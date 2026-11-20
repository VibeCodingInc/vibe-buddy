// @vitest-environment jsdom
// Send truth, in the conversation (slice 1 of the 2026-11-20 review).
//
//  1. a failed local message survives every thread refresh, with its Retry,
//     until the person retries or discards it — the words are never lost
//     (it used to vanish at the next poll, seconds after "Failed");
//  2. one idempotency key per optimistic message, reused by every retry;
//  3. unknown is its own state: "May not have reached them · Try again",
//     never "Failed";
//  4. the recipient spelling is the platform's for a '-' handle, and a send
//     to yourself is refused with the words left in the composer.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';

const memStore = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (memStore.has(k) ? memStore.get(k)! : null),
  setItem: (k: string, v: string) => { memStore.set(k, String(v)); },
  removeItem: (k: string) => { memStore.delete(k); },
  clear: () => { memStore.clear(); },
  key: (i: number) => [...memStore.keys()][i] ?? null,
  get length() { return memStore.size; },
};
import DMPanel, { clearUnresolvedAttempts } from '../src/components/DMPanel';
import { buddyClient, type VibeMessage, type SendResult } from '../src/lib/vibeClient';
import { realtime } from '../src/lib/realtime';
import { setCachedMessages } from '../src/lib/messageCache';

const ME = 'alice_demo';
const THEM = 'bob_demo';

const m = (id: string, from: string, content: string, at = new Date()): VibeMessage => ({
  id, from, to: from === ME ? THEM : ME, content, timestamp: at.toISOString(), status: 'sent',
});

type Sent = { to: string; content: string; replyTo?: string; key?: string };
let sent: Sent[] = [];
let replies: SendResult[] = [];
let incoming: ((thread: VibeMessage[]) => void) | null = null;

beforeEach(() => {
  clearUnresolvedAttempts();
  sent = []; replies = []; incoming = null;
  vi.spyOn(realtime, 'init').mockImplementation(() => {});
  vi.spyOn(realtime, 'openDM').mockImplementation((_t, cb) => { incoming = cb; });
  vi.spyOn(realtime, 'goBackground').mockImplementation(() => {});
  vi.spyOn(realtime, 'setTypingCallback').mockImplementation(() => {});
  vi.spyOn(realtime, 'setMessageEvidenceCallback').mockImplementation(() => {});
  vi.spyOn(realtime, 'hasMessageEvidenceFrom').mockReturnValue(false);
  vi.spyOn(realtime, 'recordStoredMessageWith').mockImplementation(() => {});
  vi.spyOn(buddyClient, 'sendTypingIndicator').mockResolvedValue(undefined as never);
  vi.spyOn(buddyClient, 'sendMessageResult').mockImplementation(async (to, content, replyTo, opts) => {
    sent.push({ to, content, replyTo, key: opts?.idempotencyKey });
    return replies.shift() ?? { ok: true, outcome: 'stored', id: `srv_${sent.length}` };
  });
  memStore.clear();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const mount = (chatWith = THEM, msgs: VibeMessage[] = [m('p1', chatWith, 'earlier')]) => {
  setCachedMessages(ME, chatWith, msgs);
  return render(<DMPanel handle={ME} chatWith={chatWith} onBack={() => {}} users={[]} hasServerThread />);
};
const sendText = async (text: string, chatWith = THEM) => {
  const box = screen.getByPlaceholderText(`Message @${chatWith}...`);
  fireEvent.change(box, { target: { value: text } });
  await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }); });
};
const refresh = async (thread: VibeMessage[]) => { await act(async () => { incoming!(thread); }); };

