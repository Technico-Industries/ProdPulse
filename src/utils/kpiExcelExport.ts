// src/utils/kpiExcelExport.ts
//
// Builds a single KPI_ANALYSIS_REPORT.xlsx workbook with one sheet per KPI,
// matching exactly what KPIAnalysisScreen.tsx displays.  The caller (e.g.
// KPIAnalysisScreen) passes in all the already-fetched / filtered data;
// this file does no Firestore work and never invents numbers.
//
// Sheet index:
//   00_DASHBOARD         – overview + hyperlinks
//   01_PCS_MAN_HOUR      – pcsManHourRecords data
//   02_PLAN_VS_ACTUAL    – planVsActualRecords data
//   03_REJECTION_PERCENT – productionRecords (rejection slice)
//   04_LOSS_DETAILS      – productionRecords (loss slice)
//   05_NEAR_MISS         – nearMissReports data
//   06_MAN_DAYS          – manDaysRecords data
//   07_POKA_YOKE         – pokaYokeRecords data
//   08_REWORK_PERCENT    – reworkRecords data
//   09_KAIZEN            – kaizenRecords data
//   10_ATTENDANCE        – attendanceRecords data
//
// Library: xlsx-js-style (same fork already used by reportExcelExport.ts).

import { Platform } from 'react-native';
import * as XLSX from 'xlsx-js-style';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';

// ─── Shared types (structural only — matches KPIAnalysisScreen's interfaces) ─

export interface KpiFilters {
  plant: string | null;
  workshop: string | null;
  division: string | null;
  fromDate: string;
  toDate: string;
}

// ProductionRecord slice used by Rejection & Loss sheets
export interface KpiProductionRecord {
  productionDate: string | null;
  shift: string | null;
  plant: string | null;
  workshop: string | null;
  division: string | null;
  lineId: string | null;
  lineName: string | null;
  partName: string | null;
  expectedParts: number | null;
  producedThisSlot: number | null;
  lossParts: number | null;
  lossReasonLabel: string | null;
  rejections: number | null;
  stopEvents: { reason: string; durationMinutes?: number | null }[] | null;
  operatorCount: number;
  productiveMinutes: number | null;
  createdAtMs: number | null;
}

export interface KpiPcsPerHourLine {
  lineId: string;
  lineName: string;
  production: number;
  hours: number;
  otHours: number;
}

export interface KpiPcsPerHourDay {
  dateKey: string;
  dateLabel: string;
  actual: number;
  manPowerTarget: number;
  manPowerActual: number;
  avgHours: number;
  avgOtHours: number;
  manHour: number;
  pcsManHour: number;
  lines: KpiPcsPerHourLine[];
}

export interface KpiPlanVsActualRecord {
  id: string;
  date: string;
  plant: string | null;
  workshop: string | null;
  division: string | null;
  shift: string | null;
  lineName: string;
  planned: number;
  actual: number;
  loss: number;
  productionPct: number;
  submittedBy: string;
  createdAtMs: number | null;
}

export interface KpiNearMissRecord {
  id: string;
  date: string;
  plant: string | null;
  workshop: string | null;
  division: string | null;
  areaMachine: string;
  intensity: 'Low' | 'Medium' | 'High' | 'Critical';
  description: string;
  actionTaken: string;
  tdc: string;
  responsibility: string;
  status: 'Open' | 'In Progress' | 'Closed' | 'Pending';
  closedOn: string;
  submittedBy: string;
  createdAtMs: number | null;
}

export interface KpiManDayRecord {
  id: string;
  plant: string;
  workshop: string;
  division: string;
  dateISO: string;
  dateDisplay: string;
  dayOfWeek: string;
  month: string;
  present: number;
  absent: number;
  onLeave: number;
  totalPresent: number;
  remarks: string;
  submittedBy: string;
  createdAtMs: number | null;
}

export interface KpiPokaYokeRecord {
  id: string;
  sNo: number | null;
  plant: string | null;
  workshop: string | null;
  division: string | null;
  lineName: string;
  lineNo: string;
  partsName: string;
  model: string;
  pokaYokeNo: string;
  pokaYokeDetails: string;
  problem: string;
  rootCause: string;
  actionPlan: string;
  responsibility: string;
  targetDate: string;
  status: 'Open' | 'In Progress' | 'Closed';
  submittedBy: string;
  createdAtMs: number | null;
}

export interface KpiReworkRecord {
  id: string;
  date: string;
  plant: string | null;
  workshop: string | null;
  division: string | null;
  shift: string | null;
  lineName: string;
  totalProduction: number;
  reworkCount: number;
  reworkPct: number;
  submittedBy: string;
  createdAtMs: number | null;
}

export interface KpiKaizenRecord {
  id: string;
  sNo: number;
  date: string;
  plant: string | null;
  workshop: string | null;
  division: string | null;
  employeeName: string;
  employeeCode: string;
  improvementIdentified: string;
  kaizenIdea: string;
  category: string;
  priority: string;
  actionTaken: string;
  responsibility: string;
  targetDate: string;
  status: 'Open' | 'In Progress' | 'Implemented' | 'Closed' | 'Rejected';
  result: string;
  remarks: string;
  submittedBy: string;
  createdAtMs: number | null;
}

export interface KpiAttendanceRecord {
  id: string;
  operatorId: string;
  operatorName: string;
  operatorCode: string;
  plant: string | null;
  workshop: string | null;
  division: string | null;
  date: string;
  shift: string | null;
  status: 'present' | 'absent' | 'leave';
  submittedBy: string;
  createdAtMs: number | null;
}

