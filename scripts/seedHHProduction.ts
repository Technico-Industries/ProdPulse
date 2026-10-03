// scripts/seedHHProduction.ts
//
// ONE-TIME seed script — generates realistic sample production data for the
// 7 "HH" lines for August 2026 into the sampleProductionRecords collection.
//
// WHAT THIS SCRIPT DOES NOT DO:
//   - It never touches productionRecords, productionLines, activeSessions,
//     users, or any other existing collection — read-only everywhere except
//     sampleProductionRecords.
//   - It never invents plant/workshop/division/part/cycle-time data — all of
//     that is read from the real productionLines documents at run time.
//   - It never hardcodes a Firebase project id, API key, or service account.
//
// USAGE (after installing dependencies + setting up credentials, see below):
//   npm run seed:hh              generate the sample data
//   npm run clear:hh             delete ONLY docs with isSampleData === true
//                                 from sampleProductionRecords
//
// ── Dependencies ────────────────────────────────────────────────────────
// This script uses the Firebase ADMIN SDK (not the client SDK your app
// screens use), because a standalone Node script has no signed-in user to
// satisfy your Firestore security rules the way the app does. It needs:
//   npm install --save-dev firebase-admin tsx
// (`firebase-admin` must stay a devDependency / server-only tool — never
// import it from an Expo/React Native screen; it will break the Metro
// bundle.)
//
// ── Credentials ─────────────────────────────────────────────────────────
// This script authenticates with a Firebase service account, resolved in
// this order:
//   1. GOOGLE_APPLICATION_CREDENTIALS env var (standard Google Cloud
//      convention) — if set, its JSON is used as-is.
//   2. FIREBASE_SERVICE_ACCOUNT_PATH env var, if set.
//   3. ./scripts/serviceAccountKey.json, if that file exists locally.
//   4. Otherwise, admin.credential.applicationDefault() — works if you're
//      already logged in via `gcloud auth application-default login`, or if
//      this runs inside an environment (e.g. a Cloud Function) that already
//      has default credentials.
//
// To get a service account key: Firebase Console → Project Settings →
// Service Accounts → "Generate new private key". Save it as
// scripts/serviceAccountKey.json — scripts/.gitignore (added alongside this
// file) already excludes that filename, but double-check it's not tracked
// if your repo's root .gitignore doesn't already cover it. NEVER commit it.
//
// ── Line ID resolution ──────────────────────────────────────────────────
// LINE_ID_OVERRIDES below is pinned to the exact productionLines document ID
// for all 7 HH lines, so name matching is never used for them in practice.
// For each target line, this script:
//   1. Looks up the override ID directly in productionLines.
//   2. Confirms the doc actually exists.
//   3. Confirms the resolved doc's OWN lineName still matches the intended
//      HH line (via the same normalizeStr/sameStr fuzzy match the app
//      itself uses) — an ID that resolves to a doc with a different/renamed
//      lineName is treated as a failure, not used.
//   4. Confirms the doc has at least one usable part (name + cycleTimeSeconds)
//      — never invents one.
// ALL 7 lines must resolve successfully or the script aborts before writing
// anything (see the check in main()). If a target line has no override
// entry, it falls back to fuzzy name matching against every productionLines
// doc — flagging (not guessing) if that's ambiguous or has zero matches.

import * as fs from 'fs';
import * as path from 'path';
// Modern modular Admin SDK API (firebase-admin v12+). If your project is on
// an older firebase-admin (v9–v11), swap these two imports for the classic
// `import * as admin from 'firebase-admin'` + `admin.initializeApp(...)` /
// `admin.firestore()` / `admin.firestore.Timestamp` style instead — same
// behavior, different import shape.
import { initializeApp, applicationDefault, cert, getApps, App } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

// ─── Config ─────────────────────────────────────────────────────────────

const TARGET_LINE_NAMES = [
  'HHL-01',
  'HHL-02',
  'HHL-03',
  'HHL-04',
  'HHL-05',
  'HHL-07 RH',
  'HHL - 07 LH',
];

