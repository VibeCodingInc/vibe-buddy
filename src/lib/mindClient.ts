/**
 * Private Mind client — the Studio Mind behind the Buddy composer.
 *
 * The experience contract (slashvibe.dev): your private Mind → one approved
 * facet → one honest conversation. This client implements the sender-side
 * half, under the async-discard rule:
 *
 *   · never blocks sending, never shows a spinner
 *   · the Mind answers in 30–50s; the result renders ONLY if the same draft
 *     and tension are still current — otherwise it is discarded silently
 *   · one source-honest line or nothing
 *   · the Mind never sends
 *
 * The renderer never receives the destination or bearer. It gives the native
 * boundary only the active draft or recent visible thread excerpt already on
 * screen; native code calls the one allowlisted Tailnet Studio. Missing local
 * entitlement, transport errors and refusals are all silence.
 */

import { invoke } from '@tauri-apps/api/core';

export interface MindFacet {
  silence: boolean;
  offer_kind?: 'facet' | 'aperture';
  line?: string;
  facet?: string;
  why_rotates?: string;
  domain_distance?: string;
  confidence?: string;
  caveat?: string | null;
  quote?: string;
  source?: string;
  content_date?: string;
  attribution?: string;
  author_class?: string;
  authorship_hint?: string | null;
  labeled_inference?: string;
  proposed_prose?: string;
  disclosure?: string;
  disclosure_reason?: string;
  aperture?: {
    shown_to_owner_only?: {
      exact_words?: string;
      source?: string;
      freshness?: string;
      sensitivity?: string;
    };
    // Transitional compatibility with the founder-local runtime. The UI
    // normalizes this to owner-neutral language and never emits this field.
    shown_to_seth_only?: {
      exact_words?: string;
      source?: string;
      freshness?: string;
      sensitivity?: string;
    };
    facet_prompt?: string;
  };
  latency?: number;
  stopped_at?: string;
}

/** Tension pre-gate, mirrored from the runtime so we never spend a 40s
 * round-trip on "ok sounds good". Deliberately loose — the runtime's own
 * gate is authoritative; this only filters the obvious non-tensions. */
export function looksConsequential(draft: string): boolean {
  const d = draft.trim();
  if (d.length < 40 || d.split(/\s+/).length < 8) return false;
  return /(\bshould\b.{0,60}\bor\b|\bwhether\b|\btorn\b|\bdeciding\b|\bdecide\b|\bnot sure\b|\bunsure\b|\bwondering\b|\bwhat if\b|\bi'?ll\b|\bback and forth\b|\?\s*$)/i.test(d);
}

/** Stable fingerprint of (recipient, draft-tension). The result is rendered
 * ONLY if the fingerprint at arrival equals the fingerprint at request —
 * the human moved on means the Mind stays silent. Trailing whitespace and
 * case wobble don't count as "moved on". */
export function tensionFingerprint(handle: string, draft: string): string {
  return handle + '' + draft.trim().toLowerCase().replace(/\s+/g, ' ');
}

let inFlight: AbortController | null = null;
const PRIME_TTL_MS = 15 * 60_000;
const primedFor = new Map<string, { fingerprint: string; expiresAt: number }>();
const primingFor = new Map<string, string>();

export function contextFingerprint(handle: string, context: string): string {
  return tensionFingerprint(handle, context);
}

export function retrievalFactLine(facet: MindFacet): string {
  const privateDetail =
    facet.aperture?.shown_to_owner_only ?? facet.aperture?.shown_to_seth_only;
  const source = privateDetail?.source ?? facet.source;
  const date = privateDetail?.freshness ?? facet.content_date;
  const parts = source?.split('/').filter(Boolean) ?? [];
  const leaf = parts.length > 0 ? parts[parts.length - 1] : undefined;
  return `${leaf ? `from ${leaf}` : 'from your private sources'}${date ? ` · ${date}` : ''} · see ›`;
}

/**
 * Thread-open priming. Builds an ephemeral working set for THIS relationship
 * on the Mind side — lenses, retrieval, disclosure and pre-ranking — so that
 * composing costs one small match instead of the whole pipeline. Shows
 * nothing, sends nothing, and returns nothing the UI renders: the only
 * observable effect is that the offer, if one ever comes, arrives in seconds.
 *
 * Fire-and-forget by design. If it fails, the composer still works; the Mind
 * simply falls back to the slow path.
 */
export function primeMind(handle: string, context: string, now = Date.now()): void {
  const normalized = context.trim();
  if (!normalized) return;
  const fingerprint = contextFingerprint(handle, normalized);
  const current = primedFor.get(handle);
  if (current?.fingerprint === fingerprint && current.expiresAt > now) return;
  if (primingFor.get(handle) === fingerprint) return;
  primingFor.set(handle, fingerprint);
  void invoke<unknown | null>('mind_prime', { handle, context: normalized })
    .then((res) => {
      if (res === null) throw new Error('prime unavailable');
      if (primingFor.get(handle) === fingerprint) {
        primedFor.set(handle, {
          fingerprint,
          expiresAt: Date.now() + PRIME_TTL_MS,
        });
      }
    })
    .catch(() => {
      // A failed prime remains retryable. The composer never renders the
      // failure and never waits for it.
    })
    .finally(() => {
      if (primingFor.get(handle) === fingerprint) primingFor.delete(handle);
    });
}

export function resetMindPrimeCacheForTests(): void {
  primedFor.clear();
  primingFor.clear();
}

/**
 * Ask the Studio Mind for one facet. Resolves with the facet + the
 * fingerprint it belongs to; the CALLER compares fingerprints at arrival
 * and discards silently on mismatch. Errors and timeouts resolve to null —
 * absence of the Mind is silence, never failure chrome.
 */
export async function askMind(
  handle: string,
  draft: string
): Promise<{ facet: MindFacet; fingerprint: string } | null> {
  // one request at a time; a newer ask supersedes the old one
  if (inFlight) inFlight.abort();
  const ctrl = new AbortController();
  inFlight = ctrl;
  const fingerprint = tensionFingerprint(handle, draft);
  const timer = setTimeout(() => ctrl.abort(), 90_000);
  try {
    const facet = await Promise.race([
      invoke<MindFacet | null>('mind_facet', { handle, draft }),
      new Promise<null>((resolve) => {
        ctrl.signal.addEventListener('abort', () => resolve(null), { once: true });
      }),
    ]);
    if (!facet) return null;
    return { facet, fingerprint };
  } catch {
    return null; // silence — never an error state in the composer
  } finally {
    clearTimeout(timer);
    if (inFlight === ctrl) inFlight = null;
  }
}
