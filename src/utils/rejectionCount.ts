// src/utils/rejectionCount.ts
//
// Record Production's per-slot rejection counter: typed into a numeric field
// or stepped with − / +. Both paths go through these helpers so the stored
// count is always a whole number ≥ 0.

// Generous ceiling — far above any hourly slot — so a stray paste or an
// extra digit can't store an absurd count.
export const MAX_REJECTION_COUNT = 99999;

// Text typed into the counter → the count it means, or null when it isn't a
// valid count (negative, decimal, non-numeric, too large). An empty field
// means 0, so clearing it and typing a new number works naturally.
export function parseRejectionCount(text: string): number | null {
  const t = text.trim();
  if (t === '') return 0;
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) && n <= MAX_REJECTION_COUNT ? n : null;
}

// − / + : never below 0 or above the ceiling; a missing or damaged stored
// value counts as 0.
export function stepRejectionCount(current: number | null | undefined, delta: number): number {
  const base = typeof current === 'number' && Number.isFinite(current) && current >= 0 ? Math.floor(current) : 0;
  return Math.min(MAX_REJECTION_COUNT, Math.max(0, base + delta));
}

// What the field shows for a count. While the field is being edited, the
// typed text is kept as long as it still means the stored count (so "" or
// "007" aren't rewritten mid-typing); otherwise the count itself is shown.
export function rejectionFieldText(count: number, typedText: string | null): string {
  if (typedText !== null && parseRejectionCount(typedText) === count) return typedText;
  return String(count);
}
