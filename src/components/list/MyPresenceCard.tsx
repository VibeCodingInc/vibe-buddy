// MyPresenceCard — extracted verbatim from UnifiedBuddyList.tsx (Move 2 split).
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
import { presenceStatusLine, selfDotConfirmed, type PresencePrefs, type PresenceBroadcast, type OfflineRetraction } from '../../lib/presencePrefs';
import { waitingThreads, sessionsSummary } from '../../lib/interval';
import { mySessionsBlock, mySessionsStaleLine, effectiveAgoMs, FIRST_RECOGNITION, type MySessionsProbe } from '../../lib/mySessionsState';
import { sessionLadder, type Rung, type SeatProbe } from '../../lib/sessionLadder';
import { isFreshAge, isFreshLastSeen } from '../../lib/freshness';
import { getSummonable, summonAgent } from '../../lib/doorbell';
import { MySessionsSection } from './MySessions';
import { formatAgo, formatModel, pressOnKey } from './format';
import { avatarFailed, menuItemStyle, TEST_HANDLE_PREFIXES, isTestAccount, LEGACY_AGENT_HANDLES, isBroadcastOnly, isUnproven, presenceDotColor, isAgent, MACHINE_ONELINERS, formatDuration, formatTime, Avatar, hasDNA } from './shared';





