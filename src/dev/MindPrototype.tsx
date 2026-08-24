/**
 * MENTALIST PROTOTYPE — design-branch only, never shipped.
 *
 * Screenshot-first concepts for the intelligence UNDER the conversation
 * (coordinator directive, 2026-08-24). Synthetic fixture data shaped exactly
 * like the local Mind orchestrator's output (~/.vibe/mind/mind.py) — the
 * founder-only live hookup reads real data locally and NEVER commits it.
 *
 * States (?mind-proto=<state>):
 *   quiet      — the permanent default: composer, nothing else
 *   offer      — the Mind Pass: one line after typing begins
 *   sheet      — tap: source, freshness, exact prose, approve/edit/discard
 *   threshold  — BOLDEST: entering a thread, one line of shared history
 *   invite     — "What thought would be better with them in it?"
 *
 * Laws inherited: retrieval-fact copy (never relevance-as-fact) · one
 * connection or silence · sending never waits · green = presence only ·
 * one blue action per surface · state in words, never color alone.
 */

const T = {
  bg: '#0A0A0A', panel: '#111316', line: '#1F2937',
  ink: '#E0E0E0', dim: '#9CA3AF', faint: '#6B7280',
  blue: '#6B8FFF', green: '#22c55e',
  mono: "ui-monospace,'SF Mono',SFMono-Regular,Menlo,monospace",
};

// Synthetic fixture — real SHAPE (mind.py candidate), fake people/facts.
const FIX = {
  handle: 'renata',
  thread: [
    { from: 'renata', text: 'trying to decide if the archive piece should be one long scroll or discrete plates. leaning plates but something bugs me', t: '2:41 PM' },
    { from: 'you', text: 'what bugs you about the scroll?', t: '2:44 PM' },
    { from: 'renata', text: 'that it hides the seams. the seams might be the work', t: '2:52 PM' },
  ],
  offer: {
    line: 'You wrote this Tuesday: "the seams are the provenance" · include? ›',
    source: 'notes/archive-forms.md', sourceKind: 'your note', asOf: 'Tue Aug 19',
    quote: 'the seams are the provenance — every join in the archive is a decision someone made, and hiding it launders the history.',
    prose: 'funny — i wrote almost this exact thing tuesday: "the seams are the provenance." if the seams might be the work, plates win. show the joins.',
  },
  threshold: 'You noted in March: you and @renata were both at the Marfa print fair, ’23 ›',
  invite: {
    question: 'What thought would be better with them in it?',
    thought: 'Whether the pilot’s completion screen should greet a newcomer with their inviter’s name or their inviter’s question.',
    why: '@renata designs arrival rituals for physical spaces — this is literally her field, transposed.',
    connection: 'Your March note on her Marfa wayfinding piece: "the room told you who brought you here."',
    draft: 'renata — wrestling with how a person should be greeted the moment they arrive somewhere on purpose. your marfa wayfinding piece keeps coming to mind. can i show you a screen and steal twenty minutes of your instincts?',
  },
};

const S = {
  frame: { width: 380, minHeight: 620, background: T.bg, color: T.ink, fontFamily: T.mono, fontSize: 13, display: 'flex', flexDirection: 'column' as const, border: `1px solid ${T.line}` },
  header: { padding: '10px 14px', borderBottom: `1px solid ${T.line}`, display: 'flex', alignItems: 'center', gap: 8 },
  msgs: { flex: 1, padding: 14, display: 'flex', flexDirection: 'column' as const, gap: 10 },
  bubble: (mine: boolean) => ({ alignSelf: mine ? 'flex-end' as const : 'flex-start' as const, maxWidth: '82%', background: mine ? '#16202e' : T.panel, border: `1px solid ${T.line}`, borderRadius: 8, padding: '8px 10px', whiteSpace: 'pre-wrap' as const }),
  meta: { color: T.faint, fontSize: 10, marginTop: 3 },
  composerWrap: { borderTop: `1px solid ${T.line}`, padding: 12 },
  input: { display: 'flex', gap: 8, alignItems: 'center', background: T.panel, border: `1px solid ${T.line}`, borderRadius: 8, padding: '10px 12px', color: T.dim },
  send: { color: T.blue, border: `1px solid ${T.line}`, borderRadius: 6, padding: '4px 10px', fontSize: 12, background: 'none' },
  mindLine: { color: T.dim, fontSize: 12, padding: '6px 2px 10px', display: 'flex', gap: 8, alignItems: 'baseline' },
  x: { color: T.faint, marginLeft: 'auto', cursor: 'pointer' as const },
};

