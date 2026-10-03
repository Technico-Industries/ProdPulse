// src/utils/reportExcelExport.ts
//
// Builds and saves the Excel export (SUMMARY / DETAILED RECORDS / LINE
// SUMMARY / HOURLY REPORT / HOURLY - <line> per line) for
// GenerateReportScreen. This file only formats data the screen already has
// (records/summary/byLine, plus a per-record hourly source list derived from
// the same already-loaded `records`) into a workbook — it never queries
// Firestore and never touches any API key. Web triggers a normal
// browser download; Android/iOS write the file into the app's sandboxed
// document directory and open the native share sheet, since Expo's managed
// workflow has no direct "Downloads" folder write access — sharing is the
// standard cross-platform way to let the user save or send it.
//
// Styling note: the plain `xlsx` (SheetJS Community Edition) package cannot
// write cell styles (fonts, fills, borders, alignment) — the community build
// deliberately strips them on write. `xlsx-js-style` is a drop-in fork with
// the exact same API (same import shape, same XLSX.utils.*, same
// read/write/writeFile calls) that additionally honors a cell's `.s` style
// object, which is what makes the "professional report" formatting below
// possible. Nothing about the read/write/share flow changed — only the
// import source and the cell/style construction inside the sheet builders.

import { Platform } from 'react-native';
import * as XLSX from 'xlsx-js-style';
// Expo SDK 57's expo-file-system default export switched to a new
// File/Directory/Paths API. The documentDirectory + writeAsStringAsync
// functions used below still live at the /legacy subpath.
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';

// ── Shapes this file needs — intentionally structural (not imported from
// GenerateReportScreen.tsx), so this stays a standalone, reusable helper.
// The screen's ProductionRecord/LineDayBreakdown rows already satisfy these
// once mapped to plain values (see the mapping done in the screen).

export interface ExcelFilters {
  fromDate: string;
  toDate: string;
  plant: string | null;
  workshop: string | null;
  division: string | null;
  lineName: string | null;
  partFilter: string | null;
  shiftFilter: string;
}

export interface ExcelSummary {
  totalProduction: number;
  plannedTotal: number;
  efficiency: number;
  lossParts: number;
  lossTimeMinutes: number;
  rejections: number;
  downtimeMinutes: number;
  count: number;
}

export interface ExcelDetailRow {
  productionDate: string | null;
  shift: string | null;
  plant: string | null;
  workshop: string | null;
  division: string | null;
  lineName: string | null;
  partName: string | null;
  slot: string | null;
  produced: number | null;
  planned: number | null;
  lossParts: number | null;
  lossTimeMinutes: number | null;
  lossReason: string | null;
  rejections: number | null;
  downtimeMinutes: number;
  supervisorName: string | null;
  operatorCount: number;
  operatorNames: string;
}

export interface ExcelLineSummaryRow {
  lineName: string;
  dateLabel: string;
  shift: string | null;
  records: number;
  totalProduction: number;
  totalExpected: number;
  lossParts: number;
  lossTimeMinutes: number;
  rejections: number;
  downtimeMinutes: number;
  operatorCount: number;
  operatorNames: string[];
}

// One row per already-loaded productionRecords doc — the raw material the
// HOURLY REPORT / HOURLY - <line> sheets group into hour buckets. Deliberately
// close to ExcelDetailRow's shape (same source, same screen-side mapping
// pattern) but keeps a few fields un-flattened (operatorNames as a list
// rather than a joined string, lossReason left as the resolved
// lossReasonLabel/deriveReasonFromStops chain rather than safe()'d text) so
// this file can de-duplicate/combine them correctly *per hour group* instead
// of per record. `lossParts` is expected to already carry the same
// `r.lossParts ?? Math.max(0, expectedParts - producedThisSlot)` fallback the
// screen's SUMMARY/BY LINE aggregates use — that's what lets hourly totals
// reconcile with the SUMMARY sheet (the flat DETAILED RECORDS sheet, by
// contrast, intentionally shows the raw un-fallback-applied value and is
// left untouched).
export interface ExcelHourlySourceRow {
  productionDate: string | null;
  shift: string | null;
  lineName: string | null;
  partName: string | null;
  // Minutes-since-midnight-of-shift-start, same "abs minutes" convention
  // RecordProductionScreen stamps onto every slot (SHIFT_A_START = 7*60,
  // SHIFT_B_START = 19*60, can run past 1440 for an overnight Shift B).
  // null when a record genuinely has no slot timing.
  slotStartMinutesAbs: number | null;
  slotEndMinutesAbs: number | null;
  planned: number;
  produced: number;
  lossParts: number;
  lossTimeMinutes: number;
  lossReason: string | null;
  rejections: number;
  downtimeMinutes: number;
  supervisorName: string | null;
  operatorNames: string[];
}

// Null/empty-safe display value — every cell goes through this or `num()`
// so a missing field never renders as "undefined"/"null" text in the sheet.
const safe = (v: string | null | undefined) => (v === null || v === undefined || v === '' ? '—' : v);
const num = (v: number | null | undefined) => (typeof v === 'number' && !isNaN(v) ? v : 0);

