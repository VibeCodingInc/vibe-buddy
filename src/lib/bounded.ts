/**
 * Bounded append + bounded dedupe.
 *
 * Buddy is now an app that runs for a week without a restart (menu bar, opens
 * at login), which turns "this array only ever grows" from a theoretical note
 * into a real leak. The Session and Call panels each kept an append-only list
 * of messages plus an append-only Set of ids to dedupe them — neither with a
 * ceiling.
 *
 * One helper rather than four hand-rolled caps: the recurring lesson this week
 * is that the same rule written twice becomes two rules.
 */

/** Messages kept in a panel. Generous — this is a display buffer, not history. */
export const MESSAGE_CAP = 200;

/**
 * Ids remembered for dedupe. Deliberately larger than MESSAGE_CAP: forgetting
 * an id the server still returns would re-admit that message as "new", so the
 * dedupe memory must outlive what's on screen.
 */
export const SEEN_CAP = MESSAGE_CAP * 3;

/** Append, keeping only the most recent `cap` entries. */
export function appendCapped<T>(prev: T[], next: T[], cap: number = MESSAGE_CAP): T[] {
  if (next.length === 0) return prev;
  const merged = [...prev, ...next];
  return merged.length > cap ? merged.slice(-cap) : merged;
}

/**
 * Remember ids, evicting the oldest once past `cap`.
 * Set iteration is insertion-ordered, so the first entries out are the ones
 * added longest ago.
 */
export function rememberIds(seen: Set<string>, ids: Iterable<string>, cap: number = SEEN_CAP): void {
  for (const id of ids) seen.add(id);
  if (seen.size <= cap) return;
  const excess = seen.size - cap;
  let dropped = 0;
  for (const id of seen) {
    if (dropped >= excess) break;
    seen.delete(id);
    dropped += 1;
  }
}