export interface KpiAnalysisExportParams {
  filters: KpiFilters;
  // Each dataset corresponds to one KPI sheet; pass [] for any KPI that
  // wasn't loaded (its sheet will show "No data" rather than crashing).
  pcsPerHourDays: KpiPcsPerHourDay[];
  planVsActualRecords: KpiPlanVsActualRecord[];
  productionRecords: KpiProductionRecord[];   // used for rejection + loss
  nearMissRecords: KpiNearMissRecord[];
  manDaysRecords: KpiManDayRecord[];
  pokaYokeRecords: KpiPokaYokeRecord[];
  reworkRecords: KpiReworkRecord[];
  kaizenRecords: KpiKaizenRecord[];
  attendanceRecords: KpiAttendanceRecord[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const safe = (v: string | number | null | undefined): string =>
  v === null || v === undefined || v === '' ? '—' : String(v);

const num = (v: number | null | undefined): number =>
  typeof v === 'number' && !isNaN(v) ? v : 0;

function round1(n: number) {
  return Math.round(n * 10) / 10;
}

function pad2(n: number) {
  return String(n).padStart(2, '0');
}

function dateKeyFromMs(ms: number | null): string {
  if (!ms) return 'unknown';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatDateLabel(iso: string | null | undefined): string {
  if (!iso) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const idx = parseInt(m[2], 10) - 1;
  if (idx < 0 || idx > 11) return iso;
  return `${m[3]}-${MONTH_ABBR[idx]}-${m[1]}`;
}

function monthLabelFromKey(ym: string): string {
  if (!ym || ym === 'unknown') return 'Unknown';
  const [y, mo] = ym.split('-');
  const idx = parseInt(mo, 10) - 1;
  if (!y || isNaN(idx) || idx < 0 || idx > 11) return ym;
  return `${MONTH_ABBR[idx]} ${y}`;
}

function deriveReasonFromStops(events: { reason: string }[] | null): string | null {
  if (!events || events.length === 0) return null;
  const reasons = Array.from(new Set(events.map((e) => e.reason).filter(Boolean)));
  return reasons.length === 0 ? null : reasons.join(', ');
}

// ─── Colour palette — professional/native-Excel theme (light background,
// dark navy table headers, subtle accent colors used only for status/series,
// not for large fills). Key names kept identical to the previous dark-theme
// palette so every downstream sheet-builder function below (01_PCS_MAN_HOUR
// through 10_ATTENDANCE) needs no changes — only what each key resolves to.

const C = {
  // page / card backgrounds — now white, not dark UI panels
  dashBg:    'FFFFFF',
  cardBg:    'FFFFFF',
  titleBg:   'FFFFFF',
  subHdrBg:  'D9E1F2',
  // zebra striping for data tables
  zebraOdd:  'F2F2F2',
  zebraEven: 'FFFFFF',
  // text
  primary:   '1F1F1F',
  secondary: '595959',
  muted:     '808080',
  white:     'FFFFFF',
  // accent / status / series colors — used sparingly, never as full-cell fills
  accent:    'ED7D31',
  blue:      '2E75B6',
  green:     '548235',
  red:       'C00000',
  orange:    'ED7D31',
  yellow:    'BF8F00',
  purple:    '7030A0',
  // table headers / section bars — the one place we use a solid dark fill,
  // matching a conventional Excel report header row
  headerBg:  '1F3864',
  // thin borders
  borderClr: 'BFBFBF',
};

const thin = (rgb: string) => ({ style: 'thin', color: { rgb } });

const borderAll = (rgb: string = C.borderClr) => ({
  top: thin(rgb), bottom: thin(rgb), left: thin(rgb), right: thin(rgb),
});

// ─── Style presets ────────────────────────────────────────────────────────────

function titleStyle(sz = 16) {
  return {
    font: { bold: true, sz, color: { rgb: C.primary } },
    alignment: { horizontal: 'left', vertical: 'center' },
  };
}

function subtitleStyle() {
  return {
    font: { italic: true, sz: 10, color: { rgb: C.secondary } },
    alignment: { horizontal: 'left', vertical: 'center' },
  };
}

// Section heading bar — the one place besides table headers that uses a
// solid dark fill, kept short (one row) so it reads as a normal Excel
// "banner" row rather than a UI card.
function sectionStyle(rgb = C.headerBg) {
  return {
    font: { bold: true, sz: 11, color: { rgb: C.white } },
    fill: { patternType: 'solid', fgColor: { rgb } },
    alignment: { horizontal: 'left', vertical: 'center', indent: 1 },
  };
}

function headerStyle(rgb = C.headerBg) {
  return {
    font: { bold: true, sz: 10, color: { rgb: C.white } },
    fill: { patternType: 'solid', fgColor: { rgb } },
    alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
    border: borderAll(),
  };
}

function labelStyle() {
  return {
    font: { bold: true, sz: 10, color: { rgb: C.primary } },
    fill: { patternType: 'solid', fgColor: { rgb: C.zebraOdd } },
    alignment: { horizontal: 'left', vertical: 'center', indent: 1 },
    border: borderAll(),
  };
}

function valueStyle(rgb = C.primary) {
  return {
    font: { sz: 10, color: { rgb } },
    fill: { patternType: 'solid', fgColor: { rgb: C.zebraEven } },
    alignment: { horizontal: 'left', vertical: 'center', indent: 1 },
    border: borderAll(),
  };
}

// Metric-table value cell (used by writeKpiCards) — bold, colored text,
// centered, on a plain zebra background. No oversized fonts, no merged
// 2x2 "card" blocks.
function metricValueStyle(rgb: string, zebra: boolean) {
  return {
    font: { bold: true, sz: 11, color: { rgb } },
    fill: { patternType: 'solid', fgColor: { rgb: zebra ? C.zebraOdd : C.zebraEven } },
    alignment: { horizontal: 'center', vertical: 'center' },
    border: borderAll(),
  };
}

function dataStyle(zebra: boolean) {
  return {
    font: { sz: 10, color: { rgb: C.primary } },
    fill: { patternType: 'solid', fgColor: { rgb: zebra ? C.zebraOdd : C.zebraEven } },
    alignment: { horizontal: 'center', vertical: 'center', wrapText: false },
    border: borderAll(),
  };
}

function dataStyleLeft(zebra: boolean) {
  return {
    font: { sz: 10, color: { rgb: C.primary } },
    fill: { patternType: 'solid', fgColor: { rgb: zebra ? C.zebraOdd : C.zebraEven } },
    alignment: { horizontal: 'left', vertical: 'center', wrapText: true, indent: 1 },
    border: borderAll(),
  };
}

function statusStyle(rgb: string, zebra: boolean) {
  return {
    font: { bold: true, sz: 10, color: { rgb } },
    fill: { patternType: 'solid', fgColor: { rgb: zebra ? C.zebraOdd : C.zebraEven } },
    alignment: { horizontal: 'center', vertical: 'center' },
    border: borderAll(),
  };
}

// ─── Cell writer ─────────────────────────────────────────────────────────────

function sc(ws: XLSX.WorkSheet, r: number, c: number, value: string | number, style?: any, fmt?: string) {
  const addr = XLSX.utils.encode_cell({ r, c });
  const cell: any = { v: value, t: typeof value === 'number' ? 'n' : 's' };
  if (fmt && typeof value === 'number') cell.z = fmt;
  if (style) cell.s = style;
  ws[addr] = cell;
}

function merge(merges: XLSX.Range[], r: number, c: number, re: number, ce: number) {
  merges.push({ s: { r, c }, e: { r: re, c: ce } });
}

function hyperlink(ws: XLSX.WorkSheet, r: number, c: number, label: string, sheetName: string, style?: any) {
  const addr = XLSX.utils.encode_cell({ r, c });
  ws[addr] = {
    v: label,
    t: 's',
    l: { Target: `#'${sheetName}'!A1` },
    s: style ?? {
      font: { underline: true, color: { rgb: C.blue }, sz: 10 },
      alignment: { horizontal: 'left', vertical: 'center' },
    },
  };
}

// ─── Common sheet skeleton ────────────────────────────────────────────────────
// Returns the next available row index after the common header block.
// Layout mirrors a conventional printed report header:
//   Row 0: report title (plain bold text, no fill box)
//   Row 1: date range (italic, muted)
//   Row 2: filter strip (Plant / Workshop / Division as bordered label:value
//          cells, not colored tiles)
//   Row 3: small text link back to the dashboard
//   Row 4: spacer

function writeSheetHeader(
  ws: XLSX.WorkSheet,
  merges: XLSX.Range[],
  cols: number,
  title: string,
  filters: KpiFilters,
): number {
  let r = 0;

  // Row 0 – title
  sc(ws, r, 0, title, titleStyle(14));
  merge(merges, r, 0, r, cols - 1);
  r++;

  // Row 1 – date range
  const dateRange = `${formatDateLabel(filters.fromDate)}  to  ${formatDateLabel(filters.toDate)}`;
  sc(ws, r, 0, dateRange, subtitleStyle());
  merge(merges, r, 0, r, cols - 1);
  r++;

  // Row 2 – filter row (bordered label:value pairs, like a normal Excel form)
  const fPairs: [string, string][] = [
    ['Plant', safe(filters.plant)],
    ['Workshop', safe(filters.workshop)],
    ['Division', safe(filters.division)],
  ];
  fPairs.forEach(([lbl, val], i) => {
    const col = i * 2;
    if (col < cols) sc(ws, r, col, lbl, labelStyle());
    if (col + 1 < cols) sc(ws, r, col + 1, val, valueStyle());
  });
  for (let c = fPairs.length * 2; c < cols; c++) sc(ws, r, c, '', valueStyle());
  r++;

  // Row 3 – small plain-text link back to the dashboard (no colored box)
  hyperlink(ws, r, 0, '<< Back to Dashboard', '00_DASHBOARD', {
    font: { underline: true, color: { rgb: C.blue }, sz: 9 },
    alignment: { horizontal: 'left', vertical: 'center' },
  });
  r++;

  r++; // spacer
  return r;
}

// Write a compact "Metric | Value" summary table (replaces the old
// oversized 2x2 colored KPI cards). Returns the next row after the table.
function writeKpiCards(
  ws: XLSX.WorkSheet,
  merges: XLSX.Range[],
  r: number,
  cards: { label: string; value: string | number; color?: string }[],
  cols: number,
): number {
  // Section heading
  sc(ws, r, 0, 'KPI SUMMARY', sectionStyle());
  for (let c = 1; c < cols; c++) sc(ws, r, c, '', sectionStyle());
  merge(merges, r, 0, r, cols - 1);
  r++;

  // Header row
  sc(ws, r, 0, 'Metric', headerStyle());
  sc(ws, r, 1, 'Value', headerStyle());
  for (let c = 2; c < cols; c++) sc(ws, r, c, '', headerStyle());
  merge(merges, r, 1, r, cols - 1);
  r++;

  // One row per metric — plain table row, not a merged colored tile
  cards.forEach((card, i) => {
    const zebra = i % 2 === 1;
    sc(ws, r, 0, card.label, dataStyleLeft(zebra));
    const rgb = card.color ?? C.primary;
    sc(ws, r, 1, card.value, metricValueStyle(rgb, zebra));
    for (let c = 2; c < cols; c++) sc(ws, r, c, '', dataStyle(zebra));
    merge(merges, r, 1, r, cols - 1);
    r++;
  });

  r++; // spacer
  return r;
}

// Write a section heading + header row + data rows.
// Returns next row. Also sets the sheet's AutoFilter to this table's range
// (the last table written on a sheet — typically DETAILED RECORDS — is the
// one left with an active filter, matching how a normal Excel report is
// filtered on its main data table).
function writeTable(
  ws: XLSX.WorkSheet,
  merges: XLSX.Range[],
  r: number,
  sectionTitle: string,
  headers: string[],
  rows: (string | number)[][],
  cols: number,
  numFmtCols?: { col: number; fmt: string }[],
  statusCols?: { col: number; colorMap: Record<string, string> }[],
): number {
  // Section heading
  sc(ws, r, 0, sectionTitle, sectionStyle());
  for (let c = 1; c < cols; c++) sc(ws, r, c, '', sectionStyle());
  merge(merges, r, 0, r, cols - 1);
  r++;

  // Header row
  const headerRow = r;
  headers.forEach((h, c) => sc(ws, r, c, h, headerStyle()));
  r++;

  // Data rows
  rows.forEach((row, i) => {
    const zebra = i % 2 === 1;
    row.forEach((val, c) => {
      // Determine if this column has a status color override
      const statusCol = statusCols?.find((sc2) => sc2.col === c);
      if (statusCol && typeof val === 'string' && statusCol.colorMap[val]) {
        sc(ws, r, c, val, statusStyle(statusCol.colorMap[val], zebra));
      } else if (typeof val === 'string') {
        sc(ws, r, c, val, dataStyleLeft(zebra));
      } else {
        sc(ws, r, c, val, dataStyle(zebra));
      }
    });
    r++;
  });

  // Apply number formats
  if (numFmtCols && rows.length > 0) {
    numFmtCols.forEach(({ col, fmt }) => {
      for (let i = 0; i < rows.length; i++) {
        const addr = XLSX.utils.encode_cell({ r: r - rows.length + i, c: col });
        if (ws[addr] && ws[addr].t === 'n') ws[addr].z = fmt;
      }
    });
  }

  if (rows.length > 0) {
    ws['!autofilter'] = {
      ref: XLSX.utils.encode_range({ s: { r: headerRow, c: 0 }, e: { r: headerRow + rows.length, c: headers.length - 1 } }),
    };
  }

  r++; // spacer
  return r;
}

function finalizeSheet(
  ws: XLSX.WorkSheet,
  merges: XLSX.Range[],
  lastRow: number,
  cols: number,
  colWidths: number[],
) {
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: lastRow, c: cols - 1 } });
  ws['!merges'] = merges;
  ws['!cols'] = colWidths.map((w) => ({ wch: w }));
  ws['!views'] = [{ state: 'frozen', ySplit: 5, xSplit: 0, topLeftCell: 'A6', activePane: 'bottomLeft' }];
  ws['!rows'] = [{ hpx: 24 }, { hpx: 16 }, { hpx: 18 }, { hpx: 16 }];
}

