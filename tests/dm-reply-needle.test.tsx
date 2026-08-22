// @vitest-environment jsdom
// The reply needle — server-backed reply association rendered (buddy magic
// pass, concept C, render-only slice). Proves: the needle renders ONLY from
// the served quoted-parent object; it QUOTES verbatim (never classifies);
// clicking moves to the parent without changing read state; and no reply_to
// object → an ordinary message with no chrome.

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
import DMPanel from '../src/components/DMPanel';
import { buddyClient, type VibeMessage } from '../src/lib/vibeClient';
import { realtime } from '../src/lib/realtime';
import { setCachedMessages } from '../src/lib/messageCache';

const ME = 'alice_demo';
const THEM = 'bob_demo';
const PARENT_TEXT = 'DECISION: which story should lead?';

const parent: VibeMessage = { id: 'p1', from: ME, to: THEM, content: PARENT_TEXT, timestamp: new Date(Date.now() - 3 * 3600_000).toISOString(), status: 'sent' };
const reply = (replyTo?: VibeMessage['replyTo']): VibeMessage => ({
  id: 'r1', from: THEM, to: ME, content: 'Lead with two doors.', timestamp: new Date().toISOString(), status: 'sent',
  ...(replyTo ? { replyTo } : {}),
});

beforeEach(() => {
  vi.spyOn(realtime, 'init').mockImplementation(() => {});
  vi.spyOn(realtime, 'openDM').mockImplementation(() => {});
  vi.spyOn(realtime, 'goBackground').mockImplementation(() => {});
  vi.spyOn(realtime, 'setTypingCallback').mockImplementation(() => {});
  vi.spyOn(realtime, 'setMessageEvidenceCallback').mockImplementation(() => {});
  vi.spyOn(realtime, 'hasMessageEvidenceFrom').mockReturnValue(false);
  vi.spyOn(buddyClient, 'sendMessageResult').mockResolvedValue({ ok: true });
  vi.spyOn(buddyClient, 'sendTypingIndicator').mockResolvedValue(undefined as never);
  memStore.clear();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const mount = (msgs: VibeMessage[]) => {
  setCachedMessages(ME, THEM, msgs);
  render(<DMPanel handle={ME} chatWith={THEM} onBack={() => {}} users={[]} hasServerThread />);
};

describe('the reply needle renders server-backed association', () => {
  it('renders the needle quoting the parent verbatim when reply_to is served', () => {
    mount([parent, reply({ id: 'p1', from: ME, text: PARENT_TEXT })]);
    // The quote is the parent's exact text, in quotes — a link the reader can act on.
    const needle = screen.getByRole('link', { name: /Answering: "DECISION: which story should lead\?"/ });
    expect(needle).toBeTruthy();
    // "DECISION" is shown because the human literally wrote it — verbatim,
    // never a Buddy-assigned classification.
    expect(needle.textContent).toContain('DECISION: which story should lead?');
  });

  it('shows NO needle when reply_to is absent — ordinary message, no chrome', () => {
    mount([parent, reply()]);
    expect(screen.queryByRole('link', { name: /Answering:/ })).toBeNull();
  });

  it('clicking the needle moves to the parent and highlights it, no read-state write', () => {
    mount([parent, reply({ id: 'p1', from: ME, text: PARENT_TEXT })]);
    const parentEl = document.querySelector('[data-msg-id="p1"]') as HTMLElement;
    const scrollSpy = vi.fn();
    parentEl.scrollIntoView = scrollSpy;
    fireEvent.click(screen.getByRole('link', { name: /Answering:/ }));
    expect(scrollSpy).toHaveBeenCalled();
    // No markThreadRead / read cursor anywhere in the component (kill switch 0a).
    const src = readFileSync(join(process.cwd(), 'src/components/DMPanel.tsx'), 'utf8');
    expect(src).not.toMatch(/markThreadRead|read_cursor/);
  });

  it('the needle is keyboard-activable', () => {
    mount([parent, reply({ id: 'p1', from: ME, text: PARENT_TEXT })]);
    const parentEl = document.querySelector('[data-msg-id="p1"]') as HTMLElement;
    const scrollSpy = vi.fn();
    parentEl.scrollIntoView = scrollSpy;
    const needle = screen.getByRole('link', { name: /Answering:/ });
    fireEvent.keyDown(needle, { key: 'Enter' });
    expect(scrollSpy).toHaveBeenCalled();
  });

  it('never classifies: a parent with no INTENT word gets no invented label', () => {
    const plainParent: VibeMessage = { ...parent, content: 'is the migration safe?' };
    mount([plainParent, reply({ id: 'p1', from: ME, text: 'is the migration safe?' })]);
    const needle = screen.getByRole('link', { name: /Answering:/ });
    // Verbatim quote only — no "DECISION"/"QUESTION"/etc. invented.
    expect(needle.textContent).toContain('is the migration safe?');
    expect(needle.textContent).not.toMatch(/DECISION|QUESTION|REVIEW/);
  });

  it('render-only: no reply_to write path is introduced by this slice', () => {
    const src = readFileSync(join(process.cwd(), 'src/components/DMPanel.tsx'), 'utf8');
    // The composer send does not set reply_to (that is a later slice).
    expect(src).not.toMatch(/reply_to|replyTo:/);
  });
});

describe('the needle honors the deployed unavailable/not-loaded contract (codex CR on #6)', () => {
  const mountMsgs = (msgs: VibeMessage[]) => {
    setCachedMessages(ME, THEM, msgs);
    render(<DMPanel handle={ME} chatWith={THEM} onBack={() => {}} users={[]} hasServerThread />);
  };

  it('an unavailable/deleted parent ({id, from:null, text:null}) renders quiet truthful copy, non-interactive', () => {
    mountMsgs([reply({ id: 'gone', from: null, text: null })]);
    expect(screen.getByText(/replying to an unavailable message/)).toBeTruthy();
    // No empty quote, no link, no "opens the original".
    expect(screen.queryByText('“”')).toBeNull();
    expect(screen.queryByRole('link', { name: /Answering/ })).toBeNull();
  });

  it('a parent OUTSIDE the loaded page renders the quote as PLAIN text — no link, no arrow, no claim', () => {
    // The reply references a parent id that is not present in the thread.
    mountMsgs([reply({ id: 'not_loaded', from: ME, text: PARENT_TEXT })]);
    // The quote still shows…
    expect(screen.getByText(new RegExp(PARENT_TEXT.slice(0, 12)))).toBeTruthy();
    // …but it is NOT an interactive link (parent unreachable in this view).
    expect(screen.queryByRole('link', { name: /Answering/ })).toBeNull();
  });

  it('a loaded parent IS an interactive link and the highlight is genuinely brief', () => {
    vi.useFakeTimers();
    try {
      mountMsgs([parent, reply({ id: 'p1', from: ME, text: PARENT_TEXT })]);
      const parentEl = document.querySelector('[data-msg-id="p1"]') as HTMLElement;
      parentEl.scrollIntoView = vi.fn();
      const needle = screen.getByRole('link', { name: /Answering/ });
      fireEvent.click(needle);
      // Highlighted now…
      expect((document.querySelector('[data-msg-id="p1"]') as HTMLElement).style.outline).toContain('#6B8FFF');
      // …and cleared after the delay, without animation.
      act(() => { vi.advanceTimersByTime(2600); });
      expect((document.querySelector('[data-msg-id="p1"]') as HTMLElement).style.outline).toBe('none');
    } finally {
      vi.useRealTimers();
    }
  });
});
