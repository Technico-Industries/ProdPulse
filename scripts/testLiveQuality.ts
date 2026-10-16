// scripts/testLiveQuality.ts
//
// Checks for the live QC Lines page logic in src/utils/liveQuality.ts —
// rejections from the Record Production counter (productionRecords
// .rejections). The project has no test runner, so this is a plain
// node:assert script:  npm run test:live-quality

import assert from 'node:assert/strict';
import { LiveSession, RegisteredLine } from '../src/utils/lineEfficiency';
import {
  LiveRecord,
  QUALITY_COLORS,
  buildQualityCards,
  qualityStatus,
  summarizeQuality,
} from '../src/utils/liveQuality';

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

const DATE = '2026-10-16';

const line = (id: string, name = id): RegisteredLine => ({
  id,
  lineName: name,
  plant: 'Plant 1',
  workshop: 'Assembly',
  division: null,
});

const session = (lineId: string, over: Partial<LiveSession> = {}): LiveSession => ({
  lineId,
  lineName: lineId,
  shift: 'A',
  productionDate: DATE,
  lineStopped: false,
  stopsBySlot: null,
  startedAtMs: null,
  updatedAtMs: null,
  ...over,
});

let slotSeq = 0;
// One saved slot record: `produced` good parts + `rejections` on the counter.
const slot = (lineId: string, produced: number, rejections: number | null | undefined, over: Partial<LiveRecord> = {}): LiveRecord => ({
  lineId,
  shift: 'A',
  productionDate: DATE,
  expectedParts: produced,
  producedThisSlot: produced,
  rejections,
  slotIndex: slotSeq++,
  ...over,
});

const one = (good: number, rejected: number) =>
  buildQualityCards([line('L1')], [session('L1')], [slot('L1', good, rejected)]).cards[0];

test('1. 99% quality → Good (green)', () => {
  const c = one(99, 1);
  assert.equal(c.qualityPct, 99);
  assert.equal(c.rejectionPct, 1);
  assert.equal(c.inspectedParts, 100);
  assert.equal(c.status, 'good');
  assert.equal(c.color, '#4C9A6A');
});

test('2. 96% quality → Warning (amber)', () => {
  const c = one(96, 4);
  assert.equal(c.qualityPct, 96);
  assert.equal(c.status, 'warning');
  assert.equal(c.color, '#F2A93B');
});

test('3. 90% quality → Critical (red)', () => {
  const c = one(90, 10);
  assert.equal(c.qualityPct, 90);
  assert.equal(c.status, 'critical');
  assert.equal(c.color, '#D64545');
});

test('threshold boundaries: 98 Good, 97.9 Warning, 95 Warning, 94.9 Critical', () => {
  assert.equal(qualityStatus(98), 'good');
  assert.equal(qualityStatus(97.9), 'warning');
  assert.equal(qualityStatus(95), 'warning');
  assert.equal(qualityStatus(94.9), 'critical');
  assert.equal(qualityStatus(null), 'unavailable');
});

test('checklist 1–2: 100 produced + 5 on the counter → 5 rejected, 4.8% / 95.2%', () => {
  const c = one(100, 5);
  assert.equal(c.rejectedParts, 5);
  assert.equal(c.inspectedParts, 105);
  assert.equal(c.rejectionPct, 4.8);
  assert.equal(c.qualityPct, 95.2);
  assert.equal(c.status, 'warning');
});

test('no saved slots yet → unavailable, 0 rejected', () => {
  const { cards } = buildQualityCards([line('L1')], [session('L1')], []);
  const c = cards[0];
  assert.equal(c.inspectedParts, 0);
  assert.equal(c.rejectedParts, 0);
  assert.equal(c.qualityPct, null);
  assert.equal(c.status, 'unavailable');
  assert.equal(c.color, QUALITY_COLORS.unavailable);
  assert.equal(summarizeQuality(cards).totalRejected, 0);
});

test('productionRecords not loaded → unavailable, totals unknown', () => {
  const { cards } = buildQualityCards([line('L1')], [session('L1')], null);
  assert.equal(cards[0].goodParts, null);
  assert.equal(cards[0].rejectedParts, null);
  assert.equal(cards[0].status, 'unavailable');
  assert.equal(summarizeQuality(cards).totalRejected, null);
});

test('everything rejected → 0% Critical (a real figure)', () => {
  const c = one(0, 5);
  assert.equal(c.qualityPct, 0);
  assert.equal(c.status, 'critical');
});

test('legacy slots without the counter are excluded and counted', () => {
  const { cards } = buildQualityCards([line('L1')], [session('L1')], [slot('L1', 98, 2), slot('L1', 500, undefined)]);
  assert.equal(cards[0].goodParts, 98);
  assert.equal(cards[0].rejectedParts, 2);
  assert.equal(cards[0].qualityPct, 98);
  assert.equal(cards[0].legacyRecords, 1);
});

test('only legacy slots → unavailable, total unknown', () => {
  const { cards } = buildQualityCards([line('L1')], [session('L1')], [slot('L1', 500, null)]);
  assert.equal(cards[0].rejectedParts, null);
  assert.equal(cards[0].status, 'unavailable');
  assert.equal(summarizeQuality(cards).totalRejected, null);
});

