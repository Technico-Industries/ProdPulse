// Temporary August 2026 Plan vs Actual sample data.
//
// Generate:
// npx tsx -e "import('./scripts/generatePlanVsActualSamples').then(m => m.generatePlanVsActualSamples()).catch(e => { console.error(e); process.exitCode = 1; })"
//
// Delete only these tagged samples:
// npx tsx -e "import('./scripts/generatePlanVsActualSamples').then(m => m.cleanupPlanVsActualSamples()).catch(e => { console.error(e); process.exitCode = 1; })"
//
// Firebase Admin credentials use the same resolution as
// scripts/generateRejectionSamples.ts. Never commit service-account credentials.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applicationDefault, cert, getApps, initializeApp } from 'firebase-admin/app';
import type { App } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import type { DocumentData } from 'firebase-admin/firestore';
import { DIVISIONS, PLANTS, WORKSHOPS } from '../src/constants/lineOptions';

const SAMPLE_DATA_TAG = 'plan-vs-actual-sample-august-2026-v1';
const START_DATE = '2026-08-01';
const DAYS_IN_AUGUST_2026 = 31;
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

type PlanVsActualSample = {
  date: string;
  plant: string;
  workshop: string;
  division: string | null;
  shift: Shift;
  lineId: string;
  lineName: string;
  planned: number;
  actual: number;
  loss: number;
  productionPct: number;
  submittedBy: string;
  submittedByUid: null;
  createdAt: Timestamp;
  sampleDataTag: string;
};

function resolveCredential() {
  const envPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (envPath && fs.existsSync(envPath)) {
    console.log(`[planVsActualSamples] Using service account from env path: ${envPath}`);
    return cert(JSON.parse(fs.readFileSync(envPath, 'utf8')));
  }

  const localPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'serviceAccountKey.json');
  if (fs.existsSync(localPath)) {
    console.log(`[planVsActualSamples] Using service account from ${localPath}`);
    return cert(JSON.parse(fs.readFileSync(localPath, 'utf8')));
  }

  console.log('[planVsActualSamples] No service account file found; using application default credentials.');
  return applicationDefault();
}

let app: App;
if (!getApps().length) {
  app = initializeApp({ credential: resolveCredential() });
} else {
  app = getApps()[0]!;
}
const db = getFirestore(app);

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readProductionLine(id: string, data: DocumentData): ProductionLine | null {
  const lineName = nonEmptyString(data.lineName ?? data.lineNumber ?? data.name);
  const plant = nonEmptyString(data.plant ?? data.location);
  const workshop = nonEmptyString(data.workshop ?? data.shop);

  if (!lineName || !plant || !workshop) {
    console.warn(`[planVsActualSamples] Skipping productionLines/${id}: missing line name, plant, or workshop.`);
    return null;
  }
  if (!PLANTS.some((option) => option === plant)) {
    console.warn(`[planVsActualSamples] Skipping productionLines/${id}: plant is not in PLANTS (${plant}).`);
    return null;
  }
  if (!WORKSHOPS.some((option) => option === workshop)) {
    console.warn(`[planVsActualSamples] Skipping productionLines/${id}: workshop is not in WORKSHOPS (${workshop}).`);
    return null;
  }

  let division: string | null = null;
  if (workshop.toLowerCase().includes('assembly')) {
    division = nonEmptyString(data.division ?? data.unit);
    if (!division || !DIVISIONS.some((option) => option === division)) {
      console.warn(`[planVsActualSamples] Skipping productionLines/${id}: Assembly division is missing or not in DIVISIONS.`);
      return null;
    }
  }

  return { id, lineName, plant, workshop, division };
}

