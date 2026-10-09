import { Platform } from 'react-native';
import * as XLSX from 'xlsx-js-style';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';

export interface QualityExcelRecord {
  date: string | null;
  shift: string | null;
  plant: string | null;
  workshop: string | null;
  division: string | null;
  lineId: string | null;
  lineName: string | null;
  partName: string | null;
  stage: string | null;
  rejectionQty: number;
  defect: string | null;
  responsibility: string | null;
  remarks: string | null;
  reportedByName: string | null;
  createdAtMs: number | null;
}

export interface QualityExcelParetoRow {
  defect: string;
  rejectionQty: number;
  cumulativePercentage: number;
  rank: number;
}

export interface QualityExcelFilters {
  fromDate: string;
  toDate: string;
  shift: string | null;
  plant: string | null;
  workshop: string | null;
  division: string | null;
  line: string | null;
  part: string | null;
  stage: string | null;
  responsibility: string | null;
}

type CellValue = string | number;
type AnalysisRow = { label: string; rejectionQty: number; recordCount: number };

const COLOR = {
  navy: '1F3B57',
  header: '2F5C8A',
  white: 'FFFFFF',
  label: 'DCE6F1',
  zebra: 'F4F7FB',
  border: 'B7C4D4',
  text: '222222',
  muted: '5B6B7C',
};

const thinBorder = {
  top: { style: 'thin', color: { rgb: COLOR.border } },
  bottom: { style: 'thin', color: { rgb: COLOR.border } },
  left: { style: 'thin', color: { rgb: COLOR.border } },
  right: { style: 'thin', color: { rgb: COLOR.border } },
};

const titleStyle = {
  font: { bold: true, sz: 18, color: { rgb: COLOR.navy } },
  alignment: { horizontal: 'center', vertical: 'center' },
};
const subtitleStyle = {
  font: { italic: true, sz: 10, color: { rgb: COLOR.muted } },
  alignment: { horizontal: 'center', vertical: 'center' },
};
const headerStyle = {
  font: { bold: true, sz: 10, color: { rgb: COLOR.white } },
  fill: { patternType: 'solid', fgColor: { rgb: COLOR.header } },
  alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
  border: thinBorder,
};

function safe(value: string | null | undefined): string {
  return value?.trim() || '—';
}

function formatCreatedAt(timestamp: number | null): string {
  if (timestamp == null || !Number.isFinite(timestamp)) return '—';
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? '—' : date.toISOString().replace('T', ' ').replace('Z', ' UTC');
}

function summarize(records: QualityExcelRecord[], keyFor: (record: QualityExcelRecord) => string | null): AnalysisRow[] {
  const groups = new Map<string, { rejectionQty: number; recordCount: number }>();
  records.forEach((record) => {
    const label = keyFor(record)?.trim() || 'Unspecified';
    const current = groups.get(label) ?? { rejectionQty: 0, recordCount: 0 };
    current.rejectionQty += record.rejectionQty || 0;
    current.recordCount += 1;
    groups.set(label, current);
  });
  return Array.from(groups, ([label, totals]) => ({ label, ...totals }))
    .sort((a, b) => b.rejectionQty - a.rejectionQty || a.label.localeCompare(b.label));
}

function styleRows(ws: XLSX.WorkSheet, rowStart: number, rowCount: number, columnCount: number) {
  for (let row = rowStart; row < rowStart + rowCount; row += 1) {
    const bodyStyle = {
      font: { sz: 10, color: { rgb: COLOR.text } },
      alignment: { vertical: 'center', wrapText: false },
      border: thinBorder,
      ...(row % 2 === 1 ? { fill: { patternType: 'solid', fgColor: { rgb: COLOR.zebra } } } : {}),
    };
    for (let column = 0; column < columnCount; column += 1) {
      const cell = ws[XLSX.utils.encode_cell({ r: row, c: column })] as any;
      if (cell) cell.s = bodyStyle;
    }
  }
}

