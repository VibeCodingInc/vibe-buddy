// MY SESSIONS — your own coding sessions in the buddy list, and the
// bring-a-session ladder inside each row. Extracted verbatim from
// UnifiedBuddyList.tsx (take-stock Move 2 split); the honesty contracts live
// in lib/mySessionsState and lib/sessionLadder, and the mounted tests in
// tests/mounted-honesty.test.tsx cover this file through the list.
import { useState, useEffect } from 'react';
import type { MySession } from '../../lib/vibeClient';
import { vibeconfAvailability, vibeconfSeatState, startCall, joinLine, sessionContext } from '../../lib/vibeconf';
import { rememberCall } from '../../lib/callMemory';
import { readBotfile, sessionLabel, type Botfile } from '../../lib/botfile';
import { terminalSessions, frontSession, placeInSession, matchSessionRow } from '../../lib/terminal';
import { transcriptSignal, signalLine, wantsYou, isYourTurn, hasRecentApiError, transcriptJoinable, readSignals, byAttention, type SessionSignal } from '../../lib/transcript';
import { copyText } from '../../lib/clipboard';
import { color, size } from '../../lib/tokens';
import { sessionsSummary } from '../../lib/interval';
import { mySessionsStaleLine, effectiveAgoMs } from '../../lib/mySessionsState';
import { sessionLadder, type Rung, type SeatProbe } from '../../lib/sessionLadder';
import { isFreshAge } from '../../lib/freshness';
import { formatAgo, formatAgoPrecise, formatModel, pressOnKey } from './format';

