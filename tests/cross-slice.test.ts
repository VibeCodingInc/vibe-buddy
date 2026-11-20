/**
 * Interactions between the three review slices (send truth #28, terminal
 * parity #29, sign-in and secrets #30) that no single-slice test covers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const pluginSent: Array<Record<string, unknown>> = [];
vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: async () => true,
  requestPermission: async () => 'granted',
  sendNotification: (n: never) => { pluginSent.push(n as never); },
  registerActionTypes: async () => {},
  onAction: async () => {},
}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string) => (cmd === 'native_notify_available' ? false : undefined),
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ show: async () => {}, unminimize: async () => {}, setFocus: async () => {}, isFocused: async () => false }),
}));

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
function appFiles(): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) { if (f !== 'dev') walk(p); } else if (/\.(ts|tsx)$/.test(f)) out.push(p);
    }
  };
  walk(join(root, 'src'));
  return out;
}

beforeEach(() => { vi.resetModules(); pluginSent.length = 0; });

describe('#28 × #30 — the send path and the live stream under the new CSP', () => {
  it('connect-src admits only IPC, and no native fetch/EventSource/WebSocket is left anywhere in src/', () => {
    const csp = JSON.parse(read('src-tauri/tauri.conf.json')).app.security.csp;
    expect(csp['connect-src']).toBe("'self' ipc: http://ipc.localhost");
    for (const f of appFiles()) {
      expect(code(readFileSync(f, 'utf8')), f).not.toMatch(/new EventSource\(|new WebSocket\(|(^|[^.\w])fetch\(/m);
    }
  });

  it("the recipient lookup (#28) and the stream (#30) both go through the HTTP plugin, to hosts its capability allows", () => {
    const client = code(read('src/lib/vibeClient.ts'));
    expect(client).toMatch(/tauriFetch\(`\$\{API_URL\}\/identity\/\$\{encodeURIComponent\(typed\)\}`/);
    expect(client).toMatch(/const API_URL = 'https:\/\/www\.slashvibe\.dev\/api';/);
    expect(code(read('src/lib/sseStream.ts'))).toMatch(/import \{ fetch as tauriFetch \} from '@tauri-apps\/plugin-http';/);
    expect(code(read('src/lib/realtime.ts'))).toMatch(/const API_URL = 'https:\/\/www\.slashvibe\.dev\/api';/);
    const cap = JSON.parse(read('src-tauri/capabilities/default.json'));
    const http = cap.permissions.find((p: any) => typeof p === 'object' && p.identifier === 'http:default');
    expect(http.allow.map((a: any) => a.url)).toContain('https://www.slashvibe.dev/*');
  });

  it('the send (#28) carries its Idempotency-Key through the 401 path #30 simplified: no refresh, no second request', () => {
    const client = code(read('src/lib/vibeClient.ts'));
    expect(client).toMatch(/'Idempotency-Key': idempotencyKey/);
    expect(client).not.toMatch(/refreshToken|quickAuth|buddy-token/);
  });
});

describe('#29 × #30 — the native command surface after both', () => {
  it('every command the webview invokes is registered, and the removed writers are gone from both sides', () => {
    const invoked = new Set<string>();
    for (const f of appFiles()) {
      for (const m of readFileSync(f, 'utf8').matchAll(/invoke(?:<[^>]*>)?\('([a-z_]+)'/g)) invoked.add(m[1]);
    }
    const main = read('src-tauri/src/main.rs');
    const handler = main.slice(main.indexOf('generate_handler!['), main.indexOf(']', main.indexOf('generate_handler![')));
    const registered = new Set([...handler.matchAll(/(?:[a-z_]+::)?([a-z_]+),/g)].map((m) => m[1]));
    for (const cmd of invoked) expect(registered.has(cmd), `invoke('${cmd}') has no handler`).toBe(true);
    for (const gone of ['save_auth_token', 'install_mcp']) {
      expect(invoked.has(gone)).toBe(false);
      expect(registered.has(gone)).toBe(false);
    }
    // The setup banner's check (#29) stays read-only, and the only writer of
    // token files (#30) is the private atomic one.
    expect(registered.has('check_mcp_status')).toBe(true);
    expect(code(read('src-tauri/src/mcp_setup.rs').split('#[cfg(test)]')[0])).not.toMatch(/fs::write|fs::rename|create_dir/);
    const auth = read('src-tauri/src/auth.rs').split('#[cfg(test)]')[0];
    expect(auth).not.toMatch(/fs::write\(/);
  });

  it('the sign-in thread keeps both intents: server-verified handle (#30) and no agent-config install (#29)', () => {
    const main = read('src-tauri/src/main.rs');
    expect(main).toMatch(/auth::verified_handle\(&data\.token\)/);
    expect(main).toMatch(/auth::save_auth\(&data\.token, &handle\)/);
    expect(main).not.toMatch(/mcp_setup::install_mcp|data\.handle/);
  });
});

describe('#28 × #29 — quiet/mute on the notification paths', () => {
  it('an enriched "answered" banner (the describe path) is held by mute and by quiet too', async () => {
    const n = await import('../src/lib/notifications');
    await n.hasNotificationPermission();
    n.resetNativeNotificationState();
    n.resetNotificationState();
    const reach = await import('../src/lib/reach');
    const describe = async () => ({ title: '@sam answered what you asked', body: 'from the work' });
    const t = (unread: number) => [{ with: 'sam_x', unread, lastMessage: { id: `m${unread}`, from: 'sam_x', body: 'hi' } }];

    reach.setReachState({ present: true, quiet: false, invisible: false, muted: ['sam-x'] });
    n.checkAndNotify(t(0), describe);
    n.checkAndNotify(t(1), describe);
    await new Promise((r) => setTimeout(r, 0));
    expect(pluginSent).toHaveLength(0);

    reach.setReachState({ present: true, quiet: true, invisible: false, muted: [] });
    n.checkAndNotify(t(2), describe);
    await new Promise((r) => setTimeout(r, 0));
    expect(pluginSent).toHaveLength(0);

    reach.setReachState(null);
    n.checkAndNotify(t(3), describe);
    await new Promise((r) => setTimeout(r, 0));
    expect(pluginSent.map((b) => b.title)).toEqual(['@sam answered what you asked']);
  });

  it("mute's canonical form (#29) matches the platform spelling the send path resolves to (#28)", async () => {
    const reach = await import('../src/lib/reach');
    const { chooseRecipient, cleanHandle } = await import('../src/lib/vibeClient');
    const typed = cleanHandle('@A-B');
    const sentTo = chooseRecipient(typed, { found: true, handle: 'a_b' });
    expect(reach.canonicalHandle(typed)).toBe(reach.canonicalHandle(sentTo));
  });
});
