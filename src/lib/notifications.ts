// Desktop notifications + dock badge for new DMs
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
  registerActionTypes,
  onAction,
} from '@tauri-apps/plugin-notification';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

let permissionGranted = false;
let permissionKnown = false;
let permissionReadInFlight: Promise<boolean> | null = null;
let lastUnreadCounts: Record<string, number> = {};
let initialized = false;
let clickHandlerRegistered = false;
let nativeRouteRegistered = false;

/** The CURRENT mount's routing callbacks — see initNotificationClicks. */
let routeCallbacks: {
  openThread: (handle: string) => void;
  reply?: (handle: string, text: string) => Promise<boolean>;
  openSession?: (cwd: string) => void;
} | null = null;

/**
 * Do we already hold notification permission? Read-only — never prompts.
 * Used to decide whether to OFFER notifications in-app before triggering the
 * OS dialog.
 */
export async function hasNotificationPermission(): Promise<boolean> {
  if (permissionReadInFlight) return permissionReadInFlight;
  permissionReadInFlight = (async () => {
    try {
      permissionGranted = await isPermissionGranted();
      permissionKnown = true;
      return permissionGranted;
    } catch {
      // Unknown, not denied. checkAndNotify will retry on a later roster poll
      // instead of disabling notifications for the rest of a week-long run.
      return false;
    } finally {
      permissionReadInFlight = null;
    }
  })();
  return permissionReadInFlight;
}

export interface NotificationPermissionResult {
  granted: boolean;
  /** The OS/plugin did not answer; distinct from the user choosing Deny. */
  error: boolean;
}

/**
 * Ask for notification permission.
 *
 * This TRIGGERS THE OS DIALOG, so only call it from an explicit user action.
 * It used to run automatically from the buddy list's mount effect, which
 * meant a first-time user got a high-trust system prompt before they had seen
 * what notifications were for — the classic way to train someone to click
 * Deny.
 */
export async function ensureNotificationPermissionResult(): Promise<NotificationPermissionResult> {
  try {
    permissionGranted = await isPermissionGranted();
    if (!permissionGranted) {
      const permission = await requestPermission();
      permissionGranted = permission === 'granted';
    }
    permissionKnown = true;
    return { granted: permissionGranted, error: false };
  } catch {
    // A plugin failure is not the user declining. The offer must remain
    // retryable instead of permanently recording a dismissal.
    return { granted: false, error: true };
  }
}

/** Back-compat for callers that only need the granted bit. */
export async function ensureNotificationPermission(): Promise<boolean> {
  return (await ensureNotificationPermissionResult()).granted;
}


// ── The native path (buddy#39) ───────────────────────────────────────────────
//
// On macOS the plugin's desktop backend drops `extra` and `actionTypeId`, so a
// click could never say which banner it was and inline reply never worked.
// The Rust side (src-tauri/src/notify.rs) now owns one persistent
// NSUserNotificationCenter delegate and emits "buddy://notification-action"
// with {kind, thread, cwd, reply} on every interaction. This module delivers
// through that path when the build has it, and through the plugin otherwise —
// the plugin path is not dead code, it is the real path on other platforms.

interface BuddyBanner {
  title: string;
  body: string;
  kind: 'dm' | 'session' | 'arrival';
  thread?: string;
  from?: string;
  cwd?: string;
  /** Offer the inline reply field (DMs only — nothing else has a recipient). */
  reply?: boolean;
  /** Stamped by deliver() — the account this banner belongs to. */
  owner?: string;
}

/**
 * null = not yet probed. The fast path below treats null as "plugin", so the
 * very first banners of a run may go out un-routable while the probe is in
 * flight — initNotificationClicks kicks the probe at startup precisely so
 * that window is over before any real banner exists.
 */
let nativeAvailable: boolean | null = null;
let nativeProbe: Promise<boolean> | null = null;

/**
 * The signed-in handle that owns every banner delivered from now on. A banner
 * outlives sign-out in Notification Center, so the OWNER rides the payload
 * and routing refuses a mismatch — otherwise A's banner clicked after B signs
 * in sends A's reply as B (codex P1). Sign-out also clears delivered banners
 * (the Rust side), but a click can race that clear; this is the second lock.
 */
let bannerOwner: string | null = null;

