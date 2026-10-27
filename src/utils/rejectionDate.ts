// src/utils/rejectionDate.ts
//
// Date field of the Record Rejection screen. rejectionRecords.date is a
// local calendar date "YYYY-MM-DD" (the same format the screen has always
// written), so "today" here is the device's local calendar date — not the
// 6:30 AM production day of utils/productionDay, which only Record
// Production uses.

const p2 = (n: number) => String(n).padStart(2, '0');

export function localDateKey(epochMs: number): string {
  const d = new Date(epochMs);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

export function isValidDateKey(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

// The date a rejection entry opens with: an existing record keeps its own
// date; a new entry starts on today. A date remembered from an earlier
// visit is never used for a new entry.
export function initialRejectionDate(existingRecordDate: string | null | undefined, nowMs: number): string {
  return isValidDateKey(existingRecordDate) ? existingRecordDate : localDateKey(nowMs);
}
