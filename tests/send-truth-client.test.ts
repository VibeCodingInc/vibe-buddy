/**
 * Send truth, at the wire (slice 1 of the 2026-11-20 review).
 *
 *  · every send carries an Idempotency-Key header — the header POST
 *    /api/messages hands to /api/v2/messages, which stores a key at most once
 *    and answers a same-key replay with the row it already has;
 *  · three outcomes: stored ONLY with a receipt (success === true or the
 *    stored message's id); refused = a 4xx (nothing written); unknown =
 *    timeout, transport error, 5xx, 408, or a 2xx that could not be read;
 *  · a handle written with '-' is addressed by the platform's own spelling
 *    when GET /api/identity/:handle finds the same account under '_' — any
 *    other answer keeps it as typed (slashvibe-mcp invite.resolveRecipient).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Reply = { status: number; body?: string; throws?: boolean };
let script: Reply[] = [];
const calls: Array<{ url: string; init: any }> = [];
const httpFetch = vi.fn(async (url: string, init: any) => {
  calls.push({ url: String(url), init });
  const r = script.shift() ?? { status: 500, body: '' };
  if (r.throws) throw new TypeError('network down');
  return {
    ok: r.status >= 200 && r.status < 300,
    status: r.status,
    text: async () => r.body ?? '',
    json: async () => JSON.parse(r.body ?? ''),
  };
});
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: httpFetch }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock('@tauri-apps/api/app', () => ({ getVersion: vi.fn(async () => '0.0.0-test') }));
vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn(async () => undefined) }));

async function signedIn() {
  const mod = await import('../src/lib/vibeClient');
  const client = mod.buddyClient as any;
  client.handle = 'alice_demo';
  client.authToken = 'x.eyJleHAiOjk5OTk5OTk5OTl9.y';
  return { mod, client: mod.buddyClient };
}
const json = (v: unknown) => JSON.stringify(v);
const header = (init: any, name: string) => {
  const h = init?.headers || {};
  const k = Object.keys(h).find((x) => x.toLowerCase() === name.toLowerCase());
  return k ? h[k] : undefined;
};

beforeEach(() => {
  vi.resetModules();
  httpFetch.mockClear();
  calls.length = 0;
  script = [];
});

describe('idempotency key on every send', () => {
  it('sends the given key as the Idempotency-Key header to POST /api/messages, and the same key again on a retry', async () => {
    const { client } = await signedIn();
    script = [{ status: 0, throws: true }, { status: 200, body: json({ success: true, message: { id: 'm1' } }) }];
    const first = await client.sendMessageResult('bob_demo', 'hello', undefined, { idempotencyKey: 'buddy-k1' });
    const again = await client.sendMessageResult('bob_demo', 'hello', undefined, { idempotencyKey: 'buddy-k1' });
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe('https://www.slashvibe.dev/api/messages');
    expect(calls[0].init.method).toBe('POST');
    expect(header(calls[0].init, 'Idempotency-Key')).toBe('buddy-k1');
    expect(header(calls[1].init, 'Idempotency-Key')).toBe('buddy-k1');
    expect(first.outcome).toBe('unknown');
    expect(again).toMatchObject({ ok: true, outcome: 'stored', id: 'm1' });
  });

  it('mints a key when the caller gives none — no send leaves without one', async () => {
    const { client } = await signedIn();
    script = [{ status: 200, body: json({ success: true, message: { id: 'm2' } }) }];
    await client.sendMessageResult('bob_demo', 'hi');
    const key = header(calls[0].init, 'Idempotency-Key');
    expect(typeof key).toBe('string');
    expect(key.length).toBeGreaterThan(8);
    expect(key.length).toBeLessThanOrEqual(200); // the platform's cap
  });

  it('keys are unique per mint', async () => {
    const { mod } = await signedIn();
    const keys = new Set(Array.from({ length: 50 }, () => mod.newIdempotencyKey()));
    expect(keys.size).toBe(50);
  });
});

describe('three outcomes, never two', () => {
  const cases: Array<[string, Reply, string]> = [
    ['200 with success:true + id', { status: 200, body: json({ success: true, message: { id: 'm' } }) }, 'stored'],
    ['200 with only a message id', { status: 200, body: json({ message: { id: 'm' } }) }, 'stored'],
    ['200 that is not JSON', { status: 200, body: '<html>proxy</html>' }, 'unknown'],
    ['200 {success:false} with no error', { status: 200, body: json({ success: false }) }, 'unknown'],
    ['200 {} with no receipt', { status: 200, body: json({}) }, 'unknown'],
    ['404 recipient_not_found', { status: 404, body: json({ success: false, error: 'recipient_not_found' }) }, 'refused'],
    ['400 with an unreadable body', { status: 400, body: 'Bad Request' }, 'refused'],
    ['409 idempotency_conflict', { status: 409, body: json({ success: false, error: 'idempotency_conflict' }) }, 'refused'],
    ['408 from an intermediary', { status: 408, body: '' }, 'unknown'],
    ['500', { status: 500, body: json({ success: false, error: 'boom' }) }, 'unknown'],
    ['503 not JSON', { status: 503, body: 'unavailable' }, 'unknown'],
    ['transport error / timeout', { status: 0, throws: true }, 'unknown'],
  ];
  for (const [name, reply, want] of cases) {
    it(`${name} → ${want}`, async () => {
      const { client } = await signedIn();
      script = [reply];
      const r = await client.sendMessageResult('bob_demo', 'x', undefined, { idempotencyKey: 'k' });
      expect(r.outcome).toBe(want);
      expect(r.ok).toBe(want === 'stored');
    });
  }

  it('a refusal carries its code; a stored receipt carries id and storedLength', async () => {
    const { client } = await signedIn();
    script = [
      { status: 404, body: json({ success: false, error: 'recipient_not_found' }) },
      { status: 200, body: json({ success: true, message: { id: 'm9' }, storedLength: 5 }) },
    ];
    expect(await client.sendMessageResult('bob_demo', 'hello')).toMatchObject({ outcome: 'refused', error: 'recipient_not_found' });
    expect(await client.sendMessageResult('bob_demo', 'hello')).toMatchObject({ outcome: 'stored', id: 'm9', storedLength: 5 });
  });

  it('results without an outcome field (older callers) are read conservatively', async () => {
    const { mod } = await signedIn();
    expect(mod.sendOutcomeOf({ ok: true })).toBe('stored');
    expect(mod.sendOutcomeOf({ ok: false, error: 'nope' })).toBe('refused');
    expect(mod.sendOutcomeOf({ ok: false })).toBe('unknown');
  });
});

describe("recipient spelling: the platform's answer decides, nothing is folded blindly", () => {
  it('no hyphen: cleaned, and no request at all', async () => {
    const { client } = await signedIn();
    expect(await client.resolveRecipient('  @Bob_Demo ')).toBe('bob_demo');
    expect(calls).toHaveLength(0);
  });

  it("a-b found as a_b → a_b, asked once at /api/identity/a-b (then remembered)", async () => {
    const { client } = await signedIn();
    script = [{ status: 200, body: json({ handle: 'a_b', kind: 'human' }) }];
    expect(await client.resolveRecipient('@A-B ')).toBe('a_b');
    expect(calls[0].url).toBe('https://www.slashvibe.dev/api/identity/a-b');
    expect(await client.resolveRecipient('a-b')).toBe('a_b');
    expect(calls).toHaveLength(1);
  });

  it('an account really stored with the dash keeps the dash', async () => {
    const { client } = await signedIn();
    script = [{ status: 200, body: json({ handle: 'vibe-bot' }) }];
    expect(await client.resolveRecipient('vibe-bot')).toBe('vibe-bot');
  });

  it('404, 5xx, unreadable, offline, or a DIFFERENT account all keep the typed form — and are not remembered', async () => {
    const { client } = await signedIn();
    script = [
      { status: 404, body: json({ error: 'identity_not_found' }) },
      { status: 500, body: '' },
      { status: 200, body: 'not json' },
      { status: 0, throws: true },
      { status: 200, body: json({ handle: 'someone_else' }) },
      { status: 200, body: json({ handle: 'a_b' }) },
    ];
    for (let i = 0; i < 5; i++) expect(await client.resolveRecipient('a-b')).toBe('a-b');
    // A failure is never cached: the next send asks again and can succeed.
    expect(await client.resolveRecipient('a-b')).toBe('a_b');
    expect(calls).toHaveLength(6);
  });

  it('chooseRecipient mirrors the terminal package rule exactly', async () => {
    const { mod } = await signedIn();
    expect(mod.chooseRecipient('a-b', { found: true, handle: 'a_b' })).toBe('a_b');
    expect(mod.chooseRecipient('a-b', { found: true, handle: 'a-b' })).toBe('a-b');
    expect(mod.chooseRecipient('a-b', { found: true, handle: 'x_y' })).toBe('a-b');
    expect(mod.chooseRecipient('a-b', { found: false })).toBe('a-b');
    expect(mod.chooseRecipient('a-b', { found: null })).toBe('a-b');
    expect(mod.chooseRecipient('a_b', { found: true, handle: 'a-b' })).toBe('a_b'); // no '-' typed: untouched
  });
});

describe('the ONE send function resolves the recipient, for every caller', () => {
  const postBody = (c: { init: any }) => JSON.parse(c.init.body);
  const posts = () => calls.filter((c) => c.url === 'https://www.slashvibe.dev/api/messages');

  it("a notification-banner reply to '@A-B ' is cleaned AND resolved to the platform's a_b", async () => {
    const { client } = await signedIn();
    script = [
      { status: 200, body: json({ handle: 'a_b', kind: 'human' }) },
      { status: 200, body: json({ success: true, message: { id: 'm9' } }) },
    ];
    // The banner path: UnifiedBuddyList hands (thread, text) to sendMessage.
    expect(await client.sendMessage('@A-B ', 'from the banner')).toBe(true);
    expect(calls[0].url).toBe('https://www.slashvibe.dev/api/identity/a-b');
    expect(posts()).toHaveLength(1);
    expect(postBody(posts()[0]).to).toBe('a_b');
  });

  it('no hyphen: cleaned, no lookup request', async () => {
    const { client } = await signedIn();
    script = [{ status: 200, body: json({ success: true, message: { id: 'm10' } }) }];
    const r = await client.sendMessageResult(' @Bob_Demo', 'hi');
    expect(r.outcome).toBe('stored');
    expect(calls).toHaveLength(1);
    expect(postBody(calls[0]).to).toBe('bob_demo');
  });

  it('resolved: true (the composer, which already resolved and pinned it) is not looked up again', async () => {
    const { client } = await signedIn();
    script = [{ status: 200, body: json({ success: true, message: { id: 'm11' } }) }];
    await client.sendMessageResult('vibe-bot', 'hi', undefined, { idempotencyKey: 'buddy-pinned', resolved: true });
    expect(calls).toHaveLength(1);
    expect(postBody(calls[0]).to).toBe('vibe-bot');
    expect(header(calls[0].init, 'Idempotency-Key')).toBe('buddy-pinned');
  });

  it('a lookup that cannot answer keeps the typed form, and the outcome and key are unchanged', async () => {
    const { client } = await signedIn();
    script = [
      { status: 0, throws: true },                 // identity lookup offline
      { status: 0, throws: true },                 // the send itself: unknown
      { status: 200, body: json({ handle: 'a_b' }) }, // retry: the lookup answers now
      { status: 200, body: json({ success: true, message: { id: 'm12' } }) },
    ];
    const first = await client.sendMessageResult('a-b', 'hello', undefined, { idempotencyKey: 'buddy-k9' });
    expect(first.outcome).toBe('unknown');
    expect(postBody(posts()[0]).to).toBe('a-b');
    const again = await client.sendMessageResult('a-b', 'hello', undefined, { idempotencyKey: 'buddy-k9' });
    expect(again).toMatchObject({ ok: true, outcome: 'stored', id: 'm12' });
    expect(posts().map((c) => header(c.init, 'Idempotency-Key'))).toEqual(['buddy-k9', 'buddy-k9']);
  });

  it('a refusal is still a refusal after resolution', async () => {
    const { client } = await signedIn();
    script = [
      { status: 404, body: json({ error: 'identity_not_found' }) },
      { status: 404, body: json({ success: false, error: 'recipient_not_found' }) },
    ];
    const r = await client.sendMessageResult('no-one', 'hi');
    expect(r).toMatchObject({ ok: false, outcome: 'refused', error: 'recipient_not_found' });
  });
});

describe('deep links are cleaned like typed handles', () => {
  it('vibe://dm/ handles are trimmed, de-@-ed and lowercased; spelling untouched', async () => {
    const { routeDeepLink } = await import('../src/lib/deepLink');
    expect(routeDeepLink('vibe://dm/A-B')).toEqual({ kind: 'dm', handle: 'a-b' });
    expect(routeDeepLink('vibe://dm/%40a-b')).toEqual({ kind: 'dm', handle: 'a-b' });
    expect(routeDeepLink('vibe://dm/%20%40Bob_Demo%20')).toEqual({ kind: 'dm', handle: 'bob_demo' });
    expect(routeDeepLink('vibe://dm/a%2Fb')).toBeNull();
    expect(routeDeepLink('vibe://dm/%E0%A4%A')).toBeNull();
  });
});