test('checklist 5: counts go to the matching line + date + shift only', () => {
  const { cards } = buildQualityCards(
    [line('L1'), line('L2')],
    [session('L1'), session('L2')],
    [
      slot('L1', 100, 3),
      slot('L1', 100, 2),
      slot('L2', 100, 7),
      slot('L1', 100, 50, { shift: 'B' }), // other shift
      slot('L1', 100, 50, { productionDate: '2026-10-15' }), // other day
    ]
  );
  const byId = new Map(cards.map((c) => [c.lineId, c]));
  assert.equal(byId.get('L1')!.rejectedParts, 5);
  assert.equal(byId.get('L1')!.goodParts, 200);
  assert.equal(byId.get('L2')!.rejectedParts, 7);
});

test('checklist 3: rejectionRecords are not an input at all', () => {
  // buildQualityCards takes only productionRecords — there is no parameter
  // through which a Record Rejection entry could be added.
  assert.equal(buildQualityCards.length, 3);
  assert.equal(one(95, 5).rejectedParts, 5);
});

test('checklist 4: a re-saved slot counts once, with its latest values', () => {
  // Legacy duplicate docs of one slot: the canonical/earliest one is kept,
  // so the slot is never doubled.
  const a = slot('L1', 98, 2, { id: 'x1', slotIndex: 0, createdAtMs: 1 });
  const dup = slot('L1', 98, 2, { id: 'x2', slotIndex: 0, createdAtMs: 2 });
  const { cards } = buildQualityCards([line('L1')], [session('L1')], [a, dup]);
  assert.equal(cards[0].rejectedParts, 2);
  assert.equal(cards[0].goodParts, 98);
  // Re-save = the same doc updated in place → the new figures replace the old.
  const resaved = { ...a, producedThisSlot: 95, rejections: 5 };
  const after = buildQualityCards([line('L1')], [session('L1')], [resaved]).cards[0];
  assert.equal(after.rejectedParts, 5);
  assert.equal(after.qualityPct, 95);
});

test('changeover halves are counted once each', () => {
  const before = slot('L1', 40, 1, { slotIndex: 3, partSegment: 'before', updatedAtMs: 5 });
  const after = slot('L1', 60, 2, { slotIndex: 3, partSegment: 'after', updatedAtMs: 5 });
  const { cards } = buildQualityCards([line('L1')], [session('L1')], [before, after]);
  assert.equal(cards[0].rejectedParts, 3);
  assert.equal(cards[0].goodParts, 100);
});

test('aggregate quantities, never average slot percentages', () => {
  // Slot 1: 10 good / 0 rej (0%). Slot 2: 90 good / 10 rej (10%).
  const { cards } = buildQualityCards([line('L1')], [session('L1')], [slot('L1', 10, 0), slot('L1', 90, 10)]);
  assert.equal(cards[0].qualityPct, 90.9);
  assert.equal(cards[0].rejectionPct, 9.1);
});

test('stopped session stays visible with its recorded stop reason', () => {
  const s = session('L1', {
    lineStopped: true,
    stopsBySlot: {
      '0': [
        { reason: 'quality', startAbs: 100, running: false },
        { reason: 'material shortage', startAbs: 200, running: true },
      ],
    },
  });
  const { cards, notRunning } = buildQualityCards([line('L1')], [s], [slot('L1', 100, 0)]);
  assert.equal(cards.length, 1);
  assert.equal(notRunning.length, 0);
  assert.equal(cards[0].runState, 'stopped');
  assert.equal(cards[0].runLabel, 'Material Shortage');
  assert.equal(summarizeQuality(cards).stopped, 1);
  assert.equal(summarizeQuality(cards).activeSessions, 1);
});

test('stopped with no recorded reason → "Stopped" (no invented reason)', () => {
  const { cards } = buildQualityCards([line('L1')], [session('L1', { lineStopped: true })], []);
  assert.equal(cards[0].runLabel, 'Stopped');
  assert.equal(cards[0].stop?.reason, null);
});

test('resumed session → Running', () => {
  const s = session('L1', {
    lineStopped: false,
    stopsBySlot: { '0': [{ reason: 'maintenance', startAbs: 100, running: false }] },
  });
  const { cards } = buildQualityCards([line('L1')], [s], []);
  assert.equal(cards[0].runState, 'running');
  assert.equal(cards[0].runLabel, 'Running');
  assert.equal(cards[0].stop, null);
});

test('finalized session (activeSessions doc gone) leaves the active grid', () => {
  const lines = [line('L1'), line('L2')];
  const before = buildQualityCards(lines, [session('L1'), session('L2')], []);
  assert.equal(before.cards.length, 2);
  const after = buildQualityCards(lines, [session('L2')], []);
  assert.deepEqual(after.cards.map((c) => c.lineId), ['L2']);
  assert.deepEqual(after.notRunning.map((l) => l.lineId), ['L1']);
});

test('a session on an unregistered line still gets a card', () => {
  const { cards } = buildQualityCards([], [session('GHOST', { lineName: 'Old Line' })], []);
  assert.equal(cards[0].lineName, 'Old Line');
});

test('summary is built from the same cards; worst quality sorts first', () => {
  const { cards } = buildQualityCards(
    [line('A'), line('B'), line('C'), line('D'), line('E')],
    [session('A'), session('B'), session('C', { lineStopped: true }), session('D')],
    [slot('A', 99, 1), slot('B', 96, 4), slot('C', 90, 10)]
  );
  assert.deepEqual(cards.map((c) => c.lineId), ['C', 'B', 'A', 'D']);
  assert.deepEqual(summarizeQuality(cards), {
    activeSessions: 4,
    running: 3,
    stopped: 1,
    good: 1,
    warning: 1,
    critical: 1,
    unavailable: 1,
    totalRejected: 15,
  });
});

console.log(`\n${passed} passed`);