// ─── 00_DASHBOARD ────────────────────────────────────────────────────────────
// Plain "KPI | Current Value | Status | Report Sheet" table with hyperlinks
// into each sheet — not a grid of colored web-style cards.

function buildDashboard(
  filters: KpiFilters,
  kpiSummaries: { label: string; value: string; color: string; status: string; sheet: string }[],
): XLSX.WorkSheet {
  const ws: XLSX.WorkSheet = {};
  const merges: XLSX.Range[] = [];
  const cols = 6;
  let r = 0;

  // Title
  sc(ws, r, 0, 'KPI ANALYSIS REPORT', titleStyle(18));
  merge(merges, r, 0, r, cols - 1);
  r++;

  sc(ws, r, 0, `${formatDateLabel(filters.fromDate)}  to  ${formatDateLabel(filters.toDate)}`, subtitleStyle());
  merge(merges, r, 0, r, cols - 1);
  r++;
  r++; // spacer

  // Filter strip
  const fp: [string, string][] = [
    ['Plant', safe(filters.plant)],
    ['Workshop', safe(filters.workshop)],
    ['Division', safe(filters.division)],
  ];
  fp.forEach(([lbl, val], i) => {
    sc(ws, r, i * 2, lbl, labelStyle());
    sc(ws, r, i * 2 + 1, val, valueStyle());
  });
  r++;
  sc(ws, r, 0, 'From', labelStyle());
  sc(ws, r, 1, formatDateLabel(filters.fromDate), valueStyle());
  sc(ws, r, 2, 'To', labelStyle());
  sc(ws, r, 3, formatDateLabel(filters.toDate), valueStyle());
  for (let c = 4; c < cols; c++) sc(ws, r, c, '', valueStyle());
  r += 2; // spacer

  // KPI overview table
  sc(ws, r, 0, 'KPI OVERVIEW', sectionStyle());
  for (let c = 1; c < cols; c++) sc(ws, r, c, '', sectionStyle());
  merge(merges, r, 0, r, cols - 1);
  r++;

  const headers = ['KPI', 'Current Value', 'Status', 'Report Sheet'];
  headers.forEach((h, c) => sc(ws, r, c, h, headerStyle()));
  for (let c = headers.length; c < cols; c++) sc(ws, r, c, '', headerStyle());
  r++;

  const tableStartRow = r;
  kpiSummaries.forEach((kpi, i) => {
    const zebra = i % 2 === 1;
    sc(ws, r, 0, kpi.label, dataStyleLeft(zebra));
    sc(ws, r, 1, kpi.value, metricValueStyle(kpi.color, zebra));
    sc(ws, r, 2, kpi.status, statusStyle(kpi.color, zebra));
    hyperlink(ws, r, 3, kpi.sheet, kpi.sheet, {
      font: { underline: true, sz: 10, color: { rgb: C.blue } },
      fill: { patternType: 'solid', fgColor: { rgb: zebra ? C.zebraOdd : C.zebraEven } },
      alignment: { horizontal: 'center', vertical: 'center' },
      border: borderAll(),
    });
    for (let c = 4; c < cols; c++) sc(ws, r, c, '', dataStyle(zebra));
    r++;
  });

  ws['!autofilter'] = {
    ref: XLSX.utils.encode_range({ s: { r: tableStartRow, c: 0 }, e: { r: r - 1, c: headers.length - 1 } }),
  };

  const lastRow = r + 1;
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: lastRow, c: cols - 1 } });
  ws['!merges'] = merges;
  ws['!cols'] = [24, 16, 14, 20, 14, 14].map((w) => ({ wch: w }));
  ws['!views'] = [{ state: 'frozen', ySplit: tableStartRow, xSplit: 0, topLeftCell: `A${tableStartRow + 1}`, activePane: 'bottomLeft' }];
  ws['!rows'] = [{ hpx: 26 }, { hpx: 16 }];
  return ws;
}


// ─── 01_PCS_MAN_HOUR ─────────────────────────────────────────────────────────

function buildPcsManHourSheet(filters: KpiFilters, days: KpiPcsPerHourDay[]): XLSX.WorkSheet {
  const ws: XLSX.WorkSheet = {};
  const merges: XLSX.Range[] = [];
  const cols = 8;

  // Totals (same as pcsPerHourTotals in KPIAnalysisScreen)
  const totalActual = days.reduce((s, d) => s + d.actual, 0);
  const totalManHour = days.reduce((s, d) => s + d.manHour, 0);
  const avgManPower = days.length > 0 ? round1(days.reduce((s, d) => s + d.manPowerActual, 0) / days.length) : 0;
  const avgOtHours = days.length > 0 ? round1(days.reduce((s, d) => s + d.avgOtHours, 0) / days.length) : 0;
  const pcsManHour = totalManHour > 0 ? round1(totalActual / totalManHour) : 0;

  let r = writeSheetHeader(ws, merges, cols, '01 — PCS MAN PER HOUR', filters);

  r = writeKpiCards(ws, merges, r, [
    { label: 'Total Production', value: totalActual, color: C.green },
    { label: 'Total Man-Hours', value: round1(totalManHour), color: C.blue },
    { label: 'PCS / Man-Hour', value: pcsManHour, color: C.accent },
    { label: 'Avg Manpower', value: avgManPower, color: C.purple },
    { label: 'Avg OT Hours', value: avgOtHours, color: C.orange },
    { label: 'Number of Days', value: days.length, color: C.secondary },
  ], cols);

  // BY DAY table
  const dayRows: (string | number)[][] = days.map((d) => [
    d.dateKey, d.actual, d.manPowerActual, d.manPowerTarget,
    round1(d.manHour), d.pcsManHour, round1(d.avgOtHours),
  ]);
  r = writeTable(ws, merges, r, 'DAILY BREAKDOWN', [
    'Date', 'Actual Prod.', 'Present', 'Target Manpower', 'Man-Hours', 'PCS/Man-Hour', 'OT Hours',
  ], dayRows, cols, [
    { col: 1, fmt: '#,##0' }, { col: 2, fmt: '#,##0' }, { col: 3, fmt: '#,##0' },
    { col: 4, fmt: '#,##0.0' }, { col: 5, fmt: '#,##0.0' }, { col: 6, fmt: '#,##0.0' },
  ]);

  // BY LINE (aggregated across all days)
  const lineMap = new Map<string, { prod: number; hours: number; otHours: number }>();
  days.forEach((d) => {
    d.lines.forEach((l) => {
      const ex = lineMap.get(l.lineName);
      if (ex) { ex.prod += l.production; ex.hours += l.hours; ex.otHours += l.otHours; }
      else lineMap.set(l.lineName, { prod: l.production, hours: l.hours, otHours: l.otHours });
    });
  });
  const lineRows: (string | number)[][] = Array.from(lineMap.entries()).map(([name, v]) => [
    name, v.prod, round1(v.hours), round1(v.otHours),
  ]);
  r = writeTable(ws, merges, r, 'LINE BREAKDOWN', [
    'Line', 'Production', 'Hours', 'OT Hours',
  ], lineRows, cols, [
    { col: 1, fmt: '#,##0' }, { col: 2, fmt: '#,##0.0' }, { col: 3, fmt: '#,##0.0' },
  ]);

  finalizeSheet(ws, merges, r, cols, [14, 14, 14, 14, 14, 14, 14, 14]);
  return ws;
}

// ─── 02_PLAN_VS_ACTUAL ────────────────────────────────────────────────────────

