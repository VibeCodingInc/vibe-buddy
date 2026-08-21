// G6 — the support path.
//
// Friends & family beta: support is a person, not a queue. The report the user
// reviewed goes to that person by email, prefilled — the button that opens it
// says exactly that, and nothing is sent until the user's own mail client
// sends it. No silent upload, no telemetry endpoint; the human stays the last
// step, which is the whole point of consent-gated diagnostics.

/** Where a problem report goes. A real, monitored inbox — not a placeholder. */
export const SUPPORT_EMAIL = 'seth@slashvibe.dev';

/**
 * A mailto: URL that opens the user's mail client with the report prefilled.
 * The subject carries the report id so a reply can reference it; the body is
 * the exact text the user reviewed. Opening it is the send decision — the
 * client still requires their explicit Send.
 */
export function buildSupportMailto(reportId: string, reportText: string): string {
  const subject = `Vibe Buddy problem report ${reportId}`;
  const body =
    "Here's what happened (add anything that helps):\n\n\n" +
    '--- diagnostics (reviewed before sending) ---\n' +
    reportText;
  return (
    `mailto:${SUPPORT_EMAIL}` +
    `?subject=${encodeURIComponent(subject)}` +
    `&body=${encodeURIComponent(body)}`
  );
}
