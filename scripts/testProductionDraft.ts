// scripts/testProductionDraft.ts
//
// Checks for RecordProductionScreen's session sync, local draft and restore
// logic (src/utils/productionDraft.ts), including two devices editing the
// same session against a simulated activeSessions doc (same planSessionSync /
// resolveRestore the screen's transaction and restore use).
// The project has no test runner, so this is a plain node:assert script:
//   npm run test:production-draft

import assert from 'node:assert/strict';
import {
  DraftScope,
  DraftStorage,
  ProductionDraft,
  RestoreInput,
  RestoreRecord,
  SyncConflict,
  SyncState,
  createDraft,
  createDraftStore,
  createSessionWriteQueue,
  draftStorageKey,
  emptySyncState,
  fieldsForRecordUpdate,
  loadDraft,
  parseDraft,
  pickSlotRecords,
  planSessionSync,
  productionRecordId,
  resolveRestore,
  retireDraft,
  saveDraft,
  serializeLossReasons,
  serializeStops,
  syncRetryDelayMs,
  syncStatesEqual,
  threeWayMerge,
  withTimeout,
} from '../src/utils/productionDraft';

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

// ─── Fixtures ────────────────────────────────────────────────────────────────

const SCOPE: DraftScope = { uid: 'sup-1', lineId: 'line-JAC-03', productionDate: '2026-10-21', shift: 'A', sessionInstance: 'inst-1' };
const IDENTITY = { productionDate: SCOPE.productionDate, lineId: SCOPE.lineId, shift: SCOPE.shift };
const SESSION_START = Date.UTC(2026, 9, 21, 1, 30);
const CHANGEOVER = { slotIndex: 2, atAbs: 600, startAbs: 600, endAbs: 600, oldPartIndex: 0, newPartIndex: 1 };

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const state = (over: Partial<SyncState> = {}): SyncState => ({ ...emptySyncState(), ...over });

function memoryStorage(): DraftStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: async (k) => map.get(k) ?? null,
    setItem: async (k, v) => { map.set(k, v); },
    removeItem: async (k) => { map.delete(k); },
  };
}

function record(p: Partial<RestoreRecord> & { slotIndex: number }): RestoreRecord {
  const seg = p.partSegment ?? null;
  return {
    id: productionRecordId({ ...IDENTITY, slotIndex: p.slotIndex, segment: seg ?? 'full' }),
    partSegment: seg, producedThisSlot: null, rejections: null,
    lossReasonCode: null, lossReasonLabel: null, lossReasonNote: null,
    createdAtMs: SESSION_START + 60 * 60_000, updatedAtMs: SESSION_START + 60 * 60_000,
    ...p,
  };
}

const splitFrom = (cos: SyncState['changeovers']) =>
  new Set(Object.values(cos).filter(Boolean).map((c) => Number((c as any).slotIndex)));

function restore(over: Partial<RestoreInput>) {
  return resolveRestore({
    server: state(),
    serverRevision: 1,
    draft: null,
    records: [],
    identity: IDENTITY,
    sessionStartedAtMs: SESSION_START,
    splitSlotsFor: splitFrom,
    deviceId: 'dev-A',
    nowMs: SESSION_START + 10_000,
    ...over,
  });
}

// ─── Simulated activeSessions doc + devices ─────────────────────────────────
// Mirrors the screen: a sync is a transaction (read doc → planSessionSync →
// write revision + 1) that fails outright while offline; a device keeps its
// base (last synced copy) and its local state; edits go to a local draft
// first; the listener adopts newer revisions when nothing is pending.

class FakeServer {
  doc: { revision: number; state: SyncState } | null = { revision: 1, state: state() };
  online = true;
  writes = 0;
}

let clock = SESSION_START + 1000;
class Device {
  base: { revision: number; state: SyncState } | null = null;
  local: SyncState = state();
  storage = memoryStorage();
  conflicts: SyncConflict[] = [];
  constructor(public id: string, public server: FakeServer) {}

