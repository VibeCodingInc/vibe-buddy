import { isFreshAge } from './freshness';

// The state model for "your own coding sessions", and the ONE definition of
// the copy each state renders. Extracted so the list, the empty room, and the
// tests all read the same truth — the pattern presencePrefs.presenceStatusLine
// set, applied to the /api/my-sessions read.
//
// Two separate facts, never conflated (codex integration review, 2026-08-04):
//   - the SNAPSHOT: the last sessions array a good read returned. Retained
//     across failures so a network blip doesn't erase rows the server never
//     said were gone.
//   - the CERTAINTY: whether the LATEST read succeeded. A failed read means
//     we cannot currently see — even if we could a minute ago.
// Retaining the snapshot must not retain the certainty: retained rows render
// with an explicit stale line and age honestly (effectiveAgoMs below), and a
// verified-empty followed by a failed read says "can't see", never "none".

export type MySessionsProbe =
  | 'unasked' // no read has resolved yet — say we're checking, claim nothing
  | 'known' // the LATEST read succeeded; the array is current truth
  | 'unchecked'; // the LATEST read failed — we cannot see right now

/**
 * Fold one read result into the probe. The probe is about the latest read
 * only: success is 'known', failure is 'unchecked', no matter what came
 * before. Snapshot retention is the caller's separate concern.
 */
export function nextMySessionsProbe(readError: boolean): MySessionsProbe {
  return readError ? 'unchecked' : 'known';
}

/**
 * The line the empty room shows when there are no session rows to draw.
 * Each state gets its own sentence, and none of them may claim another's fact:
 * a failed request is never "no sessions", and "no sessions" never hedges as
 * if it might be a failure.
 */
export function mySessionsEmptyLine(probe: MySessionsProbe): string {
  switch (probe) {
    case 'unasked':
      return 'checking your sessions…';
    case 'known':
      return 'no coding sessions right now — open Claude Code or Codex and this fills in on its own';
    case 'unchecked':
      return "can't see your sessions — reconnecting. showing nothing rather than guessing.";
  }
}

/**
 * The line under RETAINED rows while the latest read is failing: the rows are
 * a snapshot, and the reader deserves to know how old. `agoText` is the
 * caller-formatted age of the last good read ("2m ago").
 */
export function mySessionsStaleLine(agoText: string): string {
  return `reconnecting — sessions as of ${agoText}`;
}

/**
 * First-recognition line, shown under FRESH session rows in the quiet room —
 * the one place Buddy says out loud what a session row IS. Presence only:
 * it deliberately does not claim "configured", "connected", or call
 * readiness — a heartbeat proves none of those. The call-capability claim
 * this line used to carry was audit #7: a /vibe heartbeat proves neither
 * vibeconf availability nor a /join-call capability, so that claim returns
 * only behind a capability receipt.
 * Never shown over a stale snapshot: recognition is a now-claim.
 */
export const FIRST_RECOGNITION = 'this session shows up as you';

/**
 * What the sessions block should draw. Rows beat lines, but stale rows say
 * so: a retained snapshot under a failing read is 'rows-stale', never plain
 * rows. ('unasked' with rows cannot occur — rows only exist after a read.)
 */
export function mySessionsBlock(
  probe: MySessionsProbe,
  sessionCount: number,
): { kind: 'rows' } | { kind: 'rows-stale' } | { kind: 'line'; line: string } {
  if (sessionCount > 0) {
    return probe === 'unchecked' ? { kind: 'rows-stale' } : { kind: 'rows' };
  }
  return { kind: 'line', line: mySessionsEmptyLine(probe) };
}

/**
 * How old a session's heartbeat REALLY is right now.
 *
 * `agoSeconds` was true at the moment the response was received; a row
 * rendered from a retained snapshot must not stay "12s ago" forever. Age =
 * age-at-receipt + elapsed local time since receipt — so a row drifts from
 * "12s ago" to "1m ago" during an outage and loses its green when it crosses
 * the freshness gate, exactly like every other dot.
 *
 * `agoSeconds` and the platform's optional timestamps are produced on the
 * server clock. `observedAt` here is deliberately the LOCAL receipt time, so
 * adding local elapsed time cannot inherit server/Mac clock skew. The absolute
 * `lastSeenAt` remains useful provenance, but it is not a UI clock.
 */
export function effectiveAgoMs(
  session: { agoSeconds: number; lastSeenAt?: number | string },
  observedAt: number | undefined,
  now: number,
): number {
  const elapsedSinceReceipt = observedAt === undefined ? 0 : Math.max(0, now - observedAt);
  return session.agoSeconds * 1000 + elapsedSinceReceipt;
}

/**
 * How many sessions are broadcasting NOW, by the same effective-age gate the
 * rows' green dots use. The platform retains rows for minutes after their
 * last heartbeat, so a raw row count claims broadcasters whose liveness
 * evidence has expired — the exact overclaim the invisible card's "coding
 * sessions broadcast you separately" line must not make (codex P2 r3).
 */
export function freshSessionCount(
  sessions: Array<{ agoSeconds: number; lastSeenAt?: number | string }>,
  observedAt: number | undefined,
  now: number,
): number {
  return sessions.filter((s) => isFreshAge(effectiveAgoMs(s, observedAt, now))).length;
}
