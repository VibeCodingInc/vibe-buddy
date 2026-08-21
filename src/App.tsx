import { useState, useEffect, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { buddyClient, type VibeUser, type VibeThread, type SessionEntity, type PairStatus, type MySession, type RecentTrace } from './lib/vibeClient';
import { nextMySessionsProbe, type MySessionsProbe } from './lib/mySessionsState';
import { getCodingDNA, dnaToPresencePayload } from './lib/contextExtractor';
import { getPresencePrefs, setPresencePrefs, subscribePresencePrefs, type PresencePrefs, type PresenceBroadcast, type OfflineRetraction } from './lib/presencePrefs';
import { readSignals, wantsYou, signalLine, transcriptJoinable, type SessionSignal } from './lib/transcript';
import { checkSessionAlerts, resetSessionAlertState, setNotificationOwner } from './lib/notifications';
import { listen } from '@tauri-apps/api/event';
import { resetArrivals } from './lib/notifications';
import { getRememberedCall, forgetCall, type RememberedCall } from './lib/callMemory';
import { joinLine } from './lib/vibeconf';
import {
  checkForUpdates,
  installUpdate,
  clearUpdateFailureEvidence,
  formatUpdateFailureEvidence,
  loadUpdateFailureEvidence,
  updateFailureEvidence,
  type UpdateFailureEvidence,
  type UpdateInfo,
  recordUpdateCheck,
  loadUpdateCheck,
  updateCheckIsStale,
  type UpdateCheckRecord,
} from './lib/updater';
import UnifiedBuddyList from './components/UnifiedBuddyList';
import DMPanel from './components/DMPanel';
import SessionPanel from './components/SessionPanel';
import { realtime } from './lib/realtime';
import { singleFlight } from './lib/singleFlight';
import { color, font, size, space, radius } from './lib/tokens';
import { resetNotificationState } from './lib/notifications';
import { resetProactiveState } from './lib/intelligence';
import { copyText } from './lib/clipboard';
import { ReportProblem } from './components/ReportProblem';
import {
  installConsoleCapture,
  publishDiagnosticsSnapshot,
  clearDiagnosticsSnapshot,
  clearBreadcrumbs,
  type DiagnosticsInput,
} from './lib/diagnostics';

// G6: start capturing Buddy's own errors into a bounded, redacted breadcrumb
// ring the moment the module loads — before the first failure, so a problem
// report can carry what led up to it. Idempotent; captures message text only,
// never structured detail (that's where content hides). See lib/diagnostics.
installConsoleCapture();

/**
 * Run `fn` on an interval, but never overlap with itself.
 *
 * Buddy's polling loops used to fire on a fixed timer regardless of whether the
 * previous call had returned. On a slow or dead network that means every tick
 * adds another in-flight request — roughly 58 requests/minute for a paired,
 * visible app, growing without bound while nothing settles. A skipped tick is
 * always better than a queue.
 *
 * Returns the same cleanup contract as setInterval so callers just swap it in.
 */
function guardedInterval(fn: () => Promise<unknown>, ms: number): () => void {
  let running = false;
  let cancelled = false;
  const tick = async () => {
    if (running || cancelled) return;
    running = true;
    try {
      await fn();
    } catch {
      // callers already swallow their own errors; never let a rejection
      // permanently wedge the loop
    } finally {
      running = false;
    }
  };
  const id = setInterval(tick, ms);
  return () => {
    cancelled = true;
    clearInterval(id);
  };
}

/**
 * The one notice slot.
 *
 * ROOM TONE: state a fact once, quietly. One notice at a time, no modal, no
 * begging badge, no shadow — depth is `panel` on `bg` with a 1px line. Green
 * is reserved for live presence, so it appears here only as the caller's dot;
 * every action button is blue, because actions are /vibe's, not presence.
 */
type NoticeAction = { label: string; onClick: () => void; primary?: boolean };
export type NoticeSpec = { kind: 'call' | 'warn' | 'info'; text: string; actions?: NoticeAction[] };

// How long data may go unrefreshed before we stop presenting it as current.
// The presence loop runs every 6s, so this is ~15 consecutive failures — long
// enough that a single blip or a slow cycle says nothing, short enough that a
// user staring at a dead roster learns the truth in about a minute.
const STALE_AFTER_MS = 90_000;

function formatAge(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${Math.max(1, mins)}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// Exported for the dev screenshot harness (src/dev) — one definition of the
// notice slot, rendered there with fixture specs instead of a replica.
export function Notice({ notice }: { notice: NoticeSpec | null }) {
  if (!notice) return null;
  return (
    <div
      style={{
        padding: `${space[2]}px ${space[3]}px`,
        background: color.panel,
        borderTop: `1px solid ${color.line}`,
        // Stack when there is more than one action.
        //
        // A row worked for "@rio is calling" with answer/decline. It collapses
        // for an error with three buttons: the buttons are flexShrink:0, so in
        // a 300px window the text column is squeezed to almost nothing and
        // `overflowWrap: anywhere` then wraps it ONE CHARACTER PER LINE. The
        // wrap fix I added to stop truncation caused that, which is a fair
        // trade of one unreadable failure mode for another.
        //
        // Stacking gives the message the full width and puts the buttons
        // underneath, where three of them fit.
        display: 'flex',
        flexDirection: (notice.actions?.length ?? 0) > 1 ? 'column' : 'row',
        alignItems: (notice.actions?.length ?? 0) > 1 ? 'stretch' : 'center',
        justifyContent: 'space-between',
        gap: space[2],
        flexShrink: 0,
        fontFamily: font.mono,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: space[2], minWidth: 0, flex: 1 }}>
        {notice.kind === 'call' && (
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: color.green, // presence: someone is here, right now
              flexShrink: 0,
            }}
          />
        )}
        <span
          style={{
            fontSize: size[12],
            color: notice.kind === 'info' ? color.dim : color.ink,
            // Wrap rather than ellipsis. One line was fine for "@rio is
            // calling", but the notices that matter most are the ones that tell
            // you what went wrong and what to do — and those got cut mid-word,
            // so "update failed — download it from slashvibe.dev/join" arrived
            // as "update failed — download it from sla…". A recovery
            // instruction you cannot read is not a recovery instruction.
            overflowWrap: 'anywhere',
            lineHeight: 1.4,
          }}
        >
          {notice.text}
        </span>
      </div>
      {notice.actions && notice.actions.length > 0 && (
        <div style={{ display: 'flex', gap: space[1], flexShrink: 0, flexWrap: 'wrap' }}>
          {notice.actions.map((a) => (
            <button
              key={a.label}
              type="button"
              onClick={a.onClick}
              style={{
                background: a.primary ? color.blue : 'transparent',
                border: `1px solid ${a.primary ? color.blue : color.line}`,
                borderRadius: radius.sm,
                padding: `${space[1]}px ${space[2]}px`,
                color: a.primary ? color.bg : color.dim,
                fontSize: size[11],
                fontFamily: font.mono,
                cursor: 'pointer',
              }}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Wake detection. A tick this far behind schedule means the machine slept.
// 30s cadence keeps the check cheap; a 2-minute gap is far longer than any
// normal timer jitter or throttling, and well under the 30-minute presence
// TTL, so we reconnect before anyone sees us go dark.
const WAKE_TICK_MS = 30_000;
const WAKE_GAP_MS = 120_000;

type McpStatus = {
  installed: boolean;
  npx_available: boolean;
  config_path: string | null;
  hosts?: string[]; // agents with /vibe configured: Claude Code, Codex, Cursor
};

type View =
  | { type: 'list' }
  | { type: 'dm'; chatWith: string }
  | { type: 'session'; targetHandle: string };

export default function App() {
  const [handle, setHandle] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loggingIn, setLoggingIn] = useState(false);
  // If the browser round-trip never completes (user closed the tab, OAuth
  // stalled), stop showing an indefinite "Waiting for browser..." and offer
  // a retry instead of a dead-ended spinner.
  const [loginTimedOut, setLoginTimedOut] = useState(false);
  // Why auth stopped before the signed-in UI. Keep expiry distinct from
  // transport/plugin failure: only the former supports "your session expired".
  const [authFailure, setAuthFailure] = useState<'expired' | 'unavailable' | 'login' | null>(null);
  const [view, setView] = useState<View>({ type: 'list' });
  const [users, setUsers] = useState<VibeUser[]>([]);
  const [sessions, setSessions] = useState<SessionEntity[]>([]);
  const [mySessions, setMySessions] = useState<MySession[]>([]);
  // Certainty of the LATEST my-sessions read, kept apart from the retained
  // snapshot above — a failed read means "can't currently see", even when
  // last-good rows stay on screen. Transitions live in lib/mySessionsState.
  const [mySessionsProbe, setMySessionsProbe] = useState<MySessionsProbe>('unasked');
  // When the last GOOD read was received — the anchor retained rows age from.
  const [mySessionsObservedAt, setMySessionsObservedAt] = useState<number | undefined>(undefined);
  // Distinguish "couldn't reach /vibe" from "nobody's online" so the empty
  // state can show the right message instead of always claiming it's quiet.
  const [presenceError, setPresenceError] = useState(false);
  // Who was here recently. Kept apart from `users` on purpose — see RecentTrace.
  const [recentlyHere, setRecentlyHere] = useState<RecentTrace[]>([]);
  // Self-canary. A quiet app has to notice it is broken before the user does,
  // because the user never will — they do not file a bug, they drift away.
  // `presenceError` only ever surfaced in the empty-state branch, so once a
  // roster was on screen a failing sync was invisible: stale data rendered as
  // current, indefinitely. Track when we last learned anything true, and say so
  // when that stops being recent.
  const [lastSyncAt, setLastSyncAt] = useState<number>(() => Date.now());
  const [clockTick, setClockTick] = useState<number>(() => Date.now());
  const [threads, setThreads] = useState<VibeThread[]>([]);
  // Mirrors `threads` for reads inside the poll closure. On a failed fetch the
  // tray must keep showing the last-known unread count rather than dropping to
  // zero, and the closure cannot see the current state value.
  const threadsRef = useRef<VibeThread[]>([]);
  threadsRef.current = threads;
  // Same reason as threadsRef: on a failed presence read the tray must keep the
  // last-known online count (the list retains its rows), not drop to a false
  // zero — and the poll closure cannot see the current `users` state value.
  const usersRef = useRef<VibeUser[]>([]);
  usersRef.current = users;
  const [compact, setCompact] = useState(false);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  // Only set by an explicit user-initiated check. A background check that finds
  // nothing must stay silent; a check the user ASKED for must always answer, or
  // the menu item reads as broken.
  const [upToDate, setUpToDate] = useState<string | null>(null);
  const updateStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showUpdateStatus = useCallback((status: string | null, clearAfter?: number) => {
    if (updateStatusTimerRef.current) clearTimeout(updateStatusTimerRef.current);
    updateStatusTimerRef.current = null;
    setUpToDate(status);
    if (status && clearAfter) {
      updateStatusTimerRef.current = setTimeout(() => {
        setUpToDate(null);
        updateStatusTimerRef.current = null;
      }, clearAfter);
    }
  }, []);
  // What the install is doing right now. Without this the button is a dead
  // rectangle for the length of a 10MB download.
  const [installing, setInstalling] = useState<string | null>(null);
  // The call you started, so closing the toast does not lose the link. A fact
  // about what YOU did — never a claim that the room is still live, which Buddy
  // has no way to know.
  const [lastCall, setLastCall] = useState<RememberedCall | null>(null);
  const [joinCopied, setJoinCopied] = useState(false);
  const [lastCheck, setLastCheck] = useState<UpdateCheckRecord | null>(() => loadUpdateCheck());
  const [callCopied, setCallCopied] = useState(false);
  const [updateFailure, setUpdateFailure] = useState<UpdateFailureEvidence | null>(
    () => loadUpdateFailureEvidence()
  );
  const [updateFailureCopy, setUpdateFailureCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [mcpStatus, setMcpStatus] = useState<McpStatus | null>(null);
  const [mcpDismissed, setMcpDismissed] = useState(false);
  // G6: the problem-report panel. A frozen diagnostics snapshot, captured the
  // moment the panel opens (null when closed) — so the text the user reviews is
  // the exact text the buttons send, even as the app keeps polling underneath.
  const [reportInput, setReportInput] = useState<DiagnosticsInput | null>(null);
  // Buddy's own version and the real OS string, for the diagnostic report.
  const [appVersion, setAppVersion] = useState<string>('unknown');
  const [osInfo, setOsInfo] = useState<string>('unknown');
  // A SUCCESSFUL-sync timestamp, distinct from lastSyncAt (which seeds to
  // launch time for the self-canary's age math). This starts null and only
  // advances on a clean read, so a report from an app that has never synced
  // says exactly that instead of claiming a sync at startup (codex G6 P1).
  const [lastSyncSuccessAt, setLastSyncSuccessAt] = useState<number | null>(null);

  // Check MCP status after login
  useEffect(() => {
    if (!handle) return;
    invoke<McpStatus>('check_mcp_status').then(setMcpStatus).catch(() => {});
  }, [handle]);

  // Read the running version and the real OS once, for the problem report.
  // navigator.userAgent lies in WKWebView (frozen "Mac OS X 10_15_7"), so the
  // OS comes from a native command instead (codex G6 P2).
  useEffect(() => {
    import('@tauri-apps/api/app')
      .then((m) => m.getVersion())
      .then(setAppVersion)
      .catch(() => {});
    invoke<string>('get_os_info').then(setOsInfo).catch(() => {});
  }, []);

  // The diagnostics snapshot. Built from state Buddy already holds, at the
  // instant the report is requested.
  const diagnosticsInput = useCallback((): DiagnosticsInput => {
    const uc = loadUpdateCheck();
    const uf = loadUpdateFailureEvidence();
    return {
      handle: handle ?? null,
      appVersion,
      os: osInfo,
      // Absolute timestamp — the report computes age at format time, so a
      // snapshot retained for a later crash ages honestly.
      lastSyncSuccessAt,
      liveConnected: realtime.isLiveConnected(),
      lastUpdateCheck: uc ? { at: uc.at, outcome: uc.outcome, currentVersion: uc.currentVersion } : null,
      lastUpdateFailure: uf ? { id: uf.id, at: uf.at, phase: uf.phase, error: uf.error } : null,
      mcpInstalled: mcpStatus ? mcpStatus.installed : null,
      // A null handle only means "signed out" when we actually KNOW that.
      // During bootstrap (loading) auth hasn't resolved; and when auth failed to
      // VERIFY (authFailure 'unavailable' — "couldn't verify your sign-in"),
      // identity is genuinely unknown, not absent. Either way, don't let the
      // report assert "not signed in" (codex G6 R4). 'expired'/'login' are real
      // signed-out states, so they leave known true.
      stateKnown: !loading && authFailure !== 'unavailable',
    };
  }, [handle, appVersion, osInfo, lastSyncSuccessAt, mcpStatus, loading, authFailure]);

  // Keep a fresh diagnostics snapshot at module scope, so a crash that unmounts
  // App still has real last-known state for its report (ErrorBoundary reads it).
  // Republishes on input changes AND on a short interval — the live connection
  // (realtime.sseConnected) and failed polls change OUTSIDE React, so a
  // change-only publish would let a crash during an SSE outage report a stale
  // "up" (codex G6 R4). The interval bounds snapshot staleness to a few seconds.
  useEffect(() => {
    publishDiagnosticsSnapshot(diagnosticsInput());
    const t = setInterval(() => publishDiagnosticsSnapshot(diagnosticsInput()), 5000);
    return () => clearInterval(t);
  }, [diagnosticsInput]);

  // Report a Problem… — opened from the native menu (Rust emits the event so
  // it works from the tray with the window hidden). Snapshot diagnostics here,
  // and leave compact mode: the report panel can't render in a 56px strip, and
  // "my window is a sliver and nothing works" is a state people report from.
  useEffect(() => {
    const un = listen('report-problem', () => {
      if (compact) { setCompact(false); resizeWindow(320, 500); }
      setReportInput(diagnosticsInput());
    });
    return () => { void un.then((f) => f()); };
  }, [compact, diagnosticsInput]);

  // Open at login — enabled ONCE, on first sign-in, because a presence app
  // that disappears on reboot stops being presence (your dot goes dark and
  // you're the only one who doesn't know). This is disclosed on the sign-in
  // screen before the click, and it's one click to undo from the tray menu.
  // The flag means we never re-enable it after someone turns it off.
  useEffect(() => {
    if (!handle) return;
    try {
      if (localStorage.getItem('buddy_autostart_offered') === '1') return;
      localStorage.setItem('buddy_autostart_offered', '1');
    } catch {
      return; // no storage → don't risk re-enabling on every launch
    }
    invoke('set_autostart', { enabled: true }).catch(() => {});
  }, [handle]);

  /**
   * Wipe everything scoped to WHO is signed in.
   *
   * Called synchronously when sign-out starts, before any network work. Two
   * jobs: stop the producers (every polling effect is keyed on `handle`, so
   * dropping it halts them at once) and make sure the next account cannot
   * inherit this one's roster, threads, pair state, or notification baselines.
   *
   * `buddyClient` keeps its own handle/token until its logout() finishes, so
   * the server-side retractions still authenticate correctly after this runs.
   */
  const clearIdentityState = useCallback(() => {
    resetArrivals();
    setUsers([]);
    setRecentlyHere([]);
    setSessions([]);
    setMySessions([]);
    setMySessionsProbe('unasked');
    setMySessionsObservedAt(undefined);
    setThreads([]);
    setPresenceError(false);
    setPairStatus({ paired: false });
    setMyBroadcast(null);
    setPresenceLastLandedAt(null);
    // The offline receipt is per-person: account B must not inherit A's
    // "Invisible" claim, and a retraction still in flight for A must not
    // resolve into B's card (codex P2 on the audit-#6 fix). Bumping the
    // generation orphans any pending goOffline resolution.
    offlineRetractionGen.current += 1;
    setOfflineRetraction(null);
    // Notification/intelligence baselines are per-person: without this the
    // next account inherits the previous one's unread counts and "welcomed"
    // set, so their first real DM can arrive silently.
    resetNotificationState();
    resetProactiveState();
    // Session alerts and the outage guard are per-person too. `everKnown`
    // is a ref, so it outlived sign-out: the next identity would inherit
    // "a read has succeeded", and the empty post-teardown list would be
    // treated as authoritative — baselining on nothing, then announcing B's
    // entire backlog as fresh transitions on their first real read
    // (codex r7 P2).
    resetSessionAlertState();
    everKnown.current = false;
    // Diagnostics are principal-scoped too: without this, a failed first fetch
    // on the NEXT account would pair its handle with the PREVIOUS account's
    // sync time and snapshot, making B's connection look healthy on A's data
    // (codex G6 re-review). Clear both the success timestamp and the retained
    // crash snapshot on teardown.
    setLastSyncSuccessAt(null);
    clearDiagnosticsSnapshot();
    // Breadcrumbs are the one free-text channel in a report; account A's
    // captured errors (which can carry A-specific text) must not surface in
    // account B's report after a sign-out/sign-in without restart (codex G6 R4).
    clearBreadcrumbs();
    invoke('set_tray_status', { online: 0, unread: 0 }).catch(() => {});
    invoke('set_dock_badge', { count: 0 }).catch(() => {});
  }, []);

  const handleRetryMcp = useCallback(async () => {
    try {
      const result = await invoke<{ success: boolean; message: string }>('install_mcp');
      if (result.success) {
        const status = await invoke<McpStatus>('check_mcp_status');
        setMcpStatus(status);
      }
    } catch (e) { console.warn('MCP retry error:', e); }
  }, []);

  // Auto-dismiss MCP banner after 10s if installed
  useEffect(() => {
    if (mcpStatus?.installed) {
      const timer = setTimeout(() => setMcpDismissed(true), 10000);
      return () => clearTimeout(timer);
    }
  }, [mcpStatus?.installed]);

  // Check for updates on mount AND on a schedule.
  //
  // Mount-only was effectively "never" for this app: Buddy opens at login and
  // lives in the menu bar for weeks, so a user who does not quit never learns a
  // release exists. Combined with there being no manual check anywhere in the
  // UI, an install could sit frozen on a buggy build indefinitely — which is
  // the version of this bug that matters, because the people least likely to
  // quit an ambient app are exactly the ones we are about to invite.
  const runUpdateCheckRef = useRef<() => void>(() => {});
  const runUpdateCheck = useCallback((manual = false) => {
    if (manual) showUpdateStatus('checking');
    checkForUpdates()
      .then(info => {
        // A failure record survives restart so it can be reported later, but
        // it must not accuse a newer build after a manual install succeeded.
        setUpdateFailure(previous => {
          if (
            previous &&
            info.currentVersion &&
            (previous.targetVersion === info.currentVersion ||
              (previous.currentVersion && previous.currentVersion !== info.currentVersion))
          ) {
            clearUpdateFailureEvidence();
            return null;
          }
          return previous;
        });
        // Record that we ASKED, whatever the answer. Without this, a Buddy that
        // never checked looks exactly like one that checked and was current —
        // and when no coding session is running, Buddy is the only thing that
        // could have noticed.
        recordUpdateCheck({
          at: new Date().toISOString(),
          outcome: info.error ? 'error' : info.available ? 'available' : 'current',
          currentVersion: info.currentVersion,
        });
        setLastCheck(loadUpdateCheck());
        if (info.available) {
          setUpdate(info);
          if (manual) showUpdateStatus(null);
          return;
        }
        // A completed "no update" check supersedes an older offer. An error
        // does not: it learned nothing, so the last known offer stays.
        if (!info.error) setUpdate(null);
        if (manual) {
          // Answer the question that was asked — silence would look identical
          // to a broken menu item. And say which answer it is: "we asked and
          // you are current" is a different fact from "we could not ask".
          showUpdateStatus(info.error ? 'offline' : (info.currentVersion || 'current'), 6000);
        }
      })
      .catch(() => {
        if (manual) {
          showUpdateStatus('offline', 6000);
        }
      });
  }, [showUpdateStatus]);

  runUpdateCheckRef.current = runUpdateCheck;

  useEffect(() => {
    runUpdateCheck();
    // Six hours: frequent enough that a fix ships within a day even to someone
    // who never restarts, rare enough to be invisible.
    const t = setInterval(() => runUpdateCheck(), 6 * 60 * 60 * 1000);
    return () => clearInterval(t);
  }, [runUpdateCheck]);

  // "Check for Updates…" in the tray menu.
  useEffect(() => {
    const un = listen('check-updates', () => runUpdateCheck(true));
    return () => { un.then(f => f()).catch(() => {}); };
  }, [runUpdateCheck]);

  // Consolidated presence + threads polling. Adaptive + event-driven so the
  // green dot feels live instead of lurching on a 10s heartbeat:
  //  - snappy (4s) while the window is visible, relaxed (20s) when hidden
  //  - instant refresh the moment the user returns to the window
  //  - instant refresh on SSE live/live-ended (wired in the SSE effect below)
  const fetchAllRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (!handle) return;
    let cancelled = false;

    const fetchAll = singleFlight(async () => {
      const [presenceData, threadResult, mySessionsResult] = await Promise.all([
        buddyClient.getOnlineUsers(),
        buddyClient.getThreadListResult(),
        buddyClient.getMySessionsResult(),
      ]);
      if (cancelled) return;
      // Only overwrite the roster on a good read. A failed presence fetch
      // returns an empty list with error:true — clobbering the last-known
      // roster with [] would make a network blip look like everyone left.
      if (!presenceData.error) {
        setUsers(presenceData.users);
        setSessions(presenceData.sessions);
        setRecentlyHere(presenceData.recentlyHere || []);
      }
      setPresenceError(!!presenceData.error);
      // Same rule as the roster above, which threads did not follow: only
      // overwrite on a good read. A failed fetch used to commit [] as truth, so
      // a network blip emptied the Recent list and zeroed the tray unread count
      // — the user watched their conversations vanish and had no reason to
      // think it was the network.
      if (!threadResult.error) {
        setThreads(threadResult.threads);
      }
      // Only a clean read counts. A half-good cycle still means some of what is
      // on screen is stale, and the point of this signal is to stop presenting
      // stale data as current.
      if (!presenceData.error && !threadResult.error && !mySessionsResult.error) {
        const now = Date.now();
        setLastSyncAt(now);
        setLastSyncSuccessAt(now); // the one that a diagnostic report may trust
      }
      // Snapshot retention and certainty are SEPARATE: a failed read keeps
      // the last-good rows (a blip must not erase sessions the server never
      // said were gone) but the probe still drops to 'unchecked', so the UI
      // marks the rows stale instead of presenting them as current.
      if (!mySessionsResult.error) {
        setMySessions(mySessionsResult.sessions);
        setMySessionsObservedAt(mySessionsResult.observedAt);
      }
      setMySessionsProbe(nextMySessionsProbe(mySessionsResult.error));

      // The menu-bar glance. Buddy lives in the tray all day, so the tray
      // itself should answer "is anything happening?" without being opened —
      // that ambient read is what makes this a buddy list rather than a window.
      const unread = threadResult.error
        ? threadsRef.current.reduce((sum, t) => sum + (t.unread || 0), 0)
        : threadResult.threads.reduce((sum, t) => sum + (t.unread || 0), 0);
      // Mirror `unread` above: a failed presence read keeps the last-known
      // online count from the RETAINED roster (which the list still shows),
      // never a false zero. The count is the platform's own `active` status —
      // the same thing the Online SECTION counts — because the platform owns
      // presence and Buddy must not redefine it locally (AGENTS.md); the green
      // DOT's tighter freshness is a colour rule, not a headcount. Staleness
      // through an outage is carried by the list's "reconnecting · last synced"
      // copy, exactly as it is for the retained unread count.
      const roster = presenceData.error ? usersRef.current : presenceData.users;
      const online = roster.filter((u) => u.status === 'active' && u.handle !== handle).length;
      invoke('set_tray_status', { online, unread }).catch(() => {});
    });
    fetchAllRef.current = fetchAll;
    fetchAll();

    const FAST = 6000;
    let tick = 0;
    // guardedInterval, not setInterval: each generation issues three requests
    // with 15s deadlines against a 6s period, so on a slow network three
    // generations could be in flight at once and resolve out of order — a stale
    // response then overwrote fresher state. The guard skips a tick while the
    // previous one is still running.
    const interval = guardedInterval(() => {
      // Hidden: only fetch every 4th fast-tick (~24s) to save battery/network.
      if (document.visibilityState !== 'visible' && tick++ % 4 !== 0) return Promise.resolve();
      return fetchAll();
    }, FAST);

    const onVisible = () => {
      if (document.visibilityState === 'visible') fetchAll();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);

    return () => {
      cancelled = true;
      interval();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [handle]);

  // SSE connection — connect when authenticated, disconnect on logout
  useEffect(() => {
    if (!handle) return;
    realtime.init(handle);
    realtime.connectSSE();
    // When someone goes live / stops, refresh presence right away rather than
    // waiting for the next poll — the LIVE badge should pop instantly.
    realtime.setLiveCallback(() => fetchAllRef.current?.());
    return () => {
      realtime.setLiveCallback(null);
      realtime.stop();
    };
  }, [handle]);

  // Presence prefs (sharing on/off, detail level, custom status) + the last
  // broadcast actually sent — surfaced in the My Presence card so the user
  // always knows exactly what others see.
  const [presencePrefs, setPresencePrefsState] = useState<PresencePrefs>(() => getPresencePrefs());
  const [myBroadcast, setMyBroadcast] = useState<PresenceBroadcast | null>(null);
  // Whether any heartbeat has landed this session, and when. Deliberately NOT
  // cleared on a failed beat or on going invisible — "presence never landed"
  // and "presence landed, then stopped" are different facts (buddy#10), and
  // this is the record that tells them apart. Reset only with identity.
  const [presenceLastLandedAt, setPresenceLastLandedAt] = useState<number | null>(null);

  // ── The session detector ──────────────────────────────────────────────────
  // Lives in App because App is ALWAYS mounted. It used to sit inside the
  // buddy list, which unmounts in DM, session and compact views — so hiding
  // Buddy on any of those screens silently stopped the one feature that
  // reaches out (codex r1 P1). The alerts and the board read the same map.
  const [sessionSignals, setSessionSignals] = useState<Map<string, SessionSignal>>(new Map());
  // Has a my-sessions read EVER succeeded? Gates local signal polling during
  // an outage: retained rows are worth re-reading, an empty pre-fetch array
  // is not (codex r6 P2).
  const everKnown = useRef(false);
  const [detectorTick, setDetectorTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setDetectorTick((n) => n + 1), 45_000);
    return () => clearInterval(t);
  }, []);
  const detectorKey = mySessions.map((s) => s.cwd).join('|');
  useEffect(() => {
    // Only an authoritative read may baseline or announce: App starts with an
    // empty array, and treating that pre-fetch snapshot as truth would make
    // the first real read look like a wave of new transitions.
    // 'unchecked' means the PLATFORM read failed — it says nothing about the
    // transcripts, which are local files this machine can still read. Bailing
    // here froze the whole signal map behind an unrelated network failure, so
    // an answered turn stayed on screen as "your turn", at a frozen age, until
    // the API recovered (codex r5 P2). The retained rows still name real
    // directories; keep reading them.
    //
    // But ONLY once a good read has actually happened. If the very first
    // request fails, the probe is 'unchecked' while `mySessions` is still the
    // initial empty array — running then would baseline the alert detector on
    // nothing, and every session in the first successful response would look
    // like a fresh transition and fire at once (codex r6 P2). A silent app
    // that suddenly shouts a backlog is the exact failure the baseline rule
    // exists to prevent.
    // 'unasked' is both the pre-fetch state AND the state after sign-out.
    // Either way there is nothing to read and nothing that may baseline.
    if (mySessionsProbe === 'unasked') {
      everKnown.current = false;
      return;
    }
    if (mySessionsProbe === 'known') everKnown.current = true;
    if (!everKnown.current) return;
    let cancelled = false;
    (async () => {
      const rows = mySessions.map((s) => ({
        cwd: s.cwd,
        clientName: s.clientName,
        cwdShared: mySessions.filter((o) => o.cwd === s.cwd).length > 1,
      }));
      const map = await readSignals(rows);
      if (cancelled) return;
      setSessionSignals(map);
      checkSessionAlerts(
        mySessions.map((s) => {
          const joinable = transcriptJoinable({
            clientName: s.clientName,
            cwdShared: mySessions.filter((o) => o.cwd === s.cwd).length > 1,
          });
          const sig = map.get(s.cwd);
          return {
            cwd: s.cwd,
            label: s.project || s.cwd.split('/').pop() || 'a session',
            // null = could not see. A refused join or a failed read must not
            // be recorded as "no longer waiting" (codex r1 P2).
            wantsYou: !joinable ? null : sig ? wantsYou(sig) : null,
            line: sig ? signalLine(sig) : null,
          };
        }),
        typeof document !== 'undefined' && document.hasFocus(),
        true,
      );
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detectorKey, detectorTick, mySessionsProbe]);
  // Receipt for the offline write sent on going invisible (audit #6): the
  // status line may claim "Invisible" only on a fresh server acknowledgement.
  // null at boot — a run that starts invisible sent no retraction. The
  // generation counter scopes late resolutions to the attempt AND the
  // identity that sent them (codex P2).
  const [offlineRetraction, setOfflineRetraction] = useState<OfflineRetraction>(null);
  const offlineRetractionGen = useRef(0);

  // Heartbeat: extract coding DNA and send enriched presence
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (!handle) return;

    let lastBeatAt = 0;
    const sendHeartbeat = async () => {
      lastBeatAt = Date.now();
      const prefs = getPresencePrefs();
      // Invisible: send nothing. Presence is TTL-based on last_seen, so going
      // quiet fades the dot to away/offline on its own — no retraction needed.
      if (!prefs.sharing) return;
      const dna = prefs.detail === 'full' ? await getCodingDNA() : null;
      const payload: {
        workingOn?: string;
        project?: string;
        clientMetadata?: Record<string, unknown>;
      } = dna ? dnaToPresencePayload(dna) : {};
      if (prefs.statusText) payload.workingOn = prefs.statusText;
      // Only claim a broadcast that actually landed. The My Presence card is a
      // promise about what other people can see; showing "Others see …" for a
      // heartbeat the server rejected is the app lying to the user about their
      // own visibility.
      const landed = await buddyClient.updatePresence(payload);
      if (!landed) {
        setMyBroadcast(null);
        return;
      }
      setPresenceLastLandedAt(Date.now());
      setMyBroadcast({
        workingOn: payload.workingOn || 'Online via Buddy',
        project: payload.project || null,
        branch: typeof payload.clientMetadata?.branch === 'string' ? payload.clientMetadata.branch : null,
        model: typeof payload.clientMetadata?.model === 'string' ? payload.clientMetadata.model : null,
        sentAt: Date.now(),
      });
    };

    // A pref flip should take effect now, not at the next 5-minute beat:
    // going visible (or changing status/detail) re-announces immediately;
    // going invisible clears the local broadcast snapshot right away.
    const unsubPrefs = subscribePresencePrefs((p) => {
      setPresencePrefsState(p);
      if (p.sharing) {
        offlineRetractionGen.current += 1;
        setOfflineRetraction(null);
        void sendHeartbeat();
      } else {
        setMyBroadcast(null);
        // Retract now rather than letting the TTL fade you out: "invisible"
        // should mean gone from other people's boards within seconds, and any
        // live turn-sharing stops with it. The result is the receipt the
        // status line renders — but only for the attempt and identity that
        // sent it: a flip back to visible, a newer attempt, or a sign-out all
        // bump the generation and orphan this resolution.
        const gen = ++offlineRetractionGen.current;
        setOfflineRetraction('inflight');
        void buddyClient.stopLiveSession();
        void buddyClient.goOffline().then((ok) => {
          if (gen === offlineRetractionGen.current && !getPresencePrefs().sharing) {
            setOfflineRetraction(ok ? { confirmedAt: Date.now() } : 'failed');
          }
        });
      }
    });

    // Re-announce the moment the user comes back to Buddy — wake from sleep,
    // window/tab refocus. Presence is TTL-based on last_seen and we only beat
    // every 5 min, so on wake your own last_seen can be up to ~5 min old; this
    // pushes a fresh beat immediately instead of letting others watch a stale
    // dot until the next interval fires. The 15s throttle collapses the
    // focus+visibilitychange double-fire and avoids hammering on quick tab flips.
    const onWake = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastBeatAt > 15000) {
        void sendHeartbeat();
      }
    };
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('focus', onWake);

    // Detect the machine waking, WITHOUT relying on a DOM event.
    //
    // The listeners above only fire for a window someone is looking at. Buddy
    // now lives in the menu bar and opens at login, so the common case is a
    // hidden window that receives neither `visibilitychange` nor `focus` — it
    // just sleeps with the laptop. After an 8-hour sleep the server has long
    // since TTL'd the user to offline, and SSE is dead.
    //
    // A wall-clock jump is the one signal that always survives sleep: timers
    // don't run while suspended, so a tick that should have been 30s late
    // arriving hours late means we were out. Cheap, no native API, works
    // hidden.
    let lastTick = Date.now();
    const wakeCheck = setInterval(() => {
      const now = Date.now();
      const drift = now - lastTick;
      lastTick = now;
      if (drift > WAKE_GAP_MS) {
        console.warn(`[wake] ${Math.round(drift / 1000)}s gap — reconnecting`);
        // Order matters: announce we're back, re-establish the stream, then
        // pull authoritative state. Presence first so others stop seeing a
        // dead dot while we reconcile.
        void sendHeartbeat();
        // reconnect(), not stop()+connectSSE(): stop() is the logout teardown
        // and drops the DM subscription the still-mounted panel depends on.
        realtime.reconnect();
        fetchAllRef.current?.();
        // Timers do not run while suspended, so a laptop closed for two days
        // burns through zero six-hour ticks. Waking is the one moment we know
        // real time passed.
        runUpdateCheckRef.current?.();
      }
    }, WAKE_TICK_MS);

    // Defer the first heartbeat so the window paints before we touch the local
    // coding DB. The extract is async on the Rust side now, but deferring keeps
    // login feeling instant even on machines with a huge vibe-check DB.
    const initialTimer = setTimeout(sendHeartbeat, 3000);

    // Every 5 minutes
    heartbeatRef.current = setInterval(sendHeartbeat, 5 * 60 * 1000);
    return () => {
      clearTimeout(initialTimer);
      clearInterval(wakeCheck);
      if (heartbeatRef.current) clearInterval(heartbeatRef.current);
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('focus', onWake);
      unsubPrefs();
    };
  }, [handle]);

  // Pair state + auto-session sharing + guest message polling
  const [pairStatus, setPairStatus] = useState<PairStatus>({ paired: false });
  const [sessionShareError, setSessionShareError] = useState(false);

  // Poll pair status every 30s
  useEffect(() => {
    if (!handle) return;
    const check = async () => {
      const result = await buddyClient.getPairStatusResult();
      // A failed poll learned nothing. Treating it as `paired:false` stopped
      // session sharing and rendered the pair as ended during a network blip.
      if (!result.error) setPairStatus(result.status);
    };
    check();
    const stop = guardedInterval(check, 30_000);
    return stop;
  }, [handle]);

  // When paired: auto-share session via /api/session/live every 10s.
  //
  // Gated on presencePrefs.sharing: "Go invisible" used to stop only the
  // presence heartbeat while THIS loop kept uploading 15 recent turns of the
  // user's actual conversation every 10 seconds to their pair partner. The
  // control said "presence paused" and the most sensitive stream kept
  // running. Invisible now means invisible: no beacon, no turns.
  // KILL SWITCH (2026-08-09, take-stock Move 0c): transcript upload is
  // DISABLED. Presence consent is not transcript consent — this loop shipped
  // 15 raw conversation turns every 10s to the pair partner under the generic
  // sharing toggle. It returns only behind a separate, session-scoped grant:
  // preview of what leaves, a named recipient, an expiry, and revocation.
  // docs/TAKE-STOCK-2026-08-09.md Move 0c.
  useEffect(() => {
    setSessionShareError(false);
    // Clear any server-side live session a previous build left running.
    if (handle) void buddyClient.stopLiveSession();
  }, [handle]);

  // A dead session sends the user back to sign-in with an explanation, rather
  // than leaving a signed-in-looking app where every request silently 401s.
  useEffect(() => {
    buddyClient.setSessionExpiredHandler(() => {
      // Same teardown manual sign-out does. Expiry used to drop only the handle
      // and the view, leaving roster, threads, pair state and notification
      // baselines intact — so signing in as a different GitHub account rendered
      // the previous account's data, and a stale `paired` could start the
      // share-session effect before the new pair status came back.
      clearIdentityState();
      setAuthFailure('expired');
      setHandle(null);
      setView({ type: 'list' });
    });
    return () => buddyClient.setSessionExpiredHandler(null);
  }, []);

  // Re-render staleness without coupling it to a fetch: if the network is gone,
  // no fetch resolves, and a signal that only updates on success can never
  // report failure.
  useEffect(() => {
    if (!handle) return;
    const t = setInterval(() => setClockTick(Date.now()), 20_000);
    return () => clearInterval(t);
  }, [handle]);

  // Re-read on every tick so the memory expires on its own rather than
  // lingering as clutter, and so a call started elsewhere in the app appears
  // without prop-drilling through the tree.
  useEffect(() => {
    setLastCall(getRememberedCall());
  }, [clockTick, view]);

  // Every banner is stamped with the account that owns it, and routing
  // refuses a mismatch — a banner from account A clicked after B signs in
  // must not speak as B (codex P1 on #39). Keyed on `handle` so every
  // sign-in path and the teardown (handle -> null, which also clears
  // delivered banners) are covered by one line.
  useEffect(() => { setNotificationOwner(handle); }, [handle]);

  // Check auth on mount
  useEffect(() => {
    const check = async () => {
      const status = await buddyClient.checkAuth();
      if (status.authenticated && status.handle) {
        setHandle(status.handle);
        buddyClient.setHandle(status.handle);
        setLoading(false);
        return;
      }
      const saved = localStorage.getItem('buddy_handle');
      if (saved) {
        buddyClient.setHandle(saved);
        // Only enter the signed-in UI if this actually authenticated. The
        // result used to be discarded and the handle set regardless, which
        // rebuilt the zombie session on every launch for anyone quickAuth
        // can't serve — i.e. every ordinary GitHub user, since that endpoint
        // is alpha-whitelist-only.
        const result = await buddyClient.quickAuthResult(saved);
        if (result.authenticated) {
          setHandle(saved);
        } else {
          buddyClient.setHandle(null);
          setAuthFailure(result.error ? 'unavailable' : 'expired');
        }
      }
      setLoading(false);
    };
    check();

    if (loggingIn) {
      const interval = setInterval(async () => {
        const status = await buddyClient.checkAuth();
        if (status.authenticated && status.handle) {
          setHandle(status.handle);
          buddyClient.setHandle(status.handle);
          localStorage.setItem('buddy_handle', status.handle);
          setLoggingIn(false);
          setLoginTimedOut(false);
        }
      }, 2000);
      // Give the OAuth round-trip 90s; past that, surface a retry rather than
      // spinning forever. Polling keeps running in case they finish late.
      const timeout = setTimeout(() => setLoginTimedOut(true), 90000);
      return () => {
        clearInterval(interval);
        clearTimeout(timeout);
      };
    }
  }, [loggingIn]);

  const beginLogin = useCallback(async () => {
    setLoginTimedOut(false);
    setAuthFailure(null);
    setLoggingIn(true);
    const result = await buddyClient.login();
    if (!result.success) {
      // The browser never opened. Do not render "Waiting for browser…" for
      // the full 90-second OAuth deadline as though work were in progress.
      console.warn('could not start login:', result.error);
      setLoggingIn(false);
      setAuthFailure('login');
    }
  }, []);

  // G6: the report panel renders ABOVE every branch below, because the states a
  // user reports from are exactly the broken ones — signed out, still loading,
  // collapsed to a sliver. It's position:fixed, so it covers whichever of these
  // returns runs.
  const reportOverlay = reportInput ? (
    <ReportProblem input={reportInput} onClose={() => setReportInput(null)} />
  ) : null;

  if (loading) {
    return (
      <>
        {reportOverlay}
        <div style={{
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: color.bg,
          color: color.faint,
          fontSize: `${size[14]}px`,
          fontWeight: 600,
        }}>
          /vibe
        </div>
      </>
    );
  }

  if (!handle) {
    return (
      <>
      {reportOverlay}
      <div style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: color.bg,
        color: '#fff',
        padding: '20px',
        gap: '16px',
      }}>
        <div style={{ fontSize: '28px', fontWeight: 700, color: color.ink }}>/vibe</div>
        {authFailure ? (
          <div style={{
            fontSize: '12px',
            color: color.pink,
            textAlign: 'center',
            maxWidth: '220px',
            lineHeight: '1.5',
          }}>
            {authFailure === 'expired'
              ? 'Your session expired.'
              : authFailure === 'login'
                ? "Couldn't open GitHub sign-in."
                : "Couldn't verify your sign-in."}
            <div style={{ color: '#555', fontSize: '11px', marginTop: '4px' }}>
              {authFailure === 'expired'
                ? 'Sign in again to pick up where you left off.'
                : authFailure === 'login'
                  ? 'Try again; Buddy never opened the browser.'
                  : 'Check your connection, then try again.'}
            </div>
          </div>
        ) : (
          <div style={{
            fontSize: '12px',
            color: '#555',
            textAlign: 'center',
            maxWidth: '200px',
            lineHeight: '1.5',
          }}>
            Build together in your terminal.
            Claude Code, Codex, Cursor.
          </div>
        )}

        {/* What signing in actually does. Buddy writes MCP config into every
            coding agent it finds and starts broadcasting presence within
            seconds — a friend deserves to know both BEFORE they click, not
            discover it afterwards. Both are reversible and we say so. */}
        <div style={{
          fontSize: '10px',
          color: color.faint,
          textAlign: 'left',
          maxWidth: '230px',
          lineHeight: '1.7',
          background: color.panel,
          border: `1px solid ${color.line}`,
          borderRadius: '6px',
          padding: '9px 11px',
        }}>
          <div style={{ color: '#555', fontWeight: 600, marginBottom: '3px' }}>
            When you sign in, Buddy will:
          </div>
          • add /vibe to your coding agents<br />
          • show others you're online, and what project you're in<br />
          • open at login, so your dot stays lit<br />
          <span style={{ color: '#333' }}>
            All reversible: go invisible or share less from the top of the list,
            turn off Open at Login from the menu bar icon.
          </span>
        </div>

        <button
          onClick={() => { void beginLogin(); }}
          disabled={loggingIn && !loginTimedOut}
          style={{
            background: color.blue,
            color: '#fff',
            border: 'none',
            borderRadius: '8px',
            padding: '10px 24px',
            fontSize: '13px',
            fontWeight: 600,
            cursor: (loggingIn && !loginTimedOut) ? 'default' : 'pointer',
            opacity: (loggingIn && !loginTimedOut) ? 0.6 : 1,
            marginTop: '4px',
            width: '100%',
            maxWidth: '200px',
          }}
        >
          {loginTimedOut ? 'Try signing in again' : loggingIn ? 'Waiting for browser...' : 'Sign in with GitHub'}
        </button>

        {loginTimedOut && (
          <div style={{
            fontSize: '11px',
            color: '#777',
            textAlign: 'center',
            maxWidth: '220px',
            lineHeight: '1.5',
          }}>
            Didn't finish in your browser? Reopen the sign-in tab, or click above to retry.
          </div>
        )}

        <div style={{ fontSize: '9px', color: '#222', marginTop: '12px' }}>
          slashvibe.dev
        </div>
      </div>
      </>
    );
  }

  // Compact mode — just avatars
  if (compact) {
    const activeUsers = users.filter(u => u.handle !== handle && u.status === 'active');
    return (
      <div style={{
        height: '100%',
        width: '100%',
        background: color.bg,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '6px 4px',
        gap: '4px',
        overflow: 'auto',
      }}>
        {/* The way back OUT of compact must be legible — the old 9px
            #333-on-black "/v" was functionally invisible, and when the
            window resize silently failed the rail sat marooned in a
            full-size window with no visible exit (Seth, live, #33). */}
        <button
          type="button"
          onClick={() => {
            setCompact(false);
            resizeWindow(320, 500);
          }}
          title="Back to the full list"
          style={{
            fontSize: '10px',
            fontFamily: 'inherit',
            color: color.dim,
            background: 'transparent',
            border: `1px solid ${color.line}`,
            borderRadius: '4px',
            cursor: 'pointer',
            padding: '3px 8px',
            marginBottom: '2px',
          }}
        >
          ‹ expand
        </button>
        {activeUsers.map(u => (
          <img
            key={u.handle}
            src={`https://github.com/${u.handle}.png?size=48`}
            alt={u.handle}
            title={`@${u.handle}: ${u.oneLiner || 'online'}`}
            onClick={() => { setCompact(false); resizeWindow(320, 500); setView({ type: 'dm', chatWith: u.handle }); }}
            style={{
              width: 28,
              height: 28,
              borderRadius: '50%',
              cursor: 'pointer',
              border: `2px solid ${color.line}`,
            }}
          />
        ))}
        {activeUsers.length === 0 && (
          <div style={{ fontSize: '9px', color: '#222', marginTop: '8px' }}>~</div>
        )}
      </div>
    );
  }

  return (
    <div style={{ position: 'relative', height: '100%', width: '100%', display: 'flex', flexDirection: 'column' }}>
      {reportOverlay}
      <div style={{ flex: 1, minHeight: 0 }}>
        {view.type === 'list' && (
          <UnifiedBuddyList
            handle={handle}
            users={users}
            sessions={sessions}
            mySessions={mySessions}
            mySessionsProbe={mySessionsProbe}
            sessionSignals={sessionSignals}
            mySessionsObservedAt={mySessionsObservedAt}
            threads={threads}
            presenceError={presenceError}
            recentlyHere={recentlyHere}
            myPresence={{ prefs: presencePrefs, broadcast: myBroadcast, lastLandedAt: presenceLastLandedAt, retraction: offlineRetraction }}
            onPresenceChange={(patch) => setPresencePrefs(patch)}
            onUserClick={(h) => setView({ type: 'dm', chatWith: h })}
            onSignOut={async () => {
              // Stop being signed in FIRST, then retract over the network.
              //
              // Two bugs lived in the old order. Every polling loop is keyed
              // on `handle`, so leaving it set until logout() finished meant a
              // slow or failing network kept presence, pair-share, and guest
              // polling alive for the whole hang — and a live-session upload
              // already in flight could land AFTER the DELETE and republish
              // the session we just retracted. And because none of the
              // identity-scoped state was cleared, the next account to sign in
              // rendered the previous account's roster and threads, with a
              // stale pairStatus.paired that could start uploading THEIR
              // session before their own pair status came back.
              clearIdentityState();
              setHandle(null);
              setView({ type: 'list' });
              localStorage.removeItem('buddy_handle');
              await buddyClient.logout();
            }}
            onCompact={() => {
              setCompact(true);
              resizeWindow(56, 500);
            }}
            // Watch and its guest machinery were deleted (take-stock Move 2):
            // Watch was unreachable and silently broken; pair CREATION is not
            // Buddy's today. Pairs made elsewhere still display (PairedHero).
            onSession={(h) => setView({ type: 'session', targetHandle: h })}
            onCheckUpdates={() => runUpdateCheck(true)}
            pairedWith={pairStatus.paired && pairStatus.partner ? pairStatus.partner : undefined}
          />
        )}
        {view.type === 'dm' && (
          <DMPanel
            handle={handle}
            chatWith={view.chatWith}
            onBack={() => setView({ type: 'list' })}
            users={users}
          />
        )}
        {view.type === 'session' && (
          <SessionPanel
            handle={handle}
            targetHandle={view.targetHandle}
            onBack={() => setView({ type: 'list' })}
          />
        )}
      </div>

      {/* ── One notice slot ────────────────────────────────────────────────
          ROOM TONE: ambient over interruptive. This window is 300px wide;
          it previously stacked up to eight independent banners, so a call,
          a toast, an MCP warning and an update notice could squeeze the
          buddy list — the actual product — down to nothing.

          Now: at most ONE notice, highest priority wins, stated once and
          quietly. Green stays reserved for live presence, so the caller's
          dot is green but the Answer button is blue (ours, an action). */}
      <Notice
        notice={
          upToDate
            ? {
                kind: 'info' as const,
                text: upToDate === 'checking'
                  ? 'checking for updates…'
                  : upToDate === 'offline'
                    ? "couldn't check for updates"
                    : `you're on the latest version (${upToDate})`,
              }
            : updateFailure
            ? {
                kind: 'warn' as const,
                text: `update failed during ${updateFailure.phase} · ${updateFailure.id}`,
                actions: [
                  {
                    label: updateFailureCopy === 'copied'
                      ? 'copied'
                      : updateFailureCopy === 'failed'
                        ? 'copy failed'
                        : 'copy details',
                    onClick: () => {
                      void copyText(formatUpdateFailureEvidence(updateFailure)).then(copied => {
                        setUpdateFailureCopy(copied ? 'copied' : 'failed');
                      });
                    },
                  },
                  {
                    label: 'download',
                    onClick: () => window.open('https://www.slashvibe.dev/join', '_blank'),
                  },
                  {
                    label: 'dismiss',
                    onClick: () => {
                      clearUpdateFailureEvidence();
                      setUpdateFailure(null);
                      setUpdateFailureCopy('idle');
                    },
                  },
                ],
              }
            : lastCall
            ? {
                kind: 'info' as const,
                // Say the part that is actually load-bearing.
                //
                // Buddy mints the call and the bot walks in wearing the right
                // name and face — but it has no brain until a coding session
                // drives it, and an undriven bot shows up in the room as a blank
                // face. That surprised the person who built this: the bot was
                // "pepper", it just was not connected to the pepper session.
                //
                // The paste line was previously an 8px label on the session row
                // that expired after 12 seconds, while this durable notice
                // offered the Meet URL — the one thing the browser had already
                // opened. The important instruction was the transient one.
                text: lastCall.from
                  ? `call started · ${lastCall.from} needs the join line pasted in, or its agent is not really in the room`
                  : `you started a call ${formatAge(clockTick - lastCall.startedAt)}`,
                actions: [
                  {
                    label: joinCopied ? 'copied' : `copy /join-call`,
                    primary: true,
                    onClick: () => {
                      navigator.clipboard.writeText(joinLine(lastCall.code)).catch(() => {});
                      setJoinCopied(true);
                      setTimeout(() => setJoinCopied(false), 1500);
                    },
                  },
                  {
                    label: callCopied ? 'copied' : 'copy link',
                    onClick: () => {
                      navigator.clipboard.writeText(lastCall.url).catch(() => {});
                      setCallCopied(true);
                      setTimeout(() => setCallCopied(false), 1500);
                    },
                  },
                  {
                    label: 'dismiss',
                    onClick: () => { forgetCall(); setLastCall(null); },
                  },
                ],
              }
            : updateCheckIsStale(lastCheck, clockTick)
            ? {
                kind: 'warn' as const,
                // The claim Buddy must never make silently is "you are current".
                // Says which of the two silences this is, because "never asked"
                // and "have not asked since Tuesday" read differently to someone
                // deciding whether to worry. Offers the fix in the same breath.
                text: lastCheck
                  ? `last checked for updates ${formatAge(clockTick - Date.parse(lastCheck.at))} ago — cannot say you are current`
                  : 'never checked for updates — cannot say you are current',
                actions: [
                  {
                    label: 'check now',
                    primary: true,
                    onClick: () => runUpdateCheckRef.current?.(),
                  },
                ],
              }
            : handle && clockTick - lastSyncAt > STALE_AFTER_MS
            ? {
                kind: 'warn' as const,
                // States the fact once, quietly, and names what it means: what
                // is on screen is real but old. Without this the roster simply
                // freezes and reads as "nobody is around" — the failure looks
                // exactly like the product working.
                text: `reconnecting · last synced ${formatAge(clockTick - lastSyncAt)}`,
              }
            : pairStatus.paired && sessionShareError
            ? {
                kind: 'warn' as const,
                text: "your paired session isn't syncing",
              }
            : mcpStatus && !mcpDismissed && view.type === 'list' && !mcpStatus.installed && !mcpStatus.npx_available
            ? {
                kind: 'warn',
                text: 'terminal integration needs node.js',
                actions: [{ label: 'get node', onClick: () => window.open('https://nodejs.org', '_blank') },
                          { label: 'dismiss', onClick: () => setMcpDismissed(true) }],
              }
            : mcpStatus && !mcpDismissed && view.type === 'list' && !mcpStatus.installed
            ? {
                kind: 'warn',
                text: "couldn't set up your coding agents",
                actions: [{ label: 'try again', onClick: handleRetryMcp },
                          { label: 'dismiss', onClick: () => setMcpDismissed(true) }],
              }
            : update?.available
            ? {
                kind: 'info',
                text: installing ? installing : `v${update.version} is ready`,
                actions: installing
                  ? []
                  : [{
                      label: 'install',
                      primary: true,
                      onClick: () => {
                        clearUpdateFailureEvidence();
                        setUpdateFailure(null);
                        setUpdateFailureCopy('idle');
                        setInstalling('starting…');
                        installUpdate((phase, fraction) => {
                          if (phase === 'downloading') {
                            setInstalling(
                              fraction === null
                                ? 'downloading…'
                                : `downloading ${Math.round(fraction * 100)}%`
                            );
                          } else if (phase === 'installing') {
                            setInstalling('installing — buddy will restart');
                          } else if (phase === 'relaunching') {
                            setInstalling('restarting buddy…');
                          }
                        }).catch((e) => {
                          // Say so. A silent failure here is the difference
                          // between "the update failed" and "the button is
                          // broken", and the user can only act on the first.
                          console.error('install failed:', e);
                          setInstalling(null);
                          const evidence = updateFailureEvidence(e) || loadUpdateFailureEvidence();
                          if (evidence) setUpdateFailure(evidence);
                        });
                      },
                    }],
              }
            : null
        }
      />

    </div>
  );
}

async function resizeWindow(width: number, height: number) {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    await win.setSize(new (await import('@tauri-apps/api/dpi')).LogicalSize(width, height));
  } catch (e) { console.warn('resizeWindow error:', e); }
}
