// Session alerts — the half of the product that reaches out.
//
// Buddy shows which sessions want you; this tells you. The rules being pinned
// here are not polish, they are the whole difference between a smoke detector
// and a smoke detector somebody takes the battery out of:
//
//   transition, not state · silent baseline · quiet while you're looking ·
//   the click returns you to the WORK, not to Buddy.

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const sent: Array<{ title: string; body: string; extra?: Record<string, unknown> }> = [];

vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: async () => true,
  requestPermission: async () => 'granted',
  sendNotification: (n: never) => { sent.push(n as never); },
  registerActionTypes: async () => {},
  onAction: async () => {},
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: async () => {} }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({}) }));

const load = async () => {
  const mod = await import('../src/lib/notifications');
  await mod.hasNotificationPermission(); // establish the grant
  mod.resetSessionAlertState();
  return mod;
};

const s = (cwd: string, wantsYou: boolean) => ({
  cwd,
  label: cwd.split('/').pop() || cwd,
  wantsYou,
  line: wantsYou ? 'a Claude session in this folder finished its turn 2m ago' : null,
});

beforeEach(() => { sent.length = 0; });

describe('session alerts fire on the transition, not the state', () => {
  it('the first pass is a silent baseline — launching never announces a backlog', async () => {
    const n = await load();
    // Three sessions already waiting when Buddy starts. Zero notifications:
    // an app that shouts on launch teaches you to ignore it by lunchtime.
    const fired = n.checkSessionAlerts([s('/a', true), s('/b', true), s('/c', false)]);
    expect(fired).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('announces a crossing exactly once, however long it stays waiting', async () => {
    const n = await load();
    n.checkSessionAlerts([s('/a', false)]);          // baseline
    expect(n.checkSessionAlerts([s('/a', true)])).toBe(1);
    // Still waiting on the next four polls — still silent.
    expect(n.checkSessionAlerts([s('/a', true)])).toBe(0);
    expect(n.checkSessionAlerts([s('/a', true)])).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0].extra?.sessionCwd).toBe('/a');
    expect(sent[0].body).toContain('finished its turn');
  });

  it('re-announces only after the session has left the waiting state', async () => {
    const n = await load();
    n.checkSessionAlerts([s('/a', false)]);
    n.checkSessionAlerts([s('/a', true)]);           // 1st
    n.checkSessionAlerts([s('/a', false)]);          // answered
    expect(n.checkSessionAlerts([s('/a', true)])).toBe(1); // genuinely new
    expect(sent).toHaveLength(2);
  });

  it('stays quiet while the operator is looking at Buddy', async () => {
    const n = await load();
    n.checkSessionAlerts([s('/a', false)]);
    expect(n.checkSessionAlerts([s('/a', true)], true)).toBe(0);
    // ...and does not then fire late once the app loses focus: the state was
    // recorded, because they already saw it.
    expect(n.checkSessionAlerts([s('/a', true)], false)).toBe(0);
  });

  it('a session that disappears and returns is news again', async () => {
    const n = await load();
    n.checkSessionAlerts([s('/a', true)]);           // baseline
    n.checkSessionAlerts([]);                         // gone (closed / unjoinable)
    expect(n.checkSessionAlerts([s('/a', true)])).toBe(1);
  });

  it('carries the directory so the click can return to the work', async () => {
    const n = await load();
    n.checkSessionAlerts([s('/Users/yourname/Projects/uriel', false)]);
    n.checkSessionAlerts([s('/Users/yourname/Projects/uriel', true)]);
    expect(sent[0].title).toBe('uriel');
    expect(sent[0].extra?.sessionCwd).toBe('/Users/yourname/Projects/uriel');
  });
});

