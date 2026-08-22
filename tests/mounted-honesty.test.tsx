// @vitest-environment jsdom
//
// Mounted-component coverage for the honesty states — take-stock Move 1.
// The 152 logic tests prove the copy functions; nothing before this file
// proved the copy actually REACHES the screen. These tests mount the real
// components over the same synthetic fixtures the dev screenshot harness
// uses, so the Move-2 deletions and the UnifiedBuddyList split cannot
// silently drop an honesty state.
//
// One-definition discipline: assertions import the canonical copy from the
// state modules rather than repeating strings — if the words change on
// purpose, they change in one place and these tests follow.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Tauri IPC does not exist under jsdom. Every invoke answers with the
// truthful-unknown shape its caller expects, so mounted components render
// their cannot-see states rather than crashing.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string) => {
    switch (cmd) {
      case 'vibeconf_available':
        return null; // app not detected
      case 'vibeconf_seat_state':
        return { kind: 'closed' };
      case 'read_botfile':
        return null;
      default:
        return null;
    }
  }),
}));

// DMPanel opens SSE streams on mount; the network layer is not under test.
vi.mock('../src/lib/realtime', () => ({
  realtime: {
    init: vi.fn(),
    openDM: vi.fn(),
    goBackground: vi.fn(),
    setTypingCallback: vi.fn(),
  },
}));

import UnifiedBuddyList from '../src/components/UnifiedBuddyList';
import DMPanel from '../src/components/DMPanel';
import { FIXTURES, ME } from '../src/dev/fixtures';
import {
  FIRST_RECOGNITION,
  mySessionsEmptyLine,
} from '../src/lib/mySessionsState';
import { DRIVING_RUNG } from '../src/lib/sessionLadder';
import type { VibeUser, MySession } from '../src/lib/vibeClient';
import { MySessionsSection } from '../src/components/list/MySessions';
import type { SessionSignal } from '../src/lib/transcript';

function mountFixture(name: keyof typeof FIXTURES) {
  const fixture = FIXTURES[name];
  return render(
    <UnifiedBuddyList
      handle={ME}
      greeter="guide_demo"
      users={fixture.users}
      sessions={fixture.sessions}
      mySessions={fixture.mySessions}
      mySessionsProbe={fixture.mySessionsProbe}
      mySessionsObservedAt={fixture.mySessionsObservedAt}
      threads={fixture.threads}
      presenceError={fixture.presenceError}
      recentlyHere={fixture.recentlyHere}
      pairedWith={fixture.pairedWith}
      myPresence={{
        prefs: fixture.prefs,
        broadcast: fixture.prefs.sharing ? fixture.broadcast : null,
        lastLandedAt: fixture.lastLandedAt,
      }}
      onPresenceChange={() => {}}
      onUserClick={() => {}}
      onSignOut={() => {}}
      onSession={() => {}}
    />,
  );
}

beforeEach(() => cleanup());

describe('MY SESSIONS honesty states, on screen', () => {
  it('a fresh solo session renders its row and the recognition line', () => {
    mountFixture('solo-with-session');
    // The row exists…
    expect(screen.getByText(/My Sessions/i)).toBeTruthy();
    // …and the one place Buddy says what a session row IS renders over it.
    expect(screen.getByText(FIRST_RECOGNITION)).toBeTruthy();
  });

  it('a failed read says cannot-see — never "no sessions"', () => {
    mountFixture('sessions-unchecked');
    expect(screen.getByText(mySessionsEmptyLine('unchecked'))).toBeTruthy();
    expect(screen.queryByText(mySessionsEmptyLine('known'))).toBeNull();
  });

  it('retained rows under a failing read carry the stale line and never the recognition now-claim', () => {
    mountFixture('sessions-stale');
    expect(screen.getByText(/reconnecting — sessions as of/i)).toBeTruthy();
    expect(screen.queryByText(FIRST_RECOGNITION)).toBeNull();
  });
});

