// functions/src/tools.ts
//
// The read-only production tools the model (Grok) may call. Each tool:
//   1. validates its arguments (dates, filters, groupings, limits) — an
//      invalid argument is returned to the model as an error, never guessed;
//   2. reads data only through ProductionDataSource (fixed collections and
//      query shapes — see dataSource.ts);
//   3. aggregates deterministically with the app's own business logic:
//        • production date / Shift B overnight — utils/productionDay
//        • one record per slot (legacy duplicates) — utils/modelPartProduction
//          dedupeProductionRecords; duplicates are counted and reported,
//          never dropped silently
//        • target / efficiency — utils/lineEfficiency efficiencyOf
//          (Σ producedThisSlot / Σ expectedParts — expectedParts is the
//          slot's target from cycle time × productive minutes, computed by
//          RecordProductionScreen with utils/productionSchedule at save time)
//        • rejection % — utils/qualityMetrics counterQuality (the slot
//          Rejections counter; legacy records without it are excluded)
//        • downtime — Σ stopEvents.durationMinutes (Generate Report), plus
//          still-running sessions counted once (utils/downtime)
//   4. returns a ResultBlock (rendered and exported by the app, never
//      edited by the model) and a compact copy of it for the model.
//
// Nothing here writes to Firestore.

import { PLANTS, WORKSHOPS, DIVISIONS } from '../../src/constants/lineOptions';
import {
  dayKeyOf,
  dedupeProductionRecords,
  mapProductionRecord,
  MPLine,
  MPRecord,
  normName,
  resolveLineFields,
  validateDateRange,
} from '../../src/utils/modelPartProduction';
import { efficiencyOf, formatStopReason } from '../../src/utils/lineEfficiency';
import { counterQuality } from '../../src/utils/qualityMetrics';
import { stopDurationMinutes, stopIdOf, DowntimeStop } from '../../src/utils/downtime';
import { productionDayKeyFor, resolveSessionProductionDate } from '../../src/utils/productionDay';
import type { Cell, ResultBlock, ResultColumn, ResultMetric } from '../../src/utils/prodPulseAI';
import type { ProductionDataSource, RawDoc } from './dataSource';

// ─── Limits ──────────────────────────────────────────────────────────────────

export const DISPLAY_ROW_LIMIT = 500;
export const MODEL_ROW_LIMIT = 40;
export const DETAIL_ROW_MAX = 200;
const MAX_STRING_ARG = 100;

// An invalid argument. Its message goes back to the model so it can fix the
// call or ask the user — it is not a database failure.
export class ToolArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolArgError';
  }
}

// ─── Context ─────────────────────────────────────────────────────────────────

export interface ToolContext {
  data: ProductionDataSource;
  nowMs: number;
  // Per-request memo of loaded ranges. Lives only for one request, so one
  // user's data is never reused for another.
  cache: Map<string, Promise<unknown>>;
  nextId: () => string;
}

export function createToolContext(data: ProductionDataSource, nowMs: number): ToolContext {
  let n = 0;
  return { data, nowMs, cache: new Map(), nextId: () => `r${++n}` };
}

function memo<T>(ctx: ToolContext, key: string, load: () => Promise<T>): Promise<T> {
  let p = ctx.cache.get(key) as Promise<T> | undefined;
  if (!p) {
    p = load();
    ctx.cache.set(key, p);
    p.catch(() => ctx.cache.delete(key));
  }
  return p;
}

function calendarKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ─── Records ─────────────────────────────────────────────────────────────────

interface RecordStop {
  stopId: string | null;
  reason: string;
  minutes: number;
}

// MPRecord (the Model / Part page's mapping) plus the loss and downtime
// fields Generate Report reads. Employee data (operators, supervisor) is
// not carried into anything sent to the model.
export interface AIRecord extends MPRecord {
  lossParts: number | null;
  lossTimeMinutes: number | null;
  lossReasonLabel: string | null;
  stops: RecordStop[];
}

const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const nonNeg = (v: number | null) => Math.max(0, v ?? 0);
const round1 = (n: number) => Math.round(n * 10) / 10;

export function mapAIRecord(doc: RawDoc): AIRecord {
  const d = doc.data;
  return {
    ...mapProductionRecord(doc.id, d),
    lossParts: finite(d.lossParts),
    lossTimeMinutes: finite(d.lossTimeMinutes),
    lossReasonLabel: typeof d.lossReasonLabel === 'string' && d.lossReasonLabel.trim() ? d.lossReasonLabel : null,
    stops: Array.isArray(d.stopEvents)
      ? d.stopEvents
          .filter((s: any) => s && typeof s === 'object')
          .map((s: any) => ({
            stopId: typeof s.stopId === 'string' ? s.stopId : null,
            reason: typeof s.reason === 'string' && s.reason.trim() ? s.reason.trim() : 'Unspecified',
            minutes: nonNeg(finite(s.durationMinutes)),
          }))
      : [],
  };
}

function mapLine(doc: RawDoc): MPLine {
  const d = doc.data;
  const parts = Array.isArray(d.parts) ? d.parts : Array.isArray(d.models) ? d.models : [];
  return {
    id: doc.id,
    plant: d.plant ?? null,
    workshop: d.workshop ?? null,
    division: d.division ?? null,
    lineName: d.lineName ?? null,
    parts: parts
      .map((p: any) => ({ name: typeof p?.name === 'string' ? p.name.trim() : '' }))
      .filter((p: { name: string }) => p.name),
  };
}

function loadLines(ctx: ToolContext): Promise<MPLine[]> {
  return memo(ctx, 'lines', async () => (await ctx.data.getProductionLines()).map(mapLine));
}

interface LoadedRange {
  kept: AIRecord[];
  duplicates: AIRecord[];
}

// The whole range, de-duplicated BEFORE filtering (same order as the Model /
// Part page's buildReport, so a filter can't resurrect a dropped duplicate).
async function loadRange(ctx: ToolContext, from: string, to: string): Promise<LoadedRange> {
  return memo(ctx, `prod|${from}|${to}`, async () => {
    const [docs, lines] = await Promise.all([ctx.data.getProductionRecords(from, to), loadLines(ctx)]);
    const resolved = resolveLineFields(docs.map(mapAIRecord), lines) as AIRecord[];
    const { kept, duplicates } = dedupeProductionRecords(resolved);
    return { kept: kept as AIRecord[], duplicates: duplicates as AIRecord[] };
  });
}

interface LiveSession {
  lineId: string;
  productionDate: string | null;
  shift: string;
  stops: DowntimeStop[];
}

function loadSessions(ctx: ToolContext): Promise<LiveSession[]> {
  return memo(ctx, 'sessions', async () =>
    (await ctx.data.getActiveSessions()).map((doc) => {
      const d = doc.data;
      const stops: DowntimeStop[] = [];
      Object.values(d.stopsBySlot ?? {}).forEach((arr) => {
        (Array.isArray(arr) ? arr : []).forEach((s: any) => {
          if (s && typeof s.startAbs === 'number') stops.push(s);
        });
      });
      return {
        lineId: typeof d.lineId === 'string' ? d.lineId : doc.id,
        productionDate: resolveSessionProductionDate({ storedDate: d.productionDate, startedAt: d.startedAt }),
        shift: d.shift === 'B' ? 'B' : 'A',
        stops,
      };
    })
  );
}

