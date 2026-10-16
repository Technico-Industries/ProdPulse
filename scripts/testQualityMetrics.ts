// scripts/testQualityMetrics.ts
//
// Checks for src/utils/qualityMetrics.ts — the quality formula and its data
// source, the Record Production rejection counter (productionRecords
// .rejections). The project has no test runner, so this is a plain
// node:assert script:  npm run test:quality

import assert from 'node:assert/strict';
import { CounterRecord, computeQuality, counterQuality } from '../src/utils/qualityMetrics';

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

const rec = (producedThisSlot: number | null, rejections?: number | null): CounterRecord => ({
  producedThisSlot,
  rejections,
});

test('1. 5,610 good + 97 rejections → ≈98.3%, not 100%', () => {
  const q = computeQuality(5610, 97);
  assert.equal(q.goodParts, 5610);
  assert.equal(q.rejectedParts, 97);
  assert.equal(q.inspectedParts, 5707);
  assert.equal(q.qualityPct, 98.3);
  assert.equal(q.rejectionPct, 1.7);
});

test('2. zero rejections with production → 100%', () => {
  const q = computeQuality(500, 0);
  assert.equal(q.qualityPct, 100);
  assert.equal(q.rejectionPct, 0);
});

test('3. everything rejected → 0%', () => {
  const q = computeQuality(0, 40);
  assert.equal(q.qualityPct, 0);
  assert.equal(q.rejectionPct, 100);
  assert.equal(q.goodParts, 0);
});

test('4. no production and no rejections → unavailable, not 0% or 100%', () => {
  const q = computeQuality(0, 0);
  assert.equal(q.qualityPct, null);
  assert.equal(q.rejectionPct, null);
});

test('5. unknown rejections (null) → quality unknown, never 100%', () => {
  const q = computeQuality(5610, null);
  assert.equal(q.qualityPct, null);
  assert.equal(q.rejectionPct, null);
  assert.equal(q.rejectedParts, null);
  assert.equal(q.goodParts, 5610);
});

test('quality + rejection % always add up to 100', () => {
  for (const [good, rej] of [[5610, 97], [3, 1], [1000, 333], [7, 7], [1, 999]]) {
    const q = computeQuality(good, rej);
    assert.equal(Math.round((q.qualityPct! + q.rejectionPct!) * 10) / 10, 100);
  }
});

test('good parts never negative', () => {
  assert.equal(computeQuality(-5, 3).goodParts, 0);
  assert.equal(computeQuality(-5, 3).qualityPct, 0);
});

test('6. counter: 100 produced + 5 rejected → 105 inspected, 4.8% / 95.2%', () => {
  // producedThisSlot is the GOOD output, so the rejected parts come on top.
  const q = counterQuality([rec(100, 5)]);
  assert.equal(q.goodParts, 100);
  assert.equal(q.rejectedParts, 5);
  assert.equal(q.inspectedParts, 105);
  assert.equal(q.rejectionPct, 4.8);
  assert.equal(q.qualityPct, 95.2);
  assert.equal(q.legacyRecords, 0);
});

test('7. quantities are summed across slots before the percentage', () => {
  // Slot rates 0% and 10% would average 5%; the true figure is 10 / 110.
  const q = counterQuality([rec(10, 0), rec(90, 10)]);
  assert.equal(q.rejectedParts, 10);
  assert.equal(q.inspectedParts, 110);
  assert.equal(q.rejectionPct, 9.1);
});

test('8. legacy records without the counter are left out, not read as 0', () => {
  const q = counterQuality([rec(100, 5), rec(400), rec(300, null)]);
  assert.equal(q.goodParts, 100);
  assert.equal(q.rejectedParts, 5);
  assert.equal(q.inspectedParts, 105);
  assert.equal(q.legacyRecords, 2);
});

test('9. only legacy records → unavailable, never 100%', () => {
  const q = counterQuality([rec(400), rec(300, null)]);
  assert.equal(q.rejectedParts, null);
  assert.equal(q.qualityPct, null);
  assert.equal(q.legacyRecords, 2);
});

test('10. no records / zero production → unavailable, no division by zero', () => {
  assert.equal(counterQuality([]).qualityPct, null);
  assert.equal(counterQuality([]).rejectedParts, 0);
  const z = counterQuality([rec(0, 0), rec(null, 0)]);
  assert.equal(z.inspectedParts, 0);
  assert.equal(z.qualityPct, null);
  assert.equal(z.rejectionPct, null);
});

test('11. bad counter values are ignored, not NaN', () => {
  // NaN counter → legacy; negative counter → 0; NaN produced → 0 good.
  const q = counterQuality([rec(50, NaN), rec(50, -3), rec(NaN, 2), rec(48, 2)]);
  assert.equal(q.legacyRecords, 1);
  assert.equal(q.rejectedParts, 4);
  assert.equal(q.goodParts, 98);
  assert.equal(q.qualityPct, 96.1);
});

test('12. expectedParts plays no part in quality', () => {
  const withTarget = { ...rec(100, 5), expectedParts: 999 } as CounterRecord;
  assert.deepEqual(counterQuality([withTarget]), counterQuality([rec(100, 5)]));
});

console.log(`\n${passed} passed`);
