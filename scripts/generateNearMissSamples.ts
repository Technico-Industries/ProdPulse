// Temporary August 2026 Near-Miss sample data.
//
// Generate:
// npx tsx -e "import('./scripts/generateNearMissSamples').then(m => m.generateNearMissSamples()).catch(e => { console.error(e); process.exitCode = 1; })"
//
// Delete only these tagged samples:
// npx tsx -e "import('./scripts/generateNearMissSamples').then(m => m.cleanupNearMissSamples()).catch(e => { console.error(e); process.exitCode = 1; })"
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

const SAMPLE_DATA_TAG = 'near-miss-sample-august-2026-v1';
const DAYS_IN_AUGUST_2026 = 31;
const FIRESTORE_BATCH_LIMIT = 450;
const RECORDS_PER_DAY = 4;
const INTENSITIES = ['Low', 'Medium', 'High', 'Critical'] as const;
const STATUSES = ['Open', 'In Progress', 'Closed', 'Pending'] as const;
type Intensity = (typeof INTENSITIES)[number];
type Status = (typeof STATUSES)[number];

type NearMissSample = {
  date: string;
  plant: string;
  workshop: string;
  division: string;
  areaMachine: string;
  intensity: Intensity;
  description: string;
  actionTaken: string;
  tdc: string;
  responsibility: string;
  status: Status;
  closedOn: string;
  submittedBy: string;
  submittedByUid: null;
  createdAt: Timestamp;
  sampleDataTag: string;
};

type Scenario = {
  areaMachine: string;
  description: string;
  actionTaken: string;
  responsibility: string;
};