function buildPlanVsActualSheet(filters: KpiFilters, records: KpiPlanVsActualRecord[]): XLSX.WorkSheet {
  const ws: XLSX.WorkSheet = {};
  const merges: XLSX.Range[] = [];
  const cols = 8;

  const totalPlanned = records.reduce((s, r) => s + r.planned, 0);
  const totalActual = records.reduce((s, r) => s + r.actual, 0);
  const totalLoss = records.reduce((s, r) => s + r.loss, 0);
  const achievement = totalPlanned > 0 ? round1((totalActual / totalPlanned) * 100) : 0;

  const achColor = achievement >= 95 ? C.green : achievement >= 85 ? C.yellow : achievement >= 70 ? C.orange : C.red;

  let r = writeSheetHeader(ws, merges, cols, '02 — PLAN VS ACTUAL', filters);

  r = writeKpiCards(ws, merges, r, [
    { label: 'Total Planned', value: totalPlanned, color: C.blue },
    { label: 'Total Actual', value: totalActual, color: C.green },
    { label: 'Total Loss', value: totalLoss, color: C.red },
    { label: 'Achievement %', value: `${achievement}%`, color: achColor },
  ], cols);

  // BY LINE
  const lineMap = new Map<string, { planned: number; actual: number; loss: number }>();
  records.forEach((rec) => {
    const ex = lineMap.get(rec.lineName);
    if (ex) { ex.planned += rec.planned; ex.actual += rec.actual; ex.loss += rec.loss; }
    else lineMap.set(rec.lineName, { planned: rec.planned, actual: rec.actual, loss: rec.loss });
  });
  const lineRows: (string | number)[][] = Array.from(lineMap.entries()).map(([name, v]) => {
    const pct = v.planned > 0 ? round1((v.actual / v.planned) * 100) : 0;
    return [name, v.planned, v.actual, v.loss, pct];
  });
  r = writeTable(ws, merges, r, 'BY LINE', [
    'Line', 'Planned', 'Actual', 'Loss', 'Achievement %',
  ], lineRows, cols, [
    { col: 1, fmt: '#,##0' }, { col: 2, fmt: '#,##0' }, { col: 3, fmt: '#,##0' }, { col: 4, fmt: '0.0"%"' },
  ]);

  // DETAILED RECORDS
  const detailRows: (string | number)[][] = records.map((rec) => [
    safe(rec.date), safe(rec.shift), safe(rec.lineName), rec.planned, rec.actual, rec.loss, rec.productionPct, safe(rec.submittedBy),
  ]);
  r = writeTable(ws, merges, r, 'DETAILED RECORDS', [
    'Date', 'Shift', 'Line', 'Planned', 'Actual', 'Loss', 'Achievement %', 'Submitted By',
  ], detailRows, cols, [
    { col: 3, fmt: '#,##0' }, { col: 4, fmt: '#,##0' }, { col: 5, fmt: '#,##0' }, { col: 6, fmt: '0.0"%"' },
  ]);

  finalizeSheet(ws, merges, r, cols, [12, 8, 16, 12, 12, 12, 14, 18]);
  return ws;
}

// ─── 03_REJECTION_PERCENT ─────────────────────────────────────────────────────

function buildRejectionSheet(filters: KpiFilters, records: KpiProductionRecord[]): XLSX.WorkSheet {
  const ws: XLSX.WorkSheet = {};
  const merges: XLSX.Range[] = [];
  const cols = 8;

  const totalProduced = records.reduce((s, r) => s + (r.producedThisSlot ?? 0), 0);
  const totalRejected = records.reduce((s, r) => s + (r.rejections ?? 0), 0);
  // Exact formula from KPIAnalysisScreen: rejections / (produced + rejections) × 100
  const rejPct = totalProduced + totalRejected > 0
    ? round1((totalRejected / (totalProduced + totalRejected)) * 100) : 0;

  let r = writeSheetHeader(ws, merges, cols, '03 — REJECTION %', filters);

  r = writeKpiCards(ws, merges, r, [
    { label: 'Rejection %', value: `${rejPct}%`, color: C.red },
    { label: 'Total Rejected', value: totalRejected, color: C.orange },
    { label: 'Good Parts', value: totalProduced, color: C.green },
  ], cols);

  // BY DATE
  const byDateMap = new Map<string, { produced: number; rejections: number }>();
  records.forEach((rec) => {
    const key = rec.productionDate ?? dateKeyFromMs(rec.createdAtMs);
    const ex = byDateMap.get(key);
    if (ex) { ex.produced += rec.producedThisSlot ?? 0; ex.rejections += rec.rejections ?? 0; }
    else byDateMap.set(key, { produced: rec.producedThisSlot ?? 0, rejections: rec.rejections ?? 0 });
  });
  const byDateRows: (string | number)[][] = Array.from(byDateMap.entries())
    .filter(([d]) => d !== 'unknown')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, v]) => {
      const pct = v.produced + v.rejections > 0 ? round1((v.rejections / (v.produced + v.rejections)) * 100) : 0;
      return [date, v.produced, v.rejections, pct];
    });
  r = writeTable(ws, merges, r, 'BY DATE', ['Date', 'Produced', 'Rejected', 'Rejection %'],
    byDateRows, cols, [{ col: 1, fmt: '#,##0' }, { col: 2, fmt: '#,##0' }, { col: 3, fmt: '0.0"%"' }]);

  // BY LINE
  const byLineMap = new Map<string, { produced: number; rejections: number }>();
  records.forEach((rec) => {
    const key = rec.lineName ?? 'Unknown';
    const ex = byLineMap.get(key);
    if (ex) { ex.produced += rec.producedThisSlot ?? 0; ex.rejections += rec.rejections ?? 0; }
    else byLineMap.set(key, { produced: rec.producedThisSlot ?? 0, rejections: rec.rejections ?? 0 });
  });
  const byLineRows: (string | number)[][] = Array.from(byLineMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([line, v]) => {
      const pct = v.produced + v.rejections > 0 ? round1((v.rejections / (v.produced + v.rejections)) * 100) : 0;
      return [line, v.produced, v.rejections, pct];
    });
  r = writeTable(ws, merges, r, 'BY LINE', ['Line', 'Produced', 'Rejected', 'Rejection %'],
    byLineRows, cols, [{ col: 1, fmt: '#,##0' }, { col: 2, fmt: '#,##0' }, { col: 3, fmt: '0.0"%"' }]);

  // BY PART
  const byPartMap = new Map<string, { produced: number; rejections: number }>();
  records.forEach((rec) => {
    const key = rec.partName ?? 'Unspecified';
    const ex = byPartMap.get(key);
    if (ex) { ex.produced += rec.producedThisSlot ?? 0; ex.rejections += rec.rejections ?? 0; }
    else byPartMap.set(key, { produced: rec.producedThisSlot ?? 0, rejections: rec.rejections ?? 0 });
  });
  const byPartRows: (string | number)[][] = Array.from(byPartMap.entries())
    .sort(([, a], [, b]) => b.rejections - a.rejections)
    .map(([part, v]) => {
      const pct = v.produced + v.rejections > 0 ? round1((v.rejections / (v.produced + v.rejections)) * 100) : 0;
      return [part, v.produced, v.rejections, pct];
    });
  r = writeTable(ws, merges, r, 'BY PART', ['Part', 'Produced', 'Rejected', 'Rejection %'],
    byPartRows, cols, [{ col: 1, fmt: '#,##0' }, { col: 2, fmt: '#,##0' }, { col: 3, fmt: '0.0"%"' }]);

  // DETAILED RECORDS
  const detailRows: (string | number)[][] = records.map((rec) => [
    safe(rec.productionDate), safe(rec.shift), safe(rec.lineName), safe(rec.partName),
    num(rec.producedThisSlot), num(rec.rejections),
    (num(rec.producedThisSlot) + num(rec.rejections)) > 0
      ? round1((num(rec.rejections) / (num(rec.producedThisSlot) + num(rec.rejections))) * 100) : 0,
  ]);
  r = writeTable(ws, merges, r, 'DETAILED RECORDS',
    ['Date', 'Shift', 'Line', 'Part', 'Produced', 'Rejected', 'Rejection %'],
    detailRows, cols,
    [{ col: 4, fmt: '#,##0' }, { col: 5, fmt: '#,##0' }, { col: 6, fmt: '0.0"%"' }]);

  finalizeSheet(ws, merges, r, cols, [12, 8, 16, 16, 12, 12, 14, 14]);
  return ws;
}

// ─── 04_LOSS_DETAILS ─────────────────────────────────────────────────────────

