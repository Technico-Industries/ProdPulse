// src/utils/modelPartProduction.ts
//
// Pure logic behind the admin-only Model / Part Production page
// (src/screens/ModelPartProductionScreen.tsx). Kept free of React/Firebase
// so it can be checked by scripts/testModelPartProduction.ts
// (npm run test:model-part).
//
// SOURCE — productionRecords, loaded for a production-date range by
// services/productionRecordQueries fetchProductionRecordsForDateRange (the
// same query Generate Report uses: by productionDate, plus the legacy
// createdAt window, so an overnight Shift B — after-midnight slots and a
// late Finalize included — stays on the night it started).
//
// MODEL / PART — a production line's `parts` list (also stored as `models`
// on some lines) is the line's model list; each record carries the name of
// the part it ran as `partName`. There is no separate model name or part
// number field, so "Model / Part" is that one name. Names are matched
// case/whitespace-insensitively, like Generate Report's part filter.
//
// METRICS (the established rules — qualityMetrics.ts, KPI Analysis):
//   produced = Σ producedThisSlot — the GOOD output a supervisor records per
//              slot; nothing subtracts rejections from it
//   rejected = Σ rejections        — the slot's Rejections counter, counted
//              separately (records without the counter are legacy and add 0,
//              exactly as Generate Report sums them; they are counted in
//              legacyRejectionRecords so the UI can say so)
//   output   = produced + rejected  (qualityMetrics "inspectedParts")
// There is no "net good = produced − rejected": that would subtract the
// rejects twice.
//
// ONE RECORD PER SLOT — lineEfficiency.dedupeSlotRecords, per line +
// production date + shift (the identity RecordProductionScreen keys its
// deterministic record IDs on). Per slot + segment it keeps the doc Save Slot
// itself would update (canonical ID, else the earliest-created legacy one);
// a changeover's 'before' + 'after' pair is two legitimate records; when a
// slot holds both shapes it keeps the one written last. Everything it drops
// is returned as `duplicates` so the page and the export can show it —
// nothing is discarded silently, and nothing is written back.

import { dedupeSlotRecords } from './lineEfficiency';
import { addDaysToKey, isProductionDayKey, recordProductionDayKey, timestampToMillis } from './productionDay';
import { computeQuality, QualityMetrics } from './qualityMetrics';
import { isActiveAdmin } from './endProduction';

// ─── Access ──────────────────────────────────────────────────────────────────

export function canViewModelPartProduction(user: { role?: string | null } | null | undefined): boolean {
  return !!user && user.role === 'admin';
}

export class ModelPartAccessError extends Error {
  constructor() {
    super('Only active admin accounts can view Model / Part Production.');
    this.name = 'ModelPartAccessError';
  }
}

// Loads a date range for an admin. The signed-in role is checked, then the
// user's profile is re-read (a role removed, or an account deactivated, since
// sign-in is refused) — both BEFORE any production record is fetched.
export async function loadRecordsForAdmin<T>(
  user: { uid: string; role?: string | null } | null | undefined,
  fromKey: string,
  toKey: string,
  deps: {
    getProfile: (uid: string) => Promise<{ role?: unknown; active?: unknown } | null>;
    fetchRecords: (fromKey: string, toKey: string) => Promise<T[]>;
  }
): Promise<T[]> {
  if (!user || !canViewModelPartProduction(user)) throw new ModelPartAccessError();
  const profile = await deps.getProfile(user.uid);
  if (!isActiveAdmin(profile)) throw new ModelPartAccessError();
  return deps.fetchRecords(fromKey, toKey);
}

export function loadErrorMessage(e: unknown): string {
  if (e instanceof ModelPartAccessError) return e.message;
  const code = (e as { code?: string } | null)?.code;
  if (code === 'permission-denied') return 'You do not have permission to read production records.';
  if (code === 'unavailable') return 'Could not reach the server. Check your connection and try again.';
  return 'Could not load production data. Check your connection and try again.';
}

// Only the newest load may show its result: a slower, older request
// resolving after a newer one is ignored.
export function createLatestRequestGuard() {
  let current = 0;
  return {
    next: () => ++current,
    isCurrent: (token: number) => token === current,
    cancel: () => { current++; },
  };
}

// ─── Dates ───────────────────────────────────────────────────────────────────