describe('the session ladder, on screen', () => {
  it('the ladder is one click away, and rung ④ still refuses to claim', async () => {
    // The rungs moved behind "details" (2026-08-14): they are indispensable
    // evidence when something is wrong and pure noise in a first impression.
    // The honesty guarantee is unchanged — it just is not the opening line.
    const user = userEvent.setup();
    mountFixture('solo-with-session');
    await user.click(screen.getByRole('button', { name: /your .* session/i }));
    // Not shouting on open…
    expect(screen.queryByText('driving')).toBeNull();
    // …and one click reveals every rung, rung ④ included.
    await user.click(screen.getByText(/details/));
    for (const word of ['configured', 'heartbeating', 'seated', 'driving']) {
      expect(screen.getByText(word)).toBeTruthy();
    }
    expect(screen.getByText(DRIVING_RUNG.evidence)).toBeTruthy();
  });
});

describe('DM broadcast-only banner (kill switch 0b shape)', () => {
  const them: VibeUser = {
    handle: 'bob_demo',
    status: 'online',
    workingOn: 'agent things',
    lastSeen: new Date().toISOString(),
    reachability: 'broadcast-only',
  } as unknown as VibeUser;

  it('states the server-computed fact without a count or a forever-verdict', () => {
    render(
      <DMPanel handle={ME} chatWith="bob_demo" onBack={() => {}} users={[them]} />,
    );
    // Twice now, deliberately: the composer-moment notice AND the thread
    // header's served reachability words (buddy#53 critique vocabulary).
    expect(screen.getAllByText(/hasn't been reading messages here/i).length).toBeGreaterThan(0);
    // The retired accusation shapes must not return.
    expect(screen.queryByText(/isn't reading its messages/i)).toBeNull();
    expect(screen.queryByText(/until someone wires it up/i)).toBeNull();
  });
});

// The fold, mounted. Source-regex tests cannot tell you whether a row
// reached the screen — and "the count is visible but the rows are not" was
// exactly the bug (0.5.58 board: MY SESSIONS · 16 · your turn · 2, nothing
// under it). These mount the real section and read the DOM.
describe('a collapsed MY SESSIONS still shows what wants you', () => {
  const mk = (n: number, project: string, agoSeconds = 60): MySession => ({
    sessionId: `s-${n}`,
    cwd: `/Users/alice/work/${project}`,
    project,
    status: 'active',
    agoSeconds,
    clientName: 'claude-code',
  });

  // Sixteen sessions, two of which finished their turn.
  const many = Array.from({ length: 16 }, (_, i) => mk(i, `proj-${i}`));
  const signals = new Map<string, SessionSignal>([
    [many[3].cwd, { kind: 'awaiting-you', idle_seconds: 240 }],
    [many[9].cwd, { kind: 'awaiting-you', idle_seconds: 700 }],
    [many[5].cwd, { kind: 'working', idle_seconds: 2 }],
  ]);

  const mountSection = (sessions: MySession[], sigs = signals, attention?: MySession[]) =>
    render(
      <MySessionsSection
        mySessions={sessions}
        observedAt={Date.now()}
        allCwds={(attention ?? sessions).map((s) => s.cwd)}
        attentionSessions={attention}
        signals={sigs}
      />,
    );

  it('mounts the waiting rows while folding the quiet ones', () => {
    mountSection(many);
    // The two that want you are ON SCREEN, unexpanded.
    expect(screen.getByText(/proj-3/)).toBeTruthy();
    expect(screen.getByText(/proj-9/)).toBeTruthy();
    // ...and a quiet one is not.
    expect(screen.queryByText(/proj-7/)).toBeNull();
    // The fold names exactly what it hid: 16 - 2 = 14.
    expect(screen.getByText(/14 more/)).toBeTruthy();
    // NOT "quiet": one of the folded rows is `working` (codex r1 P2).
    expect(screen.queryByText(/quiet/)).toBeNull();
  });

  it('opens to everything when the fold is clicked', async () => {
    mountSection(many);
    await userEvent.click(screen.getByText(/14 more/));
    expect(screen.getByText(/proj-7/)).toBeTruthy();
    expect(screen.queryByText(/14 more/)).toBeNull();
  });

  it('with nothing waiting, the whole list stays folded as before', () => {
    mountSection(many, new Map());
    expect(screen.queryByText(/proj-3/)).toBeNull();
    // With no rows above the fold line, the section total IS the account —
    // a second "· 16 more" would say the same number twice.
    expect(screen.getByText(/My Sessions · 16/)).toBeTruthy();
    expect(screen.queryByText(/more/)).toBeNull();
    // The most-recent project is labeled rather than dangling as "· agent".
    expect(screen.getByText(/last active:/)).toBeTruthy();
  });

  it('a row you opened survives its signal disappearing (codex r3 P2)', async () => {
    // The peek set is derived from live signals, so an answered turn — or a
    // transient IPC failure reading null — used to unmount the row mid-edit
    // and take the draft with it.
    const { rerender } = mountSection(many);
    await userEvent.click(screen.getByText(/proj-3/));
    // The signal for proj-3 vanishes on the next refresh.
    const gone = new Map(signals);
    gone.delete(many[3].cwd);
    rerender(
      <MySessionsSection
        mySessions={many}
        observedAt={Date.now()}
        allCwds={many.map((s) => s.cwd)}
        signals={gone}
      />,
    );
    // Still mounted: you opened it, so only you close it. (An open row
    // renders its name in more than one place, hence getAllByText.)
    expect(screen.getAllByText(/proj-3/).length).toBeGreaterThan(0);
  });

  it('a quiet row opened while expanded stays open in place (codex r1 P1 on #50)', async () => {
    // The fold-line split renders rows in two halves. As two separate .map()
    // arrays those were two reconciliation lists, and pinning promoted the
    // row across them — so opening a QUIET row while expanded moved it,
    // REMOUNTED it, reset its open details and fired onOpenChange(false):
    // quiet session details could not stay open at all. Two fixes under
    // test: pins no longer relocate rows while expanded, and the halves are
    // one keyed children array either way.
    mountSection(many);
    await userEvent.click(screen.getByText(/My Sessions · 16/));
    await userEvent.click(screen.getByText(/proj-7/));
    // Open details render the name in more than one place (row + cwd line);
    // a remount would have collapsed it back to one.
    expect(screen.getAllByText(/proj-7/).length).toBeGreaterThan(1);
  });

  it('explains the header count even when nothing is folded (codex r4 P2)', () => {
    // One quiet unbound row + one bound row that wants you: nothing to
    // fold, so the suffix version of this line rendered nowhere and the
    // header count had no explanation at all.
    const two = [mk(0, 'solo')];
    const boundOne = mk(1, 'bound-one');
    const sigs = new Map<string, SessionSignal>([
      [boundOne.cwd, { kind: 'awaiting-you', idle_seconds: 120 }],
    ]);
    mountSection(two, sigs, [...two, boundOne]);
    expect(screen.queryByText(/more|sessions ›/)).toBeNull();
    expect(screen.getByText(/on an agent card/)).toBeTruthy();
  });

  it('points at attention that renders under an agent card instead of here', () => {
    // Two sessions want you; one of them is bound to an agent, so it is not
    // in this list. "1 more" pointing at nothing would be the same lie in a
    // new place.
    const unbound = many.filter((s) => s.cwd !== many[9].cwd);
    mountSection(unbound, signals, many);
    expect(screen.getByText(/proj-3/)).toBeTruthy();
    // Placement only — no direction word (the paired hero renders ABOVE),
    // no possessive identity (BOT.md is self-reported), no state re-claim
    // (the set spans turns AND errors). All three were codex r2 findings.
    expect(screen.getByText(/on an agent card/)).toBeTruthy();
    expect(screen.queryByText(/below/)).toBeNull();
    expect(screen.queryByText(/their agents/)).toBeNull();
  });
});

// The router's job is to shorten notice → arrival. It still cost an expand:
// see the row, open it, then find the verb. And the header's arithmetic did
// not close — 19 above two rows and "15 more" leaves 2 unexplained.
describe('acting on a waiting session takes one click', () => {
  const mk = (n: number, project: string): MySession => ({
    sessionId: `v-${n}`,
    cwd: `/Users/alice/work/${project}`,
    project,
    status: 'active',
    agoSeconds: 30,
    clientName: 'claude-code',
  });
  const rows = [mk(0, 'alpha'), mk(1, 'beta'), mk(2, 'gamma')];
  const sigs = new Map<string, SessionSignal>([
    [rows[0].cwd, { kind: 'awaiting-you', idle_seconds: 300 }],
  ]);

  it('a waiting row offers Open without being expanded', () => {
    render(
      <MySessionsSection mySessions={rows} observedAt={Date.now()}
        allCwds={rows.map((s) => s.cwd)} signals={sigs} />,
    );
    // The row is surfaced AND actionable in the same glance.
    expect(screen.getByText(/alpha/)).toBeTruthy();
    expect(screen.getByLabelText(/open your alpha session/i)).toBeTruthy();
    // Quiet rows are folded, so they offer nothing at all.
    expect(screen.queryByLabelText(/open your beta session/i)).toBeNull();
  });

  it('the header arithmetic closes: shown + folded + elsewhere = the count', () => {
    // Two bound sessions render on agent cards; the section must account for
    // them or the header count is unexplainable (found live, 0.5.59).
    const bound = [mk(8, 'bound-a'), mk(9, 'bound-b')];
    render(
      <MySessionsSection mySessions={rows} observedAt={Date.now()}
        allCwds={[...rows, ...bound].map((s) => s.cwd)}
        attentionSessions={[...rows, ...bound]} signals={sigs} />,
    );
    expect(screen.getByText(/My Sessions · 5/)).toBeTruthy();   // 5 machine-wide
    expect(screen.getByText(/2 more/)).toBeTruthy();            // 2 folded here
    expect(screen.getByText(/2 sessions render on an agent card/)).toBeTruthy();
    // 1 shown + 2 folded + 2 elsewhere = 5.
  });
});

// The compose box is the only place reachability can change behaviour: the
// row answers "who should I talk to", this answers "what happens if I send".
describe('the send box says what will happen to the message', () => {
  const mk = (over: Partial<VibeUser> = {}): VibeUser => ({
    handle: 'uriel', displayName: 'uriel', status: 'active',
    lastSeen: new Date().toISOString(), isAgent: true, ...over,
  } as VibeUser);

  const mount = (them: VibeUser) =>
    render(<DMPanel handle="alice_demo" chatWith={them.handle} onBack={() => {}} users={[them]} />);

  it('states the unread case ONCE, in the bounded wording', async () => {
    mount(mk({ reachability: 'broadcast-only', unreadCount: 4 }));
    const notices = await screen.findAllByText(/hasn't been reading messages here/);
    // One notice, not two: a second block was added here and duplicated the
    // one that already existed, in worse words (codex P2).
    expect(notices).toHaveLength(1);
    // And NOT the verdict Move 0b removed — 'isn't reading — N unread' reads
    // a 15-minute stale-mail heuristic as a current-state fact, and renders
    // the self-contradiction "isn't reading — 0 unread" when the count is
    // missing (codex P1).
    expect(screen.queryByText(/isn't reading/)).toBeNull();
    expect(screen.queryByText(/unread/)).toBeNull();
  });

  it('an untested agent gets a standing evidence gap, not a claim about the past', async () => {
    // "nobody has messaged this agent yet" goes false the instant you send,
    // and would sit under your own message contradicting it until presence
    // refreshed. This wording is true before and after (codex P2).
    mount(mk({ reachability: 'unknown', lastReadAt: null }));
    expect(await screen.findByText(/nothing here shows whether @uriel reads or answers/)).toBeTruthy();
    expect(screen.queryByText(/nobody has messaged/)).toBeNull();
  });

  it('stays silent when the endpoint never annotated reachability', async () => {
    // /v2/presence omits it today. An omitted field must not read as "never
    // read" — that inverts unknown-first into a confident claim about every
    // agent on the board (codex P1).
    mount(mk({ reachability: undefined, lastReadAt: undefined }));
    await screen.findByPlaceholderText(/Message @uriel/);
    expect(screen.queryByText(/nothing here shows whether/)).toBeNull();
    expect(screen.queryByText(/hasn't been reading/)).toBeNull();
  });

  it('survives the first send — unread is not read evidence', async () => {
    // Sending the first DM flips the platform enum unknown -> listening
    // because unreadCount > 0, while lastReadAt stays null. An enum-based
    // notice would vanish here for fifteen minutes (codex P2).
    mount(mk({ reachability: 'listening', unreadCount: 1, lastReadAt: null }));
    expect(await screen.findByText(/nothing here shows whether @uriel reads or answers/)).toBeTruthy();
  });

  it('says NOTHING when there is no evidence to report', async () => {
    // "Seems fine" is not evidence, and a line that is always present stops
    // being read — which would cost us the warning that matters.
    // 'listening' — the real state. An earlier draft passed 'reading', which
    // the union and the normalizer cannot produce, so the test proved nothing
    // about actual listeners (codex P3). lastReadAt present = read evidence.
    mount(mk({ reachability: 'listening', unreadCount: 0, lastReadAt: new Date().toISOString() }));
    await screen.findByPlaceholderText(/Message @uriel/);
    expect(screen.queryByText(/isn't reading/)).toBeNull();
    expect(screen.queryByText(/nobody has messaged/)).toBeNull();
  });

  it('stays silent when the endpoint never annotated reachability', async () => {
    // /v2/presence omits it today. An omitted field must not read as "never
    // read" — that inverts unknown-first into a confident claim about every
    // agent on the board (codex P1).
    mount(mk({ reachability: undefined, lastReadAt: undefined }));
    await screen.findByPlaceholderText(/Message @uriel/);
    expect(screen.queryByText(/nothing here shows whether/)).toBeNull();
    expect(screen.queryByText(/hasn't been reading/)).toBeNull();
  });

  it('survives the first send — unread is not read evidence', async () => {
    // Sending the first DM flips the platform enum unknown -> listening
    // because unreadCount > 0, while lastReadAt stays null. An enum-based
    // notice would vanish here for fifteen minutes (codex P2).
    mount(mk({ reachability: 'listening', unreadCount: 1, lastReadAt: null }));
    expect(await screen.findByText(/nothing here shows whether @uriel reads or answers/)).toBeTruthy();
  });

});

describe('the Search affordance is visible, quiet, and reveals the real field (coordinator ask on public source)', () => {
  const btn = () => screen.getByRole('button', { name: 'Search people and sessions' });

  it('is always present in the header, even in a populated room', () => {
    mountFixture('current');
    expect(btn()).toBeTruthy();
    expect(screen.getByText('Search')).toBeTruthy();
  });

  it('is subdued by default and turns blue only when active', () => {
    mountFixture('current');
    // Quiet by default: faint, not the /vibe blue.
    expect(btn().style.color).toBe('rgb(107, 114, 128)'); // color.faint
    expect(btn().getAttribute('aria-expanded')).toBe('false');
  });

  it('clicking reveals and focuses the existing search field', async () => {
    const user = userEvent.setup();
    mountFixture('current');
    await user.click(btn());
    const field = screen.getByPlaceholderText(/Search the room/i);
    expect(field).toBeTruthy();
    expect(document.activeElement).toBe(field);
    // Now active → blue and expanded.
    expect(btn().style.color).toBe('rgb(107, 143, 255)'); // color.blue
    expect(btn().getAttribute('aria-expanded')).toBe('true');
  });

  it('keeps a visible focus ring for keyboard users', async () => {
    mountFixture('current');
    fireEvent.focus(btn());
    await waitFor(() => expect(btn().style.outline).toContain('#6B8FFF')); // color.blue
    fireEvent.blur(btn());
    await waitFor(() => expect(btn().style.outline).toBe('none'));
  });

  it('the search field stays the ONLY search UI — the control adds no second system', async () => {
    const user = userEvent.setup();
    mountFixture('current');
    await user.click(btn());
    // The control drives the same searchRevealed/searchRef path, not a new
    // input: exactly one search field exists after reveal.
    const fields = await screen.findAllByPlaceholderText(/Search the room/i);
    expect(fields).toHaveLength(1);
  });
});
