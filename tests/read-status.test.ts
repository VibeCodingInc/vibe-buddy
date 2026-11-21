// Read status, whose read it is (2026-11-20 review).
//
// The thread route (GET /api/messages?user=&with= → getThreadMessages) serves
// three different facts per message:
//   read          — the VIEWER's cursor ("I read this"); on my own sends it
//                   says nothing about the recipient;
//   read_by_them  — my sends only: the recipient's cursor is past it;
//   status        — my sends only: 'sent' | 'presented' | 'read'.
// Buddy used `read` for my sends, so a message I had scrolled past showed as
// read by them. A send is 'read' only with the recipient's evidence; with no
// evidence at all (a legacy shape) it is 'sent', never 'read'.
import { describe, it, expect, vi, beforeEach } from 'vitest';

let served: any[] = [];
const httpFetch = vi.fn(async () => ({
  ok: true,
  status: 200,
  json: async () => ({ success: true, messages: served }),
}));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: httpFetch }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => {}) }));

function token(): string {
  const payload = Buffer.from(JSON.stringify({ sub: 'me_demo', exp: Math.floor(Date.now() / 1000) + 86_400 })).toString('base64url');
  return ['x', payload, 'y'].join('.');
}
const at = (i: number) => new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString();
const mine = (id: string, extra: Record<string, unknown>) =>
  ({ id, from: 'me_demo', to: 'them_demo', body: id, created_at: at(1), ...extra });
const theirs = (id: string, extra: Record<string, unknown>) =>
  ({ id, from: 'them_demo', to: 'me_demo', body: id, created_at: at(2), ...extra });

beforeEach(() => {
  vi.resetModules();
  httpFetch.mockClear();
  served = [];
});

async function load() {
  const { buddyClient } = await import('../src/lib/vibeClient');
  const client = buddyClient as any;
  client.handle = 'me_demo';
  client.authToken = token();
  const { messages, error } = await client.getThreadResult('them_demo');
  expect(error).toBe(false);
  return Object.fromEntries(messages.map((m: any) => [m.id, m.status]));
}

describe('my sends: read only on the recipient\'s evidence', () => {
  it('the viewer\'s own read=true on my send is NOT a read receipt', async () => {
    served = [mine('a', { read: true, read_by_them: false, status: 'sent' })];
    expect((await load()).a).toBe('sent');
  });

  it('read_by_them=true is read, even when the viewer cursor says false', async () => {
    served = [mine('b', { read: false, read_by_them: true, status: 'read' })];
    expect((await load()).b).toBe('read');
  });

  it("status 'presented' is not read (presentation is not delivery, nor reading)", async () => {
    served = [mine('c', { read: true, read_by_them: false, status: 'presented' })];
    expect((await load()).c).toBe('sent');
  });

  it("status 'read' counts when read_by_them is absent; an explicit false wins", async () => {
    served = [
      mine('d', { status: 'read' }),
      mine('e', { read_by_them: false, status: 'read' }),
      mine('f', { read_by_them: null, status: 'read' }),
    ];
    const s = await load();
    expect(s.d).toBe('read');
    expect(s.e).toBe('sent');
    expect(s.f).toBe('read');
  });

  it('a legacy shape with neither field shows sent — never read without evidence', async () => {
    served = [mine('g', {}), mine('h', { read: true })];
    const s = await load();
    expect(s.g).toBe('sent');
    expect(s.h).toBe('sent');
  });
});

describe('their messages: the viewer\'s own cursor', () => {
  it('read=true is read, read=false or absent is sent; their read_by_them/status are ignored', async () => {
    served = [
      theirs('i', { read: true, read_by_them: null, status: null }),
      theirs('j', { read: false, read_by_them: null, status: null }),
      theirs('k', { read_by_them: true, status: 'read' }),
    ];
    const s = await load();
    expect(s.i).toBe('read');
    expect(s.j).toBe('sent');
    expect(s.k).toBe('sent');
  });
});

describe('servedMessageStatus (the pure decision)', () => {
  it('matches the viewer case- and @-insensitively', async () => {
    const { servedMessageStatus } = await import('../src/lib/vibeClient');
    expect(servedMessageStatus({ from: 'Me_Demo', read: true }, '@me_demo')).toBe('sent');
    expect(servedMessageStatus({ from: 'me_demo', read_by_them: true }, 'ME_DEMO')).toBe('read');
    // Signed out / unknown viewer: nothing is "mine", so only the viewer cursor applies.
    expect(servedMessageStatus({ from: 'me_demo', read: false, read_by_them: true }, null)).toBe('sent');
  });
});
