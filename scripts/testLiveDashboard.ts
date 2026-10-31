// scripts/testLiveDashboard.ts
//
// Checks for src/utils/liveDashboard.ts (the web Live Dashboard's figures).
// Plain node:assert script like the project's other checks:
//   npx tsx scripts/testLiveDashboard.ts

import assert from 'node:assert/strict';
import {
  buildWeekSummary, dashboardDays, daySeries, groupQty, liveLines, mondayOf, productionBreakdown, toRejectionEntry, reasonLabel, rejectionTypes, rejectionsPerDay, stoppedLines, toDashboardRecord, toRunningRecord, DashboardRecord,
} from '../src/utils/liveDashboard';
import { counterQuality } from '../src/utils/qualityMetrics';
import { filledSlotIndices } from '../src/utils/liveDashboard';
import { parseRunningSession } from '../src/utils/supervisorHandover';

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.error(e);
  }
}

const TODAY = '2026-10-30';
const rec = (id: string, date: string, produced: number, expected: number, extra: Partial<DashboardRecord> = {}): DashboardRecord => ({
  id, lineId: 'L1', shift: 'A', productionDate: date, producedThisSlot: produced, expectedParts: expected,
  lossParts: null, rejections: 0, stopEvents: null, ...extra,
});
const empty = { activeSessions: [], endedSessions: [], shiftSummaries: [] };

test('dashboardDays: 7 production dates, oldest first, today last', () => {
  assert.deepEqual(dashboardDays(TODAY), ['2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30']);
});

test('toDashboardRecord: legacy record without productionDate is placed by createdAt', () => {
  const ms = Date.UTC(2026, 9, 29, 6, 0); // 29 Oct 11:30 IST
  const r = toDashboardRecord('x', { shift: 'A', producedThisSlot: 5 }, ms);
  assert.equal(r.productionDate, '2026-10-29');
  assert.equal(r.rejections, null);
});

test('per-day figures follow the Admin Overview formulas', () => {
  const w = buildWeekSummary({
    todayKey: TODAY, nowMs: Date.now(), ...empty,
    records: [
      rec('a', TODAY, 90, 100, { rejections: 2 }),
      rec('b', TODAY, 50, 40, { rejections: 1 }),
      rec('c', TODAY, 10, 30, { lossParts: 15, rejections: 0 }),
      rec('d', '2026-10-28', 200, 200, { rejections: 4 }),
      rec('e', '2026-10-01', 999, 999), // outside the window
    ],
  });
  const today = w.days[6];
  assert.equal(today.isToday, true);
  assert.equal(today.goodProduction, 150);
  assert.equal(today.plan, 170);
  assert.equal(today.achievementPct, 88.2);
  assert.equal(today.lossParts, 10 + 0 + 15); // lossParts wins over expected − produced
  const q = counterQuality([{ producedThisSlot: 90, rejections: 2 }, { producedThisSlot: 50, rejections: 1 }, { producedThisSlot: 10, rejections: 0 }]);
  assert.equal(today.rejectedParts, q.rejectedParts);
  assert.equal(today.rejectionPct, q.rejectionPct);
  assert.equal(w.days[4].goodProduction, 200);
  assert.equal(w.days[0].recordCount, 0);
  assert.equal(w.days[0].achievementPct, null);
  assert.equal(w.totals.goodProduction, 350);
  assert.equal(w.totals.recordCount, 4);
});

test('legacy-only day: rejections unknown, not zero', () => {
  const w = buildWeekSummary({ todayKey: TODAY, nowMs: Date.now(), ...empty, records: [rec('a', TODAY, 10, 10, { rejections: null })] });
  assert.equal(w.days[6].rejectedParts, null);
  assert.equal(w.days[6].qualityPct, null);
});

