// src/utils/downtime.ts
//
// Line stop / resume downtime arithmetic used by RecordProductionScreen.
//
// A stop's persisted start timestamp (epoch ms, StopEvent.startAbs — the
// name is historical, it is NOT a schedule minute) is the single source of
// truth for how long the line has been down. Nothing here depends on a timer
// having run: elapsed time is always `now - startAbs`, so time the app spent
// closed or in the background is counted in full.
//
// Downtime is attributed to production records by TIME OVERLAP with each
// record's window, not by the card the Stop button was pressed on. A stop
// from 14:15 to 15:05 therefore puts 45 min on the 14:00–15:00 record and
// 5 min on the 15:00–16:00 record, and a changeover slot's BEFORE and AFTER
// records each get only the part of the stop that falls inside them. Every
// minute of a stop lies in at most one window, so summing stopEvents[]
// .durationMinutes across records (what every report does) never counts
// the same downtime twice.

export type DowntimeStop = {
  // Stable interval id (`stop-<startAbs>`). Missing on stops recorded before
  // it existed — stopIdOf() derives the same value for those.
  id?: string;
  reason: string;
  startAbs: number; // epoch ms
  endAbs?: number; // epoch ms
  durationMinutes?: number; // full interval length
  running?: boolean;
  breakdownDocId?: string;
};

// One stop's share of a production record's window, as stored in
// productionRecords.stopEvents. durationMinutes is the share (what reports
// sum); startAbs/endAbs and intervalDurationMinutes keep the raw interval for
// auditing.
export type RecordStopEvent = {
  stopId: string;
  reason: string;
  startAbs: number;
  endAbs: number | null;
  durationMinutes: number;
  intervalDurationMinutes: number | null;
};

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

export function stopIdOf(stop: Pick<DowntimeStop, 'id' | 'startAbs'>): string {
  return stop.id ?? `stop-${stop.startAbs}`;
}

export function stopDurationMinutes(startMs: number, endMs: number): number {
  return Math.max(0, round2((endMs - startMs) / 60000));
}

export function isAnyStopRunning(stopsBySlot: Record<string | number, DowntimeStop[]>): boolean {
  return Object.values(stopsBySlot).some((arr) => (arr ?? []).some((s) => s.running));
}

// Closes the running stop(s) of one slot at endMs. A stop that is already
// closed is returned unchanged, so applying this twice (repeated Resume taps,
// retrying a failed save) can never move its end time or add an interval.
export function completeRunningStops<T extends DowntimeStop>(arr: T[], endMs: number): T[] {
  return arr.map((e) =>
    e.running
      ? { ...e, endAbs: endMs, durationMinutes: stopDurationMinutes(e.startAbs, endMs), running: false }
      : e
  );
}

// Every slot's stops with any running stop closed at nowMs (Finalize).
export function freezeRunningStops<T extends DowntimeStop>(
  stopsBySlot: Record<number, T[]>,
  nowMs: number
): Record<number, T[]> {
  const out: Record<number, T[]> = {};
  Object.entries(stopsBySlot).forEach(([k, arr]) => { out[Number(k)] = completeRunningStops(arr ?? [], nowMs); });
  return out;
}

// Minutes of one stop inside [windowStartMs, windowEndMs). A running stop
// counts up to nowMs.
export function stopMinutesInWindow(stop: DowntimeStop, windowStartMs: number, windowEndMs: number, nowMs: number): number {
  const end = stop.endAbs ?? (stop.running ? nowMs : undefined);
  if (end === undefined) return 0;
  const from = Math.max(stop.startAbs, windowStartMs);
  const to = Math.min(end, windowEndMs);
  return to > from ? round2((to - from) / 60000) : 0;
}

