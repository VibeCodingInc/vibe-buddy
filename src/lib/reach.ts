/**
 * The terminal's reach settings (`~/.vibe/reach.json`), honoured by Buddy.
 *
 * slashvibe-mcp keeps "who may reach you while you work" on this machine, and
 * the person changes it only by typing:
 *   npx slashvibe-mcp invisible | visible   — sessions stop saying "I am here"
 *   npx slashvibe-mcp quiet | unquiet       — nobody surfaces while you work
 *   npx slashvibe-mcp mute @h | unmute @h   — one person never surfaces
 *
 * Buddy reads the file (never writes it — the native command is read-only, one
 * fixed path) and makes the same promises true here:
 *   - invisible → no presence heartbeat from Buddy, and the card says why;
 *   - quiet     → no banner about a person (session alerts are about YOUR
 *                 sessions, not people, and are unaffected);
 *   - muted[h]  → no banner from that person.
 *
 * A missing or unreadable file is the defaults: nothing hidden, nothing
 * muted, nothing shown as an error. Unread counts are facts, not
 * interruptions, so the badge and the list still count muted people.
 */
import { invoke } from '@tauri-apps/api/core';

export interface ReachState {
  /** A readable file was found. False = the defaults, said nowhere. */
  present: boolean;
  quiet: boolean;
  invisible: boolean;
  /** Canonical handles (see canonicalHandle). */
  muted: string[];
}

export const DEFAULT_REACH: ReachState = Object.freeze({ present: false, quiet: false, invisible: false, muted: [] }) as ReachState;

/**
 * ONE canonical form for every handle comparison here: trimmed, leading @
 * removed, lowercased (reach.js norm), and '-' folded to '_' — the platform
 * stores the GitHub login a-b as a_b, so `mute @a-b` must silence the a_b
 * whose messages actually arrive. Folding can only mute MORE, never less.
 */
export function canonicalHandle(raw: string | null | undefined): string {
  return String(raw ?? '').trim().replace(/^@+/, '').trim().toLowerCase().replace(/-/g, '_');
}

/** Anything not shaped like the native answer is the defaults. */
export function normalizeReach(raw: unknown): ReachState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return DEFAULT_REACH;
  const r = raw as Record<string, unknown>;
  if (r.present !== true) return DEFAULT_REACH;
  const muted = Array.isArray(r.muted)
    ? [...new Set(r.muted.filter((h): h is string => typeof h === 'string').map(canonicalHandle).filter(Boolean))].sort()
    : [];
  return { present: true, quiet: r.quiet === true, invisible: r.invisible === true, muted };
}

let current: ReachState = DEFAULT_REACH;
const listeners = new Set<(next: ReachState, prev: ReachState) => void>();

export function getReachState(): ReachState { return current; }

const same = (a: ReachState, b: ReachState) =>
  a.present === b.present && a.quiet === b.quiet && a.invisible === b.invisible &&
  a.muted.length === b.muted.length && a.muted.every((h, i) => h === b.muted[i]);

/** Install a state (normalized). Listeners hear only real changes. */
export function setReachState(raw: unknown): ReachState {
  const next = normalizeReach(raw);
  const prev = current;
  if (same(prev, next)) return prev;
  current = next;
  for (const fn of listeners) { try { fn(next, prev); } catch { /* a listener never breaks the read */ } }
  return next;
}

export function subscribeReach(fn: (next: ReachState, prev: ReachState) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Read the file now. A failed read is the defaults, never an error. */
export async function loadReach(): Promise<ReachState> {
  let raw: unknown = null;
  try { raw = await invoke('read_reach_prefs'); } catch { raw = null; }
  return setReachState(raw);
}

/**
 * Re-read on a cadence so a terminal command takes effect within about a
 * minute, without a restart. 30s: a tiny local file read, twice a minute.
 */
export const REACH_REFRESH_MS = 30_000;
export function watchReach(intervalMs = REACH_REFRESH_MS): () => void {
  void loadReach();
  const t = setInterval(() => { void loadReach(); }, intervalMs);
  return () => clearInterval(t);
}

export function isMuted(handle: string | null | undefined, state: ReachState = current): boolean {
  const h = canonicalHandle(handle);
  return !!h && state.muted.includes(h);
}

/**
 * Should this banner be held back? Only banners about a PERSON are affected:
 * a DM, an answer, someone arriving. Session alerts (your own coding session
 * wants you) are not about anyone reaching you.
 */
export function reachSuppressesBanner(
  b: { kind: 'dm' | 'session' | 'arrival'; from?: string; thread?: string },
  state: ReachState = current,
): boolean {
  if (b.kind === 'session') return false;
  if (state.quiet) return true;
  return isMuted(b.from, state) || isMuted(b.thread, state);
}

/** Test seam. */
export function resetReachForTests(): void { current = DEFAULT_REACH; listeners.clear(); }