describe('missing evidence is not a state change (codex r1 P2)', () => {
  it('an unreadable session keeps its prior state and never re-announces', async () => {
    const n = await load();
    n.checkSessionAlerts([s('/a', false)]);
    n.checkSessionAlerts([s('/a', true)]);              // announced once
    expect(sent).toHaveLength(1);
    // The read fails: evidence unknown, NOT "no longer waiting".
    n.checkSessionAlerts([{ ...s('/a', true), wantsYou: null }]);
    // It comes back still waiting — nothing transitioned, so nothing fires.
    expect(n.checkSessionAlerts([s('/a', true)])).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it('a session Buddy may not read at all never alerts', async () => {
    const n = await load();
    n.checkSessionAlerts([{ ...s('/codex-row', true), wantsYou: null }]);
    expect(n.checkSessionAlerts([{ ...s('/codex-row', true), wantsYou: null }])).toBe(0);
    expect(sent).toHaveLength(0);
  });
});

describe('only an authoritative read may baseline (codex r1 P2)', () => {
  it('the empty pre-fetch snapshot cannot arm the detector', async () => {
    const n = await load();
    // App starts with [] and fetches asynchronously. If that empty array
    // baselines the system, the first REAL read announces the whole backlog.
    expect(n.checkSessionAlerts([], false, false)).toBe(0);
    // First authoritative read: three already waiting → still silent.
    expect(n.checkSessionAlerts([s('/a', true), s('/b', true)], false, true)).toBe(0);
    expect(sent).toHaveLength(0);
    // And a genuine crossing after that still fires.
    expect(n.checkSessionAlerts([s('/a', true), s('/b', true), s('/c', true)], false, true)).toBe(1);
  });
});

describe('the detector survives every view (codex r1 P1)', () => {
  const appSrc = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const listSrc = readFileSync(new URL('../src/components/UnifiedBuddyList.tsx', import.meta.url), 'utf8');

  it('detection lives in App, which is mounted in DM, session and compact views', () => {
    // It used to live in the buddy list, which unmounts on those routes — so
    // hiding Buddy on a DM screen silently stopped the alerts.
    expect(appSrc).toMatch(/checkSessionAlerts\(/);
    expect(appSrc).toMatch(/readSignals\(rows\)/);
    expect(listSrc).not.toMatch(/checkSessionAlerts\(/);
    expect(listSrc).not.toMatch(/readSignals\(/);
  });

  it('the board renders the same map the alerts fire from', () => {
    expect(appSrc).toMatch(/sessionSignals=\{sessionSignals\}/);
    expect(listSrc).toMatch(/sessionSignals \?\? new Map/);
  });

  it('alerts are silenced while the operator is looking at Buddy', () => {
    expect(appSrc).toMatch(/document\.hasFocus\(\)/);
  });

  it('session notifications carry no reply field — there is nobody to reply to', () => {
    const src = readFileSync(new URL('../src/lib/notifications.ts', import.meta.url), 'utf8');
    const fn = src.match(/export function checkSessionAlerts[^]*?\n\}/)?.[0] ?? '';
    // Delivery goes through the shared wrapper now (buddy#39); the invariant
    // is unchanged — a session banner is kind 'session' and never asks for
    // the reply field, because there is nobody on the other end of one.
    expect(fn).toContain("kind: 'session'");
    expect(fn).not.toContain('reply: true');
    expect(fn).not.toContain('DM_ACTION_TYPE');
  });
});

describe('the outage guard and the baseline are per-person (codex r7 P2)', () => {
  const appSrc = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');

  it('signing out clears both, so the next account does not inherit a baseline', () => {
    // `everKnown` is a ref, so it outlived sign-out: the next identity
    // inherited "a read has succeeded", the empty post-teardown list counted
    // as authoritative, and B's entire backlog announced as fresh
    // transitions on their first real read.
    expect(appSrc).toMatch(/resetSessionAlertState\(\);\s*\n\s*everKnown\.current = false;/);
    expect(appSrc).toMatch(/import \{ checkSessionAlerts, resetSessionAlertState, setNotificationOwner \}/);
  });

  it("'unasked' never runs the detector — it is the signed-out state too", () => {
    expect(appSrc).toMatch(/if \(mySessionsProbe === 'unasked'\) \{\s*\n\s*everKnown\.current = false;\s*\n\s*return;/);
  });

  it('an outage keeps reading local transcripts, but only after a good read', () => {
    // The platform failing says nothing about local transcript files; but a
    // FIRST read that fails must not baseline on the empty initial array.
    expect(appSrc).toMatch(/if \(mySessionsProbe === 'known'\) everKnown\.current = true;/);
    expect(appSrc).toMatch(/if \(!everKnown\.current\) return;/);
  });
});
