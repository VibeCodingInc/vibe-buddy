// rows — extracted verbatim from UnifiedBuddyList.tsx (Move 2 split).
/* eslint-disable */
import { useState, useEffect, useMemo, useRef, type CSSProperties } from 'react';
import { buddyClient, type VibeUser, type VibeThread, type SessionEntity, type MySession, type RecentTrace } from '../../lib/vibeClient';
import { ensureNotificationPermissionResult, hasNotificationPermission, checkAndNotify, notifyArrivals, initNotificationClicks } from '../../lib/notifications';
import { vibeconfAvailability, vibeconfSeatState, startCall, joinLine, sessionContext } from '../../lib/vibeconf';
import { rememberCall } from '../../lib/callMemory';
import { readBotfile, sessionLabel, type Botfile } from '../../lib/botfile';
import { copyText } from '../../lib/clipboard';
import {
  type SerendipityMoment,
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
import { avatarFailed, menuItemStyle, TEST_HANDLE_PREFIXES, isTestAccount, LEGACY_AGENT_HANDLES, isBroadcastOnly, isUnproven, reachabilityWords, presenceDotColor, isAgent, MACHINE_ONELINERS, formatDuration, formatTime, Avatar, ArchiveChip, hasDNA } from './shared';

// --- Paired partner hero card ---
// PairedHeroCard was deleted 2026-08-15 with the ruthless pass. It was the
// last consumer of inferState/inferredPhrase/inferredEvidence/findSerendipity
// in this file, so the inference imports went with it. A paired partner now
// renders as an ordinary UserRow carrying a `paired` marker.

export function UserRow({
  user,
  onClick,
  onSummon,
  thread,
  myHandle,
  showDetails,
  showKind,
  unreadImplied,
  isPaired,
  onSessionView,
  onArchive,
}: {
  user: VibeUser;
  onClick: () => void;
  onSummon?: () => void;
  thread?: VibeThread;
  myHandle?: string;
  showDetails?: boolean;
  /** Outside a labeled lane (the FOR YOU zone), say what kind of company this is. */
  showKind?: boolean;
  /**
   * The row sits in the FOR YOU zone, where its presence already says
   * "unread" — so the count badge earns its pixels only past 1 (buddy#49
   * decision 2: badges only where they add distinct information). The
   * accessible name keeps the exact count either way; the rule is about
   * visual noise, not information.
   */
  unreadImplied?: boolean;
  /** The platform reports a pair with this principal. */
  isPaired?: boolean;
  /**
   * Open the shared session view. Offered on a PAIRED row only, because an
   * accepted pair authorizes SessionPanel whether or not presence reports a
   * SessionEntity — the hero card offered this unconditionally, and deleting
   * it made existing shared sessions unreachable (codex P2).
   */
  onSessionView?: () => void;
  /**
   * Archive this row's thread server-side (resolves whether acknowledged).
   * A stale unread from an always-on peer renders as a UserRow, not an
   * OfflineThreadRow — without this the conversation had no archive at all
   * (codex P2 on #32). Passed only when the thread carries a server id.
   */
  onArchive?: () => Promise<boolean>;
}) {
  const [hovered, setHovered] = useState(false);
  // Keyboard reach for the archive chip: reveal on focus-within too.
  const [focused, setFocused] = useState(false);
  const isAway = user.status === 'away';
  const sessionMins = user.clientMetadata?.session_minutes || 0;
  const duration = formatDuration(sessionMins);

  const hasUnread = thread && thread.unread > 0;
  // One derivation feeds the visual chip AND the accessible name: an explicit
  // aria-label overrides descendant text, so words left out of it would fix
  // color-only rendering for sighted readers while staying invisible to
  // screen readers (codex P2 on the audit-#9 fix).
  const reachWords = reachabilityWords(user);

  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '4px' }}>
    <div
      className="vibe-row vibe-press"
      role="button"
      tabIndex={0}
      aria-label={
        // This explicit label overrides all descendant text, so everything a
        // sighted reader learns from chips and emoji must be restated here —
        // (the inferred phrase went with the ruthless pass, 2026-08-15).
        `@${user.handle}` +
        (isAgent(user) ? ', agent' : '') +
        (isPaired ? ', paired' : '') +
        (hasUnread ? `, ${thread!.unread} unread` : '') +
        (isAway ? ', away' : '') +
        (reachWords ? `, ${reachWords.label}` : '')
      }
      onKeyDown={pressOnKey(onClick)}
      style={{
        flex: 1,
        minWidth: 0,
        padding: '8px 10px 8px 12px',
        borderRadius: '6px',
        background: color.panel,
        marginBottom: '3px',
        cursor: 'pointer',
        transition: 'background 0.15s ease',
        opacity: isAway ? 0.5 : 1,
        // The state emoji already signals what someone's doing; a loud
        // state-colored border double-encoded it (a flame + an orange bar).
        // Keep a quiet neutral edge so unread rows still read, nothing shouts.
        borderLeft: hasUnread ? `2px solid ${color.dim}` : '2px solid transparent',
      }}
      onClick={onClick}
      // Every branch of both ternaries used to be color.panel, so hovering a
      // buddy row changed nothing at all — the handler ran, computed a value,
      // and assigned the colour that was already there. A row you can click
      // that gives no feedback reads as a row you cannot click, which is most
      // of why nothing in this window looks interactive.
      onMouseEnter={(e) => { setHovered(true); e.currentTarget.style.background = color.hover; }}
      onMouseLeave={(e) => { setHovered(false); e.currentTarget.style.background = color.panel; }}
      onFocus={() => setFocused(true)}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setFocused(false); }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <div style={{ position: 'relative' }}>
            <Avatar handle={user.handle} size={28} isAway={isAway} />
            {!isAway && (
              <span style={{
                position: 'absolute',
                bottom: -1,
                right: -1,
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: presenceDotColor(user, Date.now()),
                border: `2px solid ${color.panel}`,
              }} />
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
            {/* CUT 2026-08-15: the inferred-state emoji. Its own comment
                called it "a guess wearing a costume", and a guess is exactly
                what a row must not carry. */}
            <span style={{
              fontWeight: hasUnread ? 600 : 500,
              color: isAway ? color.faint : color.ink,
              fontSize: '13px',
            }}>
              {user.displayName || user.handle}
            </span>
            {/* AWAY, IN WORDS. Away agents share the AGENTS lane with active
                ones, so after the timestamp was cut only dimming and a missing
                green dot distinguished them — colour alone, for the one state
                that decides whether anyone is there (codex P2). The
                accessible name already said it; sighted readers get it too. */}
            {isAway && (
              <span
                style={{
                  fontSize: '8px',
                  padding: '1px 5px',
                  borderRadius: '3px',
                  background: color.line,
                  color: color.faint,
                  letterSpacing: '0.3px',
                  whiteSpace: 'nowrap',
                }}
              >
                away
              </span>
            )}
            {/* PAIRED, still said. The hero card carried this and is gone; the
                platform still reports the pair, and the worked plan requires
                the state stay visible (codex P2). One word on the row rather
                than a second row type. */}
            {isPaired && (
              <span
                style={{
                  fontSize: '8px',
                  padding: '1px 5px',
                  borderRadius: '3px',
                  background: color.line,
                  color: color.blue,
                  letterSpacing: '0.3px',
                  whiteSpace: 'nowrap',
                }}
              >
                paired
              </span>
            )}
            {showKind && isAgent(user) && (
              // Outside the AGENTS lane (the WAITING block), the lane label is
              // gone — the row itself says what kind of company answered.
              <span
                aria-hidden="true"
                style={{
                  fontSize: '8px',
                  padding: '1px 5px',
                  borderRadius: '3px',
                  background: color.line,
                  color: color.dim,
                  letterSpacing: '0.3px',
                  whiteSpace: 'nowrap',
                }}
              >
                🤖 agent
              </span>
            )}
            {(() => {
              // Say it in words, once, quietly — for EVERY reachability reason
              // the dot was withheld, not only broadcast-only (audit #9: an
              // unproven agent was dimmed by color alone). Title carries the
              // evidence for anyone who wants it.
              const words = reachWords;
              return words && (
                <span
                  title={words.title}
                  style={{
                    fontSize: '8px',
                    padding: '1px 5px',
                    borderRadius: '3px',
                    background: color.line,
                    color: color.faint,
                    letterSpacing: '0.3px',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {words.label}
                </span>
              );
            })()}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
          {onArchive && (
            // Same chip, same rules as OfflineThreadRow — a conversation's
            // archivability must not depend on which row shape it wears.
            <ArchiveChip revealed={hovered || focused} peer={user.handle} onArchive={onArchive} />
          )}
          {/* Actions — progressive disclosure: the kernel surface is the list
              + DMs + My Presence; Watch/Pair/Summon belong to the doorbell arc,
              so they appear only on hover instead of shouting on every row. */}
          {!isAway && onSummon && (
            <div style={{
              display: 'flex',
              gap: '5px',
              opacity: hovered ? 1 : 0,
              pointerEvents: hovered ? 'auto' : 'none',
              transition: 'opacity 0.15s ease',
            }}>
              {onSummon && (
                <span
                  onClick={(e) => { e.stopPropagation(); onSummon(); }}
                  title="Ring the doorbell — summon this agent into a call"
                  style={{
                    fontSize: '8px',
                    padding: '1px 5px',
                    borderRadius: '3px',
                    background: color.panel,
                    color: color.blue,
                    border: `1px solid ${color.line}`,
                    cursor: 'pointer',
                    fontWeight: 600,
                  }}
                >
                  Summon
                </span>
              )}
            </div>
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
          {/* CUT 2026-08-15: session duration and the away timestamp. The
              presence dot already answers "are they here"; a second, finer
              answer beside it is detail nobody needs to send a message. */}
        </div>
      </div>
      {/* Message preview (if unread) */}
      {hasUnread && thread.lastMessage && (
        <div style={{
          fontSize: '11px',
          color: color.dim,
          marginTop: '2px',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          paddingLeft: '36px',
          fontWeight: 500,
        }}>
          {thread.lastMessage.from === myHandle ? 'You: ' : ''}
          {thread.lastMessage.body}
        </div>
      )}
      {/* CUT 2026-08-15 (ruthless pass): the "working on…" status line.
          A row carries only what you need to reach someone — dot, handle,
          human/agent, unread, one action. What they are working on is status
          theater: it does not help you send, and a list of everyone's
          activity is the feed Buddy is explicitly not. The unread PREVIEW
          above stays; that IS job 3. */}
      {/* CUT 2026-08-15: tech-stack pills, model chip and streak badge.
          Profile data — how someone builds — is VibeStats' job, and a public
          profile is a different product with different consent. None of it
          helps you reach a person. */}
    </div>
    {/* SIBLING OF THE ROW BUTTON, not a descendant. ARIA button descendants
        are presentational, so nested inside role="button" this control was
        tabbable but screen readers could expose only the outer
        "@handle, paired…" name — the action was invisible to exactly the
        readers who need it announced (codex P2). */}
    {isPaired && onSessionView && (
      <span
        role="button"
        tabIndex={0}
        className="vibe-press"
        onClick={(e) => { e.stopPropagation(); onSessionView(); }}
        onKeyDown={(e) => { e.stopPropagation(); pressOnKey(onSessionView)(e); }}
        aria-label={`watch @${user.handle}'s shared session`}
        style={{
          flexShrink: 0,
          alignSelf: 'center',
          fontSize: '8px',
          padding: '1px 5px',
          borderRadius: '3px',
          background: color.panel,
          color: color.blue,
          border: `1px solid ${color.line}`,
          whiteSpace: 'nowrap',
          cursor: 'pointer',
        }}
      >
        Watch
      </span>
    )}
    </div>
  );
}

export function SessionRow({
  session,
  onSession,
}: {
  session: SessionEntity;
  onSession?: (parentHandle: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const clickable = !!onSession;
  const canType = session.guestEnabled && clickable;

  return (
    <div
      className={clickable ? 'vibe-press' : undefined}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      aria-label={clickable ? `${session.parent}'s session, ${session.project || 'coding'}` : undefined}
      onKeyDown={clickable ? pressOnKey(() => onSession?.(session.parent)) : undefined}
      style={{
        padding: '4px 10px 4px 48px',
        borderRadius: '4px',
        background: hovered && clickable ? color.panel : color.bg,
        marginBottom: '2px',
        cursor: clickable ? 'pointer' : 'default',
        transition: 'background 0.15s ease, border-color 0.15s ease',
        borderLeft: `2px solid ${color.line}`,
      }}
      onClick={() => onSession?.(session.parent)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span style={{ fontSize: '12px' }}>{session.badge}</span>
          <span style={{
            fontWeight: 500,
            color: color.dim,
            fontSize: '11px',
            fontFamily: 'monospace',
          }}>
            {session.parent}/claude
          </span>
          {session.guestEnabled && (
            <span style={{
              fontSize: '7px',
              padding: '1px 4px',
              borderRadius: '3px',
              background: color.line,
              color: color.dim,
              border: `1px solid ${color.line}`,
              fontWeight: 700,
              letterSpacing: '0.3px',
            }}>
              OPEN
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
          {session.model && (
            <span style={{
              fontSize: '8px',
              padding: '1px 4px',
              borderRadius: '3px',
              background: color.line,
              color: color.dim,
              border: `1px solid ${color.line}`,
            }}>
              {session.model}
            </span>
          )}
          <span style={{
            fontSize: '8px',
            color: color.faint,
            fontFamily: 'monospace',
          }}>
            {session.turnCount}t
          </span>
          {hovered && clickable && (
            <span style={{
              fontSize: '8px',
              padding: '1px 5px',
              borderRadius: '3px',
              background: canType ? color.line : color.panel,
              color: color.blue,
              border: `1px solid ${canType ? color.line : color.line}`,
              fontWeight: 600,
              whiteSpace: 'nowrap',
            }}>
              {canType ? 'Type' : 'Watch'}
            </span>
          )}
        </div>
      </div>
      {session.project && (
        <div style={{
          fontSize: '10px',
          color: color.faint,
          paddingLeft: '18px',
          marginTop: '1px',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {session.project}
        </div>
      )}
    </div>
  );
}