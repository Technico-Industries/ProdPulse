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
  LIVE_STATUS_COLORS,
  buildLineCards,
  buildLiveLines,
  downtimeReasonsOf,
  getLineStatus,
  groupLiveLines,
  lastSavedSlot,
  capsuleFigures,
  formatCapsuleCount,
  formatCapsulePct,
  plantSummary,
  currentStop,
  efficiencyBand,
  efficiencyOf,
  filterLineCards,
  formatStopReason,
  productionFigures,
  summarize,
} from '../src/utils/lineEfficiency';
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

test('division filter', () => {
  const lines: RegisteredLine[] = [
    { id: 'A1', lineName: 'A1', plant: 'Bawal 1', workshop: 'Assembly Shop', division: 'Side Door' },
    { id: 'A2', lineName: 'A2', plant: 'Bawal 1', workshop: 'Assembly Shop', division: 'Nissan P1324' },
    { id: 'W1', lineName: 'W1', plant: 'Bawal 1', workshop: 'Welding Shop', division: 'Div-1' },
    { id: 'X1', lineName: 'X1', plant: 'Bawal 1', workshop: 'Welding Shop', division: null },
  ];
  const cards = buildLineCards(lines, [session('W1')], []);
  const ids = (division: string | null, workshop: string | null = null) =>
    filterLineCards(cards, { plant: null, workshop, division }).map((c) => c.lineId).sort();
  assert.deepEqual(ids(null), ['A1', 'A2', 'W1', 'X1']);
  assert.deepEqual(ids('nissan p1324 '), ['A2']); // case/space-insensitive
  assert.deepEqual(ids('Div-1'), ['W1']);
  assert.deepEqual(ids('Div-1', 'Assembly Shop'), []);
  assert.deepEqual(ids('Div-1', 'Welding Shop'), ['W1']);
  // Without the field, the old two-filter call is unchanged.
  assert.equal(filterLineCards(cards, { plant: null, workshop: null }).length, 4);
});

// ─── Actual / Target under the line name ────────────────────────────────────

// A saved slot as RecordProductionScreen stores it: deterministic ID,
// slotIndex, partSegment (null for a normal slot).
const slotRec = (
  slotIndex: number,
  produced: number,
  expected: number,
  over: Partial<EfficiencyRecord> = {}
): EfficiencyRecord => {
  const seg = over.partSegment ?? null;
  return rec('L1', produced, expected, {
    id: ['pr', DATE, 'L1', 'A', String(slotIndex), seg ?? 'full'].map(encodeURIComponent).join('|'),
    slotIndex,
    partSegment: seg,
    createdAtMs: 10,
    updatedAtMs: 10,
    ...over,
  });
};
const l1 = (records: EfficiencyRecord[], s: LiveSession = session('L1')) => cardFor([line('L1')], [s], records, 'L1');

test('F1. 250 actual / 366 target → "250 / 366" and 68.3%', () => {
  const c = l1([slotRec(0, 100, 122), slotRec(1, 80, 122), slotRec(2, 70, 122)]);
  assert.equal(c.actual, 250);
  assert.equal(c.planned, 366);
  assert.equal(productionFigures(c), '250 / 366');
  assert.equal(c.efficiency, 68.3);
  // Efficiency is computed from exactly the figures shown.
  assert.equal(c.efficiency, Math.round((c.actual / c.planned) * 1000) / 10);
});

test('F2. re-saving a slot (same doc, new values) does not duplicate', () => {
  const before = l1([slotRec(0, 100, 122), slotRec(1, 80, 122)]);
  assert.equal(productionFigures(before), '180 / 244');
  // The listener delivers the updated doc in place of the old one.
  const after = l1([slotRec(0, 110, 122, { updatedAtMs: 20 }), slotRec(1, 80, 122)]);
  assert.equal(productionFigures(after), '190 / 244');
});

test('F2b. legacy addDoc duplicates of one slot count once (canonical/earliest wins)', () => {
  const c = l1([
    slotRec(0, 100, 122),
    slotRec(0, 999, 999, { id: 'legacyA', createdAtMs: 1 }),
    slotRec(1, 80, 122, { id: 'legacyB', createdAtMs: 5 }),
    slotRec(1, 999, 999, { id: 'legacyC', createdAtMs: 9 }),
  ]);
  assert.equal(productionFigures(c), '180 / 244');
});

test('F3. changeover before + after segments each counted exactly once', () => {
  const c = l1([
    slotRec(0, 100, 122),
    slotRec(1, 40, 50, { partSegment: 'before' }),
    slotRec(1, 60, 72, { partSegment: 'after' }),
    slotRec(1, 60, 72, { partSegment: 'after', id: 'legacyAfter', createdAtMs: 1 }),
  ]);
  assert.equal(productionFigures(c), '200 / 244');
});