async function loadProductionLines(): Promise<ProductionLine[]> {
  const snapshot = await db.collection('productionLines').get();
  const lines = snapshot.docs
    .map((document) => readProductionLine(document.id, document.data()))
    .filter((line): line is ProductionLine => line !== null);
  if (lines.length === 0) throw new Error('[planVsActualSamples] No valid existing productionLines documents found.');
  console.log(`[planVsActualSamples] Loaded ${lines.length} valid existing production line(s).`);
  return lines;
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function augustDate(day: number): string {
  return `${START_DATE.slice(0, 8)}${String(day).padStart(2, '0')}`;
}

function linePlannedBaseline(lineId: string): number {
  let hash = 0;
  for (let index = 0; index < lineId.length; index += 1) {
    hash = (hash * 31 + lineId.charCodeAt(index)) >>> 0;
  }
  return 500 + (hash % 901);
}

function choosePerformanceRate(): number {
  const roll = Math.random();
  if (roll < 0.12) return randomInt(600, 750) / 10;
  if (roll < 0.24) return randomInt(950, 1020) / 10;
  return randomInt(750, 999) / 10;
}

function createRecord(line: ProductionLine, date: string, shift: Shift): PlanVsActualSample {
  const shiftFactor = shift === 'A' ? 1 : 0.88;
  const planned = Math.max(
    300,
    Math.min(1500, Math.round(linePlannedBaseline(line.id) * shiftFactor * (randomInt(92, 108) / 100))),
  );
  const actual = Math.max(0, Math.round(planned * choosePerformanceRate() / 100));
  const loss = Math.max(0, planned - actual);
  const productionPct = planned > 0
    ? Math.round((actual / planned) * 1000) / 10
    : 0;
  const hour = randomInt(7, 18);
  const minute = randomInt(0, 59);
  const second = randomInt(0, 59);
  const createdAt = Timestamp.fromDate(new Date(
    `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}.000Z`,
  ));

  return {
    date,
    plant: line.plant,
    workshop: line.workshop,
    division: line.division,
    shift,
    lineId: line.id,
    lineName: line.lineName,
    planned,
    actual,
    loss,
    productionPct,
    submittedBy: 'Sample Data Generator',
    submittedByUid: null,
    createdAt,
    sampleDataTag: SAMPLE_DATA_TAG,
  };
}

function sampleKey(date: string, lineId: string, shift: Shift): string {
  return `${date}\u0000${lineId}\u0000${shift}`;
}

async function loadExistingSampleKeys(): Promise<Set<string>> {
  const snapshot = await db.collection('planVsActualRecords')
    .where('sampleDataTag', '==', SAMPLE_DATA_TAG)
    .get();
  const existingKeys = new Set<string>();
  for (const document of snapshot.docs) {
    const data = document.data();
    const date = nonEmptyString(data.date);
    const lineId = nonEmptyString(data.lineId);
    const shift = data.shift;
    if (date && lineId && (shift === 'A' || shift === 'B')) {
      existingKeys.add(sampleKey(date, lineId, shift));
    }
  }
  console.log(`[planVsActualSamples] Found ${existingKeys.size} existing tagged line/date/shift record(s).`);
  return existingKeys;
}

async function writeBatched(records: PlanVsActualSample[]): Promise<number> {
  let created = 0;
  let batchNumber = 0;
  for (let offset = 0; offset < records.length; offset += FIRESTORE_BATCH_LIMIT) {
    const chunk = records.slice(offset, offset + FIRESTORE_BATCH_LIMIT);
    const batch = db.batch();
    for (const record of chunk) {
      batch.set(db.collection('planVsActualRecords').doc(), record);
    }
    await batch.commit();
    created += chunk.length;
    batchNumber += 1;
    console.log(`[planVsActualSamples] Wrote batch ${batchNumber}: ${created}/${records.length} records.`);
  }
  return created;
}

export async function generatePlanVsActualSamples(): Promise<{ created: number; skipped: number }> {
  const lines = await loadProductionLines();
  const existingKeys = await loadExistingSampleKeys();
  const records: PlanVsActualSample[] = [];
  let skipped = 0;

  for (let day = 1; day <= DAYS_IN_AUGUST_2026; day += 1) {
    const date = augustDate(day);
    for (const line of lines) {
      for (const shift of SHIFTS) {
        const key = sampleKey(date, line.id, shift);
        if (existingKeys.has(key)) {
          skipped += 1;
          continue;
        }
        records.push(createRecord(line, date, shift));
      }
    }
  }

  const created = await writeBatched(records);
  console.log(`[planVsActualSamples] Complete: created ${created} record(s); skipped ${skipped} existing record(s).`);
  return { created, skipped };
}

export async function cleanupPlanVsActualSamples(): Promise<number> {
  console.log(
    `[planVsActualSamples] Deleting only planVsActualRecords where sampleDataTag == ${SAMPLE_DATA_TAG}...`,
  );
  const snapshot = await db.collection('planVsActualRecords')
    .where('sampleDataTag', '==', SAMPLE_DATA_TAG)
    .get();
  if (snapshot.empty) {
    console.log('[planVsActualSamples] No matching tagged sample documents found.');
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
    console.log(`[planVsActualSamples] Deleted batch ${batchNumber}: ${deleted}/${snapshot.docs.length} records.`);
  }
  console.log(`[planVsActualSamples] Cleanup complete: deleted ${deleted} document(s).`);
  return deleted;
}
