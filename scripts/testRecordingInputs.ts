// scripts/testRecordingInputs.ts
//
// Checks for the Record Production rejection counter (typed / − / +,
// src/utils/rejectionCount.ts) and the Record Rejection date default
// (src/utils/rejectionDate.ts). Plain node:assert script:
//   npm run test:recording-inputs

import assert from 'node:assert/strict';
import {
  MAX_REJECTION_COUNT,
  parseRejectionCount,
  rejectionFieldText,
  stepRejectionCount,
} from '../src/utils/rejectionCount';
import { initialRejectionDate, isValidDateKey, localDateKey } from '../src/utils/rejectionDate';

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

// The screen's counter, without React: a stored count plus the field's
// typed text, driven exactly the way RejectionCounter drives them.
function counter(initial = 0) {
  let value = initial;
  let typed: string | null = null;
  return {
    get value() { return value; },
    get shown() { return rejectionFieldText(value, typed); },
    focus() { typed = String(value); },
    type(t: string) {
      const n = parseRejectionCount(t);
      if (n === null) return; // rejected keystroke
      typed = t;
      value = n;
    },
    blur() { typed = null; },
    plus() { typed = null; value = stepRejectionCount(value, 1); },
    minus() { typed = null; value = stepRejectionCount(value, -1); },
  };
}

test('parse: whole numbers ≥ 0 only; empty means 0', () => {
  assert.equal(parseRejectionCount(''), 0);
  assert.equal(parseRejectionCount('0'), 0);
  assert.equal(parseRejectionCount('7'), 7);
  assert.equal(parseRejectionCount(' 12 '), 12);
  assert.equal(parseRejectionCount('007'), 7);
  assert.equal(parseRejectionCount(String(MAX_REJECTION_COUNT)), MAX_REJECTION_COUNT);
  for (const bad of ['-1', '1.5', '1e3', 'abc', '12a', '+3', String(MAX_REJECTION_COUNT + 1), '９']) {
    assert.equal(parseRejectionCount(bad), null, bad);
  }
});

test('step: − never goes below 0; damaged stored values count as 0', () => {
  assert.equal(stepRejectionCount(0, -1), 0);
  assert.equal(stepRejectionCount(1, -1), 0);
  assert.equal(stepRejectionCount(4, 1), 5);
  assert.equal(stepRejectionCount(undefined, 1), 1);
  assert.equal(stepRejectionCount(null, -1), 0);
  assert.equal(stepRejectionCount(-5 as number, 1), 1);
  assert.equal(stepRejectionCount(NaN, 1), 1);
  assert.equal(stepRejectionCount(MAX_REJECTION_COUNT, 1), MAX_REJECTION_COUNT);
});

test('typing, + and − stay in sync', () => {
  const c = counter(0);
  c.plus(); c.plus();
  assert.equal(c.value, 2);
  assert.equal(c.shown, '2');
  // Type 15: field and stored count agree.
  c.focus(); c.type(''); c.type('1'); c.type('15');
  assert.equal(c.value, 15);
  assert.equal(c.shown, '15');
  // + while typing → 16 shown at once; − → 15.
  c.plus();
  assert.equal(c.shown, '16');
  c.minus();
  assert.equal(c.value, 15);
  assert.equal(c.shown, '15');
  // Down to 0 and no further.
  c.focus(); c.type('1'); c.minus(); c.minus();
  assert.equal(c.value, 0);
  assert.equal(c.shown, '0');
});

test('invalid input is rejected and the count is kept', () => {
  const c = counter(8);
  c.focus();
  c.type('8-'); c.type('-8'); c.type('8.5'); c.type('x');
  assert.equal(c.value, 8);
  assert.equal(c.shown, '8');
  // Clearing the field: 0 while empty, shown as 0 once the field is left.
  c.type('');
  assert.equal(c.value, 0);
  assert.equal(c.shown, '');
  c.blur();
  assert.equal(c.shown, '0');
});

test('the saved count is the final count, whatever path set it', () => {
  // What Save Slot / Finalize write: rejectionsBySlot[key] ?? 0.
  const rejectionsBySlot: Record<string, number> = {};
  const c = counter(rejectionsBySlot['3'] ?? 0);
  c.plus(); c.plus(); c.plus();
  c.focus(); c.type('42');
  c.minus();
  rejectionsBySlot['3'] = c.value;
  assert.equal(rejectionsBySlot['3'] ?? 0, 41);
  // A count changed elsewhere (another device) replaces what is shown once
  // the field isn't being typed in.
  const d = counter(5);
  d.focus(); d.type('5');
  assert.equal(rejectionFieldText(9, '5'), '9');
});

test('rejection date: new entries open on today\'s local date', () => {
  const now = new Date(2026, 9, 27, 0, 5).getTime(); // just after local midnight
  assert.equal(localDateKey(now), '2026-10-27');
  assert.equal(initialRejectionDate(null, now), '2026-10-27');
  assert.equal(initialRejectionDate(undefined, new Date(2026, 0, 3, 23, 59).getTime()), '2026-01-03');
  // A date left over from an earlier visit is not passed in — and anything
  // invalid falls back to today.
  assert.equal(initialRejectionDate('2026-02-31', now), '2026-10-27');
  assert.equal(initialRejectionDate('27-10-2026', now), '2026-10-27');
});

test('rejection date: an existing record keeps its own date', () => {
  const now = new Date(2026, 9, 27, 10).getTime();
  assert.equal(initialRejectionDate('2026-10-20', now), '2026-10-20');
  assert.equal(isValidDateKey('2026-10-20'), true);
  assert.equal(isValidDateKey('2026-13-01'), false);
  assert.equal(isValidDateKey('2026-02-29'), false);
  assert.equal(isValidDateKey('2028-02-29'), true);
  assert.equal(isValidDateKey(null), false);
});

console.log(`\n${passed} recording input checks passed`);