test('F3b. stale full record next to a newer split (or vice versa) → latest shape only', () => {
  const split = [
    slotRec(1, 40, 50, { partSegment: 'before', updatedAtMs: 30 }),
    slotRec(1, 60, 72, { partSegment: 'after', updatedAtMs: 30 }),
  ];
  assert.equal(productionFigures(l1([slotRec(1, 90, 122, { updatedAtMs: 20 }), ...split])), '100 / 122');
  assert.equal(productionFigures(l1([slotRec(1, 90, 122, { updatedAtMs: 40 }), ...split])), '90 / 122');
});

test('F4. stopped line keeps its current session figures', () => {
  const s = session('L1', { lineStopped: true, stopsBySlot: { '2': [{ reason: 'power cut', startAbs: 1, running: true }] } });
  const c = l1([slotRec(0, 100, 122), slotRec(1, 80, 122), slotRec(2, 70, 122)], s);
  assert.equal(c.status, 'stopped');
  assert.equal(productionFigures(c), '250 / 366');
  assert.equal(c.efficiency, 68.3);
});

test('F5. no active session → "— / —", not historical totals', () => {
  const c = cardFor([line('L1')], [], [slotRec(0, 100, 122)], 'L1');
  assert.equal(productionFigures(c), '— / —');
  // Earlier shift / day records don't leak into the current session.
  const cur = l1([
    slotRec(0, 50, 100),
    slotRec(0, 999, 999, { shift: 'B', id: 'x' }),
    slotRec(0, 999, 999, { productionDate: '2026-10-13', id: 'y' }),
  ]);
  assert.equal(productionFigures(cur), '50 / 100');
});

test('F6. missing / zero target handled safely', () => {
  assert.equal(productionFigures(l1([])), '— / —');
  const zero = l1([slotRec(0, 10, 0)]);
  assert.equal(productionFigures(zero), '10 / —');
  assert.equal(zero.efficiency, null);
  const missing = l1([rec('L1', 10, null)]);
  assert.equal(productionFigures(missing), '10 / —');
  assert.equal(missing.efficiency, null);
});

// ─── getLineStatus / live lines (phone Lines screen) ────────────────────────

test('S1. getLineStatus: excellent ≥ 90, warning 75–90, poor < 75', () => {
  const st = (efficiency: number) => getLineStatus({ hasSession: true, efficiency });
  assert.equal(st(95), 'excellent');
  assert.equal(st(90), 'excellent'); // inclusive
  assert.equal(st(89.9), 'warning');
  assert.equal(st(75), 'warning'); // inclusive
  assert.equal(st(74.9), 'poor');
  assert.equal(st(0), 'poor');
});

test('S2. getLineStatus: > 100% is excellent, value not capped', () => {
  assert.equal(getLineStatus({ hasSession: true, efficiency: 105 }), 'excellent');
  assert.equal(getLineStatus({ hasSession: true, efficiency: 250 }), 'excellent');
  const c = buildLiveLines([line('L1')], [session('L1')], [rec('L1', 105, 100)], 0).find((x) => x.lineId === 'L1')!;
  assert.equal(c.efficiency, 105);
  assert.equal(c.liveStatus, 'excellent');
});

test('S3. getLineStatus: noEntry when nothing saved, or the latest ended slot is missing', () => {
  assert.equal(getLineStatus({ hasSession: true, efficiency: null }), 'noEntry');
  assert.equal(getLineStatus({ hasSession: true, efficiency: 98, missedSlot: true }), 'noEntry');
  assert.equal(getLineStatus({ hasSession: true, efficiency: 40, missedSlot: true }), 'noEntry');
});

test('S4. getLineStatus: notRunning without a session, whatever the figure', () => {
  assert.equal(getLineStatus({ hasSession: false, efficiency: null }), 'notRunning');
  assert.equal(getLineStatus({ hasSession: false, efficiency: 100 }), 'notRunning');
});

test('S5. status colours: no purple anywhere', () => {
  assert.deepEqual(LIVE_STATUS_COLORS, {
    excellent: '#4C9A6A', warning: '#F2A93B', poor: '#D64545', noEntry: '#8A96A3', notRunning: '#5C6670',
  });
});

