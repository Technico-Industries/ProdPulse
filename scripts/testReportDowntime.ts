// scripts/testReportDowntime.ts
//
// Regression checks: Generate Report's Downtime must match the Admin
// Overview's for the same date and scope. Both total downtime with
// collectDowntimeIntervals (src/utils/downtime.ts) over the same sources:
// productionRecords stopEvents (per-slot shares), live activeSessions,
// admin-ended endedSessions archives and Finalize's shiftSummaries.
// Plain node:assert script:  npm run test:report-downtime

import assert from 'node:assert/strict';
import {
  DowntimeSessionLike,
  DowntimeSourcesInput,
  DowntimeStop,
  collectDowntimeIntervals,
  completeRunningStops,
  downtimeByReason,
  downtimeBySession,
  formatDowntimeMinutes,
  inProductionRange,
  sessionSourceFromDoc,
  stopEventsForWindow,
  stopIdOf,
  summarySourceFromDoc,
  totalDowntimeMinutes,
} from '../src/utils/downtime';
import { addDaysToKey, productionDayMinuteToMillis } from '../src/utils/productionDay';

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

const PD = '2026-10-27';
const at = (h: number, m = 0, pd = PD) => productionDayMinuteToMillis(pd, h * 60 + m);
const NOW = at(15, 0);

function stop(reason: string, startMs: number, endMs: number | null): DowntimeStop {
  const s: DowntimeStop = { id: stopIdOf({ startAbs: startMs }), reason, startAbs: startMs, running: true };
  return endMs == null ? s : completeRunningStops([s], endMs)[0];
}

// What a saved slot's record holds: the part of each stop inside its window,
// as of the moment the slot was saved.
function record(lineId: string, shift: 'A' | 'B', stops: Record<number, DowntimeStop[]>, winStart: number, winEnd: number, savedAt: number, pd = PD) {
  return { lineId, productionDate: pd, shift, stopEvents: stopEventsForWindow(stops, winStart, winEnd, savedAt), lossTimeMinutes: 0 };
}

// Generate Report's downtime before the fix: Σ records' stopEvents only.
const oldReportMinutes = (input: DowntimeSourcesInput) =>
  input.records.reduce((sum, r) => sum + (r.stopEvents ?? []).reduce((s, se) => s + (se.durationMinutes ?? 0), 0), 0);

// The screenshots' day: line L1 (Shift A) stopped three times — 167 min in
// all — while its morning slots had already been saved and the afternoon
// slots were not saved yet. The session is still active.
function screenshotDay() {
  const stops: Record<number, DowntimeStop[]> = {
    4: [stop('material shortage', at(11, 0), at(12, 2))], // 62 min, slot not saved
    5: [stop('maintenance', at(12, 30), at(13, 50))], // 80 min
    7: [stop('quality', at(14, 25), at(14, 50))], // 25 min
  };
  const session: DowntimeSessionLike = { lineId: 'L1', productionDate: PD, shift: 'A', stopsBySlot: stops };
  // Slots 07:00–11:00 saved before any stop: their records carry no downtime.
  const records = [0, 1, 2, 3].map((i) => record('L1', 'A', stops, at(7 + i), at(8 + i), at(8 + i, 2)));
  return { stops, session, records };
}

test('regression: 167 min of stops → report shows 2h 47m, same as the overview (was 0m)', () => {
  const { session, records } = screenshotDay();
  const input: DowntimeSourcesInput = { records, activeSessions: [session], endedSessions: [], shiftSummaries: [] };
  assert.equal(oldReportMinutes(input), 0); // the bug
  const report = totalDowntimeMinutes(collectDowntimeIntervals(input, NOW));
  assert.equal(report, 167);
  assert.equal(formatDowntimeMinutes(report), '2h 47m');
  // The overview loads the live session from its listener and the closed
  // sources by fetch; same inputs, same rule, same figure.
  const overview = totalDowntimeMinutes(collectDowntimeIntervals({ records, activeSessions: [session] }, NOW));
  assert.equal(overview, report);
});

test('after Finalize & End (session gone, shift summary + records) the figure stays 167', () => {
  const { stops, records } = screenshotDay();
  // Finalize submits the unsaved slots with their shares, and writes every
  // stop whole to shiftSummaries.downtimeIntervals.
  const finalRecords = [
    ...records,
    ...[4, 5, 6, 7].map((i) => record('L1', 'A', stops, at(7 + i), at(8 + i), at(15, 30))),
  ];
  const summary = summarySourceFromDoc({
    lineId: 'L1', productionDate: PD, shift: 'A',
    downtimeIntervals: Object.values(stops).flat().map((s) => ({ stopId: stopIdOf(s), reason: s.reason, startAbs: s.startAbs, endAbs: s.endAbs, durationMinutes: s.durationMinutes })),
  })!;
  const intervals = collectDowntimeIntervals({ records: finalRecords, shiftSummaries: [summary] }, at(16));
  assert.equal(totalDowntimeMinutes(intervals), 167); // not 167 + the record shares
  assert.ok(intervals.every((iv) => iv.source === 'summary'));
  // Records alone now also hold most of it — and are never added on top.
  assert.ok(oldReportMinutes({ records: finalRecords }) > 0);
});

