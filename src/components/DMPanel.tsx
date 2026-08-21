import { useState, useEffect, useRef } from 'react';
import { buddyClient, type VibeMessage, type VibeUser } from '../lib/vibeClient';
import { getCachedMessages, setCachedMessages } from '../lib/messageCache';
import { realtime } from '../lib/realtime';
import { color, space, radius, size } from '../lib/tokens';
import { vibeconfAvailability, startCall, joinLine, sessionContext } from '../lib/vibeconf';
import { rememberCall } from '../lib/callMemory';
import { isFreshLastSeen } from '../lib/freshness';
import { hasNoReadEvidence } from './list/shared';

interface DMPanelProps {
  handle: string;
  chatWith: string;
  onBack: () => void;
  users: VibeUser[];
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

export default function DMPanel({ handle, chatWith, onBack, users }: DMPanelProps) {
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
  const [input, setInput] = useState('');
  // Drives the shortcut hint only — shown while composing, silent otherwise,
  // so the discoverability line is not standing chrome.
  const [composerFocused, setComposerFocused] = useState(false);
  const [sending, setSending] = useState(false);
  const [isTyping, setIsTyping] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTypingSentRef = useRef(0);

  const them = users.find(u => u.handle === chatWith) || null;
  const me = users.find(u => u.handle === handle) || null;

  useEffect(() => {
    // Load cached messages immediately
    const cached = getCachedMessages(handle, chatWith);
    if (cached.length > 0) {
      setMessages(cached);
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
  }, [handle, chatWith]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const send = async (text?: string) => {
    const msg = text || input.trim();
    if (!msg || sending) return;
    setSending(true);
    setInput('');

    const optimistic: VibeMessage = {
      id: `local_${Date.now()}`,
      from: handle,
      to: chatWith,
      content: msg,
      timestamp: new Date().toISOString(),
      status: 'pending',
    };
    setMessages((prev) => [...prev, optimistic]);

    const ok = await buddyClient.sendMessage(chatWith, msg);
    if (!ok) {
      setMessages((prev) =>
        prev.map((m) => (m.id === optimistic.id ? { ...m, status: 'failed' } : m))
      );
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
    const ok = await buddyClient.sendMessage(chatWith, failed.content);
    if (!ok) {
      setMessages((prev) =>
        prev.map((m) => (m.id === failed.id ? { ...m, status: 'failed' } : m))
      );
    }
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
            Start a conversation with @{chatWith}
          </div>
        )}

        {messages.map((msg) => {
          const isMe = msg.from === handle;
          return (
            <div
              key={msg.id}
              style={{
                alignSelf: isMe ? 'flex-end' : 'flex-start',
                maxWidth: '85%',
              }}
            >
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
                  // byte-faithfully; it stays INERT plain text — React text
                  // node, no Markdown, no HTML, nothing executable.
                  whiteSpace: 'pre-wrap',
                  // A long unbroken token (a URL, a hash) must wrap inside
                  // the bubble instead of forcing the thread sideways.
                  overflowWrap: 'anywhere',
                }}
              >
                {msg.content}
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
                {msg.status === 'failed' && (
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
        <div style={{ display: 'flex', gap: '6px' }}>
          <textarea
            value={input}
            rows={Math.min(4, input.split('\n').length)}
            onChange={(e) => {
              setInput(e.target.value);
              // Send typing indicator (debounced — max once every 3s)
              const now = Date.now();
              if (now - lastTypingSentRef.current > 3000) {
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