// Assembly Shift A: 07–08 (0), 08–09 (1), 09–10 (2), 10–11 (3), 11–12:15 (4),
// lunch (5), 12:45–14 (6, labelled 13), 14–15 (7), 15–15:30 (8).
const at = (hh: number, mm = 0, key = DATE) => productionDayMinuteToMillis(key, hh * 60 + mm);
const live = (records: EfficiencyRecord[], nowMs: number, s: LiveSession = session('L1')) =>
  buildLiveLines([line('L1')], [s], records, nowMs).find((x) => x.lineId === 'L1')!;

test('S6. all ended slots saved → banded by %, slot bars saved/current/future', () => {
  const c = live([slotRec(0, 100, 100), slotRec(1, 92, 100), slotRec(2, 95, 100)], at(10, 30));
  assert.equal(c.efficiency, 95.7);
  assert.equal(c.missedSlot, false);
  assert.equal(c.liveStatus, 'excellent');
  assert.equal(c.statusColor, '#4C9A6A');
  assert.deepEqual(c.slots.map((s) => s.state), ['saved', 'saved', 'saved', 'current', 'future', 'future', 'future', 'future']);
  assert.deepEqual(c.slots.map((s) => s.label), ['07', '08', '09', '10', '11', '13', '14', '15']);
  assert.equal(c.slots[1].actual, 92);
  assert.equal(c.slots[1].target, 100);
});

test('S7. latest ended slot not saved → noEntry since end of last saved slot', () => {
  const c = live([slotRec(0, 100, 100), slotRec(1, 100, 100)], at(10, 30));
  assert.equal(c.efficiency, 100); // the % is still known…
  assert.equal(c.missedSlot, true);
  assert.equal(c.liveStatus, 'noEntry'); // …but the line needs attention
  assert.equal(c.noEntrySince, '09:00');
  assert.equal(c.slots[2].state, 'missing');
});

test('S8. nothing saved → noEntry since production start', () => {
  assert.equal(live([], at(9, 30)).noEntrySince, '07:00');
  assert.equal(live([], at(9, 30)).liveStatus, 'noEntry');
  // Started late at 09:15: slots before it don't exist, none has ended yet.
  const late = live([], at(9, 30), session('L1', { productionStartMinutesAbs: 9 * 60 + 15 }));
  assert.equal(late.missedSlot, false);
  assert.equal(late.liveStatus, 'noEntry');
  assert.equal(late.noEntrySince, '09:15');
  assert.equal(late.slots[0].state, 'current');
});

test('S9. a deleted slot card is never "missing"', () => {
  const c = live([slotRec(0, 100, 100), slotRec(1, 100, 100)], at(10, 30), session('L1', { deletedSlotIndices: [2] }));
  assert.equal(c.missedSlot, false);
  assert.equal(c.liveStatus, 'excellent');
});

test('S10. Shift B after midnight uses the same production day', () => {
  const s = session('L1', { shift: 'B' });
  const b = (i: number) => slotRec(i, 100, 100, { shift: 'B', id: `b${i}` });
  // 19–20 … 23–24 saved (slots 0–4); 00–01 (slot 5) ended at 01:00.
  const c = live([0, 1, 2, 3, 4].map(b), at(25, 10), s);
  assert.equal(c.missedSlot, true);
  assert.equal(c.noEntrySince, '00:00');
  const ok = live([0, 1, 2, 3, 4, 5].map(b), at(25, 10), s);
  assert.equal(ok.liveStatus, 'excellent');
});

test('S11. rejection %, last entry, model and supervisor', () => {
  const c = live(
    [
      slotRec(0, 95, 100, { rejections: 5, updatedAtMs: 100, partName: 'Old', supervisorName: 'A' }),
      slotRec(1, 90, 100, { rejections: 0, updatedAtMs: 200, partName: 'DHL-RH', supervisorName: 'Ravi', lossReasonLabel: 'Material' }),
    ],
    at(9, 10)
  );
  assert.equal(c.rejections, 5);
  assert.equal(c.rejectionPct, 2.6); // 5 / (185 + 5)
  assert.equal(c.lastEntryAtMs, 200);
  assert.equal(c.partName, 'DHL-RH');
  assert.equal(c.supervisorName, 'Ravi');
  assert.deepEqual(c.lossReasons, ['Material']);
});

test('S12. grouping: no entry first, then lowest %; on track by % ascending', () => {
  const lines = ['A', 'B', 'C', 'D', 'E', 'F'].map((id) => line(id));
  const sessions = ['A', 'B', 'C', 'D', 'E'].map((id) => session(id));
  const records = [rec('A', 60, 100), rec('B', 40, 100), rec('D', 95, 100), rec('E', 80, 100)];
  const g = groupLiveLines(buildLiveLines(lines, sessions, records, 0));
  assert.deepEqual(g.needsAttention.map((l) => l.lineId), ['C', 'B', 'A']);
  assert.deepEqual(g.onTrack.map((l) => l.lineId), ['E', 'D']);
  assert.deepEqual(g.notRunning.map((l) => l.lineId), ['F']);
});

