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

import { ShiftCode, buildSlots, formatAbsMinutes24, scheduleProfileFor } from './productionSchedule';
import { isProductionDayKey, millisToProductionDayMinute } from './productionDay';
import { stopDurationMinutes, stopIdOf } from './downtime';
import { counterQuality } from './qualityMetrics';

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
  // Slot identity, used to count every slot exactly once (see
  // dedupeSlotRecords). Optional so callers without them still work.
  id?: string | null;
  slotIndex?: number | null;
  partSegment?: string | null; // null = 'full', else 'before' / 'after'
  createdAtMs?: number | null;
  updatedAtMs?: number | null;
  // Detail-sheet fields (all optional — older callers don't pass them).
  rejections?: number | null; // Record Production rejection counter; null on legacy records
  partName?: string | null;
  supervisorName?: string | null; // supervisor who saved the slot
  lossReasonLabel?: string | null;
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
  // Which run of the line's session this is (utils/endProduction
  // sessionInstanceOf) — checked by the admin End Production action.
  sessionInstance?: string | null;
  // Slot schedule of the session (optional — older callers don't pass
  // them; without them no slot can be judged "ended without an entry").
  otHours?: number | null;
  productionStartMinutesAbs?: number | null;
  plant?: string | null;
  workshop?: string | null;
  scheduleProfile?: string | null;
  deletedSlotIndices?: number[] | null;
  selectedPartIndex?: number | null;
  supervisorName?: string | null; // session starter
  // Who is running the line now: the supervisor behind the session's latest
  // sync (activeSessions.updatedBy.name) — follows a supervisor handover.
  currentSupervisorName?: string | null;
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
  // Part names, by index (optional) — the current model when nothing is saved yet.
  parts?: { name: string | null }[] | null;
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

// Same deterministic ID RecordProductionScreen's productionRecordId() writes.
function canonicalRecordId(r: EfficiencyRecord, segment: string): string {
  return ['pr', r.productionDate ?? '', r.lineId ?? '', r.shift ?? '', String(r.slotIndex), segment]
    .map((v) => encodeURIComponent(v))
    .join('|');
}

// One logical slot is stored as either ONE 'full' record or a 'before' +
// 'after' pair (a changeover slot). Two things can still leave extra docs
// for a slot, and neither may be counted twice:
//   • legacy addDoc() duplicates of the same slot + segment — keep the doc
//     RecordProductionScreen itself would update: the canonical-ID doc if
//     present, else the earliest-created one;
//   • both shapes at once (a changeover added/removed and the superseded
//     record not yet deleted) — keep the shape written most recently.
// Records without a slotIndex can't be matched to a slot and are kept as-is.
// Expects records of ONE session (line + date + shift).
export function dedupeSlotRecords<R extends EfficiencyRecord>(records: R[]): R[] {
  const loose: R[] = [];
  const bySlot = new Map<number, Map<string, R[]>>();
  records.forEach((r) => {
    if (typeof r.slotIndex !== 'number' || !Number.isFinite(r.slotIndex)) {
      loose.push(r);
      return;
    }
    const seg = r.partSegment ?? 'full';
    const segs = bySlot.get(r.slotIndex) ?? new Map<string, R[]>();
    segs.set(seg, [...(segs.get(seg) ?? []), r]);
    bySlot.set(r.slotIndex, segs);
  });

  const out: R[] = [...loose];
  bySlot.forEach((segs) => {
    const kept = new Map<string, R>();
    segs.forEach((docs, seg) => {
      const canonical = docs.find((d) => d.id != null && d.id === canonicalRecordId(d, seg));
      kept.set(
        seg,
        canonical ??
          [...docs].sort(
            (a, b) => num(a.createdAtMs) - num(b.createdAtMs) || String(a.id ?? '').localeCompare(String(b.id ?? ''))
          )[0]
      );
    });
    const full = kept.get('full');
    const split = [...kept.entries()].filter(([seg]) => seg !== 'full').map(([, r]) => r);
    if (full && split.length) {
      const splitLatest = Math.max(...split.map((r) => num(r.updatedAtMs)));
      out.push(...(num(full.updatedAtMs) > splitLatest ? [full] : split));
    } else {
      out.push(...kept.values());
    }
  });
  return out;
}

// A record belongs to a session when it is for the same line, production
// date and shift — the same identity RecordProductionScreen keys its
// deterministic productionRecords IDs on. Each slot is counted once.
export function recordsForSession<R extends EfficiencyRecord>(session: LiveSession, records: R[]): R[] {
  return dedupeSlotRecords(
    records.filter(
      (r) =>
        r.lineId === session.lineId &&
        r.productionDate != null &&
        r.productionDate === session.productionDate &&
        (session.shift == null || r.shift === session.shift)
    )
  );
}

