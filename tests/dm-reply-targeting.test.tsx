// @vitest-environment jsdom
// Explicit reply targeting (build-and-hold). The human chooses the message
// being answered; Buddy writes the existing reply_to at send. Never a silent
// newest default; ordinary send stays unlinked; failed send leaves the draft
// AND the chosen target intact; the needle is NOT rendered from the local
// choice (only the server-served link renders — covered on the needle PR).

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const memStore = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (memStore.has(k) ? memStore.get(k)! : null),
  setItem: (k: string, v: string) => { memStore.set(k, String(v)); },
  removeItem: (k: string) => { memStore.delete(k); },
  clear: () => { memStore.clear(); },
  key: (i: number) => [...memStore.keys()][i] ?? null,
  get length() { return memStore.size; },
};
import DMPanel from '../src/components/DMPanel';
import { buddyClient, type VibeMessage } from '../src/lib/vibeClient';
import { realtime } from '../src/lib/realtime';
import { setCachedMessages } from '../src/lib/messageCache';

const ME = 'alice_demo';
const THEM = 'bob_demo';

const m = (id: string, from: string, content: string): VibeMessage => ({
  id, from, to: from === ME ? THEM : ME, content,
  timestamp: new Date().toISOString(), status: 'sent',
});

let sent: Array<{ content: string; replyTo?: string }> = [];
let ok = true;
beforeEach(() => {
  sent = []; ok = true;
  vi.spyOn(realtime, 'init').mockImplementation(() => {});
  vi.spyOn(realtime, 'openDM').mockImplementation(() => {});
  vi.spyOn(realtime, 'goBackground').mockImplementation(() => {});
  vi.spyOn(realtime, 'setTypingCallback').mockImplementation(() => {});
  vi.spyOn(realtime, 'setMessageEvidenceCallback').mockImplementation(() => {});
  vi.spyOn(realtime, 'hasMessageEvidenceFrom').mockReturnValue(false);
  vi.spyOn(realtime, 'recordStoredMessageWith').mockImplementation(() => {});
  vi.spyOn(buddyClient, 'sendMessageResult').mockImplementation(async (_to, content, replyTo) => {
    sent.push({ content, replyTo }); return ok ? { ok: true } : { ok: false, error: 'nope' };
  });
  vi.spyOn(buddyClient, 'sendTypingIndicator').mockResolvedValue(undefined as never);
  memStore.clear();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const mount = (msgs: VibeMessage[]) => {
  setCachedMessages(ME, THEM, msgs);
  render(<DMPanel handle={ME} chatWith={THEM} onBack={() => {}} users={[]} hasServerThread />);
};
const composer = () => screen.getByPlaceholderText(`Message @${THEM}...`);

describe('explicit reply targeting — the human chooses', () => {
  it('an ordinary send carries NO reply_to (never a silent default)', () => {
    mount([m('p1', THEM, 'earlier question?')]);
    fireEvent.change(composer(), { target: { value: 'plain reply' } });
    fireEvent.keyDown(composer(), { key: 'Enter' });
    expect(sent).toEqual([{ content: 'plain reply', replyTo: undefined }]);
  });

  it('choosing a message to answer writes THAT id as reply_to', () => {
    mount([m('p1', THEM, 'which story should lead?'), m('p2', THEM, 'unrelated newer message')]);
    // Explicitly target the OLDER message — proving it's not "newest".
    const replyBtns = screen.getAllByRole('button', { name: /Reply to this message/ });
    fireEvent.click(replyBtns[0]); // p1, the older one
    expect(screen.getByText(/replying to/)).toBeTruthy();
    fireEvent.change(composer(), { target: { value: 'lead with two doors' } });
    fireEvent.keyDown(composer(), { key: 'Enter' });
    expect(sent).toEqual([{ content: 'lead with two doors', replyTo: 'p1' }]);
  });

  it('cancelling the target returns to an ordinary unlinked send', () => {
    mount([m('p1', THEM, 'question?')]);
    fireEvent.click(screen.getByRole('button', { name: /Reply to this message/ }));
    fireEvent.click(screen.getByRole('button', { name: /Cancel reply targeting/ }));
    fireEvent.change(composer(), { target: { value: 'nevermind, plain' } });
    fireEvent.keyDown(composer(), { key: 'Enter' });
    expect(sent).toEqual([{ content: 'nevermind, plain', replyTo: undefined }]);
  });

  it('a failed reply-targeted send is preserved as a bubble whose Retry re-sends the SAME target', async () => {
    ok = false;
    mount([m('p1', THEM, 'question?')]);
    fireEvent.click(screen.getByRole('button', { name: /Reply to this message/ }));
    fireEvent.change(composer(), { target: { value: 'attempted answer' } });
    fireEvent.keyDown(composer(), { key: 'Enter' });
    // The attempt is preserved (Buddy's established failed-bubble + Retry —
    // the text is not lost), and the target rode the send.
    expect(await screen.findByText('Failed')).toBeTruthy();
    expect(sent).toEqual([{ content: 'attempted answer', replyTo: 'p1' }]);
    // Retry re-sends with the SAME chosen parent, not dropped, not defaulted.
    ok = true;
    fireEvent.click(screen.getByText('Retry'));
    await waitFor(() => expect(sent).toContainEqual({ content: 'attempted answer', replyTo: 'p1' }));
    expect(sent.filter((s) => s.replyTo === 'p1')).toHaveLength(2);
  });

  it('optimistic bubble does NOT render a needle from the local choice (server-served only)', () => {
    mount([m('p1', THEM, 'question?')]);
    fireEvent.click(screen.getByRole('button', { name: /Reply to this message/ }));
    fireEvent.change(composer(), { target: { value: 'answer' } });
    fireEvent.keyDown(composer(), { key: 'Enter' });
    // No "answering" needle on the just-sent optimistic message.
    expect(screen.queryByText(/↳ answering/)).toBeNull();
  });

  it('no post-hoc stitch / matching / mentalist in this slice (source pins)', () => {
    const src = readFileSync(join(process.cwd(), 'src/components/DMPanel.tsx'), 'utf8');
    // The parked concepts, by their concrete signatures (bare "session" is
    // NOT pinned — DMPanel legitimately references the vibeconf CALL session).
    expect(src).not.toMatch(/does this answer one of these/i);
    expect(src).not.toMatch(/\bstitch\b/i);
    expect(src).not.toMatch(/\bmentalist\b/i);
    expect(src).not.toMatch(/session attribution|project origin|auto.?match/i);
    // reply_to is only ever set by the explicit human action, then sent.
    expect(src).toMatch(/setReplyingTo\(\{ id: msg\.id/);
  });
});