function buildLossSheet(filters: KpiFilters, records: KpiProductionRecord[]): XLSX.WorkSheet {
  const ws: XLSX.WorkSheet = {};
  const merges: XLSX.Range[] = [];
  const cols = 8;

  // Loss pieces: MAX(0, Planned - Actual) per record, summed
  const totalLostPieces = records.reduce((s, r) => {
    return s + Math.max(0, (r.expectedParts ?? 0) - (r.producedThisSlot ?? 0));
  }, 0);
  const totalDowntime = records.reduce((s, r) =>
    s + (r.stopEvents ?? []).reduce((d, se) => d + (se.durationMinutes ?? 0), 0), 0);
  const lossEvents = records.filter((r) =>
    Math.max(0, (r.expectedParts ?? 0) - (r.producedThisSlot ?? 0)) > 0).length;

  let r = writeSheetHeader(ws, merges, cols, '04 — LOSS DETAILS', filters);

  r = writeKpiCards(ws, merges, r, [
    { label: 'Est. Lost Pieces', value: Math.round(totalLostPieces), color: C.red },
    { label: 'Total Downtime (min)', value: Math.round(totalDowntime), color: C.orange },
    { label: 'Loss Events', value: lossEvents, color: C.secondary },
  ], cols);

  // BY DATE
  const byDateMap = new Map<string, { plan: number; actual: number; downtime: number }>();
  records.forEach((rec) => {
    const key = rec.productionDate ?? dateKeyFromMs(rec.createdAtMs);
    const dt = (rec.stopEvents ?? []).reduce((s, se) => s + (se.durationMinutes ?? 0), 0);
    const ex = byDateMap.get(key);
    if (ex) { ex.plan += rec.expectedParts ?? 0; ex.actual += rec.producedThisSlot ?? 0; ex.downtime += dt; }
    else byDateMap.set(key, { plan: rec.expectedParts ?? 0, actual: rec.producedThisSlot ?? 0, downtime: dt });
  });
  const byDateRows: (string | number)[][] = Array.from(byDateMap.entries())
    .filter(([d]) => d !== 'unknown').sort(([a], [b]) => a.localeCompare(b))
    .map(([date, v]) => [date, v.plan, v.actual, Math.max(0, v.plan - v.actual), Math.round(v.downtime)]);
  r = writeTable(ws, merges, r, 'BY DATE', ['Date', 'Planned', 'Actual', 'Lost Pieces', 'Downtime (min)'],
    byDateRows, cols, [{ col: 1, fmt: '#,##0' }, { col: 2, fmt: '#,##0' }, { col: 3, fmt: '#,##0' }, { col: 4, fmt: '#,##0" min"' }]);

  // BY LINE
  const byLineMap = new Map<string, { plan: number; actual: number; downtime: number }>();
  records.forEach((rec) => {
    const key = rec.lineName ?? 'Unknown';
    const dt = (rec.stopEvents ?? []).reduce((s, se) => s + (se.durationMinutes ?? 0), 0);
    const ex = byLineMap.get(key);
    if (ex) { ex.plan += rec.expectedParts ?? 0; ex.actual += rec.producedThisSlot ?? 0; ex.downtime += dt; }
    else byLineMap.set(key, { plan: rec.expectedParts ?? 0, actual: rec.producedThisSlot ?? 0, downtime: dt });
  });
  const byLineRows: (string | number)[][] = Array.from(byLineMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([line, v]) => [line, v.plan, v.actual, Math.max(0, v.plan - v.actual), Math.round(v.downtime)]);
  r = writeTable(ws, merges, r, 'BY LINE', ['Line', 'Planned', 'Actual', 'Lost Pieces', 'Downtime (min)'],
    byLineRows, cols, [{ col: 1, fmt: '#,##0' }, { col: 2, fmt: '#,##0' }, { col: 3, fmt: '#,##0' }, { col: 4, fmt: '#,##0" min"' }]);

  // BY LOSS REASON
  const byReasonMap = new Map<string, number>();
  records.forEach((rec) => {
    const loss = Math.max(0, (rec.expectedParts ?? 0) - (rec.producedThisSlot ?? 0));
    if (loss <= 0) return;
    const reason = rec.lossReasonLabel || deriveReasonFromStops(rec.stopEvents) || 'Unspecified';
    byReasonMap.set(reason, (byReasonMap.get(reason) ?? 0) + loss);
  });
  const byReasonRows: (string | number)[][] = Array.from(byReasonMap.entries())
    .sort(([, a], [, b]) => b - a).map(([reason, parts]) => [reason, Math.round(parts)]);
  r = writeTable(ws, merges, r, 'BY LOSS REASON', ['Loss Reason', 'Lost Pieces'],
    byReasonRows, cols, [{ col: 1, fmt: '#,##0' }]);

  // DETAILED RECORDS
  const detailRows: (string | number)[][] = records.map((rec) => {
    const loss = Math.max(0, (rec.expectedParts ?? 0) - (rec.producedThisSlot ?? 0));
    const dt = (rec.stopEvents ?? []).reduce((s, se) => s + (se.durationMinutes ?? 0), 0);
    const reason = rec.lossReasonLabel || deriveReasonFromStops(rec.stopEvents) || '—';
    return [
      safe(rec.productionDate), safe(rec.shift), safe(rec.lineName),
      num(rec.expectedParts), num(rec.producedThisSlot), Math.round(loss), Math.round(dt), safe(reason),
    ];
  });
  r = writeTable(ws, merges, r, 'DETAILED RECORDS',
    ['Date', 'Shift', 'Line', 'Planned', 'Actual', 'Lost Pieces', 'Downtime (min)', 'Loss Reason'],
    detailRows, cols,
    [{ col: 3, fmt: '#,##0' }, { col: 4, fmt: '#,##0' }, { col: 5, fmt: '#,##0' }, { col: 6, fmt: '#,##0" min"' }]);

  finalizeSheet(ws, merges, r, cols, [12, 8, 16, 12, 12, 14, 14, 22]);
  return ws;
}

// ─── 05_NEAR_MISS ─────────────────────────────────────────────────────────────

const NEAR_MISS_INTENSITY_COLOR: Record<string, string> = {
  Low: C.green, Medium: C.accent, High: C.orange, Critical: C.red,
};
const NEAR_MISS_STATUS_COLOR: Record<string, string> = {
  Open: C.red, 'In Progress': C.accent, Closed: C.green, Pending: C.secondary,
};

function buildNearMissSheet(filters: KpiFilters, records: KpiNearMissRecord[]): XLSX.WorkSheet {
  const ws: XLSX.WorkSheet = {};
  const merges: XLSX.Range[] = [];
  const cols = 9;

  const open = records.filter((r) => r.status === 'Open').length;
  const closed = records.filter((r) => r.status === 'Closed').length;

  let r = writeSheetHeader(ws, merges, cols, '05 — NEAR MISS', filters);

  r = writeKpiCards(ws, merges, r, [
    { label: 'Total Reports', value: records.length, color: C.accent },
    { label: 'Open', value: open, color: C.red },
    { label: 'Closed', value: closed, color: C.green },
    { label: 'Low', value: records.filter((x) => x.intensity === 'Low').length, color: C.green },
    { label: 'Medium', value: records.filter((x) => x.intensity === 'Medium').length, color: C.accent },
    { label: 'High', value: records.filter((x) => x.intensity === 'High').length, color: C.orange },
    { label: 'Critical', value: records.filter((x) => x.intensity === 'Critical').length, color: C.red },
  ], cols);

  // BY INTENSITY
  const intensityRows: (string | number)[][] = (['Low', 'Medium', 'High', 'Critical'] as const)
    .map((lvl) => [lvl, records.filter((x) => x.intensity === lvl).length]);
  r = writeTable(ws, merges, r, 'BY INTENSITY', ['Intensity', 'Count'], intensityRows, cols,
    [{ col: 1, fmt: '#,##0' }],
    [{ col: 0, colorMap: NEAR_MISS_INTENSITY_COLOR }]);

  // BY STATUS
  const statusRows: (string | number)[][] = (['Open', 'In Progress', 'Closed', 'Pending'] as const)
    .map((st) => [st, records.filter((x) => x.status === st).length]);
  r = writeTable(ws, merges, r, 'BY STATUS', ['Status', 'Count'], statusRows, cols,
    [{ col: 1, fmt: '#,##0' }],
    [{ col: 0, colorMap: NEAR_MISS_STATUS_COLOR }]);

  // MONTHLY TREND
  const byMonthMap = new Map<string, number>();
  records.forEach((rec) => {
    const ym = (rec.date && rec.date.length >= 7 ? rec.date.slice(0, 7) : null) ?? dateKeyFromMs(rec.createdAtMs).slice(0, 7);
    if (ym !== 'unknown') byMonthMap.set(ym, (byMonthMap.get(ym) ?? 0) + 1);
  });
  const monthRows: (string | number)[][] = Array.from(byMonthMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([ym, count]) => [monthLabelFromKey(ym), count]);
  r = writeTable(ws, merges, r, 'MONTHLY TREND', ['Month', 'Reports'], monthRows, cols,
    [{ col: 1, fmt: '#,##0' }]);

  // DETAILED RECORDS
  const detailRows: (string | number)[][] = records.map((rec) => [
    safe(rec.date), safe(rec.areaMachine), safe(rec.intensity), safe(rec.status),
    safe(rec.description), safe(rec.actionTaken), safe(rec.responsibility), safe(rec.tdc), safe(rec.submittedBy),
  ]);
  r = writeTable(ws, merges, r, 'DETAILED RECORDS',
    ['Date', 'Area/Machine', 'Intensity', 'Status', 'Description', 'Action Taken', 'Responsibility', 'TDC', 'Submitted By'],
    detailRows, cols, [],
    [{ col: 2, colorMap: NEAR_MISS_INTENSITY_COLOR }, { col: 3, colorMap: NEAR_MISS_STATUS_COLOR }]);

  finalizeSheet(ws, merges, r, cols, [12, 18, 10, 12, 30, 28, 18, 12, 16]);
  return ws;
}

// ─── 06_MAN_DAYS ──────────────────────────────────────────────────────────────

