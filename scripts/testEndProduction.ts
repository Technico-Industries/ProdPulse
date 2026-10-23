// scripts/testEndProduction.ts
//
// Checks for the admin "End Production" action (src/utils/endProduction.ts)
// against an in-memory Firestore with optimistic transactions (a
// transaction whose read docs changed before commit is retried, like
// Firestore's), together with the supervisor side's sync transaction built
// from the same helpers RecordProductionScreen uses (sessionWriteGate +
// planSessionSync) and Save Slot's record upsert (productionRecordId +
// fieldsForRecordUpdate).
// The project has no test runner, so this is a plain node:assert script:
//   npm run test:end-production

import assert from 'node:assert/strict';
import {
  ENDED_SESSIONS_COLLECTION,
  EndProductionActor,
  EndProductionError,
  EndProductionTarget,
  EndProductionTx,
  RunTransaction,
  confirmAndEndProduction,
  endProductionErrorMessage,
  endProductionSession,
  endedSessionId,
  sessionInstanceOf,
} from '../src/utils/endProduction';
import {
  SyncState,
  emptySyncState,
  fieldsForRecordUpdate,
  planSessionSync,
  productionRecordId,
  sessionWriteGate,
} from '../src/utils/productionDraft';
import { buildLineCards, LiveSession } from '../src/utils/lineEfficiency';
import { productionDayKeyFor } from '../src/utils/productionDay';
import { buildSlots } from '../src/utils/productionSchedule';

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

// ─── In-memory Firestore ─────────────────────────────────────────────────────

class FakeDb {
  docs = new Map<string, { data: Record<string, any>; version: number }>();
  private clock = 0;
  commits = 0;
  retries = 0;
  failNextCommit = false;

  put(path: string, data: Record<string, any>) {
    this.docs.set(path, { data: clone(data), version: ++this.clock });
  }
  read(path: string) {
    const d = this.docs.get(path);
    return d ? clone(d.data) : null;
  }

  // Optimistic: reads record the version seen; commit fails (and the
  // function is re-run) if any of them changed.
  async runTransaction<T>(
    fn: (tx: EndProductionTx & { update(path: string, data: Record<string, any>): void }) => Promise<T>
  ): Promise<T> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const seen = new Map<string, number>();
      const writes: (() => void)[] = [];
      const tx = {
        get: async (path: string) => {
          const d = this.docs.get(path);
          seen.set(path, d?.version ?? -1);
          return { exists: !!d, data: d ? clone(d.data) : null };
        },
        set: (path: string, data: Record<string, any>) => { writes.push(() => this.put(path, data)); },
        update: (path: string, data: Record<string, any>) => {
          writes.push(() => {
            const d = this.docs.get(path);
            if (!d) throw new Error(`NOT_FOUND ${path}`);
            this.put(path, { ...d.data, ...data });
          });
        },
        delete: (path: string) => { writes.push(() => { this.docs.delete(path); this.clock++; }); },
      };
      const result = await fn(tx);
      if (this.failNextCommit) { this.failNextCommit = false; throw new Error('unavailable'); }
      const stale = [...seen].some(([p, v]) => (this.docs.get(p)?.version ?? -1) !== v);
      if (stale) { this.retries++; continue; }
      writes.forEach((w) => w());
      this.commits++;
      return result;
    }
    throw new Error('aborted');
  }

  runner(): RunTransaction {
    return (fn) => this.runTransaction(fn);
  }
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const LINE = 'line-JAC-03';
const INSTANCE = 'inst-1';
const SESSION_PATH = `activeSessions/${LINE}`;
const PROD_DATE = '2026-10-21';
const ADMIN = { uid: 'admin-1', name: 'Plant Admin', email: 'admin@example.com' };
const SUPERVISOR = { uid: 'sup-1', name: 'Shift Lead', email: 'lead@example.com' };
const TARGET: EndProductionTarget = { lineId: LINE, lineName: 'JAC-03', sessionInstance: INSTANCE };
const stamps = () => ({ endedAt: 1_000, nowMs: 1_000 });
const archivePath = (instance = INSTANCE) => `${ENDED_SESSIONS_COLLECTION}/${endedSessionId(LINE, instance)}`;

