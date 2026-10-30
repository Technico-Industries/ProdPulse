// functions/src/tvDashboard/core.ts
//
// Pure logic of the Assembly TV dashboard read model (tvDashboard/assembly…).
// No Firebase here — service.ts feeds it source documents and store.ts
// persists its output, so everything below is unit-tested with plain data
// (functions/test/tvDashboard.test.ts).
//
// Every production figure comes from the app's own helpers in src/utils,
// bundled into the function by build.mjs exactly like dataSource.ts does:
//   one record per slot ........ lineEfficiency.dedupeSlotRecords
//   good / plan-to-date / % ..... lineEfficiency.efficiencyOf
//                                 (Σ producedThisSlot / Σ expectedParts, round1, null without plan)
//   rejections .................. Σ productionRecords.rejections (legacy → 0, as
//                                 supervisorHandover.buildRunningLineCards sums them)
//   quality % ................... qualityMetrics.counterQuality (legacy records excluded)
//   downtime .................... downtime.collectDowntimeIntervals (each stop once,
//                                 live session → ended archive → shift summary → record shares)
//   dates / shifts .............. productionDay + productionSchedule (06:30 cutover,
//                                 Shift B pinned to the night it started)
//   live session / model ........ supervisorHandover.parseRunningSession, currentModel,
//                                 slotEntryStatuses
// rejectionRecords are never read. activeSessions.totalDowntimeMinutes,
// stopsSummaryBySlot and totalRejections are never used.
//
// Nothing personal is copied into the read model: no supervisor / operator
// names or codes, UIDs, device IDs, emails, loss notes or remarks — see
// LINE_DOC_FIELDS and the sanitising stop-reason mapping below.

import { createHash } from 'node:crypto';
import {
  PRODUCTION_DAY_CUTOVER_MINUTES,
  addDaysToKey,
  isProductionDayKey,
  millisToProductionDayMinute,
  productionDayKeyFor,
  productionDayMinuteToMillis,
  recordProductionDayKey,
  timestampToMillis,
} from '../../../src/utils/productionDay';
import { SHIFT_B_START, ShiftCode, buildSlots } from '../../../src/utils/productionSchedule';
import { currentStop, dedupeSlotRecords, efficiencyOf, formatStopReason } from '../../../src/utils/lineEfficiency';
import { counterQuality } from '../../../src/utils/qualityMetrics';
import {
  DowntimeInterval,
  collectDowntimeIntervals,
  downtimeByReason,
  lineDowntimeSummary,
  sessionSourceFromDoc,
  stopDurationMinutes,
  summarySourceFromDoc,
  totalDowntimeMinutes,
} from '../../../src/utils/downtime';
import { MPRecord, dayKeyOf, mapProductionRecord } from '../../../src/utils/modelPartProduction';
import { RunningSession, currentModel, parseRunningSession, sessionNowAbs, slotEntryStatuses } from '../../../src/utils/supervisorHandover';

export const TV_SCHEMA_VERSION = 1;
export const TV_ROOT = 'tvDashboard/assembly';
export const WEEKLY_DAYS = 7;

export type Data = Record<string, any>;
export type RawDoc = { id: string; data: Data };

// ─── Scope & line metadata ───────────────────────────────────────────────────