function buildManDaysSheet(filters: KpiFilters, records: KpiManDayRecord[]): XLSX.WorkSheet {
  const ws: XLSX.WorkSheet = {};
  const merges: XLSX.Range[] = [];
  const cols = 8;

  const totalPresent = records.reduce((s, r) => s + r.present, 0);
  const totalAbsent = records.reduce((s, r) => s + r.absent, 0);
  const totalLeave = records.reduce((s, r) => s + r.onLeave, 0);
  const totalManDays = records.reduce((s, r) => s + r.totalPresent, 0);

  let r = writeSheetHeader(ws, merges, cols, '06 — MAN-DAYS TRACKER', filters);

  r = writeKpiCards(ws, merges, r, [
    { label: 'Total Man-Days', value: totalManDays, color: C.blue },
    { label: 'Total Present', value: totalPresent, color: C.green },
    { label: 'Total Absent', value: totalAbsent, color: C.red },
    { label: 'Total On Leave', value: totalLeave, color: C.accent },
    { label: 'Entries', value: records.length, color: C.secondary },
  ], cols);

  // BY DIVISION
  const byDivMap = new Map<string, { present: number; absent: number; leave: number; total: number; days: number }>();
  records.forEach((rec) => {
    const key = rec.division || 'Unknown';
    const ex = byDivMap.get(key);
    if (ex) { ex.present += rec.present; ex.absent += rec.absent; ex.leave += rec.onLeave; ex.total += rec.totalPresent; ex.days += 1; }
    else byDivMap.set(key, { present: rec.present, absent: rec.absent, leave: rec.onLeave, total: rec.totalPresent, days: 1 });
  });
  const byDivRows: (string | number)[][] = Array.from(byDivMap.entries())
    .map(([div, v]) => [div, v.total, v.present, v.absent, v.leave, v.days]);
  r = writeTable(ws, merges, r, 'BY DIVISION',
    ['Division', 'Total Man-Days', 'Present', 'Absent', 'On Leave', 'Days Recorded'],
    byDivRows, cols,
    [{ col: 1, fmt: '#,##0' }, { col: 2, fmt: '#,##0' }, { col: 3, fmt: '#,##0' }, { col: 4, fmt: '#,##0' }]);

  // BY MONTH
  const byMonthMap = new Map<string, { present: number; absent: number; leave: number; total: number }>();
  records.forEach((rec) => {
    const ym = rec.dateISO?.slice(0, 7) ?? 'unknown';
    if (ym === 'unknown') return;
    const ex = byMonthMap.get(ym);
    if (ex) { ex.present += rec.present; ex.absent += rec.absent; ex.leave += rec.onLeave; ex.total += rec.totalPresent; }
    else byMonthMap.set(ym, { present: rec.present, absent: rec.absent, leave: rec.onLeave, total: rec.totalPresent });
  });
  const byMonthRows: (string | number)[][] = Array.from(byMonthMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([ym, v]) => [monthLabelFromKey(ym), v.total, v.present, v.absent, v.leave]);
  r = writeTable(ws, merges, r, 'MONTHLY BREAKDOWN',
    ['Month', 'Total Man-Days', 'Present', 'Absent', 'On Leave'],
    byMonthRows, cols,
    [{ col: 1, fmt: '#,##0' }, { col: 2, fmt: '#,##0' }, { col: 3, fmt: '#,##0' }, { col: 4, fmt: '#,##0' }]);

  // DETAILED RECORDS
  const detailRows: (string | number)[][] = records.map((rec) => [
    safe(rec.dateISO), safe(rec.dayOfWeek), safe(rec.division), rec.totalPresent, rec.present, rec.absent, rec.onLeave, safe(rec.submittedBy),
  ]);
  r = writeTable(ws, merges, r, 'DETAILED RECORDS',
    ['Date', 'Day', 'Division', 'Total Present', 'Present', 'Absent', 'On Leave', 'Submitted By'],
    detailRows, cols,
    [{ col: 3, fmt: '#,##0' }, { col: 4, fmt: '#,##0' }, { col: 5, fmt: '#,##0' }, { col: 6, fmt: '#,##0' }]);

  finalizeSheet(ws, merges, r, cols, [12, 10, 16, 14, 12, 12, 12, 18]);
  return ws;
}

// ─── 07_POKA_YOKE ─────────────────────────────────────────────────────────────

const POKA_YOKE_STATUS_COLOR: Record<string, string> = {
  Open: C.red, 'In Progress': C.accent, Closed: C.green,
};

function buildPokaYokeSheet(filters: KpiFilters, records: KpiPokaYokeRecord[]): XLSX.WorkSheet {
  const ws: XLSX.WorkSheet = {};
  const merges: XLSX.Range[] = [];
  const cols = 9;

  const open = records.filter((r) => r.status === 'Open').length;
  const inProgress = records.filter((r) => r.status === 'In Progress').length;
  const closed = records.filter((r) => r.status === 'Closed').length;

  let r = writeSheetHeader(ws, merges, cols, '07 — POKA YOKE TRACKER', filters);

  r = writeKpiCards(ws, merges, r, [
    { label: 'Total Records', value: records.length, color: C.green },
    { label: 'Open', value: open, color: C.red },
    { label: 'In Progress', value: inProgress, color: C.accent },
    { label: 'Closed', value: closed, color: C.green },
  ], cols);

  // BY STATUS
  const statusRows: (string | number)[][] = (['Open', 'In Progress', 'Closed'] as const)
    .map((st) => [st, records.filter((x) => x.status === st).length]);
  r = writeTable(ws, merges, r, 'BY STATUS', ['Status', 'Count'], statusRows, cols,
    [{ col: 1, fmt: '#,##0' }],
    [{ col: 0, colorMap: POKA_YOKE_STATUS_COLOR }]);

  // BY LINE
  const byLineMap = new Map<string, number>();
  records.forEach((rec) => byLineMap.set(rec.lineName || 'Unknown', (byLineMap.get(rec.lineName || 'Unknown') ?? 0) + 1));
  const byLineRows: (string | number)[][] = Array.from(byLineMap.entries())
    .sort(([, a], [, b]) => b - a).map(([line, count]) => [line, count]);
  r = writeTable(ws, merges, r, 'BY LINE', ['Line', 'Count'], byLineRows, cols, [{ col: 1, fmt: '#,##0' }]);

  // DETAILED RECORDS
  const detailRows: (string | number)[][] = records.map((rec) => [
    safe(rec.sNo != null ? String(rec.sNo) : null), safe(rec.lineName), safe(rec.partsName), safe(rec.model),
    safe(rec.pokaYokeNo), safe(rec.pokaYokeDetails), safe(rec.problem), safe(rec.actionPlan),
    safe(rec.status), safe(rec.targetDate), safe(rec.responsibility), safe(rec.submittedBy),
  ]);
  r = writeTable(ws, merges, r, 'DETAILED RECORDS',
    ['S.No', 'Line', 'Parts Name', 'Model', 'Poka Yoke No', 'Poka Yoke Details', 'Problem', 'Action Plan', 'Status', 'Target Date', 'Responsibility', 'Submitted By'],
    detailRows, cols, [],
    [{ col: 8, colorMap: POKA_YOKE_STATUS_COLOR }]);

  finalizeSheet(ws, merges, r, cols, [6, 14, 14, 10, 12, 24, 24, 24, 12, 12, 16, 16]);
  return ws;
}

// ─── 08_REWORK_PERCENT ────────────────────────────────────────────────────────

function buildReworkSheet(filters: KpiFilters, records: KpiReworkRecord[]): XLSX.WorkSheet {
  const ws: XLSX.WorkSheet = {};
  const merges: XLSX.Range[] = [];
  const cols = 8;

  const totalProduction = records.reduce((s, r) => s + r.totalProduction, 0);
  const totalRework = records.reduce((s, r) => s + r.reworkCount, 0);
  // Rework % = Rework Count / Total Production × 100
  const reworkPct = totalProduction > 0 ? round1((totalRework / totalProduction) * 100) : 0;
  const reworkColor = reworkPct < 2 ? C.green : reworkPct < 5 ? C.accent : C.red;

  let r = writeSheetHeader(ws, merges, cols, '08 — REWORK %', filters);

  r = writeKpiCards(ws, merges, r, [
    { label: 'Total Production', value: totalProduction, color: C.green },
    { label: 'Total Rework', value: totalRework, color: C.orange },
    { label: 'Rework %', value: `${reworkPct}%`, color: reworkColor },
  ], cols);

  // BY DATE
  const byDateMap = new Map<string, { prod: number; rework: number }>();
  records.forEach((rec) => {
    const key = rec.date || dateKeyFromMs(rec.createdAtMs);
    const ex = byDateMap.get(key);
    if (ex) { ex.prod += rec.totalProduction; ex.rework += rec.reworkCount; }
    else byDateMap.set(key, { prod: rec.totalProduction, rework: rec.reworkCount });
  });
  const byDateRows: (string | number)[][] = Array.from(byDateMap.entries())
    .filter(([d]) => d !== 'unknown').sort(([a], [b]) => a.localeCompare(b))
    .map(([date, v]) => {
      const pct = v.prod > 0 ? round1((v.rework / v.prod) * 100) : 0;
      return [date, v.prod, v.rework, pct];
    });
  r = writeTable(ws, merges, r, 'BY DATE', ['Date', 'Production', 'Rework', 'Rework %'],
    byDateRows, cols, [{ col: 1, fmt: '#,##0' }, { col: 2, fmt: '#,##0' }, { col: 3, fmt: '0.0"%"' }]);

  // BY LINE
  const byLineMap = new Map<string, { prod: number; rework: number }>();
  records.forEach((rec) => {
    const key = rec.lineName || 'Unknown';
    const ex = byLineMap.get(key);
    if (ex) { ex.prod += rec.totalProduction; ex.rework += rec.reworkCount; }
    else byLineMap.set(key, { prod: rec.totalProduction, rework: rec.reworkCount });
  });
  const byLineRows: (string | number)[][] = Array.from(byLineMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([line, v]) => {
      const pct = v.prod > 0 ? round1((v.rework / v.prod) * 100) : 0;
      return [line, v.prod, v.rework, pct];
    });
  r = writeTable(ws, merges, r, 'BY LINE', ['Line', 'Production', 'Rework', 'Rework %'],
    byLineRows, cols, [{ col: 1, fmt: '#,##0' }, { col: 2, fmt: '#,##0' }, { col: 3, fmt: '0.0"%"' }]);

  // DETAILED RECORDS
  const detailRows: (string | number)[][] = records.map((rec) => [
    safe(rec.date), safe(rec.shift), safe(rec.lineName),
    rec.totalProduction, rec.reworkCount, rec.reworkPct, safe(rec.submittedBy),
  ]);
  r = writeTable(ws, merges, r, 'DETAILED RECORDS',
    ['Date', 'Shift', 'Line', 'Production', 'Rework Count', 'Rework %', 'Submitted By'],
    detailRows, cols,
    [{ col: 3, fmt: '#,##0' }, { col: 4, fmt: '#,##0' }, { col: 5, fmt: '0.0"%"' }]);

  finalizeSheet(ws, merges, r, cols, [12, 8, 16, 14, 14, 12, 18, 14]);
  return ws;
}

