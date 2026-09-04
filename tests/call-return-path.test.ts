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
    rememberCall({ url: 'https://meet.google.com/abc-defg-hij', code: 'abc-defg-hij', from: 'fixture_peer_a', thread: 'fixture_peer_a', work: { project: 'vibe-buddy', branch: 'feat/call-return-path' } });
    const c = getRememberedCall()!;
    expect(c.thread).toBe('fixture_peer_a');
    expect(c.work).toEqual({ project: 'vibe-buddy', branch: 'feat/call-return-path' });
  });
  it('a call started from a session has a work pointer and no thread', () => {
    rememberCall({ url: 'u', code: 'c', from: 'payments', work: { project: 'payments' } });
    const c = getRememberedCall()!;
    expect(c.thread).toBeUndefined();
    expect(c.work?.project).toBe('payments');
  });
  it('junk in storage does not become a return address', () => {
    store.set('buddy_last_call', JSON.stringify({ url: 'u', code: 'c', startedAt: Date.now(), thread: 42, work: 'nope' }));
    const c = getRememberedCall()!;
    expect(c.thread).toBeUndefined();
    expect(c.work).toBeUndefined();
  });
});

describe('the notice offers one way back', () => {
  it('App renders "back to the conversation" only when the call has a thread, and it opens that thread', async () => {
    const fs = await import('node:fs'); const path = await import('node:path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf8');
    const i = src.indexOf("label: 'back to the conversation'");
    expect(i).toBeGreaterThan(-1);
    expect(src.slice(i - 200, i)).toMatch(/lastCall\.thread\s*\?/);
    expect(src.slice(i, i + 200)).toMatch(/setView\(\{ type: 'dm', chatWith: lastCall\.thread! \}\)/);
  });
});