// ─── Argument validation ─────────────────────────────────────────────────────

function obj(v: unknown, name: string): Record<string, unknown> {
  if (v == null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw new ToolArgError(`"${name}" must be an object.`);
  return v as Record<string, unknown>;
}

function optString(v: unknown, name: string): string | null {
  if (v == null || v === '') return null;
  if (typeof v !== 'string') throw new ToolArgError(`"${name}" must be a string.`);
  const t = v.trim();
  if (t.length > MAX_STRING_ARG) throw new ToolArgError(`"${name}" is too long.`);
  return t || null;
}

function onlyKeys(args: Record<string, unknown>, allowed: string[]) {
  const extra = Object.keys(args).filter((k) => !allowed.includes(k));
  if (extra.length) throw new ToolArgError(`Unknown argument(s): ${extra.join(', ')}.`);
}

function oneOf<T extends string>(v: unknown, name: string, allowed: readonly T[], fallback: T): T {
  if (v == null || v === '') return fallback;
  if (typeof v !== 'string' || !allowed.includes(v as T)) {
    throw new ToolArgError(`"${name}" must be one of: ${allowed.join(', ')}.`);
  }
  return v as T;
}

export interface DateRange {
  from: string;
  to: string;
}

// Same rules as the Model / Part page (YYYY-MM-DD, a real date, from ≤ to,
// at most 92 days), and never past today — there is no future production.
export function validateRange(fromRaw: unknown, toRaw: unknown, todayKey: string, label = ''): DateRange {
  const from = typeof fromRaw === 'string' ? fromRaw.trim() : '';
  const to = typeof toRaw === 'string' ? toRaw.trim() : '';
  const err = validateDateRange(from, to);
  if (err) throw new ToolArgError(`${label}${err}`);
  if (from > todayKey) throw new ToolArgError(`${label}${from} is in the future (today is ${todayKey}).`);
  return { from, to: to > todayKey ? todayKey : to };
}

export interface ResolvedFilters {
  plant: string | null;
  workshop: string | null;
  division: string | null;
  lineId: string | null;
  lineName: string | null;
  partKey: string | null;
  partName: string | null;
  partRegistered: boolean;
  shift: 'A' | 'B' | null;
}

const compact = (s: string) => normName(s).replace(/[^a-z0-9]/g, '');

function canonical(value: string | null, allowed: string[], name: string): string | null {
  if (!value) return null;
  const hit = allowed.find((a) => normName(a) === normName(value));
  if (!hit) throw new ToolArgError(`Unknown ${name} "${value}". Valid values: ${allowed.join(', ')}.`);
  return hit;
}

export function resolveFilters(raw: unknown, lines: MPLine[]): ResolvedFilters {
  const f = obj(raw, 'filters');
  onlyKeys(f, ['plant', 'workshop', 'division', 'line', 'part', 'shift']);
  const out: ResolvedFilters = {
    plant: canonical(optString(f.plant, 'plant'), PLANTS, 'plant'),
    workshop: canonical(optString(f.workshop, 'workshop'), WORKSHOPS, 'workshop'),
    division: canonical(optString(f.division, 'division'), DIVISIONS, 'division'),
    lineId: null,
    lineName: null,
    partKey: null,
    partName: null,
    partRegistered: true,
    shift: null,
  };

  const shift = optString(f.shift, 'shift');
  if (shift && !/^all$/i.test(shift)) {
    const s = shift.replace(/^shift\s*/i, '').toUpperCase();
    if (s !== 'A' && s !== 'B') throw new ToolArgError('"shift" must be A or B.');
    out.shift = s;
  }

  const line = optString(f.line, 'line');
  if (line) {
    const named = (l: MPLine) => l.lineName ?? l.id;
    let hits = lines.filter((l) => l.id === line || normName(l.lineName) === normName(line));
    if (!hits.length) hits = lines.filter((l) => compact(named(l)) === compact(line));
    if (hits.length !== 1) {
      const names = lines.map(named).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      throw new ToolArgError(
        `${hits.length ? 'Ambiguous' : 'Unknown'} line "${line}". Registered lines: ${names.slice(0, 60).join(', ')}${names.length > 60 ? ', …' : ''}.`
      );
    }
    out.lineId = hits[0].id;
    out.lineName = named(hits[0]);
  }

  const part = optString(f.part, 'part');
  if (part) {
    const registered = new Map<string, string>();
    lines.forEach((l) => (l.parts ?? []).forEach((p) => registered.set(normName(p.name), p.name)));
    out.partKey = normName(part);
    out.partName = registered.get(out.partKey) ?? part;
    out.partRegistered = registered.has(out.partKey);
  }
  return out;
}

export function filterLabels(f: ResolvedFilters): Record<string, string> {
  const out: Record<string, string> = {};
  if (f.plant) out.Plant = f.plant;
  if (f.workshop) out.Workshop = f.workshop;
  if (f.division) out.Division = f.division;
  if (f.lineName) out.Line = f.lineName;
  if (f.partName) out['Model / Part'] = f.partName;
  if (f.shift) out.Shift = `Shift ${f.shift}`;
  return out;
}

function sameValue(a: string | null | undefined, b: string | null) {
  return a != null && b != null && normName(a) === normName(b);
}

function matchesLineFilters(r: { plant: string | null; workshop: string | null; division: string | null; lineId: string | null }, f: ResolvedFilters) {
  if (f.plant && !sameValue(r.plant, f.plant)) return false;
  if (f.workshop && !sameValue(r.workshop, f.workshop)) return false;
  if (f.division && !sameValue(r.division, f.division)) return false;
  if (f.lineId && r.lineId !== f.lineId) return false;
  return true;
}

export function applyFilters<R extends AIRecord>(records: R[], f: ResolvedFilters): R[] {
  return records.filter((r) => {
    if (!matchesLineFilters(r, f)) return false;
    if (f.partKey && normName(r.partName) !== f.partKey) return false;
    if (f.shift && r.shift !== f.shift) return false;
    return true;
  });
}

// ─── Aggregation ─────────────────────────────────────────────────────────────

export const GROUP_BY = ['none', 'line', 'part', 'shift', 'day', 'line_shift', 'line_day', 'line_part', 'day_shift', 'part_shift'] as const;
export type GroupBy = (typeof GROUP_BY)[number];
type Dim = 'line' | 'part' | 'shift' | 'day';

function dimsOf(g: GroupBy): Dim[] {
  return g === 'none' ? [] : (g.split('_') as Dim[]);
}

const DIM_COLUMNS: Record<Dim, ResultColumn> = {
  day: { key: 'date', label: 'Production Date', kind: 'text' },
  line: { key: 'line', label: 'Line', kind: 'text' },
  part: { key: 'part', label: 'Model / Part', kind: 'text' },
  shift: { key: 'shift', label: 'Shift', kind: 'text' },
};

function dimValue(r: AIRecord, d: Dim): { key: string; label: string } {
  switch (d) {
    case 'day': {
      const k = dayKeyOf(r) ?? 'unknown';
      return { key: k, label: k === 'unknown' ? 'Unknown date' : k };
    }
    case 'line':
      return { key: r.lineId ?? 'unknown', label: r.lineName ?? 'Unknown line' };
    case 'part':
      return { key: r.partName ? normName(r.partName) : '__unknown__', label: r.partName?.trim() || 'Unknown part' };
    case 'shift':
      return { key: r.shift, label: `Shift ${r.shift}` };
  }
}

export interface ProductionTotals {
  produced: number;
  target: number;
  variance: number;
  efficiencyPct: number | null;
  rejected: number;
  rejectionPct: number | null;
  legacyRejectionRecords: number;
  downtimeMinutes: number;
  lossParts: number;
  slotRecords: number;
}

// The figures of Generate Report's summary cards, over one set of
// (de-duplicated, filtered) records.
export function productionTotals(records: AIRecord[]): ProductionTotals {
  const eff = efficiencyOf(records);
  const q = counterQuality(records);
  let rejected = 0;
  let downtime = 0;
  let loss = 0;
  records.forEach((r) => {
    rejected += nonNeg(r.rejections);
    r.stops.forEach((s) => { downtime += s.minutes; });
    loss += r.lossParts ?? Math.max(0, nonNeg(r.expectedParts) - nonNeg(r.producedThisSlot));
  });
  return {
    produced: eff.actual,
    target: eff.planned,
    variance: eff.actual - eff.planned,
    efficiencyPct: eff.efficiency,
    rejected,
    rejectionPct: q.rejectionPct,
    legacyRejectionRecords: q.legacyRecords,
    downtimeMinutes: round1(downtime),
    lossParts: Math.round(loss),
    slotRecords: records.length,
  };
}

export interface GroupRow {
  key: string;
  labels: Partial<Record<Dim, string>>;
  dayKey: string | null;
  totals: ProductionTotals;
}

export function groupProduction(records: AIRecord[], groupBy: GroupBy): GroupRow[] {
  const dims = dimsOf(groupBy);
  const groups = new Map<string, { labels: Partial<Record<Dim, string>>; dayKey: string | null; records: AIRecord[] }>();
  records.forEach((r) => {
    const vals = dims.map((d) => [d, dimValue(r, d)] as const);
    const key = vals.map(([, v]) => v.key).join('|') || 'all';
    let g = groups.get(key);
    if (!g) {
      const labels: Partial<Record<Dim, string>> = {};
      vals.forEach(([d, v]) => { labels[d] = v.label; });
      g = { labels, dayKey: dims.includes('day') ? dayKeyOf(r) : null, records: [] };
      groups.set(key, g);
    }
    g.records.push(r);
  });
  return Array.from(groups, ([key, g]) => ({ key, labels: g.labels, dayKey: g.dayKey, totals: productionTotals(g.records) }));
}

const labelOrder = (a: GroupRow, b: GroupRow) =>
  Object.values(a.labels).join(' ').localeCompare(Object.values(b.labels).join(' '), undefined, { numeric: true });

export const SORT_BY = ['default', 'produced_desc', 'produced_asc', 'shortfall_desc', 'efficiency_asc', 'efficiency_desc', 'rejection_pct_desc', 'rejected_desc', 'downtime_desc', 'label'] as const;
export type SortBy = (typeof SORT_BY)[number];

export function sortGroups(rows: GroupRow[], sort: SortBy, groupBy: GroupBy): GroupRow[] {
  const s: SortBy = sort === 'default' ? (dimsOf(groupBy).includes('day') || groupBy === 'shift' ? 'label' : 'produced_desc') : sort;
  const nullLast = (v: number | null, dir: 1 | -1) => (v == null ? Infinity : dir * v);
  return [...rows].sort((a, b) => {
    const A = a.totals;
    const B = b.totals;
    switch (s) {
      case 'produced_desc': return B.produced - A.produced || labelOrder(a, b);
      case 'produced_asc': return A.produced - B.produced || labelOrder(a, b);
      case 'shortfall_desc': return A.variance - B.variance || labelOrder(a, b);
      case 'efficiency_asc': return nullLast(A.efficiencyPct, 1) - nullLast(B.efficiencyPct, 1) || labelOrder(a, b);
      case 'efficiency_desc': return nullLast(A.efficiencyPct, -1) - nullLast(B.efficiencyPct, -1) || labelOrder(a, b);
      case 'rejection_pct_desc': return nullLast(A.rejectionPct, -1) - nullLast(B.rejectionPct, -1) || labelOrder(a, b);
      case 'rejected_desc': return B.rejected - A.rejected || labelOrder(a, b);
      case 'downtime_desc': return B.downtimeMinutes - A.downtimeMinutes || labelOrder(a, b);
      default: {
        const da = a.dayKey ?? '';
        const db = b.dayKey ?? '';
        return da.localeCompare(db) || labelOrder(a, b);
      }
    }
  });
}

// ─── Result blocks ───────────────────────────────────────────────────────────

const PRODUCTION_SOURCE =
  'productionRecords, selected by production date (plus records saved before that field existed, by createdAt), one record per slot';

const DEF = {
  produced: 'Produced = Σ producedThisSlot — the good parts supervisors record per hourly slot (rejections are counted separately, not subtracted).',
  target: 'Target = Σ expectedParts — each slot\'s target from cycle time × productive minutes (breaks, startup reserve and changeovers deducted).',
  efficiency: 'Efficiency % = Produced ÷ Target × 100 over the whole group (not an average of slot percentages).',
  variance: 'Variance = Produced − Target (negative = shortfall).',
  rejection: 'Rejection % = Rejected ÷ (Produced + Rejected) × 100, from the slot Rejections counter; records saved without that counter are excluded.',
  downtime: 'Downtime = recorded line-stop minutes inside each saved slot (each stop minute counted once).',
  productionDate: 'Production date runs 6:30 AM to 6:30 AM; Shift B (7:00 PM – 3:30 AM, plus OT) belongs to the date it started.',
};

const PRODUCTION_COLUMNS: ResultColumn[] = [
  { key: 'produced', label: 'Produced', kind: 'number' },
  { key: 'target', label: 'Target', kind: 'number' },
  { key: 'variance', label: 'Variance', kind: 'number' },
  { key: 'efficiencyPct', label: 'Efficiency %', kind: 'percent' },
  { key: 'rejected', label: 'Rejected', kind: 'number' },
  { key: 'rejectionPct', label: 'Rejection %', kind: 'percent' },
  { key: 'downtimeMinutes', label: 'Downtime (min)', kind: 'minutes' },
  { key: 'slotRecords', label: 'Slot Records', kind: 'number' },
];

function totalsRow(t: ProductionTotals): Record<string, Cell> {
  return {
    produced: t.produced, target: t.target, variance: t.variance, efficiencyPct: t.efficiencyPct,
    rejected: t.rejected, rejectionPct: t.rejectionPct, downtimeMinutes: t.downtimeMinutes, slotRecords: t.slotRecords,
  };
}

function totalsMetrics(t: ProductionTotals, keys: (keyof ProductionTotals)[]): ResultMetric[] {
  const all: Record<string, ResultMetric> = {
    produced: { label: 'Produced (good parts)', value: t.produced, kind: 'number' },
    target: { label: 'Target', value: t.target, kind: 'number' },
    variance: { label: 'Variance vs target', value: t.variance, kind: 'number' },
    efficiencyPct: { label: 'Efficiency', value: t.efficiencyPct, kind: 'percent' },
    rejected: { label: 'Rejected', value: t.rejected, kind: 'number' },
    rejectionPct: { label: 'Rejection rate', value: t.rejectionPct, kind: 'percent' },
    downtimeMinutes: { label: 'Downtime', value: t.downtimeMinutes, kind: 'minutes' },
    lossParts: { label: 'Loss parts', value: t.lossParts, kind: 'number' },
    slotRecords: { label: 'Slot records', value: t.slotRecords, kind: 'number' },
  };
  return keys.map((k) => all[k]).filter(Boolean);
}

interface Notes {
  notes: string[];
  complete: boolean;
}

// Known data limitations of a production result, stated rather than hidden.
async function productionNotes(
  ctx: ToolContext,
  range: DateRange,
  f: ResolvedFilters,
  loaded: LoadedRange,
  records: AIRecord[]
): Promise<Notes> {
  const notes: string[] = [];
  let complete = true;
  const dups = applyFilters(loaded.duplicates, f);
  if (dups.length) {
    complete = false;
    const extra = dups.reduce((s, r) => s + nonNeg(r.producedThisSlot), 0);
    notes.push(
      `${dups.length} duplicate slot record(s) (${extra} parts) were excluded — the same slot was saved more than once. ` +
        `Generate Report adds them, so its total would be ${extra} higher.`
    );
  }
  const legacy = records.filter((r) => r.rejections == null).length;
  if (legacy) notes.push(`${legacy} slot record(s) have no rejection counter; they are left out of the rejection rate.`);
  if (!f.partRegistered) notes.push(`"${f.partName}" is not a registered model/part on any line; matched against part names on saved records.`);
  if (f.partKey && !records.length) notes.push(`No saved records matched model/part "${f.partName}".`);

  const today = productionDayKeyFor(ctx.nowMs);
  if (range.to >= addDays(today, -1)) {
    const lines = await loadLines(ctx);
    const lineById = new Map(lines.map((l) => [l.id, l]));
    const live = (await loadSessions(ctx)).filter((s) => {
      if (!s.productionDate || s.productionDate < range.from || s.productionDate > range.to) return false;
      if (f.shift && s.shift !== f.shift) return false;
      const l = lineById.get(s.lineId);
      return matchesLineFilters({ plant: l?.plant ?? null, workshop: l?.workshop ?? null, division: l?.division ?? null, lineId: s.lineId }, f);
    });
    if (live.length) {
      complete = false;
      notes.push(`${live.length} production session(s) in this range are still running — only slots already saved are included.`);
    }
  }
  return { notes, complete };
}

function addDays(key: string, days: number): string {
  const [y, m, d] = key.split('-').map(Number);
  return calendarKey(new Date(y, m - 1, d + days).getTime());
}

function cap(rows: Record<string, Cell>[]): { rows: Record<string, Cell>[]; truncatedRows: number } {
  return rows.length > DISPLAY_ROW_LIMIT
    ? { rows: rows.slice(0, DISPLAY_ROW_LIMIT), truncatedRows: rows.length - DISPLAY_ROW_LIMIT }
    : { rows, truncatedRows: 0 };
}

function groupColumns(groupBy: GroupBy): ResultColumn[] {
  return dimsOf(groupBy).map((d) => DIM_COLUMNS[d]);
}

function groupLabelCells(g: GroupRow, groupBy: GroupBy): Record<string, Cell> {
  const out: Record<string, Cell> = {};
  dimsOf(groupBy).forEach((d) => { out[DIM_COLUMNS[d].key] = g.labels[d] ?? ''; });
  return out;
}

// Compact copy of a block for the model: same numbers, fewer rows.
export function modelView(block: ResultBlock) {
  return {
    resultId: block.id,
    title: block.title,
    dateRange: block.dateRange,
    filters: block.filters,
    metrics: Object.fromEntries(block.metrics.map((m) => [m.label, m.value])),
    columns: block.columns.map((c) => c.label),
    rows: block.rows.slice(0, MODEL_ROW_LIMIT).map((r) => block.columns.map((c) => r[c.key] ?? null)),
    totalRows: block.rows.length + block.truncatedRows,
    rowsSentToYou: Math.min(block.rows.length, MODEL_ROW_LIMIT),
    complete: block.complete,
    notes: block.notes,
  };
}

// ─── Tool implementations ────────────────────────────────────────────────────

export interface ToolOutput {
  block: ResultBlock | null;
  forModel: unknown;
}

type ToolImpl = (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolOutput>;

async function productionTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
  spec: {
    tool: string;
    title: (range: DateRange) => string;
    allowedGroupBy: readonly GroupBy[];
    defaultGroupBy: GroupBy;
    defaultSort: SortBy;
    columns: string[];
    metricKeys: (keyof ProductionTotals)[];
    definitions: string[];
    chartValue: string;
  }
): Promise<ToolOutput> {
  onlyKeys(args, ['fromDate', 'toDate', 'filters', 'groupBy', 'sortBy', 'limit']);
  const today = productionDayKeyFor(ctx.nowMs);
  const range = validateRange(args.fromDate, args.toDate, today);
  const groupBy = oneOf(args.groupBy, 'groupBy', spec.allowedGroupBy, spec.defaultGroupBy);
  const sortBy = oneOf(args.sortBy, 'sortBy', SORT_BY, spec.defaultSort);
  const limit = args.limit == null ? null : Number(args.limit);
  if (limit != null && (!Number.isInteger(limit) || limit < 1 || limit > DISPLAY_ROW_LIMIT)) {
    throw new ToolArgError(`"limit" must be a whole number from 1 to ${DISPLAY_ROW_LIMIT}.`);
  }
  const lines = await loadLines(ctx);
  const f = resolveFilters(args.filters, lines);
  const loaded = await loadRange(ctx, range.from, range.to);
  const records = applyFilters(loaded.kept, f);
  const totals = productionTotals(records);
  const { notes, complete } = await productionNotes(ctx, range, f, loaded, records);

  let columns: ResultColumn[] = [];
  let rows: Record<string, Cell>[] = [];
  if (groupBy !== 'none') {
    let groups = sortGroups(groupProduction(records, groupBy), sortBy, groupBy);
    if (limit != null && groups.length > limit) {
      notes.push(`Showing the first ${limit} of ${groups.length} groups.`);
      groups = groups.slice(0, limit);
    }
    columns = [...groupColumns(groupBy), ...PRODUCTION_COLUMNS.filter((c) => spec.columns.includes(c.key))];
    rows = groups.map((g) => ({ ...groupLabelCells(g, groupBy), ...totalsRow(g.totals) }));
  }
  const capped = cap(rows);
  const labelKey = groupBy !== 'none' && dimsOf(groupBy).length === 1 ? DIM_COLUMNS[dimsOf(groupBy)[0]].key : null;
  const block: ResultBlock = {
    id: ctx.nextId(),
    tool: spec.tool,
    title: spec.title(range) + (groupBy !== 'none' ? ` — by ${groupBy.replace(/_/g, ' & ').replace('day', 'date')}` : ''),
    dateRange: { ...range, convention: 'production-date' },
    filters: filterLabels(f),
    source: PRODUCTION_SOURCE,
    definitions: [...spec.definitions, DEF.productionDate],
    metrics: totalsMetrics(totals, spec.metricKeys),
    columns,
    rows: capped.rows,
    chart: labelKey && capped.rows.length > 1 && capped.rows.length <= 40 ? { labelKey, valueKey: spec.chartValue } : null,
    complete,
    notes,
    truncatedRows: capped.truncatedRows,
  };
  return { block, forModel: modelView(block) };
}

const rangeTitle = (prefix: string) => (r: DateRange) => (r.from === r.to ? `${prefix} — ${r.from}` : `${prefix} — ${r.from} to ${r.to}`);

const getProductionSummary: ToolImpl = (args, ctx) =>
  productionTool(args, ctx, {
    tool: 'getProductionSummary',
    title: rangeTitle('Production'),
    allowedGroupBy: GROUP_BY,
    defaultGroupBy: 'none',
    defaultSort: 'default',
    columns: PRODUCTION_COLUMNS.map((c) => c.key),
    metricKeys: ['produced', 'target', 'variance', 'efficiencyPct', 'rejected', 'rejectionPct', 'downtimeMinutes', 'slotRecords'],
    definitions: [DEF.produced, DEF.target, DEF.efficiency, DEF.rejection, DEF.downtime],
    chartValue: 'produced',
  });

const getTargetVariance: ToolImpl = (args, ctx) =>
  productionTool(args, ctx, {
    tool: 'getProductionTargetVariance',
    title: rangeTitle('Target vs actual'),
    allowedGroupBy: GROUP_BY.filter((g) => g !== 'none'),
    defaultGroupBy: 'line',
    defaultSort: 'shortfall_desc',
    columns: ['produced', 'target', 'variance', 'efficiencyPct', 'downtimeMinutes', 'slotRecords'],
    metricKeys: ['produced', 'target', 'variance', 'efficiencyPct', 'lossParts'],
    definitions: [DEF.produced, DEF.target, DEF.variance, DEF.efficiency],
    chartValue: 'efficiencyPct',
  });

const getRejectionSummary: ToolImpl = (args, ctx) =>
  productionTool(args, ctx, {
    tool: 'getRejectionSummary',
    title: rangeTitle('Rejections (slot counter)'),
    allowedGroupBy: GROUP_BY,
    defaultGroupBy: 'part',
    defaultSort: 'rejection_pct_desc',
    columns: ['produced', 'rejected', 'rejectionPct', 'slotRecords'],
    metricKeys: ['produced', 'rejected', 'rejectionPct'],
    definitions: [DEF.rejection, DEF.produced],
    chartValue: 'rejectionPct',
  });

// Downtime: saved records' stopEvents, plus still-running sessions counted
// once and in full (utils/downtime combinedDowntimeMinutes' rule: a live
// session is the authority for its own line + date + shift, so that
// session's saved records are skipped).
const DOWNTIME_GROUP_BY = ['reason', 'line', 'shift', 'day', 'line_reason', 'day_reason'] as const;

const getDowntimeSummary: ToolImpl = async (args, ctx) => {
  onlyKeys(args, ['fromDate', 'toDate', 'filters', 'groupBy']);
  const today = productionDayKeyFor(ctx.nowMs);
  const range = validateRange(args.fromDate, args.toDate, today);
  const groupBy = oneOf(args.groupBy, 'groupBy', DOWNTIME_GROUP_BY, 'reason');
  const lines = await loadLines(ctx);
  const f = resolveFilters(args.filters, lines);
  const loaded = await loadRange(ctx, range.from, range.to);
  const records = applyFilters(loaded.kept, f);
  const { notes, complete: baseComplete } = await productionNotes(ctx, range, f, loaded, records);
  let complete = baseComplete;

  const lineById = new Map(lines.map((l) => [l.id, l]));
  const sessionKey = (lineId: string | null, day: string | null, shift: string) => `${lineId ?? ''}|${day ?? ''}|${shift}`;
  const sessions = f.partKey
    ? []
    : (await loadSessions(ctx)).filter((s) => {
        if (!s.productionDate || s.productionDate < range.from || s.productionDate > range.to) return false;
        if (f.shift && s.shift !== f.shift) return false;
        const l = lineById.get(s.lineId);
        return matchesLineFilters({ plant: l?.plant ?? null, workshop: l?.workshop ?? null, division: l?.division ?? null, lineId: s.lineId }, f);
      });
  if (f.partKey && range.to >= addDays(today, -1)) {
    notes.push('Stops of sessions still running are not included when filtering by model/part (a running stop is not tied to a part until its slot is saved).');
    complete = false;
  }
  const live = new Set(sessions.map((s) => sessionKey(s.lineId, s.productionDate, s.shift)));

  type Ev = { reason: string; line: string; lineId: string; shift: string; day: string; minutes: number; stopKey: string };
  const events: Ev[] = [];
  records.forEach((r) => {
    const day = dayKeyOf(r) ?? 'unknown';
    if (live.has(sessionKey(r.lineId, day, r.shift))) return;
    r.stops.forEach((s, i) => {
      events.push({
        reason: formatStopReason(s.reason), line: r.lineName ?? 'Unknown line', lineId: r.lineId ?? 'unknown', shift: r.shift, day,
        minutes: s.minutes, stopKey: `${r.lineId}|${day}|${r.shift}|${s.stopId ?? `${r.id}#${i}`}`,
      });
    });
  });
  sessions.forEach((s) => {
    const seen = new Set<string>();
    s.stops.forEach((st) => {
      const id = stopIdOf(st);
      if (seen.has(id)) return;
      seen.add(id);
      const minutes = st.running
        ? stopDurationMinutes(st.startAbs, ctx.nowMs)
        : typeof st.durationMinutes === 'number'
          ? Math.max(0, st.durationMinutes)
          : typeof st.endAbs === 'number'
            ? stopDurationMinutes(st.startAbs, st.endAbs)
            : 0;
      const l = lineById.get(s.lineId);
      events.push({
        reason: formatStopReason(typeof st.reason === 'string' && st.reason.trim() ? st.reason : 'Unspecified'),
        line: l?.lineName ?? s.lineId, lineId: s.lineId, shift: s.shift, day: s.productionDate ?? 'unknown',
        minutes, stopKey: `${s.lineId}|${s.productionDate}|${s.shift}|${id}`,
      });
    });
  });
  if (sessions.length) notes.push(`Includes stops of ${sessions.length} session(s) still running (a running stop counts up to now).`);

  const dims = groupBy.split('_') as ('reason' | 'line' | 'shift' | 'day')[];
  const groups = new Map<string, { labels: Record<string, string>; minutes: number; stops: Set<string> }>();
  let total = 0;
  const allStops = new Set<string>();
  events.forEach((e) => {
    const vals = dims.map((d) => (d === 'reason' ? [d, e.reason, e.reason] : d === 'line' ? [d, e.lineId, e.line] : d === 'shift' ? [d, e.shift, `Shift ${e.shift}`] : [d, e.day, e.day]));
    const key = vals.map((v) => v[1]).join('|');
    const g = groups.get(key) ?? { labels: Object.fromEntries(vals.map((v) => [v[0], v[2]])), minutes: 0, stops: new Set<string>() };
    g.minutes += e.minutes;
    g.stops.add(e.stopKey);
    groups.set(key, g);
    total += e.minutes;
    allStops.add(e.stopKey);
  });
  const dimCols: Record<string, ResultColumn> = {
    reason: { key: 'reason', label: 'Stop Reason', kind: 'text' },
    line: DIM_COLUMNS.line,
    shift: DIM_COLUMNS.shift,
    day: DIM_COLUMNS.day,
  };
  const colKey = (d: string) => dimCols[d].key;
  const rows = Array.from(groups.values())
    .map((g) => ({
      ...Object.fromEntries(dims.map((d) => [colKey(d), g.labels[d]])),
      minutes: round1(g.minutes),
      stops: g.stops.size,
      share: total > 0 ? round1((g.minutes / total) * 100) : null,
    }))
    .sort((a, b) => (dims.includes('day') && dims.length === 1 ? String((a as Record<string, Cell>).date).localeCompare(String((b as Record<string, Cell>).date)) : b.minutes - a.minutes));
  const capped = cap(rows);
  const block: ResultBlock = {
    id: ctx.nextId(),
    tool: 'getDowntimeSummary',
    title: `${rangeTitle('Downtime')(range)} — by ${groupBy.replace('_', ' & ').replace('day', 'date')}`,
    dateRange: { ...range, convention: 'production-date' },
    filters: filterLabels(f),
    source: `${PRODUCTION_SOURCE}; stopEvents of saved slots, plus activeSessions for lines still running`,
    definitions: [DEF.downtime, 'Stops = distinct recorded stop intervals (a stop crossing two slots is one stop).', DEF.productionDate],
    metrics: [
      { label: 'Total downtime', value: round1(total), kind: 'minutes' },
      { label: 'Recorded stops', value: allStops.size, kind: 'number' },
    ],
    columns: [...dims.map((d) => dimCols[d]), { key: 'minutes', label: 'Downtime (min)', kind: 'minutes' }, { key: 'stops', label: 'Stops', kind: 'number' }, { key: 'share', label: 'Share %', kind: 'percent' }],
    rows: capped.rows,
    chart: dims.length === 1 && capped.rows.length > 1 && capped.rows.length <= 40 ? { labelKey: colKey(dims[0]), valueKey: 'minutes' } : null,
    complete,
    notes: notes.filter((n) => !n.includes('rejection counter')),
    truncatedRows: capped.truncatedRows,
  };
  return { block, forModel: modelView(block) };
};

// rejectionRecords — the separate Record Rejection defect log (calendar
// date). Never added to the slot-counter rejections: both may log the same
// parts (see utils/qualityMetrics).
const DEFECT_GROUP_BY = ['defect', 'stage', 'line', 'part', 'shift', 'day', 'line_defect', 'part_defect'] as const;

const getDefectLogSummary: ToolImpl = async (args, ctx) => {
  onlyKeys(args, ['fromDate', 'toDate', 'filters', 'groupBy']);
  const range = validateRange(args.fromDate, args.toDate, calendarKey(ctx.nowMs));
  const groupBy = oneOf(args.groupBy, 'groupBy', DEFECT_GROUP_BY, 'defect');
  const lines = await loadLines(ctx);
  const f = resolveFilters(args.filters, lines);
  const docs = await memo(ctx, `rej|${range.from}|${range.to}`, () => ctx.data.getRejectionLog(range.from, range.to));
  const lineById = new Map(lines.map((l) => [l.id, l]));
  const entries = docs
    .map(({ data: d }) => {
      const l = typeof d.lineId === 'string' ? lineById.get(d.lineId) : undefined;
      return {
        date: typeof d.date === 'string' ? d.date : 'unknown',
        shift: d.shift === 'B' ? 'B' : d.shift === 'A' ? 'A' : null,
        plant: l?.plant ?? d.plant ?? null,
        workshop: l?.workshop ?? d.workshop ?? null,
        division: l?.division ?? d.division ?? null,
        lineId: typeof d.lineId === 'string' ? d.lineId : null,
        lineName: l?.lineName ?? d.lineName ?? 'Unknown line',
        part: typeof d.partName === 'string' && d.partName.trim() ? d.partName.trim() : 'Unknown part',
        stage: typeof d.stage === 'string' && d.stage.trim() ? d.stage.trim() : 'Unspecified',
        defect: typeof d.defect === 'string' && d.defect.trim() ? d.defect.trim() : 'Unspecified',
        qty: nonNeg(finite(d.rejectionQty)),
      };
    })
    .filter((e) => matchesLineFilters(e, f) && (!f.partKey || normName(e.part) === f.partKey) && (!f.shift || e.shift === f.shift));

  const dims = groupBy.split('_') as ('defect' | 'stage' | 'line' | 'part' | 'shift' | 'day')[];
  const cols: Record<string, ResultColumn> = {
    defect: { key: 'defect', label: 'Defect', kind: 'text' },
    stage: { key: 'stage', label: 'Stage', kind: 'text' },
    line: DIM_COLUMNS.line,
    part: DIM_COLUMNS.part,
    shift: DIM_COLUMNS.shift,
    day: { key: 'date', label: 'Date', kind: 'text' },
  };
  const valueOf = (e: (typeof entries)[number], d: string) =>
    d === 'line' ? e.lineName : d === 'part' ? e.part : d === 'shift' ? (e.shift ? `Shift ${e.shift}` : 'Unknown') : d === 'day' ? e.date : d === 'stage' ? e.stage : e.defect;
  const groups = new Map<string, Record<string, Cell> & { qty: number; entries: number }>();
  let total = 0;
  entries.forEach((e) => {
    const labels = dims.map((d) => valueOf(e, d));
    const key = labels.map((l) => normName(l)).join('|');
    const g = groups.get(key) ?? { ...Object.fromEntries(dims.map((d, i) => [cols[d].key, labels[i]])), qty: 0, entries: 0 };
    g.qty += e.qty;
    g.entries++;
    groups.set(key, g);
    total += e.qty;
  });
  const rows = Array.from(groups.values())
    .map((g) => ({ ...g, share: total > 0 ? round1((g.qty / total) * 100) : null }))
    .sort((a, b) => (groupBy === 'day' ? String((a as Record<string, Cell>).date).localeCompare(String((b as Record<string, Cell>).date)) : b.qty - a.qty));
  const capped = cap(rows);
  const notes = ['This is the Record Rejection defect log. It is separate from the slot Rejections counter used for rejection rates and may record the same parts — do not add the two.'];
  if (f.shift) notes.push('Entries saved without a shift are excluded by the shift filter.');
  const block: ResultBlock = {
    id: ctx.nextId(),
    tool: 'getDefectLogSummary',
    title: `${rangeTitle('Defect log')(range)} — by ${groupBy.replace('_', ' & ').replace('day', 'date')}`,
    dateRange: { ...range, convention: 'calendar-date' },
    filters: filterLabels(f),
    source: 'rejectionRecords (Record Rejection screen), by calendar date',
    definitions: ['Quantity = Σ rejectionQty of the defect log entries.'],
    metrics: [
      { label: 'Rejected quantity (defect log)', value: total, kind: 'number' },
      { label: 'Log entries', value: entries.length, kind: 'number' },
    ],
    columns: [...dims.map((d) => cols[d]), { key: 'qty', label: 'Quantity', kind: 'number' }, { key: 'entries', label: 'Entries', kind: 'number' }, { key: 'share', label: 'Share %', kind: 'percent' }],
    rows: capped.rows,
    chart: dims.length === 1 && capped.rows.length > 1 && capped.rows.length <= 40 ? { labelKey: cols[dims[0]].key, valueKey: 'qty' } : null,
    complete: true,
    notes,
    truncatedRows: capped.truncatedRows,
  };
  return { block, forModel: modelView(block) };
};

const COMPARE_METRICS: { key: keyof ProductionTotals; label: string; kind: ResultColumn['kind'] }[] = [
  { key: 'produced', label: 'Produced (good parts)', kind: 'number' },
  { key: 'target', label: 'Target', kind: 'number' },
  { key: 'variance', label: 'Variance vs target', kind: 'number' },
  { key: 'efficiencyPct', label: 'Efficiency %', kind: 'percent' },
  { key: 'rejected', label: 'Rejected', kind: 'number' },
  { key: 'rejectionPct', label: 'Rejection %', kind: 'percent' },
  { key: 'downtimeMinutes', label: 'Downtime (min)', kind: 'minutes' },
  { key: 'slotRecords', label: 'Slot records', kind: 'number' },
];

const compareProductionPeriods: ToolImpl = async (args, ctx) => {
  onlyKeys(args, ['currentFrom', 'currentTo', 'previousFrom', 'previousTo', 'filters']);
  const today = productionDayKeyFor(ctx.nowMs);
  const cur = validateRange(args.currentFrom, args.currentTo, today, 'Current period: ');
  const prev = validateRange(args.previousFrom, args.previousTo, today, 'Previous period: ');
  const lines = await loadLines(ctx);
  const f = resolveFilters(args.filters, lines);
  const [lc, lp] = await Promise.all([loadRange(ctx, cur.from, cur.to), loadRange(ctx, prev.from, prev.to)]);
  const rc = applyFilters(lc.kept, f);
  const rp = applyFilters(lp.kept, f);
  const tc = productionTotals(rc);
  const tp = productionTotals(rp);
  const nc = await productionNotes(ctx, cur, f, lc, rc);
  const np = await productionNotes(ctx, prev, f, lp, rp);
  const rows = COMPARE_METRICS.map((m) => {
    const a = tc[m.key] as number | null;
    const b = tp[m.key] as number | null;
    const change = a != null && b != null ? round1(a - b) : null;
    const pct = m.kind !== 'percent' && a != null && b != null && b !== 0 ? round1(((a - b) / Math.abs(b)) * 100) : null;
    return { metric: m.label, current: a, previous: b, change, changePct: pct };
  });
  const block: ResultBlock = {
    id: ctx.nextId(),
    tool: 'compareProductionPeriods',
    title: `Comparison — ${cur.from}…${cur.to} vs ${prev.from}…${prev.to}`,
    dateRange: { from: prev.from < cur.from ? prev.from : cur.from, to: prev.to > cur.to ? prev.to : cur.to, convention: 'production-date' },
    filters: { ...filterLabels(f), 'Current period': `${cur.from} to ${cur.to}`, 'Previous period': `${prev.from} to ${prev.to}` },
    source: PRODUCTION_SOURCE,
    definitions: [DEF.produced, DEF.target, DEF.efficiency, DEF.rejection, DEF.downtime, 'Change % is relative to the previous period; for percentages the change is in percentage points.', DEF.productionDate],
    metrics: [],
    columns: [
      { key: 'metric', label: 'Metric', kind: 'text' },
      { key: 'current', label: 'Current', kind: 'number' },
      { key: 'previous', label: 'Previous', kind: 'number' },
      { key: 'change', label: 'Change', kind: 'number' },
      { key: 'changePct', label: 'Change %', kind: 'percent' },
    ],
    rows,
    chart: null,
    complete: nc.complete && np.complete,
    notes: [...nc.notes.map((n) => `Current period: ${n}`), ...np.notes.map((n) => `Previous period: ${n}`)],
    truncatedRows: 0,
  };
  return { block, forModel: modelView(block) };
};

const getProductionRecordDetails: ToolImpl = async (args, ctx) => {
  onlyKeys(args, ['fromDate', 'toDate', 'filters', 'limit']);
  const today = productionDayKeyFor(ctx.nowMs);
  const range = validateRange(args.fromDate, args.toDate, today);
  const limit = args.limit == null ? 50 : Number(args.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > DETAIL_ROW_MAX) throw new ToolArgError(`"limit" must be a whole number from 1 to ${DETAIL_ROW_MAX}.`);
  const lines = await loadLines(ctx);
  const f = resolveFilters(args.filters, lines);
  const loaded = await loadRange(ctx, range.from, range.to);
  const records = applyFilters(loaded.kept, f).sort(
    (a, b) =>
      (dayKeyOf(a) ?? '').localeCompare(dayKeyOf(b) ?? '') ||
      (a.lineName ?? '').localeCompare(b.lineName ?? '', undefined, { numeric: true }) ||
      a.shift.localeCompare(b.shift) ||
      (a.slotIndex ?? 0) - (b.slotIndex ?? 0) ||
      (a.partSegment === 'after' ? 1 : 0) - (b.partSegment === 'after' ? 1 : 0)
  );
  const { notes, complete } = await productionNotes(ctx, range, f, loaded, records);
  if (records.length > limit) notes.push(`Showing the first ${limit} of ${records.length} slot records.`);
  const rows = records.slice(0, limit).map((r) => ({
    date: dayKeyOf(r) ?? 'unknown',
    shift: `Shift ${r.shift}`,
    line: r.lineName ?? 'Unknown line',
    part: r.partName ?? 'Unknown part',
    slot: r.slotLabel ?? (r.slotIndex != null ? `Slot ${r.slotIndex + 1}` : ''),
    segment: r.partSegment === 'before' ? 'Before changeover' : r.partSegment === 'after' ? 'After changeover' : 'Full slot',
    produced: nonNeg(r.producedThisSlot),
    target: nonNeg(r.expectedParts),
    rejected: r.rejections == null ? null : nonNeg(r.rejections),
    downtimeMinutes: round1(r.stops.reduce((s, x) => s + x.minutes, 0)),
    lossReason: r.lossReasonLabel ?? (r.stops.length ? Array.from(new Set(r.stops.map((s) => s.reason))).join(', ') : ''),
  }));
  const block: ResultBlock = {
    id: ctx.nextId(),
    tool: 'getProductionRecordDetails',
    title: rangeTitle('Slot records')(range),
    dateRange: { ...range, convention: 'production-date' },
    filters: filterLabels(f),
    source: PRODUCTION_SOURCE,
    definitions: [DEF.produced, DEF.target, DEF.productionDate],
    metrics: totalsMetrics(productionTotals(records), ['produced', 'target', 'slotRecords']),
    columns: [
      { key: 'date', label: 'Production Date', kind: 'text' },
      { key: 'shift', label: 'Shift', kind: 'text' },
      { key: 'line', label: 'Line', kind: 'text' },
      { key: 'part', label: 'Model / Part', kind: 'text' },
      { key: 'slot', label: 'Slot', kind: 'text' },
      { key: 'segment', label: 'Segment', kind: 'text' },
      { key: 'produced', label: 'Produced', kind: 'number' },
      { key: 'target', label: 'Target', kind: 'number' },
      { key: 'rejected', label: 'Rejected', kind: 'number' },
      { key: 'downtimeMinutes', label: 'Downtime (min)', kind: 'minutes' },
      { key: 'lossReason', label: 'Loss / Stop Reason', kind: 'text' },
    ],
    rows,
    chart: null,
    complete: complete && records.length <= limit,
    notes,
    truncatedRows: 0,
  };
  return { block, forModel: modelView(block) };
};

// Reference data for resolving the user's wording — no ResultBlock.
const getAvailableProductionFilters: ToolImpl = async (args, ctx) => {
  onlyKeys(args, []);
  const lines = await loadLines(ctx);
  return {
    block: null,
    forModel: {
      currentProductionDate: productionDayKeyFor(ctx.nowMs),
      currentCalendarDate: calendarKey(ctx.nowMs),
      plants: PLANTS,
      workshops: WORKSHOPS,
      divisions: DIVISIONS,
      shifts: { A: '07:00 – 15:30 (+ OT)', B: '19:00 – 03:30 next morning (+ OT), filed under the date it started' },
      lines: lines
        .map((l) => ({ line: l.lineName ?? l.id, plant: l.plant, workshop: l.workshop, division: l.division, parts: (l.parts ?? []).map((p) => p.name) }))
        .sort((a, b) => a.line.localeCompare(b.line, undefined, { numeric: true }))
        .slice(0, 300),
    },
  };
};

// ─── Registry + declarations ─────────────────────────────────────────────────

const DATE = { type: 'string', description: 'Date as YYYY-MM-DD.' };
const FILTERS = {
  type: 'object',
  description: 'Optional filters. Omit a key for "all". Use names exactly as returned by getAvailableProductionFilters.',
  properties: {
    plant: { type: 'string' },
    workshop: { type: 'string' },
    division: { type: 'string' },
    line: { type: 'string', description: 'Line name, e.g. "JAC-03".' },
    part: { type: 'string', description: 'Model / part name.' },
    shift: { type: 'string', enum: ['A', 'B'] },
  },
};
const RANGE_PROPS = {
  fromDate: { ...DATE, description: 'First production date (YYYY-MM-DD), inclusive.' },
  toDate: { ...DATE, description: 'Last production date (YYYY-MM-DD), inclusive. At most 92 days after fromDate.' },
  filters: FILTERS,
};

export const TOOL_DECLARATIONS = [
  {
    name: 'getAvailableProductionFilters',
    description: 'Current production date and calendar date, and the registered plants, workshops, divisions, lines (with their models/parts) and shifts. Call this to resolve line or part names, or relative dates, before other tools when unsure.',
    parametersJsonSchema: { type: 'object', properties: {} },
  },
  {
    name: 'getProductionSummary',
    description: 'Production totals (produced, target, variance, efficiency, rejected, rejection %, downtime) for a production-date range, optionally grouped (by line, model/part, shift, production date, or a pair). Use for total production, model/part production, line production, shift comparison, and daily trends.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        ...RANGE_PROPS,
        groupBy: { type: 'string', enum: [...GROUP_BY], description: 'Grouping. "day" = production date.' },
        sortBy: { type: 'string', enum: [...SORT_BY] },
        limit: { type: 'integer', description: 'Max groups to return (top N after sorting).' },
      },
      required: ['fromDate', 'toDate'],
    },
  },
  {
    name: 'getProductionTargetVariance',
    description: 'Target vs actual: produced, target, variance and efficiency per group, sorted by largest shortfall first by default. Use for "below target" and "highest shortfall" questions.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        ...RANGE_PROPS,
        groupBy: { type: 'string', enum: GROUP_BY.filter((g) => g !== 'none') },
        sortBy: { type: 'string', enum: [...SORT_BY] },
        limit: { type: 'integer' },
      },
      required: ['fromDate', 'toDate'],
    },
  },
  {
    name: 'getRejectionSummary',
    description: 'Rejection quantities and rejection rate from the slot Rejections counter (the authoritative quality figure), grouped by model/part (default), line, shift, date or a pair; sorted by rejection % by default.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        ...RANGE_PROPS,
        groupBy: { type: 'string', enum: [...GROUP_BY] },
        sortBy: { type: 'string', enum: [...SORT_BY] },
        limit: { type: 'integer' },
      },
      required: ['fromDate', 'toDate'],
    },
  },
  {
    name: 'getDefectLogSummary',
    description: 'Defect types / stages from the separate Record Rejection defect log (calendar dates). Use for defect type, stage or responsibility questions. Do not add its quantities to getRejectionSummary.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        fromDate: { ...DATE, description: 'First calendar date, inclusive.' },
        toDate: { ...DATE, description: 'Last calendar date, inclusive.' },
        filters: FILTERS,
        groupBy: { type: 'string', enum: [...DEFECT_GROUP_BY] },
      },
      required: ['fromDate', 'toDate'],
    },
  },
  {
    name: 'getDowntimeSummary',
    description: 'Recorded line-stop downtime minutes and stop counts, grouped by stop reason (default), line, shift, date, or line/date & reason. Includes lines still running.',
    parametersJsonSchema: {
      type: 'object',
      properties: { ...RANGE_PROPS, groupBy: { type: 'string', enum: [...DOWNTIME_GROUP_BY] } },
      required: ['fromDate', 'toDate'],
    },
  },
  {
    name: 'compareProductionPeriods',
    description: 'Compares two production-date periods (e.g. this week vs last week): produced, target, efficiency, rejections, downtime, with absolute and % change.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        currentFrom: DATE, currentTo: DATE, previousFrom: DATE, previousTo: DATE, filters: FILTERS,
      },
      required: ['currentFrom', 'currentTo', 'previousFrom', 'previousTo'],
    },
  },
  {
    name: 'getProductionRecordDetails',
    description: 'Individual hourly slot records (date, shift, line, part, slot, produced, target, rejected, downtime, loss reason). Use only when the user asks for slot-level detail.',
    parametersJsonSchema: {
      type: 'object',
      properties: { ...RANGE_PROPS, limit: { type: 'integer', description: `1–${DETAIL_ROW_MAX}, default 50.` } },
      required: ['fromDate', 'toDate'],
    },
  },
];

const TOOLS: Record<string, ToolImpl> = {
  getAvailableProductionFilters,
  getProductionSummary,
  getProductionTargetVariance: getTargetVariance,
  getRejectionSummary,
  getDefectLogSummary,
  getDowntimeSummary,
  compareProductionPeriods,
  getProductionRecordDetails,
};

export const TOOL_NAMES = Object.keys(TOOLS);

// Runs one tool call. Only names in the registry run — anything else
// (another collection, a write, arbitrary code) is refused.
export async function executeTool(name: string, rawArgs: unknown, ctx: ToolContext): Promise<ToolOutput> {
  if (!Object.prototype.hasOwnProperty.call(TOOLS, name)) throw new ToolArgError(`Unknown tool "${name}".`);
  const args = obj(rawArgs, 'arguments');
  return TOOLS[name](args, ctx);
}
