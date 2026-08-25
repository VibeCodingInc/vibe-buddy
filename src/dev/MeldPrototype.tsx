/**
 * THE MELD — first interface for a temporary shared cortex.
 * Design branch only. Founder-local. Never shipped.
 *
 * States (?meld=<state>):
 *   before      the ordinary surface: conversation + composer. nothing else.
 *   shapeshift  one thought turned through lenses — the SAME line, re-forming
 *   collision   two facets from two worlds in one frame. NO conclusion authored.
 *   third       the third thought — typed by a human, in the composer
 *   return      the insight leaves and changes the work that made it
 *   absence     THE WILDCARD: the Mind proves you have never thought about this
 *
 * THE LAW THIS INTERFACE OBEYS:
 *   The system renders the COLLISION. It never authors the CONCLUSION.
 *   The third thought appears in the human, not on the screen.
 */

const T = {
  bg: '#0A0A0A', panel: '#111316', line: '#1F2937', ink: '#E0E0E0',
  dim: '#9CA3AF', faint: '#6B7280', blue: '#6B8FFF', warm: '#C9A227',
  mono: "ui-monospace,'SF Mono',SFMono-Regular,Menlo,monospace",
};

/** REAL COLLISION, from this session's own record (2026-08-23).
 *  Both edges are documented; the third thought shipped in Build 67. */
const REAL = {
  tension: 'the iOS SSL pins are dead — the cert chain rotated and every API call has been failing silently for six weeks. do i re-pin?',
  mine: {
    edge: 'your Mind',
    facet: 'pin the ISRG ROOT, not the leaf — a root outlives routine rotations, so this exact breakage cannot recur.',
    source: 'openssl chain read + SSLPinningDelegate.swift:12-15',
    world: 'this machine, this hour: the live chain vs the pinned hashes',
  },
  theirs: {
    edge: 'the platform coordinator',
    facet: 'do NOT re-pin. Remove custom pinning; use Apple ATS. Any future pinning policy needs its own review, backup pins, and a rotation plan.',
    source: 'ruling, 2026-08-23',
    world: 'operational history of pinning failures across a fleet, and who will be awake the next time a CA rotates',
  },
  gap: 'one edge asked WHICH PIN. the other asked WHETHER PINNING IS A THING THIS TEAM CAN OPERATE.',
  third: 'the pin was never the decision — the decision was whether we can carry a rotating obligation at all. we can’t, so we don’t take one.',
  returned: { artifact: 'vibe-app Build 67', what: 'custom pinning removed; policy gate written into the code comment', proof: 'shipped, verified on device' },
};

/** The lenses, turning ONE thought. Real MM#1 material. */
const SHAPES = [
  { lens: 'as written', text: 'should the notification layer have one owner across all four doors, or does each surface stay sovereign?' },
  { lens: 'through time', text: 'when did i last watch four capable things each assume another was responsible?' },
  { lens: 'through another discipline', text: 'how does a room full of trained people avoid dropping the one person nobody was assigned?' },
  { lens: 'through a forgotten self', text: '“comfort is Raphael’s problem. yours is witness.” — you staged this, Paris, Apr 2026' },
  { lens: 'reformed', text: 'who is responsible for a message that no one has answered yet?' },
];

const S = {
  frame: { width: 460, minHeight: 640, background: T.bg, color: T.ink, fontFamily: T.mono, fontSize: 13, display: 'flex', flexDirection: 'column' as const, border: `1px solid ${T.line}`, position: 'relative' as const },
  head: { padding: '10px 14px', borderBottom: `1px solid ${T.line}`, color: T.faint, fontSize: 11, display: 'flex', gap: 8 },
  body: { flex: 1, padding: 16, display: 'flex', flexDirection: 'column' as const, gap: 12 },
  bubble: (mine: boolean) => ({ alignSelf: mine ? 'flex-end' as const : 'flex-start' as const, maxWidth: '86%', background: mine ? '#16202e' : T.panel, border: `1px solid ${T.line}`, borderRadius: 8, padding: '9px 11px', whiteSpace: 'pre-wrap' as const }),
  composer: { borderTop: `1px solid ${T.line}`, padding: 12 },
  input: { display: 'flex', gap: 8, alignItems: 'center', background: T.panel, border: `1px solid ${T.line}`, borderRadius: 8, padding: '10px 12px', color: T.faint },
  send: { color: T.blue, border: `1px solid ${T.line}`, borderRadius: 6, padding: '4px 10px', fontSize: 12, background: 'none' },
  quiet: { color: T.faint, fontSize: 10.5, marginTop: 6 },
  facet: (accent: string) => ({ border: `1px solid ${accent}`, borderRadius: 8, padding: 12, background: T.panel }),
  label: { color: T.faint, fontSize: 10, letterSpacing: '0.04em', marginBottom: 5 },
};

function Shell({ title, children, foot }: any) {
  return (
    <div style={S.frame}>
      <div style={S.head}><span style={{ color: T.blue }}>/vibe</span><span>{title}</span></div>
      <div style={S.body}>{children}</div>
      <div style={S.composer}>
        <div style={S.input}><span style={{ flex: 1 }}>{foot || 'Message @uriel…'}</span><button style={S.send}>send</button></div>
        <div style={S.quiet}>the mind is invisible · one line or silence · sending never waits</div>
      </div>
    </div>
  );
}

function Before() {
  return (
    <Shell title="· thread">
      <div style={S.bubble(true)}>{REAL.tension}<div style={{ color: T.faint, fontSize: 10, marginTop: 4 }}>you · 4:12 PM</div></div>
      <div style={{ color: T.faint, fontSize: 11, marginTop: 'auto' }}>nothing else on screen. no card, no badge, no panel.<br />this is the permanent interface.</div>
    </Shell>
  );
}