// The stopEvents to store on a production record covering
// [windowStartMs, windowEndMs): every stop (from any slot) that overlaps it,
// with durationMinutes = the overlapping minutes.
export function stopEventsForWindow(
  stopsBySlot: Record<number, DowntimeStop[]>,
  windowStartMs: number,
  windowEndMs: number,
  nowMs: number
): RecordStopEvent[] {
  const seen = new Set<string>();
  const out: RecordStopEvent[] = [];
  Object.values(stopsBySlot).forEach((arr) => {
    (arr ?? []).forEach((se) => {
      const id = stopIdOf(se);
      if (seen.has(id)) return; // defensive: one interval is only ever counted once
      const minutes = stopMinutesInWindow(se, windowStartMs, windowEndMs, nowMs);
      if (minutes <= 0) return;
      seen.add(id);
      out.push({
        stopId: id,
        reason: se.reason,
        startAbs: se.startAbs,
        endAbs: se.endAbs ?? null,
        durationMinutes: minutes,
        intervalDurationMinutes: se.durationMinutes ?? null,
      });
    });
  });
  return out.sort((a, b) => a.startAbs - b.startAbs);
}

export function downtimeMinutesInWindow(
  stopsBySlot: Record<number, DowntimeStop[]>,
  windowStartMs: number,
  windowEndMs: number,
  nowMs: number
): number {
  return round2(stopEventsForWindow(stopsBySlot, windowStartMs, windowEndMs, nowMs).reduce((s, e) => s + e.durationMinutes, 0));
}

// Total downtime of a production session: every unique stop interval in the
// session's stopsBySlot (activeSessions/{lineId}) counted once and in full —
// completed stops by their stored duration, a running stop up to nowMs.
// This is the session-level figure; productionRecords' stopEvents hold the
// per-slot shares of the same intervals and must not be added to it.
export function sessionDowntimeMinutes(stopsBySlot: Record<string | number, DowntimeStop[]> | null | undefined, nowMs: number): number {
  const seen = new Set<string>();
  let total = 0;
  Object.values(stopsBySlot ?? {}).forEach((arr) => {
    (Array.isArray(arr) ? arr : []).forEach((se) => {
      if (!se || typeof se.startAbs !== 'number') return;
      const id = stopIdOf(se);
      if (seen.has(id)) return;
      seen.add(id);
      if (se.running) total += stopDurationMinutes(se.startAbs, nowMs);
      else if (typeof se.durationMinutes === 'number') total += Math.max(0, se.durationMinutes);
      else if (typeof se.endAbs === 'number') total += stopDurationMinutes(se.startAbs, se.endAbs);
    });
  });
  return round2(total);
}

// A line's downtime for its current session (one line + production date +
// shift), as the admin Lines overview shows it: the running total of every
// stop so far — completed ones kept after the line resumes, a running one
// counted up to nowMs — plus the running stop's own duration while the
// line is stopped. Same counting as sessionDowntimeMinutes (each interval
// once, by stable id), so a retried Stop/Resume write or several devices
// listening to the same session doc never add a stop twice.
export type LineDowntimeSummary = {
  totalMinutes: number;
  currentStopMinutes: number | null; // null while the line is running
  currentStopStartMs: number | null;
  stopCount: number;
};

export function lineDowntimeSummary(
  stopsBySlot: Record<string | number, DowntimeStop[] | null | undefined> | null | undefined,
  nowMs: number
): LineDowntimeSummary {
  const seen = new Set<string>();
  let current: DowntimeStop | null = null;
  Object.values(stopsBySlot ?? {}).forEach((arr) => {
    (Array.isArray(arr) ? arr : []).forEach((se) => {
      if (!se || typeof se.startAbs !== 'number') return;
      const id = stopIdOf(se);
      if (seen.has(id)) return;
      seen.add(id);
      if (se.running && (!current || se.startAbs > current.startAbs)) current = se;
    });
  });
  const running = current as DowntimeStop | null;
  return {
    totalMinutes: sessionDowntimeMinutes(stopsBySlot as Record<string, DowntimeStop[]>, nowMs),
    currentStopMinutes: running ? stopDurationMinutes(running.startAbs, nowMs) : null,
    currentStopStartMs: running ? running.startAbs : null,
    stopCount: seen.size,
  };
}

