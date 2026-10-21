// scripts/testProductionSchedule.ts
//
// Checks for the shared schedule / changeover rules in
// src/utils/productionSchedule.ts. The project has no test runner, so this
// is a plain node:assert script:  npm run test:schedule

import assert from 'node:assert/strict';
import {
  buildSlots,
  changeoverSegmentWindows,
  changeoverSegmentMinutes,
  fixedProductiveMinutesFor,
  formatTimeInput,
  isChangeoverAtSlotStart,
  parseTimeInput,
  placeChangeoverTime,
  timeOfDayToShiftAbs,
  expectedPartsFor,
  parseClockToShiftAbs,
  productiveMinutesIn,
  scheduledNonProductive,
  validateChangeoverInterval,
  validateProductionStartTime,
  LUNCH_CHANGEOVER_MESSAGE,
  TimeInterval,
} from '../src/utils/productionSchedule';

const t = (h: number, m = 0) => h * 60 + m;
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

const slotsA = buildSlots('A', 0);
const byHour = (h: number) => slotsA.find((s) => s.hourStartAbs === t(h))!;
const validate = (start: number, end: number, otherIntervals: TimeInterval[] = []) =>
  validateChangeoverInterval({ interval: { start, end }, slots: slotsA, otherIntervals });

console.log('Lunch schedule');
test('11–12 slot runs 11:00–12:15 with 75 productive minutes', () => {
  const s = byHour(11);
  assert.equal(s.startMinutesAbs, t(11));
  assert.equal(s.endMinutesAbs, t(12, 15));
  assert.equal(s.productiveMinutes, 75);
  assert.equal(s.label, '11:00 AM - 12:00 PM');
});
test('12–1 slot is the lunch interval with 0 productive minutes', () => {
  const s = byHour(12);
  assert.equal(s.isBreak, true);
  assert.equal(s.startMinutesAbs, t(12, 15));
  assert.equal(s.endMinutesAbs, t(12, 45));
  assert.equal(s.productiveMinutes, 0);
});
test('1–2 slot runs 12:45–2:00 with 75 productive minutes', () => {
  const s = byHour(13);
  assert.equal(s.startMinutesAbs, t(12, 45));
  assert.equal(s.endMinutesAbs, t(14));
  assert.equal(s.productiveMinutes, 75);
  assert.equal(s.label, '01:00 PM - 02:00 PM');
});
test('lunch never counts as productive time', () => {
  assert.equal(productiveMinutesIn(t(12, 15), t(12, 45), scheduledNonProductive('A', 0)), 0);
  assert.equal(productiveMinutesIn(t(12), t(13), scheduledNonProductive('A', 0)), 30);
});
test('20 s cycle time → 225 parts per 75-minute window', () => {
  assert.equal(expectedPartsFor(20, byHour(11).productiveMinutes), 225);
  assert.equal(expectedPartsFor(20, byHour(13).productiveMinutes), 225);
});
test('slot windows are contiguous and cover the whole shift once', () => {
  for (let i = 1; i < slotsA.length; i++) assert.equal(slotsA[i].startMinutesAbs, slotsA[i - 1].endMinutesAbs);
  assert.equal(slotsA[0].startMinutesAbs, t(7));
  assert.equal(slotsA[slotsA.length - 1].endMinutesAbs, t(15, 30));
});
test('other Shift A slots unchanged (startup reserve, tea breaks)', () => {
  assert.equal(byHour(7).productiveMinutes, 50); // 10 min startup reserve
  assert.equal(byHour(8).productiveMinutes, 60);
  assert.equal(byHour(9).productiveMinutes, 50); // 9:30–9:40 tea
  assert.equal(byHour(14).productiveMinutes, 50); // 2:00–2:10 tea
  assert.equal(byHour(15).productiveMinutes, 30); // 3:00–3:30 partial
  assert.equal(byHour(15).label, '03:00 PM - 03:30 PM (partial)');
});
test('Shift A with 2 h OT: 4–5 PM is a full 60-minute slot', () => {
  const ot = buildSlots('A', 2);
  assert.equal(ot.find((s) => s.hourStartAbs === t(16))!.productiveMinutes, 60);
});
test('Shift B is unaffected by lunch', () => {
  const b = buildSlots('B', 0);
  assert.equal(b.some((s) => s.isBreak), false);
  assert.equal(b[0].startMinutesAbs, t(19));
  assert.equal(b[0].productiveMinutes, 50);
  assert.equal(b[1].productiveMinutes, 60);
  assert.equal(b[b.length - 1].endMinutesAbs, t(27, 30));
});

