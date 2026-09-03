// Simplified /vibe API client for Buddy app
// Only presence + messaging — no games, sessions, gigs, etc.

import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { open } from '@tauri-apps/plugin-shell';

const API_URL = 'https://www.slashvibe.dev/api';

// Every request gets a deadline.
//
// Buddy polls on seven timers (presence+threads+sessions every 6s, guest every
// 5s, live-share every 10s, calls every 10s, pair and handoffs every 30s) and
// none of them waited for the previous call to finish. With no timeout, a slow
// or dead network meant each tick launched another request that never settled —
// an unbounded pile of pending promises, and a Sign Out that could never
// complete because it awaits network retractions. 15s is far longer than any
// healthy call to this API and far shorter than "forever".
const REQUEST_TIMEOUT_MS = 15000;

function withTimeout(init: RequestInit = {}): RequestInit {
  // AbortSignal.timeout is available in the Tauri webview (WKWebView 16.4+;
  // we require macOS 13). Guard anyway — a missing signal must degrade to the
  // old behavior, never throw.
  try {
    if (!init.signal && typeof AbortSignal?.timeout === 'function') {
      return { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) };
    }
  } catch { /* fall through */ }
  return init;
}

// G8 (docs/G8-SECRET-RETIREMENT.md): Buddy ships NO client credential. The
// bundled VITE_BUDDY_APP_SECRET was extractable from every public DMG; the
// buddy-token whitelist has been agents-only since 2026-07-31, so the shipped
// secret served no user of this app. Humans authenticate by GitHub OAuth;
// house agents mint server-side with per-agent credentials that never enter
// any client artifact.

// Real app version, read from tauri.conf.json at runtime and cached once.
// Replaces a hardcoded constant that silently drifted from the shipped build
// (it stuck at 0.5.2 through 0.5.3/0.5.4/0.5.5), making presence telemetry lie
// about which Buddy version users actually run.
let cachedAppVersion: string | null = null;
async function getAppVersion(): Promise<string> {
  if (cachedAppVersion) return cachedAppVersion;
  try {
    cachedAppVersion = await getVersion();
  } catch {
    cachedAppVersion = 'unknown';
  }
  return cachedAppVersion;
}

interface AuthStatus {
  authenticated: boolean;
  handle: string | null;
  token: string | null;
}

export interface QuickAuthResult {
  authenticated: boolean;
  /** True means the attempt learned nothing; it is not evidence of expiry. */
  error: boolean;
}

/**
 * Someone who was here recently but is not here now.
 *
 * Deliberately NOT a VibeUser. Merging traces into the roster would put an
 * absent person on the board with a live dot, which is the one thing presence
 * must never do. This type exists so that mistake requires effort.
 */
export interface RecentTrace {
  handle: string;
  /** Server-formatted, e.g. "2h" — display only, never parsed. */
  ago: string;
  workingOn?: string;
}

export interface VibeUser {
  handle: string;
  oneLiner: string;
  status: 'active' | 'away' | 'offline';
  ago?: string;
  sources?: string[];
  mood?: string;
  moodInferred?: boolean;
  /** Server-declared: this principal is an agent, not a human. */
  isAgent?: boolean;
  /**
   * Server-computed: is this principal actually reading its mail?
   *
   * A heartbeat proves a process is running, not that anyone opens the mailbox
   * — and a live dot promises both. 'broadcast-only' means mail has sat unread
   * past several poll intervals, so a reply is not coming. 'unknown' means
   * nothing has been sent yet: untested, not deaf. Agents only for now.
   */
  reachability?: 'listening' | 'broadcast-only' | 'unknown';
  /** Unread messages waiting on this principal (supports `reachability`). */
  unreadCount?: number;
  /** When this principal last read anything, or null if never. */
  lastReadAt?: string | null;
  project?: string;
  model?: string;
  firstSeen?: string;
  lastSeen?: string;
  displayName?: string;
  clientMetadata?: {
    phase?: string;
    branch?: string;
    tokens_in?: number;
    tokens_out?: number;
    tech_stack?: string[];
    session_minutes?: number;
    [key: string]: unknown;
  };
  tokenActivity?: {
    total: number;
    intensity: number;
    lastActive: number;
  };
}

function normalizeClientMetadata(value: unknown): VibeUser['clientMetadata'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const normalized: NonNullable<VibeUser['clientMetadata']> = {};

  for (const key of ['phase', 'branch', 'model'] as const) {
    if (typeof source[key] === 'string') normalized[key] = source[key] as string;
  }
  for (const key of ['tokens_in', 'tokens_out', 'session_minutes', 'streak_days'] as const) {
    const number = source[key];
    if (typeof number === 'number' && Number.isFinite(number) && number >= 0) {
      normalized[key] = number;
    }
  }
  for (const key of ['tech_stack', 'recent_topics'] as const) {
    const list = source[key];
    if (Array.isArray(list)) {
      normalized[key] = list.filter((item): item is string => typeof item === 'string').slice(0, 20);
    }
  }
  return normalized;
}

/**
 * The platform#272 announcement seam: kind and provenance live INSIDE the
 * message `payload` object, and the label may render only when the platform
 * itself generated the message — `payload.kind === 'announcement'` AND
 * `payload.generated_by === 'platform'`. Anything less maps to undefined:
 * a sender-authored payload claiming to be an announcement is not one.
 *
 * TRUST BOUNDARY (codex r3 P1): this predicate is only as honest as the
 * SERVER's ownership of the field. Until platform#272 reserves/derives
 * `generated_by` server-side (today the API copies req.body.payload
 * verbatim, so any authenticated sender could forge it), this label must
 * not reach production — which is exactly why this slice's merge is HELD
 * on #272 being reviewed, merged and deployed with that reservation.
 * Flagged on the #272 review.
 */
// KILL SWITCH (codex r3/r4 P1, in the 0a tradition): the server now OWNS the
// provenance fields, and the deployed activation proof passed
// (platform#272 @ 1ea638aa, merge 13f5a0fc; recorded 2026-08-21):
//   · historical audit: 42,275 prod rows, zero pre-existing kind/generated_by
//   · forged ordinary-JWT send (msg_mt3lpc7jSjFMWl) stored {"note":"forged"}
//     — reserved fields stripped at the write boundary
//   · genuine internal announcement (msg_mt3lpcxtcoGUzd) stored
//     {"kind":"announcement","source":"qa_canary","generated_by":"platform"}
// A caller can no longer wear the platform's voice, so the label may render.
// If the reservation is ever weakened, flip this back to false first.
export const ANNOUNCEMENT_SEAM_TRUSTED = true;

