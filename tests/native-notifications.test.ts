// The native notification path (buddy#39) — delivery choice and routing.
//
// The Rust delegate reports WHAT HAPPENED ({kind, thread, cwd, reply}); every
// decision about what to DO lives in lib/notifications.ts. These tests mount
// that routing against a captured listener, because the bug this fixes was
// precisely "the click happened and nothing could route it".

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const pluginSent: Array<Record<string, unknown>> = [];
const invokes: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
let nativeAnswer: boolean | Error = true;
let capturedHandler: ((event: { payload: Record<string, unknown> }) => void) | null = null;
const windowCalls: string[] = [];

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
    if (cmd === 'native_notify_available') {
      if (nativeAnswer instanceof Error) throw nativeAnswer;
      return nativeAnswer;
    }
    return undefined;
  },
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (name: string, handler: (event: { payload: Record<string, unknown> }) => void) => {
    if (name === 'buddy://notification-action') capturedHandler = handler;
    return () => {};
  },
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    show: () => { windowCalls.push('show'); return Promise.resolve(); },
    unminimize: () => { windowCalls.push('unminimize'); return Promise.resolve(); },
    setFocus: () => { windowCalls.push('focus'); return Promise.resolve(); },
    isFocused: async () => false,
  }),
}));

const flush = () => new Promise((r) => setTimeout(r, 0));

async function freshModule() {
  vi.resetModules();
  pluginSent.length = 0;
  invokes.length = 0;
  windowCalls.length = 0;
  capturedHandler = null;
  const mod = await import('../src/lib/notifications');
  await mod.hasNotificationPermission();
  mod.resetNativeNotificationState();
  mod.resetSessionAlertState();
  mod.resetNotificationState();
  return mod;
}

beforeEach(() => { nativeAnswer = true; });

describe('delivery picks the path the build actually has', () => {
  it('after the probe answers yes, banners go native with the routing payload', async () => {
    const n = await freshModule();
    await n.initNotificationClicks(() => {}, undefined, () => {});
    await flush(); // probe resolves
    n.checkSessionAlerts([{ cwd: '/a', label: 'a', wantsYou: false, line: null }], false, true);
    n.checkSessionAlerts([{ cwd: '/a', label: 'a', wantsYou: true, line: 'finished its turn' }], false, true);
    const native = invokes.filter((i) => i.cmd === 'notify_native');
    expect(native).toHaveLength(1);
    expect((native[0].args as { n: Record<string, unknown> }).n).toMatchObject({
      kind: 'session',
      cwd: '/a',
    });
    expect(pluginSent).toHaveLength(0);
  });

  it('falls back to the plugin when the probe says no — other platforms are real', async () => {
    nativeAnswer = false;
    const n = await freshModule();
    await n.initNotificationClicks(() => {}, undefined, () => {});
    await flush();
    n.checkSessionAlerts([{ cwd: '/a', label: 'a', wantsYou: false, line: null }], false, true);
    n.checkSessionAlerts([{ cwd: '/a', label: 'a', wantsYou: true, line: 'x' }], false, true);
    expect(invokes.filter((i) => i.cmd === 'notify_native')).toHaveLength(0);
    expect(pluginSent).toHaveLength(1);
    expect(pluginSent[0]).toMatchObject({ actionTypeId: 'vibe-session' });
  });

  it('a pre-probe banner queues, then fires on whichever path the probe names', async () => {
    // It must NOT take the plugin path immediately: on macOS the plugin's
    // send installs its own delegate on the shared center, permanently
    // replacing Buddy's — one early banner would kill routing for every
    // banner after it (codex P2). Queue, probe, flush.
    nativeAnswer = false;
    const n = await freshModule();
    // The queue exists only where the hazard does: pretend to be a Mac.
    Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (Macintosh)', configurable: true });
    // No init: probe never warmed. The banner is queued, not dropped.
    n.checkSessionAlerts([{ cwd: '/a', label: 'a', wantsYou: false, line: null }], false, true);
    n.checkSessionAlerts([{ cwd: '/a', label: 'a', wantsYou: true, line: 'x' }], false, true);
    expect(pluginSent).toHaveLength(0); // nothing before the probe answers
    await flush();
    expect(pluginSent).toHaveLength(1); // ...and nothing lost after it
  });

  it('a banner owned by a previous account is refused at routing time', async () => {
    const threads: string[] = [];
    const replies: string[] = [];
    const n = await freshModule();
    n.setNotificationOwner('seth');
    await n.initNotificationClicks((h) => threads.push(h), async (_h, t) => { replies.push(t); return true; }, () => {});
    // Banner stamped for a DIFFERENT owner — e.g. delivered before sign-out,
    // clicked after the next account signed in. Acting would speak as the
    // wrong principal (codex P1).
    capturedHandler!({ payload: { id: '91', kind: 'dm', thread: 'brian', owner: 'previous-account', reply: 'yes' } });
    await flush();
    expect(replies).toEqual([]);
    expect(threads).toEqual([]);
    // The same payload with the RIGHT owner routes normally.
    capturedHandler!({ payload: { id: '92', kind: 'dm', thread: 'brian', owner: 'seth', reply: 'yes' } });
    await flush();
    expect(replies).toEqual(['yes']);
  });

  it('an action is handled exactly once across live delivery and the startup drain', async () => {
    const threads: string[] = [];
    const n = await freshModule();
    n.setNotificationOwner('seth');
    await n.initNotificationClicks((h) => threads.push(h), undefined, () => {});
    const payload = { id: '7', kind: 'dm', thread: 'brian', owner: 'seth', reply: null };
    capturedHandler!({ payload });
    capturedHandler!({ payload }); // drain + live can both deliver the same id
    await flush();
    expect(threads).toEqual(['brian']);
  });
});

