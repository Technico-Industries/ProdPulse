// scripts/testDowntime.ts
//
// Checks for line stop / resume downtime arithmetic (src/utils/downtime.ts)
// against the real shift schedule. The project has no test runner, so this
// is a plain node:assert script:  npm run test:downtime

import assert from 'node:assert/strict';
import {
  DowntimeStop,
  combinedDowntimeMinutes,
  completeRunningStops,
  downtimeMinutesInWindow,
  formatDowntimeMinutes,
  formatElapsedSince,
  freezeRunningStops,
  isAnyStopRunning,
  lineDowntimeSummary,
  sessionDowntimeMinutes,
  stopDurationMinutes,
  stopEventsForWindow,
  stopIdOf,
} from '../src/utils/downtime';
import { buildSlots, changeoverSegmentWindows, ScheduleSlot } from '../src/utils/productionSchedule';
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
// Wall-clock instant on the production day; minutes past 1440 are after midnight.
const at = (h: number, m = 0, s = 0) => productionDayMinuteToMillis(PD, h * 60 + m) + s * 1000;
const slotWindowMs = (slot: ScheduleSlot) => [
  productionDayMinuteToMillis(PD, slot.startMinutesAbs),
  productionDayMinuteToMillis(PD, slot.endMinutesAbs),
] as const;
const slotAt = (slots: ScheduleSlot[], h: number) => {
  const s = slots.find((x) => x.hourStartAbs === h * 60);
  assert.ok(s, `no slot for hour ${h}`);
  return s;
};
const stop = (startMs: number, reason = 'maintenance'): DowntimeStop => ({ id: stopIdOf({ startAbs: startMs }), reason, startAbs: startMs, running: true });
// What Firestore hands back on restore: plain JSON, no class instances.
const roundTrip = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

const shiftA = buildSlots('A', 0);
const shiftB = buildSlots('B', 0);

test('success criterion: stop 14:15, app closed, resume 15:05 → 50 min', () => {
  // Nothing runs while the app is closed: only the persisted start and the
  // resume time matter.
  const persisted = roundTrip({ 5: [stop(at(14, 15))] });
  const [closed] = completeRunningStops(persisted[5], at(15, 5));
  assert.equal(closed.running, false);
  assert.equal(closed.endAbs, at(15, 5));
  assert.equal(closed.durationMinutes, 50);
});

test('restored running stop: timer counts from the original stop, not app launch', () => {
  const persisted = roundTrip([stop(at(14, 15))]);
  // App reopened at 14:50 — elapsed is 35 min, not 0.
  assert.equal(formatElapsedSince(persisted[0].startAbs, at(14, 50)), '35:00');
  assert.equal(isAnyStopRunning({ 5: persisted }), true);
});

test('timer while open: 5 minutes → 05:00; past an hour → H:MM:SS', () => {
  assert.equal(formatElapsedSince(at(10, 0), at(10, 5)), '05:00');
  assert.equal(formatElapsedSince(at(10, 0), at(10, 0, 59)), '00:59');
  assert.equal(formatElapsedSince(at(10, 0), at(11, 30, 7)), '1:30:07');
  assert.equal(formatElapsedSince(at(10, 0), at(9, 59)), '00:00'); // clock skew never negative
});

test('hourly boundary: 14:15–15:05 → 45 min on 2–3 PM, 5 min on 3–3:30 PM', () => {
  const stops = { 7: completeRunningStops([stop(at(14, 15))], at(15, 5)) };
  const [a0, a1] = slotWindowMs(slotAt(shiftA, 14));
  const [b0, b1] = slotWindowMs(slotAt(shiftA, 15));
  assert.equal(downtimeMinutesInWindow(stops, a0, a1, at(16)), 45);
  assert.equal(downtimeMinutesInWindow(stops, b0, b1, at(16)), 5);
  // Every other slot gets none — total across records is exactly 50.
  const total = shiftA.reduce((sum, s) => sum + downtimeMinutesInWindow(stops, ...slotWindowMs(s), at(16)), 0);
  assert.equal(total, 50);
});

test('attribution is by time, not by the card Stop was pressed on', () => {
  // Pressed on the 7–8 AM card (index 0) while it was really 10:20.
  const stops = { 0: completeRunningStops([stop(at(10, 20))], at(10, 40)) };
  assert.equal(downtimeMinutesInWindow(stops, ...slotWindowMs(slotAt(shiftA, 7)), at(11)), 0);
  assert.equal(downtimeMinutesInWindow(stops, ...slotWindowMs(slotAt(shiftA, 10)), at(11)), 20);
});

