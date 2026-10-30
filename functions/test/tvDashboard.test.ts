// functions/test/tvDashboard.test.ts
//
// Checks for the Assembly TV dashboard read model (src/tvDashboard). Plain
// node:assert script, like the project's other checks:
//   npx tsx test/tvDashboard.test.ts        (from functions/)
//
// Firebase is fully mocked: an in-memory source "database" and an in-memory
// read-model store that applies the SAME commit plans (planLineCommit /
// planDayCommit / planOverviewCommit) as the Firestore store. Nothing
// connects to Firestore and nothing is written anywhere.

import '../src/timezone'; // plant timezone first — exactly as the deployed function does
import assert from 'node:assert/strict';
import {
  Data, DateSources, LINE_DOC_FIELDS, LineDocContent, RawDoc,
  awaitingEntryFromMs, computeLineDoc, computeShiftFigures, dashboardContext, dayFromLineDocs, decideOverviewWrite,
  displayStatus, impactOfWrite, isAssemblyWorkshop, normalizeLineDoc, resolveLineMeta, sanitizeStopReason,
  stableStringify, sumShiftFigures, workshopScope, OVERVIEW_HEARTBEAT_MS,
} from '../src/tvDashboard/core';
import {
  StoredDay, TvSources, TvStore, parseStoredDay, parseStoredLine, planDayCommit, planLineCommit, planOverviewCommit,
} from '../src/tvDashboard/store';
import { TvDeps, handleSourceWrite, rebuildDay, recomputeLine, runOverview } from '../src/tvDashboard/service';
import { productionRecordId } from '../../src/utils/productionDraft';
import { legacyCreatedAtWindow, selectRecordsInProductionRange, timestampToMillis } from '../../src/utils/productionDay';
import { counterQuality } from '../../src/utils/qualityMetrics';
import { efficiencyOf } from '../../src/utils/lineEfficiency';
import { buildRunningLineCards, parseRunningSession } from '../../src/utils/supervisorHandover';
import { mapProductionRecord } from '../../src/utils/modelPartProduction';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(e);
  }
}

// ─── Fixture helpers ─────────────────────────────────────────────────────────

const at = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const t23 = (h: number, mi = 0) => at(2026, 10, 23, h, mi);
const t22 = (h: number, mi = 0) => at(2026, 10, 22, h, mi);
const ts = (ms: number) => ({ toMillis: () => ms }); // Firestore Timestamp stand-in
const D23 = '2026-10-23';
const D22 = '2026-10-22';
const NOW = t23(10, 0); // 23 Oct, 10:00 plant time → production date 23, Shift A

// Personal data placed in the fixtures — must never reach the read model.
const SECRETS = ['Ravi Kumar', 'EMP-4411', 'uid-secret-1', 'uid-secret-2', 'device-xyz', 'Operator Sita', 'OP-77', 'private note', 'ravi@example.com'];

const LINE_SD01: Data = {
  plant: 'Bawal 1', workshop: 'Assembly Shop', division: 'Side Door', lineName: 'SD-01',
  parts: [{ name: 'Hinge LH', cycleTimeSeconds: 30 }, { name: 'Hinge RH', cycleTimeSeconds: 30 }],
  createdBy: 'uid-secret-1',
};
// Legacy line: every alias the app's readers accept.
const LINE_SJ02_LEGACY: Data = { location: 'Bawal 2', shop: 'Assembly', unit: 'S.Jack', lineNumber: 'SJ-02', models: [{ partName: 'Screw Jack', cycleTimeSeconds: 40 }] };
const LINE_WELD: Data = { plant: 'Bawal 1', workshop: 'Welding Shop', division: null, lineName: 'W-01', parts: [] };

function rec(lineId: string, date: string | null, shift: 'A' | 'B', slot: number, segment: 'full' | 'before' | 'after', f: {
  produced: number; expected: number; rejections?: number | null; stopEvents?: any[]; createdAt: number; updatedAt?: number; id?: string; workshop?: string;
}): RawDoc {
  const id = f.id ?? productionRecordId({ productionDate: date ?? '', lineId, shift, slotIndex: slot, segment });
  const data: Data = {
    lineId, lineName: lineId, plant: 'Bawal 1', workshop: f.workshop ?? 'Assembly Shop', division: 'Side Door', shift,
    ...(date ? { productionDate: date } : {}),
    slotIndex: slot, partName: 'Hinge LH', expectedParts: f.expected, producedThisSlot: f.produced,
    ...(f.rejections === undefined ? {} : { rejections: f.rejections }),
    ...(segment !== 'full' ? { partSegment: segment } : {}),
    stopEvents: f.stopEvents ?? [],
    lossReasonNote: 'private note',
    operators: [{ name: 'Operator Sita', code: 'OP-77' }],
    supervisor: { name: 'Ravi Kumar', code: 'EMP-4411', uid: 'uid-secret-1' },
    createdBy: { name: 'Ravi Kumar', uid: 'uid-secret-1' },
    createdAt: ts(f.createdAt), updatedAt: ts(f.updatedAt ?? f.createdAt),
  };
  return { id, data };
}

function session(lineId: string, f: Partial<Data> & { productionDate?: string | null; shift?: 'A' | 'B'; startedAt: number }): Data {
  const { startedAt, ...rest } = f;
  return {
    lineId, lineName: lineId, plant: 'Bawal 1', workshop: 'Assembly Shop', division: 'Side Door',
    shift: 'A', otHours: 0, selectedPartIndex: 0, changeovers: {}, savedSlotIndices: [], deletedSlotIndices: [],
    producedBySlot: {}, rejectionsBySlot: {}, stopsBySlot: {}, lineStopped: false,
    plannedProductionTotal: 900, productionStartMinutesAbs: null,
    supervisorName: 'Ravi Kumar', supervisorCode: 'EMP-4411', supervisorUid: 'uid-secret-1',
    operators: [{ name: 'Operator Sita', code: 'OP-77' }],
    updatedBy: { uid: 'uid-secret-2', deviceId: 'device-xyz', name: 'Ravi Kumar' },
    contributorUids: ['uid-secret-1', 'uid-secret-2'],
    lossReasonBySlot: { '1': { code: 'D', label: 'Machine breakdown', note: 'private note' } },
    totalDowntimeMinutes: 9999, // stale cached value — must never be used
    stopsSummaryBySlot: { '0': { totalDowntimeMinutes: 9999, stopCount: 9 } },
    totalRejections: 9999,
    startedAt: ts(startedAt), updatedAt: ts(startedAt), sessionInstanceId: `inst-${lineId}`,
    ...('productionDate' in f ? {} : { productionDate: D23 }),
    ...rest,
  };
}

// ─── In-memory source database and read-model store ──────────────────────────

class FakeDb {
  lines = new Map<string, Data>();
  sessions = new Map<string, Data>();
  records = new Map<string, Data>();
  summaries = new Map<string, Data>();
  ended = new Map<string, Data>();
  calls: string[] = [];
  // Failure injection: source reads that throw.
  failRecordsFor = new Set<string>(); // getLineRecordsForDate(lineId) throws
  failDates = new Set<string>();      // getRecordsForDate(date) throws
}

