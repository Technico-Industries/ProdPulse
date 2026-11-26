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

// Shift B's breaks, in its +1440 frame. Each is one interval, deducted only
// from the minutes it overlaps — dinner straddles 10:00 PM, so it costs
// 15 minutes in each of 9–10 PM and 10–11 PM (45 + 45), never 30 twice.
export const SHIFT_B_DINNER_BREAK: TimeInterval = { start: 21 * 60 + 45, end: 22 * 60 + 15 };
export const SHIFT_B_TEA_BREAK: TimeInterval = { start: 24 * 60 + 60 + 30, end: 24 * 60 + 60 + 40 };
// Late-evening tea break, 11:30–11:40 PM, making the 11 PM – 12 AM slot 50
// productive minutes. Shared by every Shift B schedule (Assembly and Welding).
export const SHIFT_B_LATE_TEA_BREAK: TimeInterval = { start: 23 * 60 + 30, end: 23 * 60 + 40 };
// Rejection clearance closes the regular shift: 3:20–3:30 AM, leaving
// 3:00–3:30 AM with 20 productive minutes. Only applied without overtime —
// with OT that slot becomes a full 3:00–4:00 AM hour, and whether the
// clearance still applies there is not yet decided, so it keeps its
// previous behaviour (no deduction).
export const SHIFT_B_REJECTION_CLEARANCE: TimeInterval = { start: 24 * 60 + 3 * 60 + 20, end: SHIFT_B_END_ABS };
// Overtime tea break, 4:30–4:40 AM — only reached when OT runs past 4:30.
export const SHIFT_B_OT_TEA_BREAK: TimeInterval = { start: 24 * 60 + 4 * 60 + 30, end: 24 * 60 + 4 * 60 + 40 };

function assemblyShiftBreaks(shift: ShiftCode, otHours: number): TimeInterval[] {
  if (shift === 'A') return BREAKS;
  return [
    SHIFT_B_DINNER_BREAK,
    SHIFT_B_LATE_TEA_BREAK,
    SHIFT_B_TEA_BREAK,
    ...(otHours > 0 ? [SHIFT_B_OT_TEA_BREAK] : [SHIFT_B_REJECTION_CLEARANCE]),
  ];
}

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
export function fixedProductiveMinutesFor(
  hourStartAbs: number,
  ceilings: Record<number, number> = FIXED_PRODUCTIVE_MINUTES_BY_HOUR
): number | null {
  const ofDay = ((hourStartAbs % 1440) + 1440) % 1440;
  return ceilings[ofDay] ?? null;
}

// ─── Workshop schedule profiles ──────────────────────────────────────────────
// Each workshop that records production keeps its own shift timings, lunch,
// tea breaks and fixed-hour rules. Every schedule function below takes an
// optional profile and defaults to ASSEMBLY_SCHEDULE, so the Assembly
// schedule (and everything already built on it) is unchanged; Bawal 1 →
// Welding passes WELDING_SCHEDULE (see scheduleProfileFor).

export type ScheduleProfileId = 'assembly' | 'welding';

export type ShiftSchedule = {
  // Regular shift window (absolute minutes; Shift B in its +1440 frame).
  start: number;
  end: number;
  // Lunch the slots are bent around (the hour holding it becomes a break
  // card) and that no changeover may touch. null when the shift has none.
  lunch: TimeInterval | null;
  // Every scheduled break of the shift for this OT, lunch included.
  breaks: (otHours: number) => TimeInterval[];
  // Fixed productive-minute ceilings by clock hour (see FIXED_PRODUCTIVE_MINUTES_BY_HOUR).
  fixedCeilings: (otHours: number) => Record<number, number>;
  // Clock window in which a new session of this shift may be started.
  startWindow: TimeInterval;
};

export type ScheduleProfile = {
  id: ScheduleProfileId;
  shifts: Record<ShiftCode, ShiftSchedule>;
};

export const ASSEMBLY_SCHEDULE: ScheduleProfile = {
  id: 'assembly',
  shifts: {
    A: {
      start: SHIFT_A_START,
      end: SHIFT_A_END,
      lunch: LUNCH_BREAK,
      breaks: (ot) => assemblyShiftBreaks('A', ot),
      fixedCeilings: () => FIXED_PRODUCTIVE_MINUTES_BY_HOUR,
      startWindow: { start: 7 * 60, end: 18 * 60 + 30 },
    },
    B: {
      start: SHIFT_B_START,
      end: SHIFT_B_END_ABS,
      // Shift B never reaches the 12:15 lunch (its frame starts at 19:00), so
      // it never bends a slot; it is kept so changeover validation answers
      // exactly as before profiles existed.
      lunch: LUNCH_BREAK,
      breaks: (ot) => assemblyShiftBreaks('B', ot),
      fixedCeilings: () => FIXED_PRODUCTIVE_MINUTES_BY_HOUR,
      startWindow: { start: 19 * 60, end: 6 * 60 + 30 },
    },
  },
};

