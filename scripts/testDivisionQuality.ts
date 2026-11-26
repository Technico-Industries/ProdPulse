// scripts/testDivisionQuality.ts
//
// Checks for src/utils/divisionQuality.ts — the division → line breakdown of
// the Quality Analysis report. Plain node:assert script (the project has no
// test runner):  npm run test:division-quality

import assert from 'node:assert/strict';
import {
  buildDivisionQuality,
  DQProductionRecord,
  DQRejectionRecord,
  NO_DIVISION,
} from '../src/utils/divisionQuality';
import { WELDING_DIVISIONS, divisionsForWorkshop } from '../src/constants/lineOptions';

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

let n = 0;
const prod = (
  division: string | null,
  lineId: string,
  good: number | null,
  rej: number | null | undefined,
  extra: Partial<DQProductionRecord> = {},
): DQProductionRecord => ({
  id: `p${++n}`,
  plant: 'Bawal 1',
  workshop: 'Welding Shop',
  division,
  lineId,
  lineName: lineId.toUpperCase(),
  partName: 'Model-X',
  producedThisSlot: good,
  rejections: rej,
  ...extra,
});
const rejRec = (division: string | null, lineId: string, defect: string, qty: number, remarks: string | null = null): DQRejectionRecord => ({
  id: `r${++n}`,
  plant: 'Bawal 1',
  workshop: 'Welding Shop',
  division,
  lineId,
  lineName: lineId.toUpperCase(),
  partName: 'Model-X',
  defect,
  rejectionQty: qty,
  remarks,
});

const weldingProd = [
  prod('Div-1', 'w1', 100, 2),
  prod('Div-1', 'w1', 150, 3),
  prod('Div-1', 'w2', 200, 0, { partName: 'Model-Y' }),
  prod('Div-2', 'w3', 300, 6),
  prod('Div-3', 'w4', 50, 50),
];
const weldingRej = [
  rejRec('Div-1', 'w1', 'Spatter', 2, 'Tip worn'),
  rejRec('Div-1', 'w1', 'Spatter', 1),
  rejRec('Div-1', 'w1', 'Porosity', 1),
  rejRec('Div-2', 'w3', 'Burn through', 6),
];
const context = { plant: 'Bawal 1', workshop: 'Welding Shop' };
const result = buildDivisionQuality(weldingProd, weldingRej, {
  configuredDivisions: divisionsForWorkshop('Welding Shop'),
  context,
});
const byName = (name: string) => result.find((d) => d.division === name)!;

test('1. Welding divisions come from the workshop configuration, in order', () => {
  assert.deepEqual(result.map((d) => d.division), WELDING_DIVISIONS);
});

test('2. each division holds only its own lines (Div-1 → w1, w2)', () => {
  assert.deepEqual(byName('Div-1').lines.map((l) => l.lineName), ['W1', 'W2']);
  assert.deepEqual(byName('Div-2').lines.map((l) => l.lineName), ['W3']);
  assert.deepEqual(byName('Div-3').lines.map((l) => l.lineName), ['W4']);
});

test('3. division totals equal the sum of their lines', () => {
  for (const d of result) {
    const good = d.lines.reduce((s, l) => s + l.goodProduction, 0);
    const rej = d.lines.reduce((s, l) => s + (l.rejections ?? 0), 0);
    assert.equal(d.goodProduction, good, d.division);
    assert.equal(d.rejections, rej, d.division);
    assert.equal(d.totalProduction, good + rej, d.division);
  }
  const d1 = byName('Div-1');
  assert.equal(d1.goodProduction, 450);
  assert.equal(d1.rejections, 5);
  assert.equal(d1.totalProduction, 455);
  assert.equal(d1.rejectionPct, 1.1); // 5 / 455 × 100
  assert.equal(d1.lineCount, 2);
});

test('4. line figures and rejection %', () => {
  const w1 = byName('Div-1').lines[0];
  assert.equal(w1.goodProduction, 250);
  assert.equal(w1.rejections, 5);
  assert.equal(w1.totalProduction, 255);
  assert.equal(w1.rejectionPct, 2);
  assert.equal(byName('Div-3').lines[0].rejectionPct, 50);
  assert.equal(byName('Div-3').status, 'critical');
});

test('5. defects and remarks come from rejectionRecords, per line only', () => {
  const w1 = byName('Div-1').lines[0];
  assert.deepEqual(w1.defects, [{ defect: 'Spatter', qty: 3 }, { defect: 'Porosity', qty: 1 }]);
  assert.deepEqual(w1.remarks, ['Tip worn']);
  assert.deepEqual(byName('Div-1').lines[1].defects, []);
  // logged defects never change the counter-based rejection total
  assert.equal(w1.rejections, 5);
});

test('6. models are the distinct parts of the line', () => {
  assert.deepEqual(byName('Div-1').lines[1].models, ['Model-Y']);
});

test('7. zero production is safe (no NaN, % unavailable)', () => {
  const d5 = byName('Div-5');
  assert.equal(d5.lineCount, 0);
  assert.equal(d5.totalProduction, 0);
  assert.equal(d5.rejectionPct, null);
  assert.equal(d5.status, 'unavailable');
  const zero = buildDivisionQuality([prod('Div-1', 'z', 0, 0)], []);
  assert.equal(zero[0].rejectionPct, null);
  assert.equal(zero[0].lines[0].rejectionPct, null);
});

test('8. a slot doc listed twice (two queries) is counted once', () => {
  const p = prod('Div-1', 'dup', 100, 4);
  const r = buildDivisionQuality([p, { ...p }], []);
  assert.equal(r[0].goodProduction, 100);
  assert.equal(r[0].rejections, 4);
});

test('9. same division name in another plant/workshop is not merged', () => {
  const r = buildDivisionQuality(
    [prod('Div-1', 'a', 10, 0), prod('Div-1', 'b', 10, 0, { plant: 'Bawal 2' })],
    [],
  );
  assert.equal(r.length, 2);
  assert.ok(r.every((d) => d.lineCount === 1));
});

test('10. Assembly records keep working (own divisions, no welding defaults)', () => {
  const asm = [
    prod('Side Door', 'a1', 500, 5, { workshop: 'Assembly Shop' }),
    prod('Back Door', 'a2', 400, 0, { workshop: 'Assembly Shop' }),
  ];
  const r = buildDivisionQuality(asm, [], {
    configuredDivisions: divisionsForWorkshop('Assembly Shop'),
    context: { plant: 'Bawal 1', workshop: 'Assembly Shop' },
  });
  assert.equal(r[0].division, 'Side Door'); // configured order
  assert.ok(!r.some((d) => d.division.startsWith('Div-')));
  assert.equal(r.find((d) => d.division === 'Side Door')!.rejections, 5);
});

test('11. records without a division group under "No division"', () => {
  const r = buildDivisionQuality([prod(null, 'p1', 10, 1, { workshop: 'Press Shop' })], []);
  assert.equal(r[0].division, NO_DIVISION);
  assert.equal(r[0].hasDivision, false);
});

test('12. legacy slots (no counter) → rejections unknown, not 0%', () => {
  const r = buildDivisionQuality([prod('Div-1', 'l', 100, undefined)], []);
  assert.equal(r[0].rejections, null);
  assert.equal(r[0].rejectionPct, null);
  assert.equal(r[0].lines[0].legacyRecords, 1);
});

console.log(`\n${passed} division-quality checks passed`);