// "Actual / Target" text under a line's name. Inactive lines and active ones
// with nothing saved yet show "— / —" (never historical totals); a missing
// target shows "—" rather than 0.
export function productionFigures(card: Pick<LineCard, 'status' | 'actual' | 'planned'>): string {
  if (card.status === 'not_running' || (card.actual === 0 && card.planned === 0)) return '— / —';
  const fmt = (n: number) => Math.round(n).toLocaleString();
  return `${fmt(card.actual)} / ${card.planned > 0 ? fmt(card.planned) : '—'}`;
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
  filters: { plant: string | null; workshop: string | null; division?: string | null }
): LineCard[] {
  return cards.filter(
    (c) =>
      (!filters.plant || sameValue(c.plant, filters.plant)) &&
      (!filters.workshop || sameValue(c.workshop, filters.workshop)) &&
      (!filters.division || sameValue(c.division, filters.division))
  );
}

// ─── Live line status (phone "Lines" list) ───────────────────────────────────
// One status per line, used for the row dot, the grouping and the plant
// summary. Thresholds (inclusive lower bounds, on the 1-decimal figure shown):
//   excellent ≥ 90 · warning 75–90 · poor < 75 — no upper cap (105% is excellent)
//   noEntry    — an active session, but nothing saved yet, or the latest slot
//                that has already ended has no saved record
//   notRunning — no active session this shift
// (The app has no separate production-plan collection: "has a plan" is the
// active session itself.)

export type LiveLineStatus = 'excellent' | 'warning' | 'poor' | 'noEntry' | 'notRunning';

export const STATUS_THRESHOLDS = { excellent: 90, warning: 75 } as const;

export const LIVE_STATUS_COLORS: Record<LiveLineStatus, string> = {
  excellent: '#4C9A6A',
  warning: '#F2A93B',
  poor: '#D64545',
  noEntry: '#8A96A3',
  notRunning: '#5C6670',
};

export interface LineStatusInput {
  hasSession: boolean;
  efficiency: number | null;
  // True when the latest slot that has already ended has no saved record.
  missedSlot?: boolean;
}

export function getLineStatus(line: LineStatusInput): LiveLineStatus {
  if (!line.hasSession) return 'notRunning';
  if (line.efficiency == null || !Number.isFinite(line.efficiency) || line.missedSlot) return 'noEntry';
  if (line.efficiency >= STATUS_THRESHOLDS.excellent) return 'excellent';
  if (line.efficiency >= STATUS_THRESHOLDS.warning) return 'warning';
  return 'poor';
}

// ─── Hourly slot bars ────────────────────────────────────────────────────────

export type SlotBarState = 'saved' | 'missing' | 'current' | 'future';

export interface SlotBar {
  index: number;
  label: string; // "07" — the slot's clock hour, 24 h
  startAbs: number;
  endAbs: number;
  state: SlotBarState;
  actual: number | null;
  target: number | null;
}

function normalizeShiftCode(v: unknown): ShiftCode {
  return v === 'B' ? 'B' : 'A';
}

// The session's current minute in its production-day frame, or null when
// the session has no usable production date.
export function sessionNowAbs(session: LiveSession, nowMs: number): number | null {
  return isProductionDayKey(session.productionDate) ? millisToProductionDayMinute(session.productionDate, nowMs) : null;
}

// Every non-break slot of the session's shift (from its production start,
// deleted cards left out), with what was saved for it. Expects the
// session's own de-duplicated records (recordsForSession).
export function sessionSlotBars(session: LiveSession, sessionRecords: EfficiencyRecord[], nowMs: number): SlotBar[] {
  const profile = scheduleProfileFor({
    plant: session.plant,
    workshop: session.workshop,
    scheduleProfile: session.scheduleProfile,
  });
  const ot = typeof session.otHours === 'number' && Number.isFinite(session.otHours) ? Math.max(0, session.otHours) : 0;
  const start =
    typeof session.productionStartMinutesAbs === 'number' && Number.isFinite(session.productionStartMinutesAbs)
      ? session.productionStartMinutesAbs
      : null;
  const deleted = new Set(session.deletedSlotIndices ?? []);
  const nowAbs = sessionNowAbs(session, nowMs);

  const bySlot = new Map<number, EfficiencyRecord[]>();
  sessionRecords.forEach((r) => {
    if (typeof r.slotIndex !== 'number') return;
    bySlot.set(r.slotIndex, [...(bySlot.get(r.slotIndex) ?? []), r]);
  });

  return buildSlots(normalizeShiftCode(session.shift), ot, [], start, profile)
    .filter((s) => !s.isBreak && !deleted.has(s.index))
    .map((s): SlotBar => {
      const recs = bySlot.get(s.index);
      let state: SlotBarState;
      if (recs?.length) state = 'saved';
      else if (nowAbs == null || nowAbs < s.startMinutesAbs) state = 'future';
      else if (nowAbs < s.endMinutesAbs) state = 'current';
      else state = 'missing';
      const totals = recs?.length ? efficiencyOf(recs) : null;
      return {
        index: s.index,
        label: formatAbsMinutes24(s.hourStartAbs).slice(0, 2),
        startAbs: s.startMinutesAbs,
        endAbs: s.endMinutesAbs,
        state,
        actual: totals ? totals.actual : null,
        target: totals ? totals.planned : null,
      };
    });
}

