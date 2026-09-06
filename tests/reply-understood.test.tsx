// @vitest-environment jsdom
// A reply is easy to understand and act on (Seth's Mac slice, 2026-09-05):
// the reply says what it answers — on served linkage only — and offers one
// honest way back to the work. No ids, revisions or protocol words on screen.
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

// The Tauri bridge: bindings, the terminal scan, fronting, revealing.
const invoked: Array<{ cmd: string; args: unknown }> = [];
let bindings: unknown[] = [];
let sessions: unknown[] = [];
let frontOk = true;
let revealError: string | null = null;
let scanWarnings: string[] = [];
vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string, args: unknown) => {
    invoked.push({ cmd, args });
    if (cmd === 'read_return_bindings') return bindings;
    if (cmd === 'terminal_sessions') return { sessions, warnings: scanWarnings };
    if (cmd === 'front_terminal_session') { if (!frontOk) throw new Error('that tab is gone'); return null; }
    if (cmd === 'reveal_in_finder') { if (revealError) throw new Error(revealError); return null; }
    return null;
  },
}));

import DMPanel from '../src/components/DMPanel';
import { buddyClient, type VibeMessage } from '../src/lib/vibeClient';
import { realtime } from '../src/lib/realtime';
import { setCachedMessages } from '../src/lib/messageCache';
import { resetReturnBindings } from '../src/lib/returnBindings';

const ME = 'ada';
const THEM = 'linus';
const CWD = '/Users/ada/Projects/payments';
const asked: VibeMessage = { id: 'msg_q', from: ME, to: THEM, content: 're: payments — which backoff curve?', timestamp: new Date(Date.now() - 3600_000).toISOString(), status: 'sent' };
const answer = (over: Partial<VibeMessage> = {}): VibeMessage => ({ id: 'msg_a', from: THEM, to: ME, content: 'exponential, three tries.', timestamp: new Date().toISOString(), status: 'sent', replyTo: { id: 'msg_q', from: ME, text: asked.content }, ...over });
const tab = (over: Record<string, unknown> = {}) => ({ window_id: '1', tty: '/dev/ttys004', name: 'claude', app: 'iTerm2', cwd: CWD, claude_foreground: true, ...over });
const theBinding = { handle: THEM, from: ME, project: 'payments', messageId: 'msg_q', firstLine: asked.content, cwd: CWD, sentAt: 1 };

beforeEach(() => {
  invoked.length = 0; bindings = []; sessions = []; frontOk = true; revealError = null; scanWarnings = []; memStore.clear(); resetReturnBindings();
  vi.spyOn(realtime, 'init').mockImplementation(() => {});
  vi.spyOn(realtime, 'openDM').mockImplementation(() => {});
  vi.spyOn(realtime, 'goBackground').mockImplementation(() => {});
  vi.spyOn(realtime, 'setTypingCallback').mockImplementation(() => {});
  vi.spyOn(buddyClient, 'sendTypingIndicator').mockResolvedValue(undefined as never);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const mount = async (msgs: VibeMessage[]) => {
  setCachedMessages(ME, THEM, msgs);
  render(<DMPanel handle={ME} chatWith={THEM} onBack={() => {}} users={[]} hasServerThread />);
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
};

describe('the reply says what it answers', () => {
  it('names the work when their reply is linked to what you sent from it', async () => {
    bindings = [theBinding];
    await mount([asked, answer()]);
    expect(screen.getByTestId('answers-line').textContent).toContain('answers what you asked from payments');
  });
  it('claims nothing for a message that merely arrived after yours', async () => {
    bindings = [theBinding];
    await mount([asked, answer({ replyTo: undefined })]);
    expect(screen.queryByTestId('answers-line')).toBeNull();
  });
  it('claims nothing when the link points at a different message', async () => {
    bindings = [theBinding];
    await mount([asked, answer({ replyTo: { id: 'msg_other', from: ME, text: 'x' } })]);
    expect(screen.queryByTestId('answers-line')).toBeNull();
  });
  it('shows no ids, revisions or protocol words', async () => {
    bindings = [theBinding];
    await mount([asked, answer()]);
    const text = document.body.textContent || '';
    expect(text).not.toMatch(/msg_|reply_to|rev\b|draft id/);
  });
});

describe('one honest way back', () => {
  it('"Back to the session" fronts the exact live tab', async () => {
    bindings = [theBinding]; sessions = [tab()];
    await mount([asked, answer()]);
    const btn = await screen.findByRole('button', { name: 'Back to the session' });
    fireEvent.click(btn);
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(invoked.some((c) => c.cmd === 'front_terminal_session' && (c.args as { tty: string }).tty === '/dev/ttys004')).toBe(true);
  });
  it('"Show the folder" when no tab is open there, and never "resume"', async () => {
    bindings = [theBinding]; sessions = [];
    await mount([asked, answer()]);
    const btn = await screen.findByRole('button', { name: 'Show the folder' });
    expect((document.body.textContent || '')).not.toMatch(/resum/i);
    fireEvent.click(btn);
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(invoked.some((c) => c.cmd === 'reveal_in_finder' && (c.args as { path: string }).path === CWD)).toBe(true);
  });
  it('a tab that vanished between look and click falls back to the folder, honestly', async () => {
    bindings = [theBinding]; sessions = [tab()]; frontOk = false;
    await mount([asked, answer()]);
    fireEvent.click(await screen.findByRole('button', { name: 'Back to the session' }));
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(invoked.some((c) => c.cmd === 'reveal_in_finder')).toBe(true);
    expect(await screen.findByRole('button', { name: 'Show the folder' })).toBeTruthy();
  });
  it('no cwd in the binding → no action, just the line', async () => {
    bindings = [{ ...theBinding, cwd: null }];
    await mount([asked, answer()]);
    expect(screen.getByTestId('answers-line')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Back to the session|Show the folder/ })).toBeNull();
  });
});