test('downtime: record stop-event shares per day and by reason', () => {
  // Each record holds its slot's SHARE of a stop (utils/downtime), so two
  // slots covered by one stop add up to the whole stop.
  const w = buildWeekSummary({
    todayKey: TODAY, nowMs: Date.now(), ...empty,
    records: [
      rec('a', TODAY, 10, 10, { stopEvents: [{ stopId: 's1', reason: 'maintenance', durationMinutes: 12 }] }),
      rec('b', TODAY, 10, 10, { stopEvents: [{ stopId: 's1', reason: 'maintenance', durationMinutes: 12 }] }),
      rec('c', '2026-10-29', 10, 10, { stopEvents: [{ stopId: 's2', reason: 'material shortage', durationMinutes: 30 }] }),
    ],
  });
  assert.equal(w.days[6].downtimeMinutes, 24);
  assert.equal(w.days[5].downtimeMinutes, 30);
  assert.equal(w.totals.downtimeMinutes, 54);
  assert.deepEqual(w.downtimeReasons.map((r) => [r.label, r.minutes]), [['Material Shortage', 30], ['Maintenance', 24]]);
});

test('downtime: a stop held by a live session is not double counted from records', () => {
  const start = Date.UTC(2026, 9, 30, 4, 0);
  const w = buildWeekSummary({
    todayKey: TODAY, nowMs: start + 60 * 60_000, endedSessions: [], shiftSummaries: [],
    records: [rec('a', TODAY, 10, 10, { stopEvents: [{ stopId: `stop-${start}`, reason: 'maintenance', startAbs: start, durationMinutes: 20 }] })],
    activeSessions: [{ lineId: 'L1', productionDate: TODAY, shift: 'A', stopsBySlot: { 0: [{ startAbs: start, endAbs: start + 20 * 60_000, durationMinutes: 20, reason: 'maintenance' }] } }],
  });
  assert.equal(w.days[6].downtimeMinutes, 20);
});

test('downtime: a running stop on a live session counts up to now', () => {
  const start = Date.UTC(2026, 9, 30, 4, 0);
  const w = buildWeekSummary({
    todayKey: TODAY, nowMs: start + 10 * 60_000, records: [], endedSessions: [], shiftSummaries: [],
    activeSessions: [{ lineId: 'L1', productionDate: TODAY, shift: 'A', stopsBySlot: { 0: [{ startAbs: start, reason: 'quality', running: true }] } }],
  });
  assert.equal(w.runningStops, 1);
  assert.equal(w.days[6].downtimeMinutes, 10);
  assert.deepEqual(w.downtimeReasons.map((r) => [r.label, r.minutes]), [['Quality', 10]]);
});

test('reasonLabel', () => {
  assert.equal(reasonLabel('gauge/fixture maintenance'), 'Gauge/Fixture Maintenance');
  assert.equal(reasonLabel(''), 'Unspecified');
  assert.equal(reasonLabel(null), 'Unspecified');
});

test('mondayOf: Monday of the calendar week', () => {
  assert.equal(mondayOf('2026-10-30'), '2026-10-26'); // Friday → Monday
  assert.equal(mondayOf('2026-10-26'), '2026-10-26'); // Monday itself
  assert.equal(mondayOf('2026-11-01'), '2026-10-26'); // Sunday → previous Monday
});

