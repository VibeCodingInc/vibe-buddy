// Shared row/format helpers for the buddy-list family — extracted from
// UnifiedBuddyList.tsx (take-stock Move 2 split).

export function formatAgo(agoSeconds: number): string {
  if (agoSeconds < 60) return 'now';
  if (agoSeconds < 3600) return `${Math.floor(agoSeconds / 60)}m`;
  return `${Math.floor(agoSeconds / 3600)}h`;
}

// Precise heartbeat age for the expanded detail — "12s ago" / "4m ago" / "1h 3m ago".
export function formatAgoPrecise(agoSeconds: number): string {
  if (agoSeconds < 60) return `${agoSeconds}s ago`;
  if (agoSeconds < 3600) return `${Math.floor(agoSeconds / 60)}m ago`;
  const h = Math.floor(agoSeconds / 3600);
  const m = Math.floor((agoSeconds % 3600) / 60);
  return m > 0 ? `${h}h ${m}m ago` : `${h}h ago`;
}

export function formatModel(model: string): string {
  if (model.includes('opus')) return 'opus';
  if (model.includes('sonnet')) return 'sonnet';
  if (model.includes('haiku')) return 'haiku';
  if (model.includes('gpt-4')) return 'gpt-4';
  if (model.includes('gpt-3')) return 'gpt-3.5';
  if (model.includes('gemini')) return 'gemini';
  if (model.includes('codex')) return 'codex';
  return model.split('/').pop()?.split('-')[0] || model;
}

// Keyboard activation for div-based rows: Enter or Space presses the row,
// exactly like the button it visually is. Shared so every primary row agrees.
export const pressOnKey = (action: () => void) => (e: { key: string; preventDefault(): void }) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    action();
  }
};
