/**
 * The menu-bar counts, with evidence or not at all.
 *
 * The tray and the Dock badge are read at a glance, with none of the list's
 * "reconnecting · last synced" context beside them. So a count is shown only
 * while the read behind it is fresh: a failed read may keep the last value for
 * the same grace the list uses (STALE_AFTER_MS), and past that the count is
 * UNKNOWN (null) — rendered as unknown, never as the last value and never as
 * zero. A first read that has never succeeded is unknown from the start.
 */

export interface TrayCountsInput {
  now: number;
  me: string | null;
  /** This cycle's presence read: the users, or null when it failed. */
  users: Array<{ handle: string; status: string }> | null;
  /** This cycle's thread read: the threads, or null when it failed. */
  threads: Array<{ unread?: number }> | null;
  /** What the list still shows from the last good reads. */
  retainedUsers: Array<{ handle: string; status: string }>;
  retainedThreads: Array<{ unread?: number }>;
  /** When each read last succeeded (null = never this session). */
  presenceGoodAt: number | null;
  threadsGoodAt: number | null;
  staleAfterMs: number;
}

export interface TrayCounts { online: number | null; unread: number | null }

const onlineOf = (users: Array<{ handle: string; status: string }>, me: string | null) =>
  users.filter((u) => u.status === 'active' && u.handle !== me).length;
const unreadOf = (threads: Array<{ unread?: number }>) =>
  threads.reduce((sum, t) => sum + (t.unread || 0), 0);

export function trayCounts(i: TrayCountsInput): TrayCounts {
  const fresh = (at: number | null) => at !== null && i.now - at <= i.staleAfterMs;
  const online = i.users ? onlineOf(i.users, i.me) : fresh(i.presenceGoodAt) ? onlineOf(i.retainedUsers, i.me) : null;
  const unread = i.threads ? unreadOf(i.threads) : fresh(i.threadsGoodAt) ? unreadOf(i.retainedThreads) : null;
  return { online, unread };
}
