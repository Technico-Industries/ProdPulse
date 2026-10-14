// src/utils/lineEfficiency.ts
//
// Pure logic behind the admin "Line Efficiency Overview" page
// (src/screens/LineEfficiencyOverviewScreen.tsx): live status of every
// registered line, and the efficiency of each line's CURRENT session.
// Kept free of React/Firebase so it can be checked by
// scripts/testLineEfficiency.ts (npm run test:line-efficiency).
//
// FORMULA — the project's existing one (GenerateReportScreen summary):
//   efficiency = Σ producedThisSlot / Σ expectedParts × 100
// summed per line over the records of that line's active session — never an
// average of per-slot percentages. No (or zero) planned production → null,
// rendered as "—", never 0% or Infinity.

// ─── Efficiency bands ────────────────────────────────────────────────────────
// Contiguous, non-overlapping: (90, ∞) green, [75, 90] amber, [50, 75) red,
// [0, 50) purple. Inactive lines are always gray, whatever they did earlier.

export type EfficiencyBand = 'excellent' | 'warning' | 'poor' | 'critical';

export const BAND_COLORS: Record<EfficiencyBand, string> = {
  excellent: '#4C9A6A',
  warning: '#F2A93B',
  poor: '#D64545',
  critical: '#8B5CF6',
};
export const INACTIVE_COLOR = '#5C6670';

export const BAND_LABELS: Record<EfficiencyBand, string> = {
  excellent: 'Excellent',
  warning: 'Warning',
  poor: 'Poor',
  critical: 'Critical',
};

export function efficiencyBand(pct: number): EfficiencyBand {
  if (pct > 90) return 'excellent';
  if (pct >= 75) return 'warning';
  if (pct >= 50) return 'poor';
  return 'critical';
}

// ─── Efficiency ──────────────────────────────────────────────────────────────