function fakeSources(db: FakeDb): TvSources {
  const log = (name: string, arg = '') => db.calls.push(arg ? `${name}:${arg}` : name);
  const list = (m: Map<string, Data>): RawDoc[] => Array.from(m, ([id, data]) => ({ id, data }));
  return {
    async getLine(id) { log('getLine', id); return db.lines.get(id) ?? null; },
    async getActiveSession(id) { log('getActiveSession', id); return db.sessions.get(id) ?? null; },
    async getLineRecordsForDate(lineId, date) {
      log('getLineRecordsForDate', lineId);
      if (db.failRecordsFor.has(lineId)) throw new Error(`simulated read failure for ${lineId}`);
      return list(db.records).filter((r) => r.data.lineId === lineId && r.data.productionDate === date);
    },
    async getShiftSummary(lineId, date, shift) { log('getShiftSummary', lineId); return db.summaries.get(`${lineId}_${date}_${shift}`) ?? null; },
    async getLineEndedSessionsForDate(lineId, date) {
      log('getLineEndedSessionsForDate', lineId);
      return Array.from(db.ended.values()).filter((e) => e.lineId === lineId && e.productionDate === date);
    },
    async listLines() { log('listLines'); return list(db.lines); },
    async listActiveSessions() { log('listActiveSessions'); return list(db.sessions); },
    async getRecordsForDate(date) {
      log('getRecordsForDate', date);
      if (db.failDates.has(date)) throw new Error(`simulated read failure for ${date}`);
      // Same selection as the deployed reader (dataSource.getProductionRecords).
      const all = list(db.records);
      const { startMs, endMs } = legacyCreatedAtWindow(date, date);
      const row = (r: RawDoc) => ({ id: r.id, shift: r.data.shift ?? 'A', productionDate: r.data.productionDate, createdAtMs: timestampToMillis(r.data.createdAt), doc: r });
      const byDate = all.filter((r) => r.data.productionDate === date).map(row);
      const byCreated = all.filter((r) => { const c = timestampToMillis(r.data.createdAt); return c != null && c >= startMs && c < endMs; }).map(row);
      return selectRecordsInProductionRange([byDate, byCreated], date, date);
    },
    async getShiftSummariesForDate(date) { log('getShiftSummariesForDate'); return Array.from(db.summaries.values()).filter((s) => s.productionDate === date); },
    async getEndedSessionsForDate(date) { log('getEndedSessionsForDate'); return Array.from(db.ended.values()).filter((s) => s.productionDate === date); },
  };
}

function memoryStore() {
  const lines = new Map<string, Data>();
  const days = new Map<string, Data>();
  const state = { overview: null as Data | null, writes: 0, deletes: 0, failCommitDay: null as string | null };
  const apply = (map: Map<string, Data> | null, key: string, plan: { decision: any; set?: Data; del?: boolean }) => {
    if (plan.set) { state.writes++; if (map) map.set(key, JSON.parse(JSON.stringify(plan.set))); else state.overview = JSON.parse(JSON.stringify(plan.set)); }
    if (plan.del && map) { state.deletes++; map.delete(key); }
    return plan.decision;
  };
  const store: TvStore = {
    async listLineDocs() { return Array.from(lines, ([id, d]) => parseStoredLine(id, d)!).filter(Boolean); },
    async commitLine(id, content, computedAtMs) { return apply(lines, id, planLineCommit(lines.get(id) ?? null, content, computedAtMs)); },
    async getDays(dates) {
      const out: Record<string, StoredDay | null> = {};
      dates.forEach((d) => { out[d] = days.has(d) ? parseStoredDay(days.get(d)) : null; });
      return out;
    },
    async commitDay(date, content, computedAtMs, opts) {
      if (state.failCommitDay === date) throw new Error(`simulated commit failure for ${date}`);
      return apply(days, date, planDayCommit(days.get(date) ?? null, content, computedAtMs, opts.protectFinal));
    },
    async markDaysDirty(dates, atMs) { dates.forEach((d) => { state.writes++; days.set(d, { ...(days.get(d) ?? {}), productionDate: d, dirty: true, dirtyAtMs: atMs }); }); },
    async commitOverview(content, generatedAtMs, freshness) { return apply(null, '', planOverviewCommit(state.overview, content, generatedAtMs, freshness)); },
  };
  return { lines, days, state, store };
}

function setup(nowMs = NOW) {
  const db = new FakeDb();
  const mem = memoryStore();
  let now = nowMs;
  const errors: { msg: string; meta?: Record<string, unknown> }[] = [];
  const deps: TvDeps = { sources: fakeSources(db), store: mem.store, now: () => now, logError: (msg, meta) => errors.push({ msg, meta }) };
  return { db, mem, deps, errors, setNow: (ms: number) => { now = ms; } };
}

const sources = (records: RawDoc[], extra: Partial<DateSources> = {}): DateSources => ({ records, shiftSummaries: [], endedSessions: [], ...extra });