describe('1 · a failed message survives the thread merge until retried or discarded', () => {
  it('Failed + Retry + the words stay through repeated refreshes', async () => {
    replies = [{ ok: false, outcome: 'refused', error: 'nope' }];
    mount();
    await sendText('do not lose me');
    expect(screen.getByText('Failed')).toBeTruthy();
    // The poll that used to erase it: a served thread without the attempt.
    await refresh([m('p1', THEM, 'earlier')]);
    await refresh([m('p1', THEM, 'earlier'), m('p2', THEM, 'a newer reply')]);
    expect(screen.getByText('do not lose me')).toBeTruthy();
    expect(screen.getByText('Failed')).toBeTruthy();
    expect(screen.getByText('Retry')).toBeTruthy();
  });

  it('Discard removes it; nothing else does', async () => {
    replies = [{ ok: false, outcome: 'refused', error: 'nope' }];
    mount();
    await sendText('throw me away');
    await refresh([m('p1', THEM, 'earlier')]);
    fireEvent.click(screen.getByText('Discard'));
    expect(screen.queryByText('throw me away')).toBeNull();
    await refresh([m('p1', THEM, 'earlier')]);
    expect(screen.queryByText('throw me away')).toBeNull();
  });

  it('leaving the conversation and coming back keeps the attempt and its Retry', async () => {
    replies = [{ ok: false, outcome: 'refused', error: 'nope' }];
    const first = mount();
    await sendText('still here after navigating');
    first.unmount();
    mount();
    expect(screen.getByText('still here after navigating')).toBeTruthy();
    expect(screen.getByText('Retry')).toBeTruthy();
  });

  it('a stored retry is replaced by the served copy (reconciled by the receipt id)', async () => {
    replies = [{ ok: false, outcome: 'refused', error: 'nope' }, { ok: true, outcome: 'stored', id: 'srv_x' }];
    mount();
    await sendText('second time lucky');
    await act(async () => { fireEvent.click(screen.getByText('Retry')); });
    await refresh([m('p1', THEM, 'earlier'), m('srv_x', ME, 'second time lucky')]);
    expect(screen.getAllByText('second time lucky')).toHaveLength(1);
    expect(screen.queryByText('Failed')).toBeNull();
  });
});

describe('2 · one idempotency key per optimistic message, reused by every retry', () => {
  it('first send and both retries carry the same key; a new message gets a new key', async () => {
    replies = [
      { ok: false, outcome: 'unknown' },
      { ok: false, outcome: 'unknown' },
      { ok: true, outcome: 'stored', id: 'srv_1' },
      { ok: true, outcome: 'stored', id: 'srv_2' },
    ];
    mount();
    await sendText('exactly once');
    await act(async () => { fireEvent.click(screen.getByText('Try again')); });
    await act(async () => { fireEvent.click(screen.getByText('Try again')); });
    await sendText('a different message');
    expect(sent.map((s) => s.content)).toEqual(['exactly once', 'exactly once', 'exactly once', 'a different message']);
    const [k1, k2, k3, k4] = sent.map((s) => s.key);
    expect(k1).toBeTruthy();
    expect(k2).toBe(k1);
    expect(k3).toBe(k1);
    expect(k4).toBeTruthy();
    expect(k4).not.toBe(k1);
  });

  it('a retry keeps the chosen reply target, so it is the identical request (a replay, never a conflict)', async () => {
    replies = [{ ok: false, outcome: 'unknown' }, { ok: true, outcome: 'stored', id: 'srv_1' }];
    mount(THEM, [m('p1', THEM, 'which one?')]);
    fireEvent.click(screen.getByRole('button', { name: /Reply to this message/ }));
    await sendText('this one');
    await act(async () => { fireEvent.click(screen.getByText('Try again')); });
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    expect(sent[0].replyTo).toBe('p1');
  });

  it('two sends in the same millisecond still get distinct bubbles (no duplicate React keys)', () => {
    const src = readFileSync(join(process.cwd(), 'src/components/DMPanel.tsx'), 'utf8');
    expect(src).toMatch(/const optimisticId = `local_\$\{idempotencyKey\}`/);
    expect(src).not.toMatch(/local_\$\{Date\.now\(\)\}/);
  });
});

describe('3 · unknown is unknown, never "Failed"', () => {
  it('a timeout reads "May not have reached them · Try again · Dismiss" and survives refreshes', async () => {
    replies = [{ ok: false, outcome: 'unknown' }];
    mount();
    await sendText('did it land?');
    expect(screen.getByText('May not have reached them')).toBeTruthy();
    expect(screen.getByText('Try again')).toBeTruthy();
    expect(screen.getByText('Dismiss')).toBeTruthy();
    expect(screen.queryByText('Failed')).toBeNull();
    expect(screen.queryByText('Retry')).toBeNull();
    await refresh([m('p1', THEM, 'earlier')]);
    expect(screen.getByText('did it land?')).toBeTruthy();
    expect(screen.getByText('May not have reached them')).toBeTruthy();
  });

  it('an unknown attempt that the served thread shows as ours is resolved by that evidence', async () => {
    replies = [{ ok: false, outcome: 'unknown' }];
    mount();
    await sendText('it did land');
    await refresh([m('p1', THEM, 'earlier'), m('srv_9', ME, 'it did land')]);
    expect(screen.getAllByText('it did land')).toHaveLength(1);
    expect(screen.queryByText('May not have reached them')).toBeNull();
  });

  it('an answer-less result from an older caller is unknown, not failed', async () => {
    replies = [{ ok: false }];
    mount();
    await sendText('no answer');
    expect(screen.getByText('May not have reached them')).toBeTruthy();
    expect(screen.queryByText('Failed')).toBeNull();
  });

  it('a refusal is still the definite word, with Retry', async () => {
    replies = [{ ok: false, outcome: 'refused', error: 'nope' }];
    mount();
    await sendText('refused');
    expect(screen.getByText('Failed')).toBeTruthy();
    expect(screen.queryByText('May not have reached them')).toBeNull();
  });

  it('copy rules: no exclamation marks in the new send-state copy; unknown is not red', () => {
    const src = readFileSync(join(process.cwd(), 'src/components/DMPanel.tsx'), 'utf8');
    for (const s of ['May not have reached them', 'Try again', 'Dismiss', 'is you — nothing was sent', "the platform's spelling of", 'the invite may not have reached them']) {
      expect(src).toContain(s);
    }
    expect(src).not.toMatch(/May not have reached them!|nothing was sent!|Try again!/);
    expect(src).toMatch(/color: color\.faint, marginLeft: '4px' \}\}>May not have reached them/);
  });
});

