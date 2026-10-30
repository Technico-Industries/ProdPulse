// functions/src/tvDashboard/service.ts
//
// Orchestration of the TV read model: what to read, what to recompute and
// when. Firebase-free (sources and store are injected), so the whole flow is
// exercised by functions/test/tvDashboard.test.ts with in-memory fakes.
//
//   handleSourceWrite  — Firestore triggers: recompute the affected line(s)
//                        from source; mark past day docs dirty.
//   runOverview        — every minute: refresh lines that rolled over to a
//                        new production date (and a full sweep every 15 min),
//                        today's day doc, at most one past day, the overview.
//   rebuildDay         — a production date from ALL sources (incl. legacy
//                        records), used for past days and the daily job.
//
// Failure isolation: in runOverview every line recompute and every day
// rebuild is attempted on its own. A failure is logged and listed in the
// overview's freshness (failedLines / failedDays); the overview, today's
// day doc and every other line/day are still updated. Nothing that failed is
// reported as zero or as available — a failed line keeps its last good doc
// (or has none), a failed day shows as unavailable.

import {
  Data, DashboardContext, DateSources, DayDocContent, LineDocContent, SourceCollection, WEEKLY_DAYS, WriteDecision,
  buildOverview, computeLineDoc, dashboardContext, dayFromLineDocs, dayFromSources, impactOfWrite,
  previousProductionDates, workshopScope, OVERVIEW_HEARTBEAT_MS,
} from './core';
import { OverviewFreshness, StoredLine, TvSources, TvStore } from './store';
import { addDaysToKey } from '../../../src/utils/productionDay';
import { parseRunningSession } from '../../../src/utils/supervisorHandover';

export interface TvDeps {
  sources: TvSources;
  store: TvStore;
  now: () => number;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
  logError?: (msg: string, meta?: Record<string, unknown>) => void;
}

// A full sweep re-derives every Assembly line from source (self-healing for a
// missed trigger, a new line, a line deleted while idle).
export const FULL_SWEEP_EVERY_MINUTES = 15;
// Past days are rebuilt from all sources — bounded per run, newest first.
export const MAX_DAY_REBUILDS_PER_RUN = 1;
// A day that keeps failing must not starve the others: after a failure the
// next due day is tried, up to this many attempts per run.
export const MAX_DAY_REBUILD_ATTEMPTS_PER_RUN = 2;
// A past day that is not final yet (a session of that date still open) is
// re-checked at most this often.
export const OPEN_DAY_RECHECK_MS = 10 * 60 * 1000;
const LINE_CONCURRENCY = 5;

async function inBatches<T>(items: T[], size: number, fn: (item: T) => Promise<unknown>) {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}

