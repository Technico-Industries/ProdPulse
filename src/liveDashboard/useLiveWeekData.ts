// src/liveDashboard/useLiveWeekData.ts
//
// Live Firestore data for the web Live Dashboard: the last 7 production days.
// Same collections and query shapes the app already uses
// (services/productionRecordQueries + services/downtimeSources), but as
// onSnapshot listeners, so every chart updates as soon as a slot is saved,
// a stop starts/ends or a shift is finalized:
//
//   productionRecords  productionDate in [from, to]          (current records)
//   productionRecords  createdAt in the legacy window        (records without productionDate)
//   activeSessions     all (running stops count up to now)
//   endedSessions      productionDate in [from, to]
//   shiftSummaries     productionDate in [from, to]
//   rejectionRecords   date in [from, to] (calendar dates — Record Rejection's own field)
//   productionLines    read once — part names for each line's current model
//
// The two record queries are merged by utils/productionDay
// selectRecordsInProductionRange, exactly like fetchProductionRecordsForDateRange.
// The 7-day window follows the 06:30 production-day cutover.

import { useEffect, useMemo, useRef, useState } from 'react';
import { collection, getDocs, onSnapshot, query, where, Timestamp, QuerySnapshot, DocumentData } from 'firebase/firestore';
import { db } from '../services/firebase';
import { ENDED_SESSIONS_COLLECTION } from '../utils/endProduction';
import {
  DowntimeSessionSource,
  DowntimeSummarySource,
  sessionSourceFromDoc,
  summarySourceFromDoc,
} from '../utils/downtime';
import {
  addDaysToKey,
  legacyCreatedAtWindow,
  productionDayKeyFor,
  selectRecordsInProductionRange,
  StoredRecordRow,
  timestampToMillis,
} from '../utils/productionDay';
import { localDateKey } from '../utils/rejectionDate';
import {
  DASHBOARD_DAYS, DashboardRecord, LiveLine, RejectionTypes, StoppedLine, WeekSummary,
  buildWeekSummary, liveLines, rejectionTypes, stoppedLines, toDashboardRecord, toRunningRecord,
} from '../utils/liveDashboard';
import type { LinePartsLookup } from '../utils/supervisorHandover';

type SourceName = 'records' | 'legacyRecords' | 'activeSessions' | 'endedSessions' | 'shiftSummaries' | 'rejectionRecords';

interface SourceState {
  snap: QuerySnapshot<DocumentData> | null;
  error: string | null;
}

export type LiveStatus = 'loading' | 'ready' | 'error';

export interface LiveWeekData {
  status: LiveStatus;
  errorCode: string | null;           // set when status === 'error'
  week: WeekSummary | null;
  todayKey: string;
  fromKey: string;
  nowMs: number;
  lastUpdateMs: number | null;        // last snapshot received from the server
  reconnecting: boolean;              // listeners serving cached data (connection lost)
  failedSources: SourceName[];        // downtime / rejection sources that could not be read
  stopped: StoppedLine[] | null;      // lines stopped right now (null until activeSessions loads)
  activeLineCount: number;            // lines with a live session
  rejectionTypes: RejectionTypes | null; // null until rejectionRecords loads
  lines: LiveLine[] | null;           // every live session with its production details
}

const RETRY_MS = 15_000;

const EMPTY: Record<SourceName, SourceState> = {
  records: { snap: null, error: null },
  legacyRecords: { snap: null, error: null },
  activeSessions: { snap: null, error: null },
  endedSessions: { snap: null, error: null },
  shiftSummaries: { snap: null, error: null },
  rejectionRecords: { snap: null, error: null },
};

