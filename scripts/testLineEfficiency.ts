// scripts/testLineEfficiency.ts
//
// Checks for the Line Efficiency Overview logic in
// src/utils/lineEfficiency.ts. The project has no test runner, so this is a
// plain node:assert script:  npm run test:line-efficiency

import assert from 'node:assert/strict';
import {
  BAND_COLORS,
  INACTIVE_COLOR,
  EfficiencyRecord,
  LiveSession,
  RegisteredLine,
  buildLineCards,
  currentStop,
  efficiencyBand,
  efficiencyOf,
  filterLineCards,
  formatStopReason,
  summarize,
} from '../src/utils/lineEfficiency';

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

const DATE = '2026-10-14';
const line = (id: string, lineName = id): RegisteredLine => ({ id, lineName, plant: null, workshop: null, division: null });
const session = (lineId: string, over: Partial<LiveSession> = {}): LiveSession => ({
  lineId,
  lineName: lineId,
  shift: 'A',
  productionDate: DATE,
  lineStopped: false,
  stopsBySlot: {},
  startedAtMs: 1,
  updatedAtMs: 2,
  ...over,
});
const rec = (lineId: string, produced: number | null, expected: number | null, over: Partial<EfficiencyRecord> = {}): EfficiencyRecord => ({
  lineId,
  shift: 'A',
  productionDate: DATE,
  producedThisSlot: produced,
  expectedParts: expected,
  ...over,
});
const cardFor = (lines: RegisteredLine[], sessions: LiveSession[], records: EfficiencyRecord[], id: string) => {
  const c = buildLineCards(lines, sessions, records).find((x) => x.lineId === id);
  assert.ok(c, `card for ${id}`);
  return c!;
};
const runningCard = (produced: number, expected: number) =>
  cardFor([line('L1')], [session('L1')], [rec('L1', produced, expected)], 'L1');

test('band thresholds have no gaps or overlaps', () => {
  assert.equal(efficiencyBand(120), 'excellent');
  assert.equal(efficiencyBand(90.1), 'excellent');
  assert.equal(efficiencyBand(90), 'warning');
  assert.equal(efficiencyBand(75), 'warning');
  assert.equal(efficiencyBand(74.9), 'poor');
  assert.equal(efficiencyBand(50), 'poor');
  assert.equal(efficiencyBand(49.9), 'critical');
  assert.equal(efficiencyBand(0), 'critical');
});

test('1. running line above 90% → green', () => {
  const c = runningCard(95, 100);
  assert.equal(c.efficiency, 95);
  assert.equal(c.color, BAND_COLORS.excellent);
  assert.equal(c.color, '#4C9A6A');
  assert.equal(c.badge, 'Running');
});

test('2. exactly 90% → amber', () => {
  assert.equal(runningCard(90, 100).color, '#F2A93B');
  // A ratio that rounds to 90.0 is coloured as the 90.0 shown, not green.
  assert.equal(runningCard(90004, 100000).efficiency, 90);
  assert.equal(runningCard(90004, 100000).color, '#F2A93B');
});

test('3. 75% → amber', () => {
  assert.equal(runningCard(75, 100).color, '#F2A93B');
});

test('4. 60% → red', () => {
  assert.equal(runningCard(60, 100).color, '#D64545');
});

test('5. below 50% → critical purple', () => {
  assert.equal(runningCard(30, 100).color, '#8B5CF6');
});

test('efficiency is Σactual / Σplanned, not an average of slot percentages', () => {
  // Slot %s are 100% and 50% (avg 75%); the true ratio is 110 / 210 = 52.4%.
  const t = efficiencyOf([rec('L1', 10, 10), rec('L1', 100, 200)]);
  assert.equal(t.actual, 110);
  assert.equal(t.planned, 210);
  assert.equal(t.efficiency, 52.4);
});

test('6. no active session → gray Not Running, despite historical records', () => {
  const c = cardFor([line('L1')], [], [rec('L1', 100, 100)], 'L1');
  assert.equal(c.status, 'not_running');
  assert.equal(c.badge, 'Not Running');
  assert.equal(c.color, INACTIVE_COLOR);
  assert.equal(c.efficiency, null);
});

test('only records of the session (line + date + shift) count', () => {
  const c = cardFor(
    [line('L1')],
    [session('L1', { shift: 'B' })],
    [
      rec('L1', 90, 100, { shift: 'B' }),
      rec('L1', 0, 100, { shift: 'A' }), // earlier shift, same day
      rec('L1', 0, 100, { productionDate: '2026-10-13', shift: 'B' }), // yesterday
      rec('L2', 0, 100, { shift: 'B' }), // other line
    ],
    'L1'
  );
  assert.equal(c.efficiency, 90);
});