// Parses the screen's `YYYY-MM-DD` filter strings into `DD-MMM-YYYY` for
// display (e.g. "2026-07-23" -> "23-Jul-2026"). Built from string slicing
// rather than `Date` to avoid any local-timezone day-shift surprises.
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function formatDateLabel(iso: string | null | undefined): string {
  if (!iso) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const monthIdx = parseInt(m[2], 10) - 1;
  if (monthIdx < 0 || monthIdx > 11) return iso;
  return `${m[3]}-${MONTH_ABBR[monthIdx]}-${m[1]}`;
}

// Mirrors RecordProductionScreen's own `formatAbsMinutesToAmPm` — same
// "abs minutes" convention, reimplemented locally rather than imported
// since this file is intentionally standalone (see the shapes note above).
function formatAbsMinutesToAmPm(mAbs: number): string {
  const m = ((mAbs % 1440) + 1440) % 1440;
  const hh = Math.floor(m / 60);
  const mm = m % 60;
  const suffix = hh >= 12 ? 'PM' : 'AM';
  const hour12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${String(hour12).padStart(2, '0')}:${String(mm).padStart(2, '0')} ${suffix}`;
}

// RecordProductionScreen builds slots as (up to) 60 wall-clock-minute
// windows starting exactly on the shift's start minute (7:00 for Shift A,
// 19:00 for Shift B), so flooring a slot's own start to the hour recovers
// the same hourly window the app already works in — including for the
// partial first/changeover-split slots, whose start still falls inside the
// hour it belongs to.
function hourBucketStart(slotStartMinutesAbs: number | null): number | null {
  if (typeof slotStartMinutesAbs !== 'number' || isNaN(slotStartMinutesAbs)) return null;
  return Math.floor(slotStartMinutesAbs / 60) * 60;
}

function hourRangeLabel(hourStartAbs: number | null): string {
  if (hourStartAbs == null) return '—';
  return `${formatAbsMinutesToAmPm(hourStartAbs)} - ${formatAbsMinutesToAmPm(hourStartAbs + 60)}`;
}

// ── Professional report styling ──────────────────────────────────────────
// A small, consistent palette + a handful of reusable style presets, used
// across all three sheets so the workbook reads as one designed report
// rather than three separately-formatted tables. `.s` is typed `any` by
// xlsx-js-style, so these are plain object literals mirroring the OpenXML
// style shape (font / fill / alignment / border).

const COLOR = {
  navy: '1F3B57',
  steel: '2F5C8A',
  headerFill: '2F5C8A',
  headerText: 'FFFFFF',
  sectionFill: '1F3B57',
  sectionText: 'FFFFFF',
  labelFill: 'DCE6F1',
  zebraFill: 'F4F7FB',
  border: 'B7C4D4',
  bodyText: '222222',
  subtleText: '5B6B7C',
};

const thinBorder = {
  top: { style: 'thin', color: { rgb: COLOR.border } },
  bottom: { style: 'thin', color: { rgb: COLOR.border } },
  left: { style: 'thin', color: { rgb: COLOR.border } },
  right: { style: 'thin', color: { rgb: COLOR.border } },
};

const STYLE = {
  title: {
    font: { bold: true, sz: 18, color: { rgb: COLOR.navy } },
    alignment: { horizontal: 'center', vertical: 'center' },
  },
  subtitle: {
    font: { italic: true, sz: 11, color: { rgb: COLOR.subtleText } },
    alignment: { horizontal: 'center', vertical: 'center' },
  },
  filterLabel: {
    font: { bold: true, sz: 11, color: { rgb: COLOR.navy } },
    fill: { patternType: 'solid', fgColor: { rgb: COLOR.labelFill } },
    alignment: { horizontal: 'left', vertical: 'center', indent: 1 },
    border: thinBorder,
  },
  filterValue: {
    font: { sz: 11, color: { rgb: COLOR.bodyText } },
    alignment: { horizontal: 'center', vertical: 'center' },
    border: thinBorder,
  },
  sectionHeading: {
    font: { bold: true, sz: 13, color: { rgb: COLOR.sectionText } },
    fill: { patternType: 'solid', fgColor: { rgb: COLOR.sectionFill } },
    alignment: { horizontal: 'center', vertical: 'center' },
  },
  tableHeader: {
    font: { bold: true, sz: 11, color: { rgb: COLOR.headerText } },
    fill: { patternType: 'solid', fgColor: { rgb: COLOR.headerFill } },
    alignment: { horizontal: 'center', vertical: 'center' },
    border: thinBorder,
  },
  metricLabel: {
    font: { bold: true, sz: 11, color: { rgb: COLOR.bodyText } },
    alignment: { horizontal: 'left', vertical: 'center', indent: 1 },
    border: thinBorder,
  },
  kpiValue: {
    font: { bold: true, sz: 12, color: { rgb: COLOR.navy } },
    alignment: { horizontal: 'center', vertical: 'center' },
    border: thinBorder,
  },
};

function dataCellStyle(zebra: boolean) {
  return {
    font: { sz: 10.5, color: { rgb: COLOR.bodyText } },
    alignment: { horizontal: 'center', vertical: 'center', wrapText: false },
    border: thinBorder,
    ...(zebra ? { fill: { patternType: 'solid', fgColor: { rgb: COLOR.zebraFill } } } : {}),
  };
}

// Writes one styled cell at (r, c). `fmt` is an Excel number-format code
// (e.g. '#,##0' or '0.0"%"') applied only to numeric values.
function setCell(ws: XLSX.WorkSheet, r: number, c: number, value: string | number, style?: any, fmt?: string) {
  const addr = XLSX.utils.encode_cell({ r, c });
  const cell: any = { v: value, t: typeof value === 'number' ? 'n' : 's' };
  if (fmt && typeof value === 'number') cell.z = fmt;
  if (style) cell.s = style;
  ws[addr] = cell;
}

// Applies a style to every already-populated cell in a header row (used
// after aoa_to_sheet, which creates cells but no styling).
function styleHeaderRow(ws: XLSX.WorkSheet, rowIdx: number, colCount: number, style: any) {
  for (let c = 0; c < colCount; c++) {
    const addr = XLSX.utils.encode_cell({ r: rowIdx, c });
    if (ws[addr]) ws[addr].s = style;
  }
}

// Applies zebra-striped body styling to a block of already-populated data
// rows produced by aoa_to_sheet.
function styleDataRows(ws: XLSX.WorkSheet, startRow: number, rowCount: number, colCount: number) {
  for (let i = 0; i < rowCount; i++) {
    const r = startRow + i;
    const style = dataCellStyle(i % 2 === 1);
    for (let c = 0; c < colCount; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      if (ws[addr]) ws[addr].s = style;
    }
  }
}

// Applies a number format to one column across a block of data rows,
// without disturbing whatever style was already set on those cells.
function setColumnNumFmt(ws: XLSX.WorkSheet, col: number, startRow: number, rowCount: number, fmt: string) {
  for (let i = 0; i < rowCount; i++) {
    const addr = XLSX.utils.encode_cell({ r: startRow + i, c: col });
    const cell = ws[addr];
    if (cell && cell.t === 'n') cell.z = fmt;
  }
}

// ── SUMMARY sheet ─────────────────────────────────────────────────────────
// Built cell-by-cell (rather than aoa_to_sheet) since the layout is bespoke:
// a merged title/subtitle banner, a 4-column filter grid, then a distinct
// PRODUCTION SUMMARY section — not a single uniform table.

function buildSummarySheet(filters: ExcelFilters, summary: ExcelSummary): XLSX.WorkSheet {
  const ws: XLSX.WorkSheet = {};
  const merges: XLSX.Range[] = [];
  let r = 0;

  // 1. Report header — large bold centered title, date range beneath it.
  setCell(ws, r, 0, 'PRODUCTION REPORT', STYLE.title);
  merges.push({ s: { r, c: 0 }, e: { r, c: 3 } });
  r++;

  setCell(ws, r, 0, `${formatDateLabel(filters.fromDate)} to ${formatDateLabel(filters.toDate)}`, STYLE.subtitle);
  merges.push({ s: { r, c: 0 }, e: { r, c: 3 } });
  r += 2; // spacing below header

  // 2. Filter information — clean 4-column Label | Value | Label | Value grid.
  const filterPairs: [string, string][] = [
    ['Plant', safe(filters.plant)],
    ['Workshop', safe(filters.workshop)],
    ['Division', safe(filters.division)],
    ['Line', safe(filters.lineName)],
    ['Part/Model', safe(filters.partFilter)],
    ['Shift', safe(filters.shiftFilter)],
  ];
  for (let i = 0; i < filterPairs.length; i += 2) {
    const [label1, value1] = filterPairs[i];
    const [label2, value2] = filterPairs[i + 1];
    setCell(ws, r, 0, label1, STYLE.filterLabel);
    setCell(ws, r, 1, value1, STYLE.filterValue);
    setCell(ws, r, 2, label2, STYLE.filterLabel);
    setCell(ws, r, 3, value2, STYLE.filterValue);
    r++;
  }
  r += 2; // spacing before summary section

  // 3. PRODUCTION SUMMARY — section heading merged across the table width,
  // then a bold Metric | Value header and the KPI rows.
  setCell(ws, r, 0, 'PRODUCTION SUMMARY', STYLE.sectionHeading);
  setCell(ws, r, 1, '', STYLE.sectionHeading);
  merges.push({ s: { r, c: 0 }, e: { r, c: 1 } });
  r++;

  setCell(ws, r, 0, 'Metric', STYLE.tableHeader);
  setCell(ws, r, 1, 'Value', STYLE.tableHeader);
  r++;

  const metrics: [string, number, string][] = [
    ['Total Produced', num(summary.totalProduction), '#,##0'],
    ['Planned', num(summary.plannedTotal), '#,##0'],
    ['Efficiency (%)', num(summary.efficiency), '0.0"%"'],
    ['Loss Parts', num(summary.lossParts), '#,##0'],
    ['Time Loss (min)', num(summary.lossTimeMinutes), '#,##0" min"'],
    ['Rejections', num(summary.rejections), '#,##0'],
    ['Downtime (min)', num(summary.downtimeMinutes), '#,##0" min"'],
    ['Slots Recorded', num(summary.count), '#,##0'],
  ];
  metrics.forEach(([label, value, fmt]) => {
    setCell(ws, r, 0, label, STYLE.metricLabel);
    setCell(ws, r, 1, value, STYLE.kpiValue, fmt);
    r++;
  });

  const lastRow = r - 1;
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: lastRow, c: 3 } });
  ws['!merges'] = merges;
  ws['!cols'] = [{ wch: 20 }, { wch: 26 }, { wch: 18 }, { wch: 24 }];
  ws['!rows'] = [{ hpx: 28 }, { hpx: 20 }];

  return ws;
}

// ── DETAILED RECORDS sheet ──────────────────────────────────────────────

const DETAIL_HEADERS = [
  'Production Date', 'Shift', 'Plant', 'Workshop', 'Division', 'Line',
  'Part/Model', 'Slot', 'Produced', 'Planned', 'Loss Parts', 'Loss Time',
  'Loss Reason', 'Rejections', 'Downtime', 'Supervisor', 'Operator Count', 'Operator Names',
];

function buildDetailedRecordsSheet(rows: ExcelDetailRow[]): XLSX.WorkSheet {
  const aoa: (string | number)[][] = [
    DETAIL_HEADERS,
    ...rows.map((r) => [
      safe(r.productionDate), safe(r.shift), safe(r.plant), safe(r.workshop), safe(r.division), safe(r.lineName),
      safe(r.partName), safe(r.slot), num(r.produced), num(r.planned), num(r.lossParts), num(r.lossTimeMinutes),
      safe(r.lossReason), num(r.rejections), num(r.downtimeMinutes), safe(r.supervisorName),
      num(r.operatorCount), safe(r.operatorNames),
    ]),
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [
    { wch: 14 }, { wch: 7 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 12 },
    { wch: 16 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 },
    { wch: 16 }, { wch: 11 }, { wch: 11 }, { wch: 16 }, { wch: 14 }, { wch: 28 },
  ];
  ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: 0, c: DETAIL_HEADERS.length - 1 } }) };
  // Freeze the header row. Supported by recent SheetJS-derived writers via
  // `!views`; if a given viewer ignores it, the sheet still renders
  // correctly — it just isn't frozen.
  ws['!views'] = [{ state: 'frozen', ySplit: 1, xSplit: 0, topLeftCell: 'A2', activePane: 'bottomLeft' }];
  ws['!rows'] = [{ hpx: 22 }];

  styleHeaderRow(ws, 0, DETAIL_HEADERS.length, STYLE.tableHeader);
  styleDataRows(ws, 1, rows.length, DETAIL_HEADERS.length);
  // Numeric columns get thousands separators / unit suffixes to match the
  // SUMMARY sheet's formatting instead of showing raw integers.
  setColumnNumFmt(ws, 8, 1, rows.length, '#,##0'); // Produced
  setColumnNumFmt(ws, 9, 1, rows.length, '#,##0'); // Planned
  setColumnNumFmt(ws, 10, 1, rows.length, '#,##0'); // Loss Parts
  setColumnNumFmt(ws, 11, 1, rows.length, '#,##0" min"'); // Loss Time
  setColumnNumFmt(ws, 13, 1, rows.length, '#,##0'); // Rejections
  setColumnNumFmt(ws, 14, 1, rows.length, '#,##0" min"'); // Downtime
  setColumnNumFmt(ws, 16, 1, rows.length, '#,##0'); // Operator Count

  return ws;
}

// ── LINE SUMMARY sheet ───────────────────────────────────────────────────

const LINE_SUMMARY_HEADERS = [
  'Line', 'Date', 'Shift', 'Records', 'Produced', 'Planned', 'Efficiency',
  'Loss Parts', 'Loss Time', 'Rejections', 'Downtime', 'Operator Count', 'Operator Names',
];

function buildLineSummarySheet(rows: ExcelLineSummaryRow[]): XLSX.WorkSheet {
  const aoa: (string | number)[][] = [
    LINE_SUMMARY_HEADERS,
    ...rows.map((b) => {
      // Same efficiency formula used everywhere else in the report
      // (summary.efficiency / efficiencyByLine) — just applied per
      // line+date+shift row here, since LINE SUMMARY reuses byLine as-is.
      const efficiency = b.totalExpected > 0 ? Math.round((b.totalProduction / b.totalExpected) * 1000) / 10 : 0;
      return [
        safe(b.lineName), safe(b.dateLabel), safe(b.shift), num(b.records), num(b.totalProduction),
        num(b.totalExpected), efficiency, num(b.lossParts), num(b.lossTimeMinutes), num(b.rejections),
        num(b.downtimeMinutes), num(b.operatorCount), safe(b.operatorNames.join(', ')),
      ];
    }),
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [
    { wch: 14 }, { wch: 12 }, { wch: 7 }, { wch: 9 }, { wch: 10 }, { wch: 10 },
    { wch: 11 }, { wch: 10 }, { wch: 10 }, { wch: 11 }, { wch: 11 }, { wch: 14 }, { wch: 30 },
  ];
  ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: 0, c: LINE_SUMMARY_HEADERS.length - 1 } }) };
  ws['!views'] = [{ state: 'frozen', ySplit: 1, xSplit: 0, topLeftCell: 'A2', activePane: 'bottomLeft' }];
  ws['!rows'] = [{ hpx: 22 }];

  styleHeaderRow(ws, 0, LINE_SUMMARY_HEADERS.length, STYLE.tableHeader);
  styleDataRows(ws, 1, rows.length, LINE_SUMMARY_HEADERS.length);
  setColumnNumFmt(ws, 4, 1, rows.length, '#,##0'); // Produced
  setColumnNumFmt(ws, 5, 1, rows.length, '#,##0'); // Planned
  setColumnNumFmt(ws, 6, 1, rows.length, '0.0"%"'); // Efficiency
  setColumnNumFmt(ws, 7, 1, rows.length, '#,##0'); // Loss Parts
  setColumnNumFmt(ws, 8, 1, rows.length, '#,##0" min"'); // Loss Time
  setColumnNumFmt(ws, 9, 1, rows.length, '#,##0'); // Rejections
  setColumnNumFmt(ws, 10, 1, rows.length, '#,##0" min"'); // Downtime
  setColumnNumFmt(ws, 11, 1, rows.length, '#,##0'); // Operator Count

  return ws;
}

// ── HOURLY REPORT / HOURLY - <line> sheets ──────────────────────────────
// Groups the same already-loaded records (via ExcelHourlySourceRow) into
// productionDate + shift + line + hour buckets. No new data source, no
// invented hours — a bucket only exists if at least one record's slot
// timing falls inside it; records with no usable slot timing land in a
// single "—" hour bucket per date/shift/line instead of being dropped, so
// nothing is silently lost.

type HourlyGroup = {
  productionDate: string | null;
  shift: string | null;
  lineName: string | null;
  hourStartAbs: number | null;
  partNames: Set<string>;
  planned: number;
  produced: number;
  lossParts: number;
  lossTimeMinutes: number;
  rejections: number;
  downtimeMinutes: number;
  supervisors: Set<string>;
  operators: Set<string>;
  reasons: Set<string>;
};

function aggregateHourly(rows: ExcelHourlySourceRow[]): HourlyGroup[] {
  const map = new Map<string, HourlyGroup>();
  rows.forEach((row) => {
    const hourStartAbs = hourBucketStart(row.slotStartMinutesAbs);
    const key = [row.productionDate ?? '\u0000', row.shift ?? '\u0000', row.lineName ?? '\u0000', hourStartAbs ?? 'x'].join('__');
    let g = map.get(key);
    if (!g) {
      g = {
        productionDate: row.productionDate,
        shift: row.shift,
        lineName: row.lineName,
        hourStartAbs,
        partNames: new Set(),
        planned: 0,
        produced: 0,
        lossParts: 0,
        lossTimeMinutes: 0,
        rejections: 0,
        downtimeMinutes: 0,
        supervisors: new Set(),
        operators: new Set(),
        reasons: new Set(),
      };
      map.set(key, g);
    }
    if (row.partName) g.partNames.add(row.partName);
    g.planned += row.planned;
    g.produced += row.produced;
    g.lossParts += row.lossParts;
    g.lossTimeMinutes += row.lossTimeMinutes;
    g.rejections += row.rejections;
    g.downtimeMinutes += row.downtimeMinutes;
    if (row.supervisorName) g.supervisors.add(row.supervisorName);
    row.operatorNames.forEach((n) => { if (n) g!.operators.add(n); });
    // lossReason may itself already be a comma-joined multi-reason string
    // (deriveReasonFromStops joins unique stop reasons) — split it back out
    // so combining across records in the same hour still de-duplicates
    // correctly instead of collecting "A, B" and "B, C" as two blobs.
    if (row.lossReason) {
      row.lossReason.split(',').map((s) => s.trim()).filter(Boolean).forEach((r) => g!.reasons.add(r));
    }
  });
  return Array.from(map.values());
}

// Date ascending, then Shift, then Hour ascending — buckets with no usable
// slot timing (hourStartAbs === null) sort last within their date+shift.
function sortHourlyGroups(groups: HourlyGroup[]): HourlyGroup[] {
  return [...groups].sort((a, b) => {
    const da = a.productionDate ?? '';
    const db = b.productionDate ?? '';
    if (da !== db) return da < db ? -1 : 1;
    const sa = a.shift ?? '';
    const sb = b.shift ?? '';
    if (sa !== sb) return sa < sb ? -1 : 1;
    const ha = a.hourStartAbs ?? Number.POSITIVE_INFINITY;
    const hb = b.hourStartAbs ?? Number.POSITIVE_INFINITY;
    if (ha !== hb) return ha - hb;
    return (a.lineName ?? '').localeCompare(b.lineName ?? '');
  });
}

function hourlyEfficiency(g: HourlyGroup): number {
  return g.planned > 0 ? Math.round((g.produced / g.planned) * 1000) / 10 : 0;
}

function hourlySupervisorText(g: HourlyGroup): string {
  return g.supervisors.size > 0 ? Array.from(g.supervisors).join(', ') : '—';
}

function hourlyOperatorsText(g: HourlyGroup): string {
  return g.operators.size > 0 ? Array.from(g.operators).join(', ') : '—';
}

function hourlyReasonText(g: HourlyGroup): string {
  if (g.reasons.size > 0) return Array.from(g.reasons).join(', ');
  return g.lossParts > 0 ? 'Unspecified' : '—';
}

function hourlyPartText(g: HourlyGroup): string {
  return g.partNames.size > 0 ? Array.from(g.partNames).join(', ') : '—';
}

// Excel sheet names: max 31 chars, no \ / ? * [ ] : — sanitize a line name
// into a safe, unique "HOURLY - <line>" sheet title.
function hourlySheetName(lineName: string, used: Set<string>): string {
  const cleaned = lineName.replace(/[\\/?*[\]:]/g, '-').trim() || 'Line';
  let base = `HOURLY - ${cleaned}`.slice(0, 31);
  let name = base;
  let n = 2;
  while (used.has(name.toUpperCase())) {
    const suffix = ` (${n})`;
    name = `${base.slice(0, 31 - suffix.length)}${suffix}`;
    n++;
  }
  used.add(name.toUpperCase());
  return name;
}

const HOURLY_REPORT_HEADERS = [
  'Date', 'Shift', 'Line', 'Part/Model', 'Hour', 'Supervisor', 'Operator(s)',
  'Planned', 'Produced', 'Efficiency', 'Rejections', 'Loss Parts', 'Loss Time (min)',
  'Loss Reason', 'Downtime (min)',
];

const HOURLY_LINE_HEADERS = [
  'Date', 'Shift', 'Hour', 'Supervisor', 'Operators',
  'Planned', 'Produced', 'Efficiency', 'Rejections', 'Loss Parts', 'Loss Time (min)',
  'Loss Reason', 'Downtime (min)',
];

// Applies the standard table look (header style, zebra body, borders, number
// formats, autofilter, frozen header, column widths) to an hourly table
// starting at `headerRow`, shared by both the combined HOURLY REPORT sheet
// and every per-line HOURLY - <line> sheet.
function styleHourlyTable(
  ws: XLSX.WorkSheet,
  headerRow: number,
  colCount: number,
  rowCount: number,
  numericCols: { col: number; fmt: string }[],
  colWidths: number[]
) {
  styleHeaderRow(ws, headerRow, colCount, STYLE.tableHeader);
  for (let i = 0; i < rowCount; i++) {
    const r = headerRow + 1 + i;
    const style = dataCellStyle(i % 2 === 1);
    for (let c = 0; c < colCount; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      if (ws[addr]) ws[addr].s = style;
    }
  }
  numericCols.forEach(({ col, fmt }) => setColumnNumFmt(ws, col, headerRow + 1, rowCount, fmt));
  ws['!autofilter'] = {
    ref: XLSX.utils.encode_range({ s: { r: headerRow, c: 0 }, e: { r: headerRow, c: colCount - 1 } }),
  };
  ws['!views'] = [{ state: 'frozen', ySplit: headerRow + 1, xSplit: 0, topLeftCell: `A${headerRow + 2}`, activePane: 'bottomLeft' }];
  ws['!cols'] = colWidths.map((wch) => ({ wch }));
}

// The compact KPI block shown at the top of HOURLY REPORT. Built from the
// same hourly groups as the table below it (not re-derived from `records`),
// so there is exactly one calculation path and it can't drift from the
// table it summarizes. It's also, by construction, the same sums the
// screen's own `summary` uses — SUMMARY sheet totals should reconcile.
function hourlyKpis(groups: HourlyGroup[]) {
  let planned = 0, produced = 0, rejections = 0, lossParts = 0, lossTimeMinutes = 0, downtimeMinutes = 0;
  groups.forEach((g) => {
    planned += g.planned;
    produced += g.produced;
    rejections += g.rejections;
    lossParts += g.lossParts;
    lossTimeMinutes += g.lossTimeMinutes;
    downtimeMinutes += g.downtimeMinutes;
  });
  const efficiency = planned > 0 ? Math.round((produced / planned) * 1000) / 10 : 0;
  return {
    hours: groups.length,
    planned,
    produced,
    efficiency,
    rejections,
    lossParts: Math.round(lossParts),
    lossTimeMinutes: Math.round(lossTimeMinutes),
    downtimeMinutes: Math.round(downtimeMinutes),
  };
}

// Shared header block: title, date range, then the existing filter-grid look
// (same STYLE.filterLabel/filterValue pair the SUMMARY sheet uses) so every
// sheet in the workbook reads as one designed report. `titleLines` lets the
// per-line sheet add its own line-name line under the main title.
function writeHourlyHeader(
  ws: XLSX.WorkSheet,
  merges: XLSX.Range[],
  tableWidth: number,
  titleLines: string[],
  dateRangeLabel: string,
  filterRows: [string, string][][]
): number {
  let r = 0;
  titleLines.forEach((line, i) => {
    setCell(ws, r, 0, line, i === 0 ? STYLE.title : STYLE.subtitle);
    merges.push({ s: { r, c: 0 }, e: { r, c: Math.max(1, tableWidth - 1) } });
    r++;
  });
  setCell(ws, r, 0, dateRangeLabel, STYLE.subtitle);
  merges.push({ s: { r, c: 0 }, e: { r, c: Math.max(1, tableWidth - 1) } });
  r += 2;

  filterRows.forEach((row) => {
    if (row.length === 1) {
      const [label, value] = row[0];
      setCell(ws, r, 0, label, STYLE.filterLabel);
      setCell(ws, r, 1, value, STYLE.filterValue);
    } else {
      const [label1, value1] = row[0];
      const [label2, value2] = row[1];
      setCell(ws, r, 0, label1, STYLE.filterLabel);
      setCell(ws, r, 1, value1, STYLE.filterValue);
      setCell(ws, r, 2, label2, STYLE.filterLabel);
      setCell(ws, r, 3, value2, STYLE.filterValue);
    }
    r++;
  });
  r += 1;
  return r;
}

// ── HOURLY REPORT (all filtered lines) ──────────────────────────────────

function buildHourlyReportSheet(filters: ExcelFilters, hourlyRows: ExcelHourlySourceRow[]): XLSX.WorkSheet {
  const ws: XLSX.WorkSheet = {};
  const merges: XLSX.Range[] = [];
  const tableWidth = HOURLY_REPORT_HEADERS.length;

  let r = writeHourlyHeader(
    ws,
    merges,
    tableWidth,
    ['HOURLY PRODUCTION REPORT'],
    `${formatDateLabel(filters.fromDate)} to ${formatDateLabel(filters.toDate)}`,
    [
      [['Plant', safe(filters.plant)], ['Workshop', safe(filters.workshop)]],
      [['Division', safe(filters.division)], ['Line', safe(filters.lineName)]],
      [['Part/Model', safe(filters.partFilter)], ['Shift', safe(filters.shiftFilter)]],
    ]
  );

  // KPI block — compact Metric | Value summary of the hourly data below.
  const groups = sortHourlyGroups(aggregateHourly(hourlyRows));
  const kpis = hourlyKpis(groups);

  setCell(ws, r, 0, 'HOURLY SUMMARY', STYLE.sectionHeading);
  setCell(ws, r, 1, '', STYLE.sectionHeading);
  merges.push({ s: { r, c: 0 }, e: { r, c: 1 } });
  r++;
  setCell(ws, r, 0, 'Metric', STYLE.tableHeader);
  setCell(ws, r, 1, 'Value', STYLE.tableHeader);
  r++;
  const kpiRows: [string, number, string][] = [
    ['Total Hours Recorded', kpis.hours, '#,##0'],
    ['Total Planned', kpis.planned, '#,##0'],
    ['Total Produced', kpis.produced, '#,##0'],
    ['Overall Efficiency (%)', kpis.efficiency, '0.0"%"'],
    ['Total Rejections', kpis.rejections, '#,##0'],
    ['Total Loss Parts', kpis.lossParts, '#,##0'],
    ['Total Loss Time (min)', kpis.lossTimeMinutes, '#,##0" min"'],
    ['Total Downtime (min)', kpis.downtimeMinutes, '#,##0" min"'],
  ];
  kpiRows.forEach(([label, value, fmt]) => {
    setCell(ws, r, 0, label, STYLE.metricLabel);
    setCell(ws, r, 1, value, STYLE.kpiValue, fmt);
    r++;
  });
  r += 2;

  // Section heading + table, across the full table width.
  setCell(ws, r, 0, 'HOURLY PRODUCTION SUMMARY', STYLE.sectionHeading);
  for (let c = 1; c < tableWidth; c++) setCell(ws, r, c, '', STYLE.sectionHeading);
  merges.push({ s: { r, c: 0 }, e: { r, c: tableWidth - 1 } });
  r++;

  const headerRow = r;
  HOURLY_REPORT_HEADERS.forEach((h, c) => setCell(ws, headerRow, c, h));
  r++;

  groups.forEach((g) => {
    setCell(ws, r, 0, formatDateLabel(g.productionDate));
    setCell(ws, r, 1, safe(g.shift));
    setCell(ws, r, 2, safe(g.lineName));
    setCell(ws, r, 3, hourlyPartText(g));
    setCell(ws, r, 4, hourRangeLabel(g.hourStartAbs));
    setCell(ws, r, 5, hourlySupervisorText(g));
    setCell(ws, r, 6, hourlyOperatorsText(g));
    setCell(ws, r, 7, num(g.planned));
    setCell(ws, r, 8, num(g.produced));
    setCell(ws, r, 9, hourlyEfficiency(g));
    setCell(ws, r, 10, num(g.rejections));
    setCell(ws, r, 11, Math.round(g.lossParts));
    setCell(ws, r, 12, Math.round(g.lossTimeMinutes));
    setCell(ws, r, 13, hourlyReasonText(g));
    setCell(ws, r, 14, Math.round(g.downtimeMinutes));
    r++;
  });

  styleHourlyTable(
    ws,
    headerRow,
    tableWidth,
    groups.length,
    [
      { col: 7, fmt: '#,##0' },
      { col: 8, fmt: '#,##0' },
      { col: 9, fmt: '0.0"%"' },
      { col: 10, fmt: '#,##0' },
      { col: 11, fmt: '#,##0' },
      { col: 12, fmt: '#,##0" min"' },
      { col: 14, fmt: '#,##0" min"' },
    ],
    [10, 7, 12, 16, 18, 24, 10, 10, 11, 11, 11, 14, 20, 26, 15]
  );

  const lastRow = Math.max(headerRow, r - 1);
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: lastRow, c: tableWidth - 1 } });
  ws['!merges'] = merges;
  ws['!rows'] = [{ hpx: 28 }];

  return ws;
}

// ── HOURLY - <line> (one line only) ─────────────────────────────────────

function buildHourlyLineSheet(filters: ExcelFilters, lineName: string, lineHourlyRows: ExcelHourlySourceRow[]): XLSX.WorkSheet {
  const ws: XLSX.WorkSheet = {};
  const merges: XLSX.Range[] = [];
  const tableWidth = HOURLY_LINE_HEADERS.length;

  const partNames = Array.from(new Set(lineHourlyRows.map((r) => r.partName).filter((p): p is string => !!p)));
  const partText = partNames.length === 0 ? '—' : partNames.length === 1 ? partNames[0] : partNames.join(', ');

  let r = writeHourlyHeader(
    ws,
    merges,
    tableWidth,
    ['HOURLY PRODUCTION REPORT', lineName],
    `${formatDateLabel(filters.fromDate)} to ${formatDateLabel(filters.toDate)}`,
    [
      [['Plant', safe(filters.plant)]],
      [['Workshop', safe(filters.workshop)]],
      [['Division', safe(filters.division)]],
      [['Line', safe(lineName)]],
      [['Part/Model', partText]],
    ]
  );

  const groups = sortHourlyGroups(aggregateHourly(lineHourlyRows));

  const headerRow = r;
  HOURLY_LINE_HEADERS.forEach((h, c) => setCell(ws, headerRow, c, h));
  r++;

  groups.forEach((g) => {
    setCell(ws, r, 0, formatDateLabel(g.productionDate));
    setCell(ws, r, 1, safe(g.shift));
    setCell(ws, r, 2, hourRangeLabel(g.hourStartAbs));
    setCell(ws, r, 3, hourlySupervisorText(g));
    setCell(ws, r, 4, hourlyOperatorsText(g));
    setCell(ws, r, 5, num(g.planned));
    setCell(ws, r, 6, num(g.produced));
    setCell(ws, r, 7, hourlyEfficiency(g));
    setCell(ws, r, 8, num(g.rejections));
    setCell(ws, r, 9, Math.round(g.lossParts));
    setCell(ws, r, 10, Math.round(g.lossTimeMinutes));
    setCell(ws, r, 11, hourlyReasonText(g));
    setCell(ws, r, 12, Math.round(g.downtimeMinutes));
    r++;
  });

  styleHourlyTable(
    ws,
    headerRow,
    tableWidth,
    groups.length,
    [
      { col: 5, fmt: '#,##0' },
      { col: 6, fmt: '#,##0' },
      { col: 7, fmt: '0.0"%"' },
      { col: 8, fmt: '#,##0' },
      { col: 9, fmt: '#,##0' },
      { col: 10, fmt: '#,##0" min"' },
      { col: 12, fmt: '#,##0" min"' },
    ],
    [12, 7, 18, 24, 10, 10, 10, 11, 11, 11, 14, 26, 15]
  );

  const lastRow = Math.max(headerRow, r - 1);
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: lastRow, c: tableWidth - 1 } });
  ws['!merges'] = merges;
  ws['!rows'] = [{ hpx: 28 }];

  return ws;
}

function reportFileName(filters: ExcelFilters) {
  return `Production_Report_${filters.fromDate}_to_${filters.toDate}.xlsx`;
}

/**
 * Builds the workbook and saves/downloads/shares it depending on platform.
 * Throws on failure — the caller (GenerateReportScreen) owns the loading
 * state and the success/error message.
 */
export async function exportReportToExcel(params: {
  filters: ExcelFilters;
  summary: ExcelSummary;
  detailRows: ExcelDetailRow[];
  lineSummaryRows: ExcelLineSummaryRow[];
  // Optional — omitting it (or passing []) just skips the HOURLY sheets,
  // so existing/older callers of this function keep working unchanged.
  hourlyRows?: ExcelHourlySourceRow[];
}): Promise<void> {
  const { filters, summary, detailRows, lineSummaryRows, hourlyRows = [] } = params;

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, buildSummarySheet(filters, summary), 'SUMMARY');
  XLSX.utils.book_append_sheet(wb, buildDetailedRecordsSheet(detailRows), 'DETAILED RECORDS');
  XLSX.utils.book_append_sheet(wb, buildLineSummarySheet(lineSummaryRows), 'LINE SUMMARY');

  if (hourlyRows.length > 0) {
    XLSX.utils.book_append_sheet(wb, buildHourlyReportSheet(filters, hourlyRows), 'HOURLY REPORT');

    // One sheet per line actually present in the filtered data — never
    // invented, and alphabetically ordered (with numeric-aware comparison
    // so "HHL-2" sorts before "HHL-10") for a stable, readable tab order.
    const lineNames = Array.from(new Set(hourlyRows.map((r) => r.lineName).filter((n): n is string => !!n)))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    const usedSheetNames = new Set<string>(['SUMMARY', 'DETAILED RECORDS', 'LINE SUMMARY', 'HOURLY REPORT']);
    lineNames.forEach((lineName) => {
      const lineRows = hourlyRows.filter((r) => r.lineName === lineName);
      const sheetName = hourlySheetName(lineName, usedSheetNames);
      XLSX.utils.book_append_sheet(wb, buildHourlyLineSheet(filters, lineName, lineRows), sheetName);
    });
  }

  const fileName = reportFileName(filters);

  if (Platform.OS === 'web') {
    // Triggers a normal browser download. No filesystem/share APIs exist
    // (or are needed) in a web build.
    XLSX.writeFile(wb, fileName, { bookType: 'xlsx' });
    return;
  }

  // Android/iOS: write into the app's sandboxed document directory, then
  // hand off to the native share sheet so the user can save or send it.
  const base64 = XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });
  const fileUri = `${FileSystem.documentDirectory}${fileName}`;
  await FileSystem.writeAsStringAsync(fileUri, base64, { encoding: FileSystem.EncodingType.Base64 });

  const canShare = await Sharing.isAvailableAsync();
  if (!canShare) {
    // Rare on real devices, but fail clearly rather than silently leaving
    // the file only in app-private storage with no way for the user to reach it.
    throw new Error('Sharing is not available on this device.');
  }
  await Sharing.shareAsync(fileUri, {
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    dialogTitle: 'Export Production Report',
    UTI: 'com.microsoft.excel.xlsx',
  });
}