// scripts/testWeldingSchedule.ts
//
// Bawal 1 → Welding schedule profile (src/utils/productionSchedule.ts) and
// its workshop wiring: slots, lunch, tea breaks, OT rules, targets, start
// windows, Shift B's production date, divisions — and that Assembly's
// schedule is exactly what it was before profiles existed.
//   npm run test:welding

import assert from 'node:assert/strict';
import {
  ASSEMBLY_SCHEDULE,
  WELDING_SCHEDULE,
  buildSlots,
  expectedPartsFor,
  placeChangeoverTime,
  scheduleProfileFor,
  scheduledNonProductive,
  shiftForStartTime,
  timeOfDayToShiftAbs,
  validateChangeoverInterval,
  validateProductionStartTime,
  validateShiftStartWindow,
  ScheduleSlot,
} from '../src/utils/productionSchedule';
import { millisToProductionDayMinute, productionDayKeyFor } from '../src/utils/productionDay';
import { DIVISIONS, WELDING_DIVISIONS, divisionsForWorkshop, workshopHasDivisions } from '../src/constants/lineOptions';
import { slotEntryStatuses } from '../src/utils/supervisorHandover';

const t = (h: number, m = 0) => h * 60 + m;
const W = WELDING_SCHEDULE;
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
const summary = (slots: ScheduleSlot[]) =>
  slots.map((s) => [s.startMinutesAbs, s.endMinutesAbs, s.productiveMinutes, s.isBreak] as const);

console.log('Assembly unchanged');

test('default profile and explicit ASSEMBLY_SCHEDULE build identical slots', () => {
  for (const sh of ['A', 'B'] as const) {
    for (const ot of [0, 1, 2, 3, 4]) {
      assert.deepEqual(buildSlots(sh, ot, [], null, ASSEMBLY_SCHEDULE), buildSlots(sh, ot), `${sh} ot${ot}`);
    }
  }
});

test('Assembly Shift A keeps 7:00–3:30, lunch 12:15–12:45', () => {
  assert.deepEqual(buildSlots('A', 0).map((s) => s.productiveMinutes), [50, 60, 50, 60, 75, 0, 75, 50, 30]);
  const lunch = buildSlots('A', 0).find((s) => s.isBreak)!;
  assert.deepEqual([lunch.startMinutesAbs, lunch.endMinutesAbs], [t(12, 15), t(12, 45)]);
});

test('lines of other plants / workshops resolve to Assembly', () => {
  assert.equal(scheduleProfileFor({ plant: 'Bawal 1', workshop: 'Assembly Shop' }), ASSEMBLY_SCHEDULE);
  assert.equal(scheduleProfileFor({ plant: 'Bawal 2', workshop: 'Welding Shop' }), ASSEMBLY_SCHEDULE);
  assert.equal(scheduleProfileFor({ plant: 'Bawal 1', workshop: 'Press Shop' }), ASSEMBLY_SCHEDULE);
  assert.equal(scheduleProfileFor({ plant: null, workshop: null }), ASSEMBLY_SCHEDULE);
  assert.equal(scheduleProfileFor(null), ASSEMBLY_SCHEDULE);
});

test('Bawal 1 → Welding resolves to the Welding profile (label variants)', () => {
  assert.equal(scheduleProfileFor({ plant: 'Bawal 1', workshop: 'Welding Shop' }), W);
  assert.equal(scheduleProfileFor({ plant: 'Bawal - 1', workshop: 'Welding' }), W);
  assert.equal(scheduleProfileFor({ plant: 'bawal1', workshop: 'WELDING SHOP' }), W);
});

console.log('Welding Shift A');

test('slots 7–8, 8–9, 9–10, 10–11:15, lunch, 11:45–1, 1–2, 2–3, 3–4, 4–5', () => {
  const s = buildSlots('A', 0, [], null, W);
  assert.deepEqual(s.map((x) => [x.startMinutesAbs, x.endMinutesAbs, x.durationMinutes]), [
    [t(7), t(8), 60], [t(8), t(9), 60], [t(9), t(10), 60], [t(10), t(11, 15), 75],
    [t(11, 15), t(11, 45), 30],
    [t(11, 45), t(13), 75], [t(13), t(14), 60], [t(14), t(15), 60], [t(15), t(16), 60], [t(16), t(17), 60],
  ]);
  assert.equal(s.filter((x) => !x.isBreak).length, 9);
});

test('lunch 11:15–11:45 is a break card with 0 productive minutes', () => {
  const lunch = buildSlots('A', 0, [], null, W).filter((x) => x.isBreak);
  assert.equal(lunch.length, 1);
  assert.deepEqual([lunch[0].startMinutesAbs, lunch[0].endMinutesAbs, lunch[0].productiveMinutes], [t(11, 15), t(11, 45), 0]);
});