export function setNotificationOwner(handle: string | null): void {
  const changed = handle !== bannerOwner;
  bannerOwner = handle;
  if (handle === null && nativeAvailable === true) {
    // First lock: nothing of the previous account stays clickable.
    void Promise.resolve(invoke('clear_native_notifications')).catch(() => {});
  }
  // A banner queued while the probe was pending belongs to the account that
  // was signed in when it fired. Flushing it after a sign-out — or under the
  // NEXT account — would put the previous account's message content on
  // screen; the owner check blocks the ROUTING but not the disclosure
  // (codex P2). The flush also re-checks, for the probe already in flight.
  if (changed) {
    // Normalized: an unstamped banner (owner undefined — signed-out delivery)
    // matches a null owner. undefined !== null would silently drop them all.
    preProbeQueue = preProbeQueue.filter((q) => (q.owner ?? null) === (handle ?? null));
  }
}

/** Actions handled already (live event vs startup drain both feed this).
 * Ids are STRINGS end-to-end: as JSON numbers they exceeded
 * Number.MAX_SAFE_INTEGER and adjacent ids rounded together (codex P1 r5). */
const handledActionIds = new Set<string>();

/**
 * Banners that fired before the native probe resolved. They must NOT fall
 * back to the plugin on macOS: the plugin's desktop path is notify-rust →
 * mac-notification-sys, whose send installs ITS OWN delegate on the shared
 * default center — one pre-probe banner would permanently replace Buddy's
 * delegate and kill routing for every banner after it (codex P2). So
 * pre-probe banners queue, and flush the moment the probe answers.
 */
let preProbeQueue: BuddyBanner[] = [];

/**
 * The delegate-replacement hazard is macOS-only — and the webview can know
 * "am I on a Mac" synchronously, without the probe. Elsewhere (and in jsdom
 * tests) the plugin path is safe immediately, so pre-probe banners keep the
 * old synchronous behavior; only where the hazard exists do they queue.
 */
const macLike = (): boolean =>
  typeof navigator !== 'undefined' && /Mac/.test(navigator.userAgent || '');

function probeNative(): Promise<boolean> {
  if (nativeProbe) return nativeProbe;
  nativeProbe = Promise.resolve(invoke<boolean>('native_notify_available'))
    .then((v) => { nativeAvailable = v === true; return nativeAvailable; })
    .catch(() => { nativeAvailable = false; return false; });
  return nativeProbe;
}

/** Exposed for tests only: the probe cache would otherwise leak between them. */
export function resetNativeNotificationState(): void {
  nativeAvailable = null;
  nativeProbe = null;
}

/**
 * Deliver a banner. SYNCHRONOUS from the caller's point of view — the
 * transition-detection loops count sends as they fire, and an async hop here
 * would let a re-poll race the baseline update.
 */
function deliver(n: BuddyBanner): void {
  const stamped = { ...n, owner: bannerOwner ?? undefined };
  if (nativeAvailable === true) {
    // No plugin fallback here: on macOS the plugin path would install its own
    // delegate over ours (see preProbeQueue). A rare failed native send costs
    // one banner; the fallback would cost every routed banner afterwards.
    void Promise.resolve(invoke('notify_native', { n: stamped })).catch(() => {});
    return;
  }
  if (nativeAvailable === null) {
    if (macLike()) {
      preProbeQueue.push(stamped);
      void probeNative().then((native) => {
        const queued = preProbeQueue;
        preProbeQueue = [];
        for (const q of queued) {
          // The owner may have changed while the probe was in flight — a
          // stale banner is a disclosure, not just a misroute (codex P2).
          if ((q.owner ?? null) !== (bannerOwner ?? null)) continue;
          if (native) void Promise.resolve(invoke('notify_native', { n: q })).catch(() => {});
          else sendPluginBanner(q);
        }
      });
      return;
    }
    void probeNative();
  }
  sendPluginBanner(stamped);
}

function sendPluginBanner(n: BuddyBanner): void {
  sendNotification({
    title: n.title,
    body: n.body,
    ...(n.kind === 'session'
      ? { actionTypeId: SESSION_ACTION_TYPE, extra: { sessionCwd: n.cwd } }
      : n.reply
        ? { actionTypeId: DM_ACTION_TYPE, extra: { thread: n.thread, from: n.from } }
        : { extra: { thread: n.thread, from: n.from } }),
  });
}

