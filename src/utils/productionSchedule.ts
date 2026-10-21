// src/utils/productionSchedule.ts
//
// Single source of truth for the production shift schedule and every time
// calculation built on it: hourly slot windows, breaks, productive minutes,
// changeover intervals and their validation. RecordProductionScreen (slot
// cards, individual saves, Finalize & End Session, shift summary) uses these
// functions so every path computes the same minutes.
//
// Time convention: "absolute minutes" counted from midnight of the shift's
// start day. Shift B runs past midnight, so its after-midnight times are
// +1440 (e.g. 2:00 AM = 1560) to keep one continuously increasing frame.
// Every interval is half-open, [start, end) — adjacent intervals such as
// 12:00–12:15 and 12:15–12:45 do not overlap.

export type TimeInterval = { start: number; end: number };

export type ShiftCode = 'A' | 'B';

export const SHIFT_A_START = 7 * 60;
export const SHIFT_A_END = 15 * 60 + 30;
export const SHIFT_B_START = 19 * 60;
export const SHIFT_B_END_ABS = 24 * 60 + 3 * 60 + 30;

// Fixed lunch break, 12:15 PM – 12:45 PM. The hourly slots on either side of
// it are bent around it (see buildSlots) and no changeover may overlap it.
export const LUNCH_BREAK: TimeInterval = { start: 12 * 60 + 15, end: 12 * 60 + 45 };

export const BREAKS: TimeInterval[] = [
  { start: 9 * 60 + 30, end: 9 * 60 + 40 },
  LUNCH_BREAK,
  { start: 14 * 60, end: 14 * 60 + 10 },
];

// The first slot of a shift reserves its first 10 minutes for startup.
export const STARTUP_RESERVE_MINUTES = 10;

// Clock hours (minutes of the day, start of the hour) that are fixed at 50
// productive minutes: 7–8 AM, 9–10 AM, 2–3 PM and 5–6 PM. Every other slot
// keeps the productive time of its own window (60, 75, partial, …).
//
// The 50 minutes is a ceiling on what the window would otherwise give, NOT
// a value from which breaks/changeovers are subtracted again: 7–8 (startup
// reserve), 9–10 and 2–3 (tea breaks) already lose exactly those 10
// minutes, and in 5–6 PM a changeover of up to 10 minutes is absorbed by
// the same allowance. Lost time beyond the allowance still reduces it.
export const FIXED_PRODUCTIVE_MINUTES_BY_HOUR: Record<number, number> = {
  [7 * 60]: 50,
  [9 * 60]: 50,
  [14 * 60]: 50,
  [17 * 60]: 50,
};

// Productive-minute ceiling for a slot whose nominal hour starts at
// `hourStartAbs`, or null when the slot has no fixed rule. Matched on clock
// time of day, so Shift B's after-midnight frame (+1440) maps correctly.
export function fixedProductiveMinutesFor(hourStartAbs: number): number | null {
  const ofDay = ((hourStartAbs % 1440) + 1440) % 1440;
  return FIXED_PRODUCTIVE_MINUTES_BY_HOUR[ofDay] ?? null;
}

export type ScheduleSlot = {
  index: number;
  // Nominal clock hour the slot belongs to — what its label shows and what
  // reports bucket by. Unchanged by the lunch adjustment.
  hourStartAbs: number;
  hourEndAbs: number;
  // Actual production window. Differs from the nominal hour only around
  // lunch: 11–12 runs 11:00–12:15, 12–1 is the lunch interval itself, and
  // 1–2 runs 12:45–2:00.
  startMinutesAbs: number;
  endMinutesAbs: number;
  // Wall-clock length of the production window (slot boundaries).
  durationMinutes: number;
  // Minutes that count towards the target: the window minus breaks, startup
  // reserve and changeovers, capped by fixedProductiveMinutesFor().
  productiveMinutes: number;
  // True for the 12–1 slot, which covers only the lunch break.
  isBreak: boolean;
  // True for the slot whose start was clipped to the session's actual
  // production start time (see buildSlots). Its label shows that window.
  startAdjusted: boolean;
  label: string;
};

