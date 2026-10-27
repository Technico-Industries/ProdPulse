// src/utils/prodAIThinking.ts
//
// Keyframes of Prod AI's "thinking" dots (components/ProdAIThinking): one
// shared loop value runs 0 → 1 per cycle and each dot rises and brightens in
// turn, left to right, then rests — a gentle wave. Pure, so the timing can be
// checked without a renderer (scripts/testProdAIPanel.ts).

export const THINKING_DOT_COUNT = 3;
export const THINKING_CYCLE_MS = 1200;
// Each dot's pulse lasts this share of the cycle; pulses start
// THINKING_STAGGER apart, so the last one ends before the cycle does.
const PULSE = 0.36;
const STAGGER = 0.2;
// A short rest before the first pulse keeps every keyframe distinct.
const LEAD = 0.04;

export const THINKING_REST_OPACITY = 0.3;
export const THINKING_PEAK_OPACITY = 1;
export const THINKING_RISE_PX = 3;

// inputRange for Animated.Value.interpolate: rest → peak → rest within the
// dot's own window, flat elsewhere. Strictly increasing, inside [0, 1].
export function thinkingDotInputRange(index: number): number[] {
  const start = LEAD + index * STAGGER;
  return [0, start, start + PULSE / 2, start + PULSE, 1];
}

export function thinkingDotOpacityRange(): number[] {
  return [THINKING_REST_OPACITY, THINKING_REST_OPACITY, THINKING_PEAK_OPACITY, THINKING_REST_OPACITY, THINKING_REST_OPACITY];
}

export function thinkingDotRiseRange(): number[] {
  return [0, 0, -THINKING_RISE_PX, 0, 0];
}

// The same curve evaluated directly (piecewise linear) — what interpolate
// produces at `progress`.
export function thinkingDotLevel(index: number, progress: number): number {
  const xs = thinkingDotInputRange(index);
  const ys = thinkingDotOpacityRange();
  const p = Math.min(1, Math.max(0, progress));
  for (let i = 1; i < xs.length; i++) {
    if (p <= xs[i]) {
      const span = xs[i] - xs[i - 1];
      return span <= 0 ? ys[i] : ys[i - 1] + ((ys[i] - ys[i - 1]) * (p - xs[i - 1])) / span;
    }
  }
  return ys[ys.length - 1];
}

// With reduced motion the dots don't move: all shown at a steady, readable
// level.
export const THINKING_STATIC_OPACITY = 0.7;