// ─── 09_KAIZEN ────────────────────────────────────────────────────────────────

const KAIZEN_STATUS_COLOR: Record<string, string> = {
  Open: C.red, 'In Progress': C.accent, Implemented: C.green, Closed: C.secondary, Rejected: C.muted,
};

function buildKaizenSheet(filters: KpiFilters, records: KpiKaizenRecord[]): XLSX.WorkSheet {
  const ws: XLSX.WorkSheet = {};
  const merges: XLSX.Range[] = [];
  const cols = 9;

  const countByStatus = (st: string) => records.filter((r) => r.status === st).length;

  let r = writeSheetHeader(ws, merges, cols, '09 — KAIZEN TRACKER', filters);

  r = writeKpiCards(ws, merges, r, [
    { label: 'Total Kaizen', value: records.length, color: C.green },
    { label: 'Open', value: countByStatus('Open'), color: C.red },
    { label: 'In Progress', value: countByStatus('In Progress'), color: C.accent },
    { label: 'Implemented', value: countByStatus('Implemented'), color: C.green },
    { label: 'Closed', value: countByStatus('Closed'), color: C.secondary },
    { label: 'Rejected', value: countByStatus('Rejected'), color: C.muted },
  ], cols);

  // BY STATUS
  const statusRows: (string | number)[][] = (['Open', 'In Progress', 'Implemented', 'Closed', 'Rejected'] as const)
    .map((st) => [st, countByStatus(st)]);
  r = writeTable(ws, merges, r, 'BY STATUS', ['Status', 'Count'], statusRows, cols,
    [{ col: 1, fmt: '#,##0' }],
    [{ col: 0, colorMap: KAIZEN_STATUS_COLOR }]);

  // BY DATE
  const byDateMap = new Map<string, number>();
  records.forEach((rec) => {
    const key = rec.date || dateKeyFromMs(rec.createdAtMs);
    byDateMap.set(key, (byDateMap.get(key) ?? 0) + 1);
  });
  const byDateRows: (string | number)[][] = Array.from(byDateMap.entries())
    .filter(([d]) => d !== 'unknown').sort(([a], [b]) => a.localeCompare(b))
    .map(([date, count]) => [date, count]);
  r = writeTable(ws, merges, r, 'BY DATE', ['Date', 'Count'], byDateRows, cols, [{ col: 1, fmt: '#,##0' }]);

  // DETAILED RECORDS
  const detailRows: (string | number)[][] = records.map((rec) => [
    safe(rec.date), safe(rec.employeeName), safe(rec.category), safe(rec.priority),
    safe(rec.kaizenIdea), safe(rec.actionTaken), safe(rec.status), safe(rec.result),
    safe(rec.targetDate), safe(rec.responsibility), safe(rec.submittedBy),
  ]);
  r = writeTable(ws, merges, r, 'DETAILED RECORDS',
    ['Date', 'Employee', 'Category', 'Priority', 'Idea', 'Action Taken', 'Status', 'Result', 'Target Date', 'Responsibility', 'Submitted By'],
    detailRows, cols, [],
    [{ col: 6, colorMap: KAIZEN_STATUS_COLOR }]);

  finalizeSheet(ws, merges, r, cols, [12, 16, 12, 10, 28, 28, 12, 20, 12, 16, 16]);
  return ws;
}

// ─── 10_ATTENDANCE ────────────────────────────────────────────────────────────

const ATTENDANCE_STATUS_COLOR: Record<string, string> = {
  present: C.green, absent: C.red, leave: C.accent,
};