describe('the event routes exactly three ways', () => {
  it('a session interaction fronts the session and never focuses Buddy', async () => {
    const opened: string[] = [];
    const threads: string[] = [];
    const n = await freshModule();
    await n.initNotificationClicks((h) => threads.push(h), undefined, (cwd) => opened.push(cwd));
    capturedHandler!({ payload: { kind: 'session', cwd: '/work/api', thread: null, reply: null } });
    await flush();
    expect(opened).toEqual(['/work/api']);
    expect(threads).toEqual([]);
    // Buddy is not the destination — the terminal is.
    expect(windowCalls).toEqual([]);
  });

  it('an inline reply sends without focusing; only a FAILED send surfaces the thread', async () => {
    const threads: string[] = [];
    let replyOk = true;
    const n = await freshModule();
    await n.initNotificationClicks(
      (h) => threads.push(h),
      async () => replyOk,
      () => {},
    );
    capturedHandler!({ payload: { kind: 'dm', thread: 'brian', reply: 'on it — give me an hour' } });
    await flush();
    expect(threads).toEqual([]);
    expect(windowCalls).toEqual([]); // replying is the point of NOT opening the app

    replyOk = false;
    capturedHandler!({ payload: { kind: 'dm', thread: 'brian', reply: 'second try' } });
    await flush();
    // A silent failure must not masquerade as a sent message.
    expect(threads).toEqual(['brian']);
    expect(windowCalls).toContain('focus');
  });

  it('a plain click focuses Buddy and opens the conversation', async () => {
    const threads: string[] = [];
    const n = await freshModule();
    await n.initNotificationClicks((h) => threads.push(h), undefined, () => {});
    capturedHandler!({ payload: { kind: 'dm', thread: 'brian', reply: null } });
    await flush();
    expect(threads).toEqual(['brian']);
    expect(windowCalls).toContain('focus');
  });
});

