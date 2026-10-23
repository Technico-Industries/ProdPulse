// scripts/testModelPartProduction.ts
//
// Checks for the admin Model / Part Production page logic in
// src/utils/modelPartProduction.ts. Plain node:assert script, like the
// project's other checks:  npm run test:model-part
//
// Records go through the real production-date selection
// (utils/productionDay selectRecordsInProductionRange + legacyCreatedAtWindow),
// so the date handling tested is the one the Firestore query feeds.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ADMIN_MENU_ITEMS } from '../src/constants/adminMenu';
import { SUPERVISOR_MENU_ITEMS } from '../src/constants/supervisorMenu';
import { QUALITY_MENU_ITEMS } from '../src/constants/qualityMenu';
import { legacyCreatedAtWindow, selectRecordsInProductionRange, timestampToMillis } from '../src/utils/productionDay';
import { productionRecordId, SlotSegment } from '../src/utils/productionDraft';
import {
  buildExportTables,
  buildReport,
  canViewModelPartProduction,
  createLatestRequestGuard,
  EMPTY_FILTERS,
  loadErrorMessage,
  loadRecordsForAdmin,
  mapProductionRecord,
  ModelPartAccessError,
  MPFilters,
  MPLine,
  MPRecord,
  partDetail,
  partOptions,
  resolveLineFields,
  sortPartRows,
  supervisorOptions,
  validateDateRange,
} from '../src/utils/modelPartProduction';

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

// ─── Fixture ─────────────────────────────────────────────────────────────────

const D1 = '2026-10-22';
const D2 = '2026-10-23';
const at = (key: string, hh: number, mm = 0) => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d, hh, mm).getTime();
};
const ts = (ms: number) => ({ toMillis: () => ms });

const LINES: MPLine[] = [
  { id: 'L1', plant: 'Bawal 1', workshop: 'Assembly Shop', division: 'Side Door', lineName: 'JAC-01', parts: [{ name: 'RH' }, { name: 'LH' }] },
  { id: 'L2', plant: 'Bawal 2', workshop: 'Welding Shop', division: null, lineName: 'WLD-02', parts: [{ name: 'RH' }, { name: 'BRK' }] },
];

type Raw = { id: string; data: any };
const SUP = {
  S1: { name: 'Asha', code: 'S1', uid: 'u-s1' },
  S2: { name: 'Ravi', code: 'S2', uid: 'u-s2' },
  S3: { name: 'Meena', code: 'S3', uid: 'u-s3' },
};

// A saved slot as Save Slot / Finalize writes it (canonical ID).
function slot(o: {
  day: string; line: string; shift: 'A' | 'B'; slotIndex: number; seg?: SlotSegment; part: string;
  produced: number; rej: number | null; sup?: keyof typeof SUP; createdMs: number; id?: string; noDate?: boolean; updatedMs?: number;
}): Raw {
  const seg = o.seg ?? 'full';
  return {
    id: o.id ?? productionRecordId({ productionDate: o.day, lineId: o.line, shift: o.shift, slotIndex: o.slotIndex, segment: seg }),
    data: {
      ...(o.noDate ? {} : { productionDate: o.day }),
      lineId: o.line,
      // L2 records carry no plant/workshop — resolved from productionLines.
      lineName: o.line === 'L1' ? 'JAC-01' : 'old name',
      plant: o.line === 'L1' ? 'Bawal 1' : null,
      workshop: o.line === 'L1' ? 'Assembly Shop' : null,
      division: o.line === 'L1' ? 'Side Door' : null,
      shift: o.shift,
      partName: o.part,
      slotIndex: o.slotIndex,
      slotLabel: `Slot ${o.slotIndex}`,
      ...(seg === 'full' ? {} : { partSegment: seg }),
      producedThisSlot: o.produced,
      expectedParts: 100,
      ...(o.rej == null ? {} : { rejections: o.rej }),
      supervisor: SUP[o.sup ?? 'S1'],
      createdAt: ts(o.createdMs),
      updatedAt: ts(o.updatedMs ?? o.createdMs),
    },
  };
}

