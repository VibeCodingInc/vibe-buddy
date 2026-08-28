import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

const primeCalls = () =>
  invokeMock.mock.calls.filter((c: unknown[]) => c[0] === 'mind_prime').length;

describe('private Mind priming cache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-26T12:00:00Z'));
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({ primed: true });
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const settle = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };

  it('never promotes an empty/loading snapshot to current relationship context', async () => {
    const mind = await import('../src/lib/mindClient');
    mind.primeMind('friend', '   ');
    await settle();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('dedupes the same context, refreshes changed context, and expires after the session TTL', async () => {
    const mind = await import('../src/lib/mindClient');
    mind.primeMind('friend', 'first served message');
    await settle();
    mind.primeMind('friend', 'first served message');
    await settle();
    expect(primeCalls()).toBe(1);
    const lastPrime = invokeMock.mock.calls.filter((c: unknown[]) => c[0] === 'mind_prime').pop();
    expect(lastPrime?.[1]).toEqual({ handle: 'friend', context: 'first served message' });

    mind.primeMind('friend', 'first served message\na newly arrived turn');
    await settle();
    expect(primeCalls()).toBe(2);

    // The TTL is the retention backstop for a WORKING SESSION (2h), not a
    // coffee break — freshness is owned by the fingerprint above.
    vi.advanceTimersByTime(2 * 60 * 60_000 + 1);
    mind.primeMind('friend', 'first served message\na newly arrived turn');
    await settle();
    expect(primeCalls()).toBe(3);
  });

  it('does not cache a refused prime', async () => {
    // Command-aware: prime_start's mind_trace call must not eat the
    // mocked-null that belongs to mind_prime.
    let refuseNext = true;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'mind_prime' && refuseNext) {
        refuseNext = false;
        return Promise.resolve(null);
      }
      return Promise.resolve(undefined);
    });
    const mind = await import('../src/lib/mindClient');
    mind.primeMind('friend', 'served context');
    await settle();
    mind.primeMind('friend', 'served context');
    await settle();
    expect(primeCalls()).toBe(2);
  });

  it('ships no Mind destination or bearer hook in renderer source', () => {
    const source = readFileSync(
      new URL('../src/lib/mindClient.ts', import.meta.url),
      'utf8'
    );
    expect(source).not.toContain('100.121.205.111');
    expect(source).not.toContain('VITE_MIND_URL');
    expect(source).not.toContain('VITE_MIND_TOKEN');
    expect(source).not.toContain('Authorization');
  });
});

describe('askMind busy contract — one native request, run to completion', () => {
  it('a second ask during flight is skipped, not aborted into the first', async () => {
    vi.resetModules();
    const pending: Array<(v: unknown) => void> = [];
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'mind_trace') return Promise.resolve(null);
      return new Promise((resolve) => pending.push(resolve));
    });
    const mind = await import('../src/lib/mindClient');
    const p1 = mind.askMind('friend', 'first long consequential draft with a real question in it?');
    const p2 = await mind.askMind('friend', 'second draft typed while the first still runs?');
    expect(p2).toBe('busy'); // busy-skip sentinel — never a second native request
    expect(pending).toHaveLength(1); // exactly ONE mind_facet in flight
    pending[0]({ silence: false, offer_kind: 'facet', line: 'x' });
    const r1 = await p1;
    expect(r1?.facet.offer_kind).toBe('facet'); // ...and it COMPLETED
  });
});