const SCENARIOS: Scenario[] = [
  {
    areaMachine: 'Welding Line 1',
    description: 'A welding lead was found routed across the operator walkway after a fixture change, creating a trip and equipment-damage risk.',
    actionTaken: 'Paused the station, rerouted and secured the lead, then checked the walkway before restarting.',
    responsibility: 'Maintenance',
  },
  {
    areaMachine: 'Welding Line 2',
    description: 'A small offcut remained beside the weld-cell foot pedal and could have shifted under an operator during the next cycle.',
    actionTaken: 'Removed the offcut, inspected the pedal area, and added the spot to the end-of-shift housekeeping check.',
    responsibility: 'Production',
  },
  {
    areaMachine: 'Press Shop',
    description: 'The return-side guarding on a press was not seated flush after adjustment, leaving a hand-access gap during setup.',
    actionTaken: 'Kept the press stopped until the guard was realigned and its interlock was verified.',
    responsibility: 'Maintenance',
  },
  {
    areaMachine: 'Assembly Line 1',
    description: 'A tote was placed beyond the marked staging boundary and narrowed the clear route beside the assembly bench.',
    actionTaken: 'Moved the tote into its marked bay and reminded the shift team to keep the aisle boundary clear.',
    responsibility: 'Supervisor',
  },
  {
    areaMachine: 'Assembly Line 2',
    description: 'A locating fixture was found slightly loose during a changeover check before the next component was loaded.',
    actionTaken: 'Secured the fixture, checked its locating points, and requested a first-piece verification.',
    responsibility: 'Tool Room',
  },
  {
    areaMachine: 'Material Store',
    description: 'Two returnable bins were stacked unevenly at the end of a rack row and shifted when the lower bin was approached.',
    actionTaken: 'Restacked the bins within the marked height limit and informed the material handler.',
    responsibility: 'Operator',
  },
  {
    areaMachine: 'Inspection Area',
    description: 'A cracked protective cover on a portable inspection lamp exposed a sharp edge near the checking station.',
    actionTaken: 'Removed the lamp from use, replaced it with an intact unit, and logged the damaged cover for disposal.',
    responsibility: 'Quality',
  },
  {
    areaMachine: 'Tool Room',
    description: 'A long-handled tool had been left projecting from a shared drawer and was close to the aisle edge.',
    actionTaken: 'Returned the tool to its fitted slot and checked the drawer insert for a secure fit.',
    responsibility: 'Tool Room',
  },
  {
    areaMachine: 'Paint Area',
    description: 'A container lid was not fully seated at the preparation bench, allowing a small amount of residue to collect nearby.',
    actionTaken: 'Closed and labelled the container, cleaned the bench, and checked nearby materials for contamination.',
    responsibility: 'Safety',
  },
  {
    areaMachine: 'Hydraulic Station',
    description: 'A fine hydraulic mist was noticed around a hose coupling during a walk-by inspection before the next cycle.',
    actionTaken: 'Isolated the station, replaced the worn coupling seal, and verified the connection under a controlled check.',
    responsibility: 'Maintenance',
  },
  {
    areaMachine: 'Assembly Cell',
    description: 'A component rack stop was not fully engaged, allowing the front tray to move when the next part was picked.',
    actionTaken: 'Re-engaged the rack stop, checked the remaining trays, and briefed the cell operator.',
    responsibility: 'Production',
  },
  {
    areaMachine: 'Press Feed Station',
    description: 'A bundle of strip material had shifted toward the feed path while being staged for the following press run.',
    actionTaken: 'Restacked and restrained the strip bundle, then confirmed the feed-side clearance with the supervisor.',
    responsibility: 'Supervisor',
  },
  {
    areaMachine: 'Weld Fixture Bay',
    description: 'A welding screen had been turned away from the adjacent inspection route, leaving a brief line of sight to the arc area.',
    actionTaken: 'Repositioned the screen to cover the shared route and checked neighboring screens for alignment.',
    responsibility: 'Safety',
  },
  {
    areaMachine: 'Plating Shop',
    description: 'A damp patch was noticed at the edge of a plating-shop walkway near a transfer trolley track.',
    actionTaken: 'Restricted the walkway, dried the patch, and reported the source for a maintenance inspection.',
    responsibility: 'Maintenance',
  },
  {
    areaMachine: 'Material Transfer Point',
    description: 'A trolley was parked with one wheel outside its marked bay and could have rolled into the pedestrian lane.',
    actionTaken: 'Moved the trolley fully into the bay, applied its wheel lock, and reminded the team about parking marks.',
    responsibility: 'Operator',
  },
  {
    areaMachine: 'Assembly Tool Stand',
    description: 'A hand tool with a worn grip was found on the assembly stand where it could slip during a tightening task.',
    actionTaken: 'Tagged the tool out, issued a replacement, and sent the worn tool to the tool-room inspection queue.',
    responsibility: 'Tool Room',
  },
  {
    areaMachine: 'Press Die Change Area',
    description: 'A loose fastener was found on the floor near the die-change path before the handling equipment entered the area.',
    actionTaken: 'Collected the fastener, checked the nearby fixture points, and cleared the path before die movement.',
    responsibility: 'Maintenance',
  },
  {
    areaMachine: 'Final Inspection',
    description: 'A rejected part with a sharp burr had been placed in an open tray at the inspection bench beside accepted parts.',
    actionTaken: 'Segregated the part in a covered reject container and reminded inspectors to use the designated reject location.',
    responsibility: 'Quality',
  },
  {
    areaMachine: 'Welding Gas Manifold',
    description: 'A cylinder restraint chain was slack during a routine check and the cylinder could move if the manifold was bumped.',
    actionTaken: 'Secured the cylinder with the restraint and confirmed the manifold area was clear and stable.',
    responsibility: 'Safety',
  },
  {
    areaMachine: 'Assembly Aisle',
    description: 'A temporary extension lead was routed close to a floor joint across the edge of the operator passage.',
    actionTaken: 'Moved the lead away from the passage and secured the route with the approved cable cover.',
    responsibility: 'Maintenance',
  },
];

function resolveCredential() {
  const envPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (envPath && fs.existsSync(envPath)) {
    console.log(`[nearMissSamples] Using service account from env path: ${envPath}`);
    return cert(JSON.parse(fs.readFileSync(envPath, 'utf8')));
  }

  const localPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'serviceAccountKey.json');
  if (fs.existsSync(localPath)) {
    console.log(`[nearMissSamples] Using service account from ${localPath}`);
    return cert(JSON.parse(fs.readFileSync(localPath, 'utf8')));
  }

  console.log('[nearMissSamples] No service account file found; using application default credentials.');
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

function formatDate(day: number): string {
  return `${String(day).padStart(2, '0')}-08-26`;
}

function addDaysToDate(day: number, days: number): string {
  const date = new Date(Date.UTC(2026, 7, day + days));
  return `${String(date.getUTCDate()).padStart(2, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCFullYear()).slice(-2)}`;
}

function chooseIntensity(): Intensity {
  const roll = Math.random();
  if (roll < 0.48) return 'Low';
  if (roll < 0.88) return 'Medium';
  if (roll < 0.98) return 'High';
  return 'Critical';
}

function chooseStatus(): Status {
  const roll = Math.random();
  if (roll < 0.39) return 'Open';
  if (roll < 0.68) return 'In Progress';
  if (roll < 0.89) return 'Closed';
  return 'Pending';
}

function sampleKey(date: string, areaMachine: string, description: string): string {
  return JSON.stringify([date, areaMachine, description]);
}

