// Auto-updater — uses tauri-plugin-updater for seamless in-place updates
// Version 0.4.2

import { getVersion } from '@tauri-apps/api/app';
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

const CHECK_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const UPDATE_FAILURE_KEY = 'buddy_last_update_failure';
const UPDATE_CHECK_KEY = 'buddy_last_update_check';

/**
 * How long a successful check stays meaningful.
 *
 * The automatic check runs every 6 hours, so anything past ~26h means several
 * checks in a row did not happen or did not complete — not a blip.
 */
export const CHECK_STALE_AFTER_MS = 26 * 60 * 60 * 1000;

export interface UpdateInfo {
  available: boolean;
  version?: string;
  notes?: string;
  /** The version currently running — so a manual check can name it. */
  currentVersion?: string;
  /**
   * The check could not be completed (offline, endpoint down).
   *
   * Distinct from `available: false`, which means we successfully asked and the
   * answer was no. Collapsing the two made an offline manual check report "you
   * are on the latest version" — a confident claim built on having learned
   * nothing, which is exactly the lie this app keeps having to stop telling.
   */
  error?: boolean;
}

export type InstallPhase = 'checking' | 'downloading' | 'installing' | 'relaunching';

/**
 * One bounded, durable account of the last failed install. A user should be
 * able to send this without finding Console.app or reproducing a timing race.
 */
export interface UpdateFailureEvidence {
  id: string;
  at: string;
  phase: InstallPhase;
  currentVersion?: string;
  targetVersion?: string;
  error: string;
}

export class UpdateInstallError extends Error {
  readonly evidence: UpdateFailureEvidence;

  constructor(evidence: UpdateFailureEvidence) {
    super(evidence.error);
    this.name = 'UpdateInstallError';
    this.evidence = evidence;
  }
}

const installPhases = new Set<InstallPhase>([
  'checking',
  'downloading',
  'installing',
  'relaunching',
]);

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
    try {
      return JSON.stringify(error);
    } catch { /* fall through */ }
  }
  return String(error || 'unknown updater error');
}

/**
 * The last time we successfully ASKED, and what the answer was.
 *
 * Buddy recorded install failures and nothing else, so a Buddy that never
 * checked was indistinguishable from a Buddy that checked and was current. Both
 * rendered as silence. That is not hypothetical: this app sat on 0.5.37 through
 * three releases because it was not running to ask, and nothing on screen could
 * have told anyone.
 *
 * It matters most in exactly the condition this surface exists for — when no
 * coding session is running, Buddy is the only thing that can notice, and an
 * unverified "you're up to date" is the one claim it must not make.
 */
export interface UpdateCheckRecord {
  /** ISO timestamp of the completed check. */
  at: string;
  /** What we learned. `error` means we could not ask — NOT that we are current. */
  outcome: 'current' | 'available' | 'error';
  /** The version running when we asked. */
  currentVersion?: string;
}

export function recordUpdateCheck(record: UpdateCheckRecord): void {
  try {
    localStorage.setItem(UPDATE_CHECK_KEY, JSON.stringify(record));
  } catch { /* the check still happened; losing the note must not fail it */ }
}