interface ThreadInfo {
  with: string;
  unread: number;
  lastMessage?: {
    from: string;
    body: string;
  };
}

export function checkAndNotify(threads: ThreadInfo[]): void {
  // Update dock badge regardless of notification permission
  const totalUnread = threads.reduce((sum, t) => sum + t.unread, 0);
  updateDockBadge(totalUnread);

  if (!permissionGranted) {
    // A failed startup permission read used to be cached as false forever. If
    // the OS API failed rather than answered "denied", retry in the background;
    // the next poll will establish a baseline and notifications resume.
    if (!permissionKnown) void hasNotificationPermission();
    return;
  }

  // First call sets baseline — no spam on app start
  if (!initialized) {
    threads.forEach((t) => {
      lastUnreadCounts[t.with] = t.unread;
    });
    initialized = true;
    return;
  }

  // Check for new unreads
  threads.forEach((t) => {
    const prev = lastUnreadCounts[t.with] || 0;
    if (t.unread > prev && t.lastMessage) {
      // New message! Send notification — extra carries the thread so a click
      // can focus Buddy and open the right DM (see initNotificationClicks).
      const preview = t.lastMessage.body.slice(0, 120);
      deliver({
        title: `@${t.lastMessage.from}`,
        body: preview,
        kind: 'dm',
        thread: t.with,
        from: t.lastMessage.from,
        // The reply field. Arrival banners deliberately omit it — there is
        // nothing to reply to when someone merely comes online.
        reply: true,
      });
    }
    lastUnreadCounts[t.with] = t.unread;
  });
}

// ── Session alerts — the reason Buddy is worth keeping installed ────────────
//
// Buddy already SHOWS which sessions want you. This is the half that reaches
// out: the moment a session crosses into wanting you, say so, and let the
// click put the operator back in it. A session stranded behind a prompt
// nobody saw is the hour this product exists to save.
//
// THE RULES, and they matter more than the feature:
//
// 1. **On the transition, never on the state.** A session that has been
//    waiting for an hour is not news every 45 seconds. One notification per
//    crossing into wants-you; the next one requires it to have left first.
// 2. **Baseline silently at startup.** Launching Buddy must never dump a
//    notification per already-waiting session — the first read teaches, it
//    does not announce.
// 3. **Accuracy over coverage.** A wrong alert costs more than a missed one:
//    it is the thing that turns a smoke detector into a smoke detector you
//    take the battery out of. Only the two evidence-backed states qualify,
//    and the classifier already refuses the ambiguous ones.
// 4. **Silence what the operator is already looking at.** No alert while
//    Buddy has focus — they can see it.

/** Action type id for session alerts (no reply field: there is nobody to reply to). */
export const SESSION_ACTION_TYPE = 'vibe-session';

// WHAT THE CLICK CAN DO NOW (buddy#39, fixed on this branch).
//
// The plugin's desktop backend still drops `extra`/`actionTypeId` — that has
// not changed. What changed is that macOS banners no longer go through it:
// src-tauri/src/notify.rs owns a persistent NSUserNotificationCenter delegate
// and reports every interaction on "buddy://notification-action", so a
// session-alert click fronts that session's terminal and a DM banner routes
// to its thread (with inline reply). The plugin path below remains the REAL
// path on other platforms and the fallback when the native probe says no —
// it is not dead code.

/** wants-you state per session directory, for transition detection. */
const lastSessionWants: Record<string, boolean> = {};
let sessionsInitialized = false;

export interface SessionAlert {
  /** The session's working directory — the click target and the state key. */
  cwd: string;
  /** What to call it: the botfile name, the project, or the folder. */
  label: string;
  /**
   * true / false when the transcript answered; **null when we could not see**
   * — a failed or refused read. Missing evidence must never be recorded as
   * "no longer waiting", or the next successful read looks like a fresh
   * transition and re-announces a session that never moved (codex r1 P2).
   */
  wantsYou: boolean | null;
  /** The evidence line, already worded by lib/transcript. */
  line: string | null;
}

export function resetSessionAlertState(): void {
  for (const key of Object.keys(lastSessionWants)) delete lastSessionWants[key];
  sessionsInitialized = false;
}