function buildAttendanceSheet(filters: KpiFilters, records: KpiAttendanceRecord[]): XLSX.WorkSheet {
  const ws: XLSX.WorkSheet = {};
  const merges: XLSX.Range[] = [];
  const cols = 9;

  const totalOps = records.length;
  const present = records.filter((r) => r.status === 'present').length;
  const absent = records.filter((r) => r.status === 'absent').length;
  const leave = records.filter((r) => r.status === 'leave').length;
  const attPct = totalOps > 0 ? round1((present / totalOps) * 100) : 0;
  const attColor = attPct >= 95 ? C.green : attPct >= 85 ? C.accent : C.red;

  let r = writeSheetHeader(ws, merges, cols, '10 — ATTENDANCE SHEET', filters);

  r = writeKpiCards(ws, merges, r, [
    { label: 'Total Operators', value: totalOps, color: C.blue },
    { label: 'Present', value: present, color: C.green },
    { label: 'Absent', value: absent, color: C.red },
    { label: 'Leave', value: leave, color: C.accent },
    { label: 'Attendance %', value: `${attPct}%`, color: attColor },
  ], cols);

  // BY DATE
  const byDateMap = new Map<string, { present: number; absent: number; leave: number }>();
  records.forEach((rec) => {
    const key = rec.date || dateKeyFromMs(rec.createdAtMs);
    const ex = byDateMap.get(key);
    if (ex) {
      if (rec.status === 'present') ex.present++;
      else if (rec.status === 'absent') ex.absent++;
      else ex.leave++;
    } else {
      byDateMap.set(key, {
        present: rec.status === 'present' ? 1 : 0,
        absent: rec.status === 'absent' ? 1 : 0,
        leave: rec.status === 'leave' ? 1 : 0,
      });
    }
  });
  const byDateRows: (string | number)[][] = Array.from(byDateMap.entries())
    .filter(([d]) => d !== 'unknown').sort(([a], [b]) => a.localeCompare(b))
    .map(([date, v]) => {
      const total = v.present + v.absent + v.leave;
      const pct = total > 0 ? round1((v.present / total) * 100) : 0;
      return [date, v.present, v.absent, v.leave, pct];
    });
  r = writeTable(ws, merges, r, 'BY DATE', ['Date', 'Present', 'Absent', 'Leave', 'Attendance %'],
    byDateRows, cols,
    [{ col: 1, fmt: '#,##0' }, { col: 2, fmt: '#,##0' }, { col: 3, fmt: '#,##0' }, { col: 4, fmt: '0.0"%"' }]);

  // BY DIVISION
  const byDivMap = new Map<string, { present: number; absent: number; leave: number }>();
  records.forEach((rec) => {
    const key = rec.division || 'Unknown';
    const ex = byDivMap.get(key);
    if (ex) {
      if (rec.status === 'present') ex.present++;
      else if (rec.status === 'absent') ex.absent++;
      else ex.leave++;
    } else {
      byDivMap.set(key, {
        present: rec.status === 'present' ? 1 : 0,
        absent: rec.status === 'absent' ? 1 : 0,
        leave: rec.status === 'leave' ? 1 : 0,
      });
    }
  });
  const byDivRows: (string | number)[][] = Array.from(byDivMap.entries())
    .map(([div, v]) => {
      const total = v.present + v.absent + v.leave;
      const pct = total > 0 ? round1((v.present / total) * 100) : 0;
      return [div, v.present, v.absent, v.leave, pct];
    });
  r = writeTable(ws, merges, r, 'BY DIVISION / LINE', ['Division', 'Present', 'Absent', 'Leave', 'Attendance %'],
    byDivRows, cols,
    [{ col: 1, fmt: '#,##0' }, { col: 2, fmt: '#,##0' }, { col: 3, fmt: '#,##0' }, { col: 4, fmt: '0.0"%"' }]);

  // DETAILED RECORDS
  const detailRows: (string | number)[][] = records.map((rec) => [
    safe(rec.date), safe(rec.operatorId), safe(rec.operatorName), safe(rec.operatorCode),
    safe(rec.plant), safe(rec.workshop), safe(rec.division), safe(rec.shift),
    rec.status, safe(rec.submittedBy),
  ]);
  r = writeTable(ws, merges, r, 'DETAILED RECORDS',
    ['Date', 'Operator ID', 'Operator Name', 'Operator Code', 'Plant', 'Workshop', 'Division', 'Shift', 'Status', 'Submitted By'],
    detailRows, cols, [],
    [{ col: 8, colorMap: ATTENDANCE_STATUS_COLOR }]);

  finalizeSheet(ws, merges, r, cols, [12, 12, 20, 14, 10, 14, 14, 8, 10, 16]);
  return ws;
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function exportKpiAnalysisToExcel(params: KpiAnalysisExportParams): Promise<void> {
  const {
    filters,
    pcsPerHourDays,
    planVsActualRecords,
    productionRecords,
    nearMissRecords,
    manDaysRecords,
    pokaYokeRecords,
    reworkRecords,
    kaizenRecords,
    attendanceRecords,
  } = params;

  // Compute summary values for the Dashboard KPI cards
  const totalPcsProd = pcsPerHourDays.reduce((s, d) => s + d.actual, 0);
  const totalManHr = pcsPerHourDays.reduce((s, d) => s + d.manHour, 0);
  const pcsManHr = totalManHr > 0 ? round1(totalPcsProd / totalManHr) : 0;

  const pvaTotalPlan = planVsActualRecords.reduce((s, r) => s + r.planned, 0);
  const pvaTotalAct = planVsActualRecords.reduce((s, r) => s + r.actual, 0);
  const pvaAch = pvaTotalPlan > 0 ? round1((pvaTotalAct / pvaTotalPlan) * 100) : 0;

  const totalProd = productionRecords.reduce((s, r) => s + (r.producedThisSlot ?? 0), 0);
  const totalRej = productionRecords.reduce((s, r) => s + (r.rejections ?? 0), 0);
  const rejPct = totalProd + totalRej > 0 ? round1((totalRej / (totalProd + totalRej)) * 100) : 0;

  const totalLost = productionRecords.reduce((s, r) => s + Math.max(0, (r.expectedParts ?? 0) - (r.producedThisSlot ?? 0)), 0);

  const nmOpen = nearMissRecords.filter((r) => r.status === 'Open').length;

  const mdTotal = manDaysRecords.reduce((s, r) => s + r.totalPresent, 0);

  const pyOpen = pokaYokeRecords.filter((r) => r.status === 'Open').length;

  const rwTotalProd = reworkRecords.reduce((s, r) => s + r.totalProduction, 0);
  const rwTotal = reworkRecords.reduce((s, r) => s + r.reworkCount, 0);
  const rwPct = rwTotalProd > 0 ? round1((rwTotal / rwTotalProd) * 100) : 0;

  const kzTotal = kaizenRecords.length;

  const attTotal = attendanceRecords.length;
  const attPresent = attendanceRecords.filter((r) => r.status === 'present').length;
  const attPct = attTotal > 0 ? round1((attPresent / attTotal) * 100) : 0;

  const kpiSummaries = [
    {
      label: 'PCS Man Per Hour',
      value: pcsPerHourDays.length > 0 ? `${pcsManHr} pcs/hr` : 'No data',
      color: pcsPerHourDays.length === 0 ? C.secondary : C.blue,
      status: pcsPerHourDays.length > 0 ? 'Recorded' : 'No Data',
      sheet: '01_PCS_MAN_HOUR',
    },
    {
      label: 'Plan vs Actual',
      value: planVsActualRecords.length > 0 ? `${pvaAch}%` : 'No data',
      color: planVsActualRecords.length === 0 ? C.secondary : pvaAch >= 95 ? C.green : pvaAch >= 85 ? C.yellow : pvaAch >= 70 ? C.orange : C.red,
      status: planVsActualRecords.length === 0 ? 'No Data' : pvaAch >= 95 ? 'On Target' : pvaAch >= 85 ? 'Near Target' : 'Below Target',
      sheet: '02_PLAN_VS_ACTUAL',
    },
    {
      label: 'Rejection %',
      value: productionRecords.length > 0 ? `${rejPct}%` : 'No data',
      color: productionRecords.length === 0 ? C.secondary : rejPct <= 1 ? C.green : rejPct <= 3 ? C.yellow : C.red,
      status: productionRecords.length === 0 ? 'No Data' : rejPct <= 1 ? 'Good' : rejPct <= 3 ? 'Watch' : 'High',
      sheet: '03_REJECTION_PERCENT',
    },
    {
      label: 'Loss Details',
      value: productionRecords.length > 0 ? `${Math.round(totalLost)} pcs` : 'No data',
      color: productionRecords.length === 0 ? C.secondary : totalLost === 0 ? C.green : C.orange,
      status: productionRecords.length === 0 ? 'No Data' : totalLost === 0 ? 'None' : 'Recorded',
      sheet: '04_LOSS_DETAILS',
    },
    {
      label: 'Near Miss',
      value: nearMissRecords.length > 0 ? `${nmOpen} open` : 'No data',
      color: nearMissRecords.length === 0 ? C.secondary : nmOpen === 0 ? C.green : C.red,
      status: nearMissRecords.length === 0 ? 'No Data' : nmOpen === 0 ? 'Clear' : `${nmOpen} Open`,
      sheet: '05_NEAR_MISS',
    },
    {
      label: 'Man-Days',
      value: manDaysRecords.length > 0 ? `${mdTotal} days` : 'No data',
      color: manDaysRecords.length === 0 ? C.secondary : C.blue,
      status: manDaysRecords.length > 0 ? 'Recorded' : 'No Data',
      sheet: '06_MAN_DAYS',
    },
    {
      label: 'Poka Yoke',
      value: pokaYokeRecords.length > 0 ? `${pyOpen} open` : 'No data',
      color: pokaYokeRecords.length === 0 ? C.secondary : pyOpen === 0 ? C.green : C.red,
      status: pokaYokeRecords.length === 0 ? 'No Data' : pyOpen === 0 ? 'Clear' : `${pyOpen} Open`,
      sheet: '07_POKA_YOKE',
    },
    {
      label: 'Rework %',
      value: reworkRecords.length > 0 ? `${rwPct}%` : 'No data',
      color: reworkRecords.length === 0 ? C.secondary : rwPct <= 2 ? C.green : rwPct <= 5 ? C.yellow : C.red,
      status: reworkRecords.length === 0 ? 'No Data' : rwPct <= 2 ? 'Good' : rwPct <= 5 ? 'Watch' : 'High',
      sheet: '08_REWORK_PERCENT',
    },
    {
      label: 'Kaizen',
      value: kaizenRecords.length > 0 ? `${kzTotal} total` : 'No data',
      color: kaizenRecords.length === 0 ? C.secondary : C.blue,
      status: kaizenRecords.length > 0 ? 'Recorded' : 'No Data',
      sheet: '09_KAIZEN',
    },
    {
      label: 'Attendance',
      value: attendanceRecords.length > 0 ? `${attPct}%` : 'No data',
      color: attendanceRecords.length === 0 ? C.secondary : attPct >= 95 ? C.green : attPct >= 85 ? C.yellow : C.red,
      status: attendanceRecords.length === 0 ? 'No Data' : attPct >= 95 ? 'Good' : attPct >= 85 ? 'Watch' : 'Low',
      sheet: '10_ATTENDANCE',
    },
  ];

  const wb = XLSX.utils.book_new();

  XLSX.utils.book_append_sheet(wb, buildDashboard(filters, kpiSummaries), '00_DASHBOARD');
  XLSX.utils.book_append_sheet(wb, buildPcsManHourSheet(filters, pcsPerHourDays), '01_PCS_MAN_HOUR');
  XLSX.utils.book_append_sheet(wb, buildPlanVsActualSheet(filters, planVsActualRecords), '02_PLAN_VS_ACTUAL');
  XLSX.utils.book_append_sheet(wb, buildRejectionSheet(filters, productionRecords), '03_REJECTION_PERCENT');
  XLSX.utils.book_append_sheet(wb, buildLossSheet(filters, productionRecords), '04_LOSS_DETAILS');
  XLSX.utils.book_append_sheet(wb, buildNearMissSheet(filters, nearMissRecords), '05_NEAR_MISS');
  XLSX.utils.book_append_sheet(wb, buildManDaysSheet(filters, manDaysRecords), '06_MAN_DAYS');
  XLSX.utils.book_append_sheet(wb, buildPokaYokeSheet(filters, pokaYokeRecords), '07_POKA_YOKE');
  XLSX.utils.book_append_sheet(wb, buildReworkSheet(filters, reworkRecords), '08_REWORK_PERCENT');
  XLSX.utils.book_append_sheet(wb, buildKaizenSheet(filters, kaizenRecords), '09_KAIZEN');
  XLSX.utils.book_append_sheet(wb, buildAttendanceSheet(filters, attendanceRecords), '10_ATTENDANCE');

  const fileName = `KPI_ANALYSIS_REPORT_${filters.fromDate}_to_${filters.toDate}.xlsx`;

  if (Platform.OS === 'web') {
    XLSX.writeFile(wb, fileName, { bookType: 'xlsx' });
    return;
  }

  const base64 = XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });
  const fileUri = `${FileSystem.documentDirectory}${fileName}`;
  await FileSystem.writeAsStringAsync(fileUri, base64, { encoding: FileSystem.EncodingType.Base64 });

  const canShare = await Sharing.isAvailableAsync();
  if (!canShare) throw new Error('Sharing is not available on this device.');
  await Sharing.shareAsync(fileUri, {
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    dialogTitle: 'Export KPI Analysis Report',
    UTI: 'com.microsoft.excel.xlsx',
  });
}