// ── Bawal 1 → Welding ──
// Shift A 7:00 AM – 5:00 PM, lunch 11:15–11:45 AM: 10:00–11:15 and
// 11:45–1:00 are the two 75-minute slots. Tea 9:30–9:40 AM and 2:00–2:10 PM;
// the first 10 minutes (7:00–7:10) are the startup reserve.
// Shift B 5:00 PM – 3:00 AM, lunch 9:15–9:45 PM: 8:00–9:15 and 9:45–11:00
// are the 75-minute slots. Tea 11:30–11:40 PM and 1:30–1:40 AM, startup reserve 5:00–5:10 PM,
// and the 4:30–4:40 AM tea break only when overtime is worked.
export const WELDING_SHIFT_A_START = 7 * 60;
export const WELDING_SHIFT_A_END = 17 * 60;
export const WELDING_SHIFT_B_START = 17 * 60;
export const WELDING_SHIFT_B_END_ABS = 24 * 60 + 3 * 60;
export const WELDING_SHIFT_A_LUNCH: TimeInterval = { start: 11 * 60 + 15, end: 11 * 60 + 45 };
export const WELDING_SHIFT_B_LUNCH: TimeInterval = { start: 21 * 60 + 15, end: 21 * 60 + 45 };
export const WELDING_SHIFT_A_TEA_BREAKS: TimeInterval[] = [
  { start: 9 * 60 + 30, end: 9 * 60 + 40 },
  { start: 14 * 60, end: 14 * 60 + 10 },
];
export const WELDING_SHIFT_B_TEA_BREAK: TimeInterval = { start: 24 * 60 + 60 + 30, end: 24 * 60 + 60 + 40 };
export const WELDING_SHIFT_B_OT_TEA_BREAK: TimeInterval = { start: 24 * 60 + 4 * 60 + 30, end: 24 * 60 + 4 * 60 + 40 };
// Shift A overtime: the 5–6 PM hour is held at 50 productive minutes only
// when 3 or more OT hours are worked; with 1–2 OT hours it is a full 60.
export const WELDING_OT_FIXED_HOUR_MIN_OT = 3;

export const WELDING_SCHEDULE: ScheduleProfile = {
  id: 'welding',
  shifts: {
    A: {
      start: WELDING_SHIFT_A_START,
      end: WELDING_SHIFT_A_END,
      lunch: WELDING_SHIFT_A_LUNCH,
      breaks: () => [WELDING_SHIFT_A_TEA_BREAKS[0], WELDING_SHIFT_A_LUNCH, WELDING_SHIFT_A_TEA_BREAKS[1]],
      fixedCeilings: (ot) => ({
        [7 * 60]: 50,
        [9 * 60]: 50,
        [14 * 60]: 50,
        ...(ot >= WELDING_OT_FIXED_HOUR_MIN_OT ? { [17 * 60]: 50 } : {}),
      }),
      startWindow: { start: 7 * 60, end: 17 * 60 },
    },
    B: {
      start: WELDING_SHIFT_B_START,
      end: WELDING_SHIFT_B_END_ABS,
      lunch: WELDING_SHIFT_B_LUNCH,
      breaks: (ot) => [
        WELDING_SHIFT_B_LUNCH,
        SHIFT_B_LATE_TEA_BREAK,
        WELDING_SHIFT_B_TEA_BREAK,
        ...(ot > 0 ? [WELDING_SHIFT_B_OT_TEA_BREAK] : []),
      ],
      // Shift B keeps each slot's own productive time (the startup reserve
      // and tea breaks already make 5–6 PM, 11 PM–12 AM, 1–2 AM and OT
      // 4–5 AM 50 minutes).
      fixedCeilings: () => ({}),
      startWindow: { start: 17 * 60, end: 6 * 60 + 30 },
    },
  },
};