describe("4 · recipient spelling and self-send", () => {
  it("a '-' conversation sends to the platform's spelling, and says so", async () => {
    const resolve = vi.spyOn(buddyClient, 'resolveRecipient').mockResolvedValue('a_b');
    mount('a-b', []);
    await sendText('hello', 'a-b');
    expect(resolve).toHaveBeenCalledWith('a-b');
    expect(sent[0].to).toBe('a_b');
    expect(screen.getByTestId('send-note').textContent).toMatch(/sent to @a_b — the platform's spelling of @a-b/);
  });

  it('a lookup that cannot confirm keeps the handle as typed', async () => {
    vi.spyOn(buddyClient, 'resolveRecipient').mockResolvedValue('a-b');
    mount('a-b', []);
    await sendText('hello', 'a-b');
    expect(sent[0].to).toBe('a-b');
    expect(screen.queryByTestId('send-note')).toBeNull();
  });

  it('the retry of a resolved attempt goes to the same spelling without asking again', async () => {
    const resolve = vi.spyOn(buddyClient, 'resolveRecipient').mockResolvedValue('a_b');
    replies = [{ ok: false, outcome: 'unknown' }, { ok: true, outcome: 'stored', id: 's' }];
    mount('a-b', []);
    await sendText('hello', 'a-b');
    await act(async () => { fireEvent.click(screen.getByText('Try again')); });
    expect(sent.map((s) => s.to)).toEqual(['a_b', 'a_b']);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('no hyphen: no lookup at all', async () => {
    const resolve = vi.spyOn(buddyClient, 'resolveRecipient');
    mount();
    await sendText('plain');
    expect(resolve).not.toHaveBeenCalled();
    expect(sent[0].to).toBe(THEM);
  });

  it('a send that resolves to yourself is refused before anything is shown as sent; the words stay', async () => {
    vi.spyOn(buddyClient, 'resolveRecipient').mockResolvedValue(ME);
    mount('alice-demo', []);
    await sendText('note to self', 'alice-demo');
    expect(sent).toHaveLength(0);
    expect(screen.getByTestId('send-note').textContent).toBe('@alice_demo is you — nothing was sent');
    expect((screen.getByPlaceholderText('Message @alice-demo...') as HTMLTextAreaElement).value).toBe('note to self');
  });

  it('App opens typed and linked handles through the resolver (source pin)', () => {
    const app = readFileSync(join(process.cwd(), 'src/App.tsx'), 'utf8');
    expect(app).toMatch(/onUserClick=\{openConversation\}/);
    expect(app).toMatch(/onOpenThread=\{openConversation\}/);
    expect(app).toMatch(/if \(route\.kind === 'dm'\) \{\n\s+openConversation\(route\.handle\);/);
    expect(app).toMatch(/buddyClient\.resolveRecipient\(typed\)/);
  });

  it('the search door no longer folds an unsighted - handle blindly (source pin)', () => {
    const src = readFileSync(join(process.cwd(), 'src/components/UnifiedBuddyList.tsx'), 'utf8');
    expect(src).toMatch(/if \(!\/\^\[a-z0-9_-\]\+\$\/\.test\(c\) \|\| c\.startsWith\('_'\) \|\| \/\^\[0-9\]\+\$\/\.test\(c\)\) return null;\n\s+return raw;/);
    expect(src).toMatch(/presentedHandles\.has\(composeQuery\.replace\(\/-\/g, '_'\)\)/);
  });
});

