// Temporary August 2026 PCS Man Hour sample data.
//
// Generate:
// npx tsx -e "import('./scripts/generatePcsManHourSamples').then(m => m.generatePcsManHourSamples()).catch(e => { console.error(e); process.exitCode = 1; })"
//
// Delete only these tagged samples:
// npx tsx -e "import('./scripts/generatePcsManHourSamples').then(m => m.cleanupPcsManHourSamples()).catch(e => { console.error(e); process.exitCode = 1; })"
//
// Firebase Admin credentials follow the same resolution as
// scripts/generateRejectionSamples.ts. Never commit service-account credentials.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applicationDefault, cert, getApps, initializeApp } from 'firebase-admin/app';
import type { App } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import type { DocumentData } from 'firebase-admin/firestore';
import { DIVISIONS, PLANTS, WORKSHOPS } from '../src/constants/lineOptions';

const SAMPLE_DATA_TAG = 'pcs-man-hour-sample-august-2026-v1';
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

type LineEntry = {
  lineId: string;
  lineName: string;
  shift: Shift;
  production: number;
  hours: number;
  otHours: number;
};

type PcsManHourSample = {
  plant: string;
  workshop: string;
  division: string | null;
  date: string;
  actual: number;
  manPowerTarget: number;
  manPowerActual: number;
  otHours: number;
  manHour: number;
  pcsManHour: number;
  avgHours: number;
  lines: LineEntry[];
  submittedBy: string;
  submittedByUid: null;
  createdAt: Timestamp;
  sampleDataTag: string;
};

type LocationGroup = {
  key: string;
  plant: string;
  workshop: string;
  division: string | null;
  lines: ProductionLine[];
};

function resolveCredential() {
  const envPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (envPath && fs.existsSync(envPath)) {
    console.log(`[pcsManHourSamples] Using service account from env path: ${envPath}`);
    return cert(JSON.parse(fs.readFileSync(envPath, 'utf8')));
  }

  const localPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'serviceAccountKey.json');
  if (fs.existsSync(localPath)) {
    console.log(`[pcsManHourSamples] Using service account from ${localPath}`);
    return cert(JSON.parse(fs.readFileSync(localPath, 'utf8')));
  }

  console.log('[pcsManHourSamples] No service account file found; using application default credentials.');
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

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function groupKey(plant: string, workshop: string, division: string | null): string {
  return JSON.stringify([plant, workshop, division]);
}

function readProductionLine(id: string, data: DocumentData): ProductionLine | null {
  const lineName = nonEmptyString(data.lineName ?? data.lineNumber ?? data.name);
  const plant = nonEmptyString(data.plant ?? data.location);
  const workshop = nonEmptyString(data.workshop ?? data.shop);

  if (!lineName || !plant || !workshop) {
    console.warn(`[pcsManHourSamples] Skipping productionLines/${id}: missing line name, plant, or workshop.`);
    return null;
  }
  if (!PLANTS.some((option) => option === plant)) {
    console.warn(`[pcsManHourSamples] Skipping productionLines/${id}: plant is not in PLANTS (${plant}).`);
    return null;
  }
  if (!WORKSHOPS.some((option) => option === workshop)) {
    console.warn(`[pcsManHourSamples] Skipping productionLines/${id}: workshop is not in WORKSHOPS (${workshop}).`);
    return null;
  }

  let division: string | null = null;
  if (workshop.toLowerCase().includes('assembly')) {
    division = nonEmptyString(data.division ?? data.unit);
    if (!division || !DIVISIONS.some((option) => option === division)) {
      console.warn(`[pcsManHourSamples] Skipping productionLines/${id}: Assembly division is missing or not in DIVISIONS.`);
      return null;
    }
  }

  return { id, lineName, plant, workshop, division };
}

