// codex P1 on #18: with SSE live there is no polling timer, so a refresh that
// arrives while a thread read is in flight is the only refresh. It must run
// after the current read settles — never be dropped.
import { describe, it, expect, vi } from 'vitest';

vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => {}) }));

describe('realtime.pollDM', () => {
  it('a refresh requested mid-read runs after the read settles', async () => {
    const { buddyClient } = await import('../src/lib/vibeClient');
    const { realtime } = await import('../src/lib/realtime');
    const rt = realtime as any;
    rt.handle = 'me';
    rt.dmTarget = 'them';
    const delivered: any[] = [];
    rt.onMessages = (m: any) => delivered.push(m);

    let release!: () => void;
    const first = new Promise<void>((r) => { release = r; });
    const reads: number[] = [];
    vi.spyOn(buddyClient, 'getThreadResult').mockImplementation(async () => {
      reads.push(Date.now());
      if (reads.length === 1) await first; // the slow first read
      return { messages: [{ id: `m${reads.length}` }] as any, error: false };
    });

    const p1 = rt.pollDM();          // in flight
    await Promise.resolve();
    const p2 = rt.pollDM();          // arrives mid-read: must not be dropped
    const p3 = rt.pollDM();          // and a third collapses into the same pending refresh
    release();
    await Promise.all([p1, p2, p3]);

    expect(reads).toHaveLength(2);               // one in flight + one deferred, not three
    expect(delivered.map((m) => m[0].id)).toEqual(['m1', 'm2']);
    expect(rt.dmInFlight).toBe(false);
  });

  it('a lone read does not spawn a second one', async () => {
    const { buddyClient } = await import('../src/lib/vibeClient');
    const { realtime } = await import('../src/lib/realtime');
    const rt = realtime as any;
    rt.handle = 'me'; rt.dmTarget = 'them'; rt.onMessages = () => {};
    const spy = vi.spyOn(buddyClient, 'getThreadResult').mockResolvedValue({ messages: [], error: false } as any);
    await rt.pollDM();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
