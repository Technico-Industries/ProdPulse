// scripts/testSupervisorShift.ts
//
// The Supervisor Production Overview must show ONLY the session's own
// shift. Shift A and Shift B of a line share one productionDate, so records
// are matched on line + production day + shift (utils/supervisorShift).
// Plain node:assert script:  npm run test:supervisor-shift

import assert from 'node:assert/strict';
import {
  normalizeShift,
  selectSessionShiftRecords,
  sessionProductionDate,
  ShiftScopedRecord,
} from '../src/utils/supervisorShift';

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

type Rec = ShiftScopedRecord & { id: string; producedThisSlot: number; expectedParts: number; rejections: number };

// Same formulas as SupervisorOverviewScreen's aggregate().
function kpis(records: Rec[]) {
  const actual = records.reduce((s, r) => s + r.producedThisSlot, 0);
  const target = records.reduce((s, r) => s + r.expectedParts, 0);
  const rejections = records.reduce((s, r) => s + r.rejections, 0);
  const achievement = target > 0 ? Math.round((actual / target) * 1000) / 10 : 0;
  return { actual, target, rejections, achievement };
}

const DAY = '2026-11-10';
const L1 = 'line-1';

// Shift A: 300 / 450 (3 slots). Shift B: 330 / 500 (3 slots, last after
// midnight — still filed under the night it started on).
const records: Rec[] = [
  { id: 'a1', lineId: L1, shift: 'A', productionDate: DAY, producedThisSlot: 100, expectedParts: 150, rejections: 2 },
  { id: 'a2', lineId: L1, shift: 'A', productionDate: DAY, producedThisSlot: 100, expectedParts: 150, rejections: 1 },
  { id: 'a3', lineId: L1, shift: 'A', productionDate: DAY, producedThisSlot: 100, expectedParts: 150, rejections: 0 },
  { id: 'b1', lineId: L1, shift: 'B', productionDate: DAY, producedThisSlot: 110, expectedParts: 170, rejections: 4 },
  { id: 'b2', lineId: L1, shift: 'B', productionDate: DAY, producedThisSlot: 110, expectedParts: 165, rejections: 0 },
  { id: 'b3-after-midnight', lineId: L1, shift: 'B', productionDate: DAY, producedThisSlot: 110, expectedParts: 165, rejections: 1 },
  // Noise: another line, and the previous / next production days.
  { id: 'other-line', lineId: 'line-2', shift: 'B', productionDate: DAY, producedThisSlot: 999, expectedParts: 999, rejections: 9 },
  { id: 'prev-night-B', lineId: L1, shift: 'B', productionDate: '2026-11-09', producedThisSlot: 777, expectedParts: 800, rejections: 7 },
  { id: 'next-day-A', lineId: L1, shift: 'A', productionDate: '2026-11-11', producedThisSlot: 555, expectedParts: 600, rejections: 5 },
];

console.log('Supervisor overview — shift scoping');

test('Shift A supervisor sees 300 / 450 = 66.7%', () => {
  const k = kpis(selectSessionShiftRecords([{ lineId: L1, shift: 'A', productionDate: DAY }], records));
  assert.deepEqual(k, { actual: 300, target: 450, rejections: 3, achievement: 66.7 });
});

test('Shift B supervisor sees 330 / 500 = 66%', () => {
  const k = kpis(selectSessionShiftRecords([{ lineId: L1, shift: 'B', productionDate: DAY }], records));
  assert.deepEqual(k, { actual: 330, target: 500, rejections: 5, achievement: 66 });
});

test('Shift B keeps its after-midnight slot; never pulls in Shift A or other days', () => {
  const ids = selectSessionShiftRecords([{ lineId: L1, shift: 'B', productionDate: DAY }], records).map((r) => r.id);
  assert.deepEqual(ids, ['b1', 'b2', 'b3-after-midnight']);
});

test('the old (line + date only) match combined both shifts — the bug', () => {
  const old = records.filter((r) => r.lineId === L1 && r.productionDate === DAY);
  assert.deepEqual(kpis(old), { actual: 630, target: 950, rejections: 8, achievement: 66.3 });
});

test('multiple lines: each session gets only its own shift', () => {
  const recs: Rec[] = [
    ...records,
    { id: 'l2-A', lineId: 'line-2', shift: 'A', productionDate: DAY, producedThisSlot: 50, expectedParts: 60, rejections: 0 },
  ];
  const ids = selectSessionShiftRecords(
    [
      { lineId: L1, shift: 'B', productionDate: DAY },
      { lineId: 'line-2', shift: 'A', productionDate: DAY },
    ],
    recs
  ).map((r) => r.id);
  assert.deepEqual(ids, ['b1', 'b2', 'b3-after-midnight', 'l2-A']);
});

test('historical session (previous night) sees only that night', () => {
  const ids = selectSessionShiftRecords([{ lineId: L1, shift: 'B', productionDate: '2026-11-09' }], records).map((r) => r.id);
  assert.deepEqual(ids, ['prev-night-B']);
});

test('a session with no production date matches nothing (no fallback to other data)', () => {
  assert.deepEqual(selectSessionShiftRecords([{ lineId: L1, shift: 'B', productionDate: null }], records), []);
});

test('normalizeShift: missing/unknown → A, B stays B', () => {
  assert.equal(normalizeShift('B'), 'B');
  assert.equal(normalizeShift('A'), 'A');
  assert.equal(normalizeShift(undefined), 'A');
});

test('sessionProductionDate: stored date wins; else Shift B startedAt maps to its start night', () => {
  assert.equal(sessionProductionDate({ productionDate: DAY, startedAtMs: null }), DAY);
  // Started 7:05 PM on the 10th → production day 10th.
  assert.equal(sessionProductionDate({ productionDate: null, startedAtMs: new Date(2026, 10, 10, 19, 5).getTime() }), DAY);
  // Started 1:00 AM on the 11th (before 6:30 cutover) → still the 10th.
  assert.equal(sessionProductionDate({ productionDate: undefined, startedAtMs: new Date(2026, 10, 11, 1, 0).getTime() }), DAY);
  assert.equal(sessionProductionDate({ productionDate: null, startedAtMs: null }), null);
});

console.log(`\n${passed} passed`);