function normalizeLabel(v: unknown) {
  return String(v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// The schedule a line / session runs on, from its plant and workshop.
// Only Bawal 1 → Welding has its own schedule ("Bawal 1", "Bawal - 1",
// "Welding", "Welding Shop" all match); everything else keeps Assembly's,
// as before. A stored `scheduleProfile` id on a session wins when present.
export function scheduleProfileFor(src: {
  plant?: string | null;
  workshop?: string | null;
  scheduleProfile?: unknown;
} | null | undefined): ScheduleProfile {
  if (src?.scheduleProfile === 'welding') return WELDING_SCHEDULE;
  if (src?.scheduleProfile === 'assembly') return ASSEMBLY_SCHEDULE;
  const plant = normalizeLabel(src?.plant);
  const workshop = normalizeLabel(src?.workshop);
  if (plant === 'bawal1' && workshop.includes('welding')) return WELDING_SCHEDULE;
  return ASSEMBLY_SCHEDULE;
}

export function shiftSchedule(shift: ShiftCode, profile: ScheduleProfile = ASSEMBLY_SCHEDULE): ShiftSchedule {
  return profile.shifts[shift];
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

export function shiftWindow(shift: ShiftCode, otHours: number, profile: ScheduleProfile = ASSEMBLY_SCHEDULE): TimeInterval {
  const sch = shiftSchedule(shift, profile);
  return { start: sch.start, end: sch.end + otHours * 60 };
}

// Scheduled non-productive time for a shift: its breaks and the first
// slot's startup reserve. Shift A's overtime has no break of its own — 4–5 PM
// is a full 60-minute slot; Shift B's has the 4:30–4:40 AM tea break.
export function scheduledNonProductive(shift: ShiftCode, otHours: number, profile: ScheduleProfile = ASSEMBLY_SCHEDULE): TimeInterval[] {
  const { start } = shiftWindow(shift, otHours, profile);
  return [...shiftSchedule(shift, profile).breaks(otHours), { start, end: start + STARTUP_RESERVE_MINUTES }];
}

// Productive minutes of one slot window: the window's own productive time,
// capped by the slot's fixed rule when it has one.
export function slotProductiveMinutes(
  hourStartAbs: number,
  from: number,
  to: number,
  nonProductive: TimeInterval[],
  ceilings: Record<number, number> = FIXED_PRODUCTIVE_MINUTES_BY_HOUR
) {
  const natural = productiveMinutesIn(from, to, nonProductive);
  const fixed = fixedProductiveMinutesFor(hourStartAbs, ceilings);
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
  productionStartAbs: number | null = null,
  profile: ScheduleProfile = ASSEMBLY_SCHEDULE
): ScheduleSlot[] {
  const { start: shiftStart, end: shiftEnd } = shiftWindow(shift, otHours, profile);
  const { lunch } = shiftSchedule(shift, profile);
  const ceilings = shiftSchedule(shift, profile).fixedCeilings(otHours);

  const windows: { hourStart: number; hourEnd: number; start: number; end: number; isBreak: boolean }[] = [];
  for (let h = shiftStart; h < shiftEnd; h += 60) {
    const hourEnd = Math.min(shiftEnd, h + 60);
    windows.push({ hourStart: h, hourEnd, start: h, end: hourEnd, isBreak: false });
  }

  // Bend the slots around lunch: the hour containing it becomes the lunch
  // interval only, the previous slot runs up to lunch start and the next
  // one starts at lunch end. Only applies when lunch sits strictly inside an
  // hour with a slot on each side (Assembly Shift A, both Welding shifts).
  const lunchIdx = lunch
    ? windows.findIndex((w) => w.start < lunch.start && lunch.end <= w.end)
    : -1;
  if (lunch && lunchIdx > 0 && lunchIdx < windows.length - 1) {
    windows[lunchIdx - 1].end = lunch.start;
    windows[lunchIdx].start = lunch.start;
    windows[lunchIdx].end = lunch.end;
    windows[lunchIdx].isBreak = true;
    windows[lunchIdx + 1].start = lunch.end;
  }

  const start = productionStartAbs != null && Number.isFinite(productionStartAbs) && productionStartAbs > shiftStart
    ? productionStartAbs
    : null;

  const nonProductive = [...scheduledNonProductive(shift, otHours, profile), ...changeoverIntervals];
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
        productiveMinutes: slotProductiveMinutes(w.hourStart, from, w.end, nonProductive, ceilings),
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
  // The shift's lunch (ShiftSchedule.lunch). Omitted → Assembly's 12:15–12:45
  // lunch, as before; null → the shift has no lunch to rule out.
  lunch?: TimeInterval | null;
};

export function lunchChangeoverMessage(lunch: TimeInterval) {
  return `A changeover cannot be recorded during the lunch break (${formatAbsMinutesToAmPm(lunch.start)} – ${formatAbsMinutesToAmPm(lunch.end)}). ` +
    `Enter a time before ${formatAbsMinutesToAmPm(lunch.start)} or from ${formatAbsMinutesToAmPm(lunch.end)} onwards.`;
}

export const LUNCH_CHANGEOVER_MESSAGE = lunchChangeoverMessage(LUNCH_BREAK);

// Shared changeover rule check. Returns an error message, or null if valid.
export function validateChangeoverInterval({ interval, slots, otherIntervals, allowInstant, lunch: lunchIn }: ChangeoverValidationInput): string | null {
  const { start, end } = interval;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'Enter a valid start and end time.';
  if (end < start || (end === start && !allowInstant)) return 'The changeover end time must be after its start time.';

  const lunch = lunchIn === undefined ? LUNCH_BREAK : lunchIn;
  const touchesLunch = lunch != null && (end === start
    ? start >= lunch.start && start < lunch.end
    : intervalsOverlap(interval, lunch));
  if (touchesLunch) return lunch === LUNCH_BREAK ? LUNCH_CHANGEOVER_MESSAGE : lunchChangeoverMessage(lunch!);

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
  nowAbs: number | null = null,
  profile: ScheduleProfile = ASSEMBLY_SCHEDULE
): ProductionStartCheck {
  const minuteOfDay = parseTimeInput(text);
  if (minuteOfDay == null) {
    return { ok: false, error: 'Enter the production start time as HH:MM in 24-hour format, e.g. 07:05 or 14:15.' };
  }
  const startAbs = timeOfDayToShiftAbs(minuteOfDay, shift);
  const { start, end } = shiftWindow(shift, otHours, profile);
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

// ─── Shift start window ──────────────────────────────────────────────────────
// When a shift's session may be STARTED, by the current clock time, so a
// supervisor can't start the wrong shift by mistake:
//   Shift A: 07:00 – 18:30
//   Shift B: 19:00 – 06:30 (next morning)
// Start inclusive, end exclusive. 18:30–19:00 and 06:30–07:00 belong to
// neither shift. Applies only to starting a new session — a running session
// is never blocked by it.
// Welding (WELDING_SCHEDULE): Shift A 07:00 – 17:00, Shift B 17:00 – 06:30.
export const SHIFT_START_WINDOWS: Record<ShiftCode, TimeInterval> = {
  A: ASSEMBLY_SCHEDULE.shifts.A.startWindow,
  B: ASSEMBLY_SCHEDULE.shifts.B.startWindow, // wraps past midnight
};

function inStartWindow(shift: ShiftCode, minuteOfDay: number, profile: ScheduleProfile = ASSEMBLY_SCHEDULE): boolean {
  const { start, end } = shiftSchedule(shift, profile).startWindow;
  return start < end
    ? minuteOfDay >= start && minuteOfDay < end
    : minuteOfDay >= start || minuteOfDay < end;
}

// The shift that may be started at this minute of the day, or null in the
// gaps between the two windows.
export function shiftForStartTime(minuteOfDay: number, profile: ScheduleProfile = ASSEMBLY_SCHEDULE): ShiftCode | null {
  if (inStartWindow('A', minuteOfDay, profile)) return 'A';
  if (inStartWindow('B', minuteOfDay, profile)) return 'B';
  return null;
}

// Error message when `shift` may not be started at `minuteOfDay`, else null.
export function validateShiftStartWindow(shift: ShiftCode, minuteOfDay: number, profile: ScheduleProfile = ASSEMBLY_SCHEDULE): string | null {
  if (inStartWindow(shift, minuteOfDay, profile)) return null;
  const w = shiftSchedule(shift, profile).startWindow;
  const now = formatAbsMinutesToAmPm(minuteOfDay);
  const allowed = shiftForStartTime(minuteOfDay, profile);
  return (
    `Shift ${shift} can only be started between ${formatAbsMinutesToAmPm(w.start)} and ${formatAbsMinutesToAmPm(w.end)}. ` +
    `The current time is ${now}` +
    (allowed ? ` — select Shift ${allowed} instead.` : ' — no shift can be started right now.')
  );
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
  otherIntervals: TimeInterval[],
  lunch?: TimeInterval | null
): ChangeoverPlacement {
  const error = validateChangeoverInterval({ interval: { start: atAbs, end: atAbs }, slots, otherIntervals, allowInstant: true, lunch });
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
