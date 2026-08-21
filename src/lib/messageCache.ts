// Message cache for thread persistence across app restarts
import type { VibeMessage } from './vibeClient';

const MAX_MESSAGES_PER_THREAD = 100;
const MAX_CACHED_THREADS = 50;
const CACHE_PREFIX = 'vibe_thread_v2_';
const CACHE_INDEX_KEY = 'vibe_thread_cache_index_v2';

function getCacheKey(handle: string, chatWith: string): string {
  // Sort handles alphabetically so both sides share the same key
  const sorted = [handle, chatWith].sort();
  // JSON is encoded as a single component. Joining raw handles with `_` made
  // ["a_b", "c"] and ["a", "b_c"] the same cache key, which could render
  // one person's private messages in another conversation.
  return `${CACHE_PREFIX}${encodeURIComponent(JSON.stringify(sorted))}`;
}

function cachedMessage(value: unknown): value is VibeMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const message = value as Partial<VibeMessage>;
  return typeof message.id === 'string' &&
    typeof message.from === 'string' &&
    typeof message.to === 'string' &&
    typeof message.content === 'string' &&
    typeof message.timestamp === 'string' &&
    (message.status === undefined ||
      ['pending', 'sent', 'delivered', 'read', 'failed'].includes(message.status));
}

function belongsToThread(message: VibeMessage, handle: string, chatWith: string): boolean {
  return (message.from === handle && message.to === chatWith) ||
    (message.from === chatWith && message.to === handle);
}

function touchCacheKey(key: string): void {
  let index: string[] = [];
  try {
    const stored = JSON.parse(localStorage.getItem(CACHE_INDEX_KEY) || '[]');
    if (Array.isArray(stored)) {
      index = stored.filter((item): item is string =>
        typeof item === 'string' && item.startsWith(CACHE_PREFIX) && item !== key
      );
    }
  } catch { /* rebuild the bounded index from this write */ }

  // If the index was lost or truncated, rediscover v2 entries before applying
  // the cap. Otherwise one corrupt bookkeeping value makes growth unbounded
  // again even though every individual thread is valid.
  const discovered: string[] = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const item = localStorage.key(i);
    if (item?.startsWith(CACHE_PREFIX) && item !== key && !index.includes(item)) {
      discovered.push(item);
    }
  }
  index = [...discovered, ...index];

  index.push(key);
  while (index.length > MAX_CACHED_THREADS) {
    const oldest = index.shift();
    if (oldest) localStorage.removeItem(oldest);
  }
  localStorage.setItem(CACHE_INDEX_KEY, JSON.stringify(index));
}

export function getCachedMessages(handle: string, chatWith: string): VibeMessage[] {
  try {
    const key = getCacheKey(handle, chatWith);
    const cached = localStorage.getItem(key);
    if (!cached) return [];
    const parsed: unknown = JSON.parse(cached);
    if (!Array.isArray(parsed)) return [];
    touchCacheKey(key);
    return parsed.filter(cachedMessage).filter(message => belongsToThread(message, handle, chatWith));
  } catch {
    return [];
  }
}

export function setCachedMessages(
  handle: string,
  chatWith: string,
  messages: VibeMessage[]
): void {
  try {
    const key = getCacheKey(handle, chatWith);
    // Filter out optimistic/pending messages — only cache confirmed ones
    const confirmed = messages.filter(
      (m) => cachedMessage(m) &&
        belongsToThread(m, handle, chatWith) &&
        !m.id.startsWith('local_') && m.status !== 'pending' && m.status !== 'failed'
    );
    // Keep only the most recent messages
    const trimmed = confirmed.slice(-MAX_MESSAGES_PER_THREAD);
    localStorage.setItem(key, JSON.stringify(trimmed));
    touchCacheKey(key);
  } catch {
    // localStorage might be full or unavailable
  }
}
