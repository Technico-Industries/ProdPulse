// Temporary August 2026 rework samples. This script writes only to the
// existing reworkRecords collection and cleanup matches the exact sample tag.
//
// Generate:
// npx tsx -e "import('./scripts/generateReworkSamples').then(m => m.generateReworkSamples()).catch(e => { console.error(e); process.exitCode = 1; })"
//
// Clean up only these samples:
// npx tsx -e "import('./scripts/generateReworkSamples').then(m => m.cleanupReworkSamples()).catch(e => { console.error(e); process.exitCode = 1; })"

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applicationDefault, cert, getApps, initializeApp } from 'firebase-admin/app';
import type { App } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import type { DocumentData } from 'firebase-admin/firestore';
import { DIVISIONS, PLANTS, WORKSHOPS } from '../src/constants/lineOptions';

const SAMPLE_DATA_TAG = 'rework-sample-august-2026-v1';
const START_DATE = '2026-08-01';
const DAY_COUNT = 31;
const DAILY_LINE_COUNT = 5;
const FIRESTORE_BATCH_LIMIT = 450;
const SHIFTS = ['A', 'B'] as const;
type Shift = (typeof SHIFTS)[number];

type ProductionLine = {
  id: string;
  lineName: string;
  plant: string;
  workshop: string;
  division: string | null;
};

type ReworkSample = {
  date: string;
  plant: string;
  workshop: string;
  division: string | null;
  shift: Shift;
  lineId: string;
  lineName: string;
  totalProduction: number;
  reworkCount: number;
  reworkPct: number;
  submittedBy: string;
  submittedByUid: null;
  createdAt: Timestamp;
  sampleDataTag: string;
};

function resolveCredential() {
  const envPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (envPath && fs.existsSync(envPath)) {
    console.log(`[reworkSamples] Using service account from environment path: ${envPath}`);
    return cert(JSON.parse(fs.readFileSync(envPath, 'utf8')));
  }

  const localPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'serviceAccountKey.json');
  if (fs.existsSync(localPath)) {
    console.log(`[reworkSamples] Using service account from ${localPath}`);
    return cert(JSON.parse(fs.readFileSync(localPath, 'utf8')));
  }

  console.log('[reworkSamples] No service account file found; using application default credentials.');
  return applicationDefault();
}

let app: App;
if (!getApps().length) {
  app = initializeApp({ credential: resolveCredential() });
} else {
  app = getApps()[0]!;
}
const db = getFirestore(app);

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isAppValue<T extends readonly string[]>(value: string, values: T): value is T[number] {
  return values.some((option) => option === value);
}

function readProductionLine(id: string, data: DocumentData): ProductionLine | null {
  const lineName = readString(data.lineName ?? data.lineNumber ?? data.name);
  const plant = readString(data.plant ?? data.location);
  const workshop = readString(data.workshop ?? data.shop);
  const rawDivision = readString(data.division ?? data.unit);

  if (!lineName || !plant || !workshop) {
    console.warn(`[reworkSamples] Skipping productionLines/${id}: missing line name, plant, or workshop.`);
    return null;
  }
  if (!isAppValue(plant, PLANTS)) {
    console.warn(`[reworkSamples] Skipping productionLines/${id}: plant is not in PLANTS (${plant}).`);
    return null;
  }
  if (!isAppValue(workshop, WORKSHOPS)) {
    console.warn(`[reworkSamples] Skipping productionLines/${id}: workshop is not in WORKSHOPS (${workshop}).`);
    return null;
  }

  if (rawDivision && !isAppValue(rawDivision, DIVISIONS)) {
    console.warn(`[reworkSamples] Skipping productionLines/${id}: division is not in DIVISIONS (${rawDivision}).`);
    return null;
  }
  if (workshop.toLowerCase().includes('assembly') && !rawDivision) {
    console.warn(`[reworkSamples] Skipping productionLines/${id}: Assembly division is missing.`);
    return null;
  }

  return { id, lineName, plant, workshop, division: rawDivision };
}

