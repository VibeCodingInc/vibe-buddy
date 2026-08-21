import { describe, expect, it } from 'vitest';
import {
  STANDARD_APP_PATH,
  createMacOSMetadataMarkerScanner,
  createEvidenceEvent,
  evaluateG4,
  normalizeUpdaterManifest,
  parseSleepWakePairs,
  prohibitedMacOSMetadataEntries,
  qualifyingSleepWakePairs,
  summarizeEvidenceRun,
  verifyEvidenceChain,
} from '../scripts/lib/update-gauntlet-core.mjs';

function successfulRun(overrides: Record<string, unknown> = {}) {
  return {
    runId: crypto.randomUUID(),
    machine: 'clean-mac-a',
    machineFingerprint: 'hardware-a',
    scenario: 'immediate',
    sourceVersion: '0.5.33',
    targetVersion: '0.5.34',
    cleanEnvironment: true,
    appPath: STANDARD_APP_PATH,
    passed: true,
    evidenceValid: true,
    ...overrides,
  };
}

describe('update delivery gauntlet', () => {
  it('the production platform-scoped updater manifest cannot be rejected as malformed', () => {
    expect(normalizeUpdaterManifest({
      version: '0.5.37',
      notes: 'release notes',
      pub_date: '2026-07-31T20:16:00Z',
      platforms: {
        'darwin-aarch64': {
          signature: 'signed-bytes',
          url: 'https://example.test/Vibe_Buddy_0.5.37_aarch64.app.tar.gz',
        },
      },
    })).toEqual({
      version: '0.5.37',
      notes: 'release notes',
      pubDate: '2026-07-31T20:16:00Z',
      signature: 'signed-bytes',
      url: 'https://example.test/Vibe_Buddy_0.5.37_aarch64.app.tar.gz',
    });
  });

  it('a signed updater archive carrying macOS xattrs cannot enter the delivery gauntlet', () => {
    const scanner = createMacOSMetadataMarkerScanner();
    scanner.push(Buffer.from('42 SCHILY.xa'));
    scanner.push(Buffer.from('ttr.com.apple.provenance=data'));

    expect(scanner.findings()).toEqual(['SCHILY.xattr']);
  });

  it('an AppleDouble sidecar cannot hide behind an otherwise clean updater archive', () => {
    expect(prohibitedMacOSMetadataEntries([
      'Vibe Buddy.app/Contents/MacOS/vibe-buddy',
      '._Vibe Buddy.app',
      'Vibe Buddy.app/Contents/Resources/.DS_Store',
    ])).toEqual([
      '._Vibe Buddy.app',
      'Vibe Buddy.app/Contents/Resources/.DS_Store',
    ]);
  });

  it('one successful update on one Mac cannot turn G4 green', () => {
    const result = evaluateG4([successfulRun()]);

    expect(result.green).toBe(false);
    expect(result.reasons).toContain('fewer than two clean Macs have qualifying successful runs');
  });

  it('two Macs on one release cannot turn G4 green', () => {
    const result = evaluateG4([
      successfulRun(),
      successfulRun({ machine: 'clean-mac-b', machineFingerprint: 'hardware-b', scenario: 'delayed-wake' }),
    ]);

    expect(result.green).toBe(false);
    expect(result.reasons).toContain('fewer than two qualifying release transitions have passed');
  });

  it('two releases without a delayed wake cannot turn G4 green', () => {
    const result = evaluateG4([
      successfulRun(),
      successfulRun({ machine: 'clean-mac-b', machineFingerprint: 'hardware-b' }),
      successfulRun({ sourceVersion: '0.5.34', targetVersion: '0.5.35' }),
      successfulRun({ machine: 'clean-mac-b', machineFingerprint: 'hardware-b', sourceVersion: '0.5.34', targetVersion: '0.5.35' }),
    ]);

    expect(result.green).toBe(false);
    expect(result.reasons).toContain('at least one transition lacks immediate or delayed-wake evidence');
  });

  it('failed update evidence cannot count as delivery', () => {
    const result = evaluateG4([
      successfulRun({ passed: false }),
      successfulRun({ machine: 'clean-mac-b', machineFingerprint: 'hardware-b', scenario: 'delayed-wake' }),
      successfulRun({ sourceVersion: '0.5.34', targetVersion: '0.5.35' }),
      successfulRun({ machine: 'clean-mac-b', machineFingerprint: 'hardware-b', sourceVersion: '0.5.34', targetVersion: '0.5.35', scenario: 'delayed-wake' }),
    ]);

    expect(result.green).toBe(false);
    expect(result.reasons).toContain('failed or incomplete runs never count as delivery');
  });

  it('different Macs covering each release cannot impersonate the same two-Mac matrix', () => {
    const result = evaluateG4([
      successfulRun(),
      successfulRun({ machine: 'clean-mac-b', machineFingerprint: 'hardware-b', scenario: 'delayed-wake' }),
      successfulRun({ machine: 'clean-mac-c', machineFingerprint: 'hardware-c', sourceVersion: '0.5.34', targetVersion: '0.5.35' }),
      successfulRun({ machine: 'clean-mac-d', machineFingerprint: 'hardware-d', sourceVersion: '0.5.34', targetVersion: '0.5.35', scenario: 'delayed-wake' }),
    ]);

    expect(result.green).toBe(false);
    expect(result.reasons).toContain('no two consecutive release transitions have a complete common two-Mac matrix');
  });

  it('one physical Mac under two labels cannot count as two clean Macs', () => {
    const result = evaluateG4([
      successfulRun(),
      successfulRun({ machine: 'alias-for-a', scenario: 'delayed-wake' }),
      successfulRun({ sourceVersion: '0.5.34', targetVersion: '0.5.35', scenario: 'delayed-wake' }),
      successfulRun({ machine: 'alias-for-a', sourceVersion: '0.5.34', targetVersion: '0.5.35' }),
    ]);

    expect(result.green).toBe(false);
    expect(result.reasons).toContain('a hardware fingerprint was reused under inconsistent machine labels');
  });

  it('an edited evidence event breaks the hash chain', () => {
    const start = createEvidenceEvent({
      runId: 'run-1',
      type: 'start',
      payload: { sourceVersion: '0.5.33' },
      at: '2026-07-31T12:00:00.000Z',
    });
    const finish = createEvidenceEvent({
      runId: 'run-1',
      type: 'finish',
      payload: { passed: true },
      previous: start,
      at: '2026-07-31T12:05:00.000Z',
    });

    expect(() => verifyEvidenceChain([start, { ...finish, payload: { passed: false } }])).toThrow(
      'evidence hash mismatch',
    );
  });

  it('an omitted optional field does not break its own evidence after JSON persistence', () => {
    const event = createEvidenceEvent({
      runId: 'run-optional',
      type: 'start',
      payload: { known: true, absent: undefined },
      at: '2026-07-31T12:00:00.000Z',
    });
    const persisted = JSON.parse(JSON.stringify(event));

    expect(() => verifyEvidenceChain([persisted])).not.toThrow();
  });

  it('a forged passing finish without continuity checks cannot count as delivery', () => {
    const start = createEvidenceEvent({
      runId: 'run-1',
      type: 'start',
      payload: {
        machine: 'clean-mac-a',
        scenario: 'immediate',
        cleanEnvironment: true,
        offerVisible: true,
        before: {
          machineFingerprint: 'hardware-a',
          app: { appPath: STANDARD_APP_PATH, version: '0.5.33' },
        },
        manifest: { version: '0.5.34' },
        artifact: { metadata: { clean: true }, bundle: { version: '0.5.34' } },
      },
      at: '2026-07-31T12:00:00.000Z',
    });
    const finish = createEvidenceEvent({
      runId: 'run-1',
      type: 'finish',
      payload: { passed: true, checks: {} },
      previous: start,
      at: '2026-07-31T12:05:00.000Z',
    });

    expect(() => summarizeEvidenceRun([start, finish])).toThrow('passing finish omitted checks');
  });

  it('old evidence without a macOS metadata inspection cannot count as delivery', () => {
    const start = createEvidenceEvent({
      runId: 'run-without-metadata-proof',
      type: 'start',
      payload: {
        machine: 'clean-mac-a',
        scenario: 'immediate',
        cleanEnvironment: true,
        offerVisible: true,
        before: {
          machineFingerprint: 'hardware-a',
          app: { appPath: STANDARD_APP_PATH, version: '0.5.33' },
        },
        manifest: { version: '0.5.34' },
        artifact: { bundle: { version: '0.5.34' } },
      },
      at: '2026-07-31T12:00:00.000Z',
    });

    expect(() => summarizeEvidenceRun([start])).toThrow('artifact lacks a passing macOS metadata inspection');
  });

  it('a lid close without a full two-minute sleep cannot satisfy delayed wake', () => {
    const pairs = parseSleepWakePairs([
      "2026-07-31 12:00:00 -0700 Sleep Entering Sleep state due to 'Clamshell Sleep'",
      '2026-07-31 12:01:10 -0700 Wake Wake from Normal Sleep',
    ].join('\n'));

    expect(pairs).toHaveLength(1);
    expect(pairs[0].durationSeconds).toBe(70);
    expect(pairs[0].durationSeconds).toBeLessThan(120);
  });

  it('clicking before the wake-triggered check can settle cannot satisfy delayed wake', () => {
    const pairs = parseSleepWakePairs([
      "2026-07-31 12:00:00 -0700 Sleep Entering Sleep state due to 'Clamshell Sleep'",
      '2026-07-31 12:03:00 -0700 Wake Wake from Normal Sleep',
    ].join('\n'));

    expect(qualifyingSleepWakePairs(pairs, {
      startedAt: '2026-07-31T18:59:00.000Z',
      observedAt: '2026-07-31T19:03:20.000Z',
    })).toHaveLength(0);
    expect(qualifyingSleepWakePairs(pairs, {
      startedAt: '2026-07-31T18:59:00.000Z',
      observedAt: '2026-07-31T19:03:31.000Z',
    })).toHaveLength(1);
  });

  it('two clean Macs across two consecutive releases satisfy G4', () => {
    const result = evaluateG4([
      successfulRun(),
      successfulRun({ machine: 'clean-mac-b', machineFingerprint: 'hardware-b', scenario: 'delayed-wake' }),
      successfulRun({ sourceVersion: '0.5.34', targetVersion: '0.5.35', scenario: 'delayed-wake' }),
      successfulRun({ machine: 'clean-mac-b', machineFingerprint: 'hardware-b', sourceVersion: '0.5.34', targetVersion: '0.5.35' }),
    ]);

    expect(result.green).toBe(true);
    expect(result.matrix.machines).toEqual(['clean-mac-a', 'clean-mac-b']);
    expect(result.matrix.transitions).toEqual(['0.5.33->0.5.34', '0.5.34->0.5.35']);
  });
});