test('midnight (Shift B): 23:40 → 00:25 splits 20 / 25 and totals 45', () => {
  const stops = { 4: completeRunningStops([stop(at(23, 40))], at(24, 25)) };
  assert.equal(stops[4][0].durationMinutes, 45);
  assert.equal(downtimeMinutesInWindow(stops, ...slotWindowMs(slotAt(shiftB, 23)), at(26)), 20);
  assert.equal(downtimeMinutesInWindow(stops, ...slotWindowMs(slotAt(shiftB, 24)), at(26)), 25);
  const total = shiftB.reduce((sum, s) => sum + downtimeMinutesInWindow(stops, ...slotWindowMs(s), at(26)), 0);
  assert.equal(total, 45);
});

test('repeated Resume / retry: closing an already-closed stop changes nothing', () => {
  const once = completeRunningStops([stop(at(14, 15))], at(15, 5));
  const twice = completeRunningStops(once, at(15, 9)); // second tap 4 min later
  assert.deepEqual(twice, once);
  assert.equal(twice.length, 1);
  assert.equal(twice[0].durationMinutes, 50);
});

test('the same interval is never counted twice in one record', () => {
  const s = completeRunningStops([stop(at(14, 15))], at(14, 45))[0];
  // e.g. a duplicate left in another slot's list by an old client
  const events = stopEventsForWindow({ 7: [s], 8: [s] }, ...slotWindowMs(slotAt(shiftA, 14)), at(16));
  assert.equal(events.length, 1);
  assert.equal(events[0].durationMinutes, 30);
});

test('changeover slot: BEFORE and AFTER get only their own part (no double count)', () => {
  const co = { start: 10 * 60 + 30, end: 10 * 60 + 40 };
  const slots = buildSlots('A', 0, [co]);
  const slot = slotAt(slots, 10);
  const w = changeoverSegmentWindows({ start: slot.startMinutesAbs, end: slot.endMinutesAbs }, co);
  const ms = (m: number) => productionDayMinuteToMillis(PD, m);
  const stops = { [slot.index]: completeRunningStops([stop(at(10, 20))], at(10, 50)) };
  const before = downtimeMinutesInWindow(stops, ms(w.before.start), ms(w.before.end), at(11));
  const after = downtimeMinutesInWindow(stops, ms(w.after.start), ms(w.after.end), at(11));
  assert.equal(before, 10); // 10:20–10:30
  assert.equal(after, 10); // 10:40–10:50; the changeover's own 10 min is in neither
  assert.ok(before + after <= stops[slot.index][0].durationMinutes!);
});

test('record stopEvents keep the raw interval for auditing', () => {
  const stops = { 7: completeRunningStops([stop(at(14, 15), 'quality')], at(15, 5)) };
  const [ev] = stopEventsForWindow(stops, ...slotWindowMs(slotAt(shiftA, 15)), at(16));
  assert.deepEqual(ev, {
    stopId: stopIdOf({ startAbs: at(14, 15) }),
    reason: 'quality',
    startAbs: at(14, 15),
    endAbs: at(15, 5),
    durationMinutes: 5,
    intervalDurationMinutes: 50,
  });
});

test('Finalize with the line still stopped freezes the stop at finalize time', () => {
  const frozen = freezeRunningStops({ 7: [stop(at(14, 15))] }, at(14, 40));
  assert.equal(isAnyStopRunning(frozen), false);
  assert.equal(frozen[7][0].durationMinutes, 25);
});

test('legacy stops (no id, no endAbs on a running stop) still work', () => {
  const legacy: DowntimeStop = { reason: 'power cut', startAbs: at(11, 0), running: true };
  assert.equal(stopIdOf(legacy), `stop-${at(11, 0)}`);
  // A running stop counts up to "now" for live display.
  assert.equal(downtimeMinutesInWindow({ 3: [legacy] }, ...slotWindowMs(slotAt(shiftA, 11)), at(11, 12)), 12);
  // A completed legacy stop with no endAbs (shouldn't exist) contributes nothing rather than crashing.
  assert.equal(downtimeMinutesInWindow({ 3: [{ reason: 'x', startAbs: at(11, 0) }] }, at(11), at(12), at(12)), 0);
  assert.equal(isAnyStopRunning({}), false);
});

test('duration uses timestamps, never wall-clock strings', () => {
  assert.equal(stopDurationMinutes(at(14, 15, 0), at(15, 5, 30)), 50.5);
  assert.equal(stopDurationMinutes(at(15, 0), at(14, 0)), 0);
});

// ── Session KPI downtime (SupervisorOverviewScreen) ─────────────────────────

test('reported case: one 4 min 12 s stop on an UNSAVED slot → session 4.2 min, badge 4.2 min', () => {
  const [done] = completeRunningStops([stop(at(10, 0), 'quality')], at(10, 4, 12));
  assert.equal(done.durationMinutes, 4.2);
  assert.equal(`${done.reason} · ${done.durationMinutes!.toFixed(1)} min`, 'quality · 4.2 min'); // slot badge text
  // What the dashboard's activeSessions listener receives.
  const sessionDoc = roundTrip({ stopsBySlot: { '3': [done] } });
  const mins = sessionDowntimeMinutes(sessionDoc.stopsBySlot, at(11));
  assert.equal(mins, 4.2);
  assert.equal(formatDowntimeMinutes(mins), '4.2 min');
});