// Downtime across saved productionRecords AND still-active sessions, each
// interval counted once. A session that is still running is the authority
// for its own line + production date + shift — its stopsBySlot holds every
// stop, including ones on slots not saved yet — so records of that same
// session are skipped (they only hold per-slot shares of the same
// intervals). Records of finished sessions count as before.
export type DowntimeRecordLike = {
  lineId: string | null;
  productionDate: string | null;
  shift: string | null;
  stopEvents: { durationMinutes?: number | null }[] | null;
};
export type DowntimeSessionLike = {
  lineId: string;
  productionDate: string | null;
  shift: string;
  stopsBySlot: Record<string | number, DowntimeStop[]> | null | undefined;
};
const sessionKey = (lineId: string | null, productionDate: string | null, shift: string | null) =>
  `${lineId ?? ''}|${productionDate ?? ''}|${shift ?? ''}`;

export function combinedDowntimeMinutes(
  records: DowntimeRecordLike[],
  activeSessions: DowntimeSessionLike[],
  nowMs: number
): number {
  return totalDowntimeMinutes(collectDowntimeIntervals({ records, activeSessions }, nowMs));
}

// ─── Downtime for reports and overviews ──────────────────────────────────────
// The one rule every downtime total (Admin Overview, Generate Report) uses.
// A stop is persisted in full in three places, and in shares in a fourth:
//   activeSessions/{lineId}.stopsBySlot   live session — every stop so far,
//                                          a running one up to now;
//   endedSessions/{id}.stopsBySlot        a session an admin ended (archive);
//   shiftSummaries/{line_date_shift}      written at Finalize & End: every
//     .downtimeIntervals                  stop of the session, whole;
//   productionRecords.stopEvents          only the part of a stop inside a
//                                          SAVED slot's window, as it was
//                                          when that slot was saved.
// Records alone miss every stop on a slot that was never saved, every stop
// after its slot was saved, and every stop of a line still running — which
// is why a report built from them showed 0 for a day with hours of
// downtime. So per session (line + production date + shift), each stop is
// counted ONCE, in full, from the first full source that has it (live
// session, then ended archive, then shift summary), keyed by its stable id.
// Record shares are counted only for stops no full source has (e.g. an
// earlier session of the same line/date/shift whose summary a later
// Finalize replaced) — summed per stop across that session's records, whose
// windows never overlap. Record events with no id at all (saved before stop
// ids existed) count only for a session with no full source, as before.
// A stop belongs to its session's production date, so a Shift B stop after
// midnight stays on the night the shift started.

export type DowntimeRecordStopLike = {
  stopId?: string | null;
  reason?: string | null;
  startAbs?: number | null;
  durationMinutes?: number | null;
};
export type DowntimeSummaryLike = {
  lineId: string | null;
  productionDate: string | null;
  shift: string | null;
  downtimeIntervals:
    | { stopId?: string | null; reason?: string | null; startAbs?: number | null; endAbs?: number | null; durationMinutes?: number | null }[]
    | null
    | undefined;
};
export type DowntimeInterval = {
  // `${lineId}|${productionDate}|${shift}`
  sessionKey: string;
  lineId: string | null;
  productionDate: string | null;
  shift: string | null;
  stopId: string | null;
  reason: string;
  minutes: number;
  running: boolean;
  source: 'session' | 'ended' | 'summary' | 'records';
};
export type DowntimeSourcesInput = {
  records: (Omit<DowntimeRecordLike, 'stopEvents'> & { stopEvents: DowntimeRecordStopLike[] | null })[];
  activeSessions?: DowntimeSessionLike[];
  endedSessions?: DowntimeSessionLike[];
  shiftSummaries?: DowntimeSummaryLike[];
};

export function downtimeSessionKey(lineId: string | null, productionDate: string | null, shift: string | null): string {
  return sessionKey(lineId, productionDate, shift);
}

const recordStopId = (se: DowntimeRecordStopLike): string | null =>
  se.stopId ? String(se.stopId) : typeof se.startAbs === 'number' ? stopIdOf({ startAbs: se.startAbs }) : null;

