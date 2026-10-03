// src/services/aiQueries.ts
//
// ProdPulse AI — Firestore query layer.
//
// This file ONLY reads existing collections with their existing field names
// (verified against the screens that write them — see the field-by-field
// notes on each function). It creates nothing, writes nothing, and does not
// call any AI provider. It is meant to be consumed later by the Cloud
// Function / AI layer described in Part 1.
//
// ─────────────────────────────────────────────────────────────────────────
// DATE KEY FORMATS — two different conventions exist in this codebase and
// callers must not mix them up:
//
//   1. `productionRecords.productionDate` — a "production day" key that
//      runs 6:30 AM to next day's 6:30 AM (see productionDayKeyFor below,
//      copied verbatim from RecordProductionScreen.tsx so AI answers use
//      the exact same "today" a supervisor would see on that screen).
//
//   2. `rejectionRecords.date` — a plain calendar-day key (midnight to
//      midnight), copied verbatim from RecordRejectionScreen.tsx's
//      todayKey().
//
// Both are formatted as YYYY-MM-DD strings, which is why range queries can
// use simple string comparison (`>=` / `<=`) — this mirrors the exact
// pattern already used in QualityAnalysisScreen.tsx for rejectionRecords.
// ─────────────────────────────────────────────────────────────────────────

import { collection, query, where, getDocs, Timestamp } from 'firebase/firestore';
import { db } from './firebase';

// ─────────────────────────────────────────────────────────────────────────
// Date-key helpers
// ─────────────────────────────────────────────────────────────────────────

/** Copied from RecordProductionScreen.tsx — DO NOT change independently. */
const PRODUCTION_DAY_CUTOVER_MINUTES = 6 * 60 + 30; // 6:30 AM

