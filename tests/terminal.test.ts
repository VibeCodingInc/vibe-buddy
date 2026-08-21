// Session verbs — the matching layer (buddy#33: sessions are agents are bots).
//
// The dangerous gate (claude must be the tty's foreground) lives in Rust
// with its own tests; what TS owns is WHICH tab a row means, and that
// matching must be exact — a sloppy match here is Rust's gate aimed at the
// wrong being.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { matchSessionRow, type TerminalSession } from '../src/lib/terminal';

const tab = (over: Partial<TerminalSession>): TerminalSession => ({
  window_id: '9159',
  tty: '/dev/ttys008',
  name: '✳ URIEL (node)',
  cwd: '/Users/yourname/Projects/uriel',
  claude_foreground: true,
  ...over,
});

describe('matchSessionRow — exact cwd, never fuzzy', () => {
  it('one tab in the directory is a match; trailing slashes do not split them', () => {
    const m = matchSessionRow('/Users/yourname/Projects/uriel/', [tab({})]);
    expect(m.kind).toBe('one');
  });

  it('a parent or sibling directory NEVER matches — prefix games type into the wrong being', () => {
    expect(matchSessionRow('/Users/yourname/Projects', [tab({})]).kind).toBe('none');
    expect(matchSessionRow('/Users/yourname/Projects/uriel-2', [tab({})]).kind).toBe('none');
    expect(matchSessionRow('/Users/yourname/Projects/uriel/sub', [tab({})]).kind).toBe('none');
  });

  it('a tab without a claude cwd cannot match anything', () => {
    expect(matchSessionRow('/Users/yourname/Projects/uriel', [tab({ cwd: null })]).kind).toBe('none');
  });

  it('two tabs in one directory is a true "many" — the UI says so, never silently picks', () => {
    const m = matchSessionRow('/Users/yourname/Projects/uriel', [
      tab({}),
      tab({ tty: '/dev/ttys012', name: 'second' }),
    ]);
    expect(m.kind).toBe('many');
  });

  it('a row with no cwd matches nothing', () => {
    expect(matchSessionRow(undefined, [tab({})]).kind).toBe('none');
  });
});

