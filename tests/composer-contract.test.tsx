// @vitest-environment jsdom
// The composer contract that is not about any private Mind (kept when the
// founder-only Personal Mind left the release build):
//   · a long single-paragraph paste autosizes, capped at four lines;
//   · the composer resets after send;
//   · the exact prose leaves byte-for-byte;
//   · a second gesture during flight sends exactly once;
//   · a refused send keeps the exact prose in a retryable failed bubble.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
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
import { buddyClient, type VibeMessage } from '../src/lib/vibeClient';
import { realtime } from '../src/lib/realtime';
import { setCachedMessages } from '../src/lib/messageCache';

const ME = 'vibetester1';
const THEM = 'vibetester2';

let sent: Array<{ content: string }> = [];

beforeEach(() => {
  clearUnresolvedAttempts();
  sent = [];
  vi.spyOn(realtime, 'init').mockImplementation(() => {});
  vi.spyOn(realtime, 'openDM').mockImplementation(() => {});
  vi.spyOn(realtime, 'goBackground').mockImplementation(() => {});
  vi.spyOn(realtime, 'setTypingCallback').mockImplementation(() => {});
  vi.spyOn(realtime, 'setMessageEvidenceCallback').mockImplementation(() => {});
  vi.spyOn(realtime, 'hasMessageEvidenceFrom').mockReturnValue(false);
  vi.spyOn(realtime, 'recordStoredMessageWith').mockImplementation(() => {});
  vi.spyOn(buddyClient, 'sendMessageResult').mockImplementation(async (_to, content) => {
    sent.push({ content });
    return { ok: true };
  });
  vi.spyOn(buddyClient, 'sendTypingIndicator').mockResolvedValue(undefined as never);
  memStore.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const mount = (chatWith = THEM, msgs: VibeMessage[] = []) => {
  setCachedMessages(ME, chatWith, msgs);
  return render(
    <DMPanel handle={ME} chatWith={chatWith} onBack={() => {}} users={[]} hasServerThread />
  );
};
const composer = (them = THEM) => screen.getByPlaceholderText(`Message @${them}...`);
const type = (text: string, them = THEM) =>
  fireEvent.change(composer(them), { target: { value: text } });
const pressSend = (them = THEM) => fireEvent.keyDown(composer(them), { key: 'Enter' });
const flush = () => act(async () => { await Promise.resolve(); });

// A 424-byte single-paragraph paste with NO newline: rows=split('\n') once
// counted 1 forever and the box clipped.
const LONG_PASTE =
  'i keep circling the same fork on this: the particle piece is finished enough to ship and the audience is warm right now, but every time i sit with it i want one more pass on the color field before it lives anywhere permanent, and i cannot tell whether that instinct is craft or fear, and whether waiting for access is patience or an excuse dressed as patience, so tell me which one you are hearing in this, plainly';
const LONG_FLAT = 'here is a long ordinary message that says a lot of ordinary things about the day without asking anything consequential at all, just news';

describe('the composer', () => {
  it('a long single-paragraph paste autosizes from rendered height, capped at four lines', () => {
    mount();
    const el = composer() as HTMLTextAreaElement;
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 160 });
    type(LONG_PASTE);
    expect(new TextEncoder().encode(LONG_PASTE).length).toBeGreaterThan(400);
    expect(el.getAttribute('rows')).toBe('1');
    expect(el.style.height).not.toBe('');
    expect(parseFloat(el.style.height)).toBeLessThanOrEqual(4 * 18 + 14 + 1);
    expect(el.style.overflowY).toBe('auto');
  });

  it('resets after send', async () => {
    mount();
    const el = composer() as HTMLTextAreaElement;
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 160 });
    type(LONG_PASTE);
    pressSend();
    await flush();
    expect((composer() as HTMLTextAreaElement).value).toBe('');
  });
});

describe('the send path', () => {
  it('the exact prose leaves byte-for-byte', async () => {
    mount();
    type(LONG_FLAT);
    await act(async () => { fireEvent.click(screen.getByText('Send')); });
    expect(sent).toEqual([{ content: LONG_FLAT }]);
  });

  it('a second gesture during flight sends exactly once', async () => {
    let release!: (v: { ok: boolean }) => void;
    vi.mocked(buddyClient.sendMessageResult).mockImplementation((_to, content) => {
      sent.push({ content });
      return new Promise((r) => { release = r; });
    });
    mount();
    type(LONG_FLAT);
    await act(async () => { fireEvent.click(screen.getByText('Send')); });
    type(LONG_FLAT);
    await act(async () => { fireEvent.click(screen.getByText('Send')); });
    expect(sent).toHaveLength(1);
    await act(async () => { release({ ok: true }); await Promise.resolve(); });
  });

  it('a refused send keeps the exact prose in a retryable failed bubble', async () => {
    vi.mocked(buddyClient.sendMessageResult).mockImplementation(async (_to, content) => {
      sent.push({ content });
      return { ok: false, error: 'server_unavailable' };
    });
    mount();
    type(LONG_FLAT);
    await act(async () => { fireEvent.click(screen.getByText('Send')); });
    expect(screen.getByText(LONG_FLAT)).toBeTruthy();
    const retryBtn = screen.getByText(/retry/i);
    vi.mocked(buddyClient.sendMessageResult).mockImplementation(async (_to, content) => {
      sent.push({ content });
      return { ok: true, id: 'msg_pin2' };
    });
    await act(async () => { fireEvent.click(retryBtn); });
    expect(sent).toHaveLength(2);
    expect(sent[1].content).toBe(LONG_FLAT);
  });
});
