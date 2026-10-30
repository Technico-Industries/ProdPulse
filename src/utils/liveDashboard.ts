// src/utils/liveDashboard.ts
//
// Day-by-day figures for the web Live Dashboard (/live-dashboard): the last
// 7 production days, today included. Pure — no Firebase, no React — so it is
// checked by scripts/testLiveDashboard.ts.
//
// The formulas are the Admin Overview's (src/screens/AdminOverviewScreen.tsx
// header), applied per production date, so the TV and the admin screen agree:
//   goodProduction = Σ producedThisSlot
//   plan           = Σ expectedParts
//   achievementPct = goodProduction / plan × 100 (round1; null without plan)
//   lossParts      = Σ (lossParts ?? max(0, expectedParts − producedThisSlot))
//   rejections     = utils/qualityMetrics counterQuality (records with the
//                    counter only — legacy records leave quality unknown)
//   downtime       = utils/downtime collectDowntimeIntervals over records,
//                    live activeSessions, endedSessions and shiftSummaries,
//                    each stop once (running stops up to now)

import { addDaysToKey, recordProductionDayKey, timestampToMillis } from './productionDay';
import { counterQuality } from './qualityMetrics';
import {
  DowntimeRecordStopLike,
  DowntimeSessionLike,
  DowntimeSummaryLike,
  collectDowntimeIntervals,
  downtimeByReason,
  downtimeBySession,
  downtimeSessionKey,
} from './downtime';
import { LiveSession, currentStop, formatStopReason, recordsForSession } from './lineEfficiency';
import { buildSlots } from './productionSchedule';
import {
  LinePartsLookup,
  RunningLineCard,
  RunningRecord,
  RunningSession,
  SlotEntryState,
  buildRunningLineCards,
  parseRunningSession,
} from './supervisorHandover';
import { RestoreRecord, pickSlotRecords } from './productionDraft';

export const DASHBOARD_DAYS = 7;

export interface DashboardRecord {
  id: string;
  lineId: string | null;
  shift: string | null;
  // Resolved production date (recordProductionDayKey), null when unknown.
  productionDate: string | null;
  producedThisSlot: number | null;
  expectedParts: number | null;
  lossParts: number | null;
  rejections: number | null;
  stopEvents: DowntimeRecordStopLike[] | null;
}

export interface DaySummary {
  productionDate: string;
  isToday: boolean;
  recordCount: number;
  goodProduction: number;
  plan: number;
  achievementPct: number | null;
  lossParts: number;
  rejectedParts: number | null;  // null = only legacy records (no counter)
  rejectionPct: number | null;
  qualityPct: number | null;
  downtimeMinutes: number;
}

export interface ReasonMinutes { reason: string; label: string; minutes: number }

export interface WeekSummary {
  days: DaySummary[];               // oldest first, today last
  downtimeReasons: ReasonMinutes[]; // whole week, largest first
  totals: Omit<DaySummary, 'productionDate' | 'isToday'>;
  runningStops: number;             // stops still running now (today's live sessions)
  calendarWeek: CalendarWeek;       // plan vs actual, Monday → Sunday of this week
  downtimeBySession: Map<string, number>; // `${lineId}|${productionDate}|${shift}` → minutes
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// The 7 production dates ending at `todayKey`, oldest first.
export function dashboardDays(todayKey: string, count = DASHBOARD_DAYS): string[] {
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) out.push(addDaysToKey(todayKey, -i));
  return out;
}

// A productionRecords document → the fields the dashboard uses (the same
// fields AdminOverviewScreen maps).
export function toDashboardRecord(id: string, data: any, createdAtMs: number | null): DashboardRecord {
  const shift = data?.shift ?? 'A';
  return {
    id,
    lineId: data?.lineId ?? null,
    shift,
    productionDate: recordProductionDayKey({ productionDate: data?.productionDate, shift, createdAtMs }),
    producedThisSlot: num(data?.producedThisSlot),
    expectedParts: num(data?.expectedParts),
    lossParts: num(data?.lossParts),
    rejections: num(data?.rejections),
    stopEvents: Array.isArray(data?.stopEvents) ? data.stopEvents : null,
  };
}

function figuresOf(records: DashboardRecord[], downtimeMinutes: number) {
  let goodProduction = 0;
  let plan = 0;
  let lossParts = 0;
  records.forEach((r) => {
    const produced = r.producedThisSlot ?? 0;
    const expected = r.expectedParts ?? 0;
    goodProduction += produced;
    plan += expected;
    lossParts += r.lossParts ?? Math.max(0, expected - produced);
  });
  const q = counterQuality(records);
  return {
    recordCount: records.length,
    goodProduction,
    plan,
    achievementPct: plan > 0 ? round1((goodProduction / plan) * 100) : null,
    lossParts: Math.round(lossParts),
    rejectedParts: records.length ? q.rejectedParts : 0,
    rejectionPct: q.rejectionPct,
    qualityPct: q.qualityPct,
    downtimeMinutes: round2(downtimeMinutes),
  };
}