console.log('Manual time parsing');
test('parses 12-hour times into shift minutes', () => {
  assert.equal(parseClockToShiftAbs('10:50', 'AM', 'A'), t(10, 50));
  assert.equal(parseClockToShiftAbs('12:05', 'PM', 'A'), t(12, 5));
  assert.equal(parseClockToShiftAbs('1:30', 'PM', 'A'), t(13, 30));
  assert.equal(parseClockToShiftAbs('2:15', 'AM', 'B'), t(26, 15)); // after midnight on Shift B
  assert.equal(parseClockToShiftAbs('9:00', 'PM', 'B'), t(21));
});
test('rejects invalid times', () => {
  for (const bad of ['', '25:00', '10:60', '0:30', 'ab:cd', '1030']) {
    assert.equal(parseClockToShiftAbs(bad, 'AM', 'A'), null, bad);
  }
});

console.log('Changeover validation');
test('changeover entirely before lunch is accepted', () => {
  assert.equal(validate(t(11, 30), t(11, 50)), null);
  assert.equal(validate(t(12), t(12, 15)), null); // ends exactly at lunch start — adjacent, not overlapping
});
test('changeover right after lunch is accepted', () => {
  assert.equal(validate(t(12, 45), t(13)), null);
});
test('changeover starting during lunch is rejected', () => {
  assert.equal(validate(t(12, 20), t(12, 50)), LUNCH_CHANGEOVER_MESSAGE);
  assert.equal(validate(t(12, 15), t(12, 30)), LUNCH_CHANGEOVER_MESSAGE);
});
test('changeover ending during lunch is rejected', () => {
  assert.equal(validate(t(12), t(12, 30)), LUNCH_CHANGEOVER_MESSAGE);
});
test('changeover spanning lunch is rejected', () => {
  assert.equal(validate(t(12, 5), t(12, 55)), LUNCH_CHANGEOVER_MESSAGE);
});
test('split around lunch as two intervals is accepted', () => {
  const first = { start: t(12, 5), end: t(12, 15) };
  const second = { start: t(12, 45), end: t(12, 55) };
  assert.equal(validate(first.start, first.end), null);
  assert.equal(validate(second.start, second.end, [first]), null);
});
test('end before/equal start is rejected', () => {
  assert.notEqual(validate(t(10, 30), t(10, 20)), null);
  assert.notEqual(validate(t(10, 30), t(10, 30)), null);
});
test('outside the shift is rejected', () => {
  assert.notEqual(validate(t(6, 30), t(7, 10)), null);
  assert.notEqual(validate(t(15, 20), t(15, 40)), null);
});
test('overlapping another changeover is rejected, adjacent is fine', () => {
  const other = { start: t(10), end: t(10, 20) };
  assert.notEqual(validate(t(10, 10), t(10, 30), [other]), null);
  assert.equal(validate(t(10, 20), t(10, 30), [other]), null);
});
test('legacy instant changeover inside lunch is rejected', () => {
  const r = validateChangeoverInterval({ interval: { start: t(12, 20), end: t(12, 20) }, slots: slotsA, otherIntervals: [], allowInstant: true });
  assert.equal(r, LUNCH_CHANGEOVER_MESSAGE);
});