// The latest saved slot: "15:00–16:00" and its quantity, or null when
// nothing is saved yet.
export function lastSavedSlot(slots: SlotBar[]): { label: string; pcs: number } | null {
  const saved = slots.filter((s) => s.state === 'saved');
  if (saved.length === 0) return null;
  const s = saved.reduce((a, b) => (b.endAbs > a.endAbs ? b : a));
  return { label: `${formatAbsMinutes24(s.startAbs)}–${formatAbsMinutes24(s.endAbs)}`, pcs: s.actual ?? 0 };
}

// ─── Capsule text (Lines grid) ───────────────────────────────────────────────
// Short enough to always fit a ~150 px capsule without truncation.

// "64.6%" under 100, whole number from 100 ("100%", "105%"); "—" if unknown.
export function formatCapsulePct(pct: number | null | undefined): string {
  if (pct == null || !Number.isFinite(pct)) return '—';
  const r = Math.round(pct * 10) / 10;
  return r >= 100 ? `${Math.round(r)}%` : `${r.toFixed(1)}%`;
}

// "1,440" with thousands separators; from 10,000 compact: "12.4k", "15k",
// "1.2M". Locale-independent, so web and Android agree.
export function formatCapsuleCount(n: number): string {
  const v = Math.round(Math.max(0, n));
  const compact = (x: number, unit: string) => `${String(Math.round(x * 10) / 10)}${unit}`;
  if (v >= 1_000_000) return compact(v / 1_000_000, 'M');
  if (v >= 10_000) {
    const k = Math.round((v / 1000) * 10) / 10;
    return k >= 1000 ? compact(v / 1_000_000, 'M') : compact(v / 1000, 'k');
  }
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// Capsule line 2. Not running / nothing saved → "— / —"; no target → "250 / —".
export function capsuleFigures(card: Pick<LineCard, 'status' | 'actual' | 'planned'>): string {
  if (card.status === 'not_running' || (card.actual === 0 && card.planned === 0)) return '— / —';
  return `${formatCapsuleCount(card.actual)} / ${card.planned > 0 ? formatCapsuleCount(card.planned) : '—'}`;
}

// ─── Downtime reasons ────────────────────────────────────────────────────────

// Minutes per stop reason for a session (each stop interval once; a running
// stop counts up to nowMs), largest first. Zero-minute reasons are left out.
export function downtimeReasonsOf(
  stopsBySlot: LiveSession['stopsBySlot'],
  nowMs: number
): { reason: string; minutes: number }[] {
  const seen = new Set<string>();
  const byReason = new Map<string, number>();
  Object.values(stopsBySlot ?? {}).forEach((arr) => {
    (Array.isArray(arr) ? arr : []).forEach((se: any) => {
      if (!se || typeof se.startAbs !== 'number') return;
      const id = stopIdOf(se);
      if (seen.has(id)) return;
      seen.add(id);
      let minutes = 0;
      if (se.running) minutes = stopDurationMinutes(se.startAbs, nowMs);
      else if (typeof se.durationMinutes === 'number') minutes = Math.max(0, se.durationMinutes);
      else if (typeof se.endAbs === 'number') minutes = stopDurationMinutes(se.startAbs, se.endAbs);
      const label = se.reason && String(se.reason).trim() ? formatStopReason(String(se.reason)) : 'Unspecified';
      byReason.set(label, (byReason.get(label) ?? 0) + minutes);
    });
  });
  return [...byReason.entries()]
    .map(([reason, minutes]) => ({ reason, minutes: Math.round(minutes) }))
    .filter((r) => r.minutes > 0)
    .sort((a, b) => b.minutes - a.minutes || a.reason.localeCompare(b.reason));
}

// ─── Live lines ──────────────────────────────────────────────────────────────

export interface LiveLine extends LineCard {
  liveStatus: LiveLineStatus;
  statusColor: string;
  missedSlot: boolean;
  // "No entry since HH:MM": end of the latest saved slot, else production
  // start. null when it can't be told (no schedule / date).
  noEntrySince: string | null;
  lastEntryAtMs: number | null;
  rejections: number | null;
  rejectionPct: number | null; // rejected / (good + rejected), as on QC Lines
  partName: string | null;
  supervisorName: string | null;
  lossReasons: string[];
  slots: SlotBar[];
}

export function buildLiveLines(
  lines: RegisteredLine[],
  sessions: LiveSession[],
  records: EfficiencyRecord[],
  nowMs: number
): LiveLine[] {
  const lineById = new Map(lines.map((l) => [l.id, l]));
  return buildLineCards(lines, sessions, records).map((card): LiveLine => {
    const session = card.session;
    if (!session) {
      return {
        ...card,
        liveStatus: 'notRunning',
        statusColor: LIVE_STATUS_COLORS.notRunning,
        missedSlot: false,
        noEntrySince: null,
        lastEntryAtMs: null,
        rejections: null,
        rejectionPct: null,
        partName: null,
        supervisorName: null,
        lossReasons: [],
        slots: [],
      };
    }
    const recs = recordsForSession(session, records);
    const slots = sessionSlotBars(session, recs, nowMs);
    const ended = slots.filter((s) => s.state === 'saved' || s.state === 'missing');
    const latestEnded = ended.length ? ended.reduce((a, b) => (b.endAbs > a.endAbs ? b : a)) : null;
    const missedSlot = latestEnded?.state === 'missing';
    const savedSlots = slots.filter((s) => s.state === 'saved');
    const sinceAbs = savedSlots.length
      ? Math.max(...savedSlots.map((s) => s.endAbs))
      : slots.length
        ? slots[0].startAbs
        : null;

    let latest: EfficiencyRecord | null = null;
    let lastEntryAtMs: number | null = null;
    recs.forEach((r) => {
      const t = r.updatedAtMs ?? r.createdAtMs ?? null;
      if (t != null && (lastEntryAtMs == null || t > lastEntryAtMs)) {
        lastEntryAtMs = t;
        latest = r;
      }
    });
    const latestRec = latest as EfficiencyRecord | null;
    const quality = counterQuality(recs.map((r) => ({ producedThisSlot: r.producedThisSlot, rejections: r.rejections })));
    const partIdx = typeof session.selectedPartIndex === 'number' ? session.selectedPartIndex : 0;
    const lossReasons = Array.from(
      new Set(recs.map((r) => (r.lossReasonLabel ?? '').trim()).filter(Boolean))
    ).sort();

    const liveStatus = getLineStatus({ hasSession: true, efficiency: card.efficiency, missedSlot });
    return {
      ...card,
      liveStatus,
      statusColor: LIVE_STATUS_COLORS[liveStatus],
      missedSlot,
      noEntrySince: sinceAbs != null ? formatAbsMinutes24(sinceAbs) : null,
      lastEntryAtMs,
      rejections: quality.rejectedParts,
      rejectionPct: quality.rejectionPct,
      partName: latestRec?.partName ?? lineById.get(card.lineId)?.parts?.[partIdx]?.name ?? null,
      // Current supervisor → who saved the latest slot → who started it.
      supervisorName: session.currentSupervisorName ?? latestRec?.supervisorName ?? session.supervisorName ?? null,
      lossReasons,
      slots,
    };
  });
}

// NEEDS ATTENTION: no entry first (by name), then lowest % first.
// ON TRACK: ≥ 75 %, lowest % first. Not running: by name.
export function groupLiveLines(lines: LiveLine[]) {
  const byName = (a: LiveLine, b: LiveLine) => a.lineName.localeCompare(b.lineName);
  const byPct = (a: LiveLine, b: LiveLine) => (a.efficiency ?? 0) - (b.efficiency ?? 0) || byName(a, b);
  const noEntry = lines.filter((l) => l.liveStatus === 'noEntry').sort(byName);
  const poor = lines.filter((l) => l.liveStatus === 'poor').sort(byPct);
  return {
    needsAttention: [...noEntry, ...poor],
    onTrack: lines.filter((l) => l.liveStatus === 'excellent' || l.liveStatus === 'warning').sort(byPct),
    notRunning: lines.filter((l) => l.liveStatus === 'notRunning').sort(byName),
  };
}

// Plant figure over every line with an active session: Σ actual / Σ target
// of the slots saved so far (the same Σ/Σ formula as each row, never an
// average of line %). "OK" = lines at ≥ 90 %.
export function plantSummary(lines: LiveLine[]) {
  const active = lines.filter((l) => l.liveStatus !== 'notRunning');
  const actual = active.reduce((s, l) => s + l.actual, 0);
  const planned = active.reduce((s, l) => s + l.planned, 0);
  const efficiency = planned > 0 ? Math.round((actual / planned) * 1000) / 10 : null;
  const status = getLineStatus({ hasSession: active.length > 0, efficiency });
  return {
    efficiency,
    actual,
    planned,
    status,
    color: LIVE_STATUS_COLORS[status],
    okLines: active.filter((l) => l.liveStatus === 'excellent').length,
    activeLines: active.length,
    notRunning: lines.length - active.length,
  };
}
