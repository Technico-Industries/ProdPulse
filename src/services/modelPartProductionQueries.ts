// src/services/modelPartProductionQueries.ts
//
// Firestore side of the Model / Part Production page. The admin check runs
// first (utils/modelPartProduction loadRecordsForAdmin); the records come
// from the same production-date range query Generate Report uses.

import { doc, getDoc } from 'firebase/firestore';
import { db } from './firebase';
import { fetchProductionRecordsForDateRange } from './productionRecordQueries';
import { loadRecordsForAdmin, mapProductionRecord, MPRecord } from '../utils/modelPartProduction';

export function loadModelPartRecords(
  user: { uid: string; role?: string | null } | null,
  fromKey: string,
  toKey: string
): Promise<MPRecord[]> {
  return loadRecordsForAdmin(user, fromKey, toKey, {
    getProfile: async (uid) => {
      const snap = await getDoc(doc(db, 'users', uid));
      return snap.exists() ? snap.data() : null;
    },
    fetchRecords: async (from, to) =>
      (await fetchProductionRecordsForDateRange(from, to)).map((d) => mapProductionRecord(d.id, d.data())),
  });
}
