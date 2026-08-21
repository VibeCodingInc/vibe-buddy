// Blocked-session hints — the copy layer and the noise discipline.
//
// The classification laws live in Rust with their own fixtures
// (src-tauri/src/transcript.rs). What TS owns is which states are allowed to
// interrupt the operator, and the words used about them — and the words are
// the feature: every line must state evidence, never a diagnosis.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { signalLine, wantsYou, transcriptJoinable, byAttention, type SessionSignal } from '../src/lib/transcript';

describe('what may interrupt the operator', () => {
  it('only the two evidence-backed states want you — everything else stays quiet', () => {
    // A queue full of maybes recreates the attention loss the feature exists
    // to end (the codex challenge's condition on approving item ①).
    expect(wantsYou({ kind: 'awaiting-you', idle_seconds: 60 })).toBe(true);
    expect(wantsYou({ kind: 'api-error-recent', idle_seconds: 60 })).toBe(true);
    // A dangling tool call is genuinely ambiguous — it shows in the expanded
    // row, but it does not tap the operator on the shoulder.
    expect(wantsYou({ kind: 'tool-no-result', tool: 'Bash', idle_seconds: 60 })).toBe(false);
    expect(wantsYou({ kind: 'working', idle_seconds: 5 })).toBe(false);
    expect(wantsYou({ kind: 'quiet', idle_seconds: 9_000 })).toBe(false);
    expect(wantsYou({ kind: 'unknown', why: 'no transcript' })).toBe(false);
    expect(wantsYou(undefined)).toBe(false);
  });
});

