// scripts/testProductionDay.ts
//
// Checks for the production-day / session date pinning rules in
// src/utils/productionDay.ts. The project has no test runner, so this is a
// plain node:assert script:  npm run test:production-day

import assert from 'node:assert/strict';
import {
  productionDayKeyFor,
  resolveSessionProductionDate,
  timestampToMillis,
} from '../src/utils/productionDay';

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

// Local wall-clock time (productionDayKeyFor works in device-local time).
const at = (month: number, day: number, h: number, m = 0) => new Date(2026, month - 1, day, h, m).getTime();
// Shape of a Firestore Timestamp, as read back from activeSessions.startedAt.
const ts = (ms: number) => ({ toMillis: () => ms });

test('cutover: before 6:30 AM belongs to the previous production day', () => {
  assert.equal(productionDayKeyFor(at(10, 15, 6, 29)), '2026-10-14');
  assert.equal(productionDayKeyFor(at(10, 15, 6, 30)), '2026-10-15');
  assert.equal(productionDayKeyFor(at(10, 14, 23, 59)), '2026-10-14');
  assert.equal(productionDayKeyFor(at(10, 15, 0, 0)), '2026-10-14');
});

test('1. started Oct 14, finalized Oct 15 → Oct 14', () => {
  const startedMs = at(10, 14, 9, 0);
  const pinned = productionDayKeyFor(startedMs);
  const finalizeMs = at(10, 15, 11, 0);
  assert.equal(productionDayKeyFor(finalizeMs), '2026-10-15'); // what the old fallback would have used
  const pd = resolveSessionProductionDate({ storedDate: pinned, pinnedDate: pinned, startedAt: ts(startedMs) });
  assert.equal(pd, '2026-10-14');
});

test('2. slots saved Oct 14 and the rest finalized Oct 15 share one date', () => {
  const startedAt = ts(at(10, 14, 9, 0));
  const stored = '2026-10-14';
  // saveSlot on Oct 14 and Finalize on Oct 15 both resolve from the session.
  const atSave = resolveSessionProductionDate({ storedDate: stored, pinnedDate: stored, startedAt });
  const atFinalize = resolveSessionProductionDate({ storedDate: stored, pinnedDate: null, startedAt });
  assert.equal(atSave, '2026-10-14');
  assert.equal(atFinalize, atSave);
});

test('3. Shift B started Oct 14 7 PM, finalized after midnight → Oct 14', () => {
  const startedMs = at(10, 14, 19, 0);
  const stored = productionDayKeyFor(startedMs);
  assert.equal(stored, '2026-10-14');
  assert.equal(resolveSessionProductionDate({ storedDate: stored, startedAt: ts(startedMs) }), '2026-10-14');
  // Even if Finalize is pressed late, after the 6:30 AM cutover.
  assert.equal(productionDayKeyFor(at(10, 15, 8, 0)), '2026-10-15');
  assert.equal(resolveSessionProductionDate({ storedDate: stored, startedAt: ts(startedMs) }), '2026-10-14');
});

test('4. restoring on Oct 15 keeps the stored date (no pinned state yet)', () => {
  assert.equal(
    resolveSessionProductionDate({ storedDate: '2026-10-14', pinnedDate: null, startedAt: ts(at(10, 14, 9, 0)) }),
    '2026-10-14'
  );
});

test('5. missing productionDate → derived from original startedAt', () => {
  assert.equal(resolveSessionProductionDate({ startedAt: ts(at(10, 14, 9, 0)) }), '2026-10-14');
  // Shift B session started after midnight but before the cutover.
  assert.equal(resolveSessionProductionDate({ startedAt: ts(at(10, 15, 2, 0)) }), '2026-10-14');
  // Invalid stored values are ignored, not trusted.
  assert.equal(resolveSessionProductionDate({ storedDate: '', startedAt: ts(at(10, 14, 9, 0)) }), '2026-10-14');
  assert.equal(resolveSessionProductionDate({ storedDate: 123, startedAt: ts(at(10, 14, 9, 0)) }), '2026-10-14');
});

test('6. stored date wins over pinned state, pinned state over startedAt', () => {
  assert.equal(
    resolveSessionProductionDate({ storedDate: '2026-10-14', pinnedDate: '2026-10-15', startedAt: ts(at(10, 15, 9, 0)) }),
    '2026-10-14'
  );
  assert.equal(
    resolveSessionProductionDate({ storedDate: undefined, pinnedDate: '2026-10-14', startedAt: ts(at(10, 15, 9, 0)) }),
    '2026-10-14'
  );
});

test('7. a new session gets its own production date', () => {
  assert.equal(productionDayKeyFor(at(10, 15, 7, 0)), '2026-10-15');
  assert.equal(productionDayKeyFor(at(10, 15, 19, 0)), '2026-10-15');
});

test('nothing to resolve from → null (callers never substitute now)', () => {
  assert.equal(resolveSessionProductionDate({}), null);
  // Pending serverTimestamp reads back as null.
  assert.equal(resolveSessionProductionDate({ storedDate: null, pinnedDate: null, startedAt: null }), null);
});

test('timestampToMillis', () => {
  const ms = at(10, 14, 9, 0);
  assert.equal(timestampToMillis(ts(ms)), ms);
  assert.equal(timestampToMillis(new Date(ms)), ms);
  assert.equal(timestampToMillis(ms), ms);
  assert.equal(timestampToMillis(null), null);
  assert.equal(timestampToMillis({}), null);
  assert.equal(timestampToMillis(NaN), null);
});

console.log(`\n${passed} passed`);