// Pinned by the project owner to the exact productionLines document IDs for
// each HH line — takes precedence over name matching entirely, so duplicate
// lineName values elsewhere in the collection can't cause a wrong match.
const LINE_ID_OVERRIDES: Record<string, string> = {
  'HHL-01': 'TfbJEBtFRBwkE2uX8DtA',
  'HHL-02': 'Qdb3CN4obWigWG3PE6zW',
  'HHL-03': 'H7teRfz1mpIhwi5UstRJ',
  'HHL-04': 'r3L69dDbsmyXjD6z9fFs',
  'HHL-05': 'noyHXBfUPV3Xl0qgMvjk',
  'HHL-07 RH': 'J9rhnrgH0qHIyzZiTB7o',
  'HHL - 07 LH': 'gL3QCcVhmHuwv1EAnnhh',
};

const START_DATE = '2026-08-01';
const END_DATE = '2026-08-31';
const SAMPLE_COLLECTION = 'sampleProductionRecords';

// Chance a given line/shift runs OT that day (adds 1–2 hours to the shift).
const OT_PROBABILITY = 0.12;
// Chance any single slot logs a stop event.
const STOP_EVENT_PROBABILITY = 0.15;
// Chance a slot is a "lower-performing" slot (wider shortfall) vs. the
// normal 85–100% band.
const LOW_PERFORMANCE_PROBABILITY = 0.1;

const FIRESTORE_BATCH_LIMIT = 450; // Firestore's hard cap is 500 — stay under it.

// ─── Firebase Admin init — no hardcoded project config ─────────────────

function resolveCredential() {
  const envPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (envPath && fs.existsSync(envPath)) {
    console.log(`[seedHH] Using service account from env path: ${envPath}`);
    return cert(JSON.parse(fs.readFileSync(envPath, 'utf8')));
  }
  const localPath = path.join(__dirname, 'serviceAccountKey.json');
  if (fs.existsSync(localPath)) {
    console.log(`[seedHH] Using service account from ${localPath}`);
    return cert(JSON.parse(fs.readFileSync(localPath, 'utf8')));
  }
  console.log('[seedHH] No service account file found — falling back to applicationDefault() credentials.');
  return applicationDefault();
}

let app: App;
if (!getApps().length) {
  app = initializeApp({ credential: resolveCredential() });
} else {
  app = getApps()[0]!;
}
const db = getFirestore(app);

// ─── String matching — mirrors GenerateReportScreen.tsx / KPIAnalysisScreen.tsx exactly ──