function useClock(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function useLiveWeekData(): LiveWeekData {
  // 30 s tick: running stops count up, and the window moves at 06:30.
  const nowMs = useClock(30_000);
  const todayKey = productionDayKeyFor(nowMs);
  const fromKey = addDaysToKey(todayKey, -(DASHBOARD_DAYS - 1));
  const rejTo = localDateKey(nowMs);
  const rejFrom = addDaysToKey(rejTo, -(DASHBOARD_DAYS - 1));

  const [sources, setSources] = useState<Record<SourceName, SourceState>>(EMPTY);
  const [lastUpdateMs, setLastUpdateMs] = useState<number | null>(null);
  const [partsByLine, setPartsByLine] = useState<LinePartsLookup>({});

  // Part names per line (the same aliases RunningLinesScreen reads), once.
  useEffect(() => {
    let cancelled = false;
    getDocs(collection(db, 'productionLines'))
      .then((snap) => {
        if (cancelled) return;
        const map: LinePartsLookup = {};
        snap.docs.forEach((d) => {
          const data: any = d.data();
          const parts =
            Array.isArray(data.parts) && data.parts.length ? data.parts :
            Array.isArray(data.models) && data.models.length ? data.models :
            Array.isArray(data.partsList) ? data.partsList : [];
          map[d.id] = parts.map((p: any) => ({ name: p?.name ?? p?.partName ?? '' }));
        });
        setPartsByLine(map);
      })
      .catch((e) => console.warn('[LiveDashboard] productionLines read failed', e));
    return () => {
      cancelled = true;
    };
  }, []);
  // Firestore ends a listener that errors; bumping this re-subscribes.
  const [attempt, setAttempt] = useState(0);
  const windowRef = useRef('');

  useEffect(() => {
    // A new window (06:30 rollover) starts empty; a retry keeps what is on screen.
    if (windowRef.current !== `${fromKey}|${todayKey}`) {
      windowRef.current = `${fromKey}|${todayKey}`;
      setSources(EMPTY);
    }
    let retry: ReturnType<typeof setTimeout> | null = null;
    const { startMs, endMs } = legacyCreatedAtWindow(fromKey, todayKey);
    const records = collection(db, 'productionRecords');
    const byDate = (name: string) =>
      query(collection(db, name), where('productionDate', '>=', fromKey), where('productionDate', '<=', todayKey));

    const listen = (name: SourceName, q: Parameters<typeof onSnapshot>[0]) =>
      onSnapshot(
        q as any,
        { includeMetadataChanges: true },
        (snap: QuerySnapshot<DocumentData>) => {
          setSources((s) => ({ ...s, [name]: { snap, error: null } }));
          if (!snap.metadata.fromCache) setLastUpdateMs(Date.now());
        },
        (err: { code?: string }) => {
          console.warn(`[LiveDashboard] ${name} listener failed`, err);
          setSources((s) => ({ ...s, [name]: { snap: s[name].snap, error: err?.code ?? 'unknown' } }));
          if (err?.code !== 'permission-denied' && !retry) retry = setTimeout(() => setAttempt((n) => n + 1), RETRY_MS);
        }
      );

    const stops = [
      listen('records', byDate('productionRecords')),
      listen('legacyRecords', query(records, where('createdAt', '>=', Timestamp.fromMillis(startMs)), where('createdAt', '<', Timestamp.fromMillis(endMs)))),
      listen('activeSessions', collection(db, 'activeSessions')),
      listen('endedSessions', byDate(ENDED_SESSIONS_COLLECTION)),
      listen('shiftSummaries', byDate('shiftSummaries')),
      // rejectionRecords.date is a local calendar date (utils/rejectionDate),
      // not a production date: same 7 calendar days, ending today.
      listen('rejectionRecords', query(collection(db, 'rejectionRecords'), where('date', '>=', rejFrom), where('date', '<=', rejTo))),
    ];
    return () => {
      if (retry) clearTimeout(retry);
      stops.forEach((stop) => stop());
    };
  }, [fromKey, todayKey, rejFrom, rejTo, attempt]);

  const records = useMemo<DashboardRecord[] | null>(() => {
    const a = sources.records.snap;
    const b = sources.legacyRecords.snap;
    if (!a || !b) return null;
    const rows = (snap: QuerySnapshot<DocumentData>): StoredRecordRow<DashboardRecord>[] =>
      snap.docs.map((d) => {
        const data = d.data();
        const createdAtMs = timestampToMillis(data.createdAt);
        return { id: d.id, shift: data.shift ?? 'A', productionDate: data.productionDate, createdAtMs, doc: toDashboardRecord(d.id, data, createdAtMs) };
      });
    return selectRecordsInProductionRange([rows(a), rows(b)], fromKey, todayKey);
  }, [sources.records.snap, sources.legacyRecords.snap, fromKey, todayKey]);

  const week = useMemo<WeekSummary | null>(() => {
    if (!records) return null;
    const sessions = (snap: QuerySnapshot<DocumentData> | null) =>
      (snap?.docs ?? []).map((d) => sessionSourceFromDoc(d.id, d.data())).filter((s): s is DowntimeSessionSource => !!s);
    const summaries = (sources.shiftSummaries.snap?.docs ?? [])
      .map((d) => summarySourceFromDoc(d.data()))
      .filter((s): s is DowntimeSummarySource => !!s);
    return buildWeekSummary({
      todayKey,
      records,
      activeSessions: sessions(sources.activeSessions.snap),
      endedSessions: sessions(sources.endedSessions.snap),
      shiftSummaries: summaries,
      nowMs,
    });
  }, [records, sources.activeSessions.snap, sources.endedSessions.snap, sources.shiftSummaries.snap, todayKey, nowMs]);

  const recordError = sources.records.error ?? sources.legacyRecords.error;
  const status: LiveStatus = recordError && !records ? 'error' : week ? 'ready' : 'loading';
  const failedSources = (['activeSessions', 'endedSessions', 'shiftSummaries', 'rejectionRecords'] as SourceName[]).filter((n) => sources[n].error);

  const live = useMemo(
    () => (sources.activeSessions.snap ? stoppedLines(sources.activeSessions.snap.docs.map((d) => ({ id: d.id, data: d.data() }))) : null),
    [sources.activeSessions.snap]
  );
  const rejections = useMemo(
    () => (sources.rejectionRecords.snap ? rejectionTypes(sources.rejectionRecords.snap.docs.map((d) => ({ data: d.data() }))) : null),
    [sources.rejectionRecords.snap]
  );
  const reconnecting = Object.values(sources).some((s) => s.snap?.metadata.fromCache) || !!recordError;

  const lines = useMemo<LiveLine[] | null>(() => {
    if (!sources.activeSessions.snap || !sources.records.snap || !week) return null;
    return liveLines({
      sessions: sources.activeSessions.snap.docs.map((d) => ({ id: d.id, data: d.data() })),
      records: sources.records.snap.docs.map((d) => toRunningRecord(d.id, d.data())),
      partsByLine,
      downtimeBySession: week.downtimeBySession,
      nowMs,
    });
  }, [sources.activeSessions.snap, sources.records.snap, partsByLine, week, nowMs]);

  return {
    lines,
    status, errorCode: recordError, week, todayKey, fromKey, nowMs, lastUpdateMs, reconnecting, failedSources,
    stopped: live?.stopped ?? null,
    activeLineCount: live?.activeCount ?? 0,
    rejectionTypes: rejections,
  };
}
