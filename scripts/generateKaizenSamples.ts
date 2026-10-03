// Temporary August 2026 Kaizen samples. Writes only to kaizenRecords and
// cleanup selects documents carrying the exact sample tag.
//
// Generate:
// npx tsx -e "import('./scripts/generateKaizenSamples').then(m => m.generateKaizenSamples()).catch(e => { console.error(e); process.exitCode = 1; })"
//
// Clean up only these samples:
// npx tsx -e "import('./scripts/generateKaizenSamples').then(m => m.cleanupKaizenSamples()).catch(e => { console.error(e); process.exitCode = 1; })"

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applicationDefault, cert, getApps, initializeApp } from 'firebase-admin/app';
import type { App } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import type { DocumentData } from 'firebase-admin/firestore';
import { DIVISIONS, PLANTS, WORKSHOPS } from '../src/constants/lineOptions';

const SAMPLE_DATA_TAG = 'kaizen-sample-august-2026-v1';
const FIRESTORE_BATCH_LIMIT = 450;
const FIRST_DAY = 1;
const LAST_DAY = 31;

const CATEGORIES = ['Safety', 'Quality', 'Productivity', 'Cost', 'Delivery', 'Morale', 'Environment'] as const;
const PRIORITIES = ['Low', 'Medium', 'High'] as const;
const STATUSES = ['Open', 'In Progress', 'Implemented', 'Closed', 'Rejected'] as const;
type KaizenCategory = (typeof CATEGORIES)[number];
type KaizenPriority = (typeof PRIORITIES)[number];
type KaizenStatus = (typeof STATUSES)[number];

type KaizenSample = {
  sNo: number;
  date: string;
  plant: string;
  workshop: string;
  division: string;
  employeeName: string;
  employeeCode: string;
  improvementIdentified: string;
  kaizenIdea: string;
  category: KaizenCategory;
  priority: KaizenPriority;
  actionTaken: string;
  responsibility: string;
  targetDate: string;
  status: KaizenStatus;
  result: string;
  remarks: string;
  submittedBy: string;
  submittedByUid: null;
  createdAt: Timestamp;
  sampleDataTag: string;
};

type KaizenIdeaTemplate = {
  identified: string;
  idea: string;
  category: KaizenCategory;
  action: string;
  responsibility: string;
  result: string;
};

