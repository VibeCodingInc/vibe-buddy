/**
 * A revoked token is a dead session, not a network problem.
 *
 * THE BUG (hit live 2026-08-13): the G8 rotation killed every historical
 * token, but a rotation-killed JWT still carries a future `exp`. The client
 * treated local exp as the authority, so it stayed "signed in" while every
 * request 401'd — rendered as "Can't reach /vibe — reconnecting
 * automatically", a promise reconnecting can never keep.
 *
 * THE CONTRACT NOW: on a 401 with a locally-valid token (after the refresh
 * attempt), the client asks the server once via /api/auth/verify. The
 * server's explicit 401 verdict → session expired, send the user to
 * sign-in. A 200 → endpoint-specific 401, stay signed in. A verify that
 * cannot complete decides nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const memStore = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (memStore.has(k) ? memStore.get(k)! : null),
  setItem: (k: string, v: string) => { memStore.set(k, String(v)); },
  removeItem: (k: string) => { memStore.delete(k); },
  clear: () => { memStore.clear(); },
  key: (i: number) => [...memStore.keys()][i] ?? null,
  get length() { return memStore.size; },
};

// URL-routed http double: everything 401s (the revoked-token world) except
// /auth/verify, whose verdict each test scripts.
const verifyVerdict: { status: number; reachable: boolean } = { status: 401, reachable: true };
const verifyGate: { promise: Promise<void> | null } = { promise: null };
const calls: string[] = [];
const httpFetch = vi.fn(async (url: string) => {
  calls.push(url);
  if (String(url).includes('/auth/verify')) {
    if (verifyGate.promise) await verifyGate.promise;
    if (!verifyVerdict.reachable) throw new TypeError('network down');
    return { ok: verifyVerdict.status === 200, status: verifyVerdict.status, json: async () => ({}) };
  }
  return { ok: false, status: 401, json: async () => ({ success: false, error: 'unauthorized' }) };
});
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: httpFetch }));

// The Rust bridge: `invoke('clear_revoked_auth', {token})` clears
// ~/.vibe/auth.json only-if-it-still-holds-that-token and retires the MCP
// config's matching credential aliases. The revoked path MUST call it
// (codex P1 rounds 2-3 — otherwise a relaunch or the terminal rehydrates
// the dead session from disk).
const invoked: Array<{ cmd: string; args?: any }> = [];
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string, args?: any) => { invoked.push({ cmd, args }); }),
}));

// An unsigned JWT whose exp is comfortably in the future — exactly what a
// rotation-killed token looks like from the client's side.
function validLookingToken(): string {
  const payload = Buffer.from(JSON.stringify({ sub: 'vibetester1', exp: Math.floor(Date.now() / 1000) + 86_400 }))
    .toString('base64url');
  return `x.${payload}.y`;
}

async function clientWithDeadToken() {
  const { buddyClient } = await import('../src/lib/vibeClient');
  const client = buddyClient as any;
  client.handle = 'vibetester1';
  client.authToken = validLookingToken();
  client.sessionExpiredNotified = false;
  const expired = vi.fn();
  client.setSessionExpiredHandler(expired);
  return { client, expired };
}

beforeEach(() => {
  vi.resetModules();
  httpFetch.mockClear();
  calls.length = 0;
  invoked.length = 0;
  verifyVerdict.status = 401;
  verifyVerdict.reachable = true;
  verifyGate.promise = null;
});

describe('server-revoked tokens end the session honestly', () => {
  it("the server's 401 verdict signs the user out despite a valid-looking exp", async () => {
    const { client, expired } = await clientWithDeadToken();
    await client.authenticatedRequest({ method: 'GET', url: 'https://www.slashvibe.dev/api/messages?user=vibetester1' });
    expect(calls.some((u) => u.includes('/auth/verify'))).toBe(true);
    expect(expired).toHaveBeenCalledTimes(1);
    // The verdict is PERSISTED, not just announced — and BOUND to the exact
    // token it probed: memory and disk are cleared through
    // clear_revoked_auth(deadToken), so relaunch and the MCP config cannot
    // rehydrate the dead session.
    const cleared = invoked.find((c) => c.cmd === 'clear_revoked_auth');
    expect(cleared?.args?.token).toBeTruthy();
    expect(client.authToken).toBeNull();
    expect(client.handle).toBeNull();
  });

  it('a stay-signed-in verdict clears nothing', async () => {
    verifyVerdict.status = 200;
    const { client } = await clientWithDeadToken();
    await client.authenticatedRequest({ method: 'GET', url: 'https://www.slashvibe.dev/api/messages?user=vibetester1' });
    expect(invoked.some((c) => c.cmd === 'clear_revoked_auth')).toBe(false);
    expect(client.authToken).not.toBeNull();
  });

  it('a stale verdict cannot erase a session re-established mid-probe (codex P2 r3)', async () => {
    // Hold the verify response open, swap in a fresh session, then let the
    // old token's 401 verdict land. The dead token's copies may be retired,
    // but the NEW session must survive untouched and no sign-out fires.
    let releaseVerify!: () => void;
    const gate = new Promise<void>((r) => { releaseVerify = r; });
    verifyGate.promise = gate;

    const { client, expired } = await clientWithDeadToken();
    const oldToken = client.authToken;
    const inFlight = client.authenticatedRequest({ method: 'GET', url: 'https://www.slashvibe.dev/api/messages?user=vibetester1' });
    await new Promise((r) => setTimeout(r, 10)); // let the probe start

    const freshToken = oldToken + '.fresh';
    client.authToken = freshToken;
    client.handle = 'vibetester1';

    releaseVerify();
    await inFlight;

    expect(expired).not.toHaveBeenCalled();
    expect(client.authToken).toBe(freshToken);
    // The dead token's own copies are still retired — bound to THAT token.
    const cleared = invoked.find((c) => c.cmd === 'clear_revoked_auth');
    expect(cleared?.args?.token).toBe(oldToken);
  });

  it('a 200 verdict means the 401 was endpoint-specific — stay signed in', async () => {
    verifyVerdict.status = 200;
    const { client, expired } = await clientWithDeadToken();
    await client.authenticatedRequest({ method: 'GET', url: 'https://www.slashvibe.dev/api/messages?user=vibetester1' });
    expect(calls.some((u) => u.includes('/auth/verify'))).toBe(true);
    expect(expired).not.toHaveBeenCalled();
  });

  it('an unreachable arbiter decides nothing — no sign-out on a blip', async () => {
    verifyVerdict.reachable = false;
    const { client, expired } = await clientWithDeadToken();
    await client.authenticatedRequest({ method: 'GET', url: 'https://www.slashvibe.dev/api/messages?user=vibetester1' });
    expect(expired).not.toHaveBeenCalled();
  });

  it('a locally-expired token still signs out immediately, no server round-trip', async () => {
    const { client, expired } = await clientWithDeadToken();
    const payload = Buffer.from(JSON.stringify({ sub: 'vibetester1', exp: Math.floor(Date.now() / 1000) - 10 }))
      .toString('base64url');
    client.authToken = `x.${payload}.y`;
    await client.authenticatedRequest({ method: 'GET', url: 'https://www.slashvibe.dev/api/messages?user=vibetester1' });
    expect(expired).toHaveBeenCalledTimes(1);
    expect(calls.some((u) => u.includes('/auth/verify'))).toBe(false);
  });
});