/** The last completed check, or null if we have never recorded one. */
export function loadUpdateCheck(): UpdateCheckRecord | null {
  try {
    const raw = localStorage.getItem(UPDATE_CHECK_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<UpdateCheckRecord>;
    if (typeof v.at !== 'string' || !v.at) return null;
    if (v.outcome !== 'current' && v.outcome !== 'available' && v.outcome !== 'error') return null;
    if (!Number.isFinite(Date.parse(v.at))) return null;
    return {
      at: v.at,
      outcome: v.outcome,
      currentVersion: typeof v.currentVersion === 'string' ? v.currentVersion : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Has Buddy gone quiet about updates?
 *
 * True when we have NEVER completed a check, or the last one is older than the
 * staleness window. Deliberately does not distinguish those two for the caller's
 * decision — both mean "we cannot claim to be current" — but the copy can,
 * because "never asked" and "have not asked since Tuesday" read differently to a
 * human deciding whether to worry.
 */
export function updateCheckIsStale(
  record: UpdateCheckRecord | null,
  now = Date.now(),
): boolean {
  if (!record) return true;
  const at = Date.parse(record.at);
  if (!Number.isFinite(at)) return true;
  return now - at > CHECK_STALE_AFTER_MS;
}

function saveUpdateFailure(evidence: UpdateFailureEvidence): void {
  try {
    localStorage.setItem(UPDATE_FAILURE_KEY, JSON.stringify(evidence));
  } catch { /* diagnostics must never replace the original failure */ }
}

export function loadUpdateFailureEvidence(): UpdateFailureEvidence | null {
  try {
    const raw = localStorage.getItem(UPDATE_FAILURE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<UpdateFailureEvidence>;
    if (
      typeof value.id !== 'string' ||
      typeof value.at !== 'string' ||
      typeof value.phase !== 'string' ||
      !installPhases.has(value.phase as InstallPhase) ||
      typeof value.error !== 'string'
    ) return null;
    return value as UpdateFailureEvidence;
  } catch {
    return null;
  }
}

export function clearUpdateFailureEvidence(): void {
  try {
    localStorage.removeItem(UPDATE_FAILURE_KEY);
  } catch { /* non-fatal */ }
}

export function updateFailureEvidence(error: unknown): UpdateFailureEvidence | null {
  return error instanceof UpdateInstallError ? error.evidence : null;
}

export function formatUpdateFailureEvidence(evidence: UpdateFailureEvidence): string {
  return [
    `Buddy update failure ${evidence.id}`,
    `Time: ${evidence.at}`,
    `Stage: ${evidence.phase}`,
    `Version: ${evidence.currentVersion || 'unknown'} -> ${evidence.targetVersion || 'unknown'}`,
    `Error: ${evidence.error}`,
  ].join('\n');
}

let checkInFlight: Promise<UpdateInfo> | null = null;
let activeInstallUpdate: Awaited<ReturnType<typeof check>> = null;
let lastKnownCurrentVersion: string | undefined;

async function performUpdateCheck(): Promise<UpdateInfo> {
  let currentVersion: string | undefined;
  try {
    currentVersion = await getVersion();
    lastKnownCurrentVersion = currentVersion;
  } catch { /* non-fatal — only used for display */ }

  try {
    const update = await check({ timeout: CHECK_TIMEOUT_MS });
    // A check that began before Install was clicked can still finish during
    // download. It must not replace and close the native resource currently in
    // use. Dispose of the redundant result instead.
    if (activeInstallUpdate) {
      if (update && update !== activeInstallUpdate) {
        await update.close().catch(() => {});
      }
      return {
        available: true,
        version: activeInstallUpdate.version,
        notes: activeInstallUpdate.body || undefined,
        currentVersion,
      };
    }
    const previous = pendingUpdate;
    pendingUpdate = update;
    if (previous && previous !== update) {
      await previous.close().catch(() => {});
    }
    if (update) {
      return {
        available: true,
        version: update.version,
        notes: update.body || undefined,
        currentVersion,
      };
    }
    return { available: false, currentVersion };
  } catch {
    return { available: false, error: true, currentVersion };
  }
}

/**
 * Deduplicate checks from mount, wake, the six-hour timer and both menus.
 *
 * Without this, a slower "no update" response can clear `pendingUpdate` after
 * another response has already offered its Install button. The button then has
 * to check the network again and can fail even though its update was known.
 */
export function checkForUpdates(): Promise<UpdateInfo> {
  // Do not replace/close the native handle while downloadAndInstall is using
  // it. Wake and menu events can still request checks during a long download.
  if (installInFlight && (activeInstallUpdate || pendingUpdate)) {
    const update = activeInstallUpdate || pendingUpdate!;
    return Promise.resolve({
      available: true,
      version: update.version,
      notes: update.body || undefined,
    });
  }
  if (checkInFlight) return checkInFlight;
  checkInFlight = (async () => {
    try {
      return await performUpdateCheck();
    } finally {
      checkInFlight = null;
    }
  })();
  return checkInFlight;
}

/**
 * The Update handle from the most recent successful check.
 *
 * installUpdate() used to call check() again, which meant clicking Install did
 * a second network round-trip before anything happened — and if that one failed
 * (offline, flaky, endpoint blip) the function returned silently and the button
 * looked broken forever. We already know an update exists; hold onto the handle
 * rather than re-earning it.
 */
let pendingUpdate: Awaited<ReturnType<typeof check>> = null;

/**
 * Download and install, reporting progress.
 *
 * Progress is not decoration here. This downloads ~10MB and then relaunches the
 * app; with no feedback the window simply sits there, and the honest read for a
 * user is "the button is dead". Errors are thrown rather than swallowed for the
 * same reason — a failure the user cannot see is indistinguishable from one
 * that never started.
 */
let installInFlight: Promise<void> | null = null;

async function performInstall(
  onProgress?: (phase: InstallPhase, fraction: number | null) => void
): Promise<void> {
  let phase: InstallPhase = 'checking';
  let currentVersion: string | undefined;
  let update: Awaited<ReturnType<typeof check>> = null;

  try {
    onProgress?.('checking', null);
    update = pendingUpdate ?? (await check({ timeout: CHECK_TIMEOUT_MS }));
    if (!update) throw new Error('no update available');
    currentVersion = (update as { currentVersion?: string }).currentVersion || lastKnownCurrentVersion;
    activeInstallUpdate = update;

    phase = 'downloading';
    let total = 0;
    let received = 0;
    await update.downloadAndInstall(
      (event: any) => {
        if (event.event === 'Started') {
          total = event.data?.contentLength ?? 0;
          onProgress?.('downloading', total ? 0 : null);
        } else if (event.event === 'Progress') {
          received += event.data?.chunkLength ?? 0;
          onProgress?.('downloading', total ? received / total : null);
        } else if (event.event === 'Finished') {
          phase = 'installing';
          onProgress?.('installing', 1);
        }
      },
      { timeout: DOWNLOAD_TIMEOUT_MS }
    );

    if (pendingUpdate === update) pendingUpdate = null;
    await update.close().catch(() => {});
    phase = 'relaunching';
    onProgress?.('relaunching', 1);
    clearUpdateFailureEvidence();
    await relaunch();
  } catch (error) {
    const now = new Date();
    const evidence: UpdateFailureEvidence = {
      id: `UPD-${phase.toUpperCase()}-${now.getTime().toString(36).slice(-6).toUpperCase()}`,
      at: now.toISOString(),
      phase,
      currentVersion,
      targetVersion: update?.version,
      error: errorMessage(error),
    };
    saveUpdateFailure(evidence);
    throw new UpdateInstallError(evidence);
  } finally {
    if (activeInstallUpdate === update) activeInstallUpdate = null;
  }
}

/**
 * A double-click (or two surfaces acting in the same render turn) must not
 * start two downloads against the same updater handle.
 */
export function installUpdate(
  onProgress?: (phase: InstallPhase, fraction: number | null) => void
): Promise<void> {
  if (installInFlight) return installInFlight;
  installInFlight = (async () => {
    try {
      await performInstall(onProgress);
    } finally {
      installInFlight = null;
    }
  })();
  return installInFlight;
}
