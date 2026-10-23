// src/utils/modelPartExcelExport.ts
//
// Excel export for the Model / Part Production page. It only lays out the
// rows utils/modelPartProduction buildExportTables made from the report on
// screen — never queries Firestore, never writes a record. Same library
// (xlsx-js-style, which keeps cell styles) and the same save flow as
// reportExcelExport.ts: a browser download on web, the native share sheet
// on Android/iOS.

import { Platform } from 'react-native';
import * as XLSX from 'xlsx-js-style';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { Cell, ExportTables } from './modelPartProduction';

// Header colours of reportExcelExport.ts, so both workbooks look alike.
const thin = { style: 'thin', color: { rgb: 'B7C4D4' } };
const border = { top: thin, bottom: thin, left: thin, right: thin };
const HEADER = {
  font: { bold: true, sz: 11, color: { rgb: 'FFFFFF' } },
  fill: { patternType: 'solid', fgColor: { rgb: '2F5C8A' } },
  alignment: { horizontal: 'center', vertical: 'center' },
  border,
};
const BODY = { font: { sz: 10.5, color: { rgb: '222222' } }, border };
const LABEL = { font: { bold: true, sz: 11, color: { rgb: '1F3B57' } }, fill: { patternType: 'solid', fgColor: { rgb: 'DCE6F1' } }, border };
const TITLE = { font: { bold: true, sz: 16, color: { rgb: '1F3B57' } } };

function tableSheet(rows: Cell[][]): XLSX.WorkSheet {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const width = rows[0]?.length ?? 0;
  rows.forEach((row, r) => row.forEach((_, c) => {
    const cell = ws[XLSX.utils.encode_cell({ r, c })];
    if (cell) cell.s = r === 0 ? HEADER : BODY;
  }));
  ws['!cols'] = Array.from({ length: width }, (_, c) => ({
    wch: Math.min(40, Math.max(10, ...rows.map((row) => String(row[c] ?? '').length + 2))),
  }));
  return ws;
}

function summarySheet(rows: Cell[][]): XLSX.WorkSheet {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  rows.forEach((row, r) => row.forEach((_, c) => {
    const cell = ws[XLSX.utils.encode_cell({ r, c })];
    if (cell) cell.s = r === 0 ? TITLE : c === 0 ? LABEL : BODY;
  }));
  ws['!cols'] = [{ wch: 38 }, { wch: 30 }];
  return ws;
}

export async function exportModelPartToExcel(tables: ExportTables, fromDate: string, toDate: string): Promise<void> {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, summarySheet(tables.summary), 'SUMMARY');
  XLSX.utils.book_append_sheet(wb, tableSheet(tables.parts), 'BY MODEL-PART');
  XLSX.utils.book_append_sheet(wb, tableSheet(tables.detail), 'SLOT RECORDS');
  if (tables.duplicates.length > 1) {
    XLSX.utils.book_append_sheet(wb, tableSheet(tables.duplicates), 'EXCLUDED DUPLICATES');
  }

  const fileName = `Model_Part_Production_${fromDate}_to_${toDate}.xlsx`;
  if (Platform.OS === 'web') {
    XLSX.writeFile(wb, fileName, { bookType: 'xlsx' });
    return;
  }
  const base64 = XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });
  const fileUri = `${FileSystem.documentDirectory}${fileName}`;
  await FileSystem.writeAsStringAsync(fileUri, base64, { encoding: FileSystem.EncodingType.Base64 });
  if (!(await Sharing.isAvailableAsync())) throw new Error('Sharing is not available on this device.');
  await Sharing.shareAsync(fileUri, {
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    dialogTitle: 'Export Model / Part Production',
    UTI: 'com.microsoft.excel.xlsx',
  });
}