/** Matches `productionRecords.productionDate` exactly. */
function productionDayKeyFor(epochMs: number): string {
  const d = new Date(epochMs);
  const minutesOfDay = d.getHours() * 60 + d.getMinutes();
  const effective = new Date(d);
  if (minutesOfDay < PRODUCTION_DAY_CUTOVER_MINUTES) {
    effective.setDate(effective.getDate() - 1);
  }
  const y = effective.getFullYear();
  const m = String(effective.getMonth() + 1).padStart(2, '0');
  const day = String(effective.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Matches `rejectionRecords.date` (and attendanceRecords/manDaysRecords/etc). */
function calendarDayKeyFor(epochMs: number): string {
  const d = new Date(epochMs);
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

function addDays(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return calendarDayKeyFor(dt.getTime());
}

// ─────────────────────────────────────────────────────────────────────────
// Error handling
// ─────────────────────────────────────────────────────────────────────────

export class AIQueryError extends Error {
  cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'AIQueryError';
    this.cause = cause;
  }
}

async function safeGetDocs(q: ReturnType<typeof query>, context: string) {
  try {
    return await getDocs(q);
  } catch (err) {
    console.error(`[aiQueries] ${context} failed:`, err);
    throw new AIQueryError(`Could not ${context}. Check your connection and try again.`, err);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Types — field names match the writers exactly (see Part 1 report)
// ─────────────────────────────────────────────────────────────────────────

export interface ProductionRecord {
  id: string;
  plant: string | null;
  workshop: string | null;
  division: string | null;
  lineId: string | null;
  lineName: string | null;
  shift: string | null;
  productionDate: string | null;
  partName: string | null;
  slotIndex: number | null;
  slotLabel: string | null;
  producedThisSlot: number | null;
  expectedParts: number | null;
  lossParts: number | null;
  lossTimeMinutes: number | null;
  lossReasonCode: string | null;
  lossReasonLabel: string | null;
  rejections: number | null;
  createdAt: Timestamp | null;
}

export interface RejectionRecord {
  id: string;
  date: string | null;
  plant: string | null;
  workshop: string | null;
  division: string | null;
  lineId: string | null;
  lineName: string | null;
  partName: string | null;
  stage: string | null;
  rejectionQty: number | null;
  defect: string | null;
  responsibility: string | null;
  remarks: string | null;
  createdAt: Timestamp | null;
}

export interface LineProductionTotal {
  lineId: string | null;
  lineName: string | null;
  totalProduced: number;
  recordCount: number;
}

export interface DefectTotal {
  defect: string;
  totalQty: number;
  recordCount: number;
}

export interface ProductionSummary {
  dateKey: string;
  totalProduced: number;
  totalExpected: number;
  totalLossParts: number;
  recordCount: number;
}

export interface RejectionSummary {
  dateKeyRange: { from: string; to: string };
  totalRejectionQty: number;
  recordCount: number;
}

export interface ComparisonResult<T> {
  current: T;
  previous: T;
  differenceAbs: number;
  differencePct: number | null; // null when previous total is 0 (undefined %)
}

// ─────────────────────────────────────────────────────────────────────────
// Mappers
// ─────────────────────────────────────────────────────────────────────────

function toProductionRecord(d: any): ProductionRecord {
  const data: any = d.data();
  return {
    id: d.id,
    plant: data.plant ?? null,
    workshop: data.workshop ?? null,
    division: data.division ?? null,
    lineId: data.lineId ?? null,
    lineName: data.lineName ?? null,
    shift: data.shift ?? null,
    productionDate: data.productionDate ?? null,
    partName: data.partName ?? null,
    slotIndex: data.slotIndex ?? null,
    slotLabel: data.slotLabel ?? null,
    producedThisSlot: data.producedThisSlot ?? null,
    expectedParts: data.expectedParts ?? null,
    lossParts: data.lossParts ?? null,
    lossTimeMinutes: data.lossTimeMinutes ?? null,
    lossReasonCode: data.lossReasonCode ?? null,
    lossReasonLabel: data.lossReasonLabel ?? null,
    rejections: data.rejections ?? null,
    createdAt: data.createdAt ?? null,
  };
}

function toRejectionRecord(d: any): RejectionRecord {
  const data: any = d.data();
  return {
    id: d.id,
    date: data.date ?? null,
    plant: data.plant ?? null,
    workshop: data.workshop ?? null,
    division: data.division ?? null,
    lineId: data.lineId ?? null,
    lineName: data.lineName ?? null,
    partName: data.partName ?? null,
    stage: data.stage ?? null,
    rejectionQty: data.rejectionQty ?? null,
    defect: data.defect ?? null,
    responsibility: data.responsibility ?? null,
    remarks: data.remarks ?? null,
    createdAt: data.createdAt ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// PRODUCTION
// ─────────────────────────────────────────────────────────────────────────

/**
 * Reads: productionRecords
 * Filters on: productionDate (== today's production-day key)
 */
export async function getTodayProduction(): Promise<ProductionRecord[]> {
  const todayKey = productionDayKeyFor(Date.now());
  const q = query(collection(db, 'productionRecords'), where('productionDate', '==', todayKey));
  const snap = await safeGetDocs(q, "load today's production");
  return snap.docs.map(toProductionRecord);
}

/**
 * Reads: productionRecords
 * Filters on: productionDate (== yesterday's production-day key)
 */
export async function getYesterdayProduction(): Promise<ProductionRecord[]> {
  const yesterdayKey = addDays(productionDayKeyFor(Date.now()), -1);
  const q = query(collection(db, 'productionRecords'), where('productionDate', '==', yesterdayKey));
  const snap = await safeGetDocs(q, "load yesterday's production");
  return snap.docs.map(toProductionRecord);
}

/**
 * Reads: productionRecords
 * Filters on: productionDate (range, inclusive, YYYY-MM-DD string compare —
 * same technique QualityAnalysisScreen.tsx uses for rejectionRecords.date)
 */
export async function getProductionByDateRange(
  fromDateKey: string,
  toDateKey: string
): Promise<ProductionRecord[]> {
  if (fromDateKey > toDateKey) {
    throw new AIQueryError('"from" date must be on or before "to" date.');
  }
  const q = query(
    collection(db, 'productionRecords'),
    where('productionDate', '>=', fromDateKey),
    where('productionDate', '<=', toDateKey)
  );
  const snap = await safeGetDocs(q, 'load production for the date range');
  return snap.docs.map(toProductionRecord);
}

/**
 * Reads: productionRecords
 * Filters on: lineId (==), optionally productionDate (range)
 * Sorted client-side by productionDate to avoid requiring a composite index
 * (equality + range across two different fields needs one otherwise).
 */
export async function getProductionByLine(
  lineId: string,
  fromDateKey?: string,
  toDateKey?: string
): Promise<ProductionRecord[]> {
  const clauses = [where('lineId', '==', lineId)];
  if (fromDateKey) clauses.push(where('productionDate', '>=', fromDateKey));
  if (toDateKey) clauses.push(where('productionDate', '<=', toDateKey));
  const q = query(collection(db, 'productionRecords'), ...clauses);
  const snap = await safeGetDocs(q, 'load production for this line');
  return snap.docs
    .map(toProductionRecord)
    .sort((a, b) => (a.productionDate ?? '').localeCompare(b.productionDate ?? ''));
}

/**
 * Reads: productionRecords
 * Filters on: productionDate (== given day, defaults to today)
 * Aggregates: producedThisSlot, grouped by lineId/lineName
 */
export async function getHighestProductionLine(
  dateKey: string = productionDayKeyFor(Date.now())
): Promise<LineProductionTotal | null> {
  const q = query(collection(db, 'productionRecords'), where('productionDate', '==', dateKey));
  const snap = await safeGetDocs(q, "find the day's highest-production line");
  if (snap.empty) return null;

  const totals = new Map<string, LineProductionTotal>();
  snap.docs.forEach((d) => {
    const rec = toProductionRecord(d);
    const key = rec.lineId ?? rec.lineName ?? 'unknown';
    const existing = totals.get(key) ?? {
      lineId: rec.lineId,
      lineName: rec.lineName,
      totalProduced: 0,
      recordCount: 0,
    };
    existing.totalProduced += rec.producedThisSlot ?? 0;
    existing.recordCount += 1;
    totals.set(key, existing);
  });

  let best: LineProductionTotal | null = null;
  for (const total of totals.values()) {
    if (!best || total.totalProduced > best.totalProduced) best = total;
  }
  return best;
}

// ─────────────────────────────────────────────────────────────────────────
// QUALITY
// ─────────────────────────────────────────────────────────────────────────

/**
 * Reads: rejectionRecords
 * Filters on: date (== today's calendar-day key)
 */
export async function getTodayRejections(): Promise<RejectionRecord[]> {
  const todayKey = calendarDayKeyFor(Date.now());
  const q = query(collection(db, 'rejectionRecords'), where('date', '==', todayKey));
  const snap = await safeGetDocs(q, "load today's rejections");
  return snap.docs.map(toRejectionRecord);
}

/**
 * Reads: rejectionRecords
 * Filters on: date (range, inclusive) — matches QualityAnalysisScreen.tsx exactly.
 */
export async function getRejectionsByDateRange(
  fromDateKey: string,
  toDateKey: string
): Promise<RejectionRecord[]> {
  if (fromDateKey > toDateKey) {
    throw new AIQueryError('"from" date must be on or before "to" date.');
  }
  const q = query(
    collection(db, 'rejectionRecords'),
    where('date', '>=', fromDateKey),
    where('date', '<=', toDateKey)
  );
  const snap = await safeGetDocs(q, 'load rejections for the date range');
  return snap.docs.map(toRejectionRecord);
}

/**
 * Reads: rejectionRecords
 * Filters on: date (range, defaults to the last 7 calendar days)
 * Aggregates: rejectionQty, grouped by defect, sorted descending.
 */
export async function getTopDefects(
  fromDateKey: string = addDays(calendarDayKeyFor(Date.now()), -6),
  toDateKey: string = calendarDayKeyFor(Date.now()),
  limitCount: number = 5
): Promise<DefectTotal[]> {
  const records = await getRejectionsByDateRange(fromDateKey, toDateKey);
  const totals = new Map<string, DefectTotal>();
  records.forEach((r) => {
    const key = r.defect ?? 'Unspecified';
    const existing = totals.get(key) ?? { defect: key, totalQty: 0, recordCount: 0 };
    existing.totalQty += r.rejectionQty ?? 0;
    existing.recordCount += 1;
    totals.set(key, existing);
  });
  return Array.from(totals.values())
    .sort((a, b) => b.totalQty - a.totalQty)
    .slice(0, limitCount);
}

/**
 * Reads: rejectionRecords
 * Filters on: lineId (==), optionally date (range)
 */
export async function getRejectionsByLine(
  lineId: string,
  fromDateKey?: string,
  toDateKey?: string
): Promise<RejectionRecord[]> {
  const clauses = [where('lineId', '==', lineId)];
  if (fromDateKey) clauses.push(where('date', '>=', fromDateKey));
  if (toDateKey) clauses.push(where('date', '<=', toDateKey));
  const q = query(collection(db, 'rejectionRecords'), ...clauses);
  const snap = await safeGetDocs(q, 'load rejections for this line');
  return snap.docs
    .map(toRejectionRecord)
    .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
}

/**
 * Reads: rejectionRecords
 * Filters on: plant (==), optionally date (range)
 */
export async function getRejectionsByPlant(
  plant: string,
  fromDateKey?: string,
  toDateKey?: string
): Promise<RejectionRecord[]> {
  const clauses = [where('plant', '==', plant)];
  if (fromDateKey) clauses.push(where('date', '>=', fromDateKey));
  if (toDateKey) clauses.push(where('date', '<=', toDateKey));
  const q = query(collection(db, 'rejectionRecords'), ...clauses);
  const snap = await safeGetDocs(q, 'load rejections for this plant');
  return snap.docs
    .map(toRejectionRecord)
    .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
}

/**
 * Reads: rejectionRecords
 * Filters on: workshop (==), optionally date (range)
 */
export async function getRejectionsByWorkshop(
  workshop: string,
  fromDateKey?: string,
  toDateKey?: string
): Promise<RejectionRecord[]> {
  const clauses = [where('workshop', '==', workshop)];
  if (fromDateKey) clauses.push(where('date', '>=', fromDateKey));
  if (toDateKey) clauses.push(where('date', '<=', toDateKey));
  const q = query(collection(db, 'rejectionRecords'), ...clauses);
  const snap = await safeGetDocs(q, 'load rejections for this workshop');
  return snap.docs
    .map(toRejectionRecord)
    .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
}

/**
 * Reads: rejectionRecords
 * Filters on: division (==), optionally date (range)
 */
export async function getRejectionsByDivision(
  division: string,
  fromDateKey?: string,
  toDateKey?: string
): Promise<RejectionRecord[]> {
  const clauses = [where('division', '==', division)];
  if (fromDateKey) clauses.push(where('date', '>=', fromDateKey));
  if (toDateKey) clauses.push(where('date', '<=', toDateKey));
  const q = query(collection(db, 'rejectionRecords'), ...clauses);
  const snap = await safeGetDocs(q, 'load rejections for this division');
  return snap.docs
    .map(toRejectionRecord)
    .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
}

/**
 * Reads: rejectionRecords
 * Filters on: stage (==), optionally date (range)
 */
export async function getRejectionsByStage(
  stage: string,
  fromDateKey?: string,
  toDateKey?: string
): Promise<RejectionRecord[]> {
  const clauses = [where('stage', '==', stage)];
  if (fromDateKey) clauses.push(where('date', '>=', fromDateKey));
  if (toDateKey) clauses.push(where('date', '<=', toDateKey));
  const q = query(collection(db, 'rejectionRecords'), ...clauses);
  const snap = await safeGetDocs(q, 'load rejections for this stage');
  return snap.docs
    .map(toRejectionRecord)
    .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
}

/**
 * Reads: rejectionRecords
 * Filters on: responsibility (==), optionally date (range)
 */
export async function getRejectionsByResponsibility(
  responsibility: string,
  fromDateKey?: string,
  toDateKey?: string
): Promise<RejectionRecord[]> {
  const clauses = [where('responsibility', '==', responsibility)];
  if (fromDateKey) clauses.push(where('date', '>=', fromDateKey));
  if (toDateKey) clauses.push(where('date', '<=', toDateKey));
  const q = query(collection(db, 'rejectionRecords'), ...clauses);
  const snap = await safeGetDocs(q, 'load rejections for this responsibility');
  return snap.docs
    .map(toRejectionRecord)
    .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
}

/**
 * Reads: rejectionRecords
 * Filters on: defect (==), optionally date (range)
 */
export async function getRejectionsByDefect(
  defect: string,
  fromDateKey?: string,
  toDateKey?: string
): Promise<RejectionRecord[]> {
  const clauses = [where('defect', '==', defect)];
  if (fromDateKey) clauses.push(where('date', '>=', fromDateKey));
  if (toDateKey) clauses.push(where('date', '<=', toDateKey));
  const q = query(collection(db, 'rejectionRecords'), ...clauses);
  const snap = await safeGetDocs(q, 'load rejections for this defect');
  return snap.docs
    .map(toRejectionRecord)
    .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
}

// ─────────────────────────────────────────────────────────────────────────
// COMPARISON
// ─────────────────────────────────────────────────────────────────────────

function sumProduced(records: ProductionRecord[]): number {
  return records.reduce((sum, r) => sum + (r.producedThisSlot ?? 0), 0);
}

function sumRejected(records: RejectionRecord[]): number {
  return records.reduce((sum, r) => sum + (r.rejectionQty ?? 0), 0);
}

function diff(current: number, previous: number): { differenceAbs: number; differencePct: number | null } {
  const differenceAbs = current - previous;
  const differencePct = previous !== 0 ? (differenceAbs / previous) * 100 : null;
  return { differenceAbs, differencePct };
}

/**
 * Reads: productionRecords, rejectionRecords
 * Compares today's totals against yesterday's totals for both.
 * Note: "today"/"yesterday" use each collection's own date convention
 * (production-day key for productionRecords, calendar-day key for
 * rejectionRecords) — see the header comment above.
 */
export async function compareTodayYesterday(): Promise<{
  production: ComparisonResult<number>;
  rejections: ComparisonResult<number>;
}> {
  const [todayProd, yesterdayProd, todayRej, yesterdayRejRaw] = await Promise.all([
    getTodayProduction(),
    getYesterdayProduction(),
    getTodayRejections(),
    getRejectionsByDateRange(addDays(calendarDayKeyFor(Date.now()), -1), addDays(calendarDayKeyFor(Date.now()), -1)),
  ]);

  const currentProd = sumProduced(todayProd);
  const previousProd = sumProduced(yesterdayProd);
  const currentRej = sumRejected(todayRej);
  const previousRej = sumRejected(yesterdayRejRaw);

  return {
    production: { current: currentProd, previous: previousProd, ...diff(currentProd, previousProd) },
    rejections: { current: currentRej, previous: previousRej, ...diff(currentRej, previousRej) },
  };
}

/**
 * Reads: productionRecords, rejectionRecords
 * Compares the last 7 calendar days against the 7 calendar days before that
 * (rolling window — this codebase has no existing "week" convention to
 * match, e.g. no ISO week boundaries used elsewhere, so this is a
 * deliberate choice; easy to switch to calendar Mon–Sun weeks later if
 * preferred).
 */
export async function compareWeeks(): Promise<{
  production: ComparisonResult<number>;
  rejections: ComparisonResult<number>;
}> {
  const today = calendarDayKeyFor(Date.now());
  const currentStart = addDays(today, -6);
  const previousEnd = addDays(currentStart, -1);
  const previousStart = addDays(previousEnd, -6);

  // productionRecords uses a different "day" boundary (production-day key)
  // than rejectionRecords, but both are still YYYY-MM-DD strings and a
  // 7-day window is the same width in either convention, so the same
  // calendar-day keys are used as the range bounds for both queries.
  const [currentProd, previousProd, currentRej, previousRej] = await Promise.all([
    getProductionByDateRange(currentStart, today),
    getProductionByDateRange(previousStart, previousEnd),
    getRejectionsByDateRange(currentStart, today),
    getRejectionsByDateRange(previousStart, previousEnd),
  ]);

  const currentProdTotal = sumProduced(currentProd);
  const previousProdTotal = sumProduced(previousProd);
  const currentRejTotal = sumRejected(currentRej);
  const previousRejTotal = sumRejected(previousRej);

  return {
    production: {
      current: currentProdTotal,
      previous: previousProdTotal,
      ...diff(currentProdTotal, previousProdTotal),
    },
    rejections: {
      current: currentRejTotal,
      previous: previousRejTotal,
      ...diff(currentRejTotal, previousRejTotal),
    },
  };
}

/**
 * Reads: productionRecords, rejectionRecords
 * Compares the last 30 calendar days against the 30 calendar days before
 * that (rolling window — see compareWeeks note on convention; this
 * codebase has no existing calendar-month reporting boundary to match).
 */
export async function compareMonths(): Promise<{
  production: ComparisonResult<number>;
  rejections: ComparisonResult<number>;
}> {
  const today = calendarDayKeyFor(Date.now());
  const currentStart = addDays(today, -29);
  const previousEnd = addDays(currentStart, -1);
  const previousStart = addDays(previousEnd, -29);

  const [currentProd, previousProd, currentRej, previousRej] = await Promise.all([
    getProductionByDateRange(currentStart, today),
    getProductionByDateRange(previousStart, previousEnd),
    getRejectionsByDateRange(currentStart, today),
    getRejectionsByDateRange(previousStart, previousEnd),
  ]);

  const currentProdTotal = sumProduced(currentProd);
  const previousProdTotal = sumProduced(previousProd);
  const currentRejTotal = sumRejected(currentRej);
  const previousRejTotal = sumRejected(previousRej);

  return {
    production: {
      current: currentProdTotal,
      previous: previousProdTotal,
      ...diff(currentProdTotal, previousProdTotal),
    },
    rejections: {
      current: currentRejTotal,
      previous: previousRejTotal,
      ...diff(currentRejTotal, previousRejTotal),
    },
  };
}