console.log('Changeover minute allocation');
test('changeover inside one slot splits it without double counting', () => {
  const co = { start: t(10, 20), end: t(10, 35) };
  const slots = buildSlots('A', 0, [co]);
  const s = slots.find((x) => x.hourStartAbs === t(10))!;
  const np = [...scheduledNonProductive('A', 0), co];
  const { before, after } = changeoverSegmentWindows({ start: s.startMinutesAbs, end: s.endMinutesAbs }, co);
  const b = productiveMinutesIn(before.start, before.end, np);
  const a = productiveMinutesIn(after.start, after.end, np);
  assert.equal(b, 20);
  assert.equal(a, 25);
  assert.equal(b + a + 15, 60);
});
test('changeover crossing an hour boundary is allocated to both slots', () => {
  const co = { start: t(10, 50), end: t(11, 10) };
  const slots = buildSlots('A', 0, [co]);
  const ten = slots.find((x) => x.hourStartAbs === t(10))!;
  const eleven = slots.find((x) => x.hourStartAbs === t(11))!;
  const np = [...scheduledNonProductive('A', 0), co];
  const { before, after } = changeoverSegmentWindows({ start: ten.startMinutesAbs, end: ten.endMinutesAbs }, co);
  assert.equal(productiveMinutesIn(before.start, before.end, np), 50);
  assert.equal(productiveMinutesIn(after.start, after.end, np), 0); // runs past the slot end
  assert.equal(after.start, t(11));
  assert.equal(eleven.productiveMinutes, 65); // 75 − 10 spill-over minutes
  // 20 changeover minutes in total, taken out exactly once across both slots.
  const base = buildSlots('A', 0);
  const lost =
    base.reduce((sum, s) => sum + s.productiveMinutes, 0) -
    slots.filter((s) => s.hourStartAbs !== t(10)).reduce((sum, s) => sum + s.productiveMinutes, 0) -
    50;
  assert.equal(lost, 20);
});
test('changeover over a tea break is not double counted', () => {
  const co = { start: t(9, 25), end: t(9, 45) }; // covers the 9:30–9:40 tea break
  const np = [...scheduledNonProductive('A', 0), co];
  assert.equal(productiveMinutesIn(t(9), t(10), np), 40); // 60 − (9:25–9:45)
});

