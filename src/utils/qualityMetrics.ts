// src/utils/qualityMetrics.ts
//
// Quality figures for the admin Production Overview (AdminOverviewScreen),
// the Quality Overview (QualityOverviewScreen) and the live QC Lines page
// (via src/utils/liveQuality.ts). Checked by scripts/testQualityMetrics.ts
// (npm run test:quality).
//
// SOURCE OF REJECTIONS — the "Rejections" −/+ counter on each Record
// Production slot card. RecordProductionScreen writes it to that slot's
// productionRecords doc as `rejections` (one doc per slot, or per changeover
// half). It is the ONLY rejection source for these figures.
// rejectionRecords (the separate Record Rejection screen, browsed in Quality
// Analysis) is never added — it may log the very same parts.
//
// DATA MODEL — the one KPIAnalysisScreen already uses: producedThisSlot is
// the GOOD output a line reports (efficiency compares it with the target,
// nothing subtracts rejections from it, and KPIAnalysis computes
// rejection % = rejections / (produced + rejections)). So, summed over the
// same records — quantities first, never an average of slot percentages:
//   goodParts      = Σ producedThisSlot
//   rejectedParts  = Σ rejections
//   inspectedParts = goodParts + rejectedParts
//   qualityPct     = goodParts / inspectedParts × 100
//   rejectionPct   = rejectedParts / inspectedParts × 100  (= 100 − quality)
//
// LEGACY records without a numeric `rejections` field are left out of all
// four quantities (counted in `legacyRecords`), so a missing counter is
// never read as "0 rejected". expectedParts is never used here.

export interface QualityMetrics {
  goodParts: number;
  // null when the rejections are unknown (not loaded / legacy records only).
  rejectedParts: number | null;
  inspectedParts: number | null;
  // null when unknown (rejections unknown) or when nothing was inspected.
  qualityPct: number | null;
  rejectionPct: number | null;
}

function round1(n: number) {
  return Math.round(n * 10) / 10;
}

export function computeQuality(goodParts: number, rejectedParts: number | null): QualityMetrics {
  const good = Math.max(0, Number.isFinite(goodParts) ? goodParts : 0);
  if (rejectedParts == null || !Number.isFinite(rejectedParts)) {
    return { goodParts: good, rejectedParts: null, inspectedParts: null, qualityPct: null, rejectionPct: null };
  }
  const rejected = Math.max(0, rejectedParts);
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

export interface CounterRecord {
  producedThisSlot: number | null;
  // Absent / null on legacy records written before the counter existed.
  rejections?: number | null;
}

export interface CounterQuality extends QualityMetrics {
  // Records left out because they carry no rejection counter.
  legacyRecords: number;
}

function finiteOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// Quality of a set of productionRecords (already de-duplicated / filtered by
// the caller). No records → unavailable; only legacy records → rejections
// unknown, so quality is unavailable rather than a misleading 100%.
export function counterQuality(records: CounterRecord[]): CounterQuality {
  let good = 0;
  let rejected = 0;
  let counted = 0;
  let legacyRecords = 0;
  records.forEach((r) => {
    const rej = finiteOrNull(r.rejections);
    if (rej == null) {
      legacyRecords++;
      return;
    }
    counted++;
    good += Math.max(0, finiteOrNull(r.producedThisSlot) ?? 0);
    rejected += Math.max(0, rej);
  });
  const q = computeQuality(good, counted === 0 && legacyRecords > 0 ? null : rejected);
  return { ...q, legacyRecords };
}