  async open() {
    if (!this.server.online || !this.server.doc) throw new Error('offline');
    const draft = await loadDraft(this.storage, SCOPE);
    const r = restore({
      server: clone(this.server.doc.state), serverRevision: this.server.doc.revision,
      draft: draft.ok ? draft.draft : null, records: null, deviceId: this.id, nowMs: ++clock,
    });
    this.base = { revision: r.baseRevision, state: clone(r.base) };
    this.local = clone(r.state);
    this.conflicts.push(...r.conflicts);
    return r;
  }
  // App closed: memory gone, the draft stays.
  close() { this.base = null; this.local = state(); }
  async edit(fn: (s: SyncState) => void) {
    fn(this.local);
    await saveDraft(this.storage, createDraft(SCOPE, this.base!.state, this.base!.revision, this.local, ++clock, clock));
  }
  pending() { return !!this.base && !syncStatesEqual(this.base.state, this.local); }
  async sync(preferLocalKeys?: Set<string>): Promise<boolean> {
    if (!this.server.online) return false;              // transaction fails — draft kept
    if (!this.server.doc) return false;
    const plan = planSessionSync(this.base, clone(this.local), clone(this.server.doc), { preferLocalKeys, deviceId: this.id, nowMs: ++clock });
    this.server.doc = { revision: plan.revision, state: clone(plan.merged) };
    this.server.writes++;
    this.base = { revision: plan.revision, state: clone(plan.merged) };
    this.local = clone(plan.merged);
    this.conflicts.push(...plan.conflicts);
    await retireDraft(this.storage, SCOPE, Number.MAX_SAFE_INTEGER);
    return true;
  }
  // onSnapshot: adopt a newer revision when nothing is pending here.
  receive() {
    const d = this.server.doc;
    if (!d || !this.base || d.revision <= this.base.revision || this.pending()) return false;
    this.base = clone(d);
    this.local = clone(d.state);
    return true;
  }
}