// A range is fetched whole and filtered in memory; this caps one load.
export const MAX_RANGE_DAYS = 92;

export function rangeDayCount(fromKey: string, toKey: string): number {
  let n = 1;
  for (let k = fromKey; k < toKey && n <= MAX_RANGE_DAYS + 1; k = addDaysToKey(k, 1)) n++;
  return n;
}

export function validateDateRange(fromKey: string, toKey: string): string | null {
  if (!isProductionDayKey(fromKey) || !isProductionDayKey(toKey)) return 'Enter dates as YYYY-MM-DD.';
  if (addDaysToKey(fromKey, 0) !== fromKey || addDaysToKey(toKey, 0) !== toKey) return 'Enter a real calendar date.';
  if (fromKey > toKey) return '"From" date must be on or before "To" date.';
  if (rangeDayCount(fromKey, toKey) > MAX_RANGE_DAYS) return `Choose a range of ${MAX_RANGE_DAYS} days or fewer.`;
  return null;
}

// ─── Records ─────────────────────────────────────────────────────────────────

export interface MPRecord {
  id: string;
  shift: string;
  plant: string | null;
  workshop: string | null;
  division: string | null;
  lineId: string | null;
  lineName: string | null;
  partName: string | null;
  slotIndex: number | null;
  slotLabel: string | null;
  partSegment: 'before' | 'after' | null;
  productionDate: string | null;
  expectedParts: number | null;
  producedThisSlot: number | null;
  rejections: number | null;
  supervisorName: string | null;
  supervisorUid: string | null;
  createdAtMs: number | null;
  updatedAtMs: number | null;
}

const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

// A productionRecords doc → MPRecord (same field defaults as Generate Report).
export function mapProductionRecord(id: string, data: any): MPRecord {
  const seg = data?.partSegment;
  return {
    id,
    shift: data?.shift ?? 'A',
    plant: data?.plant ?? null,
    workshop: data?.workshop ?? null,
    division: data?.division ?? null,
    lineId: data?.lineId ?? null,
    lineName: data?.lineName ?? null,
    partName: str(data?.partName),
    slotIndex: finite(data?.slotIndex),
    slotLabel: data?.slotLabel ?? null,
    partSegment: seg === 'before' || seg === 'after' ? seg : null,
    productionDate: isProductionDayKey(data?.productionDate) ? data.productionDate : null,
    expectedParts: finite(data?.expectedParts),
    producedThisSlot: finite(data?.producedThisSlot),
    rejections: finite(data?.rejections),
    supervisorName: str(data?.supervisor?.name),
    supervisorUid: str(data?.supervisor?.uid),
    createdAtMs: timestampToMillis(data?.createdAt),
    updatedAtMs: timestampToMillis(data?.updatedAt),
  };
}

export interface MPLine {
  id: string;
  plant?: string | null;
  workshop?: string | null;
  division?: string | null;
  lineName?: string | null;
  parts?: { name: string }[];
}

// Same fix Generate Report applies: plant / workshop / division / line name
// come from the productionLines doc, falling back to the record's own copy.
export function resolveLineFields(records: MPRecord[], lines: MPLine[]): MPRecord[] {
  const byId = new Map(lines.map((l) => [l.id, l]));
  return records.map((r) => {
    const l = r.lineId ? byId.get(r.lineId) : undefined;
    if (!l) return r;
    return {
      ...r,
      plant: l.plant ?? r.plant,
      workshop: l.workshop ?? r.workshop,
      division: l.division ?? r.division,
      lineName: l.lineName ?? r.lineName,
    };
  });
}

export function dayKeyOf(r: MPRecord): string | null {
  return recordProductionDayKey(r);
}

// ─── One record per slot ─────────────────────────────────────────────────────

export function dedupeProductionRecords(records: MPRecord[]): { kept: MPRecord[]; duplicates: MPRecord[] } {
  const loose: MPRecord[] = [];
  const sessions = new Map<string, MPRecord[]>();
  records.forEach((r) => {
    const day = dayKeyOf(r);
    if (!r.lineId || !day) {
      loose.push(r);
      return;
    }
    const key = `${r.lineId}|${day}|${r.shift}`;
    sessions.set(key, [...(sessions.get(key) ?? []), r]);
  });
  const kept = [...loose];
  sessions.forEach((group) => kept.push(...dedupeSlotRecords(group)));
  const keptSet = new Set(kept);
  return {
    kept: records.filter((r) => keptSet.has(r)),
    duplicates: records.filter((r) => !keptSet.has(r)),
  };
}