test('7. lineStopped stays visible with its real stop reason', () => {
  const s = session('L1', {
    lineStopped: true,
    stopsBySlot: {
      '0': [{ reason: 'changeover', startAbs: 100, running: false }],
      '2': [{ reason: 'material shortage', startAbs: 5000, running: true }],
    },
  });
  const c = cardFor([line('L1')], [s], [rec('L1', 60, 100)], 'L1');
  assert.equal(c.status, 'stopped');
  assert.equal(c.badge, 'Stopped');
  assert.equal(c.stop?.label, 'Material Shortage');
  assert.equal(c.stop?.sinceMs, 5000);
  // Its session efficiency is kept, with its band colour.
  assert.equal(c.efficiency, 60);
  assert.equal(c.color, '#D64545');

  const maint = cardFor([line('L1')], [session('L1', { lineStopped: true, stopsBySlot: { '1': [{ reason: 'maintenance', startAbs: 1, running: true }] } })], [], 'L1');
  assert.equal(maint.badge, 'Maintenance');
  const qual = cardFor([line('L1')], [session('L1', { lineStopped: true, stopsBySlot: { '1': [{ reason: 'quality', startAbs: 1, running: true }] } })], [], 'L1');
  assert.equal(qual.badge, 'Quality Hold');
});

test('7b. stopped with no recorded reason → plain "Stopped", nothing invented', () => {
  const c = cardFor([line('L1')], [session('L1', { lineStopped: true, stopsBySlot: null })], [], 'L1');
  assert.equal(c.badge, 'Stopped');
  assert.equal(c.stop?.reason, null);
  assert.equal(c.stop?.label, null);
});

test('8. resuming (lineStopped false) → Running', () => {
  const resumed = session('L1', {
    lineStopped: false,
    stopsBySlot: { '2': [{ reason: 'maintenance', startAbs: 5000, running: false }] },
  });
  const c = cardFor([line('L1')], [resumed], [rec('L1', 95, 100)], 'L1');
  assert.equal(c.status, 'running');
  assert.equal(c.badge, 'Running');
  assert.equal(c.stop, null);
});

test('9. finalized (session doc gone) → Not Running', () => {
  const lines = [line('L1')];
  const records = [rec('L1', 95, 100)];
  assert.equal(cardFor(lines, [session('L1')], records, 'L1').status, 'running');
  assert.equal(cardFor(lines, [], records, 'L1').status, 'not_running');
});

test('10. missing / zero planned production → no percentage', () => {
  for (const records of [[], [rec('L1', 10, 0)], [rec('L1', 10, null)], [rec('L1', null, null)]]) {
    const c = cardFor([line('L1')], [session('L1')], records, 'L1');
    assert.equal(c.efficiency, null);
    assert.equal(c.band, null);
    assert.equal(c.color, INACTIVE_COLOR);
    assert.equal(c.status, 'running');
  }
});

test('11. every registered line appears, plus live sessions on unregistered lines', () => {
  const cards = buildLineCards(
    [line('L1', 'Line 1'), line('L2', 'Line 2'), line('L3', 'Line 3')],
    [session('L1'), session('L2', { lineStopped: true }), session('GONE')],
    [rec('L1', 95, 100)]
  );
  assert.deepEqual(cards.map((c) => c.lineId).sort(), ['GONE', 'L1', 'L2', 'L3']);
  assert.deepEqual(summarize(cards), { total: 4, running: 2, stopped: 1, notRunning: 1 });
  // Stopped first, then running, then not running.
  assert.equal(cards[0].lineId, 'L2');
  assert.equal(cards[cards.length - 1].lineId, 'L3');
});

test('formatStopReason / currentStop', () => {
  assert.equal(formatStopReason('power cut'), 'Power Cut');
  assert.equal(formatStopReason('5s'), '5S');
  assert.equal(formatStopReason('gauge/fixture maintenance'), 'Gauge/Fixture Maintenance');
  const s = session('L1', {
    stopsBySlot: {
      '1': [{ reason: 'quality', startAbs: 10, running: true }],
      '3': [{ reason: 'power cut', startAbs: 20, running: true }],
    },
  });
  assert.equal(currentStop(s).reason, 'power cut'); // latest running stop
});

test('plant / workshop filter', () => {
  const lines: RegisteredLine[] = [
    { id: 'L1', lineName: 'L1', plant: 'Plant 1', workshop: 'Assembly', division: null },
    { id: 'L2', lineName: 'L2', plant: 'Plant 1', workshop: 'Machining', division: null },
    { id: 'L3', lineName: 'L3', plant: 'Plant 2 ', workshop: 'assembly', division: null },
  ];
  const cards = buildLineCards(lines, [session('L1'), session('GONE')], []);
  const ids = (f: { plant: string | null; workshop: string | null }) =>
    filterLineCards(cards, f).map((c) => c.lineId).sort();
  assert.deepEqual(ids({ plant: null, workshop: null }), ['GONE', 'L1', 'L2', 'L3']);
  assert.deepEqual(ids({ plant: 'Plant 1', workshop: null }), ['L1', 'L2']);
  assert.deepEqual(ids({ plant: null, workshop: 'Assembly' }), ['L1', 'L3']); // case/space-insensitive
  assert.deepEqual(ids({ plant: 'plant 2', workshop: 'Assembly' }), ['L3']);
  assert.deepEqual(ids({ plant: 'Plant 3', workshop: null }), []);
  // Counts follow the filter.
  assert.deepEqual(summarize(filterLineCards(cards, { plant: 'Plant 1', workshop: null })), {
    total: 2, running: 1, stopped: 0, notRunning: 1,
  });
});

console.log(`\n${passed} passed`);
