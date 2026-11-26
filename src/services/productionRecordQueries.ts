// src/services/productionRecordQueries.ts
//
// Loads the productionRecords of a production-date range for the report,
// overview and KPI screens. Records are matched on their productionDate (the
// date pinned when the session started), so an overnight Shift B — including
// slots saved, or a Finalize pressed, after midnight — is reported under the
// night it started on. A second, createdAt-window query picks up older
// records saved before productionDate existed; see
// utils/productionDay selectRecordsInProductionRange for how both are merged.

import { collection, getDocs, query, where, Timestamp, QueryDocumentSnapshot } from 'firebase/firestore';
import { db } from './firebase';
import {
  legacyCreatedAtWindow,
  selectRecordsInProductionRange,
  StoredRecordRow,
  timestampToMillis,
} from '../utils/productionDay';

export async function fetchProductionRecordsForDateRange(fromKey: string, toKey: string): Promise<QueryDocumentSnapshot[]> {
  const records = collection(db, 'productionRecords');
  const { startMs, endMs } = legacyCreatedAtWindow(fromKey, toKey);
  // Single-field range filters only — both are served by Firestore's
  // automatic indexes, no composite index needed.
  // TEMPORARY DIAGNOSTIC (performance audit, step A) — per-query wall time.
  // Both queries still start together (Promise.all), exactly as before.
  const t0 = Date.now();
  const timed = <T,>(label: string, p: Promise<T>) =>
    p.then((v) => {
      console.log(`[productionRecordQueries] ${label} resolved after ${Date.now() - t0}ms`);
      return v;
    });
  const [byDate, byCreatedAt] = await Promise.all([
    timed('byDate', getDocs(query(records, where('productionDate', '>=', fromKey), where('productionDate', '<=', toKey)))),
    timed('byCreatedAt', getDocs(query(
      records,
      where('createdAt', '>=', Timestamp.fromMillis(startMs)),
      where('createdAt', '<', Timestamp.fromMillis(endMs))
    ))),
  ]);
  // TEMPORARY DIAGNOSTIC (step A) — downloaded payload size, measured after
  // the timings above so it does not affect them.
  {
    const tSize = Date.now();
    let total = 0;
    let largest = { id: '', bytes: 0, operators: 0, stopEvents: 0 };
    byDate.docs.forEach((d) => {
      const data: any = d.data();
      const bytes = JSON.stringify(data).length;
      total += bytes;
      if (bytes > largest.bytes) {
        largest = {
          id: d.id,
          bytes,
          operators: Array.isArray(data.operators) ? data.operators.length : 0,
          stopEvents: Array.isArray(data.stopEvents) ? data.stopEvents.length : 0,
        };
      }
    });
    console.log('[productionRecordQueries] byDate payload', {
      docs: byDate.size,
      totalKB: Math.round(total / 1024),
      avgBytes: byDate.size ? Math.round(total / byDate.size) : 0,
      largest,
      sizingMs: Date.now() - tSize,
    });
  }
  const rows = (docs: QueryDocumentSnapshot[]): StoredRecordRow<QueryDocumentSnapshot>[] =>
    docs.map((d) => {
      const data: any = d.data();
      return { id: d.id, shift: data.shift ?? 'A', productionDate: data.productionDate, createdAtMs: timestampToMillis(data.createdAt), doc: d };
    });
  const merged = selectRecordsInProductionRange([rows(byDate.docs), rows(byCreatedAt.docs)], fromKey, toKey);
  // TEMPORARY DIAGNOSTIC (performance audit) — document counts per query.
  console.log('[productionRecordQueries] counts', { fromKey, toKey, byDate: byDate.size, byCreatedAt: byCreatedAt.size, merged: merged.length });
  return merged;
}