// A running Shift B session with saved and unsaved slots, a loss reason, a
// changeover and a closed stop.
function sessionDoc(over: Record<string, any> = {}): Record<string, any> {
  return {
    lineId: LINE, lineName: 'JAC-03', shift: 'B', otHours: 1, selectedPartIndex: 0,
    supervisorName: 'Shift Lead', supervisorCode: 'S-1', supervisorUid: SUPERVISOR.uid,
    operators: [{ id: 'op-1', name: 'Asha', code: 'O-1' }],
    producedBySlot: { '0': 50, '1': 47, '3': 40 },
    rejectionsBySlot: { '0': 1, '3': 2 },
    producedSegment: { '2:before': 20, '2:after': 25 },
    lossReasonBySlot: { '3': { code: 'material', label: 'Material shortage', note: 'late coil' } },
    changeovers: { '2': { slotIndex: 2, atAbs: 1260, startAbs: 1260, endAbs: 1270, oldPartIndex: 0, newPartIndex: 1 } },
    stopsBySlot: { '1': [{ id: 'stop-1', reason: 'quality', startAbs: 10, endAbs: 20, durationMinutes: 5, running: false }] },
    deletedSlotIndices: [],
    savedSlotIndices: [0],
    syncConflicts: {},
    lineStopped: false,
    productionDate: PROD_DATE,
    productionStartMinutesAbs: 1230,
    plannedProductionTotal: 480,
    sessionInstanceId: INSTANCE,
    revision: 7,
    startedAt: 500,
    ...over,
  };
}

function seed(over: Record<string, any> = {}) {
  const db = new FakeDb();
  db.put('users/admin-1', { role: 'admin', active: true, name: 'Plant Admin' });
  db.put('users/sup-1', { role: 'supervisor', active: true, name: 'Shift Lead' });
  db.put(SESSION_PATH, sessionDoc(over));
  // A slot saved earlier (Save Slot), with its loss reason.
  const savedId = productionRecordId({ productionDate: PROD_DATE, lineId: LINE, shift: 'B', slotIndex: 0, segment: 'full' });
  db.put(`productionRecords/${savedId}`, {
    productionDate: PROD_DATE, lineId: LINE, shift: 'B', slotIndex: 0, producedThisSlot: 50, expectedParts: 60,
    rejections: 1, lossReasonCode: 'tooling', lossReasonLabel: 'Tooling', lossReasonNote: null,
  });
  return db;
}

const adminEnd = (db: FakeDb, target = TARGET, actor: EndProductionActor = ADMIN) => endProductionSession(db.runner(), target, actor, stamps);

function recordsOf(db: FakeDb) {
  return [...db.docs].filter(([p]) => p.startsWith('productionRecords/')).map(([p, d]) => [p, clone(d.data)] as const);
}

function stateFromDoc(d: Record<string, any>): SyncState {
  return {
    ...emptySyncState(),
    producedBySlot: { ...(d.producedBySlot ?? {}) }, producedSegment: { ...(d.producedSegment ?? {}) },
    rejectionsBySlot: { ...(d.rejectionsBySlot ?? {}) }, lossReasonBySlot: { ...(d.lossReasonBySlot ?? {}) },
    changeovers: { ...(d.changeovers ?? {}) }, deletedSlotIndices: [...(d.deletedSlotIndices ?? [])],
    savedSlotIndices: [...(d.savedSlotIndices ?? [])], stopsBySlot: { ...(d.stopsBySlot ?? {}) },
    otHours: d.otHours ?? 0, operators: d.operators ?? [], syncConflicts: { ...(d.syncConflicts ?? {}) },
  };
}