function Header({ note }: { note?: string }) {
  return (
    <div>
      <div style={S.header}>
        <span style={{ color: T.green }}>●</span>
        <span>@{FIX.handle}</span>
        <span style={{ color: T.faint, fontSize: 11 }}>around now · self-reported focus: print archive</span>
      </div>
      {note && (
        <div style={{ padding: '8px 14px', borderBottom: `1px solid ${T.line}`, color: T.dim, fontSize: 12 }}>
          {note} <span style={{ color: T.faint, fontSize: 10, marginLeft: 6 }}>your note, Mar · dismissible</span>
        </div>
      )}
    </div>
  );
}

function Thread() {
  return (
    <div style={S.msgs}>
      {FIX.thread.map((m, i) => (
        <div key={i} style={S.bubble(m.from === 'you')}>
          {m.text}
          <div style={S.meta}>{m.from === 'you' ? 'you' : `@${m.from}`} · {m.t}</div>
        </div>
      ))}
    </div>
  );
}

function Composer({ typed, offer, onOfferTap }: { typed?: string; offer?: boolean; onOfferTap?: () => void }) {
  return (
    <div style={S.composerWrap}>
      {offer && (
        <div style={S.mindLine}>
          <span style={{ cursor: 'pointer' }} onClick={onOfferTap}>{FIX.offer.line}</span>
          <span style={S.x}>✕</span>
        </div>
      )}
      <div style={S.input}>
        <span style={{ flex: 1, color: typed ? T.ink : T.faint }}>{typed || `Message @${FIX.handle}…`}</span>
        <button style={S.send}>send</button>
      </div>
      {offer && <div style={{ color: T.faint, fontSize: 10, marginTop: 6 }}>sending never waits for the mind · offer expires with this draft</div>}
    </div>
  );
}

function Sheet() {
  return (
    <div style={{ position: 'absolute' as const, inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'flex-end' }}>
      <div style={{ width: '100%', background: T.panel, borderTop: `1px solid ${T.blue}`, padding: 16, fontSize: 12.5 }}>
        <div style={{ color: T.dim, marginBottom: 10 }}>Add what you wrote to this message?</div>
        <div style={{ border: `1px solid ${T.line}`, borderRadius: 8, padding: 10, marginBottom: 10 }}>
          <div style={{ color: T.ink, whiteSpace: 'pre-wrap' }}>&ldquo;{FIX.offer.quote}&rdquo;</div>
          <div style={{ color: T.faint, fontSize: 10.5, marginTop: 6 }}>
            {FIX.offer.sourceKind} · {FIX.offer.source} · as of {FIX.offer.asOf} · your agent&rsquo;s retrieval
          </div>
        </div>
        <div style={{ color: T.dim, margin: '10px 0 6px' }}>Exactly this will be added:</div>
        <div style={{ border: `1px solid ${T.line}`, borderRadius: 8, padding: 10, color: T.ink, whiteSpace: 'pre-wrap' }}>{FIX.offer.prose}</div>
        <div style={{ color: T.faint, fontSize: 10.5, margin: '8px 0 12px' }}>recipient sees ordinary text · nothing sends until you send</div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button style={{ ...S.send, padding: '8px 14px' }}>add &amp; review</button>
          <button style={{ ...S.send, color: T.dim, padding: '8px 14px' }}>edit</button>
          <button style={{ ...S.send, color: T.faint, padding: '8px 14px' }}>don&rsquo;t add</button>
        </div>
      </div>
    </div>
  );
}

