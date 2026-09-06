/**
 * What a reply answers, and one way back to the work — from the terminal
 * package's private bindings (`~/.vibe/return-bindings.json`, read by Rust).
 *
 * Truth rules (Seth, 2026-09-05):
 *  · "answers what you asked" is claimed ONLY when the reply's served
 *    `reply_to` id equals the binding's sent message id. A message that
 *    merely arrived after yours gets no claim.
 *  · The way back says what it does: "Back to the session" only when the
 *    exact terminal tab is still open (fronted, not resumed); otherwise
 *    "Show the folder"; otherwise nothing.
 *  · No ids, revisions or protocol words reach the screen.
 */
import { invoke } from '@tauri-apps/api/core';
import { matchSessionRow, type TerminalSession } from './terminal';
import type { VibeMessage } from './vibeClient';

export interface ReturnBinding {
  handle: string;
  from: string | null;
  project: string | null;
  messageId: string | null;
  firstLine: string | null;
  cwd: string | null;
  sentAt: number | null;
}

let cache: { me: string; at: number; list: ReturnBinding[] } | null = null;
const TTL_MS = 15_000;

/** Bindings for the signed-in account. Cached briefly; a failure is an empty list. */
export async function loadReturnBindings(me: string, force = false): Promise<ReturnBinding[]> {
  if (!force && cache && cache.me === me && Date.now() - cache.at < TTL_MS) return cache.list;
  let list: ReturnBinding[] = [];
  try {
    const raw = await invoke<unknown>('read_return_bindings', { me });
    if (Array.isArray(raw)) {
      list = raw
        .filter((b): b is Record<string, unknown> => Boolean(b) && typeof b === 'object')
        .map((b) => ({
          handle: String(b.handle || '').toLowerCase(),
          from: typeof b.from === 'string' ? b.from : null,
          project: typeof b.project === 'string' && b.project ? b.project : null,
          messageId: typeof b.messageId === 'string' && b.messageId ? b.messageId : null,
          firstLine: typeof b.firstLine === 'string' ? b.firstLine : null,
          cwd: typeof b.cwd === 'string' && b.cwd ? b.cwd : null,
          sentAt: typeof b.sentAt === 'number' ? b.sentAt : null,
        }))
        .filter((b) => b.handle);
    }
  } catch {
    list = [];
  }
  cache = { me, at: Date.now(), list };
  return list;
}

export function resetReturnBindings(): void { cache = null; }

export function bindingFor(handle: string, list: ReturnBinding[]): ReturnBinding | null {
  const h = String(handle || '').replace(/^@/, '').toLowerCase();
  return list.find((b) => b.handle === h) ?? null;
}

/**
 * Is this message THEIR verified answer to what you sent from the bound work?
 * Only served linkage counts.
 */
export function answersYourAsk(msg: Pick<VibeMessage, 'from' | 'replyTo'>, binding: ReturnBinding | null, them: string): boolean {
  if (!binding || !binding.messageId) return false;
  if (msg.from !== them) return false;
  return Boolean(msg.replyTo && msg.replyTo.id === binding.messageId);
}

/** The one line above a verified answer. */
export function answersLine(binding: ReturnBinding): string {
  return binding.project ? `answers what you asked from ${binding.project}` : 'answers what you asked';
}

export type ReturnAction =
  | { kind: 'session'; label: 'Back to the session'; tty: string; app: string | undefined }
  | { kind: 'folder'; label: 'Show the folder'; cwd: string }
  | { kind: 'none' };

/**
 * Decide the honest way back. A live tab in exactly that directory can be
 * fronted; two tabs there is a true ambiguity we do not resolve by guessing
 * (fall back to the folder); no tab → the folder, if we know it.
 */
export function returnAction(binding: ReturnBinding | null, sessions: TerminalSession[]): ReturnAction {
  if (!binding || !binding.cwd) return { kind: 'none' };
  const m = matchSessionRow(binding.cwd, sessions);
  if (m.kind === 'one') return { kind: 'session', label: 'Back to the session', tty: m.session.tty, app: m.session.app };
  return { kind: 'folder', label: 'Show the folder', cwd: binding.cwd };
}

/**
 * The banner for a new message from `them`, when it is their verified answer
 * to what you sent from a piece of work. `loadTail` fetches the thread's
 * newest page (the thread LIST does not carry reply linkage). Null → the
 * caller's ordinary banner. Never claims "answered" without served linkage.
 */
export async function answeredBanner(
  me: string,
  them: string,
  loadTail: (handle: string) => Promise<Pick<VibeMessage, 'from' | 'content' | 'replyTo'>[]>,
  /** The message that raised the banner: only ITS linkage may describe it (codex P2). */
  trigger?: { id?: string; from: string; body: string },
): Promise<{ title: string; body: string } | null> {
  const list = await loadReturnBindings(me, true);
  const b = bindingFor(them, list);
  if (!b || !b.messageId) return null;
  let tail: Pick<VibeMessage, 'id' | 'from' | 'content' | 'replyTo'>[] = [];
  try { tail = await loadTail(them); } catch { return null; }
  const hit = pickTriggering(tail, them, trigger);
  if (!hit || !answersYourAsk(hit, b, them)) return null;
  const preview = String(hit.content || '').slice(0, 100);
  return { title: `@${them}`, body: `${b.project ? `answered what you asked from ${b.project}` : 'answered what you asked'}: ${preview}` };
}

/**
 * The message a banner is about. With a served id, only that exact message
 * qualifies — text is not identity (two "OK"s are two messages). Without an
 * id (older servers) nothing is picked: better an ordinary banner than a
 * later message speaking for an earlier one.
 */
export function pickTriggering<M extends Pick<VibeMessage, 'id' | 'from'>>(tail: M[], them: string, trigger?: { id?: string; from: string; body: string }): M | null {
  if (!trigger || !trigger.id) return null;
  const hit = tail.find((m) => m.from === them && m.id === trigger.id);
  return hit ?? null;
}

export async function revealFolder(cwd: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await invoke('reveal_in_finder', { path: cwd });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
