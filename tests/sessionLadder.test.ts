import { describe, expect, it } from 'vitest';
import {
  configuredRung,
  DRIVING_RUNG,
  heartbeatingRung,
  seatedRung,
  sessionLadder,
} from '../src/lib/sessionLadder';
import { GREEN_FRESH_MS } from '../src/lib/freshness';

// The ladder's law: four separately-evidenced rungs, never collapsed. These
// tests pin the honesty edges — the states that would be easiest to blur.

describe('configuredRung — ① the receipt is the evidence', () => {
  it('is verified fact under a succeeding read, naming the client', () => {
    expect(configuredRung('known', 'claude-code', 0)).toEqual({
      state: 'yes',
      evidence: '/vibe heartbeats from claude-code',
    });
  });

  it('falls back to "this session" when the receipt named no client', () => {
    expect(configuredRung('known', undefined, 0).evidence).toBe('/vibe heartbeats from this session');
  });

  it('degrades to unknown-with-age while the latest read fails — the fact is dated, not current', () => {
    const r = configuredRung('unchecked', 'codex', 120_000);
    expect(r.state).toBe('unknown');
    expect(r.evidence).toBe('last confirmed 2m ago');
  });

  it('never claims configuration it cannot date', () => {
    expect(configuredRung('unchecked', 'codex', undefined)).toEqual({
      state: 'unknown',
      evidence: "can't confirm right now",
    });
  });
});

describe('heartbeatingRung — ② the only rung that may go green', () => {
  it('is live under a fresh heartbeat and a succeeding read', () => {
    expect(heartbeatingRung('known', 8_000)).toEqual({ state: 'live', evidence: 'last seen 8s ago' });
  });

  it('goes honestly quiet — not unknown — when the heartbeat ages out', () => {
    const r = heartbeatingRung('known', GREEN_FRESH_MS + 60_000);
    expect(r.state).toBe('no');
    expect(r.evidence).toMatch(/^gone quiet/);
  });

  it('a failing read is unknown even when the retained age would still be fresh', () => {
    // The overclaim this rung exists to prevent: green from a snapshot.
    const r = heartbeatingRung('unchecked', 8_000);
    expect(r.state).toBe('unknown');
    expect(r.evidence).toBe("can't see — last known 8s ago");
  });
});

describe('seatedRung — ③ nothing earns live until Meet participant evidence exists', () => {
  it('closed is a no, unknown is not-closed, and the copy keeps them apart', () => {
    expect(seatedRung({ kind: 'closed' })).toEqual({ state: 'no', evidence: "seat app isn't running" });
    expect(seatedRung({ kind: 'unknown' })).toEqual({ state: 'unknown', evidence: "couldn't ask the seat app" });
  });

  it('a running app with an unreadable call state degrades to unknown, never a guess', () => {
    // The defensive posture for the seat API shape changing under us
    // (a vibeconf-app contract note): absent fields read as cannot-see.
    const r = seatedRung({ kind: 'running' });
    expect(r.state).toBe('unknown');
  });

  it('idle is a truthful no; in-call is an assertion, rendered as one', () => {
    // Audit #10: 'in-call' is the seat app's self-report about its own
    // machinery, not evidence of Meet admission (field: 7 accepts, 0 seats).
    // Green would be a claim we cannot back; the honest render names the
    // reporter and what stays unverified.
    expect(seatedRung({ kind: 'idle' }).state).toBe('no');
    expect(seatedRung({ kind: 'in-call', room: 'jmp-bpnt-mht' })).toEqual({
      state: 'unknown',
      evidence: 'admission unverified — seat app reports in jmp-bpnt-mht',
    });
  });

  it('joining is not seated: an entering seat stays a truthful no until in-call', () => {
    expect(seatedRung({ kind: 'joining', room: 'abc-defg-hij' })).toEqual({
      state: 'no',
      evidence: 'seat is joining abc-defg-hij…',
    });
    expect(seatedRung({ kind: 'joining' }).evidence).toBe('seat is joining a room…');
  });
});

describe('driving — ④ the honest gap', () => {
  it('is a constant unknown until a claim primitive exists', () => {
    expect(DRIVING_RUNG.state).toBe('unknown');
    expect(DRIVING_RUNG.evidence).toMatch(/nothing proves which session drives/);
  });
});

describe('sessionLadder — the rungs never borrow from each other', () => {
  it('a reported call does not launder rungs ③/④: both stay unknown', () => {
    const ladder = sessionLadder({
      probe: 'known',
      clientName: 'claude-code',
      snapshotAgeMs: 0,
      effectiveAgeMs: 5_000,
      seat: { kind: 'in-call', room: 'abc-defg-hij' },
    });
    expect(ladder.seated.state).toBe('unknown');
    expect(ladder.driving.state).toBe('unknown');
  });

  it('a dead session in front of a reporting seat: ② no, ③ unknown — separately true', () => {
    const ladder = sessionLadder({
      probe: 'known',
      effectiveAgeMs: GREEN_FRESH_MS * 3,
      seat: { kind: 'in-call', room: 'abc-defg-hij' },
    });
    expect(ladder.heartbeating.state).toBe('no');
    expect(ladder.seated.state).toBe('unknown');
    expect(ladder.seated.evidence).toBe('admission unverified — seat app reports in abc-defg-hij');
  });
});
