// functions/src/tvDashboard/store.ts
//
// Persistence of the TV read model and the read-only source access it needs.
//
//   tvDashboard/assembly                      overview (one doc, ≤ 1 write/min)
//   tvDashboard/assembly/lines/{lineId}       one sanitised doc per Assembly line
//   tvDashboard/assembly/days/{productionDate} one aggregate doc per production date
//
// Source collections are only READ (no transaction ever touches them, so the
// app's own writes are never blocked). Every read-model write goes through a
// transaction on the read-model doc itself and the pure plan*Commit rules
// below: a computation that started earlier never overwrites one that
// started later, identical content is not rewritten, and a finalised day is
// not replaced by live data. The in-memory store used by the tests applies
// the very same plan functions.

import type { DocumentReference, Firestore, QuerySnapshot, Transaction } from 'firebase-admin/firestore';
import { firestoreDataSource } from '../dataSource';
import {
  Data, DayDocContent, LineDocContent, OverviewContent, RawDoc, StoredMeta, TV_ROOT, WriteDecision,
  contentHash, decideOverviewWrite, decideWrite,
} from './core';
import type { ShiftCode } from '../../../src/utils/productionSchedule';

// ─── Interfaces (mocked in tests) ────────────────────────────────────────────

export interface TvSources {
  getLine(lineId: string): Promise<Data | null>;
  getActiveSession(lineId: string): Promise<Data | null>;
  getLineRecordsForDate(lineId: string, productionDate: string): Promise<RawDoc[]>;
  getShiftSummary(lineId: string, productionDate: string, shift: ShiftCode): Promise<Data | null>;
  getLineEndedSessionsForDate(lineId: string, productionDate: string): Promise<Data[]>;
  listLines(): Promise<RawDoc[]>;
  listActiveSessions(): Promise<RawDoc[]>;
  getRecordsForDate(productionDate: string): Promise<RawDoc[]>;
  getShiftSummariesForDate(productionDate: string): Promise<Data[]>;
  getEndedSessionsForDate(productionDate: string): Promise<Data[]>;
}

export interface StoredLine { id: string; content: LineDocContent; computedAtMs: number | null; updatedAtMs: number | null }
export interface StoredDay { content: DayDocContent | null; computedAtMs: number | null; dirty: boolean; dirtyAtMs: number | null }
export interface OverviewFreshness {
  generatedAtMs: number;
  heartbeatMs: number;
  complete: boolean;              // false when any line / day / the sweep listing failed this run
  lineDocCount: number;
  linesRecomputed: number;        // successful recomputes this run
  failedLines: string[];          // line ids whose recompute failed (last good doc kept, or none)
  daysRebuilt: string[];
  failedDays: string[];           // dates whose doc could not be rebuilt / committed (shown as unavailable)
  sweepFailed: boolean;           // the 15-minute sweep could not list lines / sessions
  staleLineDocs: number;          // line docs not (yet) on the dashboard's production date
  oldestLineComputedAtMs: number | null;
  newestLineUpdatedAtMs: number | null;
}

export interface TvStore {
  listLineDocs(): Promise<StoredLine[]>;
  commitLine(lineId: string, content: LineDocContent | null, computedAtMs: number): Promise<WriteDecision>;
  getDays(dates: string[]): Promise<Record<string, StoredDay | null>>;
  commitDay(date: string, content: DayDocContent, computedAtMs: number, opts: { protectFinal: boolean }): Promise<WriteDecision>;
  markDaysDirty(dates: string[], atMs: number): Promise<void>;
  commitOverview(content: OverviewContent, generatedAtMs: number, freshness: OverviewFreshness): Promise<WriteDecision>;
}

// ─── Pure commit plans (shared by the Firestore and in-memory stores) ────────

export type Plan = { decision: WriteDecision; set?: Data; del?: boolean };

export function planLineCommit(existing: Data | null, content: LineDocContent | null, computedAtMs: number): Plan {
  const hash = content ? contentHash(content) : null;
  const decision = decideWrite(existing as StoredMeta | null, { computedAtMs, hash });
  if (decision === 'write') return { decision, set: { ...content, contentHash: hash, computedAtMs, updatedAtMs: computedAtMs } };
  if (decision === 'delete') return { decision, del: true };
  return { decision };
}

// A day doc may carry a dirty flag set by a source write. It is cleared only
// by a computation that started after the flag was set; a newer flag stays.
export function planDayCommit(existing: Data | null, content: DayDocContent, computedAtMs: number, protectFinal: boolean): Plan {
  const hash = contentHash(content);
  const hasContent = !!existing && typeof existing.contentHash === 'string';
  let decision = decideWrite(hasContent ? (existing as StoredMeta) : null, { computedAtMs, hash }, { protectFinal });
  const dirtyAtMs = typeof existing?.dirtyAtMs === 'number' ? existing.dirtyAtMs : null;
  const keepDirty = existing?.dirty === true && dirtyAtMs != null && dirtyAtMs > computedAtMs;
  if (decision === 'unchanged' && existing?.dirty === true && !keepDirty) decision = 'write';
  if (decision !== 'write') return { decision };
  return {
    decision,
    set: { ...content, contentHash: hash, computedAtMs, updatedAtMs: computedAtMs, dirty: keepDirty, dirtyAtMs: keepDirty ? dirtyAtMs : null },
  };
}

