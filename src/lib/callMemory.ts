// The call you just started.
//
// Buddy mints a Meet, copies the join line, opens a browser — and then forgets
// everything. Close the toast or switch view and the link is gone, with no way
// to get it back short of starting a second call. That is a bad trade for a
// gesture whose whole point is bringing someone else in.
//
// WHAT THIS DELIBERATELY IS NOT: room state. Buddy has no reliable way to know
// whether a call is still live, who is in it, or what the bot is doing, and the
// vibeconf contract is explicit that it must not guess. So this records a fact
// about what the USER did — "you started a call 12 minutes ago, here is the
// link you were given" — which is local knowledge, always true, and never a
// claim about the room.

const KEY = 'buddy_last_call';

/**
 * How long the memory is worth showing.
 *
 * Not how long the Meet lives — we cannot know that. This is how long "you
 * started a call" stays useful before it is just clutter in a 300px window.
 */
export const CALL_MEMORY_TTL_MS = 2 * 60 * 60 * 1000;

export interface RememberedCall {
  url: string;
  code: string;
  /** Where it was started from, for the label: a project name or a handle. */
  from?: string;
  /**
   * The originating conversation (a /vibe handle), when the call was started
   * from a thread. This is the RETURN ADDRESS: after the call, one action
   * reopens exactly this thread (#329 — the participant returns to work).
   */
  thread?: string;
  /**
   * A private pointer to YOUR OWN work the call was about — the session it
   * was started from (its id and project). Local only; never sent anywhere;
   * never shown to the other participant. It exists so Buddy can put you back
   * where you were, not so the room knows your machine.
   *
   * It is set only when the local origin is actually known (a call started
   * from one of your session rows). A call started from a conversation does
   * not know your work location, so it records none — the other person's
   * project is THEIR work, never a stand-in for yours (Astra, #22 read).
   */
  work?: { project?: string; sessionId?: string };
  /**
   * The account that started the call. The return action is offered only to
   * this account: after a sign-out, the next person must not inherit a way
   * into someone else's conversation (codex P2 on #22).
   */
  account?: string;
  startedAt: number;
}

export function rememberCall(call: Omit<RememberedCall, 'startedAt'>): void {
  try {
    const record: RememberedCall = { ...call, startedAt: Date.now() };
    localStorage.setItem(KEY, JSON.stringify(record));
  } catch {
    // Storage unavailable — the call still happened, we just cannot recall it.
  }
}

/** The remembered call, or null if there is none, it is stale, or it is junk. */
export function getRememberedCall(now = Date.now()): RememberedCall | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const call = parsed as Partial<RememberedCall>;
    // Validate rather than trust: a half-written or hand-edited record must not
    // put a broken link in front of someone about to share it.
    if (typeof call.url !== 'string' || typeof call.code !== 'string') return null;
    if (typeof call.startedAt !== 'number' || !Number.isFinite(call.startedAt)) return null;
    if (now - call.startedAt > CALL_MEMORY_TTL_MS) return null;
    return {
      url: call.url,
      code: call.code,
      from: typeof call.from === 'string' ? call.from : undefined,
      thread: typeof call.thread === 'string' && call.thread.trim() ? call.thread.trim() : undefined,
      work: call.work && typeof call.work === 'object'
        ? {
            project: typeof call.work.project === 'string' ? call.work.project : undefined,
            sessionId: typeof call.work.sessionId === 'string' ? call.work.sessionId : undefined,
          }
        : undefined,
      account: typeof call.account === 'string' && call.account.trim() ? call.account.trim() : undefined,
      startedAt: call.startedAt,
    };
  } catch {
    return null;
  }
}

export function forgetCall(): void {
  try {
    localStorage.removeItem(KEY);
  } catch { /* nothing to do */ }
}
