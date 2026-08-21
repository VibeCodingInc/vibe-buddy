// Context Extractor — reads local coding data via Rust backend
// Enriches presence heartbeat with CodingDNA

import { invoke } from '@tauri-apps/api/core';

export interface CodingDNA {
  active_project: string | null;
  branch: string | null;
  model: string | null;
  session_minutes: number;
  tokens_today: { input: number; output: number };
  top_projects: string[];
  top_languages: string[];
  recent_topics: string[];
  weekly_sessions: number;
  streak_days: number;
  stuck_signal: boolean;
  projects_known: string[];
}

let cachedDNA: CodingDNA | null = null;
let lastExtracted = 0;
let extractionInFlight: Promise<CodingDNA> | null = null;
let extractionStartedAt = 0;
const CACHE_TTL = 60_000; // Re-extract every 60s

export async function getCodingDNA(): Promise<CodingDNA | null> {
  const now = Date.now();
  if (cachedDNA && now - lastExtracted < CACHE_TTL) {
    return cachedDNA;
  }

  try {
    // Bounded, because this reads a SQLite database whose size we do not
    // control. A Mac Studio in this fleet has a 32GB vibe_check.db; the extract
    // there never returned, and since the heartbeat AWAITS this before posting
    // presence, that machine was silently invisible to everyone — signed in,
    // sharing on, and never once announced. The UI showed "Announcing…"
    // indefinitely, which reads as progress rather than as a stuck call.
    //
    // CodingDNA is enrichment. Being present is the product. Enrichment must
    // never be able to prevent the essential thing, so it gets a deadline and
    // the caller proceeds without it.
    // A JS timeout cannot cancel a Rust `spawn_blocking` task. Keep the raw
    // invocation single-flight so a database scan that never returns consumes
    // one worker, not another worker every five-minute heartbeat for a week.
    if (!extractionInFlight) {
      extractionStartedAt = now;
      const raw = invoke<CodingDNA>('extract_coding_context');
      let tracked: Promise<CodingDNA>;
      tracked = raw
        .then((dna) => {
          cachedDNA = dna;
          lastExtracted = Date.now();
          return dna;
        })
        .finally(() => {
          if (extractionInFlight === tracked) extractionInFlight = null;
        });
      extractionInFlight = tracked;
    }

    const remaining = EXTRACT_TIMEOUT_MS - (now - extractionStartedAt);
    if (remaining <= 0) return cachedDNA;
    return await withDeadline(extractionInFlight, remaining);
  } catch (err) {
    console.warn('[ContextExtractor] Failed to extract:', err);
    return cachedDNA; // Return stale if available
  }
}

/** How long the local context read may take before presence goes without it. */
const EXTRACT_TIMEOUT_MS = 4000;

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`extract_coding_context exceeded ${ms}ms`)),
      ms
    );
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

// REMOVED 2026-08-15 with the Rust command behind it: getRecentTurnsResult /
// getRecentTurns read raw conversation text. Kill switch 0c stopped Buddy
// sending turns in 2026-08-09, but leaving the reader wired meant the
// transcript-privacy promise held only because no caller happened to invoke
// it. Raw turns may return only behind a separate, session-scoped grant —
// preview of what leaves, a named recipient, an expiry, revocation — and that
// work will add its own path deliberately rather than inherit this one.

/**
 * Format CodingDNA into presence-compatible fields
 */
export function dnaToPresencePayload(dna: CodingDNA) {
  // Build a natural "workingOn" string from the DNA
  const parts: string[] = [];
  if (dna.active_project) parts.push(dna.active_project);
  if (dna.branch && dna.branch !== 'main' && dna.branch !== 'master') {
    parts.push(`on ${dna.branch}`);
  }

  const workingOn = parts.length > 0
    ? parts.join(' ')
    : 'Building with AI';

  return {
    workingOn,
    project: dna.active_project || undefined,
    clientMetadata: {
      branch: dna.branch || undefined,
      model: dna.model || undefined,
      session_minutes: dna.session_minutes || undefined,
      tech_stack: dna.top_languages.length > 0 ? dna.top_languages : undefined,
      tokens_in: dna.tokens_today.input || undefined,
      tokens_out: dna.tokens_today.output || undefined,
      phase: dna.stuck_signal ? 'debugging' : (dna.session_minutes > 120 ? 'deep-focus' : 'coding'),
      top_projects: dna.top_projects.length > 0 ? dna.top_projects : undefined,
      recent_topics: dna.recent_topics.length > 0 ? dna.recent_topics : undefined,
      weekly_sessions: dna.weekly_sessions || undefined,
      streak_days: dna.streak_days || undefined,
    },
  };
}
