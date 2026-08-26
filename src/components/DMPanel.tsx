import { useState, useEffect, useRef } from 'react';
import { askMind, isFounderMind, looksConsequential, tensionFingerprint } from '../lib/mindClient';
import type { MindFacet } from '../lib/mindClient';
import { buddyClient, type VibeMessage, type VibeUser } from '../lib/vibeClient';
import { getCachedMessages, setCachedMessages } from '../lib/messageCache';
import { realtime } from '../lib/realtime';
import { color, space, radius, size } from '../lib/tokens';
import { vibeconfAvailability, startCall, joinLine, sessionContext } from '../lib/vibeconf';
import { rememberCall } from '../lib/callMemory';
import { isFreshLastSeen } from '../lib/freshness';
import { hasNoReadEvidence, isTestAccount } from './list/shared';

interface DMPanelProps {
  handle: string;
  chatWith: string;
  onBack: () => void;
  users: VibeUser[];
  /**
   * Open (or switch to) the thread with another principal — the first-message
   * door (buddy#53): an @handle inside a message body is clickable and lands
   * in the normal composer with NOTHING sent. Optional so the panel renders
   * unchanged where the host provides no navigation.
   */
  onOpenThread?: (handle: string) => void;
  /**
   * The roster snapshot behind `users` has gone stale (App retains the last
   * good snapshot through refresh failures, by design). Served words in the
   * header must not outlive their evidence — the whole clause line
   * suppresses rather than repeating 'away 2h' forever (codex r6 P2).
   */
  presenceStale?: boolean;
  /**
   * The SERVER's thread list says a thread with this principal exists.
   * Opening a conversation must not create one (codex r1 P1 on #53): the
   * platform's GET thread-messages calls getOrCreateThread, so polling a
   * never-messaged principal would persist an empty thread into RECENT
   * before any stored-message receipt. When this is false and no cache
   * exists, the panel defers polling until the first accepted send.
   * Boundary stated honestly: the served list is paginated, so a very old
   * thread beyond the page loads its history only after the first send.
   */
  hasServerThread?: boolean;
  /**
   * The thread list has been read successfully at least once this session.
   * When false, hasServerThread=false means "cannot know", not "none" —
   * the empty state says so instead of inviting a first message over
   * possibly-real history (codex r12 P1).
   */
  threadsCertain?: boolean;
}

// @handle tokens inside a message body, LINKING ONLY (buddy#53): this
// presents the text's own characters as a navigation affordance and claims
// nothing about the handle — existence is decided at send, where the server
// refuses with `recipient_not_found` (and its lookup fails open, so nothing
// is ever "verified"). A token counts only at a word boundary, so an email's
// `@domain` half never becomes a link.
// Trailing boundary too (codex r2 P2): a 40+-char run is an invalid token
// and must stay TEXT — linking its first 39 chars would navigate to a
// truncated, different handle. 39 = the platform/GitHub handle cap.
const HANDLE_TOKEN = /@([A-Za-z0-9][A-Za-z0-9_-]{0,38})(?![A-Za-z0-9_-])/g;
export function renderBodyWithHandles(
  body: string,
  onOpen?: (handle: string) => void,
  // SERVED FORM FIRST (codex r13 P1): when the host can see a served
  // identity carrying the raw (possibly hyphenated) form, the link targets
  // it verbatim; aliasing to underscores applies only when no served
  // identity claims the raw form.
  servedKnows?: (raw: string) => boolean,
): Array<string | { handle: string; text: string }> {
  const parts: Array<string | { handle: string; text: string }> = [];
  let last = 0;
  for (const m of body.matchAll(HANDLE_TOKEN)) {
    const at = m.index ?? 0;
    const before = body.slice(last, at);
    // Word boundary: the char before '@' must not be a word char — 'a@b' is
    // an email-ish token, not a mention.
    if (at > 0 && /[A-Za-z0-9_]/.test(body[at - 1])) continue;
    parts.push(before);
    // Canonical form mirrors the PLATFORM's own handle rule
    // (getHandleRecord maps hyphens to underscores): '@foo-bar' must reach
    // the real foo_bar, not a parallel thread it can never read
    // (codex r1 P1 on #53). Display keeps the text's own characters.
    // Synthetic-QA principals are deliberately removed from this board
    // (shared.tsx isTestAccount); a mention of one stays TEXT (codex r9
    // P2) — linking it would open a conversation the list then hides.
    // Both forms: the prefix list carries 'synth-' (hyphenated), which the
    // canonical underscore form would slip past.
    const raw = m[1].toLowerCase();
    const canonical = servedKnows?.(raw) ? raw : raw.replace(/-/g, '_');
    // The platform handle grammar (validateHandle: 3–20 chars, not
    // numeric-only, no leading underscore) — an unregisterable token stays
    // TEXT instead of minting a composer that ends in recipient_not_found
    // (codex r12 P2). Synthetic-QA principals likewise.
    const impossible =
      canonical.length < 3 || canonical.length > 20 ||
      /^[0-9]+$/.test(canonical) || canonical.startsWith('_');
    if (impossible || isTestAccount(raw) || isTestAccount(canonical)) {
      parts.push(m[0]); last = at + m[0].length; continue;
    }
    parts.push({ handle: canonical, text: m[0] });
    last = at + m[0].length;
  }
  parts.push(body.slice(last));
  return onOpen ? parts.filter((p) => p !== '') : [body];
}

