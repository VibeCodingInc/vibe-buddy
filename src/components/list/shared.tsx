// Shared status semantics + Avatar for the buddy-list family —
// extracted verbatim from UnifiedBuddyList.tsx (take-stock Move 2 split).
/* eslint-disable */
import { useState, useEffect, useMemo, useRef, type CSSProperties } from 'react';
import { buddyClient, type VibeUser, type VibeThread, type SessionEntity, type MySession, type RecentTrace } from '../../lib/vibeClient';
import { ensureNotificationPermissionResult, hasNotificationPermission, checkAndNotify, notifyArrivals, initNotificationClicks } from '../../lib/notifications';
import { vibeconfAvailability, vibeconfSeatState, startCall, joinLine, sessionContext } from '../../lib/vibeconf';
import { rememberCall } from '../../lib/callMemory';
import { readBotfile, sessionLabel, type Botfile } from '../../lib/botfile';
import { copyText } from '../../lib/clipboard';
import {
} from '../../lib/intelligence';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { color, space, radius, size } from '../../lib/tokens';
import { presenceStatusLine, selfDotConfirmed, type PresencePrefs, type PresenceBroadcast } from '../../lib/presencePrefs';
import { waitingThreads, sessionsSummary } from '../../lib/interval';
import { mySessionsBlock, mySessionsStaleLine, effectiveAgoMs, FIRST_RECOGNITION, type MySessionsProbe } from '../../lib/mySessionsState';
import { sessionLadder, type Rung, type SeatProbe } from '../../lib/sessionLadder';
import { isFreshAge, isFreshLastSeen } from '../../lib/freshness';
import { getSummonable, summonAgent } from '../../lib/doorbell';
import { MySessionsSection } from './MySessions';
import { formatAgo, formatModel, pressOnKey } from './format';

// Remember avatars that 404'd so we render the letter fallback instantly on
// re-mount instead of re-fetching a broken GitHub image (and reflickering).
export const avatarFailed = new Set<string>();


// Shared style for the header dropdown items. They're <button>s (a11y:
// keyboard-focusable, Enter/Space activated) reset to look like plain rows.
export const menuItemStyle: CSSProperties = {
  display: 'block',
  width: '100%',
  textAlign: 'left',
  background: 'transparent',
  border: 'none',
  padding: '8px 12px',
  fontSize: '12px',
  fontFamily: 'inherit',
  cursor: 'pointer',
};

// Synthetic QA accounts (scripts/test-bots.js: synth-seth, synth-stan) plus any
// future synth-* bot. Never surface these to real users — mirrors the way system
// accounts are filtered from presence server-side.
// Kept in sync with the server's isTestHandle() in api/lib/presence-service.js.
// This used to match only `synth-`, so an afternoon of e2e runs left FIFTY
// junk threads (e2e_*, test_welcome_*, test_dup_*) sitting in Recent, burying
// the actual humans. The server already filters these out of presence; the
// thread list had no such filter, which is why they only showed up here.
export const TEST_HANDLE_PREFIXES = ['synth-', 'test_', 'testuser_', 'qa_', 'ftue_', 'e2e_'];
export const isTestAccount = (handle: string): boolean => {
  const h = handle.toLowerCase();
  return h === 'link_checker' || TEST_HANDLE_PREFIXES.some((p) => h.startsWith(p));
};

// Attribution comes from the server (guarantee 5: every message names a
// principal and says whether it is a human or an agent).
//
// This used to be a hardcoded roster of Seth's fleet handles. That silently
// mislabels any agent added after the list was written, and every agent that
// isn't ours — it would show a stranger's bot as a person. The presence API
// already separates agents into their own bucket and flags them; Buddy was
// dropping that and guessing instead.
//
// The old roster survives only as a fallback for servers that predate the
// flag, and should be deleted once nothing needs it.
export const LEGACY_AGENT_HANDLES = new Set([
  'archie', 'coltrane', 'fred', 'farmerfredai', 'grace', 'levi', 'sal',
  'henri', 'denza', 'gotham', 'tara', 'basel', 'sara', 'vibe-bot', 'vibebuddy',
]);
// Reachability predicates. These feed the WORDS beside the dot, never the
// dot itself: the contract (AGENTS.md, "Presence is liveness, not
// reachability") keeps the two systems independent — a green dot must never
// be read as "will receive this", and the way to prevent that reading is to
// say reachability in words, not to make the dot secretly encode it.
//
// (This module dimmed the dot on these predicates through 0.5.49. Audit #9
// called the blend, and the codex review of the fix pointed back at the
// written contract: one presence claim across principals, reachability as
// its own signal. The dot logic below is presence-only by that ruling.)
export const isBroadcastOnly = (user: VibeUser): boolean =>
  user.reachability === 'broadcast-only';

