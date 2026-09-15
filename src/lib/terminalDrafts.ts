/**
 * The terminal's drafts, decided from Buddy.
 *
 * Your coding agent prepared a message in a session (`/vibe`). It is one draft,
 * in one store, with one revision and one approval digest, and the terminal
 * package is its only sender. Buddy shows it exactly, and every decision here
 * — send, discard — goes back through that package. Buddy never posts a
 * draft's text itself, so there is never a second send.
 *
 * Truth rules:
 *  · what you see is `message` verbatim, and Send names `rev`, the revision of
 *    exactly those bytes; the package refuses any other;
 *  · a draft belongs to the account that prepared it — a different signed-in
 *    account sees nothing;
 *  · "sent" is the package's word from a server receipt, never Buddy's guess;
 *  · a discard anywhere is a discard everywhere.
 */
import { invoke } from '@tauri-apps/api/core';

export interface TerminalDraft {
  id: string;
  to: string;
  why: string | null;
  why_now: string | null;
  message: string;
  refs: { title: string | null; url: string }[];
  reply_to: string | null;
  rev: string;
  created_at: number | null;
}

export interface DraftList { handle: string | null; drafts: TerminalDraft[]; error: string | null; message: string | null }
export interface SendOutcome { id: string; sent: boolean; message_id: string | null; status: string | null; display: string | null; definite: string | null }
export interface DiscardOutcome { id: string; status: string | null; display: string | null }

export type DraftAvailability =
  | { kind: 'draft'; draft: TerminalDraft }
  | { kind: 'none' }
  | { kind: 'unavailable'; reason: string };

/** The one previewed draft for this conversation, for this account, or an honest reason. */
export async function draftFor(me: string, them: string): Promise<DraftAvailability> {
  let list: DraftList;
  try {
    list = await invoke<DraftList>('terminal_drafts', { me });
  } catch (e) {
    return { kind: 'unavailable', reason: e instanceof Error ? e.message : String(e) };
  }
  return pickDraft(list, me, them);
}

/** Pure: which draft, if any, belongs in this composer. */
export function pickDraft(list: DraftList | null | undefined, me: string, them: string): DraftAvailability {
  // A malformed answer (null, no drafts array) is "unavailable", never a crash
  // and never "no draft": the bridge answered nothing we can read.
  if (!list || typeof list !== 'object' || !Array.isArray(list.drafts)) return { kind: 'unavailable', reason: 'no answer from the terminal package' };
  if (list.error === 'account_mismatch') return { kind: 'unavailable', reason: 'the terminal is signed in as someone else' };
  if (list.error) return { kind: 'unavailable', reason: list.message || list.error };
  if (!list.handle || list.handle.toLowerCase() !== me.toLowerCase()) return { kind: 'unavailable', reason: 'the terminal is signed in as someone else' };
  const t = them.replace(/^@/, '').toLowerCase();
  const mine = list.drafts.filter((d) => d.to.replace(/^@/, '').toLowerCase() === t);
  if (!mine.length) return { kind: 'none' };
  // Newest previewed draft for this person. The terminal keeps one live
  // preview per flow, so more than one here means an older one was left
  // behind; the newest is what was last looked at.
  const newest = [...mine].sort((a, b) => (b.created_at || 0) - (a.created_at || 0))[0];
  return { kind: 'draft', draft: newest };
}

/** Send exactly the revision shown. Returns the package's own outcome. */
export async function sendDraft(id: string, rev: string): Promise<SendOutcome> {
  return invoke<SendOutcome>('send_terminal_draft', { id, rev });
}

export async function discardDraft(id: string): Promise<DiscardOutcome> {
  return invoke<DiscardOutcome>('discard_terminal_draft', { id });
}

/**
 * What to tell the person after the package answered. `sent` is only ever
 * the package's word. Anything else is shown as the package said it, and the
 * draft stays where it was.
 */
export function outcomeLine(o: SendOutcome): { sent: boolean; line: string } {
  if (o.sent) return { sent: true, line: `sent — your terminal's draft went to @${'to' in o ? (o as unknown as { to: string }).to : 'them'} as shown` };
  return { sent: false, line: o.display || 'not sent — the terminal package refused, and the draft is unchanged' };
}