function buildTableSheet(
  title: string,
  subtitle: string,
  headers: string[],
  rows: CellValue[][],
  widths: number[],
  numberFormats: Record<number, string> = {},
): XLSX.WorkSheet {
  const headerRow = 3;
  const aoa: CellValue[][] = [
    [title],
    [subtitle],
    [],
    headers,
    ...rows,
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const lastColumn = headers.length - 1;
  ws['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: lastColumn } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: lastColumn } },
  ];
  ws['!cols'] = widths.map((wch) => ({ wch }));
  ws['!rows'] = [{ hpx: 28 }, { hpx: 20 }, { hpx: 8 }, { hpx: 30 }];
  ws['!autofilter'] = {
    ref: XLSX.utils.encode_range({
      s: { r: headerRow, c: 0 },
      e: { r: Math.max(headerRow, headerRow + rows.length), c: lastColumn },
    }),
  };
  ws['!views'] = [{ state: 'frozen', ySplit: headerRow + 1, xSplit: 0, topLeftCell: 'A5', activePane: 'bottomLeft' }];

  const titleCell = ws.A1 as any;
  if (titleCell) titleCell.s = titleStyle;
  const subtitleCell = ws.A2 as any;
  if (subtitleCell) subtitleCell.s = subtitleStyle;
  for (let column = 0; column < headers.length; column += 1) {
    const cell = ws[XLSX.utils.encode_cell({ r: headerRow, c: column })] as any;
    if (cell) cell.s = headerStyle;
  }
  styleRows(ws, headerRow + 1, rows.length, headers.length);
  Object.entries(numberFormats).forEach(([column, format]) => {
    for (let row = headerRow + 1; row <= headerRow + rows.length; row += 1) {
      const cell = ws[XLSX.utils.encode_cell({ r: row, c: Number(column) })] as any;
      if (cell && cell.t === 'n') cell.z = format;
    }
  });
  return ws;
}

function qualityFileName(filters: QualityExcelFilters): string {
  const from = filters.fromDate.replace(/[^0-9-]/g, '');
  const to = filters.toDate.replace(/[^0-9-]/g, '');
  return `Quality_Analysis_${from}_to_${to}.xlsx`;
}

export async function exportQualityToExcel(params: {
  records: QualityExcelRecord[];
  paretoRows: QualityExcelParetoRow[];
  filters: QualityExcelFilters;
}): Promise<void> {
  const { records, paretoRows, filters } = params;
  const totalRejectionQty = records.reduce((total, record) => total + (record.rejectionQty || 0), 0);
  const uniqueDefects = new Set(records.map((record) => record.defect).filter(Boolean)).size;
  const uniqueParts = new Set(records.map((record) => record.partName).filter(Boolean)).size;
  const uniqueLines = new Set(records.map((record) => record.lineId ?? record.lineName).filter(Boolean)).size;

  const summaryRows: CellValue[][] = [
    ['From Date', safe(filters.fromDate)],
    ['To Date', safe(filters.toDate)],
    ['Shift', safe(filters.shift)],
    ['Plant', safe(filters.plant)],
    ['Workshop', safe(filters.workshop)],
    ['Division', safe(filters.division)],
    ['Line', safe(filters.line)],
    ['Part', safe(filters.part)],
    ['Rejection Stage', safe(filters.stage)],
    ['Responsibility', safe(filters.responsibility)],
    ['Total Records', records.length],
    ['Total Rejection Qty', totalRejectionQty],
    ['Unique Defects', uniqueDefects],
    ['Unique Parts', uniqueParts],
    ['Unique Lines', uniqueLines],
  ];
  const detailRows: CellValue[][] = records.map((record) => [
    safe(record.date),
    safe(record.shift),
    safe(record.plant),
    safe(record.workshop),
    safe(record.division),
    safe(record.lineName),
    safe(record.partName),
    safe(record.stage),
    safe(record.defect),
    record.rejectionQty || 0,
    safe(record.responsibility),
    safe(record.remarks),
    safe(record.reportedByName),
    formatCreatedAt(record.createdAtMs),
  ]);
  const defectRows: CellValue[][] = paretoRows.map((row) => [
    row.defect,
    row.rejectionQty,
    totalRejectionQty > 0 ? (row.rejectionQty / totalRejectionQty) * 100 : 0,
    row.cumulativePercentage,
    row.rank,
  ]);
  const lineRows = summarize(records, (record) => record.lineName).map((row) => [row.label, row.rejectionQty, row.recordCount]);
  const partRows = summarize(records, (record) => record.partName).map((row) => [row.label, row.rejectionQty, row.recordCount]);
  const stageRows = summarize(records, (record) => record.stage).map((row) => [row.label, row.rejectionQty, row.recordCount]);
  const responsibilityRows = summarize(records, (record) => record.responsibility)
    .map((row) => [row.label, row.rejectionQty, row.recordCount]);
  const dateRange = `${filters.fromDate || '—'} to ${filters.toDate || '—'}`;

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    buildTableSheet('QUALITY ANALYSIS SUMMARY', dateRange, ['Metric', 'Value'], summaryRows, [26, 34], { 1: '#,##0' }),
    'SUMMARY',
  );
  XLSX.utils.book_append_sheet(
    workbook,
    buildTableSheet(
      'DETAILED REJECTION RECORDS',
      dateRange,
      ['Date', 'Shift', 'Plant', 'Workshop', 'Division', 'Line', 'Part', 'Stage', 'Defect', 'Rejection Qty', 'Responsibility', 'Remarks', 'Reported By', 'Created At'],
      detailRows,
      [14, 10, 16, 18, 16, 18, 22, 14, 22, 15, 18, 40, 24, 26],
      { 9: '#,##0' },
    ),
    'DETAILED RECORDS',
  );
  XLSX.utils.book_append_sheet(
    workbook,
    buildTableSheet(
      'DEFECT ANALYSIS',
      'Top defects and cumulative percentage use the screen Pareto calculation.',
      ['Defect', 'Rejection Qty', 'Percentage of Total', 'Cumulative Percentage', 'Rank'],
      defectRows,
      [28, 16, 22, 24, 10],
      { 1: '#,##0', 2: '0.0"%"', 3: '0.0"%"', 4: '0' },
    ),
    'DEFECT ANALYSIS',
  );
  const analyses: [string, string, CellValue[][]][] = [
    ['LINE ANALYSIS', 'LINE ANALYSIS', lineRows],
    ['PART ANALYSIS', 'PART ANALYSIS', partRows],
    ['STAGE ANALYSIS', 'STAGE ANALYSIS', stageRows],
    ['RESPONSIBILITY ANALYSIS', 'RESPONSIBILITY ANALYSIS', responsibilityRows],
  ];
  analyses.forEach(([title, sheetName, rows]) => {
    XLSX.utils.book_append_sheet(
      workbook,
      buildTableSheet(title, dateRange, [title.replace(' ANALYSIS', ''), 'Rejection Qty', 'Record Count'], rows, [28, 18, 18], { 1: '#,##0', 2: '#,##0' }),
      sheetName,
    );
  });

  const fileName = qualityFileName(filters);
  if (Platform.OS === 'web') {
    XLSX.writeFile(workbook, fileName, { bookType: 'xlsx' });
    return;
  }

  const base64 = XLSX.write(workbook, { type: 'base64', bookType: 'xlsx' });
  const fileUri = `${FileSystem.documentDirectory}${fileName}`;
  await FileSystem.writeAsStringAsync(fileUri, base64, { encoding: FileSystem.EncodingType.Base64 });
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error('Sharing is not available on this device.');
  }
  await Sharing.shareAsync(fileUri, {
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    dialogTitle: 'Export Quality Analysis',
    UTI: 'com.microsoft.excel.xlsx',
  });
}