console.log('Fixed 50-minute slots');
const slotsA3 = buildSlots('A', 3); // 7:00 AM – 6:30 PM
const byHour3 = (h: number) => slotsA3.find((s) => s.hourStartAbs === t(h))!;
test('7–8, 9–10, 2–3 and 5–6 have 50 productive minutes on 60-minute boundaries', () => {
  for (const h of [7, 9, 14, 17]) {
    const s = byHour3(h);
    assert.equal(s.productiveMinutes, 50, `${h}:00`);
    assert.equal(s.durationMinutes, 60, `${h}:00`);
    assert.equal(s.endMinutesAbs - s.startMinutesAbs, 60, `${h}:00`);
  }
  assert.equal(byHour3(17).label, '05:00 PM - 06:00 PM');
});
test('only those four clock hours are fixed', () => {
  const fixed: number[] = [];
  for (let h = 0; h < 24; h++) if (fixedProductiveMinutesFor(t(h)) != null) fixed.push(h);
  assert.deepEqual(fixed, [7, 9, 14, 17]);
  assert.equal(fixedProductiveMinutesFor(t(31)), 50); // 7 AM on Shift B's +1440 frame
});
test('other slots keep their own durations (60 / 75 / 30 / partial)', () => {
  assert.equal(byHour3(8).productiveMinutes, 60);
  assert.equal(byHour3(10).productiveMinutes, 60);
  assert.equal(byHour3(11).productiveMinutes, 75);
  assert.equal(byHour3(13).productiveMinutes, 75);
  assert.equal(byHour3(15).productiveMinutes, 60);
  assert.equal(byHour3(16).productiveMinutes, 60); // no OT break
  assert.equal(byHour3(18).productiveMinutes, 30); // 6:00–6:30 partial
  assert.equal(buildSlots('A', 0).find((s) => s.hourStartAbs === t(15))!.productiveMinutes, 30);
});
test('partial 5–6 slot (2 h OT) keeps its partial time', () => {
  const s = buildSlots('A', 2).find((x) => x.hourStartAbs === t(17))!;
  assert.equal(s.durationMinutes, 30);
  assert.equal(s.productiveMinutes, 30);
});
test('targets at 20 s cycle: 50→150, 60→180, 75→225, 30→90', () => {
  assert.equal(expectedPartsFor(20, byHour3(17).productiveMinutes), 150);
  assert.equal(expectedPartsFor(20, byHour3(7).productiveMinutes), 150);
  assert.equal(expectedPartsFor(20, byHour3(8).productiveMinutes), 180);
  assert.equal(expectedPartsFor(20, byHour3(11).productiveMinutes), 225);
  assert.equal(expectedPartsFor(20, byHour3(18).productiveMinutes), 90);
  assert.equal(expectedPartsFor(7, 50), 428); // rounds down
});
test('tea break in 9–10 is not subtracted twice', () => {
  assert.equal(byHour3(9).productiveMinutes, 50);
  const co = { start: t(9, 45), end: t(9, 55) };
  assert.equal(buildSlots('A', 3, [co]).find((s) => s.hourStartAbs === t(9))!.productiveMinutes, 40);
});
test('changeover in 5–6 PM: 10-minute allowance absorbs it, longer ones reduce it', () => {
  const small = { start: t(17, 20), end: t(17, 30) };
  const big = { start: t(17, 20), end: t(17, 45) };
  assert.equal(buildSlots('A', 3, [small]).find((s) => s.hourStartAbs === t(17))!.productiveMinutes, 50);
  assert.equal(buildSlots('A', 3, [big]).find((s) => s.hourStartAbs === t(17))!.productiveMinutes, 35);
});
test('changeover segments always add up to the slot total', () => {
  const cases: [number, TimeInterval][] = [
    [17, { start: t(17, 20), end: t(17, 25) }],
    [17, { start: t(17, 20), end: t(17, 45) }],
    [9, { start: t(9, 10), end: t(9, 20) }],
    [7, { start: t(7, 30), end: t(7, 40) }],
    [11, { start: t(11, 30), end: t(11, 50) }],
    [8, { start: t(8, 50), end: t(9, 10) }], // spills into 9–10
  ];
  for (const [h, co] of cases) {
    const s = buildSlots('A', 3, [co]).find((x) => x.hourStartAbs === t(h))!;
    const seg = changeoverSegmentMinutes(s, co, [...scheduledNonProductive('A', 3), co]);
    assert.equal(Math.round((seg.beforeMinutes + seg.afterMinutes) * 100) / 100, s.productiveMinutes, `${h}:00`);
  }
  const co = { start: t(17, 20), end: t(17, 25) };
  const s17 = buildSlots('A', 3, [co]).find((x) => x.hourStartAbs === t(17))!;
  const seg = changeoverSegmentMinutes(s17, co, [...scheduledNonProductive('A', 3), co]);
  assert.equal(seg.beforeMinutes, 18.18); // 20 × 50/55
  assert.equal(seg.afterMinutes, 31.82); // 35 × 50/55
});
test('lunch windows stay 75 minutes with OT', () => {
  assert.equal(byHour3(12).isBreak, true);
  assert.equal(byHour3(12).productiveMinutes, 0);
  assert.equal(byHour3(11).endMinutesAbs, t(12, 15));
  assert.equal(byHour3(13).startMinutesAbs, t(12, 45));
});
test('shift total = sum of slot productive minutes (Shift A, 3 h OT)', () => {
  // 7–8 … 6–6:30: 50+60+50+60+75+0+75+50+60+60+50+30
  assert.equal(slotsA3.reduce((a, s) => a + s.productiveMinutes, 0), 620);
});