test('saving the slot does not add it again; restoring does not duplicate it', () => {
  const [done] = completeRunningStops([stop(at(10, 0), 'quality')], at(10, 4, 12));
  const stops = { 3: [done] };
  const before = sessionDowntimeMinutes(stops, at(11));
  // Saving writes record stopEvents but leaves the session's stopsBySlot as is.
  const recordEvents = stopEventsForWindow(stops, ...slotWindowMs(slotAt(shiftA, 10)), at(11));
  assert.equal(recordEvents[0].durationMinutes, 4.2);
  assert.equal(sessionDowntimeMinutes(stops, at(11)), before);
  // Restore round-trip; and a copy of the same interval in another slot's list.
  assert.equal(sessionDowntimeMinutes(roundTrip(stops), at(11)), 4.2);
  assert.equal(sessionDowntimeMinutes({ 3: [done], 4: [done] }, at(11)), 4.2);
});

test('stopped line: live downtime grows; Resume fixes it at the real duration', () => {
  const running = { 3: [stop(at(10, 0))] };
  assert.equal(sessionDowntimeMinutes(running, at(10, 6)), 6);
  assert.equal(sessionDowntimeMinutes(running, at(10, 9)), 9);
  const resumed = { 3: completeRunningStops(running[3], at(10, 9, 30)) };
  assert.equal(sessionDowntimeMinutes(resumed, at(12)), 9.5); // no longer grows
});

test('multiple intervals across slots, plus a running one', () => {
  const stops = {
    1: completeRunningStops([stop(at(8, 0))], at(8, 4, 12)), // 4.2
    5: completeRunningStops([stop(at(13, 0), 'power cut')], at(13, 10)), // 10
    6: [stop(at(14, 20))], // running, 5 min at 14:25
  };
  assert.equal(sessionDowntimeMinutes(stops, at(14, 25)), 19.2);
});

test('no downtime → 0 min; legacy / malformed entries are ignored safely', () => {
  assert.equal(sessionDowntimeMinutes({}, at(12)), 0);
  assert.equal(sessionDowntimeMinutes(undefined, at(12)), 0);
  assert.equal(formatDowntimeMinutes(0), '0 min');
  // Older stop with endAbs but no durationMinutes; garbage entries skipped.
  assert.equal(sessionDowntimeMinutes({ 2: [{ reason: 'x', startAbs: at(9), endAbs: at(9, 3) }, null as any], 3: 'bad' as any }, at(12)), 3);
});

test('KPI formatting: decimals under an hour, whole minutes after', () => {
  assert.equal(formatDowntimeMinutes(4.2), '4.2 min');
  assert.equal(formatDowntimeMinutes(4.24), '4.2 min');
  assert.equal(formatDowntimeMinutes(12), '12 min');
  assert.equal(formatDowntimeMinutes(59.96), '1h');
  assert.equal(formatDowntimeMinutes(65.4), '1h 5m');
  assert.equal(formatDowntimeMinutes(-3), '0 min');
});

// ── Admin overview downtime (records + active sessions) ─────────────────────

test('admin: unsaved 4.2 min stop on an active session shows 4.2, not 0', () => {
  const [done] = completeRunningStops([stop(at(10, 0), 'quality')], at(10, 4, 12));
  const session = { lineId: 'L1', productionDate: PD, shift: 'A', stopsBySlot: roundTrip({ '3': [done] }) };
  assert.equal(combinedDowntimeMinutes([], [session], at(11)), 4.2);
});

test('admin: saving the slot does not double count; finished sessions still count', () => {
  const [done] = completeRunningStops([stop(at(10, 0), 'quality')], at(10, 4, 12));
  const stops = { 3: [done] };
  const session = { lineId: 'L1', productionDate: PD, shift: 'A', stopsBySlot: stops };
  const savedRecord = {
    lineId: 'L1', productionDate: PD, shift: 'A',
    stopEvents: stopEventsForWindow(stops, ...slotWindowMs(slotAt(shiftA, 10)), at(11)),
  };
  assert.equal(combinedDowntimeMinutes([savedRecord], [session], at(11)), 4.2);
  // After Finalize the session is gone and the record is the source.
  assert.equal(combinedDowntimeMinutes([savedRecord], [], at(11)), 4.2);
  // Another line's / shift's records are unaffected by L1's live session.
  const otherLine = { lineId: 'L2', productionDate: PD, shift: 'A', stopEvents: [{ durationMinutes: 10 }] };
  const otherShift = { lineId: 'L1', productionDate: PD, shift: 'B', stopEvents: [{ durationMinutes: 7 }] };
  assert.equal(combinedDowntimeMinutes([savedRecord, otherLine, otherShift], [session], at(11)), 21.2);
  assert.equal(combinedDowntimeMinutes([], [], at(11)), 0);
});

