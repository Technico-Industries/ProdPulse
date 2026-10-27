// src/services/downtimeSources.ts
//
// Loads the full stop intervals of a production-date range — live
// activeSessions, admin-ended endedSessions archives and Finalize's
// shiftSummaries — for utils/downtime collectDowntimeIntervals, which
// Admin Overview and Generate Report both total downtime with. All three are
// matched on productionDate (pinned when the session started), so Shift B
// stops after midnight stay on the night the shift started.
//
// Single-field range filters only (automatic indexes). activeSessions has
// one doc per running line, so it is read whole and filtered here. A source
// that fails to load is reported in `failed` and left out; the caller still
// has the record shares for those sessions.

import { collection, getDocs, query, where } from 'firebase/firestore';
import { db } from './firebase';
import { ENDED_SESSIONS_COLLECTION } from '../utils/endProduction';
import {
  DowntimeSessionSource,
  DowntimeSummarySource,
  inProductionRange,
  sessionSourceFromDoc,
  summarySourceFromDoc,
} from '../utils/downtime';

export type DowntimeSources = {
  activeSessions: DowntimeSessionSource[];
  endedSessions: DowntimeSessionSource[];
  shiftSummaries: DowntimeSummarySource[];
  failed: ('activeSessions' | 'endedSessions' | 'shiftSummaries')[];
};

const inRange = inProductionRange;

export async function fetchDowntimeSourcesForDateRange(
  fromKey: string,
  toKey: string,
  opts: { skipActive?: boolean } = {}
): Promise<DowntimeSources> {
  const byDate = (name: string) =>
    getDocs(query(collection(db, name), where('productionDate', '>=', fromKey), where('productionDate', '<=', toKey)));
  const [active, ended, summaries] = await Promise.allSettled([
    opts.skipActive ? Promise.resolve(null) : getDocs(collection(db, 'activeSessions')),
    byDate(ENDED_SESSIONS_COLLECTION),
    byDate('shiftSummaries'),
  ]);
  const failed: DowntimeSources['failed'] = [];
  const settled = <T>(r: PromiseSettledResult<T>, name: DowntimeSources['failed'][number]): T | null => {
    if (r.status === 'fulfilled') return r.value;
    console.warn(`[downtimeSources] ${name} could not be loaded`, r.reason);
    failed.push(name);
    return null;
  };
  const activeSnap = settled(active, 'activeSessions');
  const endedSnap = settled(ended, 'endedSessions');
  const summarySnap = settled(summaries, 'shiftSummaries');
  return {
    activeSessions: (activeSnap?.docs ?? [])
      .map((d) => sessionSourceFromDoc(d.id, d.data()))
      .filter((s): s is DowntimeSessionSource => !!s && inRange(s.productionDate, fromKey, toKey)),
    endedSessions: (endedSnap?.docs ?? [])
      .map((d) => sessionSourceFromDoc(d.id, d.data()))
      .filter((s): s is DowntimeSessionSource => !!s && inRange(s.productionDate, fromKey, toKey)),
    shiftSummaries: (summarySnap?.docs ?? [])
      .map((d) => summarySourceFromDoc(d.data()))
      .filter((s): s is DowntimeSummarySource => !!s && inRange(s.productionDate, fromKey, toKey)),
    failed,
  };
}