export function formatAbsMinutesToAmPm(mAbs: number) {
  const m = ((mAbs % 1440) + 1440) % 1440;
  const hh = Math.floor(m / 60);
  const mm = m % 60;
  const suffix = hh >= 12 ? 'PM' : 'AM';
  const hour12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${hour12.toString().padStart(2, '0')}:${mm.toString().padStart(2, '0')} ${suffix}`;
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

// Half-open overlap test: [a.start, a.end) ∩ [b.start, b.end) ≠ ∅.
export function intervalsOverlap(a: TimeInterval, b: TimeInterval) {
  return a.start < b.end && b.start < a.end;
}

// Minutes of [from, to) covered by the UNION of `intervals` — overlapping
// intervals (e.g. a changeover across a tea break) are only counted once.
export function coveredMinutes(from: number, to: number, intervals: TimeInterval[]) {
  const clipped = intervals
    .map((iv) => ({ start: Math.max(from, iv.start), end: Math.min(to, iv.end) }))
    .filter((iv) => iv.end > iv.start)
    .sort((a, b) => a.start - b.start);
  let total = 0;
  let curStart = -Infinity;
  let curEnd = -Infinity;
  for (const iv of clipped) {
    if (iv.start > curEnd) {
      if (curEnd > curStart) total += curEnd - curStart;
      curStart = iv.start;
      curEnd = iv.end;
    } else if (iv.end > curEnd) {
      curEnd = iv.end;
    }
  }
  if (curEnd > curStart) total += curEnd - curStart;
  return total;
}

// Productive minutes inside [from, to): wall time minus every non-productive
// interval (breaks, startup reserve, changeovers).
export function productiveMinutesIn(from: number, to: number, nonProductive: TimeInterval[]) {
  if (to <= from) return 0;
  return Math.max(0, round2(to - from - coveredMinutes(from, to, nonProductive)));
}

export function shiftWindow(shift: ShiftCode, otHours: number): TimeInterval {
  const start = shift === 'A' ? SHIFT_A_START : SHIFT_B_START;
  const end = (shift === 'A' ? SHIFT_A_END : SHIFT_B_END_ABS) + otHours * 60;
  return { start, end };
}

// Scheduled non-productive time for a shift: breaks and the first slot's
// startup reserve. Overtime has no break of its own — 4–5 PM is a full
// 60-minute slot.
export function scheduledNonProductive(shift: ShiftCode, otHours: number): TimeInterval[] {
  const { start } = shiftWindow(shift, otHours);
  return [...BREAKS, { start, end: start + STARTUP_RESERVE_MINUTES }];
}

// Productive minutes of one slot window: the window's own productive time,
// capped by the slot's fixed rule when it has one.
export function slotProductiveMinutes(hourStartAbs: number, from: number, to: number, nonProductive: TimeInterval[]) {
  const natural = productiveMinutesIn(from, to, nonProductive);
  const fixed = fixedProductiveMinutesFor(hourStartAbs);
  return fixed == null ? natural : Math.min(fixed, natural);
}

// Hourly slots for a shift. `changeoverIntervals` are subtracted from the
// productive minutes of every slot they overlap, so a changeover crossing an
// hour boundary is split across the slots it actually covers.
//
// `productionStartAbs` is the session's actual production start (null for
// sessions started before it was recorded — the full shift, as before).
// Slots that end on or before it are left out, and only the slot it falls
// inside has its start clipped to it; every later slot keeps its scheduled
// boundaries. Slot indices are those of the full shift either way, so
// productionRecords IDs and every per-slot map keep pointing at the same slot.
// Breaks, the startup reserve and the fixed-hour ceilings are applied to the
// clipped window unchanged — e.g. a 14:15 start leaves 14:15–15:00, whose
// 45 productive minutes are already below the 2–3 PM 50-minute ceiling.
export function buildSlots(
  shift: ShiftCode,
  otHours: number,
  changeoverIntervals: TimeInterval[] = [],
  productionStartAbs: number | null = null
): ScheduleSlot[] {
  const { start: shiftStart, end: shiftEnd } = shiftWindow(shift, otHours);

  const windows: { hourStart: number; hourEnd: number; start: number; end: number; isBreak: boolean }[] = [];
  for (let h = shiftStart; h < shiftEnd; h += 60) {
    const hourEnd = Math.min(shiftEnd, h + 60);
    windows.push({ hourStart: h, hourEnd, start: h, end: hourEnd, isBreak: false });
  }

  // Bend the slots around lunch: the hour containing it becomes the lunch
  // interval only, the previous slot runs up to lunch start and the next
  // one starts at lunch end. Only applies when lunch sits strictly inside an
  // hour with a slot on each side (Shift A) — Shift B never reaches it.
  const lunchIdx = windows.findIndex(
    (w) => w.start < LUNCH_BREAK.start && LUNCH_BREAK.end <= w.end
  );
  if (lunchIdx > 0 && lunchIdx < windows.length - 1) {
    windows[lunchIdx - 1].end = LUNCH_BREAK.start;
    windows[lunchIdx].start = LUNCH_BREAK.start;
    windows[lunchIdx].end = LUNCH_BREAK.end;
    windows[lunchIdx].isBreak = true;
    windows[lunchIdx + 1].start = LUNCH_BREAK.end;
  }

  const start = productionStartAbs != null && Number.isFinite(productionStartAbs) && productionStartAbs > shiftStart
    ? productionStartAbs
    : null;

  const nonProductive = [...scheduledNonProductive(shift, otHours), ...changeoverIntervals];
  return windows
    .map((w, idx) => ({ w, idx }))
    .filter(({ w }) => start == null || w.end > start)
    .map(({ w, idx }) => {
      const startAdjusted = start != null && start > w.start;
      const from = startAdjusted ? start : w.start;
      return {
        index: idx,
        hourStartAbs: w.hourStart,
        hourEndAbs: w.hourEnd,
        startMinutesAbs: from,
        endMinutesAbs: w.end,
        durationMinutes: w.end - from,
        productiveMinutes: slotProductiveMinutes(w.hourStart, from, w.end, nonProductive),
        isBreak: w.isBreak,
        startAdjusted,
        label: startAdjusted
          ? `${formatAbsMinutesToAmPm(from)} - ${formatAbsMinutesToAmPm(w.end)}`
          : `${formatAbsMinutesToAmPm(w.hourStart)} - ${formatAbsMinutesToAmPm(w.hourEnd)}${w.hourEnd - w.hourStart < 60 ? ' (partial)' : ''}`,
      };
    });
}

// Theoretical parts for a number of productive minutes at a cycle time
// (rounded down — same rule the screen always used).
export function expectedPartsFor(cycleTimeSeconds: number, minutes: number) {
  if (!cycleTimeSeconds || minutes <= 0) return 0;
  return Math.floor((minutes * 60) / cycleTimeSeconds);
}

// The two production windows a changeover splits its starting slot into:
// BEFORE runs on the old part up to the changeover start, AFTER runs on the
// new part from the changeover end (or not at all inside this slot, if the
// changeover runs past the slot's end — its remaining minutes are then taken
// out of the following slot(s) by buildSlots instead).
export function changeoverSegmentWindows(slot: TimeInterval, co: TimeInterval) {
  const before = { start: slot.start, end: Math.max(slot.start, Math.min(co.start, slot.end)) };
  const afterStart = Math.min(slot.end, Math.max(co.end, slot.start));
  const after = { start: afterStart, end: slot.end };
  return { before, after };
}

// BEFORE/AFTER productive minutes of a changeover's starting slot. Each
// segment gets its own window's productive time; if the slot's fixed rule
// caps it below their sum (e.g. 5–6 PM), the unused allowance is taken out of
// the segments in proportion to their length, so BEFORE + AFTER always equals
// the slot's productiveMinutes and nothing is counted twice.
export function changeoverSegmentMinutes(slot: ScheduleSlot, co: TimeInterval, nonProductive: TimeInterval[]) {
  const { before, after } = changeoverSegmentWindows({ start: slot.startMinutesAbs, end: slot.endMinutesAbs }, co);
  const rawBefore = productiveMinutesIn(before.start, before.end, nonProductive);
  const rawAfter = productiveMinutesIn(after.start, after.end, nonProductive);
  const rawTotal = rawBefore + rawAfter;
  if (rawTotal <= slot.productiveMinutes || rawTotal <= 0) {
    return { before, after, beforeMinutes: rawBefore, afterMinutes: rawAfter };
  }
  const beforeMinutes = round2((rawBefore * slot.productiveMinutes) / rawTotal);
  const afterMinutes = round2(slot.productiveMinutes - beforeMinutes);
  return { before, after, beforeMinutes, afterMinutes };
}

// Parses "HH:MM" (12-hour, as typed by the supervisor) + AM/PM into the
// shift's absolute minutes. Returns null for anything that isn't a real time.
export function parseClockToShiftAbs(text: string, meridiem: 'AM' | 'PM', shift: ShiftCode): number | null {
  const m = /^\s*(\d{1,2})\s*[:.]\s*(\d{2})\s*$/.exec(text);
  if (!m) return null;
  const h12 = Number(m[1]);
  const min = Number(m[2]);
  if (h12 < 1 || h12 > 12 || min > 59) return null;
  const h24 = (h12 % 12) + (meridiem === 'PM' ? 12 : 0);
  let abs = h24 * 60 + min;
  // Same rule the screen uses for Shift B: morning times belong to the
  // night that started the previous evening.
  if (shift === 'B' && h24 < 12) abs += 1440;
  return abs;
}

export type ChangeoverValidationInput = {
  interval: TimeInterval;
  // Slots changeovers may be placed in (deleted cards already excluded).
  slots: ScheduleSlot[];
  // Every other changeover in the session, to rule out overlaps.
  otherIntervals: TimeInterval[];
  // Single-time changeovers are an instant (start === end). Without this
  // flag an instant is rejected — only start/end intervals are accepted.
  allowInstant?: boolean;
};

export const LUNCH_CHANGEOVER_MESSAGE =
  `A changeover cannot be recorded during the lunch break (${formatAbsMinutesToAmPm(LUNCH_BREAK.start)} – ${formatAbsMinutesToAmPm(LUNCH_BREAK.end)}). ` +
  `Enter a time before ${formatAbsMinutesToAmPm(LUNCH_BREAK.start)} or from ${formatAbsMinutesToAmPm(LUNCH_BREAK.end)} onwards.`;

// Shared changeover rule check. Returns an error message, or null if valid.
export function validateChangeoverInterval({ interval, slots, otherIntervals, allowInstant }: ChangeoverValidationInput): string | null {
  const { start, end } = interval;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'Enter a valid start and end time.';
  if (end < start || (end === start && !allowInstant)) return 'The changeover end time must be after its start time.';

  const touchesLunch = end === start
    ? start >= LUNCH_BREAK.start && start < LUNCH_BREAK.end
    : intervalsOverlap(interval, LUNCH_BREAK);
  if (touchesLunch) return LUNCH_CHANGEOVER_MESSAGE;

  const productionSlots = slots.filter((s) => !s.isBreak);
  const startSlot = productionSlots.find((s) => start >= s.startMinutesAbs && start < s.endMinutesAbs);
  if (!startSlot) return 'The changeover time is outside this shift\'s production slots.';
  const lastEnd = Math.max(...productionSlots.map((s) => s.endMinutesAbs));
  if (end > lastEnd) return 'The changeover end time is after the end of this shift.';

  const clash = otherIntervals.find((o) =>
    o.end === o.start
      ? o.start === start || (o.start >= start && o.start < end)
      : intervalsOverlap(interval, o) || (end === start && start >= o.start && start < o.end)
  );
  if (clash) {
    return clash.end === clash.start
      ? `Another changeover is already recorded at ${formatAbsMinutesToAmPm(clash.start)}.`
      : `This changeover overlaps another one (${formatAbsMinutesToAmPm(clash.start)} – ${formatAbsMinutesToAmPm(clash.end)}).`;
  }
  return null;
}

// ─── Manual time entry ───────────────────────────────────────────────────────
// The supervisor types digits only; the colon is inserted after the hour
// digits. The display string is rebuilt from the digits on every change, so
// deleting or editing in the middle can never leave two colons behind.
export function formatTimeInput(text: string): string {
  const digits = text.replace(/\D/g, '').slice(0, 4);
  return digits.length > 2 ? `${digits.slice(0, 2)}:${digits.slice(2)}` : digits;
}

// Complete 24-hour "HH:MM" (00–23 : 00–59) → minutes of the day, else null.
export function parseTimeInput(text: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

// Minutes of the day → the shift's absolute frame. Shift B's morning hours
// belong to the night that started the previous evening.
export function timeOfDayToShiftAbs(minuteOfDay: number, shift: ShiftCode): number {
  return shift === 'B' && minuteOfDay < 12 * 60 ? minuteOfDay + 1440 : minuteOfDay;
}

// Absolute minutes → 24-hour "HH:MM", the format the supervisor types.
export function formatAbsMinutes24(mAbs: number) {
  const m = ((mAbs % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

// ─── Production start time ───────────────────────────────────────────────────
// The time production actually started, typed as 24-hour "HH:MM" before
// Start Production. It must fall inside the selected shift's window
// (including OT), [shift start, shift end) — a start on or after the end
// would leave no slot to record. `nowAbs` is the current time in the same
// production-day frame; when given, a start later than it is rejected (the
// app has no scheduled future production). An earlier time is accepted, so
// a supervisor entering data late can record when production really began.
export type ProductionStartCheck =
  | { ok: true; startAbs: number }
  | { ok: false; error: string };

export function validateProductionStartTime(
  text: string,
  shift: ShiftCode,
  otHours: number,
  nowAbs: number | null = null
): ProductionStartCheck {
  const minuteOfDay = parseTimeInput(text);
  if (minuteOfDay == null) {
    return { ok: false, error: 'Enter the production start time as HH:MM in 24-hour format, e.g. 07:05 or 14:15.' };
  }
  const startAbs = timeOfDayToShiftAbs(minuteOfDay, shift);
  const { start, end } = shiftWindow(shift, otHours);
  if (startAbs < start || startAbs >= end) {
    return {
      ok: false,
      error: `Shift ${shift} runs ${formatAbsMinutes24(start)}–${formatAbsMinutes24(end)}${otHours > 0 ? ` (incl. ${otHours}h OT)` : ''}. Enter a start time inside it.`,
    };
  }
  if (nowAbs != null && startAbs > nowAbs) {
    return {
      ok: false,
      error: `${formatAbsMinutes24(startAbs)} is later than the current time (${formatAbsMinutes24(nowAbs)}). Enter the time production actually started.`,
    };
  }
  return { ok: true, startAbs };
}

// ─── Single-time changeover ──────────────────────────────────────────────────
// A changeover is entered as ONE time: the moment the line switches part.
// The slot it falls in is split into BEFORE [slot start, time) and AFTER
// [time, slot end). A time exactly on a slot's start would leave an empty
// BEFORE segment, so it is a part switch at the start of that slot instead:
// the slot stays one full card on the new part.
export type ChangeoverPlacement =
  | { ok: true; slot: ScheduleSlot; atSlotStart: boolean }
  | { ok: false; error: string };

export function placeChangeoverTime(
  atAbs: number,
  slots: ScheduleSlot[],
  otherIntervals: TimeInterval[]
): ChangeoverPlacement {
  const error = validateChangeoverInterval({ interval: { start: atAbs, end: atAbs }, slots, otherIntervals, allowInstant: true });
  if (error) return { ok: false, error };
  const slot = slots.find((s) => !s.isBreak && atAbs >= s.startMinutesAbs && atAbs < s.endMinutesAbs);
  if (!slot) return { ok: false, error: 'The changeover time is outside this shift\'s production slots.' };
  return { ok: true, slot, atSlotStart: atAbs === slot.startMinutesAbs };
}

// True when a changeover starts on (or, for a legacy interval, before) its
// slot's start — it switches the part for the whole slot instead of
// splitting it, so no empty BEFORE segment is ever created.
export function isChangeoverAtSlotStart(slot: ScheduleSlot, co: TimeInterval) {
  return co.start <= slot.startMinutesAbs;
}