// Same rule as the app's screens (isAssemblyWorkshop in AdminOverviewScreen,
// GenerateReportScreen, RecordProductionScreen…): case-insensitive substring,
// so legacy "Assembly" matches as well as "Assembly Shop". Not exported from
// src/utils, so mirrored here.
export function isAssemblyWorkshop(w: string | null | undefined): boolean {
  return !!w && w.toLowerCase().includes('assembly');
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export interface LineMeta {
  lineId: string;
  lineName: string | null;
  plant: string | null;
  workshop: string | null;
  division: string | null;
  // Index = part index (selectedPartIndex / changeover newPartIndex). Never
  // filtered, so indices keep pointing at the right part.
  parts: { name: string }[];
  registered: boolean;
}

// A productionLines doc with the legacy aliases the app's readers accept
// (GenerateReportScreen / RunningLinesScreen …): plant ← location,
// workshop ← shop, division ← unit, lineName ← lineNumber ← name,
// parts ← models ← partsList, part name ← partName.
export function normalizeLineDoc(lineId: string, d: Data): LineMeta {
  const parts =
    Array.isArray(d?.parts) && d.parts.length ? d.parts
    : Array.isArray(d?.models) && d.models.length ? d.models
    : Array.isArray(d?.partsList) && d.partsList.length ? d.partsList
    : [];
  return {
    lineId,
    lineName: str(d?.lineName) ?? str(d?.lineNumber) ?? str(d?.name),
    plant: str(d?.plant) ?? str(d?.location),
    workshop: str(d?.workshop) ?? str(d?.shop),
    division: str(d?.division) ?? str(d?.unit),
    parts: parts.map((p: any) => ({ name: str(p?.name) ?? str(p?.partName) ?? '' })),
    registered: true,
  };
}

// Metadata of a line: the productionLines doc first, falling back field by
// field to the copies carried by its session / records / summaries — the
// rule of modelPartProduction.resolveLineFields ("same fix Generate Report
// applies"). A line no longer registered is resolved from those copies only.
export function resolveLineMeta(lineId: string, lineDoc: Data | null, copies: (Data | null | undefined)[]): LineMeta {
  const base: LineMeta = lineDoc
    ? normalizeLineDoc(lineId, lineDoc)
    : { lineId, lineName: null, plant: null, workshop: null, division: null, parts: [], registered: false };
  for (const c of copies) {
    if (!c) continue;
    base.lineName ??= str(c.lineName);
    base.plant ??= str(c.plant);
    base.workshop ??= str(c.workshop);
    base.division ??= str(c.division);
  }
  return base;
}

// Scope of a line from the cheapest metadata available: the productionLines
// doc (legacy aliases included) and, when given, the session's copy — the
// same precedence resolveLineMeta / computeLineDoc apply, so an early
// 'other' can never disagree with the full computation. 'unknown' (no
// workshop on either) is never treated as out of scope: only the record /
// summary copies can tell, so the caller must read them.
export type WorkshopScope = 'assembly' | 'other' | 'unknown';

export function workshopScope(lineId: string, lineDoc: Data | null, session: Data | null): WorkshopScope {
  const w = resolveLineMeta(lineId, lineDoc, session ? [session] : []).workshop;
  return w == null ? 'unknown' : isAssemblyWorkshop(w) ? 'assembly' : 'other';
}

// ─── Dashboard context (production date + current shift) ────────────────────

export interface DashboardContext {
  nowMs: number;
  productionDate: string;
  shift: ShiftCode;
}

// The production date is productionDayKeyFor (06:30 Asia/Kolkata cutover —
// the deployed function pins TZ via ../timezone). The dashboard's shift runs
// from the cutover until Shift B starts (19:00) as A, then B until the next
// cutover, so between shifts the TV keeps showing the shift that just ran.
// This only picks WHICH shift the overview shows; every figure still belongs
// to the production date / shift stored on the source documents.
export function dashboardContext(nowMs: number): DashboardContext {
  const productionDate = productionDayKeyFor(nowMs);
  const minute = millisToProductionDayMinute(productionDate, nowMs);
  const shift: ShiftCode = minute >= PRODUCTION_DAY_CUTOVER_MINUTES && minute < SHIFT_B_START ? 'A' : 'B';
  return { nowMs, productionDate, shift };
}

// The `count` production dates before `productionDate`, oldest first.
export function previousProductionDates(productionDate: string, count: number): string[] {
  const out: string[] = [];
  for (let i = count; i >= 1; i--) out.push(addDaysToKey(productionDate, -i));
  return out;
}

// ─── Stop reasons (sanitised) ────────────────────────────────────────────────

// The Stop picker's fixed list (RecordProductionScreen STOP_REASONS — not
// exported from a util, so mirrored here). Anything else that turns up in a
// stop's `reason` is reported as "other", so no free text reaches the TV.
export const KNOWN_STOP_REASONS = [
  'maintenance', 'changeover', 'quality', 'material shortage', 'no operator', 'storage issue', 'training',
  '5s', 'meeting', 'pokayoke checktime', 'gauge/fixture maintenance', 'no production plan', 'power cut', 'machine pm',
] as const;

export function sanitizeStopReason(reason: string | null | undefined): { reason: string; label: string } {
  const key = (reason ?? '').trim().toLowerCase();
  if (!key || key === 'unspecified') return { reason: 'unspecified', label: 'Unspecified' };
  if ((KNOWN_STOP_REASONS as readonly string[]).includes(key)) return { reason: key, label: formatStopReason(key) };
  return { reason: 'other', label: 'Other' };
}

// ─── Figures of one line, one production date, one shift ────────────────────

export interface QualityParts {
  goodParts: number;      // counterQuality goodParts (records with a counter only)
  rejectedParts: number;  // 0 when no record has a counter
  countedRecords: number;
  legacyRecords: number;
}

export interface ReasonMinutes { reason: string; label: string; minutes: number }

export interface ShiftFigures {
  recordCount: number;          // de-duplicated slot records
  goodProduction: number;       // Σ producedThisSlot
  planToDate: number;           // Σ expectedParts of saved slots
  achievementPct: number | null;
  rejections: number;           // Σ rejections (legacy records add 0)
  quality: QualityParts;
  qualityPct: number | null;
  rejectionPct: number | null;
  downtimeClosedMinutes: number; // stops that have ended; running ones are published separately
  downtimeByReason: ReasonMinutes[];
}

export interface DateSources {
  records: RawDoc[];        // productionRecords that may belong to this date
  shiftSummaries: Data[];   // shiftSummaries docs of this date
  endedSessions: Data[];    // endedSessions docs of this date
}

export interface RunningStop { startMs: number; reason: string; label: string; shift: ShiftCode; productionDate: string }

const round2 = (n: number) => Math.round(n * 100) / 100;

// Records of one session identity (line + date + shift), one per slot.
function sessionRecords(lineId: string, productionDate: string, shift: ShiftCode, records: RawDoc[]) {
  const mapped = records.map((d) => ({ mp: mapProductionRecord(d.id, d.data), raw: d.data }));
  const own = mapped.filter(({ mp }) => mp.lineId === lineId && dayKeyOf(mp) === productionDate && mp.shift === shift);
  const kept = new Set<MPRecord>(dedupeSlotRecords(own.map((o) => o.mp)));
  return own.filter((o) => kept.has(o.mp));
}

function reasonsFromIntervals(intervals: DowntimeInterval[]): ReasonMinutes[] {
  const sanitized = intervals.map((iv) => ({ ...iv, reason: sanitizeStopReason(iv.reason).reason }));
  return downtimeByReason(sanitized).map((r) => ({ reason: r.reason, label: sanitizeStopReason(r.reason).label, minutes: r.minutes }));
}

export function computeShiftFigures(
  lineId: string,
  productionDate: string,
  shift: ShiftCode,
  src: DateSources,
  session: Data | null,
  nowMs: number
): { figures: ShiftFigures; runningStop: RunningStop | null } {
  const own = sessionRecords(lineId, productionDate, shift, src.records);
  const mps = own.map((o) => o.mp);

  const eff = efficiencyOf(mps);
  const q = counterQuality(mps);
  const rejections = mps.reduce((s, r) => s + (finite(r.rejections) ?? 0), 0);

  // Downtime: every source of this line + date + shift, each stop once.
  const sameSession = (s: { lineId: string | null; productionDate: string | null; shift: string | null } | null) =>
    !!s && s.lineId === lineId && s.productionDate === productionDate && s.shift === shift;
  const live = session ? sessionSourceFromDoc(lineId, session) : null;
  const intervals = collectDowntimeIntervals(
    {
      records: own.map(({ mp, raw }) => ({
        lineId: mp.lineId,
        productionDate,
        shift: mp.shift,
        stopEvents: Array.isArray(raw?.stopEvents) ? raw.stopEvents : null,
      })),
      activeSessions: sameSession(live) ? [live!] : [],
      endedSessions: src.endedSessions.map((d) => sessionSourceFromDoc(lineId, d)).filter(sameSession) as any[],
      shiftSummaries: src.shiftSummaries.map((d) => summarySourceFromDoc(d)).filter(sameSession) as any[],
    },
    nowMs
  ).filter((iv) => iv.lineId === lineId);

  const closed = intervals.filter((iv) => !iv.running);
  let runningStop: RunningStop | null = null;
  if (sameSession(live) && intervals.some((iv) => iv.running)) {
    const summary = lineDowntimeSummary(session?.stopsBySlot, nowMs);
    if (summary.currentStopStartMs != null) {
      const cur = sanitizeStopReason(intervals.filter((iv) => iv.running).sort((a, b) => b.minutes - a.minutes)[0]?.reason);
      runningStop = { startMs: summary.currentStopStartMs, reason: cur.reason, label: cur.label, shift, productionDate };
    }
  }

  return {
    figures: {
      recordCount: mps.length,
      goodProduction: eff.actual,
      planToDate: eff.planned,
      achievementPct: eff.efficiency,
      rejections,
      quality: {
        goodParts: q.goodParts,
        rejectedParts: q.rejectedParts ?? 0,
        countedRecords: mps.length - q.legacyRecords,
        legacyRecords: q.legacyRecords,
      },
      qualityPct: q.qualityPct,
      rejectionPct: q.rejectionPct,
      downtimeClosedMinutes: totalDowntimeMinutes(closed),
      downtimeByReason: reasonsFromIntervals(closed),
    },
    runningStop,
  };
}

// ─── Summing figures across lines (still through the app's helpers) ─────────

// efficiencyOf / counterQuality / downtimeByReason over per-line totals give
// exactly what they give over the union of the underlying records: each line
// contributes one pseudo-record with its sums (plus one pseudo-record per
// legacy record, so counterQuality's "only legacy → unknown" rule holds).
export function sumShiftFigures(parts: ShiftFigures[]): ShiftFigures {
  const good = parts.reduce((s, p) => s + p.goodProduction, 0);
  const plan = parts.reduce((s, p) => s + p.planToDate, 0);
  const eff = efficiencyOf([{ lineId: null, shift: null, productionDate: null, producedThisSlot: good, expectedParts: plan }]);
  const pseudo: { producedThisSlot: number; rejections: number | null }[] = [];
  parts.forEach((p) => {
    if (p.quality.countedRecords > 0) pseudo.push({ producedThisSlot: p.quality.goodParts, rejections: p.quality.rejectedParts });
    for (let i = 0; i < p.quality.legacyRecords; i++) pseudo.push({ producedThisSlot: 0, rejections: null });
  });
  const q = counterQuality(pseudo);
  const reasons = downtimeByReason(
    parts.flatMap((p) => p.downtimeByReason.map((r) => ({ reason: r.reason, minutes: r.minutes }) as DowntimeInterval))
  ).map((r) => ({ reason: r.reason, label: sanitizeStopReason(r.reason).label, minutes: r.minutes }));
  return {
    recordCount: parts.reduce((s, p) => s + p.recordCount, 0),
    goodProduction: eff.actual,
    planToDate: eff.planned,
    achievementPct: eff.efficiency,
    rejections: parts.reduce((s, p) => s + p.rejections, 0),
    quality: {
      goodParts: q.goodParts,
      rejectedParts: q.rejectedParts ?? 0,
      countedRecords: parts.reduce((s, p) => s + p.quality.countedRecords, 0),
      legacyRecords: q.legacyRecords,
    },
    qualityPct: q.qualityPct,
    rejectionPct: q.rejectionPct,
    downtimeClosedMinutes: round2(parts.reduce((s, p) => s + p.downtimeClosedMinutes, 0)),
    downtimeByReason: reasons,
  };
}

export const EMPTY_SHIFT: ShiftFigures = sumShiftFigures([]);

// ─── Line document ───────────────────────────────────────────────────────────

export type LineBaseStatus = 'running' | 'stopped' | 'idle';
export type LineDisplayStatus = LineBaseStatus | 'awaiting_entry';

export interface LineDocContent {
  schemaVersion: number;
  lineId: string;
  lineName: string;
  plant: string | null;
  workshop: string | null;
  division: string | null;
  registered: boolean;
  // running / stopped come from the live session; idle = no session.
  status: LineBaseStatus;
  // A running line becomes "awaiting entry" at this instant (end of its
  // earliest unsaved slot) — time-based, so it is published as a moment
  // rather than rewritten when it passes. See displayStatus().
  awaitingEntryFromMs: number | null;
  model: string | null;
  current: {
    productionDate: string;
    shift: ShiftCode;
    shiftPlan: number | null;     // activeSessions.plannedProductionTotal (full shift)
    sessionStale: boolean;        // the session belongs to another date/shift than the dashboard's
    figures: ShiftFigures;
  };
  activeStop: { startMs: number; reason: string; label: string } | null;
  day: { productionDate: string; shifts: { A: ShiftFigures; B: ShiftFigures } };
}

export interface LineSources {
  lineId: string;
  lineDoc: Data | null;               // productionLines/{lineId}
  session: Data | null;               // activeSessions/{lineId}
  byDate: Record<string, DateSources>; // the dashboard date, plus the session's own date
}

// Moment the running session turns "awaiting entry": the end of its earliest
// slot that is neither saved, deleted nor a break — the same rule as
// slotEntryStatuses (awaiting = slot ended and not saved), evaluated for
// every slot at once instead of at one "now".
export function awaitingEntryFromMs(s: RunningSession): number | null {
  if (!isProductionDayKey(s.productionDate)) return null;
  const all = slotEntryStatuses(s, Number.POSITIVE_INFINITY);
  if (!all.awaiting.length) return null;
  const pending = new Set(all.awaiting);
  const slots = buildSlots(s.shift, s.otHours, s.changeovers.map((co) => ({ start: co.startAbs, end: co.endAbs })), s.productionStartAbs);
  const ends = slots.filter((sl) => pending.has(sl.index)).map((sl) => sl.endMinutesAbs);
  return ends.length ? productionDayMinuteToMillis(s.productionDate, Math.min(...ends)) : null;
}

export function displayStatus(line: Pick<LineDocContent, 'status' | 'awaitingEntryFromMs'>, nowMs: number): LineDisplayStatus {
  if (line.status === 'running' && line.awaitingEntryFromMs != null && nowMs >= line.awaitingEntryFromMs) return 'awaiting_entry';
  return line.status;
}

const emptySources = (): DateSources => ({ records: [], shiftSummaries: [], endedSessions: [] });

// The sanitised read-model doc of one line, or null when it must not (or no
// longer) appear: not Assembly, or an unregistered line with neither a live
// session nor any record on the dashboard date.
export function computeLineDoc(src: LineSources, ctx: DashboardContext): LineDocContent | null {
  const { lineId, session } = src;
  const today = src.byDate[ctx.productionDate] ?? emptySources();
  const copies: Data[] = [
    ...(session ? [session] : []),
    ...Object.values(src.byDate).flatMap((d) => [...d.records.map((r) => r.data), ...d.shiftSummaries, ...d.endedSessions]),
  ];
  const meta = resolveLineMeta(lineId, src.lineDoc, copies);
  if (!isAssemblyWorkshop(meta.workshop)) return null;

  const running = session ? parseRunningSession(lineId, session) : null;
  const hasTodayRecords = today.records.some((r) => r.data?.lineId === lineId);
  if (!meta.registered && !running && !hasTodayRecords) return null;

  const dayA = computeShiftFigures(lineId, ctx.productionDate, 'A', today, session, ctx.nowMs);
  const dayB = computeShiftFigures(lineId, ctx.productionDate, 'B', today, session, ctx.nowMs);

  let current: LineDocContent['current'];
  let activeStop: LineDocContent['activeStop'] = null;
  let model: string | null = null;
  let status: LineBaseStatus = 'idle';
  let awaiting: number | null = null;

  if (running && running.productionDate) {
    const date = running.productionDate;
    const own = date === ctx.productionDate
      ? (running.shift === 'A' ? dayA : dayB)
      : computeShiftFigures(lineId, date, running.shift, src.byDate[date] ?? emptySources(), session, ctx.nowMs);
    current = {
      productionDate: date,
      shift: running.shift,
      shiftPlan: running.plannedProductionTotal,
      sessionStale: date !== ctx.productionDate || running.shift !== ctx.shift,
      figures: own.figures,
    };
    // currentStop is the app's reading of the running stop; its reason is
    // sanitised, its start comes from lineDowntimeSummary via own.runningStop.
    if (running.lineStopped) {
      const stop = currentStop({
        lineId, lineName: running.lineName, shift: running.shift, productionDate: date,
        lineStopped: true, stopsBySlot: session?.stopsBySlot ?? null, startedAtMs: running.startedAtMs, updatedAtMs: running.updatedAtMs,
      });
      const startMs = own.runningStop?.startMs ?? stop.sinceMs;
      if (startMs != null) {
        const r = sanitizeStopReason(stop.reason ?? own.runningStop?.reason);
        activeStop = { startMs, reason: r.reason, label: r.label };
      }
    }
    const records = (src.byDate[date]?.records ?? []).map((d) => mapProductionRecord(d.id, d.data))
      .filter((r) => r.lineId === lineId && dayKeyOf(r) === date && r.shift === running.shift);
    model = currentModel(running, meta.parts, sessionNowAbs(date, ctx.nowMs), records);
    status = running.lineStopped ? 'stopped' : 'running';
    awaiting = status === 'running' ? awaitingEntryFromMs(running) : null;
  } else {
    current = {
      productionDate: ctx.productionDate,
      shift: ctx.shift,
      shiftPlan: null,
      sessionStale: false,
      figures: (ctx.shift === 'A' ? dayA : dayB).figures,
    };
    // A legacy session whose production date cannot be resolved (no
    // productionDate, no startedAt) still shows the line as live — its
    // figures just can't be placed on a day.
    if (running) status = running.lineStopped ? 'stopped' : 'running';
  }

  return {
    schemaVersion: TV_SCHEMA_VERSION,
    lineId,
    lineName: meta.lineName ?? lineId,
    plant: meta.plant,
    workshop: meta.workshop,
    division: meta.division,
    registered: meta.registered,
    status,
    awaitingEntryFromMs: awaiting,
    model: str(model),
    current,
    activeStop,
    day: { productionDate: ctx.productionDate, shifts: { A: dayA.figures, B: dayB.figures } },
  };
}

// ─── Day document ────────────────────────────────────────────────────────────

export interface DayDocContent {
  schemaVersion: number;
  productionDate: string;
  // true once the date is over (before today's cutover) and no Assembly
  // session of that date is still open — built from all sources.
  final: boolean;
  source: 'lines' | 'sources';
  lineCount: number;
  shifts: { A: ShiftFigures; B: ShiftFigures };
  totals: ShiftFigures;
}

// Today's day doc: the sum of the per-line docs for that date.
export function dayFromLineDocs(productionDate: string, lines: LineDocContent[]): DayDocContent {
  const own = lines.filter((l) => l.day.productionDate === productionDate);
  const A = sumShiftFigures(own.map((l) => l.day.shifts.A));
  const B = sumShiftFigures(own.map((l) => l.day.shifts.B));
  return {
    schemaVersion: TV_SCHEMA_VERSION, productionDate, final: false, source: 'lines',
    lineCount: own.length, shifts: { A, B }, totals: sumShiftFigures([A, B]),
  };
}

export interface DaySources {
  productionDate: string;
  lines: RawDoc[];           // all productionLines
  activeSessions: RawDoc[];  // all activeSessions
  records: RawDoc[];         // productionRecords of the date (productionDate range + legacy createdAt window)
  shiftSummaries: Data[];    // shiftSummaries of the date
  endedSessions: Data[];     // endedSessions of the date
}

// A past (or any) date rebuilt from every source, per line through the very
// same computeShiftFigures, then summed. Records without a lineId cannot be
// attributed to a line or workshop and are left out (counted in skipped).
export function dayFromSources(src: DaySources, nowMs: number, todayKey: string): { day: DayDocContent; skippedRecords: number } {
  const date = src.productionDate;
  const lineDocs = new Map(src.lines.map((l) => [l.id, l.data]));
  const sessionsOfDate = src.activeSessions.filter((s) => {
    const parsed = parseRunningSession(s.id, s.data);
    return parsed.productionDate === date;
  });
  const sessionByLine = new Map(sessionsOfDate.map((s) => [str(s.data?.lineId) ?? s.id, s.data]));

  let skippedRecords = 0;
  const lineIds = new Set<string>();
  src.records.forEach((r) => {
    const mp = mapProductionRecord(r.id, r.data);
    if (dayKeyOf(mp) !== date) return;
    if (mp.lineId) lineIds.add(mp.lineId);
    else skippedRecords++;
  });
  src.shiftSummaries.forEach((s) => { if (str(s.lineId)) lineIds.add(s.lineId); });
  src.endedSessions.forEach((s) => { if (str(s.lineId)) lineIds.add(s.lineId); });
  sessionByLine.forEach((_d, id) => lineIds.add(id));

  const perLineA: ShiftFigures[] = [];
  const perLineB: ShiftFigures[] = [];
  let lineCount = 0;
  const dateSources: DateSources = { records: src.records, shiftSummaries: src.shiftSummaries, endedSessions: src.endedSessions };
  lineIds.forEach((lineId) => {
    const session = sessionByLine.get(lineId) ?? null;
    const copies = [
      session,
      ...src.records.filter((r) => r.data?.lineId === lineId).map((r) => r.data),
      ...src.shiftSummaries.filter((s) => s.lineId === lineId),
      ...src.endedSessions.filter((s) => s.lineId === lineId),
    ];
    const meta = resolveLineMeta(lineId, lineDocs.get(lineId) ?? null, copies);
    if (!isAssemblyWorkshop(meta.workshop)) return;
    lineCount++;
    perLineA.push(computeShiftFigures(lineId, date, 'A', dateSources, session, nowMs).figures);
    perLineB.push(computeShiftFigures(lineId, date, 'B', dateSources, session, nowMs).figures);
  });

  const A = sumShiftFigures(perLineA);
  const B = sumShiftFigures(perLineB);
  const openAssemblySession = sessionsOfDate.some((s) =>
    isAssemblyWorkshop(resolveLineMeta(s.id, lineDocs.get(str(s.data?.lineId) ?? s.id) ?? null, [s.data]).workshop)
  );
  return {
    day: {
      schemaVersion: TV_SCHEMA_VERSION, productionDate: date,
      final: date < todayKey && !openAssemblySession,
      source: 'sources', lineCount, shifts: { A, B }, totals: sumShiftFigures([A, B]),
    },
    skippedRecords,
  };
}

// ─── Overview document ───────────────────────────────────────────────────────

export interface TrendPoint {
  productionDate: string;
  available: boolean;          // false = no day doc yet (never invented)
  final: boolean;
  goodProduction: number | null;
  planToDate: number | null;
  achievementPct: number | null;
  rejections: number | null;
  qualityPct: number | null;
}

export interface OverviewContent {
  schemaVersion: number;
  scope: { workshopMatch: 'assembly'; plants: string[] };
  productionDate: string;
  currentShift: ShiftCode;
  operationalState: 'production' | 'no_active_sessions';
  kpis: {
    productionDate: string;
    shift: ShiftCode;
    goodProduction: number;
    planToDate: number;
    achievementPct: number | null;
    rejections: number;
    qualityPct: number | null;
    rejectionPct: number | null;
    downtimeClosedMinutes: number;
    // TV adds (now − startMs) for each running stop to downtimeClosedMinutes.
    activeStops: { lineId: string; startMs: number; reason: string; label: string }[];
  };
  lineCounts: { total: number; running: number; stopped: number; idle: number; awaitingEntry: number };
  weeklyTrend: TrendPoint[];
  shiftComparison: { productionDate: string; A: ShiftFigures; B: ShiftFigures };
  // Current shift, closed stops plus running stops up to generatedAt.
  downtimeReasons: ReasonMinutes[];
}

function trendPoint(date: string, day: DayDocContent | null): TrendPoint {
  if (!day) {
    return { productionDate: date, available: false, final: false, goodProduction: null, planToDate: null, achievementPct: null, rejections: null, qualityPct: null };
  }
  const t = day.totals;
  return {
    productionDate: date, available: true, final: day.final,
    goodProduction: t.goodProduction, planToDate: t.planToDate, achievementPct: t.achievementPct,
    rejections: t.rejections, qualityPct: t.qualityPct,
  };
}

export function buildOverview(
  ctx: DashboardContext,
  lines: LineDocContent[],
  today: DayDocContent,
  pastDays: Record<string, DayDocContent | null>,
  generatedAtMs: number
): OverviewContent {
  const counts = { total: lines.length, running: 0, stopped: 0, idle: 0, awaitingEntry: 0 };
  lines.forEach((l) => {
    const s = displayStatus(l, generatedAtMs);
    if (s === 'awaiting_entry') counts.awaitingEntry++;
    else counts[s]++;
  });

  const shiftNow = today.shifts[ctx.shift];
  const activeStops = lines
    .filter((l) => l.activeStop && l.current.productionDate === ctx.productionDate && l.current.shift === ctx.shift)
    .map((l) => ({ lineId: l.lineId, ...l.activeStop! }))
    .sort((a, b) => a.startMs - b.startMs);

  const reasons = downtimeByReason([
    ...shiftNow.downtimeByReason.map((r) => ({ reason: r.reason, minutes: r.minutes }) as DowntimeInterval),
    ...activeStops.map((s) => ({ reason: s.reason, minutes: stopDurationMinutes(s.startMs, generatedAtMs) }) as DowntimeInterval),
  ]).map((r) => ({ reason: r.reason, label: sanitizeStopReason(r.reason).label, minutes: r.minutes }));

  const plants = Array.from(new Set(lines.map((l) => l.plant).filter((p): p is string => !!p))).sort();
  const anyLive = lines.some((l) => l.status !== 'idle');

  return {
    schemaVersion: TV_SCHEMA_VERSION,
    scope: { workshopMatch: 'assembly', plants },
    productionDate: ctx.productionDate,
    currentShift: ctx.shift,
    operationalState: anyLive ? 'production' : 'no_active_sessions',
    kpis: {
      productionDate: ctx.productionDate,
      shift: ctx.shift,
      goodProduction: shiftNow.goodProduction,
      planToDate: shiftNow.planToDate,
      achievementPct: shiftNow.achievementPct,
      rejections: shiftNow.rejections,
      qualityPct: shiftNow.qualityPct,
      rejectionPct: shiftNow.rejectionPct,
      downtimeClosedMinutes: shiftNow.downtimeClosedMinutes,
      activeStops,
    },
    lineCounts: counts,
    weeklyTrend: previousProductionDates(ctx.productionDate, WEEKLY_DAYS).map((d) => trendPoint(d, pastDays[d] ?? null)),
    shiftComparison: { productionDate: ctx.productionDate, A: today.shifts.A, B: today.shifts.B },
    downtimeReasons: reasons,
  };
}

// ─── Change detection & stale-computation guard ──────────────────────────────

// Key-order-independent JSON, so equal content always hashes equally.
export function stableStringify(v: unknown): string {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
}

export function contentHash(content: unknown): string {
  return createHash('sha256').update(stableStringify(content)).digest('hex');
}

export interface StoredMeta { computedAtMs?: unknown; contentHash?: unknown; final?: unknown }

export type WriteDecision = 'write' | 'delete' | 'unchanged' | 'stale' | 'noop' | 'final';

// What to do with a computation that started at `computedAtMs` (its source
// reads happened after that instant). A doc written by a computation that
// started LATER is never overwritten — Firestore reads are strongly
// consistent, so the later one saw data at least as new. Identical content is
// not rewritten. `protectFinal` keeps a finalised day doc from being replaced
// by live (line-sum) data.
export function decideWrite(
  existing: StoredMeta | null,
  next: { computedAtMs: number; hash: string | null },
  opts: { protectFinal?: boolean } = {}
): WriteDecision {
  if (existing && typeof existing.computedAtMs === 'number' && existing.computedAtMs > next.computedAtMs) return 'stale';
  if (next.hash == null) return existing ? 'delete' : 'noop';
  if (opts.protectFinal && existing?.final === true) return 'final';
  if (existing && existing.contentHash === next.hash) return 'unchanged';
  return 'write';
}

// Overview: also rewritten when unchanged once the heartbeat is due, so the
// TV can tell a live pipeline (fresh generatedAtMs) from a stopped one.
export const OVERVIEW_HEARTBEAT_MS = 5 * 60 * 1000;

export function decideOverviewWrite(existing: (StoredMeta & { generatedAtMs?: unknown }) | null, hash: string, generatedAtMs: number): WriteDecision {
  if (existing && typeof existing.generatedAtMs === 'number' && existing.generatedAtMs > generatedAtMs) return 'stale';
  if (existing && existing.contentHash === hash && typeof existing.generatedAtMs === 'number' && generatedAtMs - existing.generatedAtMs < OVERVIEW_HEARTBEAT_MS) {
    return 'unchanged';
  }
  return 'write';
}

// ─── Which read-model docs a source write affects ────────────────────────────

export type SourceCollection = 'activeSessions' | 'productionRecords' | 'shiftSummaries' | 'endedSessions' | 'productionLines';

// activeSessions is synced 1.2 s after every keystroke (typed but unsaved
// quantities, operators, loss reasons, sync metadata). Only these fields can
// change the line's read model.
export function sessionProjection(d: Data | null): unknown {
  if (!d) return null;
  const stops = Object.entries(d.stopsBySlot ?? {}).flatMap(([slot, arr]) =>
    (Array.isArray(arr) ? arr : []).map((s: any) => [slot, s?.id ?? null, s?.startAbs ?? null, s?.endAbs ?? null, s?.durationMinutes ?? null, !!s?.running, s?.reason ?? null])
  );
  return {
    lineId: d.lineId ?? null, lineName: d.lineName ?? null, plant: d.plant ?? null, workshop: d.workshop ?? null, division: d.division ?? null,
    shift: d.shift ?? null, productionDate: d.productionDate ?? null, startedAt: timestampToMillis(d.startedAt),
    otHours: d.otHours ?? null, productionStartMinutesAbs: d.productionStartMinutesAbs ?? null,
    plannedProductionTotal: d.plannedProductionTotal ?? null, selectedPartIndex: d.selectedPartIndex ?? null,
    changeovers: d.changeovers ?? null, savedSlotIndices: d.savedSlotIndices ?? null, deletedSlotIndices: d.deletedSlotIndices ?? null,
    lineStopped: d.lineStopped === true, stops,
  };
}

export interface WriteImpact { lineIds: string[]; dirtyDates: string[] }

// Line(s) to recompute and past dates whose day doc must be rebuilt, for one
// source write. Dates older than the weekly window are not tracked.
export function impactOfWrite(
  collection: SourceCollection,
  docId: string,
  before: Data | null,
  after: Data | null,
  ctx: DashboardContext
): WriteImpact {
  if (collection === 'activeSessions') {
    if (stableStringify(sessionProjection(before)) === stableStringify(sessionProjection(after))) return { lineIds: [], dirtyDates: [] };
    const dates = [before, after].map((d) => (d ? parseRunningSession(docId, d).productionDate : null));
    return { lineIds: [docId], dirtyDates: pastDates(dates, ctx) };
  }
  if (collection === 'productionLines') return { lineIds: [docId], dirtyDates: [] };

  const lineIds = new Set<string>();
  const dates: (string | null)[] = [];
  [before, after].forEach((d) => {
    if (!d) return;
    const lineId = str(d.lineId);
    if (lineId) lineIds.add(lineId);
    dates.push(
      collection === 'productionRecords'
        ? recordProductionDayKey({ productionDate: d.productionDate, shift: d.shift ?? 'A', createdAtMs: timestampToMillis(d.createdAt) })
        : isProductionDayKey(d.productionDate) ? d.productionDate : null
    );
  });
  return { lineIds: Array.from(lineIds), dirtyDates: pastDates(dates, ctx) };
}

function pastDates(dates: (string | null)[], ctx: DashboardContext): string[] {
  const oldest = addDaysToKey(ctx.productionDate, -WEEKLY_DAYS);
  return Array.from(new Set(dates.filter((d): d is string => !!d && d < ctx.productionDate && d >= oldest)));
}

// Field allow-list of a line doc — a test asserts nothing else is ever written.
export const LINE_DOC_FIELDS = [
  'schemaVersion', 'lineId', 'lineName', 'plant', 'workshop', 'division', 'registered', 'status',
  'awaitingEntryFromMs', 'model', 'current', 'activeStop', 'day',
] as const;
