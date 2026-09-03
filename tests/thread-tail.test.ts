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
  const all = Array.from({ length: TOTAL }, (_, i) => msg(i + 1));
  if (!u.searchParams.get('with')) {
    // the thread list: the only place the length of a thread is served
    return { ok: true, status: 200, json: async () => ({ success: true, threads: [{ id: 'thread_T', with: 'them', unread: 1, message_count: TOTAL, last_message: { from: 'them', body: 'x', created_at: all[TOTAL - 1].created_at } }] }) };
  }
  const limit = Number(u.searchParams.get('limit') ?? 100);
  const offset = Number(u.searchParams.get('offset') ?? 0);
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
  it('a long thread shows its newest page, addressed by the served count', async () => {
    const { buddyClient } = await import('../src/lib/vibeClient');
    const client = buddyClient as any;
    client.handle = 'vibetester1';
    client.authToken = token();
    const { messages, error } = await client.getThreadResult('them');
    expect(error).toBe(false);
    expect(messages).toHaveLength(PAGE);
    expect(messages[messages.length - 1].id).toBe(`m${TOTAL}`);
    expect(messages[0].id).toBe(`m${TOTAL - PAGE + 1}`);
    const threadCalls = calls.filter((c) => c.includes('with=them'));
    expect(threadCalls).toHaveLength(2); // first page, then the tail
    expect(threadCalls[0]).toContain(`limit=${PAGE}`);
    expect(threadCalls[1]).toContain(`offset=${TOTAL - PAGE}`);
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

describe('a long thread that is not on the inbox page (archived / past 50 rows)', () => {
  it('still shows its newest page by walking forward and keeping the tail', async () => {
    const { buddyClient } = await import('../src/lib/vibeClient');
    const client = buddyClient as any;
    client.handle = 'vibetester1';
    client.authToken = token();
    // the inbox has no row for this thread: no served count
    httpFetch.mockImplementation(async (url: string) => {
      calls.push(String(url));
      const u = new URL(String(url));
      if (!u.searchParams.get('with')) {
        return { ok: true, status: 200, json: async () => ({ success: true, threads: [] }) };
      }
      const all = Array.from({ length: 450 }, (_, i) => msg(i + 1));
      const limit = Number(u.searchParams.get('limit') ?? 100);
      const offset = Number(u.searchParams.get('offset') ?? 0);
      const page = all.slice(offset, offset + limit);
      return { ok: true, status: 200, json: async () => ({ success: true, messages: page, count: page.length, offset, limit }) };
    });
    const { messages, error } = await client.getThreadResult('them');
    expect(error).toBe(false);
    expect(messages).toHaveLength(PAGE);
    expect(messages[messages.length - 1].id).toBe('m450');
    expect(messages[0].id).toBe('m251');
  });
});
