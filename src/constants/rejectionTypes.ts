// rejectionTypes.ts
//
// Single source of truth for QC rejection types and their category, taken
// from "Rejection Types.xlsx" (sheet order and spelling preserved exactly).
// The category is what gets written to `rejectionRecords.stage`.
//
// Every type maps to exactly one category EXCEPT FOULING, which the sheet
// lists twice (Visual and Process). It is kept as a single entry with
// `category: null` and the allowed choices in `manualCategories`, so the
// recording screen asks the user instead of silently picking one.

export const REJECTION_CATEGORIES = ['Visual', 'Process', 'Dimension'] as const;
export type RejectionCategory = (typeof REJECTION_CATEGORIES)[number];

export type RejectionType =
  | { name: string; category: RejectionCategory; manualCategories?: undefined }
  | { name: string; category: null; manualCategories: readonly RejectionCategory[] };

export const REJECTION_TYPES: readonly RejectionType[] = [
  { name: 'Bush Miss', category: 'Process' },
  { name: 'Part Miss', category: 'Process' },
  { name: 'Wrong Assy', category: 'Process' },
  { name: 'Tool Mark', category: 'Process' },
  { name: 'Riveting Damage', category: 'Process' },
  { name: 'Small/Long Pin Riveting', category: 'Process' },
  { name: 'Riveting Dia More/Less', category: 'Process' },
  { name: 'Wrong Or Batch code Damage', category: 'Process' },
  { name: 'Bush Damage', category: 'Process' },
  { name: 'Rivet Crack', category: 'Process' },
  { name: 'Wrong bolt Assy. in Pedal', category: 'Process' },
  { name: 'Part Bend during Riveting', category: 'Process' },
  { name: 'Gauge out', category: 'Dimension' },
  { name: 'Movement Loose', category: 'Process' },
  { name: 'Movement Hard', category: 'Process' },
  { name: 'Jurky Movement', category: 'Process' },
  { name: 'Exess Play', category: 'Visual' },
  { name: 'Opening Angle More', category: 'Dimension' },
  { name: 'Opening Angle Less', category: 'Dimension' },
  { name: 'Closing Angle Less', category: 'Dimension' },
  { name: 'Plating NG', category: 'Visual' },
  { name: 'Dent/Scratch', category: 'Visual' },
  { name: 'Burr on Part', category: 'Visual' },
  { name: 'Bolt/Nut NG', category: 'Dimension' },
  { name: 'Logo NG in Part', category: 'Dimension' },
  { name: 'Part Profile NG', category: 'Visual' },
  { name: 'Part Crack', category: 'Process' },
  { name: 'Knurling Gap', category: 'Dimension' },
  { name: 'Excess Grinding on Parts', category: 'Dimension' },
  { name: 'FOULING', category: null, manualCategories: ['Visual', 'Process'] },
  { name: 'SPETTER', category: 'Visual' },
  { name: 'HEAD CRACK', category: 'Process' },
  { name: 'Blank Short', category: 'Visual' },
  { name: 'Hole Shift', category: 'Dimension' },
  { name: 'Thread NG', category: 'Visual' },
];

export const REJECTION_TYPE_NAMES: string[] = REJECTION_TYPES.map((t) => t.name);

const BY_NAME = new Map(REJECTION_TYPES.map((t) => [t.name, t]));

export function getRejectionType(name: string | null | undefined): RejectionType | null {
  return name ? BY_NAME.get(name) ?? null : null;
}

/**
 * SUM(rejectionQty) per rejection type, seeded with 0 for every known type.
 * FOULING Visual + Process land on the same key since `defect` is the same.
 * Records with a missing/non-string defect or a non-positive quantity are
 * skipped instead of throwing.
 */
export function sumQtyByRejectionType(records: Iterable<{ defect?: unknown; rejectionQty?: unknown }>): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const name of REJECTION_TYPE_NAMES) totals[name] = 0;
  for (const r of records) {
    if (typeof r.defect !== 'string') continue;
    const qty = Number(r.rejectionQty);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    totals[r.defect] = (totals[r.defect] ?? 0) + qty;
  }
  return totals;
}

export type RejectionEntry = { type: RejectionType; qty: number; stage: RejectionCategory };

/**
 * Turns the entry sheet (qty and manual category pick per type) into one
 * entry per type with qty > 0, in sheet order. Zero rows are
 * dropped. A manual pick only applies to its own type and must be one of that
 * type's allowed categories. Returns an error message instead when a non-zero
 * type is missing its category (FOULING), or when nothing was entered.
 */
export function buildRejectionEntries(
  qtyByType: Record<string, number>,
  manualPicks: Record<string, RejectionCategory | null>
): { entries: RejectionEntry[]; error: null } | { entries: null; error: string } {
  const entries: RejectionEntry[] = [];
  for (const type of REJECTION_TYPES) {
    const qty = qtyByType[type.name] ?? 0;
    if (!(qty > 0)) continue;
    const pick = manualPicks[type.name] ?? null;
    const stage = type.category ?? (pick && type.manualCategories?.includes(pick) ? pick : null);
    if (!stage) return { entries: null, error: `Please select Visual or Process for ${type.name}.` };
    entries.push({ type, qty, stage });
  }
  if (entries.length === 0) return { entries: null, error: 'Enter at least one rejection quantity.' };
  return { entries, error: null };
}