console.log('Time input formatting');
// Simulates typing one character at a time, the way onChangeText fires.
const typeDigits = (digits: string) => [...digits].reduce((shown, d) => formatTimeInput(shown + d), '');
test('1020 → 10:20, 0730 → 07:30, 1245 → 12:45', () => {
  assert.equal(typeDigits('1020'), '10:20');
  assert.equal(typeDigits('0730'), '07:30');
  assert.equal(typeDigits('1245'), '12:45');
  assert.equal(formatTimeInput('1020'), '10:20'); // pasted in one go
});
test('colon appears only after the hour digits, max 4 digits', () => {
  assert.equal(typeDigits('1'), '1');
  assert.equal(typeDigits('10'), '10');
  assert.equal(typeDigits('102'), '10:2');
  assert.equal(typeDigits('102055'), '10:20');
});
test('backspace and mid-field edits never leave stray colons', () => {
  assert.equal(formatTimeInput('10:'), '10'); // backspace over "10:2"
  assert.equal(formatTimeInput('1:020'), '10:20'); // colon deleted, digit re-typed
  assert.equal(formatTimeInput('10::20'), '10:20');
  assert.equal(formatTimeInput('1a0:2b0'), '10:20');
  assert.equal(formatTimeInput(''), '');
});
test('parses valid HH:MM (00–23 : 00–59) only', () => {
  assert.equal(parseTimeInput('10:20'), t(10, 20));
  assert.equal(parseTimeInput('07:30'), t(7, 30));
  assert.equal(parseTimeInput('00:00'), 0);
  assert.equal(parseTimeInput('23:59'), t(23, 59));
  for (const bad of ['25:65', '24:00', '12:60', '10:2', '1020', '', '7:30']) {
    assert.equal(parseTimeInput(bad), null, bad);
  }
  assert.equal(parseTimeInput(typeDigits('2565')), null);
});
test('shift frame: Shift B morning hours are after midnight', () => {
  assert.equal(timeOfDayToShiftAbs(t(10, 20), 'A'), t(10, 20));
  assert.equal(timeOfDayToShiftAbs(t(21), 'B'), t(21));
  assert.equal(timeOfDayToShiftAbs(t(2, 15), 'B'), t(26, 15));
});