test('multiple stoppages on one line, by reason, no double counting', () => {
  const { session, records } = screenshotDay();
  const intervals = collectDowntimeIntervals({ records, activeSessions: [session] }, NOW);
  assert.equal(intervals.length, 3);
  assert.deepEqual(downtimeByReason(intervals), [
    { reason: 'maintenance', minutes: 80 },
    { reason: 'material shortage', minutes: 62 },
    { reason: 'quality', minutes: 25 },
  ]);
  // The same session seen twice (two listeners / a repeated fetch) and a
  // stop present in two sources count once.
  const twice = collectDowntimeIntervals({ records, activeSessions: [session, JSON.parse(JSON.stringify(session))] }, NOW);
  assert.equal(totalDowntimeMinutes(twice), 167);
});

test('multiple lines and shifts are kept apart and summed', () => {
  const { session, records } = screenshotDay();
  const l2: DowntimeSessionLike = { lineId: 'L2', productionDate: PD, shift: 'A', stopsBySlot: { 2: [stop('5s', at(9), at(9, 20))] } };
  const l1b: DowntimeSessionLike = { lineId: 'L1', productionDate: PD, shift: 'B', stopsBySlot: { 1: [stop('material shortage', at(20), at(20, 10))] } };
  const intervals = collectDowntimeIntervals({ records, activeSessions: [session, l2, l1b] }, at(21));
  assert.equal(totalDowntimeMinutes(intervals), 167 + 20 + 10);
  const bySession = downtimeBySession(intervals);
  assert.equal(bySession.get(`L1|${PD}|A`), 167);
  assert.equal(bySession.get(`L2|${PD}|A`), 20);
  assert.equal(bySession.get(`L1|${PD}|B`), 10);
});

test('an active stoppage counts up to now', () => {
  const s: DowntimeSessionLike = { lineId: 'L3', productionDate: PD, shift: 'A', stopsBySlot: { 6: [stop('maintenance', at(14, 40), null)] } };
  assert.equal(totalDowntimeMinutes(collectDowntimeIntervals({ records: [], activeSessions: [s] }, at(15))), 20);
  assert.equal(totalDowntimeMinutes(collectDowntimeIntervals({ records: [], activeSessions: [s] }, at(15, 7))), 27);
  const iv = collectDowntimeIntervals({ records: [], activeSessions: [s] }, at(15))[0];
  assert.equal(iv.running, true);
});

test('zero downtime is 0 (and Time Loss never feeds Downtime)', () => {
  const s: DowntimeSessionLike = { lineId: 'L4', productionDate: PD, shift: 'A', stopsBySlot: {} };
  const recs = [{ lineId: 'L4', productionDate: PD, shift: 'A', stopEvents: [], lossTimeMinutes: 68 }];
  const total = totalDowntimeMinutes(collectDowntimeIntervals({ records: recs, activeSessions: [s], endedSessions: [], shiftSummaries: [] }, NOW));
  assert.equal(total, 0);
  assert.equal(formatDowntimeMinutes(total), '0 min');
  assert.equal(totalDowntimeMinutes(collectDowntimeIntervals({ records: [] }, NOW)), 0);
});

test('a range spanning several days: each day once, from its own sources', () => {
  const d1 = '2026-10-25', d2 = '2026-10-26', d3 = PD;
  const summary1 = summarySourceFromDoc({ lineId: 'L1', productionDate: d1, shift: 'A', downtimeIntervals: [{ stopId: 'stop-1', reason: 'x', durationMinutes: 30 }] })!;
  const ended2 = sessionSourceFromDoc('L1--inst', { lineId: 'L1', productionDate: d2, shift: 'B', stopsBySlot: { 3: [stop('y', at(22, 0, d2), at(22, 45, d2))] } })!;
  const { session, records } = screenshotDay();
  const sources = { shiftSummaries: [summary1], endedSessions: [ended2], activeSessions: [session] };
  const all = collectDowntimeIntervals({ records, ...sources }, NOW);
  assert.equal(totalDowntimeMinutes(all), 30 + 45 + 167);
  // The same rule with only the sources inside each range.
  const forRange = (from: string, to: string) =>
    totalDowntimeMinutes(collectDowntimeIntervals({
      records: records.filter((r) => inProductionRange(r.productionDate, from, to)),
      shiftSummaries: sources.shiftSummaries.filter((s) => inProductionRange(s.productionDate, from, to)),
      endedSessions: sources.endedSessions.filter((s) => inProductionRange(s.productionDate, from, to)),
      activeSessions: sources.activeSessions.filter((s) => inProductionRange(s.productionDate, from, to)),
    }, NOW));
  assert.equal(forRange(d3, d3), 167); // Today
  assert.equal(forRange(d2, d2), 45); // Yesterday
  assert.equal(forRange(addDaysToKey(d3, -6), d3), 242); // Last 7 days
  assert.equal(forRange('2026-10-01', d3), 242); // This month
  assert.equal(forRange('2026-10-26', '2026-10-27'), 212); // custom
  assert.equal(forRange('2026-09-01', '2026-09-30'), 0);
});

