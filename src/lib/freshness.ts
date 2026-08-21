// One local freshness rule for the reserved green — matching the MCP board.
//
// The terminal's presence board (mcp-server/tools/who.js) treats a heartbeat
// under 10 minutes old as "here" and anything older as idle. Buddy's dots now
// spend green by the same clock, so the two surfaces a person sees side by
// side never disagree about who is lit. This is a presentation rule for the
// prototype: the server still owns status; this only decides whether the
// reserved colour is earned.

export const GREEN_FRESH_MS = 10 * 60_000;

export const isFreshAge = (ageMs: number): boolean => ageMs < GREEN_FRESH_MS;

/**
 * Green is the assertion, so it needs evidence of freshness — a missing or
 * unparseable timestamp is no evidence at all, and withholding the reserved
 * colour claims nothing (honest-state audit #11; same reversal as
 * isUnproven). An earlier version returned fresh here on the reasoning that
 * "the server said active"; that kept a malformed field green forever.
 *
 * Known residue: `lastSeen` is a server-clock timestamp compared against the
 * Mac clock, so backward skew can keep expired evidence green. The real fix
 * is a server-computed age on the presence contract (tracked with audit #12).
 */
export function isFreshLastSeen(lastSeen: string | undefined, now: number): boolean {
  if (!lastSeen) return false;
  const t = Date.parse(lastSeen);
  return Number.isNaN(t) ? false : isFreshAge(now - t);
}
