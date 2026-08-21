/**
 * Collapse concurrent triggers onto one promise.
 *
 * Useful for work that can be kicked by both a timer and UI/lifecycle events:
 * the result is authoritative state, so allowing an older request to land
 * after a newer one is worse than skipping the duplicate trigger.
 */
export function singleFlight<T>(fn: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return () => {
    if (inFlight) return inFlight;
    let current: Promise<T>;
    current = fn().finally(() => {
      if (inFlight === current) inFlight = null;
    });
    inFlight = current;
    return current;
  };
}