export function planOverviewCommit(existing: Data | null, content: OverviewContent, generatedAtMs: number, freshness: OverviewFreshness): Plan {
  const hash = contentHash(content);
  const decision = decideOverviewWrite(existing as any, hash, generatedAtMs);
  if (decision !== 'write') return { decision };
  return { decision, set: { ...content, contentHash: hash, generatedAtMs, freshness } };
}

export function parseStoredLine(id: string, d: Data | null | undefined): StoredLine | null {
  if (!d || d.schemaVersion == null || !d.day || !d.current) return null;
  const { contentHash: _h, computedAtMs, updatedAtMs, ...content } = d;
  return {
    id,
    content: content as LineDocContent,
    computedAtMs: typeof computedAtMs === 'number' ? computedAtMs : null,
    updatedAtMs: typeof updatedAtMs === 'number' ? updatedAtMs : null,
  };
}

export function parseStoredDay(d: Data | null | undefined): StoredDay | null {
  if (!d) return null;
  const hasContent = typeof d.contentHash === 'string' && d.schemaVersion != null;
  let content: DayDocContent | null = null;
  if (hasContent) {
    const { contentHash: _h, computedAtMs: _c, updatedAtMs: _u, dirty: _d, dirtyAtMs: _da, ...rest } = d;
    content = rest as DayDocContent;
  }
  return {
    content,
    computedAtMs: typeof d.computedAtMs === 'number' ? d.computedAtMs : null,
    dirty: d.dirty === true,
    dirtyAtMs: typeof d.dirtyAtMs === 'number' ? d.dirtyAtMs : null,
  };
}

// ─── Firestore implementations ───────────────────────────────────────────────

export function firestoreTvSources(db: Firestore): TvSources {
  const data = async (path: string) => {
    const snap = await db.doc(path).get();
    return snap.exists ? (snap.data() ?? null) : null;
  };
  const raw = (snap: QuerySnapshot): RawDoc[] => snap.docs.map((d) => ({ id: d.id, data: d.data() }));
  const legacyAware = firestoreDataSource(db);
  return {
    getLine: (lineId) => data(`productionLines/${lineId}`),
    getActiveSession: (lineId) => data(`activeSessions/${lineId}`),
    // Equality filters only — served by Firestore's automatic indexes (the
    // app runs the same shape of query, RecordProductionScreen.tsx:300-310).
    getLineRecordsForDate: async (lineId, date) =>
      raw(await db.collection('productionRecords').where('lineId', '==', lineId).where('productionDate', '==', date).get()),
    getShiftSummary: (lineId, date, shift) => data(`shiftSummaries/${lineId}_${date}_${shift}`),
    getLineEndedSessionsForDate: async (lineId, date) =>
      (await db.collection('endedSessions').where('lineId', '==', lineId).where('productionDate', '==', date).get()).docs.map((d) => d.data()),
    listLines: async () => raw(await db.collection('productionLines').limit(2000).get()),
    listActiveSessions: async () => raw(await db.collection('activeSessions').limit(2000).get()),
    // The AI backend's reader: productionDate range + legacy createdAt window,
    // merged by utils/productionDay selectRecordsInProductionRange.
    getRecordsForDate: (date) => legacyAware.getProductionRecords(date, date),
    getShiftSummariesForDate: async (date) =>
      (await db.collection('shiftSummaries').where('productionDate', '==', date).get()).docs.map((d) => d.data()),
    getEndedSessionsForDate: async (date) =>
      (await db.collection('endedSessions').where('productionDate', '==', date).get()).docs.map((d) => d.data()),
  };
}

export function firestoreTvStore(db: Firestore): TvStore {
  const root = db.doc(TV_ROOT);
  const lines = root.collection('lines');
  const days = root.collection('days');

  const apply = (tx: Transaction, ref: DocumentReference, plan: Plan) => {
    if (plan.set) tx.set(ref, plan.set);
    else if (plan.del) tx.delete(ref);
    return plan.decision;
  };

  return {
    async listLineDocs() {
      const snap = await lines.get();
      return snap.docs.map((d) => parseStoredLine(d.id, d.data())).filter((l): l is StoredLine => !!l);
    },
    commitLine(lineId, content, computedAtMs) {
      const ref = lines.doc(lineId);
      return db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        return apply(tx, ref, planLineCommit(snap.exists ? (snap.data() ?? null) : null, content, computedAtMs));
      });
    },
    async getDays(dates) {
      if (!dates.length) return {};
      const snaps = await db.getAll(...dates.map((d) => days.doc(d)));
      const out: Record<string, StoredDay | null> = {};
      snaps.forEach((s, i) => { out[dates[i]] = s.exists ? parseStoredDay(s.data()) : null; });
      return out;
    },
    commitDay(date, content, computedAtMs, opts) {
      const ref = days.doc(date);
      return db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        return apply(tx, ref, planDayCommit(snap.exists ? (snap.data() ?? null) : null, content, computedAtMs, opts.protectFinal));
      });
    },
    async markDaysDirty(dates, atMs) {
      if (!dates.length) return;
      const batch = db.batch();
      dates.forEach((d) => batch.set(days.doc(d), { productionDate: d, dirty: true, dirtyAtMs: atMs }, { merge: true }));
      await batch.commit();
    },
    commitOverview(content, generatedAtMs, freshness) {
      return db.runTransaction(async (tx) => {
        const snap = await tx.get(root);
        return apply(tx, root, planOverviewCommit(snap.exists ? (snap.data() ?? null) : null, content, generatedAtMs, freshness));
      });
    },
  };
}