console.log('Single-time changeover');
const place = (at: number, others: TimeInterval[] = [], slots = slotsA) => placeChangeoverTime(at, slots, others);
const splitAt = (at: number, shift: 'A' | 'B' = 'A', ot = 0) => {
  const co = { start: at, end: at };
  const slots = buildSlots(shift, ot, [co]);
  const p = placeChangeoverTime(at, slots, []);
  assert.ok(p.ok);
  const seg = changeoverSegmentMinutes(p.slot, co, [...scheduledNonProductive(shift, ot), co]);
  return { slot: p.slot, ...seg };
};
test('10:20 splits 10–11 into 10:00–10:20 and 10:20–11:00', () => {
  const r = splitAt(t(10, 20));
  assert.equal(r.slot.hourStartAbs, t(10));
  assert.deepEqual(r.before, { start: t(10), end: t(10, 20) });
  assert.deepEqual(r.after, { start: t(10, 20), end: t(11) });
  assert.equal(r.beforeMinutes, 20);
  assert.equal(r.afterMinutes, 40);
  assert.equal(expectedPartsFor(20, r.beforeMinutes), 60);
  assert.equal(expectedPartsFor(20, r.afterMinutes), 120);
});
test('a single-time changeover takes no productive minutes from any slot', () => {
  const base = buildSlots('A', 0);
  const withCo = buildSlots('A', 0, [{ start: t(10, 20), end: t(10, 20) }]);
  assert.deepEqual(withCo.map((s) => s.productiveMinutes), base.map((s) => s.productiveMinutes));
});
test('50-minute slots keep their rule when split', () => {
  const tea = splitAt(t(9, 15)); // 9–10, tea 9:30–9:40
  assert.equal(tea.beforeMinutes + tea.afterMinutes, 50);
  assert.equal(tea.beforeMinutes, 15);
  assert.equal(tea.afterMinutes, 35);
  const five = splitAt(t(17, 20), 'A', 3); // 5–6, no break: cap shared proportionally
  assert.equal(Math.round((five.beforeMinutes + five.afterMinutes) * 100) / 100, 50);
  assert.equal(five.beforeMinutes, 16.67);
  assert.equal(five.afterMinutes, 33.33);
  const start = splitAt(t(7, 30)); // 7–8, startup reserve 7:00–7:10
  assert.equal(start.beforeMinutes, 20);
  assert.equal(start.afterMinutes, 30);
});
test('split around lunch windows uses the 75-minute windows', () => {
  const pre = splitAt(t(12));
  assert.equal(pre.slot.hourStartAbs, t(11));
  assert.equal(pre.beforeMinutes, 60);
  assert.equal(pre.afterMinutes, 15); // 12:00–12:15, lunch excluded
  const post = splitAt(t(13));
  assert.equal(post.slot.hourStartAbs, t(13));
  assert.equal(post.beforeMinutes, 15); // 12:45–1:00
  assert.equal(post.afterMinutes, 60);
});
test('time on a slot boundary is a whole-slot switch, never a zero-length segment', () => {
  for (const at of [t(10), t(11), t(12, 45), t(14), t(7)]) {
    const p = place(at);
    assert.ok(p.ok, String(at));
    assert.equal(p.slot.startMinutesAbs, at);
    assert.equal(p.atSlotStart, true);
    assert.equal(isChangeoverAtSlotStart(p.slot, { start: at, end: at }), true);
  }
  // 11:00 belongs to the 11–12 slot only (half-open), not also to 10–11.
  const p = place(t(11));
  assert.ok(p.ok && p.slot.hourStartAbs === t(11));
  const mid = place(t(10, 20));
  assert.ok(mid.ok && !mid.atSlotStart);
});
test('times during lunch are rejected with the lunch message', () => {
  for (const at of [t(12, 15), t(12, 30), t(12, 44)]) {
    const p = place(at);
    assert.equal(p.ok, false);
    assert.equal(!p.ok && p.error, LUNCH_CHANGEOVER_MESSAGE);
  }
  assert.ok(place(t(12, 14)).ok);
  assert.ok(place(t(12, 45)).ok);
});
test('times outside the shift are rejected, not assigned to a wrong slot', () => {
  for (const at of [t(6, 59), t(15, 30), t(18)]) assert.equal(place(at).ok, false, String(at));
  const deleted = slotsA.filter((s) => s.hourStartAbs !== t(10)); // 10–11 card deleted
  assert.equal(place(t(10, 20), [], deleted).ok, false);
});
test('a second changeover at the same time is rejected', () => {
  const p = place(t(10, 20), [{ start: t(10, 20), end: t(10, 20) }]);
  assert.equal(p.ok, false);
  assert.ok(place(t(10, 21), [{ start: t(10, 20), end: t(10, 20) }]).ok);
});
test('Shift B: 02:15 lands in the after-midnight slot', () => {
  const slotsB = buildSlots('B', 0);
  const p = placeChangeoverTime(timeOfDayToShiftAbs(parseTimeInput('02:15')!, 'B'), slotsB, []);
  assert.ok(p.ok && p.slot.hourStartAbs === t(26));
});