// ── Admin Lines overview: cumulative downtime per line ────────────────────
// The stops below are written the way Stop / Resume write them
// (completeRunningStops on the persisted startAbs), on whatever card the
// supervisor pressed — the line's total must keep growing across
// stop → start → stop → start and never fall back to 0 on Resume.
test('line downtime accumulates across stop → start → stop → start', () => {
  const s1: DowntimeStop = { id: stopIdOf({ startAbs: at(9, 10) }), reason: 'material', startAbs: at(9, 10), running: true };
  let stops: Record<number, DowntimeStop[]> = { 2: [s1] };
  // 1st stop running: total and current stop both 5 min.
  let sum = lineDowntimeSummary(stops, at(9, 15));
  assert.equal(sum.totalMinutes, 5);
  assert.equal(sum.currentStopMinutes, 5);
  assert.equal(sum.currentStopStartMs, at(9, 10));
  // Start (Resume) at 9:22 — the 12 min stay; no current stop.
  stops = { 2: completeRunningStops(stops[2], at(9, 22)) };
  sum = lineDowntimeSummary(stops, at(9, 40));
  assert.equal(sum.totalMinutes, 12);
  assert.equal(sum.currentStopMinutes, null);
  assert.equal(sum.currentStopStartMs, null);
  // 2nd stop at 10:05 (another card), running: 12 + 3 so far.
  const s2: DowntimeStop = { id: stopIdOf({ startAbs: at(10, 5) }), reason: 'maintenance', startAbs: at(10, 5), running: true };
  stops = { ...stops, 3: [s2] };
  sum = lineDowntimeSummary(stops, at(10, 8));
  assert.equal(sum.totalMinutes, 15);
  assert.equal(sum.currentStopMinutes, 3);
  assert.equal(sum.stopCount, 2);
  // Start again at 10:15 — 12 + 10, still kept after the line runs.
  stops = { ...stops, 3: completeRunningStops(stops[3], at(10, 15)) };
  sum = lineDowntimeSummary(stops, at(13));
  assert.equal(sum.totalMinutes, 22);
  assert.equal(sum.currentStopMinutes, null);
  assert.equal(sum.stopCount, 2);
});

test('line downtime never double-counts retried writes or copies of one stop', () => {
  const start = at(11);
  const running: DowntimeStop = { id: stopIdOf({ startAbs: start }), reason: 'quality', startAbs: start, running: true };
  // Resume tapped twice / retried after a failed save: closing again is a no-op.
  const closedOnce = completeRunningStops([running], at(11, 6));
  const closedTwice = completeRunningStops(closedOnce, at(11, 30));
  assert.deepEqual(closedTwice, closedOnce);
  // The same interval present twice (a merge between two devices, or a
  // legacy stop without an id next to its id'd copy) counts once.
  const legacyCopy: DowntimeStop = { reason: 'quality', startAbs: start, endAbs: at(11, 6), durationMinutes: 6 };
  const sum = lineDowntimeSummary({ 4: closedTwice, 5: [legacyCopy] }, at(12));
  assert.equal(sum.totalMinutes, 6);
  assert.equal(sum.stopCount, 1);
  // Two listeners reading the same session doc compute the same figure.
  const copy = JSON.parse(JSON.stringify({ 4: closedTwice }));
  assert.deepEqual(lineDowntimeSummary({ 4: closedTwice }, at(12)), lineDowntimeSummary(copy, at(12)));
});

test('line downtime handles missing and legacy data safely', () => {
  const none = { totalMinutes: 0, currentStopMinutes: null, currentStopStartMs: null, stopCount: 0 };
  assert.deepEqual(lineDowntimeSummary(null, at(9)), none);
  assert.deepEqual(lineDowntimeSummary(undefined, at(9)), none);
  const junk: any = { 1: null, 2: 'x', 3: [null, { reason: 'x' }, { reason: 'old', startAbs: at(8), endAbs: at(8, 4) }] };
  const sum = lineDowntimeSummary(junk, at(9));
  // Only the usable legacy stop (no id, no stored duration) counts: 4 min.
  assert.equal(sum.totalMinutes, 4);
  assert.equal(sum.stopCount, 1);
  // A Shift B stop across midnight keeps counting on the same session.
  const night: DowntimeStop = { reason: 'material', startAbs: at(23, 50), running: true };
  assert.equal(lineDowntimeSummary({ 9: [night] }, at(24, 20)).currentStopMinutes, 30);
});

console.log(`\n${passed} downtime checks passed`);
