// src/utils/prodPulseAIExcelExport.ts
//
// Excel export of one ProdPulse AI result table. It writes only the rows
// utils/prodPulseAI buildResultExportTables made from the backend's
// ResultBlock — the exact rows on screen, never anything the model wrote.
// Web: a browser download. Android/iOS: written to the app's document
// directory and handed to the share sheet — the same two paths as
// reportExcelExport.ts. Same library and header colours as
// modelPartExcelExport.ts.

import { Platform } from 'react-native';
import * as XLSX from 'xlsx-js-style';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { buildResultExportTables, Cell, ResultBlock } from './prodPulseAI';

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

function styled(rows: Cell[][], styleOf: (r: number, c: number) => object, widths: (c: number) => number): XLSX.WorkSheet {
  const ws = XLSX.utils.aoa_to_sheet(rows.map((row) => row.map((v) => (v == null ? '' : v))));
  rows.forEach((row, r) => row.forEach((_, c) => {
    const cell = ws[XLSX.utils.encode_cell({ r, c })];
    if (cell) cell.s = styleOf(r, c);
  }));
  const width = Math.max(0, ...rows.map((r) => r.length));
  ws['!cols'] = Array.from({ length: width }, (_, c) => ({ wch: widths(c) }));
  return ws;
}

export function resultExportFileName(block: ResultBlock): string {
  const slug = block.title.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'ProdPulse_AI';
  return `ProdPulse_AI_${slug}.xlsx`;
}

export async function exportResultToExcel(block: ResultBlock, generatedAt: string): Promise<void> {
  const { info, table } = buildResultExportTables(block, generatedAt);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    styled(info, (r, c) => (r === 0 ? TITLE : c === 0 ? LABEL : BODY), (c) => (c === 0 ? 40 : 60)),
    'SUMMARY'
  );
  if (block.columns.length) {
    XLSX.utils.book_append_sheet(
      wb,
      styled(table, (r) => (r === 0 ? HEADER : BODY), (c) => Math.min(40, Math.max(10, ...table.map((row) => String(row[c] ?? '').length + 2)))),
      'DATA'
    );
  }
  const fileName = resultExportFileName(block);
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
    dialogTitle: 'Export Prod AI result',
    UTI: 'com.microsoft.excel.xlsx',
  });
}
