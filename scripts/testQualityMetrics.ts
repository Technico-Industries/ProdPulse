// scripts/testQualityMetrics.ts
//
// Checks for the admin dashboard's first-pass quality in
// src/utils/qualityMetrics.ts. The project has no test runner, so this is a
// plain node:assert script:  npm run test:quality

import assert from 'node:assert/strict';
import {
  QcRejectionRecord,
  computeQuality,
  filterQcRecords,
  sumRejectionQty,
} from '../src/utils/qualityMetrics';

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

const qc = (over: Partial<QcRejectionRecord>): QcRejectionRecord => ({
  date: '2026-10-14',
  lineId: null,
  plant: null,
  workshop: null,
  division: null,
  rejectionQty: 0,
  ...over,
});

test('1. 5,610 good + 97 QC rejections → ≈98.3%, not 100%', () => {
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

test('5. failed QC read (null) → quality unknown, never 100%', () => {
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

test('6. filters narrow QC rejections the same way as production', () => {
  const lines = [
    { id: 'L1', plant: 'Plant 1', workshop: 'Assembly', division: 'Div A' },
    { id: 'L2', plant: 'Plant 2', workshop: 'Machining', division: null },
  ];
  const records = [
    qc({ lineId: 'L1', rejectionQty: 10 }),
    // Stamped location is wrong; the line's productionLines doc wins.
    qc({ lineId: 'L2', plant: 'Plant 1', rejectionQty: 5 }),
    // Line since deleted → its own stamped fields are used.
    qc({ lineId: 'GONE', plant: 'plant 1 ', workshop: 'Paint', rejectionQty: 2 }),
  ];
  const sum = (f: { plant: string | null; workshop: string | null; division: string | null }) =>
    sumRejectionQty(filterQcRecords(records, lines, f));
  assert.equal(sum({ plant: null, workshop: null, division: null }), 17);
  assert.equal(sum({ plant: 'Plant 1', workshop: null, division: null }), 12);
  assert.equal(sum({ plant: 'Plant 2', workshop: null, division: null }), 5);
  assert.equal(sum({ plant: null, workshop: 'Assembly', division: 'Div A' }), 10);
  assert.equal(sum({ plant: 'Plant 3', workshop: null, division: null }), 0);

  // Quality follows the filtered count.
  assert.equal(computeQuality(990, sum({ plant: 'Plant 1', workshop: null, division: null })).rejectedParts, 12);
});

test('7. supervisor line rejections are not added to QC rejections', () => {
  // The quality figure is computed from good output + QC rejections only;
  // there is no parameter through which line-reported rejections could be
  // added, so a part logged both by the supervisor and by QC counts once.
  const goodParts = 5610;
  const qcRejected = sumRejectionQty([qc({ rejectionQty: 60 }), qc({ rejectionQty: 37 })]);
  assert.equal(qcRejected, 97);
  assert.equal(computeQuality(goodParts, qcRejected).rejectedParts, 97);
  assert.equal(computeQuality.length, 2);
});

test('bad rejectionQty values are ignored, not NaN', () => {
  assert.equal(sumRejectionQty([qc({ rejectionQty: NaN }), qc({ rejectionQty: -3 }), qc({ rejectionQty: 4 })]), 4);
});

console.log(`\n${passed} passed`);
