// scripts/testShiftBOvernight.ts
//
// Shift B (7:00 PM – 3:30 AM) crosses midnight but is ONE production day:
// the date it started on. Checks that recording (slot timestamps, record
// IDs, restore, drafts) and reporting (productionRecords range selection)
// keep the whole night on that date, and that Shift B's productive-minute
// rules (dinner, tea, rejection clearance, OT tea) hold on both sides of
// midnight. Every time is a fixed local date — nothing here reads the
// system clock. The project has no test runner, so this is a plain
// node:assert script:  npm run test:shift-b-overnight

import assert from 'node:assert/strict';
import {
  addDaysToKey,
  legacyCreatedAtWindow,
  millisToProductionDayMinute,
  productionDayKeyFor,
  productionDayMinuteToMillis,
  recordProductionDayKey,
  resolveSessionProductionDate,
  selectRecordsInProductionRange,
  StoredRecordRow,
} from '../src/utils/productionDay';
import {
  BREAKS,
  SHIFT_B_DINNER_BREAK,
  SHIFT_B_REJECTION_CLEARANCE,
  SHIFT_B_TEA_BREAK,
  buildSlots,
  changeoverSegmentMinutes,
  expectedPartsFor,
  productiveMinutesIn,
  scheduledNonProductive,
} from '../src/utils/productionSchedule';
import {
  DraftScope,
  DraftStorage,
  createDraft,
  createDraftStore,
  draftStorageKey,
  emptySyncState,
  productionRecordId,
} from '../src/utils/productionDraft';

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}`);
    throw e;
  }
}

// Local wall-clock time, October 2026.
const at = (day: number, h: number, m = 0) => new Date(2026, 9, day, h, m).getTime();
const ts = (ms: number) => ({ toMillis: () => ms });
const ymdhm = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ` +
    `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const NIGHT = '2026-10-21';
const STARTED_MS = at(21, 19, 0);
const SLOTS_B = buildSlots('B', 0);

function memoryStorage(): DraftStorage {
  const map = new Map<string, string>();
  return {
    getItem: async (k) => map.get(k) ?? null,
    setItem: async (k, v) => { map.set(k, v); },
    removeItem: async (k) => { map.delete(k); },
  };
}

// ─── Simulated productionRecords + the two queries of
// services/productionRecordQueries (same predicates Firestore applies). ──
type FakeRecord = { id: string; shift: 'A' | 'B'; productionDate?: string; createdAtMs: number };

function fetchRange(all: FakeRecord[], fromKey: string, toKey: string): string[] {
  const row = (r: FakeRecord): StoredRecordRow<string> => ({ ...r, doc: r.id });
  // where('productionDate', '>=', from) / '<=' to — docs without the field never match.
  const byDate = all.filter((r) => typeof r.productionDate === 'string' && r.productionDate >= fromKey && r.productionDate <= toKey);
  const { startMs, endMs } = legacyCreatedAtWindow(fromKey, toKey);
  const byCreatedAt = all.filter((r) => r.createdAtMs >= startMs && r.createdAtMs < endMs);
  return selectRecordsInProductionRange([byDate.map(row), byCreatedAt.map(row)], fromKey, toKey);
}

// The query the report used before this fix: createdAt within the calendar day(s).
function oldCalendarFetch(all: FakeRecord[], fromKey: string, toKey: string): string[] {
  const start = new Date(`${fromKey}T00:00:00`).getTime();
  const end = new Date(`${toKey}T23:59:59.999`).getTime();
  return all.filter((r) => r.createdAtMs >= start && r.createdAtMs <= end).map((r) => r.id);
}

const RECORDS: FakeRecord[] = [
  // Shift A, Oct 21.
  { id: 'A21-s0', shift: 'A', productionDate: '2026-10-21', createdAtMs: at(21, 8, 2) },
  { id: 'A21-s8', shift: 'A', productionDate: '2026-10-21', createdAtMs: at(21, 15, 35) },
  // Shift B, night of Oct 21: saved before midnight, after midnight, and
  // the rest written by Finalize at 3:40 AM.
  { id: 'B21-s0', shift: 'B', productionDate: NIGHT, createdAtMs: at(21, 20, 3) },
  { id: 'B21-s4', shift: 'B', productionDate: NIGHT, createdAtMs: at(21, 23, 59) },
  { id: 'B21-s5', shift: 'B', productionDate: NIGHT, createdAtMs: at(22, 0, 1) },
  { id: 'B21-s7', shift: 'B', productionDate: NIGHT, createdAtMs: at(22, 3, 40) },
  { id: 'B21-s8', shift: 'B', productionDate: NIGHT, createdAtMs: at(22, 3, 40) },
  // Finalize pressed late, after the 6:30 AM cutover — still the 21st's night.
  { id: 'B21-late', shift: 'B', productionDate: NIGHT, createdAtMs: at(22, 9, 15) },
  // Shift A and Shift B of Oct 22.
  { id: 'A22-s0', shift: 'A', productionDate: '2026-10-22', createdAtMs: at(22, 8, 5) },
  { id: 'B22-s0', shift: 'B', productionDate: '2026-10-22', createdAtMs: at(22, 20, 0) },
  { id: 'B22-s6', shift: 'B', productionDate: '2026-10-22', createdAtMs: at(23, 1, 10) },
  // Legacy records (saved before productionDate existed).
  { id: 'legacy-B21-0030', shift: 'B', createdAtMs: at(22, 0, 30) },
  { id: 'legacy-B21-2200', shift: 'B', createdAtMs: at(21, 22, 0) },
  { id: 'legacy-A22-1000', shift: 'A', createdAtMs: at(22, 10, 0) },
];

(async () => {
  console.log('Shift B overnight production date');

  await test('1. Shift B Oct 21 7:00 PM → Oct 22 3:30 AM: every slot is on Oct 21, timestamps are real', () => {
    const pd = productionDayKeyFor(STARTED_MS);
    assert.equal(pd, NIGHT);
    assert.equal(SLOTS_B.length, 9);
    const first = SLOTS_B[0];
    const last = SLOTS_B[SLOTS_B.length - 1];
    assert.equal(ymdhm(productionDayMinuteToMillis(pd, first.startMinutesAbs)), '2026-10-21 19:00');
    assert.equal(ymdhm(productionDayMinuteToMillis(pd, last.startMinutesAbs)), '2026-10-22 03:00');
    assert.equal(ymdhm(productionDayMinuteToMillis(pd, last.endMinutesAbs)), '2026-10-22 03:30');
    for (const s of SLOTS_B) {
      // The session's pinned date, and the date its own start/end instants resolve to.
      const startMs: number = productionDayMinuteToMillis(pd, s.startMinutesAbs);
      const endMs: number = productionDayMinuteToMillis(pd, s.endMinutesAbs) - 1;
      assert.equal(productionDayKeyFor(startMs), NIGHT, s.label);
      assert.equal(productionDayKeyFor(endMs), NIGHT, s.label);
      assert.equal(millisToProductionDayMinute(pd, startMs), s.startMinutesAbs);
    }
  });

  await test('2. the slots either side of midnight share one production date', () => {
    const before = SLOTS_B.find((s) => s.startMinutesAbs === 23 * 60)!;
    const after = SLOTS_B.find((s) => s.startMinutesAbs === 24 * 60)!;
    assert.equal(before.label, '11:00 PM - 12:00 AM');
    assert.equal(after.label, '12:00 AM - 01:00 AM');
    const beforeMs = productionDayMinuteToMillis(NIGHT, before.startMinutesAbs);
    const afterMs = productionDayMinuteToMillis(NIGHT, after.startMinutesAbs);
    assert.equal(ymdhm(beforeMs), '2026-10-21 23:00');
    assert.equal(ymdhm(afterMs), '2026-10-22 00:00');
    assert.equal(productionDayKeyFor(at(21, 23, 59)), productionDayKeyFor(at(22, 0, 0)));
    assert.equal(productionDayKeyFor(at(22, 0, 0)), NIGHT);
  });

  await test('3. reopening the session after midnight restores Oct 21', () => {
    // restoreSession resolves from the stored session only — the time of
    // reopening is not an input, so 12:05 AM, 3:45 AM or 9:00 AM all give Oct 21.
    assert.equal(resolveSessionProductionDate({ storedDate: NIGHT, startedAt: ts(STARTED_MS) }), NIGHT);
    // Even if the stored date were missing, it is not re-derived from "now"
    // (which after 6:30 AM would be Oct 22).
    assert.equal(productionDayKeyFor(at(22, 9, 0)), '2026-10-22');
    // Older session without productionDate: derived from its original startedAt.
    assert.equal(resolveSessionProductionDate({ startedAt: ts(STARTED_MS) }), NIGHT);
    // Late start entered after midnight still belongs to the night before.
    assert.equal(resolveSessionProductionDate({ startedAt: ts(at(22, 0, 20)) }), NIGHT);
  });

  await test('4. Save Slot before midnight and Finalize after midnight hit the same record', () => {
    const slot = SLOTS_B.find((s) => s.startMinutesAbs === 23 * 60)!;
    // Save Slot at 11:58 PM: pinned date in screen state + activeSessions.
    const atSave = resolveSessionProductionDate({ storedDate: NIGHT, pinnedDate: NIGHT, startedAt: ts(STARTED_MS) })!;
    // Finalize at 3:40 AM, screen reopened (no pinned state).
    const atFinalize = resolveSessionProductionDate({ storedDate: NIGHT, pinnedDate: null, startedAt: ts(STARTED_MS) })!;
    const id = (pd: string) => productionRecordId({ productionDate: pd, lineId: 'line-7', shift: 'B', slotIndex: slot.index, segment: 'full' });
    assert.equal(id(atSave), id(atFinalize));
    // What a calendar-date ID at Finalize would have been — a second record.
    assert.notEqual(id(atSave), id('2026-10-22'));
  });

  await test('5. production-record IDs keep the established format before and after midnight', () => {
    const ids = SLOTS_B.map((s) => productionRecordId({ productionDate: NIGHT, lineId: 'line-7', shift: 'B', slotIndex: s.index, segment: 'full' }));
    assert.equal(ids[0], 'pr|2026-10-21|line-7|B|0|full');
    assert.equal(ids[5], 'pr|2026-10-21|line-7|B|5|full'); // 12:00 – 1:00 AM
    assert.equal(ids[8], 'pr|2026-10-21|line-7|B|8|full'); // 3:00 – 3:30 AM
    assert.equal(SLOTS_B.map((s) => s.index).join(','), '0,1,2,3,4,5,6,7,8');
    assert.equal(
      productionRecordId({ productionDate: NIGHT, lineId: 'line-7', shift: 'B', slotIndex: 5, segment: 'after' }),
      'pr|2026-10-21|line-7|B|5|after'
    );
  });

  await test('6. a draft written before midnight is found after midnight (same session)', async () => {
    const store = createDraftStore(memoryStorage());
    const scope: DraftScope = { uid: 'sup-1', lineId: 'line-7', productionDate: NIGHT, shift: 'B', sessionInstance: 'inst-1' };
    const local = { ...emptySyncState(), producedBySlot: { '4': 118 } };
    assert.equal(await store.save(createDraft(scope, emptySyncState(), 3, local, at(21, 23, 50), 4)), true);
    // After midnight the scope is rebuilt from the session, not the clock.
    const reopened: DraftScope = {
      ...scope,
      productionDate: resolveSessionProductionDate({ storedDate: NIGHT, startedAt: ts(STARTED_MS) })!,
    };
    assert.equal(draftStorageKey(reopened), draftStorageKey(scope));
    const loaded = await store.load(reopened);
    assert.ok(loaded.ok);
    if (loaded.ok) assert.equal(loaded.draft.local.producedBySlot['4'], 118);
    // A calendar-date scope would not match it: it is a different session key.
    const wrong = await store.load({ ...scope, productionDate: '2026-10-22' });
    assert.equal(wrong.ok, false);
  });

  await test('7. report for Oct 21 includes the whole Shift B, after-midnight records included', () => {
    const got = fetchRange(RECORDS, NIGHT, NIGHT);
    assert.deepEqual(got, [
      'A21-s0', 'A21-s8', 'B21-s0', 'legacy-B21-2200', 'B21-s4', 'B21-s5', 'legacy-B21-0030', 'B21-s7', 'B21-s8', 'B21-late',
    ]);
    // Before the fix: the after-midnight and late-Finalize records were dropped.
    const old = oldCalendarFetch(RECORDS, NIGHT, NIGHT);
    for (const id of ['B21-s5', 'B21-s7', 'B21-s8', 'B21-late', 'legacy-B21-0030']) assert.ok(!old.includes(id), id);
  });

  await test('8. report for Oct 22 does not pick up the previous night\'s Shift B', () => {
    const got = fetchRange(RECORDS, '2026-10-22', '2026-10-22');
    assert.deepEqual(got, ['A22-s0', 'legacy-A22-1000', 'B22-s0', 'B22-s6']);
    // Before the fix: Oct 21's after-midnight Shift B showed up on Oct 22,
    // and Oct 22's own after-midnight slot was missing.
    const old = oldCalendarFetch(RECORDS, '2026-10-22', '2026-10-22');
    assert.ok(old.includes('B21-s5') && old.includes('B21-late'));
    assert.ok(!old.includes('B22-s6'));
    // A multi-day range holds each record exactly once.
    const both = fetchRange(RECORDS, NIGHT, '2026-10-22');
    assert.equal(both.length, new Set(both).size);
    assert.equal(both.length, RECORDS.length);
  });

  await test('9. Shift A keeps its existing calendar-day behaviour', () => {
    for (const h of [7, 9, 12, 15]) assert.equal(productionDayKeyFor(at(22, h, 0)), '2026-10-22');
    const slotsA = buildSlots('A', 0);
    for (const s of slotsA) assert.equal(productionDayKeyFor(productionDayMinuteToMillis('2026-10-22', s.startMinutesAbs)), '2026-10-22');
    // Legacy (no productionDate) Shift A records still use their calendar day.
    assert.equal(recordProductionDayKey({ shift: 'A', createdAtMs: at(22, 10, 0) }), '2026-10-22');
    assert.equal(recordProductionDayKey({ shift: 'A', createdAtMs: at(22, 2, 0) }), '2026-10-22');
    // A stored productionDate always wins, for every shift.
    assert.equal(recordProductionDayKey({ shift: 'A', productionDate: '2026-10-21', createdAtMs: at(22, 10, 0) }), '2026-10-21');
    assert.equal(recordProductionDayKey({ shift: 'B', productionDate: 'bogus', createdAtMs: at(22, 1, 0) }), NIGHT);
    assert.equal(recordProductionDayKey({ shift: 'B', createdAtMs: null }), null);
    assert.equal(addDaysToKey('2026-10-31', 1), '2026-11-01');
  });

  // ─── Confirmed Shift B productive-minute rules ──────────────────────────
  const t = (h: number, m = 0) => h * 60 + m; // absolute minutes; Shift B's mornings are 24+
  const minutesByLabel = (slots: ReturnType<typeof buildSlots>) =>
    Object.fromEntries(slots.map((s) => [s.label, s.productiveMinutes]));

  await test('10. Shift B regular slots: confirmed productive minutes', () => {
    assert.deepEqual(minutesByLabel(SLOTS_B), {
      '07:00 PM - 08:00 PM': 50, // startup reserve only
      '08:00 PM - 09:00 PM': 60,
      '09:00 PM - 10:00 PM': 45, // dinner 9:45–10:00
      '10:00 PM - 11:00 PM': 45, // dinner 10:00–10:15
      '11:00 PM - 12:00 AM': 60,
      '12:00 AM - 01:00 AM': 60,
      '01:00 AM - 02:00 AM': 50, // tea 1:30–1:40
      '02:00 AM - 03:00 AM': 60,
      '03:00 AM - 03:30 AM (partial)': 20, // rejection clearance 3:20–3:30
    });
    assert.deepEqual(SLOTS_B.map((s) => s.index), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  await test('11. dinner 9:45–10:15 PM is counted once across 9–10 and 10–11 PM', () => {
    const np = scheduledNonProductive('B', 0);
    assert.equal(productiveMinutesIn(t(21), t(22), np), 45);
    assert.equal(productiveMinutesIn(t(22), t(23), np), 45);
    assert.equal(productiveMinutesIn(t(21), t(23), np), 90); // 120 − 30, not 120 − 60
    // Whole shift: 510 wall minutes − 10 startup − 30 dinner − 10 tea − 10 clearance.
    assert.equal(SLOTS_B.reduce((sum, s) => sum + s.productiveMinutes, 0), 450);
  });

  await test('12. 7–8 PM keeps one startup reserve; tea applies to 1–2 AM only', () => {
    const np = scheduledNonProductive('B', 0);
    assert.equal(np.filter((iv) => iv.start < t(20) && iv.end > t(19)).length, 1);
    assert.equal(productiveMinutesIn(t(19), t(20), np), 50);
    assert.equal(productiveMinutesIn(t(25), t(25, 30), np), 30);
    assert.equal(productiveMinutesIn(t(25, 30), t(25, 40), np), 0);
    assert.equal(productiveMinutesIn(t(24), t(25), np), 60);
    assert.equal(productiveMinutesIn(t(26), t(27), np), 60);
  });

  await test('13. overtime: boundaries unchanged, 4–5 AM = 50, no other new deductions', () => {
    assert.equal(SLOTS_B[SLOTS_B.length - 1].endMinutesAbs, t(27, 30)); // no OT ends 3:30 AM
    assert.deepEqual(minutesByLabel(buildSlots('B', 1)), {
      ...minutesByLabel(SLOTS_B.slice(0, 8)),
      '03:00 AM - 04:00 AM': 60,
      '04:00 AM - 04:30 AM (partial)': 30, // ends before the 4:30 tea break
    });
    assert.deepEqual(minutesByLabel(buildSlots('B', 2)), {
      ...minutesByLabel(SLOTS_B.slice(0, 8)),
      '03:00 AM - 04:00 AM': 60,
      '04:00 AM - 05:00 AM': 50, // tea 4:30–4:40
      '05:00 AM - 05:30 AM (partial)': 30,
    });
    // The regular slots' indices and windows don't move with OT; OT slots follow on.
    for (const ot of [1, 2, 3, 4]) {
      const s = buildSlots('B', ot);
      assert.deepEqual(s.slice(0, 8).map((x) => [x.index, x.startMinutesAbs, x.endMinutesAbs]),
        SLOTS_B.slice(0, 8).map((x) => [x.index, x.startMinutesAbs, x.endMinutesAbs]));
      assert.equal(s[8].index, 8);
      assert.equal(s[8].startMinutesAbs, t(27));
    }
  });

  await test('14. rejection clearance is not silently moved into the OT 3:00–4:00 AM hour', () => {
    // Pending decision: with OT the slot-8 window is 3:00–4:00 AM, and it
    // keeps its previous 60 minutes — no 3:20–3:30 deduction is applied.
    const s8 = buildSlots('B', 1)[8];
    assert.equal(s8.label, '03:00 AM - 04:00 AM');
    assert.equal(s8.productiveMinutes, 60);
    assert.equal(productiveMinutesIn(t(27, 20), t(27, 30), scheduledNonProductive('B', 1)), 10);
    assert.equal(productiveMinutesIn(t(27, 20), t(27, 30), scheduledNonProductive('B', 0)), 0);
  });

  await test('15. changeovers: breaks and changeover time are never double-counted', () => {
    // A changeover inside dinner costs nothing extra.
    const inDinner = { start: t(21, 50), end: t(22, 5) };
    const s1 = buildSlots('B', 0, [inDinner]);
    assert.equal(s1[2].productiveMinutes, 45);
    assert.equal(s1[3].productiveMinutes, 45);
    // A part switch at 9:30 PM: BEFORE 9:00–9:30, AFTER 9:30–10:00 minus dinner.
    const at930 = { start: t(21, 30), end: t(21, 30) };
    const seg = changeoverSegmentMinutes(SLOTS_B[2], at930, [...scheduledNonProductive('B', 0), at930]);
    assert.equal(seg.beforeMinutes, 30);
    assert.equal(seg.afterMinutes, 15);
    // A part switch at 1:20 AM: AFTER loses the tea break.
    const at120 = { start: t(25, 20), end: t(25, 20) };
    const seg2 = changeoverSegmentMinutes(SLOTS_B[6], at120, [...scheduledNonProductive('B', 0), at120]);
    assert.equal(seg2.beforeMinutes, 20);
    assert.equal(seg2.afterMinutes, 30);
    assert.equal(seg2.beforeMinutes + seg2.afterMinutes, SLOTS_B[6].productiveMinutes);
    // A 12:20–12:30 AM changeover still takes its own 10 minutes.
    const co = { start: t(24, 20), end: t(24, 30) };
    const withCo = buildSlots('B', 0, [co]);
    assert.equal(withCo[5].productiveMinutes, 50);
    assert.equal(withCo[5].index, 5);
    // BEFORE/AFTER records stay separate, on the same slot index.
    const id = (segment: 'before' | 'after') =>
      productionRecordId({ productionDate: NIGHT, lineId: 'line-7', shift: 'B', slotIndex: 6, segment });
    assert.equal(id('before'), 'pr|2026-10-21|line-7|B|6|before');
    assert.equal(id('after'), 'pr|2026-10-21|line-7|B|6|after');
    assert.equal(expectedPartsFor(45, seg2.afterMinutes), 40);
  });

  await test('16. crossing midnight does not change the rules; real break times are next-day', () => {
    // Rules live in the shift's minute frame, not on a calendar date.
    assert.deepEqual(buildSlots('B', 0), SLOTS_B);
    assert.equal(ymdhm(productionDayMinuteToMillis(NIGHT, SHIFT_B_TEA_BREAK.start)), '2026-10-22 01:30');
    assert.equal(ymdhm(productionDayMinuteToMillis(NIGHT, SHIFT_B_REJECTION_CLEARANCE.start)), '2026-10-22 03:20');
    assert.equal(ymdhm(productionDayMinuteToMillis('2026-10-31', SHIFT_B_DINNER_BREAK.end)), '2026-10-31 22:15');
    assert.equal(ymdhm(productionDayMinuteToMillis('2026-10-31', SHIFT_B_TEA_BREAK.end)), '2026-11-01 01:40');
    // A session started late, after midnight, keeps the same slot rules.
    const late = buildSlots('B', 0, [], t(24, 45));
    assert.equal(late[0].index, 5);
    assert.equal(late.find((s) => s.index === 6)!.productiveMinutes, 50);
    assert.equal(late.find((s) => s.index === 8)!.productiveMinutes, 20);
    // 2h overtime still files under the same night.
    const ot = buildSlots('B', 2);
    const lastOt = ot[ot.length - 1];
    assert.equal(ymdhm(productionDayMinuteToMillis(NIGHT, lastOt.endMinutesAbs)), '2026-10-22 05:30');
    assert.equal(productionDayKeyFor(productionDayMinuteToMillis(NIGHT, lastOt.endMinutesAbs) - 1), NIGHT);
  });

  await test('17. Shift A schedule, breaks and targets are unchanged', () => {
    assert.deepEqual(scheduledNonProductive('A', 0), [...BREAKS, { start: t(7), end: t(7, 10) }]);
    assert.deepEqual(buildSlots('A', 0).map((s) => s.productiveMinutes), [50, 60, 50, 60, 75, 0, 75, 50, 30]);
    assert.deepEqual(buildSlots('A', 2).map((s) => s.productiveMinutes), [50, 60, 50, 60, 75, 0, 75, 50, 60, 60, 30]);
    assert.equal(expectedPartsFor(45, 60), 80);
    assert.equal(expectedPartsFor(45, 30), 40);
  });

  // ─── Every regular and overtime slot keeps the shift's start date ──────
  const calendarDay = (ms: number) => ymdhm(ms).slice(0, 10);

  await test('18. every slot for OT 0–4 is filed under Oct 21, with real timestamps', () => {
    const pd = resolveSessionProductionDate({ storedDate: NIGHT, startedAt: ts(STARTED_MS) })!;
    assert.equal(pd, NIGHT);
    for (const ot of [0, 1, 2, 3, 4]) {
      const slots = buildSlots('B', ot);
      assert.deepEqual(slots.map((s) => s.index), Array.from({ length: 9 + ot }, (_, i) => i), `OT ${ot}`);
      assert.equal(slots[slots.length - 1].endMinutesAbs, t(27, 30) + ot * 60);
      for (const s of slots) {
        const startMs = productionDayMinuteToMillis(pd, s.startMinutesAbs);
        const endMs = productionDayMinuteToMillis(pd, s.endMinutesAbs);
        // Real timestamps: before midnight on the 21st, after it on the 22nd.
        assert.equal(calendarDay(startMs), s.startMinutesAbs < t(24) ? '2026-10-21' : '2026-10-22', s.label);
        // (11 PM – 12 AM ends at 00:00, which is already the 22nd.)
        assert.equal(calendarDay(endMs), s.endMinutesAbs < t(24) ? '2026-10-21' : '2026-10-22', s.label);
        // Record identity always carries the session's date.
        assert.equal(
          productionRecordId({ productionDate: pd, lineId: 'line-7', shift: 'B', slotIndex: s.index, segment: 'full' }),
          `pr|2026-10-21|line-7|B|${s.index}|full`
        );
      }
    }
    // Why the date must come from the session, never from a slot's time:
    // with 4h OT the 6–7 AM slot crosses the 6:30 AM cutover and 7–7:30 AM
    // is entirely past it, where the clock alone would say Oct 22.
    const ot4 = buildSlots('B', 4);
    assert.equal(ot4[12].label, '07:00 AM - 07:30 AM (partial)');
    assert.equal(productionDayKeyFor(productionDayMinuteToMillis(NIGHT, ot4[11].startMinutesAbs)), NIGHT);
    assert.equal(productionDayKeyFor(productionDayMinuteToMillis(NIGHT, ot4[11].endMinutesAbs) - 1), '2026-10-22');
    assert.equal(productionDayKeyFor(productionDayMinuteToMillis(NIGHT, ot4[12].startMinutesAbs)), '2026-10-22');
  });

  await test('19. OT 3h/4h slots keep their existing productive minutes', () => {
    assert.deepEqual(buildSlots('B', 3).slice(8).map((s) => [s.label, s.productiveMinutes]), [
      ['03:00 AM - 04:00 AM', 60], ['04:00 AM - 05:00 AM', 50], ['05:00 AM - 06:00 AM', 60],
      ['06:00 AM - 06:30 AM (partial)', 30],
    ]);
    assert.deepEqual(buildSlots('B', 4).slice(8).map((s) => [s.label, s.productiveMinutes]), [
      ['03:00 AM - 04:00 AM', 60], ['04:00 AM - 05:00 AM', 50], ['05:00 AM - 06:00 AM', 60],
      ['06:00 AM - 07:00 AM', 60], ['07:00 AM - 07:30 AM (partial)', 30],
    ]);
    // Regular slots are identical whatever the OT.
    for (const ot of [1, 2, 3, 4]) {
      assert.deepEqual(buildSlots('B', ot).slice(0, 8), SLOTS_B.slice(0, 8));
    }
  });

  await test('20. reopening at 7:20 AM during 4h OT restores Oct 21 and the same draft', async () => {
    // Stored date, legacy session (startedAt only) and screen-pinned date all agree.
    assert.equal(resolveSessionProductionDate({ storedDate: NIGHT, startedAt: ts(STARTED_MS) }), NIGHT);
    assert.equal(resolveSessionProductionDate({ startedAt: ts(STARTED_MS) }), NIGHT);
    assert.equal(resolveSessionProductionDate({ storedDate: NIGHT, pinnedDate: null, startedAt: ts(STARTED_MS) }), NIGHT);
    assert.equal(productionDayKeyFor(at(22, 7, 20)), '2026-10-22'); // what "now" would wrongly give
    const store = createDraftStore(memoryStorage());
    const scope: DraftScope = { uid: 'sup-1', lineId: 'line-7', productionDate: NIGHT, shift: 'B', sessionInstance: 'inst-1' };
    await store.save(createDraft(scope, emptySyncState(), 9, { ...emptySyncState(), otHours: 4, producedBySlot: { '11': 77 } }, at(22, 6, 55), 10));
    const reopened = { ...scope, productionDate: resolveSessionProductionDate({ storedDate: NIGHT, startedAt: ts(STARTED_MS) })! };
    const loaded = await store.load(reopened);
    assert.ok(loaded.ok);
    if (loaded.ok) assert.equal(loaded.draft.local.producedBySlot['11'], 77);
  });

  await test('21. OT slots: Save Slot and Finalize after the cutover hit the same record', () => {
    const pdAtSave = resolveSessionProductionDate({ storedDate: NIGHT, pinnedDate: NIGHT, startedAt: ts(STARTED_MS) })!; // 7:31 AM
    const pdAtFinalize = resolveSessionProductionDate({ storedDate: NIGHT, startedAt: ts(STARTED_MS) })!; // 7:40 AM, reopened
    const id = (pd: string, slotIndex: number, segment: 'full' | 'before' | 'after' = 'full') =>
      productionRecordId({ productionDate: pd, lineId: 'line-7', shift: 'B', slotIndex, segment });
    assert.equal(id(pdAtSave, 12), id(pdAtFinalize, 12));
    assert.equal(id(pdAtSave, 12), 'pr|2026-10-21|line-7|B|12|full');
    // A part switch at 5:20 AM (OT slot 10): separate BEFORE/AFTER records.
    const ot4 = buildSlots('B', 4);
    const at520 = { start: t(29, 20), end: t(29, 20) };
    const seg = changeoverSegmentMinutes(ot4[10], at520, [...scheduledNonProductive('B', 4), at520]);
    assert.equal(seg.beforeMinutes, 20);
    assert.equal(seg.afterMinutes, 40);
    assert.notEqual(id(NIGHT, 10, 'before'), id(NIGHT, 10, 'after'));
    assert.equal(id(NIGHT, 10, 'after'), 'pr|2026-10-21|line-7|B|10|after');
  });

  await test('22. reports: OT records saved after 6:30 AM stay on Oct 21', () => {
    const withOt: FakeRecord[] = [
      ...RECORDS,
      { id: 'B21-ot10', shift: 'B', productionDate: NIGHT, createdAtMs: at(22, 6, 2) },
      { id: 'B21-ot11', shift: 'B', productionDate: NIGHT, createdAtMs: at(22, 7, 1) },
      { id: 'B21-ot12', shift: 'B', productionDate: NIGHT, createdAtMs: at(22, 7, 35) },
    ];
    const oct21 = fetchRange(withOt, NIGHT, NIGHT);
    for (const id of ['B21-ot10', 'B21-ot11', 'B21-ot12']) assert.ok(oct21.includes(id), id);
    const oct22 = fetchRange(withOt, '2026-10-22', '2026-10-22');
    for (const id of ['B21-ot10', 'B21-ot11', 'B21-ot12', 'B21-s5', 'B21-late']) assert.ok(!oct22.includes(id), id);
    const both = fetchRange(withOt, NIGHT, '2026-10-22');
    assert.equal(both.length, new Set(both).size);
    assert.equal(both.length, withOt.length);
  });

  console.log(`\n${passed} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
