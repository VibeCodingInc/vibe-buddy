/**
 * /vibe design tokens — ROOM TONE.
 *
 * Typed twin of the canonical `vibe-tokens.json` in the platform repo, which
 * is itself the twin of `vibe-tokens.css` (the source of record). Buddy is a
 * Tauri/React app and cannot import the platform's CSS, so the values live
 * here — in ONE place. Never retype a hex in a component; four /vibe surfaces
 * drifted into four palettes precisely because colors were documented as prose
 * instead of exported.
 *
 * Re-sync: copy the values from platform `vibe-tokens.json`. Nothing else in
 * Buddy should contain a literal hex.
 *
 * RESERVED MEANINGS — these are not decoration:
 *   green — live presence ONLY. A person or agent is here NOW. Never success,
 *           never a checkmark, never a confirm button.
 *   pink  — attention and danger, sparingly.
 *   blue  — /vibe itself: our own actions and affordances.
 * More than one saturated hue on a screen means something is wrong.
 */

export const color = {
  bg: '#0A0A0A',
  panel: '#111316',
  line: '#1F2937',
  // One step up from `panel`, for hover only. ROOM TONE gives three depths and
  // this is not a fourth surface — it is the transient lift that tells you a row
  // is interactive. Without it every row hover was a no-op: the handler existed
  // and set panel to panel.
  hover: '#171A1F',
  ink: '#E0E0E0',
  dim: '#9CA3AF',
  faint: '#6B7280',
  blue: '#6B8FFF',
  blueBright: '#8BA8FF',
  blueDim: '#3b4a7a',
  green: '#22c55e',
  greenDim: '#15803d',
  pink: '#ff79c6',
} as const;

export const font = {
  mono: "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Monaco, Consolas, monospace",
} as const;

export const size = { 11: 11, 12: 12, 13: 13, 14: 14, 16: 16, 20: 20, 28: 28 } as const;
export const space = { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24, 8: 32 } as const;
export const radius = { sm: 6, md: 8, lg: 10 } as const;