export function collectDowntimeIntervals(input: DowntimeSourcesInput, nowMs: number): DowntimeInterval[] {
  const out: DowntimeInterval[] = [];
  // sessionKey → stop ids already counted from a full source
  const fullIds = new Map<string, Set<string>>();
  const idsOf = (key: string) => {
    let s = fullIds.get(key);
    if (!s) fullIds.set(key, (s = new Set()));
    return s;
  };
  const meta = (lineId: string | null, productionDate: string | null, shift: string | null) => ({
    sessionKey: sessionKey(lineId, productionDate, shift), lineId, productionDate, shift,
  });

  const addSessionStops = (sessions: DowntimeSessionLike[] | undefined, source: 'session' | 'ended') => {
    (sessions ?? []).forEach((s) => {
      const m = meta(s.lineId, s.productionDate, s.shift);
      const ids = idsOf(m.sessionKey);
      Object.values(s.stopsBySlot ?? {}).forEach((arr) => {
        (Array.isArray(arr) ? arr : []).forEach((se) => {
          if (!se || typeof se.startAbs !== 'number') return;
          const id = stopIdOf(se);
          if (ids.has(id)) return;
          let minutes: number | null = null;
          if (se.running) minutes = stopDurationMinutes(se.startAbs, nowMs);
          else if (typeof se.durationMinutes === 'number') minutes = Math.max(0, se.durationMinutes);
          else if (typeof se.endAbs === 'number') minutes = stopDurationMinutes(se.startAbs, se.endAbs);
          if (minutes == null) return;
          ids.add(id);
          out.push({ ...m, stopId: id, reason: se.reason || 'Unspecified', minutes, running: !!se.running, source });
        });
      });
    });
  };
  addSessionStops(input.activeSessions, 'session');
  addSessionStops(input.endedSessions, 'ended');

  (input.shiftSummaries ?? []).forEach((sum) => {
    const m = meta(sum.lineId, sum.productionDate, sum.shift);
    const ids = idsOf(m.sessionKey);
    (Array.isArray(sum.downtimeIntervals) ? sum.downtimeIntervals : []).forEach((iv) => {
      if (!iv) return;
      const id = iv.stopId ? String(iv.stopId) : typeof iv.startAbs === 'number' ? stopIdOf({ startAbs: iv.startAbs }) : null;
      if (!id || ids.has(id)) return;
      const minutes =
        typeof iv.durationMinutes === 'number' ? Math.max(0, iv.durationMinutes)
        : typeof iv.startAbs === 'number' && typeof iv.endAbs === 'number' ? stopDurationMinutes(iv.startAbs, iv.endAbs)
        : null;
      if (minutes == null) return;
      ids.add(id);
      out.push({ ...m, stopId: id, reason: iv.reason || 'Unspecified', minutes, running: false, source: 'summary' });
    });
  });

  // Record shares of stops no full source has, summed per stop.
  const shares = new Map<string, DowntimeInterval>();
  input.records.forEach((r) => {
    const m = meta(r.lineId, r.productionDate, r.shift);
    const full = fullIds.get(m.sessionKey);
    (r.stopEvents ?? []).forEach((se, i) => {
      const minutes = typeof se?.durationMinutes === 'number' ? Math.max(0, se.durationMinutes) : 0;
      if (!se || minutes <= 0) return;
      const id = recordStopId(se);
      if (id === null) {
        if (full && full.size > 0) return; // can't be told apart from a stop already counted
        out.push({ ...m, stopId: null, reason: se.reason || 'Unspecified', minutes, running: false, source: 'records' });
        return;
      }
      if (full?.has(id)) return;
      const k = `${m.sessionKey}#${id}`;
      const prev = shares.get(k);
      if (prev) prev.minutes += minutes;
      else shares.set(k, { ...m, stopId: id, reason: se.reason || 'Unspecified', minutes, running: false, source: 'records' });
    });
  });
  shares.forEach((iv) => out.push(iv));

  return out.map((iv) => ({ ...iv, minutes: round2(iv.minutes) }));
}

export function totalDowntimeMinutes(intervals: DowntimeInterval[]): number {
  return round2(intervals.reduce((s, iv) => s + iv.minutes, 0));
}

