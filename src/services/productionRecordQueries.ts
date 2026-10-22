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
  const [byDate, byCreatedAt] = await Promise.all([
    getDocs(query(records, where('productionDate', '>=', fromKey), where('productionDate', '<=', toKey))),
    getDocs(query(
      records,
      where('createdAt', '>=', Timestamp.fromMillis(startMs)),
      where('createdAt', '<', Timestamp.fromMillis(endMs))
    )),
  ]);
  const rows = (docs: QueryDocumentSnapshot[]): StoredRecordRow<QueryDocumentSnapshot>[] =>
    docs.map((d) => {
      const data: any = d.data();
      return { id: d.id, shift: data.shift ?? 'A', productionDate: data.productionDate, createdAtMs: timestampToMillis(data.createdAt), doc: d };
    });
  return selectRecordsInProductionRange([rows(byDate.docs), rows(byCreatedAt.docs)], fromKey, toKey);
}
