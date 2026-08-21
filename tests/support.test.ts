// G6 — the support path builds a correct mailto and never sends on its own.

import { describe, it, expect } from 'vitest';
import { buildSupportMailto, SUPPORT_EMAIL } from '../src/lib/support';

describe('buildSupportMailto', () => {
  it('targets the real support inbox with the report id in the subject', () => {
    const url = buildSupportMailto('bd-abc123', 'REPORT BODY');
    expect(url.startsWith(`mailto:${SUPPORT_EMAIL}?`)).toBe(true);
    expect(decodeURIComponent(url)).toContain('subject=Vibe Buddy problem report bd-abc123');
  });

  it('prefills the reviewed report in the body, encoded', () => {
    const url = buildSupportMailto('bd-1', 'line one\nline two');
    // newlines and spaces must be percent-encoded, not raw, or the mailto breaks
    expect(url).toContain('%0A');
    expect(url).not.toContain('line one\nline two');
    expect(decodeURIComponent(url)).toContain('line one\nline two');
  });

  it('is a real address, not a placeholder', () => {
    expect(SUPPORT_EMAIL).toMatch(/@slashvibe\.dev$/);
    expect(SUPPORT_EMAIL).not.toMatch(/example|placeholder|todo/i);
  });
});