export function announcementKind(payload: unknown): 'announcement' | undefined {
  if (!ANNOUNCEMENT_SEAM_TRUSTED) return undefined;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const p = payload as { kind?: unknown; generated_by?: unknown };
  return p.kind === 'announcement' && p.generated_by === 'platform' ? 'announcement' : undefined;
}

export interface VibeMessage {
  id: string;
  from: string;
  to: string;
  content: string;
  timestamp: string;
  status?: 'pending' | 'sent' | 'delivered' | 'read' | 'failed';
  /**
   * SERVED message kind (platform#272 seam): set if and only if the wire
   * payload carried kind='announcement' AND generated_by='platform'
   * (announcementKind above). Never inferred from body text or the sender
   * handle. Absent on older servers → no claim, no label.
   */
  kind?: 'announcement';
  /**
   * SERVER-BACKED reply association (the "needle"). The DEPLOYED thread-read
   * contract returns, per reply, the quoted parent as `reply_to`:
   *   · available parent → `{ id, from, text }` (text = sanitized body ≤200)
   *   · unavailable/deleted parent → `{ id, from: null, text: null }`
   * `undefined` here = the message is not a reply at all. Authoritative
   * association, never inference. `from`/`text` are PRESERVED as null (never
   * coerced to '') so the renderer can show the truthful "unavailable" state
   * rather than an empty quote.
   *
   * Still not in the contract: a parent timestamp (so the needle shows no
   * relative age).
   */
  replyTo?: { id: string; from: string | null; text: string | null };
}

export interface VibeThread {
  /** Server thread id — the address for per-thread preferences (archive). */
  id?: string;
  with: string;
  unread: number;
  lastMessage?: {
    from: string;
    body: string;
    created_at: string;
  };
}

export interface SessionEntity {
  handle: string;       // e.g. "seth/claude"
  parent: string;       // e.g. "seth"
  type: 'session';
  status: 'active';
  project?: string;
  model?: string;
  summary?: string;
  turnCount: number;
  updatedAt: string;
  guestEnabled: boolean;
  badge: string;
  displayName: string;
}

export interface MySession {
  sessionId: string;
  cwd: string;
  project: string;
  model?: string;
  workingOn?: string;
  status: 'active' | 'idle';
  agoSeconds: number;
  // Optional truth-contract fields (platform codex/session-truth-contract,
  // 1f0dd1d0). All optional: older platform responses omit them and Buddy
  // must keep working. Do NOT build copy on one ("your Codex session") until
  // the field is actually present in the response being rendered.
  /** Server timestamp of this session's last heartbeat (epoch ms or ISO). */
  lastSeenAt?: number | string;
  /** Host agent, e.g. "claude-code" | "codex" | "cursor". */
  clientName?: string;
  clientVersion?: string;
}

export interface PairStatus {
  paired: boolean;
  pending?: boolean;
  partner?: string;
  mode?: string;
  startedAt?: string;
  requestedAt?: string;
  incomingRequests?: Array<{
    from: string;
    to: string;
    mode?: string;
    requestedAt?: string;
  }>;
  partnerContext?: Record<string, unknown> | null;
}

export interface GuestMessage {
  id: string;
  from: string;
  message: string;
  sessionId: string | null;
  timestamp: string;
}

export interface LiveSession {
  sharing: boolean;
  restricted?: boolean;
  message?: string;
  handle?: string;
  project?: string | null;
  model?: string | null;
  summary?: string | null;
  turns?: Array<{ role: string; text: string }>;
  updatedAt?: string;
  guestEnabled?: boolean;
}


/** GitHub-login normalization mirroring the server: trim, lowercase, strip one leading @. */
export function normalizeGithub(raw: string | null | undefined): string {
  let v = String(raw ?? '').trim().toLowerCase();
  if (v.startsWith('@')) v = v.slice(1);
  return v;
}

/** The principal a token PROVES, from its own claim — null for handle-only. */
export function principalFromToken(token: string | null | undefined): string | null {
  try {
    const part = String(token || '').split('.')[1];
    if (!part) return null;
    const claims = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
    return typeof claims.principal_id === 'string' && claims.principal_id
      ? claims.principal_id
      : null;
  } catch {
    return null;
  }
}

/**
 * THE served-thread decoder — production and tests share it. GET
 * /api/v2/threads/:id serves { thread_id, with, messages }; `with` is the
 * OTHER participant, computed server-side for the authed handle.
 */
export function peerFromThreadResponse(data: any): string | null {
  const peer = data?.with ?? data?.thread?.with;
  return typeof peer === 'string' && peer.trim() ? peer.trim().toLowerCase() : null;
}

export type ThoughtInviteResult =
  | { kind: 'created'; shareUrl: string; namedFor: string; expiresAt: string }
  | { kind: 'principal_required'; label: string; url: string; hint: string }
  | { kind: 'refused'; error: string }
  | { kind: 'unreachable' };

/**
 * THE decoder — production and tests share this exact function, so a test
 * cannot pass while the product regresses. Success requires ALL served
 * truths (#322): carries_thought true, named_for matching the normalized
 * intended recipient, expires_at present.
 */
export function decodeThoughtInvite(
  ok: boolean,
  data: any,
  intendedGithub: string
): ThoughtInviteResult {
  if (data?.code === 'principal_required' && data?.action?.url) {
    return {
      kind: 'principal_required',
      label: data.action.label || 'Refresh your /vibe session',
      url: data.action.url,
      hint: data.action.hint || data.error || '',
    };
  }
  if (ok && data?.share_url) {
    const namedFor = normalizeGithub(data.named_for);
    const intended = normalizeGithub(intendedGithub);
    if (data.carries_thought === true && namedFor && namedFor === intended && data.expires_at) {
      return { kind: 'created', shareUrl: data.share_url, namedFor, expiresAt: data.expires_at };
    }
    // A link exists but the ritual did not complete as intended — say
    // exactly which served truth is missing; never celebrate.
    const missing = data.carries_thought !== true
      ? 'the server did not accept the thought'
      : !namedFor || namedFor !== intended
        ? 'the server did not bind it to the person you named'
        : 'the server did not state when it expires';
    return { kind: 'refused', error: `The invitation was not created as intended — ${missing}. Nothing to share yet.` };
  }
  if (typeof data?.error === 'string' && data.error) {
    return { kind: 'refused', error: data.error };
  }
  return { kind: 'unreachable' };
}

class BuddyClient {
  private handle: string | null = null;
  private authToken: string | null = null;
  private refreshing: Promise<boolean> | null = null;
  private presenceInFlight = new Set<Promise<boolean>>();
  private loggingOut = false;

