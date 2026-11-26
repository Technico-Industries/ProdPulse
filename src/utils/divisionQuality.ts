// src/utils/divisionQuality.ts
//
// Division-wise quality breakdown for the Quality Analysis report
// (QualityAnalysisScreen + qualityExcelExport). Pure — no React/Firebase — so
// scripts/testDivisionQuality.ts can check it (npm run test:division-quality).
//
// SOURCES (both existing, nothing new is written):
//   • productionRecords — production figures, via qualityMetrics'
//     counterQuality (good = Σ producedThisSlot, rejected = Σ rejections
//     counter, total = good + rejected). Legacy slots without a counter are
//     left out, exactly as everywhere else that uses counterQuality.
//   • rejectionRecords  — the defect categories and remarks logged on the
//     Record Rejection screen, shown per line "if recorded". Never added to
//     the rejection totals (see qualityMetrics.ts — they may log the very
//     same parts as the counter).
//
// GROUPING: every record belongs to exactly one (plant, workshop, division)
// group and, inside it, to exactly one line (lineId, else lineName), so no
// record is counted twice. Division totals are the sum of their lines.

import { computeQuality, counterQuality, CounterRecord } from './qualityMetrics';
import { qualityStatus, QualityStatus } from './liveQuality';

export interface DQProductionRecord extends CounterRecord {
  id: string;
  plant: string | null;
  workshop: string | null;
  division: string | null;
  lineId: string | null;
  lineName: string | null;
  partName: string | null;
}

export interface DQRejectionRecord {
  id: string;
  plant: string | null;
  workshop: string | null;
  division: string | null;
  lineId: string | null;
  lineName: string | null;
  partName: string | null;
  defect: string | null;
  rejectionQty: number;
  remarks: string | null;
}

export interface DefectQty {
  defect: string;
  qty: number;
}

export interface LineQuality {
  key: string;
  lineName: string;
  models: string[];
  totalProduction: number | null; // good + rejected (inspected)
  goodProduction: number;
  rejections: number | null;
  rejectionPct: number | null;
  qualityPct: number | null;
  status: QualityStatus;
  slotRecords: number;
  legacyRecords: number;
  defects: DefectQty[]; // from rejectionRecords, high → low
  loggedDefectQty: number;
  remarks: string[];
}

export interface DivisionQuality {
  key: string;
  plant: string | null;
  workshop: string | null;
  division: string; // display name ("No division" when unset)
  hasDivision: boolean;
  totalProduction: number | null;
  goodProduction: number;
  rejections: number | null;
  rejectionPct: number | null;
  qualityPct: number | null;
  status: QualityStatus;
  lineCount: number;
  lines: LineQuality[];
}

export const NO_DIVISION = 'No division';

function norm(v: string | null | undefined): string {
  return (v ?? '').trim().toLowerCase();
}

function groupKey(plant: string | null, workshop: string | null, division: string | null) {
  return `${norm(plant)}|${norm(workshop)}|${norm(division)}`;
}

function lineKeyOf(r: { lineId: string | null; lineName: string | null }) {
  return r.lineId ? `id:${r.lineId}` : `name:${norm(r.lineName) || 'unnamed'}`;
}

interface Bucket {
  plant: string | null;
  workshop: string | null;
  division: string | null;
  lines: Map<string, { lineName: string | null; prod: DQProductionRecord[]; rej: DQRejectionRecord[] }>;
}

function sum(values: (number | null)[]): number | null {
  // null only when every value is null (all lines' rejections unknown).
  if (values.length === 0) return 0;
  if (values.every((v) => v == null)) return null;
  return values.reduce<number>((s, v) => s + (v ?? 0), 0);
}

