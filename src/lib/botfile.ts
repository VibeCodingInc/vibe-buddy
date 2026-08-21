// Who a local session actually is.
//
// A session row is a path and a heartbeat — accurate, and completely impersonal.
// Five of them read as five terminals rather than five agents you know by name.
//
// vibeconf already solved this for calls: a `BOT.md` in the project's working
// directory gives that project's agent a durable character (slug, display name,
// emoji, owner). Buddy knows the cwd of every session on THIS machine, so it can
// read the same file and show the same identity. One source of truth for "who is
// this agent", shared between the call and the buddy list, with no new format and
// nothing to sync.
//
// SCOPE, deliberately narrow: local sessions only. Buddy can read its own disk,
// not anyone else's, so other people's sessions are untouched by this. Carrying
// bot identity BETWEEN people is presence data, and presence semantics are the
// platform's — a client must not open a second channel for them.

import { invoke } from '@tauri-apps/api/core';

export interface Botfile {
  bot: string;
  display: string;
  emoji?: string;
  owner?: string;
}

/**
 * Cached per directory, because this is called on every render pass for every
 * local session and a BOT.md changes about as often as a project is renamed.
 *
 * `null` is cached as deliberately as a hit: "there is no Botfile here" is the
 * common answer, and re-statting the disk for it on every poll would be the
 * expensive way to learn nothing.
 */
const cache = new Map<string, { value: Botfile | null; at: number }>();
const TTL_MS = 60_000;

export function clearBotfileCache(): void {
  cache.clear();
}

export async function readBotfile(cwd: string | undefined, now = Date.now()): Promise<Botfile | null> {
  if (!cwd) return null;
  const hit = cache.get(cwd);
  if (hit && now - hit.at < TTL_MS) return hit.value;
  try {
    const value = (await invoke<Botfile | null>('read_botfile', { cwd })) ?? null;
    cache.set(cwd, { value, at: now });
    return value;
  } catch {
    // An IPC failure is not evidence the session has no character. Do NOT cache
    // it as `null` — that would turn one blip into a minute of anonymity.
    return null;
  }
}

/**
 * What to call this session in a list row.
 *
 * Falls back to the project name, which is what Buddy showed before any of this
 * existed. A session without a Botfile must look exactly as it always did, not
 * like something failed to load.
 */
export function sessionLabel(botfile: Botfile | null, project: string | undefined): string {
  if (botfile?.display) return botfile.display;
  return project || 'session';
}