// ─── Tests ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('TV dashboard read model');

  // ── Scope & metadata ──
  await test('Assembly matching: case-insensitive substring of the resolved workshop', () => {
    for (const w of ['Assembly Shop', 'assembly', 'ASSEMBLY', 'Main Assembly Line']) assert.equal(isAssemblyWorkshop(w), true, w);
    for (const w of ['Welding Shop', 'Press Shop', '', null, undefined]) assert.equal(isAssemblyWorkshop(w as any), false, String(w));
  });

  await test('legacy line aliases are resolved (location/shop/unit/lineNumber/models/partName)', () => {
    const m = normalizeLineDoc('SJ02', LINE_SJ02_LEGACY);
    assert.deepEqual([m.plant, m.workshop, m.division, m.lineName], ['Bawal 2', 'Assembly', 'S.Jack', 'SJ-02']);
    assert.deepEqual(m.parts, [{ name: 'Screw Jack' }]);
    assert.equal(isAssemblyWorkshop(m.workshop), true);
  });

  await test('metadata: productionLines first, copies only fill gaps; unregistered lines use copies', () => {
    const m = resolveLineMeta('L1', { lineName: 'SD-01', workshop: 'Assembly Shop', plant: null }, [{ plant: 'Bawal 1', workshop: 'Welding Shop', division: 'Side Door' }]);
    assert.deepEqual([m.lineName, m.workshop, m.plant, m.division, m.registered], ['SD-01', 'Assembly Shop', 'Bawal 1', 'Side Door', true]);
    const u = resolveLineMeta('Lx', null, [null, { lineName: 'X-9', workshop: 'Assembly Shop', plant: 'Bawal 2' }]);
    assert.deepEqual([u.lineName, u.workshop, u.plant, u.registered], ['X-9', 'Assembly Shop', 'Bawal 2', false]);
  });

  await test('both Bawal 1 and Bawal 2 lines are included', async () => {
    const { db, deps, mem } = setup();
    db.lines.set('SD01', LINE_SD01);
    db.lines.set('SJ02', LINE_SJ02_LEGACY);
    db.lines.set('W01', LINE_WELD);
    await runOverview(deps, { fullSweep: true });
    assert.deepEqual(Array.from(mem.lines.keys()).sort(), ['SD01', 'SJ02']);
    assert.deepEqual(mem.state.overview!.scope.plants, ['Bawal 1', 'Bawal 2']);
  });

  // ── Production figures ──
  await test('dedupe: canonical record wins over a legacy duplicate of the same slot', () => {
    const canonical = rec('L1', D23, 'A', 0, 'full', { produced: 90, expected: 100, rejections: 2, createdAt: t23(8, 1) });
    const legacyDup = rec('L1', D23, 'A', 0, 'full', { produced: 70, expected: 100, rejections: 9, createdAt: t23(7, 59), id: 'legacy-auto-1' });
    const other = rec('L1', D23, 'A', 1, 'full', { produced: 110, expected: 120, rejections: 1, createdAt: t23(9, 1) });
    const { figures } = computeShiftFigures('L1', D23, 'A', sources([canonical, legacyDup, other]), null, NOW);
    assert.deepEqual([figures.recordCount, figures.goodProduction, figures.planToDate, figures.rejections], [2, 200, 220, 3]);
  });

  await test('dedupe: a slot holding both shapes keeps the shape written last', () => {
    const full = rec('L1', D23, 'A', 2, 'full', { produced: 100, expected: 100, rejections: 0, createdAt: t23(9, 5), updatedAt: t23(9, 5) });
    const before = rec('L1', D23, 'A', 2, 'before', { produced: 40, expected: 50, rejections: 0, createdAt: t23(9, 30), updatedAt: t23(9, 30) });
    const after = rec('L1', D23, 'A', 2, 'after', { produced: 45, expected: 50, rejections: 0, createdAt: t23(9, 31), updatedAt: t23(9, 31) });
    const { figures } = computeShiftFigures('L1', D23, 'A', sources([full, before, after]), null, NOW);
    assert.deepEqual([figures.goodProduction, figures.planToDate], [85, 100]);
  });

  await test('good / plan-to-date / achievement = efficiencyOf (round1); no plan → null, never 0', () => {
    const r1 = rec('L1', D23, 'A', 0, 'full', { produced: 97, expected: 100, rejections: 0, createdAt: t23(8) });
    const r2 = rec('L1', D23, 'A', 1, 'full', { produced: 104, expected: 120, rejections: 0, createdAt: t23(9) });
    const { figures } = computeShiftFigures('L1', D23, 'A', sources([r1, r2]), null, NOW);
    const expected = efficiencyOf([r1, r2].map((r) => mapProductionRecord(r.id, r.data)));
    assert.deepEqual([figures.goodProduction, figures.planToDate, figures.achievementPct], [expected.actual, expected.planned, expected.efficiency]);
    assert.equal(figures.achievementPct, 91.4);
    const none = computeShiftFigures('L1', D23, 'B', sources([r1, r2]), null, NOW).figures;
    assert.deepEqual([none.goodProduction, none.planToDate, none.achievementPct], [0, 0, null]);
  });

  await test('rejections = Σ productionRecords.rejections; quality = counterQuality (legacy excluded)', () => {
    const counted = rec('L1', D23, 'A', 0, 'full', { produced: 96, expected: 100, rejections: 4, createdAt: t23(8) });
    const legacy = rec('L1', D23, 'A', 1, 'full', { produced: 120, expected: 120, rejections: undefined, createdAt: t23(9) });
    const { figures } = computeShiftFigures('L1', D23, 'A', sources([counted, legacy]), null, NOW);
    const q = counterQuality([counted, legacy].map((r) => mapProductionRecord(r.id, r.data)));
    assert.equal(figures.rejections, 4);
    assert.equal(figures.goodProduction, 216); // legacy record still counts as production
    assert.deepEqual([figures.qualityPct, figures.rejectionPct], [q.qualityPct, q.rejectionPct]);
    assert.deepEqual([figures.qualityPct, figures.rejectionPct], [96, 4]);
    assert.deepEqual(figures.quality, { goodParts: 96, rejectedParts: 4, countedRecords: 1, legacyRecords: 1 });
    const onlyLegacy = computeShiftFigures('L1', D23, 'A', sources([legacy]), null, NOW).figures;
    assert.equal(onlyLegacy.qualityPct, null); // unknown, not a misleading 100 %
  });

  await test('summing lines equals the helpers over the union of their records', () => {
    const a = [rec('L1', D23, 'A', 0, 'full', { produced: 96, expected: 100, rejections: 4, createdAt: t23(8) }), rec('L1', D23, 'A', 1, 'full', { produced: 50, expected: 120, rejections: undefined, createdAt: t23(9) })];
    const b = [rec('L2', D23, 'A', 0, 'full', { produced: 77, expected: 80, rejections: 3, createdAt: t23(8) })];
    const fa = computeShiftFigures('L1', D23, 'A', sources(a), null, NOW).figures;
    const fb = computeShiftFigures('L2', D23, 'A', sources(b), null, NOW).figures;
    const sum = sumShiftFigures([fa, fb]);
    const all = [...a, ...b].map((r) => mapProductionRecord(r.id, r.data));
    const q = counterQuality(all);
    const e = efficiencyOf(all);
    assert.deepEqual([sum.goodProduction, sum.planToDate, sum.achievementPct], [e.actual, e.planned, e.efficiency]);
    assert.deepEqual([sum.qualityPct, sum.rejectionPct, sum.quality.legacyRecords], [q.qualityPct, q.rejectionPct, q.legacyRecords]);
    assert.equal(sum.rejections, 7);
    const legacyOnly = sumShiftFigures([computeShiftFigures('L1', D23, 'A', sources([a[1]]), null, NOW).figures]);
    assert.equal(legacyOnly.qualityPct, null);
  });

  await test('rejectionRecords are never read (no source method exists for them)', async () => {
    const { db, deps } = setup();
    db.lines.set('SD01', LINE_SD01);
    await runOverview(deps, { fullSweep: true });
    assert.ok(db.calls.length > 0);
    assert.ok(db.calls.every((c) => !/reject/i.test(c)));
    assert.ok(!Object.keys(fakeSources(db)).some((k) => /reject/i.test(k)));
  });

  // ── Downtime ──
  await test('downtime: one stop in session + record share + summary is counted once; cached totals ignored', () => {
    const stopX = { id: 'stop-X', reason: 'maintenance', startAbs: t23(9, 10), endAbs: t23(9, 40), durationMinutes: 30, running: false };
    const share = rec('L1', D23, 'A', 2, 'full', {
      produced: 60, expected: 100, rejections: 0, createdAt: t23(9, 45),
      stopEvents: [{ stopId: 'stop-X', reason: 'maintenance', startAbs: t23(9, 10), endAbs: t23(9, 40), durationMinutes: 30 }],
    });
    const s = session('L1', { startedAt: t23(7), stopsBySlot: { '2': [stopX] } });
    const summary = { lineId: 'L1', productionDate: D23, shift: 'A', downtimeIntervals: [{ stopId: 'stop-X', reason: 'maintenance', startAbs: t23(9, 10), endAbs: t23(9, 40), durationMinutes: 30 }] };
    const { figures } = computeShiftFigures('L1', D23, 'A', sources([share], { shiftSummaries: [summary] }), s, NOW);
    assert.equal(figures.downtimeClosedMinutes, 30); // not 60/90, not the cached 9999
    assert.deepEqual(figures.downtimeByReason, [{ reason: 'maintenance', label: 'Maintenance', minutes: 30 }]);
  });

  await test('downtime: same stop in an ended archive and a summary counts once; duplicate ids within a session once', () => {
    const stop = { id: 'stop-Z', reason: 'power cut', startAbs: t23(8, 0), endAbs: t23(8, 20), durationMinutes: 20 };
    const ended = { ...session('L1', { startedAt: t23(7), stopsBySlot: { '1': [stop], '2': [stop] } }), sessionStatus: 'ended', endedBy: { email: 'ravi@example.com' } };
    const summary = { lineId: 'L1', productionDate: D23, shift: 'A', downtimeIntervals: [{ stopId: 'stop-Z', reason: 'power cut', durationMinutes: 20 }] };
    const { figures } = computeShiftFigures('L1', D23, 'A', sources([], { endedSessions: [ended], shiftSummaries: [summary] }), null, NOW);
    assert.equal(figures.downtimeClosedMinutes, 20);
  });

  await test('active stop: excluded from closed minutes, start published, reason sanitised', () => {
    const s = session('L1', {
      startedAt: t23(7), lineStopped: true,
      stopsBySlot: { '2': [{ id: 'stop-Y', reason: 'material shortage', startAbs: t23(9, 50), running: true }] },
    });
    const doc = computeLineDoc({ lineId: 'L1', lineDoc: LINE_SD01, session: s, byDate: { [D23]: sources([]) } }, dashboardContext(NOW))!;
    assert.equal(doc.status, 'stopped');
    assert.deepEqual(doc.activeStop, { startMs: t23(9, 50), reason: 'material shortage', label: 'Material Shortage' });
    assert.equal(doc.current.figures.downtimeClosedMinutes, 0);
    assert.deepEqual(sanitizeStopReason('Machine went bang, call Ravi'), { reason: 'other', label: 'Other' });
    assert.deepEqual(sanitizeStopReason('5s'), { reason: '5s', label: '5S' });
  });

  await test('overview adds running stop minutes up to generatedAt to the reasons; TV gets startMs', async () => {
    const { db, deps, mem } = setup();
    db.lines.set('L1', LINE_SD01);
    db.sessions.set('L1', session('L1', {
      startedAt: t23(7), lineStopped: true,
      stopsBySlot: { '0': [{ id: 'stop-1', reason: 'quality', startAbs: t23(7, 30), endAbs: t23(7, 40), durationMinutes: 10 }], '2': [{ id: 'stop-2', reason: 'quality', startAbs: t23(9, 45), running: true }] },
    }));
    await runOverview(deps, { fullSweep: true });
    const o = mem.state.overview!;
    assert.equal(o.kpis.downtimeClosedMinutes, 10);
    assert.deepEqual(o.kpis.activeStops.map((s: any) => [s.lineId, s.startMs]), [['L1', t23(9, 45)]]);
    assert.deepEqual(o.downtimeReasons, [{ reason: 'quality', label: 'Quality', minutes: 25 }]);
    assert.equal(o.lineCounts.stopped, 1);
  });

  // ── Time & shifts ──
  await test('06:30 cutover and shift context', () => {
    const c = (ms: number) => [dashboardContext(ms).productionDate, dashboardContext(ms).shift];
    assert.deepEqual(c(t23(6, 29)), [D22, 'B']);
    assert.deepEqual(c(t23(6, 30)), [D23, 'A']);
    assert.deepEqual(c(t23(15, 45)), [D23, 'A']); // between shifts: the shift that just ran
    assert.deepEqual(c(t23(18, 59)), [D23, 'A']);
    assert.deepEqual(c(t23(19, 0)), [D23, 'B']);
    assert.deepEqual(c(t23(23, 59)), [D23, 'B']);
    assert.deepEqual(c(at(2026, 10, 24, 2, 0)), [D23, 'B']);
  });

  await test('overnight Shift B: after-midnight slots and late saves stay on the night it started', async () => {
    const { db, deps, mem, setNow } = setup(at(2026, 10, 23, 2, 0)); // 02:00 on the 23rd → production date 22
    db.lines.set('L1', LINE_SD01);
    db.sessions.set('L1', session('L1', { shift: 'B', productionDate: D22, startedAt: t22(19, 0), savedSlotIndices: [0, 1, 6] }));
    db.records.set('r1', rec('L1', D22, 'B', 0, 'full', { produced: 100, expected: 100, rejections: 1, createdAt: t22(20, 1) }).data);
    db.records.set('r2', rec('L1', D22, 'B', 6, 'full', { produced: 80, expected: 100, rejections: 0, createdAt: t23(1, 59) }).data);
    await recomputeLine('L1', deps);
    const doc = mem.lines.get('L1')!;
    assert.equal(doc.current.productionDate, D22);
    assert.equal(doc.current.shift, 'B');
    assert.equal(doc.current.sessionStale, false);
    assert.deepEqual([doc.current.figures.goodProduction, doc.current.figures.planToDate], [180, 200]);
    // A legacy record (no productionDate) saved at 01:30 on Shift B belongs to the 22nd.
    setNow(at(2026, 10, 23, 9, 0));
    const impact = impactOfWrite('productionRecords', 'x', null, { lineId: 'L1', shift: 'B', createdAt: ts(t23(1, 30)) }, dashboardContext(at(2026, 10, 23, 9, 0)));
    assert.deepEqual(impact, { lineIds: ['L1'], dirtyDates: [D22] });
  });

  await test('session left open past the cutover is flagged stale and its own date is kept', () => {
    const s = session('L1', { shift: 'B', productionDate: D22, startedAt: t22(19) });
    const doc = computeLineDoc({ lineId: 'L1', lineDoc: LINE_SD01, session: s, byDate: { [D23]: sources([]), [D22]: sources([]) } }, dashboardContext(t23(8)))!;
    assert.deepEqual([doc.current.productionDate, doc.current.shift, doc.current.sessionStale, doc.day.productionDate], [D22, 'B', true, D23]);
  });

  await test('awaiting entry: same moment as supervisorHandover.buildRunningLineCards', () => {
    const s = session('L1', { startedAt: t23(7), savedSlotIndices: [0, 1] });
    const parsed = parseRunningSession('L1', s);
    const from = awaitingEntryFromMs(parsed);
    assert.equal(from, t23(10, 0)); // 9–10 slot unsaved, ends at 10:00
    for (const now of [t23(9, 30), t23(9, 59), t23(10, 0), t23(11, 30)]) {
      const card = buildRunningLineCards([parsed], [], {}, now)[0];
      const mine = displayStatus({ status: 'running', awaitingEntryFromMs: from }, now);
      assert.equal(mine === 'awaiting_entry', card.status === 'awaiting_entry', new Date(now).toISOString());
    }
    assert.equal(displayStatus({ status: 'stopped', awaitingEntryFromMs: t23(8) }, NOW), 'stopped');
  });

  // ── Finalization & admin end ──
  await test('finalized session: line goes idle, figures from records, downtime from the summary once', async () => {
    const { db, deps, mem } = setup(t23(16, 0));
    db.lines.set('L1', LINE_SD01);
    db.sessions.set('L1', session('L1', { startedAt: t23(7), stopsBySlot: { '1': [{ id: 'stop-A', reason: 'meeting', startAbs: t23(8, 10), endAbs: t23(8, 25), durationMinutes: 15 }] } }));
    db.records.set('r0', rec('L1', D23, 'A', 0, 'full', { produced: 95, expected: 100, rejections: 2, createdAt: t23(8, 2) }).data);
    await recomputeLine('L1', deps);
    assert.equal(mem.lines.get('L1')!.status, 'running');
    // Finalize: unsaved slot submitted, summary written, session deleted.
    const share = [{ stopId: 'stop-A', reason: 'meeting', startAbs: t23(8, 10), endAbs: t23(8, 25), durationMinutes: 15 }];
    db.records.set('r1', rec('L1', D23, 'A', 1, 'full', { produced: 110, expected: 120, rejections: 1, createdAt: t23(15, 40), stopEvents: share }).data);
    db.summaries.set(`L1_${D23}_A`, { lineId: 'L1', productionDate: D23, shift: 'A', workshop: 'Assembly Shop', plannedProductionTotal: 220, actualProductionTotal: 205, downtimeIntervals: share, supervisor: { name: 'Ravi Kumar' } });
    const before = db.sessions.get('L1')!;
    db.sessions.delete('L1');
    await handleSourceWrite('activeSessions', 'L1', before, null, deps);
    const doc = mem.lines.get('L1')!;
    assert.equal(doc.status, 'idle');
    assert.deepEqual([doc.day.shifts.A.goodProduction, doc.day.shifts.A.planToDate, doc.day.shifts.A.rejections], [205, 220, 3]);
    assert.equal(doc.day.shifts.A.downtimeClosedMinutes, 15);
  });

  await test('admin-ended session: archived stops count, unsaved slot quantities do not', () => {
    const ended = {
      ...session('L1', {
        startedAt: t23(7), producedBySlot: { '1': 500 }, rejectionsBySlot: { '1': 50 },
        stopsBySlot: { '0': [{ id: 'stop-E', reason: 'no operator', startAbs: t23(7, 20), endAbs: t23(7, 32), durationMinutes: 12 }] },
      }),
      sessionStatus: 'ended', endReason: 'admin_end', endedBy: { uid: 'uid-secret-1', email: 'ravi@example.com' },
    };
    const saved = rec('L1', D23, 'A', 0, 'full', { produced: 90, expected: 100, rejections: 1, createdAt: t23(8, 3) });
    const doc = computeLineDoc({ lineId: 'L1', lineDoc: LINE_SD01, session: null, byDate: { [D23]: sources([saved], { endedSessions: [ended] }) } }, dashboardContext(NOW))!;
    assert.deepEqual([doc.status, doc.day.shifts.A.goodProduction, doc.day.shifts.A.rejections, doc.day.shifts.A.downtimeClosedMinutes], ['idle', 90, 1, 12]);
  });

  // ── Change detection & guards ──
  await test('unchanged aggregate: recomputing identical sources writes nothing', async () => {
    const { db, deps, mem, setNow } = setup();
    db.lines.set('L1', LINE_SD01);
    db.records.set('r0', rec('L1', D23, 'A', 0, 'full', { produced: 95, expected: 100, rejections: 2, createdAt: t23(8, 2) }).data);
    assert.equal(await recomputeLine('L1', deps), 'write');
    const writes = mem.state.writes;
    setNow(NOW + 60_000);
    assert.equal(await recomputeLine('L1', deps), 'unchanged');
    assert.equal(mem.state.writes, writes);
  });

  await test('activeSessions writes that only change unsaved inputs / sync metadata trigger nothing', async () => {
    const { db, deps } = setup();
    db.lines.set('L1', LINE_SD01);
    const before = session('L1', { startedAt: t23(7) });
    const typing = { ...before, producedBySlot: { '2': 37 }, rejectionsBySlot: { '2': 1 }, revision: 7, clientUpdatedAtMs: NOW, updatedBy: { uid: 'u', deviceId: 'd2', name: 'x' }, operators: [] };
    const r1 = await handleSourceWrite('activeSessions', 'L1', before, typing, deps);
    assert.deepEqual(r1, { lines: {}, dirtyDates: [] });
    const stopping = { ...typing, lineStopped: true, stopsBySlot: { '2': [{ id: 'stop-9', reason: 'training', startAbs: t23(9, 58), running: true }] } };
    db.sessions.set('L1', stopping);
    const r2 = await handleSourceWrite('activeSessions', 'L1', typing, stopping, deps);
    assert.deepEqual(Object.keys(r2.lines), ['L1']);
  });

  await test('stale computation never overwrites a newer one (lines, days, overview)', () => {
    const content = { schemaVersion: 1 } as unknown as LineDocContent;
    const newer = planLineCommit(null, content, 2000).set!;
    assert.equal(planLineCommit(newer, { ...content, lineId: 'changed' } as LineDocContent, 1000).decision, 'stale');
    assert.equal(planLineCommit(newer, null, 1000).decision, 'stale'); // an old delete can't remove a newer doc
    assert.equal(planLineCommit(newer, { ...content, lineId: 'changed' } as LineDocContent, 3000).decision, 'write');
    const day = dayFromLineDocs(D23, []);
    const storedDay = planDayCommit(null, day, 2000, true).set!;
    assert.equal(planDayCommit(storedDay, { ...day, lineCount: 9 }, 1000, true).decision, 'stale');
    const ov = planOverviewCommit(null, {} as any, 2000, {} as any).set!;
    assert.equal(planOverviewCommit(ov, { x: 1 } as any, 1000, {} as any).decision, 'stale');
    assert.equal(decideOverviewWrite(ov as any, ov.contentHash, 2000 + 60_000), 'unchanged');
    assert.equal(decideOverviewWrite(ov as any, ov.contentHash, 2000 + OVERVIEW_HEARTBEAT_MS), 'write'); // heartbeat
  });

  await test('a final day is never replaced by live line sums; a newer dirty flag survives a rebuild', () => {
    const finalDay = { ...dayFromLineDocs(D22, []), final: true, source: 'sources' as const };
    const stored = planDayCommit(null, finalDay, 1000, false).set!;
    assert.equal(planDayCommit(stored, { ...dayFromLineDocs(D22, []), lineCount: 3 }, 2000, true).decision, 'final');
    const dirty = { ...stored, dirty: true, dirtyAtMs: 5000 };
    // Same content, flag set at 5000 is newer than this 4000 computation:
    // nothing is written, so the flag stays and the day is rebuilt again.
    assert.equal(planDayCommit(dirty, finalDay, 4000, false).decision, 'unchanged');
    // Changed content from an older computation still keeps the newer flag.
    const changed = planDayCommit(dirty, { ...finalDay, lineCount: 4 }, 4000, false);
    assert.equal(changed.decision, 'write');
    assert.equal(changed.set!.dirty, true);
    // A computation that started after the flag clears it, even with equal content.
    const cleared = planDayCommit(dirty, finalDay, 6000, false);
    assert.deepEqual([cleared.decision, cleared.set!.dirty], ['write', false]);
  });

  // ── Missing / deleted lines ──
  await test('deleted line: doc removed when idle without records; kept (unregistered) while it has a session or records', async () => {
    const { db, deps, mem } = setup();
    db.lines.set('L1', LINE_SD01);
    db.lines.set('L2', { ...LINE_SD01, lineName: 'SD-02' });
    db.records.set('r', rec('L2', D23, 'A', 0, 'full', { produced: 10, expected: 20, rejections: 0, createdAt: t23(8) }).data);
    await runOverview(deps, { fullSweep: true });
    assert.deepEqual(Array.from(mem.lines.keys()).sort(), ['L1', 'L2']);
    const l1 = db.lines.get('L1')!; db.lines.delete('L1');
    const l2 = db.lines.get('L2')!; db.lines.delete('L2');
    await handleSourceWrite('productionLines', 'L1', l1, null, deps);
    await handleSourceWrite('productionLines', 'L2', l2, null, deps);
    assert.equal(mem.lines.has('L1'), false);
    assert.equal(mem.lines.get('L2')!.registered, false);
    assert.equal(mem.lines.get('L2')!.day.shifts.A.goodProduction, 10);
  });

  await test('line moved out of Assembly is removed; unregistered session without any workshop is excluded', async () => {
    const { db, deps, mem } = setup();
    db.lines.set('L1', LINE_SD01);
    await recomputeLine('L1', deps);
    assert.ok(mem.lines.has('L1'));
    db.lines.set('L1', { ...LINE_SD01, workshop: 'Press Shop' });
    await handleSourceWrite('productionLines', 'L1', LINE_SD01, db.lines.get('L1')!, deps);
    assert.equal(mem.lines.has('L1'), false);
    db.sessions.set('L9', session('L9', { startedAt: t23(7), workshop: null }));
    await recomputeLine('L9', deps);
    assert.equal(mem.lines.has('L9'), false);
  });

  // ── Overview, days, sanitisation ──
  await test('overview: counts, KPIs for the current shift, weekly days built from sources (never invented)', async () => {
    const { db, deps, mem } = setup();
    db.lines.set('L1', LINE_SD01);
    db.lines.set('L2', { ...LINE_SD01, lineName: 'SD-02' });
    db.lines.set('L3', { ...LINE_SD01, lineName: 'SD-03' });
    db.sessions.set('L1', session('L1', { startedAt: t23(7), savedSlotIndices: [0, 1, 2] }));
    db.sessions.set('L2', session('L2', { startedAt: t23(7), savedSlotIndices: [0] })); // awaiting entry
    for (const [id, line, slot, p, e, r] of [['a', 'L1', 0, 95, 100, 2], ['b', 'L1', 1, 110, 120, 1], ['c', 'L2', 0, 80, 100, 0]] as const) {
      db.records.set(id, rec(line, D23, 'A', slot, 'full', { produced: p, expected: e, rejections: r, createdAt: t23(8 + slot) }).data);
    }
    // History: the 22nd (a final day) — and a legacy record without productionDate on the 21st.
    db.records.set('h1', rec('L1', D22, 'B', 0, 'full', { produced: 300, expected: 320, rejections: 5, createdAt: t22(20, 5) }).data);
    db.records.set('h2', rec('L1', null, 'A', 0, 'full', { produced: 150, expected: 160, rejections: 1, createdAt: at(2026, 10, 21, 8, 5), id: 'legacy-21' }).data);
    const res = await runOverview(deps, { fullSweep: true });
    const o = mem.state.overview!;
    assert.deepEqual(o.lineCounts, { total: 3, running: 1, stopped: 0, idle: 1, awaitingEntry: 1 });
    assert.deepEqual([o.kpis.shift, o.kpis.goodProduction, o.kpis.planToDate, o.kpis.achievementPct, o.kpis.rejections], ['A', 285, 320, 89.1, 3]);
    assert.equal(o.operationalState, 'production');
    assert.deepEqual(res.freshness.daysRebuilt, [D22]); // newest missing day first, one per run
    const w = Object.fromEntries(o.weeklyTrend.map((p: any) => [p.productionDate, p]));
    assert.equal(o.weeklyTrend.length, 7);
    assert.deepEqual([w[D22].available, w[D22].final, w[D22].goodProduction, w[D22].planToDate], [true, true, 300, 320]);
    assert.equal(w['2026-10-21'].available, false); // not built yet → unavailable, not zero
    await runOverview(deps, { fullSweep: false });
    const w2 = Object.fromEntries(mem.state.overview!.weeklyTrend.map((p: any) => [p.productionDate, p]));
    assert.deepEqual([w2['2026-10-21'].available, w2['2026-10-21'].goodProduction], [true, 150]); // legacy record found via createdAt window
    assert.deepEqual(o.shiftComparison.A.goodProduction, 285);
  });

  await test('day rollover: line docs of the previous date are recomputed by the overview job', async () => {
    const { db, deps, mem, setNow } = setup(t23(18, 0));
    db.lines.set('L1', LINE_SD01);
    await recomputeLine('L1', deps);
    assert.equal(mem.lines.get('L1')!.day.productionDate, D23);
    setNow(at(2026, 10, 24, 6, 31)); // past the next cutover
    const res = await runOverview(deps, { fullSweep: false });
    assert.equal(res.freshness.linesRecomputed, 1);
    assert.equal(mem.lines.get('L1')!.day.productionDate, '2026-10-24');
  });

  await test('sanitisation: line docs carry only allow-listed fields and no personal data', async () => {
    const { db, deps, mem } = setup();
    db.lines.set('L1', LINE_SD01);
    db.sessions.set('L1', session('L1', { startedAt: t23(7), lineStopped: true, stopsBySlot: { '1': [{ id: 's', reason: 'Ravi Kumar told us to stop', startAbs: t23(9), running: true }] } }));
    db.records.set('r0', rec('L1', D23, 'A', 0, 'full', { produced: 95, expected: 100, rejections: 2, createdAt: t23(8, 2) }).data);
    db.ended.set('e', { ...session('L1', { startedAt: t23(6, 40) }), endedBy: { email: 'ravi@example.com', uid: 'uid-secret-1' } });
    await runOverview(deps, { fullSweep: true });
    const doc = mem.lines.get('L1')!;
    const content = Object.keys(doc).filter((k) => !['contentHash', 'computedAtMs', 'updatedAtMs'].includes(k));
    assert.deepEqual(content.sort(), [...LINE_DOC_FIELDS].sort());
    const everything = stableStringify({ lines: Array.from(mem.lines.values()), days: Array.from(mem.days.values()), overview: mem.state.overview });
    for (const s of SECRETS) assert.ok(!everything.includes(s), `leaked: ${s}`);
    assert.equal(doc.activeStop.reason, 'other');
    assert.equal(typeof doc.updatedAtMs, 'number');
  });

  await test('rebuildDay of today is not final; of a past date with an open session is not final', async () => {
    const { db, deps } = setup();
    db.lines.set('L1', LINE_SD01);
    db.sessions.set('L1', session('L1', { shift: 'B', productionDate: D22, startedAt: t22(19) }));
    assert.equal((await rebuildDay(D23, deps)).day.final, false);
    assert.equal((await rebuildDay(D22, deps)).day.final, false);
    db.sessions.delete('L1');
    assert.equal((await rebuildDay(D22, deps)).day.final, true);
  });

  // ── Early exit for other workshops (pre-deploy review WARNING 2.2) ──
  await test('scope helper: line doc (aliases included) first, then session copy; nothing known → unknown', () => {
    assert.equal(workshopScope('A', LINE_SD01, null), 'assembly');
    assert.equal(workshopScope('A', LINE_SJ02_LEGACY, null), 'assembly'); // legacy `shop: 'Assembly'`
    assert.equal(workshopScope('W', LINE_WELD, null), 'other');
    assert.equal(workshopScope('W', LINE_WELD, { workshop: 'Assembly Shop' }), 'other'); // line doc wins, as in computeLineDoc
    assert.equal(workshopScope('X', { lineName: 'X' }, { workshop: 'Press Shop' }), 'other');
    assert.equal(workshopScope('X', { lineName: 'X' }, { workshop: 'Assembly Shop' }), 'assembly');
    assert.equal(workshopScope('X', { lineName: 'X', workshop: '  ' }, null), 'unknown');
    assert.equal(workshopScope('X', null, null), 'unknown');
  });

  await test('non-Assembly line: exits after its line doc — no session, record, summary or ended-session reads', async () => {
    const { db, deps, mem } = setup();
    db.lines.set('W01', LINE_WELD);
    db.sessions.set('W01', session('W01', { startedAt: t23(7), workshop: 'Welding Shop' }));
    db.records.set('w', rec('W01', D23, 'A', 0, 'full', { produced: 10, expected: 10, rejections: 0, createdAt: t23(8), workshop: 'Welding Shop' }).data);
    assert.equal(await recomputeLine('W01', deps), 'noop');
    assert.deepEqual(db.calls, ['getLine:W01']);
    assert.equal(mem.lines.has('W01'), false);
    // A record write on that line costs the same single read.
    db.calls.length = 0;
    await handleSourceWrite('productionRecords', 'w', null, db.records.get('w')!, deps);
    assert.deepEqual(db.calls, ['getLine:W01']);
  });

  await test('line doc without a workshop: the session copy decides (2 reads); Assembly copy keeps the line', async () => {
    const { db, deps, mem } = setup();
    db.lines.set('P1', { lineName: 'P-01', plant: 'Bawal 1' });
    db.sessions.set('P1', session('P1', { startedAt: t23(7), workshop: 'Press Shop' }));
    assert.equal(await recomputeLine('P1', deps), 'noop');
    assert.deepEqual(db.calls, ['getLine:P1', 'getActiveSession:P1']);
    db.lines.set('A1', { lineName: 'A-01', plant: 'Bawal 2' });
    db.sessions.set('A1', session('A1', { startedAt: t23(7), workshop: 'Assembly Shop' }));
    assert.equal(await recomputeLine('A1', deps), 'write');
    assert.equal(mem.lines.get('A1')!.workshop, 'Assembly Shop');
  });

  await test('legacy Assembly and missing metadata are never excluded by the early exit', async () => {
    const { db, deps, mem } = setup();
    // Legacy aliases on the line doc.
    db.lines.set('SJ02', LINE_SJ02_LEGACY);
    assert.equal(await recomputeLine('SJ02', deps), 'write');
    assert.deepEqual([mem.lines.get('SJ02')!.workshop, mem.lines.get('SJ02')!.plant, mem.lines.get('SJ02')!.lineName], ['Assembly', 'Bawal 2', 'SJ-02']);
    // Line doc with no workshop and no session: only the record copy can tell → full path.
    db.lines.set('N1', { lineName: 'N-01' });
    db.records.set('n', rec('N1', D23, 'A', 0, 'full', { produced: 40, expected: 50, rejections: 0, createdAt: t23(8) }).data);
    assert.equal(await recomputeLine('N1', deps), 'write');
    assert.equal(mem.lines.get('N1')!.day.shifts.A.goodProduction, 40);
    // Deleted line (no line doc, no session) with today's Assembly records → kept, unregistered.
    db.records.set('d', rec('D1', D23, 'A', 0, 'full', { produced: 30, expected: 40, rejections: 0, createdAt: t23(8) }).data);
    assert.equal(await recomputeLine('D1', deps), 'write');
    assert.equal(mem.lines.get('D1')!.registered, false);
  });

  await test('line moved out of Assembly: removed through the early exit (one source read)', async () => {
    const { db, deps, mem } = setup();
    db.lines.set('L1', LINE_SD01);
    await recomputeLine('L1', deps);
    db.lines.set('L1', { ...LINE_SD01, workshop: 'Plating Shop' });
    db.calls.length = 0;
    assert.equal(await recomputeLine('L1', deps), 'delete');
    assert.deepEqual(db.calls, ['getLine:L1']);
    assert.equal(mem.lines.has('L1'), false);
  });

  await test('sweep: only Assembly (incl. legacy) and unscopable lines/sessions are recomputed', async () => {
    const { db, deps, mem } = setup();
    db.lines.set('SD01', LINE_SD01);
    db.lines.set('SJ02', LINE_SJ02_LEGACY);
    db.lines.set('W01', LINE_WELD);
    db.lines.set('N1', { lineName: 'N-01' }); // no workshop anywhere → must be checked
    db.sessions.set('W02', session('W02', { startedAt: t23(7), workshop: 'Welding Shop' })); // no line doc
    db.sessions.set('A9', session('A9', { startedAt: t23(7), workshop: 'Assembly Shop' }));  // no line doc
    await runOverview(deps, { fullSweep: true });
    const queried = new Set(db.calls.filter((c) => c.startsWith('getLine:')).map((c) => c.slice('getLine:'.length)));
    assert.deepEqual(Array.from(queried).sort(), ['A9', 'N1', 'SD01', 'SJ02']);
    assert.ok(!db.calls.some((c) => /:(W01|W02)$/.test(c)), 'other-workshop lines must not be read');
    assert.deepEqual(Array.from(mem.lines.keys()).sort(), ['A9', 'SD01', 'SJ02']); // N1 resolves to no workshop → not shown
  });

  // ── Failure isolation (pre-deploy review BLOCKER 6.1) ──
  await test('one failing line does not stop other lines, today\'s day doc or the overview', async () => {
    const { db, deps, mem, errors } = setup();
    db.lines.set('L1', LINE_SD01);
    db.lines.set('L2', { ...LINE_SD01, lineName: 'SD-02' });
    db.records.set('a', rec('L1', D23, 'A', 0, 'full', { produced: 95, expected: 100, rejections: 2, createdAt: t23(8) }).data);
    db.records.set('b', rec('L2', D23, 'A', 0, 'full', { produced: 50, expected: 100, rejections: 0, createdAt: t23(8) }).data);
    db.failRecordsFor.add('L2');
    const res = await runOverview(deps, { fullSweep: true });
    assert.equal(res.decision, 'write');
    assert.ok(mem.lines.has('L1'));
    assert.equal(mem.lines.has('L2'), false); // no doc rather than a zero doc
    const o = mem.state.overview!;
    assert.deepEqual([o.kpis.goodProduction, o.kpis.planToDate, o.lineCounts.total], [95, 100, 1]);
    assert.deepEqual([o.freshness.failedLines, o.freshness.complete, o.freshness.linesRecomputed], [['L2'], false, 1]);
    assert.equal(mem.days.get(D23)!.totals.goodProduction, 95);
    assert.ok(errors.some((e) => e.msg === 'line recompute failed' && e.meta?.lineId === 'L2'));
  });

  await test('a line that later fails keeps its last good doc (not zero) until it recovers', async () => {
    const { db, deps, mem, setNow } = setup();
    db.lines.set('L1', LINE_SD01);
    db.lines.set('L2', { ...LINE_SD01, lineName: 'SD-02' });
    db.records.set('a', rec('L1', D23, 'A', 0, 'full', { produced: 95, expected: 100, rejections: 2, createdAt: t23(8) }).data);
    db.records.set('b', rec('L2', D23, 'A', 0, 'full', { produced: 50, expected: 100, rejections: 0, createdAt: t23(8) }).data);
    await runOverview(deps, { fullSweep: true });
    assert.equal(mem.state.overview!.kpis.goodProduction, 145);
    db.records.set('b', rec('L2', D23, 'A', 0, 'full', { produced: 80, expected: 100, rejections: 0, createdAt: t23(8), updatedAt: t23(9) }).data);
    db.failRecordsFor.add('L2');
    setNow(NOW + 60_000);
    await runOverview(deps, { fullSweep: true });
    assert.equal(mem.lines.get('L2')!.day.shifts.A.goodProduction, 50);
    assert.deepEqual([mem.state.overview!.kpis.goodProduction, mem.state.overview!.freshness.failedLines], [145, ['L2']]);
    db.failRecordsFor.clear();
    setNow(NOW + 120_000);
    await runOverview(deps, { fullSweep: true });
    assert.deepEqual([mem.state.overview!.kpis.goodProduction, mem.state.overview!.freshness.failedLines, mem.state.overview!.freshness.complete], [175, [], true]);
  });

  await test('a failing historical day does not stop other days or the overview; it shows as unavailable', async () => {
    const { db, deps, mem, errors, setNow } = setup();
    db.lines.set('L1', LINE_SD01);
    db.records.set('h22', rec('L1', D22, 'A', 0, 'full', { produced: 300, expected: 320, rejections: 5, createdAt: t22(8, 5) }).data);
    db.records.set('h21', rec('L1', '2026-10-21', 'A', 0, 'full', { produced: 150, expected: 160, rejections: 1, createdAt: at(2026, 10, 21, 8, 5) }).data);
    db.failDates.add(D22);
    const res = await runOverview(deps, { fullSweep: true });
    assert.deepEqual([res.freshness.failedDays, res.freshness.daysRebuilt, res.freshness.complete], [[D22], ['2026-10-21'], false]);
    const w = Object.fromEntries(mem.state.overview!.weeklyTrend.map((p: any) => [p.productionDate, p]));
    assert.deepEqual([w[D22].available, w[D22].goodProduction], [false, null]); // not zero
    assert.deepEqual([w['2026-10-21'].available, w['2026-10-21'].goodProduction], [true, 150]);
    assert.ok(!mem.days.get(D22)?.contentHash, 'no day doc content for the failed date');
    assert.ok(mem.days.has(D23), "today's day doc still written");
    assert.ok(errors.some((e) => e.msg === 'day rebuild failed' && e.meta?.productionDate === D22));
    // Recovery on a later run.
    db.failDates.clear();
    setNow(NOW + 60_000);
    const res2 = await runOverview(deps, { fullSweep: false });
    assert.deepEqual([res2.freshness.daysRebuilt, res2.freshness.failedDays], [[D22], []]);
    const w2 = Object.fromEntries(mem.state.overview!.weeklyTrend.map((p: any) => [p.productionDate, p]));
    assert.deepEqual([w2[D22].available, w2[D22].goodProduction], [true, 300]);
  });

  await test("today's day doc commit failing still updates the overview (and is reported)", async () => {
    const { db, deps, mem } = setup();
    db.lines.set('L1', LINE_SD01);
    db.records.set('a', rec('L1', D23, 'A', 0, 'full', { produced: 95, expected: 100, rejections: 2, createdAt: t23(8) }).data);
    mem.state.failCommitDay = D23;
    const res = await runOverview(deps, { fullSweep: true });
    assert.equal(res.decision, 'write');
    assert.equal(mem.state.overview!.kpis.goodProduction, 95);
    assert.ok(res.freshness.failedDays.includes(D23));
    assert.equal(res.freshness.complete, false);
  });

  await test('trigger: a failing line is logged and rethrown only after the other affected lines were recomputed', async () => {
    const { db, deps, mem, errors } = setup();
    db.lines.set('L1', LINE_SD01);
    db.lines.set('L2', { ...LINE_SD01, lineName: 'SD-02' });
    db.failRecordsFor.add('L1');
    const before = rec('L1', D23, 'A', 0, 'full', { produced: 1, expected: 1, rejections: 0, createdAt: t23(8) }).data;
    const after = { ...before, lineId: 'L2' }; // a record re-attributed from L1 to L2
    db.records.set('m', after);
    await assert.rejects(handleSourceWrite('productionRecords', 'm', before, after, deps), /L1/);
    assert.ok(mem.lines.has('L2'));
    assert.ok(errors.some((e) => e.msg === 'line recompute failed' && e.meta?.lineId === 'L1'));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main();

