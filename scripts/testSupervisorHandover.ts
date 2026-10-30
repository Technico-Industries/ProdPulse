// scripts/testSupervisorHandover.ts
//
// Checks for the supervisor handover / Running Lines workflow:
//   • dashboard → Running Lines navigation (swipe pager + tappable tabs and
//     edge arrow, wired for the plain Supervisor role) — source checks, as
//     the project has no React renderer in its tests;
//   • Running Lines cards: plan vs actual, status, model, slot progress
//     (src/utils/supervisorHandover.ts);
//   • Supervisor A starting a session and B continuing the SAME session,
//     against a simulated activeSessions doc + productionRecords collection
//     that applies the screen's own sync rules (planSessionSync,
//     syncAttributionFields, recorderIdentity, splitCreateOnlyFields,
//     productionRecordId);
//   • concurrency, model changes, Shift B overnight dates, stopped /
//     completed / no-session states.
// Plain node:assert script:
//   npm run test:supervisor-handover

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DraftStorage,
  SyncConflict,
  SyncState,
  createDraft,
  draftStorageKey,
  emptySyncState,
  loadDraft,
  planSessionSync,
  productionRecordId,
  saveDraft,
  sessionWriteGate,
} from '../src/utils/productionDraft';
import { productionDayKeyFor, productionDayMinuteToMillis } from '../src/utils/productionDay';
import { buildSlots, expectedPartsFor } from '../src/utils/productionSchedule';
import {
  RunningRecord,
  buildRunningLineCards,
  currentModel,
  isHandover,
  isSupervisorsSession,
  parseRunningSession,
  recorderIdentity,
  sessionNowAbs,
  slotEntryStatuses,
  splitCreateOnlyFields,
  syncAttributionFields,
} from '../src/utils/supervisorHandover';

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}`);
    throw e;
  }
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const ROOT = join(__dirname, '..');
const src = (p: string) => readFileSync(join(ROOT, p), 'utf8');

// ─── Simulated Firestore ─────────────────────────────────────────────────────
// activeSessions/{lineId} and productionRecords/{id}. Timestamps are plain
// epoch ms (timestampToMillis accepts them).

type SessionDoc = Record<string, any>;
const ARRAY_UNION = Symbol('arrayUnion');
const fakeArrayUnion = (...uids: string[]) => ({ [ARRAY_UNION]: uids });

class FakeDb {
  sessions = new Map<string, SessionDoc>();
  records = new Map<string, Record<string, any>>();
  sessionWrites = 0;
  online = true;

  // tx.update semantics, including the arrayUnion sentinel.
  updateSession(lineId: string, payload: Record<string, any>) {
    const cur = this.sessions.get(lineId);
    if (!cur) throw new Error('not-found');
    const next = { ...cur };
    for (const [k, v] of Object.entries(payload)) {
      if (v && typeof v === 'object' && ARRAY_UNION in v) {
        const add = (v as any)[ARRAY_UNION] as string[];
        next[k] = Array.from(new Set([...(Array.isArray(cur[k]) ? cur[k] : []), ...add]));
      } else next[k] = v;
    }
    this.sessions.set(lineId, next);
    this.sessionWrites++;
  }
}

function stateOf(d: SessionDoc): SyncState {
  return {
    ...emptySyncState(),
    producedBySlot: { ...(d.producedBySlot ?? {}) },
    producedSegment: { ...(d.producedSegment ?? {}) },
    rejectionsBySlot: { ...(d.rejectionsBySlot ?? {}) },
    lossReasonBySlot: { ...(d.lossReasonBySlot ?? {}) },
    changeovers: { ...(d.changeovers ?? {}) },
    deletedSlotIndices: [...(d.deletedSlotIndices ?? [])],
    savedSlotIndices: [...(d.savedSlotIndices ?? [])],
    stopsBySlot: { ...(d.stopsBySlot ?? {}) },
    otHours: d.otHours ?? 0,
    operators: d.operators ?? [],
    syncConflicts: { ...(d.syncConflicts ?? {}) },
    deletedSlotBackups: { ...(d.deletedSlotBackups ?? {}) },
  };
}

function memoryStorage(): DraftStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: async (k) => map.get(k) ?? null,
    setItem: async (k, v) => { map.set(k, v); },
    removeItem: async (k) => { map.delete(k); },
  };
}

const PARTS = [{ name: 'Bracket-A', cycleTimeSeconds: 30 }, { name: 'Bracket-B', cycleTimeSeconds: 45 }];

// One supervisor on one device, doing what RecordProductionScreen does.
class Supervisor {
  base: { revision: number; state: SyncState } | null = null;
  local: SyncState = emptySyncState();
  lineId: string | null = null;
  doc: SessionDoc | null = null; // as last opened
  conflicts: SyncConflict[] = [];
  storage = memoryStorage();
  constructor(public uid: string, public profileName: string, public db: FakeDb, public deviceId = `dev-${uid}`) {}

  // handleStartProduction / beginSession.
  start(lineId: string, shift: 'A' | 'B', startedMs: number, startAbs: number, otHours = 0) {
    const pd = productionDayKeyFor(startedMs);
    const planned = buildSlots(shift, otHours, [], startAbs).reduce((s, sl) => s + expectedPartsFor(PARTS[0].cycleTimeSeconds, sl.productiveMinutes), 0);
    const d: SessionDoc = {
      lineId, lineName: `Line ${lineId}`, plant: 'P1', workshop: 'Assembly', division: 'D1', shift, otHours,
      selectedPartIndex: 0, supervisorName: this.profileName, supervisorCode: `${this.uid}-code`, supervisorUid: this.uid,
      operators: [{ id: 'op1', name: 'Op', code: '1' }], producedBySlot: {}, rejectionsBySlot: {}, stopsBySlot: {},
      changeovers: {}, producedSegment: {}, deletedSlotIndices: [], lineStopped: false, productionDate: pd,
      plannedProductionTotal: planned, productionStartMinutesAbs: startAbs, lossReasonBySlot: {}, savedSlotIndices: [],
      sessionInstanceId: `inst-${lineId}-${startedMs}`, revision: 1, syncConflicts: {},
      updatedBy: { uid: this.uid, deviceId: this.deviceId, name: this.profileName }, contributorUids: [this.uid],
      startedAt: startedMs, updatedAt: startedMs,
    };
    this.db.sessions.set(lineId, d);
    this.db.sessionWrites++;
    return this.open(lineId)!;
  }

  // openSession: read the CURRENT doc (+ this device's draft); never writes.
  open(lineId: string): SessionDoc | null {
    const d = this.db.sessions.get(lineId);
    if (!d) return null;
    this.lineId = lineId;
    this.doc = clone(d);
    this.base = { revision: d.revision, state: stateOf(d) };
    this.local = stateOf(d);
    return this.doc;
  }

  get scope() {
    const d = this.doc!;
    return { uid: this.uid, lineId: this.lineId!, productionDate: d.productionDate, shift: d.shift, sessionInstance: d.sessionInstanceId };
  }

  async edit(fn: (s: SyncState) => void) {
    fn(this.local);
    await saveDraft(this.storage, createDraft(this.scope, this.base!.state, this.base!.revision, this.local, Date.now(), Date.now()));
  }

  get recorder() {
    const d = this.doc!;
    return recorderIdentity(
      { startedBy: { uid: d.supervisorUid, name: d.supervisorName }, supervisorName: d.supervisorName, supervisorCode: d.supervisorCode },
      { uid: this.uid, profileName: this.profileName, profileCode: `${this.uid}-code` }
    );
  }

  // writeSessionNow's update branch: transaction → planSessionSync → update
  // with the sync payload (no starter fields) + attribution.
  sync(preferLocalKeys?: Set<string>): boolean {
    if (!this.db.online) return false;
    const remote = this.db.sessions.get(this.lineId!);
    const gone = sessionWriteGate({ exists: !!remote, sessionInstanceId: remote?.sessionInstanceId }, this.doc!.sessionInstanceId);
    if (gone) return false;
    const plan = planSessionSync(this.base, clone(this.local), { revision: remote!.revision, state: stateOf(remote!) }, { preferLocalKeys, deviceId: this.deviceId, nowMs: Date.now() });
    this.db.updateSession(this.lineId!, {
      ...clone(plan.merged),
      revision: plan.revision,
      lineStopped: Object.values(plan.merged.stopsBySlot).some((arr: any) => arr.some((s: any) => s.running)),
      ...syncAttributionFields({ uid: this.uid, name: this.recorder.name, deviceId: this.deviceId }, fakeArrayUnion),
      updatedAt: Date.now(),
    });
    this.conflicts.push(...plan.conflicts);
    this.base = { revision: plan.revision, state: clone(plan.merged) };
    this.local = clone(plan.merged);
    return true;
  }

  // onSnapshot: adopt a newer revision when nothing is pending here.
  receive() {
    const d = this.db.sessions.get(this.lineId!);
    if (!d || !this.base || d.revision <= this.base.revision) return;
    this.base = { revision: d.revision, state: stateOf(d) };
    this.local = stateOf(d);
  }

  // Save Slot: upsert the slot's record (deterministic id, createdBy kept
  // from the first save), then sync with the slot marked saved.
  async saveSlot(slotIndex: number, produced: number, rejections = 0) {
    const d = this.doc!;
    await this.edit((s) => {
      s.producedBySlot[String(slotIndex)] = produced;
      if (rejections) s.rejectionsBySlot[String(slotIndex)] = rejections;
    });
    const slot = buildSlots(d.shift, d.otHours, [], d.productionStartMinutesAbs).find((s) => s.index === slotIndex)!;
    const rec = this.recorder;
    const data = {
      shift: d.shift, lineId: this.lineId, lineName: d.lineName, productionDate: d.productionDate, slotIndex,
      partName: PARTS[0].name, producedThisSlot: produced, rejections,
      expectedParts: expectedPartsFor(PARTS[0].cycleTimeSeconds, slot.productiveMinutes),
      supervisor: { name: rec.name, code: rec.code, uid: rec.uid },
      sessionSupervisor: { name: d.supervisorName, code: d.supervisorCode, uid: d.supervisorUid },
      createdBy: { name: rec.name, uid: rec.uid },
      createdAt: 'server-time',
    };
    const id = productionRecordId({ productionDate: d.productionDate, lineId: this.lineId!, shift: d.shift, slotIndex, segment: 'full' });
    const { fields, createOnly } = splitCreateOnlyFields(data);
    const existing = this.db.records.get(id);
    this.db.records.set(id, existing ? { ...existing, ...fields } : { ...fields, ...createOnly, id });
    if (!this.local.savedSlotIndices.includes(slotIndex)) this.local.savedSlotIndices.push(slotIndex);
    return this.sync(new Set([`producedBySlot|${slotIndex}`, `rejectionsBySlot|${slotIndex}`]));
  }
}

function recordsOf(db: FakeDb): RunningRecord[] {
  return [...db.records.values()].map((r) => ({
    id: r.id, lineId: r.lineId, shift: r.shift, productionDate: r.productionDate, expectedParts: r.expectedParts,
    producedThisSlot: r.producedThisSlot, rejections: r.rejections, partName: r.partName, slotIndex: r.slotIndex,
    partSegment: r.partSegment ?? null, createdAtMs: 1, updatedAtMs: 1,
  }));
}

// Local wall-clock instants on a production day.
const at = (day: string, minuteAbs: number) => productionDayMinuteToMillis(day, minuteAbs);
const DAY = '2026-10-28';
const SHIFT_A_START = 7 * 60;

async function main() {
  // ── 1. Navigation ──────────────────────────────────────────────────────
  console.log('Dashboard → Running Lines navigation');

  await test('plain Supervisor dashboard is the pager with Running Lines as page 2', () => {
    const dash = src('src/screens/DashboardScreen.tsx');
    assert.match(dash, /if \(!isTechnician && !isRestocker\) \{\s*return <SupervisorDashboardPager \/>;/);
    const pager = src('src/components/AdminDashboardPager.tsx');
    const pages = pager.slice(pager.indexOf('const SUPERVISOR_PAGES'), pager.indexOf('];', pager.indexOf('const SUPERVISOR_PAGES')));
    assert.ok(pages.indexOf('SupervisorOverviewScreen') < pages.indexOf('RunningLinesScreen'), 'overview first, running lines one swipe left');
  });

  await test('swipe is horizontal paging, and a visible tab + edge arrow reach it without swiping (web)', () => {
    const pager = src('src/components/AdminDashboardPager.tsx');
    assert.match(pager, /horizontal\s+pagingEnabled/);
    assert.match(pager, /directionalLockEnabled/, 'vertical scrolling must not page sideways');
    assert.match(pager, /accessibilityRole="tab"/);
    assert.match(pager, /<DashboardPager pages=\{SUPERVISOR_PAGES\} edgeHint \/>/);
    assert.match(pager, /onPress=\{\(\) => goTo\(page \+ 1\)\}/);
  });

  await test('Running Lines cards open RecordProduction for that exact line', () => {
    const screen = src('src/screens/RunningLinesScreen.tsx');
    assert.match(screen, /navigate\('RecordProduction', \{ lineId: c\.lineId, requestedAt: Date\.now\(\) \}\)/);
    const app = src('App.tsx');
    assert.match(app, /RecordProduction: \{ lineId\?: string; requestedAt\?: number \} \| undefined;/);
  });

  await test('admin and quality pagers are unchanged', () => {
    const pager = src('src/components/AdminDashboardPager.tsx');
    assert.match(pager, /return <DashboardPager pages=\{ADMIN_PAGES\} overlay=\{<ProdAIButton \/>\} \/>;/);
    assert.match(pager, /return <DashboardPager pages=\{QUALITY_PAGES\} \/>;/);
  });

  await test('a sync never rewrites the session starter (sessionPayload has no supervisor fields)', () => {
    const rp = src('src/screens/RecordProductionScreen.tsx');
    const body = rp.slice(rp.indexOf('function sessionPayload('), rp.indexOf('async function writeSessionNow('));
    assert.doesNotMatch(body, /supervisorUid\s*:/);
    assert.doesNotMatch(body, /supervisorName\s*:/);
    assert.match(body, /syncAttributionFields\(/);
  });

  // ── 2–5. A starts, B continues ─────────────────────────────────────────
  console.log('Supervisor A → B handover');

  const db = new FakeDb();
  const A = new Supervisor('uid-A', 'Asha', db);
  const B = new Supervisor('uid-B', 'Bilal', db);

  await test('A starts Line 12 and saves hourly slots 7 AM – 2 PM', async () => {
    A.start('L12', 'A', at(DAY, SHIFT_A_START + 2), SHIFT_A_START);
    for (const i of [0, 1, 2, 3, 4, 6]) assert.equal(await A.saveSlot(i, 100 + i, i === 2 ? 3 : 0), true);
    const d = db.sessions.get('L12')!;
    assert.deepEqual(d.savedSlotIndices, [0, 1, 2, 3, 4, 6]);
    assert.equal(db.records.size, 6);
  });

  const docBeforeB = clone(db.sessions.get('L12')!);
  const writesBeforeB = db.sessionWrites;

  await test('B opens the same session and sees A\'s saved data — opening writes nothing', () => {
    const d = B.open('L12')!;
    assert.equal(db.sessionWrites, writesBeforeB);
    assert.equal(d.sessionInstanceId, docBeforeB.sessionInstanceId);
    assert.equal(B.local.producedBySlot['6'], 106);
    assert.equal(B.local.rejectionsBySlot['2'], 3);
    assert.deepEqual(B.local.savedSlotIndices, [0, 1, 2, 3, 4, 6]);
    assert.equal(isHandover(d.supervisorUid, B.uid), true);
    assert.equal(isHandover(d.supervisorUid, A.uid), false);
  });

  await test('B fills the remaining slots in the SAME session doc and records', async () => {
    assert.equal(await B.saveSlot(7, 120), true);
    assert.equal(await B.saveSlot(8, 50), true);
    assert.equal(db.sessions.size, 1, 'no second session');
    const d = db.sessions.get('L12')!;
    assert.deepEqual(d.savedSlotIndices, [0, 1, 2, 3, 4, 6, 7, 8]);
    assert.equal(db.records.size, 8, 'one record per slot, deterministic ids');
    assert.equal(new Set([...db.records.keys()]).size, 8);
  });

  await test('handover keeps A as starter, date, shift, session id and start time', () => {
    const d = db.sessions.get('L12')!;
    for (const k of ['supervisorUid', 'supervisorName', 'supervisorCode', 'productionDate', 'shift', 'sessionInstanceId', 'startedAt', 'productionStartMinutesAbs', 'plannedProductionTotal']) {
      assert.deepEqual(d[k], docBeforeB[k], k);
    }
    assert.deepEqual(d.updatedBy, { uid: 'uid-B', deviceId: 'dev-uid-B', name: 'Bilal' });
    assert.deepEqual(d.contributorUids, ['uid-A', 'uid-B']);
  });

  await test('entries are attributed to who saved them; A\'s records untouched', () => {
    const rec = (i: number) => db.records.get(productionRecordId({ productionDate: DAY, lineId: 'L12', shift: 'A', slotIndex: i, segment: 'full' }))!;
    assert.deepEqual(rec(3).supervisor, { name: 'Asha', code: 'uid-A-code', uid: 'uid-A' });
    assert.deepEqual(rec(7).supervisor, { name: 'Bilal', code: 'uid-B-code', uid: 'uid-B' });
    assert.deepEqual(rec(7).sessionSupervisor, { name: 'Asha', code: 'uid-A-code', uid: 'uid-A' });
    assert.deepEqual(rec(7).createdBy, { name: 'Bilal', uid: 'uid-B' });
    assert.equal('createdAt' in rec(7), false, 'createdAt comes from the server timestamp, not the payload');
  });

  await test('B correcting A\'s saved slot updates it but keeps createdBy = A', async () => {
    B.receive();
    assert.equal(await B.saveSlot(3, 99), true);
    const r = db.records.get(productionRecordId({ productionDate: DAY, lineId: 'L12', shift: 'A', slotIndex: 3, segment: 'full' }))!;
    assert.equal(r.producedThisSlot, 99);
    assert.deepEqual(r.createdBy, { name: 'Asha', uid: 'uid-A' });
    assert.deepEqual(r.supervisor, { name: 'Bilal', code: 'uid-B-code', uid: 'uid-B' });
  });

  await test('both supervisors see the line as theirs; A sees B\'s entries live', () => {
    const s = parseRunningSession('L12', db.sessions.get('L12'));
    assert.equal(isSupervisorsSession(s, 'uid-A'), true);
    assert.equal(isSupervisorsSession(s, 'uid-B'), true);
    assert.equal(isSupervisorsSession(s, 'uid-C'), false);
    A.receive();
    assert.equal(A.local.producedBySlot['7'], 120);
  });

  await test('recorder identity: starter keeps their entered name; others use their profile', () => {
    const session = { startedBy: { uid: 'uid-A', name: 'Asha K' }, supervisorName: 'Asha K', supervisorCode: 'A1' };
    assert.deepEqual(recorderIdentity(session, { uid: 'uid-A', profileName: 'Asha', profileCode: 'x' }), { uid: 'uid-A', name: 'Asha K', code: 'A1' });
    assert.deepEqual(recorderIdentity(session, { uid: 'uid-B', profileName: 'Bilal', profileCode: 'B1' }), { uid: 'uid-B', name: 'Bilal', code: 'B1' });
    // Legacy doc without a starter uid: never a handover.
    assert.equal(isHandover(null, 'uid-B'), false);
  });

  // ── 2. Running Lines card values ───────────────────────────────────────
  console.log('Running Lines cards');

  await test('plan vs actual come from the saved records of the session', () => {
    const s = parseRunningSession('L12', db.sessions.get('L12'));
    const [card] = buildRunningLineCards([s], recordsOf(db), { L12: PARTS }, at(DAY, 15 * 60 + 40));
    const recs = recordsOf(db);
    const actual = recs.reduce((n, r) => n + (r.producedThisSlot ?? 0), 0);
    const planned = recs.reduce((n, r) => n + (r.expectedParts ?? 0), 0);
    assert.equal(card.actual, actual);
    assert.equal(card.planToDate, planned);
    assert.equal(card.variance, actual - planned);
    assert.equal(card.rejections, 3);
    assert.equal(card.shiftPlan, db.sessions.get('L12')!.plannedProductionTotal);
    assert.equal(card.startedBy, 'Asha');
    assert.equal(card.lastUpdatedBy, 'Bilal');
    assert.equal(card.model, 'Bracket-A');
    assert.equal(card.section, 'D1 • Assembly');
    assert.equal(card.status, 'running');
  });

  await test('records of other lines / dates / shifts never count', () => {
    const s = parseRunningSession('L12', db.sessions.get('L12'));
    const noise: RunningRecord[] = [
      { id: 'x1', lineId: 'L13', shift: 'A', productionDate: DAY, expectedParts: 500, producedThisSlot: 500, slotIndex: 0 },
      { id: 'x2', lineId: 'L12', shift: 'B', productionDate: DAY, expectedParts: 500, producedThisSlot: 500, slotIndex: 0 },
      { id: 'x3', lineId: 'L12', shift: 'A', productionDate: '2026-10-27', expectedParts: 500, producedThisSlot: 500, slotIndex: 0 },
    ];
    const base = buildRunningLineCards([s], recordsOf(db), {}, at(DAY, 900))[0];
    const withNoise = buildRunningLineCards([s], [...recordsOf(db), ...noise], {}, at(DAY, 900))[0];
    assert.equal(withNoise.actual, base.actual);
    assert.equal(withNoise.planToDate, base.planToDate);
  });

  await test('slot progress: completed vs awaiting entry vs current', () => {
    const s = parseRunningSession('L12', { ...db.sessions.get('L12'), savedSlotIndices: [0, 1, 2] });
    const st = slotEntryStatuses(s, 14 * 60 + 30); // 2:30 PM
    assert.deepEqual(st.completed, [0, 1, 2]);
    assert.deepEqual(st.awaiting, [3, 4, 6]); // 12:15–12:45 lunch slot (5) is neither
    assert.equal(st.current, 7);
    assert.deepEqual(st.upcoming, [8]);
    const [card] = buildRunningLineCards([s], [], {}, at(DAY, 14 * 60 + 30));
    assert.equal(card.status, 'awaiting_entry');
  });

  await test('cards sort stopped → awaiting entry → running', () => {
    const mk = (id: string, extra: object) => parseRunningSession(id, { ...db.sessions.get('L12'), lineId: id, lineName: id, ...extra });
    const cards = buildRunningLineCards(
      [mk('C', { savedSlotIndices: [0, 1, 2, 3, 4, 6, 7, 8] }), mk('B', { savedSlotIndices: [] }), mk('A', { lineStopped: true })],
      [], {}, at(DAY, 14 * 60 + 30)
    );
    assert.deepEqual(cards.map((c) => [c.lineId, c.status]), [['A', 'stopped'], ['B', 'awaiting_entry'], ['C', 'running']]);
  });

  // ── 6. Drafts survive refresh / device change ──────────────────────────
  console.log('Drafts and refreshes');

  await test('B\'s unsynced draft survives an app restart on B\'s device', async () => {
    B.open('L12');
    await B.edit((s) => { s.producedBySlot['8'] = 55; });
    const loaded = await loadDraft(B.storage, B.scope);
    assert.equal(loaded.ok, true);
    assert.equal(loaded.ok && loaded.draft.local.producedBySlot['8'], 55);
  });

  await test('drafts are per supervisor: A and B never share a draft key', () => {
    assert.notEqual(draftStorageKey({ ...A.scope }), draftStorageKey({ ...B.scope, uid: 'uid-B' }));
    assert.notEqual(draftStorageKey(A.scope), draftStorageKey(B.scope));
  });

  await test('a new device sees every synced value (server copy)', () => {
    const fresh = new Supervisor('uid-B', 'Bilal', db, 'dev-B2');
    fresh.open('L12');
    assert.equal(fresh.local.producedBySlot['7'], 120);
    assert.equal(fresh.local.producedBySlot['3'], 99);
  });

  // ── 7–8. Concurrency ───────────────────────────────────────────────────
  console.log('Concurrent supervisors');

  await test('A and B editing DIFFERENT slots: both values kept, no conflict', async () => {
    const db2 = new FakeDb();
    const a = new Supervisor('uid-A', 'Asha', db2);
    const b = new Supervisor('uid-B', 'Bilal', db2);
    a.start('L1', 'A', at(DAY, SHIFT_A_START), SHIFT_A_START);
    b.open('L1');
    await a.edit((s) => { s.producedBySlot['0'] = 10; });
    await b.edit((s) => { s.producedBySlot['1'] = 20; });
    assert.equal(a.sync(), true);
    assert.equal(b.sync(), true);
    const d = db2.sessions.get('L1')!;
    assert.equal(d.producedBySlot['0'], 10);
    assert.equal(d.producedBySlot['1'], 20);
    assert.equal(a.conflicts.length + b.conflicts.length, 0);
  });

  await test('SAME slot via autosave: newer server value kept, other recorded as a conflict', async () => {
    const db2 = new FakeDb();
    const a = new Supervisor('uid-A', 'Asha', db2);
    const b = new Supervisor('uid-B', 'Bilal', db2);
    a.start('L1', 'A', at(DAY, SHIFT_A_START), SHIFT_A_START);
    b.open('L1');
    await a.edit((s) => { s.producedBySlot['2'] = 30; });
    await b.edit((s) => { s.producedBySlot['2'] = 33; });
    a.sync();
    b.sync();
    const d = db2.sessions.get('L1')!;
    assert.equal(d.producedBySlot['2'], 30, 'B\'s draft does not silently overwrite A\'s newer data');
    const c = Object.values(d.syncConflicts).find(Boolean) as SyncConflict;
    assert.equal(c.field, 'producedBySlot');
    assert.equal(c.otherValue, 33);
  });

  await test('SAME slot via Save Slot: explicit save wins, the overwritten value is kept as a conflict', async () => {
    const db2 = new FakeDb();
    const a = new Supervisor('uid-A', 'Asha', db2);
    const b = new Supervisor('uid-B', 'Bilal', db2);
    a.start('L1', 'A', at(DAY, SHIFT_A_START), SHIFT_A_START);
    b.open('L1');
    await a.saveSlot(2, 30);
    await b.saveSlot(2, 33);
    const d = db2.sessions.get('L1')!;
    assert.equal(d.producedBySlot['2'], 33);
    const c = Object.values(d.syncConflicts).find(Boolean) as SyncConflict;
    assert.equal(c.otherValue, 30);
    assert.equal(db2.records.size, 1, 'one record for the slot');
  });

  await test('offline: sync fails without writing; the draft is kept and syncs on reconnect', async () => {
    const db2 = new FakeDb();
    const a = new Supervisor('uid-A', 'Asha', db2);
    a.start('L1', 'A', at(DAY, SHIFT_A_START), SHIFT_A_START);
    db2.online = false;
    await a.edit((s) => { s.producedBySlot['0'] = 7; });
    assert.equal(a.sync(), false);
    assert.equal(db2.sessions.get('L1')!.producedBySlot['0'], undefined);
    assert.equal((await loadDraft(a.storage, a.scope)).ok, true);
    db2.online = true;
    assert.equal(a.sync(), true);
    assert.equal(db2.sessions.get('L1')!.producedBySlot['0'], 7);
  });

  // ── 9. Model change ────────────────────────────────────────────────────
  console.log('Model changes');

  await test('current model follows the latest started changeover', () => {
    const s = parseRunningSession('L12', {
      ...db.sessions.get('L12'),
      changeovers: { 3: { slotIndex: 3, atAbs: 620, startAbs: 620, endAbs: 630, oldPartIndex: 0, newPartIndex: 1 } },
    });
    assert.equal(currentModel(s, PARTS, 600, []), 'Bracket-A');
    assert.equal(currentModel(s, PARTS, 640, []), 'Bracket-B');
    // No part list: newest saved record's part name.
    assert.equal(currentModel(s, undefined, 640, [{ id: 'r', lineId: 'L12', shift: 'A', productionDate: DAY, expectedParts: 1, producedThisSlot: 1, slotIndex: 3, partSegment: 'after', partName: 'Bracket-B' }]), 'Bracket-B');
  });

  await test('a split slot (before + after) counts once each; stale full record ignored', () => {
    const s = parseRunningSession('L12', { ...db.sessions.get('L12') });
    const r = (seg: string | null, produced: number, upd: number): RunningRecord => ({
      id: productionRecordId({ productionDate: DAY, lineId: 'L12', shift: 'A', slotIndex: 3, segment: (seg ?? 'full') as any }),
      lineId: 'L12', shift: 'A', productionDate: DAY, slotIndex: 3, partSegment: seg, expectedParts: 50, producedThisSlot: produced, createdAtMs: 1, updatedAtMs: upd,
    });
    const [card] = buildRunningLineCards([s], [r(null, 999, 1), r('before', 40, 5), r('after', 45, 5)], {}, at(DAY, 900));
    assert.equal(card.actual, 85);
    assert.equal(card.planToDate, 100);
  });

  await test('changeover time is non-productive in slot status (schedule unchanged)', () => {
    const s = parseRunningSession('L12', {
      ...db.sessions.get('L12'), savedSlotIndices: [],
      changeovers: { 3: { slotIndex: 3, atAbs: 620, startAbs: 620, endAbs: 630, oldPartIndex: 0, newPartIndex: 1 } },
    });
    const st = slotEntryStatuses(s, 11 * 60);
    assert.deepEqual(st.awaiting, [0, 1, 2, 3]);
    assert.equal(st.current, 4);
  });

  // ── 10. Shift B overnight ──────────────────────────────────────────────
  console.log('Shift B overnight');

  await test('Shift B after midnight and in OT keeps the start day; viewer clock never moves it', async () => {
    const db3 = new FakeDb();
    const a = new Supervisor('uid-A', 'Asha', db3);
    const b = new Supervisor('uid-B', 'Bilal', db3);
    a.start('L7', 'B', at(DAY, 19 * 60 + 1), 19 * 60, 4); // 7 PM, 4h OT → 07:30 next morning
    assert.equal(db3.sessions.get('L7')!.productionDate, DAY);
    // B opens at 07:10 on the 29th — after the 6:30 cutover, so "today" is the 29th.
    const viewNow = at(DAY, 24 * 60 + 7 * 60 + 10);
    assert.equal(productionDayKeyFor(viewNow), '2026-10-29');
    b.open('L7');
    assert.equal(await b.saveSlot(6, 40), true); // 01:00–02:00
    const d = db3.sessions.get('L7')!;
    assert.equal(d.productionDate, DAY);
    const rid = productionRecordId({ productionDate: DAY, lineId: 'L7', shift: 'B', slotIndex: 6, segment: 'full' });
    assert.equal(db3.records.get(rid)!.productionDate, DAY);
    const s = parseRunningSession('L7', d);
    assert.equal(s.productionDate, DAY);
    assert.equal(sessionNowAbs(s.productionDate, viewNow), 24 * 60 + 7 * 60 + 10);
    const st = slotEntryStatuses(s, sessionNowAbs(s.productionDate, viewNow));
    assert.ok(st.completed.includes(6));
    assert.ok(st.awaiting.includes(5), '00:00–01:00 ended without an entry');
    assert.equal(st.current, 12, '07:00–07:30 OT slot is running');
  });

  await test('legacy doc without productionDate derives it from startedAt, not now', () => {
    const s = parseRunningSession('L7', { shift: 'B', startedAt: at(DAY, 19 * 60 + 5) });
    assert.equal(s.productionDate, DAY);
  });

  // ── 11. Stopped / completed / no session ───────────────────────────────
  console.log('Session states');

  await test('stopped line with an open session shows Stopped; opening does not resume it', () => {
    const db4 = new FakeDb();
    const a = new Supervisor('uid-A', 'Asha', db4);
    const b = new Supervisor('uid-B', 'Bilal', db4);
    a.start('L3', 'A', at(DAY, SHIFT_A_START), SHIFT_A_START);
    db4.updateSession('L3', { lineStopped: true, stopsBySlot: { 2: [{ id: 'stop-1', reason: 'maintenance', startAbs: 1, running: true }] } });
    const writes = db4.sessionWrites;
    b.open('L3');
    assert.equal(db4.sessionWrites, writes);
    assert.equal(db4.sessions.get('L3')!.lineStopped, true);
    const [card] = buildRunningLineCards([parseRunningSession('L3', db4.sessions.get('L3'))], [], {}, at(DAY, 600));
    assert.equal(card.status, 'stopped');
  });

  await test('completed (finalized) session: gone from the list, never re-created by a late sync', () => {
    const db4 = new FakeDb();
    const a = new Supervisor('uid-A', 'Asha', db4);
    const b = new Supervisor('uid-B', 'Bilal', db4);
    a.start('L4', 'A', at(DAY, SHIFT_A_START), SHIFT_A_START);
    b.open('L4');
    db4.sessions.delete('L4'); // Finalize & End
    assert.equal(b.sync(), false);
    assert.equal(db4.sessions.has('L4'), false);
    assert.equal(b.open('L4'), null);
    assert.deepEqual(buildRunningLineCards([], [], {}, Date.now()), []);
  });

  await test('a session restarted on the line is a different run — the old one can\'t write into it', () => {
    const db4 = new FakeDb();
    const a = new Supervisor('uid-A', 'Asha', db4);
    const b = new Supervisor('uid-B', 'Bilal', db4);
    a.start('L5', 'A', at(DAY, SHIFT_A_START), SHIFT_A_START);
    b.open('L5');
    db4.sessions.delete('L5');
    a.start('L5', 'A', at(DAY, SHIFT_A_START + 60), SHIFT_A_START + 60);
    assert.equal(b.sync(), false);
    assert.equal(sessionWriteGate({ exists: true, sessionInstanceId: db4.sessions.get('L5')!.sessionInstanceId }, b.doc!.sessionInstanceId), 'replaced');
  });

  await test('original supervisor unavailable: B continues with no dependency on A', async () => {
    const db4 = new FakeDb();
    const a = new Supervisor('uid-A', 'Asha', db4);
    a.start('L6', 'A', at(DAY, SHIFT_A_START), SHIFT_A_START);
    // A never comes back.
    const b = new Supervisor('uid-B', 'Bilal', db4);
    b.open('L6');
    assert.equal(await b.saveSlot(0, 90), true);
    assert.equal(db4.sessions.get('L6')!.supervisorUid, 'uid-A');
  });

  console.log(`\n${passed} passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
