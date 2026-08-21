// Presence preferences — the vibecoder's control over what Buddy broadcasts.
//
// The heartbeat (App.tsx) has always announced presence automatically from
// CodingDNA. These prefs give the user agency over that broadcast:
//   sharing    — false means invisible: no heartbeats, the presence TTL fades
//                your dot to away/offline on its own
//   detail     — 'minimal' announces you're online but strips CodingDNA
//                (project, branch, model, tech stack, token counts)
//   statusText — a hand-written status line that overrides the DNA-derived one
//
// Persisted in localStorage so the choice survives restarts. A tiny subscribe
// hook lets the heartbeat react to changes instantly (a pref flip shouldn't
// wait up to 5 minutes for the next beat).

import { isFreshAge } from './freshness';

export type PresenceDetail = 'full' | 'minimal';

export interface PresencePrefs {
  sharing: boolean;
  detail: PresenceDetail;
  statusText: string | null;
}

// Snapshot of the last heartbeat actually sent — "what others see right now".
export interface PresenceBroadcast {
  workingOn: string;
  project: string | null;
  branch: string | null;
  model: string | null;
  sentAt: number;
}

// The status line under your own name in the My Presence card. Pure so the
// three failure states stay testable — this line is Buddy's claim about your
// own visibility, and it has already lied once (buddy#10): with wifi off it
// read "presence never landed" minutes after presence had landed.
//
// "Never landed" and "landed, then stopped" are different facts and warrant
// different reactions — never landed means something is misconfigured; stopped
// means something is temporarily wrong. `lastLandedAt` is the wall-clock time
// of the last heartbeat the server confirmed this session, or null if none has
// been. Same shape as the updater fix in d7a1cfa: record whether the operation
// ever succeeded, or "never asked" and "asked, answer was yes" collapse.
/**
 * What Buddy's offline retraction is known to have done. 'inflight' — the
 * write was sent, no answer yet. `{ confirmedAt }` — the server acknowledged
 * it, at that wall-clock moment; the acknowledgement is evidence of a MOMENT
 * and ages out like every other evidence (a terminal heartbeat can relight
 * presence any time after it — codex P1). 'failed' — the write did not land.
 * null — no retraction was sent this run (Buddy booted already invisible).
 */
export type OfflineRetraction = 'inflight' | 'failed' | { confirmedAt: number } | null;

export function presenceStatusLine(args: {
  sharing: boolean;
  broadcast: PresenceBroadcast | null;
  announceGrace: boolean;
  lastLandedAt: number | null;
  now: number;
  /** Receipt for the offline write sent when sharing was switched off. */
  retraction?: OfflineRetraction;
  /**
   * Session rows currently under a good read — they heartbeat on their own.
   * null means the latest read failed: we cannot currently see whether other
   * runtimes broadcast, which is not the same as none doing so.
   */
  liveSessionCount?: number | null;
}): string {
  if (!args.sharing) {
    // "Invisible" is a claim about what OTHERS see, and the pref alone cannot
    // back it (audit #6): the offline write can fail, and coding sessions
    // heartbeat the same handle independently of Buddy's pref. Each branch
    // claims exactly what its evidence covers, nothing wider.
    if (args.retraction === 'inflight') return 'Going invisible — clearing your presence…';
    if (args.retraction === 'failed') return "Buddy heartbeats paused — couldn't confirm your dot cleared";
    if ((args.liveSessionCount ?? 0) > 0) return 'Buddy heartbeats paused — coding sessions broadcast you separately';
    // The word "Invisible" needs ALL of: a fresh server acknowledgement, and
    // a succeeding sessions read showing no other broadcaster. A stale
    // receipt, or eyes we don't currently have, both fall to the plain line.
    if (
      args.retraction !== null &&
      typeof args.retraction === 'object' &&
      isFreshAge(args.now - args.retraction.confirmedAt) &&
      args.liveSessionCount === 0
    ) {
      return 'Invisible — the server cleared your presence';
    }
    return 'Buddy heartbeats paused — not broadcasting';
  }
  // A broadcast is "what others see" only while it is FRESH by the same 10-min
  // clock every other dot uses (freshness.GREEN_FRESH_MS). Past that the server
  // has faded us — the Mac slept, or a terminal heartbeat took over the row —
  // and we can no longer claim current visibility. A stale broadcast falls to
  // the "stopped updating" line below (audit #5, the buddy#10 shape).
  if (args.broadcast && isFreshAge(args.now - args.broadcast.sentAt)) return args.broadcast.workingOn;
  // First-announcement grace is ONLY for when nothing has ever landed. A
  // broadcast that has gone stale must read "stopped updating", never
  // "Announcing…" — which would be an unbounded progress claim over dead
  // evidence while the dot is already dimmed (codex, cluster review).
  if (args.announceGrace && args.broadcast === null) return 'Announcing…';
  // Age the "stopped updating" line from whichever landing evidence we have.
  const anchor = args.lastLandedAt ?? (args.broadcast ? args.broadcast.sentAt : null);
  if (anchor !== null) {
    const ago = formatAgeShort(Math.max(0, Math.round((args.now - anchor) / 1000)));
    return `Presence stopped updating ${ago} — you may not be visible`;
  }
  return 'Not visible to others — presence never landed';
}