/**
 * Notify on sessions that JUST started wanting the operator.
 *
 * `appFocused` silences alerts while Buddy is the front window — the board is
 * already telling them. Returns the number of notifications sent, which the
 * tests assert on (and which keeps this function honest about doing nothing
 * on the baseline pass).
 */
export function checkSessionAlerts(
  sessions: SessionAlert[],
  appFocused = false,
  /**
   * Has an authoritative session read actually happened? App starts with an
   * empty array and fetches asynchronously; baselining on that empty
   * pre-fetch snapshot marks the system initialized with no keys, so the
   * first real read then looks like a wave of new transitions and announces
   * the entire backlog (codex r1 P2 — the exact spam the silent baseline
   * exists to prevent).
   */
  authoritative = true,
): number {
  const record = (list: SessionAlert[]) => {
    list.forEach((s) => {
      if (s.wantsYou !== null) lastSessionWants[s.cwd] = s.wantsYou;
    });
  };

  if (!authoritative) return 0;

  if (!permissionGranted) {
    if (!permissionKnown) void hasNotificationPermission();
    // Still track state: when permission arrives we must not then announce
    // everything that has been waiting since launch.
    record(sessions);
    sessionsInitialized = true;
    return 0;
  }

  // Rule 2: the first pass is a baseline, never an announcement.
  if (!sessionsInitialized) {
    record(sessions);
    sessionsInitialized = true;
    return 0;
  }

  let sent = 0;
  for (const s of sessions) {
    // Cannot see: leave the prior state exactly as it was.
    if (s.wantsYou === null) continue;
    const was = lastSessionWants[s.cwd] === true;
    // Rule 1: the transition is the news.
    if (s.wantsYou && !was && !appFocused) {
      deliver({
        title: s.label,
        body: s.line || 'your turn in this session',
        kind: 'session',
        cwd: s.cwd,
      });
      sent += 1;
    }
    // Record the state even when focused, so returning to the app does not
    // then fire a stale alert for something already seen.
    lastSessionWants[s.cwd] = s.wantsYou;
  }
  // A session that disappears (closed, or no longer joinable) forgets its
  // state, so coming back later is a fresh transition rather than silence.
  const present = new Set(sessions.map((s) => s.cwd));
  for (const key of Object.keys(lastSessionWants)) {
    if (!present.has(key)) delete lastSessionWants[key];
  }
  return sent;
}

/**
 * Register a single global handler for notification clicks. When the user clicks
 * a DM notification, focus the Buddy window and route to that thread via the
 * supplied callback. Idempotent — safe to call more than once.
 */
/** Action type id carried on DM notifications so macOS offers the reply field. */
export const DM_ACTION_TYPE = 'vibe-dm';

