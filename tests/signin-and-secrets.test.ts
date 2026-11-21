/**
 * Sign-in and secrets (slice 2 of the 2026-11-20 review), webview half.
 * The Rust half (OAuth state, verified handle, 0600/0700 atomic writes,
 * control characters) is pinned by `cargo test` in auth.rs and terminal.rs.
 *
 *  3. No token refresh exists to claim a session Buddy cannot get.
 *  4. A Content Security Policy, as tight as the code's real sources allow.
 *  5. The call-start command no longer blocks the window.
 *  6. The live stream's token travels in a header, never in the URL.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const calls: string[] = [];
const httpFetch = vi.fn(async (url: string) => {
  calls.push(String(url));
  if (String(url).includes('/auth/verify')) return { ok: true, status: 200, json: async () => ({ valid: true }) };
  return { ok: false, status: 401, json: async () => ({ success: false, error: 'unauthorized' }) };
});
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: httpFetch }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock('@tauri-apps/api/app', () => ({ getVersion: vi.fn(async () => '0.0.0-test') }));
vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn(async () => undefined) }));

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

beforeEach(() => { vi.resetModules(); httpFetch.mockClear(); calls.length = 0; });

describe('3 · no refresh path to pretend with', () => {
  it('a 401 asks the server about the token, and never asks buddy-token for a new one', async () => {
    const { buddyClient } = await import('../src/lib/vibeClient');
    const c = buddyClient as any;
    c.handle = 'alice';
    c.authToken = `x.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86_400 })).toString('base64url')}.y`;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await c.authenticatedRequest({ method: 'GET', url: 'https://www.slashvibe.dev/api/messages?user=alice' });
    warn.mockRestore();
    expect(r.status).toBe(401);
    expect(calls.some((u) => u.includes('/auth/verify'))).toBe(true);
    expect(calls.some((u) => u.includes('buddy-token'))).toBe(false);
    // One request, one verdict: nothing was retried with a credential we do not have.
    expect(calls.filter((u) => u.includes('/api/messages'))).toHaveLength(1);
  });
});

describe('4 · Content Security Policy', () => {
  const conf = JSON.parse(read('src-tauri/tauri.conf.json'));
  const csp = conf.app.security.csp as Record<string, string>;
  const dev = conf.app.security.devCsp as Record<string, string>;

  it('is set (it was null) and closes what the app never uses', () => {
    expect(csp).toBeTruthy();
    expect(csp['default-src']).toBe("'self'");
    expect(csp['script-src']).toBe("'self'");
    for (const d of ['object-src', 'base-uri', 'frame-src', 'form-action']) expect(csp[d]).toBe("'none'");
    for (const v of Object.values(csp)) expect(v).not.toMatch(/unsafe-eval|\*/);
  });

  it('the webview reaches the network only through IPC: no https origin in connect-src', () => {
    expect(csp['connect-src']).toBe("'self' ipc: http://ipc.localhost");
    // ...which holds because no native fetch/EventSource/WebSocket remains in app code.
    const files: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) { if (f !== 'dev') walk(p); } else if (/\.(ts|tsx)$/.test(f)) files.push(p); } };
    walk(join(process.cwd(), 'src'));
    for (const f of files) {
      const code = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(code, f).not.toMatch(/new EventSource\(|new WebSocket\(|(^|[^.\w])fetch\(/m);
    }
  });

  it('img-src covers exactly the avatar hosts the code loads (github.com redirects to avatars.githubusercontent.com)', () => {
    expect(csp['img-src']).toBe("'self' data: https://github.com https://avatars.githubusercontent.com");
    const imgHosts = new Set<string>();
    for (const f of ['src/App.tsx', 'src/components/DMPanel.tsx', 'src/components/SessionPanel.tsx', 'src/components/list/shared.tsx']) {
      for (const m of read(f).matchAll(/src=\{`(https:\/\/[^/`$]+)/g)) imgHosts.add(m[1]);
    }
    expect([...imgHosts]).toEqual(['https://github.com']);
  });

  it("styles: React's inline style objects and the injected keyframes need 'unsafe-inline', so Tauri's style nonce is disabled for style-src only", () => {
    expect(csp['style-src']).toBe("'self' 'unsafe-inline'");
    expect(conf.app.security.dangerousDisableAssetCspModification).toEqual(['style-src']);
    expect(read('src/components/UnifiedBuddyList.tsx')).toMatch(/document\.createElement\('style'\)/);
  });

  it('dev differs only by the Vite server and its inline React-refresh preamble', () => {
    expect(dev['connect-src']).toBe("'self' ipc: http://ipc.localhost ws://localhost:1421 http://localhost:1421");
    expect(dev['script-src']).toBe("'self' 'unsafe-inline'");
    for (const k of Object.keys(csp)) if (k !== 'connect-src' && k !== 'script-src') expect(dev[k]).toBe(csp[k]);
  });
});