// The MY SESSIONS block: header line + rows. One session renders as a row;
// several fold into the header until asked. Extracted into a component so the
// populated list and the quiet room draw the SAME block — the quiet room
// previously never mounted it, which hid a live coding session behind
// "Quiet in here" at the exact moment Buddy could have said it was there.
export function MySessionsSection({ mySessions, observedAt, stale = false, allCwds, attentionSessions, signals }: {
  mySessions: MySession[];
  /** When the rows' snapshot was received; rows age from it (effectiveAgoMs). */
  observedAt?: number;
  /** The latest read failed: rows are a retained snapshot and must say so. */
  stale?: boolean;
  /**
   * Every session cwd INCLUDING rows rendered elsewhere (bot-bound rows live
   * under their agent's card). The shared-cwd stand-down must see the whole
   * machine, or a bound twin would silently un-share its sibling's directory.
   */
  allCwds?: string[];
  /**
   * Every session on the machine, including rows rendered elsewhere (bound
   * under an agent card). Only the attention COUNT uses this; the list still
   * renders `mySessions`.
   */
  attentionSessions?: MySession[];
  /**
   * The board's ONE signal map, keyed by cwd, read once at the list level so
   * the header aggregate and every row — including rows bound under an agent
   * card — agree at all times (codex r1 on #37).
   */
  signals?: Map<string, SessionSignal>;
}) {
  const [expanded, setExpanded] = useState(false);
  // A frozen "12s ago" reads as current — the same overclaim the presence
  // card's "stopped updating" tick exists to avoid. Tick so retained rows
  // age (and lose green) even while failed polls trigger no re-render.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  // The header must know what the rows would say, because with two or more
  // sessions this section starts COLLAPSED — no row mounts, so a row-local
  // read could never surface anything, which is precisely the many-session
  // case the feature exists for (codex r1 P1). Cached, so this and the rows
  // share one IPC per directory.
  //
  // `attentionRows` is EVERY session on the machine — including rows rendered
  // elsewhere (bound under an agent card). The operator's "what wants me"
  // number must not depend on which list a session happens to render in
  // (found live: the header said "1 wants you" while a bound Pepper card
  // wanted him too, and neither number was wrong on its own).
  const cwdCount = (cwd: string) =>
    (allCwds ?? mySessions.map((o) => o.cwd)).filter((c) => c === cwd).length;
  const all = attentionSessions ?? mySessions;
  const signalFor = (cwd: string) => signals?.get(cwd);
  // The machine-wide attention aggregate ("what wants me" in one number,
  // codex r1 on #37) moved UP to the board's FOR YOU zone header
  // (buddy#49 decision 2), computed there over the same machine-wide set.
  // The two-claim distinction (your turn vs error recorded, codex r2 P2)
  // lives on the rows, which say which they are.

  // What needs you, first. A ten-row list where the waiting session sits
  // eighth is a list you have to read.
  const ordered = byAttention(
    mySessions,
    (s) => signalFor(s.cwd),
    (s) => effectiveAgoMs(s, observedAt, now),
  );

  // COLLAPSED IS NOT HIDDEN.
  //
  // At sixteen sessions this section auto-folds, so the header could say
  // "your turn · 2" while not a single row was mounted — the count at the
  // top and the answer one click away. That is the product's own thesis
  // deferred behind a disclosure triangle (found live, 0.5.58 screenshot).
  //
  // So the fold now applies to the QUIET sessions only: anything that wants
  // you stays on screen at all times, and the rest collapse into one line.
  // A peek row is derived from a LIVE signal, and signals move: the turn
  // gets answered, or a poll reads null on a transient IPC failure. Without
  // a pin, the row you are typing into vanishes under your hands mid-draft,
  // taking the text and the caret with it (codex r3 P2). So opening a row
  // pins it: once you have touched it, only YOU close it.
  const [pinned, setPinned] = useState<Set<string>>(new Set());
  const setPin = (id: string, on: boolean) =>
    setPinned((p) => {
      if (on === p.has(id)) return p;
      const next = new Set(p);
      if (on) next.add(id); else next.delete(id);
      return next;
    });
  // Attention rows render ABOVE the fold line, always — they are this
  // section's contribution to the FOR YOU zone (buddy#49 decision 1: the
  // zone holds waiting conversations plus sessions that want you, in one
  // fixed position). They stay on top even while expanded, so expanding
  // never demotes the row you were about to answer.
  //
  // `top` — the zone's session rows — is EVIDENCE-ONLY: exactly the rows
  // the FOR YOU count counts, nothing held there by interaction state
  // (codex r3 P2, r4 P2, r5 P2 on #50 — three renderings of one rule: the
  // zone shows what the count counts).
  //
  // Pins keep a held-open row VISIBLE while collapsed — but BELOW the
  // boundary line, where a quiet row belongs. The row you are typing into
  // survives its signal clearing (codex r3 P2 on the original fold): it
  // moves from `top` to `below`, and because both halves share one keyed
  // children array the move preserves its open state, draft and caret.
  // Expanded and singleton views already show every row, so pins add
  // nothing there.
  const top = ordered.filter((s) => wantsYou(signalFor(s.cwd)));
  const topIds = new Set(top.map((s) => s.sessionId));
  const below = expanded || mySessions.length === 1
    ? ordered.filter((s) => !topIds.has(s.sessionId))
    : ordered.filter((s) => !topIds.has(s.sessionId) && pinned.has(s.sessionId));
  const foldedCount = ordered.length - top.length - below.length;

  // Attention that is NOT in this section: bound sessions render on their
  // agent's card, so the header's machine-wide count can exceed what this
  // list can show. Saying "2 more" while pointing at nothing would be the
  // same lie in a new place — so this names WHERE, and nothing else.
  //
  // Three things this copy must NOT do (codex r2, all three earned):
  //  · not "their agents" — the binding is a local BOT.md self-declaration
  //    ("this session says it's @uriel"), and possessive phrasing upgrades
  //    a client-side claim into platform identity. Placement only.
  //  · not "below" — the paired hero renders ABOVE this section, so a
  //    direction word is false for exactly the case that made bound rows
  //    visible in the first place.
  //  · not "wants you" — this set spans finished turns AND recorded errors,
  //    which the header deliberately counts apart. So it re-asserts no
  //    state at all; it points at the ones already counted up there.
  // EVERY session not in this list, not just the ones asking for you. The
  // board read "MY SESSIONS · 19" above two rows and "15 more" — and 2 + 15
  // is 17. The two bound sessions were counted in the header and explained
  // nowhere, so the arithmetic silently failed to close (found live, 0.5.59
  // screenshot). Counting only bound ATTENTION left exactly this hole.
  const onAgentCards = Math.max(0, all.length - mySessions.length);

  // ONE row renderer for both maps, so the two halves of the list can never
  // drift apart in what a row carries.
  const renderRow = (s: MySession) => (
    <MySessionRow
      key={s.sessionId}
      session={s}
      ageMs={effectiveAgoMs(s, observedAt, now)}
      stale={stale}
      snapshotAgeMs={observedAt === undefined ? undefined : Math.max(0, now - observedAt)}
      // Two ROWS in one directory cannot be told apart by cwd, and cwd
      // is the only join the terminal verbs have — so the verbs stand
      // down for both rows rather than type into a coin flip (codex r2).
      cwdShared={cwdCount(s.cwd) > 1}
      knownSignal={signalFor(s.cwd)}
      onOpenChange={(open) => setPin(s.sessionId, open)}
    />
  );

  return (
    <>
      {/* Rows first, fold line after: attention rows sit inside the FOR YOU
          zone directly under the waiting conversations; the section label
          doubles as the fold and follows them.
          ONE KEYED CHILDREN ARRAY, deliberately: `top` and `below` as two
          separate .map() arrays are two reconciliation lists, so a row
          crossing the fold (a pinned quiet row at collapse) would REMOUNT —
          resetting its open details and draft, firing onOpenChange(false),
          and unpinning itself (codex r1 P1 on #50). In a single array React
          matches by key across the whole list, fold line included, and the
          row MOVES — the same guarantee the old keyed-siblings swap carried
          (codex r5 P1 / r6 P2). */}
      {[
      ...top.map(renderRow),
      mySessions.length > 1 || mySessions.length < all.length ? (
        <button
          key="fold"
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => {
            // Folding the section by hand is a deliberate close — it
            // releases the pins, so the next open starts from evidence
            // again rather than from everything ever clicked.
            if (v) setPinned(new Set());
            return !v;
          })}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            width: '100%',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            fontFamily: 'inherit',
            fontSize: '9px',
            fontWeight: 600,
            color: color.faint,
            textTransform: 'uppercase',
            letterSpacing: '1px',
            padding: '4px 4px 4px',
            textAlign: 'left',
          }}
        >
          <span>My Sessions · {all.length}</span>
          {/* The attention counts moved OUT of this line: the FOR YOU zone
              header is now the board's one aggregate (buddy#49 decision 2),
              and the attention rows themselves render above this line — a
              second count here would be the same number twice. The two-claim
              distinction (your turn vs error recorded, codex r2 P2) survives
              on the rows, which say which they are. */}
          {!expanded && foldedCount > 0 && top.length + below.length > 0 && (
            // The arithmetic must close on screen (0.5.59 lesson): rows
            // shown + this = the total on this line. Only when rows ARE
            // shown — with nothing rendered, "· 16 · 16 more" would say the
            // same number twice. `below` counts too: a pinned row visible
            // under the line is a shown row the account must close against
            // (codex r6 P2 on #50).
            <span style={{ color: color.dim, textTransform: 'none', letterSpacing: 0 }}>
              · {foldedCount} more
            </span>
          )}
          {mySessions.length === 0 && (
            <span style={{ color: color.faint, textTransform: 'none', letterSpacing: 0 }}>
              · all shown with their agents
            </span>
          )}
          {/* A bare project name reads as a category — "· agent" sat beside
              "· your turn · 2" looking like a third count, when it is just
              the folder of the session that moved most recently. Say which
              it is. Dropped entirely once peek rows are on screen: they
              already show where the work is, and this becomes noise. */}
          {/* From `all`, not `mySessions`: bound rows render under their
              agents but are still sessions on this machine, and the newest
              one is frequently bound (agents work). Summarizing the unbound
              subset would name the wrong project as last active — a
              machine-wide claim computed from part of the machine
              (codex r1 P2). */}
          {!expanded && top.length === 0 && all.length > 0 && sessionsSummary(all) && (
            <span style={{ color: color.faint, textTransform: 'none', letterSpacing: 0 }}>
              · last active: {sessionsSummary(all)}
            </span>
          )}
          <span style={{
            fontSize: '8px',
            transform: expanded ? 'rotate(90deg)' : 'none',
            transition: 'transform 0.15s ease',
            display: 'inline-block',
            letterSpacing: 0,
          }}>
            {'›'}
          </span>
        </button>
      ) : (
        <div key="fold" style={{
          fontSize: '9px',
          fontWeight: 600,
          color: color.faint,
          textTransform: 'uppercase',
          letterSpacing: '1px',
          padding: '4px 4px 4px',
        }}>
          My Sessions · 1
        </div>
      ),
      ...below.map(renderRow),
      ]}
      {/* The old standalone fold row ("N more ›") is gone: the section line
          above now carries the account ("· N more") and the toggle, so the
          fold is one control instead of two saying the same number. */}
      {/* Everything counted in the header is on screen, but some of it
          renders on an agent card rather than here — so the number resolves
          to a place, not to nothing. It re-states no state: "those" is the
          header's own counts, whatever they were.
          Its OWN line, in every view. As a suffix on the fold it vanished
          whenever nothing was folded (one quiet unbound row + one bound row
          that wants you = a header count with no explanation), and it was
          swallowed by the fold button's aria-label, so screen readers heard
          the count and never the reason (codex r4 P2 ×2). */}
      {onAgentCards > 0 && (
        <div style={{ padding: '0 10px 4px', color: color.faint, fontSize: size[11] }}>
          {onAgentCards} {onAgentCards === 1 ? 'session renders' : 'sessions render'} on an agent card
        </div>
      )}
      {/* Retaining the snapshot is not retaining the certainty: while the
          latest read fails, the rows say how old they are. */}
      {stale && (
        <div style={{ color: color.faint, fontSize: size[11], padding: '0 4px 4px' }}>
          {mySessionsStaleLine(
            observedAt === undefined ? 'an earlier read' : formatAgoPrecise(Math.round((now - observedAt) / 1000)),
          )}
        </div>
      )}
    </>
  );
}

