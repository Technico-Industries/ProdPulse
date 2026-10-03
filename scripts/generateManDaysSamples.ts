// Temporary August 2026 Man-Days sample data.
//
// Generate:
// npx tsx -e "import('./scripts/generateManDaysSamples').then(m => m.generateManDaysSamples()).catch(e => { console.error(e); process.exitCode = 1; })"
//
// Delete only these tagged samples:
// npx tsx -e "import('./scripts/generateManDaysSamples').then(m => m.cleanupManDaysSamples()).catch(e => { console.error(e); process.exitCode = 1; })"
//
// Uses the same Firebase Admin credential resolution as
// scripts/generateRejectionSamples.ts. Never commit service-account credentials.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applicationDefault, cert, getApps, initializeApp } from 'firebase-admin/app';
import type { App } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { DIVISIONS, PLANTS, WORKSHOPS } from '../src/constants/lineOptions';

const SAMPLE_DATA_TAG = 'mandays-sample-august-2026-v1';
const YEAR = 2026;
const MONTH = 8;
const DAYS_IN_MONTH = 31;
const FIRESTORE_BATCH_LIMIT = 450;
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

type ManDaysRecord = {
  plant: string;
  workshop: string;
  division: string;
  dateISO: string;
  dateDisplay: string;
  dayOfWeek: string;
  month: string;
  present: number;
  absent: number;
  onLeave: number;
  totalPresent: number;
  remarks: string;
  submittedBy: string;
  submittedByUid: null;
  createdAt: Timestamp;
  sampleDataTag: string;
};

function resolveCredential() {
  const envPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (envPath && fs.existsSync(envPath)) {
    console.log(`[manDaysSamples] Using service account from env path: ${envPath}`);
    return cert(JSON.parse(fs.readFileSync(envPath, 'utf8')));
  }

  const localPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'serviceAccountKey.json');
  if (fs.existsSync(localPath)) {
    console.log(`[manDaysSamples] Using service account from ${localPath}`);
    return cert(JSON.parse(fs.readFileSync(localPath, 'utf8')));
  }

  console.log('[manDaysSamples] No service account file found; using application default credentials.');
  return applicationDefault();
}

let app: App;
if (!getApps().length) {
  app = initializeApp({ credential: resolveCredential() });
} else {
  app = getApps()[0]!;
}
const db = getFirestore(app);

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function dateISOFor(day: number): string {
  return `${YEAR}-${String(MONTH).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function createRecord(plant: string, workshop: string, division: string, day: number): ManDaysRecord {
  const dateISO = dateISOFor(day);
  const weekday = new Date(`${dateISO}T00:00:00.000Z`).getUTCDay();
  const weekendAdjustment = weekday === 0 ? -6 : weekday === 6 ? -3 : 0;
  const lowManpowerDay = Math.random() < 0.07;
  const basePresent = randomInt(29, 53);
  const present = Math.max(
    15,
    Math.min(60, basePresent + randomInt(-7, 7) + weekendAdjustment - (lowManpowerDay ? randomInt(9, 16) : 0)),
  );
  const absent = randomInt(0, 6);
  const onLeave = randomInt(0, 5);
  const hour = randomInt(7, 17);
  const minute = randomInt(0, 59);
  const second = randomInt(0, 59);
  const createdAt = Timestamp.fromDate(
    new Date(`${dateISO}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}.000Z`),
  );

  let remarks = 'Normal manpower';
  if (lowManpowerDay || present < 24) remarks = 'Reduced manpower';
  else if (onLeave >= 4) remarks = `${onLeave} operators on leave`;
  else if (absent >= 4) remarks = 'Higher absenteeism';
  else if (weekendAdjustment < 0) remarks = 'Weekend shift coverage';
  else if (onLeave > 0 && absent > 0) remarks = 'Manpower adjusted for leave and absence';

  return {
    plant,
    workshop,
    division,
    dateISO,
    dateDisplay: `${String(day).padStart(2, '0')}-${String(MONTH).padStart(2, '0')}-${String(YEAR).slice(-2)}`,
    dayOfWeek: DAY_NAMES[weekday],
    month: `${YEAR}-${String(MONTH).padStart(2, '0')}`,
    present,
    absent,
    onLeave,
    totalPresent: present,
    remarks,
    submittedBy: 'Sample Data Generator',
    submittedByUid: null,
    createdAt,
    sampleDataTag: SAMPLE_DATA_TAG,
  };
}

function createAllRecords(): ManDaysRecord[] {
  const records: ManDaysRecord[] = [];
  for (const plant of PLANTS) {
    for (const workshop of WORKSHOPS) {
      for (const division of DIVISIONS) {
        for (let day = 1; day <= DAYS_IN_MONTH; day += 1) {
          records.push(createRecord(plant, workshop, division, day));
        }
      }
    }
  }
  return records;
}

async function writeBatched(records: ManDaysRecord[]): Promise<number> {
  let created = 0;
  let batchNumber = 0;
  for (let offset = 0; offset < records.length; offset += FIRESTORE_BATCH_LIMIT) {
    const chunk = records.slice(offset, offset + FIRESTORE_BATCH_LIMIT);
    const batch = db.batch();
    for (const record of chunk) {
      batch.set(db.collection('manDaysRecords').doc(), record);
    }
    await batch.commit();
    created += chunk.length;
    batchNumber += 1;
    console.log(`[manDaysSamples] Wrote batch ${batchNumber}: ${created}/${records.length} records.`);
  }
  return created;
}

export async function generateManDaysSamples(): Promise<number> {
  const records = createAllRecords();
  console.log(
    `[manDaysSamples] Generating ${records.length} records for ${YEAR}-${String(MONTH).padStart(2, '0')}-01 through `
    + `${YEAR}-${String(MONTH).padStart(2, '0')}-${DAYS_IN_MONTH}, using ${PLANTS.length} plants, `
    + `${WORKSHOPS.length} workshops, and ${DIVISIONS.length} divisions.`,
  );
  const created = await writeBatched(records);
  console.log(`[manDaysSamples] Created ${created} document(s) in manDaysRecords.`);
  return created;
}

export async function cleanupManDaysSamples(): Promise<number> {
  console.log(
    `[manDaysSamples] Deleting only manDaysRecords where sampleDataTag == ${SAMPLE_DATA_TAG}...`,
  );
  const snapshot = await db.collection('manDaysRecords')
    .where('sampleDataTag', '==', SAMPLE_DATA_TAG)
    .get();
  if (snapshot.empty) {
    console.log('[manDaysSamples] No matching tagged sample documents found.');
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
    console.log(`[manDaysSamples] Deleted batch ${batchNumber}: ${deleted}/${snapshot.docs.length} records.`);
  }
  console.log(`[manDaysSamples] Cleanup complete: deleted ${deleted} document(s).`);
  return deleted;
}