const DOCS: Raw[] = [
  // D1 Shift A — L1, with a changeover in slot 2 (RH → LH)
  slot({ day: D1, line: 'L1', shift: 'A', slotIndex: 1, part: 'RH', produced: 100, rej: 2, createdMs: at(D1, 8) }),
  slot({ day: D1, line: 'L1', shift: 'A', slotIndex: 2, seg: 'before', part: 'RH', produced: 40, rej: 1, createdMs: at(D1, 9) }),
  slot({ day: D1, line: 'L1', shift: 'A', slotIndex: 2, seg: 'after', part: 'LH', produced: 50, rej: 0, createdMs: at(D1, 9, 1) }),
  slot({ day: D1, line: 'L1', shift: 'A', slotIndex: 3, part: 'LH', produced: 90, rej: 3, createdMs: at(D1, 10) }),
  // D1 Shift A — L2
  slot({ day: D1, line: 'L2', shift: 'A', slotIndex: 1, part: 'RH', produced: 70, rej: 0, sup: 'S2', createdMs: at(D1, 8) }),
  // D1 Shift B — L1: one evening slot, one saved after midnight (calendar D2)
  slot({ day: D1, line: 'L1', shift: 'B', slotIndex: 1, part: 'RH', produced: 80, rej: 1, sup: 'S3', createdMs: at(D1, 19, 30) }),
  slot({ day: D1, line: 'L1', shift: 'B', slotIndex: 8, part: 'RH', produced: 60, rej: 2, sup: 'S3', createdMs: at(D2, 2) }),
  // D1 Shift B — L2 legacy record: no productionDate, no rejection counter,
  // random ID, saved at 01:30 on calendar D2 → belongs to the night of D1
  slot({ day: D1, line: 'L2', shift: 'B', slotIndex: 9, part: 'BRK', produced: 30, rej: null, sup: 'S3', createdMs: at(D2, 1, 30), id: 'legacyB1', noDate: true }),
  // D2 Shift A — L1
  slot({ day: D2, line: 'L1', shift: 'A', slotIndex: 1, part: 'RH', produced: 110, rej: 5, createdMs: at(D2, 8) }),
  slot({ day: D2, line: 'L1', shift: 'A', slotIndex: 2, part: 'RH', produced: 30, rej: 0, createdMs: at(D2, 9) }),
  // …and a legacy addDoc() duplicate of that same slot
  slot({ day: D2, line: 'L1', shift: 'A', slotIndex: 2, part: 'RH', produced: 30, rej: 0, createdMs: at(D2, 8, 59), id: 'legacyY' }),
  // D2 Shift A — L2: two legacy docs of one slot (no canonical doc)
  slot({ day: D2, line: 'L2', shift: 'A', slotIndex: 1, part: 'BRK', produced: 20, rej: 0, sup: 'S2', createdMs: at(D2, 8), id: 'legacyX1' }),
  slot({ day: D2, line: 'L2', shift: 'A', slotIndex: 1, part: 'BRK', produced: 20, rej: 0, sup: 'S2', createdMs: at(D2, 8, 5), id: 'legacyX2' }),
];

// fetchProductionRecordsForDateRange, over an in-memory collection.
function fetchRange(docs: Raw[], from: string, to: string): MPRecord[] {
  const { startMs, endMs } = legacyCreatedAtWindow(from, to);
  const row = (d: Raw) => ({
    id: d.id, shift: d.data.shift ?? 'A', productionDate: d.data.productionDate,
    createdAtMs: timestampToMillis(d.data.createdAt), doc: d,
  });
  const byDate = docs.filter((d) => d.data.productionDate >= from && d.data.productionDate <= to).map(row);
  const byCreated = docs.filter((d) => {
    const ms = timestampToMillis(d.data.createdAt)!;
    return ms >= startMs && ms < endMs;
  }).map(row);
  return selectRecordsInProductionRange([byDate, byCreated], from, to).map((d) => mapProductionRecord(d.id, d.data));
}