export function buildWeekSummary(input: {
  todayKey: string;
  records: DashboardRecord[];
  activeSessions: DowntimeSessionLike[];
  endedSessions: DowntimeSessionLike[];
  shiftSummaries: DowntimeSummaryLike[];
  nowMs: number;
}): WeekSummary {
  const days = dashboardDays(input.todayKey);
  const inWeek = new Set(days);
  const records = input.records.filter((r) => r.productionDate != null && inWeek.has(r.productionDate));
  const inWeekSource = <T extends { productionDate: string | null }>(s: T) => s.productionDate != null && inWeek.has(s.productionDate);

  const intervals = collectDowntimeIntervals(
    {
      records,
      activeSessions: input.activeSessions.filter(inWeekSource),
      endedSessions: input.endedSessions.filter(inWeekSource),
      shiftSummaries: input.shiftSummaries.filter(inWeekSource),
    },
    input.nowMs
  );

  const downtimeByDay = new Map<string, number>();
  intervals.forEach((iv) => {
    if (iv.productionDate) downtimeByDay.set(iv.productionDate, (downtimeByDay.get(iv.productionDate) ?? 0) + iv.minutes);
  });

  const byDay = new Map<string, DashboardRecord[]>(days.map((d) => [d, []]));
  records.forEach((r) => byDay.get(r.productionDate!)!.push(r));

  const daySummaries: DaySummary[] = days.map((d) => ({
    productionDate: d,
    isToday: d === input.todayKey,
    ...figuresOf(byDay.get(d)!, downtimeByDay.get(d) ?? 0),
  }));
  return {
    days: daySummaries,
    downtimeReasons: downtimeByReason(intervals).map((r) => ({ ...r, label: reasonLabel(r.reason) })),
    totals: figuresOf(records, intervals.reduce((s, iv) => s + iv.minutes, 0)),
    runningStops: intervals.filter((iv) => iv.running).length,
    calendarWeek: calendarWeek(input.todayKey, daySummaries, records),
    downtimeBySession: downtimeBySession(intervals),
  };
}

// ─── Plan vs actual, this calendar week (Monday → Sunday) ───────────────────

export interface WeekDayPlan {
  productionDate: string;
  isToday: boolean;
  isFuture: boolean;              // after today: no figures yet
  goodProduction: number | null;
  plan: number | null;
  achievementPct: number | null;
}

export interface CalendarWeek {
  days: WeekDayPlan[];            // Monday first, always 7
  totals: { goodProduction: number; plan: number; achievementPct: number | null; lossParts: number };
}

// Monday of the week containing `key` ("YYYY-MM-DD", read as a calendar date).
export function mondayOf(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return addDaysToKey(key, -((dow + 6) % 7));
}

// Monday → today always lies inside the 7-day window, so the week's figures
// come from the same day summaries (same formulas) as every other chart.
export function calendarWeek(todayKey: string, days: DaySummary[], records: DashboardRecord[]): CalendarWeek {
  const monday = mondayOf(todayKey);
  const byDate = new Map(days.map((d) => [d.productionDate, d]));
  const keys = Array.from({ length: 7 }, (_, i) => addDaysToKey(monday, i));
  const weekRecords = records.filter((r) => r.productionDate != null && r.productionDate >= monday && r.productionDate <= todayKey);
  const t = figuresOf(weekRecords, 0);
  return {
    days: keys.map((k) => {
      const d = byDate.get(k);
      const isFuture = k > todayKey;
      return {
        productionDate: k,
        isToday: k === todayKey,
        isFuture,
        goodProduction: isFuture ? null : d?.goodProduction ?? 0,
        plan: isFuture ? null : d?.plan ?? 0,
        achievementPct: isFuture ? null : d?.achievementPct ?? null,
      };
    }),
    totals: { goodProduction: t.goodProduction, plan: t.plan, achievementPct: t.achievementPct, lossParts: t.lossParts },
  };
}

// ─── Lines stopped right now ──────────────────────────────────────────────────

export interface StoppedLine {
  lineId: string;
  lineName: string;
  plant: string | null;
  shift: string | null;
  reason: string | null;   // display label (formatStopReason), null = not recorded
  sinceMs: number | null;
}