describe('terminals are not equal, and the UI says so', () => {
  const rs = readFileSync(new URL('../src-tauri/src/terminal.rs', import.meta.url), 'utf8');
  const src = readFileSync(new URL('../src/components/list/MySessions.tsx', import.meta.url), 'utf8');

  it('both hosts are enumerated, and asking never launches one', () => {
    // Merely listing your sessions must not open an app you had closed.
    expect(rs).toMatch(/ENUMERATE_APPLE_TERMINAL/);
    expect((rs.match(/is running then/g) || []).length).toBe(2);
    expect(rs).toMatch(/\("iTerm2", ENUMERATE_ITERM, true\)/);
    expect(rs).toMatch(/\("Terminal", ENUMERATE_APPLE_TERMINAL, false\)/);
  });

  it('one unhappy host does not blind us to the other', () => {
    expect(rs).toMatch(/errors\.push/);
    expect(rs).toMatch(/if out\.is_empty\(\) && !errors\.is_empty\(\)/);
  });

  it("Terminal.app refuses the draft in words — Buddy never presses enter", () => {
    // Its only scripting verb RUNS what it is given; there is no inert
    // placement, so the verb is refused rather than degraded into a submit.
    expect(rs).toMatch(/app\.as_deref\(\) == Some\("Terminal"\)/);
    expect(rs).toContain("won't press enter for you");
    // ...and the control is hidden there rather than offered and refused.
    // Confirmed-capable only: `!== false` was also true mid-probe (codex r2).
    expect(src).toMatch(/\{canPlaceHere && \(/);
    expect(src).toContain('can only run a line, not hold one');
  });

  it('focus is dispatched per host', () => {
    expect(rs).toMatch(/fn focus_script_apple/);
    expect(rs).toMatch(/if app == "Terminal" \{ focus_script_apple/);
  });
});

describe('the verbs render honestly (source guards)', () => {
  it('the send affordance says what it refuses, and the note channel exists', () => {
    const src = readFileSync(new URL('../src/components/list/MySessions.tsx', import.meta.url), 'utf8');
    // The row→tab match happens at the moment of use (inside the verb),
    // never cached in state at expand time.
    expect(src).toMatch(/const resolveTab = async/);
    // Rust's refusals surface verbatim — the UI never rewrites the gate.
    expect(src).toMatch(/setVerbNote\(w\.error/);
    // Ambiguity REFUSES, never picks (codex P1): enumeration order is
    // unrelated to which session a row is.
    expect(src).toContain("won't guess");
    expect(src).not.toMatch(/match\.sessions\[0\]\.tty/);
  });

  it('buddy can only PLACE — no code path submits, so no timing can execute in a shell (codex r2)', () => {
    const rs = readFileSync(new URL('../src-tauri/src/terminal.rs', import.meta.url), 'utf8');
    // The canon boundary IS the race closure: the one typing script carries
    // `newline NO`, and nothing in the module writes a submitting newline.
    expect(rs).toContain('newline NO');
    expect(rs).not.toContain('write_newline_script');
    expect(rs).not.toMatch(/write text ""/);
    expect(rs).toMatch(/pub async fn place_in_terminal_session/);
    // The foreground-claude gate still guards placement, verified inside
    // the call, and an embedded newline still refuses (it would submit).
    const place = rs.match(/fn place_text[^]{0,1600}\n\}/)?.[0] ?? '';
    expect(place).toMatch(/foreground_claude_pid\(tty\)\.is_none\(\)/);
    expect(place).toContain('a newline would submit');
    // Blocking work never runs on the UI thread (codex P2).
    expect(rs.match(/spawn_blocking/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it('the UI stages and the human submits; verbs stand down where they cannot work (codex r2)', () => {
    const src = readFileSync(new URL('../src/components/list/MySessions.tsx', import.meta.url), 'utf8');
    // Place semantics, said out loud.
    expect(src).toContain('press enter there; the turn is yours');
    // Host gate: only claude-code rows get verbs the enumerator can serve.
    expect(src).toMatch(/verbsSupported = \/claude\/i\.test\(session\.clientName/);
    expect(src).toMatch(/verbsSupported && !cwdShared && \(/);
    // Row-side ambiguity (two ROWS, one cwd) stands the verbs down, in words.
    expect(src).toContain('verbs stand');
    // Row-side ambiguity: the shared-cwd check must consult the FULL machine
    // (allCwds includes rows bound under agent cards), never just the
    // section's filtered list.
    expect(src).toMatch(/const cwdCount = \(cwd: string\) =>/);
    expect(src).toMatch(/cwdShared=\{cwdCount\(s\.cwd\) > 1\}/);
  });

  it('one card per being: the BOT.md join is labeled self-report and refuses ambiguity (buddy#33 ①)', () => {
    const src = readFileSync(new URL('../src/components/UnifiedBuddyList.tsx', import.meta.url), 'utf8');
    // The join label still says SAYS, not IS — a local file is a claim, not
    // proof. The jargon ("BOT.md, self-reported") left the face on 2026-08-14
    // because nobody outside this repo knows what a BOT.md is; the epistemics
    // survive in the verb.
    expect(src).toContain("this session says it's @");
    expect(src).not.toContain('BOT.md, self-reported');
    // A handle claimed by two sessions binds to none (coin flips under an
    // agent's name are worse than two rows).
    expect(src).toMatch(/claimCounts\.get\(slug\) === 1/);
    // Bound rows leave MY SESSIONS (they render under their agent) and the
    // section still sees every cwd for the shared-directory stand-down.
    expect(src).toMatch(/mySessions=\{unboundSessions\}/);
    expect(src).toMatch(/allCwds=\{allSessionCwds\}/);
    // The join grants nothing: no authority flows from the botfile — the
    // bound block renders presentation (MySessionRow) only.
    expect(src).not.toMatch(/boundByHandle[^]{0,200}(summon|Archive|token|credential)/i);
    // codex r1: the join derives from the UNFILTERED roster (an agent in
    // WAITING or the hero is still on screen), suspends under search so a
    // hidden agent's session cannot vanish, attaches in the WAITING lane,
    // hides the emptied section, and re-reads BOT.md on the minute tick.
    expect(src).toMatch(/users\.filter\(\(u\) => isAgent\(u\)\)/);
    expect(src).toMatch(/bindingActive = !q/);
    expect(src).toMatch(/isAgent\(sender\) && boundSessionBlock\(sender\.handle\)/);
    // The section mounts whenever the machine HAS sessions — bound rows
    // render under their agents, but the machine-wide aggregate must survive
    // a fully-bound board (codex r1 on #37). Only the row LIST is unbound.
    // The populated board now builds ONE element and places it above or
    // below the exchange by evidence (codex r1), so the mount guard lives in
    // that element rather than being repeated at each site. The quiet room
    // keeps its own copy.
    expect(src).toMatch(/const mySessionsEl = mySessions\.length > 0 \?/);
    expect((src.match(/mySessions=\{unboundSessions\}/g) || []).length).toBe(2);
    expect(src).toMatch(/\[sessionCwdKey, intelClock\]/);
  });

  it('shipped builds can actually ask for Automation consent (codex r2 P1)', () => {
    // Without the usage string + hardened-runtime entitlement, a notarized
    // build cannot even PROMPT — every verb dies -1743 and System Settings
    // has nothing to offer.
    const plist = readFileSync(new URL('../src-tauri/Info.plist', import.meta.url), 'utf8');
    expect(plist).toContain('NSAppleEventsUsageDescription');
    const ent = readFileSync(new URL('../src-tauri/entitlements.plist', import.meta.url), 'utf8');
    expect(ent).toContain('com.apple.security.automation.apple-events');
    const conf = readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8');
    expect(conf).toContain('"entitlements": "entitlements.plist"');
  });
});

// Terminal.app support, round 2. Both hosts are enumerated, but a tty alone
// does not identify a tab — Rust defaults an absent app to iTerm2, so any
// path that drops the host silently redirects Terminal.app users' clicks
// into iTerm (codex r2 P1). These pin the identifier's whole journey.
describe('the host travels with the tty (codex r2 P1)', () => {
  const src = readFileSync(new URL('../src/components/list/MySessions.tsx', import.meta.url), 'utf8');

  it('resolveTab returns the matched app, not just the tty', () => {
    expect(src).toMatch(/return \{ tty: match\.session\.tty, app: match\.session\.app \}/);
    // ...and the type makes app REQUIRED, so a future caller cannot forget.
    expect(src).toMatch(/Promise<\{ tty: string; app: string;/);
  });

  it('every focus call passes the host through', () => {
    const calls = src.match(/frontSession\([^)]*\)/g) || [];
    expect(calls.length).toBeGreaterThan(0);
    // The post-place refocus was the one that dropped it.
    for (const c of calls) expect(c).toMatch(/r\.app/);
  });

  it('draft controls appear only on a host that CONFIRMED it can hold a line', () => {
    // `host?.canPlace !== false` was true while the probe was still in
    // flight, so Terminal rows flashed a draft box that could only refuse.
    expect(src).toMatch(/const canPlaceHere = host\.kind === 'known' && host\.canPlace/);
    expect(src).toMatch(/\{canPlaceHere && \(/);
    expect(src).not.toMatch(/canPlace !== false/);
  });
});

describe('a half-blind scan says so (codex r2 P2)', () => {
  it('one host failing does not report the other host\'s tabs as the whole truth', () => {
    const rust = readFileSync(new URL('../src-tauri/src/terminal.rs', import.meta.url), 'utf8');
    expect(rust).toMatch(/pub struct TerminalScan/);
    expect(rust).toMatch(/Ok\(TerminalScan \{ sessions: out, warnings: errors \}\)/);
    const ts = readFileSync(new URL('../src/lib/terminal.ts', import.meta.url), 'utf8');
    expect(ts).toMatch(/warnings: scan\.warnings \?\? \[\]/);
    // And "no tab found" names the host it couldn't ask.
    const ui = readFileSync(new URL('../src/components/list/MySessions.tsx', import.meta.url), 'utf8');
    expect(ui).toMatch(/warnings\.length \? ` \(\$\{warnings\.join\(' · '\)\}\)` : ''/);
  });

  it('osascript failures name the app that actually failed', () => {
    const rust = readFileSync(new URL('../src-tauri/src/terminal.rs', import.meta.url), 'utf8');
    expect(rust).toMatch(/fn osascript\(script: &str, host: &str\)/);
    expect(rust).toMatch(/macOS blocked Buddy from controlling \{host\}/);
    // No hardcoded iTerm left in the shared failure paths.
    expect(rust).not.toMatch(/"iTerm didn't answer/);
  });
});

describe('the header never calls a crash "your turn" (codex r2 P2)', () => {
  it('aggregates are state-neutral; the rows say which claim is which', () => {
    // The original defect: one aggregate labeled "your turn" covering rows
    // that actually said "error recorded". The counts now live in the FOR
    // YOU zone header, whose words assert no state at all — and the
    // two-claim distinction survives where the evidence is, on the row.
    const t = readFileSync(new URL('../src/lib/transcript.ts', import.meta.url), 'utf8');
    expect(t).toMatch(/export function isYourTurn/);
    expect(t).toMatch(/export function hasRecentApiError/);
    const ui = readFileSync(new URL('../src/components/list/MySessions.tsx', import.meta.url), 'utf8');
    // No state-claiming aggregate anywhere in the section chrome...
    expect(ui).not.toMatch(/your turn · \{/);
    expect(ui).not.toMatch(/error recorded · \{/);
    // ...while the row still distinguishes a finished turn from a crash.
    expect(ui).toMatch(/'api-error-recent' \? 'error recorded' : 'your turn'/);
    const list = readFileSync(new URL('../src/components/UnifiedBuddyList.tsx', import.meta.url), 'utf8');
    expect(list).toMatch(/For you · \{filteredWaiting\.length \+ zoneSessionCount\}/);
    expect(list).not.toMatch(/your turn · \{/);
  });
});
