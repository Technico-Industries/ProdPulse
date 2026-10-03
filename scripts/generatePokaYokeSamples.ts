// Temporary August 2026 Poka Yoke sample data.
//
// Generate:
// npx tsx -e "import('./scripts/generatePokaYokeSamples').then(m => m.generatePokaYokeSamples()).catch(e => { console.error(e); process.exitCode = 1; })"
//
// Delete only these tagged samples:
// npx tsx -e "import('./scripts/generatePokaYokeSamples').then(m => m.cleanupPokaYokeSamples()).catch(e => { console.error(e); process.exitCode = 1; })"
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

const SAMPLE_DATA_TAG = 'poka-yoke-sample-august-2026-v1';
const DAYS_IN_AUGUST_2026 = 31;
const RECORDS_PER_DAY = 2;
const FIRESTORE_BATCH_LIMIT = 450;

type ProductionLine = {
  id: string;
  lineName: string;
  lineNo: string;
  plant: string;
  workshop: string;
  division: string;
  parts: string[];
};

type PokaYokeSample = {
  sNo: number;
  plant: string;
  workshop: string;
  division: string;
  lineId: string;
  lineName: string;
  lineNo: string;
  partsName: string;
  model: string;
  pokaYokeNo: string;
  pokaYokeDetails: string;
  problem: string;
  rootCause: string;
  actionPlan: string;
  responsibility: string;
  targetDate: string;
  status: 'Open' | 'In Progress' | 'Closed';
  submittedBy: string;
  submittedByUid: null;
  createdAt: Timestamp;
  sampleDataTag: string;
};

type Improvement = {
  problem: string;
  rootCause: string;
  actionPlan: string;
  pokaYokeDetails: string;
  responsibility: string;
};

