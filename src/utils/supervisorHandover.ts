// src/utils/supervisorHandover.ts
//
// Pure logic behind the supervisor "Running Lines" page
// (src/screens/RunningLinesScreen.tsx) and the shared-session handover in
// RecordProductionScreen. Kept free of React/Firebase so it can be checked
// by scripts/testSupervisorHandover.ts (npm run test:supervisor-handover).
//
// ─── SESSION MODEL (unchanged — this file only reads it) ─────────────────────
//   activeSessions/{lineId} — ONE doc per running line. The session run is
//   identified by sessionInstanceId; its production day is pinned in
//   productionDate when Start Production writes the doc, and never
//   re-derived from the clock (Shift B after midnight keeps the date it
//   started on). Supervisor B continuing a line opens THIS doc — there is
//   no per-supervisor session.
//
// ─── HANDOVER FIELDS (backward-compatible additions) ─────────────────────────
//   supervisorName / supervisorCode / supervisorUid — who STARTED the
//     session. Written once by Start Production; a sync never rewrites them.
//   updatedBy.{uid, deviceId, name} — who made the latest synced change
//     (uid/deviceId existed; name is new).
//   contributorUids — every supervisor who has synced a change to the
//     session (arrayUnion), so a supervisor who continued a line still sees
//     it on their own overview.
// Older docs without the new fields read as "no handover information".
//
// ─── FIGURES ─────────────────────────────────────────────────────────────────
// Same as the admin Line Efficiency page (utils/lineEfficiency):
//   actual (good parts) = Σ producedThisSlot   (utils/qualityMetrics)
//   plan to date        = Σ expectedParts       of the saved slots
//   variance            = actual − plan to date
//   shift plan          = the session doc's plannedProductionTotal
// over the de-duplicated records of the session's line + date + shift.

import { EfficiencyRecord, efficiencyOf, recordsForSession } from './lineEfficiency';
import { ShiftCode, TimeInterval, buildSlots } from './productionSchedule';
import { isProductionDayKey, millisToProductionDayMinute, resolveSessionProductionDate, timestampToMillis } from './productionDay';

// ─── Session doc → running session ───────────────────────────────────────────

export interface Person {
  uid: string | null;
  name: string | null;
  code?: string | null;
}

