/**
 * Honest-state audit (docs/HONEST-STATE-AUDIT-2026-08-11.md) — the dark-path
 * cluster: #11 (freshness treats missing evidence as fresh), #15 (stale
 * summon grants never expire), #16 (any 2xx reads as "doorbell rung"),
 * #17 (the legacy roster overrides server agent-attribution).
 *
 * One defect class throughout: claiming a state stronger than the evidence.
 * Each test pins the direction the audit reversed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const memStore = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (memStore.has(k) ? memStore.get(k)! : null),
  setItem: (k: string, v: string) => { memStore.set(k, String(v)); },
  removeItem: (k: string) => { memStore.delete(k); },
  clear: () => { memStore.clear(); },
  key: (i: number) => [...memStore.keys()][i] ?? null,
  get length() { return memStore.size; },
};

const httpResponse: { status: number; body: any } = { status: 200, body: {} };
const httpFetch = vi.fn(async () => ({
  ok: httpResponse.status >= 200 && httpResponse.status < 300,
  status: httpResponse.status,
  json: async () => httpResponse.body,
  text: async () => JSON.stringify(httpResponse.body),
}));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: httpFetch }));

// ---------------------------------------------------------------------------
// #11 · a timestamp that cannot be read is not evidence of freshness
// ---------------------------------------------------------------------------
describe('freshness: green needs a readable, recent timestamp (#11)', () => {
  it('withholds green when lastSeen is missing', async () => {
    const { isFreshLastSeen } = await import('../src/lib/freshness');
    expect(isFreshLastSeen(undefined, Date.now())).toBe(false);
  });

  it('withholds green when lastSeen is unparseable', async () => {
    const { isFreshLastSeen } = await import('../src/lib/freshness');
    expect(isFreshLastSeen('not-a-date', Date.now())).toBe(false);
  });

  it('still grants green for a readable, recent timestamp', async () => {
    const { isFreshLastSeen } = await import('../src/lib/freshness');
    const now = Date.now();
    expect(isFreshLastSeen(new Date(now - 60_000).toISOString(), now)).toBe(true);
  });

  it('still withholds green past the shared window', async () => {
    const { isFreshLastSeen, GREEN_FRESH_MS } = await import('../src/lib/freshness');
    const now = Date.now();
    expect(isFreshLastSeen(new Date(now - GREEN_FRESH_MS - 1).toISOString(), now)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// #17 · server attribution wins; the legacy roster only fills silence
// ---------------------------------------------------------------------------
describe('agent attribution: the roster can never override the server (#17)', () => {
  const user = (over: any) => ({ handle: 'x', status: 'active', ...over });

  it('an explicit server false stays false, even for a roster handle', async () => {
    const { isAgent } = await import('../src/components/list/shared');
    expect(isAgent(user({ handle: 'coltrane', isAgent: false }) as any)).toBe(false);
  });

  it('server silence falls back to the roster', async () => {
    const { isAgent } = await import('../src/components/list/shared');
    expect(isAgent(user({ handle: 'coltrane' }) as any)).toBe(true);
    expect(isAgent(user({ handle: 'a-stranger' }) as any)).toBe(false);
  });

  it('an explicit server true labels a handle the roster has never heard of', async () => {
    const { isAgent } = await import('../src/components/list/shared');
    expect(isAgent(user({ handle: 'a-stranger', isAgent: true }) as any)).toBe(true);
  });

  it('the presence mapping preserves the tri-state instead of collapsing silence to false', async () => {
    vi.resetModules();
    httpResponse.status = 200;
    httpResponse.body = {
      active: [
        { handle: 'says-nothing' },
        { handle: 'says-no', is_agent: false },
        { handle: 'says-yes', isAgent: true },
      ],
      away: [], agents: [], sessions: [],
    };
    const { buddyClient } = await import('../src/lib/vibeClient');
    const res = await (buddyClient as any).getOnlineUsers();
    const by = (h: string) => res.users.find((u: any) => u.handle === h);
    expect(by('says-nothing').isAgent).toBeUndefined();
    expect(by('says-no').isAgent).toBe(false);
    expect(by('says-yes').isAgent).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// #15 / #16 · the doorbell
// ---------------------------------------------------------------------------
describe('doorbell honesty (#15, #16)', () => {
  beforeEach(() => {
    vi.resetModules(); // module-level probe cache == a fresh process
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-12T12:00:00Z'));
    httpFetch.mockClear();
    // doorbell resolves auth through buddyClient; stub it signed-in
    vi.doMock('../src/lib/vibeClient', () => ({
      buddyClient: {
        getAuthToken: () => 'test-token',
        getHandle: () => 'tester',
      },
    }));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock('../src/lib/vibeClient');
  });

  const ring = async () => {
    const { summonAgent } = await import('../src/lib/doorbell');
    return summonAgent({
      agent: 'coltrane',
      meetUrl: 'https://meet.google.com/abc-defg-hij',
      purpose: 'test',
    });
  };

  it('a 202 with the contract envelope is rung (#16 keeps the real path)', async () => {
    httpResponse.status = 202;
    httpResponse.body = { summon_ref: 'ref_1' };
    const result = await ring();
    expect(result.rung).toBe(true);
    expect(result.summonRef).toBe('ref_1');
  });

  it('a 200 is not "rung" — only the contract 202 earns the claim (#16)', async () => {
    httpResponse.status = 200;
    httpResponse.body = { summon_ref: 'ref_1' };
    const result = await ring();
    expect(result.rung).toBe(false);
  });

  it('a 202 without summon_ref is out of contract, not rung (#16)', async () => {
    httpResponse.status = 202;
    httpResponse.body = {};
    const result = await ring();
    expect(result.rung).toBe(false);
    expect(result.error).toMatch(/out of contract/);
  });

  it('a confirmed quick-dial survives one failed probe cycle, then expires (#15)', async () => {
    const { getSummonable } = await import('../src/lib/doorbell');

    httpResponse.status = 200;
    httpResponse.body = { summonable: [{ agent: 'coltrane' }] };
    expect(await getSummonable()).toHaveLength(1);

    // 6 min: probe cache expired, server now failing — recent evidence holds.
    vi.setSystemTime(new Date('2026-08-12T12:06:00Z'));
    httpResponse.status = 500;
    expect(await getSummonable()).toHaveLength(1);

    // 20 min since the last successful probe: the grant evidence has aged out.
    vi.setSystemTime(new Date('2026-08-12T12:20:00Z'));
    expect(await getSummonable()).toHaveLength(0);
  });

  it('recovery: a succeeding probe relights the quick-dial after expiry (#15)', async () => {
    const { getSummonable } = await import('../src/lib/doorbell');
    httpResponse.status = 200;
    httpResponse.body = { summonable: [{ agent: 'coltrane' }] };
    await getSummonable();

    vi.setSystemTime(new Date('2026-08-12T12:20:00Z'));
    httpResponse.status = 500;
    expect(await getSummonable()).toHaveLength(0);

    vi.setSystemTime(new Date('2026-08-12T12:26:00Z'));
    httpResponse.status = 200;
    expect(await getSummonable()).toHaveLength(1);
  });
});
