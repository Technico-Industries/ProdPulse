// functions/src/dataSource.ts
//
// The ONLY Firestore access the AI backend has. Every read goes through the
// fixed collection names below with fixed query shapes — the model never
// supplies a collection name, a field name or a query. There is no write,
// update or delete anywhere in this file.
//
// productionRecords are selected exactly like the app's report screens
// (src/services/productionRecordQueries fetchProductionRecordsForDateRange):
// by productionDate, plus the legacy createdAt window, merged by
// utils/productionDay selectRecordsInProductionRange — so an overnight
// Shift B stays on the night it started.

import type { Firestore, QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { Timestamp } from 'firebase-admin/firestore';
import {
  legacyCreatedAtWindow,
  selectRecordsInProductionRange,
  StoredRecordRow,
  timestampToMillis,
} from '../../src/utils/productionDay';

export const COLLECTIONS = {
  productionRecords: 'productionRecords',
  productionLines: 'productionLines',
  activeSessions: 'activeSessions',
  rejectionRecords: 'rejectionRecords',
  users: 'users',
} as const;

// One question may not read more than this many docs per query; a range
// that needs more is refused with a clear message instead of a slow,
// expensive, partial answer.
export const MAX_DOCS_PER_QUERY = 20000;

export class DataLimitError extends Error {
  constructor(what: string) {
    super(`Too many ${what} in this range to analyse in one question. Choose a shorter date range.`);
    this.name = 'DataLimitError';
  }
}

export type RawDoc = { id: string; data: Record<string, any> };

export interface ProductionDataSource {
  getUserProfile(uid: string): Promise<Record<string, any> | null>;
  // Raw productionRecords docs whose production date is in [fromKey, toKey].
  getProductionRecords(fromKey: string, toKey: string): Promise<RawDoc[]>;
  getProductionLines(): Promise<RawDoc[]>;
  getActiveSessions(): Promise<RawDoc[]>;
  // rejectionRecords whose calendar `date` is in [fromKey, toKey].
  getRejectionLog(fromKey: string, toKey: string): Promise<RawDoc[]>;
}

const toRaw = (d: QueryDocumentSnapshot): RawDoc => ({ id: d.id, data: d.data() });

function capped(docs: QueryDocumentSnapshot[], what: string) {
  if (docs.length > MAX_DOCS_PER_QUERY) throw new DataLimitError(what);
  return docs;
}

export function firestoreDataSource(db: Firestore): ProductionDataSource {
  return {
    async getUserProfile(uid) {
      const snap = await db.collection(COLLECTIONS.users).doc(uid).get();
      return snap.exists ? (snap.data() ?? null) : null;
    },

    async getProductionRecords(fromKey, toKey) {
      const records = db.collection(COLLECTIONS.productionRecords);
      const { startMs, endMs } = legacyCreatedAtWindow(fromKey, toKey);
      // Single-field range filters only — served by automatic indexes.
      const [byDate, byCreatedAt] = await Promise.all([
        records.where('productionDate', '>=', fromKey).where('productionDate', '<=', toKey).limit(MAX_DOCS_PER_QUERY + 1).get(),
        records
          .where('createdAt', '>=', Timestamp.fromMillis(startMs))
          .where('createdAt', '<', Timestamp.fromMillis(endMs))
          .limit(MAX_DOCS_PER_QUERY + 1)
          .get(),
      ]);
      const rows = (docs: QueryDocumentSnapshot[]): StoredRecordRow<RawDoc>[] =>
        capped(docs, 'production records').map((d) => {
          const data = d.data();
          return { id: d.id, shift: data.shift ?? 'A', productionDate: data.productionDate, createdAtMs: timestampToMillis(data.createdAt), doc: toRaw(d) };
        });
      return selectRecordsInProductionRange([rows(byDate.docs), rows(byCreatedAt.docs)], fromKey, toKey);
    },

    async getProductionLines() {
      const snap = await db.collection(COLLECTIONS.productionLines).limit(2000).get();
      return snap.docs.map(toRaw);
    },

    async getActiveSessions() {
      const snap = await db.collection(COLLECTIONS.activeSessions).limit(2000).get();
      return snap.docs.map(toRaw);
    },

    async getRejectionLog(fromKey, toKey) {
      const snap = await db
        .collection(COLLECTIONS.rejectionRecords)
        .where('date', '>=', fromKey)
        .where('date', '<=', toKey)
        .limit(MAX_DOCS_PER_QUERY + 1)
        .get();
      return capped(snap.docs, 'rejection log entries').map(toRaw);
    },
  };
}
