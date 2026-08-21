// The interval priority — identity → exchange → continuity → room.
//
// Buddy owns the interval between turns (TRUE-NORTH §4 law 3). In that
// interval the thing that matters most is the exchange that is already
// waiting, so unread conversations outrank presence lanes. These helpers are
// pure so the ordering is testable; they present the platform's unread counts
// and message order untouched — no local definition of unread, read, or
// delivery lives here or anywhere else in Buddy.

import type { VibeThread, MySession } from './vibeClient';

/**
 * The WAITING block: every thread holding unread messages, newest reply
 * first. The paired partner is excluded — the pair hero card already leads
 * with that thread, and a principal is presented once.
 */
export function waitingThreads(threads: VibeThread[], pairedWith?: string): VibeThread[] {
  return threads
    .filter((t) => t.unread > 0 && t.with !== pairedWith)
    .sort((a, b) =>
      (b.lastMessage?.created_at || '').localeCompare(a.lastMessage?.created_at || ''),
    );
}

/**
 * One quiet line for the collapsed MY SESSIONS header: the count plus the
 * most recently active session's project, e.g. "checkout-api". Callers use
 * this only when there is more than one session; a single session renders as
 * its normal full row.
 */
export function sessionsSummary(sessions: MySession[]): string {
  if (sessions.length === 0) return '';
  const mostRecent = [...sessions].sort((a, b) => a.agoSeconds - b.agoSeconds)[0];
  return mostRecent.project || '';
}