export async function initNotificationClicks(
  openThread: (handle: string) => void,
  reply?: (handle: string, text: string) => Promise<boolean>,
  /**
   * Clicking a session alert must land the operator IN the session — that
   * one-click return is the whole retention loop, not a convenience.
   */
  openSession?: (cwd: string) => void,
): Promise<void> {
  // The listener is registered once and lives forever, but the CALLBACKS it
  // routes through must always be the current mount's. After ErrorBoundary's
  // "Try again" remounts App, the old closure held the unmounted tree's
  // setView — a DM click routed into a dead component until a full reload
  // (codex P2 r6). So the callbacks live in module refs, refreshed on every
  // call, and the closure only ever reads the refs.
  routeCallbacks = { openThread, reply, openSession };

  // Two registrations, two flags. They used to share one, and the plugin
  // half FAILS on macOS (onAction has no desktop command) — its catch reset
  // the shared flag, so every list remount re-registered the ALREADY-WORKING
  // native listener and one inline reply posted duplicate DMs (codex P1).
  if (nativeRouteRegistered && clickHandlerRegistered) return;

  // Warm the native probe now, before any banner exists — see nativeAvailable.
  void probeNative();

  // THE NATIVE PATH (buddy#39). One event, three routes, and the routing
  // policy lives here and only here — the Rust delegate reports what
  // happened, never what to do about it.
  interface NativeAction {
    id?: string;
    kind?: string;
    thread?: string | null;
    cwd?: string | null;
    owner?: string | null;
    reply?: string | null;
  }
  const route = (p: NativeAction) => {
    // Always the freshest mount's callbacks, never this closure's originals.
    const cb = routeCallbacks;
    if (!cb) return;
    const { openThread, reply, openSession } = cb;
    // Exactly once, whether it arrived live, from the startup drain, or both.
    if (typeof p.id === 'string' && p.id) {
      if (handledActionIds.has(p.id)) return;
      handledActionIds.add(p.id);
      // ...and exactly once across a WEBVIEW RELOAD too: tell Rust this id is
      // handled so it leaves the pending buffer. handledActionIds dies with
      // the page; the buffer does not, and an unacked reply re-drained after
      // a reload posted the same message twice (codex P2).
      void Promise.resolve(invoke('ack_notification_action', { id: p.id })).catch(() => {});
    }
    // A banner from another account — or from before sign-in — gets no
    // action at all. Acting on it would speak as the wrong principal.
    if (p.owner && p.owner !== bannerOwner) return;
    // Session alert: put them back where the work is waiting. Buddy is
    // not the destination — the terminal is.
    if (p.kind === 'session' && p.cwd && openSession) {
      openSession(p.cwd);
      return;
    }
    const text = (p.reply || '').trim();
    if (p.thread && text && reply) {
      // A reply is the whole point of not opening the app: do NOT focus
      // the window here. Surface the thread only if the send fails, so a
      // silent failure cannot masquerade as a sent message.
      void reply(p.thread, text).then((sent) => {
        if (sent) return;
        getCurrentWindow().show()
          .then(() => getCurrentWindow().unminimize())
          .then(() => getCurrentWindow().setFocus())
          .catch(() => {});
        openThread(p.thread!);
      }).catch(() => openThread(p.thread!));
      return;
    }
    // A plain click: focus Buddy and open the conversation.
    getCurrentWindow().show()
      .then(() => getCurrentWindow().unminimize())
      .then(() => getCurrentWindow().setFocus())
      .catch(() => {});
    if (p.thread) openThread(p.thread);
  };

  if (!nativeRouteRegistered) {
    nativeRouteRegistered = true;
    try {
      await listen<NativeAction>('buddy://notification-action', (event) => route(event.payload || {}));
      // Drain actions that fired before this listener existed — a click can
      // LAUNCH Buddy, and the delegate runs long before the webview does
      // (codex P2). The id dedupe makes drain + live delivery safe together.
      void Promise.resolve(invoke<NativeAction[]>('drain_notification_actions'))
        .then((pending) => { for (const p of pending || []) route(p); })
        .catch(() => {});
    } catch {
      // Event system unavailable (test env / very old webview) — the plugin
      // path below still covers whatever the platform supports.
      nativeRouteRegistered = false;
    }
  }

  if (clickHandlerRegistered) return;
  clickHandlerRegistered = true;

  // Inline reply.
  //
  // The most ambient thing a messenger can do is let you answer without
  // becoming the foreground app. macOS supports a text field directly in the
  // banner; this registers it so a DM notification carries one.
  //
  // Registered before the handler so a notification that arrives immediately
  // still gets the reply field.
  try {
    await registerActionTypes([
      {
        id: DM_ACTION_TYPE,
        actions: [
          {
            id: 'reply',
            title: 'Reply',
            input: true,
            inputButtonTitle: 'Send',
            inputPlaceholder: 'Reply…',
          },
        ],
      },
    ]);
  } catch {
    // Older webview or an unsupported platform: notifications still work, they
    // just open the app instead of offering a reply field.
  }

  try {
    await onAction(async (notification) => {
      const extra = notification?.extra as { thread?: string; sessionCwd?: string } | undefined;
      const thread = extra?.thread;

      // A session alert: put them back where the work is waiting. Buddy is
      // not the destination here — the terminal is.
      if (extra?.sessionCwd && openSession) {
        openSession(extra.sessionCwd);
        return;
      }
      // The typed text arrives on the notification payload. Its key has varied
      // across plugin versions, so read the shapes rather than trusting one.
      const raw = notification as unknown as Record<string, unknown>;
      const typed =
        (typeof raw.inputValue === 'string' && raw.inputValue) ||
        (typeof raw.input === 'string' && raw.input) ||
        (typeof raw.userText === 'string' && raw.userText) ||
        '';
      const text = typed.trim();

      // A reply is the whole point of not opening the app, so DO NOT focus the
      // window in this branch — pulling Buddy to the foreground would undo the
      // one thing that makes this worth having.
      if (thread && text && reply) {
        const sent = await reply(thread, text).catch(() => false);
        if (sent) return;
        // If it failed, fall through and surface the thread so the user can see
        // their message did not go, rather than believing a silent success.
      }

      getCurrentWindow()
        .show()
        .then(() => getCurrentWindow().unminimize())
        .then(() => getCurrentWindow().setFocus())
        .catch(() => {});
      if (thread) openThread(thread);
    });
  } catch {
    // onAction unsupported (older webview / platform) — clicks just focus the app
    clickHandlerRegistered = false;
  }
}