async function main() {
  console.log('Record identity (unchanged format)');

  await test('productionRecordId keeps the exact pr|date|line|shift|slot|segment format', () => {
    assert.equal(
      productionRecordId({ productionDate: '2026-10-21', lineId: 'JAC-03', shift: 'A', slotIndex: 0, segment: 'full' }),
      'pr|2026-10-21|JAC-03|A|0|full'
    );
    assert.equal(
      productionRecordId({ productionDate: '2026-10-21', lineId: 'a/b|c', shift: 'B', slotIndex: 3, segment: 'after' }),
      'pr|2026-10-21|a%2Fb%7Cc|B|3|after'
    );
  });

  await test('Finalize update keeps a stored loss reason when memory has none', () => {
    const keep = ['lossReasonCode', 'lossReasonLabel', 'lossReasonNote'];
    assert.deepEqual(fieldsForRecordUpdate({ producedThisSlot: 40, lossReasonCode: null, lossReasonLabel: null, lossReasonNote: null }, keep), { producedThisSlot: 40 });
    assert.deepEqual(
      fieldsForRecordUpdate({ producedThisSlot: 40, lossReasonCode: 'D', lossReasonLabel: 'Machine breakdown', lossReasonNote: null }, keep),
      { producedThisSlot: 40, lossReasonCode: 'D', lossReasonLabel: 'Machine breakdown' }
    );
    assert.deepEqual(fieldsForRecordUpdate({ lossReasonCode: null }), { lossReasonCode: null });
  });

  console.log('Local draft (device recovery layer)');

  await test('draft key isolates user, line, date and shift', () => {
    const keys = new Set([
      draftStorageKey(SCOPE), draftStorageKey({ ...SCOPE, uid: 'sup-2' }), draftStorageKey({ ...SCOPE, lineId: 'line-2' }),
      draftStorageKey({ ...SCOPE, productionDate: '2026-10-22' }), draftStorageKey({ ...SCOPE, shift: 'B' }),
    ]);
    assert.equal(keys.size, 5);
  });

  await test('draft round-trips base + local (quantities, segments, rejections, reasons, changeovers, stops)', async () => {
    const st = memoryStorage();
    const local = state({
      producedBySlot: { '0': 40, '1': null }, producedSegment: { '2:before': 12, '2:after': null },
      rejectionsBySlot: { '0': 3 }, lossReasonBySlot: { '0': { code: 'D', label: 'Machine breakdown', note: null } },
      changeovers: { '2': CHANGEOVER }, deletedSlotIndices: [5], savedSlotIndices: [0],
      stopsBySlot: { '1': [{ id: 'stop-1', reason: 'maintenance', startAbs: 1, running: true }] }, otHours: 2,
      operators: [{ id: 'o1', name: 'Ravi', code: 'R1' }],
    });
    assert.equal(await saveDraft(st, createDraft(SCOPE, state(), 4, local, 1000, 7)), true);
    const loaded = await loadDraft(st, SCOPE);
    assert.ok(loaded.ok);
    if (!loaded.ok) return;
    assert.ok(syncStatesEqual(loaded.draft.local, local));
    assert.equal(loaded.draft.baseRevision, 4);
    assert.equal(loaded.draft.revision, 7);
  });

  await test('a draft never loads into another user / line / shift / date / session run', async () => {
    const st = memoryStorage();
    await saveDraft(st, createDraft(SCOPE, state(), 1, state(), 1000, 1));
    const raw = st.map.get(draftStorageKey(SCOPE))!;
    for (const other of [
      { ...SCOPE, uid: 'sup-2' }, { ...SCOPE, lineId: 'x' }, { ...SCOPE, shift: 'B' },
      { ...SCOPE, productionDate: '2026-10-22' }, { ...SCOPE, sessionInstance: 'inst-2' },
    ]) assert.equal(parseDraft(raw, other).ok, false);
  });

  await test('missing, malformed, outdated and damaged drafts are rejected without throwing', () => {
    const good = clone(createDraft(SCOPE, state(), 1, state(), 1000, 1));
    const reason = (raw: string | null) => { const r = parseDraft(raw, SCOPE); return r.ok ? 'ok' : r.reason; };
    assert.equal(reason(null), 'missing');
    assert.equal(reason('{not json'), 'malformed');
    assert.equal(reason('[]'), 'malformed');
    assert.equal(reason(JSON.stringify({ ...good, version: 1 })), 'version');
    assert.equal(reason(JSON.stringify({ ...good, local: { ...good.local, producedBySlot: { '0': -4 } } })), 'malformed');
    assert.equal(reason(JSON.stringify({ ...good, local: { ...good.local, changeovers: { '2': { slotIndex: 2 } } } })), 'malformed');
    assert.equal(reason(JSON.stringify({ ...good, base: null })), 'malformed');
    assert.equal(reason(JSON.stringify({ ...good, baseRevision: -1 })), 'malformed');
    assert.equal(reason(JSON.stringify(good)), 'ok');
  });

  await test('a failing storage reports failure and keeps the existing draft', async () => {
    const st = memoryStorage();
    await saveDraft(st, createDraft(SCOPE, state(), 1, state({ producedBySlot: { '0': 40 } }), 1000, 1));
    const failing: DraftStorage = { ...st, setItem: async () => { throw new Error('quota'); } };
    assert.equal(await saveDraft(failing, createDraft(SCOPE, state(), 1, state(), 2000, 2)), false);
    const loaded = await loadDraft(st, SCOPE);
    assert.ok(loaded.ok && loaded.draft.local.producedBySlot['0'] === 40);
  });

  await test('retire removes a confirmed draft but keeps a newer, unconfirmed one', async () => {
    const st = memoryStorage();
    await saveDraft(st, createDraft(SCOPE, state(), 1, state(), 1000, 5));
    assert.equal(await retireDraft(st, SCOPE, 4), false);
    assert.ok(st.map.has(draftStorageKey(SCOPE)));
    assert.equal(await retireDraft(st, SCOPE, 5), true);
    assert.ok(!st.map.has(draftStorageKey(SCOPE)));
  });

  await test('draft store: a save queued during an older retire is not removed', async () => {
    const st = memoryStorage();
    // Read first, return later — an unserialized retire would remove the newer draft.
    const slow: DraftStorage = {
      getItem: async (k) => { const v = await st.getItem(k); await new Promise((r) => setTimeout(r, 20)); return v; },
      setItem: (k, v) => st.setItem(k, v),
      removeItem: (k) => st.removeItem(k),
    };
    const store = createDraftStore(slow);
    await store.save(createDraft(SCOPE, state(), 1, state(), 1000, 1));
    await Promise.all([
      store.retire(SCOPE, 1),
      store.save(createDraft(SCOPE, state(), 1, state({ producedBySlot: { '0': 40 } }), 2000, 2)),
    ]);
    const loaded = await loadDraft(st, SCOPE);
    assert.ok(loaded.ok && loaded.draft.revision === 2 && loaded.draft.local.producedBySlot['0'] === 40);
  });

  await test('values written to Firestore never contain undefined', () => {
    assert.deepEqual(
      serializeLossReasons({ '0': { code: 'K', label: 'Others', note: undefined }, '1': undefined, '2': { code: '', label: 'x' } }),
      { '0': { code: 'K', label: 'Others', note: null } }
    );
    const stops = serializeStops({ '1': [{ id: 's', reason: 'quality', startAbs: 5, endAbs: undefined, running: true }] });
    assert.ok(!('endAbs' in stops['1'][0]));
  });

  console.log('Three-way merge');

  await test('changes on different keys from two devices are both kept, no conflict', () => {
    const base = state({ producedBySlot: { '0': 10 } });
    const { merged, conflicts } = threeWayMerge(
      base,
      state({ producedBySlot: { '0': 10, '1': 20 } }),
      state({ producedBySlot: { '0': 10, '2': 30 } }),
      { prefer: 'remote', deviceId: 'dev-A', nowMs: 1 }
    );
    assert.deepEqual(merged.producedBySlot, { '0': 10, '1': 20, '2': 30 });
    assert.equal(conflicts.length, 0);
  });

  await test('a clash keeps the server value and preserves the other one as a conflict', () => {
    const { merged, conflicts } = threeWayMerge(
      state({ producedBySlot: { '0': 35 } }),
      state({ producedBySlot: { '0': 40 } }),
      state({ producedBySlot: { '0': 42 } }),
      { prefer: 'remote', deviceId: 'dev-A', nowMs: 7 }
    );
    assert.equal(merged.producedBySlot['0'], 42);
    assert.equal(conflicts.length, 1);
    assert.deepEqual(
      { field: conflicts[0].field, key: conflicts[0].key, kept: conflicts[0].keptValue, other: conflicts[0].otherValue },
      { field: 'producedBySlot', key: '0', kept: 42, other: 40 }
    );
    assert.ok(merged.syncConflicts[conflicts[0].id]);
  });

  await test('Save Slot values win a clash on their own keys only', () => {
    const { merged } = threeWayMerge(
      state({ producedBySlot: { '0': 35, '1': 5 } }),
      state({ producedBySlot: { '0': 40, '1': 6 } }),
      state({ producedBySlot: { '0': 42, '1': 7 } }),
      { prefer: 'remote', preferLocalKeys: new Set(['producedBySlot|0']), deviceId: 'dev-A', nowMs: 1 }
    );
    assert.equal(merged.producedBySlot['0'], 40);
    assert.equal(merged.producedBySlot['1'], 7);
  });

  await test('a stop resumed on one device is never re-opened by the other', () => {
    const running = { id: 'stop-1', reason: 'maintenance', startAbs: 100, running: true };
    const closed = { id: 'stop-1', reason: 'maintenance', startAbs: 100, endAbs: 200, durationMinutes: 0, running: false };
    const extra = { id: 'stop-2', reason: 'quality', startAbs: 300, running: true };
    const { merged, conflicts } = threeWayMerge(
      state({ stopsBySlot: { '1': [running] } }),
      state({ stopsBySlot: { '1': [{ ...running, reason: 'maintenance' }], '2': [extra] } }), // local: unchanged stop-1, new stop-2
      state({ stopsBySlot: { '1': [closed] } }),
      { prefer: 'local', deviceId: 'dev-A', nowMs: 1 }
    );
    assert.equal(merged.stopsBySlot['1'][0].running, false);
    assert.equal(merged.stopsBySlot['2'][0].id, 'stop-2');
    assert.equal(conflicts.length, 0);
  });

  await test('deleted / saved slot sets merge membership changes from both sides', () => {
    const { merged } = threeWayMerge(
      state({ savedSlotIndices: [0], deletedSlotIndices: [] }),
      state({ savedSlotIndices: [0, 1], deletedSlotIndices: [5] }),
      state({ savedSlotIndices: [2], deletedSlotIndices: [] }), // remote un-saved 0 (changeover added), saved 2
      { prefer: 'remote', deviceId: 'dev-A', nowMs: 1 }
    );
    assert.deepEqual(merged.savedSlotIndices, [1, 2]);
    assert.deepEqual(merged.deletedSlotIndices, [5]);
  });

  await test('a dismissed conflict stays dismissed on every device', () => {
    const c: SyncConflict = { id: 'c1', field: 'producedBySlot', key: '0', keptValue: 42, otherValue: 40, otherDeviceId: 'dev-A', atMs: 1 };
    const { merged } = threeWayMerge(
      state({ syncConflicts: { c1: c } }),
      state({ syncConflicts: { c1: null } }),
      state({ syncConflicts: { c1: c } }),
      { prefer: 'remote', deviceId: 'dev-B', nowMs: 2 }
    );
    assert.equal(merged.syncConflicts.c1, null);
  });

  await test('the server is used as is when still at this device\'s base revision', () => {
    const local = state({ producedBySlot: { '0': 40 } });
    const plan = planSessionSync({ revision: 3, state: state() }, local, { revision: 3, state: state() }, { deviceId: 'dev-A', nowMs: 1 });
    assert.equal(plan.revision, 4);
    assert.ok(syncStatesEqual(plan.merged, local));
  });

  console.log('Two devices, one session (simulated activeSessions doc)');

  await test('A enters a draft and syncs; B opens the session and sees the values', async () => {
    const server = new FakeServer();
    const a = new Device('dev-A', server);
    const b = new Device('dev-B', server);
    await a.open();
    await a.edit((s) => { s.producedBySlot['0'] = 40; s.rejectionsBySlot['0'] = 2; s.lossReasonBySlot['0'] = { code: 'D', label: 'Machine breakdown', note: null }; });
    assert.equal(await a.sync(), true);
    await b.open();
    assert.equal(b.local.producedBySlot['0'], 40);
    assert.equal(b.local.rejectionsBySlot['0'], 2);
    assert.equal(b.local.lossReasonBySlot['0'].label, 'Machine breakdown');
    assert.equal(server.doc!.revision, 2);
  });

  await test('a device-local draft is NOT visible on another device until synced', async () => {
    const server = new FakeServer();
    const a = new Device('dev-A', server);
    const b = new Device('dev-B', server);
    await a.open();
    server.online = false;
    await a.edit((s) => { s.producedBySlot['3'] = 55; });
    assert.equal(await a.sync(), false); // offline → fails, draft kept
    server.online = true;
    await b.open();
    assert.equal(b.local.producedBySlot['3'], undefined);
    assert.ok((await loadDraft(a.storage, SCOPE)).ok);
  });

  await test('B, idle, picks up A\'s synced changes live (listener)', async () => {
    const server = new FakeServer();
    const a = new Device('dev-A', server);
    const b = new Device('dev-B', server);
    await a.open(); await b.open();
    await a.edit((s) => { s.producedBySlot['1'] = 33; });
    await a.sync();
    assert.equal(b.receive(), true);
    assert.equal(b.local.producedBySlot['1'], 33);
  });

  await test('concurrent edits of different slots: both survive, whichever syncs first', async () => {
    const server = new FakeServer();
    const a = new Device('dev-A', server);
    const b = new Device('dev-B', server);
    await a.open(); await b.open();
    await a.edit((s) => { s.producedBySlot['0'] = 40; });
    await b.edit((s) => { s.producedBySlot['1'] = 50; s.otHours = 2; });
    assert.equal(b.receive(), false); // B has pending edits — not overwritten by the listener
    await a.sync();
    await b.sync();
    assert.deepEqual(server.doc!.state.producedBySlot, { '0': 40, '1': 50 });
    assert.equal(server.doc!.state.otHours, 2);
    assert.equal(b.conflicts.length, 0);
    a.receive();
    assert.deepEqual(a.local.producedBySlot, { '0': 40, '1': 50 });
  });

  await test('concurrent edits of the SAME value: first synced value kept, the other preserved as a conflict', async () => {
    const server = new FakeServer();
    const a = new Device('dev-A', server);
    const b = new Device('dev-B', server);
    await a.open(); await b.open();
    await a.edit((s) => { s.producedBySlot['0'] = 40; });
    await b.edit((s) => { s.producedBySlot['0'] = 42; });
    await a.sync();
    await b.sync();
    assert.equal(server.doc!.state.producedBySlot['0'], 40);
    const kept = Object.values(server.doc!.state.syncConflicts).filter(Boolean) as SyncConflict[];
    assert.equal(kept.length, 1);
    assert.equal(kept[0].otherValue, 42);
    assert.equal(kept[0].otherDeviceId, 'dev-B');
    // B now shows the server value; the conflict is visible to A too.
    assert.equal(b.local.producedBySlot['0'], 40);
    a.receive();
    assert.equal(Object.values(a.local.syncConflicts).filter(Boolean).length, 1);
  });

  await test('offline edits survive a restart and sync later without losing the other device\'s work', async () => {
    const server = new FakeServer();
    const a = new Device('dev-A', server);
    const b = new Device('dev-B', server);
    await a.open(); await b.open();
    server.online = false;
    await a.edit((s) => { s.producedBySlot['2'] = 30; s.rejectionsBySlot['2'] = 1; });
    assert.equal(await a.sync(), false);
    a.close(); // app killed while offline
    server.online = true;
    await b.edit((s) => { s.producedBySlot['3'] = 10; });
    await b.sync();
    const r = await a.open(); // back online, reopen
    assert.equal(r.draftApplied, true);
    assert.equal(r.conflicts.length, 0);
    assert.equal(a.local.producedBySlot['2'], 30);
    assert.equal(a.local.producedBySlot['3'], 10);
    await a.sync();
    assert.deepEqual(server.doc!.state.producedBySlot, { '2': 30, '3': 10 });
    assert.equal((await loadDraft(a.storage, SCOPE)).ok, false); // retired once synced
  });

  await test('an older offline draft never overwrites a newer server value', async () => {
    const server = new FakeServer();
    const a = new Device('dev-A', server);
    const b = new Device('dev-B', server);
    await a.open();
    await a.edit((s) => { s.producedBySlot['0'] = 35; });
    await a.sync();
    await b.open();
    server.online = false;
    await a.edit((s) => { s.producedBySlot['0'] = 40; });  // offline, based on revision 2
    a.close();
    server.online = true;
    await b.edit((s) => { s.producedBySlot['0'] = 50; });
    await b.sync();                                         // revision 3
    const r = await a.open();
    assert.equal(a.local.producedBySlot['0'], 50);          // newer server value kept
    assert.equal(r.conflicts.length, 1);
    assert.equal(r.conflicts[0].otherValue, 40);            // A's value preserved, recoverable
    await a.sync();
    assert.equal(server.doc!.state.producedBySlot['0'], 50);
  });

  await test('Save Slot on one device wins over a stale edit of that slot from another', async () => {
    const server = new FakeServer();
    const a = new Device('dev-A', server);
    const b = new Device('dev-B', server);
    await a.open(); await b.open();
    await b.edit((s) => { s.producedBySlot['0'] = 41; });
    await b.sync();
    await a.edit((s) => { s.producedBySlot['0'] = 40; s.savedSlotIndices = [0]; }); // A saved its 40 to productionRecords
    await a.sync(new Set(['producedBySlot|0']));
    assert.equal(server.doc!.state.producedBySlot['0'], 40);
    assert.deepEqual(server.doc!.state.savedSlotIndices, [0]);
  });

  await test('random interleavings: no edit is ever silently lost', async () => {
    let seed = 12345;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
    for (let round = 0; round < 60; round++) {
      const server = new FakeServer();
      const devs = [new Device('dev-A', server), new Device('dev-B', server)];
      for (const d of devs) await d.open();
      for (let step = 0; step < 25; step++) {
        const d = devs[rnd(2)];
        const op = rnd(4);
        if (op < 2) {
          const key = String(rnd(4));
          const value = rnd(100);
          await d.edit((s) => { s.producedBySlot[key] = value; });
        } else if (op === 2) {
          const before = clone(d.local);
          const baseBefore = clone(d.base!.state);
          const serverBefore = clone(server.doc!.state);
          await d.sync();
          // Values this device did NOT change are never overwritten with its
          // stale copy — the other device's synced work survives.
          for (const [k, w] of Object.entries(serverBefore.producedBySlot)) {
            if (before.producedBySlot[k] !== baseBefore.producedBySlot[k]) continue;
            assert.equal(server.doc!.state.producedBySlot[k], w, `round ${round}: other device's slot ${k}=${w} overwritten`);
          }
          // Every value this device changed is now on the server or kept as a conflict.
          for (const [k, v] of Object.entries(before.producedBySlot)) {
            if (baseBefore.producedBySlot[k] === v) continue;
            const onServer = server.doc!.state.producedBySlot[k] === v;
            const asConflict = Object.values(server.doc!.state.syncConflicts).some(
              (c) => c && c.key === k && (c.otherValue === v || c.keptValue === v)
            );
            assert.ok(onServer || asConflict, `round ${round}: slot ${k}=${v} lost`);
          }
        } else {
          d.receive();
        }
      }
      // Revisions only ever go up by one per sync.
      assert.equal(server.doc!.revision, 1 + server.writes);
    }
  });

  console.log('Restore precedence (server + draft + productionRecords)');

  await test('a draft based on the current server revision applies as pending edits', () => {
    const draft = createDraft(SCOPE, state(), 1, state({ producedBySlot: { '0': 40 }, changeovers: { '2': CHANGEOVER } }), 5, 3);
    const r = restore({ draft });
    assert.equal(r.draftApplied, true);
    assert.equal(r.state.producedBySlot['0'], 40);
    assert.deepEqual(r.state.changeovers['2'], CHANGEOVER);
    assert.equal(r.needsSync, true);
  });

  await test('a draft with nothing beyond its base is ignored', () => {
    const server = state({ producedBySlot: { '0': 50 } });
    const r = restore({ server, draft: createDraft(SCOPE, state(), 1, state(), 5, 3) });
    assert.equal(r.draftApplied, false);
    assert.equal(r.state.producedBySlot['0'], 50);
    assert.equal(r.needsSync, false);
  });

  await test('a saved slot missing from the session is recovered from its record, and shows as saved', () => {
    const r = restore({
      records: [record({ slotIndex: 0, producedThisSlot: 40, rejections: 2, lossReasonCode: 'D', lossReasonLabel: 'Machine breakdown' })],
    });
    assert.equal(r.state.producedBySlot['0'], 40);
    assert.equal(r.state.rejectionsBySlot['0'], 2);
    assert.deepEqual(r.state.lossReasonBySlot['0'], { code: 'D', label: 'Machine breakdown', note: null });
    assert.deepEqual(r.state.savedSlotIndices, [0]);
    assert.equal(r.needsSync, true);
  });

  await test('an entered value is never overwritten by a record', () => {
    const r = restore({
      server: state({ producedBySlot: { '0': 45 }, lossReasonBySlot: { '0': { code: 'A', label: 'Job setup delay', note: null } } }),
      records: [record({ slotIndex: 0, producedThisSlot: 40, lossReasonCode: 'D', lossReasonLabel: 'Machine breakdown' })],
    });
    assert.equal(r.state.producedBySlot['0'], 45);
    assert.equal(r.state.lossReasonBySlot['0'].code, 'A');
    assert.deepEqual(r.state.savedSlotIndices, []);
  });

  await test('an explicitly saved slot stays saved even if edited later (existing Finalize rule)', () => {
    const r = restore({
      server: state({ producedBySlot: { '0': 45 }, savedSlotIndices: [0] }),
      records: [record({ slotIndex: 0, producedThisSlot: 40 })],
    });
    assert.deepEqual(r.state.savedSlotIndices, [0]);
  });

  await test('a before/after pair restores to the split slot keys and is not a duplicate', () => {
    const r = restore({
      server: state({ changeovers: { '2': CHANGEOVER } }),
      records: [
        record({ slotIndex: 2, partSegment: 'before', producedThisSlot: 12, lossReasonCode: 'B', lossReasonLabel: 'Wait for component' }),
        record({ slotIndex: 2, partSegment: 'after', producedThisSlot: 20 }),
      ],
    });
    assert.equal(r.state.producedSegment['2:before'], 12);
    assert.equal(r.state.producedSegment['2:after'], 20);
    assert.equal(r.state.lossReasonBySlot['2:before'].code, 'B');
    assert.equal(r.state.producedBySlot['2'], undefined);
    assert.deepEqual(r.state.savedSlotIndices, [2]);
  });

  await test('a record of the old shape does not mark a re-split slot as saved', () => {
    const r = restore({
      server: state({ changeovers: { '2': CHANGEOVER }, savedSlotIndices: [2] }),
      records: [record({ slotIndex: 2, producedThisSlot: 30 })],
    });
    assert.deepEqual(r.state.savedSlotIndices, []);
  });

  await test('legacy duplicates: the doc Save Slot would update is the one used', () => {
    const legacyA = record({ slotIndex: 0, id: 'randomA', producedThisSlot: 40, createdAtMs: SESSION_START + 10_000 });
    const legacyB = record({ slotIndex: 0, id: 'randomB', producedThisSlot: 40, createdAtMs: SESSION_START + 20_000 });
    assert.equal(pickSlotRecords([legacyB, legacyA], IDENTITY, SESSION_START).get(0)?.full?.id, 'randomA');
    const canonical = record({ slotIndex: 0, producedThisSlot: 40, createdAtMs: SESSION_START + 30_000 });
    assert.equal(pickSlotRecords([legacyA, legacyB, canonical], IDENTITY, SESSION_START).get(0)?.full?.id, canonical.id);
  });

  await test('records written before this session run started are ignored', () => {
    const r = restore({ records: [record({ slotIndex: 0, producedThisSlot: 40, createdAtMs: SESSION_START - 3_600_000, updatedAtMs: SESSION_START - 3_600_000 })] });
    assert.equal(r.state.producedBySlot['0'], undefined);
  });

  await test('records unavailable (offline) → stored saved markers are kept; loaded → unbacked markers dropped', () => {
    const server = state({ producedBySlot: { '0': 40 }, savedSlotIndices: [0] });
    assert.deepEqual(restore({ server, records: null }).state.savedSlotIndices, [0]);
    assert.deepEqual(restore({ server, records: [] }).state.savedSlotIndices, []);
  });

  await test('a deleted slot is left deleted and unfilled', () => {
    const r = restore({ server: state({ deletedSlotIndices: [4] }), records: [record({ slotIndex: 4, producedThisSlot: 40 })] });
    assert.deepEqual(r.state.deletedSlotIndices, [4]);
    assert.equal(r.state.producedBySlot['4'], undefined);
  });

  await test('an up-to-date session needs no write back on open', () => {
    const r = restore({ server: state({ producedBySlot: { '0': 40 }, savedSlotIndices: [0] }), records: [record({ slotIndex: 0, producedThisSlot: 40 })] });
    assert.equal(r.needsSync, false);
  });

  console.log('Session write queue and retry');

  await test('writes never overlap and the newest state wins', async () => {
    const q = createSessionWriteQueue();
    let current = 1;
    let inFlight = 0, maxInFlight = 0;
    const written: number[] = [];
    const job = async () => {
      const snapshot = current;
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 15));
      written.push(snapshot);
      inFlight--;
      return true;
    };
    const first = q.latest(job);
    await new Promise((r) => setTimeout(r, 5));
    current = 2; const a = q.latest(job);
    current = 3; const b = q.latest(job);
    assert.equal(a, b);
    assert.ok(q.busy());
    await Promise.all([first, a, b]);
    assert.equal(maxInFlight, 1);
    assert.deepEqual(written, [1, 3]);
    assert.equal(q.busy(), false);
  });

  await test('changes made while a Save Slot write is pending are in its session snapshot', async () => {
    const q = createSessionWriteQueue();
    const produced: Record<string, number> = { '0': 40 };
    let lastWritten: Record<string, number> | null = null;
    const saveSlot = (async () => {
      await new Promise((r) => setTimeout(r, 20)); // record write
      return q.explicit(async () => { lastWritten = { ...produced }; return true; });
    })();
    produced['1'] = 55;
    await saveSlot;
    assert.deepEqual(lastWritten, { '0': 40, '1': 55 });
  });

  await test('a failed write reports false and later writes still run', async () => {
    const q = createSessionWriteQueue();
    const bad = q.explicit(async () => { throw new Error('offline'); });
    const good = q.latest(async () => true);
    assert.equal(await bad, false);
    assert.equal(await good, true);
  });

  await test('code awaiting a write runs before the next snapshot is built', async () => {
    const q = createSessionWriteQueue();
    const ref = { stops: 'running' };
    const seen: string[] = [];
    const resume = (async () => {
      if (await q.explicit(async () => { seen.push('resume-write'); return true; })) ref.stops = 'closed';
    })();
    const next = q.latest(async () => { seen.push(`next:${ref.stops}`); return true; });
    await Promise.all([resume, next]);
    assert.deepEqual(seen, ['resume-write', 'next:closed']);
  });

  await test('withTimeout rejects a write that never settles', async () => {
    await assert.rejects(withTimeout(new Promise(() => {}), 20, 'session save'), /timed out/);
    assert.equal(await withTimeout(Promise.resolve(7), 20), 7);
  });

  await test('failed syncs retry with backoff: 5s, 10s, 20s, 40s, then every 60s', () => {
    assert.deepEqual([1, 2, 3, 4, 5, 9].map(syncRetryDelayMs), [5000, 10000, 20000, 40000, 60000, 60000]);
  });

  console.log(`\n${passed} passed`);
}

main().catch(() => process.exit(1));