export interface RunningSession {
  lineId: string;
  lineName: string | null;
  plant: string | null;
  workshop: string | null;
  division: string | null;
  shift: ShiftCode;
  productionDate: string | null;
  otHours: number;
  productionStartAbs: number | null;
  plannedProductionTotal: number | null;
  selectedPartIndex: number;
  changeovers: { slotIndex: number; startAbs: number; endAbs: number; newPartIndex: number }[];
  savedSlotIndices: number[];
  deletedSlotIndices: number[];
  lineStopped: boolean;
  startedBy: Person;
  lastUpdatedBy: Person | null;
  contributorUids: string[];
  sessionInstance: string | null;
  startedAtMs: number | null;
  updatedAtMs: number | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const indexList = (v: unknown): number[] =>
  Array.isArray(v) ? v.filter((n): n is number => Number.isInteger(n) && n >= 0) : [];

export function parseRunningSession(docId: string, d: any): RunningSession {
  const changeovers = Object.values(d?.changeovers ?? {})
    .filter((co: any) => co && typeof co === 'object' && Number.isInteger(co.slotIndex))
    .map((co: any) => {
      const start = finite(co.startAbs) ?? finite(co.atAbs) ?? 0;
      return {
        slotIndex: co.slotIndex as number,
        startAbs: start,
        endAbs: finite(co.endAbs) ?? finite(co.atAbs) ?? start,
        newPartIndex: finite(co.newPartIndex) ?? 0,
      };
    })
    .sort((a, b) => a.startAbs - b.startAbs);
  const startedAtMs = timestampToMillis(d?.startedAt);
  const updatedBy = d?.updatedBy && typeof d.updatedBy === 'object' ? d.updatedBy : null;
  return {
    lineId: str(d?.lineId) ?? docId,
    lineName: str(d?.lineName),
    plant: str(d?.plant),
    workshop: str(d?.workshop),
    division: str(d?.division),
    shift: d?.shift === 'B' ? 'B' : 'A',
    // Read exactly as the recording screen does — stored date, else the
    // original startedAt. Never the viewer's clock.
    productionDate: resolveSessionProductionDate({ storedDate: d?.productionDate, startedAt: d?.startedAt }),
    otHours: finite(d?.otHours) ?? 0,
    productionStartAbs: finite(d?.productionStartMinutesAbs),
    plannedProductionTotal: finite(d?.plannedProductionTotal),
    selectedPartIndex: finite(d?.selectedPartIndex) ?? 0,
    changeovers,
    savedSlotIndices: indexList(d?.savedSlotIndices),
    deletedSlotIndices: indexList(d?.deletedSlotIndices),
    lineStopped: d?.lineStopped === true,
    startedBy: { uid: str(d?.supervisorUid), name: str(d?.supervisorName), code: str(d?.supervisorCode) },
    lastUpdatedBy: updatedBy ? { uid: str(updatedBy.uid), name: str(updatedBy.name) } : null,
    contributorUids: Array.isArray(d?.contributorUids) ? d.contributorUids.filter((u: unknown) => typeof u === 'string') : [],
    sessionInstance: str(d?.sessionInstanceId) ?? (startedAtMs != null ? `startedAt:${startedAtMs}` : null),
    startedAtMs,
    updatedAtMs: timestampToMillis(d?.updatedAt),
  };
}

// ─── Hourly slot entry status ────────────────────────────────────────────────
// completed — saved (savedSlotIndices: its productionRecords write AND the
//             session sync both succeeded);
// awaiting  — its production window has ended but it was never saved;
// current   — the slot running now (not saved yet);
// upcoming  — not reached yet.
// Lunch-only slots and deleted cards are neither.

export type SlotEntryState = 'completed' | 'awaiting' | 'current' | 'upcoming';

export interface SlotEntrySummary {
  bySlot: Record<number, SlotEntryState>;
  completed: number[];
  awaiting: number[];
  current: number | null;
  upcoming: number[];
}

export function slotEntryStatuses(
  s: Pick<RunningSession, 'shift' | 'otHours' | 'changeovers' | 'productionStartAbs' | 'savedSlotIndices' | 'deletedSlotIndices'>,
  nowAbs: number | null
): SlotEntrySummary {
  const intervals: TimeInterval[] = s.changeovers.map((co) => ({ start: co.startAbs, end: co.endAbs }));
  const slots = buildSlots(s.shift, s.otHours, intervals, s.productionStartAbs);
  const saved = new Set(s.savedSlotIndices);
  const deleted = new Set(s.deletedSlotIndices);
  const out: SlotEntrySummary = { bySlot: {}, completed: [], awaiting: [], current: null, upcoming: [] };
  for (const slot of slots) {
    if (slot.isBreak || deleted.has(slot.index)) continue;
    let state: SlotEntryState;
    if (saved.has(slot.index)) state = 'completed';
    else if (nowAbs == null) state = 'upcoming';
    else if (slot.endMinutesAbs <= nowAbs) state = 'awaiting';
    else if (slot.startMinutesAbs <= nowAbs) state = 'current';
    else state = 'upcoming';
    out.bySlot[slot.index] = state;
    if (state === 'current') out.current = slot.index;
    else out[state].push(slot.index);
  }
  return out;
}

// Minute of the session's OWN production day for an instant — past 1440
// after midnight on Shift B. null when the session has no usable date.
export function sessionNowAbs(productionDate: string | null, nowMs: number): number | null {
  return isProductionDayKey(productionDate) ? millisToProductionDayMinute(productionDate, nowMs) : null;
}

// ─── Running line cards ──────────────────────────────────────────────────────

export type RunningStatus = 'running' | 'stopped' | 'awaiting_entry';

export const RUNNING_STATUS_LABELS: Record<RunningStatus, string> = {
  running: 'Running',
  stopped: 'Stopped',
  awaiting_entry: 'Awaiting Entry',
};

export const RUNNING_STATUS_COLORS: Record<RunningStatus, string> = {
  running: '#4C9A6A',
  stopped: '#D64545',
  awaiting_entry: '#F2A93B',
};

export interface LinePartsLookup {
  [lineId: string]: { name: string }[] | undefined;
}

export interface RunningRecord extends EfficiencyRecord {
  partName?: string | null;
  rejections?: number | null;
}

export interface RunningLineCard {
  lineId: string;
  lineName: string;
  section: string | null;
  model: string | null;
  startedBy: string | null;
  // Shown when someone other than the starter made the latest change.
  lastUpdatedBy: string | null;
  shift: ShiftCode;
  productionDate: string | null;
  shiftPlan: number | null;
  planToDate: number;
  actual: number;
  variance: number;
  rejections: number;
  status: RunningStatus;
  slots: SlotEntrySummary;
  session: RunningSession;
}

// The part running now: the part of the latest changeover that has started,
// else the session's starting part. Falls back to the newest saved record's
// partName when the line's part list isn't available.
export function currentModel(s: RunningSession, parts: { name: string }[] | undefined, nowAbs: number | null, records: RunningRecord[]): string | null {
  let idx = s.selectedPartIndex;
  for (const co of s.changeovers) {
    if (nowAbs == null || co.startAbs <= nowAbs) idx = co.newPartIndex;
  }
  const name = parts?.[idx]?.name;
  if (name) return name;
  const latest = [...records]
    .filter((r) => r.partName)
    .sort((a, b) => (b.slotIndex ?? -1) - (a.slotIndex ?? -1) || (b.partSegment === 'after' ? 1 : 0) - (a.partSegment === 'after' ? 1 : 0))[0];
  return latest?.partName ?? null;
}

export function buildRunningLineCards(
  sessions: RunningSession[],
  records: RunningRecord[],
  partsByLine: LinePartsLookup,
  nowMs: number
): RunningLineCard[] {
  const cards = sessions.map((s): RunningLineCard => {
    const own = recordsForSession(
      { lineId: s.lineId, lineName: s.lineName, shift: s.shift, productionDate: s.productionDate, lineStopped: s.lineStopped, stopsBySlot: null, startedAtMs: s.startedAtMs, updatedAtMs: s.updatedAtMs },
      records
    );
    const totals = efficiencyOf(own);
    const rejections = own.reduce((sum, r) => sum + (typeof r.rejections === 'number' && Number.isFinite(r.rejections) ? r.rejections : 0), 0);
    const nowAbs = sessionNowAbs(s.productionDate, nowMs);
    const slots = slotEntryStatuses(s, nowAbs);
    const status: RunningStatus = s.lineStopped ? 'stopped' : slots.awaiting.length > 0 ? 'awaiting_entry' : 'running';
    const last = s.lastUpdatedBy;
    const handedOver = !!last?.uid && !!s.startedBy.uid && last.uid !== s.startedBy.uid;
    return {
      lineId: s.lineId,
      lineName: s.lineName ?? s.lineId,
      section: [s.division, s.workshop].filter(Boolean).join(' • ') || null,
      model: currentModel(s, partsByLine[s.lineId], nowAbs, own),
      startedBy: s.startedBy.name,
      lastUpdatedBy: handedOver ? last?.name ?? null : null,
      shift: s.shift,
      productionDate: s.productionDate,
      shiftPlan: s.plannedProductionTotal,
      planToDate: totals.planned,
      actual: totals.actual,
      variance: totals.actual - totals.planned,
      rejections,
      status,
      slots,
      session: s,
    };
  });
  const order: Record<RunningStatus, number> = { stopped: 0, awaiting_entry: 1, running: 2 };
  return cards.sort((a, b) => order[a.status] - order[b.status] || a.lineName.localeCompare(b.lineName));
}

// ─── Handover ────────────────────────────────────────────────────────────────

// Whether the signed-in supervisor is continuing a session someone else
// started. Legacy docs with no starter uid are never treated as a handover.
export function isHandover(startedByUid: string | null | undefined, viewerUid: string | null | undefined): boolean {
  return !!startedByUid && !!viewerUid && startedByUid !== viewerUid;
}

// Whose name goes on a productionRecords write: the person actually saving.
// The session's starter keeps the name/code they entered at Start
// Production; anyone continuing the session uses their own profile.
export function recorderIdentity(
  session: { startedBy: Person; supervisorName: string; supervisorCode: string },
  viewer: { uid: string | null; profileName: string | null; profileCode: string | null }
): Person & { code: string | null } {
  if (isHandover(session.startedBy.uid, viewer.uid)) {
    return { uid: viewer.uid, name: viewer.profileName || null, code: viewer.profileCode || null };
  }
  return { uid: viewer.uid, name: session.supervisorName || viewer.profileName || null, code: session.supervisorCode || viewer.profileCode || null };
}

// Session fields a SYNC may write about people. Starter fields
// (supervisorName/Code/Uid) are deliberately absent — only Start Production
// (and the legacy create branch) write them. Pass to the session payload
// with the Firestore arrayUnion sentinel for contributorUids.
export function syncAttributionFields<U>(
  actor: { uid: string | null; name: string | null; deviceId: string | null },
  arrayUnion: (...uids: string[]) => U
): { updatedBy: { uid: string | null; deviceId: string | null; name: string | null }; contributorUids?: U } {
  return {
    updatedBy: { uid: actor.uid, deviceId: actor.deviceId, name: actor.name },
    ...(actor.uid ? { contributorUids: arrayUnion(actor.uid) } : {}),
  };
}

// A supervisor's own lines on their overview: the ones they started, plus
// the ones they have continued.
export function isSupervisorsSession(s: Pick<RunningSession, 'startedBy' | 'contributorUids'>, uid: string | null | undefined): boolean {
  if (!uid) return false;
  return s.startedBy.uid === uid || s.contributorUids.includes(uid);
}

// productionRecords write split: createdAt/createdBy are written only when
// the record is CREATED, so a later save by another supervisor keeps who
// first recorded the slot (and when); every other field is written on
// create and update alike.
export function splitCreateOnlyFields<T extends Record<string, any>>(
  data: T
): { fields: Omit<T, 'createdAt' | 'createdBy'>; createOnly: { createdBy?: unknown } } {
  const { createdAt: _createdAt, createdBy, ...fields } = data;
  return { fields, createOnly: createdBy !== undefined ? { createdBy } : {} };
}