console.log('Production start time');
const startAt = (shift: 'A' | 'B', start: number, ot = 0) => buildSlots(shift, ot, [], start);
const indexOfHour = (h: number) => byHour(h).index;
test('start at 14:00: first slot stays 2–3 PM, nothing clipped', () => {
  const s = startAt('A', t(14));
  assert.equal(s[0].hourStartAbs, t(14));
  assert.equal(s[0].startMinutesAbs, t(14));
  assert.equal(s[0].startAdjusted, false);
  assert.equal(s[0].label, byHour(14).label);
  assert.equal(s[0].productiveMinutes, byHour(14).productiveMinutes);
});
test('start at 14:15: first slot 14:15–15:00, 45 minutes, target 135 at 20 s', () => {
  const s = startAt('A', t(14, 15));
  assert.equal(s[0].startMinutesAbs, t(14, 15));
  assert.equal(s[0].endMinutesAbs, t(15));
  assert.equal(s[0].durationMinutes, 45);
  assert.equal(s[0].productiveMinutes, 45);
  assert.equal(s[0].label, '02:15 PM - 03:00 PM');
  assert.equal(s[0].startAdjusted, true);
  assert.equal(expectedPartsFor(20, s[0].productiveMinutes), 135);
});
test('later slots keep their boundaries, minutes and indices', () => {
  const s = startAt('A', t(14, 15), 2);
  const full = buildSlots('A', 2);
  for (const slot of s.slice(1)) assert.deepEqual(slot, full.find((f) => f.index === slot.index));
  assert.equal(s[0].index, full.find((f) => f.hourStartAbs === t(14))!.index);
  assert.deepEqual(s.map((x) => x.startMinutesAbs), [t(14, 15), t(15), t(16), t(17)]);
});
test('start at 14:59: one minute left in the slot', () => {
  const s = startAt('A', t(14, 59));
  assert.equal(s[0].durationMinutes, 1);
  assert.equal(s[0].productiveMinutes, 1);
});
test('hourly boundary start: no zero-length or duplicate slot', () => {
  for (const h of [8, 10, 11, 15]) {
    const s = startAt('A', t(h));
    assert.ok(s.every((x) => x.durationMinutes > 0));
    assert.equal(new Set(s.map((x) => x.index)).size, s.length);
    assert.equal(s.filter((x) => x.startAdjusted).length, 0);
  }
});
test('13:00 start: the 12:45–2:00 slot (after lunch) is clipped to 13:00–14:00', () => {
  const s = startAt('A', t(13));
  assert.equal(s[0].index, indexOfHour(13));
  assert.equal(s[0].startMinutesAbs, t(13));
  assert.equal(s[0].productiveMinutes, 60);
});
test('no start / start at shift start = legacy schedule', () => {
  assert.deepEqual(buildSlots('A', 0, [], null), slotsA);
  assert.deepEqual(buildSlots('A', 0, [], t(7)), slotsA);
  assert.deepEqual(buildSlots('B', 1, [], t(19)), buildSlots('B', 1));
});
test('start inside tea break 9:35: break still excluded from the clipped slot', () => {
  const s = startAt('A', t(9, 35));
  assert.equal(s[0].startMinutesAbs, t(9, 35));
  assert.equal(s[0].productiveMinutes, 20); // 9:35–10:00 minus 9:35–9:40 break
});
test('start in the startup reserve 7:05 keeps the 7–8 rule (50 min)', () => {
  assert.equal(startAt('A', t(7, 5))[0].productiveMinutes, 50);
});
test('start during lunch 12:20: lunch card clipped, 0 productive, 1–2 PM untouched', () => {
  const s = startAt('A', t(12, 20));
  assert.equal(s[0].isBreak, true);
  assert.equal(s[0].startMinutesAbs, t(12, 20));
  assert.equal(s[0].productiveMinutes, 0);
  assert.deepEqual(s[1], byHour(13));
});
test('start at 12:05: 11–12 slot clipped to 12:05–12:15 (lunch excluded)', () => {
  const s = startAt('A', t(12, 5));
  assert.equal(s[0].index, indexOfHour(11));
  assert.equal(s[0].productiveMinutes, 10);
  assert.equal(s[0].label, '12:05 PM - 12:15 PM');
});
test('start at 13:15: 1–2 PM slot clipped to 13:15–14:00', () => {
  const s = startAt('A', t(13, 15));
  assert.equal(s[0].index, indexOfHour(13));
  assert.equal(s[0].productiveMinutes, 45);
});
test('Shift B overnight start 01:20 → 25:20, 1–2 AM slot clipped, index unchanged', () => {
  const abs = timeOfDayToShiftAbs(parseTimeInput('01:20')!, 'B');
  assert.equal(abs, t(25, 20));
  const s = startAt('B', abs);
  assert.equal(s[0].index, buildSlots('B', 0).find((f) => f.hourStartAbs === t(25))!.index);
  assert.equal(s[0].startMinutesAbs, t(25, 20));
  assert.equal(s[0].endMinutesAbs, t(26));
  assert.equal(s[0].label, '01:20 AM - 02:00 AM');
  assert.equal(s[s.length - 1].endMinutesAbs, t(27, 30));
});
test('changeovers: before the start rejected, in the clipped slot split from the start', () => {
  const s = startAt('A', t(14, 15));
  assert.equal(placeChangeoverTime(t(14, 10), s, []).ok, false);
  assert.equal(placeChangeoverTime(t(10), s, []).ok, false);
  const atStart = placeChangeoverTime(t(14, 15), s, []);
  assert.ok(atStart.ok && atStart.atSlotStart);
  const mid = placeChangeoverTime(t(14, 40), s, []);
  assert.ok(mid.ok && !mid.atSlotStart && mid.slot.index === s[0].index);
  const seg = changeoverSegmentMinutes(s[0], { start: t(14, 40), end: t(14, 40) }, scheduledNonProductive('A', 0));
  assert.equal(seg.beforeMinutes, 25);
  assert.equal(seg.afterMinutes, 20);
  assert.equal(seg.beforeMinutes + seg.afterMinutes, s[0].productiveMinutes);
});
test('validation: malformed and incomplete input rejected', () => {
  for (const txt of ['', '1', '14:', '14:1', '24:00', '14:60', 'ab:cd']) {
    assert.equal(validateProductionStartTime(txt, 'A', 0).ok, false, txt);
  }
});
test('validation: accepts times inside the shift (incl. boundaries)', () => {
  const cases: [string, number][] = [['07:00', t(7)], ['07:05', t(7, 5)], ['09:30', t(9, 30)], ['14:15', t(14, 15)], ['15:29', t(15, 29)]];
  for (const [txt, abs] of cases) {
    const r = validateProductionStartTime(txt, 'A', 0);
    assert.ok(r.ok && r.startAbs === abs, txt);
  }
  const b = validateProductionStartTime('23:45', 'B', 0);
  assert.ok(b.ok && b.startAbs === t(23, 45));
});
test('validation: before shift, at/after shift end and other shift rejected', () => {
  assert.equal(validateProductionStartTime('06:59', 'A', 0).ok, false);
  assert.equal(validateProductionStartTime('15:30', 'A', 0).ok, false);
  assert.ok(validateProductionStartTime('15:30', 'A', 1).ok); // inside OT
  assert.equal(validateProductionStartTime('16:30', 'A', 1).ok, false);
  assert.equal(validateProductionStartTime('14:15', 'B', 0).ok, false);
  assert.equal(validateProductionStartTime('03:30', 'B', 0).ok, false);
  assert.ok(validateProductionStartTime('03:29', 'B', 0).ok);
});
test('validation: future rejected, earlier time (late entry) accepted', () => {
  assert.equal(validateProductionStartTime('14:15', 'A', 0, t(14, 10)).ok, false);
  assert.ok(validateProductionStartTime('14:15', 'A', 0, t(14, 15)).ok);
  assert.ok(validateProductionStartTime('14:15', 'A', 0, t(14, 30)).ok);
  assert.ok(validateProductionStartTime('01:20', 'B', 0, t(25, 30)).ok);
  assert.equal(validateProductionStartTime('02:00', 'B', 0, t(25, 30)).ok, false);
});

console.log(`\n${passed} checks passed`);