function Shapeshift() {
  return (
    <Shell title="· one thought, turning">
      <div style={{ color: T.faint, fontSize: 10.5, marginBottom: 4 }}>THE PRISM — the same line, re-forming. not a list of options.</div>
      {SHAPES.map((s, i) => (
        <div key={i} style={{ opacity: 0.35 + (i * 0.16), borderLeft: `2px solid ${i === SHAPES.length - 1 ? T.warm : T.line}`, paddingLeft: 10 }}>
          <div style={S.label}>{s.lens.toUpperCase()}</div>
          <div style={{ color: i === SHAPES.length - 1 ? T.ink : T.dim }}>{s.text}</div>
        </div>
      ))}
      <div style={{ color: T.faint, fontSize: 10.5, marginTop: 6 }}>
        you did not get an answer. you got your own question back, unrecognisable.
      </div>
    </Shell>
  );
}

function Collision() {
  return (
    <Shell title="· two worlds, one frame" foot="…">
      <div style={{ color: T.faint, fontSize: 10.5 }}>THE MELD — each edge contributed one approved facet.</div>
      <div style={S.facet(T.blue)}>
        <div style={S.label}>{REAL.mine.edge.toUpperCase()} · {REAL.mine.world}</div>
        <div>{REAL.mine.facet}</div>
        <div style={{ color: T.faint, fontSize: 10, marginTop: 6 }}>{REAL.mine.source}</div>
      </div>
      <div style={S.facet(T.warm)}>
        <div style={S.label}>{REAL.theirs.edge.toUpperCase()} · {REAL.theirs.world}</div>
        <div>{REAL.theirs.facet}</div>
        <div style={{ color: T.faint, fontSize: 10, marginTop: 6 }}>{REAL.theirs.source}</div>
      </div>
      <div style={{ borderTop: `1px dashed ${T.line}`, paddingTop: 10 }}>
        <div style={S.label}>THE GAP</div>
        <div style={{ color: T.dim }}>{REAL.gap}</div>
      </div>
      <div style={{ color: T.faint, fontSize: 10.5 }}>
        the system stops here. it renders the collision; it never writes the conclusion.
      </div>
    </Shell>
  );
}

function Third() {
  return (
    <Shell title="· the third thought" foot={REAL.third}>
      <div style={S.facet(T.blue)}><div style={S.label}>YOUR EDGE</div><div style={{ color: T.dim }}>{REAL.mine.facet}</div></div>
      <div style={S.facet(T.warm)}><div style={S.label}>THEIR EDGE</div><div style={{ color: T.dim }}>{REAL.theirs.facet}</div></div>
      <div style={{ marginTop: 4, borderLeft: `2px solid ${T.ink}`, paddingLeft: 10 }}>
        <div style={S.label}>WHAT NEITHER SIDE ARRIVED WITH</div>
        <div style={{ fontSize: 14 }}>{REAL.third}</div>
        <div style={{ color: T.faint, fontSize: 10.5, marginTop: 6 }}>typed by a human, in the composer. the system never authored this line.</div>
      </div>
    </Shell>
  );
}

function ReturnChanged() {
  return (
    <Shell title="· return" foot="Message @uriel…">
      <div style={{ color: T.dim }}>{REAL.third}</div>
      <div style={{ marginTop: 8, border: `1px solid ${T.blue}`, borderRadius: 8, padding: 12 }}>
        <div style={S.label}>THIS CHANGED SOMETHING · return it?</div>
        <div>affected work — <span style={{ color: T.ink }}>{REAL.returned.artifact}</span></div>
        <div style={{ color: T.dim, marginTop: 6 }}>{REAL.returned.what}</div>
        <div style={{ color: T.faint, fontSize: 10, marginTop: 6 }}>proof: {REAL.returned.proof}</div>
        <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
          <button style={S.send}>apply</button>
          <button style={{ ...S.send, color: T.dim }}>edit</button>
          <button style={{ ...S.send, color: T.faint }}>don’t</button>
        </div>
      </div>
      <div style={{ color: T.faint, fontSize: 10.5 }}>the conversation ends by altering the work that started it.</div>
    </Shell>
  );
}

function Absence() {
  return (
    <Shell title="· what you have never thought">
      <div style={S.facet(T.faint)}>
        <div style={S.label}>THE ABSENCE — a verified negative</div>
        <div style={{ fontSize: 14 }}>
          you have never once written about <span style={{ color: T.warm }}>timing as a selection filter</span>.
        </div>
        <div style={{ color: T.dim, marginTop: 8 }}>
          two independent sweeps · ~40 vocabularies · vault, sessions, agents, research, essays.
          nothing on opening a door too early. nothing on waiting as a way of choosing.
        </div>
        <div style={{ color: T.faint, fontSize: 10.5, marginTop: 8 }}>
          on this, you are reasoning from scratch — and now you know it.
        </div>
      </div>
      <div style={{ color: T.faint, fontSize: 11 }}>
        the only interface element that gets more valuable the less it finds.
      </div>
    </Shell>
  );
}

export default function MeldPrototype() {
  const state = new URLSearchParams(window.location.search).get('meld') || 'before';
  const V: any = { before: Before, shapeshift: Shapeshift, collision: Collision, third: Third, return: ReturnChanged, absence: Absence };
  const Chosen = V[state] || Before;
  return (
    <div style={{ background: '#000', minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <Chosen />
    </div>
  );
}
