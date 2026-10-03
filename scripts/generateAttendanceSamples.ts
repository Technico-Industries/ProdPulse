// Temporary August 2026 attendance samples. Writes only to the existing
// attendanceRecords collection using the app's deterministic document IDs.
// Cleanup selects documents with the exact sampleDataTag only.
//
// Generate:
// npx tsx -e "import('./scripts/generateAttendanceSamples').then(m => m.generateAttendanceSamples()).catch(e => { console.error(e); process.exitCode = 1; })"
//
// Clean up only these samples:
// npx tsx -e "import('./scripts/generateAttendanceSamples').then(m => m.cleanupAttendanceSamples()).catch(e => { console.error(e); process.exitCode = 1; })"

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applicationDefault, cert, getApps, initializeApp } from 'firebase-admin/app';
import type { App } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import type { DocumentData, DocumentReference } from 'firebase-admin/firestore';
import { DIVISIONS, PLANTS, WORKSHOPS } from '../src/constants/lineOptions';

const SAMPLE_DATA_TAG = 'attendance-sample-august-2026-v1';
const YEAR = 2026;
const MONTH = 8;
const DAYS_IN_MONTH = 31;
const FIRESTORE_BATCH_LIMIT = 450;
const READ_CHUNK_SIZE = 400;
const SHIFTS = ['A', 'B'] as const;
type Shift = (typeof SHIFTS)[number];
type AttendanceStatus = 'present' | 'absent' | 'leave';

type Operator = {
  id: string;
  name: string;
  code: string;
  plant: string;
  workshop: string;
  division: string;
  stableShift: Shift;
  index: number;
};

type AttendanceSample = {
  operatorId: string;
  operatorName: string;
  operatorCode: string;
  plant: string;
  workshop: string;
  division: string;
  date: string;
  shift: Shift;
  status: AttendanceStatus;
  submittedBy: {
    uid: null;
    name: 'Sample Data Generator';
  };
  createdAt: Timestamp;
  sampleDataTag: string;
};

function resolveCredential() {
  const envPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (envPath && fs.existsSync(envPath)) {
    console.log(`[attendanceSamples] Using service account from environment path: ${envPath}`);
    return cert(JSON.parse(fs.readFileSync(envPath, 'utf8')));
  }

  const localPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'serviceAccountKey.json');
  if (fs.existsSync(localPath)) {
    console.log(`[attendanceSamples] Using service account from ${localPath}`);
    return cert(JSON.parse(fs.readFileSync(localPath, 'utf8')));
  }

  console.log('[attendanceSamples] No service account file found; using application default credentials.');
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

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function readOperator(id: string, data: DocumentData, index: number): Operator {
  const name = readString(data.name);
  const code = readString(data.code);
  const plant = readString(data.plant);
  const workshop = readString(data.workshop);
  if (!name || !code || !plant || !workshop) {
    throw new Error(`[attendanceSamples] operators/${id} is missing a required name, code, plant, or workshop.`);
  }
  if (!isAppValue(plant, PLANTS) || !isAppValue(workshop, WORKSHOPS)) {
    throw new Error(`[attendanceSamples] operators/${id} has a plant or workshop value not used by the app.`);
  }

  const operatorHash = hashString(id);
  return {
    id,
    name,
    code,
    plant,
    workshop,
    division: DIVISIONS[operatorHash % DIVISIONS.length],
    stableShift: SHIFTS[(operatorHash >>> 8) % SHIFTS.length],
    index,
  };
}

async function loadOperators(): Promise<Operator[]> {
  const snapshot = await db.collection('operators').get();
  if (snapshot.empty) {
    throw new Error('[attendanceSamples] No existing operators found; refusing to generate sample records.');
  }

  const operators = snapshot.docs.map((document, index) =>
    readOperator(document.id, document.data(), index),
  );
  console.log(`[attendanceSamples] Found ${operators.length} existing operator(s).`);
  return operators;
}

