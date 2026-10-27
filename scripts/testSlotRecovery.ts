// scripts/testSlotRecovery.ts
//
// Checks for deleting and restoring Record Production hourly cards
// (src/utils/slotRecovery.ts) and for the backups travelling through the
// session sync and the on-device draft (src/utils/productionDraft.ts).
// Plain node:assert script:  npm run test:slot-recovery

import assert from 'node:assert/strict';
import {
  DraftScope,
  SyncState,
  cleanSyncState,
  createDraft,
  emptySyncState,
  parseDraft,
  planSessionSync,
  threeWayMerge,
} from '../src/utils/productionDraft';
import { deleteSlotWithBackup, restorableSlots, restoreDeletedSlot } from '../src/utils/slotRecovery';
import { sessionDowntimeMinutes } from '../src/utils/downtime';
import { buildSlots } from '../src/utils/productionSchedule';
import { productionDayMinuteToMillis } from '../src/utils/productionDay';

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}`);
    throw e;
  }
}

const PD = '2026-10-21';
const at = (h: number, m = 0) => productionDayMinuteToMillis(PD, h * 60 + m);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const state = (over: Partial<SyncState> = {}): SyncState => ({ ...emptySyncState(), ...over });
const META = { label: '10:00 AM – 11:00 AM', startMinutesAbs: 600, endMinutesAbs: 660 };
const CHANGEOVER = { slotIndex: 3, atAbs: 620, startAbs: 620, endAbs: 630, oldPartIndex: 0, newPartIndex: 1 };
const DEVICE = { deviceId: 'dev-a', nowMs: at(12) };

// A session with values on slot 3 (a changeover slot) and on slot 4.
function filled(): SyncState {
  return state({
    producedBySlot: { '3': null, '4': 95 },
    producedSegment: { '3:before': 40, '3:after': 50 },
    rejectionsBySlot: { '3:before': 2, '3:after': 1, '4': 3 },
    lossReasonBySlot: { '3:after': { code: 'B', label: 'Material shortage', note: null } },
    changeovers: { '3': CHANGEOVER },
    stopsBySlot: {
      '3': [{ id: `stop-${at(10, 40)}`, reason: 'material', startAbs: at(10, 40), endAbs: at(10, 52), durationMinutes: 12, running: false }],
      '4': [{ id: `stop-${at(11, 20)}`, reason: 'quality', startAbs: at(11, 20), endAbs: at(11, 25), durationMinutes: 5, running: false }],
    },
    savedSlotIndices: [1],
    otHours: 2,
  });
}

test('delete clears exactly the deleted card and keeps a backup of it', () => {
  const before = filled();
  const after = deleteSlotWithBackup(before, 3, META, at(12));
  assert.deepEqual(after.deletedSlotIndices, [3]);
  assert.equal('3' in after.producedBySlot, false);
  assert.deepEqual(after.producedSegment, {});
  assert.deepEqual(after.rejectionsBySlot, { '4': 3 });
  assert.deepEqual(after.lossReasonBySlot, {});
  assert.deepEqual(after.changeovers, {});
  assert.deepEqual(Object.keys(after.stopsBySlot), ['4']);
  // Other slots, saved slots and OT untouched.
  assert.equal(after.producedBySlot['4'], 95);
  assert.deepEqual(after.savedSlotIndices, [1]);
  assert.equal(after.otHours, 2);
  const b = after.deletedSlotBackups['3']!;
  assert.equal(b.slotIndex, 3);
  assert.equal(b.deletedAtMs, at(12));
  assert.equal(b.label, META.label);
  assert.deepEqual(b.producedSegment, before.producedSegment);
  assert.deepEqual(b.rejections, { '3:before': 2, '3:after': 1 });
  assert.deepEqual(b.changeover, CHANGEOVER);
  assert.equal(b.stops.length, 1);
  // The input state is not mutated.
  assert.deepEqual(before, filled());
  // Deleting again is a no-op (the first backup is kept).
  assert.equal(deleteSlotWithBackup(after, 3, META, at(13)), after);
});

test('restore brings back the original slot index, values, changeover and stops', () => {
  const before = filled();
  const deleted = deleteSlotWithBackup(before, 3, META, at(12));
  assert.deepEqual(restorableSlots(deleted).map((b) => b.slotIndex), [3]);
  const r = restoreDeletedSlot(deleted, 3);
  assert.equal(r.restored, true);
  assert.deepEqual(r.keptCurrent, []);
  // Everything is back exactly as before the delete — no backup left over.
  const { deletedSlotBackups, ...rest } = r.state;
  const { deletedSlotBackups: _b, ...orig } = before;
  assert.deepEqual(deletedSlotBackups, {});
  assert.deepEqual(rest, { ...orig, producedBySlot: { '4': 95 } }); // slot 3's null "produced" was never a value
  assert.deepEqual(restorableSlots(r.state), []);
  // Downtime comes back with the stop — counted once.
  assert.equal(sessionDowntimeMinutes(deleted.stopsBySlot, at(13)), 5);
  assert.equal(sessionDowntimeMinutes(r.state.stopsBySlot, at(13)), 17);
});

test('restore never overwrites values entered after the delete, nor duplicates a stop', () => {
  const deleted = deleteSlotWithBackup(filled(), 3, META, at(12));
  // Another device entered a value for the same key, and already has the stop.
  const edited = clone(deleted);
  edited.producedSegment['3:before'] = 44;
  edited.stopsBySlot['3'] = [clone(filled().stopsBySlot['3'][0])];
  const r = restoreDeletedSlot(edited, 3);
  assert.equal(r.restored, true);
  assert.equal(r.state.producedSegment['3:before'], 44);
  assert.equal(r.state.producedSegment['3:after'], 50);
  assert.deepEqual(r.keptCurrent, ['producedSegment:3:before']);
  assert.equal(r.state.stopsBySlot['3'].length, 1);
});

test('a stop still running at delete time comes back closed at the delete time', () => {
  const s = state({ stopsBySlot: { '5': [{ id: `stop-${at(11)}`, reason: 'material', startAbs: at(11), running: true }] } });
  const deleted = deleteSlotWithBackup(s, 5, META, at(11, 10));
  const r = restoreDeletedSlot(deleted, 5);
  const stop = r.state.stopsBySlot['5'][0];
  assert.equal(stop.running, false);
  assert.equal(stop.endAbs, at(11, 10));
  assert.equal(stop.durationMinutes, 10);
});

test('nothing to restore: not deleted, no backup, or a legacy deletion', () => {
  const s = filled();
  assert.equal(restoreDeletedSlot(s, 3).restored, false);
  // Deleted before backups existed: index in deletedSlotIndices, no backup —
  // not offered, nothing fabricated.
  const legacy = state({ deletedSlotIndices: [6] });
  assert.deepEqual(restorableSlots(legacy), []);
  const r = restoreDeletedSlot(legacy, 6);
  assert.equal(r.restored, false);
  assert.equal(r.state, legacy);
  // Restoring twice: the second is a no-op.
  const once = restoreDeletedSlot(deleteSlotWithBackup(s, 4, META, at(12)), 4);
  assert.equal(restoreDeletedSlot(once.state, 4).restored, false);
});

test('slot ids/indices of the schedule are untouched (incl. Shift B overnight + OT)', () => {
  const slots = buildSlots('B', 2);
  const last = slots[slots.length - 1];
  const s = state({ producedBySlot: { [String(last.index)]: 70 } });
  const deleted = deleteSlotWithBackup(s, last.index, { label: last.label, startMinutesAbs: last.startMinutesAbs, endMinutesAbs: last.endMinutesAbs }, at(27));
  const r = restoreDeletedSlot(deleted, last.index);
  assert.equal(r.state.producedBySlot[String(last.index)], 70);
  assert.deepEqual(buildSlots('B', 2), slots);
  // The backup holds the slot's own (after-midnight) time range.
  assert.equal(deleted.deletedSlotBackups[String(last.index)]!.endMinutesAbs, last.endMinutesAbs);
  assert.ok(last.endMinutesAbs > 1440);
});

test('backups survive a refresh (device draft round trip) and are read safely from old drafts/docs', () => {
  const scope: DraftScope = { uid: 'sup-1', lineId: 'L1', productionDate: PD, shift: 'A', sessionInstance: 'inst-1' };
  const deleted = deleteSlotWithBackup(filled(), 3, META, at(12));
  const raw = JSON.stringify(createDraft(scope, emptySyncState(), 4, deleted, at(12), 5));
  const parsed = parseDraft(raw, scope);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.draft.local.deletedSlotBackups, deleted.deletedSlotBackups);
  assert.equal(restoreDeletedSlot(parsed.draft.local, 3).restored, true);
  // A draft / session doc from before this field: read as {}.
  const old: any = clone(deleted);
  delete old.deletedSlotBackups;
  assert.deepEqual(cleanSyncState(old)?.deletedSlotBackups, {});
  // A damaged backup is dropped, the draft itself is still accepted.
  const damaged: any = clone(deleted);
  damaged.deletedSlotBackups['7'] = { slotIndex: 'x' };
  damaged.deletedSlotBackups['8'] = { slotIndex: 9, deletedAtMs: 1 }; // key/index mismatch
  const cleaned = cleanSyncState(damaged);
  assert.ok(cleaned);
  assert.deepEqual(Object.keys(cleaned!.deletedSlotBackups), ['3']);
});

test('multi-device: a delete on one device and a restore on another merge cleanly', () => {
  const base = filled();
  // Device A deletes slot 3 and syncs (server at revision 1 → 2).
  const a = deleteSlotWithBackup(base, 3, META, at(12));
  const s1 = planSessionSync({ revision: 1, state: base }, a, { revision: 1, state: base }, DEVICE);
  assert.equal(s1.revision, 2);
  // Device B (behind, at revision 1) edits slot 4 meanwhile; its sync merges.
  const b = clone(base);
  b.producedBySlot['4'] = 99;
  const s2 = planSessionSync({ revision: 1, state: base }, b, { revision: 2, state: s1.merged }, { ...DEVICE, deviceId: 'dev-b' });
  assert.deepEqual(s2.conflicts, []);
  assert.deepEqual(s2.merged.deletedSlotIndices, [3]);
  assert.ok(s2.merged.deletedSlotBackups['3']);
  assert.equal(s2.merged.producedBySlot['4'], 99);
  // Device B now restores slot 3 from the synced backup; device A merges it.
  const restored = restoreDeletedSlot(s2.merged, 3).state;
  const m = threeWayMerge(s2.merged, s2.merged, restored, { prefer: 'remote', deviceId: 'dev-a', nowMs: at(13) });
  assert.deepEqual(m.conflicts, []);
  assert.deepEqual(m.merged.deletedSlotIndices, []);
  assert.deepEqual(m.merged.deletedSlotBackups, {});
  assert.equal(m.merged.producedSegment['3:after'], 50);
  assert.equal(m.merged.stopsBySlot['3'].length, 1);
});

console.log(`\n${passed} slot recovery checks passed`);