test('tea 9:30 and 2:00, startup reserve 7:00: 50 min in 7–8, 9–10, 2–3', () => {
  const s = buildSlots('A', 0, [], null, W).filter((x) => !x.isBreak);
  assert.deepEqual(s.map((x) => x.productiveMinutes), [50, 60, 50, 75, 75, 60, 50, 60, 60]);
  const np = scheduledNonProductive('A', 0, W);
  for (const iv of [{ start: t(9, 30), end: t(9, 40) }, { start: t(14), end: t(14, 10) }, { start: t(7), end: t(7, 10) }]) {
    assert.ok(np.some((b) => b.start === iv.start && b.end === iv.end));
  }
});

test('OT 1–2 h: 5–6 PM is a full 60 (50-minute rule not applied)', () => {
  for (const ot of [1, 2]) {
    const five = buildSlots('A', ot, [], null, W).find((x) => x.hourStartAbs === t(17))!;
    assert.equal(five.productiveMinutes, 60, `ot ${ot}`);
  }
});

test('OT ≥ 3 h: 5–6 PM is held at 50; normal hours unaffected', () => {
  for (const ot of [3, 4]) {
    const s = buildSlots('A', ot, [], null, W);
    assert.equal(s.find((x) => x.hourStartAbs === t(17))!.productiveMinutes, 50, `ot ${ot}`);
    assert.deepEqual(s.filter((x) => !x.isBreak && x.hourStartAbs < t(17)).map((x) => x.productiveMinutes), [50, 60, 50, 75, 75, 60, 50, 60, 60]);
  }
});

console.log('Welding Shift B');

test('slots 5–6 PM … 8–9:15, lunch 9:15–9:45, 9:45–11 … 2–3 AM', () => {
  const s = buildSlots('B', 0, [], null, W);
  assert.deepEqual(s.map((x) => [x.startMinutesAbs, x.endMinutesAbs, x.durationMinutes]), [
    [t(17), t(18), 60], [t(18), t(19), 60], [t(19), t(20), 60], [t(20), t(21, 15), 75],
    [t(21, 15), t(21, 45), 30],
    [t(21, 45), t(23), 75], [t(23), t(24), 60], [t(24), t(25), 60], [t(25), t(26), 60], [t(26), t(27), 60],
  ]);
  assert.ok(s[4].isBreak);
});

test('tea 1:30 AM and startup reserve: 50 in 5–6 PM and 1–2 AM; no OT tea without OT', () => {
  const s = buildSlots('B', 0, [], null, W).filter((x) => !x.isBreak);
  assert.deepEqual(s.map((x) => x.productiveMinutes), [50, 60, 60, 75, 75, 60, 60, 50, 60]);
  assert.ok(!scheduledNonProductive('B', 0, W).some((b) => b.start === t(28, 30)));
  assert.ok(!buildSlots('B', 0, [], null, W).some((x) => x.hourStartAbs >= t(27)));
});

test('OT tea 4:30–4:40 AM only with overtime', () => {
  assert.ok(scheduledNonProductive('B', 1, W).some((b) => b.start === t(28, 30) && b.end === t(28, 40)));
  const ot2 = buildSlots('B', 2, [], null, W);
  assert.equal(ot2.find((x) => x.hourStartAbs === t(27))!.productiveMinutes, 60); // 3–4 AM
  assert.equal(ot2.find((x) => x.hourStartAbs === t(28))!.productiveMinutes, 50); // 4–5 AM
});

console.log('Targets');

test('75-minute slots = hourly target × 1.25 (20 s cycle: 180 → 225)', () => {
  const s = buildSlots('A', 0, [], null, W);
  const hourly = expectedPartsFor(20, s.find((x) => x.hourStartAbs === t(8))!.productiveMinutes);
  assert.equal(hourly, 180);
  for (const x of s.filter((x) => x.productiveMinutes === 75)) assert.equal(expectedPartsFor(20, x.productiveMinutes), hourly * 1.25);
  const b = buildSlots('B', 0, [], null, W).filter((x) => x.productiveMinutes === 75);
  assert.equal(b.length, 2);
});

test('shift targets use available minutes only (A 540, B 550 at 0 OT)', () => {
  const sum = (sh: 'A' | 'B') => buildSlots(sh, 0, [], null, W).reduce((n, x) => n + x.productiveMinutes, 0);
  assert.equal(sum('A'), 540); // 600 − 30 lunch − 2×10 tea − 10 startup
  assert.equal(sum('B'), 550); // 600 − 30 lunch − 10 tea − 10 startup
  assert.equal(buildSlots('A', 0, [], null, W).filter((x) => x.isBreak).reduce((n, x) => n + expectedPartsFor(20, x.productiveMinutes), 0), 0);
});

console.log('Changeovers and lunch');

