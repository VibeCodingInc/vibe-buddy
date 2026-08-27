import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

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
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenLastCalledWith('mind_prime', {
      handle: 'friend',
      context: 'first served message',
    });

    mind.primeMind('friend', 'first served message\na newly arrived turn');
    await settle();
    expect(invokeMock).toHaveBeenCalledTimes(2);

    // The TTL is the retention backstop for a WORKING SESSION (2h), not a
    // coffee break — freshness is owned by the fingerprint above.
    vi.advanceTimersByTime(2 * 60 * 60_000 + 1);
    mind.primeMind('friend', 'first served message\na newly arrived turn');
    await settle();
    expect(invokeMock).toHaveBeenCalledTimes(3);
  });

  it('does not cache a refused prime', async () => {
    invokeMock.mockResolvedValueOnce(null);
    const mind = await import('../src/lib/mindClient');
    mind.primeMind('friend', 'served context');
    await settle();
    mind.primeMind('friend', 'served context');
    await settle();
    expect(invokeMock).toHaveBeenCalledTimes(2);
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