// ─── Filters ─────────────────────────────────────────────────────────────────

export function normName(v: string | null | undefined): string {
  return (v ?? '').trim().toLowerCase();
}

export const UNKNOWN_PART_KEY = '__unknown__';

export function partKeyOf(r: Pick<MPRecord, 'partName'>): string {
  return r.partName ? normName(r.partName) : UNKNOWN_PART_KEY;
}

export function supervisorKeyOf(r: Pick<MPRecord, 'supervisorUid' | 'supervisorName'>): string | null {
  if (r.supervisorUid) return `uid:${r.supervisorUid}`;
  if (r.supervisorName) return `name:${normName(r.supervisorName)}`;
  return null;
}

export type ShiftFilter = 'All' | 'A' | 'B';

export interface MPFilters {
  plant: string | null;
  workshop: string | null;
  division: string | null;
  lineId: string | null;
  partKey: string | null;
  shift: ShiftFilter;
  supervisorKey: string | null;
}

export const EMPTY_FILTERS: MPFilters = {
  plant: null, workshop: null, division: null, lineId: null, partKey: null, shift: 'All', supervisorKey: null,
};

export function hasActiveFilters(f: MPFilters): boolean {
  return !!(f.plant || f.workshop || f.division || f.lineId || f.partKey || f.shift !== 'All' || f.supervisorKey);
}

function sameValue(a: string | null | undefined, b: string | null | undefined) {
  if (a == null || b == null) return false;
  return normName(a) === normName(b);
}

export function applyFilters(records: MPRecord[], f: MPFilters): MPRecord[] {
  return records.filter((r) => {
    if (f.plant && !sameValue(r.plant, f.plant)) return false;
    if (f.workshop && !sameValue(r.workshop, f.workshop)) return false;
    if (f.division && !sameValue(r.division, f.division)) return false;
    if (f.lineId && r.lineId !== f.lineId) return false;
    if (f.partKey && partKeyOf(r) !== f.partKey) return false;
    if (f.shift !== 'All' && r.shift !== f.shift) return false;
    if (f.supervisorKey && supervisorKeyOf(r) !== f.supervisorKey) return false;
    return true;
  });
}

export interface Option { key: string; label: string }

// Parts offered by the filter: the registered parts of the lines in scope,
// plus any part name present in the loaded records (a part since removed
// from a line still has history).
export function partOptions(lines: MPLine[], records: MPRecord[]): Option[] {
  const out = new Map<string, string>();
  lines.forEach((l) => (l.parts ?? []).forEach((p) => { if (p.name?.trim() && !out.has(normName(p.name))) out.set(normName(p.name), p.name.trim()); }));
  records.forEach((r) => { if (r.partName && !out.has(partKeyOf(r))) out.set(partKeyOf(r), r.partName.trim()); });
  return Array.from(out, ([key, label]) => ({ key, label })).sort((a, b) => a.label.localeCompare(b.label));
}

export function supervisorOptions(records: MPRecord[]): Option[] {
  const out = new Map<string, string>();
  records.forEach((r) => {
    const key = supervisorKeyOf(r);
    if (key && !out.has(key)) out.set(key, r.supervisorName?.trim() || 'Unnamed supervisor');
  });
  return Array.from(out, ([key, label]) => ({ key, label })).sort((a, b) => a.label.localeCompare(b.label));
}

// ─── Aggregates ──────────────────────────────────────────────────────────────

export interface MPSummary {
  produced: number;
  rejected: number;
  output: number;
  quality: QualityMetrics;
  partCount: number;
  lineCount: number;
  records: number;
  // Records without a rejection counter (they add 0 to `rejected`).
  legacyRejectionRecords: number;
}

const add = (v: number | null) => Math.max(0, v ?? 0);

