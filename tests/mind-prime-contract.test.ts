import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('private Mind priming cache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-26T12:00:00Z'));
    vi.stubEnv('VITE_MIND_URL', 'http://127.0.0.1:7788');
    vi.stubEnv('VITE_MIND_TOKEN', 'fixture-token');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
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
    expect(fetch).not.toHaveBeenCalled();
  });

  it('dedupes the same context, refreshes changed context, and expires after 15 minutes', async () => {
    const mind = await import('../src/lib/mindClient');
    mind.primeMind('friend', 'first served message');
    await settle();
    mind.primeMind('friend', 'first served message');
    await settle();
    expect(fetch).toHaveBeenCalledTimes(1);

    mind.primeMind('friend', 'first served message\na newly arrived turn');
    await settle();
    expect(fetch).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(15 * 60_000 + 1);
    mind.primeMind('friend', 'first served message\na newly arrived turn');
    await settle();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('does not cache a refused prime', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false } as Response);
    const mind = await import('../src/lib/mindClient');
    mind.primeMind('friend', 'served context');
    await settle();
    mind.primeMind('friend', 'served context');
    await settle();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