function dateForDay(day: number): string {
  return `${YEAR}-${String(MONTH).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function createdAtFor(date: string): Timestamp {
  const hour = randomInt(7, 19);
  const minute = randomInt(0, 59);
  const second = randomInt(0, 59);
  return Timestamp.fromDate(new Date(
    `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}+05:30`,
  ));
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function hasPlannedLeave(operator: Operator, day: number): boolean {
  if (operator.index % 13 !== 0) return false;
  const startDay = 5 + ((operator.index * 7) % 21);
  const duration = 2 + (operator.index % 3);
  return day >= startDay && day < startDay + duration;
}

function attendanceStatus(operator: Operator, day: number): AttendanceStatus {
  if (hasPlannedLeave(operator, day)) return 'leave';

  const highAbsenceDay = day === 8 || day === 22;
  const roll = Math.random();
  if (roll < (highAbsenceDay ? 0.085 : 0.05)) return 'absent';
  if (roll < (highAbsenceDay ? 0.125 : 0.095)) return 'leave';
  return 'present';
}

function shiftFor(operator: Operator, day: number): Shift {
  const occasionalShiftChange = (operator.index % 9 === 3 && day === 16)
    || (operator.index % 11 === 5 && day === 27);
  if (!occasionalShiftChange) return operator.stableShift;
  return operator.stableShift === 'A' ? 'B' : 'A';
}

function createRecord(operator: Operator, day: number): AttendanceSample {
  const date = dateForDay(day);
  return {
    operatorId: operator.id,
    operatorName: operator.name,
    operatorCode: operator.code,
    plant: operator.plant,
    workshop: operator.workshop,
    division: operator.division,
    date,
    shift: shiftFor(operator, day),
    status: attendanceStatus(operator, day),
    submittedBy: {
      uid: null,
      name: 'Sample Data Generator',
    },
    createdAt: createdAtFor(date),
    sampleDataTag: SAMPLE_DATA_TAG,
  };
}

function recordRef(operatorId: string, date: string): DocumentReference {
  return db.collection('attendanceRecords').doc(`${operatorId}_${date}`);
}

async function getExistingDocuments(refs: DocumentReference[]): Promise<Map<string, DocumentData>> {
  const existing = new Map<string, DocumentData>();
  for (let offset = 0; offset < refs.length; offset += READ_CHUNK_SIZE) {
    const snapshots = await db.getAll(...refs.slice(offset, offset + READ_CHUNK_SIZE));
    for (const snapshot of snapshots) {
      if (snapshot.exists) existing.set(snapshot.id, snapshot.data() ?? {});
    }
  }
  return existing;
}

async function writeBatched(
  records: Array<{ ref: DocumentReference; data: AttendanceSample }>,
): Promise<number> {
  let created = 0;
  let batchNumber = 0;
  for (let offset = 0; offset < records.length; offset += FIRESTORE_BATCH_LIMIT) {
    const chunk = records.slice(offset, offset + FIRESTORE_BATCH_LIMIT);
    const batch = db.batch();
    for (const record of chunk) {
      batch.create(record.ref, record.data);
    }
    await batch.commit();
    created += chunk.length;
    batchNumber += 1;
    console.log(`[attendanceSamples] Wrote batch ${batchNumber}: ${created}/${records.length} records.`);
  }
  return created;
}

export async function generateAttendanceSamples(): Promise<{
  operatorsFound: number;
  datesProcessed: number;
  created: number;
  skipped: number;
  totalRecords: number;
}> {
  const operators = await loadOperators();
  const planned: Array<{ ref: DocumentReference; data: AttendanceSample }> = [];
  for (let day = 1; day <= DAYS_IN_MONTH; day += 1) {
    const date = dateForDay(day);
    for (const operator of operators) {
      planned.push({
        ref: recordRef(operator.id, date),
        data: createRecord(operator, day),
      });
    }
  }

  const existingDocuments = await getExistingDocuments(planned.map((record) => record.ref));
  const recordsToCreate: typeof planned = [];
  let skipped = 0;
  let taggedSampleSkipped = 0;
  let protectedRecordSkipped = 0;
  for (const record of planned) {
    const existing = existingDocuments.get(record.ref.id);
    if (existing) {
      skipped += 1;
      if (existing.sampleDataTag === SAMPLE_DATA_TAG) taggedSampleSkipped += 1;
      else protectedRecordSkipped += 1;
      continue;
    }
    recordsToCreate.push(record);
  }
  console.log(
    `[attendanceSamples] Skipped ${skipped} existing record(s): `
    + `${taggedSampleSkipped} already-tagged sample(s), ${protectedRecordSkipped} protected record(s).`,
  );

  const created = await writeBatched(recordsToCreate);
  const totalRecords = operators.length * DAYS_IN_MONTH;
  console.log(
    `[attendanceSamples] Complete: operators=${operators.length}; datesProcessed=${DAYS_IN_MONTH}; `
    + `created=${created}; skipped=${skipped}; totalRecords=${totalRecords}; `
    + `sampleDataTag=${SAMPLE_DATA_TAG}.`,
  );
  return {
    operatorsFound: operators.length,
    datesProcessed: DAYS_IN_MONTH,
    created,
    skipped,
    totalRecords,
  };
}

export async function cleanupAttendanceSamples(): Promise<number> {
  console.log(
    `[attendanceSamples] Deleting only attendanceRecords where sampleDataTag == ${SAMPLE_DATA_TAG}...`,
  );
  const snapshot = await db.collection('attendanceRecords')
    .where('sampleDataTag', '==', SAMPLE_DATA_TAG)
    .get();
  if (snapshot.empty) {
    console.log('[attendanceSamples] No matching tagged sample documents found.');
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
    console.log(`[attendanceSamples] Deleted batch ${batchNumber}: ${deleted}/${snapshot.size} records.`);
  }
  console.log(`[attendanceSamples] Cleanup complete: deleted ${deleted} tagged sample document(s).`);
  return deleted;
}