test('S13. plant summary is Σactual / Σtarget across running lines', () => {
  const lines = ['A', 'B', 'C'].map((id) => line(id));
  const all = buildLiveLines(lines, [session('A'), session('B')], [rec('A', 95, 100), rec('B', 10, 200)], 0);
  const p = plantSummary(all);
  assert.equal(p.efficiency, 35); // 105 / 300, not the 52.5 average
  assert.equal(p.okLines, 1);
  assert.equal(p.activeLines, 2);
  assert.equal(p.notRunning, 1);
  assert.equal(p.status, 'poor');
});

test('S14. downtime reasons: each stop once, running stop up to now', () => {
  const r = downtimeReasonsOf(
    {
      '0': [{ id: 'x', reason: 'power cut', startAbs: 0, endAbs: 600000, running: false, durationMinutes: 10 } as any],
      '1': [
        { id: 'x', reason: 'power cut', startAbs: 0, endAbs: 600000, running: false, durationMinutes: 10 } as any,
        { reason: 'maintenance', startAbs: 0, running: true },
      ],
    },
    30 * 60000
  );
  assert.deepEqual(r, [{ reason: 'Maintenance', minutes: 30 }, { reason: 'Power Cut', minutes: 10 }]);
});

test('S15. last saved slot: latest window and its quantity (changeover halves summed)', () => {
  assert.equal(lastSavedSlot(live([], at(9, 30)).slots), null);
  const c = live(
    [
      slotRec(0, 100, 100),
      slotRec(2, 40, 50, { partSegment: 'before' }),
      slotRec(2, 70, 72, { partSegment: 'after' }),
    ],
    at(10, 30)
  );
  assert.deepEqual(lastSavedSlot(c.slots), { label: '09:00–10:00', pcs: 110 });
});

test('S16. supervisor: current (handover) → latest slot saver → session starter', () => {
  const recs = [slotRec(0, 100, 100, { supervisorName: 'Ravi', updatedAtMs: 50 })];
  const s = (over: Partial<LiveSession>) => live(recs, at(8, 10), session('L1', over)).supervisorName;
  assert.equal(s({ supervisorName: 'Amit', currentSupervisorName: 'Sunil' }), 'Sunil');
  assert.equal(s({ supervisorName: 'Amit' }), 'Ravi');
  assert.equal(live([], at(8, 10), session('L1', { supervisorName: 'Amit' })).supervisorName, 'Amit');
  assert.equal(live([], at(8, 10)).supervisorName, null);
});

test('C1. capsule %: 1 decimal under 100, whole number from 100', () => {
  assert.equal(formatCapsulePct(64.6), '64.6%');
  assert.equal(formatCapsulePct(29), '29.0%');
  assert.equal(formatCapsulePct(99.9), '99.9%');
  assert.equal(formatCapsulePct(99.96), '100%'); // rounds into the ≥100 rule
  assert.equal(formatCapsulePct(100), '100%');
  assert.equal(formatCapsulePct(105.4), '105%');
  assert.equal(formatCapsulePct(null), '—');
});

test('C2. capsule counts: separators below 10,000, compact from 10,000', () => {
  assert.equal(formatCapsuleCount(250), '250');
  assert.equal(formatCapsuleCount(1440), '1,440');
  assert.equal(formatCapsuleCount(9999), '9,999');
  assert.equal(formatCapsuleCount(12400), '12.4k');
  assert.equal(formatCapsuleCount(15000), '15k');
  assert.equal(formatCapsuleCount(999_960), '1M');
  assert.equal(formatCapsuleCount(1_234_000), '1.2M');
});

test('C3. capsule figures', () => {
  assert.equal(capsuleFigures({ status: 'running', actual: 1440, planned: 1440 }), '1,440 / 1,440');
  assert.equal(capsuleFigures({ status: 'running', actual: 12400, planned: 15000 }), '12.4k / 15k');
  assert.equal(capsuleFigures({ status: 'running', actual: 250, planned: 0 }), '250 / —');
  assert.equal(capsuleFigures({ status: 'running', actual: 0, planned: 0 }), '— / —');
  assert.equal(capsuleFigures({ status: 'not_running', actual: 5, planned: 5 }), '— / —');
});

console.log(`\n${passed} passed`);