export const isUnproven = (user: VibeUser): boolean =>
  user.isAgent === true && user.reachability === 'unknown';

/**
 * No READ evidence has ever existed for this agent — keyed on `lastReadAt`,
 * not on the reachability enum.
 *
 * The enum is not sufficient and the difference is not academic: platform
 * `classifyReachability` moves an agent from 'unknown' to 'listening' the
 * moment `unreadCount > 0`, while `lastReadAt` stays null. So sending the
 * FIRST message to a never-read agent flips it to 'listening' within one
 * six-second presence refresh, and an enum-based warning vanishes for the
 * next fifteen minutes — exactly when the sender is deciding whether to send
 * a second one (codex P2). Unread mail is evidence of arrival, never of
 * reading; only `lastReadAt` is evidence of reading (AGENTS.md 54-56).
 */
export const hasNoReadEvidence = (user: VibeUser): boolean =>
  user.isAgent === true &&
  // The annotation must have RUN. Without this, an endpoint that simply
  // omits reachability reads as "never read" for every agent — unknown-first
  // inverted into a confident claim (codex P1). Today /v2/presence, the
  // endpoint Buddy actually calls, does not annotate: only the V1
  // getPresenceList() runs getReachability. So this is correctly silent in
  // production until the platform annotates V2, and it says nothing rather
  // than saying something false in the meantime.
  user.reachability !== undefined &&
  // Explicitly null = platform says never read. undefined = it did not say.
  user.lastReadAt === null;

// The dot renders exactly one system: presence. Fresh heartbeat → green,
// anything else → faint. Reachability never dims it (audit #9 / AGENTS.md).
export const presenceDotColor = (user: VibeUser, now: number): string =>
  isFreshLastSeen(user.lastSeen, now) ? color.green : color.faint;

// State is glyph + word, never color alone — and here, word beside glyph:
// the dot says "here now" while these words carry the separate reachability
// fact ("not reading" / "untested"), so a reader never has to decode a color
// into a delivery promise. One definition: the row chips, the accessible
// name, and the tests read this same truth (audit #9).
export function reachabilityWords(user: VibeUser): { label: string; title: string } | null {
  if (isBroadcastOnly(user)) {
    return {
      label: 'not reading',
      title: `${user.unreadCount ?? 0} unread${user.lastReadAt ? '' : ', never read'}`,
    };
  }
  if (isUnproven(user)) {
    // The title describes only the evidence gap. It must not promise that
    // green means answering: the platform flips reachability off unread-mail
    // freshness and read cursors, neither of which proves an answer
    // (platform listening.js; codex P2 on the audit-#9 fix).
    return {
      label: 'untested',
      title: "no one has DM'd this agent yet, so nothing shows whether it reads or answers",
    };
  }
  return null;
}

// Server attribution wins outright when present — including an explicit
// `false`, which the old `||` silently overrode for legacy-roster handles
// (honest-state audit #17). The roster is consulted only when the server
// predates the flag and says nothing either way.
export const isAgent = (user: VibeUser): boolean =>
  user.isAgent !== undefined
    ? user.isAgent === true
    : LEGACY_AGENT_HANDLES.has(user.handle.toLowerCase());

