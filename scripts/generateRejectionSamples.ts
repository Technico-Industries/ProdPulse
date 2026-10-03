// Temporary August 2026 rejection samples for the seven pinned HH production
// lines. This script writes only to rejectionRecords and only removes prior
// records carrying the exact sampleDataTag below.
//
// Generate:
// npx ts-node -e "import('./scripts/generateRejectionSamples').then(m => m.generateRejectionSamples()).catch(e => { console.error(e); process.exitCode = 1; })"
//
// Clean up only these samples:
// npx ts-node -e "import('./scripts/generateRejectionSamples').then(m => m.cleanupRejectionSamples()).catch(e => { console.error(e); process.exitCode = 1; })"
//
// Firebase Admin credentials follow the same resolution order as
// scripts/seedHHProduction.ts. Never commit service-account credentials.

import * as fs from 'fs';
import * as path from 'path';
import { applicationDefault, cert, getApps, initializeApp } from 'firebase-admin/app';
import type { App } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import type { DocumentData } from 'firebase-admin/firestore';
import { fileURLToPath } from 'node:url';


const SAMPLE_DATA_TAG = 'quality-sample-august-2026-v1';
const TARGET_LINE_IDS = [
  'gL3QCcVhmHuwv1EAnnhh',
  'TfbJEBtFRBwkE2uX8DtA',
  'Qdb3CN4obWigWG3PE6zW',
  'H7teRfz1mpIhwi5UstRJ',
  'r3L69dDbsmyXjD6z9fFs',
  'noyHXBfUPV3Xl0qgMvjk',
  'J9rhnrgH0qHIyzZiTB7o',
];
const START_DATE = '2026-08-01';
const END_DATE = '2026-08-31';
const FIRESTORE_BATCH_LIMIT = 450;
const MIN_RECORDS = 700;
const MAX_RECORDS = 1700;
const WORKING_TIME_ZONE_OFFSET = '+05:30';

const DEFECTS = [
  'Angle more', 'Angle ng', 'Angleless', 'ANGLEMORE', 'ARM', 'ARM BEND', 'Arm Dent',
  'B GAP', 'B SHORT', 'B Short', 'B.C', 'B.CRACK', 'B.D', 'B.DAMAGE', 'B.GAP', 'B.H.C',
  'B.NG', 'B.P.C', 'B.S', 'B.Short', 'B.SHORT', 'Base plat crack', 'BATCH CODE',
  'BATCH CODE NG', 'Batch code NG', 'BatchCode', 'BC NG', 'BCND', 'BCNG', 'BD', 'BEND',
  'Bend', 'BG', 'BGAP', 'BKT HOLE MISS', 'Blank Short', 'BOLT CRACK', 'BOLT G', 'Bolt G',
  'BOLT GAP', 'BOLT.G', 'BURR', 'Burr', 'Bush damage', 'BUSH G', 'Bush Gap', 'Bush GAP',
  'Bush taper', 'CDNG', 'DENT', 'Dent', 'Dent mark', 'Dia NG', 'Double B/C', 'F.BEND',
  'F.CDNG', 'Femal B shot', 'Femal bend', 'Female Bend', 'Female CDNG', 'FEMALE.B',
  'Fouling', 'FOULING', 'G.O', 'Gap', 'GAUGE OUT', 'Gauge out', 'GO', 'H. Shift', 'H.C',
  'H.D', 'H.GAP', 'H.Gap', 'H.M', 'H.S', 'HC', 'HEAD GAP', 'HM', 'Hole', 'Hole ng',
  'HOLE NG', 'Hole NG', 'Hole Shift', 'HOLE.G', 'HOLE.NG', 'J.M', 'JERK.M', 'LOGO NG',
  'LOGO.M', 'M.L', 'M.NG', 'MALE H.NG', 'ML', 'Movement', 'Movement Large', 'Movement NG',
  'NO-DOT', 'NOGO NG', 'NUT NG', 'P.Dent', 'P.DENT', 'P.NT', 'Part Bend', 'Pin Crack',
  'PIN DENT', 'PIN.BEND', 'PIN.D', 'PIN.H.D', 'plating ng', 'Plating ng', 'Plating NG',
  'PLATTING', 'PLAY', 'Play', 'PNG', 'R.C', 'R.M', 'RC', 'RG', 'RIVET NG', 'Rivit miss',
  'Rivit ng', 'RM Band', 'RNG', 'ROD', 'ROD BEND', 'Rod Gap', 'S.C', 'S.F', 'S.P', 'SC',
  'Scratch', 'Seat Fault', 'SF', 'SP', 'Stopper NG', 'T.D', 'T.M', 'T.NG', 'TD', 'TH',
  'TH D', 'TH.D', 'THD', 'TM', 'Tool Mark', 'W.P', 'W.PIN', 'W.S', 'WARSER MISS',
  'Washer miss', 'weld miss', 'WELDING NG', 'Wrong ass', 'WRONG ASSEMBLE', 'Wrong Assy',
  'Wrong assy', 'Wrong pin', 'Wrong Pin',
] as const;