describe('the cwd join refuses where it could point at the wrong runtime (codex r1 P1)', () => {
  it('only a Claude host in an unshared directory may be joined', () => {
    expect(transcriptJoinable({ clientName: 'claude-code', cwdShared: false })).toBe(true);
    // A codex/cursor row's directory can still hold a HISTORICAL Claude
    // transcript — joining it would show another runtime's state as this
    // row's.
    expect(transcriptJoinable({ clientName: 'codex', cwdShared: false })).toBe(false);
    expect(transcriptJoinable({ clientName: undefined, cwdShared: false })).toBe(false);
    // Two rows, one directory: cwd cannot tell them apart, so neither reads.
    expect(transcriptJoinable({ clientName: 'claude-code', cwdShared: true })).toBe(false);
  });

  it('the row and the section apply the same refusal', () => {
    const src = readFileSync(new URL('../src/components/list/MySessions.tsx', import.meta.url), 'utf8');
    // The section's bulk read applies the refusal via readSignals(), and the
    // row applies it again for the bound case it fetches itself.
    // The board reads signals ONCE at the list level, applying the refusal
    // there; the row applies it again only for the case it fetches itself.
    // Detection moved to App (always mounted) so alerts survive view changes;
    // the refusal moved with it.
    const appSrc = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    expect(appSrc).toMatch(/readSignals\(rows\)/);
    expect(appSrc).toMatch(/transcriptJoinable\(/);
    expect(src).toMatch(/transcriptJoinable\(/);
    expect(src).toMatch(/if \(!canJoinTranscript\)/);
  });
});

describe('the collapsed section still surfaces what wants you (codex r1 P1)', () => {
  it('the header counts wants-you rows without any row mounting', () => {
    // With 2+ sessions the section starts COLLAPSED and mounts no rows — a
    // row-local read could never surface anything in the many-session case
    // the feature exists for.
    const src = readFileSync(new URL('../src/components/list/MySessions.tsx', import.meta.url), 'utf8');
    // The wants-you rows themselves ALWAYS mount (the `top` set renders
    // above the fold line, collapsed or not), and the machine-wide count
    // moved up to the board's FOR YOU zone header (buddy#49 decision 2).
    const list = readFileSync(new URL('../src/components/UnifiedBuddyList.tsx', import.meta.url), 'utf8');
    expect(list).toMatch(/const wantingUnbound = unboundSessions\.filter\(\(s\) => wantsYou\(signals\.get\(s\.cwd\)\)\)\.length/);
    expect(list).toMatch(/For you · \{filteredWaiting\.length \+ zoneSessionCount\}/);
    // Turn-taking, not obligation — no "wants you" wording anywhere.
    expect(src).not.toMatch(/wants? you'/);
    expect(list).not.toMatch(/wants? you'/);
    // The machine-wide set (rows bound under agent cards included) still
    // feeds the section's own accounting — found live: the header said
    // "1 wants you" while a bound Pepper card wanted him too.
    expect(src).toMatch(/attentionSessions \?\? mySessions/);
    // Rows are ordered by what needs you.
    expect(src).toMatch(/const ordered = byAttention\(/);
    // Attention rows reach the DOM first, before the fold line, always —
    // and both halves live in ONE keyed children array, so a row crossing
    // the fold MOVES instead of remounting (codex r1 P1 on #50).
    expect(src).toMatch(/\.\.\.top\.map\(renderRow\)/);
    expect(src).toMatch(/\.\.\.below\.map\(renderRow\)/);
    // No singleton special-case above the line: a quiet single session
    // renders BELOW the section boundary (always visible, never inside the
    // zone as an uncounted row — codex r3 P2 on #50).
    expect(src).toMatch(/expanded \|\| mySessions\.length === 1/);
    // And it survives a fully-bound board: the header renders (and counts)
    // even when every session is shown under an agent card, where there are
    // zero unbound rows to mount (codex r1 on #37).
    expect(src).toMatch(/mySessions\.length > 1 \|\| mySessions\.length < all\.length/);
    expect(src).toContain('all shown with their agents');
    // ONE map: bound rows are fed from it too, never a second poll.
    const listSrc2 = readFileSync(new URL('../src/components/UnifiedBuddyList.tsx', import.meta.url), 'utf8');
    expect(listSrc2).toMatch(/knownSignal=\{signals\.get\(bound\.cwd\)\}/);
    expect(listSrc2).toMatch(/mySessions\.length > 0 && \(\n\s*<MySessionsSection/);
  });
});

describe('the router puts what needs you first', () => {
  const row = (id: string, agoMs: number, s?: SessionSignal) => ({ id, agoMs, s });
  const sort = (rows: ReturnType<typeof row>[]) =>
    byAttention(rows, (r) => r.s, (r) => r.agoMs).map((r) => r.id);

  it('wants-you rows lead, no matter how stale, and recency orders within a tier', () => {
    const rows = [
      row('fresh-working', 1_000, { kind: 'working', idle_seconds: 1 }),
      row('old-waiting', 900_000, { kind: 'awaiting-you', idle_seconds: 900 }),
      row('mid-quiet', 60_000, { kind: 'quiet', idle_seconds: 60 }),
      row('new-error', 5_000, { kind: 'api-error-recent', idle_seconds: 5 }),
    ];
    expect(sort(rows)).toEqual(['new-error', 'old-waiting', 'fresh-working', 'mid-quiet']);
  });

  it('only two tiers — ambiguous states do not get a rank of their own', () => {
    // Finer ranking would encode confidence this module does not have, and
    // would make the order jitter as ambiguous states flicker.
    const rows = [
      row('quiet', 30_000, { kind: 'quiet', idle_seconds: 30 }),
      row('dangling', 40_000, { kind: 'tool-no-result', tool: 'Bash', idle_seconds: 40 }),
      row('unknown', 20_000, { kind: 'unknown', why: 'no transcript' }),
      row('none', 10_000, undefined),
    ];
    expect(sort(rows)).toEqual(['none', 'unknown', 'quiet', 'dangling']);
  });

  it('is a stable pure sort — it never mutates the caller\'s list', () => {
    const rows = [row('a', 10, { kind: 'quiet', idle_seconds: 1 }), row('b', 5)];
    const before = rows.map((r) => r.id);
    sort(rows);
    expect(rows.map((r) => r.id)).toEqual(before);
  });
});

describe('the copy states evidence, never a diagnosis', () => {
  const lines = (
    [
      { kind: 'awaiting-you', idle_seconds: 300 },
      { kind: 'tool-no-result', tool: 'Bash', idle_seconds: 200 },
      { kind: 'api-error-recent', idle_seconds: 45 },
      { kind: 'quiet', idle_seconds: 3600 },
      { kind: 'unknown', why: 'no transcript for this directory' },
    ] as SessionSignal[]
  ).map((s) => signalLine(s) ?? '');

  it('never names a cause the transcript cannot show', () => {
    const banned = [
      /permission prompt/i,
      /\bstalled\b/i,
      /rate.?limit/i,
      /login loop/i,
      /\bcrashed\b/i,
      /\bdied\b/i,
    ];
    for (const line of lines) {
      for (const bad of banned) {
        expect(line, `"${line}" claims a cause it cannot see`).not.toMatch(bad);
      }
    }
  });

  it('the dangling-tool line offers the alternatives instead of picking one', () => {
    const line = signalLine({ kind: 'tool-no-result', tool: 'Bash', idle_seconds: 200 })!;
    expect(line).toContain('no recorded result');
    expect(line).toMatch(/could be/);
    expect(line).toContain('Bash');
  });

  it('claims are folder-scoped while no device identity exists (codex r3 P1)', () => {
    // /api/my-sessions carries no device field, so a row from another Mac
    // with a matching path cannot be distinguished from the local session.
    // What is verified is the FOLDER, so that is what the sentence claims.
    for (const s of [
      { kind: 'awaiting-you', idle_seconds: 60 },
      { kind: 'tool-no-result', tool: 'Bash', idle_seconds: 60 },
      { kind: 'api-error-recent', idle_seconds: 60 },
    ] as SessionSignal[]) {
      expect(signalLine(s)).toMatch(/in this folder/);
    }
    // ...and never claims the row's own session by name.
    expect(signalLine({ kind: 'awaiting-you', idle_seconds: 60 })).not.toMatch(/this session/);
  });

  it('unknown says which nothing it is', () => {
    const line = signalLine({ kind: 'unknown', why: 'no transcript for this directory' })!;
    expect(line).toContain("can't read");
    expect(line).toContain('no transcript for this directory');
  });

  it('working renders no second line — the heartbeat already says it', () => {
    expect(signalLine({ kind: 'working', idle_seconds: 4 })).toBeNull();
  });
});

describe('the Rust boundary keeps transcripts local (source guards)', () => {
  const rs = readFileSync(new URL('../src-tauri/src/transcript.rs', import.meta.url), 'utf8');

  it('classification is version-gated and structural — never text-matched', () => {
    // Law 2: in this operator's own transcripts, prose about rate limits
    // outnumbers real API errors ~33:1, so a text scan is a false-positive
    // machine. Only the structural flag counts.
    expect(rs).toContain('isApiErrorMessage');
    expect(rs).not.toMatch(/contains\("rate limit"\)|contains\("429"\)|contains\("\/login"\)/);
    expect(rs).toMatch(/fn version_supported/);
    // The gate is the SHAPE, not a patch number: a fixed ceiling failed both
    // ways — too generous it classifies a changed format, pinned to the
    // corpus it switched the feature off for the current release (codex r1
    // then r2). The family bump still degrades; the vocabulary is checked
    // directly.
    expect(rs).toMatch(/fn shape_recognized/);
    expect(rs).not.toMatch(/KNOWN_PATCH_(MIN|MAX)/);
    expect(rs).toMatch(/KNOWN_MAJOR_MINOR/);
  });

  it('the exported shape carries no conversation content', () => {
    // The struct is the privacy boundary: state, ages, a tool NAME, a
    // correlation id — nothing that could carry prompt or output text.
    const struct = rs.match(/pub struct TranscriptRead \{[^]*?\n\}/)?.[0] ?? '';
    expect(struct).toBeTruthy();
    for (const leak of ['text', 'body', 'content', 'input', 'output', 'path']) {
      expect(struct.toLowerCase(), `TranscriptRead must not expose ${leak}`).not.toContain(`${leak}:`);
    }
  });

  it('a transcript is attributed only to a LIVE, unambiguous session (codex r2 P1)', () => {
    // "Newest file in the folder" can name a session that CLOSED while an
    // older one keeps running. Claude does not hold its transcript open, so
    // the join is process AGE: candidates are transcripts touched since the
    // live process booted, and anything but exactly one refuses.
    expect(rs).toMatch(/fn live_claudes/);
    expect(rs).toContain('no live Claude session in this directory');
    expect(rs).toContain("can't tell their transcripts apart");
    expect(rs).toContain("can't tell which is its own");
    expect(rs).toMatch(/if t >= started/);
  });

  it('the tail read walks backward instead of pulling megabytes per poll (codex r2 P2)', () => {
    expect(rs).toMatch(/TAIL_CHUNK/);
    expect(rs).toMatch(/newlines > TAIL_RECORDS \|\| start == floor/);
  });

  it('the cwd join is verified from inside the records, not the folder name', () => {
    // The encoded directory name is lossy (every non-alphanumeric becomes
    // '-'), so two real paths can collide on it.
    expect(rs).toMatch(/claims_cwd/);
    expect(rs).toContain('belongs to a different directory');
  });

  it('reading happens off the UI thread', () => {
    expect(rs).toMatch(/pub async fn transcript_signal/);
    expect(rs).toContain('spawn_blocking');
  });
});

describe('the row renders the signal honestly', () => {
  const src = readFileSync(new URL('../src/components/list/MySessions.tsx', import.meta.url), 'utf8');

  it('only wants-you states mark the collapsed row', () => {
    expect(src).toMatch(/signalWantsYou && \(/);
    expect(src).toMatch(/wantsYou\(signal\)/);
  });

  it('the evidence line renders from the shared copy definition', () => {
    expect(src).toMatch(/signalLine\(signal\)/);
    // No locally-invented state words in the row.
    expect(src).not.toMatch(/'permission prompt'|"permission prompt"/);
  });
});

// Collapsed is not hidden. At sixteen sessions the section auto-folds, and
// the header said "your turn · 2" with zero rows mounted — the count at the
// top, the answer behind a triangle. Found live on the 0.5.58 board.
describe('the fold applies to quiet sessions only', () => {
  const src = readFileSync(new URL('../src/components/list/MySessions.tsx', import.meta.url), 'utf8');

  it('a collapsed section still renders everything that wants you', () => {
    // The zone's session rows are evidence-only; pins keep a held row
    // visible BELOW the boundary line while collapsed (codex r5 P2 on #50).
    expect(src).toMatch(/const top = ordered\.filter\(\(s\) => wantsYou\(signalFor\(s\.cwd\)\)\)/);
    expect(src).toMatch(/!topIds\.has\(s\.sessionId\) && pinned\.has\(s\.sessionId\)/);
    // A row you opened is pinned, so a vanishing signal cannot unmount it
    // mid-draft (codex r3 P2).
    expect(src).toMatch(/onOpenChange=\{\(open\) => setPin\(s\.sessionId, open\)\}/);
    // Closing releases the pin, or interacted rows accumulate for the life
    // of the mount and the collapsed view stops folding (codex r8 P2).
    expect(src).toMatch(/onOpenChange\?\.\(expanded\)/);
    // Attention/pinned rows mount always (`top`); the remainder mounts only
    // when expanded (`below`) — collapsed keeps the attention rows.
    expect(src).toMatch(/const below = expanded \|\| mySessions\.length === 1\n\s*\? ordered\.filter\(\(s\) => !topIds\.has\(s\.sessionId\)\)\n\s*: ordered\.filter\(\(s\) => !topIds\.has\(s\.sessionId\) && pinned\.has\(s\.sessionId\)\)/);
  });

  it('the fold line counts only what it actually hides', () => {
    expect(src).toMatch(/const foldedCount = ordered\.length - top\.length - below\.length/);
    expect(src).toMatch(/\{foldedCount\} more/);
    // The fold must not call the pile 'quiet' — it holds working/unknown too.
    expect(src).not.toMatch(/more, quiet/);
    // ...and it renders only when rows are shown above it — with nothing
    // shown, the section total IS the account, said once.
    expect(src).toMatch(/\{!expanded && foldedCount > 0 && top\.length \+ below\.length > 0 && \(/);
  });

  it('attention rendered under an agent card is pointed AT, never counted as missing', () => {
    // The header counts machine-wide; this list holds unbound rows only. A
    // bare "2 more" would point at nothing when the second one lives under
    // its agent's card, so the difference is named and located.
    // EVERY session not in this list, not only the ones asking for you:
    // "19" above two rows and "15 more" left 2 unaccounted for.
    expect(src).toMatch(/const onAgentCards = Math\.max\(0, all\.length - mySessions\.length\)/);
    expect(src).toMatch(/on an agent card/);
    // Its own line in EVERY view: as a suffix it disappeared whenever
    // nothing was folded, and it was swallowed by the fold's aria-label
    // (codex r4 P2 x2).
    expect(src).toMatch(/\{onAgentCards > 0 && \(/);
    expect(src).not.toMatch(/attentionOnAgentCards/);
    expect(src).not.toMatch(/on agent cards`\}/);
    // Codex r2: no direction (the hero renders above), no possessive
    // identity (BOT.md self-declares), no state word (turns AND errors).
    expect(src).toMatch(/on an agent card/);
    expect(src).not.toMatch(/agents below/);
    expect(src).not.toMatch(/sessions want'\} you, shown/);
  });

  it('the most-recent project is labeled, and yields to the rows', () => {
    // "· agent" beside "· your turn · 2" read as a third count; it is a
    // folder name. And once peek rows are up, it is noise.
    expect(src).toMatch(/· last active: \{sessionsSummary\(all\)\}/);
    expect(src).toMatch(/!expanded && top\.length === 0 && all\.length > 0/);
  });
});

describe('the paired hero renders its bound session too (codex r1 P2 on #42)', () => {
  it('both agent lanes — AGENTS and WAITING — call boundSessionBlock', () => {
    // A session bound to your PAIRED agent leaves MY SESSIONS like any bound
    // row, but the hero card never rendered it — so a session that wanted
    // you existed in the header count and nowhere on screen.
    const src = readFileSync(new URL('../src/components/UnifiedBuddyList.tsx', import.meta.url), 'utf8');
    // The hero card is gone (ruthless pass 2026-08-15), so there are two
    // lanes now, not three — and no bespoke third path to keep in sync.
    expect(src).not.toMatch(/showHero|PairedHeroCard/);
    // Wherever an agent card can render, its body renders under it, so
    // "shown with their agents" is true in every lane: the definition,
    // WAITING, the FOR YOU promotion (a bound body that wants you with a
    // quiet inbox — codex r2 P2 on #50), and the AGENTS lane.
    expect((src.match(/boundSessionBlock\(/g) || []).length).toBe(3);
  });
});

describe('a bound session is keyed by runtime (codex r8 P1)', () => {
  it("replacing an agent's session does not carry the old one's row state", () => {
    // A ends, B starts and claims the same handle via BOT.md. Unkeyed, the
    // subtree held its position and MySessionRow kept A's expanded state and
    // DRAFT — so a line written for A could be staged into B's terminal,
    // which is the cross-session mistake the verbs' matching rules exist to
    // prevent, arriving through React instead.
    const src = readFileSync(new URL('../src/components/UnifiedBuddyList.tsx', import.meta.url), 'utf8');
    expect(src).toMatch(/<div key=\{bound\.sessionId\}/);
  });
});

describe('one action, one name (ROOM TONE)', () => {
  it('the row shortcut and the panel button are both "Open Session"', () => {
    // A bare "Open" on a row that itself opens details is ambiguous about
    // which thing opens, and renames an established action mid-surface.
    const src = readFileSync(new URL('../src/components/list/MySessions.tsx', import.meta.url), 'utf8');
    // Both render sites: the collapsed row shortcut and the detail panel.
    expect((src.match(/^\s*Open Session\s*$/gm) || []).length).toBe(2);
    // And no bare "Open" label anywhere.
    expect(src).not.toMatch(/^\s*Open\s*$/m);
  });
});
