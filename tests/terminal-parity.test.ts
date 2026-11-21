// Terminal parity (slice 3 of the 2026-11-20 review).
//
//  1. Buddy honours the terminal's ~/.vibe/reach.json, read-only:
//       invisible → no presence heartbeat, and the card says why and how;
//       quiet     → no banner about a person until it is off;
//       muted[h]  → no banner from h (one canonical handle form: '-' = '_');
//     re-read every 30s so a typed command takes effect within about a
//     minute; a missing/unreadable file is the defaults, never an error.
//  2. Buddy writes no agent configuration; it shows `npx slashvibe-mcp setup`.
//  3. Tray and Dock counts are unknown, not the last value, once stale.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

let reachAnswer: unknown = null;
let reachThrows = false;
const pluginSent: Array<Record<string, unknown>> = [];
const invokes: Array<{ cmd: string; args?: Record<string, unknown> }> = [];

vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: async () => true,
  requestPermission: async () => 'granted',
  sendNotification: (n: never) => { pluginSent.push(n as never); },
  registerActionTypes: async () => {},
  onAction: async () => {},
}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string, args?: Record<string, unknown>) => {
    invokes.push({ cmd, args });
    if (cmd === 'read_reach_prefs') {
      if (reachThrows) throw new Error('no such command');
      return reachAnswer;
    }
    if (cmd === 'native_notify_available') return false; // plugin path: synchronous in tests
    return undefined;
  },
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ show: async () => {}, unminimize: async () => {}, setFocus: async () => {}, isFocused: async () => false }),
}));

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.resetModules();
  reachAnswer = null;
  reachThrows = false;
  pluginSent.length = 0;
  invokes.length = 0;
});
afterEach(() => { vi.useRealTimers(); });

describe('1 · reach.json — the state Buddy reads', () => {
  it('a missing file (present:false), garbage, or a failed command is the defaults — never an error', async () => {
    const reach = await import('../src/lib/reach');
    for (const raw of [null, undefined, 'x', [], { present: false, quiet: true, invisible: true, muted: ['sam'] }]) {
      expect(reach.normalizeReach(raw)).toEqual(reach.DEFAULT_REACH);
    }
    reachThrows = true;
    await expect(reach.loadReach()).resolves.toEqual(reach.DEFAULT_REACH);
  });

  it('only a literal true turns a flag on; muted handles are canonical (trim, @, case, - → _)', async () => {
    const reach = await import('../src/lib/reach');
    const r = reach.normalizeReach({ present: true, quiet: 'yes', invisible: true, muted: ['@Sam', ' a-b ', 'a_b', 7] });
    expect(r).toEqual({ present: true, quiet: false, invisible: true, muted: ['a_b', 'sam'] });
    expect(reach.canonicalHandle(' @A-B ')).toBe('a_b');
  });

  it('mute @a-b in the terminal silences the a_b whose messages arrive, and vice versa', async () => {
    const reach = await import('../src/lib/reach');
    const s = reach.normalizeReach({ present: true, quiet: false, invisible: false, muted: ['a-b'] });
    expect(reach.isMuted('a_b', s)).toBe(true);
    expect(reach.isMuted('@A-B', s)).toBe(true);
    expect(reach.isMuted('ab', s)).toBe(false);
  });

  it('suppression covers banners about people; session alerts are never held', async () => {
    const reach = await import('../src/lib/reach');
    const quiet = reach.normalizeReach({ present: true, quiet: true, invisible: false, muted: [] });
    const muted = reach.normalizeReach({ present: true, quiet: false, invisible: false, muted: ['sam'] });
    expect(reach.reachSuppressesBanner({ kind: 'dm', from: 'bob' }, quiet)).toBe(true);
    expect(reach.reachSuppressesBanner({ kind: 'arrival', from: 'bob' }, quiet)).toBe(true);
    expect(reach.reachSuppressesBanner({ kind: 'session' }, quiet)).toBe(false);
    expect(reach.reachSuppressesBanner({ kind: 'dm', from: 'sam' }, muted)).toBe(true);
    expect(reach.reachSuppressesBanner({ kind: 'dm', from: 'bob' }, muted)).toBe(false);
    expect(reach.reachSuppressesBanner({ kind: 'dm', from: 'bob' }, reach.DEFAULT_REACH)).toBe(false);
  });

  it('listeners hear real changes only', async () => {
    const reach = await import('../src/lib/reach');
    const heard: boolean[] = [];
    reach.subscribeReach((next) => heard.push(next.invisible));
    reach.setReachState({ present: true, quiet: false, invisible: true, muted: [] });
    reach.setReachState({ present: true, quiet: false, invisible: true, muted: [] });
    reach.setReachState(null);
    expect(heard).toEqual([true, false]);
  });

  it('a terminal command takes effect within about a minute: the file is re-read every 30s, no restart', async () => {
    vi.useFakeTimers();
    const reach = await import('../src/lib/reach');
    expect(reach.REACH_REFRESH_MS).toBeLessThanOrEqual(60_000);
    const stop = reach.watchReach();
    await vi.advanceTimersByTimeAsync(0);
    expect(reach.getReachState().quiet).toBe(false);
    reachAnswer = { present: true, quiet: true, invisible: false, muted: [] }; // `npx slashvibe-mcp quiet`
    await vi.advanceTimersByTimeAsync(reach.REACH_REFRESH_MS);
    expect(reach.getReachState().quiet).toBe(true);
    stop();
    expect(invokes.filter((i) => i.cmd === 'read_reach_prefs').length).toBeGreaterThanOrEqual(2);
  });
});