const RESPONSIBILITIES = ['Stamping', 'Plating', 'Assy', 'Welding', 'BOP', 'Bolt Sticking'] as const;
type Responsibility = (typeof RESPONSIBILITIES)[number];
type RejectionStage = 'Visual' | 'Process' | 'Dimension';

type LinePart = { name: string; cycleTimeSeconds: number };
type ResolvedLine = {
  id: string;
  lineName: string;
  plant: string;
  workshop: string;
  division: string;
  parts: LinePart[];
};
type DayPlan = {
  line: ResolvedLine;
  date: string;
  recordCount: number;
  highRejectionDay: boolean;
};
type RejectionRecord = {
  date: string;
  plant: string;
  workshop: string;
  division: string;
  lineId: string;
  lineName: string;
  partName: string;
  stage: RejectionStage;
  rejectionQty: number;
  defect: string;
  responsibility: Responsibility;
  remarks: string | null;
  reportedBy: { uid: null; name: string };
  createdAt: Timestamp;
  sampleDataTag: string;
};

function resolveCredential() {
  const envPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (envPath && fs.existsSync(envPath)) {
    console.log(`[rejectionSamples] Using service account from env path: ${envPath}`);
    return cert(JSON.parse(fs.readFileSync(envPath, 'utf8')));
  }
  const localPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'serviceAccountKey.json'
);
  if (fs.existsSync(localPath)) {
    console.log(`[rejectionSamples] Using service account from ${localPath}`);
    return cert(JSON.parse(fs.readFileSync(localPath, 'utf8')));
  }
  console.log('[rejectionSamples] No service account file found; using application default credentials.');
  return applicationDefault();
}

let app: App;
if (!getApps().length) {
  app = initializeApp({ credential: resolveCredential() });
} else {
  app = getApps()[0]!;
}
const db = getFirestore(app);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readLinePart(value: unknown): LinePart | null {
  const part = asRecord(value);
  if (!part) return null;
  const name = readString(part.name ?? part.partName);
  const cycleTimeSeconds = Number(part.cycleTimeSeconds ?? part.cycleTime ?? part.cycle ?? 0);
  return name && Number.isFinite(cycleTimeSeconds) && cycleTimeSeconds > 0
    ? { name, cycleTimeSeconds }
    : null;
}

function resolveLine(id: string, data: DocumentData | undefined): ResolvedLine {
  if (!data) throw new Error(`[rejectionSamples] productionLines/${id} has no document data.`);
  const lineName = readString(data.lineName ?? data.lineNumber ?? data.name);
  const plant = readString(data.plant ?? data.location);
  const workshop = readString(data.workshop ?? data.shop);
  const division = readString(data.division ?? data.unit);
  const sourceParts: unknown = data.parts ?? data.models ?? data.partsList;
  const parts = Array.isArray(sourceParts)
    ? sourceParts.map(readLinePart).filter((part): part is LinePart => part !== null)
    : [];

  if (!lineName || !plant || !workshop || !division || parts.length === 0) {
    throw new Error(
      `[rejectionSamples] productionLines/${id} is missing a real line name, plant, workshop, division, or usable parts.`,
    );
  }
  return { id, lineName, plant, workshop, division, parts };
}