// activeSessions flagged lineStopped, with the running stop from the app's
// own currentStop() (utils/lineEfficiency — what Line Efficiency shows).
// Longest-stopped first.
export function stoppedLines(sessions: { id: string; data: any }[]): { stopped: StoppedLine[]; activeCount: number } {
  const stopped: StoppedLine[] = [];
  sessions.forEach(({ id, data }) => {
    if (data?.lineStopped !== true) return;
    const session: LiveSession = {
      lineId: data.lineId ?? id,
      lineName: data.lineName ?? null,
      shift: data.shift ?? null,
      productionDate: data.productionDate ?? null,
      lineStopped: true,
      stopsBySlot: data.stopsBySlot ?? null,
      startedAtMs: null,
      updatedAtMs: null,
    };
    const stop = currentStop(session);
    stopped.push({
      lineId: session.lineId,
      lineName: session.lineName || session.lineId,
      plant: data.plant ?? null,
      shift: session.shift,
      reason: stop.label,
      sinceMs: stop.sinceMs,
    });
  });
  stopped.sort((a, b) => (a.sinceMs ?? Infinity) - (b.sinceMs ?? Infinity) || a.lineName.localeCompare(b.lineName));
  return { stopped, activeCount: sessions.length };
}

// ─── Types of rejection (Record Rejection entries) ───────────────────────────

export interface RejectionTypeRow { defect: string; stage: string | null; qty: number; count: number }

export interface RejectionTypes {
  total: number;
  types: RejectionTypeRow[];                       // Σ rejectionQty per defect, high → low
  stages: { stage: string; qty: number }[];        // Σ rejectionQty per stage (Visual / Process / Dimension)
}

// rejectionRecords grouped like the Quality Report (QualityOverviewScreen
// aggregateQty): Σ rejectionQty per key, sorted high → low. These are the
// Record Rejection entries — a separate log from the production counter, so
// their total can differ from "Rejections per day".
export function rejectionTypes(docs: { data: any }[]): RejectionTypes {
  const byDefect = new Map<string, RejectionTypeRow>();
  const byStage = new Map<string, number>();
  let total = 0;
  docs.forEach(({ data }) => {
    const qty = num(data?.rejectionQty) ?? 0;
    const defect = typeof data?.defect === 'string' && data.defect.trim() ? data.defect.trim() : 'Unspecified';
    const stage = typeof data?.stage === 'string' && data.stage.trim() ? data.stage.trim() : null;
    total += qty;
    const row = byDefect.get(defect) ?? { defect, stage, qty: 0, count: 0 };
    row.qty += qty;
    row.count += 1;
    byDefect.set(defect, row);
    const sk = stage ?? 'Unspecified';
    byStage.set(sk, (byStage.get(sk) ?? 0) + qty);
  });
  return {
    total,
    types: Array.from(byDefect.values()).sort((a, b) => b.qty - a.qty || a.defect.localeCompare(b.defect)),
    stages: Array.from(byStage, ([stage, qty]) => ({ stage, qty })).sort((a, b) => b.qty - a.qty),
  };
}

// ─── Running lines page (swipe right on the dashboard) ───────────────────────

export interface LiveSlot {
  index: number;
  hour: string;                    // "07"
  range: string;                   // "7–8" (24-hour clock, from the slot's nominal hour)
  state: SlotEntryState;
  produced: number | null;         // Σ producedThisSlot of the slot's saved record(s)
  expected: number | null;         // Σ expectedParts
}

export interface LiveLine {
  card: RunningLineCard;           // supervisorHandover.buildRunningLineCards — the Running Lines screen's card
  plant: string | null;
  achievementPct: number | null;   // card.actual / card.planToDate (round1), the same figure as efficiencyOf
  stop: { reason: string | null; sinceMs: number | null } | null;
  downtimeMinutes: number;         // this session's stops (collectDowntimeIntervals rule)
  slots: LiveSlot[];
}

// Minute of the production day → "7", "15:30", "1" (24-hour clock, minutes only when not on the hour).
function clockLabel(minuteAbs: number): string {
  const h = Math.floor(minuteAbs / 60) % 24;
  const m = minuteAbs % 60;
  return m ? `${h}:${String(m).padStart(2, '0')}` : `${h}`;
}

export function toRunningRecord(id: string, r: any): RunningRecord {
  return {
    id,
    lineId: r?.lineId ?? null,
    shift: r?.shift ?? null,
    productionDate: r?.productionDate ?? null,
    expectedParts: num(r?.expectedParts),
    producedThisSlot: num(r?.producedThisSlot),
    rejections: num(r?.rejections),
    partName: r?.partName ?? null,
    slotIndex: num(r?.slotIndex),
    partSegment: r?.partSegment ?? null,
    createdAtMs: timestampToMillis(r?.createdAt),
    updatedAtMs: timestampToMillis(r?.updatedAt),
  };
}