export interface EfficiencyRecord {
  lineId: string | null;
  shift: string | null;
  productionDate: string | null;
  expectedParts: number | null;
  producedThisSlot: number | null;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export interface EfficiencyTotals {
  actual: number;
  planned: number;
  // Rounded to 1 decimal. The band is taken from this same rounded value, so
  // the colour always agrees with the number on screen.
  efficiency: number | null;
}

export function efficiencyOf(records: EfficiencyRecord[]): EfficiencyTotals {
  let actual = 0;
  let planned = 0;
  records.forEach((r) => {
    actual += num(r.producedThisSlot);
    planned += num(r.expectedParts);
  });
  const efficiency = planned > 0 ? Math.round((actual / planned) * 1000) / 10 : null;
  return { actual, planned, efficiency };
}

// ─── Live status ─────────────────────────────────────────────────────────────

export interface SessionStopEvent {
  reason?: string | null;
  startAbs?: number | null;
  running?: boolean | null;
}

export interface LiveSession {
  lineId: string;
  lineName: string | null;
  shift: string | null;
  productionDate: string | null;
  lineStopped: boolean;
  stopsBySlot: Record<string, SessionStopEvent[] | null | undefined> | null;
  startedAtMs: number | null;
  updatedAtMs: number | null;
}

export type LineStatus = 'running' | 'stopped' | 'not_running';

export interface StopInfo {
  // Raw reason as recorded (e.g. 'maintenance'), or null when the session is
  // flagged stopped but no running stop event carries a reason.
  reason: string | null;
  label: string | null;
  sinceMs: number | null;
}

// Display form of a recorded stop reason ('material shortage' → 'Material
// Shortage', '5s' → '5S'). Purely cosmetic — the reason itself always comes
// from the session's stop events, never invented.
export function formatStopReason(reason: string): string {
  return reason
    .trim()
    .split(/\s+/)
    .map((w) => w.split('/').map((p) => (p ? p[0].toUpperCase() + p.slice(1) : p)).join('/'))
    .join(' ')
    .replace(/\b(\d+)s\b/gi, '$1S');
}

// The currently running stop of a session (latest-started one if, unusually,
// more than one is running).
export function currentStop(session: LiveSession): StopInfo {
  let best: SessionStopEvent | null = null;
  Object.values(session.stopsBySlot ?? {}).forEach((arr) => {
    (arr ?? []).forEach((ev) => {
      if (!ev?.running) return;
      if (!best || num(ev.startAbs) > num(best.startAbs)) best = ev;
    });
  });
  const ev = best as SessionStopEvent | null;
  const reason = ev?.reason && ev.reason.trim() ? ev.reason.trim() : null;
  return {
    reason,
    label: reason ? formatStopReason(reason) : null,
    sinceMs: ev && Number.isFinite(ev.startAbs) ? (ev.startAbs as number) : null,
  };
}

// Badge text for a stopped line: the two reasons that are line states in
// their own right get their own badge, everything else is "Stopped" with the
// recorded reason shown underneath.
export function stoppedBadge(reason: string | null): string {
  const r = (reason ?? '').toLowerCase();
  if (r === 'maintenance') return 'Maintenance';
  if (r === 'quality') return 'Quality Hold';
  return 'Stopped';
}

// ─── Per-line cards ──────────────────────────────────────────────────────────

export interface RegisteredLine {
  id: string;
  lineName: string | null;
  plant: string | null;
  workshop: string | null;
  division: string | null;
}

export interface LineCard {
  lineId: string;
  lineName: string;
  plant: string | null;
  workshop: string | null;
  division: string | null;
  status: LineStatus;
  badge: string;
  // Gray for not-running lines; band colour (or gray when there's no plan
  // yet) for active ones.
  color: string;
  band: EfficiencyBand | null;
  efficiency: number | null;
  actual: number;
  planned: number;
  stop: StopInfo | null;
  session: LiveSession | null;
}

// A record belongs to a session when it is for the same line, production
// date and shift — the same identity RecordProductionScreen keys its
// deterministic productionRecords IDs on.
export function recordsForSession<R extends EfficiencyRecord>(session: LiveSession, records: R[]): R[] {
  return records.filter(
    (r) =>
      r.lineId === session.lineId &&
      r.productionDate != null &&
      r.productionDate === session.productionDate &&
      (session.shift == null || r.shift === session.shift)
  );
}

const STATUS_ORDER: Record<LineStatus, number> = { stopped: 0, running: 1, not_running: 2 };

// One card per registered line (productionLines is the master list, so
// lines with no session or no records still appear), plus a card for any
// active session whose line is no longer registered, so a live session is
// never hidden. Sorted stopped → running → not running, then by name.
export function buildLineCards(
  lines: RegisteredLine[],
  sessions: LiveSession[],
  records: EfficiencyRecord[]
): LineCard[] {
  const sessionByLine = new Map(sessions.map((s) => [s.lineId, s]));
  const known = new Set(lines.map((l) => l.id));
  const all: RegisteredLine[] = [
    ...lines,
    ...sessions
      .filter((s) => !known.has(s.lineId))
      .map((s) => ({ id: s.lineId, lineName: s.lineName, plant: null, workshop: null, division: null })),
  ];

  const cards = all.map((line): LineCard => {
    const session = sessionByLine.get(line.id) ?? null;
    const name = line.lineName ?? session?.lineName ?? line.id;
    if (!session) {
      return {
        lineId: line.id, lineName: name, plant: line.plant, workshop: line.workshop, division: line.division,
        status: 'not_running', badge: 'Not Running', color: INACTIVE_COLOR, band: null,
        efficiency: null, actual: 0, planned: 0, stop: null, session: null,
      };
    }
    const totals = efficiencyOf(recordsForSession(session, records));
    const band = totals.efficiency != null ? efficiencyBand(totals.efficiency) : null;
    const stop = session.lineStopped ? currentStop(session) : null;
    return {
      lineId: line.id, lineName: name, plant: line.plant, workshop: line.workshop, division: line.division,
      status: session.lineStopped ? 'stopped' : 'running',
      badge: session.lineStopped ? stoppedBadge(stop?.reason ?? null) : 'Running',
      color: band ? BAND_COLORS[band] : INACTIVE_COLOR,
      band,
      efficiency: totals.efficiency,
      actual: totals.actual,
      planned: totals.planned,
      stop,
      session,
    };
  });

  return cards.sort(
    (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.lineName.localeCompare(b.lineName)
  );
}

export function summarize(cards: LineCard[]) {
  return {
    total: cards.length,
    running: cards.filter((c) => c.status === 'running').length,
    stopped: cards.filter((c) => c.status === 'stopped').length,
    notRunning: cards.filter((c) => c.status === 'not_running').length,
  };
}

// ─── Plant / Workshop filter ─────────────────────────────────────────────────
// Case/whitespace-insensitive, the same matching the other admin screens use.
// null means "All". A card with no plant/workshop (a live session on a line
// that's no longer registered) only shows while that filter is "All".

function sameValue(a: string | null | undefined, b: string | null | undefined) {
  if (a == null || b == null) return false;
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

export function filterLineCards(
  cards: LineCard[],
  filters: { plant: string | null; workshop: string | null }
): LineCard[] {
  return cards.filter(
    (c) =>
      (!filters.plant || sameValue(c.plant, filters.plant)) &&
      (!filters.workshop || sameValue(c.workshop, filters.workshop))
  );
}