// The dot on your own card. Green is reserved for server-confirmed presence
// (ROOM TONE; TRUE-NORTH §4 law 2), and a sharing pref is an intention, not a
// confirmation — the dot was keyed on the pref, so it stayed green while the
// status line on the same card said "presence stopped updating". The landed
// broadcast is the confirmation; only that earns the reserved colour.
export function selfDotConfirmed(args: {
  sharing: boolean;
  broadcast: PresenceBroadcast | null;
  now: number;
}): boolean {
  // Same freshness gate as the status line: a broadcast older than the green
  // window is no longer confirmation of current visibility (audit #5).
  return args.sharing && args.broadcast !== null && isFreshAge(args.now - args.broadcast.sentAt);
}

function formatAgeShort(agoSeconds: number): string {
  if (agoSeconds < 60) return `${agoSeconds}s ago`;
  if (agoSeconds < 3600) return `${Math.floor(agoSeconds / 60)}m ago`;
  return `${Math.floor(agoSeconds / 3600)}h ago`;
}

const KEY = 'buddy_presence_prefs';
// First-launch stance (decided 2026-08-09, take-stock Move 0d): presence ON —
// the product is presence, and installs arrive through a personal invitation —
// but detail MINIMAL. Full conversational detail is an explicit choice a
// person makes, never a default they discover they'd been making.
const DEFAULTS: PresencePrefs = { sharing: true, detail: 'minimal', statusText: null };
// A first launch may default visible. Corrupt persisted state may not: if the
// user chose Invisible and storage is later truncated, resuming broadcasts is
// the unsafe guess.
const STORAGE_FAILURE_DEFAULTS: PresencePrefs = { sharing: false, detail: 'minimal', statusText: null };
const STATUS_MAX_LEN = 120;

let listeners: Array<(p: PresencePrefs) => void> = [];

export function getPresencePrefs(): PresencePrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<PresencePrefs>;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.sharing !== 'boolean') {
      return { ...STORAGE_FAILURE_DEFAULTS };
    }
    return {
      sharing: parsed.sharing,
      detail: parsed.detail === 'minimal' ? 'minimal' : 'full',
      statusText:
        typeof parsed.statusText === 'string' && parsed.statusText.trim()
          ? parsed.statusText.trim().slice(0, STATUS_MAX_LEN)
          : null,
    };
  } catch {
    return { ...STORAGE_FAILURE_DEFAULTS };
  }
}

export function setPresencePrefs(patch: Partial<PresencePrefs>): PresencePrefs {
  const next = { ...getPresencePrefs(), ...patch };
  if (next.statusText !== null) {
    const trimmed = next.statusText.trim().slice(0, STATUS_MAX_LEN);
    next.statusText = trimmed || null;
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage can be unavailable; prefs still apply for this session via listeners.
  }
  for (const fn of listeners) fn(next);
  return next;
}

export function subscribePresencePrefs(fn: (p: PresencePrefs) => void): () => void {
  listeners.push(fn);
  return () => {
    listeners = listeners.filter((l) => l !== fn);
  };
}