describe('truthful attribution', () => {
  it('a delegated agent message says whose grant it acted under — from the served actor only', async () => {
    await mount([asked, answer({ id: 'msg_b', actor: { kind: 'agent', operator: 'seth' } })]);
    expect(screen.getByTestId('acting-for').textContent).toMatch(/acting for @seth/);
  });
  it('a human message, or an agent with no operator, gets no label', async () => {
    await mount([asked, answer({ id: 'msg_c', actor: { kind: 'human', operator: null } }), answer({ id: 'msg_d', actor: { kind: 'agent', operator: null } })]);
    expect(screen.queryByTestId('acting-for')).toBeNull();
  });
});

describe('codex round 1', () => {
  it('the return action is decided at click time from a fresh scan — a tab that now holds other work is not fronted', async () => {
    bindings = [theBinding]; sessions = [tab()];
    await mount([asked, answer()]);
    await screen.findByRole('button', { name: 'Back to the session' });
    sessions = [tab({ cwd: '/Users/ada/Projects/other' })]; // the tab moved on
    fireEvent.click(screen.getByRole('button', { name: 'Back to the session' }));
    await act(async () => { await new Promise((r) => setTimeout(r, 15)); });
    expect(invoked.some((c) => c.cmd === 'front_terminal_session')).toBe(false);
    expect(invoked.some((c) => c.cmd === 'reveal_in_finder')).toBe(true);
  });
  it('a folder that cannot be shown says why instead of a dead button', async () => {
    bindings = [theBinding]; sessions = []; revealError = "that folder isn't there anymore";
    await mount([asked, answer()]);
    fireEvent.click(await screen.findByRole('button', { name: 'Show the folder' }));
    expect((await screen.findByTestId('back-error')).textContent).toMatch(/isn't there anymore/);
    expect(screen.queryByRole('button', { name: 'Show the folder' })).toBeNull();
  });
  it('a binding written after the conversation opened is picked up when a reply arrives', async () => {
    bindings = [];
    let incoming: ((msgs: VibeMessage[]) => void) | null = null;
    (realtime.openDM as unknown as { mockImplementation: (f: (t: string, cb: (msgs: VibeMessage[]) => void) => void) => void }).mockImplementation((_t, cb) => { incoming = cb; });
    setCachedMessages(ME, THEM, [asked]);
    render(<DMPanel handle={ME} chatWith={THEM} onBack={() => {}} users={[]} hasServerThread />);
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(screen.queryByTestId('answers-line')).toBeNull();
    bindings = [theBinding]; // the terminal wrote it after this panel opened
    await act(async () => { incoming!([asked, answer()]); await new Promise((r) => setTimeout(r, 30)); });
    expect(await screen.findByTestId('answers-line')).toBeTruthy();
  });
});

describe('codex round 2', () => {
  it('a served operator that is a principal id is never shown as a handle', async () => {
    await mount([asked, answer({ id: 'msg_e', actor: { kind: 'agent', operator: '3f2b1c9a-1111-4c2d-9e8f-000000000001' } })]);
    const label = screen.getByTestId('acting-for').textContent || '';
    expect(label).toMatch(/acting under a person's grant/i);
    expect(label).not.toMatch(/3f2b1c9a|@/);
  });
  it('a previous folder failure does not suppress the action for a new binding', async () => {
    bindings = [theBinding]; sessions = []; revealError = 'gone';
    let incoming: ((msgs: VibeMessage[]) => void) | null = null;
    (realtime.openDM as unknown as { mockImplementation: (f: (t: string, cb: (msgs: VibeMessage[]) => void) => void) => void }).mockImplementation((_t, cb) => { incoming = cb; });
    await mount([asked, answer()]);
    fireEvent.click(await screen.findByRole('button', { name: 'Show the folder' }));
    await screen.findByTestId('back-error');
    revealError = null;
    bindings = [{ ...theBinding, messageId: 'msg_q2', cwd: '/Users/ada/Projects/other' }];
    await act(async () => { incoming!([asked, answer(), { ...answer({ id: 'msg_a2' }), replyTo: { id: 'msg_q2', from: ME, text: 'q2' } }]); await new Promise((r) => setTimeout(r, 30)); });
    expect(screen.queryByTestId('back-error')).toBeNull();
    expect(await screen.findByRole('button', { name: 'Show the folder' })).toBeTruthy();
  });
});

describe('codex round 4', () => {
  it('a scan with warnings (a terminal denied or timed out) offers the folder, not a tab that may be the wrong one', async () => {
    bindings = [theBinding]; sessions = [tab()]; scanWarnings = ['Terminal.app: Automation denied'];
    await mount([asked, answer()]);
    expect(await screen.findByRole('button', { name: 'Show the folder' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Back to the session' })).toBeNull();
  });
});
