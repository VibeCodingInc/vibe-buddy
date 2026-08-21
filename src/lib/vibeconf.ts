// Handing a call to vibeconf.
//
// Buddy does not own a call. Starting one from a session row is the first real
// instance of the handoff: the session already IS a context (project, cwd, what
// you're working on), so a call started from it arrives pre-explained instead of
// being an empty room someone has to talk their way into.
//
// The contract is the vibeconf lane's (Pepper, 2026-07-30). Two constraints
// worth restating here because they are easy to "improve" and both would break:
//
//   - Availability is checked at the MOMENT of use, never cached. The app can
//     quit, and a Meet expires. Buddy renders what it just learned or nothing.
//   - Buddy never shows who is in the room, or what the bot is doing. No
//     reliable query exists for outsiders, so anything we drew would be
//     invented — the exact defect this codebase keeps repeating.

import { invoke } from '@tauri-apps/api/core';
import type { SeatProbe } from './sessionLadder';

export interface CallInfo {
  url: string;
  code: string;
}

export interface VibeconfAvailability {
  available: boolean;
  error: boolean;
}

/** Is the Vibeconferencing app usable right now? Ask every time. */
export async function vibeconfAvailability(): Promise<VibeconfAvailability> {
  try {
    const port = await invoke<number | null>('vibeconf_available');
    return { available: typeof port === 'number', error: false };
  } catch {
    // An IPC failure is not evidence that Vibeconferencing is unavailable.
    // Callers surface this state instead of silently deleting the affordance.
    return { available: false, error: true };
  }
}

/** Back-compat for callers that cannot render an availability-check failure. */
export async function vibeconfAvailable(): Promise<boolean> {
  return (await vibeconfAvailability()).available;
}

/**
 * The seat app's own report of its call state, for the session ladder's
 * rung ③. Same never-cached rule as availability. The shape is the Rust
 * SeatState enum, which serializes to the ladder's SeatProbe directly; an
 * IPC failure reads as 'unknown' — we learned nothing, and say so.
 */
export async function vibeconfSeatState(): Promise<SeatProbe> {
  try {
    return await invoke<SeatProbe>('vibeconf_seat_state');
  } catch {
    return { kind: 'unknown' };
  }
}

/**
 * Mint a call and get its join link.
 *
 * The app does the actual work: it creates the Meet, sends the user's bot in,
 * and opens their browser. Buddy's whole job is asking, and then handing over
 * the one line that makes it session-scoped.
 */
let callInFlight: Promise<CallInfo> | null = null;

export function startCall(context?: string): Promise<CallInfo> {
  if (callInFlight) return callInFlight;
  callInFlight = (async () => {
    try {
      return await invoke<CallInfo>('vibeconf_start_call', { context: context || null });
    } finally {
      callInFlight = null;
    }
  })();
  return callInFlight;
}

/**
 * What the room should already know when it opens.
 *
 * A call started from a coding session arrives pre-explained instead of being
 * an empty room someone has to talk their way into — the session already IS the
 * context. Posted into the Meet chat as its first message.
 */
export function sessionContext(s: {
  project?: string;
  cwd?: string;
  workingOn?: string;
}): string {
  const bits = [
    s.project ? `session: ${s.project}` : null,
    s.cwd || null,
    s.workingOn ? `working on: ${s.workingOn}` : null,
  ].filter(Boolean);
  return bits.length > 0 ? `launched from ${bits.join(' · ')}` : '';
}

/**
 * The line the user pastes into the coding session they launched from.
 *
 * This is the feature, not a garnish. Buddy cannot put a brain in the bot —
 * the bot's brain is whichever Claude Code session drives it, and two drivers
 * wedge a call. Pasting this into the session that is already working in that
 * cwd is what makes the agent walk into the room already knowing the work.
 */
export function joinLine(code: string): string {
  return `/join-call ${code}`;
}