export function summarize(records: MPRecord[]): MPSummary {
  let produced = 0;
  let rejected = 0;
  let legacy = 0;
  const parts = new Set<string>();
  const lines = new Set<string>();
  records.forEach((r) => {
    produced += add(r.producedThisSlot);
    rejected += add(r.rejections);
    if (r.rejections == null) legacy++;
    parts.add(partKeyOf(r));
    if (r.lineId) lines.add(r.lineId);
  });
  return {
    produced,
    rejected,
    output: produced + rejected,
    quality: computeQuality(produced, rejected),
    partCount: parts.size,
    lineCount: lines.size,
    records: records.length,
    legacyRejectionRecords: legacy,
  };
}

export interface PartRow {
  key: string;
  partName: string;
  produced: number;
  rejected: number;
  records: number;
  lineCount: number;
  lineNames: string[];
  latestMs: number | null;
}

const latestOf = (r: MPRecord) => r.updatedAtMs ?? r.createdAtMs;

export function breakdownByPart(records: MPRecord[]): PartRow[] {
  const map = new Map<string, PartRow & { lineIds: Set<string>; lineNameSet: Set<string> }>();
  records.forEach((r) => {
    const key = partKeyOf(r);
    let row = map.get(key);
    if (!row) {
      row = {
        key, partName: r.partName?.trim() || 'Unknown part', produced: 0, rejected: 0, records: 0,
        lineCount: 0, lineNames: [], latestMs: null, lineIds: new Set(), lineNameSet: new Set(),
      };
      map.set(key, row);
    }
    row.produced += add(r.producedThisSlot);
    row.rejected += add(r.rejections);
    row.records++;
    if (r.lineId) row.lineIds.add(r.lineId);
    if (r.lineName) row.lineNameSet.add(r.lineName);
    const t = latestOf(r);
    if (t != null && (row.latestMs == null || t > row.latestMs)) row.latestMs = t;
  });
  return Array.from(map.values()).map(({ lineIds, lineNameSet, ...row }) => ({
    ...row,
    lineCount: lineIds.size,
    lineNames: Array.from(lineNameSet).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
  }));
}

export type PartSort = 'qty-desc' | 'qty-asc' | 'name-asc' | 'name-desc';

export function sortPartRows(rows: PartRow[], sort: PartSort): PartRow[] {
  const byName = (a: PartRow, b: PartRow) => a.partName.localeCompare(b.partName, undefined, { numeric: true, sensitivity: 'base' });
  return [...rows].sort((a, b) => {
    switch (sort) {
      case 'qty-desc': return b.produced - a.produced || byName(a, b);
      case 'qty-asc': return a.produced - b.produced || byName(a, b);
      case 'name-asc': return byName(a, b);
      case 'name-desc': return byName(b, a);
    }
  });
}

export type DetailDimension = 'day' | 'shift' | 'line' | 'supervisor';

export interface DetailRow { key: string; label: string; produced: number; rejected: number; records: number }

// One part's figures split by production day / shift / line / supervisor.
export function partDetail(records: MPRecord[], partKey: string, by: DetailDimension): DetailRow[] {
  const map = new Map<string, DetailRow>();
  records.forEach((r) => {
    if (partKeyOf(r) !== partKey) return;
    let key: string;
    let label: string;
    switch (by) {
      case 'day': key = dayKeyOf(r) ?? 'unknown'; label = key === 'unknown' ? 'Unknown date' : key; break;
      case 'shift': key = r.shift; label = `Shift ${r.shift}`; break;
      case 'line': key = r.lineId ?? 'unknown'; label = r.lineName ?? 'Unknown line'; break;
      case 'supervisor': key = supervisorKeyOf(r) ?? 'unknown'; label = r.supervisorName?.trim() || 'Unknown supervisor'; break;
    }
    const row = map.get(key) ?? { key, label, produced: 0, rejected: 0, records: 0 };
    row.produced += add(r.producedThisSlot);
    row.rejected += add(r.rejections);
    row.records++;
    map.set(key, row);
  });
  return Array.from(map.values()).sort((a, b) =>
    by === 'day' || by === 'shift' ? a.key.localeCompare(b.key) : b.produced - a.produced || a.label.localeCompare(b.label)
  );
}

// ─── Whole report ────────────────────────────────────────────────────────────

export interface MPReport {
  // Kept records matching the filters (the detail of every figure below).
  records: MPRecord[];
  // Duplicate docs left out, matching the filters.
  duplicates: MPRecord[];
  duplicateProduced: number;
  summary: MPSummary;
  parts: PartRow[];
}

