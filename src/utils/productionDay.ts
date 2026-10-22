// ─── Production day ──────────────────────────────────────────────────────────
// A "production day" runs from 6:30 AM to the next day's 6:30 AM - chosen
// because it's 30 min before Shift A starts (7:00 AM) and ~3 hours after
// Shift B ends (3:30 AM), so no shift is ever active across that boundary.
// This is what lets Shift B (7:00 PM - 3:30 AM) keep the SAME production
// date all night, even though the real calendar date changes at midnight:
// a session started at 7:00 PM on the 22nd is still "22nd" at 2:00 AM,
// because 2:00 AM is before the 6:30 AM cutover into the 23rd.
export const PRODUCTION_DAY_CUTOVER_MINUTES = 6 * 60 + 30; // 6:30 AM

export function productionDayKeyFor(epochMs: number): string {
  const d = new Date(epochMs);
  const minutesOfDay = d.getHours() * 60 + d.getMinutes();
  const effective = new Date(d);
  if (minutesOfDay < PRODUCTION_DAY_CUTOVER_MINUTES) {
    effective.setDate(effective.getDate() - 1);
  }
  const y = effective.getFullYear();
  const m = String(effective.getMonth() + 1).padStart(2, '0');
  const day = String(effective.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Local instant of an absolute shift minute (minutes from midnight of the
// production day, past 1440 for Shift B's after-midnight hours).
export function productionDayMinuteToMillis(key: string, minuteAbs: number): number {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d, 0, minuteAbs).getTime();
}

// Inverse of productionDayMinuteToMillis, rounded down to the minute.
export function millisToProductionDayMinute(key: string, epochMs: number): number {
  return Math.floor((epochMs - productionDayMinuteToMillis(key, 0)) / 60000);
}

export function isProductionDayKey(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

// Firestore Timestamp (or a pending serverTimestamp, which reads back as
// null), Date or epoch ms → epoch ms, or null if it isn't a usable time.
export function timestampToMillis(ts: unknown): number | null {
  if (ts == null) return null;
  if (typeof ts === 'number') return Number.isFinite(ts) ? ts : null;
  if (ts instanceof Date) return Number.isFinite(ts.getTime()) ? ts.getTime() : null;
  const toMillis = (ts as { toMillis?: () => number }).toMillis;
  if (typeof toMillis === 'function') {
    const ms = toMillis.call(ts);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

// ─── Reading productionRecords by production date ───────────────────────────
// Reports must select records by the date they were filed under, NOT by
// createdAt: a Shift B slot saved at 1:00 AM, or a Finalize pressed after
// midnight, has a next-calendar-day createdAt but belongs to the night it
// started on. A calendar-day createdAt range drops those records from their
// own day and pulls them into the next one.

function calendarDayKeyFor(epochMs: number): string {
  const d = new Date(epochMs);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function addDaysToKey(key: string, days: number): string {
  const [y, m, d] = key.split('-').map(Number);
  return calendarDayKeyFor(new Date(y, m - 1, d + days).getTime());
}

// The production date of a stored productionRecords doc: its own
// productionDate, else (records saved before that field existed) derived
// from createdAt — by the 6:30 AM cutover for Shift B, so its after-midnight
// slots stay on the night they belong to, and by calendar day for every
// other shift, exactly as before.
export function recordProductionDayKey(r: { productionDate?: unknown; shift?: unknown; createdAtMs?: number | null }): string | null {
  if (isProductionDayKey(r.productionDate)) return r.productionDate;
  if (r.createdAtMs == null || !Number.isFinite(r.createdAtMs)) return null;
  return r.shift === 'B' ? productionDayKeyFor(r.createdAtMs) : calendarDayKeyFor(r.createdAtMs);
}

// createdAt window that can contain a legacy record (no productionDate) of
// a day in [fromKey, toKey]: from the first day's midnight up to the 6:30 AM
// cutover after the last day, which covers Shift B's after-midnight slots.
export function legacyCreatedAtWindow(fromKey: string, toKey: string): { startMs: number; endMs: number } {
  return {
    startMs: productionDayMinuteToMillis(fromKey, 0),
    endMs: productionDayMinuteToMillis(addDaysToKey(toKey, 1), PRODUCTION_DAY_CUTOVER_MINUTES),
  };
}

export type StoredRecordRow<T> = { id: string; shift?: unknown; productionDate?: unknown; createdAtMs: number | null; doc: T };

// Merges the results of the productionDate-range query and the legacy
// createdAt-window query: de-duplicated by doc id, kept only when the
// record's production date is inside [fromKey, toKey], oldest createdAt first.
export function selectRecordsInProductionRange<T>(lists: StoredRecordRow<T>[][], fromKey: string, toKey: string): T[] {
  const byId = new Map<string, StoredRecordRow<T>>();
  for (const list of lists) for (const row of list) if (!byId.has(row.id)) byId.set(row.id, row);
  return Array.from(byId.values())
    .filter((row) => {
      const key = recordProductionDayKey(row);
      return key != null && key >= fromKey && key <= toKey;
    })
    .sort((a, b) => (a.createdAtMs ?? 0) - (b.createdAtMs ?? 0) || a.id.localeCompare(b.id))
    .map((row) => row.doc);
}

// The production date a session's records belong to. It is pinned once,
// when the session starts, and every later write (slot saves, Finalize, the
// shift summary) must reuse it — never re-derive it from the current time,
// or a session finalized after the cutover (or reopened the next day)
// would file its records under the wrong day. In order of preference:
//   1. the productionDate stored on the activeSessions doc;
//   2. the date already pinned in screen state for this session;
//   3. derived from the session's original startedAt (older sessions that
//      pre-date the productionDate field).
// Returns null when none of these is available — callers decide what to do,
// but must not substitute Date.now().
export function resolveSessionProductionDate(src: {
  storedDate?: unknown;
  pinnedDate?: string | null;
  startedAt?: unknown;
}): string | null {
  if (isProductionDayKey(src.storedDate)) return src.storedDate;
  if (isProductionDayKey(src.pinnedDate)) return src.pinnedDate;
  const startedAtMs = timestampToMillis(src.startedAt);
  if (startedAtMs != null) return productionDayKeyFor(startedAtMs);
  return null;
}