test('Shift A: changeover inside 11:15–11:45 is rejected; 11:45 accepted', () => {
  const slots = buildSlots('A', 0, [], null, W);
  const lunch = W.shifts.A.lunch;
  const err = validateChangeoverInterval({ interval: { start: t(11, 20), end: t(11, 20) }, slots, otherIntervals: [], allowInstant: true, lunch });
  assert.match(err ?? '', /lunch break \(11:15 AM – 11:45 AM\)/);
  assert.equal(placeChangeoverTime(t(11, 45), slots, [], lunch).ok, true);
  assert.equal(placeChangeoverTime(t(12, 20), slots, [], lunch).ok, true); // Assembly's lunch is not Welding's
});

test('Shift B: changeover inside 9:15–9:45 PM is rejected', () => {
  const slots = buildSlots('B', 0, [], null, W);
  const lunch = W.shifts.B.lunch;
  const at = timeOfDayToShiftAbs(t(21, 30), 'B');
  const r = placeChangeoverTime(at, slots, [], lunch);
  assert.equal(r.ok, false);
  assert.match(r.ok ? '' : r.error, /09:15 PM – 09:45 PM/);
  assert.equal(placeChangeoverTime(timeOfDayToShiftAbs(t(1, 5), 'B'), slots, [], lunch).ok, true);
});

console.log('Start windows and production date');

test('start windows: A 07:00–17:00, B 17:00–06:30', () => {
  assert.equal(shiftForStartTime(t(16, 59), W), 'A');
  assert.equal(shiftForStartTime(t(17), W), 'B');
  assert.equal(shiftForStartTime(t(2), W), 'B');
  assert.equal(shiftForStartTime(t(6, 45), W), null);
  assert.equal(validateShiftStartWindow('B', t(17, 30), W), null);
  assert.notEqual(validateShiftStartWindow('B', t(17, 30)), null); // Assembly B still from 19:00
});

test('production start must lie inside the Welding shift', () => {
  assert.deepEqual(validateProductionStartTime('17:00', 'B', 0, null, W), { ok: true, startAbs: t(17) });
  assert.equal(validateProductionStartTime('03:00', 'B', 0, null, W).ok, false);
  assert.equal(validateProductionStartTime('03:00', 'B', 1, null, W).ok, true);
  assert.equal(validateProductionStartTime('16:30', 'A', 0, null, W).ok, true);
  assert.equal(validateProductionStartTime('17:00', 'A', 0, null, W).ok, false);
});

test('Shift B after-midnight slots keep the evening production date', () => {
  const start = new Date(2026, 10, 21, 17, 5).getTime();
  const pd = productionDayKeyFor(start);
  assert.equal(pd, '2026-11-21');
  for (const [h, m] of [[23, 30], [0, 30], [1, 35], [2, 59]] as const) {
    const ms = new Date(2026, 10, h < 12 ? 22 : 21, h, m).getTime();
    assert.equal(productionDayKeyFor(ms), pd, `${h}:${m}`);
  }
  // 1:35 AM is in slot 8 (1–2 AM) of that night's frame.
  const nowAbs = millisToProductionDayMinute(pd, new Date(2026, 10, 22, 1, 35).getTime());
  const slot = buildSlots('B', 0, [], t(17, 5), W).find((s) => nowAbs >= s.startMinutesAbs && nowAbs < s.endMinutesAbs)!;
  assert.equal(slot.index, 8);
});

test('supervisor slot status uses the session workshop schedule', () => {
  const session = {
    shift: 'B' as const, otHours: 0, changeovers: [], productionStartAbs: t(17),
    savedSlotIndices: [0], deletedSlotIndices: [], plant: 'Bawal 1', workshop: 'Welding Shop',
  };
  const st = slotEntryStatuses(session, t(17, 30) + 60);   // 6:30 PM
  assert.equal(st.current, 1);
  assert.deepEqual(st.completed, [0]);
  assert.ok(!(4 in st.bySlot)); // lunch is never an entry slot
});

console.log('Divisions');

test('Welding shows Div-1 … Div-5; Assembly keeps its sections', () => {
  assert.deepEqual(WELDING_DIVISIONS, ['Div-1', 'Div-2', 'Div-3', 'Div-4', 'Div-5']);
  assert.deepEqual(divisionsForWorkshop('Welding Shop'), WELDING_DIVISIONS);
  assert.deepEqual(divisionsForWorkshop('Assembly Shop'), DIVISIONS);
  assert.ok(workshopHasDivisions('Welding Shop') && workshopHasDivisions('Assembly Shop'));
  assert.ok(!workshopHasDivisions('Press Shop'));
});

test('summary snapshot of both Welding shifts', () => {
  assert.equal(summary(buildSlots('A', 0, [], null, W)).length, 10);
  assert.equal(summary(buildSlots('B', 0, [], null, W)).length, 10);
});

console.log(`\n${passed} checks passed`);
