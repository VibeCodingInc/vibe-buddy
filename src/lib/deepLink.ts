/**
 * The app's deep-link entry path (#320 finding 4): a redemption lands its
 * redeemer at /t/{thread_id}, and the recipient must finish INSIDE that
 * thread — so `vibe://t/{thread_id}` routes to the exact thread, resolved
 * through the served row (never a guess).
 *
 * Parsing is pure and exported so tests exercise the REAL route.
 */
export type DeepLinkRoute =
  | { kind: 'thread'; threadId: string }
  | { kind: 'dm'; handle: string }
  | null;

export function routeDeepLink(url: string): DeepLinkRoute {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'vibe:') return null;
  // vibe://t/{id} — URL() puts the first segment in host for custom schemes
  const host = u.host.toLowerCase();
  const segs = u.pathname.split('/').filter(Boolean);
  if (host === 't' && segs.length === 1 && /^[A-Za-z0-9_-]{1,64}$/.test(segs[0])) {
    return { kind: 'thread', threadId: segs[0] };
  }
  if (host === 'dm' && segs.length === 1) {
    // Trimmed, leading @ removed, lowercased — the same cleaning as a typed
    // handle. The spelling ('-' vs '_') is not touched here: the platform's
    // identity answer decides that (App resolves before opening).
    let seg: string;
    try { seg = decodeURIComponent(segs[0]); } catch { return null; }
    const handle = seg.trim().replace(/^@+/, '').trim().toLowerCase();
    if (/^[a-z0-9][a-z0-9_-]{0,38}$/.test(handle)) return { kind: 'dm', handle };
  }
  return null;
}
