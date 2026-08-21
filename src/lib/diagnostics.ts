// G6 — a broken install must be debuggable.
//
// A quiet app's user does not file a bug; they drift away. When they DO reach
// out, "what version are you on / is it syncing / what did the error say" is a
// conversation neither side can win from memory. This assembles that answer
// once, from state Buddy already holds — and shows it to the user in full
// before it goes anywhere, because presence consent is not diagnostics consent
// (the same law that governs the roster governs this).
//
// The hard rule: this report carries operational state, NEVER content. No
// message bodies, no roster, no coding-session text, no tokens. The breadcrumb
// buffer below is the one place free-form strings enter, so it redacts
// credential-shaped substrings and truncates — and the formatter states, in
// the report itself, exactly what is and isn't inside, so the person deciding
// to send it is deciding on the real thing.

const MAX_BREADCRUMBS = 30;
const BREADCRUMB_MAX_LEN = 240;

/** What every report contains — shown to the user verbatim, so consent is informed. */
export const REPORT_INCLUDES = [
  'the Buddy version, your OS, and your own handle',
  'how long since Buddy last synced, and whether its live connection is up',
  'the last update check and any failed install',
  "whether the coding-agent connector (MCP) is installed",
  'recent error messages from Buddy itself (never message text)',
] as const;

/** What a report NEVER contains — the same list, as a promise. */
export const REPORT_EXCLUDES = [
  'the contents of any message, DM, or thread',
  'who is on your roster',
  'anything from your coding sessions',
  'passwords, tokens, or auth secrets',
] as const;

export interface Breadcrumb {
  /** ISO timestamp. */
  at: string;
  level: 'error' | 'warn';
  /** Redacted, truncated. First argument of the console call only. */
  text: string;
}

// Module-level ring buffer. Bounded so a long-running app can't grow it without
// limit, and so the report stays short enough for a human to actually read.
const breadcrumbs: Breadcrumb[] = [];

/**
 * Strip credential-shaped substrings from free text before it can be retained.
 * JWTs (three base64url segments) and long hex/base64 blobs are the shapes a
 * token takes; a diagnostic string should never carry one, but an error that
 * echoes a request is exactly where one could leak.
 */