function createRecord(day: number, index: number): NearMissSample {
  const scenario = SCENARIOS[(day * 7 + index * 11) % SCENARIOS.length];
  const date = formatDate(day);
  const status = chooseStatus();
  const time = `${String(randomInt(7, 18)).padStart(2, '0')}:${String(randomInt(0, 59)).padStart(2, '0')}:${String(randomInt(0, 59)).padStart(2, '0')}.000Z`;
  const createdAt = Timestamp.fromDate(new Date(`2026-08-${String(day).padStart(2, '0')}T${time}`));
  const tdc = addDaysToDate(day, randomInt(1, 14));
  const closedOn = status === 'Closed' ? addDaysToDate(day, randomInt(1, 10)) : '';
  const plant = PLANTS[(day + index) % PLANTS.length];
  const workshop = WORKSHOPS[(day * 3 + index) % WORKSHOPS.length];
  const division = DIVISIONS[(day * 5 + index * 2) % DIVISIONS.length];
  const description = `${scenario.description} Logged during the ${index % 2 === 0 ? 'morning' : 'afternoon'} safety round on ${date}.`;

  return {
    date,
    plant,
    workshop,
    division,
    areaMachine: scenario.areaMachine,
    intensity: chooseIntensity(),
    description,
    actionTaken: scenario.actionTaken,
    tdc,
    responsibility: scenario.responsibility,
    status,
    closedOn,
    submittedBy: 'Sample Data Generator',
    submittedByUid: null,
    createdAt,
    sampleDataTag: SAMPLE_DATA_TAG,
  };
}

function createAllRecords(): NearMissSample[] {
  const records: NearMissSample[] = [];
  for (let day = 1; day <= DAYS_IN_AUGUST_2026; day += 1) {
    for (let index = 0; index < RECORDS_PER_DAY; index += 1) {
      records.push(createRecord(day, index));
    }
  }
  return records;
}

async function loadExistingSampleKeys(): Promise<Set<string>> {
  const snapshot = await db.collection('nearMissReports')
    .where('sampleDataTag', '==', SAMPLE_DATA_TAG)
    .get();
  const keys = new Set<string>();
  for (const document of snapshot.docs) {
    const data = document.data();
    if (
      typeof data.date === 'string'
      && typeof data.areaMachine === 'string'
      && typeof data.description === 'string'
    ) {
      keys.add(sampleKey(data.date, data.areaMachine, data.description));
    }
  }
  console.log(`[nearMissSamples] Found ${keys.size} existing tagged date/area/description record(s).`);
  return keys;
}

async function writeBatched(records: NearMissSample[]): Promise<number> {
  let created = 0;
  let batchNumber = 0;
  for (let offset = 0; offset < records.length; offset += FIRESTORE_BATCH_LIMIT) {
    const chunk = records.slice(offset, offset + FIRESTORE_BATCH_LIMIT);
    const batch = db.batch();
    for (const record of chunk) {
      batch.set(db.collection('nearMissReports').doc(), record);
    }
    await batch.commit();
    created += chunk.length;
    batchNumber += 1;
    console.log(`[nearMissSamples] Wrote batch ${batchNumber}: ${created}/${records.length} records.`);
  }
  return created;
}

export async function generateNearMissSamples(): Promise<{ created: number; skipped: number }> {
  const existingKeys = await loadExistingSampleKeys();
  const generatedKeys = new Set<string>();
  const records: NearMissSample[] = [];
  let skipped = 0;

  for (const record of createAllRecords()) {
    const key = sampleKey(record.date, record.areaMachine, record.description);
    if (existingKeys.has(key) || generatedKeys.has(key)) {
      skipped += 1;
      continue;
    }
    generatedKeys.add(key);
    records.push(record);
  }

  const created = await writeBatched(records);
  console.log(`[nearMissSamples] Complete: created ${created} record(s); skipped ${skipped} duplicate(s).`);
  return { created, skipped };
}

export async function cleanupNearMissSamples(): Promise<number> {
  console.log(`[nearMissSamples] Deleting only nearMissReports where sampleDataTag == ${SAMPLE_DATA_TAG}...`);
  const snapshot = await db.collection('nearMissReports')
    .where('sampleDataTag', '==', SAMPLE_DATA_TAG)
    .get();
  if (snapshot.empty) {
    console.log('[nearMissSamples] No matching tagged sample documents found.');
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
    console.log(`[nearMissSamples] Deleted batch ${batchNumber}: ${deleted}/${snapshot.docs.length} records.`);
  }
  console.log(`[nearMissSamples] Cleanup complete: deleted ${deleted} document(s).`);
  return deleted;
}