const IMPROVEMENTS: Improvement[] = [
  {
    problem: 'A component could be loaded in the reversed orientation and still reach the next assembly step.',
    rootCause: 'The nest accepted the component in either orientation and relied on a visual check.',
    actionPlan: 'Modify the nest with an asymmetric locating pin and add a first-piece orientation check.',
    pokaYokeDetails: 'The offset locating pin allows the component to seat only in its specified orientation.',
    responsibility: 'Tool Room',
  },
  {
    problem: 'A required fastener could be missed during the manual assembly sequence.',
    rootCause: 'Fastener presence was not sensed before the station cycle was enabled.',
    actionPlan: 'Install a fastener-presence sensor linked to the station cycle interlock.',
    pokaYokeDetails: 'The interlock confirms the required fastener positions before allowing the next cycle.',
    responsibility: 'Manufacturing Engineering',
  },
  {
    problem: 'Similar left- and right-hand parts could be selected together from the same staging area.',
    rootCause: 'Part identification depended on the operator reading small labels on adjacent bins.',
    actionPlan: 'Add keyed part-specific bins and barcode confirmation at the point of use.',
    pokaYokeDetails: 'The keyed bin and scanner confirmation prevent a mismatched part from being released to assembly.',
    responsibility: 'Production',
  },
  {
    problem: 'A component could be partially inserted while appearing seated from the operator position.',
    rootCause: 'The fixture had no positive stop or confirmation of full insertion depth.',
    actionPlan: 'Add a depth stop and a limit switch to confirm full insertion before fastening.',
    pokaYokeDetails: 'The limit switch enables fastening only when the component reaches the defined depth stop.',
    responsibility: 'Process Engineering',
  },
  {
    problem: 'The wrong model variant could be loaded after a changeover between similar assemblies.',
    rootCause: 'The changeover check was manual and did not validate the model-specific fixture setup.',
    actionPlan: 'Add model-specific fixture coding with a scanner check at changeover.',
    pokaYokeDetails: 'A scanned model code is matched to the fixture ID before the station can start.',
    responsibility: 'Quality',
  },
  {
    problem: 'A locating clamp could be left open, allowing the part to shift during the operation.',
    rootCause: 'The clamp position was not monitored by the machine control.',
    actionPlan: 'Fit a clamp-closed sensor and add it to the start permissive.',
    pokaYokeDetails: 'The machine cycle remains inhibited until the clamp sensor confirms a locked position.',
    responsibility: 'Maintenance',
  },
  {
    problem: 'A bolt could be started at an angle and cross-thread during the tightening step.',
    rootCause: 'The guide sleeve did not constrain the fastener to the correct entry axis.',
    actionPlan: 'Install a close-guided fastener sleeve and verify the torque tool sequence.',
    pokaYokeDetails: 'The sleeve holds the bolt coaxial to the threaded hole during initial engagement.',
    responsibility: 'Manufacturing Engineering',
  },
  {
    problem: 'A part could be presented to the fixture before all locating faces were clear.',
    rootCause: 'The fixture had no feature to reject an obstruction or incomplete seating condition.',
    actionPlan: 'Add a seating confirmation probe and a clear-down check to the cycle logic.',
    pokaYokeDetails: 'The probe confirms all reference faces are seated before the process can proceed.',
    responsibility: 'Process Engineering',
  },
  {
    problem: 'An assembly could proceed with a connector inserted into the adjacent position.',
    rootCause: 'The connector positions were close together and had no position-specific keying.',
    actionPlan: 'Add a keyed connector guide and a position-confirmation sensor.',
    pokaYokeDetails: 'The guide accepts only the specified connector orientation and the sensor verifies its position.',
    responsibility: 'Quality',
  },
  {
    problem: 'A fixture could retain a previous component and allow the next cycle to begin.',
    rootCause: 'The station did not confirm part removal after the completed cycle.',
    actionPlan: 'Add a part-clear sensor and include the signal in the cycle-start interlock.',
    pokaYokeDetails: 'The next cycle is enabled only after the sensor confirms the previous part is removed.',
    responsibility: 'Maintenance',
  },
  {
    problem: 'A spacer could be omitted when two visually similar variants were built consecutively.',
    rootCause: 'Spacer presence was checked by memory rather than a physical verification feature.',
    actionPlan: 'Add a spacer-presence probe and provide separate identified spacer locations.',
    pokaYokeDetails: 'The probe detects the spacer at the required interface before the fastening operation.',
    responsibility: 'Supervisor',
  },
  {
    problem: 'A weld fixture could be loaded with the bracket against the wrong datum face.',
    rootCause: 'The fixture allowed a near-symmetric part to sit against either datum.',
    actionPlan: 'Add a non-symmetric locator and a fixture seating sensor.',
    pokaYokeDetails: 'The locator blocks reversed loading and the sensor confirms the bracket is fully seated.',
    responsibility: 'Tool Room',
  },
];

function resolveCredential() {
  const envPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (envPath && fs.existsSync(envPath)) {
    console.log(`[pokaYokeSamples] Using service account from env path: ${envPath}`);
    return cert(JSON.parse(fs.readFileSync(envPath, 'utf8')));
  }

  const localPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'serviceAccountKey.json');
  if (fs.existsSync(localPath)) {
    console.log(`[pokaYokeSamples] Using service account from ${localPath}`);
    return cert(JSON.parse(fs.readFileSync(localPath, 'utf8')));
  }

  console.log('[pokaYokeSamples] No service account file found; using application default credentials.');
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
  const lineNo = nonEmptyString(data.lineNo ?? data.lineNumber) ?? '';
  const plant = nonEmptyString(data.plant ?? data.location);
  const workshop = nonEmptyString(data.workshop ?? data.shop);
  const division = nonEmptyString(data.division ?? data.unit);
  const rawParts: unknown = data.parts;
  const parts = Array.isArray(rawParts)
    ? rawParts.map((part: unknown) => {
        if (typeof part !== 'object' || part === null) return null;
        const record = part as Record<string, unknown>;
        return nonEmptyString(record.name ?? record.partName);
      }).filter((part): part is string => part !== null)
    : [];

  if (!lineName || !plant || !workshop || !division || parts.length === 0) {
    console.warn(`[pokaYokeSamples] Skipping productionLines/${id}: missing valid location, line name, or configured parts.`);
    return null;
  }
  if (!PLANTS.some((value) => value === plant)) {
    console.warn(`[pokaYokeSamples] Skipping productionLines/${id}: plant is not in PLANTS (${plant}).`);
    return null;
  }
  if (!WORKSHOPS.some((value) => value === workshop)) {
    console.warn(`[pokaYokeSamples] Skipping productionLines/${id}: workshop is not in WORKSHOPS (${workshop}).`);
    return null;
  }
  if (!DIVISIONS.some((value) => value === division)) {
    console.warn(`[pokaYokeSamples] Skipping productionLines/${id}: division is not in DIVISIONS (${division}).`);
    return null;
  }

  return { id, lineName, lineNo, plant, workshop, division, parts };
}

