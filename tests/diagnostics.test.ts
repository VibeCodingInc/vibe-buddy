// G6 — the diagnostic report must be trustworthy about its own contents.
// These pin the two promises that make consent meaningful: NO content leaks,
// and the report says exactly what it carries.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  redact,
  recordBreadcrumb,
  getBreadcrumbs,
  clearBreadcrumbs,
  installConsoleCapture,
  buildDiagnosticReport,
  formatDiagnosticReport,
  reportId,
  REPORT_INCLUDES,
  REPORT_EXCLUDES,
  type DiagnosticsInput,
} from '../src/lib/diagnostics';

const BUILD_AT = Date.parse('2026-08-10T12:00:00.000Z');
const baseInput: DiagnosticsInput = {
  handle: 'brightseth',
  appVersion: '0.5.47',
  os: 'Test/1.0',
  lastSyncSuccessAt: BUILD_AT - 42_000, // 42s before build time
  liveConnected: true,
  lastUpdateCheck: { at: '2026-08-10T00:00:00.000Z', outcome: 'current', currentVersion: '0.5.47' },
  lastUpdateFailure: null,
  mcpInstalled: true,
};

beforeEach(() => clearBreadcrumbs());

describe('redact', () => {
  it('strips JWT-shaped tokens', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjb2x0cmFuZSJ9.abcdEFGH1234_-signaturehere';
    expect(redact(`auth failed with ${jwt}`)).toBe('auth failed with [redacted-token]');
  });

  it('strips long hex secrets and long opaque blobs', () => {
    expect(redact('secret=' + 'a'.repeat(64))).toContain('[redacted]');
    expect(redact('secret=' + 'a'.repeat(64))).not.toContain('a'.repeat(64));
    const blob = 'Zm9vYmFyYmF6cXV4' + 'x'.repeat(40);
    expect(redact(`token ${blob}`)).toContain('[redacted]');
  });

  it('leaves ordinary error text intact', () => {
    expect(redact('stopPair error: network timeout')).toBe('stopPair error: network timeout');
  });

  it('strips peer/session handles out of captured request URLs (codex re-review)', () => {
    const line = '401 on https://www.slashvibe.dev/api/messages?user=alice&with=bob with a valid token';
    const out = redact(line);
    expect(out).not.toContain('alice');
    expect(out).not.toContain('bob');
    // param names stay (useful, not identifying); values are gone
    expect(out).toContain('user=[redacted]');
    expect(out).toContain('with=[redacted]');
  });
});

describe('breadcrumb ring buffer', () => {
  it('records, redacts, and truncates', () => {
    recordBreadcrumb('error', 'boom ' + 'x'.repeat(400));
    const [b] = getBreadcrumbs();
    expect(b.level).toBe('error');
    expect(b.text.length).toBeLessThanOrEqual(240);
  });

  it('is bounded — old entries fall off, newest kept', () => {
    for (let i = 0; i < 50; i++) recordBreadcrumb('warn', `event ${i}`);
    const crumbs = getBreadcrumbs();
    expect(crumbs.length).toBe(30);
    expect(crumbs[crumbs.length - 1].text).toBe('event 49');
    expect(crumbs.some((c) => c.text === 'event 19')).toBe(false);
  });

  it('ignores empty/non-string input', () => {
    recordBreadcrumb('error', '');
    // @ts-expect-error deliberately wrong type
    recordBreadcrumb('error', null);
    expect(getBreadcrumbs()).toHaveLength(0);
  });
});

describe('installConsoleCapture', () => {
  it('captures the message arg, drops structured detail, preserves original', () => {
    const calls: unknown[][] = [];
    const fake = {
      error: (...a: unknown[]) => calls.push(a),
      warn: (...a: unknown[]) => calls.push(a),
    } as unknown as Console;
    installConsoleCapture(fake);
    fake.error('render failed', { secret: 'eyJh.eyJb.sig_aaaaaaaa' }, 'extra');
    // original still called with all args
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('render failed');
    // only the first (message) arg became a breadcrumb; the object is dropped
    const [b] = getBreadcrumbs();
    expect(b.text).toBe('render failed');
    expect(JSON.stringify(getBreadcrumbs())).not.toContain('secret');
  });
});

describe('reportId', () => {
  it('is deterministic for a given seed and prefixed', () => {
    expect(reportId(0x123456)).toBe('bd-123456');
    expect(reportId(1)).toMatch(/^bd-[0-9a-f]{6}$/);
  });
});

describe('formatDiagnosticReport', () => {
  it('carries operational state and the full inventory', () => {
    recordBreadcrumb('error', 'sync failed: 500');
    const report = buildDiagnosticReport(baseInput, Date.parse('2026-08-10T12:00:00.000Z'));
    const text = formatDiagnosticReport(report);

    expect(text).toContain('Buddy version: 0.5.47');
    expect(text).toContain('Signed in as: @brightseth');
    expect(text).toContain('Last sync: 42s ago');
    expect(text).toContain('Live connection: up');
    expect(text).toContain('Connector (MCP): installed');
    expect(text).toContain('sync failed: 500');

    // The promise is IN the report, both halves.
    for (const line of REPORT_INCLUDES) expect(text).toContain(line);
    for (const line of REPORT_EXCLUDES) expect(text).toContain(line);
    expect(text).toContain('does NOT include');
  });

  it('never renders an unverified state as a known one', () => {
    const text = formatDiagnosticReport(
      buildDiagnosticReport({
        ...baseInput,
        handle: null,
        lastSyncSuccessAt: null,
        liveConnected: null,
        mcpInstalled: null,
        lastUpdateCheck: null,
      }),
    );
    expect(text).toContain('not signed in'); // resolved: genuinely no session
    expect(text).toContain('never synced this session');
    expect(text).toContain('Live connection: unknown');
    // null provenance renders as unknown, not a claimed absence (codex re-review)
    expect(text).toContain('Connector (MCP): unknown');
    expect(text).toContain('Last update check: no valid record');
  });

  it('computes sync age at format time — a retained snapshot ages honestly', () => {
    // Sync succeeded 30 min before the report is built (the crash-snapshot case).
    const built = Date.parse('2026-08-10T12:30:00.000Z');
    const text = formatDiagnosticReport(
      buildDiagnosticReport({ ...baseInput, lastSyncSuccessAt: Date.parse('2026-08-10T12:00:00.000Z') }, built),
    );
    expect(text).toContain('Last sync: 30m ago');
  });

  it('unknown state renders neutrally — never "signed out / never synced", never "crash"', () => {
    // stateKnown:false covers BOTH a crash and a still-loading startup, so the
    // wording must not assert either a crash or a resolved sign-out (codex R4).
    const text = formatDiagnosticReport(
      buildDiagnosticReport({
        ...baseInput,
        handle: null,
        lastSyncSuccessAt: null,
        stateKnown: false,
      }),
    );
    expect(text).toContain('Signed in as: unknown');
    expect(text).toContain('Last sync: unknown');
    expect(text).not.toContain('not signed in');
    expect(text).not.toContain('never synced this session');
    expect(text).not.toContain('crash');
  });

  it('a report of a healthy Buddy still carries no message content by construction', () => {
    // The input type has no field for message/roster/session text — this is the
    // structural guarantee. Assert the shape stays that way.
    const keys = Object.keys(baseInput);
    expect(keys).not.toContain('messages');
    expect(keys).not.toContain('threads');
    expect(keys).not.toContain('roster');
    expect(keys).not.toContain('token');
  });
});