// De-duplicates the WHOLE loaded range first, then filters — a legacy
// duplicate whose part or supervisor differs from the doc that is kept must
// not reappear just because a filter excludes the kept one.
export function buildReport(loaded: MPRecord[], filters: MPFilters, sort: PartSort = 'qty-desc'): MPReport {
  const { kept, duplicates } = dedupeProductionRecords(loaded);
  const records = applyFilters(kept, filters);
  const dups = applyFilters(duplicates, filters);
  return {
    records,
    duplicates: dups,
    duplicateProduced: dups.reduce((s, r) => s + add(r.producedThisSlot), 0),
    summary: summarize(records),
    parts: sortPartRows(breakdownByPart(records), sort),
  };
}

// ─── Export tables ───────────────────────────────────────────────────────────
// Plain rows for the Excel workbook, built from the SAME report the screen
// shows, so the file and the page always agree.

export interface ExportFilterLabels {
  fromDate: string;
  toDate: string;
  plant: string | null;
  workshop: string | null;
  division: string | null;
  lineName: string | null;
  partName: string | null;
  shift: ShiftFilter;
  supervisorName: string | null;
}

export type Cell = string | number;

export interface ExportTables {
  summary: Cell[][];
  parts: Cell[][];
  detail: Cell[][];
  duplicates: Cell[][];
}

function segmentLabel(r: MPRecord) {
  return r.partSegment === 'before' ? 'Before changeover' : r.partSegment === 'after' ? 'After changeover' : 'Full slot';
}

function isoOrBlank(ms: number | null) {
  return ms == null ? '' : new Date(ms).toISOString();
}

const DETAIL_HEADER: Cell[] = [
  'Production Date', 'Shift', 'Plant', 'Workshop', 'Division', 'Line', 'Model / Part', 'Slot', 'Segment',
  'Produced (good)', 'Rejected', 'Supervisor', 'Record ID', 'Last Saved (UTC)',
];

function detailRow(r: MPRecord): Cell[] {
  return [
    dayKeyOf(r) ?? 'unknown', r.shift, r.plant ?? '', r.workshop ?? '', r.division ?? '', r.lineName ?? '',
    r.partName ?? 'Unknown part', r.slotLabel ?? (r.slotIndex != null ? `Slot ${r.slotIndex}` : ''), segmentLabel(r),
    add(r.producedThisSlot), r.rejections == null ? '' : add(r.rejections), r.supervisorName ?? '', r.id, isoOrBlank(latestOf(r)),
  ];
}

export function buildExportTables(report: MPReport, f: ExportFilterLabels): ExportTables {
  const s = report.summary;
  return {
    summary: [
      ['Model / Part Production'],
      ['Production date range', `${f.fromDate} to ${f.toDate}`],
      ['Plant', f.plant ?? 'All'],
      ['Workshop', f.workshop ?? 'All'],
      ['Division', f.division ?? 'All'],
      ['Line', f.lineName ?? 'All'],
      ['Model / Part', f.partName ?? 'All'],
      ['Shift', f.shift === 'All' ? 'All' : `Shift ${f.shift}`],
      ['Supervisor', f.supervisorName ?? 'All'],
      [],
      ['Produced (good parts)', s.produced],
      ['Rejected', s.rejected],
      ['Total output (good + rejected)', s.output],
      ['Rejection %', s.quality.rejectionPct ?? ''],
      ['Models / Parts', s.partCount],
      ['Lines', s.lineCount],
      ['Slot records', s.records],
      ['Records without a rejection counter', s.legacyRejectionRecords],
      ['Duplicate records excluded', report.duplicates.length],
      ['Produced on excluded duplicates', report.duplicateProduced],
    ],
    parts: [
      ['Model / Part', 'Produced (good)', 'Rejected', 'Total Output', 'Lines', 'Line Names', 'Slot Records', 'Latest Saved (UTC)'],
      ...report.parts.map((p) => [
        p.partName, p.produced, p.rejected, p.produced + p.rejected, p.lineCount, p.lineNames.join(', '), p.records, isoOrBlank(p.latestMs),
      ]),
    ],
    detail: [DETAIL_HEADER, ...report.records.map(detailRow)],
    duplicates: [DETAIL_HEADER, ...report.duplicates.map(detailRow)],
  };
}
