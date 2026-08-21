// The Doorbell — Buddy client for summon contract v0.1 (dark-launched).
//
// Contract: platform DOORBELL-CONTRACT.md (summon profile of the invite/consent
// seam). Buddy is the `surface: "app"` origin: authenticated by the app session
// (Bearer JWT), no capability URL — the agent's address resolves server-side,
// the standing grant gates it.
//
// DARK LAUNCH: the server side (porch + summon, behind DOORBELL_ENABLED) is
// built but not yet merged/deployed — production 404s. This client PROBES for
// the endpoint: while it's absent every affordance stays hidden, and the
// doorbell lights up in Buddy the moment the platform flips, with no client
// release needed. The route path is explicitly the platform builder's call
// ("final path is the builder's; the shape is the contract"), so it's
// centralized here and overridable for testing via localStorage
// `buddy_doorbell_base`.
//
// Blind by design: the server answers a uniform 202 {summon_ref} for success,
// no-grant, unknown-agent, and agent-declined alike. Buddy therefore never
// claims an outcome — the copy is "doorbell rung", and the body appearing (or
// not) is the answer. Don't "improve" this with status guesses; the blindness
// is an anti-enumeration property of the contract, not a UX gap.

import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { buddyClient } from './vibeClient';

const DEFAULT_BASE = 'https://www.slashvibe.dev/api/doorbell';
const REQUEST_TIMEOUT_MS = 15_000;

async function fetchDoorbell(init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await tauriFetch(base(), { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export interface SummonableAgent {
  agent: string;          // handle, e.g. "coltrane"
  displayName?: string;
  archetype?: string;
}

export interface SummonRequest {
  agent: string;
  meetUrl: string;
  purpose: string;        // 1-160 chars, required — lands in the receipt
}

export interface SummonResult {
  rung: boolean;          // a 202 came back — nothing more is knowable
  summonRef?: string;
  error?: string;         // transport/validation only, never an outcome
}

function base(): string {
  try {
    return localStorage.getItem('buddy_doorbell_base') || DEFAULT_BASE;
  } catch {
    return DEFAULT_BASE;
  }
}

// Single-use nonce: 8-128 url-safe chars per contract.
function nonce(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[b & 63]).join('');
}

// Probe result cached per app run; re-probed on an interval so a platform-side
// flip lights Buddy up within a few minutes, not on next restart.
let cachedSummonable: SummonableAgent[] | null = null;
let lastProbeAt = 0;
let probeInFlight: Promise<SummonableAgent[]> | null = null;
const PROBE_TTL_MS = 5 * 60 * 1000;

// A retained quick-dial is evidence of a grant, and evidence ages out. Through
// repeated failed probes the cache used to survive indefinitely, offering
// "Summon" on a grant last confirmed hours ago (honest-state audit #15). One
// missed probe cycle keeps the list (a blip shouldn't empty the porch); after
// that the affordance hides until a probe succeeds again.
const GRANT_EVIDENCE_TTL_MS = 3 * PROBE_TTL_MS;

function retainedQuickDial(now: number): SummonableAgent[] {
  if (cachedSummonable === null) return [];
  return now - lastProbeAt <= GRANT_EVIDENCE_TTL_MS ? cachedSummonable : [];
}

/**
 * The quick-dial: agents this user holds a live summon grant for, with an
 * installed doorbell. Empty (and cached) while the endpoint isn't deployed —
 * which is exactly the dark-launch switch: no agents, no UI.
 */
async function performSummonableProbe(): Promise<SummonableAgent[]> {
  const now = Date.now();
  const token = buddyClient.getAuthToken();
  if (!token) return retainedQuickDial(now);

  try {
    const response = await fetchDoorbell({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'X-Vibe-Client': 'buddy',
      },
      body: JSON.stringify({ action: 'list_summonable', v: 'doorbell/0.1' }),
    });
    if (!response.ok) {
      // 404/405/501 = endpoint not deployed or gated off → feature stays dark.
      if ([404, 405, 501].includes(response.status)) {
        cachedSummonable = [];
        lastProbeAt = now;
      }
      // A 500 learned nothing. Preserve a previously visible quick-dial
      // through a blip rather than making agents disappear — but only while
      // the last successful probe is recent enough to count as evidence.
      return retainedQuickDial(now);
    }
    const data = await response.json() as { summonable?: SummonableAgent[] };
    if (!Array.isArray(data.summonable)) return retainedQuickDial(now);
    cachedSummonable = data.summonable;
    lastProbeAt = now;
    return cachedSummonable;
  } catch {
    return retainedQuickDial(now);
  }
}

export function getSummonable(): Promise<SummonableAgent[]> {
  const now = Date.now();
  if (cachedSummonable !== null && now - lastProbeAt < PROBE_TTL_MS) {
    return Promise.resolve(cachedSummonable);
  }
  if (probeInFlight) return probeInFlight;
  probeInFlight = performSummonableProbe().finally(() => {
    probeInFlight = null;
  });
  return probeInFlight;
}

/**
 * Ring the doorbell: summon an agent into an existing Google Meet.
 * Returns rung=true on the contract's blind 202 — the caller learns the real
 * outcome only by the body appearing in the room (or not).
 */
export async function summonAgent(req: SummonRequest): Promise<SummonResult> {
  const token = buddyClient.getAuthToken();
  const handle = buddyClient.getHandle();
  if (!token || !handle) return { rung: false, error: 'not signed in' };

  const purpose = req.purpose.trim().slice(0, 160);
  if (!purpose) return { rung: false, error: 'purpose is required' };
  if (!/^https:\/\/meet\.google\.com\//.test(req.meetUrl.trim())) {
    return { rung: false, error: 'paste a Google Meet link (https://meet.google.com/…)' };
  }

  try {
    const response = await fetchDoorbell({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'X-Vibe-Client': 'buddy',
      },
      body: JSON.stringify({
        action: 'summon_agent',
        v: 'doorbell/0.1',
        agent: req.agent.replace(/^@/, ''),
        meet: { platform: 'google-meet', url: req.meetUrl.trim() },
        origin: { surface: 'app', actor: handle },
        purpose,
        nonce: nonce(),
        ts: new Date().toISOString(),
      }),
    });
    // "Doorbell rung" is a claim, and the contract defines exactly one shape
    // that earns it: 202 + {summon_ref}. Any other 2xx — a proxy page, a
    // half-deployed route, a wrong endpoint answering 200 — used to read as
    // rung when nothing was (honest-state audit #16). The blindness contract
    // is unchanged: a real 202 still says nothing about the outcome.
    if (response.status === 202) {
      const data = await response.json().catch(() => null) as { summon_ref?: unknown } | null;
      if (data && typeof data.summon_ref === 'string' && data.summon_ref) {
        return { rung: true, summonRef: data.summon_ref };
      }
      return { rung: false, error: 'doorbell answered out of contract (202 without summon_ref)' };
    }
    return { rung: false, error: `doorbell unavailable (${response.status})` };
  } catch (e) {
    return { rung: false, error: 'could not reach the doorbell' };
  }
}