// Which hours of a session are filled. The session doc's savedSlotIndices
// marker can lag behind (it syncs after the record write) or be dropped (a
// resumed session), so — like the recording screen's own restore
// (productionDraft.fillFromRecords) — a slot also counts as filled when a
// productionRecord of its current shape exists for THIS run of the session:
// one 'full' record, or both 'before' and 'after' for a changeover slot,
// picked by productionDraft.pickSlotRecords (records from an earlier run on
// the same line/date/shift are ignored).
export function filledSlotIndices(s: RunningSession, records: RunningRecord[]): number[] {
  const out = new Set(s.savedSlotIndices);
  if (s.productionDate) {
    const own: RestoreRecord[] = records
      .filter((r) => r.lineId === s.lineId && r.productionDate === s.productionDate && r.shift === s.shift)
      .map((r) => ({
        id: r.id ?? '',
        slotIndex: r.slotIndex ?? null,
        partSegment: r.partSegment === 'before' || r.partSegment === 'after' ? r.partSegment : null,
        producedThisSlot: r.producedThisSlot,
        rejections: r.rejections ?? null,
        lossReasonCode: null,
        lossReasonLabel: null,
        lossReasonNote: null,
        createdAtMs: r.createdAtMs ?? null,
        updatedAtMs: r.updatedAtMs ?? null,
      }));
    pickSlotRecords(own, { productionDate: s.productionDate, lineId: s.lineId, shift: s.shift }, s.startedAtMs)
      .forEach((segs, i) => {
        if (segs.full || (segs.before && segs.after)) out.add(i);
      });
  }
  return Array.from(out).sort((a, b) => a - b);
}

// Every live session as the Running Lines screen sees it, plus its current
// stop, its downtime and slot-by-slot output for the hourly chart.
export function liveLines(input: {
  sessions: { id: string; data: any }[];
  records: RunningRecord[];
  partsByLine: LinePartsLookup;
  downtimeBySession: Map<string, number>;
  nowMs: number;
}): LiveLine[] {
  const sessions = input.sessions.map((s) => {
    const parsed = parseRunningSession(s.id, s.data);
    return { ...parsed, savedSlotIndices: filledSlotIndices(parsed, input.records) };
  });
  const rawById = new Map(input.sessions.map((s) => [parseRunningSession(s.id, s.data).lineId, s.data]));
  const cards = buildRunningLineCards(sessions, input.records, input.partsByLine, input.nowMs);
  return cards.map((card) => {
    const s = card.session;
    const raw = rawById.get(card.lineId);
    const own = recordsForSession(
      { lineId: s.lineId, lineName: s.lineName, shift: s.shift, productionDate: s.productionDate, lineStopped: s.lineStopped, stopsBySlot: null, startedAtMs: null, updatedAtMs: null },
      input.records
    );
    const bySlot = new Map<number, { produced: number; expected: number }>();
    own.forEach((r) => {
      if (r.slotIndex == null) return;
      const cur = bySlot.get(r.slotIndex) ?? { produced: 0, expected: 0 };
      cur.produced += r.producedThisSlot ?? 0;
      cur.expected += r.expectedParts ?? 0;
      bySlot.set(r.slotIndex, cur);
    });
    const schedule = buildSlots(s.shift, s.otHours, s.changeovers.map((co) => ({ start: co.startAbs, end: co.endAbs })), s.productionStartAbs);
    const slots: LiveSlot[] = schedule
      .filter((sl) => card.slots.bySlot[sl.index] != null)
      .map((sl) => ({
        index: sl.index,
        hour: String(Math.floor(sl.hourStartAbs / 60) % 24).padStart(2, '0'),
        range: `${clockLabel(sl.hourStartAbs)}–${clockLabel(sl.hourEndAbs)}`,
        state: card.slots.bySlot[sl.index],
        produced: bySlot.get(sl.index)?.produced ?? null,
        expected: bySlot.get(sl.index)?.expected ?? null,
      }));
    const stop = s.lineStopped
      ? currentStop({ lineId: s.lineId, lineName: s.lineName, shift: s.shift, productionDate: s.productionDate, lineStopped: true, stopsBySlot: raw?.stopsBySlot ?? null, startedAtMs: null, updatedAtMs: null })
      : null;
    return {
      card,
      plant: s.plant,
      achievementPct: card.planToDate > 0 ? round1((card.actual / card.planToDate) * 100) : null,
      stop: stop ? { reason: stop.label, sinceMs: stop.sinceMs } : null,
      downtimeMinutes: round2(input.downtimeBySession.get(downtimeSessionKey(s.lineId, s.productionDate, s.shift)) ?? 0),
      slots,
    };
  });
}

export function reasonLabel(reason: string | null | undefined): string {
  const r = (reason ?? '').trim();
  return r && r.toLowerCase() !== 'unspecified' ? formatStopReason(r) : 'Unspecified';
}