const IDEA_TEMPLATES: KaizenIdeaTemplate[] = [
  {
    identified: 'Operators walked to a shared rack several times during each shift to collect fixtures.',
    idea: 'Create a point-of-use fixture rack beside the cell and mark a return location for each fixture.',
    category: 'Productivity',
    action: 'A labeled rack was positioned at the cell and fixture slots were marked.',
    responsibility: 'Production Engineering',
    result: 'Average fixture retrieval time reduced by 4 minutes per changeover.',
  },
  {
    identified: 'Similar fasteners were stored in adjacent, visually similar bins at the assembly station.',
    idea: 'Add distinct bin labels and a simple part-photo guide to prevent fastener mix-ups.',
    category: 'Quality',
    action: 'Part photographs and larger bin labels were added to the station.',
    responsibility: 'Quality',
    result: 'Fastener selection errors fell from 6 to 1 per week during the trial.',
  },
  {
    identified: 'Aisle-side material totes narrowed the marked pedestrian route during replenishment.',
    idea: 'Mark a fixed tote footprint and replenish only within the designated line-side space.',
    category: 'Safety',
    action: 'Floor boundaries were repainted and the replenishment route was briefed.',
    responsibility: 'Safety',
    result: 'The pedestrian aisle remained clear through the four-week verification period.',
  },
  {
    identified: 'The operator crossed the workstation repeatedly to retrieve the inspection gauge.',
    idea: 'Mount the gauge at the inspection point with a shadow outline for return after use.',
    category: 'Productivity',
    action: 'A gauge holder and shadow-board outline were installed within arm reach.',
    responsibility: 'Maintenance',
    result: 'Walking per inspected batch reduced by approximately 120 meters.',
  },
  {
    identified: 'Changeover instructions were kept in a binder away from the machine.',
    idea: 'Place a concise setup checklist at the machine and identify the current revision.',
    category: 'Delivery',
    action: 'A controlled setup checklist was posted at the machine-side document holder.',
    responsibility: 'Production',
    result: 'Average setup confirmation time reduced by 7 minutes.',
  },
  {
    identified: 'Weld spatter accumulated on a fixture locator and required repeated manual cleaning.',
    idea: 'Trial a replaceable spatter shield on the locator and add it to the daily check.',
    category: 'Quality',
    action: 'A removable shield was fitted and added to the fixture inspection checklist.',
    responsibility: 'Maintenance',
    result: 'Fixture cleaning stops decreased from 5 to 2 per shift.',
  },
  {
    identified: 'Small parts were replenished only after the operator noticed a nearly empty container.',
    idea: 'Introduce a two-bin visual replenishment signal for frequently used line-side parts.',
    category: 'Delivery',
    action: 'Two-bin cards were introduced with a defined replenishment pickup point.',
    responsibility: 'Materials',
    result: 'Line-side stockout interruptions reduced by about 30% in the trial.',
  },
  {
    identified: 'Inspection samples were placed on an unmarked surface beside accepted components.',
    idea: 'Add a clearly separated sample tray with status labels for inspection results.',
    category: 'Quality',
    action: 'A marked sample tray with accepted and pending sections was put in place.',
    responsibility: 'Quality',
    result: 'Sample mix-up risk was reduced and the check was verified during layered audits.',
  },
  {
    identified: 'The operator reached around a container to access the most frequently used tools.',
    idea: 'Rearrange the tool board by usage frequency and keep high-use tools in the safe reach zone.',
    category: 'Morale',
    action: 'The tool board was rearranged and the new layout was reviewed with the team.',
    responsibility: 'Production',
    result: 'Operator reaching motions reduced by an average of 18 per cycle.',
  },
  {
    identified: 'Compressed air was left flowing at a cleaning point during breaks.',
    idea: 'Fit a self-closing nozzle and add a shutdown reminder to the break checklist.',
    category: 'Environment',
    action: 'A self-closing nozzle was installed and the checklist was updated.',
    responsibility: 'Maintenance',
    result: 'Compressed-air use at the point fell by an estimated 12% during the monitored week.',
  },
  {
    identified: 'The inspection lamp position changed between shifts, creating inconsistent visibility.',
    idea: 'Add a fixed lamp bracket and a marked angle reference for repeatable positioning.',
    category: 'Quality',
    action: 'A fixed adjustable bracket was installed and its reference position marked.',
    responsibility: 'Quality',
    result: 'Inspection adjustments reduced by 3 minutes per shift.',
  },
  {
    identified: 'Finished components waited in mixed sequence before transfer to the next process.',
    idea: 'Use numbered FIFO lanes and a maximum queue limit at the transfer point.',
    category: 'Delivery',
    action: 'FIFO lanes were numbered and a visual queue limit was posted.',
    responsibility: 'Production',
    result: 'Average queue age reduced from 46 to 29 minutes.',
  },
  {
    identified: 'The same fixture adjustment was repeated because its approved setting was not visible.',
    idea: 'Record the approved fixture setting on a durable setup card attached to the fixture.',
    category: 'Cost',
    action: 'A setup card with verified reference dimensions was attached to the fixture.',
    responsibility: 'Process Engineering',
    result: 'Trial setup scrap reduced by 9 pieces over the following two weeks.',
  },
  {
    identified: 'A floor marking near a frequently used emergency access route had faded.',
    idea: 'Refresh the route marking and include its visibility in the weekly 5S walk.',
    category: 'Safety',
    action: 'The access boundary was repainted and added to the weekly 5S checklist.',
    responsibility: 'Safety',
    result: 'Emergency access remained unobstructed during four consecutive audits.',
  },
  {
    identified: 'Operators searched several folders to find the current defect reference sheet.',
    idea: 'Create a single indexed, revision-controlled reference point at the inspection station.',
    category: 'Productivity',
    action: 'A revision-controlled reference binder was indexed and placed at inspection.',
    responsibility: 'Quality',
    result: 'Defect-reference lookup time reduced by roughly 2 minutes per review.',
  },
  {
    identified: 'A returnable packaging insert was discarded despite being suitable for reuse.',
    idea: 'Add a clearly labeled return container and a reuse check before disposal.',
    category: 'Environment',
    action: 'A return container was marked and added to the end-of-shift checklist.',
    responsibility: 'Materials',
    result: 'Reusable inserts recovered increased by 24 per week.',
  },
];