// The supervisor's sync transaction, as in RecordProductionScreen
// writeSessionNow: read → sessionWriteGate → planSessionSync → update.
// `between` runs after the read and before the commit (another device).
async function supervisorSync(
  db: FakeDb,
  base: { revision: number; state: SyncState },
  local: SyncState,
  opts: { extraSavedSlots?: number[]; between?: () => Promise<void> } = {}
): Promise<'synced' | 'finalized' | 'replaced'> {
  let between = opts.between;
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(SESSION_PATH);
      if (between) { const b = between; between = undefined; await b(); }
      const gone = sessionWriteGate({ exists: snap.exists, sessionInstanceId: snap.data?.sessionInstanceId ?? null }, INSTANCE);
      if (gone) throw new EndProductionError('failed', `gone:${gone}`);
      const merged = { ...local, savedSlotIndices: [...new Set([...local.savedSlotIndices, ...(opts.extraSavedSlots ?? [])])] };
      const plan = planSessionSync(base, merged, { revision: snap.data!.revision ?? 0, state: stateFromDoc(snap.data!) }, { deviceId: 'dev-sup', nowMs: 2_000 });
      tx.update(SESSION_PATH, { ...plan.merged, revision: plan.revision });
    });
    return 'synced';
  } catch (e) {
    const m = /^gone:(finalized|replaced)$/.exec((e as Error).message);
    if (m) return m[1] as 'finalized' | 'replaced';
    throw e;
  }
}

// Save Slot's record write (upsertProductionRecord: deterministic ID, merge).
function saveSlotRecord(db: FakeDb, slotIndex: number, fields: Record<string, any>) {
  const id = productionRecordId({ productionDate: PROD_DATE, lineId: LINE, shift: 'B', slotIndex, segment: 'full' });
  const path = `productionRecords/${id}`;
  const existing = db.read(path);
  db.put(path, existing ? { ...existing, ...fieldsForRecordUpdate(fields) } : { productionDate: PROD_DATE, lineId: LINE, shift: 'B', slotIndex, ...fields });
}