// --- My Presence card ---
// The vibecoder's own broadcast, made visible and controllable: exactly what
// others see (the last heartbeat actually sent), a hand-written status that
// overrides the DNA-derived line, a full/minimal detail switch, and an
// invisible mode. Collapsed it's one quiet row; expanded it's the controls.
export function MyPresenceCard({
  handle,
  prefs,
  broadcast,
  lastLandedAt,
  retraction = null,
  liveSessionCount = null,
  onChange,
}: {
  handle: string;
  prefs: PresencePrefs;
  broadcast: PresenceBroadcast | null;
  lastLandedAt: number | null;
  /** Receipt for the offline write sent on going invisible (audit #6). */
  retraction?: OfflineRetraction;
  /**
   * Session rows under a good read — they broadcast independently of Buddy.
   * null when the latest read failed: cannot-see, which is not zero.
   */
  liveSessionCount?: number | null;
  onChange: (patch: Partial<PresencePrefs>) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [draft, setDraft] = useState(prefs.statusText || '');

  // Keep the draft in sync when the status changes elsewhere (e.g. cleared).
  useEffect(() => {
    setDraft(prefs.statusText || '');
  }, [prefs.statusText]);

  const saveDraft = () => {
    const trimmed = draft.trim();
    onChange({ statusText: trimmed || null });
  };

  // "Announcing…" is only honest for a few seconds. A heartbeat that never
  // lands leaves it on screen forever, and it reads as progress — which is how
  // a Mac Studio sat signed-in, sharing on, and invisible to everyone while its
  // own window looked completely normal. After a grace period, say what is
  // actually true.
  const [announceGrace, setAnnounceGrace] = useState(true);
  useEffect(() => {
    if (broadcast) { setAnnounceGrace(true); return; }
    setAnnounceGrace(true);
    const t = setTimeout(() => setAnnounceGrace(false), 20_000);
    return () => clearTimeout(t);
  }, [broadcast]);

  // A moving `now` is load-bearing here: "stopped updating Xm ago" must age,
  // AND a live broadcast must be re-evaluated so its green expires the moment it
  // crosses the 10-min freshness window (audit #5) rather than staying lit until
  // the next render. Tick whenever either time-sensitive claim is on screen —
  // depends on the PRESENCE of a broadcast / landed record, not on `now`, so the
  // interval is stable.
  const [now, setNow] = useState(() => Date.now());
  // A confirmed retraction is also a time-sensitive claim: its "Invisible"
  // line expires on the freshness window, and a frozen clock would keep
  // isFreshAge true forever precisely while sharing is off (codex P1 r2).
  const timeSensitive =
    (prefs.sharing && (broadcast !== null || (!announceGrace && lastLandedAt !== null))) ||
    (!prefs.sharing && retraction !== null && typeof retraction === 'object');
  useEffect(() => {
    if (!timeSensitive) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [timeSensitive]);

  const statusLine = presenceStatusLine({
    sharing: prefs.sharing,
    broadcast,
    announceGrace,
    lastLandedAt,
    now,
    retraction,
    liveSessionCount,
  });

  // Is the last broadcast still fresh enough to be "what others see"? Same gate
  // as the dot and the status line. Drives the expanded block below so it can't
  // present a stale broadcast as current while the collapsed row already reads
  // "stopped updating" (codex, cluster review).
  const broadcastFresh = broadcast !== null && isFreshAge(now - broadcast.sentAt);

  const toggleStyle = (active: boolean): CSSProperties => ({
    flex: 1,
    background: active ? color.panel : 'transparent',
    border: `1px solid ${active ? color.line : color.line}`,
    borderRadius: '4px',
    padding: '4px 0',
    color: active ? color.blueBright : color.faint,
    fontSize: '10px',
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
  });

  return (
    <div style={{ marginBottom: '4px' }}>
      <div
        className="vibe-press"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-label="your presence — control what you share"
        onKeyDown={pressOnKey(() => setExpanded((v) => !v))}
        style={{
          padding: '8px 10px 8px 12px',
          borderRadius: expanded ? '6px 6px 0 0' : '6px',
          background: hovered || expanded ? color.hover : color.panel,
          border: `1px solid ${color.panel}`,
          borderBottom: expanded ? 'none' : `1px solid ${color.panel}`,
          cursor: 'pointer',
          transition: 'background 0.15s ease',
          opacity: prefs.sharing ? 1 : 0.65,
        }}
        onClick={() => setExpanded((v) => !v)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        title={expanded ? 'Hide presence controls' : 'Control what you share'}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
            <div style={{ position: 'relative' }}>
              <Avatar handle={handle} size={28} isAway={!prefs.sharing} />
              <span style={{
                position: 'absolute',
                bottom: -1,
                right: -1,
                width: 8,
                height: 8,
                borderRadius: '50%',
                // Green only while the last heartbeat actually landed — a
                // sharing pref is an intention; the broadcast is the receipt.
                background: selfDotConfirmed({ sharing: prefs.sharing, broadcast, now }) ? color.green : color.faint,
                border: `2px solid ${color.panel}`,
              }} />
            </div>
            <span style={{ fontWeight: 600, color: color.ink, fontSize: '13px' }}>
              {handle}
            </span>
            <span style={{ fontSize: '9px', color: color.faint }}>you</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '5px', flexShrink: 0 }}>
            {prefs.sharing && prefs.detail === 'minimal' && (
              <span style={{
                fontSize: '7px',
                padding: '1px 4px',
                borderRadius: '3px',
                background: color.panel,
                color: color.faint,
                border: `1px solid ${color.line}`,
                fontWeight: 700,
                letterSpacing: '0.3px',
              }}>
                MINIMAL
              </span>
            )}
            {!prefs.sharing && (
              <span style={{
                fontSize: '7px',
                padding: '1px 4px',
                borderRadius: '3px',
                background: color.panel,
                color: color.faint,
                border: `1px solid ${color.line}`,
                fontWeight: 700,
                letterSpacing: '0.3px',
              }}>
                INVISIBLE
              </span>
            )}
            <span style={{
              fontSize: '8px',
              color: color.faint,
              transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
              transition: 'transform 0.15s ease',
              display: 'inline-block',
            }}>
              {'›'}
            </span>
          </div>
        </div>
        <div style={{
          fontSize: '11px',
          color: color.faint,
          marginTop: '2px',
          // Two lines, then clip. One nowrap line amputated the failure copy
          // mid-clause: "Presence stopped updating 4m ago — …" shipped without
          // the part that says what it means. The claim must survive the width.
          overflow: 'hidden',
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          paddingLeft: '36px',
          lineHeight: 1.4,
        }}>
          {statusLine}
        </div>
      </div>

      {expanded && (
        <div
          style={{
            padding: '8px 10px 10px',
            background: color.bg,
            borderRadius: '0 0 6px 6px',
            border: `1px solid ${color.panel}`,
            borderTop: 'none',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* What others see — the actual last-sent broadcast, not a guess.
              Present tense ("Others see") only while the broadcast is FRESH; a
              stale one is dated as a snapshot, never claimed as current. */}
          {prefs.sharing && broadcastFresh && broadcast && (
            <div style={{
              fontSize: '10px',
              color: color.faint,
              marginBottom: '8px',
              lineHeight: 1.6,
            }}>
              <span style={{ color: color.faint, fontWeight: 600, textTransform: 'uppercase', fontSize: '8px', letterSpacing: '0.5px' }}>
                Others see{' '}
              </span>
              <span style={{ color: color.dim }}>{broadcast.workingOn}</span>
              {(broadcast.project || broadcast.branch || broadcast.model) && (
                <span style={{ fontFamily: 'monospace', color: color.faint }}>
                  {broadcast.project ? ` · ${broadcast.project}` : ''}
                  {broadcast.branch && !['main', 'master'].includes(broadcast.branch) ? ` · ${broadcast.branch}` : ''}
                  {broadcast.model ? ` · ${formatModel(broadcast.model)}` : ''}
                </span>
              )}
            </div>
          )}
          {prefs.sharing && !broadcastFresh && broadcast && (
            <div style={{ fontSize: '10px', color: color.faint, marginBottom: '8px', lineHeight: 1.6 }}>
              <span style={{ fontWeight: 600, textTransform: 'uppercase', fontSize: '8px', letterSpacing: '0.5px' }}>
                Buddy last sent{' '}
              </span>
              <span style={{ color: color.dim }}>{broadcast.workingOn}</span>
              <span> · {formatAgo(Math.max(0, Math.round((now - broadcast.sentAt) / 1000)))} ago — others may no longer see it</span>
            </div>
          )}

          {/* Custom status — overrides the CodingDNA-derived line */}
          <div style={{ display: 'flex', gap: '5px', marginBottom: '8px' }}>
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  saveDraft();
                  e.currentTarget.blur();
                } else if (e.key === 'Escape') {
                  setDraft(prefs.statusText || '');
                  e.currentTarget.blur();
                }
              }}
              placeholder="Set a status — what are you building?"
              maxLength={120}
              spellCheck={false}
              style={{
                flex: 1,
                minWidth: 0,
                boxSizing: 'border-box',
                background: color.panel,
                border: `1px solid ${color.panel}`,
                borderRadius: '4px',
                padding: '5px 8px',
                color: color.ink,
                fontSize: '11px',
                outline: 'none',
                fontFamily: 'inherit',
              }}
            />
            {draft.trim() !== (prefs.statusText || '') ? (
              <button
                type="button"
                onClick={saveDraft}
                style={{
                  background: color.blue,
                  border: 'none',
                  borderRadius: '4px',
                  padding: '5px 10px',
                  color: color.ink,
                  fontSize: '10px',
                  fontWeight: 600,
                  cursor: 'pointer',
                  flexShrink: 0,
                }}
              >
                Set
              </button>
            ) : prefs.statusText ? (
              <button
                type="button"
                onClick={() => onChange({ statusText: null })}
                title="Back to automatic status from your coding session"
                style={{
                  background: color.panel,
                  border: `1px solid ${color.line}`,
                  borderRadius: '4px',
                  padding: '5px 10px',
                  color: color.dim,
                  fontSize: '10px',
                  fontWeight: 600,
                  cursor: 'pointer',
                  flexShrink: 0,
                }}
              >
                Auto
              </button>
            ) : null}
          </div>

          {/* Detail level + visibility */}
          <div style={{ display: 'flex', gap: '5px' }}>
            <button
              type="button"
              onClick={() => onChange({ detail: 'full' })}
              title="Share project, branch, model, and tech stack"
              style={toggleStyle(prefs.sharing && prefs.detail === 'full')}
            >
              Full context
            </button>
            <button
              type="button"
              onClick={() => onChange({ detail: 'minimal' })}
              title="Just show you're online — no coding details"
              style={toggleStyle(prefs.sharing && prefs.detail === 'minimal')}
            >
              Minimal
            </button>
            <button
              type="button"
              onClick={() => onChange({ sharing: !prefs.sharing })}
              title={prefs.sharing
                ? 'Stop broadcasting — your dot fades out shortly'
                : 'Resume broadcasting presence'}
              style={{
                flex: 1,
                background: prefs.sharing ? 'transparent' : color.panel,
                border: `1px solid ${prefs.sharing ? color.line : color.line}`,
                borderRadius: '4px',
                padding: '4px 0',
                color: prefs.sharing ? color.faint : color.ink,
                fontSize: '10px',
                fontWeight: 600,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              {prefs.sharing ? 'Go invisible' : 'Go visible'}
            </button>
          </div>
          {!prefs.sharing && (
            <div style={{ fontSize: '9px', color: color.faint, marginTop: '6px', lineHeight: 1.5 }}>
              Not sending heartbeats — others will see you fade to away, then offline.
            </div>
          )}
        </div>
      )}
    </div>
  );
}