/**
 * The archive affordance — ONE definition for every thread row variant
 * (OfflineThreadRow and UserRow both render it, so a stale unread can be
 * cleared no matter which shape the conversation takes — codex P2 on #32).
 *
 * Honesty rules it carries:
 *  - mounts only while `revealed` (hover OR keyboard focus) or once its own
 *    state is in motion — and the caller passes onArchive only when the
 *    thread carries a server id, so the button never offers a write that
 *    cannot land;
 *  - the row is never hidden locally: 'archived — clearing on next sync' is
 *    the claim, and departure happens by server truth on the next poll;
 *  - both click and keyboard activation stop the REAL event, so archiving
 *    never also opens the DM behind it.
 */
export function ArchiveChip({
  revealed,
  peer,
  onArchive,
}: {
  revealed: boolean;
  peer: string;
  onArchive: () => Promise<boolean>;
}) {
  const [state, setState] = useState<'idle' | 'archiving' | 'archived' | 'failed'>('idle');
  if (!revealed && state === 'idle') return null;

  const act = async () => {
    if (state === 'archiving' || state === 'archived') return;
    setState('archiving');
    const ok = await onArchive();
    setState(ok ? 'archived' : 'failed');
  };

  return (
    <span
      role="button"
      tabIndex={0}
      aria-label={`archive the conversation with @${peer}`}
      onClick={(e) => { e.stopPropagation(); void act(); }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          void act();
        }
      }}
      title={
        state === 'failed'
          ? 'the server did not acknowledge the archive — try again'
          : `hide this thread on every device. today an archived thread does NOT come back if @${peer} writes again — un-archiving is a platform ask away.`
      }
      style={{
        fontSize: '9px',
        padding: '1px 6px',
        borderRadius: '3px',
        background: color.line,
        color: state === 'failed' ? color.ink : color.faint,
        whiteSpace: 'nowrap',
        cursor: state === 'archived' ? 'default' : 'pointer',
      }}
    >
      {state === 'idle' && 'archive'}
      {state === 'archiving' && 'archiving…'}
      {state === 'archived' && 'archived — clearing on next sync'}
      {state === 'failed' && "couldn't archive"}
    </span>
  );
}

// oneLiners that are machine noise, not something a human wrote. Presence
// beacons ("Heartbeat"), default placeholders, and bare status words shouldn't
// leak into the status line as if they were a builder's own words.
export const MACHINE_ONELINERS = new Set([
  'vibing', 'online via buddy', 'heartbeat', 'online', 'active', 'present',
  'idle', 'away', 'offline', 'connected', 'ping',
]);

// smartStatus was deleted 2026-08-15 (ruthless pass). Nothing called it any
// more, and it was the last path from a component into inferState — so the
// bundle kept executing the metadata inference the pass claims to have
// removed, and the guard missed it because it only searched the components
// (codex P3). Deleted rather than left dead.


export function formatDuration(minutes: number): string {
  if (minutes < 1) return '';
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h${m}m` : `${h}h`;
}

export function formatTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'now';
  if (diffMins < 60) return `${diffMins}m`;
  if (diffHours < 24) return `${diffHours}h`;
  if (diffDays < 7) return `${diffDays}d`;
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// ambientMessage was deleted 2026-08-15 with the ambient line it fed. It was
// the last consumer of ProactiveMoment/SerendipityMoment in this file.


export function Avatar({ handle, size = 24, isAway }: { handle: string; size?: number; isAway?: boolean }) {
  const [failed, setFailed] = useState(() => avatarFailed.has(handle.toLowerCase()));

  if (failed) {
    return (
      <div style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: color.panel,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: size * 0.45,
        color: color.faint,
        fontWeight: 600,
        flexShrink: 0,
      }}>
        {handle[0]?.toUpperCase()}
      </div>
    );
  }

  return (
    <img
      src={`https://github.com/${handle}.png?size=${size * 2}`}
      alt={handle}
      onError={() => { avatarFailed.add(handle.toLowerCase()); setFailed(true); }}
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        flexShrink: 0,
        opacity: isAway ? 0.5 : 1,
      }}
    />
  );
}


export function hasDNA(user: VibeUser): boolean {
  const meta = user.clientMetadata || {};
  return !!(meta.tech_stack?.length || meta.model || (meta.streak_days as number) >= 3);
}