function normalizeStr(s: string | null | undefined): string {
  return (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}
function sameStr(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeStr(a);
  const nb = normalizeStr(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

// ─── Shift / slot config — ported verbatim from RecordProductionScreen.tsx ──
// (SHIFT_A_START/END, SHIFT_B_START/END, BREAKS, buildSlots, the
// expected-parts formula, and the loss-time formula are all copied exactly
// so generated records look like real ones. See that file for the
// original/canonical version if it's ever changed.)

const SHIFT_A_START = 7 * 60;
const SHIFT_A_END = 15 * 60 + 30;
const SHIFT_B_START = 19 * 60;
const SHIFT_B_END_ABS = 24 * 60 + 3 * 60 + 30;

const BREAKS: { start: number; end: number }[] = [
  { start: 9 * 60 + 30, end: 9 * 60 + 40 },
  { start: 12 * 60 + 15, end: 12 * 60 + 45 },
  { start: 14 * 60, end: 14 * 60 + 10 },
];

function overlapMinutes(aStart: number, aEnd: number, bStart: number, bEnd: number) {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

function formatAbsMinutesToAmPm(mAbs: number): string {
  const m = ((mAbs % 1440) + 1440) % 1440;
  const hh = Math.floor(m / 60);
  const mm = m % 60;
  const suffix = hh >= 12 ? 'PM' : 'AM';
  const hour12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${String(hour12).padStart(2, '0')}:${String(mm).padStart(2, '0')} ${suffix}`;
}

type Slot = {
  index: number;
  startMinutesAbs: number;
  endMinutesAbs: number;
  durationMinutes: number;
  label: string;
  productiveMinutes: number;
};

function buildSlots(shift: 'A' | 'B', otHours: number): Slot[] {
  const startAbs = shift === 'A' ? SHIFT_A_START : SHIFT_B_START;
  const endAbs = shift === 'A' ? SHIFT_A_END : SHIFT_B_END_ABS;
  const fullEnd = endAbs + otHours * 60;
  const allBreaks = [...BREAKS];
  if (otHours > 0) allBreaks.push({ start: 16 * 60, end: 16 * 60 + 10 });

  const result: Slot[] = [];
  let cursor = startAbs;
  let idx = 0;
  while (cursor < fullEnd) {
    const next = Math.min(fullEnd, cursor + 60);
    const duration = next - cursor;
    const reserve = cursor === startAbs || cursor === 13 * 60 ? 10 : 0;
    let breakOverlap = 0;
    allBreaks.forEach((b) => { breakOverlap += overlapMinutes(cursor, next, b.start, b.end); });
    const productive = Math.max(0, Math.round((duration - reserve - breakOverlap) * 100) / 100);
    result.push({
      index: idx,
      startMinutesAbs: cursor,
      endMinutesAbs: next,
      durationMinutes: duration,
      productiveMinutes: productive,
      label: `${formatAbsMinutesToAmPm(cursor)} - ${formatAbsMinutesToAmPm(next)}${duration < 60 ? ' (partial)' : ''}`,
    });
    cursor = next;
    idx++;
  }
  return result;
}

// Expected/planned parts = cycle time × the slot's full productive time —
// same formula as RecordProductionScreen's frozenExpected().
function expectedPartsFor(cycleTimeSeconds: number, productiveMinutes: number): number {
  if (!cycleTimeSeconds || productiveMinutes <= 0) return 0;
  return Math.floor((productiveMinutes * 60) / cycleTimeSeconds);
}

// Same formula as RecordProductionScreen's lossTimeMinutes().
function lossTimeMinutesFor(cycleTimeSeconds: number, lossParts: number): number {
  if (!cycleTimeSeconds || lossParts <= 0) return 0;
  return Math.round(((lossParts * cycleTimeSeconds) / 60) * 100) / 100;
}

// Real picker values, copied from RecordProductionScreen.tsx's LOSS_REASONS
// / STOP_REASONS — using the app's actual vocabulary rather than inventing
// new label text keeps generated records indistinguishable from real ones
// in every downstream report/KPI screen that groups by these fields.
const LOSS_REASONS: { code: string; label: string }[] = [
  { code: 'A', label: 'Job setup delay' },
  { code: 'B', label: 'Wait for component' },
  { code: 'C', label: 'Operator short / seed loss' },
  { code: 'D', label: 'Machine breakdown' },
  { code: 'E', label: 'Quality problem' },
  { code: 'F', label: 'Power failure' },
  { code: 'G', label: 'Stop by schedule' },
  { code: 'H', label: 'Jig fixture breakdown' },
  { code: 'I', label: 'Packing bin short' },
  { code: 'J', label: 'Air pressure low' },
  { code: 'K', label: 'Others' },
];

const STOP_REASONS = [
  'maintenance', 'changeover', 'quality', 'material shortage', 'no operator',
  'storage issue', 'training', '5s', 'meeting', 'pokayoke checktime',
  'gauge/fixture maintenance', 'no production plan', 'power cut', 'machine pm',
] as const;

// ─── Small random helpers ───────────────────────────────────────────────

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function randFloat(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}
function pick<T>(arr: readonly T[]): T {
  return arr[randInt(0, arr.length - 1)];
}
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

const FIRST_NAMES = ['Rahul', 'Amit', 'Suresh', 'Vikram', 'Ramesh', 'Sanjay', 'Anil', 'Deepak', 'Manoj', 'Ravi', 'Ajay', 'Vinod'];
const LAST_INITIALS = ['K', 'S', 'R', 'P', 'M', 'V', 'T'];

function makeRoster(seedKey: string, count: number): { name: string; code: string }[] {
  // Deterministic-ish per line/shift/day so the "same roster reused across
  // slots" requirement is trivially satisfied (built once per session, not
  // once per slot) — the seedKey just makes console output easier to trace.
  const roster: { name: string; code: string }[] = [];
  const used = new Set<string>();
  while (roster.length < count) {
    const name = `${pick(FIRST_NAMES)} ${pick(LAST_INITIALS)}.`;
    if (used.has(name)) continue;
    used.add(name);
    roster.push({ name, code: `OP-${randInt(1000, 9999)}` });
  }
  return roster;
}

function makeSupervisor(): { name: string; code: string; uid: null } {
  return { name: `${pick(FIRST_NAMES)} ${pick(LAST_INITIALS)}.`, code: `SUP-${randInt(100, 999)}`, uid: null };
}

// ─── Date range iteration ───────────────────────────────────────────────

function eachDateStr(fromISO: string, toISO: string): string[] {
  const out: string[] = [];
  const from = new Date(`${fromISO}T00:00:00`);
  const to = new Date(`${toISO}T00:00:00`);
  for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
    out.push(`${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`);
  }
  return out;
}

// createdAt is pinned to productionDate's own calendar date (converting the
// slot's own abs-minutes time-of-day, mod 1440) rather than the slot's true
// wall-clock time. This is a deliberate simplification: Shift B genuinely
// rolls past midnight (slot minutes can exceed 1440), and the task's hard
// requirement is that createdAt falls inside the Aug 1–31 range GenerateReportScreen
// queries by — using the *productionDate* directly guarantees that for every
// slot in the range, sidestepping the midnight-rollover edge case entirely.
// (RecordProductionScreen's real createdAt would occasionally land on the
// next calendar day for a late Shift B slot — a pre-existing quirk of the
// live app, not something this seed script needs to reproduce.)
function createdAtFor(productionDate: string, slotStartMinutesAbs: number): Timestamp {
  const [y, m, d] = productionDate.split('-').map(Number);
  const minuteOfDay = ((slotStartMinutesAbs % 1440) + 1440) % 1440;
  const hh = Math.floor(minuteOfDay / 60);
  const mm = minuteOfDay % 60;
  // A few minutes of "saved a bit after the slot started" jitter, purely for
  // realism — still same calendar day since it's capped well under 60 min.
  const jitterMin = randInt(0, 15);
  const dt = new Date(y, m - 1, d, hh, mm + jitterMin, randInt(0, 59));
  return Timestamp.fromDate(dt);
}

// ─── productionLines lookup ─────────────────────────────────────────────

type LinePart = { name: string; cycleTimeSeconds: number };
type ResolvedLine = {
  id: string;
  lineName: string;
  plant: string | null;
  workshop: string | null;
  division: string | null;
  parts: LinePart[];
};

async function resolveTargetLines(): Promise<ResolvedLine[]> {
  const snap = await db.collection('productionLines').get();
  const allDocs = snap.docs.map((d) => {
    const data: any = d.data();
    const partsArray: any[] =
      Array.isArray(data.parts) && data.parts.length ? data.parts :
      Array.isArray(data.models) && data.models.length ? data.models :
      Array.isArray(data.partsList) && data.partsList.length ? data.partsList : [];
    return {
      id: d.id,
      lineName: (data.lineName ?? data.lineNumber ?? data.name ?? null) as string | null,
      plant: (data.plant ?? data.location ?? null) as string | null,
      workshop: (data.workshop ?? data.shop ?? null) as string | null,
      division: (data.division ?? data.unit ?? null) as string | null,
      parts: partsArray
        .map((p: any) => ({
          name: (p.name ?? p.partName ?? '') as string,
          cycleTimeSeconds: Number(p.cycleTimeSeconds ?? p.cycleTime ?? p.cycle ?? 0),
        }))
        .filter((p) => p.name && p.cycleTimeSeconds > 0),
    };
  });

  console.log(`[seedHH] Loaded ${allDocs.length} productionLines doc(s).`);

  const resolved: ResolvedLine[] = [];
  for (const target of TARGET_LINE_NAMES) {
    if (LINE_ID_OVERRIDES[target]) {
      const overrideId = LINE_ID_OVERRIDES[target];
      const doc = allDocs.find((l) => l.id === overrideId);
      if (!doc) {
        console.warn(`[seedHH] LINE_ID_OVERRIDES has "${target}" -> ${overrideId}, but no productionLines doc with that ID exists.`);
        continue;
      }
      // Validate the resolved doc is actually the intended HH line, not just
      // any doc with that ID — a typo'd/stale override ID would otherwise
      // silently seed data under the wrong line.
      // Strict equality (after normalizing case/punctuation only) — NOT the
      // fuzzy substring sameStr() used below for auto-discovery. Substring
      // matching would let e.g. "HHL-03-RENAMED" pass as a match for
      // "HHL-03", which defeats the point of validating a pinned ID.
      if (normalizeStr(doc.lineName) !== normalizeStr(target)) {
        console.warn(`[seedHH] LINE_ID_OVERRIDES "${target}" -> ${overrideId} resolved to a doc whose lineName is ${JSON.stringify(doc.lineName)}, which doesn't match "${target}". Refusing to use it — fix LINE_ID_OVERRIDES.`);
        continue;
      }
      if (doc.parts.length === 0) {
        console.warn(`[seedHH] "${target}" (${overrideId}) has no usable parts (parts/models/partsList with a name + cycleTimeSeconds) — skipping, no fake part will be invented.`);
        continue;
      }
      resolved.push({ id: doc.id, lineName: doc.lineName ?? target, plant: doc.plant, workshop: doc.workshop, division: doc.division, parts: doc.parts });
      console.log(`[seedHH] "${target}" -> ${doc.id} (via LINE_ID_OVERRIDES, lineName confirmed = ${JSON.stringify(doc.lineName)})`);
      continue;
    }

    const matches = allDocs.filter((l) => sameStr(l.lineName, target));
    if (matches.length === 0) {
      console.warn(`[seedHH] No productionLines doc matches "${target}" — skipping this line entirely.`);
      continue;
    }
    if (matches.length > 1) {
      console.warn(`[seedHH] AMBIGUOUS: ${matches.length} productionLines docs match "${target}":`);
      matches.forEach((m) => console.warn(`    id=${m.id}  lineName=${JSON.stringify(m.lineName)}  plant=${m.plant}  workshop=${m.workshop}  division=${m.division}`));
      console.warn(`    Add "${target}": "<correct doc id>" to LINE_ID_OVERRIDES above and re-run. Skipping for now.`);
      continue;
    }
    const doc = matches[0];
    if (doc.parts.length === 0) {
      console.warn(`[seedHH] "${target}" (${doc.id}) has no usable parts (parts/models/partsList with a name + cycleTimeSeconds) — skipping, no fake part will be invented.`);
      continue;
    }
    resolved.push({ id: doc.id, lineName: doc.lineName ?? target, plant: doc.plant, workshop: doc.workshop, division: doc.division, parts: doc.parts });
    console.log(`[seedHH] "${target}" -> ${doc.id} (lineName=${doc.lineName}, ${doc.parts.length} part(s))`);
  }
  return resolved;
}

// ─── Record generation ──────────────────────────────────────────────────

function generateRecordsForSession(line: ResolvedLine, productionDate: string, shift: 'A' | 'B') {
  const otHours = Math.random() < OT_PROBABILITY ? randInt(1, 2) : 0;
  const slots = buildSlots(shift, otHours);
  const part = pick(line.parts); // "if a line has multiple parts, randomly use its real parts"
  const operators = makeRoster(`${line.id}-${productionDate}-${shift}`, randInt(2, 4));
  const supervisor = makeSupervisor();

  const docs: any[] = [];

  slots.forEach((s) => {
    const expected = expectedPartsFor(part.cycleTimeSeconds, s.productiveMinutes);
    if (expected <= 0) return; // nothing plannable this slot (e.g. fully within a break) — real app wouldn't save one either

    const lowPerf = Math.random() < LOW_PERFORMANCE_PROBABILITY;
    const factor = lowPerf ? randFloat(0.5, 0.85) : randFloat(0.85, 1.0);
    const produced = Math.max(0, Math.min(expected, Math.round(expected * factor)));
    const lossParts = Math.max(0, expected - produced);
    const lossReason = lossParts > 0 ? pick(LOSS_REASONS) : null;

    // Rejections: usually 0, occasionally a small fraction of produced.
    const rejections = Math.random() < 0.3 ? randInt(1, Math.max(1, Math.round(produced * 0.03))) : 0;

    // Most slots: no downtime. Some: one realistic stop event.
    const stopEvents: { reason: string; startAbs: number; endAbs: number; durationMinutes: number }[] = [];
    if (Math.random() < STOP_EVENT_PROBABILITY) {
      const stopDuration = randInt(5, Math.min(25, s.durationMinutes - 5 > 5 ? s.durationMinutes - 5 : 10));
      const latestStart = Math.max(s.startMinutesAbs, s.endMinutesAbs - stopDuration);
      const startAbs = randInt(s.startMinutesAbs, latestStart);
      stopEvents.push({ reason: pick(STOP_REASONS), startAbs, endAbs: startAbs + stopDuration, durationMinutes: stopDuration });
    }

    docs.push({
      shift,
      plant: line.plant,
      workshop: line.workshop,
      division: line.division,
      lineId: line.id,
      lineName: line.lineName,
      partName: part.name,
      productionDate,
      slotIndex: s.index,
      slotLabel: s.label,
      slotStartMinutesAbs: s.startMinutesAbs,
      slotEndMinutesAbs: s.endMinutesAbs,
      slotDurationMinutes: s.durationMinutes,
      productiveMinutes: s.productiveMinutes,
      expectedParts: expected,
      producedThisSlot: produced,
      lossParts,
      lossTimeMinutes: lossTimeMinutesFor(part.cycleTimeSeconds, lossParts),
      lossReasonCode: lossReason?.code ?? null,
      lossReasonLabel: lossReason?.label ?? null,
      rejections,
      stopEvents,
      supervisor,
      operators,
      isSampleData: true,
      createdAt: createdAtFor(productionDate, s.startMinutesAbs),
    });
  });

  return docs;
}

// ─── Batched writes ─────────────────────────────────────────────────────

async function writeBatched(docs: any[]) {
  let written = 0;
  for (let i = 0; i < docs.length; i += FIRESTORE_BATCH_LIMIT) {
    const chunk = docs.slice(i, i + FIRESTORE_BATCH_LIMIT);
    const batch = db.batch();
    chunk.forEach((docData) => {
      const ref = db.collection(SAMPLE_COLLECTION).doc(); // auto-ID — collection is created on first write automatically
      batch.set(ref, docData);
    });
    await batch.commit();
    written += chunk.length;
    console.log(`[seedHH] Wrote ${written}/${docs.length} record(s)...`);
  }
  return written;
}

async function deleteSampleData() {
  console.log(`[seedHH] Deleting docs where isSampleData == true from ${SAMPLE_COLLECTION}...`);
  const snap = await db.collection(SAMPLE_COLLECTION).where('isSampleData', '==', true).get();
  if (snap.empty) {
    console.log('[seedHH] Nothing to delete — no matching docs found.');
    return;
  }
  const docsToDelete = snap.docs;
  let deleted = 0;
  for (let i = 0; i < docsToDelete.length; i += FIRESTORE_BATCH_LIMIT) {
    const chunk = docsToDelete.slice(i, i + FIRESTORE_BATCH_LIMIT);
    const batch = db.batch();
    chunk.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    deleted += chunk.length;
    console.log(`[seedHH] Deleted ${deleted}/${docsToDelete.length}...`);
  }
  console.log(`[seedHH] Done — deleted ${deleted} sample record(s).`);
}

// ─── Main ───────────────────────────────────────────────────────────────

async function main() {
  const clearMode = process.argv.includes('--clear');

  if (clearMode) {
    await deleteSampleData();
    return;
  }

  console.log(`[seedHH] Resolving target HH lines from productionLines...`);
  const lines = await resolveTargetLines();
  // All-or-nothing: with LINE_ID_OVERRIDES now pinned for all 7 lines, a
  // partial resolution means something is wrong (bad ID, renamed line, no
  // parts) — write nothing until every one of the 7 resolves cleanly, so a
  // half-seeded dataset never silently lands in Firestore.
  if (lines.length < TARGET_LINE_NAMES.length) {
    console.error(
      `[seedHH] Only ${lines.length}/${TARGET_LINE_NAMES.length} target line(s) resolved successfully. ` +
      `Aborting WITHOUT writing anything — fix the warning(s) above (bad/mismatched LINE_ID_OVERRIDES entry, ` +
      `or a line with no usable parts) and re-run.`
    );
    process.exitCode = 1;
    return;
  }

  const dates = eachDateStr(START_DATE, END_DATE);
  console.log(`[seedHH] Generating ${dates.length} day(s) x ${lines.length} line(s) x 2 shifts...`);

  const allDocs: any[] = [];
  for (const line of lines) {
    for (const productionDate of dates) {
      for (const shift of ['A', 'B'] as const) {
        allDocs.push(...generateRecordsForSession(line, productionDate, shift));
      }
    }
  }

  console.log(`[seedHH] Generated ${allDocs.length} slot record(s) in memory. Writing to "${SAMPLE_COLLECTION}"...`);
  const written = await writeBatched(allDocs);
  console.log(`[seedHH] Done — wrote ${written} record(s) to ${SAMPLE_COLLECTION}. Every doc has isSampleData: true.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seedHH] FAILED:', e);
    process.exit(1);
  });