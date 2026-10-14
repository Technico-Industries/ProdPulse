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