async function loadLocationGroups(): Promise<LocationGroup[]> {
  const snapshot = await db.collection('productionLines').get();
  const groups = new Map<string, LocationGroup>();
  snapshot.docs.forEach((document) => {
    const line = readProductionLine(document.id, document.data());
    if (!line) return;
    const key = groupKey(line.plant, line.workshop, line.division);
    const group = groups.get(key);
    if (group) group.lines.push(line);
    else groups.set(key, { key, plant: line.plant, workshop: line.workshop, division: line.division, lines: [line] });
  });
  const result = Array.from(groups.values());
  if (result.length === 0) throw new Error('[pcsManHourSamples] No valid existing production lines found.');
  console.log(`[pcsManHourSamples] Loaded ${snapshot.size} productionLines document(s) into ${result.length} valid group(s).`);
  return result;
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomFloat(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function augustDate(day: number): string {
  return `${START_DATE.slice(0, 8)}${String(day).padStart(2, '0')}`;
}

function plannedProductionWeight(lineId: string): number {
  let hash = 0;
  for (let index = 0; index < lineId.length; index += 1) {
    hash = (hash * 31 + lineId.charCodeAt(index)) >>> 0;
  }
  return 0.8 + (hash % 401) / 1000;
}

function chooseTargetPcsManHour(): number {
  const roll = Math.random();
  if (roll < 0.12) return randomFloat(8, 13);
  if (roll < 0.25) return randomFloat(31, 40);
  return randomFloat(14, 30);
}

function randomOtHours(): number {
  if (Math.random() < 0.76) return 0;
  return round2(randomFloat(0.25, 2.5));
}

function allocateProduction(total: number, weights: number[]): number[] {
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  const quantities = weights.map((weight) => Math.floor(total * weight / weightTotal));
  let remaining = total - quantities.reduce((sum, quantity) => sum + quantity, 0);
  while (remaining > 0) {
    quantities[randomInt(0, quantities.length - 1)] += 1;
    remaining -= 1;
  }
  return quantities;
}

function createRecord(group: LocationGroup, date: string): PcsManHourSample {
  const manPowerTarget = randomInt(20, 60);
  const manPowerActual = Math.max(
    17,
    Math.min(manPowerTarget, Math.round(manPowerTarget * randomInt(85, 100) / 100)),
  );
  const entries = group.lines.flatMap((line): Omit<LineEntry, 'production'>[] =>
    SHIFTS.map((shift) => {
      const otHours = randomOtHours();
      const baseHours = randomInt(850, 950) / 100;
      return {
        lineId: line.id,
        lineName: line.lineName,
        shift,
        hours: round2(baseHours + otHours),
        otHours,
      };
    }),
  );
  const avgHours = round2(entries.reduce((sum, line) => sum + line.hours, 0) / entries.length);
  const otHours = round2(entries.reduce((sum, line) => sum + line.otHours, 0) / entries.length);
  const manHour = round2(manPowerActual * avgHours);
  const targetRate = chooseTargetPcsManHour();
  const actual = Math.round(targetRate * manHour);
  const weights = entries.map((line) =>
    plannedProductionWeight(line.lineId) * (line.shift === 'A' ? 1 : randomFloat(0.82, 0.96)),
  );
  const quantities = allocateProduction(actual, weights);
  const lines: LineEntry[] = entries.map((line, index) => ({ ...line, production: quantities[index] }));
  const lineProductionTotal = lines.reduce((sum, line) => sum + line.production, 0);
  if (lineProductionTotal !== actual) {
    throw new Error('[pcsManHourSamples] Line production does not match the document actual total.');
  }

  const hour = randomInt(7, 19);
  const minute = randomInt(0, 59);
  const second = randomInt(0, 59);
  const createdAt = Timestamp.fromDate(new Date(
    `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}.000Z`,
  ));

  return {
    plant: group.plant,
    workshop: group.workshop,
    division: group.division,
    date,
    actual,
    manPowerTarget,
    manPowerActual,
    otHours,
    manHour,
    pcsManHour: manHour > 0 ? round2(actual / manHour) : 0,
    avgHours,
    lines,
    submittedBy: 'Sample Data Generator',
    submittedByUid: null,
    createdAt,
    sampleDataTag: SAMPLE_DATA_TAG,
  };
}

function existingRecordKey(
  plant: string,
  workshop: string,
  division: string | null,
  date: string,
): string {
  return JSON.stringify([plant, workshop, division, date]);
}

async function loadExistingSampleKeys(): Promise<Set<string>> {
  const snapshot = await db.collection('pcsManHourRecords')
    .where('sampleDataTag', '==', SAMPLE_DATA_TAG)
    .get();
  const keys = new Set<string>();
  snapshot.docs.forEach((document) => {
    const data = document.data();
    const plant = nonEmptyString(data.plant);
    const workshop = nonEmptyString(data.workshop);
    const date = nonEmptyString(data.date);
    if (plant && workshop && typeof data.date === 'string') {
      keys.add(existingRecordKey(plant, workshop, data.division ?? null, date ?? data.date));
    }
  });
  console.log(`[pcsManHourSamples] Found ${keys.size} existing tagged plant/workshop/division/date record(s).`);
  return keys;
}

async function writeBatched(records: PcsManHourSample[]): Promise<number> {
  let created = 0;
  let batchNumber = 0;
  for (let offset = 0; offset < records.length; offset += FIRESTORE_BATCH_LIMIT) {
    const chunk = records.slice(offset, offset + FIRESTORE_BATCH_LIMIT);
    const batch = db.batch();
    for (const record of chunk) {
      batch.set(db.collection('pcsManHourRecords').doc(), record);
    }
    await batch.commit();
    created += chunk.length;
    batchNumber += 1;
    console.log(`[pcsManHourSamples] Wrote batch ${batchNumber}: ${created}/${records.length} records.`);
  }
  return created;
}

export async function generatePcsManHourSamples(): Promise<{ created: number; skipped: number }> {
  const groups = await loadLocationGroups();
  const existingKeys = await loadExistingSampleKeys();
  const records: PcsManHourSample[] = [];
  let skipped = 0;

  for (const group of groups) {
    for (let day = 1; day <= DAYS_IN_AUGUST_2026; day += 1) {
      const date = augustDate(day);
      const key = existingRecordKey(group.plant, group.workshop, group.division, date);
      if (existingKeys.has(key)) {
        skipped += 1;
        continue;
      }
      records.push(createRecord(group, date));
    }
  }

  const created = await writeBatched(records);
  console.log(`[pcsManHourSamples] Complete: created ${created} record(s); skipped ${skipped} existing record(s).`);
  return { created, skipped };
}

export async function cleanupPcsManHourSamples(): Promise<number> {
  console.log(
    `[pcsManHourSamples] Deleting only pcsManHourRecords where sampleDataTag == ${SAMPLE_DATA_TAG}...`,
  );
  const snapshot = await db.collection('pcsManHourRecords')
    .where('sampleDataTag', '==', SAMPLE_DATA_TAG)
    .get();
  if (snapshot.empty) {
    console.log('[pcsManHourSamples] No matching tagged sample documents found.');
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
    console.log(`[pcsManHourSamples] Deleted batch ${batchNumber}: ${deleted}/${snapshot.docs.length} records.`);
  }
  console.log(`[pcsManHourSamples] Cleanup complete: deleted ${deleted} document(s).`);
  return deleted;
}
