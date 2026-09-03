// buddy#17 — the open thread lost its newest messages. The server pages a
// thread OLDEST-first (100 by default, 200 max); asked with no page size, a
// 108-message thread came back as its first 100 and the panel rendered the
// founder's local send beside nothing from the last sixteen hours. The loader
// must walk every page so the newest message is always in the panel.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls: string[] = [];
const PAGE = 200;
const TOTAL = 208; // one full page + a tail of 8, like the real thread
const msg = (i: number) => ({
  id: `m${i}`,
  from: i % 2 ? 'them' : 'vibetester1',
  to: i % 2 ? 'vibetester1' : 'them',
  body: `message ${i}`,
  created_at: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(),
});
const httpFetch = vi.fn(async (url: string) => {
  calls.push(String(url));
  const u = new URL(String(url));
  const limit = Number(u.searchParams.get('limit') ?? 100);
  const offset = Number(u.searchParams.get('offset') ?? 0);
  const all = Array.from({ length: TOTAL }, (_, i) => msg(i + 1));
  const page = all.slice(offset, offset + limit);
  return { ok: true, status: 200, json: async () => ({ success: true, messages: page, count: page.length, offset, limit }) };
});
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: httpFetch }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => {}) }));

function token(): string {
  const payload = Buffer.from(JSON.stringify({ sub: 'vibetester1', exp: Math.floor(Date.now() / 1000) + 86_400 })).toString('base64url');
  return `x.${payload}.y`;
}

beforeEach(() => {
  vi.resetModules();
  httpFetch.mockClear();
  calls.length = 0;
});

describe('thread loader reads the whole thread, newest included (buddy#17)', () => {
  it('walks every page at the maximum size and keeps the tail', async () => {
    const { buddyClient } = await import('../src/lib/vibeClient');
    const client = buddyClient as any;
    client.handle = 'vibetester1';
    client.authToken = token();
    const { messages, error } = await client.getThreadResult('them');
    expect(error).toBe(false);
    expect(messages).toHaveLength(TOTAL);
    expect(messages[messages.length - 1].id).toBe(`m${TOTAL}`);
    const threadCalls = calls.filter((c) => c.includes('with=them'));
    expect(threadCalls).toHaveLength(2);
    expect(threadCalls[0]).toContain(`limit=${PAGE}`);
    expect(threadCalls[0]).toContain('offset=0');
    expect(threadCalls[1]).toContain(`offset=${PAGE}`);
  });

  it('a short thread costs one request', async () => {
    const { buddyClient } = await import('../src/lib/vibeClient');
    const client = buddyClient as any;
    client.handle = 'vibetester1';
    client.authToken = token();
    httpFetch.mockImplementationOnce(async (url: string) => {
      calls.push(String(url));
      return { ok: true, status: 200, json: async () => ({ success: true, messages: [msg(1), msg(2)], count: 2, offset: 0, limit: PAGE }) };
    });
    const { messages } = await client.getThreadResult('them');
    expect(messages).toHaveLength(2);
    expect(calls.filter((c) => c.includes('with=them'))).toHaveLength(1);
  });
});