test('calendarWeek: Monday → Sunday, future days empty, totals from Monday to today', () => {
  const w = buildWeekSummary({
    todayKey: TODAY, nowMs: Date.now(), ...empty,
    records: [
      rec('a', '2026-10-25', 500, 500), // Sunday of the previous week — not in this week
      rec('b', '2026-10-26', 90, 100),  // Monday
      rec('c', TODAY, 45, 60),          // Friday (today)
    ],
  });
  const cw = w.calendarWeek;
  assert.deepEqual(cw.days.map((d) => d.productionDate), ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01']);
  assert.equal(cw.days[0].goodProduction, 90);
  assert.equal(cw.days[1].goodProduction, 0);
  assert.equal(cw.days[4].isToday, true);
  assert.equal(cw.days[5].isFuture, true);
  assert.equal(cw.days[5].plan, null);
  assert.equal(cw.totals.goodProduction, 135);
  assert.equal(cw.totals.plan, 160);
  assert.equal(cw.totals.achievementPct, 84.4);
});

test('stoppedLines: only lineStopped sessions, reason + start from currentStop, longest first', () => {
  const { stopped, activeCount } = stoppedLines([
    { id: 'L1', data: { lineName: 'Line 1', lineStopped: true, shift: 'A', plant: 'Bawal 1', stopsBySlot: { 2: [{ reason: 'material shortage', startAbs: 2000, running: true }] } } },
    { id: 'L2', data: { lineName: 'Line 2', lineStopped: false, stopsBySlot: {} } },
    { id: 'L3', data: { lineName: 'Line 3', lineStopped: true, stopsBySlot: { 0: [{ reason: 'maintenance', startAbs: 1000, running: true }] } } },
    { id: 'L4', data: { lineStopped: true, stopsBySlot: {} } },
  ]);
  assert.equal(activeCount, 4);
  assert.deepEqual(stopped.map((s) => s.lineName), ['Line 3', 'Line 1', 'L4']);
  assert.equal(stopped[1].reason, 'Material Shortage');
  assert.equal(stopped[1].sinceMs, 2000);
  assert.equal(stopped[2].reason, null);
});

test('rejectionTypes: Σ rejectionQty per defect and per stage, high → low', () => {
  const r = rejectionTypes([
    { data: { defect: 'Bush Miss', stage: 'Process', rejectionQty: 3 } },
    { data: { defect: 'Plating NG', stage: 'Visual', rejectionQty: 5 } },
    { data: { defect: 'Bush Miss', stage: 'Process', rejectionQty: 4 } },
    { data: { defect: '', stage: null, rejectionQty: 1 } },
  ]);
  assert.equal(r.total, 13);
  assert.deepEqual(r.types.map((t) => [t.defect, t.qty, t.count]), [['Bush Miss', 7, 2], ['Plating NG', 5, 1], ['Unspecified', 1, 1]]);
  assert.deepEqual(r.stages, [{ stage: 'Process', qty: 7 }, { stage: 'Visual', qty: 5 }, { stage: 'Unspecified', qty: 1 }]);
});

test('rejectionsPerDay: Σ rejectionQty per date; later dates fold into today, older ones drop', () => {
  const days = dashboardDays(TODAY);
  const r = rejectionsPerDay([
    { data: { date: TODAY, rejectionQty: 3 } },
    { data: { date: TODAY, rejectionQty: 2 } },
    { data: { date: '2026-10-28', rejectionQty: 4 } },
    { data: { date: '2026-10-31', rejectionQty: 1 } },
    { data: { date: '2026-10-01', rejectionQty: 9 } },
    { data: { rejectionQty: 7 } },
  ], days);
  assert.equal(r.length, 7);
  assert.deepEqual(r[6], { date: TODAY, qty: 6, count: 3 });
  assert.deepEqual(r[4], { date: '2026-10-28', qty: 4, count: 1 });
  assert.equal(r.reduce((n, d) => n + d.qty, 0), 10);
});

test('productionBreakdown: per line / per shift with the card formulas; stops-only groups kept', () => {
  const records = [
    rec('a', TODAY, 90, 100, { rejections: 2 }),
    rec('b', TODAY, 60, 50, { lineId: 'L2', shift: 'B' }),
    rec('c', TODAY, 10, 30, { shift: 'B' }),
  ];
  const intervals = [
    { sessionKey: 'L3|x|A', lineId: 'L3', productionDate: TODAY, shift: 'A', stopId: 's1', reason: 'power', minutes: 12, running: false, source: 'summary' as const },
  ];
  const lines = productionBreakdown(records, intervals, 'line');
  assert.deepEqual(lines.map((r) => [r.key, r.goodProduction, r.plan, r.lossParts]), [['L1', 100, 130, 30], ['L2', 60, 50, 0], ['L3', 0, 0, 0]]);
  assert.equal(lines[0].achievementPct, 76.9);
  assert.equal(lines[2].downtimeMinutes, 12);
  const shifts = productionBreakdown(records, intervals, 'shift');
  assert.deepEqual(shifts.map((r) => [r.key, r.goodProduction, r.downtimeMinutes]), [['A', 90, 12], ['B', 70, 0]]);
});

test('daySeries: one line\'s days match buildWeekSummary for that line alone', () => {
  const records = [rec('a', TODAY, 90, 100), rec('b', '2026-10-28', 40, 50), rec('c', TODAY, 999, 999, { lineId: 'L2' })];
  const own = records.filter((r) => r.lineId === 'L1');
  const series = daySeries(dashboardDays(TODAY), TODAY, own, []);
  const w = buildWeekSummary({ todayKey: TODAY, nowMs: Date.now(), ...empty, records: own });
  assert.deepEqual(series, w.days);
  assert.equal(w.records.length, 2);
});

test('groupQty + toRejectionEntry: Record Rejection entries grouped high → low', () => {
  const entries = [
    { defect: ' Bush Miss ', rejectionQty: 3, lineId: 'L1', shift: 'A', reportedBy: { name: 'QI' } },
    { defect: 'Plating NG', rejectionQty: 5, lineId: 'L2' },
    { defect: 'Bush Miss', rejectionQty: 4, lineId: 'L1' },
    { rejectionQty: 'x' },
  ].map(toRejectionEntry);
  assert.equal(entries[0].defect, 'Bush Miss');
  assert.equal(entries[0].reportedBy, 'QI');
  assert.equal(entries[3].defect, 'Unspecified');
  assert.equal(entries[3].qty, 0);
  assert.deepEqual(groupQty(entries, (e) => e.defect, (e) => e.qty), [
    { key: 'Bush Miss', qty: 7, count: 2 }, { key: 'Plating NG', qty: 5, count: 1 }, { key: 'Unspecified', qty: 0, count: 1 },
  ]);
  assert.deepEqual(groupQty(entries, (e) => e.lineId ?? '—', (e) => e.qty).map((r) => r.key), ['L1', 'L2', '—']);
});

test('liveLines: Running Lines cards + slot output, stop, session downtime', () => {
  // Shift A on 30 Oct, slots 0 and 1 saved; "now" is 10:30 IST, so slot 2
  // (09–10) has ended unsaved (awaiting) and slot 3 (10–11) is current.
  const nowMs = Date.UTC(2026, 9, 30, 5, 0); // 10:30 IST
  const session = {
    id: 'L1',
    data: {
      lineId: 'L1', lineName: 'Line 1', plant: 'Bawal 1', shift: 'A', productionDate: TODAY, plannedProductionTotal: 800,
      selectedPartIndex: 0, savedSlotIndices: [0, 1], lineStopped: true,
      stopsBySlot: { 3: [{ reason: 'maintenance', startAbs: nowMs - 5 * 60_000, running: true }] },
    },
  };
  const records = [
    toRunningRecord('r0', { lineId: 'L1', shift: 'A', productionDate: TODAY, slotIndex: 0, expectedParts: 100, producedThisSlot: 90, rejections: 1, partName: 'Hinge' }),
    toRunningRecord('r1', { lineId: 'L1', shift: 'A', productionDate: TODAY, slotIndex: 1, expectedParts: 100, producedThisSlot: 105, rejections: 0, partName: 'Hinge' }),
    toRunningRecord('x', { lineId: 'L2', shift: 'A', productionDate: TODAY, slotIndex: 0, expectedParts: 50, producedThisSlot: 50 }),
  ];
  const [line] = liveLines({
    sessions: [session], records, partsByLine: { L1: [{ name: 'Hinge LH' }] },
    downtimeBySession: new Map([['L1|2026-10-30|A', 17.5]]), nowMs,
  });
  assert.equal(line.card.actual, 195);
  assert.equal(line.card.planToDate, 200);
  assert.equal(line.card.variance, -5);
  assert.equal(line.card.rejections, 1);
  assert.equal(line.card.model, 'Hinge LH');
  assert.equal(line.card.status, 'stopped');
  assert.equal(line.achievementPct, 97.5);
  assert.equal(line.downtimeMinutes, 17.5);
  assert.equal(line.stop?.reason, 'Maintenance');
  const byIndex = new Map(line.slots.map((s) => [s.index, s]));
  assert.equal(byIndex.get(0)?.state, 'completed');
  assert.equal(byIndex.get(0)?.produced, 90);
  assert.equal(byIndex.get(1)?.expected, 100);
  assert.equal(byIndex.get(0)?.hour, '07');
  assert.equal(byIndex.get(0)?.range, '7–8');
  assert.equal(line.slots[line.slots.length - 1].range, '15–15:30'); // Shift A ends at 15:30
  assert.ok(line.slots.some((s) => s.state === 'awaiting'));
  assert.ok(line.slots.some((s) => s.state === 'current'));
});

test('filledSlotIndices: a saved record fills the hour even when the session marker is missing', () => {
  const started = Date.UTC(2026, 9, 30, 1, 25); // 06:55 IST
  const s = parseRunningSession('L1', { lineId: 'L1', shift: 'A', productionDate: TODAY, startedAt: { toMillis: () => started }, savedSlotIndices: [0] });
  const at = (ms: number) => ({ toMillis: () => ms });
  const r = (id: string, slotIndex: number, extra: any = {}) =>
    toRunningRecord(id, { lineId: 'L1', shift: 'A', productionDate: TODAY, slotIndex, producedThisSlot: 100, expectedParts: 100, createdAt: at(started + 3_600_000), ...extra });
  const filled = filledSlotIndices(s, [
    r('a', 1),                                                     // record, no marker → filled
    r('b', 2, { createdAt: at(started - 3 * 3_600_000) }),         // earlier run of this line → ignored
    r('c', 3, { partSegment: 'before' }),                          // changeover slot, only one half → not filled
    r('d', 4, { partSegment: 'before' }), r('e', 4, { partSegment: 'after' }), // both halves → filled
    toRunningRecord('f', { lineId: 'L2', shift: 'A', productionDate: TODAY, slotIndex: 5, createdAt: at(started + 1) }), // other line
  ]);
  assert.deepEqual(filled, [0, 1, 4]); // 0 from the marker
});

test('liveLines: hours with saved records are not "awaiting entry" even without the marker', () => {
  const nowMs = Date.UTC(2026, 9, 30, 5, 0); // 10:30 IST → slots 0, 1, 2 have ended
  const started = Date.UTC(2026, 9, 30, 1, 25);
  const [line] = liveLines({
    sessions: [{ id: 'L1', data: { lineId: 'L1', shift: 'A', productionDate: TODAY, startedAt: { toMillis: () => started }, savedSlotIndices: [] } }],
    records: [0, 1, 2].map((i) => toRunningRecord(`r${i}`, {
      lineId: 'L1', shift: 'A', productionDate: TODAY, slotIndex: i, producedThisSlot: 90, expectedParts: 100, createdAt: { toMillis: () => started + (i + 1) * 3_600_000 },
    })),
    partsByLine: {}, downtimeBySession: new Map(), nowMs,
  });
  assert.equal(line.card.status, 'running');
  assert.deepEqual(line.slots.filter((s) => s.state === 'completed').map((s) => s.index), [0, 1, 2]);
  assert.equal(line.slots.filter((s) => s.state === 'awaiting').length, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