function Invite() {
  return (
    <div style={{ padding: 18, display: 'flex', flexDirection: 'column' as const, gap: 14, flex: 1 }}>
      <div style={{ color: T.dim }}>invite a mind</div>
      <div style={{ fontSize: 16, color: T.ink }}>{FIX.invite.question}</div>
      <div style={{ border: `1px solid ${T.line}`, borderRadius: 8, padding: 12 }}>
        <div style={{ color: T.faint, fontSize: 10.5, marginBottom: 4 }}>an unresolved thought in your work · from your open threads</div>
        <div>{FIX.invite.thought}</div>
      </div>
      <div style={{ border: `1px solid ${T.line}`, borderRadius: 8, padding: 12 }}>
        <div style={{ color: T.faint, fontSize: 10.5, marginBottom: 4 }}>why @{FIX.handle} · your agent&rsquo;s inference</div>
        <div>{FIX.invite.why}</div>
        <div style={{ color: T.dim, marginTop: 8, fontSize: 12 }}>↳ {FIX.invite.connection}</div>
      </div>
      <div style={{ border: `1px solid ${T.blue}`, borderRadius: 8, padding: 12 }}>
        <div style={{ color: T.faint, fontSize: 10.5, marginBottom: 4 }}>the invitation — exactly this, if you approve</div>
        <div style={{ whiteSpace: 'pre-wrap' as const }}>{FIX.invite.draft}</div>
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        <button style={{ ...S.send, padding: '8px 14px' }}>send invitation</button>
        <button style={{ ...S.send, color: T.dim, padding: '8px 14px' }}>edit</button>
        <button style={{ ...S.send, color: T.faint, padding: '8px 14px' }}>not now</button>
      </div>
      <div style={{ color: T.faint, fontSize: 10.5 }}>no address book was read · one person, one reason · nothing recurring</div>
    </div>
  );
}

// ── FOUNDER-LIVE MODE (?mind-proto=live&handle=X) ──────────────────────────
// Consults the REAL local Mind at 127.0.0.1:7433 (loopback; CORS pinned to
// this dev origin). Renders only what the Mind returns; persists nothing;
// real data never enters the repo. Sending is not wired — approval here only
// stages text for the human to carry into a real composer.
import { useEffect, useRef, useState } from 'react';