function updateDockBadge(count: number): void {
  try {
    invoke('set_dock_badge', { count });
  } catch {}
}

export function resetNotificationState(): void {
  lastUnreadCounts = {};
  initialized = false;
}

// ---------------------------------------------------------------------------
// Arrival
//
// A buddy list's oldest and best trick: someone you know shows up, and you hear
// about it. Until now the ONLY thing Buddy ever notified about was an unread
// DM, so the moment the whole product is built around — presence — was
// invisible unless you happened to be staring at a window that lives hidden in
// the menu bar.
//
// The restraint matters as much as the feature. An arrival ping for everyone,
// every time, is a notification firehose that gets Buddy muted within a day,
// and a muted ambient app is a deleted one. So:
//   - only people you have actually talked to (a thread is the evidence)
//   - never on the first roster after launch (everyone "arrives" at startup)
//   - at most once per person per day
//   - never while you are already looking at Buddy
// ---------------------------------------------------------------------------

const ARRIVAL_KEY = 'buddy_arrival_notified';
let knownActive: Set<string> | null = null;

interface ArrivalUser {
  handle: string;
  status: string;
  isAgent?: boolean;
  oneLiner?: string;
}

function arrivalLog(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(ARRIVAL_KEY) || '{}');
  } catch {
    return {};
  }
}

function rememberArrival(handle: string, day: string, log: Record<string, string>): void {
  log[handle] = day;
  // Drop anyone not seen today so this cannot grow without bound.
  for (const [h, d] of Object.entries(log)) {
    if (d !== day) delete log[h];
  }
  try {
    localStorage.setItem(ARRIVAL_KEY, JSON.stringify(log));
  } catch { /* storage full or unavailable — the ping is not worth failing over */ }
}

/**
 * Notify when someone you know comes online.
 *
 * @param users   current roster
 * @param threads conversations you have — the evidence that you know someone
 */
export async function notifyArrivals(users: ArrivalUser[], threads: ThreadInfo[]): Promise<void> {
  if (!permissionGranted) return;

  const active = new Set(
    users.filter((u) => u.status === 'active').map((u) => u.handle)
  );

  // First roster of the session is the baseline, never an event. Without this
  // every launch would announce everyone who happened to be online.
  if (knownActive === null) {
    knownActive = active;
    return;
  }

  const arrived = [...active].filter((h) => !knownActive!.has(h));
  knownActive = active;
  if (arrived.length === 0) return;

  // Being here to see it yourself is better than being told about it.
  try {
    if (await getCurrentWindow().isFocused()) return;
  } catch { /* if we cannot tell, prefer notifying */ }

  const known = new Set(threads.map((t) => t.with));
  const day = new Date().toDateString();
  const log = arrivalLog();

  for (const handle of arrived) {
    if (!known.has(handle)) continue;        // a stranger arriving is not news
    if (log[handle] === day) continue;       // already said so today
    const user = users.find((u) => u.handle === handle);
    if (user?.isAgent) continue;             // agents come and go constantly

    deliver({
      title: `@${handle} just came online`,
      body: user?.oneLiner || 'on /vibe now',
      kind: 'arrival',
      thread: handle,
      from: handle,
    });
    rememberArrival(handle, day, log);
  }
}

/** Forget the roster baseline — call on sign-out so the next account starts clean. */
export function resetArrivals(): void {
  knownActive = null;
  // The per-day suppression log is identity-scoped too. Without clearing it,
  // account B inherits account A's "already announced" people and silently
  // misses arrivals after a sign-out on the same Mac.
  try {
    localStorage.removeItem(ARRIVAL_KEY);
  } catch { /* storage unavailable — the in-memory baseline is still reset */ }
}