// Session key → minutes (for per line/date/shift breakdowns).
export function downtimeBySession(intervals: DowntimeInterval[]): Map<string, number> {
  const map = new Map<string, number>();
  intervals.forEach((iv) => map.set(iv.sessionKey, round2((map.get(iv.sessionKey) ?? 0) + iv.minutes)));
  return map;
}

// Reason → minutes, largest first.
export function downtimeByReason(intervals: DowntimeInterval[]): { reason: string; minutes: number }[] {
  const map = new Map<string, number>();
  intervals.forEach((iv) => map.set(iv.reason, (map.get(iv.reason) ?? 0) + iv.minutes));
  return Array.from(map.entries())
    .map(([reason, minutes]) => ({ reason, minutes: round2(minutes) }))
    .sort((a, b) => b.minutes - a.minutes);
}

// Downtime minutes for KPI display. Rounding policy: under an hour, one
// decimal — the precision the recording screen's stop badges use ("4.2 min";
// a whole value drops the ".0", so 0 → "0 min"). From an hour, nearest whole
// minute as "1h 5m". Display only — stored durations are never rounded.
export function formatDowntimeMinutes(mins: number): string {
  const safe = Number.isFinite(mins) ? Math.max(0, mins) : 0;
  const one = Math.round(safe * 10) / 10;
  if (one < 60) return `${one} min`;
  const total = Math.round(safe);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

// Live stop timer text: MM:SS under an hour, H:MM:SS after.
export function formatElapsedSince(startMs: number, nowMs: number): string {
  const total = Math.max(0, Math.floor((nowMs - startMs) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mmss = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return h > 0 ? `${h}:${mmss}` : mmss;
}

// ─── Firestore docs → downtime sources ───────────────────────────────────────
// Location fields ride along so screens can apply their plant / workshop /
// division / line filters. Anything missing or malformed is read safely
// (legacy docs): no production date → the doc can't be placed on a day and
// is skipped.

export type DowntimeSourceLocation = {
  lineName: string | null;
  plant: string | null;
  workshop: string | null;
  division: string | null;
};
export type DowntimeSessionSource = DowntimeSessionLike & DowntimeSourceLocation;
export type DowntimeSummarySource = DowntimeSummaryLike & DowntimeSourceLocation;

const strOrNull = (v: unknown) => (typeof v === 'string' && v ? v : null);
const location = (d: any): DowntimeSourceLocation => ({
  lineName: strOrNull(d?.lineName),
  plant: strOrNull(d?.plant),
  workshop: strOrNull(d?.workshop),
  division: strOrNull(d?.division),
});

// activeSessions/{lineId} (doc id = line id) or an endedSessions archive
// (a copy of that doc).
export function sessionSourceFromDoc(docId: string, d: any): DowntimeSessionSource | null {
  if (!d || typeof d !== 'object' || !strOrNull(d.productionDate)) return null;
  return {
    lineId: strOrNull(d.lineId) ?? docId,
    productionDate: d.productionDate,
    shift: d.shift === 'B' ? 'B' : 'A',
    stopsBySlot: d.stopsBySlot && typeof d.stopsBySlot === 'object' ? d.stopsBySlot : {},
    ...location(d),
  };
}

export function summarySourceFromDoc(d: any): DowntimeSummarySource | null {
  if (!d || typeof d !== 'object' || !strOrNull(d.productionDate) || !strOrNull(d.lineId)) return null;
  return {
    lineId: d.lineId,
    productionDate: d.productionDate,
    shift: d.shift === 'B' ? 'B' : 'A',
    downtimeIntervals: Array.isArray(d.downtimeIntervals) ? d.downtimeIntervals : [],
    ...location(d),
  };
}

// Whether a source's production date is inside [fromKey, toKey] (both
// inclusive, "YYYY-MM-DD" — compared as strings, like the Firestore query).
export function inProductionRange(productionDate: string | null | undefined, fromKey: string, toKey: string): boolean {
  return typeof productionDate === 'string' && productionDate >= fromKey && productionDate <= toKey;
}
