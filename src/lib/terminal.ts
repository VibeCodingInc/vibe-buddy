// Session verbs, TS side — "sessions are agents are bots" (buddy#33).
//
// A MY SESSIONS row and an iTerm tab are the same being seen from two sides.
// This module joins them BY CWD AT THE MOMENT OF USE — never cached: tabs
// move, sessions end, and a stale match would front (or type into) the
// wrong being. The Rust side owns the dangerous parts and re-verifies the
// claude-is-foreground gate inside the write itself; everything here is
// presentation and matching.

import { invoke } from '@tauri-apps/api/core';

export interface TerminalSession {
  /** Which terminal owns it — the two verbs are not equally supported. */
  app: string;
  /** Can a draft be placed here WITHOUT being submitted? iTerm yes; Terminal.app no. */
  can_place: boolean;
  window_id: string;
  tty: string;
  name: string;
  cwd: string | null;
  claude_foreground: boolean;
}

/**
 * `warnings` is the half-failure channel: two terminals are asked, so one of
 * them being blocked or hung does NOT make the scan a failure — it makes it
 * incomplete. Silently returning the healthy host's tabs would tell someone
 * their Terminal sessions don't exist when really macOS refused to say
 * (codex r2 P2). `error` still means nothing could be read at all.
 */
export async function terminalSessions(): Promise<{
  sessions: TerminalSession[];
  error: string | null;
  warnings: string[];
}> {
  try {
    const scan = await invoke<{ sessions: TerminalSession[]; warnings: string[] }>('terminal_sessions');
    return { sessions: scan.sessions, error: null, warnings: scan.warnings ?? [] };
  } catch (e) {
    return { sessions: [], error: String(e), warnings: [] };
  }
}

export async function frontSession(tty: string, app?: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await invoke('front_terminal_session', { tty, app });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * Stage a one-line draft in the session's claude prompt, UNSUBMITTED — the
 * terminal owns the turn, so the human presses enter there. Rust refuses
 * unless claude is the tty's foreground at the moment of placing.
 */
export async function placeInSession(tty: string, text: string, app?: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await invoke('place_in_terminal_session', { tty, text, app });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** Trailing-slash-insensitive path equality; no fuzzy prefix games. */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p);
  return norm(a) === norm(b);
}

export type SessionMatch =
  | { kind: 'one'; session: TerminalSession }
  | { kind: 'many'; sessions: TerminalSession[] }
  | { kind: 'none' };

/**
 * Which iTerm tab is this row? Exact cwd match only — a prefix match would
 * happily pick a parent-directory session and type into the wrong being.
 * 'many' is a true state (two sessions in one directory) and the UI says so
 * rather than silently picking.
 */
export function matchSessionRow(rowCwd: string | undefined, sessions: TerminalSession[]): SessionMatch {
  if (!rowCwd) return { kind: 'none' };
  const hits = sessions.filter((s) => s.cwd !== null && samePath(s.cwd, rowCwd));
  if (hits.length === 0) return { kind: 'none' };
  if (hits.length === 1) return { kind: 'one', session: hits[0] };
  return { kind: 'many', sessions: hits };
}
