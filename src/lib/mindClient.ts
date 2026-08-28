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
  // MIRRORS the runtime's detect_tension grammar (decision / contradiction /
  // uncertainty / possibility / promise / open question). The Camille defect
  // was this gate being NARROWER than the server's: a draft the Mind would
  // have honored ("curious how…", "maybe…", a but-clause) never left the
  // composer, and the silence was indistinguishable from an intelligent
  // pass. This gate exists only to save round-trips on obvious non-tensions;
  // when in doubt it ASKS — the server's gate is authoritative.
  return TENSION_RX.test(d);
}

/** One expression, kept deliberately in sync with mind.py's TENSION table. */
export const TENSION_RX = new RegExp(
  [
    "\\bshould\\b.{0,60}\\bor\\b", "\\btorn\\b", "\\bdecid(?:e|ing)\\b", "\\bversus\\b",
    "\\bback and forth\\b",
    "\\bbut\\b", "\\bhowever\\b", "\\bon the other hand\\b", "\\bthough\\b", "\\bexcept\\b", "\\bdisagree\\b",
    "\\bnot sure\\b", "\\bunsure\\b", "\\bwondering\\b", "\\bunclear\\b", "\\bdon'?t know\\b",
    "\\bno idea\\b", "\\bmaybe\\b", "\\bmight be\\b", "\\bcurious\\b", "\\bstruggling\\b",
    "\\bwhat if\\b", "\\bcould we\\b", "\\bimagine\\b", "\\bsuppose\\b", "\\bworth trying\\b",
    "\\bi'?ll\\b", "\\bi will\\b", "\\blet me\\b",
    "\\?\\s*$",
  ].join("|"),
  "i"
);

/** Stable fingerprint of (recipient, draft-tension). The result is rendered
 * ONLY if the fingerprint at arrival equals the fingerprint at request —
 * the human moved on means the Mind stays silent. Trailing whitespace and
 * case wobble don't count as "moved on". */
export function tensionFingerprint(handle: string, draft: string): string {
  return handle + '' + draft.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Metadata-only tracing (Camille defect): stage names, byte counts, and a
 * short fingerprint hash — NEVER text. Fire-and-forget; tracing must never
 * affect the path it observes. */
export function mindTrace(event: string, meta: Record<string, number | string | boolean> = {}): void {
  void invoke('mind_trace', { event, meta }).catch(() => {});
}

/** Short non-reversible tag for correlating trace lines about one tension. */
export function fpTag(fingerprint: string): string {
  let h = 0;
  for (let i = 0; i < fingerprint.length; i++) h = ((h << 5) - h + fingerprint.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

let inFlight: AbortController | null = null;
// A working session, not a coffee break: the set costs ~100s to build, and
// freshness is owned by the context fingerprint (a new message re-primes
// regardless), so this is purely the retention backstop for the in-memory
// pool. 15 minutes expired mid-read and silently pushed real passes onto
// the cold path. Matches the Studio runtime.
const PRIME_TTL_MS = 2 * 60 * 60_000;
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
  mindTrace('request_attempted', { fp: fpTag(fingerprint), draft_bytes: new TextEncoder().encode(draft).length });
  const timer = setTimeout(() => ctrl.abort(), 90_000);
  try {
    const facet = await Promise.race([
      invoke<MindFacet | null>('mind_facet', { handle, draft }),
      new Promise<null>((resolve) => {
        ctrl.signal.addEventListener('abort', () => resolve(null), { once: true });
      }),
    ]);
    if (!facet) {
      // null from the native layer = REFUSED/UNREACHABLE — a different fact
      // from the Mind answering with silence, and the trace keeps them apart.
      mindTrace('response', { fp: fpTag(fingerprint), class: 'native_null' });
      return null;
    }
    mindTrace('response', {
      fp: fpTag(fingerprint),
      class: facet.silence ? 'silence' : (facet.offer_kind || 'offer'),
    });
    return { facet, fingerprint };
  } catch {
    mindTrace('response', { fp: fpTag(fingerprint), class: 'invoke_error' });
    return null; // silence — never an error state in the composer
  } finally {
    clearTimeout(timer);
    if (inFlight === ctrl) inFlight = null;
  }
}