async function resolveTargetLines(): Promise<ResolvedLine[]> {
  const snapshots = await Promise.all(
    TARGET_LINE_IDS.map((id) => db.collection('productionLines').doc(id).get()),
  );
  const missingIds = snapshots.filter((snapshot) => !snapshot.exists).map((snapshot) => snapshot.id);
  if (missingIds.length) {
    throw new Error(`[rejectionSamples] Missing required productionLines docs: ${missingIds.join(', ')}`);
  }

  const lines = snapshots.map((snapshot) => resolveLine(snapshot.id, snapshot.data()));
  console.log(`[rejectionSamples] Loaded ${lines.length} exact productionLines documents.`);
  return lines;
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function eachDate(): string[] {
  const dates: string[] = [];
  for (let day = 1; day <= 31; day += 1) {
    dates.push(`${START_DATE.slice(0, 8)}${String(day).padStart(2, '0')}`);
  }
  return dates;
}

function createDayPlan(lines: ResolvedLine[]): DayPlan[] {
  const plans: DayPlan[] = [];
  for (const line of lines) {
    for (const date of eachDate()) {
      const roll = Math.random();
      if (roll < 0.04) {
        plans.push({ line, date, recordCount: 0, highRejectionDay: false });
      } else if (roll < 0.10) {
        plans.push({ line, date, recordCount: randomInt(9, 12), highRejectionDay: true });
      } else {
        plans.push({ line, date, recordCount: randomInt(3, 7), highRejectionDay: false });
      }
    }
  }

  let total = plans.reduce((sum, plan) => sum + plan.recordCount, 0);
  while (total < MIN_RECORDS) {
    const plan = plans.find((candidate) => candidate.recordCount > 0 && candidate.recordCount < 12)
      ?? plans.find((candidate) => candidate.recordCount === 0);
    if (!plan) throw new Error('[rejectionSamples] Could not meet the minimum sample record count.');
    if (plan.recordCount === 0) plan.recordCount = 3;
    else plan.recordCount += 1;
    total = plans.reduce((sum, candidate) => sum + candidate.recordCount, 0);
  }
  while (total > MAX_RECORDS) {
    const plan = plans.find((candidate) => candidate.recordCount > 3);
    if (!plan) throw new Error('[rejectionSamples] Could not meet the maximum sample record count.');
    plan.recordCount -= 1;
    total -= 1;
  }
  return plans;
}

function responsibilityFor(defect: string): Responsibility {
  const normalized = defect.toLowerCase().replace(/[^a-z]/g, '');
  if (normalized.includes('plating') || normalized.includes('platting')) return 'Plating';
  if (normalized.includes('weld')) return 'Welding';
  if (normalized.includes('bolt') || normalized.includes('nut')) return 'Bolt Sticking';
  if (
    normalized.includes('batch')
    || normalized.includes('logo')
    || normalized === 'bc'
    || normalized.includes('bcng')
    || normalized.includes('bcnd')
  ) return 'BOP';
  if (
    normalized.includes('assy')
    || normalized.includes('assemble')
    || normalized.includes('arm')
    || normalized.includes('movement')
    || normalized.includes('rivit')
    || normalized.includes('washer')
    || normalized.includes('female')
    || normalized.includes('male')
  ) return 'Assy';
  return 'Stamping';
}

function stageFor(responsibility: Responsibility): RejectionStage {
  const roll = Math.random();
  if (roll < 0.68) return 'Visual';
  if (responsibility === 'Stamping') return roll < 0.91 ? 'Dimension' : 'Process';
  return roll < 0.91 ? 'Process' : 'Dimension';
}

function rejectionQuantity(highRejectionDay: boolean): number {
  const roll = Math.random();
  if (highRejectionDay && roll < 0.12) return randomInt(21, 45);
  if (roll < 0.75) return randomInt(1, 8);
  if (roll < 0.97) return randomInt(9, 20);
  return randomInt(21, 35);
}

function createdAtFor(date: string): Timestamp {
  const hour = randomInt(8, 17);
  const minute = hour === 17 ? randomInt(0, 30) : randomInt(0, 59);
  const second = randomInt(0, 59);
  return Timestamp.fromDate(
    new Date(`${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}${WORKING_TIME_ZONE_OFFSET}`),
  );
}

function makeRecord(plan: DayPlan, index: number): RejectionRecord {
  const defect = DEFECTS[randomInt(0, DEFECTS.length - 1)];
  const responsibility = responsibilityFor(defect);
  const stage = stageFor(responsibility);
  const notes = [
    `Sample ${plan.highRejectionDay ? 'spike' : 'inspection'}: ${defect} found during ${stage.toLowerCase()} check.`,
    `Sample QC entry for ${defect}; affected pieces were segregated for review.`,
    `Sample inspection finding: ${defect}; follow-up assigned to ${responsibility}.`,
  ];
  return {
    date: plan.date,
    plant: plan.line.plant,
    workshop: plan.line.workshop,
    division: plan.line.division,
    lineId: plan.line.id,
    lineName: plan.line.lineName,
    partName: plan.line.parts[randomInt(0, plan.line.parts.length - 1)].name,
    stage,
    rejectionQty: rejectionQuantity(plan.highRejectionDay),
    defect,
    responsibility,
    remarks: notes[index % notes.length],
    reportedBy: { uid: null, name: 'Quality Sample Generator' },
    createdAt: createdAtFor(plan.date),
    sampleDataTag: SAMPLE_DATA_TAG,
  };
}

async function writeBatched(records: RejectionRecord[]): Promise<{ written: number; batches: number }> {
  let written = 0;
  let batches = 0;
  for (let offset = 0; offset < records.length; offset += FIRESTORE_BATCH_LIMIT) {
    const chunk = records.slice(offset, offset + FIRESTORE_BATCH_LIMIT);
    const batch = db.batch();
    for (const record of chunk) {
      batch.set(db.collection('rejectionRecords').doc(), record);
    }
    await batch.commit();
    written += chunk.length;
    batches += 1;
    console.log(`[rejectionSamples] Wrote batch ${batches}: ${written}/${records.length} records.`);
  }
  return { written, batches };
}

export async function cleanupRejectionSamples(): Promise<number> {
  console.log(`[rejectionSamples] Deleting only rejectionRecords where sampleDataTag == ${SAMPLE_DATA_TAG}...`);
  const snapshot = await db.collection('rejectionRecords')
    .where('sampleDataTag', '==', SAMPLE_DATA_TAG)
    .get();
  if (snapshot.empty) {
    console.log('[rejectionSamples] No matching tagged sample records found.');
    return 0;
  }

  let deleted = 0;
  let batches = 0;
  for (let offset = 0; offset < snapshot.docs.length; offset += FIRESTORE_BATCH_LIMIT) {
    const chunk = snapshot.docs.slice(offset, offset + FIRESTORE_BATCH_LIMIT);
    const batch = db.batch();
    for (const document of chunk) batch.delete(document.ref);
    await batch.commit();
    deleted += chunk.length;
    batches += 1;
    console.log(`[rejectionSamples] Deleted batch ${batches}: ${deleted}/${snapshot.docs.length} records.`);
  }
  console.log(`[rejectionSamples] Cleanup complete: deleted ${deleted} record(s) in ${batches} batch(es).`);
  return deleted;
}

export async function generateRejectionSamples(): Promise<void> {
  const lines = await resolveTargetLines();
  await cleanupRejectionSamples();

  const plans = createDayPlan(lines);
  const records = plans.flatMap((plan) =>
    Array.from({ length: plan.recordCount }, (_, index) => makeRecord(plan, index)),
  );
  const { written, batches } = await writeBatched(records);
  console.log(
    `[rejectionSamples] Complete: ${written} records; dates ${START_DATE} through ${END_DATE}; `
    + `${lines.length} lines; ${batches} write batch(es); sampleDataTag=${SAMPLE_DATA_TAG}.`,
  );
}
