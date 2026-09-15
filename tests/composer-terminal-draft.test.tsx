// @vitest-environment jsdom
// The terminal's draft in Buddy's composer (buddy#56 slice 2): shown verbatim,
// sent only through the terminal package with the exact rev, edit moves the
// text into your own box and discards the draft, discard is everywhere.
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';

const memStore = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (memStore.has(k) ? memStore.get(k)! : null),
  setItem: (k: string, v: string) => { memStore.set(k, String(v)); },
  removeItem: (k: string) => { memStore.delete(k); },
  clear: () => { memStore.clear(); }, key: () => null, get length() { return memStore.size; },
};

const invoked: Array<{ cmd: string; args: unknown }> = [];
let drafts: unknown[] = [];
let sendResult: unknown = { id: 'd1', sent: true, message_id: 'msg_9', status: 'sent', display: null, definite: false };
let discardResult: { cancelled: boolean; display: string | null } = { cancelled: true, display: null };
vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string, args: unknown) => {
    invoked.push({ cmd, args });
    if (cmd === 'terminal_drafts') return { handle: 'ada', drafts, error: null, message: null };
    if (cmd === 'send_terminal_draft') return sendResult;
    if (cmd === 'discard_terminal_draft') return { id: (args as { id: string }).id, status: discardResult.cancelled ? 'cancelled' : 'sending', cancelled: discardResult.cancelled, display: discardResult.display };
    if (cmd === 'read_return_bindings') return [];
    if (cmd === 'terminal_sessions') return { sessions: [], warnings: [] };
    return null;
  },
}));

import DMPanel from '../src/components/DMPanel';
import { buddyClient } from '../src/lib/vibeClient';
import { realtime } from '../src/lib/realtime';
import { setCachedMessages } from '../src/lib/messageCache';

const draft = { id: 'd1', to: 'linus', why: 'you named them', why_now: 'he asked you this morning', message: 'Which backoff curve did you land on? I kept the 3-try cap.', refs: [], reply_to: null, rev: 'abcd1234', created_at: Date.now() };

beforeEach(() => {
  invoked.length = 0; drafts = []; memStore.clear(); discardResult = { cancelled: true, display: null };
  vi.spyOn(realtime, 'init').mockImplementation(() => {});
  vi.spyOn(realtime, 'openDM').mockImplementation(() => {});
  vi.spyOn(realtime, 'goBackground').mockImplementation(() => {});
  vi.spyOn(realtime, 'setTypingCallback').mockImplementation(() => {});
  vi.spyOn(buddyClient, 'sendTypingIndicator').mockResolvedValue(undefined as never);
  vi.spyOn(buddyClient, 'sendMessageResult').mockResolvedValue({ ok: true, id: 'buddy_msg' });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const mount = async () => {
  setCachedMessages('ada', 'linus', []);
  render(<DMPanel handle="ada" chatWith="linus" onBack={() => {}} users={[]} hasServerThread />);
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
};

describe('the draft appears exactly as the terminal showed it', () => {
  it('message verbatim, with why-now, and a Send naming the person', async () => {
    drafts = [draft];
    await mount();
    expect((await screen.findByTestId('terminal-draft-message')).textContent).toBe(draft.message);
    expect(screen.getByTestId('terminal-draft').textContent).toContain('he asked you this morning');
    expect(screen.getByRole('button', { name: 'Send to @linus' })).toBeTruthy();
  });
  it('no draft → an ordinary composer, nothing claimed', async () => {
    await mount();
    expect(screen.queryByTestId('terminal-draft')).toBeNull();
  });
});

describe('deciding here goes through the terminal package', () => {
  it('Send calls the package with the exact rev; Buddy posts nothing itself', async () => {
    drafts = [draft];
    await mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Send to @linus' }));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(invoked.some((c) => c.cmd === 'send_terminal_draft' && JSON.stringify(c.args) === JSON.stringify({ id: 'd1', rev: 'abcd1234' }))).toBe(true);
    expect(buddyClient.sendMessageResult).not.toHaveBeenCalled();
    expect((await screen.findByTestId('terminal-draft-outcome')).textContent).toMatch(/sent to @linus — exactly as shown/);
    expect(screen.queryByTestId('terminal-draft')).toBeNull();
  });
  it('a refusal is shown in the package\'s words and the draft stays', async () => {
    drafts = [draft];
    sendResult = { id: 'd1', sent: false, message_id: null, status: 'previewed', display: 'Draft d1 changed since that preview (rev abcd1234 → 9999ffff) — open it again.', definite: true };
    await mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Send to @linus' }));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect((await screen.findByTestId('terminal-draft-outcome')).textContent).toMatch(/changed since that preview/);
    expect(screen.getByTestId('terminal-draft')).toBeTruthy();
    expect(buddyClient.sendMessageResult).not.toHaveBeenCalled();
    sendResult = { id: 'd1', sent: true, message_id: 'msg_9', status: 'sent', display: null, definite: false };
  });
  it('an unconfirmed send keeps the draft on screen, marked, so Send again can retry the same text', async () => {
    drafts = [draft];
    sendResult = { id: 'd1', sent: false, message_id: null, status: 'unknown', unconfirmed: true, display: 'Couldn\'t confirm the send.', definite: false };
    await mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Send to @linus' }));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(screen.getByTestId('terminal-draft')).toBeTruthy();
    expect(screen.getByTestId('terminal-draft').textContent).toMatch(/did not confirm — Send again retries exactly this text/);
    sendResult = { id: 'd1', sent: true, message_id: 'msg_9', status: 'sent', display: null, definite: false };
  });
  it('Edit copies NOTHING unless the package confirms the original is cancelled (codex P1)', async () => {
    drafts = [draft];
    discardResult = { cancelled: false, display: 'Draft d1 is being sent right now — it can\'t be cancelled.' };
    await mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect((screen.getByPlaceholderText('Message @linus...') as HTMLTextAreaElement).value).toBe('', 'no editable copy beside a live original');
    expect(screen.getByTestId('terminal-draft')).toBeTruthy();
    expect(screen.getByTestId('terminal-draft-outcome').textContent).toMatch(/being sent right now/);
  });
  it('Discard honours a refusal: the draft stays and the package\'s reason is shown', async () => {
    drafts = [draft];
    discardResult = { cancelled: false, display: 'Draft d1 is being sent right now.' };
    await mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(screen.getByTestId('terminal-draft')).toBeTruthy();
    expect(screen.getByTestId('terminal-draft-outcome').textContent).toMatch(/being sent right now/);
  });
  it('Edit moves the text into your own box and discards the draft — what you send then is your own words', async () => {
    drafts = [draft];
    await mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(invoked.some((c) => c.cmd === 'discard_terminal_draft')).toBe(true);
    expect((screen.getByPlaceholderText('Message @linus...') as HTMLTextAreaElement).value).toBe(draft.message);
    expect(screen.queryByTestId('terminal-draft')).toBeNull();
    expect(screen.getByTestId('terminal-draft-outcome').textContent).toMatch(/your own words/);
  });
  it('Discard is one call and the draft is gone here', async () => {
    drafts = [draft];
    await mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(invoked.filter((c) => c.cmd === 'discard_terminal_draft')).toHaveLength(1);
    expect(screen.queryByTestId('terminal-draft')).toBeNull();
  });
});