const EMPLOYEES = [
  { name: 'Aarav Sharma', code: 'KZ-SMP-001' },
  { name: 'Meera Verma', code: 'KZ-SMP-002' },
  { name: 'Rohan Singh', code: 'KZ-SMP-003' },
  { name: 'Kavya Patel', code: 'KZ-SMP-004' },
  { name: 'Arjun Yadav', code: 'KZ-SMP-005' },
  { name: 'Nisha Kumar', code: 'KZ-SMP-006' },
  { name: 'Vikram Das', code: 'KZ-SMP-007' },
  { name: 'Sana Rao', code: 'KZ-SMP-008' },
  { name: 'Dev Malhotra', code: 'KZ-SMP-009' },
  { name: 'Isha Nair', code: 'KZ-SMP-010' },
  { name: 'Kabir Joshi', code: 'KZ-SMP-011' },
  { name: 'Anaya Gupta', code: 'KZ-SMP-012' },
  { name: 'Neel Shah', code: 'KZ-SMP-013' },
  { name: 'Pooja Mehta', code: 'KZ-SMP-014' },
  { name: 'Rahul Saini', code: 'KZ-SMP-015' },
  { name: 'Tara Menon', code: 'KZ-SMP-016' },
  { name: 'Aditya Roy', code: 'KZ-SMP-017' },
  { name: 'Simran Kaur', code: 'KZ-SMP-018' },
  { name: 'Manav Bhat', code: 'KZ-SMP-019' },
  { name: 'Riya Kapoor', code: 'KZ-SMP-020' },
  { name: 'Kunal Jain', code: 'KZ-SMP-021' },
  { name: 'Diya Iyer', code: 'KZ-SMP-022' },
  { name: 'Samar Khan', code: 'KZ-SMP-023' },
  { name: 'Leena Bose', code: 'KZ-SMP-024' },
];

function resolveCredential() {
  const envPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (envPath && fs.existsSync(envPath)) {
    console.log(`[kaizenSamples] Using service account from environment path: ${envPath}`);
    return cert(JSON.parse(fs.readFileSync(envPath, 'utf8')));
  }

  const localPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'serviceAccountKey.json');
  if (fs.existsSync(localPath)) {
    console.log(`[kaizenSamples] Using service account from ${localPath}`);
    return cert(JSON.parse(fs.readFileSync(localPath, 'utf8')));
  }

  console.log('[kaizenSamples] No service account file found; using application default credentials.');
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

function augustDate(day: number): string {
  return `${String(day).padStart(2, '0')}-08-26`;
}

function targetDate(day: number, offset: number): string {
  const date = new Date(Date.UTC(2026, 7, day + offset));
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const yy = String(date.getUTCFullYear()).slice(-2);
  return `${dd}-${mm}-${yy}`;
}

function createdAtFor(day: number): Timestamp {
  const hour = randomInt(7, 18);
  const minute = randomInt(0, 59);
  const second = randomInt(0, 59);
  return Timestamp.fromDate(new Date(
    `2026-08-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}+05:30`,
  ));
}

function duplicateKey(data: Pick<KaizenSample, 'date' | 'employeeCode' | 'kaizenIdea'>): string {
  return `${data.date}\u0000${data.employeeCode}\u0000${data.kaizenIdea}`;
}

function createSample(day: number, slot: number): Omit<KaizenSample, 'sNo'> {
  const index = (day - 1) * 2 + slot;
  const template = IDEA_TEMPLATES[index % IDEA_TEMPLATES.length];
  const employee = EMPLOYEES[(day * 5 + slot * 11) % EMPLOYEES.length];
  const status = STATUSES[(day + slot) % STATUSES.length];
  const plant = PLANTS[(day + slot) % PLANTS.length];
  const workshop = WORKSHOPS[(day * 2 + slot) % WORKSHOPS.length];
  const division = DIVISIONS[(day * 3 + slot * 2) % DIVISIONS.length];
  const targetOffset = 4 + ((day + slot * 3) % 11);
  const rejectionRemarks = [
    'Reviewed by the area team; deferred because the proposed layout conflicts with the approved material route.',
    'Not selected for this cycle; the existing control already addresses the issue without added handling.',
    'Trial was declined pending a standard engineering change review.',
  ];
  const remarks = status === 'Rejected'
    ? rejectionRemarks[(day + slot) % rejectionRemarks.length]
    : status === 'Open'
      ? 'Submitted for area-team review; no implementation activity started.'
      : status === 'In Progress'
        ? 'Trial action is underway; effectiveness check is scheduled after the next review.'
        : status === 'Closed'
          ? 'Effectiveness verified by the area team and added to the standard work review.'
          : 'Implemented during the shift; follow-up verification is in progress.';
  const actionTaken = status === 'Open'
    ? 'Idea logged for review; implementation has not started.'
    : status === 'In Progress'
      ? `Trial preparation started: ${template.action.charAt(0).toLowerCase()}${template.action.slice(1)}`
      : status === 'Rejected'
        ? 'Idea reviewed with the area team; no change was implemented.'
        : template.action;
  const result = status === 'Implemented' || status === 'Closed'
    ? template.result
    : status === 'Rejected'
      ? 'No process change made; current standard remains in place.'
      : status === 'In Progress'
        ? 'Expected to reduce avoidable motion after the trial is verified.'
        : '';

  return {
    date: augustDate(day),
    plant,
    workshop,
    division,
    employeeName: employee.name,
    employeeCode: employee.code,
    improvementIdentified: template.identified,
    kaizenIdea: template.idea,
    category: template.category,
    priority: PRIORITIES[(day + slot * 2) % PRIORITIES.length],
    actionTaken,
    responsibility: template.responsibility,
    targetDate: targetDate(day, targetOffset),
    status,
    result,
    remarks,
    submittedBy: 'Sample Data Generator',
    submittedByUid: null,
    createdAt: createdAtFor(day),
    sampleDataTag: SAMPLE_DATA_TAG,
  };
}