describe('1 · reach.json — what Buddy does with it', () => {
  async function notifications() {
    const n = await import('../src/lib/notifications');
    await n.hasNotificationPermission();
    n.resetNativeNotificationState();
    n.resetNotificationState();
    n.resetSessionAlertState();
    const reach = await import('../src/lib/reach');
    return { n, reach };
  }
  const thread = (w: string, unread: number) => ({ with: w, unread, lastMessage: { id: `m${unread}`, from: w, body: 'hi' } });

  it('a muted person sends no banner; others still do', async () => {
    const { n, reach } = await notifications();
    reach.setReachState({ present: true, quiet: false, invisible: false, muted: ['sam-x'] });
    n.checkAndNotify([thread('sam_x', 0), thread('bob', 0)]);
    n.checkAndNotify([thread('sam_x', 1), thread('bob', 1)]);
    await flush();
    expect(pluginSent.map((b) => b.title)).toEqual(['@bob']);
  });

  it('quiet holds every banner about a person until it is off, and session alerts still fire', async () => {
    const { n, reach } = await notifications();
    reach.setReachState({ present: true, quiet: true, invisible: false, muted: [] });
    n.checkAndNotify([thread('bob', 0)]);
    n.checkAndNotify([thread('bob', 1)]);
    n.checkSessionAlerts([{ cwd: '/w', label: 'w', wantsYou: false, line: null }], false, true);
    n.checkSessionAlerts([{ cwd: '/w', label: 'w', wantsYou: true, line: 'finished its turn' }], false, true);
    await flush();
    expect(pluginSent.map((b) => b.title)).not.toContain('@bob');
    expect(pluginSent.length).toBe(1); // the session alert
    reach.setReachState({ present: true, quiet: false, invisible: false, muted: [] }); // `unquiet`
    n.checkAndNotify([thread('bob', 2)]);
    await flush();
    expect(pluginSent.map((b) => b.title)).toContain('@bob');
  });

  it('the one place every banner passes is gated (source pin)', () => {
    const src = read('src/lib/notifications.ts');
    expect(src).toMatch(/function deliver\(n: BuddyBanner\): void \{\n(\s*\/\/.*\n)*\s*if \(reachSuppressesBanner\(n\)\) return;/);
  });

  it('invisible: the heartbeat reads reach.json fresh and sends nothing (source pin)', () => {
    const app = read('src/App.tsx');
    expect(app).toMatch(/if \(\(await loadReach\(\)\)\.invisible\) \{\n\s*setMyBroadcast\(null\);\n\s*return;\n\s*\}/);
    // ...the read precedes the only presence write.
    expect(app.indexOf('(await loadReach()).invisible')).toBeLessThan(app.indexOf('buddyClient.updatePresence(payload)'));
    // ...and turning it off re-announces at once, not at the next 5-minute beat.
    expect(app).toMatch(/else if \(prev\.invisible\) void sendHeartbeat\(\);/);
    expect(app).toMatch(/const stop = watchReach\(\);/);
  });

  it('invisible: the card says what Buddy does and how it was set — and how to undo it', async () => {
    const { presenceStatusLine } = await import('../src/lib/presencePrefs');
    const base = { sharing: true, broadcast: null, announceGrace: false, lastLandedAt: null, now: Date.now() };
    const line = presenceStatusLine({ ...base, terminalInvisible: true });
    expect(line).toBe("Buddy isn't announcing you — the terminal's invisible setting is on (undo: npx slashvibe-mcp visible)");
    expect(line).not.toMatch(/!/);
    // It claims only what Buddy does — not that nobody can see you.
    expect(line).not.toMatch(/nobody|no one|invisible to/i);
    // Without the flag, nothing changes.
    expect(presenceStatusLine({ ...base, terminalInvisible: false })).toBe(presenceStatusLine(base));
    expect(read('src/components/list/MyPresenceCard.tsx')).toMatch(/No message alerts — the terminal's quiet setting is on \(undo: npx slashvibe-mcp unquiet\)/);
  });

  it('Buddy never writes reach.json: the native command is read-only and takes no arguments', () => {
    const rust = read('src-tauri/src/reach.rs');
    const code = rust.split('#[cfg(test)]')[0];
    expect(code).toMatch(/pub async fn read_reach_prefs\(\) -> ReachPrefs/);
    expect(code).not.toMatch(/fs::write|OpenOptions|create_dir|rename|remove_file/);
    expect(read('src/lib/reach.ts')).not.toMatch(/invoke\('(write|save|set)_reach/);
    expect(read('src-tauri/src/main.rs')).toMatch(/reach::read_reach_prefs,/);
  });
});

describe('2 · Buddy writes no agent configuration; it shows the one real command', () => {
  it('the line names `npx slashvibe-mcp setup` and says what it does', async () => {
    const { setupLine, SETUP_COMMAND } = await import('../src/lib/setupLine');
    expect(SETUP_COMMAND).toBe('npx slashvibe-mcp setup');
    expect(setupLine(null)).toBeNull();
    expect(setupLine({ installed: true, npx_available: true })).toBeNull();
    const missing = setupLine({ installed: false, server: false, hooks: false, npx_available: true })!;
    expect(missing.text).toContain('npx slashvibe-mcp setup');
    expect(missing.text).toMatch(/adds \/vibe, signs you in with GitHub, and installs the hooks/);
    const noHooks = setupLine({ installed: false, server: true, hooks: false, npx_available: true })!;
    expect(noHooks.text).toMatch(/without the hooks/);
    expect(setupLine({ installed: false, npx_available: false })!.needsNode).toBe(true);
    for (const l of [missing.text, noHooks.text]) expect(l).not.toMatch(/!/);
  });

  it('no copy names an install line or tool that does not exist', () => {
    for (const f of ['src/App.tsx', 'src/lib/setupLine.ts', 'src/components/UnifiedBuddyList.tsx', 'src/components/list/MyPresenceCard.tsx', 'src/lib/presencePrefs.ts']) {
      // Code only — comments may name what does NOT exist, to say so.
      const src = read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
      // Strings only: vibe init / vibe_dm / bare `npx slashvibe-mcp` as an install line.
      expect(src).not.toMatch(/['"`][^'"`\n]*\bvibe init\b[^'"`\n]*['"`]/);
      expect(src).not.toMatch(/['"`][^'"`\n]*\bvibe_dm\b[^'"`\n]*['"`]/);
      expect(src).not.toMatch(/['"`]npx slashvibe-mcp['"`]/);
    }
    // The sign-in card no longer promises to "add /vibe to your coding agents".
    expect(read('src/App.tsx')).not.toMatch(/add \/vibe to your coding agents/);
    expect(read('src/App.tsx')).not.toMatch(/Message people from Claude Code or Codex/);
  });

  it('the installer is gone from both sides', () => {
    const main = read('src-tauri/src/main.rs');
    expect(main).not.toMatch(/install_mcp/);
    expect(read('src/App.tsx')).not.toMatch(/install_mcp/);
    const setup = read('src-tauri/src/mcp_setup.rs').split('#[cfg(test)]')[0];
    expect(setup).not.toMatch(/fs::write|fs::rename|create_dir|codex_home|cursor_dir|config\.toml/);
  });
});

describe('3 · tray and Dock counts: unknown once stale, never the last value', () => {
  const base = {
    now: 1_000_000,
    me: 'alice',
    retainedUsers: [{ handle: 'bob', status: 'active' }, { handle: 'alice', status: 'active' }],
    retainedThreads: [{ unread: 2 }, { unread: 1 }],
    staleAfterMs: 90_000,
  };

  it('fresh reads count as before (self excluded, platform `active` status)', async () => {
    const { trayCounts } = await import('../src/lib/trayStatus');
    expect(trayCounts({ ...base, users: [{ handle: 'bob', status: 'active' }, { handle: 'cy', status: 'away' }], threads: [{ unread: 4 }], presenceGoodAt: base.now, threadsGoodAt: base.now }))
      .toEqual({ online: 1, unread: 4 });
  });

  it('a blip inside the grace keeps the retained counts (the list still shows them)', async () => {
    const { trayCounts } = await import('../src/lib/trayStatus');
    expect(trayCounts({ ...base, users: null, threads: null, presenceGoodAt: base.now - 30_000, threadsGoodAt: base.now - 30_000 }))
      .toEqual({ online: 1, unread: 3 });
  });

  it('past the grace, and before any good read, the counts are unknown — not the last value, not zero', async () => {
    const { trayCounts } = await import('../src/lib/trayStatus');
    expect(trayCounts({ ...base, users: null, threads: null, presenceGoodAt: base.now - 91_000, threadsGoodAt: base.now - 91_000 }))
      .toEqual({ online: null, unread: null });
    expect(trayCounts({ ...base, users: null, threads: null, presenceGoodAt: null, threadsGoodAt: null }))
      .toEqual({ online: null, unread: null });
    // Each count stands on its own read.
    expect(trayCounts({ ...base, users: null, threads: [{ unread: 0 }], presenceGoodAt: null, threadsGoodAt: base.now }))
      .toEqual({ online: null, unread: 0 });
  });

  it('App feeds the tray from trayCounts and tells the Dock badge when unread is unknown (source pin)', () => {
    const app = read('src/App.tsx');
    expect(app).toMatch(/const \{ online, unread \} = trayCounts\(\{/);
    expect(app).toMatch(/staleAfterMs: STALE_AFTER_MS,/);
    expect(app).toMatch(/setUnreadEvidence\(unread !== null\);/);
    expect(app).toMatch(/invoke\('set_tray_status', \{ online: null, unread: null, signedOut: true \}\)/);
  });

  it('the Dock badge shows "?" while unread is unknown, and the count again once fresh', async () => {
    const n = await import('../src/lib/notifications');
    n.resetNotificationState();
    n.checkAndNotify([{ with: 'bob', unread: 3 }]);
    n.setUnreadEvidence(false);
    n.setUnreadEvidence(true);
    const badges = invokes.filter((i) => i.cmd === 'set_dock_badge').map((i) => i.args);
    expect(badges).toEqual([
      { count: 3, unknown: false },
      { count: 3, unknown: true },
      { count: 3, unknown: false },
    ]);
  });
});
