// src/utils/qualityMetrics.ts
//
// First-pass quality for the admin Production Overview
// (AdminOverviewScreen), checked by scripts/testQualityMetrics.ts
// (npm run test:quality).
//
// DATA MODEL — the one KPIAnalysisScreen and kpiExcelExport already use:
// productionRecords.producedThisSlot is the GOOD output a line reports
// (KPIAnalysis shows Σ producedThisSlot as "Good Parts" and computes
// rejection % = rejected / (produced + rejected)). Rejected parts come on
// top of it, so:
//   goodParts      = Σ producedThisSlot
//   rejectedParts  = Σ rejectionRecords.rejectionQty  (QC-logged)
//   inspectedParts = goodParts + rejectedParts
//   qualityPct     = goodParts / inspectedParts × 100
//   rejectionPct   = rejectedParts / inspectedParts × 100  (= 100 − quality)
//
// AUTHORITATIVE REJECTIONS — the QC-logged `rejectionRecords` (one record per
// defect type, written by RecordRejectionScreen). The per-slot `rejections`
// a supervisor can also tap in on RecordProductionScreen are a separate,
// unlinked count of what may be the very same physical parts (nothing ties a
// slot rejection to a QC record), so they are NOT added — that would
// double-count. They're shown separately for reference only.
//
// QC data that failed to load is `null`, never 0: quality is then unknown
// (null → "—"), not a misleading 100%.

export interface QcRejectionRecord {
  date: string | null;
  lineId: string | null;
  plant: string | null;
  workshop: string | null;
  division: string | null;
  rejectionQty: number;
}

export interface QualityMetrics {
  goodParts: number;
  // null when the QC rejections couldn't be loaded.
  rejectedParts: number | null;
  inspectedParts: number | null;
  // null when unknown (QC data unavailable) or when nothing was inspected.
  qualityPct: number | null;
  rejectionPct: number | null;
}

function round1(n: number) {
  return Math.round(n * 10) / 10;
}

export function computeQuality(goodParts: number, qcRejected: number | null): QualityMetrics {
  const good = Math.max(0, Number.isFinite(goodParts) ? goodParts : 0);
  if (qcRejected == null || !Number.isFinite(qcRejected)) {
    return { goodParts: good, rejectedParts: null, inspectedParts: null, qualityPct: null, rejectionPct: null };
  }
  const rejected = Math.max(0, qcRejected);
  const inspected = good + rejected;
  if (inspected <= 0) {
    return { goodParts: good, rejectedParts: rejected, inspectedParts: 0, qualityPct: null, rejectionPct: null };
  }
  const rejectionPct = round1((rejected / inspected) * 100);
  return {
    goodParts: good,
    rejectedParts: rejected,
    inspectedParts: inspected,
    // Derived from the same rounded figure so the two always add to 100.
    qualityPct: round1(100 - rejectionPct),
    rejectionPct,
  };
}

// Case/whitespace-insensitive equality — the same matching the admin
// screens use for their Plant/Workshop/Division filters.
function sameValue(a: string | null | undefined, b: string | null | undefined) {
  if (a == null || b == null) return false;
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

export interface LineLocation {
  id: string;
  plant: string | null;
  workshop: string | null;
  division: string | null;
}

// QC records narrowed to the dashboard's Plant/Workshop/Division filters.
// Like the production records on the same screen, a record's location is
// taken from its line's productionLines doc when that line still exists, and
// from the record's own stamped fields otherwise.
export function filterQcRecords<T extends QcRejectionRecord>(
  records: T[],
  lines: LineLocation[],
  filters: { plant: string | null; workshop: string | null; division: string | null }
): T[] {
  const lineById = new Map(lines.map((l) => [l.id, l]));
  return records.filter((r) => {
    const line = r.lineId ? lineById.get(r.lineId) : undefined;
    const plant = line?.plant ?? r.plant;
    const workshop = line?.workshop ?? r.workshop;
    const division = line?.division ?? r.division;
    if (filters.plant && !sameValue(plant, filters.plant)) return false;
    if (filters.workshop && !sameValue(workshop, filters.workshop)) return false;
    if (filters.division && !sameValue(division, filters.division)) return false;
    return true;
  });
}

export function sumRejectionQty(records: QcRejectionRecord[]): number {
  return records.reduce((s, r) => s + (Number.isFinite(r.rejectionQty) ? Math.max(0, r.rejectionQty) : 0), 0);
}
