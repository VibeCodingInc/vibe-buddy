// What a session looks like it's doing — and the words Buddy is allowed to
// use about it.
//
// The Rust side does the reading and returns state only (no conversation
// content ever crosses this boundary — see src-tauri/src/transcript.rs law 3).
// This module owns the COPY, because the copy is where the honesty lives:
// every line states the evidence, none names a cause the transcript cannot
// show. "A tool call has no result" — never "waiting on a permission prompt".

import { invoke } from '@tauri-apps/api/core';

export type SessionSignal =
  | { kind: 'unknown'; why: string }
  | { kind: 'awaiting-you'; idle_seconds: number }
  | { kind: 'tool-no-result'; tool: string; idle_seconds: number }
  | { kind: 'api-error-recent'; idle_seconds: number }
  | { kind: 'working'; idle_seconds: number }
  | { kind: 'quiet'; idle_seconds: number };

export interface TranscriptRead {
  signal: SessionSignal;
  last_activity_seconds: number | null;
  session_id: string | null;
}

// Cached per directory: the collapsed section polls every row's signal for
// its header count while an expanded row polls its own, and both must not
// become two IPC calls per session per tick.
const cache = new Map<string, { value: TranscriptRead | null; at: number }>();
const TTL_MS = 30_000;

export function clearTranscriptCache(): void {
  cache.clear();
}

export async function transcriptSignal(
  cwd: string | undefined,
  now = Date.now(),
): Promise<TranscriptRead | null> {
  if (!cwd) return null;
  const hit = cache.get(cwd);
  if (hit && now - hit.at < TTL_MS) return hit.value;
  try {
    const value = await invoke<TranscriptRead>('transcript_signal', { cwd });
    cache.set(cwd, { value, at: now });
    return value;
  } catch {
    // An IPC failure is not evidence about the session — say nothing rather
    // than inventing a state. Not cached: the next tick should retry.
    return null;
  }
}

/**
 * May this row be joined to a transcript at all?
 *
 * cwd is the only join available, and it is not an identity (the runtime
 * contract is explicit that client session ids and working directories are
 * correlation metadata). So the read is refused wherever the join could
 * attribute one transcript to the wrong runtime (codex r1 P1):
 *
 *  - a non-Claude host (codex/cursor row) whose directory may still contain
 *    a historical Claude transcript;
 *  - a directory shared by more than one of your session rows.
 *
 * The same ambiguity that stands the terminal verbs down stands this down —
 * one rule, both features.
 */
export function transcriptJoinable(args: { clientName?: string; cwdShared: boolean }): boolean {
  return !args.cwdShared && /claude/i.test(args.clientName || '');
}

/**
 * Read every joinable session's signal in one pass, keyed by cwd.
 *
 * ONE source for the whole board: the section header counts from it, rows
 * render from it, and rows bound under an agent card are included — the
 * operator's "what wants me" number must cover every session on the machine,
 * not just the ones that happen to live in this list (found live, 2026-08-14:
 * the header said "1 wants you" while a bound Pepper card also wanted him).
 */
export async function readSignals(
  rows: Array<{ cwd: string; clientName?: string; cwdShared: boolean }>,
): Promise<Map<string, SessionSignal>> {
  const out = new Map<string, SessionSignal>();
  const joinable = rows.filter((r) => transcriptJoinable(r));
  const reads = await Promise.all(joinable.map((r) => transcriptSignal(r.cwd)));
  joinable.forEach((r, i) => {
    const s = reads[i]?.signal;
    if (s) out.set(r.cwd, s);
  });
  return out;
}

/**
 * Order rows the way a router should: what wants you, first.
 *
 * A ten-row list where the one waiting session sits eighth is a list you have
 * to READ. Sorted, the answer is always the top row. Within a tier, most
 * recently active first — the freshest thing is the likeliest thing.
 *
 * Deliberately only TWO tiers: wants-you, then everything else. Finer ranking
 * (dangling tools above quiet, quiet above working) would encode confidence
 * this module does not have, and would make the order jitter as ambiguous
 * states flicker.
 */
export function byAttention<T>(
  rows: T[],
  signalOf: (row: T) => SessionSignal | undefined,
  agoOf: (row: T) => number,
): T[] {
  return [...rows].sort((a, b) => {
    const wa = wantsYou(signalOf(a)) ? 0 : 1;
    const wb = wantsYou(signalOf(b)) ? 0 : 1;
    return wa !== wb ? wa - wb : agoOf(a) - agoOf(b);
  });
}

function ago(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

/**
 * Does this signal want the operator's eyes? Only two states do. Everything
 * else — working, quiet, unknown — is deliberately NOT queue-worthy: a
 * "blocked" list full of maybes recreates the attention loss it exists to
 * cure (the codex review's condition, and the whole point of the feature).
 */
export function wantsYou(signal: SessionSignal | undefined): boolean {
  // Named `wantsYou` internally, rendered as "your turn". A session that
  // finished its turn is not needy — it is mid-conversation, and the next
  // move is the operator's. Obligation language ("needs you", "waiting on
  // you") turns a flow tool into an inbox with guilt in it; turn-taking is
  // both friendlier AND more accurate, and it is the language canon already
  // uses (the terminal owns the turn; Buddy owns the interval between them).
  return signal?.kind === 'awaiting-you' || signal?.kind === 'api-error-recent';
}

/**
 * The strict half of `wantsYou`: a turn actually completed and nobody replied.
 *
 * Both states deserve your eyes, but they are not the same sentence. A session
 * that only recorded an API error has NOT handed you a turn — it fell over —
 * and counting it under "your turn" asserts something no evidence supports
 * (codex r2 P2), while the row one line below correctly says "error recorded".
 * The header now counts these separately so the two claims can't contradict.
 */
export function isYourTurn(signal: SessionSignal | undefined): boolean {
  return signal?.kind === 'awaiting-you';
}

export function hasRecentApiError(signal: SessionSignal | undefined): boolean {
  return signal?.kind === 'api-error-recent';
}

/**
 * The line the row renders. Evidence, never diagnosis:
 *  - a dangling tool call could be a permission prompt, a slow tool, an API
 *    hang or a dead process — so it says what was seen and stops;
 *  - an API error says an error was recorded, not that the session is stalled;
 *  - unknown says which nothing this is, and how to proceed by hand.
 */
export function signalLine(signal: SessionSignal): string | null {
  switch (signal.kind) {
    // FOLDER-SCOPED BY LAW (codex r3 P1): /api/my-sessions carries no device
    // or runtime identity, so a row from another Mac whose path matches a
    // local one cannot be told apart from the local session. What IS verified
    // is that a live Claude session ON THIS MAC, in this directory, is in
    // that state — so the sentence says exactly that and no more. When the
    // platform's endpoint identity lands (runtime-delivery slice 4), the
    // claim can shrink back to "this session".
    case 'awaiting-you':
      return `a Claude session in this folder finished its turn ${ago(signal.idle_seconds)} ago — nobody has replied`;
    case 'tool-no-result':
      return `a ${signal.tool} call in this folder has no recorded result (${ago(signal.idle_seconds)}) — could be a prompt, a slow tool, or a stop; front it to see`;
    case 'api-error-recent':
      return `a session in this folder recorded an API error ${ago(signal.idle_seconds)} ago and nothing has succeeded since`;
    case 'quiet':
      return `no turns for ${ago(signal.idle_seconds)}`;
    case 'working':
      return null; // the heartbeat already says this; a second line is noise
    case 'unknown':
      return `can't read this session's transcript — ${signal.why}`;
  }
}