// A thread can span months, so a bare time ("1:56 PM") can't tell today's
// message from one 164 days ago. Show the date whenever it isn't today:
// today → time only, yesterday → "Yesterday 1:56 PM", older → "Feb 3, 1:56 PM"
// (with the year once the message is from a previous year).
function formatMessageTime(ts: string | number | Date): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const now = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
  const dayDiff = Math.round((startOfDay(now).getTime() - startOfDay(d).getTime()) / 86400000);
  if (dayDiff === 0) return time;
  if (dayDiff === 1) return `Yesterday ${time}`;
  const dateOpts: Intl.DateTimeFormatOptions =
    d.getFullYear() === now.getFullYear()
      ? { month: 'short', day: 'numeric' }
      : { month: 'short', day: 'numeric', year: 'numeric' };
  return `${d.toLocaleDateString([], dateOpts)}, ${time}`;
}

export default function DMPanel({ handle, chatWith, onBack, users, onOpenThread, hasServerThread = true, presenceStale = false, threadsCertain = true }: DMPanelProps) {
  // Invite this person into a call.
  //
  // The agent half is the point, and it does NOT need summon infrastructure:
  // the recipient's agent joins exactly the way ours does, by pasting the join
  // line into their own coding session. We already have a channel to them — a
  // DM — so the invite rides that. No new transport, no allowlist, no consent
  // seam to negotiate, and it works for anyone Buddy can already message.
  // Four states, not two — the same correction made in UnifiedBuddyList. "Not
  // asked yet" and "vibeconf is closed" both rendered nothing, so a gated
  // capability was indistinguishable from a removed one.
  type InviteProbe = 'unasked' | 'ready' | 'closed' | 'unknown';
  const [inviteProbe, setInviteProbe] = useState<InviteProbe>('unasked');
  const [inviteState, setInviteState] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setInviteProbe('unasked');
    vibeconfAvailability().then((result) => {
      if (cancelled) return;
      setInviteProbe(result.error ? 'unknown' : result.available ? 'ready' : 'closed');
    });
    return () => { cancelled = true; };
  }, [chatWith]);
  const canInvite = inviteProbe === 'ready';

  const inviteToCall = async () => {
    setInviteState('starting…');
    try {
      // Seed the room with who it is for and what they were doing, so the
      // person arriving is not walking into a blank Meet with no idea why.
      const info = await startCall(
        sessionContext({
          project: them?.project || undefined,
          workingOn: `a call with @${handle} and @${chatWith}`,
        }),
      );
      // Both halves in one message: the link a human clicks, and the line their
      // agent needs. Stated plainly — the recipient should not have to be told
      // separately what to do with it.
      const body =
        `join me: ${info.url}\n` +
        `to bring your agent, paste this into the session you are working in: ${joinLine(info.code)}`;
      rememberCall({ url: info.url, code: info.code, from: chatWith });
      const sent = await buddyClient.sendMessage(chatWith, body);
      if (!sent) throw new Error('the invite could not be sent');
      realtime.recordStoredMessageWith(chatWith);
      setPollArmed(true);
      setInviteState('invite sent');
      setTimeout(() => setInviteState(null), 6000);
    } catch (e) {
      // Never claim an invite landed. The call may well be open in the browser
      // while the message failed, and those are different facts.
      setInviteState('call started — invite failed to send');
      setTimeout(() => setInviteState(null), 8000);
    }
  };
  const [messages, setMessages] = useState<VibeMessage[]>([]);
  // WHY a local send was refused, by message id — so recipient_not_found can
  // render as its honest reason instead of a generic Failed (buddy#53). Local
  // presentation state only; nothing here creates or implies a thread.
  const [failReasons, setFailReasons] = useState<Map<string, string>>(new Map());
  const [input, setInput] = useState('');
  // The message the human explicitly chose to answer. Set ONLY by the
  // per-message "reply" action; never auto-selected, never a newest-message
  // default. null = an ordinary unlinked send.
  const [replyingTo, setReplyingTo] = useState<{ id: string; from: string; text: string } | null>(null);
  // Per-optimistic-message reply target, so a Retry of a FAILED reply-
  // targeted send re-sends with the same parent (the failed bubble + Retry
  // is Buddy's established "draft intact" mechanism; this keeps the target
  // intact alongside the text). Keyed by the optimistic id.
  const [failReplyTargets, setFailReplyTargets] = useState<Map<string, string>>(new Map());
  // Drives the shortcut hint only — shown while composing, silent otherwise,
  // so the discoverability line is not standing chrome.
  const [composerFocused, setComposerFocused] = useState(false);
  const [sending, setSending] = useState(false);
  // ── FOUNDER MIND (sender-side telepathy) ─────────────────────────────
  // One source-honest line or nothing. Never blocks send, never a spinner.
  // The Studio answers in 30–50s; the result renders ONLY if the same
  // draft-tension is still current at arrival — else discarded silently.
  const [mindOffer, setMindOffer] = useState<MindFacet | null>(null);
  const [mindOfferFp, setMindOfferFp] = useState('');
  const [mindReveal, setMindReveal] = useState(false);
  const mindAskTimer = useRef<number | undefined>(undefined);
  const mindDismissedFp = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!isFounderMind()) return;
    window.clearTimeout(mindAskTimer.current);
    // any edit that changes the tension clears a now-stale offer
    if (mindOffer && tensionFingerprint(chatWith, input) !== mindOfferFp) {
      setMindOffer(null);
      setMindReveal(false);
    }
    if (!looksConsequential(input)) return;
    const fp = tensionFingerprint(chatWith, input);
    if (mindDismissedFp.current.has(fp)) return; // dismissed = dismissed
    mindAskTimer.current = window.setTimeout(() => {
      void askMind(chatWith, input).then((res) => {
        if (!res || res.facet.silence) return;
        // THE DISCARD RULE: render only if this exact tension is current.
        setInput((cur) => {
          if (tensionFingerprint(chatWith, cur) === res.fingerprint) {
            setMindOffer(res.facet);
            setMindOfferFp(res.fingerprint);
          } // else: discarded silently — the human moved on
          return cur;
        });
      });
    }, 2500); // debounce: a pause in typing, not every keystroke
    return () => window.clearTimeout(mindAskTimer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input, chatWith]);
  const [isTyping, setIsTyping] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTypingSentRef = useRef(0);
  // The needle's tap target: which parent is briefly highlighted, and which
  // needle has keyboard focus (explicit ring in the dark UI).
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [needleFocusedId, setNeedleFocusedId] = useState<string | null>(null);

  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Move to + highlight the parent a needle points at, then clear the
  // highlight after a short delay so "brief" is true (no animation — the
  // outline just appears and later disappears; reduced-motion safe). Only
  // called when the parent IS loaded (the needle is interactive only then),
  // so this never no-ops. Chronology is never changed; no read-state change.
  const scrollToParent = (parentId: string) => {
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(parentId)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    setHighlightedId(parentId);
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
    highlightTimer.current = setTimeout(() => setHighlightedId(null), 2500);
  };
  useEffect(() => () => { if (highlightTimer.current) clearTimeout(highlightTimer.current); }, []);

  const them = users.find(u => u.handle === chatWith) || null;
  const me = users.find(u => u.handle === handle) || null;

  // THE RECEIPT BOUNDARY (codex r1 P1 on #53): the platform's thread-messages
  // GET calls getOrCreateThread, so polling a never-messaged principal would
  // CREATE a durable empty thread — RECENT must gain a row only from a
  // stored-message receipt. Polling arms only when the server already lists
  // this thread, a local cache proves prior history, or a send in this panel
  // was accepted.
  const [pollArmed, setPollArmed] = useState<boolean>(
    () =>
      hasServerThread ||
      getCachedMessages(handle, chatWith).length > 0 ||
      // Retained SSE evidence (codex r9 P1): the peer's message event
      // arrived while no panel was mounted — an archived thread's only
      // trace, since archiving survives new messages and the inbox filters
      // it forever.
      realtime.hasMessageEvidenceFrom(chatWith),
  );
  // Server truth can arrive AFTER mount: the recipient sends first, App's
  // thread poll flips hasServerThread, and this open conversation must join
  // the wire instead of sitting empty until a send or remount (codex r2 P1).
  useEffect(() => {
    if (hasServerThread) setPollArmed(true);
  }, [hasServerThread]);

  useEffect(() => {
    // Load cached messages immediately
    const cached = getCachedMessages(handle, chatWith);
    if (cached.length > 0) {
      setMessages(cached);
    }
    if (!pollArmed) {
      // Composer-first: nothing fetched, nothing created. But stay AWAKE:
      // an archived conversation never reappears in the inbox (archiving
      // survives new messages), so the peer writing is only visible as a
      // passive SSE message event. That event is stored-message evidence —
      // exactly the receipt boundary's bar — so it arms polling
      // (codex r7 P2). The SSE connection itself fetches no thread and
      // creates nothing.
      realtime.init(handle);
      realtime.setMessageEvidenceCallback((from) => {
        if (from === chatWith) setPollArmed(true);
      });
      return () => {
        realtime.setMessageEvidenceCallback(null);
      };
    }

    const handleIncoming = (thread: VibeMessage[]) => {
      setMessages((prev) => {
        const optimistic = prev.filter(
          (m) => m.id.startsWith('local_') && m.status !== 'failed'
        );
        const confirmed = optimistic.filter((opt) =>
          !thread.some(
            (api) =>
              api.content === opt.content &&
              api.from === opt.from &&
              Math.abs(new Date(api.timestamp).getTime() - new Date(opt.timestamp).getTime()) < 30000
          )
        );
        const merged = [...thread, ...confirmed];
        setCachedMessages(handle, chatWith, thread);
        return merged;
      });
    };

    // Use realtime layer — SSE primary, polling fallback
    realtime.init(handle);
    realtime.openDM(chatWith, handleIncoming);

    // Listen for typing events
    realtime.setTypingCallback((from: string) => {
      if (from === chatWith) {
        setIsTyping(true);
        if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
        typingTimerRef.current = setTimeout(() => setIsTyping(false), 5000);
      }
    });

    return () => {
      realtime.goBackground();
      realtime.setTypingCallback(null);
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handle, chatWith, pollArmed]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const send = async (text?: string, forceUnlinked?: boolean) => {
    const msg = text || input.trim();
    if (!msg || sending) return;
    // The parent the HUMAN explicitly chose to answer (never a silent
    // newest-message default). Captured before the async send so an arriving
    // message can't shift the target mid-flight. forceUnlinked (the "send
    // without the link" recovery from invalid_reply_target) sends bare
    // regardless of any currently-composed target.
    const replyTarget = forceUnlinked ? null : replyingTo;
    const optimisticId = `local_${Date.now()}`;
    setSending(true);
    setInput('');
    // The composed unit (text + chosen target) becomes the pending message;
    // the composer + chip clear together, exactly like an ordinary send.
    setReplyingTo(null);

    const optimistic: VibeMessage = {
      id: optimisticId,
      from: handle,
      to: chatWith,
      content: msg,
      timestamp: new Date().toISOString(),
      status: 'pending',
      // Deliberately NO replyTo on the optimistic bubble: the needle renders
      // only from the SERVER-served link on the next read, never from the
      // local choice (coordinator scope).
    };
    setMessages((prev) => [...prev, optimistic]);

    const result = await buddyClient.sendMessageResult(chatWith, msg, replyTarget?.id);
    if (result.ok) {
      // A stored-message receipt is exactly the evidence the receipt
      // boundary waits for — the server thread now exists; polling may join,
      // and the receipt outlives this panel (codex r15 P2).
      realtime.recordStoredMessageWith(chatWith);
      setPollArmed(true);
    }
    if (!result.ok) {
      setMessages((prev) =>
        prev.map((m) => (m.id === optimisticId ? { ...m, status: 'failed' } : m))
      );
      if (result.error) {
        setFailReasons((prev) => new Map(prev).set(optimisticId, result.error!));
      }
      // Keep the chosen target with the failed message so Retry re-sends it.
      if (replyTarget) {
        setFailReplyTargets((prev) => new Map(prev).set(optimisticId, replyTarget.id));
      }
    }
    setSending(false);
  };

  // Re-send a message that failed to leave the client. Flip it back to
  // 'pending' for immediate feedback; on failure it returns to 'failed', on
  // success the poll reconciles it against the real server copy (the merge
  // drops local_ messages that aren't 'failed').
  const retry = async (failed: VibeMessage) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === failed.id ? { ...m, status: 'pending' } : m))
    );
    setFailReasons((prev) => {
      if (!prev.has(failed.id)) return prev;
      const next = new Map(prev);
      next.delete(failed.id);
      return next;
    });
    // Re-send with the reply target the failed message carried, so a Retry
    // preserves the human's chosen parent (never silently dropping it).
    const result = await buddyClient.sendMessageResult(chatWith, failed.content, failReplyTargets.get(failed.id));
    if (result.ok) {
      realtime.recordStoredMessageWith(chatWith);
      setPollArmed(true);
      setFailReplyTargets((prev) => {
        if (!prev.has(failed.id)) return prev;
        const next = new Map(prev);
        next.delete(failed.id);
        return next;
      });
    }
    if (!result.ok) {
      setMessages((prev) =>
        prev.map((m) => (m.id === failed.id ? { ...m, status: 'failed' } : m))
      );
      if (result.error) {
        setFailReasons((prev) => new Map(prev).set(failed.id, result.error!));
      }
    }
  };

  const dropFailed = (id: string) => {
    setMessages((prev) => prev.filter((m) => m.id !== id));
    setFailReasons((prev) => { const n = new Map(prev); n.delete(id); return n; });
    setFailReplyTargets((prev) => { const n = new Map(prev); n.delete(id); return n; });
  };

  // The platform PERMANENTLY refused the chosen reply target
  // (invalid_reply_target — the parent is gone/invalid). Retrying the same
  // target is futile, so the failed bubble offers an explicit human choice
  // instead of Retry: send the same text WITHOUT the link, or take the text
  // back to the composer to pick a different parent. The link is never
  // silently dropped — the human decides.
  const sendUnlinked = async (failed: VibeMessage) => {
    dropFailed(failed.id);
    await send(failed.content, true); // force no link
  };
  const pickAnother = (failed: VibeMessage) => {
    setInput(failed.content);
    dropFailed(failed.id);
    // The human now taps a message's "reply" and sends — a new, valid target.
  };

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: '#0a0a0a',
        color: '#fff',
      }}
    >
      {/* Header with context */}
      <div
        style={{
          padding: '10px 12px',
          borderBottom: '1px solid #191919',
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button
            onClick={onBack}
            style={{
              background: 'none',
              border: 'none',
              color: '#555',
              cursor: 'pointer',
              fontSize: '14px',
              padding: '2px 4px',
            }}
          >
            &larr;
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1 }}>
            {/* IDENTITY-NEUTRAL until something served backs the identity
                (codex r2 P2): an unverified composer target is just a typed
                string, and painting a same-named GitHub account's face on it
                asserts an identity /vibe never served. A SERVED roster row
                is the bar — an accepted send is only a storage receipt (the
                recipient lookup fails open), and a thread's existence
                proves the same (codex r6 P2). */}
            {them ? (
              <img
                src={`https://github.com/${chatWith}.png?size=48`}
                alt={chatWith}
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: '50%',
                  flexShrink: 0,
                }}
              />
            ) : (
              <div
                aria-hidden
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: '50%',
                  flexShrink: 0,
                  background: '#151515',
                  border: `1px solid ${color.line}`,
                  color: color.faint,
                  fontSize: '11px',
                  fontWeight: 700,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {chatWith[0]?.toUpperCase()}
              </div>
            )}
            <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              {/* CUT 2026-08-15: the inferred state emoji. getDMContext calls
                  inferState, so this header was defining a person's state
                  client-side — the third surface this pass had to find. */}
              <span style={{ fontWeight: 600, fontSize: '13px', color: '#eee' }}>
                {them?.displayName || chatWith}
              </span>
              {them?.status === 'active' && isFreshLastSeen(them.lastSeen, Date.now()) && (
                <span style={{
                  width: '5px',
                  height: '5px',
                  borderRadius: '50%',
                  background: '#22c55e',
                  display: 'inline-block',
                }} />
              )}
            </div>
            {/* SERVED words, each clause on its own evidence, never inferred
                from each other (buddy#53 critique): "away Nh" is presence
                freshness; the reading words are the platform's reachability
                annotation (stale-unread evidence). Vocabulary is fixed by
                the critique — 'reading messages' at MOST, never 'will
                reply'; unknown renders as 'reading unknown' for agents;
                humans carry no annotation and get silence. Nothing here
                promises a response. */}
            {!presenceStale && (() => {
              const clauses: string[] = [];
              if (them?.status === 'away' && them.ago) clauses.push(`away ${them.ago}`);
              // 'not reading' — the board's shipped chip word for this
              // exact state, so board and thread say the same thing about
              // the same being. The full sentence ('hasn't been reading
              // messages here. yours will queue…') stays at the composer
              // moment, stated ONCE (mounted-honesty pin).
              if (them?.reachability === 'broadcast-only') clauses.push('not reading');
              else if (them?.isAgent && them?.reachability === 'unknown') clauses.push('reading unknown');
              // 'listening' renders NOTHING (codex r1 P1): the platform
              // flips that enum on fresh unread mail alone — mail ARRIVING
              // is not evidence of anyone READING. The critique's 'at most
              // "reading messages"' permits less; silence is the honest
              // amount.
              return clauses.length > 0 ? (
                <div style={{ marginTop: '2px', fontSize: size[11], color: color.faint }}>
                  {clauses.join(' · ')}
                </div>
              ) : null;
            })()}
            {/* CUT 2026-08-15: the inferred "looks like…" status line. */}
            {canInvite && (
              <button
                type="button"
                onClick={inviteToCall}
                disabled={!!inviteState}
                style={{
                  marginTop: space[1],
                  background: 'transparent',
                  border: `1px solid ${color.line}`,
                  borderRadius: radius.sm,
                  padding: `2px ${space[2]}px`,
                  color: inviteState ? color.faint : color.blue,
                  fontSize: size[11],
                  fontFamily: 'inherit',
                  cursor: inviteState ? 'default' : 'pointer',
                }}
              >
                {inviteState || 'invite to a call'}
              </button>
            )}
            {inviteProbe === 'closed' && (
              <span
                title="Buddy hands calls to the Vibeconferencing app, which has to be running on this Mac"
                style={{ marginTop: space[1], color: color.faint, fontSize: size[11] }}
              >
                open vibeconf to invite them to a call
              </span>
            )}
            {inviteProbe === 'unknown' && (
              <span
                title="Buddy could not reach the Vibeconferencing app to ask — this is not proof it is closed"
                style={{ marginTop: space[1], color: color.faint, fontSize: size[11] }}
              >
                couldn't check calls
              </span>
            )}
          </div>
          </div>
        </div>
      </div>

      {/* CUT 2026-08-15 (ruthless pass): the shared-context banner and the
          conversation starters. Both inferred things about a person from
          presence metadata and offered them as things to SAY — client-side
          inference, and the closest Buddy came to writing your messages for
          you. One composer, one conversation. */}

      {/* Messages */}
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          overflow: 'auto',
          padding: '10px 12px',
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: '6px',
        }}
      >

        {messages.length === 0 && (
          <div style={{ textAlign: 'center', color: '#333', padding: '30px', fontSize: '12px' }}>
            {/* Neutral copy, never "Start a conversation" — that claims none
                exists, which even a successful read cannot prove: the inbox
                returns only its first 50 threads and excludes archived ones,
                so absence here is not absence of history (codex review on
                #54). A failed read says even less. */}
            {pollArmed
              ? 'No messages yet'
              : threadsCertain
                ? `Write a message to @${chatWith}`
                : `can't check for history right now — a sent message will land in the same thread either way`}
          </div>
        )}

        {messages.map((msg) => {
          const isMe = msg.from === handle;
          return (
            <div
              key={msg.id}
              data-msg-id={msg.id}
              style={{
                alignSelf: isMe ? 'flex-end' : 'flex-start',
                maxWidth: '85%',
                // Brief highlight when a needle points here — an instant
                // outline (no animation: honors no-motion-on-chrome +
                // reduced-motion), cleared on the next interaction. It does
                // not change read state.
                outline: highlightedId === msg.id ? `1px solid ${color.blue}` : 'none',
                outlineOffset: '2px',
                borderRadius: '12px',
              }}
            >
              {/* THE NEEDLE — server-backed reply association (buddy magic
                  pass). Three deployed-contract states:
                   · unavailable/deleted parent → served as
                     {id, from:null, text:null}: render quiet, plain,
                     non-interactive "↳ replying to an unavailable message".
                   · available parent that IS loaded in this view → an
                     interactive link (arrow, pointer, "opens the original");
                     click/Enter moves to + highlights it.
                   · available parent NOT in the loaded page → the served
                     quote as PLAIN text (no arrow, no link, no claim) — we
                     never promise to open something we can't reach.
                  QUOTES the sanitized parent verbatim, never classifies it.
                  Absent replyTo → ordinary message, no chrome. */}
              {msg.replyTo && msg.replyTo.text === null && (
                <div style={{ fontSize: '11px', color: color.faint, marginBottom: '2px' }}>
                  ↳ replying to an unavailable message
                </div>
              )}
              {msg.replyTo && msg.replyTo.text !== null && (() => {
                const parentLoaded = messages.some((mm) => mm.id === msg.replyTo!.id);
                const quote = (
                  <span
                    style={{ color: color.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    “{msg.replyTo!.text}”
                  </span>
                );
                if (!parentLoaded) {
                  // PLAIN, non-interactive: no link role, no arrow, no
                  // pointer, no "opens the original" claim — the parent is
                  // not reachable in this view, so the quote is just a quote.
                  return (
                    <div style={{ fontSize: '11px', color: color.faint, marginBottom: '2px', display: 'flex', gap: '4px', alignItems: 'baseline', maxWidth: '100%' }}>
                      <span style={{ flexShrink: 0 }}>↳ answering</span>
                      {quote}
                    </div>
                  );
                }
                return (
                  <div
                    role="link"
                    tabIndex={0}
                    aria-label={`Answering: "${msg.replyTo!.text}". Opens the original message.`}
                    onClick={() => scrollToParent(msg.replyTo!.id)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); scrollToParent(msg.replyTo!.id); } }}
                    onFocus={() => setNeedleFocusedId(msg.id)}
                    onBlur={() => setNeedleFocusedId(null)}
                    style={{
                      fontSize: '11px',
                      color: color.faint,
                      marginBottom: '2px',
                      cursor: 'pointer',
                      display: 'flex',
                      gap: '4px',
                      alignItems: 'baseline',
                      maxWidth: '100%',
                      outline: needleFocusedId === msg.id ? `1px solid ${color.blue}` : 'none',
                      outlineOffset: '1px',
                      borderRadius: '3px',
                    }}
                  >
                    <span aria-hidden style={{ flexShrink: 0 }}>↳ answering</span>
                    {quote}
                    <span aria-hidden style={{ color: color.blue, flexShrink: 0 }}>›</span>
                  </div>
                );
              })()}
              {/* SERVED kind only (platform#272; coordinator ruling): the
                  label renders when the platform marked the message — never
                  inferred from body text or the sender handle, and never
                  'via @coltrane' unless the platform can truthfully
                  establish authorship. Dark until the seam deploys. */}
              {msg.kind === 'announcement' && (
                <div style={{ fontSize: '9px', color: color.faint, marginBottom: '2px', letterSpacing: '0.4px', textTransform: 'uppercase' }}>
                  automated announcement · from /vibe
                </div>
              )}
              <div
                style={{
                  background: isMe ? '#6B8FFF' : '#151515',
                  color: isMe ? '#fff' : '#ddd',
                  padding: '8px 10px',
                  borderRadius: isMe ? '12px 12px 4px 12px' : '12px 12px 12px 4px',
                  fontSize: '13px',
                  lineHeight: '1.4',
                  opacity: msg.status === 'failed' ? 0.5 : 1,
                  // STRUCTURE FIDELITY (joint critique on buddy#49): between
                  // builders and agents the payload IS structure — numbered
                  // lists, blank-line separations, indented commands. Default
                  // whitespace collapsed every \n to a space (an agent's
                  // findings arrived as one run-on paragraph; Buddy's own
                  // call invite mangled itself). `pre-wrap` renders the body
                  // structure-faithfully; it stays INERT plain text — React
                  // text node, no Markdown, no HTML, nothing executable.
                  whiteSpace: 'pre-wrap',
                  // A long unbroken token (a URL, a hash) must wrap inside
                  // the bubble instead of forcing the thread sideways.
                  overflowWrap: 'anywhere',
                  // A bulletin is posted, not said: squared corners + a
                  // hairline, only when the kind is SERVED.
                  ...(msg.kind === 'announcement'
                    ? { background: '#101216', border: `1px solid ${color.line}`, borderRadius: '6px' }
                    : {}),
                }}
              >
                {renderBodyWithHandles(msg.content, onOpenThread, (raw) =>
                  // The current PEER, a roster row, or a sender already in
                  // THIS served thread — the sightings this panel holds
                  // (codex r14/r15 P2; the full resolution is the platform
                  // identity read on #272). An all-outbound thread's own
                  // peer must keep their form.
                  raw === chatWith.toLowerCase() ||
                  users.some((u) => u.handle.toLowerCase() === raw) ||
                  messages.some((m2) => m2.from.toLowerCase() === raw),
                ).map((part, i) =>
                  typeof part === 'string' ? (
                    part
                  ) : (
                    <span
                      key={i}
                      role="link"
                      tabIndex={0}
                      onClick={() => onOpenThread?.(part.handle)}
                      onKeyDown={(e) => { if (e.key === 'Enter') onOpenThread?.(part.handle); }}
                      style={{ textDecoration: 'underline', cursor: 'pointer' }}
                    >
                      {part.text}
                    </span>
                  ),
                )}
              </div>
              <div
                style={{
                  fontSize: '9px',
                  color: '#333',
                  marginTop: '2px',
                  textAlign: isMe ? 'right' : 'left',
                }}
              >
                {formatMessageTime(msg.timestamp)}
                {/* Explicit reply targeting: the human chooses THIS message
                    as the one they're answering. Only on durable messages
                    (a local_ optimistic has no server id to target). Never
                    auto-selected. */}
                {!msg.id.startsWith('local_') && msg.status !== 'failed' && (
                  <button
                    type="button"
                    onClick={() => setReplyingTo({ id: msg.id, from: msg.from, text: msg.content })}
                    aria-label={`Reply to this message: "${msg.content.slice(0, 80)}"`}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      color: color.faint,
                      fontSize: '9px',
                      fontFamily: 'inherit',
                      cursor: 'pointer',
                      marginLeft: '6px',
                      padding: 0,
                    }}
                  >
                    reply
                  </button>
                )}
                {msg.status === 'failed' && failReasons.get(msg.id) === 'recipient_not_found' && (
                  // The server's refusal, stated as HISTORY. It outranks a
                  // roster row (codex r9 P2): the snapshot may be RETAINED
                  // and older than the refusal, so only an accepted retry —
                  // newer send-path truth — clears this line (retry() does).
                  // No phantom thread exists; the lookup fails open, so
                  // nothing claims existence either way.
                  <div style={{ color: color.faint, marginBottom: '1px' }}>
                    the server couldn&rsquo;t find @{chatWith} when this was
                    sent — double-check the handle, or retry
                  </div>
                )}
                {/* PERMANENT reply-target refusal: the chosen parent is
                    gone/invalid, so a plain Retry (same target) is futile and
                    is NOT offered. One explanation + an explicit human choice:
                    send the same text without the link, or take it back to
                    pick another parent. The link is never silently dropped. */}
                {msg.status === 'failed' && failReasons.get(msg.id) === 'invalid_reply_target' && (
                  <div style={{ marginTop: '1px' }}>
                    <div style={{ color: color.faint, marginBottom: '2px' }}>
                      that message can&rsquo;t be replied to — it may have been
                      deleted. send without the link, or pick another to answer.
                    </div>
                    <button
                      type="button"
                      onClick={() => sendUnlinked(msg)}
                      style={{ background: 'transparent', border: 'none', color: '#6B8FFF', fontSize: '9px', fontFamily: 'inherit', cursor: 'pointer', padding: 0, textDecoration: 'underline' }}
                    >
                      send without the link
                    </button>
                    <button
                      type="button"
                      onClick={() => pickAnother(msg)}
                      style={{ background: 'transparent', border: 'none', color: '#6B8FFF', fontSize: '9px', fontFamily: 'inherit', cursor: 'pointer', marginLeft: '10px', padding: 0, textDecoration: 'underline' }}
                    >
                      pick another
                    </button>
                  </div>
                )}
                {msg.status === 'failed' && failReasons.get(msg.id) !== 'invalid_reply_target' && (
                  <>
                    <span style={{ color: '#ff4444', marginLeft: '4px' }}>Failed</span>
                    <button
                      type="button"
                      onClick={() => retry(msg)}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: '#6B8FFF',
                        fontSize: '9px',
                        fontFamily: 'inherit',
                        cursor: 'pointer',
                        marginLeft: '4px',
                        padding: 0,
                        textDecoration: 'underline',
                      }}
                    >
                      Retry
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Typing indicator */}
      {isTyping && (
        <div style={{
          padding: '2px 12px 4px',
          fontSize: '11px',
          color: '#555',
          flexShrink: 0,
        }}>
          @{chatWith} is typing...
        </div>
      )}

      {/* The moment the promise gets made. Everywhere else a dimmed dot is
          ambient; here someone is about to type a question and wait for an
          answer that is not coming. Say so before they spend the effort, not
          after. Stated once, quietly, and it does not block sending — the
          message still queues for whenever the recipient starts reading. */}
      {(them?.reachability === 'broadcast-only' || (them ? hasNoReadEvidence(them) : false)) && (
        <div
          style={{
            padding: '6px 10px',
            borderTop: `1px solid ${color.line}`,
            color: color.faint,
            fontSize: '11px',
            flexShrink: 0,
          }}
        >
          {/* EACH LINE STANDS ON ITS OWN EVIDENCE — no fallback branch. */}
          {them?.reachability === 'broadcast-only' && (
            <div>
              @{chatWith} hasn't been reading messages here. yours will queue
              until it does.
            </div>
          )}
          {/* A STANDING EVIDENCE GAP, not a fact about the past. "nobody has
              messaged this agent yet" was the first draft and it goes false
              the instant you send. The predicate keys on lastReadAt so the
              line survives the first send — unread mail flips the enum to
              'listening' without anyone having read anything. */}
          {them && hasNoReadEvidence(them) && them.reachability !== 'broadcast-only' && (
            <div>nothing here shows whether @{chatWith} reads or answers.</div>
          )}
        </div>
      )}

      {/* ── FOUNDER MIND: one source-honest line or nothing ─────────────
          Sender-side telepathy. No spinner, no badge, no persona; sending
          never waits. Dismiss forgets this exact tension permanently. */}
      {mindOffer && !mindOffer.silence && (
        <div style={{ padding: '4px 12px 0', flexShrink: 0 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12, color: color.dim }}>
            <span style={{ cursor: 'pointer' }} onClick={() => setMindReveal(true)}>
              {mindOffer.line || 'your own material bears on this · see? ›'}
            </span>
            <span
              style={{ marginLeft: 'auto', color: color.faint, cursor: 'pointer' }}
              onClick={() => {
                mindDismissedFp.current.add(mindOfferFp);
                setMindOffer(null);
                setMindReveal(false);
              }}
            >
              ✕
            </span>
          </div>
        </div>
      )}
      {mindReveal && mindOffer && (
        <div style={{ padding: '8px 12px', borderTop: `1px solid ${color.line}`, flexShrink: 0, fontSize: 12 }}>
          {mindOffer.offer_kind === 'aperture' ? (
            <>
              {/* PRIVATE TO YOU: consult-only prevents direct crossing — it
                  does not prevent the OWNER from seeing the insight. The
                  facet renders in full; only the quote may not travel. */}
              <div style={{ color: color.faint, fontSize: 10, letterSpacing: '0.04em', marginBottom: 4 }}>
                PRIVATE TO YOU — this may not cross as written
              </div>
              {mindOffer.facet && (
                <div style={{ color: color.ink, marginBottom: 6 }}>{mindOffer.facet}</div>
              )}
              {mindOffer.why_rotates && (
                <div style={{ color: color.dim, marginBottom: 6 }}>{mindOffer.why_rotates}</div>
              )}
              <div style={{ color: color.dim, whiteSpace: 'pre-wrap', marginBottom: 6 }}>
                “{mindOffer.aperture?.shown_to_seth_only?.exact_words}”
              </div>
              <div style={{ color: color.faint, fontSize: 10.5 }}>
                {mindOffer.attribution ? `${mindOffer.attribution} · ` : ''}
                {mindOffer.aperture?.shown_to_seth_only?.source || mindOffer.source} ·{' '}
                {mindOffer.aperture?.shown_to_seth_only?.freshness || mindOffer.content_date} ·{' '}
                {mindOffer.disclosure_reason}
              </div>
              <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
                <span
                  style={{ color: color.blue, cursor: 'pointer' }}
                  onClick={() => {
                    // "say it in my words": seeds the draft with a PROMPT to
                    // author the facet, never with the withheld quote.
                    setInput((cur) => cur.trimEnd());
                    setMindReveal(false);
                  }}
                >
                  say it in my words
                </span>
                <span style={{ color: color.faint, cursor: 'pointer' }} onClick={() => setMindReveal(false)}>
                  close
                </span>
              </div>
            </>
          ) : (
            <>
              <div style={{ color: color.ink, whiteSpace: 'pre-wrap', marginBottom: 6 }}>
                “{mindOffer.quote}”
              </div>
              <div style={{ color: color.faint, fontSize: 10.5 }}>
                {mindOffer.attribution} · {mindOffer.content_date} · {mindOffer.source}
              </div>
              {mindOffer.why_rotates && (
                <div style={{ color: color.dim, marginTop: 6 }}>{mindOffer.why_rotates}</div>
              )}
              <div style={{ color: color.faint, fontSize: 10.5, marginTop: 4 }}>
                {mindOffer.labeled_inference || "your agent's inference that this relates — you judge"}
                {mindOffer.caveat ? ` · ${mindOffer.caveat}` : ''}
              </div>
              <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
                <span
                  style={{ color: color.blue, cursor: 'pointer' }}
                  onClick={() => {
                    // add & review: appends to the DRAFT for the human to
                    // edit and send. The Mind never sends.
                    setInput((cur) => (cur.trimEnd() + '\n\n' + (mindOffer.proposed_prose || mindOffer.quote || '')).trim());
                    setMindReveal(false);
                    setMindOffer(null);
                  }}
                >
                  add &amp; review
                </span>
                <span style={{ color: color.faint, cursor: 'pointer' }} onClick={() => setMindReveal(false)}>
                  close
                </span>
              </div>
            </>
          )}
        </div>
      )}
      {/* Input — a 1–4 line textarea (joint critique on buddy#49). The
          single-line input made a newline UNAUTHORABLE from Buddy while the
          terminal and every agent sends structured text on the same thread.
          Return still sends, exactly as before; Shift+Return inserts the
          newline. Beyond four explicit lines the box scrolls internally —
          the composer grows for structure, not into an editor. */}
      <div
        style={{
          padding: '8px 10px',
          borderTop: `1px solid ${color.line}`,
          flexShrink: 0,
        }}
      >
        {/* The chosen reply target, shown before send so the human sees which
            message this will answer — and can cancel back to an ordinary
            send. This is the ONLY thing that sets reply_to; there is no
            silent default. */}
        {replyingTo && (
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: '6px',
              marginBottom: '6px',
              fontSize: '11px',
              color: color.faint,
            }}
          >
            <span style={{ flexShrink: 0 }}>↳ replying to</span>
            <span style={{ color: color.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              “{replyingTo.text}”
            </span>
            <button
              type="button"
              onClick={() => setReplyingTo(null)}
              aria-label="Cancel reply targeting; send as an ordinary message"
              style={{
                marginLeft: 'auto',
                flexShrink: 0,
                background: 'transparent',
                border: 'none',
                color: color.faint,
                fontFamily: 'inherit',
                fontSize: '12px',
                cursor: 'pointer',
                padding: '0 2px',
              }}
            >
              ✕
            </button>
          </div>
        )}
        <div style={{ display: 'flex', gap: '6px' }}>
          <textarea
            value={input}
            rows={Math.min(4, input.split('\n').length)}
            onChange={(e) => {
              setInput(e.target.value);
              // Send typing indicator (debounced — max once every 3s).
              // NEVER before thread evidence exists (codex r10 P2): the
              // composer-first state promises "nothing sent", and /api/typing
              // dispatches an SSE event to the target — drafting must not
              // notify someone you have not yet messaged.
              const now = Date.now();
              if (pollArmed && now - lastTypingSentRef.current > 3000) {
                lastTypingSentRef.current = now;
                buddyClient.sendTypingIndicator(chatWith);
              }
            }}
            onKeyDown={(e) => {
              // Return-to-send preserved verbatim; Shift+Return falls
              // through to the browser default (insert '\n'). Without the
              // preventDefault, Return would BOTH send and grow the box.
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            onFocus={() => setComposerFocused(true)}
            onBlur={() => setComposerFocused(false)}
            placeholder={`Message @${chatWith}...`}
            style={{
              flex: 1,
              background: '#111',
              border: '1px solid #222',
              borderRadius: '8px',
              padding: '8px 10px',
              color: '#fff',
              fontSize: '13px',
              lineHeight: '1.4',
              outline: 'none',
              resize: 'none',
              fontFamily: 'inherit',
            }}
            autoFocus
          />
          <button
            onClick={() => send()}
            disabled={!input.trim() || sending}
            style={{
              background: input.trim() ? '#6B8FFF' : '#181818',
              border: 'none',
              borderRadius: '8px',
              padding: '8px 12px',
              color: '#fff',
              fontSize: '13px',
              cursor: input.trim() ? 'pointer' : 'default',
              opacity: input.trim() ? 1 : 0.3,
              alignSelf: 'flex-end',
            }}
          >
            Send
          </button>
        </div>
        {/* The shortcut, discoverable at the moment of composition and
            silent otherwise (joint critique: "make that shortcut
            discoverable" — as words, not as standing chrome). */}
        {composerFocused && (
          <div style={{ marginTop: '4px', fontSize: '10px', color: color.faint }}>
            return sends · shift-return for a new line
          </div>
        )}
      </div>
    </div>
  );
}