function LiveMind({ handle }: { handle: string }) {
  // draft may be prefilled via ?draft= so headless capture can exercise the offer
  const [draft, setDraft] = useState(new URLSearchParams(window.location.search).get('draft') || '');
  const [offer, setOffer] = useState<any>(null);
  const [threshold, setThreshold] = useState<any>(null);
  const [sheet, setSheet] = useState(false);
  const [status, setStatus] = useState('mind: idle');
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    fetch(`http://127.0.0.1:7433/?mode=threshold&handle=${encodeURIComponent(handle)}`)
      .then(r => r.json()).then(j => setThreshold(j.silence ? null : j))
      .catch(() => setStatus('mind: unreachable (start: python3 ~/.vibe/mind/mind.py --serve)'));
  }, [handle]);

  useEffect(() => {
    if (draft.trim().length < 8) { setOffer(null); return; }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      setStatus('mind: consulting…');
      const t0 = performance.now();
      fetch(`http://127.0.0.1:7433/?mode=pass&handle=${encodeURIComponent(handle)}&draft=${encodeURIComponent(draft)}`)
        .then(r => r.json())
        .then(j => {
          setStatus(`mind: ${j.silence ? 'silence' : 'one connection'} · ${j.latency}s retrieval · ${Math.round(performance.now() - t0)}ms round-trip`);
          setOffer(j.silence ? null : j);
        })
        .catch(() => setStatus('mind: unreachable'));
    }, 700);
  }, [draft, handle]);

  return (
    <div style={{ ...S.frame, position: 'relative' as const }}>
      <div style={S.header}>
        <span style={{ color: T.faint }}>○</span>
        <span>@{handle}</span>
        <span style={{ color: T.faint, fontSize: 11 }}>founder-live · loopback mind</span>
      </div>
      {threshold && (
        <div style={{ padding: '8px 14px', borderBottom: `1px solid ${T.line}`, color: T.dim, fontSize: 12 }}>
          {threshold.line}
          <span style={{ color: T.faint, fontSize: 10, marginLeft: 6 }}>{threshold.source} · {threshold.freshness}</span>
        </div>
      )}
      <div style={{ ...S.msgs, color: T.faint, fontSize: 12 }}>
        (live mode renders no thread — the wire stays in real clients; this window tests ONLY the mind)
      </div>
      <div style={S.composerWrap}>
        {offer && (
          <div style={S.mindLine}>
            <span style={{ cursor: 'pointer' }} onClick={() => setSheet(true)}>{offer.offer_line}</span>
            <span style={S.x} onClick={() => setOffer(null)}>✕</span>
          </div>
        )}
        <div style={S.input}>
          <textarea
            value={draft}
            onChange={e => setDraft(e.target.value)}
            placeholder={`Message @${handle}…`}
            style={{ flex: 1, background: 'none', border: 'none', outline: 'none', color: T.ink, fontFamily: T.mono, fontSize: 13, resize: 'none' as const, minHeight: 20 }}
          />
          <button style={S.send} title="not wired in live mode">send</button>
        </div>
        <div style={{ color: T.faint, fontSize: 10, marginTop: 6 }}>{status} · sending never waits for the mind</div>
      </div>
      {sheet && offer && (
        <div style={{ position: 'absolute' as const, inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'flex-end' }} onClick={() => setSheet(false)}>
          <div style={{ width: '100%', background: T.panel, borderTop: `1px solid ${T.blue}`, padding: 16, fontSize: 12.5 }} onClick={e => e.stopPropagation()}>
            <div style={{ color: T.dim, marginBottom: 10 }}>Add what you {offer.offer_line?.startsWith('You noted') ? 'noted' : 'wrote'} to this message?</div>
            <div style={{ border: `1px solid ${T.line}`, borderRadius: 8, padding: 10, marginBottom: 10 }}>
              <div style={{ color: T.ink, whiteSpace: 'pre-wrap' }}>&ldquo;{offer.quote}&rdquo;</div>
              <div style={{ color: T.faint, fontSize: 10.5, marginTop: 6 }}>
                {offer.source}:{offer.source_line} · as of {offer.freshness} · {offer.why} · your agent&rsquo;s retrieval
              </div>
            </div>
            <div style={{ color: T.dim, margin: '10px 0 6px' }}>Exactly this would be added:</div>
            <div style={{ border: `1px solid ${T.line}`, borderRadius: 8, padding: 10, color: T.ink, whiteSpace: 'pre-wrap' }}>{offer.proposed_prose}</div>
            {(offer.contradictions || []).map((c: string, i: number) => (
              <div key={i} style={{ color: T.dim, fontSize: 11, marginTop: 8 }}>⚠ {c}</div>
            ))}
            <div style={{ color: T.faint, fontSize: 10.5, margin: '8px 0 12px' }}>nothing sends from this window · copy into a real composer to use it</div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button style={{ ...S.send, padding: '8px 14px' }} onClick={() => { navigator.clipboard.writeText(offer.proposed_prose); setSheet(false); }}>copy &amp; review</button>
              <button style={{ ...S.send, color: T.faint, padding: '8px 14px' }} onClick={() => { setSheet(false); setOffer(null); }}>don&rsquo;t add</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function MindPrototype() {
  const q = new URLSearchParams(window.location.search);
  const state = q.get('mind-proto') || 'quiet';
  const inner = state === 'live'
    ? <LiveMind handle={q.get('handle') || 'wanderingstan'} />
    : state === 'invite'
      ? <div style={{ ...S.frame, position: 'relative' as const }}><Invite /></div>
      : (
        <div style={{ ...S.frame, position: 'relative' as const }}>
          <Header note={state === 'threshold' ? FIX.threshold : undefined} />
          <Thread />
          <Composer
            typed={state === 'offer' || state === 'sheet' ? 'plates, and here\u2019s why \u2014' : undefined}
            offer={state === 'offer' || state === 'sheet'}
          />
          {state === 'sheet' && <Sheet />}
        </div>
      );
  return (
    <div style={{ background: '#000', minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      {inner}
    </div>
  );
}