// Your own live Claude Code session. Read-only presence (step 1: "see"), now
// clickable to expand full context — cwd, what it's working on, model, exact
// heartbeat age (step 2: "ping" begins with a session you can focus + address).
export function MySessionRow({ session, ageMs, stale = false, snapshotAgeMs, cwdShared = false, knownSignal, onOpenChange }: {
  session: MySession;
  ageMs?: number;
  /** The latest my-sessions read failed — the ladder's rungs ① and ② must not claim current truth. */
  stale?: boolean;
  /** Age of the retained snapshot (now - observedAt), for dating rung ①'s evidence. */
  snapshotAgeMs?: number;
  /** Another row shares this cwd — the terminal verbs cannot tell them apart. */
  cwdShared?: boolean;
  /** The section already read this row's signal; use it instead of re-reading. */
  knownSignal?: SessionSignal;
  /**
   * Fired whenever this row opens OR closes. The section uses it to PIN the
   * row while it is open: an auto-surfaced row is derived from a live
   * signal, and a signal can vanish mid-edit (the turn gets answered, or a
   * transient IPC failure reads null) — which would unmount the row and
   * take the draft and the caret with it (codex r3 P2).
   *
   * Closing releases the pin. Reporting only the open transition meant
   * interacted rows accumulated for the life of the mount, and the
   * collapsed view slowly stopped folding anything (codex r8 P2).
   */
  onOpenChange?: (open: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  // Reported from an EFFECT, never from inside the state updater: calling
  // the parent's setState while React is evaluating this component's update
  // is a cross-component render-phase write (React warns, and updaters may
  // be replayed under Strict/concurrent mode). After commit is both legal
  // and sufficient — pinning is idempotent (codex r4 P2).
  useEffect(() => {
    onOpenChange?.(expanded);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);
  const [hovered, setHovered] = useState(false);
  const [copyState, setCopyState] = useState<'copied' | 'failed' | null>(null);
  // The four-rung ladder is evidence for the operator, noise for everyone
  // else. It stays one click away rather than in the first impression.
  const [showLadder, setShowLadder] = useState(false);
  const isActive = session.status === 'active';
  // The REAL heartbeat age: server-computed age-at-receipt plus elapsed local
  // time. Never compare an absolute server timestamp with the Mac clock — a
  // retained row must drift from "12s ago" to "1m ago" without clock skew.
  const heartbeatAgeMs = ageMs ?? session.agoSeconds * 1000;
  // Same 10-minute clock as every other dot: a session row's green is earned
  // by heartbeat age, not by a status word alone — AND by a succeeding latest
  // read. When `stale` (the latest my-sessions read failed), the retained age
  // may still look fresh, but we cannot currently see this session, so the dot
  // must not stay green while the expanded rung ② honestly says "can't see"
  // (audit #8). No green without a current, successful read.
  const dotColor = isActive && !stale && isFreshAge(heartbeatAgeMs) ? color.green : color.faint;

  // Call handoff. Availability is checked when the row is opened and never
  // cached — the app can quit between renders, and a button that fails after
  // the user commits to it is worse than one that was never offered.
  // Who this session is, if it has said. Read from BOT.md in the session's own
  // working directory — the same file vibeconf uses to give a bot a durable
  // character on a call, so the buddy list and the call agree by construction
  // instead of by syncing.
  const [botfile, setBotfile] = useState<Botfile | null>(null);
  useEffect(() => {
    let cancelled = false;
    readBotfile(session.cwd).then((b) => { if (!cancelled) setBotfile(b); });
    return () => { cancelled = true; };
  }, [session.cwd]);

  // What the session's own transcript shows. Local read; the Rust side
  // returns state only, never conversation content. Re-read on a slow tick
  // (a stranded turn is minutes-scale news, and the file is on this disk).
  const [ownSignal, setOwnSignal] = useState<SessionSignal | undefined>(undefined);
  const signal = knownSignal ?? ownSignal;
  const [signalTick, setSignalTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setSignalTick((n) => n + 1), 45_000);
    return () => clearInterval(t);
  }, []);
  // Refused where the cwd join could point at another runtime's transcript
  // (non-Claude host, or a directory two rows share) — codex r1 P1.
  const canJoinTranscript = transcriptJoinable({ clientName: session.clientName, cwdShared });
  useEffect(() => {
    if (knownSignal !== undefined) return; // the section already read it
    if (!canJoinTranscript) { setOwnSignal(undefined); return; }
    let cancelled = false;
    transcriptSignal(session.cwd).then((r) => { if (!cancelled) setOwnSignal(r?.signal); });
    return () => { cancelled = true; };
  }, [session.cwd, signalTick, canJoinTranscript, knownSignal]);
  const signalText = signal ? signalLine(signal) : null;
  const signalWantsYou = wantsYou(signal);

  // Four states, not two. "Not asked yet", "vibeconf is closed", "we could not
  // ask" and "ready" were previously collapsed such that the first three all
  // rendered NOTHING — so a feature that was merely gated looked exactly like a
  // feature that had been removed. That is not hypothetical: the question this
  // fixes was literally "what happened to being able to launch a vibeconf from
  // a session?" The answer was that vibeconf was not running, and Buddy said so
  // by drawing empty space.
  type CallProbe = 'unasked' | 'ready' | 'closed' | 'unknown';
  const [callProbe, setCallProbe] = useState<CallProbe>('unasked');
  const [callState, setCallState] = useState<string | null>(null);
  useEffect(() => {
    // Probe on hover as well as expand, now that Call is offered in the row
    // header rather than only inside the detail panel. Still never cached
    // across renders — the app can quit, and an affordance that outlives it
    // fails after the user has committed to it.
    if (!expanded && !hovered) return;
    let cancelled = false;
    setCallProbe('unasked');
    vibeconfAvailability().then((result) => {
      if (cancelled) return;
      // An IPC failure is not evidence vibeconf is closed — we learned nothing.
      // Keep those distinct so the copy can be honest about which it is.
      setCallProbe(result.error ? 'unknown' : result.available ? 'ready' : 'closed');
    });
    return () => { cancelled = true; };
  }, [expanded, hovered]);
  const canCall = callProbe === 'ready';

  // The ladder's rung ③: the seat app's own call-state report. Asked when the
  // row opens and RE-asked on an interval while it stays open — a call can
  // start, end, or the app can quit under an expanded row, and evidence that
  // outlives its moment is the overclaim this ladder exists to prevent.
  // `seatAskEpoch` forces an immediate re-ask after this row launches a call.
  const [seatProbe, setSeatProbe] = useState<SeatProbe>({ kind: 'checking' });
  const [seatAskEpoch, setSeatAskEpoch] = useState(0);
  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    setSeatProbe({ kind: 'checking' });
    const ask = () => vibeconfSeatState().then((s) => { if (!cancelled) setSeatProbe(s); });
    ask();
    const t = setInterval(ask, 10_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [expanded, seatAskEpoch]);

  const launchCall = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (callState) return;
    setCallState('starting…');
    try {
      const info = await startCall(
        sessionContext({ project: session.project, cwd: session.cwd, workingOn: session.workingOn }),
      );
      // Remember it, so closing the toast does not lose the link.
      rememberCall({ url: info.url, code: info.code, from: session.project, work: { project: session.project, branch: (session as { branch?: string }).branch } });
      // The paste line IS the feature: it is what makes the agent already
      // working in this cwd walk into the room knowing the work. Buddy cannot
      // put a brain in the bot; the session the user pastes into is the brain.
      try {
        await navigator.clipboard.writeText(joinLine(info.code));
        setCallState(`paste into ${session.project}`);
      } catch {
        setCallState(info.code);
      }
      setTimeout(() => setCallState(null), 12000);
    } catch (err) {
      setCallState(String(err).slice(0, 60));
      setTimeout(() => setCallState(null), 6000);
    } finally {
      // Either way the seat's state may just have changed — re-ask now
      // rather than waiting out the poll interval.
      setSeatAskEpoch((n) => n + 1);
    }
  };

  const copyPath = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const copied = await copyText(session.cwd);
    setCopyState(copied ? 'copied' : 'failed');
    setTimeout(() => setCopyState(null), copied ? 1500 : 3000);
  };

  // Session verbs — sessions are agents are bots (buddy#33). The row IS the
  // being, so it can be fronted and messaged. Row→tab matching happens at
  // the moment of use, never cached; the dangerous gate (claude must be the
  // tty's foreground, or typed bytes hit a shell) lives in Rust and its
  // refusals surface here verbatim.
  const [verbNote, setVerbNote] = useState<string | null>(null);
  // Which terminal is this session in, and can it hold a draft? iTerm can
  // place text without running it; Terminal.app's only verb RUNS what it is
  // given, and Buddy never presses enter for anyone. So the draft control is
  // hidden there rather than offered and then refused.
  //
  // Three states, not two: 'checking' while the enumeration is in flight,
  // and 'unknown' when it finished without a single confident match (host
  // blocked, tab gone, two candidates). Offering the draft box in either of
  // those is the refuse-later pattern this feature exists to avoid — it can
  // only appear once a host has SAID it can hold a line (codex r2 P2).
  type Host = { kind: 'checking' } | { kind: 'unknown' } | { kind: 'known'; app: string; canPlace: boolean };
  const [host, setHost] = useState<Host>({ kind: 'checking' });
  useEffect(() => {
    if (!expanded || !canJoinTranscript) return;
    let cancelled = false;
    setHost({ kind: 'checking' });
    (async () => {
      const { sessions } = await terminalSessions();
      if (cancelled) return;
      const m = matchSessionRow(session.cwd, sessions);
      setHost(
        m.kind === 'one'
          ? { kind: 'known', app: m.session.app, canPlace: m.session.can_place }
          : { kind: 'unknown' },
      );
    })();
    return () => { cancelled = true; };
  }, [expanded, session.cwd, canJoinTranscript]);
  const canPlaceHere = host.kind === 'known' && host.canPlace;
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);

  const resolveTab = async (): Promise<{ tty: string; app: string; note?: string } | { error: string }> => {
    const { sessions, error, warnings } = await terminalSessions();
    if (error) return { error };
    const match = matchSessionRow(session.cwd, sessions);
    if (match.kind === 'none') {
      // If a host was unreadable, "no tab" is not established — say which
      // one couldn't be asked rather than reporting an absence we can't see.
      const why = warnings.length ? ` (${warnings.join(' · ')})` : '';
      return { error: `no terminal tab has claude running in this directory${why}` };
    }
    if (match.kind === 'many') {
      // REFUSE, never pick: enumeration order is unrelated to which session
      // this row is, and a wrong pick types into a different being (codex
      // P1). Name the tabs so the person can act by hand.
      const names = match.sessions.map((s) => `"${s.name}"`).join(', ');
      return {
        error: `${match.sessions.length} tabs run claude in this directory (${names}) — Buddy can't tell which one is this session, so it won't guess`,
      };
    }
    // The host travels WITH the tty, always. Rust defaults an absent app to
    // iTerm2, so dropping it here made "Open Session" on a Terminal.app row
    // activate — or launch — iTerm instead of focusing the tab the person is
    // looking at (codex r2 P1). tty alone does not identify a tab.
    return { tty: match.session.tty, app: match.session.app };
  };

  const frontVerb = async () => {
    setVerbNote('finding the session…');
    const r = await resolveTab();
    if ('error' in r) { setVerbNote(r.error); return; }
    const f = await frontSession(r.tty, r.app);
    setVerbNote(f.ok ? 'opened' : (f.error ?? "couldn't open the session"));
  };

  const placeVerb = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setVerbNote('finding the session…');
    const r = await resolveTab();
    if ('error' in r) { setVerbNote(r.error); setSending(false); return; }
    const w = await placeInSession(r.tty, text, r.app);
    if (w.ok) {
      // Front the tab so the enter key is one reach away — the terminal
      // owns the turn, and this walks you to it with the draft staged.
      await frontSession(r.tty, r.app).catch(() => {});
      setVerbNote('opened with your line ready — press enter there; the turn is yours');
      setDraft('');
    } else {
      setVerbNote(w.error ?? "couldn't open with your draft");
    }
    setSending(false);
  };

  // The verbs exist only where they can work: a claude-code session (the
  // enumerator matches only foreground `claude` processes — a codex or
  // cursor row would offer a button that always fails), in a directory no
  // sibling row shares (cwd is the only join; two rows one cwd = coin flip).
  const verbsSupported = /claude/i.test(session.clientName || '');

  return (
    <div style={{ marginBottom: '2px' }}>
      <div
        className="vibe-press"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-label={`your ${session.project || 'coding'} session`}
        onKeyDown={pressOnKey(() => setExpanded((v) => !v))}
        style={{
          padding: '5px 10px',
          borderRadius: expanded ? '4px 4px 0 0' : '4px',
          background: hovered || expanded ? color.panel : color.bg,
          cursor: 'pointer',
          transition: 'background 0.15s ease',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '6px',
        }}
        onClick={() => setExpanded((v) => !v)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        title={expanded ? 'Hide session detail' : 'Show session detail'}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0, flex: 1 }}>
          {/* The agent's own face when it has declared one, the generic terminal
              when it has not. A session with a BOT.md is somebody; a session
              without one must look exactly as it always did, not like something
              failed to load. */}
          <span
            style={{ fontSize: '12px', flexShrink: 0 }}
            title={botfile ? `${botfile.display} — from BOT.md in ${session.cwd}` : undefined}
          >
            {botfile?.emoji || '🖥️'}
          </span>
          <span
            style={{
              width: '6px',
              height: '6px',
              borderRadius: '50%',
              background: dotColor,
              flexShrink: 0,
              display: 'inline-block',
            }}
          />
          <span
            style={{
              fontWeight: 600,
              color: color.ink,
              fontSize: '11px',
              fontFamily: 'monospace',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {sessionLabel(botfile, session.project)}
          </span>
          {signalWantsYou && (
            // ONLY the two states evidence supports as "wants you" surface on
            // the collapsed row — a marker on every maybe would rebuild the
            // attention loss this feature exists to end. Words, not colour
            // alone; the expanded row carries the evidence.
            <span
              title={signalText ?? undefined}
              style={{
                flexShrink: 0,
                fontSize: '8px',
                padding: '1px 5px',
                borderRadius: '3px',
                background: color.line,
                color: color.dim,
                whiteSpace: 'nowrap',
              }}
            >
              {signal?.kind === 'api-error-recent' ? 'error recorded' : 'your turn'}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '5px', flexShrink: 0 }}>
          {session.model && (
            <span
              style={{
                fontSize: '8px',
                padding: '1px 4px',
                borderRadius: '3px',
                background: color.line,
                color: color.dim,
                border: `1px solid ${color.line}`,
              }}
            >
              {formatModel(session.model)}
            </span>
          )}
          {/* OPEN, FROM THE ROW ITSELF.
              The router's whole job is to shorten notice -> arrival, and it
              still cost an expand: see it, open the row, then find the verb.
              This is the same frontVerb the detail panel uses, on the same
              gates (claude host, unshared cwd) — it just stops making you
              open a drawer to reach it.
              Shown when the row is asking for you, or on hover for the rest,
              so quiet rows stay quiet. stopPropagation because the row body
              toggles expansion. */}
          {verbsSupported && !cwdShared && (signalWantsYou || hovered) && !expanded && (
            <span
              role="button"
              tabIndex={0}
              className="vibe-press"
              onClick={(e) => { e.stopPropagation(); void frontVerb(); }}
              onKeyDown={(e) => { e.stopPropagation(); pressOnKey(() => void frontVerb())(e); }}
              title="Bring this session's terminal tab to the front"
              aria-label={`open your ${session.project || 'coding'} session`}
              style={{
                flexShrink: 0,
                fontSize: '8px',
                padding: '1px 6px',
                borderRadius: '3px',
                background: color.panel,
                color: color.blue,
                border: `1px solid ${color.line}`,
                cursor: 'pointer',
                fontWeight: 600,
                whiteSpace: 'nowrap',
              }}
            >
              {/* "Open Session", not "Open": one action, one name, wherever
                  it appears (ROOM TONE). And the row itself opens details,
                  so a bare "Open" is ambiguous about which thing opens
                  (codex P2). */}
              Open Session
            </span>
          )}
          <span style={{ fontSize: '9px', color: color.faint, fontFamily: 'monospace' }}>
            {formatAgo(Math.round(heartbeatAgeMs / 1000))}
          </span>
          {/* Chevron — signals the row opens. Rotates when expanded. */}
          <span
            style={{
              fontSize: '8px',
              color: color.faint,
              transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
              transition: 'transform 0.15s ease',
              display: 'inline-block',
            }}
          >
            {'›'}
          </span>
        </div>
      </div>

      {/* The collapsed Open button reports HERE. Without this its result —
          including refusals like "2 tabs run claude in this directory" —
          would land inside a panel the user never opened. */}
      {!expanded && verbNote && (
        <div style={{ padding: '2px 10px 4px 28px', color: color.faint, fontSize: size[11] }}>
          {verbNote}
        </div>
      )}

      {/* Detail panel — everything the beacon knows about this session. */}
      {expanded && (
        <div
          style={{
            padding: '7px 10px 8px 28px',
            background: color.bg,
            borderRadius: '0 0 4px 4px',
            borderLeft: `2px solid ${dotColor}44`,
            fontSize: '10px',
            color: color.faint,
            lineHeight: 1.6,
          }}
        >
          {session.workingOn && (
            <div style={{ color: color.dim, marginBottom: '3px' }}>
              {session.workingOn}
            </div>
          )}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              fontFamily: 'monospace',
              color: color.faint,
            }}
          >
            <span
              style={{
                minWidth: 0,
                flex: 1,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={session.cwd}
            >
              {session.cwd}
            </span>
            <span
              onClick={copyPath}
              title="Copy working directory"
              style={{
                flexShrink: 0,
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
              {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy'}
            </span>
            {/* Hand the call to vibeconf. Only offered when the app answered a
                health probe moments ago — launching a call requires it running
                on this Mac, and there is no cloud path to fall back to. */}
            {canCall && (
              <span
                onClick={launchCall}
                title="Start a vibeconf call from this session"
                style={{
                  flexShrink: 0,
                  fontSize: '8px',
                  padding: '1px 5px',
                  borderRadius: '3px',
                  background: color.panel,
                  color: callState ? color.dim : color.blue,
                  border: `1px solid ${color.line}`,
                  cursor: callState ? 'default' : 'pointer',
                  fontWeight: 600,
                  maxWidth: '140px',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {callState || 'Call'}
              </span>
            )}
            {/* Say why the button is missing, and name the fix in the same
                breath. Ambient, not a nag: one faint line, no icon, no colour
                budget spent — but never empty space where a capability was. */}
            {callProbe === 'closed' && (
              <span
                title="Buddy hands calls to the Vibeconferencing app, which has to be running on this Mac"
                style={{ flexShrink: 0, fontSize: '8px', color: color.faint }}
              >
                open vibeconf to call
              </span>
            )}
            {callProbe === 'unknown' && (
              <span
                title="Buddy could not reach the Vibeconferencing app to ask — this is not proof it is closed"
                style={{ flexShrink: 0, fontSize: '8px', color: color.faint }}
              >
                couldn't check calls
              </span>
            )}
          </div>
          <div style={{ marginTop: '3px', color: color.faint }}>
            {stale ? 'last reported ' : ''}{isActive ? 'active' : 'idle'} · heartbeat {formatAgoPrecise(Math.round(heartbeatAgeMs / 1000))}
          </div>
          {signalText && (
            // The transcript's own evidence, in the words it earns. Never a
            // diagnosis: a dangling tool call names what was seen and stops.
            <div style={{ marginTop: '2px', color: signalWantsYou ? color.dim : color.faint }}>
              {signalText}
            </div>
          )}

          {/* The verbs. "front" lands you in the iTerm tab; the input STAGES
              a draft in the claude prompt, unsubmitted — the terminal owns
              the turn, so pressing enter there is yours (codex r2 / canon).
              Rendered only where they can work; absence explains itself. */}
          {verbsSupported && cwdShared && (
            <div style={{ marginTop: '6px', color: color.faint }}>
              two of your sessions share this directory — the terminal verbs stand
              down rather than guess which tab is which
            </div>
          )}
          {verbsSupported && !cwdShared && (
          <div
            style={{ display: 'flex', alignItems: 'center', gap: '5px', marginTop: '6px' }}
            onClick={(e) => e.stopPropagation()}
          >
            <span
              role="button"
              tabIndex={0}
              onClick={() => void frontVerb()}
              onKeyDown={pressOnKey(() => void frontVerb())}
              title={host.kind === 'known'
                ? `Bring this session's ${host.app} tab to the front`
                : "Bring this session's terminal tab to the front (iTerm2 or Terminal.app)"}
              style={{
                flexShrink: 0,
                fontSize: '8px',
                padding: '2px 6px',
                borderRadius: '3px',
                background: color.panel,
                color: color.blue,
                border: `1px solid ${color.line}`,
                cursor: 'pointer',
                fontWeight: 600,
              }}
            >
              Open Session
            </span>
            {canPlaceHere && (
            <>
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') { e.preventDefault(); void placeVerb(); }
              }}
              placeholder="type a line to start it with…"
              aria-label={`stage a draft in your ${session.project || 'coding'} session — you submit it there`}
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: '10px',
                fontFamily: 'monospace',
                padding: '3px 6px',
                borderRadius: '3px',
                background: color.panel,
                color: color.ink,
                border: `1px solid ${color.line}`,
                outline: 'none',
              }}
            />
            <span
              role="button"
              tabIndex={0}
              onClick={() => void placeVerb()}
              onKeyDown={pressOnKey(() => void placeVerb())}
              title="Puts your line in that session's claude prompt, unsubmitted, and opens the tab — you press enter"
              style={{
                flexShrink: 0,
                fontSize: '8px',
                padding: '2px 6px',
                borderRadius: '3px',
                background: color.panel,
                color: sending ? color.dim : color.blue,
                border: `1px solid ${color.line}`,
                cursor: sending ? 'default' : 'pointer',
                fontWeight: 600,
              }}
            >
              {sending ? 'opening…' : 'Open with Draft'}
            </span>
            </>
            )}
          </div>
          )}
          {host.kind === 'known' && !host.canPlace && (
            <div style={{ marginTop: '3px', color: color.faint }}>
              {host.app} can only run a line, not hold one — open the session and type there
            </div>
          )}
          {verbNote && (
            <div style={{ marginTop: '3px', color: color.faint }}>{verbNote}</div>
          )}
          {/* Evidence, on request. The ladder tells the operator exactly
              what is and isn't verified about bringing this session into a
              call — indispensable when something is wrong, and pure noise on
              a first look. */}
          <div
            className="vibe-press"
            role="button"
            tabIndex={0}
            onClick={(e) => { e.stopPropagation(); setShowLadder((v) => !v); }}
            onKeyDown={pressOnKey(() => setShowLadder((v) => !v))}
            style={{ marginTop: '4px', color: color.faint, cursor: 'pointer', display: 'inline-block' }}
          >
            {showLadder ? '▾ hide details' : '▸ details'}
          </div>
          {showLadder && (
            <>
          {/* The bring-a-session ladder: the four facts between "this session
              exists" and "this session is on the call", each with its own
              evidence, never collapsed into one light. Rung ④ has no
              verification primitive yet and says so — that honesty is the
              feature, not a gap in it. */}
          <div style={{ marginTop: '5px', borderTop: `1px solid ${color.line}`, paddingTop: '4px' }}>
            {(() => {
              const ladder = sessionLadder({
                probe: stale ? 'unchecked' : 'known',
                clientName: session.clientName,
                snapshotAgeMs,
                effectiveAgeMs: heartbeatAgeMs,
                seat: seatProbe,
              });
              const rungs: Array<[string, string, Rung]> = [
                ['①', 'configured', ladder.configured],
                ['②', 'heartbeating', ladder.heartbeating],
                ['③', 'seated', ladder.seated],
                ['④', 'driving', ladder.driving],
              ];
              return rungs.map(([glyph, word, rung]) => (
                <div
                  key={word}
                  style={{ display: 'flex', alignItems: 'baseline', gap: '5px', lineHeight: 1.7 }}
                >
                  <span style={{ color: color.faint, flexShrink: 0 }}>{glyph}</span>
                  <span
                    style={{
                      color: rung.state === 'yes' || rung.state === 'live' ? color.dim : color.faint,
                      flexShrink: 0,
                      minWidth: '68px',
                    }}
                  >
                    {word}
                  </span>
                  {/* Green is live presence only — today rung ② fresh alone;
                      rung ③ needs Meet participant evidence no signal carries
                      yet (audit #10). */}
                  {rung.state === 'live' && (
                    <span
                      style={{
                        width: '5px',
                        height: '5px',
                        borderRadius: '50%',
                        background: color.green,
                        flexShrink: 0,
                        alignSelf: 'center',
                      }}
                    />
                  )}
                  {rung.state === 'yes' && <span style={{ color: color.dim, flexShrink: 0 }}>✓</span>}
                  <span
                    style={{
                      color: color.faint,
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={rung.evidence}
                  >
                    {rung.evidence}
                  </span>
                </div>
              ));
            })()}
          </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
