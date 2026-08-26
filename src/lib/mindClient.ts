/**
 * FOUNDER-ONLY Mind client — the Studio Mind behind the Buddy composer.
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
 * Founder gating: activates only when VITE_MIND_URL + VITE_MIND_TOKEN are
 * present at build time (Seth's dev environment). Production builds carry
 * no Mind code path — both env vars are absent, isFounderMind() is false,
 * and the dynamic checks keep every call unreachable. No platform proxying:
 * the call goes straight from Buddy to the Studio over Seth's private
 * Tailscale path.
 */

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

const MIND_URL = (import.meta as any).env?.VITE_MIND_URL as string | undefined;
const MIND_TOKEN = (import.meta as any).env?.VITE_MIND_TOKEN as string | undefined;

export function isFounderMind(): boolean {
  return Boolean(MIND_URL && MIND_TOKEN);
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
  if (!isFounderMind()) return null;
  // one request at a time; a newer ask supersedes the old one
  if (inFlight) inFlight.abort();
  const ctrl = new AbortController();
  inFlight = ctrl;
  const fingerprint = tensionFingerprint(handle, draft);
  const timer = setTimeout(() => ctrl.abort(), 90_000);
  try {
    const res = await fetch(`${MIND_URL}/facet`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${MIND_TOKEN}`,
      },
      body: JSON.stringify({ handle, draft }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const facet = (await res.json()) as MindFacet;
    return { facet, fingerprint };
  } catch {
    return null; // silence — never an error state in the composer
  } finally {
    clearTimeout(timer);
    if (inFlight === ctrl) inFlight = null;
  }
}
