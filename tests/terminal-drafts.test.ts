// The terminal's draft in Buddy's composer: shown exactly, decided here, sent
// only by the terminal package — never a second sender.
import { describe, expect, it, vi, beforeEach } from 'vitest';

const calls: Array<{ cmd: string; args: unknown }> = [];
let listResult: unknown = { handle: 'ada', drafts: [], error: null, message: null };
let sendResult: unknown = { id: 'd1', sent: true, message_id: 'msg_1', status: 'sent', display: null, definite: false };
let throwOn: string | null = null;
vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string, args: unknown) => {
    calls.push({ cmd, args });
    if (throwOn === cmd) throw new Error('the terminal package is not installed here');
    if (cmd === 'terminal_drafts') return listResult;
    if (cmd === 'send_terminal_draft') return sendResult;
    if (cmd === 'discard_terminal_draft') return { id: (args as { id: string }).id, status: 'cancelled', cancelled: true, display: null };
    return null;
  },
}));

import { draftFor, pickDraft, sendDraft, discardDraft, outcomeLine, type DraftList } from '../src/lib/terminalDrafts';

const d = (over: Partial<DraftList['drafts'][number]> = {}) => ({ id: 'd1', to: 'linus', why: 'you named them', why_now: null, message: 'which curve did you land on?', refs: [], reply_to: null, rev: 'abcd1234', created_at: 10, ...over });

beforeEach(() => { calls.length = 0; throwOn = null; listResult = { handle: 'ada', drafts: [], error: null, message: null }; });

describe('which draft belongs in this composer', () => {
  it('the previewed draft for this person, for this account, message verbatim with its rev', () => {
    const r = pickDraft({ handle: 'ada', drafts: [d()], error: null, message: null }, 'ada', '@Linus');
    expect(r.kind).toBe('draft');
    if (r.kind === 'draft') { expect(r.draft.message).toBe('which curve did you land on?'); expect(r.draft.rev).toBe('abcd1234'); }
  });
  it('none for a person with no draft — the composer stays an ordinary empty box', () => {
    expect(pickDraft({ handle: 'ada', drafts: [d({ to: 'grace' })], error: null, message: null }, 'ada', 'linus').kind).toBe('none');
  });
  it('a draft is never shown to another account', () => {
    expect(pickDraft({ handle: 'ada', drafts: [d()], error: null, message: null }, 'bob', 'linus')).toEqual({ kind: 'unavailable', reason: 'the terminal is signed in as someone else' });
    expect(pickDraft({ handle: 'ada', drafts: [], error: 'account_mismatch', message: 'x', }, 'bob', 'linus').kind).toBe('unavailable');
  });
  it('the newest previewed draft wins when an older one was left behind', () => {
    const r = pickDraft({ handle: 'ada', drafts: [d({ id: 'old', created_at: 1 }), d({ id: 'new', created_at: 9 })], error: null, message: null }, 'ada', 'linus');
    expect(r.kind === 'draft' && r.draft.id).toBe('new');
  });
  it('a null or shapeless answer is "unavailable", never a crash and never "no draft"', () => {
    expect(pickDraft(null as unknown as DraftList, 'ada', 'linus').kind).toBe('unavailable');
    expect(pickDraft({} as DraftList, 'ada', 'linus').kind).toBe('unavailable');
  });
  it('an uninstalled package is "unavailable", never "no draft"', async () => {
    throwOn = 'terminal_drafts';
    const r = await draftFor('ada', 'linus');
    expect(r.kind).toBe('unavailable');
  });
});

describe('deciding goes through the package', () => {
  it('send names the exact rev, and nothing else is posted by Buddy', async () => {
    await sendDraft('d1', 'abcd1234');
    expect(calls).toEqual([{ cmd: 'send_terminal_draft', args: { id: 'd1', rev: 'abcd1234' } }]);
  });
  it('"sent" is only the package\'s word; a refusal is shown in the package\'s words and the draft stays', () => {
    expect(outcomeLine({ id: 'd1', sent: true, message_id: 'm', status: 'sent', display: null, definite: false }).sent).toBe(true);
    const refused = outcomeLine({ id: 'd1', sent: false, message_id: null, status: 'previewed', display: 'Draft d1 changed since that preview (rev abcd1234 → 9999ffff) — open it again.', definite: true });
    expect(refused.sent).toBe(false);
    expect(refused.line).toMatch(/changed since that preview/);
  });
  it('discard is one call, and its answer is the package\'s status', async () => {
    const r = await discardDraft('d1');
    expect(r.status).toBe('cancelled');
    expect(calls.map((c) => c.cmd)).toEqual(['discard_terminal_draft']);
  });
});