  // Auth
  async checkAuth(): Promise<AuthStatus> {
    try {
      const status = await invoke<AuthStatus>('check_auth_status');
      if (status.authenticated && status.token) {
        this.loggingOut = false;
        this.authToken = status.token;
        this.handle = status.handle;
      }
      return status;
    } catch (e) {
      console.warn('checkAuth error:', e);
      return { authenticated: false, handle: null, token: null };
    }
  }

  /**
   * The REAL reauth round trip (#320 review finding 3): the existing native
   * OAuth authority (start_login -> browser -> Rust callback -> auth.json),
   * then poll the stored credential until it PROVES a principal — success is
   * verified from the token's own claim, never assumed from a browser page
   * having opened.
   */
  async reauthorizePrincipal(timeoutMs = 180_000): Promise<boolean> {
    // SNAPSHOT FIRST (review P2): success must be THIS round trip's doing.
    // Without it, any principal-bearing token already on disk — including a
    // stale one — reports success before the callback even lands.
    let priorToken: string | null;
    try {
      priorToken = (await invoke<AuthStatus>('check_auth_status'))?.token ?? null;
    } catch {
      // FAIL CLOSED (round-2 P2): if the snapshot itself cannot be read,
      // success can no longer be causally bound to THIS login — abort rather
      // than risk accepting a pre-existing principal token.
      return false;
    }
    const started = await this.login();
    if (!started.success) return false;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const status = await invoke<AuthStatus>('check_auth_status');
        if (status?.token && status.token !== priorToken && principalFromToken(status.token)) {
          this.authToken = status.token;
          if (status.handle) this.handle = status.handle;
          return true;
        }
      } catch { /* keep polling — unreachable is not failure yet */ }
    }
    return false;
  }

  async login(): Promise<{ success: boolean; error?: string }> {
    try {
      const loginUrl = await invoke<string>('start_login');
      await open(loginUrl);
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  /**
   * Sign out — retract everything server-side BEFORE dropping local auth.
   *
   * Order matters and used to be wrong: clearing `handle`/`authToken` first
   * made every retraction call a no-op (they early-return on a null handle),
   * so a signed-out user stayed publicly "active" for the presence TTL, their
   * shared turns stayed readable, and pair authorization survived for hours.
   * Each retraction is independently awaited and failure-tolerant: a network
   * error must not prevent the local sign-out the user asked for.
   */
  async logout(): Promise<void> {
    // Prevent a timer/focus callback from starting another heartbeat while the
    // final offline operation is ordering itself after existing ones.
    this.loggingOut = true;
    const hadSession = !!this.handle && !!this.authToken;
    if (hadSession) {
      // Best-effort, in parallel — all three are idempotent server-side.
      await Promise.allSettled([
        this.stopLiveSession(),
        this.stopPair(),
        this.goOffline(),
      ]);
    }
    try {
      await invoke('logout');
    } catch (e) { console.warn('logout error:', e); }
    this.authToken = null;
    this.handle = null;
  }

  /**
   * Explicit offline beacon — flips presence off now instead of waiting out
   * the last_seen TTL (the v2 presence route's `action: 'offline'`).
   */
  /**
   * Returns whether the offline write reached the server — the receipt the
   * My Presence card needs before it may claim "Invisible" (audit #6: the
   * pref is an intention; only a confirmed retraction is a fact). No handle
   * means no presence row exists to clear: vacuously true.
   */
  async goOffline(): Promise<boolean> {
    if (!this.handle) return true;
    try {
      // A heartbeat that began before "invisible" or sign-out can otherwise
      // arrive after this DELETE-like operation and put the user straight back
      // online. Wait it out so offline is always the last presence write.
      const pending = [...this.presenceInFlight];
      if (pending.length > 0) await Promise.allSettled(pending);
      // authenticatedRequest resolves — never throws — on a 4xx/5xx, so the
      // receipt must read `ok`; a 401 that "returned" is not a cleared dot
      // (codex P1 on the audit-#6 fix).
      const res = await this.authenticatedRequest({
        method: 'POST',
        url: `${API_URL}/v2/presence`,
        body: { action: 'offline' },
      });
      return res.ok;
    } catch (e) {
      console.warn('goOffline error:', e);
      return false;
    }
  }

  getHandle(): string | null {
    return this.handle;
  }

  getAuthToken(): string | null {
    return this.authToken;
  }

  setHandle(handle: string | null) {
    this.handle = handle;
  }

  /** Back-compat for refreshToken, whose caller separately checks token exp. */
  async quickAuth(handle: string): Promise<boolean> {
    return (await this.quickAuthResult(handle)).authenticated;
  }

  async stopPair(): Promise<void> {
    if (!this.handle) return;
    try {
      await this.authenticatedRequest({
        method: 'POST',
        url: `${API_URL}/pair`,
        body: { handle: this.handle, action: 'stop' },
      });
    } catch (e) { console.warn('stopPair error:', e); }
  }

  /**
   * Quick auth: fetch a JWT from buddy-token endpoint (alpha whitelist)
   */
  async quickAuthResult(handle: string): Promise<QuickAuthResult> {
    try {
      this.loggingOut = false;
      const response = await tauriFetch(`${API_URL}/auth/buddy-token`, withTimeout({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ handle }),
      }));

      if (response.ok) {
        const data = await response.json() as any;
        if (data.token) {
          this.authToken = data.token;
          this.handle = data.handle || handle;
          // A successful authentication re-arms the expiry notice. Resetting
          // this before the request meant a transport failure could re-arm a
          // notification without establishing a new session.
          this.sessionExpiredNotified = false;
          // Write it to disk too. Holding a refreshed token in memory only meant
          // ~/.vibe/auth.json kept the ORIGINAL sign-in token, and check_auth
          // (correctly) refuses an expired one — so once that first token passed
          // exp, every restart showed the sign-in screen even though a valid
          // session had just been in hand. Awaited, because a restart racing an
          // unawaited write is precisely the case this fixes.
          await this.persistToken(this.authToken!, this.handle!);
          return { authenticated: true, error: false };
        }
        return { authenticated: false, error: true };
      }
      // A server rejection is an answer; a 5xx/429 is not.
      return {
        authenticated: false,
        error: response.status >= 500 || response.status === 429,
      };
    } catch (e) {
      console.warn('quickAuth error:', e);
      return { authenticated: false, error: true };
    }
  }

  /**
   * Write the live token to `~/.vibe/auth.json`.
   *
   * Best-effort by design: failing to persist does NOT invalidate the session
   * the user just established — they stay signed in for this run, and only lose
   * the benefit on restart. Throwing here would turn a disk problem into a
   * sign-out, which is strictly worse than the bug being fixed.
   *
   * But it is not silent. This codebase's characteristic defect is rendering
   * confidence over an operation that never happened, so a failure is logged
   * loudly enough to find in a report rather than swallowed.
   */
  private async persistToken(token: string, handle: string): Promise<void> {
    try {
      await invoke('save_auth_token', { token, handle });
    } catch (e) {
      console.error(
        'auth: refreshed token could not be persisted — this session survives, ' +
        'but a restart may require signing in again:', e,
      );
    }
  }

  /**
   * Refresh token if expired. Deduplicates concurrent refresh attempts.
   */
  private async refreshToken(): Promise<boolean> {
    if (!this.handle) return false;
    if (this.refreshing) return this.refreshing;

    this.refreshing = this.quickAuth(this.handle);
    try {
      return await this.refreshing;
    } finally {
      this.refreshing = null;
    }
  }

  /**
   * Make an authenticated request with automatic token refresh on 401.
   */
  private async authenticatedRequest(options: {
    method: string;
    url: string;
    body?: any;
    extraHeaders?: Record<string, string>;
  }): Promise<{ ok: boolean; data: any; status: number }> {
    const doRequest = async () => {
      const headers: Record<string, string> = {
        ...(this.authToken ? { Authorization: `Bearer ${this.authToken}` } : {}),
        ...(options.extraHeaders || {}),
      };

      const fetchOptions: RequestInit = {
        method: options.method,
        headers,
      };

      if (options.body) {
        headers['Content-Type'] = 'application/json';
        fetchOptions.body = JSON.stringify(options.body);
      }

      const response = await tauriFetch(options.url, withTimeout(fetchOptions));
      const data = await response.json();
      return { ok: response.ok, data, status: response.status };
    };

    const response = await doRequest();

    // On 401, try refreshing token and retry once. If the refresh itself
    // fails, the session is genuinely dead — tell the app so it can send the
    // user back to sign-in. Silently returning the 401 produced a "zombie"
    // Buddy: a signed-in-looking buddy list where nothing worked, with no way
    // for the user to discover why. This is the common case for anyone
    // outside the alpha whitelist (i.e. every invited friend), because their
    // refresh path — quickAuth — can never succeed for them.
    if (response.status === 401 && this.handle) {
      const refreshed = await this.refreshToken();
      if (refreshed) {
        return doRequest();
      }
      // A failed refresh is NOT proof the session is over.
      //
      // refreshToken() goes through quickAuth, which is the alpha-whitelist
      // endpoint — it can never succeed for an ordinary GitHub user. So for
      // exactly the people we're onboarding, every refresh "fails", and
      // treating that as expiry meant the FIRST 401 from any endpoint threw
      // them out of the app. (Sending one DM was enough.) The previous
      // behavior — swallow it — was the opposite error, leaving a signed-in
      // UI that did nothing.
      //
      // The token's own exp is NOT the authority — the server is. A
      // server-side revocation (session-secret rotation, mint-generation
      // bump: both real events, see G8) kills a token whose local exp still
      // reads valid, and treating local exp as truth produced the zombie
      // this branch exists to prevent: signed-in UI, every request 401s,
      // rendered as "Can't reach /vibe — reconnecting automatically" — a
      // promise reconnecting can never keep (hit live 2026-08-13, a
      // rotation-killed token). So: locally-expired is still an immediate
      // sign-out, and a locally-VALID token gets one server verdict via
      // /api/auth/verify — 401 there means the session is dead however
      // fresh the exp looks; 200 means this 401 belonged to one endpoint.
      // A verify we couldn't complete (offline) decides nothing.
      if (this.tokenLooksExpired()) {
        this.onSessionExpired();
      } else {
        // Clear the credential BEFORE showing sign-in: the Rust side's
        // check_auth_status trusts a stored token's exp, so a definitively
        // rejected JWT left anywhere (auth.json, the MCP config) rehydrates
        // the dead session. The verdict is BOUND to the token it probed: a
        // stale in-flight verdict must never erase a session the user
        // re-established while it was on the wire (codex P2 round 3) — so
        // sign-out happens only if that same token is still the current one.
        const deadToken = await this.tokenRevokedPerServer();
        if (deadToken) {
          await this.clearDeadSession(deadToken);
          if (this.authToken === null) this.onSessionExpired();
        } else {
          console.warn(`401 on ${options.url} with a token the server has not disowned — not signing out`);
        }
      }
    }

    return response;
  }

  /**
   * Erase a server-disowned credential everywhere it lives. The Rust
   * `clear_revoked_auth` command removes ~/.vibe/auth.json ONLY if it still
   * holds this exact token, and retires the MCP config's matching aliases
   * regardless — a dead copy there is dead wherever auth.json has moved on
   * to. Memory is cleared only when it still holds the dead token, so a
   * session re-established mid-probe survives untouched. No server
   * goodbyes: the token is already dead and would just 401 again.
   */
  private async clearDeadSession(deadToken: string): Promise<void> {
    try {
      await invoke('clear_revoked_auth', { token: deadToken });
    } catch (e) { console.warn('clear_revoked_auth failed:', e); }
    if (this.authToken === deadToken) {
      this.authToken = null;
      this.handle = null;
    }
  }

  /**
   * Ask the server whether our token is still honored. Only called on a 401
   * whose token still looks locally valid — the case where revocation is the
   * live hypothesis. Resolves to the PROBED TOKEN on the server's explicit
   * 401 verdict (so the caller can bind consequences to exactly that
   * credential), and null otherwise; transport failures and odd statuses are
   * null (inconclusive evidence must not sign anyone out). Throttled to one
   * ask per minute; an in-flight probe is shared only by callers holding the
   * SAME token — a probe for yesterday's token says nothing about today's.
   */
  private verifyProbe: Promise<string | null> | null = null;
  private verifyProbeToken: string | null = null;
  private lastVerifyAt = 0;
  private tokenRevokedPerServer(): Promise<string | null> {
    const probed = this.authToken;
    if (!probed) return Promise.resolve(null);
    if (this.verifyProbe && this.verifyProbeToken === probed) return this.verifyProbe;
    if (Date.now() - this.lastVerifyAt < 60_000) return Promise.resolve(null);
    this.lastVerifyAt = Date.now();
    this.verifyProbeToken = probed;
    this.verifyProbe = (async () => {
      try {
        const res = await tauriFetch(`${API_URL}/auth/verify`, withTimeout({
          method: 'GET',
          headers: { Authorization: `Bearer ${probed}` },
        }));
        return res.status === 401 ? probed : null;
      } catch {
        return null; // could not reach the arbiter — decide nothing
      } finally {
        this.verifyProbe = null;
        this.verifyProbeToken = null;
      }
    })();
    return this.verifyProbe;
  }

  /**
   * Is our stored token past its own `exp`? Decodes the payload without
   * verifying the signature (the server owns verification; we hold no key).
   * Anything unreadable is treated as NOT expired — the server decides.
   * Mirrors is_jwt_expired() in src-tauri/src/auth.rs.
   */
  private tokenLooksExpired(): boolean {
    const token = this.authToken;
    if (!token) return true; // no token at all is the one certain case
    const payload = token.split('.')[1];
    if (!payload) return false; // legacy two-part token — let the server say
    try {
      const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
      const exp = JSON.parse(json)?.exp;
      if (typeof exp !== 'number') return false;
      return Date.now() / 1000 >= exp - 60; // skew early, same as the Rust side
    } catch {
      return false;
    }
  }

  /**
   * Set by the app to be told when a session can no longer be refreshed.
   * Fires at most once per client instance so a burst of parallel 401s
   * doesn't bounce the UI repeatedly.
   */
  private sessionExpiredNotified = false;
  private sessionExpiredHandler: (() => void) | null = null;

  setSessionExpiredHandler(fn: (() => void) | null) {
    this.sessionExpiredHandler = fn;
  }

  private onSessionExpired() {
    if (this.sessionExpiredNotified) return;
    this.sessionExpiredNotified = true;
    this.sessionExpiredHandler?.();
  }

  // Presence (V2 API)
  // Returns `error: true` when the fetch fails or the server responds non-2xx,
  // so callers can tell "couldn't reach /vibe" apart from "nobody's online".
  // Both used to collapse to an empty list, which made a network blip look
  // identical to an empty room.
  async getOnlineUsers(): Promise<{ users: VibeUser[]; sessions: SessionEntity[]; recentlyHere?: RecentTrace[]; error?: boolean }> {
    try {
      // ?include=recent is load-bearing, not an optimisation. v2 omits the
      // `recent` bucket entirely unless asked, so the empty-room traces mapped
      // a field the server never sent and silently rendered nothing — a feature
      // that shipped in 0.5.26 and could not work. v1 returns recent by
      // default, which is what made it look correct when tested by hand
      // against the wrong endpoint.
      // Through authenticatedRequest, NOT a bare fetch. The roster read used to
      // go out with no Authorization header at all, which worked only because
      // /v2/presence answered anonymously. Platform PR #141 closed five
      // unauthenticated presence endpoints — correctly; "is @alice online" for
      // any handle a stranger can type is a real leak — and this request started
      // taking a hard 401 on every poll. The buddy list is the screen Buddy
      // exists to draw, so it must present a credential like every other read.
      //
      // Using authenticatedRequest also puts the roster on the same
      // refresh-on-401-and-retry path as messaging, instead of a second,
      // weaker opinion about what an expired session means.
      const response = await this.authenticatedRequest({
        method: 'GET',
        url: `${API_URL}/v2/presence?include=recent`,
      });
      if (!response.ok) return { users: [], sessions: [], error: true };
      const data = response.data as any;
      // A successful HTTP status is not proof that this is a presence
      // response. Proxies and broken deploys can return 200 with HTML or an
      // unrelated JSON envelope; treating missing buckets as `[]` would erase
      // the roster and confidently render an empty room.
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return { users: [], sessions: [], error: true };
      }
      if (!Array.isArray(data.active) || !Array.isArray(data.away)) {
        return { users: [], sessions: [], error: true };
      }
      for (const bucket of ['active', 'away', 'agents', 'sessions', 'recent']) {
        if (data[bucket] !== undefined && !Array.isArray(data[bucket])) {
          return { users: [], sessions: [], error: true };
        }
      }
      for (const bucket of ['active', 'away', 'agents']) {
        if ((data[bucket] || []).some((user: unknown) =>
          !user || typeof user !== 'object' || Array.isArray(user) ||
          typeof (user as { handle?: unknown }).handle !== 'string' ||
          !(user as { handle: string }).handle.trim()
        )) {
          return { users: [], sessions: [], error: true };
        }
      }

      const mapUser = (u: any, status: 'active' | 'away'): VibeUser => ({
        handle: u.handle,
        oneLiner: typeof u.workingOn === 'string'
          ? u.workingOn
          : (status === 'active' ? 'Vibing' : ''),
        status,
        ago: typeof u.ago === 'string' ? u.ago : undefined,
        sources: Array.isArray(u.sources)
          ? u.sources.filter((source: unknown): source is string => typeof source === 'string')
          : [],
        mood: typeof u.mood === 'string' ? u.mood : undefined,
        moodInferred: u.mood_inferred === true,
        // Attribution comes from the server, which knows. Buddy used to infer
        // it from a hardcoded roster of handles — which silently mislabels
        // every agent added after the list was written, and every agent that
        // isn't Seth's.
        //
        // Tri-state, preserved deliberately: a server that says nothing maps
        // to undefined so the legacy-roster fallback can still label
        // pre-flag servers; an explicit false must stay false so the roster
        // can never override the server (honest-state audit #17).
        isAgent: u.isAgent === true || u.is_agent === true
          ? true
          : u.isAgent === false || u.is_agent === false
            ? false
            : undefined,
        // Reachability is server-computed so a handle that stops reading
        // downgrades itself, instead of Buddy keeping a list by hand.
        reachability: ['listening', 'broadcast-only', 'unknown'].includes(u.reachability)
          ? u.reachability
          : undefined,
        unreadCount: typeof u.unreadCount === 'number' &&
          Number.isFinite(u.unreadCount) && u.unreadCount >= 0
          ? u.unreadCount
          : undefined,
        // ABSENT ≠ NEVER READ. Collapsing an omitted field to null made
        // "this agent has never read anything" indistinguishable from "the
        // endpoint did not tell us" — and /v2/presence does not tell us, so
        // every agent looked never-read (codex P1). null is now reserved for
        // an explicit platform statement; undefined means unannotated.
        lastReadAt: typeof u.lastReadAt === 'string'
          ? u.lastReadAt
          : u.lastReadAt === null
            ? null
            : undefined,
        project: typeof u.project === 'string' ? u.project : undefined,
        model: typeof u.model === 'string' ? u.model : undefined,
        firstSeen: typeof u.firstSeen === 'string' ? u.firstSeen : undefined,
        lastSeen: typeof u.lastSeen === 'string' ? u.lastSeen : undefined,
        displayName: typeof u.displayName === 'string' ? u.displayName : u.handle,
        clientMetadata: normalizeClientMetadata(u.clientMetadata),
        tokenActivity: status === 'active' ? (u.tokenActivity || null) : null,
      });

      const active: VibeUser[] = (data.active || []).map((u: any) => mapUser(u, 'active'));
      const away: VibeUser[] = (data.away || []).map((u: any) => mapUser(u, 'away'));
      // The server separates resident agents into their own bucket so "humans
      // online" stays an honest number. Buddy was DROPPING it, then guessing
      // agent-ness from a hardcoded list — so a new agent appeared as a human.
      //
      // A resident agent can still be OFFLINE (persistent identity, not here
      // now). Mapping everything-but-away to 'active' put an offline agent in
      // the active bucket and the "agents here right now" count — a presence
      // claim with no evidence. Drop explicitly-offline agents from the roster;
      // a missing/unknown status keeps the server's bucketing (it put them here).
      const agents: VibeUser[] = (data.agents || [])
        .filter((u: any) => u.status !== 'offline')
        .map((u: any) => ({
          ...mapUser(u, u.status === 'away' ? 'away' : 'active'),
          isAgent: true,
        }));

      const sessions: SessionEntity[] = (data.sessions || []).map((s: any) => ({
        handle: s.handle,
        parent: s.parent,
        type: 'session' as const,
        status: 'active' as const,
        project: s.project || undefined,
        model: s.model || undefined,
        summary: s.summary || undefined,
        turnCount: s.turnCount || 0,
        updatedAt: s.updatedAt,
        guestEnabled: s.guestEnabled || false,
        badge: s.badge || '🧠',
        displayName: s.displayName || s.handle,
      }));

      // The room's traces. The server has always sent these — who was here, how
      // long ago, and what they were doing — and Buddy dropped them, exactly as
      // it dropped agents[] before that. So a board with nobody on it right now
      // rendered as "Quiet in here" while the server knew four people had been
      // working in the last nine hours. An empty room with a history is a room;
      // an empty room with no history is a dead app.
      const recentlyHere: RecentTrace[] = (data.recent || [])
        .filter((u: any) => u?.handle)
        .map((u: any) => ({
          handle: u.handle,
          ago: u.ago || '',
          workingOn: u.workingOn || undefined,
        }));

      return { users: [...active, ...away, ...agents], sessions, recentlyHere };
    } catch (e) {
      console.warn('getOnlineUsers error:', e);
      return { users: [], sessions: [], error: true };
    }
  }

  /**
   * Fetch the caller's own live Claude Code sessions from /api/my-sessions.
   *
   * `error: true` means the caller learned nothing and must keep its last good
   * sessions — but keeping the SNAPSHOT is not keeping the CERTAINTY: the
   * probe goes 'unchecked' and retained rows age (lib/mySessionsState). An
   * empty array with `error: false` is an authoritative "none".
   *
   * `observedAt` is the LOCAL receipt time for a successful response — the
   * anchor retained rows age from. The platform's `observedAt` and
   * `lastSeenAt` share the server clock, but neither may be compared directly
   * with the Mac clock. `agoSeconds` is the server-computed age at receipt;
   * local elapsed time advances it without inheriting clock skew.
   */
  async getMySessionsResult(): Promise<{ sessions: MySession[]; error: boolean; observedAt?: number }> {
    if (!this.authToken) return { sessions: [], error: true };
    try {
      const { ok, data } = await this.authenticatedRequest({
        method: 'GET',
        url: `${API_URL}/my-sessions`,
      });
      if (!ok || !data || typeof data !== 'object' || data.ok !== true) {
        return { sessions: [], error: true };
      }
      if (!Array.isArray(data.sessions)) {
        return { sessions: [], error: true };
      }
      return {
        sessions: data.sessions as MySession[],
        error: false,
        observedAt: Date.now(),
      };
    } catch {
      return { sessions: [], error: true };
    }
  }

  /**
   * A shareable invite link backed by a real, tracked code
   * (https://www.slashvibe.dev/join/VIBE-XXXX-HAND). Unlike the bare
   * /invite/{handle} referral page, a code credits the referral chain used
   * for K-factor. Reuses an existing available code before minting a new one
   * (each user is capped at 3 unused), and falls back to the referral page if
   * the invites API is unreachable so the button never dead-ends.
   */
  /**
   * A thought-bearing NAMED invitation — the ritual surface (#320 + #322).
   *
   * In THIS surface both halves are required: a non-empty thought and the one
   * nontransferable GitHub recipient. The thought is transmitted BYTE-FOR-BYTE
   * as typed (validated with trim, sent untrimmed — "exact prose" means the
   * server receives the person's actual keystrokes, not our tidied copy).
   * The plain tracked-link path (getInviteLink) remains for thoughtless
   * invites elsewhere.
   *
   * Success is the SERVED truth, not the 200 (#322): created only when
   * carries_thought is true, named_for equals the normalized intended
   * recipient, and expires_at is present. Anything else is an incomplete
   * creation reported honestly — never celebratory success.
   */
  async createThoughtInvite(
    firstThought: string,
    forGithub: string
  ): Promise<ThoughtInviteResult> {
    if (!firstThought.trim() || !normalizeGithub(forGithub)) {
      return { kind: 'refused', error: 'This invitation needs both the thought and the person it is for.' };
    }
    try {
      const res = await this.authenticatedRequest({
        method: 'POST',
        url: `${API_URL}/invites`,
        body: {
          first_thought: firstThought,
          for_github: forGithub,
        },
      });
      return decodeThoughtInvite(res.ok, res.data, forGithub);
    } catch {
      return { kind: 'unreachable' };
    }
  }

  /**
   * The other participant of a served thread id — the /t/{thread_id} landing
   * a redemption redirects to (#320). The endpoint serves
   * { thread_id, with, messages } and `with` IS the peer, verified
   * server-side as a participant — never a guess. null when the thread is
   * not served to this principal.
   */
  async resolveThreadPeer(threadId: string): Promise<string | null> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(threadId)) return null;
    try {
      const res = await this.authenticatedRequest({
        method: 'GET',
        url: `${API_URL}/v2/threads/${encodeURIComponent(threadId)}`,
      });
      if (!res.ok) return null;
      return peerFromThreadResponse(res.data);
    } catch {
      return null;
    }
  }


  async getInviteLink(): Promise<string> {
    const fallback = `https://www.slashvibe.dev/invite/${this.handle || ''}`;
    if (!this.handle) return fallback;
    try {
      const mine = await this.authenticatedRequest({
        method: 'GET',
        url: `${API_URL}/invites/my`,
      });
      if (mine.ok && Array.isArray(mine.data?.codes)) {
        const avail = mine.data.codes.find(
          (c: any) => c.status === 'available' && c.share_url
        );
        if (avail?.share_url) return avail.share_url;
      }
      const made = await this.authenticatedRequest({
        method: 'POST',
        url: `${API_URL}/invites`,
      });
      if (made.ok && made.data?.share_url) return made.data.share_url;
    } catch (e) {
      console.warn('getInviteLink error:', e);
    }
    return fallback;
  }

  async updatePresence(enriched?: {
    workingOn?: string;
    project?: string;
    clientMetadata?: Record<string, unknown>;
  }): Promise<boolean> {
    if (!this.handle || this.loggingOut) return false;

    // AUTHENTICATED. This used to be a raw fetch with no Authorization header,
    // relying on the server's `username`-in-body fallback — the same fallback
    // that let anyone post presence as anyone, and which is now closed. The
    // combination would have been silent and total: every heartbeat 401s, the
    // server TTLs the user to away at 30 minutes and offline at two hours, and
    // Buddy's own UI keeps reporting success the whole time. Route through
    // authenticatedRequest and RETURN whether it actually landed, so callers
    // stop claiming a broadcast that never happened.
    let request: Promise<boolean>;
    request = (async () => {
      try {
        const { ok } = await this.authenticatedRequest({
          method: 'POST',
          url: `${API_URL}/presence`,
          extraHeaders: { 'X-Vibe-Client': 'buddy' },
          body: {
            username: this.handle,
            workingOn: enriched?.workingOn || 'Online via Buddy',
            project: enriched?.project || undefined,
            clientName: 'vibe-buddy',
            clientVersion: await getAppVersion(),
            source: 'buddy',
            clientMetadata: enriched?.clientMetadata || undefined,
          },
        });
        if (!ok) console.warn('updatePresence: server rejected heartbeat');
        return ok;
      } catch (e) {
        console.warn('updatePresence error:', e);
        return false;
      }
    })();
    this.presenceInFlight.add(request);
    try {
      return await request;
    } finally {
      this.presenceInFlight.delete(request);
    }
  }

  /**
   * Thread list, with failure distinguishable from emptiness.
   *
   * This used to return `[]` on every failure, which callers committed as
   * truth — so a network blip erased the Recent list and zeroed the tray unread
   * count, and the user watched their conversations disappear. Presence already
   * carried an `error` flag for exactly this reason; threads did not.
   *
   * `error: true` means "we learned nothing, keep what you had". An empty array
   * with `error: false` is a real, authoritative empty inbox.
   */
  async getThreadListResult(): Promise<{ threads: VibeThread[]; error: boolean }> {
    if (!this.handle) return { threads: [], error: false };

    try {
      const { ok, data } = await this.authenticatedRequest({
        method: 'GET',
        url: `${API_URL}/messages?user=${this.handle}`,
      });

      if (!ok) return { threads: [], error: true };

      // A 200 whose body is not the shape we expect is a failure, not an empty
      // inbox — a proxy error page or a bad deploy must not read as "no threads".
      //
      // The object check is load-bearing: an HTML error page arrives as a
      // STRING, on which `.threads` is simply undefined, so a guard that only
      // inspected `.threads` fell through and reported a confident empty inbox.
      // A regression test caught that.
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return { threads: [], error: true };
      }
      if (!Array.isArray(data.threads)) {
        return { threads: [], error: true };
      }

      const threads = data.threads.map((t: any) => ({
        id: typeof t.id === 'string' ? t.id : undefined,
        with: t.with,
        unread: t.unread || 0,
        lastMessage: t.last_message
          ? {
              from: t.last_message.from,
              body: t.last_message.body,
              created_at: t.last_message.created_at,
            }
          : undefined,
      }));
      return { threads, error: false };
    } catch (e) {
      console.warn('getThreadList error:', e);
      return { threads: [], error: true };
    }
  }

  /** Back-compat shim for callers that cannot act on the error either way. */
  async getThreadList(): Promise<VibeThread[]> {
    return (await this.getThreadListResult()).threads;
  }

  /**
   * Archive (or unarchive) a thread — per-account server preference, synced
   * across devices. The platform's inbox query filters archived threads out,
   * so success here means the thread leaves the list by SERVER truth on the
   * next poll; Buddy never hides it locally on hope. Returns whether the
   * server acknowledged the write.
   */
  async setThreadArchived(threadId: string, archived: boolean): Promise<boolean> {
    if (!this.handle || !threadId) return false;
    try {
      const { ok } = await this.authenticatedRequest({
        method: 'PATCH',
        url: `${API_URL}/v2/threads/${encodeURIComponent(threadId)}/preferences`,
        body: { archived },
      });
      return ok;
    } catch (e) {
      console.warn('setThreadArchived error:', e);
      return false;
    }
  }

  async sendMessage(to: string, content: string, replyTo?: string): Promise<boolean> {
    return (await this.sendMessageResult(to, content, replyTo)).ok;
  }

  /**
   * Send, and say WHY a refusal happened. The server refuses sends to
   * handles it cannot find (`recipient_not_found`, a stable code) — the
   * first-message door needs that reason to render an honest refusal
   * instead of a generic Failed (buddy#53). The lookup FAILS OPEN on
   * server-side errors, so an ok here never claims the handle was
   * verified — it claims exactly one thing: this send was stored.
   */
  async sendMessageResult(
    to: string,
    content: string,
    replyTo?: string
  ): Promise<{ ok: boolean; error?: string; id?: string; storedLength?: number }> {
    if (!this.handle) return { ok: false };

    try {
      const { ok, data } = await this.authenticatedRequest({
        method: 'POST',
        url: `${API_URL}/messages`,
        extraHeaders: { 'X-Vibe-Client': 'buddy' },
        body: {
          from: this.handle,
          to,
          body: content,
          // Explicit reply targeting: the parent message id the HUMAN chose
          // to answer. snake_case is the wire format the platform accepts.
          // Omitted entirely for an ordinary (unlinked) send — never a
          // silent default. The needle only appears once the server serves
          // the resulting link back on the next read.
          ...(replyTo ? { reply_to: replyTo } : {}),
        },
      });

      if (ok) {
        // The stored-message receipt: the server's own id for the row it
        // wrote, plus how many chars it stored — the evidence a send trace
        // and a read-back verification hang off (P0 send diagnosis).
        const msg = (data as { message?: { id?: unknown } } | null)?.message;
        const id = msg && typeof msg.id === 'string' ? msg.id : undefined;
        const storedLength =
          data && typeof (data as { storedLength?: unknown }).storedLength === 'number'
            ? (data as { storedLength: number }).storedLength
            : undefined;
        return { ok: true, id, storedLength };
      }
      const error = data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string'
        ? (data as { error: string }).error
        : undefined;
      return { ok: false, error };
    } catch (e) {
      console.warn('sendMessage error:', e);
      return { ok: false };
    }
  }

  async sendTypingIndicator(to: string): Promise<void> {
    if (!this.handle) return;
    try {
      // POST /api/typing requires auth — the server verifies the JWT handle
      // matches `from` and 401s otherwise. The previous raw tauriFetch sent no
      // Authorization header, so every keystroke 401'd and the "is typing…"
      // signal silently never reached the recipient. Route through
      // authenticatedRequest so the Bearer token is attached, matching sendMessage.
      await this.authenticatedRequest({
        method: 'POST',
        url: `${API_URL}/typing`,
        extraHeaders: { 'X-Vibe-Client': 'buddy' },
        body: { from: this.handle, to },
      });
    } catch (e) { console.warn('sendTypingIndicator error:', e); }
  }



  // === Pair Mode ===

  async getPairStatusResult(): Promise<{ status: PairStatus; error: boolean }> {
    if (!this.handle) return { status: { paired: false }, error: false };
    try {
      const { ok, data } = await this.authenticatedRequest({
        method: 'GET',
        url: `${API_URL}/pair?handle=${this.handle}`,
      });
      if (!ok || !data || typeof data !== 'object' || typeof data.paired !== 'boolean') {
        return { status: { paired: false }, error: true };
      }
      return { status: data as PairStatus, error: false };
    } catch (e) {
      console.warn('getPairStatus error:', e);
      return { status: { paired: false }, error: true };
    }
  }

  /** Back-compat for callers that have no last-known pair state to preserve. */
  async getPairStatus(): Promise<PairStatus> {
    return (await this.getPairStatusResult()).status;
  }

  // === Live Session ===

  async getLiveSessionResult(targetHandle: string): Promise<{
    session: LiveSession | null;
    error: boolean;
  }> {
    if (!this.handle) return { session: null, error: true };
    try {
      const { ok, data } = await this.authenticatedRequest({
        method: 'GET',
        url: `${API_URL}/session/live?handle=${targetHandle}`,
      });
      if (
        !ok ||
        !data ||
        typeof data !== 'object' ||
        Array.isArray(data) ||
        typeof data.sharing !== 'boolean'
      ) {
        return { session: null, error: true };
      }
      return { session: data as LiveSession, error: false };
    } catch (e) {
      console.warn('getLiveSession error:', e);
      return { session: null, error: true };
    }
  }

  async stopLiveSession(): Promise<void> {
    if (!this.handle) return;
    try {
      await this.authenticatedRequest({
        method: 'DELETE',
        url: `${API_URL}/session/live?handle=${this.handle}`,
      });
    } catch (e) { console.warn('stopLiveSession error:', e); }
  }

  // === Guest Session ===

  async sendGuestMessage(to: string, message: string): Promise<boolean> {
    if (!this.handle) return false;
    try {
      const { ok } = await this.authenticatedRequest({
        method: 'POST',
        url: `${API_URL}/session/guest`,
        body: {
          from: this.handle,
          to,
          message,
        },
      });
      return ok;
    } catch (e) {
      console.warn('sendGuestMessage error:', e);
      return false;
    }
  }

  async getGuestMessages(ack: boolean = false): Promise<GuestMessage[]> {
    if (!this.handle) return [];
    try {
      const { ok, data } = await this.authenticatedRequest({
        method: 'GET',
        url: `${API_URL}/session/guest?handle=${this.handle}${ack ? '&ack=true' : ''}`,
      });
      if (!ok) return [];
      return data.messages || [];
    } catch (e) {
      console.warn('getGuestMessages error:', e);
      return [];
    }
  }

  // === Session Handoff ===

  /**
   * Fetch one conversation without making failure look like an empty thread.
   *
   * This result is consumed by realtime polling. On `error: true` it must not
   * invoke the UI callback, because DMPanel would render `[]` and persist that
   * as the new local cache.
   */
  async getThreadResult(otherHandle: string): Promise<{ messages: VibeMessage[]; error: boolean }> {
    if (!this.handle) return { messages: [], error: true };

    try {
      // The server pages a thread OLDEST-first, 100 by default, 200 at most.
      // Asked with no page size, a thread past 100 messages came back as its
      // first 100 and the open panel silently lost its newest — the founder's
      // own 108-message thread showed nothing from the last sixteen hours
      // while rendering his local send (buddy#17). Walk every page at the
      // maximum size so the panel holds the whole thread, newest included.
      const PAGE = 200;
      const wireMessages: any[] = [];
      for (let offset = 0; ; offset += PAGE) {
        const { ok, data } = await this.authenticatedRequest({
          method: 'GET',
          url: `${API_URL}/messages?user=${this.handle}&with=${otherHandle}&limit=${PAGE}&offset=${offset}`,
        });
        if (!ok || !data || typeof data !== 'object' || Array.isArray(data)) {
          return { messages: [], error: true };
        }
        const page = Array.isArray(data.messages)
          ? data.messages
          : Array.isArray(data.thread)
            ? data.thread
            : null;
        if (!page) {
          return { messages: [], error: true };
        }
        wireMessages.push(...page);
        if (page.length < PAGE) break;
        if (offset >= PAGE * 25) break; // 5,000 messages: a bound, not a claim
      }

      // KILL SWITCH (2026-08-09, take-stock Move 0a): do NOT advance the read
      // cursor from here. "Refreshing a thread" is not "the human saw it" —
      // Buddy's hide-on-close keeps this panel mounted, so background
      // refreshes were marking messages read that nobody had seen, making a
      // client the authority for human sight (the split-authority failure
      // canon names). The server side also fabricates cursor IDs from this
      // call. Unread stays platform-derived and read-only here until the
      // platform defines a principal-scoped acknowledgement (real message ID
      // + foreground visibility). docs/TAKE-STOCK-2026-08-09.md Move 0a.

      const messages: VibeMessage[] = wireMessages.map((m: any): VibeMessage => ({
        id: m.id,
        from: m.from,
        to: m.to,
        content: m.body || m.text,
        timestamp: m.created_at || m.createdAt,
        status: m.read ? 'read' : 'sent',
        // Served kind, validated at the client edge (platform#272 stores
        // it inside `payload`, with provenance): see announcementKind.
        kind: announcementKind(m.payload),
        // Server-backed reply association. Only the OBJECT shape (the quoted
        // parent from getThreadMessages) becomes a needle; the ask-resolver
        // path returns reply_to as a bare id string, which is not a quoted
        // parent and must not render a needle. Never inferred. Nulls are
        // PRESERVED: an unavailable/deleted parent arrives as
        // { id, from: null, text: null } and must render the truthful
        // "unavailable" state, not an empty quote.
        replyTo:
          m.reply_to && typeof m.reply_to === 'object' && typeof m.reply_to.id === 'string'
            ? {
                id: m.reply_to.id,
                from: typeof m.reply_to.from === 'string' ? m.reply_to.from : null,
                text: typeof m.reply_to.text === 'string' ? m.reply_to.text : null,
              }
            : undefined,
      }));
      return { messages, error: false };
    } catch (e) {
      console.warn('getThread error:', e);
      return { messages: [], error: true };
    }
  }

}

export const buddyClient = new BuddyClient();