const report = (from: string, to: string, filters: Partial<MPFilters> = {}, docs = DOCS) =>
  buildReport(resolveLineFields(fetchRange(docs, from, to), LINES), { ...EMPTY_FILTERS, ...filters });

// Generate Report's summary: a plain sum over every doc in the range.
const reportScreenSum = (records: MPRecord[]) => ({
  produced: records.reduce((s, r) => s + (r.producedThisSlot ?? 0), 0),
  rejected: records.reduce((s, r) => s + (r.rejections ?? 0), 0),
});

async function main() {
  console.log('Model / Part Production');

  await test('1. the menu entry is in the admin drawer only, and only admins may view', () => {
    const entry = ADMIN_MENU_ITEMS.find((i) => i.route === 'ModelPartProduction');
    assert.ok(entry);
    assert.equal(entry!.title, 'Model / Part Production');
    assert.ok(!SUPERVISOR_MENU_ITEMS.some((i) => i.route === 'ModelPartProduction'));
    assert.ok(!QUALITY_MENU_ITEMS.some((i) => i.route === 'ModelPartProduction'));
    assert.equal(canViewModelPartProduction({ role: 'admin' }), true);
    assert.equal(canViewModelPartProduction({ role: 'supervisor' }), false);
    assert.equal(canViewModelPartProduction(null), false);
    assert.equal(canViewModelPartProduction(undefined), false);
    // Registered as a route + deep link, and the screen guards itself.
    const app = readFileSync('App.tsx', 'utf8');
    assert.match(app, /name="ModelPartProduction"/);
    assert.match(app, /ModelPartProduction: 'model-part-production'/);
    const screen = readFileSync('src/screens/ModelPartProductionScreen.tsx', 'utf8');
    assert.match(screen, /if \(!canViewModelPartProduction\(user\)\)/);
  });

  await test('2. non-admins never reach the production-record query', async () => {
    let fetches = 0;
    const deps = (profile: any) => ({
      getProfile: async () => profile,
      fetchRecords: async () => { fetches++; return [1]; },
    });
    const refused = async (user: any, profile: any) => {
      await assert.rejects(loadRecordsForAdmin(user, D1, D1, deps(profile)), ModelPartAccessError);
    };
    await refused(null, { role: 'admin' });
    await refused({ uid: 'u', role: 'supervisor' }, { role: 'admin' }); // store says supervisor
    await refused({ uid: 'u', role: 'admin' }, { role: 'supervisor' }); // role removed since sign-in
    await refused({ uid: 'u', role: 'admin' }, { role: 'admin', active: false }); // deactivated
    await refused({ uid: 'u', role: 'admin' }, null); // no profile doc
    assert.equal(fetches, 0);
    assert.deepEqual(await loadRecordsForAdmin({ uid: 'u', role: 'admin' }, D1, D1, deps({ role: 'admin' })), [1]);
    assert.equal(fetches, 1);
  });

  await test('3. single day: totals, parts, lines', () => {
    const r = report(D1, D1);
    assert.equal(r.summary.produced, 520);
    assert.equal(r.summary.rejected, 9);
    assert.equal(r.summary.output, 529);
    assert.equal(r.summary.records, 8);
    assert.equal(r.summary.partCount, 3);
    assert.equal(r.summary.lineCount, 2);
    assert.equal(r.duplicates.length, 0);
    const rows = Object.fromEntries(r.parts.map((p) => [p.partName, p]));
    assert.equal(rows.RH.produced, 100 + 40 + 70 + 80 + 60);
    assert.equal(rows.RH.lineCount, 2);
    assert.equal(rows.LH.produced, 140);
    assert.equal(rows.BRK.produced, 30);
    assert.equal(rows.RH.latestMs, at(D2, 2)); // the after-midnight save
    // Part rows add up to the summary — nothing counted under two parts.
    assert.equal(r.parts.reduce((s, p) => s + p.produced, 0), r.summary.produced);
  });

  await test('4. date range: totals, duplicates excluded', () => {
    const r = report(D1, D2);
    assert.equal(r.summary.produced, 520 + 160);
    assert.equal(r.summary.rejected, 9 + 5);
    assert.equal(r.duplicates.length, 2);
    assert.equal(r.duplicateProduced, 50);
    assert.equal(report(D2, D2).summary.produced, 160);
  });

  await test('5. plant / workshop / division / line / part / shift / supervisor filters combine', () => {
    assert.equal(report(D1, D1, { plant: 'bawal 1 ', shift: 'A', partKey: 'rh' }).summary.produced, 140);
    assert.equal(report(D1, D1, { workshop: 'Welding Shop' }).summary.produced, 100); // resolved from the line doc
    assert.equal(report(D1, D1, { division: 'Side Door' }).summary.produced, 420);
    assert.equal(report(D1, D1, { lineId: 'L2', partKey: 'brk' }).summary.produced, 30);
    assert.equal(report(D1, D1, { supervisorKey: 'uid:u-s2' }).summary.produced, 70);
    assert.equal(report(D1, D1, { supervisorKey: 'uid:u-s3', lineId: 'L1' }).summary.produced, 140);
    assert.equal(report(D1, D1, { plant: 'Bawal 2', division: 'Side Door' }).summary.produced, 0);
    const loaded = resolveLineFields(fetchRange(DOCS, D1, D1), LINES);
    assert.deepEqual(supervisorOptions(loaded).map((o) => o.label), ['Asha', 'Meena', 'Ravi']);
    assert.deepEqual(partOptions(LINES, loaded).map((o) => o.label), ['BRK', 'LH', 'RH']);
  });

  await test('6. Shift B after-midnight slots stay on the production date the shift started', () => {
    const night = report(D1, D1, { shift: 'B' });
    assert.equal(night.summary.produced, 80 + 60 + 30); // incl. the legacy 01:30 record
    assert.equal(report(D2, D2, { shift: 'B' }).summary.produced, 0); // not split into the next day
    const byDay = partDetail(report(D1, D2).records, 'rh', 'day');
    assert.deepEqual(byDay.map((d) => [d.key, d.produced]), [[D1, 350], [D2, 140]]);
  });

  await test('7. before/after changeover segments both count, each under its own part', () => {
    const r = report(D1, D1, { lineId: 'L1', shift: 'A' });
    assert.equal(r.summary.produced, 280);
    assert.equal(r.records.filter((x) => x.slotIndex === 2).length, 2);
    assert.equal(r.parts.find((p) => p.partName === 'RH')!.produced, 140);
    assert.equal(r.parts.find((p) => p.partName === 'LH')!.produced, 140);
    // A slot stored in both shapes keeps the one written last (dedupeSlotRecords).
    const both = [
      slot({ day: D1, line: 'L1', shift: 'A', slotIndex: 5, part: 'RH', produced: 99, rej: 0, createdMs: at(D1, 11), updatedMs: at(D1, 11) }),
      slot({ day: D1, line: 'L1', shift: 'A', slotIndex: 5, seg: 'before', part: 'RH', produced: 40, rej: 0, createdMs: at(D1, 12), updatedMs: at(D1, 12) }),
      slot({ day: D1, line: 'L1', shift: 'A', slotIndex: 5, seg: 'after', part: 'LH', produced: 45, rej: 0, createdMs: at(D1, 12), updatedMs: at(D1, 12) }),
    ];
    const r2 = report(D1, D1, {}, both);
    assert.equal(r2.summary.produced, 85);
    assert.equal(r2.duplicates.length, 1);
    assert.equal(r2.duplicates[0].producedThisSlot, 99);
  });

  await test('8. identified duplicates do not inflate totals; look-alike records are not merged', () => {
    const r = report(D2, D2);
    assert.deepEqual(r.duplicates.map((d) => d.id).sort(), ['legacyX2', 'legacyY']); // canonical, else earliest, kept
    assert.ok(r.records.some((x) => x.id === 'legacyX1'));
    // Same part, quantity and time but different slots → both are real.
    const lookAlike = [
      slot({ day: D1, line: 'L1', shift: 'A', slotIndex: 4, part: 'RH', produced: 50, rej: 0, createdMs: at(D1, 12) }),
      slot({ day: D1, line: 'L1', shift: 'A', slotIndex: 5, part: 'RH', produced: 50, rej: 0, createdMs: at(D1, 12) }),
      slot({ day: D1, line: 'L2', shift: 'A', slotIndex: 4, part: 'RH', produced: 50, rej: 0, createdMs: at(D1, 12) }),
      slot({ day: D1, line: 'L1', shift: 'B', slotIndex: 4, part: 'RH', produced: 50, rej: 0, createdMs: at(D1, 20) }),
    ];
    assert.equal(report(D1, D1, {}, lookAlike).summary.produced, 200);
    // No slot identity → can't be matched, so kept rather than guessed at.
    const noSlot = [0, 1].map((i) => {
      const d = slot({ day: D1, line: 'L1', shift: 'A', slotIndex: 1, part: 'RH', produced: 10, rej: 0, createdMs: at(D1, 8), id: `noslot${i}` });
      delete d.data.slotIndex;
      return d;
    });
    assert.equal(report(D1, D1, {}, noSlot).summary.produced, 20);
    // Filters apply after de-duplication: a duplicate whose supervisor
    // differs from the kept doc does not come back under that filter.
    const dupOtherSup = [
      slot({ day: D1, line: 'L1', shift: 'A', slotIndex: 1, part: 'RH', produced: 10, rej: 0, createdMs: at(D1, 8) }),
      slot({ day: D1, line: 'L1', shift: 'A', slotIndex: 1, part: 'RH', produced: 10, rej: 0, sup: 'S2', createdMs: at(D1, 7), id: 'dupS2' }),
    ];
    assert.equal(report(D1, D1, { supervisorKey: 'uid:u-s2' }, dupOtherSup).summary.produced, 0);
  });

  await test('9. produced is good output; rejected is separate; nothing is subtracted', () => {
    const r = report(D1, D1);
    assert.equal(r.summary.produced, 520);
    assert.equal(r.summary.output, r.summary.produced + r.summary.rejected);
    assert.equal(r.summary.quality.goodParts, 520);
    assert.equal(r.summary.quality.rejectedParts, 9);
    assert.equal(r.summary.quality.rejectionPct, 1.7); // 9 / 529
    assert.equal(r.summary.legacyRejectionRecords, 1); // counted as 0 rejected, flagged
    assert.equal(r.parts.find((p) => p.partName === 'BRK')!.rejected, 0);
  });

  await test('10. empty results, errors, invalid dates and out-of-order loads', async () => {
    const empty = report('2026-09-01', '2026-09-01');
    assert.equal(empty.summary.produced, 0);
    assert.equal(empty.summary.records, 0);
    assert.deepEqual(empty.parts, []);
    assert.equal(empty.summary.quality.rejectionPct, null);
    assert.deepEqual(buildReport([], EMPTY_FILTERS).parts, []);

    assert.match(loadErrorMessage({ code: 'permission-denied' }), /permission/);
    assert.match(loadErrorMessage({ code: 'unavailable' }), /connection/);
    assert.match(loadErrorMessage(new Error('boom')), /Could not load/);
    assert.match(loadErrorMessage(new ModelPartAccessError()), /admin/);

    assert.equal(validateDateRange(D1, D2), null);
    assert.ok(validateDateRange('2026-1-01', D2));
    assert.ok(validateDateRange('2026-02-30', '2026-03-01'));
    assert.ok(validateDateRange(D2, D1));
    assert.equal(validateDateRange('2026-01-01', '2026-04-02'), null); // 92 days
    assert.ok(validateDateRange('2026-01-01', '2026-04-03')); // 93 days

    // The screen's load(): only the newest request may show its result.
    const guard = createLatestRequestGuard();
    let shown: string | null = null;
    const pending: Record<string, (v: string) => void> = {};
    const load = async (name: string) => {
      const token = guard.next();
      const v = await new Promise<string>((res) => { pending[name] = res; });
      if (guard.isCurrent(token)) shown = v;
    };
    const a = load('a');
    const b = load('b');
    pending.b('range B');
    await b;
    pending.a('range A'); // older, slower response
    await a;
    assert.equal(shown, 'range B');
    guard.cancel(); // screen left
    const c = load('c');
    guard.cancel();
    pending.c('late');
    await c;
    assert.equal(shown, 'range B');
  });

  await test('11. the export carries the same figures, range, filters and changeover segments', () => {
    const r = report(D1, D2, { lineId: 'L1' });
    const t = buildExportTables(r, {
      fromDate: D1, toDate: D2, plant: null, workshop: null, division: null,
      lineName: 'JAC-01', partName: null, shift: 'All', supervisorName: null,
    });
    const value = (label: string) => t.summary.find((row) => row[0] === label)?.[1];
    assert.equal(value('Production date range'), `${D1} to ${D2}`);
    assert.equal(value('Line'), 'JAC-01');
    assert.equal(value('Produced (good parts)'), r.summary.produced);
    assert.equal(value('Rejected'), r.summary.rejected);
    assert.equal(value('Duplicate records excluded'), 1);
    const col = (rows: (string | number)[][], name: string) => rows[0].indexOf(name);
    const sum = (rows: (string | number)[][], name: string) =>
      rows.slice(1).reduce((s, row) => s + (Number(row[col(rows, name)]) || 0), 0);
    assert.equal(sum(t.detail, 'Produced (good)'), r.summary.produced);
    assert.equal(sum(t.detail, 'Rejected'), r.summary.rejected);
    assert.equal(sum(t.parts, 'Produced (good)'), r.summary.produced);
    assert.equal(t.detail.length - 1, r.records.length);
    assert.equal(t.duplicates.length - 1, r.duplicates.length);
    const segs = t.detail.slice(1).map((row) => row[col(t.detail, 'Segment')]);
    assert.ok(segs.includes('Before changeover') && segs.includes('After changeover'));
    // Every detail row's date is a production date in range (Shift B on D1).
    const dates = new Set(t.detail.slice(1).map((row) => row[0]));
    assert.deepEqual([...dates].sort(), [D1, D2]);
  });

  await test('12. agrees with Generate Report where there are no duplicates; differs by exactly the duplicates', () => {
    for (const [from, to] of [[D1, D1], [D2, D2], [D1, D2]]) {
      const loaded = fetchRange(DOCS, from, to);
      const plain = reportScreenSum(loaded);
      const r = report(from, to);
      assert.equal(r.summary.produced, plain.produced - r.duplicateProduced);
      assert.equal(
        r.summary.rejected,
        plain.rejected - r.duplicates.reduce((s, d) => s + (d.rejections ?? 0), 0)
      );
    }
    const d1 = fetchRange(DOCS, D1, D1);
    assert.equal(report(D1, D1).summary.produced, reportScreenSum(d1).produced);
    // Sorting never changes the figures.
    const r = report(D1, D2);
    assert.deepEqual(sortPartRows(r.parts, 'name-asc').map((p) => p.partName), ['BRK', 'LH', 'RH']);
    assert.deepEqual(sortPartRows(r.parts, 'qty-desc').map((p) => p.partName), ['RH', 'LH', 'BRK']);
    assert.equal(sortPartRows(r.parts, 'qty-asc').reduce((s, p) => s + p.produced, 0), r.summary.produced);
  });

  console.log(`\n${passed} passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