test('Shift B: stops after midnight and in OT stay on the shift-start production date', () => {
  // Shift B of the 26th: stops at 23:40–00:20 and 04:10–04:30 (OT), both
  // on the 26th's session, whose productionDate stays 2026-10-26.
  const night = '2026-10-26';
  const s = sessionSourceFromDoc('L5', {
    lineId: 'L5', productionDate: night, shift: 'B',
    stopsBySlot: { 4: [stop('maintenance', at(23, 40, night), at(24, 20, night))], 9: [stop('quality', at(28, 10, night), at(28, 30, night))] },
  })!;
  const total = (from: string, to: string) =>
    totalDowntimeMinutes(collectDowntimeIntervals({ records: [], activeSessions: [s].filter((x) => inProductionRange(x.productionDate, from, to)) }, at(30, 0, night)));
  assert.equal(total(night, night), 60);
  assert.equal(total(PD, PD), 0); // nothing leaks into the next calendar day
});

test('legacy data: no stop ids, missing fields, old summaries', () => {
  // Records saved before stop ids (only reason + minutes) count as before
  // when nothing else covers their session.
  const legacy = [{ lineId: 'L6', productionDate: '2026-09-01', shift: 'A', stopEvents: [{ reason: 'material', durationMinutes: 12 }, { durationMinutes: 3 }] }];
  assert.equal(totalDowntimeMinutes(collectDowntimeIntervals({ records: legacy }, NOW)), 15);
  // Records with startAbs but no stopId match the full source by start time.
  const { session } = screenshotDay();
  const s4 = session.stopsBySlot![4][0];
  const rec = [{ lineId: 'L1', productionDate: PD, shift: 'A', stopEvents: [{ reason: s4.reason, startAbs: s4.startAbs, durationMinutes: 50 }] }];
  assert.equal(totalDowntimeMinutes(collectDowntimeIntervals({ records: rec, activeSessions: [session] }, NOW)), 167);
  // Damaged docs are skipped, not thrown on.
  assert.equal(sessionSourceFromDoc('x', null), null);
  assert.equal(sessionSourceFromDoc('x', { shift: 'A' }), null); // no productionDate
  assert.equal(summarySourceFromDoc({ productionDate: PD }), null); // no lineId
  const oldSummary = summarySourceFromDoc({ lineId: 'L7', productionDate: PD, shift: 'A' })!; // before downtimeIntervals
  assert.deepEqual(oldSummary.downtimeIntervals, []);
  const junk: any = { lineId: 'L8', productionDate: PD, shift: 'A', stopsBySlot: { 1: 'x', 2: [null, { reason: 'r' }] } };
  assert.equal(totalDowntimeMinutes(collectDowntimeIntervals({ records: [], activeSessions: [sessionSourceFromDoc('L8', junk)!] }, NOW)), 0);
});

test('an earlier session replaced in the shift summary still counts from its records', () => {
  // Session 1 (finalized, summary later overwritten by session 2's Finalize)
  // left a 10-min stop only in its record shares.
  const s1Stop = stop('material', at(8), at(8, 10));
  const s1Records = [record('L1', 'A', { 1: [s1Stop] }, at(8), at(9), at(9, 1))];
  const s2Summary = summarySourceFromDoc({ lineId: 'L1', productionDate: PD, shift: 'A', downtimeIntervals: [{ stopId: 'stop-99', reason: 'quality', durationMinutes: 7 }] })!;
  assert.equal(totalDowntimeMinutes(collectDowntimeIntervals({ records: s1Records, shiftSummaries: [s2Summary] }, NOW)), 17);
});

test('a stop split across two saved slots counts once, in full', () => {
  // 10:45–11:15 split 15/15 over two saved slots, plus the live session.
  const st = stop('maintenance', at(10, 45), at(11, 15));
  const stops = { 3: [st] };
  const recs = [record('L9', 'A', stops, at(10), at(11), at(11, 20)), record('L9', 'A', stops, at(11), at(12), at(12, 1))];
  assert.deepEqual(recs.map((r) => r.stopEvents[0].durationMinutes), [15, 15]);
  const live: DowntimeSessionLike = { lineId: 'L9', productionDate: PD, shift: 'A', stopsBySlot: stops };
  assert.equal(totalDowntimeMinutes(collectDowntimeIntervals({ records: recs, activeSessions: [live] }, NOW)), 30);
  // Session gone, no summary (e.g. legacy): the shares add up to the same 30.
  assert.equal(totalDowntimeMinutes(collectDowntimeIntervals({ records: recs }, NOW)), 30);
});

console.log(`\n${passed} report downtime checks passed`);
