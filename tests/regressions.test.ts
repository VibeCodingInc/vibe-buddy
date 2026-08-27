/**
 * Scar tissue.
 *
 * Every test here maps to a defect that actually shipped and reached a user or
 * would have reached one within days. None of them are here to describe how the
 * code works — they are here because these specific bugs came back once already
 * or would silently come back the moment someone refactors the surrounding code.
 *
 * All three were found by an external code review, not by anything failing.
 * That is the gap these close.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

// Minimal localStorage. The modules under test persist small preferences there;
// a real DOM is far more machinery than these state-machine tests need.
const memStore = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (memStore.has(k) ? memStore.get(k)! : null),
  setItem: (k: string, v: string) => { memStore.set(k, String(v)); },
  removeItem: (k: string) => { memStore.delete(k); },
  clear: () => { memStore.clear(); },
  key: (i: number) => [...memStore.keys()][i] ?? null,
  get length() { return memStore.size; },
};

// ---------------------------------------------------------------------------
// Tauri plugin doubles. The real ones need a running app; the logic under test
// is ours, not theirs.
// ---------------------------------------------------------------------------
const osPermissionGranted = { value: true };
const permissionRead = vi.fn(async () => osPermissionGranted.value);
const permissionRequest = vi.fn(async () => (osPermissionGranted.value ? 'granted' : 'denied'));
const sent: Array<{ title: string; body: string }> = [];

vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: permissionRead,
  requestPermission: permissionRequest,
  sendNotification: (n: any) => { sent.push(n); },
  onAction: async () => {},
}));
const tauriInvoke = vi.fn(async () => {});
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauriInvoke }));
vi.mock('@tauri-apps/api/app', () => ({ getVersion: async () => '0.0.0-test' }));
const updaterCheck = vi.fn();
const relaunchApp = vi.fn(async () => {});
vi.mock('@tauri-apps/plugin-updater', () => ({ check: updaterCheck }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: relaunchApp }));

// presence fetches directly via the http plugin, not authenticatedRequest.
const presencePayload: { value: any; ok: boolean } = { value: {}, ok: true };
const httpFetch = vi.fn(async () => ({
  ok: presencePayload.ok,
  status: presencePayload.ok ? 200 : 500,
  json: async () => presencePayload.value,
  text: async () => JSON.stringify(presencePayload.value),
}));
vi.mock('@tauri-apps/plugin-http', () => ({
  fetch: httpFetch,
}));
const windowFocused = { value: false };
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ isFocused: async () => windowFocused.value, setFocus: async () => {} }),
}));

const thread = (withHandle: string, unread: number) => ({
  with: withHandle,
  unread,
  lastMessage: { from: withHandle, body: 'hello' },
});

describe('notifications survive an app restart', () => {
  beforeEach(() => {
    sent.length = 0;
    osPermissionGranted.value = true;
    permissionRead.mockReset();
    permissionRead.mockImplementation(async () => osPermissionGranted.value);
    permissionRequest.mockReset();
    permissionRequest.mockImplementation(async () => (osPermissionGranted.value ? 'granted' : 'denied'));
    vi.resetModules(); // fresh module state == a fresh process
  });

  it('notifies after a restart when the OS grant is read at startup', async () => {
    // THE BUG (shipped, would have hit every invited user by day 2):
    // `permissionGranted` is module state starting false in every process. The
    // only call that set it sat behind a `buddy_notify_dismissed` gate — and
    // accepting the notification offer SETS that flag. So a user who enabled
    // notifications got exactly one session of them, then silence forever,
    // while the tray unread count kept moving so it still looked alive.
    const n = await import('../src/lib/notifications');

    // What the mount effect now does unconditionally on every launch.
    await n.hasNotificationPermission();

    n.checkAndNotify([thread('alice', 0)]); // first call establishes baseline
    n.checkAndNotify([thread('alice', 1)]); // a new message arrives

    // Pre-probe banners QUEUE now (#39): a plugin send on macOS installs its
    // own delegate over Buddy's, so nothing may take the plugin path until
    // the native probe has answered. One microtask settles it.
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toContain('hello');
  });

  it('stays silent if startup never reads the OS grant — the regression itself', async () => {
    // Pin the failure mode. If someone reintroduces the gate around that
    // startup read, this test is what tells them what they broke.
    const n = await import('../src/lib/notifications');

    // deliberately NOT calling hasNotificationPermission()
    n.checkAndNotify([thread('alice', 0)]);
    n.checkAndNotify([thread('alice', 1)]);

    expect(sent).toHaveLength(0);
  });

  it('does not fire for the backlog already unread at startup', async () => {
    // The other half of the same function: opening Buddy to 20 unread messages
    // must not produce 20 notifications.
    const n = await import('../src/lib/notifications');
    await n.hasNotificationPermission();

    n.checkAndNotify([thread('alice', 12), thread('bob', 3)]);
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toHaveLength(0);

    n.checkAndNotify([thread('alice', 13), thread('bob', 3)]);
    await new Promise((r) => setTimeout(r, 0)); // pre-probe queue drains (#39)
    expect(sent).toHaveLength(1);
  });

  it('one failed permission read cannot disable notifications for the whole week', async () => {
    // THE BUG: startup checked the OS grant once. A transient plugin rejection
    // became module-level false for the remaining process lifetime, recreating
    // the exact silent-notification failure the restart fix was meant to stop.
    permissionRead
      .mockRejectedValueOnce(new Error('notification service unavailable'))
      .mockResolvedValue(true);
    const n = await import('../src/lib/notifications');

    await expect(n.hasNotificationPermission()).resolves.toBe(false);
    n.checkAndNotify([thread('alice', 0)]); // triggers background retry
    await Promise.resolve();
    await Promise.resolve();
    n.checkAndNotify([thread('alice', 0)]); // recovered baseline
    n.checkAndNotify([thread('alice', 1)]);

    expect(permissionRead).toHaveBeenCalledTimes(2);
    expect(sent).toHaveLength(1);
  });

  it('a notification plugin failure cannot be remembered as the users dismissal', async () => {
    // THE BUG: Turn on ignored the boolean result and persisted the offer as
    // dismissed even when the OS/plugin threw. Notifications stayed off and
    // Buddy never offered them again, exactly like a deliberate No.
    osPermissionGranted.value = false;
    permissionRequest.mockRejectedValueOnce(new Error('notification service unavailable'));
    const n = await import('../src/lib/notifications');

    await expect(n.ensureNotificationPermissionResult()).resolves.toEqual({
      granted: false,
      error: true,
    });
  });
});

describe('an open DM survives sleep', () => {
  beforeEach(() => { vi.resetModules(); });

  it('reconnect() keeps the subscription; stop() is the logout teardown', async () => {
    // THE BUG: wake handling called realtime.stop() then connectSSE(). stop()
    // drops dmTarget and both callbacks and resets mode to background — correct
    // for logout, fatal on wake, because the DM panel is still mounted and its
    // subscribe effect does not rerun. The stream came back with nothing to
    // deliver to, so the open conversation went silent until the user navigated
    // away and back. After every laptop sleep, which is every day.
    const { realtime } = await import('../src/lib/realtime');
    const onMessages = vi.fn();

    realtime.openDM('alice', onMessages);
    expect((realtime as any).dmTarget).toBe('alice');
    expect((realtime as any).mode).toBe('dm');

    realtime.reconnect();

    expect((realtime as any).dmTarget).toBe('alice');
    expect((realtime as any).onMessages).toBe(onMessages);
    expect((realtime as any).mode).toBe('dm');

    // ...whereas stop() is supposed to forget everything.
    realtime.stop();
    expect((realtime as any).dmTarget).toBeNull();
    expect((realtime as any).onMessages).toBeNull();
    expect((realtime as any).mode).toBe('background');
  });

  it('invalidates in-flight fetches across the gap', async () => {
    // Anything still resolving from before an 8-hour sleep is stale and must
    // not land on top of fresh state.
    const { realtime } = await import('../src/lib/realtime');
    realtime.openDM('alice', vi.fn());

    const before = (realtime as any).dmGeneration;
    realtime.reconnect();
    expect((realtime as any).dmGeneration).toBeGreaterThan(before);
  });
});

describe('a network blip does not erase your conversations', () => {
  beforeEach(() => { vi.resetModules(); });

  const load = async (impl: () => Promise<{ ok: boolean; data: any }>) => {
    const mod = await import('../src/lib/vibeClient');
    const client: any = mod.buddyClient;
    client.handle = 'me';
    client.authenticatedRequest = impl;
    return client;
  };

  it('reports error rather than an authoritative empty inbox when the request fails', async () => {
    // THE BUG: getThreadList returned [] on every failure and App committed it
    // as truth — so a dropped connection emptied the Recent list and zeroed the
    // tray unread count. The user watched their conversations disappear with no
    // reason to think it was the network. Presence already guarded against
    // exactly this; threads did not.
    const client = await load(async () => ({ ok: false, data: null }));
    const res = await client.getThreadListResult();

    expect(res.error).toBe(true);
    expect(res.threads).toEqual([]);
  });

  it('treats a 200 whose body is the wrong shape as failure, not emptiness', async () => {
    // A proxy error page or a bad deploy returns 200 with something that is not
    // our envelope. That must never read as "you have no messages".
    const client = await load(async () => ({ ok: true, data: '<html>502</html>' }));
    const res = await client.getThreadListResult();
    expect(res.error).toBe(true);
  });

  it('reports a genuinely empty inbox as empty, not as an error', async () => {
    // The other side of the same coin: a real empty inbox must stay empty, or
    // a new user would see phantom state forever.
    const client = await load(async () => ({ ok: true, data: { threads: [] } }));
    const res = await client.getThreadListResult();

    expect(res.error).toBe(false);
    expect(res.threads).toEqual([]);
  });

  it('maps real threads through', async () => {
    const client = await load(async () => ({
      ok: true,
      data: { threads: [{ with: 'alice', unread: 2, last_message: { from: 'alice', body: 'hi', created_at: 'now' } }] },
    }));
    const res = await client.getThreadListResult();

    expect(res.error).toBe(false);
    expect(res.threads).toHaveLength(1);
    expect(res.threads[0].with).toBe('alice');
    expect(res.threads[0].unread).toBe(2);
  });
});

describe('arrival notifications stay magical rather than annoying', () => {
  const user = (handle: string, status = 'active', extra = {}) =>
    ({ handle, status, oneLiner: 'shipping', ...extra });

  beforeEach(() => {
    sent.length = 0;
    osPermissionGranted.value = true;
    windowFocused.value = false;
    localStorage.clear();
    vi.resetModules();
  });

  const ready = async () => {
    const n = await import('../src/lib/notifications');
    await n.hasNotificationPermission();
    return n;
  };

  it('announces someone you know coming online', async () => {
    const n = await ready();
    await n.notifyArrivals([user('alice', 'away')], [thread('alice', 0)]);  // baseline
    await n.notifyArrivals([user('alice', 'active')], [thread('alice', 0)]);

    expect(sent).toHaveLength(1);
    expect(sent[0].title).toContain('alice');
  });

  it('never announces the first roster — everyone "arrives" at launch', async () => {
    // Without a baseline, opening Buddy would fire one notification per person
    // already online. That is the difference between delight and a firehose.
    const n = await ready();
    await n.notifyArrivals(
      [user('alice'), user('bob')],
      [thread('alice', 0), thread('bob', 0)]
    );
    expect(sent).toHaveLength(0);
  });

  it('stays quiet about strangers', async () => {
    // A thread is the evidence that you know someone. Without one, an arrival
    // is a stranger walking past a window.
    const n = await ready();
    await n.notifyArrivals([user('carol', 'away')], []);
    await n.notifyArrivals([user('carol', 'active')], []);
    expect(sent).toHaveLength(0);
  });

  it('announces a person at most once a day', async () => {
    // Someone with a flaky connection can flip active/away all afternoon. That
    // must not become an afternoon of notifications.
    const n = await ready();
    await n.notifyArrivals([user('alice', 'away')], [thread('alice', 0)]);
    await n.notifyArrivals([user('alice', 'active')], [thread('alice', 0)]);
    await n.notifyArrivals([user('alice', 'away')], [thread('alice', 0)]);
    await n.notifyArrivals([user('alice', 'active')], [thread('alice', 0)]);

    expect(sent).toHaveLength(1);
  });

  it('says nothing while you are already looking at Buddy', async () => {
    // Seeing it happen beats being told it happened.
    const n = await ready();
    await n.notifyArrivals([user('alice', 'away')], [thread('alice', 0)]);
    windowFocused.value = true;
    await n.notifyArrivals([user('alice', 'active')], [thread('alice', 0)]);
    expect(sent).toHaveLength(0);
  });

  it('ignores agents, which come and go constantly', async () => {
    const n = await ready();
    await n.notifyArrivals([user('sal', 'away', { isAgent: true })], [thread('sal', 0)]);
    await n.notifyArrivals([user('sal', 'active', { isAgent: true })], [thread('sal', 0)]);
    expect(sent).toHaveLength(0);
  });

  it('starts clean after a sign-out so the next account sees no phantom wave', async () => {
    const n = await ready();
    await n.notifyArrivals([user('alice')], [thread('alice', 0)]);
    n.resetArrivals();
    // Next account's first roster is a baseline again, not six arrivals.
    await n.notifyArrivals([user('alice'), user('bob')], [thread('alice', 0), thread('bob', 0)]);
    expect(sent).toHaveLength(0);
  });

  it('sign-out clears the persisted arrival suppression log', async () => {
    // THE BUG: resetArrivals cleared only the in-memory roster. Its persisted
    // "already notified today" log survived, so the next account on the Mac
    // silently missed an arrival for anyone both accounts had messaged.
    const n = await ready();
    await n.notifyArrivals([user('alice', 'away')], [thread('alice', 0)]);
    await n.notifyArrivals([user('alice', 'active')], [thread('alice', 0)]);
    expect(sent).toHaveLength(1);

    n.resetArrivals();
    sent.length = 0;

    // Account B establishes its own baseline, then Alice really arrives.
    await n.notifyArrivals([user('alice', 'away')], [thread('alice', 0)]);
    await n.notifyArrivals([user('alice', 'active')], [thread('alice', 0)]);
    expect(sent).toHaveLength(1);
  });
});

describe('the empty room keeps its traces', () => {
  beforeEach(() => { vi.resetModules(); presencePayload.ok = true; });

  const presence = async (data: any) => {
    presencePayload.value = data;
    const mod = await import('../src/lib/vibeClient');
    return (mod.buddyClient as any).getOnlineUsers();
  };

  it('keeps who was here recently, which the client used to discard', async () => {
    // The server has always sent `recent` — handle, how long ago, what they
    // were doing. Buddy dropped it, so a board with nobody on it right now
    // rendered as a void while the server knew people had been working within
    // the last few hours.
    const res = await presence({
      active: [], away: [], agents: [], sessions: [],
      recent: [
        { handle: 'bflynn4141', ago: '2h', workingOn: 'Updating budgeting system' },
        { handle: 'nadavmills', ago: '9h', workingOn: 'katalog.chat' },
      ],
    });

    expect(res.recentlyHere).toHaveLength(2);
    expect(res.recentlyHere[0]).toMatchObject({ handle: 'bflynn4141', ago: '2h' });
  });

  it('never lets a trace become presence', async () => {
    // The one thing this must not do: a trace merged into the roster would put
    // an absent person on the board behind a live dot.
    const res = await presence({
      active: [], away: [], agents: [], sessions: [],
      recent: [{ handle: 'ghost', ago: '9h' }],
    });

    expect(res.users).toHaveLength(0);
    expect(res.users.find((u: any) => u.handle === 'ghost')).toBeUndefined();
  });

  it('survives a server that sends no recent bucket at all', async () => {
    const res = await presence({ active: [], away: [], agents: [], sessions: [] });
    expect(res.recentlyHere).toEqual([]);
  });

  it('an OFFLINE resident agent is not promoted to here-now (honest-state audit)', async () => {
    // A resident agent has a persistent identity and can be offline. The mapper
    // collapsed everything-but-away to 'active', so an offline agent landed in
    // the active bucket and the "agents here right now" count — presence with no
    // evidence. It must not appear on the roster at all.
    const res = await presence({
      active: [], away: [], sessions: [],
      agents: [
        { handle: 'coltrane', status: 'offline', lastSeen: '2020-01-01T00:00:00Z' },
        { handle: 'sal', status: 'active' },
      ],
    });
    expect(res.users.find((u: any) => u.handle === 'coltrane')).toBeUndefined();
    const sal = res.users.find((u: any) => u.handle === 'sal');
    expect(sal).toBeTruthy();
    expect(sal.status).toBe('active');
    expect(sal.isAgent).toBe(true);
  });

  it('an agent with no status keeps the server bucketing (active)', async () => {
    const res = await presence({
      active: [], away: [], sessions: [],
      agents: [{ handle: 'grace' }],
    });
    const grace = res.users.find((u: any) => u.handle === 'grace');
    expect(grace).toBeTruthy();
    expect(grace.status).toBe('active');
  });

  it('a malformed 200 presence body cannot erase the last-good roster', async () => {
    // THE BUG: every presence bucket defaulted to [], even when the 200 body
    // was HTML or unrelated JSON. App then erased a good roster and rendered
    // "Quiet in here" as if the server had said nobody was online.
    const res = await presence('<html>upstream unavailable</html>');
    expect(res.error).toBe(true);

    const jsonError = await presence({ error: 'upstream unavailable' });
    expect(jsonError.error).toBe(true);
  });
});

describe('failed refreshes preserve state that was already on screen', () => {
  beforeEach(() => { vi.resetModules(); });

  it('does not replace an open conversation with emptiness when refresh fails', async () => {
    // THE BUG: getThread returned [] for both "real empty thread" and "request
    // failed". Realtime delivered that [] to DMPanel, which erased the visible
    // conversation and persisted [] over the last-good local cache.
    const { buddyClient } = await import('../src/lib/vibeClient');
    const { realtime } = await import('../src/lib/realtime');
    const client = buddyClient as any;
    const callback = vi.fn();
    client.handle = 'me';
    client.authToken = 'token';
    // A JSON error envelope is especially dangerous: it looks parseable, but
    // it contains neither authoritative conversation bucket.
    client.authenticatedRequest = vi.fn(async () => ({
      ok: true,
      status: 200,
      data: { error: 'upstream unavailable' },
    }));

    (realtime as any).handle = 'me';
    (realtime as any).dmTarget = 'alice';
    (realtime as any).onMessages = callback;
    await (realtime as any).pollDM();

    expect(callback).not.toHaveBeenCalled();
    realtime.stop();
  });

  it('does not declare that local sessions vanished when their request fails', async () => {
    // THE BUG: /my-sessions returned [] on every failure and App committed it
    // unconditionally, so a network blip removed the user's active sessions
    // (and their new Start a call affordances) from the list.
    const { buddyClient } = await import('../src/lib/vibeClient');
    const client = buddyClient as any;
    client.authToken = 'token';
    client.authenticatedRequest = vi.fn(async () => ({ ok: false, data: null }));

    const result = await client.getMySessionsResult();
    expect(result).toEqual({ sessions: [], error: true });
  });
});

describe('update actions are single-flight', () => {
  beforeEach(() => {
    vi.resetModules();
    updaterCheck.mockReset();
    relaunchApp.mockClear();
    memStore.clear();
  });

  it('does not let an overlapping check discard the update being offered', async () => {
    // THE BUG: mount, wake, the timer, and two menus could check concurrently.
    // One response offered an update; a later no-update response cleared the
    // module's handle without clearing the visible Install button. Install then
    // went back to the network and could fail while the UI still promised vX.
    let finish!: (value: any) => void;
    const update = {
      version: '9.9.9',
      body: '',
      downloadAndInstall: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    updaterCheck.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));

    const updater = await import('../src/lib/updater');
    const first = updater.checkForUpdates();
    const second = updater.checkForUpdates();
    await Promise.resolve(); // getVersion resolves before the updater check starts
    expect(updaterCheck).toHaveBeenCalledTimes(1);
    expect(updaterCheck).toHaveBeenCalledWith({ timeout: 15_000 });

    finish(update);
    await expect(first).resolves.toMatchObject({ available: true, version: '9.9.9' });
    await expect(second).resolves.toMatchObject({ available: true, version: '9.9.9' });

    await updater.installUpdate();
    expect(updaterCheck).toHaveBeenCalledTimes(1);
    expect(update.downloadAndInstall).toHaveBeenCalledTimes(1);
  });

  it('does not start two installers when Install is double-clicked', async () => {
    // React does not disable the button until its next render. Two clicks in
    // that window used the same update handle to launch two downloads.
    let finishInstall!: () => void;
    const update = {
      version: '9.9.9',
      body: '',
      downloadAndInstall: vi.fn(() => new Promise<void>((resolve) => { finishInstall = resolve; })),
      close: vi.fn(async () => {}),
    };
    updaterCheck.mockResolvedValue(update);

    const updater = await import('../src/lib/updater');
    await updater.checkForUpdates();
    const first = updater.installUpdate();
    const second = updater.installUpdate();
    const checkDuringInstall = updater.checkForUpdates();

    expect(update.downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(updaterCheck).toHaveBeenCalledTimes(1);
    await expect(checkDuringInstall).resolves.toMatchObject({ available: true, version: '9.9.9' });
    finishInstall();
    await Promise.all([first, second]);
    expect(update.downloadAndInstall).toHaveBeenCalledWith(
      expect.any(Function),
      { timeout: 5 * 60_000 }
    );
    expect(relaunchApp).toHaveBeenCalledTimes(1);
  });

  it('closes superseded native updater handles instead of leaking one every six hours', async () => {
    // THE BUG: each successful scheduled check allocated a native Tauri
    // Resource. Replacing `pendingUpdate` dropped only the JS reference; Resource
    // has no finalizer, so a week-long process leaked every superseded handle.
    const oldUpdate = {
      version: '9.9.8',
      body: '',
      downloadAndInstall: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const newUpdate = {
      version: '9.9.9',
      body: '',
      downloadAndInstall: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    updaterCheck.mockResolvedValueOnce(oldUpdate).mockResolvedValueOnce(newUpdate);
    const updater = await import('../src/lib/updater');

    await updater.checkForUpdates();
    await updater.checkForUpdates();

    expect(oldUpdate.close).toHaveBeenCalledTimes(1);
    expect(newUpdate.close).not.toHaveBeenCalled();
  });

  it('an already-running update check cannot close the handle being installed', async () => {
    // THE BUG: the single-flight guard stops a new check after Install begins,
    // but a wake/timer check can already be inside native `check()`. When that
    // call returned, it replaced `pendingUpdate` and closed the old Resource
    // even though downloadAndInstall was using that Resource's rid.
    let finishInstall!: () => void;
    let finishLateCheck!: (value: any) => void;
    const offered = {
      version: '9.9.8',
      body: '',
      downloadAndInstall: vi.fn(() => new Promise<void>(resolve => { finishInstall = resolve; })),
      close: vi.fn(async () => {}),
    };
    const redundant = {
      version: '9.9.9',
      body: '',
      downloadAndInstall: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    updaterCheck
      .mockResolvedValueOnce(offered)
      .mockImplementationOnce(() => new Promise(resolve => { finishLateCheck = resolve; }));

    const updater = await import('../src/lib/updater');
    await updater.checkForUpdates();
    const lateCheck = updater.checkForUpdates();
    await vi.waitFor(() => expect(updaterCheck).toHaveBeenCalledTimes(2));

    const install = updater.installUpdate();
    await vi.waitFor(() => expect(offered.downloadAndInstall).toHaveBeenCalledTimes(1));
    finishLateCheck(redundant);
    await expect(lateCheck).resolves.toMatchObject({ available: true, version: '9.9.8' });

    expect(offered.close).not.toHaveBeenCalled();
    expect(redundant.close).toHaveBeenCalledTimes(1);
    finishInstall();
    await install;
    expect(offered.close).toHaveBeenCalledTimes(1);
  });

  it('a failed updater install leaves copyable evidence after the notice would have expired', async () => {
    // THE BUG: App logged the native error to a developer console, showed a
    // generic message for eight seconds, then discarded it. A family user who
    // cannot reproduce a stale-build failure had nothing concrete to report.
    const update = {
      version: '0.5.30',
      body: '',
      downloadAndInstall: vi.fn(async () => {
        throw new Error('failed to replace bundle: operation not permitted');
      }),
      close: vi.fn(async () => {}),
    };
    updaterCheck.mockResolvedValue(update);
    const updater = await import('../src/lib/updater');

    await updater.checkForUpdates();
    let thrown: unknown;
    try {
      await updater.installUpdate();
    } catch (error) {
      thrown = error;
    }

    const evidence = updater.updateFailureEvidence(thrown);
    expect(evidence).toMatchObject({
      phase: 'downloading',
      currentVersion: '0.0.0-test',
      targetVersion: '0.5.30',
      error: 'failed to replace bundle: operation not permitted',
    });
    expect(evidence?.id).toMatch(/^UPD-DOWNLOADING-/);
    expect(updater.loadUpdateFailureEvidence()).toEqual(evidence);
    vi.resetModules();
    const afterRestart = await import('../src/lib/updater');
    expect(afterRestart.loadUpdateFailureEvidence()).toEqual(evidence);
    expect(updater.formatUpdateFailureEvidence(evidence!)).toContain(
      'Version: 0.0.0-test -> 0.5.30'
    );
    expect(updater.formatUpdateFailureEvidence(evidence!)).toContain(
      'Error: failed to replace bundle: operation not permitted'
    );
  });
});

describe('the DM cache never invents a conversation', () => {
  beforeEach(() => {
    vi.resetModules();
    memStore.clear();
  });

  const message = (id: string, from: string, to: string) => ({
    id,
    from,
    to,
    content: `private message ${id}`,
    timestamp: '2026-07-31T12:00:00.000Z',
    status: 'sent' as const,
  });

  it('underscores in handles cannot put one persons DMs in another thread', async () => {
    // THE BUG: cache keys joined sorted handles with `_`. The distinct pairs
    // a_b/c and a/b_c both became `vibe_thread_a_b_c`, so opening the second
    // thread after a restart rendered the first thread's private messages.
    const cache = await import('../src/lib/messageCache');
    cache.setCachedMessages('a_b', 'c', [message('first', 'a_b', 'c')]);
    cache.setCachedMessages('a', 'b_c', [message('second', 'a', 'b_c')]);

    expect(cache.getCachedMessages('a_b', 'c').map(m => m.id)).toEqual(['first']);
    expect(cache.getCachedMessages('a', 'b_c').map(m => m.id)).toEqual(['second']);
  });

  it('malformed cached JSON cannot become a message object in the renderer', async () => {
    // THE BUG: valid JSON was cast straight to VibeMessage[]. An object, or an
    // array entry with no string id, reached DMPanel where `.startsWith()`
    // crashed the entire conversation view.
    const cache = await import('../src/lib/messageCache');
    cache.setCachedMessages('me', 'alice', [message('valid', 'alice', 'me')]);
    const key = [...memStore.keys()].find(k => k.startsWith('vibe_thread_v2_'))!;
    memStore.set(key, JSON.stringify([
      message('still-valid', 'alice', 'me'),
      message('wrong-thread', 'mallory', 'me'),
      { id: null, from: 'alice', content: 'broken' },
    ]));

    expect(cache.getCachedMessages('me', 'alice').map(m => m.id)).toEqual(['still-valid']);
    memStore.set(key, JSON.stringify({ messages: [] }));
    expect(cache.getCachedMessages('me', 'alice')).toEqual([]);
  });

  it('a week of new conversations cannot grow the message cache without bound', async () => {
    // THE BUG: each thread was capped at 100 messages, but the number of
    // thread keys had no cap. Every new correspondent permanently consumed
    // another localStorage bucket until writes began failing silently.
    const cache = await import('../src/lib/messageCache');
    for (let i = 0; i < 51; i += 1) {
      cache.setCachedMessages('me', `person_${i}`, [message(String(i), 'me', `person_${i}`)]);
    }

    expect(cache.getCachedMessages('me', 'person_0')).toEqual([]);
    expect(cache.getCachedMessages('me', 'person_50').map(m => m.id)).toEqual(['50']);
    expect([...memStore.keys()].filter(k => k.startsWith('vibe_thread_v2_'))).toHaveLength(50);
  });
});

describe('a stuck local context scan stays single-flight', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    tauriInvoke.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not spawn another SQLite scan on every heartbeat after the deadline', async () => {
    // THE BUG: Promise timeout rejected only the JS wrapper; Rust's
    // spawn_blocking scan kept running. With no cached DNA, every five-minute
    // heartbeat launched another scan of the same 32GB database — thousands
    // of orphaned workers over the week this app is designed to stay open.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    tauriInvoke.mockImplementation(() => new Promise(() => {}));
    try {
      const { getCodingDNA } = await import('../src/lib/contextExtractor');

      const first = getCodingDNA();
      await vi.advanceTimersByTimeAsync(4000);
      await expect(first).resolves.toBeNull();

      // The original native invocation is still unresolved. A later heartbeat
      // must use its stale/null fallback immediately, without spawning another.
      await expect(getCodingDNA()).resolves.toBeNull();
      expect(tauriInvoke).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('clipboard feedback says what actually happened', () => {
  it('does not report success when WKWebView rejects the write', async () => {
    // THE BUG: both Copy Path and Copy Invite caught a rejected clipboard
    // promise and flashed "Copied!" anyway. The user pasted stale clipboard
    // contents and had no reason to suspect Buddy had learned nothing.
    const previousNavigator = globalThis.navigator;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { clipboard: { writeText: vi.fn(async () => { throw new Error('denied'); }) } },
    });
    try {
      const { copyText } = await import('../src/lib/clipboard');
      await expect(copyText('https://example.test/invite')).resolves.toBe(false);
    } finally {
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: previousNavigator,
      });
    }
  });
});

describe('call handoff is single-flight', () => {
  beforeEach(() => {
    vi.resetModules();
    tauriInvoke.mockReset();
  });

  it('does not spawn two Vibeconferencing bridges for two clicks', async () => {
    // THE BUG: "starting…" only changed text; the session-row span was still
    // clickable, and reopening the account menu exposed the same live handler.
    // Two clicks spawned two Node bridges and could mint two Meet rooms.
    let finish!: (value: any) => void;
    tauriInvoke.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const { startCall } = await import('../src/lib/vibeconf');

    const first = startCall();
    const second = startCall();
    expect(tauriInvoke).toHaveBeenCalledTimes(1);

    finish({ url: 'https://meet.google.com/abc-defg-hij', code: 'abc-defg-hij' });
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });
});

describe('event-driven roster refreshes are single-flight', () => {
  it('does not let mount, focus, SSE, or timer triggers overlap', async () => {
    // THE BUG: guardedInterval guarded only callbacks originating from its own
    // timer. App's initial fetch plus focus, visibility, SSE, and wake handlers
    // all called the raw function, so a slow old response could still land
    // after a newer response and overwrite the roster it was meant to protect.
    const { singleFlight } = await import('../src/lib/singleFlight');
    let finish!: () => void;
    const work = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const refresh = singleFlight(work);

    const mount = refresh();
    const focus = refresh();
    const sse = refresh();
    expect(work).toHaveBeenCalledTimes(1);

    finish();
    await Promise.all([mount, focus, sse]);
    const next = refresh();
    expect(work).toHaveBeenCalledTimes(2);
    finish();
    await next;
  });
});

describe('going invisible wins the presence race', () => {
  beforeEach(() => { vi.resetModules(); });

  it('an in-flight heartbeat cannot relight the dot after Invisible', async () => {
    // THE BUG: toggling Invisible (and manual sign-out) fired goOffline while an
    // existing heartbeat could still be pending. If offline landed first, the
    // old heartbeat landed second and immediately relit the user's green dot
    // while their own UI confidently said presence was paused.
    const { buddyClient } = await import('../src/lib/vibeClient');
    const client = buddyClient as any;
    client.handle = 'me';
    client.authToken = 'token';
    client.loggingOut = false;
    let finishHeartbeat!: () => void;
    const writes: string[] = [];
    client.authenticatedRequest = vi.fn((options: any) => {
      if (options.body?.action !== 'offline') {
        writes.push('heartbeat-started');
        return new Promise((resolve) => {
          finishHeartbeat = () => {
            writes.push('heartbeat-landed');
            resolve({ ok: true, data: {}, status: 200 });
          };
        });
      }
      writes.push('offline-landed');
      return Promise.resolve({ ok: true, data: {}, status: 200 });
    });

    const heartbeat = client.updatePresence();
    const offline = client.goOffline();
    await Promise.resolve();
    await Promise.resolve(); // cached app-version lookup completes first
    expect(writes).toEqual(['heartbeat-started']);

    finishHeartbeat();
    await Promise.all([heartbeat, offline]);
    expect(writes).toEqual(['heartbeat-started', 'heartbeat-landed', 'offline-landed']);
  });
});

describe('deleted call stack permissions', () => {
  it('does not ship camera and microphone declarations for removed calls', async () => {
    // THE BUG: removing every audio/video call path left privacy declarations
    // in the shipped bundle that still claimed Buddy records camera and mic.
    const { readFileSync } = await import('node:fs');
    const plist = readFileSync(
      new URL('../src-tauri/Info.plist', import.meta.url),
      'utf8',
    );

    expect(plist).not.toContain('NSMicrophoneUsageDescription');
    expect(plist).not.toContain('NSCameraUsageDescription');
  });
});

describe('storage failures fail closed for presence privacy', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it('a corrupted Invisible preference cannot silently resume broadcasting', async () => {
    // THE BUG: JSON parse failure returned the first-launch default
    // `sharing:true`. A truncated localStorage value therefore converted an
    // unknown prior choice into a confident public heartbeat.
    localStorage.setItem('buddy_presence_prefs', '{"sharing":');
    const { getPresencePrefs } = await import('../src/lib/presencePrefs');

    expect(getPresencePrefs()).toMatchObject({ sharing: false, detail: 'minimal' });
  });
});

describe('background pair state survives failed enrichment reads', () => {
  beforeEach(() => {
    vi.resetModules();
    tauriInvoke.mockReset();
  });

  it('a failed pair poll cannot announce that an existing pair ended', async () => {
    // THE BUG: every failed 30-second poll returned {paired:false}. App
    // committed it, stopped the live session, and tore down guest polling even
    // though the server had said nothing about the pair ending.
    const { buddyClient } = await import('../src/lib/vibeClient');
    const client = buddyClient as any;
    client.handle = 'me';
    client.authToken = 'token';
    client.authenticatedRequest = vi.fn(async () => ({ ok: false, data: null }));

    await expect(client.getPairStatusResult()).resolves.toEqual({
      status: { paired: false },
      error: true,
    });
  });

  it('there is no way to read raw conversation turns at all', async () => {
    // STRONGER THAN THE TEST IT REPLACES. That one proved a failed turn read
    // reported itself honestly instead of collapsing to []. This one proves
    // the read cannot happen: kill switch 0c (2026-08-09) stopped Buddy
    // SENDING turns, but left the reader registered, so the
    // transcript-privacy promise held only because no caller invoked it.
    // The capability is now absent, not merely unused (2026-08-15).
    const mod = await import('../src/lib/contextExtractor');
    expect('getRecentTurnsResult' in mod).toBe(false);
    expect('getRecentTurns' in mod).toBe(false);

    // The Tauri command is gone and unregistered, so the webview cannot reach
    // raw turns even by invoking it directly.
    const mainRs = readFileSync(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
    expect(mainRs).not.toMatch(/fn extract_recent_turns/);
    expect(mainRs).not.toMatch(/^\s*extract_recent_turns,/m);

    // The reader is gone entirely — struct, query core and its tests. Keeping
    // them private-but-test-pinned was the first instinct; the compiler called
    // it dead code, and dead code rots.
    const ctx = readFileSync(new URL('../src-tauri/src/context_extractor.rs', import.meta.url), 'utf8');
    expect(ctx).not.toMatch(/extract_recent_turns\(/);
    expect(ctx).not.toMatch(/fn recent_turns_from/);
    expect(ctx).not.toMatch(/struct SessionTurn/);
    // What remains reads structure for CodingDNA, not conversation text.
    expect(ctx).toMatch(/pub struct CodingDNA/);
  });

});

describe('optional call availability never disappears on an IPC error', () => {
  beforeEach(() => {
    vi.resetModules();
    tauriInvoke.mockReset();
  });

  it('a failed availability check is not rendered as Vibeconferencing absent', async () => {
    // THE BUG: invoke rejection returned false, exactly like a clean health
    // result saying the app was absent. Every call affordance silently vanished.
    tauriInvoke.mockRejectedValueOnce(new Error('IPC unavailable'));
    const { vibeconfAvailability } = await import('../src/lib/vibeconf');

    await expect(vibeconfAvailability()).resolves.toEqual({ available: false, error: true });
  });
});

describe('doorbell progress always terminates with evidence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-31T12:00:00Z'));
    vi.resetModules();
    httpFetch.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    httpFetch.mockReset();
    httpFetch.mockImplementation(async () => ({
      ok: presencePayload.ok,
      status: presencePayload.ok ? 200 : 500,
      json: async () => presencePayload.value,
      text: async () => JSON.stringify(presencePayload.value),
    }));
  });

  it('a network request that never returns cannot leave Ringing on screen forever', async () => {
    // THE BUG: the direct plugin fetch had no deadline. `summonBusy` was only
    // cleared after it returned, so one stalled socket left Ringing… disabled
    // forever and made the operation look perpetually in progress.
    httpFetch.mockImplementationOnce((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })
    );
    const { buddyClient } = await import('../src/lib/vibeClient');
    const client = buddyClient as any;
    client.handle = 'me';
    client.authToken = 'token';
    const { summonAgent } = await import('../src/lib/doorbell');

    const result = summonAgent({
      agent: 'alice',
      meetUrl: 'https://meet.google.com/abc-defg-hij',
      purpose: 'debug together',
    });
    await vi.advanceTimersByTimeAsync(15_000);

    await expect(result).resolves.toEqual({ rung: false, error: 'could not reach the doorbell' });
  });

  it('a malformed successful probe cannot erase a visible doorbell roster', async () => {
    // THE BUG: a 200 with the wrong envelope defaulted summonable to [], so a
    // bad deploy silently removed every quick-dial as if the grant list were
    // authoritatively empty.
    httpFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ summonable: [{ agent: 'alice' }] }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ error: 'upstream unavailable' }),
      } as Response);
    const { buddyClient } = await import('../src/lib/vibeClient');
    const client = buddyClient as any;
    client.handle = 'me';
    client.authToken = 'token';
    const { getSummonable } = await import('../src/lib/doorbell');

    await expect(getSummonable()).resolves.toEqual([{ agent: 'alice' }]);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);
    await expect(getSummonable()).resolves.toEqual([{ agent: 'alice' }]);
  });
});

describe('presence asks for the data it renders', () => {
  beforeEach(() => { vi.resetModules(); presencePayload.ok = true; });

  it('requests the recent bucket explicitly', async () => {
    // v2 omits `recent` unless ?include=recent is passed. Buddy mapped that
    // field without asking for it, so the empty-room traces rendered nothing at
    // all — a shipped feature that could never work. Testing by hand against v1
    // (which returns recent by default) is what hid it.
    presencePayload.value = { active: [], away: [], agents: [], sessions: [] };
    httpFetch.mockClear();
    const mod = await import('../src/lib/vibeClient');
    await (mod.buddyClient as any).getOnlineUsers();

    const url = String(httpFetch.mock.calls[0]?.[0] ?? '');
    expect(url).toContain('include=recent');
  });
});

describe('presence metadata cannot become confident fiction', () => {
  beforeEach(() => {
    vi.resetModules();
    presencePayload.ok = true;
  });

  const user = (extra: Record<string, unknown> = {}) => ({
    handle: 'alice',
    oneLiner: 'Online via Buddy',
    status: 'active' as const,
    // Inference expires with presence evidence (audit #4): without a fresh
    // lastSeen no guess renders at all, so every fixture that expects an
    // inference carries one.
    lastSeen: new Date().toISOString(),
    ...extra,
  });

  it('an inference dies with its presence evidence — no guess over a stale heartbeat (audit #4)', async () => {
    const { inferState } = await import('../src/lib/intelligence');
    const stale = new Date(Date.now() - 11 * 60_000).toISOString();
    expect(inferState(user({ clientMetadata: { phase: 'debugging' } }) as any)?.state).toBe('debugging');
    expect(inferState(user({ lastSeen: stale, clientMetadata: { phase: 'debugging' } }) as any)).toBeNull();
    expect(inferState(user({ lastSeen: undefined, clientMetadata: { phase: 'debugging' } }) as any)).toBeNull();
  });

  it('a guess is said to be a guess; a self-report is attributed (audit #4, ruled 2026-08-13)', async () => {
    const { inferState, inferredPhrase, inferredEvidence } = await import('../src/lib/intelligence');
    const guessed = inferState(user({ clientMetadata: { branch: 'fix/login-loop' } }) as any)!;
    expect(guessed.kind).toBe('inferred');
    expect(inferredPhrase(guessed)).toBe('looks like debugging');
    expect(inferredEvidence(guessed)).toBe('a guess from: on fix/login-loop');
    const said = inferState(user({ mood: 'shipping', moodInferred: false }) as any)!;
    expect(said.kind).toBe('self-report');
    expect(inferredPhrase(said)).toBe("says they're shipping");
    // The LIBRARY still distinguishes a guess from a self-report, and these
    // assertions still guard that distinction. What changed 2026-08-15 is
    // that no component renders it any more: smartStatus was the only caller
    // and is deleted, so nothing in the UI states an inferred state at all.
    const sharedSrc = readFileSync(new URL('../src/components/list/shared.tsx', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(sharedSrc).not.toMatch(/smartStatus|inferredPhrase/);
  });

  it('serendipity and proactive lines carry their register: reported facts say "report", guesses say "looks like"', async () => {
    const src = readFileSync(new URL('../src/lib/intelligence.ts', import.meta.url), 'utf8');
    // Self-broadcast facts are attributed, not asserted.
    expect(src).toContain('both report working on');
    expect(src).toContain('both report using');
    expect(src).toContain('reports a 3+ hour session');
    // Heuristic conclusions are labeled as guesses.
    expect(src).toContain('Looks like @${user.handle} started shipping');
    expect(src).toContain('Looks like @${other.handle} is shipping');
    // No line renders an inferred state as bare fact.
    expect(src).not.toContain('has been in flow for');
    // DMPanel's starters and shared-context speak the same register
    // (codex P2 r1: "every surface" must include the DM ones).
    expect(src).toMatch(/Looks like they\\?'re deploying/);
    expect(src).toMatch(/Looks like they\\?'re working through an issue/);
    expect(src).toContain('Both report:');
    expect(src).not.toContain('Both working on:');
    expect(src).not.toMatch(/They\\?'re actively deploying/);
  });

  it('Buddy infers nothing about people at all (ruthless pass 2026-08-15)', () => {
    // This used to pin that inferred "moments" expired with the heartbeat
    // they rode in on. They no longer exist: serendipity and proactive
    // moments read presence metadata and asserted things ABOUT PEOPLE —
    // local inference, which the platform law forbids clients from doing,
    // and the seed of a feed. Absence beats expiry.
    // The first version of this test searched ONE file for TWO identifiers
    // and declared the surface gone, while getSharedContext,
    // getConversationStarters, collaborationScore and inferState were all
    // still live (codex P2). A guard whose promise exceeds its reach is
    // worse than no guard: it retires the vigilance without doing the work.
    const list = readFileSync(new URL('../src/components/UnifiedBuddyList.tsx', import.meta.url), 'utf8');
    const rows = readFileSync(new URL('../src/components/list/rows.tsx', import.meta.url), 'utf8');
    const dm = readFileSync(new URL('../src/components/DMPanel.tsx', import.meta.url), 'utf8');
    const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    const shared = readFileSync(new URL('../src/components/list/shared.tsx', import.meta.url), 'utf8');
    // shared.tsx is where smartStatus lives and calls inferState — excluded
    // from the first guard, which is how the call chain survived (codex P3).
    for (const [name, src] of [['list', list], ['rows', rows], ['dm', dm], ['shared-callers', shared]] as const) {
      const code = strip(src);
      for (const surface of [
        /findSerendipity/,          // "you and @x are both on vibeconf"
        /detectProactiveMoments/,   // nudges derived from presence metadata
        /serendipityMap|isSerendipitous/,
        /getSharedContext/,         // an inferred banner about a person
        /getConversationStarters/,  // suggested things to SAY to them
        /collaborationScore/,       // ranking PEOPLE by inferred affinity
        /inferState\(/,             // a guessed state on the row
        /getDMContext/,             // the DM header's inferred emoji + status
      ]) expect(code, `${name} still carries ${surface}`).not.toMatch(surface);
    }
  });

  it('being checked out on main cannot be rendered as actively shipping', async () => {
    // THE BUG: a branch name was treated as evidence of an operation. A user
    // who had done nothing except leave a checkout on main got a flame and the
    // present-tense label "shipping" indefinitely.
    const { inferState } = await import('../src/lib/intelligence');
    expect(inferState(user({ clientMetadata: { branch: 'main' } }))).toBeNull();
  });

  it('the viewers timezone cannot label another person late night', async () => {
    // THE BUG: inference read `new Date().getHours()` in the viewer's process,
    // so Phoenix at 2am labeled a London user "late night" at 10am.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 31, 2, 0, 0));
    try {
      const { inferState } = await import('../src/lib/intelligence');
      expect(inferState(user())).toBeNull();
      expect(inferState(user({ clientMetadata: { phase: 'late-night' } }))?.state).toBe('late-night');
    } finally {
      vi.useRealTimers();
    }
  });

  it('stale away metadata cannot describe work as happening now', async () => {
    // THE BUG: an away heartbeat retained its old phase and session duration,
    // and inference continued to render "shipping" or "deep focus" in the
    // present tense after the source had stopped reporting.
    const { inferState } = await import('../src/lib/intelligence');
    expect(inferState(user({
      status: 'away',
      clientMetadata: { phase: 'shipping', session_minutes: 300 },
    }) as any)).toBeNull();
  });

  it('malformed optional metadata cannot crash the status renderer', async () => {
    // THE BUG: presence is network input, but branch was called with
    // `.toLowerCase()` and tech_stack with `.filter()`/`.join()` without type
    // checks. One malformed optional field blanked the entire buddy view.
    presencePayload.value = {
      active: [{
        handle: 'alice',
        workingOn: { text: 'not a string' },
        sources: 'buddy',
        isLive: 'false',
        reachability: 'probably',
        clientMetadata: {
          branch: 42,
          phase: ['shipping'],
          tech_stack: 'typescript',
          session_minutes: '180',
          recent_topics: [null, 'presence'],
        },
      }],
      away: [], agents: [], sessions: [],
    };
    const { buddyClient } = await import('../src/lib/vibeClient');
    const result = await buddyClient.getOnlineUsers();
    const { inferState, getDMContext, findSerendipity } = await import('../src/lib/intelligence');

    expect(result.error).not.toBe(true);
    expect(result.users[0].clientMetadata).toEqual({ recent_topics: ['presence'] });
    // isLive left VibeUser with the LIVE corpse (take-stock Move 2, cut 1).
    expect(result.users[0].reachability).toBeUndefined();
    expect(() => inferState(result.users[0])).not.toThrow();
    expect(() => getDMContext(result.users[0])).not.toThrow();
    expect(() => findSerendipity('me', [user({ handle: 'me' }), result.users[0]])).not.toThrow();
  });

  it('a future or invalid first-seen timestamp cannot trigger a welcome', async () => {
    // THE BUG: negative ages satisfy `< 48`, so clock skew or a future server
    // timestamp confidently called an established person "new here".
    const { getConversationStarters } = await import('../src/lib/intelligence');
    const starters = getConversationStarters(
      user({ handle: 'me' }),
      user({ firstSeen: '2999-01-01T00:00:00Z' }),
      []
    );
    expect(starters.some(starter => starter.reason === "They're new here")).toBe(false);
  });
});

describe('network booleans do not manufacture authoritative state', () => {
  beforeEach(() => {
    vi.resetModules();
    httpFetch.mockClear();
  });

  it('a network failure during saved-login recovery cannot be rendered as session expiry', async () => {
    // THE BUG: quickAuth returned the same false for a real rejection and a
    // transport failure. App translated both into "Your session expired", so
    // opening Buddy offline made a confident claim it had not established.
    httpFetch.mockRejectedValueOnce(new Error('network unavailable'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { buddyClient } = await import('../src/lib/vibeClient');
      await expect(buddyClient.quickAuthResult('alice')).resolves.toEqual({
        authenticated: false,
        error: true,
      });
    } finally {
      warn.mockRestore();
    }
  });

  it('a failed login launch cannot leave Waiting for browser on screen', async () => {
    // THE BUG: the click handler set loggingIn and fire-and-forgot login(). If
    // start_login or shell-open failed immediately, the returned false was
    // ignored and the UI claimed it was waiting on a browser for 90 seconds.
    tauriInvoke.mockRejectedValueOnce(new Error('could not start callback server'));
    const { buddyClient } = await import('../src/lib/vibeClient');
    await expect(buddyClient.login()).resolves.toMatchObject({ success: false });

    // Pin the caller wiring too: this result only matters if App awaits it and
    // terminates the progress state.
    const { readFileSync } = await import('node:fs');
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    expect(app).toContain('const result = await buddyClient.login()');
    expect(app).toContain("setAuthFailure('login')");
    expect(app).toContain('setLoggingIn(false)');
  });

  it('a failed live-session refresh cannot say the other person stopped sharing', async () => {
    // THE BUG: every HTTP/transport failure became `{sharing:false}`.
    // SessionPanel committed that as truth and told the viewer the other
    // person was no longer sharing, replacing a last-good live transcript.
    const { buddyClient } = await import('../src/lib/vibeClient');
    const client = buddyClient as any;
    client.handle = 'me';
    client.authToken = 'token';
    client.authenticatedRequest = vi.fn(async () => ({ ok: false, data: null }));

    await expect(client.getLiveSessionResult('alice')).resolves.toEqual({
      session: null,
      error: true,
    });

    client.authenticatedRequest = vi.fn(async () => ({
      ok: true,
      data: { sharing: false },
    }));
    await expect(client.getLiveSessionResult('alice')).resolves.toEqual({
      session: { sharing: false },
      error: false,
    });
  });
});

describe('replying from the notification banner', () => {
  beforeEach(() => {
    sent.length = 0;
    osPermissionGranted.value = true;
    localStorage.clear();
    vi.resetModules();
  });

  it('tags DM notifications with the reply action type', async () => {
    // Without actionTypeId macOS shows no text field, and the whole point of
    // the feature — answering without the app becoming foreground — is lost.
    const n = await import('../src/lib/notifications');
    await n.hasNotificationPermission();

    n.checkAndNotify([thread('alice', 0)]);
    n.checkAndNotify([thread('alice', 1)]);

    expect(sent).toHaveLength(1);
    expect((sent[0] as any).actionTypeId).toBe(n.DM_ACTION_TYPE);
  });

  it('does not tag arrival notifications — there is nothing to reply to', async () => {
    const n = await import('../src/lib/notifications');
    await n.hasNotificationPermission();

    await n.notifyArrivals([{ handle: 'alice', status: 'away' }], [thread('alice', 0)]);
    await n.notifyArrivals([{ handle: 'alice', status: 'active' }], [thread('alice', 0)]);

    expect(sent).toHaveLength(1);
    expect((sent[0] as any).actionTypeId).toBeUndefined();
  });
});

describe('the call you started is not lost when the toast closes', () => {
  beforeEach(() => { localStorage.clear(); vi.resetModules(); });

  it('remembers the link so it can be shared again', async () => {
    // Minting a call, closing the toast and having no way back to the link is a
    // bad trade for a gesture whose whole point is bringing someone else in.
    const m = await import('../src/lib/callMemory');
    m.rememberCall({ url: 'https://meet.google.com/abc-defg-hij', code: 'abc-defg-hij', from: 'platform' });

    const got = m.getRememberedCall();
    expect(got?.url).toBe('https://meet.google.com/abc-defg-hij');
    expect(got?.from).toBe('platform');
  });

  it('forgets it once it is only clutter', async () => {
    const m = await import('../src/lib/callMemory');
    m.rememberCall({ url: 'https://meet.google.com/abc-defg-hij', code: 'abc-defg-hij' });

    const later = Date.now() + m.CALL_MEMORY_TTL_MS + 1000;
    expect(m.getRememberedCall(later)).toBeNull();
  });

  it('refuses a malformed record rather than offering a broken link', async () => {
    // A half-written or hand-edited record must not put a broken link in front
    // of someone who is about to paste it to another person.
    localStorage.setItem('buddy_last_call', JSON.stringify({ url: 42, code: null }));
    const m = await import('../src/lib/callMemory');
    expect(m.getRememberedCall()).toBeNull();
  });

  it('survives storage containing nonsense', async () => {
    localStorage.setItem('buddy_last_call', 'not json at all');
    const m = await import('../src/lib/callMemory');
    expect(m.getRememberedCall()).toBeNull();
  });
});

// A refreshed token that lives only in memory.
//
// quickAuthResult() minted a new JWT and assigned it to this.authToken, but
// nothing wrote it back to ~/.vibe/auth.json. check_auth (Rust) correctly
// refuses a stored token past exp — so once the ORIGINAL sign-in token expired,
// every restart showed the sign-in screen even though a valid session had been
// in hand seconds earlier.
//
// It hit invited users hardest, which is exactly backwards: whitelisted alpha
// handles could always re-mint via buddy-token, so the people testing it were
// the only ones who never saw it.
describe('refreshed tokens survive a restart', () => {
  beforeEach(() => {
    tauriInvoke.mockClear();
    presencePayload.ok = true;
  });

  const respondWithToken = (token: string, handle = 'friend') => {
    httpFetch.mockImplementationOnce(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ token, handle }),
      text: async () => '',
    }) as any);
  };

  it('persists the refreshed token through the tauri command', async () => {
    const { buddyClient } = await import('../src/lib/vibeClient');
    respondWithToken('fresh.jwt.token');

    const result = await (buddyClient as any).quickAuthResult('friend');

    expect(result.authenticated).toBe(true);
    const saved = tauriInvoke.mock.calls.find((c: any[]) => c[0] === 'save_auth_token');
    expect(saved, 'a successful refresh must write the token to disk').toBeTruthy();
    expect((saved as any[])[1]).toMatchObject({ token: 'fresh.jwt.token', handle: 'friend' });
  });

  it('does not persist anything when the refresh fails', async () => {
    const { buddyClient } = await import('../src/lib/vibeClient');
    httpFetch.mockImplementationOnce(async () => ({
      ok: false, status: 401, json: async () => ({}), text: async () => '',
    }) as any);

    await (buddyClient as any).quickAuthResult('friend');

    const saved = tauriInvoke.mock.calls.find((c: any[]) => c[0] === 'save_auth_token');
    expect(saved, 'a failed refresh must not overwrite a good stored token').toBeFalsy();
  });

  // Losing the disk write is bad; losing the session is worse. A storage
  // failure must leave the user signed in for this run.
  it('keeps the session when persistence fails', async () => {
    const { buddyClient } = await import('../src/lib/vibeClient');
    respondWithToken('fresh.jwt.token');
    tauriInvoke.mockImplementationOnce(async () => { throw new Error('disk full'); });

    const result = await (buddyClient as any).quickAuthResult('friend');

    expect(result.authenticated).toBe(true);
    expect(result.error).toBe(false);
    expect((buddyClient as any).getAuthToken()).toBe('fresh.jwt.token');
  });

  // The server is allowed to correct the handle; the credential on disk has to
  // follow, or presence and identity drift apart.
  it('persists the handle the server returned, not the one requested', async () => {
    const { buddyClient } = await import('../src/lib/vibeClient');
    respondWithToken('fresh.jwt.token', 'canonical-handle');

    await (buddyClient as any).quickAuthResult('requested-handle');

    const saved = tauriInvoke.mock.calls.find((c: any[]) => c[0] === 'save_auth_token');
    expect((saved as any[])[1]).toMatchObject({ handle: 'canonical-handle' });
  });
});

// The buddy list must present a credential.
//
// The roster read went out as a bare fetch with no Authorization header, which
// worked only because /v2/presence answered anonymously. Platform PR #141 closed
// five unauthenticated presence endpoints — correctly, since "is @alice online"
// for any handle a stranger can type is a real leak — and this request began
// taking a hard 401 on every poll. The buddy list is the screen Buddy exists to
// draw.
describe('the roster read is authenticated', () => {
  beforeEach(() => { presencePayload.ok = true; httpFetch.mockClear(); });

  it('sends a Bearer token with the presence request', async () => {
    const { buddyClient } = await import('../src/lib/vibeClient');
    (buddyClient as any).authToken = 'test.jwt.token';
    (buddyClient as any).handle = 'friend';
    presencePayload.value = { active: [], away: [], agents: [], sessions: [] };

    await (buddyClient as any).getOnlineUsers();

    const call = httpFetch.mock.calls.find((c: any[]) => String(c[0]).includes('/v2/presence'));
    expect(call, 'the roster must be fetched').toBeTruthy();
    const init: any = (call as any[])[1] || {};
    expect(
      init.headers?.Authorization,
      'the roster read must carry a credential — #141 closed the anonymous path',
    ).toBe('Bearer test.jwt.token');
  });

  // The distinction that matters: a room with nobody in it, versus not being
  // able to ask. Collapsing the second into the first is this codebase's
  // characteristic defect.
  it('reports an error rather than an empty room when the request fails', async () => {
    const { buddyClient } = await import('../src/lib/vibeClient');
    (buddyClient as any).authToken = 'test.jwt.token';
    (buddyClient as any).handle = 'friend';
    httpFetch.mockImplementationOnce(async () => ({
      ok: false, status: 500, json: async () => ({}), text: async () => '',
    }) as any);

    const result = await (buddyClient as any).getOnlineUsers();

    expect(result.error, 'a failed roster read must not render as an empty room').toBe(true);
    expect(result.users).toEqual([]);
  });
});

// A gated capability must never look like a removed one.
//
// The Call affordance is offered only when the Vibeconferencing app answers a
// health probe on this Mac. When it did not, Buddy rendered NOTHING — so "vibeconf
// is closed", "we could not ask", and "this feature no longer exists" were the
// same pixels. That is not theoretical: the report that produced this test was
// "what happened to being able to launch a vibeconf from one of my sessions?"
// Nothing had happened. The app was closed and Buddy said so with empty space.
// The list surface split into a family (take-stock Move 2): structural
// guards over "the list's source" now read every member, so moved code
// stays guarded instead of silently escaping the scrape.
const listFamilySrc = () => {
  const dir = new URL('../src/components/list/', import.meta.url);
  const parts = [
    readFileSync(new URL('../src/components/UnifiedBuddyList.tsx', import.meta.url), 'utf8'),
  ];
  for (const f of readdirSync(dir)) {
    parts.push(readFileSync(new URL(`../src/components/list/${f}`, import.meta.url), 'utf8'));
  }
  return parts.join('\n');
};

describe('an unavailable call affordance explains itself', () => {
  const source = () => listFamilySrc();
  const dmSource = () =>
    readFileSync(new URL('../src/components/DMPanel.tsx', import.meta.url), 'utf8');

  it('distinguishes "closed" from "could not ask" in both surfaces', () => {
    for (const [name, src] of [['UnifiedBuddyList', source()], ['DMPanel', dmSource()]] as const) {
      expect(src, `${name} must model a closed vibeconf distinctly`).toMatch(/'closed'/);
      expect(src, `${name} must model an unknown probe distinctly`).toMatch(/'unknown'/);
    }
  });

  it('renders copy for the closed case, naming the fix', () => {
    // ROOM TONE: errors name the fix in the same sentence as the problem.
    expect(source()).toMatch(/open vibeconf to call/);
    expect(dmSource()).toMatch(/open vibeconf to invite/);
  });

  it('never gates the affordance on a bare boolean that hides all failure modes', () => {
    // The old shape: `const [canCall, setCanCall] = useState(false)` with the
    // unavailable branch rendering nothing. Deriving canCall from the probe is
    // what keeps the three states separable.
    expect(source()).toMatch(/const canCall = callProbe === 'ready'/);
    expect(dmSource()).toMatch(/const canInvite = inviteProbe === 'ready'/);
  });
});

// Sessions can be somebody.
//
// A session row was a path and a heartbeat — accurate and impersonal. vibeconf
// already solved naming for calls via BOT.md in the project directory, and Buddy
// knows the cwd of every LOCAL session, so it reads the same file rather than
// inventing a second identity format.
describe('botfile identity for local sessions', () => {
  beforeEach(async () => {
    const { clearBotfileCache } = await import('../src/lib/botfile');
    clearBotfileCache();
    tauriInvoke.mockClear();
  });

  it('falls back to the project name when there is no BOT.md', async () => {
    const { sessionLabel } = await import('../src/lib/botfile');
    // A session without a character must look exactly as it always did.
    expect(sessionLabel(null, 'buddy')).toBe('buddy');
    expect(sessionLabel(null, undefined)).toBe('session');
  });

  it('prefers the botfile display name', async () => {
    const { sessionLabel } = await import('../src/lib/botfile');
    expect(sessionLabel({ bot: 'coltrane', display: 'COLTRANE' }, 'coltrane')).toBe('COLTRANE');
  });

  it('caches a null answer — "no botfile here" is the common case', async () => {
    const { readBotfile } = await import('../src/lib/botfile');
    tauriInvoke.mockImplementation(async () => null);

    await readBotfile('/tmp/x');
    await readBotfile('/tmp/x');

    const calls = tauriInvoke.mock.calls.filter((c: any[]) => c[0] === 'read_botfile');
    expect(calls.length, 're-statting disk to learn nothing is the expensive answer').toBe(1);
  });

  // The distinction that matters: an IPC blip is not evidence the session has no
  // character. Caching it would turn one failure into a minute of anonymity.
  it('does not cache an IPC failure', async () => {
    const { readBotfile } = await import('../src/lib/botfile');
    tauriInvoke.mockImplementation(async () => { throw new Error('ipc down'); });

    expect(await readBotfile('/tmp/y')).toBe(null);
    tauriInvoke.mockImplementation(async () => ({ bot: 'sal', display: 'SAL' }));
    const second = await readBotfile('/tmp/y');

    expect(second?.display, 'a recovered IPC must be able to name the session').toBe('SAL');
  });

  it('re-reads when the cache expires', async () => {
    const { readBotfile } = await import('../src/lib/botfile');
    tauriInvoke.mockImplementation(async () => ({ bot: 'a', display: 'A' }));
    await readBotfile('/tmp/z', 0);
    await readBotfile('/tmp/z', 120_000);
    const calls = tauriInvoke.mock.calls.filter((c: any[]) => c[0] === 'read_botfile');
    expect(calls.length).toBe(2);
  });
});

// The bot in the room is not the agent you know.
//
// Buddy mints a call and the bot walks in wearing the right name and face — but
// it has no brain until a coding session drives it, and an undriven bot shows up
// as a blank face. Reported as: "it joined the call as pepper but I don't think
// it connected to my running pepper session, so the face was a skeleton."
//
// The paste line IS the handoff. It was an 8px label on a session row that
// expired after 12 seconds, while the DURABLE notice offered the Meet URL — the
// one thing the browser had already opened for you. The important instruction
// was the transient one.
describe('the call handoff is the durable instruction', () => {
  const app = () => readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');

  it('offers the join line as the primary action on the remembered call', () => {
    const src = app();
    expect(src, 'the notice must offer /join-call').toMatch(/copy \/join-call/);
    // Primary means first — the Meet link is the consolation prize, not the point.
    const joinIdx = src.indexOf('copy /join-call');
    const linkIdx = src.indexOf("'copy link'");
    expect(joinIdx).toBeGreaterThan(-1);
    expect(linkIdx).toBeGreaterThan(-1);
    expect(joinIdx, 'the join line must come before the meet link').toBeLessThan(linkIdx);
  });

  it('says why the paste matters, not just that a call started', () => {
    // "you started a call" is a fact the user already knows. The fact they do
    // not know is that the agent is not really in the room yet.
    expect(app()).toMatch(/needs the join line pasted in/);
  });

  it('builds the join line from the remembered code', async () => {
    const { joinLine } = await import('../src/lib/vibeconf');
    expect(joinLine('abc123')).toBe('/join-call abc123');
  });
});

// "Never asked" is not "up to date".
//
// Buddy recorded install FAILURES and nothing else, so a Buddy that never checked
// was indistinguishable from one that checked and was current — both rendered as
// silence. This app sat on 0.5.37 through three releases because it was not
// running to ask, and nothing on screen could have said so.
//
// It matters most in the condition this surface exists for: when no coding
// session is running, Buddy is the only thing that can notice, and an unverified
// "you're up to date" is the one claim it must not make.
describe('an unverified "up to date" is never claimed', () => {
  beforeEach(() => localStorage.clear());

  it('treats never-having-checked as stale', async () => {
    const { updateCheckIsStale } = await import('../src/lib/updater');
    expect(updateCheckIsStale(null)).toBe(true);
  });

  it('a fresh successful check is not stale', async () => {
    const { updateCheckIsStale } = await import('../src/lib/updater');
    const now = Date.now();
    expect(updateCheckIsStale({ at: new Date(now - 60_000).toISOString(), outcome: 'current' }, now))
      .toBe(false);
  });

  it('goes stale after several missed automatic checks', async () => {
    const { updateCheckIsStale, CHECK_STALE_AFTER_MS } = await import('../src/lib/updater');
    const now = Date.now();
    const old = new Date(now - CHECK_STALE_AFTER_MS - 1000).toISOString();
    expect(updateCheckIsStale({ at: old, outcome: 'current' }, now)).toBe(true);
  });

  // An error means we could not ask. It must still be RECORDED as a completed
  // attempt (so we know when we last tried) without ever implying currency.
  it('records an error outcome distinctly from current', async () => {
    const { recordUpdateCheck, loadUpdateCheck } = await import('../src/lib/updater');
    recordUpdateCheck({ at: new Date().toISOString(), outcome: 'error' });
    expect(loadUpdateCheck()?.outcome).toBe('error');
  });

  it('round-trips a record and rejects a corrupt one', async () => {
    const { recordUpdateCheck, loadUpdateCheck } = await import('../src/lib/updater');
    recordUpdateCheck({ at: new Date().toISOString(), outcome: 'current', currentVersion: '0.5.41' });
    expect(loadUpdateCheck()?.currentVersion).toBe('0.5.41');

    localStorage.setItem('buddy_last_update_check', '{"at":"not-a-date","outcome":"current"}');
    expect(loadUpdateCheck(), 'an unparseable timestamp must not read as a real check').toBe(null);

    localStorage.setItem('buddy_last_update_check', '{"at":"2026-01-01T00:00:00Z","outcome":"lies"}');
    expect(loadUpdateCheck(), 'an unknown outcome must not be trusted').toBe(null);
  });

  // Added after a negative check showed the suite passed with the notice
  // DELETED: the logic was covered, the wiring was not. A staleness predicate
  // nothing renders is a fact nobody is told.
  it('the stale state is actually rendered, not just computed', () => {
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    expect(app, 'the notice must be driven by the predicate').toMatch(/updateCheckIsStale\(lastCheck/);
    expect(app, 'it must say it cannot claim currency').toMatch(/cannot say you are current/);
    expect(app, 'and offer the fix in the same breath').toMatch(/check now/);
    // Both silences, told apart — "never asked" and "not since Tuesday" read
    // differently to someone deciding whether to worry.
    expect(app).toMatch(/never checked for updates/);
    expect(app).toMatch(/last checked for updates/);
  });

  it('records the check on every completed attempt, not only on success', () => {
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    // The record must be written BEFORE the available/current branch returns,
    // or an available update would never mark that we asked.
    const record = app.indexOf('recordUpdateCheck({');
    const branch = app.indexOf('if (info.available) {', record);
    expect(record, 'recordUpdateCheck must be present').toBeGreaterThan(-1);
    expect(branch, 'and must run before the early return').toBeGreaterThan(record);
  });

  // The whole point: a corrupt record must fall back to "we cannot claim
  // currency", never to "you're fine".
  it('a corrupt record reads as stale, not as current', async () => {
    const { loadUpdateCheck, updateCheckIsStale } = await import('../src/lib/updater');
    localStorage.setItem('buddy_last_update_check', 'not json at all');
    expect(updateCheckIsStale(loadUpdateCheck())).toBe(true);
  });
});

// No stranger-matching surface, anywhere in src/.
//
// Buddy polled unauthenticated /api/suggestions every five minutes and rendered
// a "Suggested" section. Production returned real handles, live online state and
// project names to a caller presenting no credential. Removed 2026-08-02 under
// current canon (platform#174).
//
// This is NOT a rejection of automatic matching. PROJECT-HISTORY parks that idea
// behind explicit opt-in, double consent, identity enforcement and evidence that
// matches are useful. The removed implementation satisfied none of those four,
// and a future one must satisfy all of them — a canon question, not something a
// client reintroduces.
//
// The first version of this guard read three named files, so a NEW component or
// helper could reintroduce the same call and pass. It now walks all of src/.
describe('Buddy surfaces no unrequested stranger matching', () => {
  // Route boundaries matter: /api/handles/check and /api/handles/claim are
  // ordinary onboarding calls about YOUR OWN handle, and operational
  // /api/agents/<id>/... routes are fine. Only the list/search shapes disclose
  // people who did not ask to be listed.
  const DANGEROUS: Array<{ name: string; re: RegExp }> = [
    { name: '/api/suggestions', re: /\/api\/suggestions\b/ },
    { name: '/api/discover', re: /\/api\/discover\b/ },
    // bare list, query string, or the github lookup — but never check/claim
    { name: '/api/handles (list/search)', re: /\/api\/handles(?:\/by-github\b|(?!\/(?:check|claim)\b)(?=[?'"`\s)&]|$))/ },
    // bare agents list/search; operational subroutes are permitted
    { name: '/api/agents (list/search)', re: /\/api\/agents(?=[?'"`\s)&]|$)/ },
  ];

  const flag = (text: string) => DANGEROUS.filter(({ re }) => re.test(text)).map(({ name }) => name);

  // The matcher is itself tested, because a crude regex that silently stops
  // matching reads exactly like "all clear". These fixtures fail loudly if the
  // pattern drifts in either direction.
  it('the matcher flags list/search routes and permits safe subroutes', () => {
    for (const bad of [
      `fetch('/api/suggestions?handle=x')`,
      `fetch("/api/discover")`,
      'fetch(`${API}/api/handles?limit=50`)',
      `fetch('/api/handles/by-github?login=x')`,
      `fetch('/api/agents')`,
      `fetch('/api/agents?online=true')`,
    ]) {
      expect(flag(bad), `should be flagged: ${bad}`).not.toEqual([]);
    }
    for (const ok of [
      `fetch('/api/handles/check?handle=me')`,
      `fetch('/api/handles/claim')`,
      'fetch(`/api/agents/${id}/status`)',
      `fetch('/api/agents/sal/heartbeat')`,
      `fetch('/api/v2/presence')`,
    ]) {
      expect(flag(ok), `must NOT be flagged: ${ok}`).toEqual([]);
    }
  });

  it('no file under src/ calls a matching or discovery route', () => {
    const root = new URL('../src/', import.meta.url);
    const walk = (dir: URL): URL[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const child = new URL(e.name + (e.isDirectory() ? '/' : ''), dir);
        if (e.isDirectory()) return walk(child);
        return /\.(ts|tsx)$/.test(e.name) ? [child] : [];
      });

    const files = walk(root);
    // A guard that scans nothing passes. Assert it actually walked the tree.
    expect(files.length, 'the walker found no source files — it is not guarding anything')
      .toBeGreaterThan(10);

    const offenders = files
      .map((f) => ({ file: f.pathname.split('/src/')[1], hits: flag(readFileSync(f, 'utf8')) }))
      .filter(({ hits }) => hits.length > 0)
      .map(({ file, hits }) => `${file}: ${hits.join(', ')}`);

    expect(
      offenders,
      'these expose people who did not opt in — see PROJECT-HISTORY on parked matching',
    ).toEqual([]);
  });

  it('renders no Suggested section', () => {
    const src = readFileSync(new URL('../src/components/UnifiedBuddyList.tsx', import.meta.url), 'utf8');
    expect(src).not.toMatch(/visibleSuggestions/);
    expect(src).not.toMatch(/>\s*Suggested\s*</);
  });
});

describe('"presence never landed" is never claimed after presence has landed', () => {
  // buddy#10, found live during the 2026-08-02 G3 run: with wifi off, the My
  // Presence card read "presence never landed" while vibetester1 had been on
  // the roster minutes earlier. Same defect shape as the updater bug above —
  // "never happened" and "happened, then stopped" collapsed into one state.
  // The distinction is load-bearing: never landed means misconfigured; stopped
  // means temporarily wrong. They warrant different reactions.
  const base = { sharing: true, broadcast: null, announceGrace: false };

  it('keeps the never-landed copy when no heartbeat has ever landed', async () => {
    const { presenceStatusLine } = await import('../src/lib/presencePrefs');
    const line = presenceStatusLine({ ...base, lastLandedAt: null, now: 1_000_000 });
    expect(line).toBe('Not visible to others — presence never landed');
  });

  it('says "stopped updating", with the age, once presence has landed and then gone', async () => {
    const { presenceStatusLine } = await import('../src/lib/presencePrefs');
    const now = 10_000_000;
    const line = presenceStatusLine({ ...base, lastLandedAt: now - 4 * 60_000, now });
    expect(line).toBe('Presence stopped updating 4m ago — you may not be visible');
    expect(line).not.toMatch(/never/);
  });

  it('a clock that reads earlier than the landing never renders a negative age', async () => {
    const { presenceStatusLine } = await import('../src/lib/presencePrefs');
    const line = presenceStatusLine({ ...base, lastLandedAt: 2_000_000, now: 1_000_000 });
    expect(line).toBe('Presence stopped updating 0s ago — you may not be visible');
  });

  it('the landed record does not override the honest states', async () => {
    const { presenceStatusLine } = await import('../src/lib/presencePrefs');
    const landed = { lastLandedAt: 5_000, now: 10_000_000 };
    expect(presenceStatusLine({ ...base, ...landed, sharing: false }))
      .toBe('Buddy heartbeats paused — not broadcasting');
    expect(presenceStatusLine({ ...base, ...landed, announceGrace: true }))
      .toBe('Announcing…');
    expect(presenceStatusLine({
      ...base,
      ...landed,
      // FRESH broadcast (1 min old) is what others see.
      broadcast: { workingOn: 'shipping buddy', project: null, branch: null, model: null, sentAt: landed.now - 60_000 },
    })).toBe('shipping buddy');
  });

  it('a broadcast past the freshness window stops claiming "others see" (audit #5)', async () => {
    const { presenceStatusLine } = await import('../src/lib/presencePrefs');
    const now = 10_000_000;
    // Landed 20 min ago, and nothing since: the Mac slept or a terminal took the
    // row. The card must not still assert current visibility — it downgrades to
    // "stopped updating", dated from the last landing.
    const line = presenceStatusLine({
      sharing: true,
      announceGrace: false,
      broadcast: { workingOn: 'shipping buddy', project: null, branch: null, model: null, sentAt: now - 20 * 60_000 },
      lastLandedAt: now - 20 * 60_000,
      now,
    });
    expect(line).toBe('Presence stopped updating 20m ago — you may not be visible');
    expect(line).not.toBe('shipping buddy');
  });

  it('a stale broadcast does not read "Announcing…" even with grace on (codex)', async () => {
    const { presenceStatusLine } = await import('../src/lib/presencePrefs');
    const now = 10_000_000;
    // The card can leave announceGrace true while a broadcast is non-null; a
    // stale one must still downgrade to "stopped updating", never claim progress.
    const line = presenceStatusLine({
      sharing: true,
      announceGrace: true,
      broadcast: { workingOn: 'x', project: null, branch: null, model: null, sentAt: now - 15 * 60_000 },
      lastLandedAt: now - 15 * 60_000,
      now,
    });
    expect(line).toBe('Presence stopped updating 15m ago — you may not be visible');
    // ...but with NOTHING landed, grace still shows first-announcement progress.
    expect(presenceStatusLine({ sharing: true, announceGrace: true, broadcast: null, lastLandedAt: null, now }))
      .toBe('Announcing…');
  });

  // Audit #6: "Invisible" is a claim about what OTHERS see, and the sharing
  // pref alone cannot back it — the offline write can fail, and coding
  // sessions heartbeat the same handle independently of Buddy. Each invisible
  // branch claims exactly what its evidence covers.
  it('going invisible claims only what the retraction receipt covers (audit #6)', async () => {
    const { presenceStatusLine } = await import('../src/lib/presencePrefs');
    const off = { ...base, sharing: false, lastLandedAt: null, now: 10_000_000 };
    // No receipt (booted invisible): claim Buddy's own behavior, nothing wider.
    expect(presenceStatusLine(off)).toBe('Buddy heartbeats paused — not broadcasting');
    // Write in flight: progress, not a state.
    expect(presenceStatusLine({ ...off, retraction: 'inflight' }))
      .toBe('Going invisible — clearing your presence…');
    // Write failed: the dot may still be lit — say so.
    expect(presenceStatusLine({ ...off, retraction: 'failed' }))
      .toBe("Buddy heartbeats paused — couldn't confirm your dot cleared");
    // "Invisible" needs a fresh acknowledgement AND verified-zero sessions.
    expect(presenceStatusLine({ ...off, retraction: { confirmedAt: off.now - 60_000 }, liveSessionCount: 0 }))
      .toBe('Invisible — the server cleared your presence');
  });

  it('a confirmed retraction is evidence of a moment — it ages out and never outlives its eyes (codex P1)', async () => {
    const { presenceStatusLine } = await import('../src/lib/presencePrefs');
    const { GREEN_FRESH_MS } = await import('../src/lib/freshness');
    const off = { ...base, sharing: false, lastLandedAt: null, now: 100_000_000 };
    // A terminal heartbeat can relight presence any time after the ack, so a
    // stale receipt falls back to the plain paused line, never "Invisible".
    expect(presenceStatusLine({
      ...off,
      retraction: { confirmedAt: off.now - GREEN_FRESH_MS - 1000 },
      liveSessionCount: 0,
    })).toBe('Buddy heartbeats paused — not broadcasting');
    // A failed sessions read is cannot-see, not zero: without eyes on the
    // other broadcasters, even a fresh ack may not claim "Invisible".
    expect(presenceStatusLine({
      ...off,
      retraction: { confirmedAt: off.now - 1000 },
      liveSessionCount: null,
    })).toBe('Buddy heartbeats paused — not broadcasting');
    // Absent data (caller passed nothing) is treated the same as cannot-see.
    expect(presenceStatusLine({ ...off, retraction: { confirmedAt: off.now - 1000 } }))
      .toBe('Buddy heartbeats paused — not broadcasting');
  });

  it('live session rows outrank even a confirmed retraction — they broadcast you separately', async () => {
    const { presenceStatusLine } = await import('../src/lib/presencePrefs');
    const off = { ...base, sharing: false, lastLandedAt: null, now: 10_000_000 };
    // Terminal sessions heartbeat regardless of Buddy's pref; while rows exist
    // under a good read, "Invisible" would be false no matter what Buddy's own
    // write achieved. Failure/progress receipts still come first — both true,
    // but the unconfirmed write is the more urgent fact.
    expect(presenceStatusLine({ ...off, retraction: { confirmedAt: off.now - 1000 }, liveSessionCount: 2 }))
      .toBe('Buddy heartbeats paused — coding sessions broadcast you separately');
    expect(presenceStatusLine({ ...off, liveSessionCount: 1 }))
      .toBe('Buddy heartbeats paused — coding sessions broadcast you separately');
    expect(presenceStatusLine({ ...off, retraction: 'failed', liveSessionCount: 1 }))
      .toBe("Buddy heartbeats paused — couldn't confirm your dot cleared");
    expect(presenceStatusLine({ ...off, retraction: 'inflight', liveSessionCount: 1 }))
      .toBe('Going invisible — clearing your presence…');
  });

  it('goOffline reads the response, not the absence of a throw (codex P1)', async () => {
    // authenticatedRequest resolves — never throws — on 4xx/5xx. A 401 that
    // "returned" must not become an "Invisible" receipt.
    const { buddyClient } = await import('../src/lib/vibeClient');
    const client = buddyClient as any;
    const savedHandle = client.handle;
    const savedRequest = client.authenticatedRequest;
    try {
      client.handle = 'tester';
      client.authenticatedRequest = async () => ({ ok: false, data: {}, status: 401 });
      expect(await client.goOffline()).toBe(false);
      client.authenticatedRequest = async () => ({ ok: true, data: {}, status: 200 });
      expect(await client.goOffline()).toBe(true);
    } finally {
      client.handle = savedHandle;
      client.authenticatedRequest = savedRequest;
    }
  });

  // The record itself lives in App.tsx state. A failed heartbeat must not
  // clear it — clearing it is exactly the collapse this block exists to stop —
  // and logout must, or the next account inherits the previous one's history.
  it('App keeps the landed record on a failed beat and clears it with identity', () => {
    const src = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    const failedBeat = src.match(/if \(!landed\) \{([\s\S]*?)\}/);
    expect(failedBeat, 'the failed-heartbeat branch has moved — re-anchor this guard').toBeTruthy();
    expect(failedBeat![1]).not.toMatch(/setPresenceLastLandedAt/);
    const clearIdentity = src.match(/const clearIdentityState = useCallback\(\(\) => \{([\s\S]*?)\}, \[\]\);/);
    expect(clearIdentity, 'clearIdentityState has moved — re-anchor this guard').toBeTruthy();
    expect(clearIdentity![1]).toMatch(/setPresenceLastLandedAt\(null\)/);
  });

  // Retained-snapshot cluster (honest-state audit 2026-08-11): a claim must not
  // outlive the evidence for it — the buddy#10 shape, swept across the surfaces.
  it('#1 · the tray keeps the last-known online count on a failed read, never a false zero', () => {
    const src = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    // The old `presenceData.error ? 0 : …` said "nobody around" on a blip while
    // the list retained people. The count now comes from the retained roster,
    // using the platform's own `active` status (matching the Online section;
    // Buddy must not redefine presence locally — AGENTS.md).
    expect(src).not.toMatch(/presenceData\.error\s*\?\s*0/);
    expect(src).toMatch(/presenceData\.error \? usersRef\.current : presenceData\.users/);
  });

  it('#3 · there is no ambient line to go stale (ruthless pass 2026-08-15)', () => {
    // The line said "3 builders online right now", restating a count the
    // list already showed, and audit #3 existed because it outlived the
    // roster that proved it. Removed rather than kept honest.
    const src = readFileSync(new URL('../src/components/UnifiedBuddyList.tsx', import.meta.url), 'utf8');
    expect(src).not.toMatch(/ambientText|ambientVisible|ambientMessage/);
  });
});

describe('the interval leads with the exchange', () => {
  // The 2026-08-03 interval audit (docs/INTERVAL-UX-AUDIT.md): with one unread
  // reply waiting and a modest room, the reply rendered below the fold, under
  // the notification offer, own sessions and the presence lanes — a buddy
  // directory with the exchange filed under miscellany. The WAITING block puts
  // the exchange first. Presentation only: the platform's unread counts and
  // message order are rendered untouched.
  const t = (withHandle: string, unread: number, at: string) => ({
    with: withHandle,
    unread,
    lastMessage: { from: withHandle, body: 'x', created_at: at },
  });

  it('waiting holds exactly the unread threads, newest reply first', async () => {
    const { waitingThreads } = await import('../src/lib/interval');
    const result = waitingThreads([
      t('older', 2, '2026-08-03T10:00:00Z'),
      t('read', 0, '2026-08-03T12:00:00Z'),
      t('newer', 1, '2026-08-03T11:00:00Z'),
    ]);
    expect(result.map((x) => x.with)).toEqual(['newer', 'older']);
  });

  it('the paired partner is never duplicated into waiting', async () => {
    const { waitingThreads } = await import('../src/lib/interval');
    const result = waitingThreads(
      [t('partner', 3, '2026-08-03T10:00:00Z'), t('other', 1, '2026-08-03T09:00:00Z')],
      'partner',
    );
    expect(result.map((x) => x.with)).toEqual(['other']);
  });

  it('a thread with no lastMessage still ranks, it does not throw', async () => {
    const { waitingThreads } = await import('../src/lib/interval');
    const bare = { with: 'bare', unread: 1 };
    const result = waitingThreads([bare, t('dated', 1, '2026-08-03T10:00:00Z')]);
    expect(result.map((x) => x.with)).toEqual(['dated', 'bare']);
  });

  it('the collapsed sessions line names the most recently active project', async () => {
    const { sessionsSummary } = await import('../src/lib/interval');
    const s = (project: string, agoSeconds: number) => ({
      sessionId: project, cwd: '/', project, status: 'idle' as const, agoSeconds,
    });
    expect(sessionsSummary([s('stale-proj', 900), s('fresh-proj', 30)])).toBe('fresh-proj');
    expect(sessionsSummary([])).toBe('');
  });

  // The self dot claimed presence from the sharing PREF while the status line
  // on the same card said "presence stopped updating". Green is reserved for
  // server-confirmed state; only a landed broadcast earns it.
  it('the self dot is green only while a FRESH broadcast has landed', async () => {
    const { selfDotConfirmed } = await import('../src/lib/presencePrefs');
    const now = 10_000_000;
    const fresh = { workingOn: 'x', project: null, branch: null, model: null, sentAt: now - 60_000 };
    const stale = { workingOn: 'x', project: null, branch: null, model: null, sentAt: now - 20 * 60_000 };
    expect(selfDotConfirmed({ sharing: true, broadcast: fresh, now })).toBe(true);
    expect(selfDotConfirmed({ sharing: true, broadcast: null, now })).toBe(false);
    expect(selfDotConfirmed({ sharing: false, broadcast: fresh, now })).toBe(false);
    // audit #5: a broadcast past the 10-min window no longer confirms presence.
    expect(selfDotConfirmed({ sharing: true, broadcast: stale, now })).toBe(false);
  });

  // Wiring guards on the component source: the ordering claim and the
  // present-once claim are structural, so pin the structure.
  const listSrc = () => listFamilySrc();

  it('blocked work outranks the exchange; an idle session does not', () => {
    // ORDER CHANGED 2026-08-14. This used to pin waiting-above-sessions, from
    // when MY SESSIONS was presence information rather than an attention
    // queue. Both are queues now, and "which of your sessions needs you" was
    // rendering below the fold. But the promotion is CONDITIONAL: an idle
    // session must not outrank a real unread reply just for being yours
    // (codex r1), so one element is placed on one side of the exchange or
    // the other by the same evidence the badge uses.
    //
    // MECHANISM CHANGED 2026-08-14 (codex r5 P1): this was two conditional
    // call sites in one parent, so when the last attention signal cleared
    // the element moved between them and React REMOUNTED the section —
    // taking an open row's draft, caret and pin with it. React reconciles by
    // position, so a key cannot fix that. Now: ONE mount, reordered with
    // flex `order`. DOM order is stable; paint order follows the evidence.
    const src = listSrc();
    const mountAt = src.indexOf('{mySessionsEl}');
    const zoneAt = src.indexOf('For you · {filteredWaiting.length + zoneSessionCount}');
    const onlineAt = src.indexOf('Online · {humanActive.length}');
    expect(mountAt, 'the single mount is missing').toBeGreaterThan(-1);
    // Exactly one — a second call site would reintroduce the remount.
    expect((src.match(/\{mySessionsEl\}/g) || []).length).toBe(1);
    // THE FOR YOU ZONE IS FIXED (buddy#49 decision 1): exchange first, then
    // your sessions, then presence — one position, always. The old
    // evidence-driven swap (and the keyed-siblings machinery it needed to
    // survive its own reordering: codex r5 P1, r6 P2) is deliberately gone;
    // a fixed order remounts nothing and DOM order IS the visual order.
    expect(src).not.toMatch(/\['sessions', 'waiting'\]/);
    expect(src).not.toMatch(/order: sessionsWantYou/);
    expect(zoneAt, 'the zone header is missing').toBeGreaterThan(-1);
    expect(zoneAt).toBeLessThan(mountAt);
    expect(mountAt).toBeLessThan(onlineAt);
    // The zone count reads the SAME signal map the rows and alerts read —
    // machine-wide, so the number cannot depend on where a row renders
    // (codex r1 on #37) — and counts ACTIONABLE ROWS exactly (decision 2).
    // Presented rows, exactly (codex r5 P2): unbound wanting sessions —
    // MySessions' above-the-line set — plus the promoted bound-wanting
    // beings, placement-frozen members included.
    expect(src).toMatch(/const wantingUnbound = unboundSessions\.filter\(\(s\) => wantsYou\(signals\.get\(s\.cwd\)\)\)\.length/);
    expect(src).toMatch(/const zoneSessionCount = wantingUnbound \+ promotedAgents\.length/);
  });
  it('every lane excludes principals already presented in waiting', () => {
    const src = listSrc();
    const exclusions = src.match(/!waitingHandles\.has\(/g) || [];
    // active, away, offline-threads — all three must exclude, or a principal
    // renders twice and the block becomes duplication instead of priority.
    expect(exclusions.length).toBeGreaterThanOrEqual(3);
  });

  it('the self status line wraps rather than truncating its claim', () => {
    const src = listSrc();
    const statusBlock = src.match(/([^]{0,600})\{statusLine\}/);
    expect(statusBlock, 'status line render moved — re-anchor this guard').toBeTruthy();
    expect(statusBlock![1]).toMatch(/WebkitLineClamp/);
    expect(statusBlock![1]).not.toMatch(/whiteSpace: 'nowrap'/);
  });

  it('an unread thread row is never dimmed as history', () => {
    const src = listSrc();
    const row = src.match(/function OfflineThreadRow[^]{0,3000}opacity: ([^,]+),/);
    expect(row, 'OfflineThreadRow moved — re-anchor this guard').toBeTruthy();
    expect(row![1]).toContain('hasUnread');
  });

  it('archive is a server write the row renders honestly (thread management v1)', async () => {
    // The affordance renders only when the thread carries a server id — an
    // offer to archive that cannot land is a lie in button form — and the
    // row never hides itself locally: departure happens by server truth on
    // the next poll ("archived — clearing on next sync").
    // ONE chip definition serves every row variant (codex P2: a stale unread
    // from an always-on peer renders as a UserRow, and archivability must not
    // depend on row shape) — and it reveals on keyboard focus, not hover
    // alone, with real stopPropagation so archiving never also opens the DM.
    const chipSrc = readFileSync(new URL('../src/components/list/shared.tsx', import.meta.url), 'utf8');
    expect(chipSrc).toMatch(/export function ArchiveChip/);
    expect(chipSrc).toContain("'archived — clearing on next sync'");
    expect(chipSrc).toContain("couldn't archive");
    expect(chipSrc).toMatch(/e\.key === 'Enter' \|\| e\.key === ' '/);
    for (const f of ['OfflineThreadRow.tsx', 'rows.tsx']) {
      const src = readFileSync(new URL(`../src/components/list/${f}`, import.meta.url), 'utf8');
      expect(src, `${f} renders the shared chip`).toMatch(/<ArchiveChip revealed=\{hovered \|\| focused\}/);
    }
    const listSrc3 = readFileSync(new URL('../src/components/UnifiedBuddyList.tsx', import.meta.url), 'utf8');
    expect(listSrc3).toMatch(/t\?\.id \? \(\) => buddyClient\.setThreadArchived\(t\.id!, true\) : undefined/);
    // Every row variant that can carry a thread gets the affordance.
    expect((listSrc3.match(/onArchive=\{archiveFor\(/g) || []).length).toBeGreaterThanOrEqual(6);
    // The client call reads the server's verdict, not the absence of a throw.
    const { buddyClient } = await import('../src/lib/vibeClient');
    const client = buddyClient as any;
    const saved = { handle: client.handle, req: client.authenticatedRequest };
    try {
      client.handle = 'tester';
      client.authenticatedRequest = async () => ({ ok: false, data: {}, status: 500 });
      expect(await client.setThreadArchived('thread_x', true)).toBe(false);
      client.authenticatedRequest = async () => ({ ok: true, data: {}, status: 200 });
      expect(await client.setThreadArchived('thread_x', true)).toBe(true);
      expect(await client.setThreadArchived('', true)).toBe(false);
    } finally {
      client.handle = saved.handle;
      client.authenticatedRequest = saved.req;
    }
  });

  it('the dev harness cannot reach a production bundle', () => {
    const src = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8');
    const gate = src.match(/import\.meta\.env\.DEV[^]{0,200}import\('\.\/dev\/Harness'\)/);
    expect(gate, 'the harness import must stay behind import.meta.env.DEV').toBeTruthy();
  });
});

describe('social polish stays honest (2026-08-03 follow-up)', () => {
  const listSrc2 = () => listFamilySrc();
  const dmSrc2 = () =>
    readFileSync(new URL('../src/components/DMPanel.tsx', import.meta.url), 'utf8');

  // One local freshness clock for the reserved green, matching the MCP
  // board's 10-minute window (mcp-server/tools/who.js) — the two surfaces a
  // person sees side by side must not disagree about who is lit.
  it('green freshness matches the MCP ten-minute window', async () => {
    const { isFreshLastSeen, GREEN_FRESH_MS } = await import('../src/lib/freshness');
    const now = 1_000_000_000_000;
    expect(GREEN_FRESH_MS).toBe(10 * 60_000);
    expect(isFreshLastSeen(new Date(now - GREEN_FRESH_MS + 1000).toISOString(), now)).toBe(true);
    expect(isFreshLastSeen(new Date(now - GREEN_FRESH_MS).toISOString(), now)).toBe(false);
  });

  it('a missing or unreadable timestamp withholds green (audit #11 reversed the old rule)', async () => {
    // This test used to pin the opposite: "keep the server's word" when the
    // timestamp was unreadable. The honest-state audit called that the
    // characteristic defect — green is the assertion, so it needs readable,
    // recent evidence; withholding it claims nothing.
    const { isFreshLastSeen } = await import('../src/lib/freshness');
    expect(isFreshLastSeen(undefined, 1_000)).toBe(false);
    expect(isFreshLastSeen('not-a-date', 1_000)).toBe(false);
  });

  it('every presence dot spends green through the freshness rule', () => {
    const src = listSrc2();
    // presenceDotColor takes the clock and consults freshness…
    expect(src).toMatch(/presenceDotColor = \(user: VibeUser, now: number\)/);
    expect(src).toMatch(/isFreshLastSeen\(user\.lastSeen, now\)/);
    // …and the local session dot uses the same window on the EFFECTIVE
    // heartbeat age (age-at-receipt + elapsed since receipt) AND requires the
    // latest read to have succeeded (!stale), so a retained row cannot stay
    // green through an outage (audit #8).
    expect(src).toMatch(/isActive && !stale && isFreshAge\(heartbeatAgeMs\)/);
    // The conversation header is a presence surface too. It must not relight a
    // stale server-"active" row after the roster has correctly dimmed it.
    expect(dmSrc2()).toMatch(
      /them\?\.status === 'active' && isFreshLastSeen\(them\.lastSeen, Date\.now\(\)\)/,
    );
  });

  it('a withheld dot is never color alone — every reachability reason has words (audit #9)', async () => {
    const { reachabilityWords } = await import('../src/components/list/shared');
    const u = (over: Record<string, unknown>) =>
      ({ handle: 'x', lastSeen: new Date().toISOString(), status: 'active', ...over }) as never;
    // Both dot-withholding reasons name themselves beside the dot.
    expect(reachabilityWords(u({ reachability: 'broadcast-only', unreadCount: 3 }))?.label).toBe('not reading');
    expect(reachabilityWords(u({ isAgent: true, reachability: 'unknown' }))?.label).toBe('untested');
    // A human's untested reachability withholds nothing, so no words: the
    // human dot's only promise is presence. An agent that reads keeps green.
    expect(reachabilityWords(u({ isAgent: false, reachability: 'unknown' }))).toBeNull();
    expect(reachabilityWords(u({ isAgent: true, reachability: 'reading' }))).toBeNull();
    // The row chip renders from this single definition — the words and the
    // dot logic cannot drift apart without failing here.
    expect(listSrc2()).toMatch(/reachabilityWords\(user\)/);
  });

  it('the dot renders presence only — reachability never dims it (audit #9 / AGENTS.md)', async () => {
    // "Presence is liveness, not reachability. Never render a green dot as
    // 'will receive this'" — the contract keeps the two systems independent,
    // so a live broadcast-only or untested principal keeps its green dot and
    // the WORDS carry the reachability fact.
    const { presenceDotColor } = await import('../src/components/list/shared');
    const now = 1_000_000_000_000;
    const fresh = new Date(now - 60_000).toISOString();
    const stale = new Date(now - 11 * 60_000).toISOString();
    const u = (over: Record<string, unknown>) =>
      ({ handle: 'x', status: 'active', lastSeen: fresh, ...over }) as never;
    const green = presenceDotColor(u({}), now);
    expect(presenceDotColor(u({ reachability: 'broadcast-only' }), now)).toBe(green);
    expect(presenceDotColor(u({ isAgent: true, reachability: 'unknown' }), now)).toBe(green);
    // Presence itself still gates it: stale is faint for everyone.
    expect(presenceDotColor(u({ lastSeen: stale }), now)).not.toBe(green);
    // The invisible card's expiry clock must keep ticking while a confirmed
    // retraction is on screen (codex P1 r2: a frozen `now` keeps isFreshAge
    // true forever, exactly while sharing is off).
    const cardSrc = readFileSync(new URL('../src/components/list/MyPresenceCard.tsx', import.meta.url), 'utf8');
    expect(cardSrc).toMatch(/!prefs\.sharing && retraction !== null && typeof retraction === 'object'/);
  });

  it('a paired partner gets reachability words like anyone else (2026-08-15)', () => {
    // This used to check that the hero card carried its own copy of the
    // reachability chip, because a paired agent was EXCLUDED from UserRow and
    // would otherwise have shown presence-green with no qualifier anywhere.
    // The exclusion is gone with the card: the partner is an ordinary row, so
    // there is one chip implementation instead of two that could drift.
    const src = readFileSync(new URL('../src/components/list/rows.tsx', import.meta.url), 'utf8');
    // Comments stripped — the file documents the deletion by name.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/PairedHeroCard/);
    expect(code).toMatch(/reachabilityWords\(user\)/);
    const list = readFileSync(new URL('../src/components/UnifiedBuddyList.tsx', import.meta.url), 'utf8');
    expect(list).not.toMatch(/u\.handle !== pairedWith/);
    // A pair authorizes the session view whether or not presence reports a
    // SessionEntity, so the action survives the card's deletion.
    // Suppressed in exactly ONE lane — the only one that renders a
    // SessionRow. Everywhere else the action must survive, or a paired
    // partner who is unread, away or an agent loses access precisely when a
    // live session exists (codex P2).
    expect((list.match(/onSessionView=\{[^}]*!sessionMap\.has/g) || []).length).toBe(1);
    // Five call sites: waiting, the FOR YOU bound-wanting promotion (#50),
    // online, away, agents.
    expect((list.match(/onSessionView=/g) || []).length).toBe(5);
    // State is not an action: 'paired' stays a plain chip and the action is
    // its own control, borrowing SessionRow's word rather than minting a
    // second name for opening a session (codex P2).
    const rowsSrc = readFileSync(new URL('../src/components/list/rows.tsx', import.meta.url), 'utf8');
    expect(rowsSrc).toMatch(/aria-label=\{`watch @\$\{user\.handle\}'s shared session`\}/);
    // SIBLING, not descendant: ARIA button descendants are presentational, so
    // nested inside role="button" the control was tabbable but screen readers
    // could expose only the outer row name (codex P2).
    const rowBtn = rowsSrc.indexOf('className="vibe-row vibe-press"');
    expect(rowsSrc.indexOf("watch @${user.handle}'s shared session")).toBeGreaterThan(rowBtn);
    expect(rowsSrc).toMatch(/\{isPaired && onSessionView && \(/);
    // smartStatus calls inferState, so a dead derivation kept the inference
    // in the bundle the 'infers nothing' test claims to have removed (P3).
    expect(rowsSrc).not.toMatch(/smartStatus/);
    // Search matches only what a row shows — tech_stack pills are gone, so
    // matching them surfaced results with no visible match and leaked
    // profile metadata moved behind another consent boundary.
    expect(list).not.toMatch(/tech_stack \|\| \[\]/);
    // ...and the partner's session is adopted into the Sessions lane ONLY
    // when no other lane draws it, or the board shows it twice.
    expect(list).toMatch(/s\.parent === pairedWith && !renderedHandles\.has\(s\.parent\)/);
  });

  it('only fresh sessions count as broadcasters — retained rows do not (codex P2 r3)', async () => {
    // The platform keeps session rows for minutes after their last heartbeat.
    // A retained row must not keep the invisible card claiming "coding
    // sessions broadcast you separately" past its liveness evidence.
    const { freshSessionCount } = await import('../src/lib/mySessionsState');
    const { GREEN_FRESH_MS } = await import('../src/lib/freshness');
    const now = 1_000_000_000_000;
    const observedAt = now - 60_000; // read landed a minute ago
    const sessions = [
      { agoSeconds: 5 },                                  // fresh
      { agoSeconds: (GREEN_FRESH_MS / 1000) + 60 },       // expired at receipt
    ];
    expect(freshSessionCount(sessions, observedAt, now)).toBe(1);
    // The elapsed time since receipt ages rows too: a session fresh at
    // receipt expires as the snapshot sits.
    expect(freshSessionCount([{ agoSeconds: 5 }], now - GREEN_FRESH_MS, now)).toBe(0);
    expect(freshSessionCount([], undefined, now)).toBe(0);
  });

  it('an agent answering in WAITING is labeled inside the row', () => {
    const src = listSrc2();
    // The waiting block asks the row to say its kind…
    expect(src).toMatch(/showDetails=\{showDetails\}\s*\n\s*showKind/);
    // …and the row renders the chip for agents when asked.
    expect(src).toMatch(/showKind && isAgent\(user\)/);
    expect(src).toContain('🤖 agent');
  });

  it('the synthetic capture set never greets with a real handle', () => {
    for (const file of ['../src/dev/fixtures.ts', '../src/dev/Harness.tsx']) {
      const src = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(src, `${file} must not contain a real handle`).not.toMatch(/brightseth/);
    }
    // The harness overrides the product's founder greeter with a synthetic one.
    const harness = readFileSync(new URL('../src/dev/Harness.tsx', import.meta.url), 'utf8');
    expect(harness).toMatch(/greeter="guide_demo"/);
  });

  it('primary rows are keyboard-activatable with visible focus', () => {
    const src = listSrc2();
    const pressSites = src.match(/onKeyDown=\{(clickable \? )?pressOnKey\(/g) || [];
    // user rows, thread rows, session rows, my-session header, presence card,
    // recent traces, show-all expander
    expect(pressSites.length).toBeGreaterThanOrEqual(7);
    expect(src).toMatch(/\.vibe-press:focus-visible\{outline:2px solid/);
    // Focus outline is the one action colour, from the token — never a literal.
    expect(src).toMatch(/outline:2px solid \$\{color\.blue\}/);
  });

  it('no text is painted in the border colour', () => {
    const src = listSrc2();
    expect(src.match(/color: color\.line[,\s}]/g) || []).toEqual([]);
  });
});

describe('a live coding session is never hidden behind "Quiet in here" (2026-08-04)', () => {
  // THE BUG: the room-content gate omitted mySessions, so a solo user with a
  // live session got the empty room — Buddy drew a void at the exact moment it
  // could have said "your session is here". And with zero rows, three
  // different worlds (checking / verified none / read failed) rendered the
  // same blank space, the defect class the CallProbe comment documents.
  //
  // Amended after the codex integration review: snapshot retention and
  // latest-read certainty are separate facts. Retained rows age honestly and
  // never render as current; a verified-empty followed by a failed read says
  // "can't see", never "none".

  it('probe: certainty tracks the LATEST read — a blip after a good read is still unchecked', async () => {
    const { nextMySessionsProbe } = await import('../src/lib/mySessionsState');
    expect(nextMySessionsProbe(false)).toBe('known');
    expect(nextMySessionsProbe(true)).toBe('unchecked');
  });

  it('known-empty then a failed read renders can\'t-check, never "no sessions"', async () => {
    const { nextMySessionsProbe, mySessionsBlock } = await import('../src/lib/mySessionsState');
    // good empty read → authoritative none
    let probe = nextMySessionsProbe(false);
    let block = mySessionsBlock(probe, 0);
    expect(block.kind).toBe('line');
    expect((block as any).line).toMatch(/no coding sessions/);
    // then the next read fails → we can no longer claim "none"
    probe = nextMySessionsProbe(true);
    block = mySessionsBlock(probe, 0);
    expect(block.kind).toBe('line');
    expect((block as any).line).not.toMatch(/no coding sessions/i);
    expect((block as any).line).toMatch(/can't see/);
  });

  it('zero rows says WHICH zero: three states, three distinct sentences', async () => {
    const { mySessionsEmptyLine } = await import('../src/lib/mySessionsState');
    const lines = (['unasked', 'known', 'unchecked'] as const).map(mySessionsEmptyLine);
    expect(new Set(lines).size).toBe(3);
    expect(mySessionsEmptyLine('unchecked')).not.toMatch(/no coding sessions/i);
    expect(mySessionsEmptyLine('unchecked')).toMatch(/can't see/);
    expect(mySessionsEmptyLine('known')).toMatch(/no coding sessions/);
    expect(mySessionsEmptyLine('known')).not.toMatch(/reconnect|can't|fail/i);
    expect(mySessionsEmptyLine('known')).toMatch(/open Claude Code or Codex/);
  });

  it('retained rows render as rows-STALE, and the stale line names the snapshot age', async () => {
    const { mySessionsBlock, mySessionsStaleLine } = await import('../src/lib/mySessionsState');
    expect(mySessionsBlock('known', 1)).toEqual({ kind: 'rows' });
    expect(mySessionsBlock('unchecked', 2)).toEqual({ kind: 'rows-stale' });
    expect(mySessionsBlock('known', 0).kind).toBe('line');
    expect(mySessionsStaleLine('2m ago')).toBe('reconnecting — sessions as of 2m ago');
  });

  it('retained rows age from receipt and lose green at the freshness gate', async () => {
    const { effectiveAgoMs } = await import('../src/lib/mySessionsState');
    const { isFreshAge } = await import('../src/lib/freshness');
    const receipt = 1_000_000_000;
    const session = { agoSeconds: 12 };
    // At receipt the stated age holds: 12s, fresh.
    expect(effectiveAgoMs(session, receipt, receipt)).toBe(12_000);
    expect(isFreshAge(effectiveAgoMs(session, receipt, receipt))).toBe(true);
    // 48s later the row has drifted to 1m — never frozen at "12s ago".
    expect(effectiveAgoMs(session, receipt, receipt + 48_000)).toBe(60_000);
    // 10 minutes into an outage it crosses the gate and the dot dims.
    const later = receipt + 10 * 60_000;
    expect(isFreshAge(effectiveAgoMs(session, receipt, later))).toBe(false);
  });

  it('effectiveAgoMs cannot inherit skew from an absolute server timestamp', async () => {
    const { effectiveAgoMs } = await import('../src/lib/mySessionsState');
    const now = Date.UTC(2026, 7, 4, 12, 0, 0);
    // Whether lastSeenAt is an epoch or ISO string, agoSeconds is the server's
    // already-computed age. Only local time since receipt advances it.
    expect(effectiveAgoMs(
      { agoSeconds: 5, lastSeenAt: now + 24 * 60 * 60_000 },
      now - 30_000,
      now,
    )).toBe(35_000);
    expect(effectiveAgoMs(
      { agoSeconds: 5, lastSeenAt: new Date(now - 24 * 60 * 60_000).toISOString() },
      now - 30_000,
      now,
    )).toBe(35_000);
    // No good read yet: the stated age is all we have.
    expect(effectiveAgoMs({ agoSeconds: 5 }, undefined, now)).toBe(5_000);
  });

  it('recognition copy claims presence only — no call capability, no configured/connected/ready — and never over a stale snapshot', () => {
    // Audit #7: a /vibe heartbeat proves neither vibeconf availability nor a
    // /join-call capability. The call claim returns only behind a receipt.
    const src = readFileSync(new URL('../src/lib/mySessionsState.ts', import.meta.url), 'utf8');
    expect(src).toContain("'this session shows up as you'");
    expect(src).not.toContain('it can come into calls with you');
    const listSrc = readFileSync(new URL('../src/components/UnifiedBuddyList.tsx', import.meta.url), 'utf8');
    // The recognition line renders only under kind === 'rows' (a now-claim),
    // never beside the stale line.
    expect(listSrc).toMatch(/sessionsBlock\.kind === 'rows' && \(\s*<div/);
  });

  it('the quiet room mounts the sessions block, and above the "Quiet in here" claim', () => {
    const src = readFileSync(new URL('../src/components/UnifiedBuddyList.tsx', import.meta.url), 'utf8');
    // ONE section serves the shared block element and the populated list —
    // a second markup copy is how surfaces drift apart.
    expect((src.match(/<MySessionsSection\s/g) || []).length).toBe(2);
    // The block decision precedes the room's quiet claim in the render.
    const blockAt = src.indexOf('mySessionsBlock(mySessionsProbe, mySessions.length)');
    const quietAt = src.lastIndexOf('Quiet in here');
    expect(blockAt).toBeGreaterThan(-1);
    expect(quietAt).toBeGreaterThan(blockAt);
    expect(src).toContain('{FIRST_RECOGNITION}');
  });

  it('a roster outage does not hide an independently verified sessions read', () => {
    const src = readFileSync(new URL('../src/components/UnifiedBuddyList.tsx', import.meta.url), 'utf8');
    // The can't-reach-/vibe branch renders the block when the my-sessions
    // read verified an answer — and keeps RETAINED rows on screen under a
    // failing read (with their stale line), so the zone count never points
    // at a hidden row (codex r2 P2 on #50).
    expect(src).toMatch(/\(mySessionsProbe === 'known' \|\| mySessions\.length > 0\) && sessionsBlockEl/);
  });

  it('App separates snapshot retention from certainty and resets both with identity', () => {
    const src = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    expect(src).toMatch(/setMySessionsProbe\(nextMySessionsProbe\(mySessionsResult\.error\)\)/);
    expect(src).toMatch(/setMySessionsProbe\('unasked'\)/);
    expect(src).toMatch(/setMySessionsObservedAt\(undefined\)/);
  });

  it('older platform responses without the truth-contract fields still work', async () => {
    const { buddyClient } = await import('../src/lib/vibeClient');
    const client = buddyClient as any;
    client.authToken = 'token';
    const localReceipt = Date.UTC(2026, 7, 4, 12, 0, 0);
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(localReceipt);
    // Pre-contract shape: ok + sessions, no observedAt, no per-session fields.
    client.authenticatedRequest = vi.fn(async () => ({
      ok: true,
      status: 200,
      data: { ok: true, sessions: [{ sessionId: 's1', cwd: '/x', project: 'x', status: 'active', agoSeconds: 3 }] },
    }));
    const legacy = await client.getMySessionsResult();
    expect(legacy.error).toBe(false);
    expect(legacy.sessions).toHaveLength(1);
    // The receipt anchor is still provided locally so rows can age.
    expect(legacy.observedAt).toBe(localReceipt);

    // Truth-contract shape: server timestamps never replace the local receipt
    // anchor, even when the two clocks are deliberately far apart.
    const stamped = '2026-08-05T12:00:00.000Z';
    client.authenticatedRequest = vi.fn(async () => ({
      ok: true,
      status: 200,
      data: { ok: true, observedAt: stamped, sessions: [] },
    }));
    const modern = await client.getMySessionsResult();
    expect(modern.error).toBe(false);
    expect(modern.observedAt).toBe(localReceipt);
    nowSpy.mockRestore();
  });
});

describe('"builders" means one thing on the board', () => {
  const src = readFileSync(new URL('../src/components/UnifiedBuddyList.tsx', import.meta.url), 'utf8');
  const sharedSrc = readFileSync(new URL('../src/components/list/shared.tsx', import.meta.url), 'utf8');

  it('nothing attaches a number to "builders" any more', () => {
    // The placeholder once said "Search 8 builders" from users.length (humans
    // AND agents) while the ambient line said "3 builders online right now"
    // (humans only) — one word, two counts, two lines apart. The count came
    // out of the placeholder first; the ambient line itself was deleted in
    // the ruthless pass, so the conflict has no surface left to recur on.
    const code = sharedSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/builders online right now/);
    expect(src).not.toMatch(/\$\{totalPeople\} builders/);
    expect(src).not.toMatch(/builders…/);
  });

  it('search copy names no population it cannot define', () => {
    expect(src).toMatch(/placeholder="Search the room…/);
    // The filter matches agents too, so the empty state cannot say builders.
    expect(src).not.toMatch(/No builders match/);
    expect(src).toMatch(/Nobody here matches/);
  });

  it('the box appears only when the list is genuinely unscannable', () => {
    // Eight rows can be read. `/` still opens search at any size, so the
    // threshold costs nothing below it.
    expect(src).toMatch(/const SEARCH_WORTH_IT = 20;/);
    // Counted over every searchable principal — thread senders need not be
    // in `users`, so users.length could sit at 8 with 20+ rows on screen,
    // hiding the box from a list bigger than its own threshold (codex P2).
    expect(src).toMatch(/const showSearch = searchablePrincipals\.size >= SEARCH_WORTH_IT;/);
    expect(src).toMatch(/\.\.\.waiting\.map\(\(t\) => t\.with\.toLowerCase\(\)\)/);
    expect(src).toMatch(/\.\.\.offlineThreads\.map\(\(t\) => t\.with\.toLowerCase\(\)\)/);
    // The threshold governs the BOX, never the capability: `/` was gated on
    // showSearch, so raising it would have removed search outright for a
    // room of 8-19 instead of merely hiding the control.
    expect(src).not.toMatch(/if \(!showSearch\) return;/);
    expect(src).toMatch(/setSearchRevealed\(true\)/);
    expect(src).toMatch(/\{\(showSearch \|\| searchRevealed \|\| query\) && \(/);
    // A live query keeps the box up, or filtering would hide the control
    // that is doing the filtering.
    expect(src).toMatch(/if \(searchRevealed\) searchRef\.current\?\.focus\(\);/);
  });
});

describe('there is no paired-hero card (ruthless pass 2026-08-15)', () => {
  // One bespoke treatment for one person was a second row type to maintain
  // and a second set of honesty rules to keep in sync — it needed its own
  // searchability fix, its own Enter-target fix and its own bound-session
  // keying, each found separately. With the list sorted by attention, your
  // partner rises on merit.
  const src = readFileSync(new URL('../src/components/UnifiedBuddyList.tsx', import.meta.url), 'utf8');

  it('the card is gone and nothing renders it', () => {
    expect(src).not.toMatch(/PairedHeroCard/);
    expect(src).not.toMatch(/heroMatches|showHero/);
  });

  it('the partner is no longer excluded from every lane', () => {
    // Every exclusion existed only to keep them out of the lists while the
    // hero owned them. Left in place, an unread message from your closest
    // collaborator would render NOWHERE.
    expect(src).not.toMatch(/u\.handle !== pairedWith/);
    expect(src).not.toMatch(/t\.with !== pairedWith/);
    expect(src).toMatch(/waitingThreads\(threads\)/);
  });
});

// (The 'landing page shot cannot go stale' suite guarded the release/ship
// scripts, which live in the private operations overlay — not in this
// public source repo. It was removed with them in the clean export.)

describe('orphan session rows are searchable rows (codex P2)', () => {
  const src = readFileSync(new URL('../src/components/UnifiedBuddyList.tsx', import.meta.url), 'utf8');

  it('the Sessions lane filters instead of vanishing on any query', () => {
    // The lane was gated on `!q`, so typing the exact name of a visible
    // session parent removed the row and reported "Nobody here matches".
    expect(src).toMatch(/const filteredOrphanSessions = q/);
    expect(src).toMatch(/\{filteredOrphanSessions\.length > 0 && \(/);
    expect(src).not.toMatch(/\{!q && sessions\.filter/);
  });

  it('they count toward the standing box and toward matches', () => {
    // Twenty orphan rows never earned a search box, and a matching row
    // rendered above "Nobody here matches".
    expect(src).toMatch(/\.\.\.orphanSessions\.map\(\(s\) => s\.parent\.toLowerCase\(\)\)/);
    expect(src).toMatch(/filteredOrphanSessions\.length === 0/);
    // Enter reaches them at their rendered position, and opens them the way
    // they open — onSession, not a DM they do not have (codex P2).
    expect(src).toMatch(/filteredOrphanSessions\[0\] \? \{ handle: filteredOrphanSessions\[0\]\.parent, session: true \}/);
    expect(src).toMatch(/if \(enterTarget\.session\) onSession\?\.\(enterTarget\.handle\)/);
    // Render order: the FOR YOU zone (waiting, then promoted bound-wanting
    // agents), Online, Sessions, Away, Agents, Recent.
    const order = ['filteredWaiting[0]', 'promotedAgents[0]', 'humanActive[0]',
      'filteredOrphanSessions[0]', 'humanAway[0]', 'laneAgents[0]', 'filteredOffline[0]']
      .map((k) => src.indexOf(k, src.indexOf('const enterTarget')));
    expect(order.every((i) => i > -1)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});

describe('the send box never names a transport (Telegram test)', () => {
  it('the compose warning speaks only in consequences', () => {
    // A reader must not need to know which bus a message rides to predict
    // what happens to it. Six mechanisms exist underneath; none may surface.
    const src = readFileSync(new URL('../src/components/DMPanel.tsx', import.meta.url), 'utf8');
    // Anchored on the composer block's own opening condition — the thread
    // HEADER now also reads reachability (buddy#53 served words), so the
    // first bare occurrence of the enum is no longer this block.
    const warningStart = src.indexOf(
      "(them?.reachability === 'broadcast-only' || (them ? hasNoReadEvidence(them) : false))",
    );
    // Stop at the end of the warning itself. The old slice ran through the
    // entire composer and interpreted unrelated later conditionals as a
    // warning fallback — a static guard proving the shape of adjacent UI,
    // not the contract it names.
    const compose = src.slice(
      warningStart,
      src.indexOf('{/* ── FOUNDER MIND', warningStart),
    );
    expect(compose.length).toBeGreaterThan(200);
    // Comments are stripped first: the ban is on what RENDERS, and the
    // comment above the block legitimately uses these words to explain the
    // ban itself. Scanning them would forbid documenting the rule.
    const rendered = compose.replace(/\/\*[^]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // Named SYSTEMS are banned. "queue" as a verb is not — "yours will queue
    // until it does" is the consequence, which is exactly what we want said.
    for (const word of [/session-guest/i, /\bKV\b/, /wire protocol/i, /AIRC/, /Postgres/i, /\bSSE\b/, /\bbus\b/]) {
      expect(rendered).not.toMatch(word);
    }
    // ...and it does say the consequence.
    expect(compose).toMatch(/yours will queue\s+until it does/);
    // Exactly one notice for the unread state — the duplicate is gone.
    expect((src.match(/hasn't been reading messages here/g) || []).length).toBe(1);

    // Each line stands on its own evidence — no ternary fallback between the
    // two warnings, which once let one condition render the other's copy.
    expect(compose).toMatch(/hasNoReadEvidence\(them\) && them\.reachability !== 'broadcast-only'/);
    expect(compose).not.toMatch(/\) : \(/);
    // NO LATENCY. Removed from the initial product: optional, privacy-
    // sensitive, hard to phrase honestly (four review rounds and it still
    // hid response RATE), and it does not help anyone send a message.
    expect(compose).not.toMatch(/latency/i);
  });
});
