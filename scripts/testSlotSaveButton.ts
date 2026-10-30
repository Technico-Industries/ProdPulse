// scripts/testSlotSaveButton.ts
//
// Checks for the Record Production slot button (Save Slot → Update Slot,
// src/utils/slotSaveButton.ts): per-slot state driven by persisted saved
// status, kept through failed saves and restored from saved records.
// Plain node:assert script:
//   npm run test:slot-save-button

import assert from 'node:assert/strict';
import { slotSaveButtonState } from '../src/utils/slotSaveButton';
import { emptySyncState, fillFromRecords, productionRecordId, RestoreRecord } from '../src/utils/productionDraft';

let passed = 0;
function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch((e) => { console.error(`  ✗ ${name}`); throw e; });
}

// The screen's save flow, without React or Firestore: saved/saving sets
// per slot, and a slot joins `saved` only after the write succeeds.
function screen(initialSaved: number[] = []) {
  const saved = new Set(initialSaved);
  const saving = new Set<number>();
  let writes = 0;
  const records = new Map<number, number>(); // slot → record count (upsert: never > 1)
  const button = (i: number, lineStopped = false) =>
    slotSaveButtonState({ saved: saved.has(i), saving: saving.has(i), lineStopped });
  async function save(i: number, write: () => Promise<void>) {
    if (saving.has(i)) return 'ignored';
    saving.add(i);
    try {
      await write();
      writes++;
      records.set(i, 1);
      saved.add(i);
      return 'ok';
    } catch {
      return 'error';
    } finally {
      saving.delete(i);
    }
  }
  return { saved, button, save, records, get writes() { return writes; } };
}

const ok = () => Promise.resolve();
const fail = () => Promise.reject(new Error('offline'));

const IDENTITY = { productionDate: '2026-10-30', lineId: 'L1', shift: 'A' };
const SESSION_START = Date.UTC(2026, 9, 30, 2, 0);
function record(p: Partial<RestoreRecord> & { slotIndex: number }): RestoreRecord {
  const seg = p.partSegment ?? null;
  return {
    id: productionRecordId({ ...IDENTITY, slotIndex: p.slotIndex, segment: seg ?? 'full' }),
    partSegment: seg, producedThisSlot: null, rejections: null,
    lossReasonCode: null, lossReasonLabel: null, lossReasonNote: null,
    createdAtMs: SESSION_START + 60_000, updatedAtMs: SESSION_START + 60_000,
    ...p,
  };
}

(async () => {
  console.log('slotSaveButton');

  await test('new slot shows Save Slot in the default style', () => {
    assert.deepEqual(slotSaveButtonState({ saved: false, saving: false, lineStopped: false }),
      { label: 'Save Slot', variant: 'save', disabled: false });
  });

  await test('saved slot shows Update Slot in green', () => {
    assert.deepEqual(slotSaveButtonState({ saved: true, saving: false, lineStopped: false }),
      { label: 'Update Slot', variant: 'update', disabled: false });
  });

  await test('in-flight save is disabled and keeps its previous colour', () => {
    assert.deepEqual(slotSaveButtonState({ saved: false, saving: true, lineStopped: false }),
      { label: 'Saving…', variant: 'save', disabled: true });
    assert.deepEqual(slotSaveButtonState({ saved: true, saving: true, lineStopped: false }),
      { label: 'Updating…', variant: 'update', disabled: true });
  });

  await test('stopped line disables the button', () => {
    const s = slotSaveButtonState({ saved: true, saving: false, lineStopped: true });
    assert.equal(s.disabled, true);
    assert.equal(s.variant, 'disabled');
    assert.equal(s.label, 'Update Slot');
  });

  await test('typing alone never turns a slot green', () => {
    const sc = screen();
    // Values entered for slot 0, not saved: button still Save Slot.
    assert.equal(sc.button(0).label, 'Save Slot');
  });

  await test('green only after the save succeeds', async () => {
    const sc = screen();
    let release!: () => void;
    const p = sc.save(0, () => new Promise<void>((r) => { release = r; }));
    assert.equal(sc.button(0).label, 'Saving…');
    assert.equal(sc.button(0).variant, 'save');
    release();
    assert.equal(await p, 'ok');
    assert.equal(sc.button(0).label, 'Update Slot');
    assert.equal(sc.button(0).variant, 'update');
  });

  await test('saving one slot leaves the other slots unchanged', async () => {
    const sc = screen([2]);
    let release!: () => void;
    const p = sc.save(0, () => new Promise<void>((r) => { release = r; }));
    assert.equal(sc.button(1).label, 'Save Slot');
    assert.equal(sc.button(1).disabled, false);
    assert.equal(sc.button(2).label, 'Update Slot');
    assert.equal(sc.button(2).disabled, false);
    release();
    await p;
    assert.equal(sc.button(0).variant, 'update');
    assert.equal(sc.button(1).variant, 'save');
    assert.equal(sc.button(2).variant, 'update');
  });

  await test('updating a saved slot keeps it green and writes no duplicate', async () => {
    const sc = screen();
    await sc.save(0, ok);
    await sc.save(0, ok);
    assert.equal(sc.button(0).label, 'Update Slot');
    assert.equal(sc.records.get(0), 1);
  });

  await test('failed save keeps the previous state', async () => {
    const sc = screen([1]);
    assert.equal(await sc.save(0, fail), 'error');
    assert.equal(sc.button(0).label, 'Save Slot');
    assert.equal(sc.button(0).variant, 'save');
    assert.equal(await sc.save(1, fail), 'error');
    assert.equal(sc.button(1).label, 'Update Slot');
    assert.equal(sc.button(1).variant, 'update');
  });

  await test('duplicate taps while saving are ignored', async () => {
    const sc = screen();
    let release!: () => void;
    const first = sc.save(0, () => new Promise<void>((r) => { release = r; }));
    assert.equal(await sc.save(0, ok), 'ignored');
    release();
    await first;
    assert.equal(sc.writes, 1);
  });

  await test('reopened session restores button state from saved records', () => {
    const data = emptySyncState();
    // Slot 0: record matches the shown value. Slot 1: typed only, no record.
    // Slot 2: changeover slot with both segment records. Slot 3: marked
    // saved but its record is gone — dropped, so it shows Save Slot again.
    data.producedBySlot = { '0': 50, '1': 40 };
    data.savedSlotIndices = [3];
    const records = [
      record({ slotIndex: 0, producedThisSlot: 50 }),
      record({ slotIndex: 2, partSegment: 'before', producedThisSlot: 20 }),
      record({ slotIndex: 2, partSegment: 'after', producedThisSlot: 25 }),
    ];
    fillFromRecords(data, records, IDENTITY, SESSION_START, new Set([2]));
    const saved = new Set(data.savedSlotIndices);
    const label = (i: number) => slotSaveButtonState({ saved: saved.has(i), saving: false, lineStopped: false }).label;
    assert.equal(label(0), 'Update Slot');
    assert.equal(label(1), 'Save Slot');
    assert.equal(label(2), 'Update Slot');
    assert.equal(label(3), 'Save Slot');
  });

  console.log(`\n${passed} passed`);
})().catch(() => process.exit(1));