async function loadProductionLines(): Promise<ProductionLine[]> {
  const snapshot = await db.collection('productionLines').get();
  const lines = snapshot.docs
    .map((document) => readProductionLine(document.id, document.data()))
    .filter((line): line is ProductionLine => line !== null);
  if (lines.length === 0) {
    throw new Error('[pokaYokeSamples] No productionLines documents with configured parts and valid app locations were found.');
  }
  console.log(`[pokaYokeSamples] Loaded ${lines.length} valid production line(s) with configured parts.`);
  return lines;
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function formatDate(day: number): string {
  return `${String(day).padStart(2, '0')}-08-2026`;
}

function addDaysToAugustDate(day: number, offset: number): string {
  const date = new Date(Date.UTC(2026, 7, day + offset));
  return `${String(date.getUTCDate()).padStart(2, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${date.getUTCFullYear()}`;
}

function sampleKey(pokaYokeNo: string): string {
  return pokaYokeNo.trim().toUpperCase();
}

function statusFor(day: number, sequence: number): PokaYokeSample['status'] {
  if ((day + sequence) % 5 === 0) return 'Open';
  if ((day + sequence) % 3 === 0) return 'In Progress';
  return 'Closed';
}

function targetDateFor(day: number, status: PokaYokeSample['status'], sequence: number): string {
  if (status === 'Closed') return addDaysToAugustDate(day, randomInt(1, 9));
  const futureWindow = sequence % 3 === 0 ? randomInt(1, 14) : randomInt(0, 8);
  return addDaysToAugustDate(day, futureWindow);
}

function createdAtFor(day: number): Timestamp {
  const hour = randomInt(7, 18);
  const minute = randomInt(0, 59);
  const second = randomInt(0, 59);
  return Timestamp.fromDate(new Date(
    `2026-08-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}.000Z`,
  ));
}

function createRecord(
  line: ProductionLine,
  day: number,
  recordIndex: number,
  sNo: number,
  pokaYokeSequence: number,
): PokaYokeSample {
  const partIndex = (day * 3 + recordIndex * 5) % line.parts.length;
  const partsName = line.parts[partIndex];
  const improvement = IMPROVEMENTS[(day * 5 + recordIndex * 7) % IMPROVEMENTS.length];
  const status = statusFor(day, recordIndex);
  const pokaYokeNo = `PY-${String(pokaYokeSequence).padStart(3, '0')}`;
  return {
    sNo,
    plant: line.plant,
    workshop: line.workshop,
    division: line.division,
    lineId: line.id,
    lineName: line.lineName,
    lineNo: line.lineNo,
    partsName,
    model: partsName,
    pokaYokeNo,
    pokaYokeDetails: improvement.pokaYokeDetails,
    problem: improvement.problem,
    rootCause: improvement.rootCause,
    actionPlan: improvement.actionPlan,
    responsibility: improvement.responsibility,
    targetDate: targetDateFor(day, status, recordIndex),
    status,
    submittedBy: 'Sample Data Generator',
    submittedByUid: null,
    createdAt: createdAtFor(day),
    sampleDataTag: SAMPLE_DATA_TAG,
  };
}

function maximumExistingSerial(records: DocumentData[], field: 'sNo' | 'pokaYokeNo'): number {
  return records.reduce((maximum, record) => {
    if (field === 'sNo') {
      const value = Number(record.sNo);
      return Number.isFinite(value) ? Math.max(maximum, Math.floor(value)) : maximum;
    }
    const match = /^PY-(\d+)$/i.exec(String(record.pokaYokeNo ?? '').trim());
    return match ? Math.max(maximum, Number(match[1])) : maximum;
  }, 0);
}

async function loadExistingRecords(): Promise<{ maxSNo: number; maxPokaYokeSequence: number; taggedNumbers: Set<string> }> {
  const snapshot = await db.collection('pokaYokeRecords').get();
  const records = snapshot.docs.map((document) => document.data());
  const taggedNumbers = new Set(
    records
      .filter((record) => record.sampleDataTag === SAMPLE_DATA_TAG)
      .map((record) => sampleKey(String(record.pokaYokeNo ?? ''))),
  );
  return {
    maxSNo: maximumExistingSerial(records, 'sNo'),
    maxPokaYokeSequence: maximumExistingSerial(records, 'pokaYokeNo'),
    taggedNumbers,
  };
}

function planRecords(
  lines: ProductionLine[],
  maxSNo: number,
  maxPokaYokeSequence: number,
  existingTaggedNumbers: Set<string>,
): { records: PokaYokeSample[]; skipped: number } {
  const records: PokaYokeSample[] = [];
  const seenNumbers = new Set(existingTaggedNumbers);
  let skipped = 0;
  let nextSNo = maxSNo + 1;
  let nextPokaYokeSequence = maxPokaYokeSequence + 1;

  for (let day = 1; day <= DAYS_IN_AUGUST_2026; day += 1) {
    for (let recordIndex = 0; recordIndex < RECORDS_PER_DAY; recordIndex += 1) {
      const lineIndex = (day * RECORDS_PER_DAY + recordIndex - RECORDS_PER_DAY) % lines.length;
      const pokaYokeNo = `PY-${String(nextPokaYokeSequence).padStart(3, '0')}`;
      const key = sampleKey(pokaYokeNo);
      if (seenNumbers.has(key)) {
        skipped += 1;
        nextPokaYokeSequence += 1;
        recordIndex -= 1;
        continue;
      }

      seenNumbers.add(key);
      records.push(createRecord(
        lines[lineIndex],
        day,
        recordIndex,
        nextSNo,
        nextPokaYokeSequence,
      ));
      nextSNo += 1;
      nextPokaYokeSequence += 1;
    }
  }
  return { records, skipped };
}

async function writeBatched(records: PokaYokeSample[]): Promise<number> {
  let created = 0;
  let batchNumber = 0;
  for (let offset = 0; offset < records.length; offset += FIRESTORE_BATCH_LIMIT) {
    const chunk = records.slice(offset, offset + FIRESTORE_BATCH_LIMIT);
    const batch = db.batch();
    for (const record of chunk) {
      batch.set(db.collection('pokaYokeRecords').doc(), record);
    }
    await batch.commit();
    created += chunk.length;
    batchNumber += 1;
    console.log(`[pokaYokeSamples] Wrote batch ${batchNumber}: ${created}/${records.length} records.`);
  }
  return created;
}

export async function generatePokaYokeSamples(): Promise<{ created: number; skipped: number }> {
  const lines = await loadProductionLines();
  const existing = await loadExistingRecords();
  const { records, skipped } = planRecords(
    lines,
    existing.maxSNo,
    existing.maxPokaYokeSequence,
    existing.taggedNumbers,
  );
  console.log(
    `[pokaYokeSamples] Generating records dated 2026-08-01 through 2026-08-31 from `
    + `${lines.length} existing lines with configured parts.`,
  );
  const created = await writeBatched(records);
  console.log(`[pokaYokeSamples] Complete: created ${created} record(s); skipped ${skipped} duplicate number(s).`);
  return { created, skipped };
}

export async function cleanupPokaYokeSamples(): Promise<number> {
  console.log(`[pokaYokeSamples] Deleting only pokaYokeRecords where sampleDataTag == ${SAMPLE_DATA_TAG}...`);
  const snapshot = await db.collection('pokaYokeRecords')
    .where('sampleDataTag', '==', SAMPLE_DATA_TAG)
    .get();
  if (snapshot.empty) {
    console.log('[pokaYokeSamples] No matching tagged sample documents found.');
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
    console.log(`[pokaYokeSamples] Deleted batch ${batchNumber}: ${deleted}/${snapshot.docs.length} records.`);
  }
  console.log(`[pokaYokeSamples] Cleanup complete: deleted ${deleted} document(s).`);
  return deleted;
}