describe('5 · the call start no longer blocks the window', () => {
  it('vibeconf_start_call is async + spawn_blocking', () => {
    const src = read('src-tauri/src/vibeconf.rs');
    expect(src).toMatch(/#\[tauri::command\]\npub async fn vibeconf_start_call\(context: Option<String>\) -> Result<CallInfo, String> \{\n\s*tauri::async_runtime::spawn_blocking/);
  });
});

describe('6 · the live stream carries the token in a header, never in the URL', () => {
  it('the parser handles LF, CRLF, multi-line data, comments and chunk splits', async () => {
    const { createSseParser } = await import('../src/lib/sseStream');
    const got: Array<{ event: string; data: string }> = [];
    const feed = createSseParser((e) => got.push({ event: e.event, data: e.data }));
    feed(': ping\n\nevent: mess');
    feed('age\ndata: {"from":"bob"}\n\n');
    feed('event: typing\r\ndata: {"a":1}\r\n');
    feed('\r');
    feed('\ndata: line1\ndata: line2\n\nevent: x\n'); // the last is not yet dispatched
    expect(got).toEqual([
      { event: 'message', data: '{"from":"bob"}' },
      { event: 'typing', data: '{"a":1}' },
      { event: 'message', data: 'line1\nline2' },
    ]);
  });

  function streamOf(chunks: string[], status = 200, type = 'text/event-stream') {
    const enc = new TextEncoder();
    let i = 0;
    return {
      ok: status === 200, status,
      headers: new Headers({ 'content-type': type }),
      body: new ReadableStream<Uint8Array>({ pull(c) { if (i < chunks.length) c.enqueue(enc.encode(chunks[i++])); else c.close(); } }),
    };
  }

  it('Authorization: Bearer, and a URL with no token in it', async () => {
    const { openAuthedEventStream } = await import('../src/lib/sseStream');
    const seen: Array<{ url: string; init: any }> = [];
    const events: string[] = [];
    let opened = false;
    let errors = 0;
    await new Promise<void>((done) => {
      openAuthedEventStream('https://www.slashvibe.dev/api/v2/messages/stream', 'tok.en.x', {
        onOpen: () => { opened = true; },
        onEvent: (e) => events.push(`${e.event}:${e.data}`),
        onError: () => { errors++; done(); },
      }, (async (url: string, init: any) => { seen.push({ url, init }); return streamOf(['event: message\ndata: {}\n\n']); }) as any);
    });
    expect(seen[0].url).toBe('https://www.slashvibe.dev/api/v2/messages/stream');
    expect(seen[0].url).not.toMatch(/token/);
    expect(seen[0].init.headers.Authorization).toBe('Bearer tok.en.x');
    expect(opened).toBe(true);
    expect(events).toEqual(['message:{}']);
    expect(errors).toBe(1); // the server ending the stream → reconnect, like EventSource
  });

  it('a refused or non-SSE answer is an error, not an open stream; closing is silent', async () => {
    const { openAuthedEventStream } = await import('../src/lib/sseStream');
    for (const res of [streamOf([], 401), streamOf(['x'], 200, 'text/html')]) {
      let opened = false;
      await new Promise<void>((done) => {
        openAuthedEventStream('u', 't', { onOpen: () => { opened = true; }, onEvent: () => {}, onError: () => done() }, (async () => res) as any);
      });
      expect(opened).toBe(false);
    }
    let errored = false;
    const close = openAuthedEventStream('u', 't', { onOpen: () => {}, onEvent: () => {}, onError: () => { errored = true; } },
      (async (_u: string, init: any) => new Promise((_r, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))))) as any);
    close();
    await new Promise((r) => setTimeout(r, 0));
    expect(errored).toBe(false);
  });

  it('realtime uses it: no EventSource, no ?token= anywhere in the client', () => {
    const rt = read('src/lib/realtime.ts');
    expect(rt).toMatch(/openAuthedEventStream\(`\$\{API_URL\}\/v2\/messages\/stream`, token,/);
    expect(rt).not.toMatch(/EventSource|\?token=/);
  });
});
