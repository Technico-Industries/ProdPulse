// src/utils/supervisorShift.ts
//
// Shift scoping for the Supervisor Production Overview.
//
// A line runs Shift A and Shift B on the SAME production day (Shift B keeps
// its start date all night — see utils/productionDay), and both shifts'
// slots are stored in `productionRecords` under that one productionDate.
// Matching records on productionDate + lineId alone therefore added Shift A
// and Shift B together. A record belongs to a supervisor's session only when
// its line, production day AND shift all equal the session's.
//
// The session (activeSessions/{lineId}) is the authority for both the shift
// and the production day; its productionDate is pinned at session start, so
// Shift B's after-midnight slots are already filed under the night they
// started on and need no calendar-date arithmetic here.

import { resolveSessionProductionDate } from './productionDay';

export type ShiftCode = 'A' | 'B';

// Stored shift → 'A' | 'B'. Records saved before the field existed read as
// 'A', the same default RecordProductionScreen and productionRecordQueries use.
export function normalizeShift(v: unknown): ShiftCode {
  return v === 'B' ? 'B' : 'A';
}

export function sessionShiftKey(lineId: string, productionDate: string, shift: ShiftCode): string {
  return `${lineId}|${productionDate}|${shift}`;
}

// The production day a session's records are filed under: the stored
// productionDate, else derived from startedAt (older session docs).
export function sessionProductionDate(s: { productionDate?: unknown; startedAtMs?: number | null }): string | null {
  return resolveSessionProductionDate({ storedDate: s.productionDate, startedAt: s.startedAtMs ?? null });
}

export interface ShiftScopedSession {
  lineId: string;
  shift: ShiftCode;
  productionDate: string | null;
}

export interface ShiftScopedRecord {
  lineId: string | null;
  shift: ShiftCode;
  productionDate: string | null;
}

// Only the records of each session's own line + production day + shift.
export function selectSessionShiftRecords<R extends ShiftScopedRecord>(sessions: ShiftScopedSession[], records: R[]): R[] {
  const keys = new Set<string>();
  sessions.forEach((s) => {
    if (s.productionDate) keys.add(sessionShiftKey(s.lineId, s.productionDate, s.shift));
  });
  return records.filter(
    (r) => r.lineId != null && r.productionDate != null && keys.has(sessionShiftKey(r.lineId, r.productionDate, r.shift))
  );
}