describe('the Rust side holds up its half of the contract', () => {
  const rsSrc = () => readFileSync(new URL('../src-tauri/src/notify.rs', import.meta.url), 'utf8');
  const rs = rsSrc();

  it('one persistent delegate — never the blocking per-send API', () => {
    // mac-notification-sys's blocking send replaces the shared delegate per
    // call; concurrent banners orphan each other's waits forever.
    expect(rs).toMatch(/setDelegate/);
    expect(rs).not.toMatch(/mac_notification_sys/);
    expect(rs).toMatch(/buddy:\/\/notification-action/);
  });

  it('reports what happened, never what to do — routing stays in the webview', () => {
    expect(rs).not.toMatch(/front_terminal_session|openThread|setFocus/);
  });

  it('an acted-on banner is removed so it cannot re-fire from Notification Center', () => {
    expect(rs).toMatch(/removeDeliveredNotification/);
  });

  it('a cold-launch click is captured from the launch notification', () => {
    // macOS hands a launching click to applicationDidFinishLaunching, before
    // any center delegate exists. The delegate observes that notification and
    // funnels it through the same handler; a content-dedupe window keeps the
    // one physical click from routing twice if didActivate also re-fires.
    expect(rs).toMatch(/NSApplicationLaunchUserNotificationKey/);
    expect(rs).toMatch(/NSApplicationDidFinishLaunchingNotification/);
    // Registered from main() BEFORE the builder runs — setup happens inside
    // applicationDidFinishLaunching, one callback too late (codex P1 r3).
    const main = readFileSync(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
    expect(main.indexOf('notify::early_init()')).toBeLessThan(main.indexOf('tauri::Builder::default()'));
    // Dedupe is banner IDENTITY (a nid stamped at deliver), never content —
    // a content fingerprint collapsed two real banners for one thread and
    // suppressed a legitimate repeated reply (codex P2 r3).
    expect(rs).toMatch(/already_handled_nid/);
    const rsCode = rs.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(rsCode).not.toMatch(/fingerprint/);
  });

  it('a queued banner from a signed-out account is never flushed', async () => {
    // Queued while A's probe was pending; A signs out before it resolves.
    // The owner check blocks ROUTING, but flushing would still put A's
    // message content on screen — a disclosure, not a misroute (codex P2).
    nativeAnswer = false;
    const n = await freshModule();
    Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (Macintosh)', configurable: true });
    n.setNotificationOwner('account-a');
    n.checkSessionAlerts([{ cwd: '/a', label: 'a', wantsYou: false, line: null }], false, true);
    n.checkSessionAlerts([{ cwd: '/a', label: 'a', wantsYou: true, line: 'x' }], false, true);
    n.setNotificationOwner(null); // sign-out races the probe
    await flush();
    expect(pluginSent).toHaveLength(0);
    expect(invokes.filter((i) => i.cmd === 'notify_native')).toHaveLength(0);
  });

  it('nids survive a restart without colliding', () => {
    // Notification Center retains banners past a relaunch; a bare counter
    // restarting at 1 let an old and a new banner share an id, and clicking
    // either swallowed the other's action (codex P2).
    expect(rsSrc()).toMatch(/fn fresh_nid/);
    expect(rsSrc()).toMatch(/ms << 16/);
    // ...and it crosses to JS as a STRING: as a JSON number it exceeds
    // MAX_SAFE_INTEGER and adjacent ids round together (codex P1 r5).
    expect(rsSrc()).toMatch(/fresh_nid\(\)\.to_string\(\)/);
  });

  it('the dev binary keeps the plugin path — no bundle id, no native center', () => {
    // pnpm tauri dev runs a plain binary (CLAUDE.md); NSUserNotificationCenter
    // cannot deliver for an identity-less process, but the plugin path can.
    expect(rsSrc()).toMatch(/has_bundle_identity/);
    expect(rsSrc()).toMatch(/bundleIdentifier/);
  });

  it('routing always uses the freshest mount callbacks (crash-recovery remount)', async () => {
    // ErrorBoundary "Try again" remounts App; the persistent listener kept
    // the OLD closure's callbacks and routed DM clicks into a dead component
    // until a full reload (codex P2 r6). A second init call must refresh
    // what the (single) listener routes through.
    const first: string[] = [];
    const second: string[] = [];
    const n = await freshModule();
    n.setNotificationOwner('seth');
    await n.initNotificationClicks((h) => first.push(h), undefined, () => {});
    await n.initNotificationClicks((h) => second.push(h), undefined, () => {});
    capturedHandler!({ payload: { id: '61', kind: 'dm', thread: 'brian', owner: 'seth', reply: null } });
    await flush();
    expect(first).toEqual([]);        // the dead mount hears nothing
    expect(second).toEqual(['brian']); // the live one routes
  });

  it('a live-handled action is acked out of the replay buffer', async () => {
    // handledActionIds dies with the page; the Rust buffer does not. Without
    // the ack, a webview reload re-drained every warm action — an inline
    // reply posted twice (codex P2 r3).
    const threads: string[] = [];
    const n = await freshModule();
    n.setNotificationOwner('seth');
    await n.initNotificationClicks((h) => threads.push(h), undefined, () => {});
    capturedHandler!({ payload: { id: '41', kind: 'dm', thread: 'brian', owner: 'seth', reply: null } });
    await flush();
    expect(invokes.some((i) => i.cmd === 'ack_notification_action' && (i.args as { id: string }).id === '41')).toBe(true);
  });

  it('a failed terminal front lands the user in Buddy, never nowhere', () => {
    // The banner is gone by the time the front fails — a swallowed { ok:
    // false } made the click visibly do nothing (codex P2).
    const list = readFileSync(new URL('../src/components/UnifiedBuddyList.tsx', import.meta.url), 'utf8');
    expect(list).toMatch(/if \(!fronted\.ok\)/);
    expect(list).toMatch(/frontSession\(match\.session\.tty, match\.session\.app\)/);
  });

  it('the command is registered and the delegate installed at setup', () => {
    const main = readFileSync(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
    expect(main).toMatch(/notify::init\(app\.handle\(\)\)/);
    expect(main).toMatch(/notify::notify_native/);
    expect(main).toMatch(/notify::native_notify_available/);
  });
});
