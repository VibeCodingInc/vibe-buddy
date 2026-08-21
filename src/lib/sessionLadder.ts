// The four facts of bringing a session into a call, as separately-evidenced
// rungs — the ladder from the 2026-08-03 handshake review (canon SHA 53869aa6;
// platform canon 67e85854). The law this module exists to enforce: the four
// facts are never collapsed into one light. Each rung names its own evidence,
// each decays on its own clock, and a rung we cannot verify says so instead of
// borrowing certainty from its neighbors.
//
// Pattern-sibling of mySessionsState.ts: pure derivations, one definition of
// the copy, the UI and the tests read the same truth.

import { isFreshAge } from './freshness';
import type { MySessionsProbe } from './mySessionsState';

/**
 * One rung's state. 'live' is reserved for evidence that someone/something is
 * here NOW (the green-dot class — today that is rung ② under a fresh
 * heartbeat, and nothing else; rung ③ may re-earn it only from Meet
 * participant evidence, which no signal carries yet). 'yes' is verified fact
 * that is not a presence claim (ink ✓, never green). 'no' is
 * honestly-not-right-now. 'unknown' is cannot-see — distinct from 'no',
 * exactly as the my-sessions probe keeps "failed read" distinct from
 * "no sessions".
 */
export type Rung =
  | { state: 'yes'; evidence: string }
  | { state: 'live'; evidence: string }
  | { state: 'no'; evidence: string }
  | { state: 'unknown'; evidence: string };

/** The ladder, rung by rung. Order is the canon order and the render order. */
export interface SessionLadder {
  /** ① the session has /vibe — proven by the receipt existing at all. */
  configured: Rung;
  /** ② the session is heartbeating — proven by fresh age, decays honestly. */
  heartbeating: Rung;
  /** ③ a seat is in the room — only Meet participant evidence can prove it. */
  seated: Rung;
  /** ④ THIS session drives the seat — no primitive exists; always unknown. */
  driving: Rung;
}

/**
 * What Buddy knows about the local seat app (vibeconf) at render time.
 * Mirrors the row's CallProbe but carries the call fact when we have it:
 *  - 'closed'   — probe answered: the app is not running
 *  - 'unknown'  — probe failed: we learned nothing (NOT evidence of closed)
 *  - 'idle'     — app is running, reports no call (includes 'left')
 *  - 'joining'  — app reports it is entering a room, not seated yet
 *  - 'in-call'  — app is running and reports a live room
 *  - 'running'  — app is running but its call state could not be read
 *                 (absent/renamed fields degrade here, never to a guess)
 */
export type SeatProbe =
  | { kind: 'checking' }
  | { kind: 'closed' }
  | { kind: 'unknown' }
  | { kind: 'idle' }
  | { kind: 'joining'; room?: string | null }
  | { kind: 'in-call'; room: string }
  | { kind: 'running' };

/** Compact age for evidence copy — "8s ago" / "3m ago" / "1h ago". */
function ago(ageMs: number): string {
  const s = Math.max(0, Math.round(ageMs / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

/**
 * ① configured. The receipt itself is the evidence: a row only exists because
 * the session's own /vibe server heartbeated it. While the latest read is
 * failing, the fact was true as of the retained snapshot — say when, claim
 * nothing newer.
 */
export function configuredRung(probe: MySessionsProbe, clientName: string | undefined, snapshotAgeMs: number | undefined): Rung {
  const client = clientName || 'this session';
  if (probe === 'known') {
    return { state: 'yes', evidence: `/vibe heartbeats from ${client}` };
  }
  return {
    state: 'unknown',
    evidence: snapshotAgeMs === undefined
      ? `can't confirm right now`
      : `last confirmed ${ago(snapshotAgeMs)}`,
  };
}

/**
 * ② heartbeating. The only rung that may go green: fresh heartbeat age under
 * a succeeding read is live presence. Old age is an honest 'no' (gone quiet),
 * and a failing read is 'unknown' — we cannot see, which is not the same as
 * quiet.
 */
export function heartbeatingRung(probe: MySessionsProbe, effectiveAgeMs: number): Rung {
  if (probe !== 'known') {
    return { state: 'unknown', evidence: `can't see — last known ${ago(effectiveAgeMs)}` };
  }
  if (isFreshAge(effectiveAgeMs)) {
    return { state: 'live', evidence: `last seen ${ago(effectiveAgeMs)}` };
  }
  return { state: 'no', evidence: `gone quiet — last heartbeat ${ago(effectiveAgeMs)}` };
}

/**
 * ③ seated. "Seated" means admitted to the Meet, and the only evidence for
 * that is the Meet participants list — a signal nothing carries to Buddy yet.
 * The seat app's own 'in-call' is an assertion about its machinery, not about
 * admission (the field record: seven accepts, zero seats), so it renders as
 * the assertion it is and never spends green. A probe failure is 'unknown',
 * and a running app whose call state we could not read is also 'unknown'
 * (with different words).
 */
export function seatedRung(seat: SeatProbe): Rung {
  switch (seat.kind) {
    case 'checking':
      // The ask is in flight: claim nothing either way, and say which
      // nothing this is — not-yet-asked, not could-not-ask.
      return { state: 'unknown', evidence: `checking the seat…` };
    case 'closed':
      return { state: 'no', evidence: `seat app isn't running` };
    case 'unknown':
      return { state: 'unknown', evidence: `couldn't ask the seat app` };
    case 'idle':
      return { state: 'no', evidence: `seat is ready — no call yet` };
    case 'joining':
      return { state: 'no', evidence: seat.room ? `seat is joining ${seat.room}…` : `seat is joining a room…` };
    case 'in-call':
      // Qualifier first: the row's evidence span ellipsizes at narrow widths,
      // and a truncation must never re-create the overclaim this rung exists
      // to prevent (codex P2 on the audit-#10 fix).
      return { state: 'unknown', evidence: `admission unverified — seat app reports in ${seat.room}` };
    case 'running':
      return { state: 'unknown', evidence: `seat is running — call state unreadable` };
  }
}

/**
 * ④ driving. No primitive verifies which session controls a seat — the
 * review's biggest gap, and this rung's honesty is the point of the ladder.
 * A constant until the claim primitive exists.
 */
export const DRIVING_RUNG: Rung = {
  state: 'unknown',
  evidence: `can't verify yet — nothing proves which session drives the seat`,
};

/** The whole ladder from the signals the row already has. */
export function sessionLadder(args: {
  probe: MySessionsProbe;
  clientName?: string;
  /** Age of the retained snapshot itself (now - observedAt), if any. */
  snapshotAgeMs?: number;
  /** The session's effective heartbeat age (effectiveAgoMs). */
  effectiveAgeMs: number;
  seat: SeatProbe;
}): SessionLadder {
  return {
    configured: configuredRung(args.probe, args.clientName, args.snapshotAgeMs),
    heartbeating: heartbeatingRung(args.probe, args.effectiveAgeMs),
    seated: seatedRung(args.seat),
    driving: DRIVING_RUNG,
  };
}