function liveSessionsOf(db: FakeDb): LiveSession[] {
  return [...db.docs].filter(([p]) => p.startsWith('activeSessions/')).map(([, d]) => ({
    lineId: d.data.lineId, lineName: d.data.lineName ?? null, shift: d.data.shift ?? null,
    productionDate: d.data.productionDate ?? null, lineStopped: d.data.lineStopped === true,
    stopsBySlot: d.data.stopsBySlot ?? null, startedAtMs: null, updatedAtMs: null,
    sessionInstance: sessionInstanceOf(d.data),
  }));
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('End Production (admin)');

  await test('1. an admin ends an active line: session archived with audit fields, then removed', async () => {
    const db = seed();
    const before = db.read(SESSION_PATH)!;
    const { archiveId } = await adminEnd(db);
    assert.equal(archiveId, endedSessionId(LINE, INSTANCE));
    assert.equal(db.read(SESSION_PATH), null);
    const archive = db.read(archivePath())!;
    assert.equal(archive.sessionStatus, 'ended');
    assert.equal(archive.endReason, 'admin_end');
    assert.equal(archive.endedAt, 1_000);
    assert.deepEqual(archive.endedBy, { uid: 'admin-1', name: 'Plant Admin', email: 'admin@example.com', role: 'admin' });
    assert.equal(archive.archivedFrom, SESSION_PATH);
    for (const [k, v] of Object.entries(before)) assert.deepEqual(archive[k], v, `archive keeps ${k}`);
  });

  await test('2. a non-admin (or deactivated admin, or signed-out user) cannot end a line', async () => {
    for (const [actor, profile] of [
      [SUPERVISOR, null],
      [ADMIN, { role: 'admin', active: false }],
      [{ uid: 'ghost', name: null, email: null }, null],
    ] as const) {
      const db = seed();
      if (profile) db.put('users/admin-1', profile);
      await assert.rejects(adminEnd(db, TARGET, actor as any), (e: any) => e instanceof EndProductionError && e.code === 'not-admin');
      assert.ok(db.read(SESSION_PATH), 'session untouched');
      assert.equal(db.read(archivePath()), null);
    }
    const db = seed();
    await assert.rejects(adminEnd(db, TARGET, { uid: null, name: null, email: null }), (e: any) => e.code === 'not-signed-in');
    assert.ok(db.read(SESSION_PATH));
  });

  await test('3. cancelling the confirmation leaves the session unchanged', async () => {
    const db = seed();
    const before = clone([...db.docs]);
    let endCalls = 0;
    const inFlight = new Set<string>();
    const out = await confirmAndEndProduction(TARGET, {
      inFlight,
      confirm: async (title, message) => {
        assert.equal(title, 'End production for JAC-03?');
        assert.match(message, /end the current production session for this line/);
        assert.match(message, /NOT submitted as production records/);
        return false;
      },
      end: async (t) => { endCalls++; await adminEnd(db, t); },
    });
    assert.deepEqual(out, { kind: 'cancelled' });
    assert.equal(endCalls, 0);
    assert.deepEqual(clone([...db.docs]), before);
    assert.equal(inFlight.size, 0, 'line is not left busy');
  });

  await test('4. a line that is already inactive cannot be ended again', async () => {
    const db = seed();
    await adminEnd(db);
    const archive = db.read(archivePath());
    await assert.rejects(adminEnd(db), (e: any) => e.code === 'not-active');
    assert.deepEqual(db.read(archivePath()), archive, 'archive not rewritten');
    // Finalized by the supervisor (doc gone, no archive) between the dialog and the confirm.
    const db2 = seed();
    db2.docs.delete(SESSION_PATH);
    await assert.rejects(adminEnd(db2), (e: any) => e.code === 'not-active');
    assert.equal(db2.read(archivePath()), null);
    assert.match(endProductionErrorMessage(new EndProductionError('not-active')), /no longer running/);
  });

  await test('4b. a session replaced or stopped after the dialog opened is not ended', async () => {
    const db = seed({ sessionInstanceId: 'inst-2' });
    await assert.rejects(adminEnd(db), (e: any) => e.code === 'replaced');
    assert.ok(db.read(SESSION_PATH));
    const db2 = seed({ lineStopped: true, stopsBySlot: { '3': [{ id: 'stop-9', reason: 'maintenance', startAbs: 90, running: true }] } });
    await assert.rejects(adminEnd(db2), (e: any) => e.code === 'line-stopped');
    assert.ok(db2.read(SESSION_PATH));
  });

  await test('5. double-tapping End Production performs one transition', async () => {
    const db = seed();
    const inFlight = new Set<string>();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let endCalls = 0;
    const busy: boolean[] = [];
    const deps = {
      inFlight,
      confirm: async () => { await gate; return true; },
      end: async (t: EndProductionTarget) => { endCalls++; await adminEnd(db, t); },
      onBusyChange: (_: string, b: boolean) => { busy.push(b); },
    };
    const first = confirmAndEndProduction(TARGET, deps);
    const second = await confirmAndEndProduction(TARGET, deps); // tap while the dialog is open
    assert.deepEqual(second, { kind: 'busy' });
    release();
    const r1 = await first;
    assert.equal(r1.kind, 'ended');
    assert.equal(endCalls, 1);
    assert.equal(db.commits, 1);
    assert.deepEqual(busy, [true, false]);
    // A late third tap on the (now stale) card fails safely, no second archive write.
    const third = await confirmAndEndProduction(TARGET, { ...deps, confirm: async () => true });
    assert.equal(third.kind, 'error');
    assert.equal(db.commits, 1);
  });

  await test('6. a failed request shows an error, never success, and changes nothing', async () => {
    const db = seed();
    db.failNextCommit = true;
    const before = clone([...db.docs]);
    const out = await confirmAndEndProduction(TARGET, {
      inFlight: new Set(), confirm: async () => true, end: (t) => adminEnd(db, t),
    });
    assert.equal(out.kind, 'error');
    assert.match((out as any).message, /Could not end production/);
    assert.match((out as any).message, /Nothing was changed/);
    assert.deepEqual(clone([...db.docs]), before);
  });

  await test('7. saved production records are unchanged and no record is created', async () => {
    const db = seed();
    const before = recordsOf(db);
    await adminEnd(db);
    assert.deepEqual(recordsOf(db), before);
  });

  await test('8. unsaved entries stay recoverable (not submitted, not discarded)', async () => {
    const db = seed();
    await adminEnd(db);
    const a = db.read(archivePath())!;
    // Slots 1 and 3 and the changeover slot were never saved: their values
    // are in the archive, not in productionRecords.
    assert.deepEqual(a.producedBySlot, { '0': 50, '1': 47, '3': 40 });
    assert.deepEqual(a.producedSegment, { '2:before': 20, '2:after': 25 });
    assert.deepEqual(a.rejectionsBySlot, { '0': 1, '3': 2 });
    assert.deepEqual(a.lossReasonBySlot['3'], { code: 'material', label: 'Material shortage', note: 'late coil' });
    assert.equal(a.changeovers['2'].newPartIndex, 1);
    assert.equal(a.stopsBySlot['1'][0].durationMinutes, 5);
    assert.deepEqual(a.savedSlotIndices, [0]);
    assert.equal(recordsOf(db).length, 1);
    // A supervisor device's unsynced entries are added to the archive
    // (RecordProductionScreen handleRemoteEnded) — an update, which only
    // lands on an existing archive, never creating a session or record.
    await db.runTransaction(async (tx) => {
      tx.update(archivePath(), { recoveredDrafts: { 'dev-sup': { uid: 'sup-1', local: { producedBySlot: { '4': 33 } } } } });
    });
    assert.equal(db.read(archivePath())!.recoveredDrafts['dev-sup'].local.producedBySlot['4'], 33);
    assert.equal(db.read(SESSION_PATH), null);
    // After a normal Finalize there is no archive, so that update fails instead of creating one.
    await assert.rejects(db.runTransaction(async (tx) => { tx.update(archivePath('other'), { recoveredDrafts: {} }); }), /NOT_FOUND/);
  });

  await test('9. the Live Production view shows the line running, then not running', async () => {
    const db = seed();
    const lines = [{ id: LINE, lineName: 'JAC-03', plant: null, workshop: null, division: null }];
    assert.equal(buildLineCards(lines, liveSessionsOf(db), [])[0].status, 'running');
    assert.equal(buildLineCards(lines, liveSessionsOf(db), [])[0].session?.sessionInstance, INSTANCE);
    await adminEnd(db);
    assert.equal(buildLineCards(lines, liveSessionsOf(db), [])[0].status, 'not_running');
  });

  await test('10. supervisor devices observe the end and recognise it as an admin end', async () => {
    const db = seed();
    await adminEnd(db);
    // Listener / sync read: the doc is gone.
    assert.equal(sessionWriteGate({ exists: false }, INSTANCE), 'finalized');
    // The archive id the supervisor screen derives from its own session matches.
    assert.ok(db.read(`${ENDED_SESSIONS_COLLECTION}/${endedSessionId(LINE, INSTANCE)}`));
    // Legacy sessions without sessionInstanceId: both sides use startedAt:<ms>.
    assert.equal(sessionInstanceOf({ startedAt: { toMillis: () => 777 } }), 'startedAt:777'); // a Firestore Timestamp
    const legacy = seed({ sessionInstanceId: undefined, startedAt: 777 });
    await adminEnd(legacy, { ...TARGET, sessionInstance: 'startedAt:777' });
    assert.ok(legacy.read(`${ENDED_SESSIONS_COLLECTION}/${endedSessionId(LINE, 'startedAt:777')}`));
  });

  await test('11. a stale supervisor write cannot reopen the ended session', async () => {
    const db = seed();
    const base = { revision: 7, state: stateFromDoc(sessionDoc()) };
    const local = { ...base.state, producedBySlot: { ...base.state.producedBySlot, '4': 30 } };
    // Supervisor read the doc, admin ended it before the supervisor committed.
    const result = await supervisorSync(db, base, local, { between: async () => { await adminEnd(db); } });
    assert.equal(result, 'finalized');
    assert.ok(db.retries >= 1, 'the supervisor transaction was retried after the end');
    assert.equal(db.read(SESSION_PATH), null, 'session not re-created');
    assert.equal(db.read(archivePath())!.producedBySlot['4'], undefined, 'archive holds the state as ended');
    // Any later queued write (retry timer, leaving the screen) stops the same way.
    assert.equal(await supervisorSync(db, base, local), 'finalized');
    assert.equal(db.read(SESSION_PATH), null);
  });

  await test('11b. an admin end racing a supervisor sync archives the synced state', async () => {
    const db = seed();
    const base = { revision: 7, state: stateFromDoc(sessionDoc()) };
    const local = { ...base.state, producedBySlot: { ...base.state.producedBySlot, '4': 30 } };
    // Admin read the session, supervisor synced before the admin committed.
    let between = true;
    const raced = endProductionSession(async (fn) => db.runTransaction(async (tx) => {
      const r = await fn(tx);
      if (between) { between = false; assert.equal(await supervisorSync(db, base, local), 'synced'); }
      return r;
    }), TARGET, ADMIN, stamps);
    await raced;
    assert.equal(db.read(SESSION_PATH), null);
    const a = db.read(archivePath())!;
    assert.equal(a.producedBySlot['4'], 30, 'the supervisor\'s synced value is in the archive');
    assert.equal(a.revision, 8);
  });

  await test('12. concurrent Save Slot and End Production: one record, loss reason kept', async () => {
    const db = seed();
    const base = { revision: 7, state: stateFromDoc(sessionDoc()) };
    // Save Slot for slot 3: record write, then the session sync marking it saved.
    saveSlotRecord(db, 3, { producedThisSlot: 40, rejections: 2, lossReasonCode: 'material', lossReasonLabel: 'Material shortage', lossReasonNote: 'late coil' });
    const result = await supervisorSync(db, base, base.state, { extraSavedSlots: [3], between: async () => { await adminEnd(db); } });
    assert.equal(result, 'finalized');
    // A retried Save Slot (same identity) updates the same doc.
    saveSlotRecord(db, 3, { producedThisSlot: 40, rejections: 2, lossReasonCode: 'material', lossReasonLabel: 'Material shortage', lossReasonNote: 'late coil' });
    const slot3 = recordsOf(db).filter(([, d]) => d.slotIndex === 3);
    assert.equal(slot3.length, 1);
    assert.equal(slot3[0][1].lossReasonCode, 'material');
    assert.equal(slot3[0][1].lossReasonNote, 'late coil');
    assert.equal(recordsOf(db).length, 2);
    // The archive still has the loss reason too.
    assert.equal(db.read(archivePath())!.lossReasonBySlot['3'].code, 'material');
  });

  await test('13. production date, shift, targets and slot identity are not altered', async () => {
    const db = seed();
    const slotsBefore = buildSlots('B', 1, [], 1230);
    const ids = [0, 1, 2, 3].map((i) => productionRecordId({ productionDate: PROD_DATE, lineId: LINE, shift: 'B', slotIndex: i, segment: 'full' }));
    await adminEnd(db);
    const a = db.read(archivePath())!;
    assert.equal(a.productionDate, PROD_DATE);
    assert.equal(a.shift, 'B');
    assert.equal(a.productionStartMinutesAbs, 1230);
    assert.equal(a.plannedProductionTotal, 480);
    assert.equal(a.otHours, 1);
    assert.deepEqual(buildSlots('B', 1, [], 1230), slotsBefore);
    assert.deepEqual([0, 1, 2, 3].map((i) => productionRecordId({ productionDate: PROD_DATE, lineId: LINE, shift: 'B', slotIndex: i, segment: 'full' })), ids);
    // Shift B after midnight still belongs to the night it started.
    assert.equal(productionDayKeyFor(new Date(2026, 9, 22, 2, 0).getTime()), '2026-10-21');
  });

  console.log(`\n${passed} passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
