// OfflineThreadRow — extracted verbatim from UnifiedBuddyList.tsx (Move 2 split).
/* eslint-disable */
import { useState, useEffect, useMemo, useRef, type CSSProperties } from 'react';
import { buddyClient, type VibeUser, type VibeThread, type SessionEntity, type MySession, type RecentTrace } from '../../lib/vibeClient';
import { ensureNotificationPermissionResult, hasNotificationPermission, checkAndNotify, notifyArrivals, initNotificationClicks } from '../../lib/notifications';
import { vibeconfAvailability, vibeconfSeatState, startCall, joinLine, sessionContext } from '../../lib/vibeconf';
import { rememberCall } from '../../lib/callMemory';
import { readBotfile, sessionLabel, type Botfile } from '../../lib/botfile';
import { copyText } from '../../lib/clipboard';
import {
  detectProactiveMoments,
  collaborationScore,
  type SerendipityMoment,
  type ProactiveMoment,
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
import { avatarFailed, menuItemStyle, TEST_HANDLE_PREFIXES, isTestAccount, LEGACY_AGENT_HANDLES, isBroadcastOnly, isUnproven, presenceDotColor, isAgent, MACHINE_ONELINERS, formatDuration, formatTime, Avatar, ArchiveChip, hasDNA } from './shared';


// Offline thread row — for users with messages but not currently online
export function OfflineThreadRow({
  thread,
  onClick,
  myHandle,
  onArchive,
  unreadImplied,
}: {
  thread: VibeThread;
  onClick: () => void;
  myHandle: string;
  /**
   * The row sits in the FOR YOU zone, where its presence already says
   * "unread" — the count badge earns its pixels only past 1 (buddy#49
   * decision 2). The accessible name keeps the exact count either way.
   */
  unreadImplied?: boolean;
  /**
   * Archive this thread server-side; resolves whether the server acknowledged.
   * Absent when the thread carries no id (an old server) — the affordance
   * simply doesn't render rather than offering a write that cannot land.
   */
  onArchive?: () => Promise<boolean>;
}) {
  const hasUnread = thread.unread > 0;
  const [hovered, setHovered] = useState(false);
  // Keyboard reach: the chip reveals on focus-within too, so a keyboard-only
  // user can Tab to it — hover alone never happens for them (codex P2).
  const [focused, setFocused] = useState(false);

  return (
    <div
      className="vibe-press"
      role="button"
      tabIndex={0}
      aria-label={`@${thread.with}${hasUnread ? `, ${thread.unread} unread` : ', conversation'}`}
      onKeyDown={pressOnKey(onClick)}
      style={{
        padding: '8px 10px 8px 12px',
        borderRadius: '6px',
        background: color.panel,
        marginBottom: '3px',
        cursor: 'pointer',
        transition: 'background 0.15s ease',
        // Dimming is for history. A thread holding unread is the most
        // important row on screen (the WAITING block), not a memory.
        opacity: hasUnread ? 1 : 0.6,
        borderLeft: hasUnread ? `2px solid ${color.dim}` : '2px solid transparent',
      }}
      onClick={onClick}
      onMouseEnter={(e) => { setHovered(true); e.currentTarget.style.background = color.hover; }}
      onMouseLeave={(e) => { setHovered(false); e.currentTarget.style.background = color.panel; }}
      onFocus={() => setFocused(true)}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setFocused(false); }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Avatar handle={thread.with} size={28} isAway />
          <span style={{
            fontWeight: hasUnread ? 600 : 500,
            color: hasUnread ? color.ink : color.faint,
            fontSize: '13px',
          }}>
            {thread.with}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
          {onArchive && (
            // Progressive disclosure like the doorbell actions: history
            // management appears on hover or keyboard focus, never shouting.
            <ArchiveChip revealed={hovered || focused} peer={thread.with} onArchive={onArchive} />
          )}
          {thread.lastMessage?.created_at && (
            <span style={{ fontSize: '9px', color: color.faint }}>
              {formatTime(thread.lastMessage.created_at)}
            </span>
          )}
          {hasUnread && thread.unread > (unreadImplied ? 1 : 0) && (
            <span style={{
              background: color.blue,
              color: color.ink,
              fontSize: '9px',
              padding: '1px 5px',
              borderRadius: '6px',
              fontWeight: 600,
              minWidth: '16px',
              textAlign: 'center',
            }}>
              {thread.unread}
            </span>
          )}
        </div>
      </div>
      {thread.lastMessage && (
        <div style={{
          fontSize: '11px',
          color: hasUnread ? color.dim : color.faint,
          marginTop: '2px',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          paddingLeft: '36px',
          fontWeight: hasUnread ? 500 : 400,
        }}>
          {thread.lastMessage.from === myHandle ? 'You: ' : ''}
          {thread.lastMessage.body}
        </div>
      )}
    </div>
  );
}