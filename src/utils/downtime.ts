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
  const live = new Set(activeSessions.map((s) => sessionKey(s.lineId, s.productionDate, s.shift)));
  let total = 0;
  records.forEach((r) => {
    if (live.has(sessionKey(r.lineId, r.productionDate, r.shift))) return;
    (r.stopEvents ?? []).forEach((se) => { total += se?.durationMinutes ?? 0; });
  });
  activeSessions.forEach((s) => { total += sessionDowntimeMinutes(s.stopsBySlot, nowMs); });
  return round2(total);
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
