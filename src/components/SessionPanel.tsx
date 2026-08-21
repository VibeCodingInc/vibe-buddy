import { useState, useEffect, useRef, useCallback } from 'react';
import { appendCapped, rememberIds } from '../lib/bounded';
import { buddyClient, type LiveSession, type GuestMessage } from '../lib/vibeClient';

interface SessionPanelProps {
  handle: string;           // viewer's handle
  targetHandle: string;     // whose session we're watching
  onBack: () => void;
}

export default function SessionPanel({ handle, targetHandle, onBack }: SessionPanelProps) {
  const [session, setSession] = useState<LiveSession | null>(null);
  const [guestInput, setGuestInput] = useState('');
  const [sending, setSending] = useState(false);
  const [sentMessages, setSentMessages] = useState<Array<{ text: string; ts: string; id?: string }>>([]);
  const [incomingReplies, setIncomingReplies] = useState<GuestMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const seenReplyIds = useRef<Set<string>>(new Set());

  // Poll live session every 3s
  const fetchSession = useCallback(async () => {
    const result = await buddyClient.getLiveSessionResult(targetHandle);
    if (result.error) {
      // Keep the last session on screen. A failed refresh does not mean the
      // other person stopped sharing.
      setRefreshError(true);
      return;
    }
    setRefreshError(false);
    setSession(result.session);
  }, [targetHandle]);

  // Poll for incoming guest messages (agent replies) every 3s
  const fetchReplies = useCallback(async () => {
    const messages = await buddyClient.getGuestMessages(false);
    if (messages.length > 0) {
      const newReplies = messages.filter(m => !seenReplyIds.current.has(m.id));
      if (newReplies.length > 0) {
        rememberIds(seenReplyIds.current, newReplies.map(r => r.id));
        setIncomingReplies(prev => appendCapped(prev, newReplies));
        // Acknowledge after reading
        await buddyClient.getGuestMessages(true);
      }
    }
  }, []);

  useEffect(() => {
    fetchSession();
    fetchReplies();
    pollRef.current = setInterval(() => {
      fetchSession();
      fetchReplies();
    }, 3000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [fetchSession, fetchReplies]);

  // Auto-scroll on new turns
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [session?.turns?.length, sentMessages.length, incomingReplies.length]);

  const sendMessage = async () => {
    const text = guestInput.trim();
    if (!text || sending) return;

    setSending(true);
    setError(null);

    const ok = await buddyClient.sendGuestMessage(targetHandle, text);
    if (ok) {
      setSentMessages((prev) => appendCapped(prev, [{ text, ts: new Date().toISOString() }]));
      setGuestInput('');
    } else {
      setError('Failed to send');
    }
    setSending(false);
  };

  const formatTime = (iso: string) => {
    try {
      const d = new Date(iso);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
      return '';
    }
  };

  const notSharing = session && !session.sharing;
  const restricted = session?.restricted;
  const turns = session?.turns || [];

  return (
    <div style={{
      width: '100%',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      background: '#0a0a0a',
      color: '#fff',
    }}>
      {/* Header */}
      <div style={{
        padding: '10px 12px',
        borderBottom: '1px solid #191919',
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
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
          <img
            src={`https://github.com/${targetHandle}.png?size=48`}
            alt={targetHandle}
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
            style={{
              width: 20,
              height: 20,
              borderRadius: '50%',
              flexShrink: 0,
            }}
          />
          <span style={{ fontWeight: 600, fontSize: '13px', color: '#eee' }}>
            @{targetHandle}
          </span>
          {session?.sharing && (
            <span style={{
              background: '#6B8FFF',
              color: '#fff',
              fontSize: '7px',
              padding: '1px 4px',
              borderRadius: '3px',
              fontWeight: 700,
              letterSpacing: '0.5px',
            }}>
              SESSION
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '10px', color: '#555' }}>
          {session?.project && <span>{session.project}</span>}
          {session?.model && <span style={{ color: '#6B8FFF' }}>{session.model}</span>}
        </div>
      </div>

      {/* Session turns */}
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          overflow: 'auto',
          minHeight: 0,
          padding: '8px',
          background: '#050505',
        }}
      >
        {notSharing && (
          <div style={{
            textAlign: 'center',
            color: '#555',
            padding: '40px 16px',
            fontSize: '12px',
          }}>
            @{targetHandle} is not sharing a session right now.
          </div>
        )}

        {restricted && (
          <div style={{
            textAlign: 'center',
            color: '#555',
            padding: '40px 16px',
            fontSize: '12px',
          }}>
            {session?.message || 'Pair with this user to watch their session.'}
          </div>
        )}

        {session?.sharing && !restricted && turns.length === 0 && (
          <div style={{
            padding: '20px 16px',
            display: 'flex',
            flexDirection: 'column',
            gap: '12px',
          }}>
            {/* Show session metadata even when no turns yet */}
            {(session.project || session.model || session.summary) && (
              <div style={{
                padding: '10px 12px',
                background: '#0a0f0a',
                borderRadius: '6px',
                border: '1px solid #151f15',
              }}>
                {session.project && (
                  <div style={{ fontSize: '13px', color: '#22c55e', fontWeight: 600, marginBottom: '4px' }}>
                    {session.project}
                  </div>
                )}
                {session.summary && (
                  <div style={{ fontSize: '11px', color: '#888', marginBottom: '4px' }}>
                    {session.summary}
                  </div>
                )}
                {session.model && (
                  <div style={{ fontSize: '10px', color: '#6B8FFF' }}>
                    {session.model}
                  </div>
                )}
              </div>
            )}
            <div style={{
              textAlign: 'center',
              color: '#333',
              fontSize: '11px',
            }}>
              Session active — turns will appear as they code
            </div>
            {session.guestEnabled && (
              <div style={{
                textAlign: 'center',
                fontSize: '10px',
                color: '#22c55e44',
              }}>
                Guest messaging is on — type below to send into their Claude Code
              </div>
            )}
          </div>
        )}

        {/* Unified timeline: session turns + guest messages interleaved chronologically */}
        {(() => {
          // Build unified timeline entries
          type TimelineEntry =
            | { kind: 'turn'; role: string; content: string; ts: string; idx: number }
            | { kind: 'guest-sent'; text: string; from: string; ts: string }
            | { kind: 'guest-reply'; text: string; from: string; ts: string };

          const timeline: TimelineEntry[] = [];

          // Add session turns (use timestamp if available, otherwise estimate from position)
          const sessionStart = session?.updatedAt
            ? new Date(session.updatedAt).getTime() - turns.length * 15000
            : Date.now() - turns.length * 15000;

          turns.forEach((turn, i) => {
            const ts = (turn as any).timestamp || new Date(sessionStart + i * 15000).toISOString();
            timeline.push({
              kind: 'turn',
              role: turn.role,
              content: (turn as any).content || turn.text || '',
              ts,
              idx: i,
            });
          });

          // Add sent guest messages
          sentMessages.forEach(m => {
            timeline.push({ kind: 'guest-sent', text: m.text, from: handle, ts: m.ts });
          });

          // Add incoming replies
          incomingReplies.forEach(m => {
            timeline.push({ kind: 'guest-reply', text: m.message, from: m.from, ts: m.timestamp });
          });

          // Sort by timestamp
          timeline.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());

          return timeline.map((entry, i) => {
            if (entry.kind === 'turn') {
              const isUser = entry.role === 'user';
              return (
                <div
                  key={`turn-${entry.idx}`}
                  style={{
                    padding: '6px 8px',
                    marginBottom: '4px',
                    borderLeft: `2px solid ${isUser ? '#6B8FFF' : '#22c55e'}`,
                    background: isUser ? '#0d1117' : '#0a0f0a',
                    borderRadius: '2px',
                  }}
                >
                  <div style={{
                    fontSize: '9px',
                    color: isUser ? '#6B8FFF' : '#22c55e',
                    marginBottom: '2px',
                    fontWeight: 600,
                    display: 'flex',
                    justifyContent: 'space-between',
                  }}>
                    <span>{isUser ? targetHandle : 'claude'}</span>
                    <span style={{ color: '#333', fontWeight: 400 }}>{formatTime(entry.ts)}</span>
                  </div>
                  <pre style={{
                    margin: 0,
                    fontFamily: "'JetBrains Mono', 'SF Mono', Monaco, Consolas, monospace",
                    fontSize: '11px',
                    lineHeight: '1.4',
                    color: '#c0c0c0',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}>
                    {entry.content}
                  </pre>
                </div>
              );
            }

            // Guest message (sent or reply) — visually distinct with pink/orange
            const isSent = entry.kind === 'guest-sent';
            return (
              <div
                key={`guest-${i}`}
                style={{
                  padding: '6px 8px',
                  marginBottom: '4px',
                  borderLeft: `2px solid ${isSent ? '#ec4899' : '#f59e0b'}`,
                  background: isSent ? '#1a0a14' : '#1a150a',
                  borderRadius: '2px',
                }}
              >
                <div style={{
                  fontSize: '9px',
                  color: isSent ? '#ec4899' : '#f59e0b',
                  marginBottom: '2px',
                  fontWeight: 600,
                  display: 'flex',
                  justifyContent: 'space-between',
                }}>
                  <span>
                    {isSent ? `${entry.from} (you)` : `@${entry.from}`}
                    <span style={{
                      background: '#222',
                      color: '#888',
                      fontSize: '7px',
                      padding: '0 3px',
                      borderRadius: '2px',
                      marginLeft: '5px',
                      fontWeight: 400,
                    }}>
                      guest
                    </span>
                  </span>
                  <span style={{ color: '#333', fontWeight: 400 }}>{formatTime(entry.ts)}</span>
                </div>
                <pre style={{
                  margin: 0,
                  fontFamily: "'JetBrains Mono', 'SF Mono', Monaco, Consolas, monospace",
                  fontSize: '11px',
                  lineHeight: '1.4',
                  color: '#c0c0c0',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}>
                  {entry.text}
                </pre>
              </div>
            );
          });
        })()}

        {session?.summary && (
          <div style={{
            padding: '6px 8px',
            marginTop: '8px',
            borderTop: '1px solid #191919',
            fontSize: '10px',
            color: '#555',
            fontStyle: 'italic',
          }}>
            {session.summary}
          </div>
        )}
      </div>

      {/* Guest input — type into their session (or chat with agent) */}
      {(session?.sharing && !restricted || incomingReplies.length > 0 || sentMessages.length > 0) && (
        <div style={{
          padding: '8px 12px',
          borderTop: '1px solid #191919',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
        }}>
          <input
            value={guestInput}
            onChange={(e) => setGuestInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
              }
            }}
            placeholder={`Type into @${targetHandle}'s session...`}
            disabled={sending}
            style={{
              flex: 1,
              background: '#111',
              border: '1px solid #222',
              borderRadius: '4px',
              color: '#eee',
              padding: '6px 8px',
              fontSize: '12px',
              fontFamily: "'JetBrains Mono', 'SF Mono', Monaco, Consolas, monospace",
              outline: 'none',
            }}
          />
          <button
            onClick={sendMessage}
            disabled={sending || !guestInput.trim()}
            style={{
              background: sending ? '#333' : '#6B8FFF',
              color: '#fff',
              border: 'none',
              borderRadius: '4px',
              padding: '6px 10px',
              fontSize: '11px',
              cursor: sending ? 'default' : 'pointer',
              fontWeight: 600,
              opacity: !guestInput.trim() ? 0.5 : 1,
            }}
          >
            {sending ? '...' : 'Send'}
          </button>
        </div>
      )}

      {/* Error */}
      {refreshError && (
        <div style={{
          padding: '4px 12px',
          fontSize: '10px',
          color: '#888',
          textAlign: 'center',
        }}>
          reconnecting to this session…
        </div>
      )}
      {error && (
        <div style={{
          padding: '4px 12px',
          fontSize: '10px',
          color: '#ef4444',
          textAlign: 'center',
        }}>
          {error}
        </div>
      )}
    </div>
  );
}