// `configuredDivisions` (from the workshop configuration, divisionsForWorkshop)
// are listed even with no records when `context` names the plant + workshop,
// so an idle division shows as "No data" instead of disappearing.
export function buildDivisionQuality(
  production: DQProductionRecord[],
  rejections: DQRejectionRecord[],
  options: { configuredDivisions?: string[]; context?: { plant: string; workshop: string } | null } = {},
): DivisionQuality[] {
  const buckets = new Map<string, Bucket>();
  const bucketFor = (r: { plant: string | null; workshop: string | null; division: string | null }) => {
    const key = groupKey(r.plant, r.workshop, r.division);
    let b = buckets.get(key);
    if (!b) {
      b = { plant: r.plant ?? null, workshop: r.workshop ?? null, division: r.division?.trim() || null, lines: new Map() };
      buckets.set(key, b);
    }
    return b;
  };
  const lineFor = (b: Bucket, r: { lineId: string | null; lineName: string | null }) => {
    const key = lineKeyOf(r);
    let l = b.lines.get(key);
    if (!l) {
      l = { lineName: r.lineName ?? null, prod: [], rej: [] };
      b.lines.set(key, l);
    } else if (!l.lineName && r.lineName) {
      l.lineName = r.lineName;
    }
    return l;
  };

  // De-duplicate production slots by doc id (a slot doc is one record).
  const seen = new Set<string>();
  production.forEach((r) => {
    if (seen.has(r.id)) return;
    seen.add(r.id);
    lineFor(bucketFor(r), r).prod.push(r);
  });
  const seenRej = new Set<string>();
  rejections.forEach((r) => {
    if (seenRej.has(r.id)) return;
    seenRej.add(r.id);
    lineFor(bucketFor(r), r).rej.push(r);
  });

  const configured = options.configuredDivisions ?? [];
  if (options.context) {
    configured.forEach((d) => bucketFor({ plant: options.context!.plant, workshop: options.context!.workshop, division: d }));
  }
  const configuredIndex = new Map(configured.map((d, i) => [norm(d), i]));

  const result: DivisionQuality[] = Array.from(buckets.entries()).map(([key, b]) => {
    const lines: LineQuality[] = Array.from(b.lines.entries()).map(([lineKey, l]) => {
      const q = counterQuality(l.prod);
      const defectMap = new Map<string, number>();
      l.rej.forEach((r) => {
        const label = r.defect?.trim() || 'Unspecified';
        defectMap.set(label, (defectMap.get(label) ?? 0) + (r.rejectionQty || 0));
      });
      const defects = Array.from(defectMap, ([defect, qty]) => ({ defect, qty })).sort(
        (a, b2) => b2.qty - a.qty || a.defect.localeCompare(b2.defect),
      );
      const models = Array.from(
        new Set([...l.prod, ...l.rej].map((r) => r.partName?.trim()).filter(Boolean) as string[]),
      ).sort((a, b2) => a.localeCompare(b2));
      const remarks = Array.from(new Set(l.rej.map((r) => r.remarks?.trim()).filter(Boolean) as string[]));
      return {
        key: lineKey,
        lineName: l.lineName?.trim() || 'Unnamed line',
        models,
        totalProduction: q.inspectedParts,
        goodProduction: q.goodParts,
        rejections: q.rejectedParts,
        rejectionPct: q.rejectionPct,
        qualityPct: q.qualityPct,
        status: qualityStatus(q.qualityPct),
        slotRecords: l.prod.length,
        legacyRecords: q.legacyRecords,
        defects,
        loggedDefectQty: defects.reduce((s, d) => s + d.qty, 0),
        remarks,
      };
    });
    lines.sort((a, b2) => a.lineName.localeCompare(b2.lineName, undefined, { numeric: true }));

    // Division totals = Σ of its lines (each record sits in exactly one line).
    const good = lines.reduce((s, l) => s + l.goodProduction, 0);
    const rejected = sum(lines.filter((l) => l.slotRecords > 0).map((l) => l.rejections));
    const dq = computeQuality(good, lines.some((l) => l.slotRecords > 0) ? rejected : 0);
    const hasProduction = lines.some((l) => l.slotRecords > 0);
    return {
      key,
      plant: b.plant,
      workshop: b.workshop,
      division: b.division ?? NO_DIVISION,
      hasDivision: !!b.division,
      totalProduction: hasProduction ? dq.inspectedParts : 0,
      goodProduction: dq.goodParts,
      rejections: hasProduction ? dq.rejectedParts : 0,
      rejectionPct: dq.rejectionPct,
      qualityPct: dq.qualityPct,
      status: qualityStatus(dq.qualityPct),
      lineCount: lines.length,
      lines,
    };
  });

  return result.sort((a, b) => {
    const byPlant = norm(a.plant).localeCompare(norm(b.plant));
    if (byPlant) return byPlant;
    const byWorkshop = norm(a.workshop).localeCompare(norm(b.workshop));
    if (byWorkshop) return byWorkshop;
    if (a.hasDivision !== b.hasDivision) return a.hasDivision ? -1 : 1;
    const ia = configuredIndex.get(norm(a.division));
    const ib = configuredIndex.get(norm(b.division));
    if (ia != null && ib != null) return ia - ib;
    if (ia != null) return -1;
    if (ib != null) return 1;
    return a.division.localeCompare(b.division, undefined, { numeric: true });
  });
}