export function errorText(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

// ─── Lines ───────────────────────────────────────────────────────────────────

export async function recomputeLine(lineId: string, deps: TvDeps, ctxOverride?: DashboardContext): Promise<WriteDecision> {
  const computedAtMs = deps.now();
  const ctx = ctxOverride ?? dashboardContext(computedAtMs);
  const { sources } = deps;

  // Scope first, from the cheapest docs: a line of another workshop costs
  // one read (two when its line doc has no workshop) instead of the record /
  // summary / ended-session queries. Its read-model doc, if any (e.g. the
  // line just moved out of Assembly), is removed under the usual guard.
  const outOfScope = async () => {
    const decision = await deps.store.commitLine(lineId, null, computedAtMs);
    deps.log?.('line', { lineId, decision, scope: 'other' });
    return decision;
  };
  const lineDoc = await sources.getLine(lineId);
  if (workshopScope(lineId, lineDoc, null) === 'other') return outOfScope();
  const session = await sources.getActiveSession(lineId);
  if (workshopScope(lineId, lineDoc, session) === 'other') return outOfScope();

  const sessionDate = session ? parseRunningSession(lineId, session).productionDate : null;
  const dates = Array.from(new Set([ctx.productionDate, ...(sessionDate ? [sessionDate] : [])]));

  const byDate: Record<string, DateSources> = {};
  await Promise.all(dates.map(async (date) => {
    const [records, summaryA, summaryB, endedSessions] = await Promise.all([
      sources.getLineRecordsForDate(lineId, date),
      sources.getShiftSummary(lineId, date, 'A'),
      sources.getShiftSummary(lineId, date, 'B'),
      sources.getLineEndedSessionsForDate(lineId, date),
    ]);
    byDate[date] = { records, shiftSummaries: [summaryA, summaryB].filter((s): s is Data => !!s), endedSessions };
  }));

  const content = computeLineDoc({ lineId, lineDoc, session, byDate }, { ...ctx, nowMs: computedAtMs });
  const decision = await deps.store.commitLine(lineId, content, computedAtMs);
  deps.log?.('line', { lineId, decision });
  return decision;
}

// One Firestore trigger event. Idempotent: always recomputes from source.
// Marking dirty days and each affected line are independent — one failing
// does not stop the other; the first error is rethrown after all were tried
// (the trigger logs it).
export async function handleSourceWrite(
  collection: SourceCollection,
  docId: string,
  before: Data | null,
  after: Data | null,
  deps: TvDeps
): Promise<{ lines: Record<string, WriteDecision>; dirtyDates: string[] }> {
  const ctx = dashboardContext(deps.now());
  const impact = impactOfWrite(collection, docId, before, after, ctx);
  let firstError: unknown = null;
  if (impact.dirtyDates.length) {
    try {
      await deps.store.markDaysDirty(impact.dirtyDates, ctx.nowMs);
    } catch (e) {
      firstError ??= e;
      deps.logError?.('mark days dirty failed', { collection, docId, dates: impact.dirtyDates, error: errorText(e) });
    }
  }
  const lines: Record<string, WriteDecision> = {};
  for (const lineId of impact.lineIds) {
    try {
      lines[lineId] = await recomputeLine(lineId, deps);
    } catch (e) {
      firstError ??= e;
      deps.logError?.('line recompute failed', { collection, docId, lineId, error: errorText(e) });
    }
  }
  if (firstError) throw firstError;
  return { lines, dirtyDates: impact.dirtyDates };
}

// ─── Days ────────────────────────────────────────────────────────────────────

export async function rebuildDay(productionDate: string, deps: TvDeps): Promise<{ decision: WriteDecision; day: DayDocContent; skippedRecords: number }> {
  const computedAtMs = deps.now();
  const ctx = dashboardContext(computedAtMs);
  const { sources } = deps;
  const [lines, activeSessions, records, shiftSummaries, endedSessions] = await Promise.all([
    sources.listLines(),
    sources.listActiveSessions(),
    sources.getRecordsForDate(productionDate),
    sources.getShiftSummariesForDate(productionDate),
    sources.getEndedSessionsForDate(productionDate),
  ]);
  const { day, skippedRecords } = dayFromSources(
    { productionDate, lines, activeSessions, records, shiftSummaries, endedSessions },
    computedAtMs,
    ctx.productionDate
  );
  // Built from every source, so it may replace a final doc (e.g. after a
  // late edit of that day marked it dirty).
  const decision = await deps.store.commitDay(productionDate, day, computedAtMs, { protectFinal: false });
  deps.log?.('day', { productionDate, decision, skippedRecords });
  return { decision, day, skippedRecords };
}

// Daily job (06:45 plant time): the production date that ended at 06:30.
export async function finalizePreviousDay(deps: TvDeps) {
  const ctx = dashboardContext(deps.now());
  return rebuildDay(addDaysToKey(ctx.productionDate, -1), deps);
}

// ─── Overview ────────────────────────────────────────────────────────────────

// Lines the sweep re-derives: every existing read-model doc (so a line that
// left Assembly or was deleted is cleaned up), plus every registered line and
// every live session that is Assembly or can't be scoped from its line doc /
// session copy alone. Lines and sessions of other workshops are skipped.
async function sweepLineIds(deps: TvDeps, stored: StoredLine[]): Promise<string[]> {
  const [lines, sessions] = await Promise.all([deps.sources.listLines(), deps.sources.listActiveSessions()]);
  const lineById = new Map(lines.map((l) => [l.id, l.data]));
  const sessionById = new Map(sessions.map((s) => [s.id, s.data])); // activeSessions doc id = line id
  const ids = new Set<string>(stored.map((s) => s.id));
  new Set([...lineById.keys(), ...sessionById.keys()]).forEach((id) => {
    if (workshopScope(id, lineById.get(id) ?? null, sessionById.get(id) ?? null) !== 'other') ids.add(id);
  });
  return Array.from(ids);
}

export async function runOverview(deps: TvDeps, opts: { fullSweep?: boolean } = {}) {
  const generatedAtMs = deps.now();
  const ctx = dashboardContext(generatedAtMs);
  let stored = await deps.store.listLineDocs();
  const failedLines: string[] = [];
  const failedDays: string[] = [];
  const rolledOver = () => stored.filter((s) => s.content.day.productionDate !== ctx.productionDate).map((s) => s.id);

  const sweep = opts.fullSweep ?? (stored.length === 0 || new Date(generatedAtMs).getMinutes() % FULL_SWEEP_EVERY_MINUTES === 0);
  let sweepFailed = false;
  let toRecompute: string[];
  if (sweep) {
    try {
      toRecompute = await sweepLineIds(deps, stored);
    } catch (e) {
      // Listing failed: still refresh what we know about, sweep next time.
      sweepFailed = true;
      deps.logError?.('sweep listing failed', { error: errorText(e) });
      toRecompute = rolledOver();
    }
  } else {
    toRecompute = rolledOver();
  }

  let linesRecomputed = 0;
  await inBatches(toRecompute, LINE_CONCURRENCY, async (lineId) => {
    try {
      await recomputeLine(lineId, deps);
      linesRecomputed++;
    } catch (e) {
      // The line keeps its last good doc (or has none) — never a zero.
      failedLines.push(lineId);
      deps.logError?.('line recompute failed', { lineId, error: errorText(e) });
    }
  });
  if (toRecompute.length) stored = await deps.store.listLineDocs();

  // Lines whose doc is still for another date (e.g. their recompute just
  // failed after the cutover) are left out of today's sums by
  // dayFromLineDocs, not counted as zero.
  const lines: LineDocContent[] = stored.map((s) => s.content);
  const today = dayFromLineDocs(ctx.productionDate, lines);
  try {
    await deps.store.commitDay(ctx.productionDate, today, generatedAtMs, { protectFinal: true });
  } catch (e) {
    failedDays.push(ctx.productionDate);
    deps.logError?.('day commit failed', { productionDate: ctx.productionDate, error: errorText(e) });
  }

  // Weekly window: never invented — a missing day is rebuilt from sources
  // (bounded per run) and shown as unavailable until it exists.
  const past = previousProductionDates(ctx.productionDate, WEEKLY_DAYS);
  const storedDays = await deps.store.getDays(past);
  const due = [...past].reverse().filter((d) => {
    const s = storedDays[d];
    if (!s || !s.content || s.dirty) return true;
    return !s.content.final && (s.computedAtMs == null || generatedAtMs - s.computedAtMs >= OPEN_DAY_RECHECK_MS);
  });
  const daysRebuilt: string[] = [];
  let attempts = 0;
  for (const d of due) {
    if (daysRebuilt.length >= MAX_DAY_REBUILDS_PER_RUN || attempts >= MAX_DAY_REBUILD_ATTEMPTS_PER_RUN) break;
    attempts++;
    try {
      const { day } = await rebuildDay(d, deps);
      storedDays[d] = { content: day, computedAtMs: generatedAtMs, dirty: false, dirtyAtMs: null };
      daysRebuilt.push(d);
    } catch (e) {
      failedDays.push(d);
      deps.logError?.('day rebuild failed', { productionDate: d, error: errorText(e) });
    }
  }
  // A day whose rebuild failed this run is shown as unavailable: it was due
  // because it is missing, dirty (known to be outdated) or not final.
  const pastContent: Record<string, DayDocContent | null> = {};
  past.forEach((d) => { pastContent[d] = failedDays.includes(d) ? null : storedDays[d]?.content ?? null; });

  const overview = buildOverview(ctx, lines, today, pastContent, generatedAtMs);
  const computed = stored.map((s) => s.computedAtMs).filter((n): n is number => n != null);
  const updated = stored.map((s) => s.updatedAtMs).filter((n): n is number => n != null);
  const freshness: OverviewFreshness = {
    generatedAtMs,
    heartbeatMs: OVERVIEW_HEARTBEAT_MS,
    complete: failedLines.length === 0 && failedDays.length === 0 && !sweepFailed,
    lineDocCount: stored.length,
    linesRecomputed,
    failedLines: [...failedLines].sort(),
    daysRebuilt,
    failedDays,
    sweepFailed,
    staleLineDocs: lines.filter((l) => l.day.productionDate !== ctx.productionDate).length,
    oldestLineComputedAtMs: computed.length ? Math.min(...computed) : null,
    newestLineUpdatedAtMs: updated.length ? Math.max(...updated) : null,
  };
  const decision = await deps.store.commitOverview(overview, generatedAtMs, freshness);
  deps.log?.('overview', { decision, sweep, linesRecomputed, failedLines: freshness.failedLines, daysRebuilt, failedDays });
  return { decision, overview, freshness, sweep };
}