export function redact(text: string): string {
  return text
    // URL query VALUES first — these carry peer/session handles
    // (`.../messages?user=alice&with=bob`), which the report promises it does
    // NOT include. Keep the param names (they're useful, and not identifying),
    // drop every value. Must run before the token rules so a token in a query
    // value is caught here rather than surviving as a short value.
    .replace(/([?&][A-Za-z0-9_.\-]+=)[^&\s#"']+/g, '$1[redacted]')
    // JWT: header.payload.signature, each base64url
    .replace(/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[redacted-token]')
    // bare long hex (session secrets, hashes) or base64url blobs
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, '[redacted]')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[redacted]');
}

function pushBreadcrumb(level: 'error' | 'warn', text: string): void {
  breadcrumbs.push({
    at: new Date().toISOString(),
    level,
    text: redact(text).slice(0, BREADCRUMB_MAX_LEN),
  });
  while (breadcrumbs.length > MAX_BREADCRUMBS) breadcrumbs.shift();
}

/** Record a breadcrumb directly (for known call sites that want a clean tag). */
export function recordBreadcrumb(level: 'error' | 'warn', text: string): void {
  if (text && typeof text === 'string') pushBreadcrumb(level, text);
}

export function getBreadcrumbs(): readonly Breadcrumb[] {
  return breadcrumbs.slice();
}

export function clearBreadcrumbs(): void {
  breadcrumbs.length = 0;
}

let consoleCaptured = false;

/**
 * Wrap console.error/warn ONCE so real failures become breadcrumbs without
 * every call site having to opt in. Only the first argument is retained (the
 * message; structured detail is dropped, since that's where content hides), and
 * it goes through redact(). The original console behavior is preserved — this
 * observes, it does not replace.
 */
export function installConsoleCapture(consoleObj: Pick<Console, 'error' | 'warn'> = console): void {
  if (consoleCaptured) return;
  consoleCaptured = true;
  for (const level of ['error', 'warn'] as const) {
    const original = consoleObj[level].bind(consoleObj);
    consoleObj[level] = (...args: unknown[]) => {
      try {
        const first = args.length ? args[0] : '';
        pushBreadcrumb(level, typeof first === 'string' ? first : String(first));
      } catch { /* capturing a breadcrumb must never break logging */ }
      original(...args);
    };
  }
}

export interface DiagnosticsInput {
  handle: string | null;
  appVersion: string;
  os: string;
  /**
   * ABSOLUTE ms timestamp of the last successful sync, or null if never. Stored
   * absolute (not an age) so the age is computed at format time — a snapshot
   * retained for a crash 30 minutes later must not report a 30-minute-old sync
   * as fresh (codex G6 re-review).
   */
  lastSyncSuccessAt: number | null;
  /** Buddy's live (SSE) connection state, or null if unknown. */
  liveConnected: boolean | null;
  /** From loadUpdateCheck(): last time we asked about updates and the answer. */
  lastUpdateCheck: { at: string; outcome: string; currentVersion?: string } | null;
  /** From loadUpdateFailureEvidence(): the last failed install, if any. */
  lastUpdateFailure: { id: string; at: string; phase: string; error: string } | null;
  /** Whether the MCP connector is installed, or null if not checked. */
  mcpInstalled: boolean | null;
  /**
   * Whether handle/sync state is actually KNOWN. Default true. The crash path
   * (ErrorBoundary with no retained snapshot) sets this false so the formatter
   * says "unknown" instead of reading null as "signed out / never synced" —
   * those would be false facts in exactly the report meant to diagnose a crash
   * (never claim an unverified state, CLAUDE.md).
   */
  stateKnown?: boolean;
}

// The last diagnostics snapshot the live app published, kept at module scope so
// it survives an App unmount. The ErrorBoundary reads it to build a crash
// report from real last-known state rather than nulls. Cleared on identity
// teardown so a crash after sign-out can't attribute one account's state to the
// next (codex G6 re-review).
let lastSnapshot: DiagnosticsInput | null = null;
export function publishDiagnosticsSnapshot(input: DiagnosticsInput): void {
  lastSnapshot = input;
}
export function getLastDiagnosticsSnapshot(): DiagnosticsInput | null {
  return lastSnapshot;
}
export function clearDiagnosticsSnapshot(): void {
  lastSnapshot = null;
}

export interface DiagnosticReport extends DiagnosticsInput {
  /** Short human-shareable id so a report can be referenced in a reply. */
  id: string;
  /** ISO timestamp the report was built. */
  at: string;
  breadcrumbs: readonly Breadcrumb[];
}

/**
 * A short id that a human can read over a call ("report bd-4f2a"). Derived from
 * the timestamp; two reports a second apart differ. No randomness dependency —
 * `seed` lets callers keep it deterministic (and testable).
 */
export function reportId(seed = Date.now()): string {
  return 'bd-' + (seed % 0xffffff).toString(16).padStart(6, '0');
}

export function buildDiagnosticReport(
  input: DiagnosticsInput,
  now = Date.now(),
): DiagnosticReport {
  return {
    ...input,
    id: reportId(now),
    at: new Date(now).toISOString(),
    breadcrumbs: getBreadcrumbs(),
  };
}

function agoLine(sinceMs: number | null, nowMs: number): string {
  if (sinceMs == null) return 'never synced this session';
  const s = Math.max(0, Math.round((nowMs - sinceMs) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

/**
 * The report as plain text the user reads and sends. The Included/Not-included
 * inventory is part of the text on purpose: whoever receives it, and whoever
 * sends it, sees the same promise about its contents.
 */
export function formatDiagnosticReport(r: DiagnosticReport): string {
  // A crash with no retained snapshot can't assert identity or sync state —
  // null there means "lost in the crash", not "signed out / never synced".
  const known = r.stateKnown !== false;
  const nowMs = Date.parse(r.at);
  const lines: string[] = [
    `Vibe Buddy problem report ${r.id}`,
    `Time: ${r.at}`,
    '',
    `Buddy version: ${r.appVersion}`,
    `System: ${r.os}`,
    `Signed in as: ${known ? (r.handle ? '@' + r.handle : 'not signed in') : 'unknown'}`,
    `Last sync: ${known ? agoLine(r.lastSyncSuccessAt, nowMs) : 'unknown'}`,
    `Live connection: ${r.liveConnected == null ? 'unknown' : r.liveConnected ? 'up' : 'down'}`,
    // null = the native check is pending or failed, NOT a confirmed absence.
    `Connector (MCP): ${r.mcpInstalled == null ? 'unknown' : r.mcpInstalled ? 'installed' : 'not installed'}`,
  ];

  lines.push(
    // null covers "never checked" AND a malformed/unreadable record — say we
    // have no valid record rather than asserting it never happened.
    r.lastUpdateCheck
      ? `Last update check: ${r.lastUpdateCheck.outcome} at ${r.lastUpdateCheck.at}`
      : 'Last update check: no valid record',
  );
  if (r.lastUpdateFailure) {
    lines.push(
      `Last failed install: ${r.lastUpdateFailure.id} during ${r.lastUpdateFailure.phase} — ${r.lastUpdateFailure.error}`,
    );
  }

  lines.push('', `Recent Buddy errors (${r.breadcrumbs.length}):`);
  if (r.breadcrumbs.length === 0) {
    lines.push('  none recorded');
  } else {
    for (const b of r.breadcrumbs) lines.push(`  [${b.at}] ${b.level}: ${b.text}`);
  }

  lines.push('', 'This report includes:');
  for (const i of REPORT_INCLUDES) lines.push(`  - ${i}`);
  lines.push('It does NOT include:');
  for (const e of REPORT_EXCLUDES) lines.push(`  - ${e}`);

  return lines.join('\n');
}
