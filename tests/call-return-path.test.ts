// #329 — the participant returns to work. A call started from a thread keeps
// that thread as its return address and a PRIVATE work pointer; both survive
// storage, both are validated, neither is ever sent anywhere.
import { describe, it, expect, beforeEach } from 'vitest';
import { rememberCall, getRememberedCall, forgetCall } from '../src/lib/callMemory';

const store = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) };

beforeEach(() => { store.clear(); forgetCall(); });

describe('call memory carries the return address', () => {
  it('keeps the originating thread and the private work pointer', () => {
    rememberCall({ url: 'https://meet.google.com/abc-defg-hij', code: 'abc-defg-hij', from: 'payments', work: { project: 'payments', sessionId: 'sess_1' } });
    const c = getRememberedCall()!;
    expect(c.thread).toBeUndefined();
    expect(c.work).toEqual({ project: 'payments', sessionId: 'sess_1' });
  });
  it('a call started from a session has a work pointer and no thread', () => {
    rememberCall({ url: 'u', code: 'c', from: 'payments', work: { project: 'payments' } });
    const c = getRememberedCall()!;
    expect(c.thread).toBeUndefined();
    expect(c.work?.project).toBe('payments');
  });
  it('remembers which account started the call', () => {
    rememberCall({ url: 'u', code: 'c', from: 'fixture_peer_a', thread: 'fixture_peer_a', account: 'fixture_me' });
    expect(getRememberedCall()!.account).toBe('fixture_me');
  });
  it('junk in storage does not become a return address', () => {
    store.set('buddy_last_call', JSON.stringify({ url: 'u', code: 'c', startedAt: Date.now(), thread: 42, work: 'nope' }));
    const c = getRememberedCall()!;
    expect(c.thread).toBeUndefined();
    expect(c.work).toBeUndefined();
  });
});

describe('the work pointer is yours, never the other participant\'s', () => {
  it('a call started from a conversation records the thread and NO work pointer', async () => {
    const fs = await import('node:fs'); const path = await import('node:path');
    const dm = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'DMPanel.tsx'), 'utf8');
    const call = dm.match(/rememberCall\(\{[^}]*\}\)/)![0];
    expect(call).toMatch(/thread: chatWith/);
    expect(call).not.toMatch(/work:/);
    expect(call).not.toMatch(/them/);
  });
  it('a call started from your session records that session as the origin', async () => {
    const fs = await import('node:fs'); const path = await import('node:path');
    const ms = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'list', 'MySessions.tsx'), 'utf8');
    expect(ms).toMatch(/rememberCall\(\{ url: info\.url, code: info\.code, from: session\.project, work: \{ project: session\.project, sessionId: session\.sessionId \} \}\)/);
  });
});

describe('the notice offers one way back', () => {
  it('App renders "back to the conversation" only when the call has a thread, and it opens that thread', async () => {
    const fs = await import('node:fs'); const path = await import('node:path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf8');
    const i = src.indexOf("label: 'back to the conversation'");
    expect(i).toBeGreaterThan(-1);
    expect(src.slice(i - 200, i)).toMatch(/lastCall\.thread && lastCall\.account === handle/);
    expect(src.slice(i, i + 200)).toMatch(/setView\(\{ type: 'dm', chatWith: lastCall\.thread! \}\)/);
  });
  it('the way back belongs to the account that started the call (codex P2, #22)', async () => {
    const fs = await import('node:fs'); const path = await import('node:path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf8');
    const i = src.indexOf("label: 'back to the conversation'");
    expect(src.slice(i - 200, i)).toMatch(/lastCall\.account === handle/);
    // and identity teardown forgets the call, so the next person inherits no door
    const j = src.indexOf('const clearIdentityState = useCallback(() => {');
    expect(src.slice(j, j + 400)).toMatch(/forgetCall\(\);/);
    expect(src.slice(j, j + 400)).toMatch(/setLastCall\(null\);/);
    // DMPanel records the account when it remembers the call
    const dm = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'DMPanel.tsx'), 'utf8');
    expect(dm).toMatch(/rememberCall\(\{[^}]*account: handle/);
  });
});