function loadExistingRecords(snapshot: FirebaseFirestore.QuerySnapshot<DocumentData>): {
  maxSNo: number;
  existingKeys: Set<string>;
} {
  let maxSNo = 0;
  const existingKeys = new Set<string>();
  for (const document of snapshot.docs) {
    const data = document.data();
    if (typeof data.sNo === 'number' && Number.isFinite(data.sNo)) {
      maxSNo = Math.max(maxSNo, data.sNo);
    }
    if (data.sampleDataTag !== SAMPLE_DATA_TAG) continue;
    const date = typeof data.date === 'string' ? data.date : '';
    const employeeCode = typeof data.employeeCode === 'string' ? data.employeeCode : '';
    const kaizenIdea = typeof data.kaizenIdea === 'string' ? data.kaizenIdea : '';
    if (date && employeeCode && kaizenIdea) {
      existingKeys.add(duplicateKey({ date, employeeCode, kaizenIdea }));
    }
  }
  return { maxSNo, existingKeys };
}

async function writeBatched(records: KaizenSample[]): Promise<number> {
  let created = 0;
  let batchNumber = 0;
  for (let offset = 0; offset < records.length; offset += FIRESTORE_BATCH_LIMIT) {
    const chunk = records.slice(offset, offset + FIRESTORE_BATCH_LIMIT);
    const batch = db.batch();
    for (const record of chunk) {
      batch.create(db.collection('kaizenRecords').doc(), record);
    }
    await batch.commit();
    created += chunk.length;
    batchNumber += 1;
    console.log(`[kaizenSamples] Wrote batch ${batchNumber}: ${created}/${records.length} records.`);
  }
  return created;
}

export async function generateKaizenSamples(): Promise<{ created: number; skipped: number }> {
  const snapshot = await db.collection('kaizenRecords').get();
  const { maxSNo, existingKeys } = loadExistingRecords(snapshot);
  console.log(`[kaizenSamples] Read ${snapshot.size} existing record(s); highest S.No is ${maxSNo}.`);

  const records: KaizenSample[] = [];
  let skipped = 0;
  for (let day = FIRST_DAY; day <= LAST_DAY; day += 1) {
    for (let slot = 0; slot < 2; slot += 1) {
      const sample = createSample(day, slot);
      const key = duplicateKey(sample);
      if (existingKeys.has(key)) {
        skipped += 1;
        continue;
      }
      existingKeys.add(key);
      records.push({ ...sample, sNo: maxSNo + records.length + 1 });
    }
  }

  const created = await writeBatched(records);
  console.log(
    `[kaizenSamples] Complete: created ${created} record(s); skipped ${skipped} duplicate(s); `
    + `dates 01-08-26 through 31-08-26; sampleDataTag=${SAMPLE_DATA_TAG}.`,
  );
  return { created, skipped };
}

export async function cleanupKaizenSamples(): Promise<number> {
  console.log(`[kaizenSamples] Deleting only kaizenRecords where sampleDataTag == ${SAMPLE_DATA_TAG}...`);
  const snapshot = await db.collection('kaizenRecords')
    .where('sampleDataTag', '==', SAMPLE_DATA_TAG)
    .get();
  if (snapshot.empty) {
    console.log('[kaizenSamples] No matching tagged sample documents found.');
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
    console.log(`[kaizenSamples] Deleted batch ${batchNumber}: ${deleted}/${snapshot.docs.length} records.`);
  }
  console.log(`[kaizenSamples] Cleanup complete: deleted ${deleted} tagged sample document(s).`);
  return deleted;
}