async function loadProductionLines(): Promise<ProductionLine[]> {
  const snapshot = await db.collection('productionLines').get();
  const lines = snapshot.docs
    .map((document) => readProductionLine(document.id, document.data()))
    .filter((line): line is ProductionLine => line !== null);
  if (lines.length === 0) {
    throw new Error('[reworkSamples] No valid existing productionLines documents found.');
  }
  console.log(`[reworkSamples] Loaded ${lines.length} valid existing production line(s).`);
  return lines;
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sampleKey(date: string, lineId: string, shift: Shift): string {
  return `${date}\u0000${lineId}\u0000${shift}`;
}

function dateForDay(day: number): string {
  return `${START_DATE.slice(0, 8)}${String(day).padStart(2, '0')}`;
}

function lineProductionBaseline(lineId: string): number {
  let hash = 0;
  for (let index = 0; index < lineId.length; index += 1) {
    hash = (hash * 31 + lineId.charCodeAt(index)) >>> 0;
  }
  return 300 + (hash % 1201);
}

function totalProductionFor(line: ProductionLine, day: number, shift: Shift): number {
  const shiftFactor = shift === 'A' ? 1 : 0.9;
  const dailyFactor = randomInt(90, 110) / 100;
  return Math.max(
    300,
    Math.min(1500, Math.round(lineProductionBaseline(line.id) * shiftFactor * dailyFactor)),
  );
}

function reworkRateFor(day: number, lineIndex: number, shift: Shift): number {
  const isHigherReworkDay = (day + lineIndex + (shift === 'B' ? 1 : 0)) % 11 === 0;
  return isHigherReworkDay
    ? randomInt(50, 80) / 10
    : randomInt(5, 50) / 10;
}

function createdAtFor(date: string): Timestamp {
  const hour = randomInt(7, 18);
  const minute = randomInt(0, 59);
  const second = randomInt(0, 59);
  return Timestamp.fromDate(new Date(
    `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}+05:30`,
  ));
}

function createRecord(line: ProductionLine, date: string, day: number, lineIndex: number, shift: Shift): ReworkSample {
  const totalProduction = totalProductionFor(line, day, shift);
  const reworkCount = Math.min(
    totalProduction,
    Math.max(1, Math.round(totalProduction * reworkRateFor(day, lineIndex, shift) / 100)),
  );

  return {
    date,
    plant: line.plant,
    workshop: line.workshop,
    division: line.division,
    shift,
    lineId: line.id,
    lineName: line.lineName,
    totalProduction,
    reworkCount,
    reworkPct: totalProduction > 0
      ? Math.round((reworkCount / totalProduction) * 1000) / 10
      : 0,
    submittedBy: 'Sample Data Generator',
    submittedByUid: null,
    createdAt: createdAtFor(date),
    sampleDataTag: SAMPLE_DATA_TAG,
  };
}

async function loadExistingSampleKeys(): Promise<Set<string>> {
  const snapshot = await db.collection('reworkRecords')
    .where('sampleDataTag', '==', SAMPLE_DATA_TAG)
    .get();
  const existingKeys = new Set<string>();
  for (const document of snapshot.docs) {
    const data = document.data();
    const date = readString(data.date);
    const lineId = readString(data.lineId);
    const shift = data.shift;
    if (date && lineId && (shift === 'A' || shift === 'B')) {
      existingKeys.add(sampleKey(date, lineId, shift));
    }
  }
  console.log(`[reworkSamples] Found ${existingKeys.size} existing tagged date/line/shift record(s).`);
  return existingKeys;
}

async function writeBatched(records: ReworkSample[]): Promise<number> {
  let created = 0;
  let batchNumber = 0;
  for (let offset = 0; offset < records.length; offset += FIRESTORE_BATCH_LIMIT) {
    const chunk = records.slice(offset, offset + FIRESTORE_BATCH_LIMIT);
    const batch = db.batch();
    for (const record of chunk) {
      batch.set(db.collection('reworkRecords').doc(), record);
    }
    await batch.commit();
    created += chunk.length;
    batchNumber += 1;
    console.log(`[reworkSamples] Wrote batch ${batchNumber}: ${created}/${records.length} records.`);
  }
  return created;
}

export async function generateReworkSamples(): Promise<{ created: number; skipped: number }> {
  const lines = await loadProductionLines();
  const existingKeys = await loadExistingSampleKeys();
  const selectedLineCount = Math.min(DAILY_LINE_COUNT, lines.length);
  const records: ReworkSample[] = [];
  let skipped = 0;

  for (let day = 1; day <= DAY_COUNT; day += 1) {
    const date = dateForDay(day);
    const startIndex = ((day - 1) * selectedLineCount) % lines.length;
    for (let offset = 0; offset < selectedLineCount; offset += 1) {
      const lineIndex = (startIndex + offset) % lines.length;
      const line = lines[lineIndex];
      for (const shift of SHIFTS) {
        const key = sampleKey(date, line.id, shift);
        if (existingKeys.has(key)) {
          skipped += 1;
          continue;
        }
        existingKeys.add(key);
        records.push(createRecord(line, date, day, lineIndex, shift));
      }
    }
  }

  const created = await writeBatched(records);
  console.log(
    `[reworkSamples] Complete: created ${created} record(s); skipped ${skipped} existing record(s); `
    + `dates ${START_DATE} through 2026-08-31; sampleDataTag=${SAMPLE_DATA_TAG}.`,
  );
  return { created, skipped };
}

export async function cleanupReworkSamples(): Promise<number> {
  console.log(`[reworkSamples] Deleting only reworkRecords where sampleDataTag == ${SAMPLE_DATA_TAG}...`);
  const snapshot = await db.collection('reworkRecords')
    .where('sampleDataTag', '==', SAMPLE_DATA_TAG)
    .get();
  if (snapshot.empty) {
    console.log('[reworkSamples] No matching tagged sample documents found.');
    return 0;
  }

  let deleted = 0;
  let batchNumber = 0;
  for (let offset = 0; offset < snapshot.docs.length; offset += FIRESTORE_BATCH_LIMIT) {
    const chunk = snapshot.docs.slice(offset, offset + FIRESTORE_BATCH_LIMIT);
    const batch = db.batch();
    for (const document of chunk) batch.delete(document.ref);
    await batch.commit();
    deleted += chunk.length;
    batchNumber += 1;
    console.log(`[reworkSamples] Deleted batch ${batchNumber}: ${deleted}/${snapshot.docs.length} records.`);
  }
  console.log(`[reworkSamples] Cleanup complete: deleted ${deleted} tagged sample document(s).`);
  return deleted;
}
