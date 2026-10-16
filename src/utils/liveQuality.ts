// src/utils/liveQuality.ts
//
// Pure logic behind the "Live Quality Lines" swipe page
// (src/screens/LiveQualityLinesScreen.tsx): Quality % of every
// production line's CURRENT session. Kept free of React/Firebase so it can
// be checked by scripts/testLiveQuality.ts (npm run test:live-quality).
//
// Reuses, unchanged:
//   • lineEfficiency.ts — session ↔ productionRecords matching (line +
//     production date + shift, one record per slot/segment, see
//     recordsForSession) and the running stop event of a stopped session
//     (currentStop);
//   • qualityMetrics.ts — the quality formula and its data source
//     (counterQuality): the Record Production rejection counter, stored on
//     each slot's productionRecords doc as `rejections`.
//
// Good parts and rejections come from the SAME de-duplicated session
// records, so a re-saved slot replaces its old figures instead of adding to
// them. rejectionRecords (Record Rejection screen) are not used at all.

import {
  LiveSession,
  EfficiencyRecord,
  RegisteredLine,
  StopInfo,
  currentStop,
  recordsForSession,
} from './lineEfficiency';
import { computeQuality, counterQuality } from './qualityMetrics';

// ─── Thresholds ──────────────────────────────────────────────────────────────
// Initial UI thresholds (no official company limits exist in the project).
// Change them here only — the gauges, badges, legend and summary all read
// from this one place.

export type QualityStatus = 'good' | 'warning' | 'critical' | 'unavailable';

export const QUALITY_THRESHOLDS = {
  good: 98, // quality ≥ 98 → Good
  warning: 95, // 95 ≤ quality < 98 → Warning; below → Critical
};

export const QUALITY_COLORS: Record<QualityStatus, string> = {
  good: '#4C9A6A',
  warning: '#F2A93B',
  critical: '#D64545',
  unavailable: '#5C6670',
};

export const QUALITY_LABELS: Record<QualityStatus, string> = {
  good: 'Good',
  warning: 'Warning',
  critical: 'Critical',
  unavailable: 'No data',
};

// null (not calculable) → 'unavailable'. Takes the same rounded figure that
// is displayed, so the colour always agrees with the number on screen.
export function qualityStatus(qualityPct: number | null): QualityStatus {
  if (qualityPct == null || !Number.isFinite(qualityPct)) return 'unavailable';
  if (qualityPct >= QUALITY_THRESHOLDS.good) return 'good';
  if (qualityPct >= QUALITY_THRESHOLDS.warning) return 'warning';
  return 'critical';
}

// ─── Records ─────────────────────────────────────────────────────────────────

// A productionRecords slot doc with its rejection counter. `rejections` is
// absent on legacy records (see counterQuality).
export interface LiveRecord extends EfficiencyRecord {
  rejections?: number | null;
}

// ─── Per-line cards ──────────────────────────────────────────────────────────

export type RunState = 'running' | 'stopped';

export interface QualityCard {
  lineId: string;
  lineName: string;
  plant: string | null;
  workshop: string | null;
  division: string | null;
  session: LiveSession;
  runState: RunState;
  // 'Running', or the recorded stop reason ('Maintenance', 'Material
  // Shortage', …). A stopped session with no recorded reason is 'Stopped'.
  runLabel: string;
  stop: StopInfo | null;
  // null when the production records aren't loaded.
  goodParts: number | null;
  // null when not loaded, or when every saved slot is a legacy record.
  rejectedParts: number | null;
  inspectedParts: number | null;
  qualityPct: number | null;
  rejectionPct: number | null;
  // Saved slots of this session left out for lacking a rejection counter.
  legacyRecords: number;
  // Saved slot records counted for this session.
  savedSlots: number;
  status: QualityStatus;
  color: string;
}

export interface NotRunningLine {
  lineId: string;
  lineName: string;
}

const STATUS_ORDER: Record<QualityStatus, number> = { critical: 0, warning: 1, good: 2, unavailable: 3 };

// One card per active session (activeSessions doc), worst quality first.
// productionLines supplies names/locations and the list of lines with no
// active session; a session on a line that's no longer registered still
// gets a card, so a live session is never hidden.
// `records` null = productionRecords not loaded (or failed) → every quality
// is unavailable rather than a misleading 0% or 100%.
export function buildQualityCards(
  lines: RegisteredLine[],
  sessions: LiveSession[],
  records: LiveRecord[] | null
): { cards: QualityCard[]; notRunning: NotRunningLine[] } {
  const lineById = new Map(lines.map((l) => [l.id, l]));

  const cards = sessions.map((session): QualityCard => {
    const line = lineById.get(session.lineId);
    const sessionRecords = records ? recordsForSession(session, records) : null;
    const q = sessionRecords
      ? counterQuality(sessionRecords)
      : { ...computeQuality(0, null), goodParts: null, legacyRecords: 0 };
    const status = qualityStatus(q.qualityPct);
    const stop = session.lineStopped ? currentStop(session) : null;
    return {
      lineId: session.lineId,
      lineName: line?.lineName ?? session.lineName ?? session.lineId,
      plant: line?.plant ?? null,
      workshop: line?.workshop ?? null,
      division: line?.division ?? null,
      session,
      runState: session.lineStopped ? 'stopped' : 'running',
      runLabel: session.lineStopped ? stop?.label ?? 'Stopped' : 'Running',
      stop,
      goodParts: q.goodParts,
      rejectedParts: q.rejectedParts,
      inspectedParts: q.inspectedParts,
      qualityPct: q.qualityPct,
      rejectionPct: q.rejectionPct,
      legacyRecords: q.legacyRecords,
      savedSlots: sessionRecords?.length ?? 0,
      status,
      color: QUALITY_COLORS[status],
    };
  });

  const active = new Set(sessions.map((s) => s.lineId));
  const notRunning = lines
    .filter((l) => !active.has(l.id))
    .map((l) => ({ lineId: l.id, lineName: l.lineName ?? l.id }))
    .sort((a, b) => a.lineName.localeCompare(b.lineName));

  return {
    cards: cards.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.lineName.localeCompare(b.lineName)),
    notRunning,
  };
}

// Summary tiles, from the same cards the gauges render.
export function summarizeQuality(cards: QualityCard[]) {
  // A session with no saved slots yet has 0 rejections; any other unknown
  // count (not loaded, legacy records only) makes the total unknown, so it's
  // never silently short.
  const rejectedKnown = cards.every((c) => c.rejectedParts != null);
  return {
    activeSessions: cards.length,
    running: cards.filter((c) => c.runState === 'running').length,
    stopped: cards.filter((c) => c.runState === 'stopped').length,
    good: cards.filter((c) => c.status === 'good').length,
    warning: cards.filter((c) => c.status === 'warning').length,
    critical: cards.filter((c) => c.status === 'critical').length,
    unavailable: cards.filter((c) => c.status === 'unavailable').length,
    totalRejected: rejectedKnown ? cards.reduce((s, c) => s + (c.rejectedParts ?? 0), 0) : null,
  };
}
