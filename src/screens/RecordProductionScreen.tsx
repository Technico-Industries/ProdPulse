// src/screens/RecordProductionScreen.tsx
//
// KEY BEHAVIOURS:
//  1. SETUP PHASE → supervisor fills location / line / operators → taps "Start Production"
//  2. ACTIVE SESSION → hourly slot cards appear; session is persisted to Firestore
//     (activeSessions/{lineId}) so the supervisor can log out and back in and
//     resume exactly where they left off.
//  3. LINE STOPPED → when any stop is running, the session doc's `lineStopped`
//     flag is set to true. Even after logout/login the line shows as STOPPED and
//     the supervisor must press "Resume Line" (= endStop) before they can record.
//  4. "Stop Production" → ends the session, removes the activeSessions doc.
//
// Changes:
// - Removed auto-restore of "one session per supervisor" on initial load so a supervisor
//   can record for multiple lines.
// - Only restore an active session when a specific line is selected.
// - The "Stop Production" button now saves/persists the session. Ending/removing the
//   activeSessions doc only happens when the supervisor explicitly presses
//   "Finalize & End Session" (bulk finalization).
// - OT hours can be changed during an active session and will be persisted.

import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  SafeAreaView,
  ScrollView,
  ActivityIndicator,
  Alert,
  Modal,
  BackHandler,
  Animated,
  PanResponder,
  Dimensions,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import {
  collection,
  getDocs,
  addDoc,
  serverTimestamp,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
} from 'firebase/firestore';
import { db } from '../services/firebase';
import { useAuthStore } from '../stores/authStore';
import { PLANTS, WORKSHOPS, DIVISIONS } from '../constants/lineOptions';

// ─── Types ────────────────────────────────────────────────────────────────────

type Operator = { id: string; name: string; code: string };
type Line = {
  id: string;
  plant?: string | null;
  workshop?: string | null;
  division?: string | null;
  lineName?: string | null;
  parts?: { name: string; cycleTimeSeconds: number }[];
};

type Slot = {
  index: number;
  startMinutesAbs: number;
  endMinutesAbs: number;
  durationMinutes: number;
  label: string;
  productiveMinutes: number;
};

type ChangeoverInfo = {
  slotIndex: number;
  atAbs: number;
  oldPartIndex: number;
  newPartIndex: number;
  beforeMinutes: number;
  afterMinutes: number;
  expectedBefore: number;
  expectedAfter: number;
};

type StopEvent = {
  reason: string;
  startAbs: number;
  endAbs?: number;
  durationMinutes?: number;
  running?: boolean;
  // Firestore doc id of the lineBreakdowns record this stop created (maintenance
  // stops only). Each stop gets its OWN document (via addDoc) instead of a
  // single doc keyed by lineId, so a line breaking down more than once keeps
  // every occurrence instead of the newest overwriting the previous one.
  breakdownDocId?: string;
};

// Active session document shape in Firestore (activeSessions/{lineId})
interface ActiveSessionDoc {
  lineId: string;
  lineName: string | null;
  plant: string | null;
  workshop: string | null;
  division: string | null;
  shift: 'A' | 'B';
  otHours: number;
  selectedPartIndex: number;
  supervisorName: string;
  supervisorCode: string;
  supervisorUid: string | null;
  operators: { id: string; name: string; code: string }[];
  producedBySlot: Record<string, number | null>;
  rejectionsBySlot: Record<string, number>;
  stopsBySlot: Record<string, StopEvent[]>;
  changeovers: Record<string, ChangeoverInfo | null>;
  producedSegment: Record<string, number | null>;
  deletedSlotIndices: number[];
  lineStopped: boolean;        // true if any stop is currently running
  startedAt: any;              // serverTimestamp
  updatedAt: any;              // serverTimestamp
}

// ─── Constants ────────────────────────────────────────────────────────────────

const STOP_REASONS = [
  'maintenance',
  'changeover',
  'quality',
  'material shortage',
  'no operator',
  'storage issue',
  'training',
  '5s',
  'meeting',
  'pokayoke checktime',
  'gauge/fixture maintenance',
  'no production plan',
  'power cut',
  'machine pm',
] as const;

// Reasons for a production shortfall (produced < expected) in a given time
// slot / segment. Shown ONLY when that shortfall exists — see attemptSave.
const LOSS_REASONS: { code: string; label: string }[] = [
  { code: 'A', label: 'Job setup delay' },
  { code: 'B', label: 'Wait for component' },
  { code: 'C', label: 'Operator short / seed loss' },
  { code: 'D', label: 'Machine breakdown' },
  { code: 'E', label: 'Quality problem' },
  { code: 'F', label: 'Power failure' },
  { code: 'G', label: 'Stop by schedule' },
  { code: 'H', label: 'Jig fixture breakdown' },
  { code: 'I', label: 'Packing bin short' },
  { code: 'J', label: 'Air pressure low' },
  { code: 'K', label: 'Others' },
];

interface LossReason {
  code: string;
  label: string;
  note?: string;
}

// ─── Dropdown picker (tap-a-box → select from list) ────────────────────────────
// Every setup field (Plant / Workshop / Division / Line / Part / Shift) is a
// single empty-looking box. Tapping it opens a modal list; picking a value
// updates the relevant state, which then gets written to Firestore in one
// structured write when the supervisor presses "Start Production"
// (see handleStartProduction) or, during an active session, via persistSession.

type DropdownKind = 'plant' | 'workshop' | 'division' | 'line' | 'part' | 'shift';

type DropdownOption = { key: string; label: string; sublabel?: string };

const DROPDOWN_TITLES: Record<DropdownKind, string> = {
  plant: 'Select Plant',
  workshop: 'Select Workshop',
  division: 'Select Division',
  line: 'Select Line',
  part: 'Select Part / Model',
  shift: 'Select Shift',
};

function PickerBox({
  label,
  value,
  placeholder,
  onPress,
  disabled,
}: {
  label: string;
  value?: string | null;
  placeholder: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <Pressable
        onPress={onPress}
        disabled={disabled}
        style={[styles.pickerBox, disabled && styles.disabledInput]}
      >
        <Text style={[styles.pickerBoxText, !value && styles.pickerBoxPlaceholder]} numberOfLines={1}>
          {value || placeholder}
        </Text>
        <Ionicons name="chevron-down" size={18} color="#8A96A3" />
      </Pressable>
    </View>
  );
}

const SHIFT_A_START = 7 * 60;
const SHIFT_A_END = 15 * 60 + 30;
const SHIFT_B_START = 19 * 60;
const SHIFT_B_END_ABS = 24 * 60 + 3 * 60 + 30;

// ─── Floating calculator ────────────────────────────────────────────────────
// A small floating icon, always on top of whichever phase (setup/active) is
// showing, that opens a basic +/-/×/÷ calculator — a quick scratchpad for the
// supervisor (e.g. checking expected parts, adding up a few slot counts)
// without leaving this screen. Fully self-contained: its own state, its own
// math, no Firestore or session data involved.
const CALC_FAB_SIZE = 44;
const CALC_FAB_MARGIN = 12; // keep the button fully on screen when dragged near an edge

const CALC_BUTTON_LABELS = [
  ['⌫', 'C', '±', '%', '÷'],
  ['7', '8', '9', '×'],
  ['4', '5', '6', '−'],
  ['1', '2', '3', '+'],
  ['0', '.', '='],
] as const;

function computeCalc(a: number, b: number, op: string): number {
  switch (op) {
    case '+': return a + b;
    case '−': return a - b;
    case '×': return a * b;
    case '÷': return b === 0 ? NaN : a / b;
    default: return b;
  }
}

function CalculatorButton() {
  const [visible, setVisible] = useState(false);
  const [display, setDisplay] = useState('0');
  const [pendingValue, setPendingValue] = useState<number | null>(null);
  const [pendingOp, setPendingOp] = useState<string | null>(null);
  const [awaitingOperand, setAwaitingOperand] = useState(false);

  // ── Drag-anywhere-on-screen positioning ──────────────────────────────
  // The button starts near its old fixed spot (top-right) but can be
  // dragged anywhere on screen afterward. Position is tracked as plain
  // {x, y} via Animated.ValueXY and rendered with pan.getLayout()
  // ({ left, top }), rather than the old fixed top/right style.
  const screen = Dimensions.get('window');
  const pan = useRef(
    new Animated.ValueXY({ x: screen.width - CALC_FAB_SIZE - 16, y: 12 })
  ).current;
  // Where the drag started, captured on grant, used on release to compute
  // the final clamped position and on move to tell a drag from a tap.
  const dragStart = useRef({ x: 0, y: 0 });
  const didDrag = useRef(false);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_e, gesture) =>
        Math.abs(gesture.dx) > 2 || Math.abs(gesture.dy) > 2,
      onPanResponderGrant: () => {
        didDrag.current = false;
        pan.stopAnimation((value) => { dragStart.current = value; });
        pan.setOffset(dragStart.current);
        pan.setValue({ x: 0, y: 0 });
      },
      onPanResponderMove: (evt, gesture) => {
        if (Math.abs(gesture.dx) > 2 || Math.abs(gesture.dy) > 2) didDrag.current = true;
        return Animated.event([null, { dx: pan.x, dy: pan.y }], { useNativeDriver: false })(evt, gesture);
      },
      onPanResponderRelease: (_e, gesture) => {
        pan.flattenOffset();

        // Keep the button fully on screen regardless of where it's dropped.
        const win = Dimensions.get('window');
        const rawX = dragStart.current.x + gesture.dx;
        const rawY = dragStart.current.y + gesture.dy;
        const maxX = Math.max(CALC_FAB_MARGIN, win.width - CALC_FAB_SIZE - CALC_FAB_MARGIN);
        const maxY = Math.max(CALC_FAB_MARGIN, win.height - CALC_FAB_SIZE - CALC_FAB_MARGIN);
        const clampedX = Math.min(Math.max(rawX, CALC_FAB_MARGIN), maxX);
        const clampedY = Math.min(Math.max(rawY, CALC_FAB_MARGIN), maxY);
        Animated.spring(pan, {
          toValue: { x: clampedX, y: clampedY },
          useNativeDriver: false,
          friction: 7,
        }).start();

        // A near-stationary touch (no real drag) is treated as a tap that
        // opens the calculator — mirrors what Pressable's onPress did
        // before this button became draggable.
        if (!didDrag.current) setVisible(true);
      },
    })
  ).current;

  function resetCalc() {
    setDisplay('0');
    setPendingValue(null);
    setPendingOp(null);
    setAwaitingOperand(false);
  }

  function closeCalc() {
    setVisible(false);
    resetCalc();
  }

  function inputDigit(d: string) {
    if (awaitingOperand) {
      setDisplay(d === '.' ? '0.' : d);
      setAwaitingOperand(false);
      return;
    }
    if (d === '.') {
      if (!display.includes('.')) setDisplay(display + '.');
      return;
    }
    setDisplay(display === '0' ? d : display + d);
  }

  function toggleSign() {
    if (display === '0') return;
    setDisplay(display.startsWith('-') ? display.slice(1) : `-${display}`);
  }

  function inputPercent() {
    const val = parseFloat(display);
    if (isNaN(val)) return;
    setDisplay(String(val / 100));
  }

  function inputOperator(op: string) {
    const inputValue = parseFloat(display);
    if (pendingOp != null && !awaitingOperand && pendingValue != null) {
      const result = computeCalc(pendingValue, inputValue, pendingOp);
      setDisplay(isNaN(result) ? 'Error' : String(round4(result)));
      setPendingValue(isNaN(result) ? null : result);
    } else {
      setPendingValue(inputValue);
    }
    setPendingOp(op);
    setAwaitingOperand(true);
  }

  function inputEquals() {
    const inputValue = parseFloat(display);
    if (pendingOp == null || pendingValue == null) return;
    const result = computeCalc(pendingValue, inputValue, pendingOp);
    setDisplay(isNaN(result) ? 'Error' : String(round4(result)));
    setPendingValue(null);
    setPendingOp(null);
    setAwaitingOperand(true);
  }

  function inputBackspace() {
    if (awaitingOperand) return; // nothing typed yet for this operand
    if (display === 'Error' || display.length <= 1 || (display.length === 2 && display.startsWith('-'))) {
      setDisplay('0');
    } else {
      setDisplay(display.slice(0, -1));
    }
  }

  function round4(n: number) {
    return Math.round(n * 10000) / 10000;
  }

  function handlePress(label: string) {
    if (label === 'C') { resetCalc(); return; }
    if (label === '⌫') { inputBackspace(); return; }
    if (label === '±') { toggleSign(); return; }
    if (label === '%') { inputPercent(); return; }
    if (label === '=') { inputEquals(); return; }
    if (['+', '−', '×', '÷'].includes(label)) { inputOperator(label); return; }
    inputDigit(label);
  }

  return (
    <>
      {Platform.OS === 'web' ? (
        // No PanResponder on web: RNW emulates the native touch-responder
        // system via document-level listeners, and once this always-claims
        // (`onStartShouldSetPanResponder: () => true`) responder gets
        // engaged, it can fail to cleanly release — silently intercepting
        // subsequent clicks anywhere else on the page with no visible
        // error. A plain Pressable has none of that responder-negotiation
        // machinery, so it can't swallow other controls' clicks. Dragging
        // isn't essential on web anyway, since the mouse can already reach
        // anywhere on screen.
        <Pressable
          onPress={() => setVisible(true)}
          style={[styles.calcFab, pan.getLayout()]}
          accessibilityLabel="Open calculator"
        >
          <Ionicons name="calculator-outline" size={24} color="#14181C" />
        </Pressable>
      ) : (
        <Animated.View
          {...panResponder.panHandlers}
          style={[styles.calcFab, pan.getLayout()]}
          accessibilityLabel="Open calculator"
        >
          <Ionicons name="calculator-outline" size={24} color="#14181C" />
        </Animated.View>
      )}

      <Modal visible={visible} animationType="fade" transparent onRequestClose={closeCalc}>
        <View style={styles.calcModalOverlay}>
          <View style={styles.calcCard}>
            <View style={styles.calcHeaderRow}>
              <Text style={styles.calcTitle}>Calculator</Text>
              <Pressable onPress={closeCalc} hitSlop={10}>
                <Ionicons name="close" size={22} color="#8A96A3" />
              </Pressable>
            </View>
            <View style={styles.calcDisplayBox}>
              {pendingOp != null && pendingValue != null && (
                <Text style={styles.calcExpressionText} numberOfLines={1}>
                  {round4(pendingValue)} {pendingOp}{!awaitingOperand ? ` ${display}` : ''}
                </Text>
              )}
              <Text style={styles.calcDisplayText} numberOfLines={1} adjustsFontSizeToFit>
                {display}
              </Text>
            </View>
            {CALC_BUTTON_LABELS.map((row, ri) => (
              <View key={ri} style={styles.calcRow}>
                {row.map((label) => (
                  <Pressable
                    key={label}
                    onPress={() => handlePress(label)}
                    style={[
                      styles.calcKey,
                      label === '0' && styles.calcKeyWide,
                      ['÷', '×', '−', '+', '='].includes(label) && styles.calcKeyOperator,
                      ['⌫', 'C', '±', '%'].includes(label) && styles.calcKeyFunc,
                    ]}
                  >
                    <Text
                      style={[
                        styles.calcKeyText,
                        ['÷', '×', '−', '+', '='].includes(label) && styles.calcKeyOperatorText,
                        ['⌫', 'C', '±', '%'].includes(label) && styles.calcKeyFuncText,
                      ]}
                    >
                      {label}
                    </Text>
                  </Pressable>
                ))}
              </View>
            ))}
          </View>
        </View>
      </Modal>
    </>
  );
}

const BREAKS: { start: number; end: number }[] = [
  { start: 9 * 60 + 30, end: 9 * 60 + 40 },
  { start: 12 * 60 + 15, end: 12 * 60 + 45 },
  { start: 14 * 60, end: 14 * 60 + 10 },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatAbsMinutesToAmPm(mAbs: number) {
  const m = ((mAbs % 1440) + 1440) % 1440;
  const hh = Math.floor(m / 60);
  const mm = m % 60;
  const suffix = hh >= 12 ? 'PM' : 'AM';
  const hour12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${hour12.toString().padStart(2, '0')}:${mm.toString().padStart(2, '0')} ${suffix}`;
}

function overlapMinutes(aStart: number, aEnd: number, bStart: number, bEnd: number) {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

// ─── Production day ──────────────────────────────────────────────────────────
// A "production day" runs from 6:30 AM to the next day's 6:30 AM - chosen
// because it's 30 min before Shift A starts (7:00 AM) and ~3 hours after
// Shift B ends (3:30 AM), so no shift is ever active across that boundary.
// This is what lets Shift B (7:00 PM - 3:30 AM) keep the SAME production
// date all night, even though the real calendar date changes at midnight:
// a session started at 7:00 PM on the 22nd is still "22nd" at 2:00 AM,
// because 2:00 AM is before the 6:30 AM cutover into the 23rd.
const PRODUCTION_DAY_CUTOVER_MINUTES = 6 * 60 + 30; // 6:30 AM

function productionDayKeyFor(epochMs: number): string {
  const d = new Date(epochMs);
  const minutesOfDay = d.getHours() * 60 + d.getMinutes();
  const effective = new Date(d);
  if (minutesOfDay < PRODUCTION_DAY_CUTOVER_MINUTES) {
    effective.setDate(effective.getDate() - 1);
  }
  const y = effective.getFullYear();
  const m = String(effective.getMonth() + 1).padStart(2, '0');
  const day = String(effective.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatProductionDayDisplay(key: string | null): string {
  if (!key) return '—';
  const [y, m, d] = key.split('-');
  return `${d}/${m}/${y}`;
}

function formatSessionStartedAt(ms: number | null): string {
  if (!ms) return '—';
  const d = new Date(ms);
  const day = String(d.getDate()).padStart(2, '0');
  const mon = String(d.getMonth() + 1).padStart(2, '0');
  return `${day}/${mon} · ${formatAbsMinutesToAmPm(d.getHours() * 60 + d.getMinutes())}`;
}

// Division only applies under the Assembly workshop. Matched by substring
// rather than an exact hardcoded string so this keeps working even if the
// exact label in lineOptions.ts changes (e.g. "Assembly" vs "Assembly Shop").
function isAssemblyWorkshop(w: string | null) {
  return !!w && w.toLowerCase().includes('assembly');
}

function buildSlots(shift: 'A' | 'B', otHours: number): Slot[] {
  const startAbs = shift === 'A' ? SHIFT_A_START : SHIFT_B_START;
  const endAbs = shift === 'A' ? SHIFT_A_END : SHIFT_B_END_ABS;
  const fullEnd = endAbs + otHours * 60;
  const allBreaks = [...BREAKS];
  if (otHours > 0) allBreaks.push({ start: 16 * 60, end: 16 * 60 + 10 });

  const result: Slot[] = [];
  let cursor = startAbs;
  let idx = 0;
  while (cursor < fullEnd) {
    const next = Math.min(fullEnd, cursor + 60);
    const duration = next - cursor;
    // Every slot is 60 wall-clock minutes except: the very first slot of the
    // day, which reserves 10 minutes for startup, and the 1:00 PM – 2:00 PM
    // slot, which is a 50-minute production slot (its clock range and every
    // other slot's boundaries are unaffected — only its own productive
    // capacity is reduced).
    const reserve = cursor === startAbs || cursor === 13 * 60 ? 10 : 0;
    let breakOverlap = 0;
    allBreaks.forEach((b) => { breakOverlap += overlapMinutes(cursor, next, b.start, b.end); });
    const productive = Math.max(0, Math.round((duration - reserve - breakOverlap) * 100) / 100);
    result.push({
      index: idx,
      startMinutesAbs: cursor,
      endMinutesAbs: next,
      durationMinutes: duration,
      productiveMinutes: productive,
      label: `${formatAbsMinutesToAmPm(cursor)} - ${formatAbsMinutesToAmPm(next)}${duration < 60 ? ' (partial)' : ''}`,
    });
    cursor = next;
    idx++;
  }
  return result;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function RecordProductionScreen() {
  const navigation = useNavigation<any>();
  const user = useAuthStore((s) => s.user);

  // ── Screen phase: 'loading' | 'setup' | 'active'
  const [phase, setPhase] = useState<'loading' | 'setup' | 'active'>('loading');
  const [sessionLineId, setSessionLineId] = useState<string | null>(null); // lineId of the restored session
  const [productionDate, setProductionDate] = useState<string | null>(null); // pinned production-day key (YYYY-MM-DD)
  const [savedSlotIndices, setSavedSlotIndices] = useState<Set<number>>(new Set());
  // Hourly cards the supervisor deleted for this session — deleted slots are
  // excluded from planning (shiftPlannedTotal, partTargetSummary) and hidden
  // from the card list. Only unsaved slots can be deleted (see
  // handleDeleteSlot).
  const [deletedSlotIndices, setDeletedSlotIndices] = useState<Set<number>>(new Set());


  // Active sessions for THIS supervisor across any line, shown as tappable
  // "continue" cards under the Start Production button so they don't have
  // to re-pick plant/workshop/division/line/part/shift/operators every time
  // they reopen the screen mid-shift.
  const [activeSessionsList, setActiveSessionsList] = useState<
    { docId: string; data: ActiveSessionDoc }[]
  >([]);
  const [loadingActiveSessions, setLoadingActiveSessions] = useState(false);

  // ── Supervisor profile
  const [supervisorName, setSupervisorName] = useState(user?.name ?? '');
  const [supervisorCode, setSupervisorCode] = useState('');
  const [profileLoading, setProfileLoading] = useState(true);

  // ── Setup form state
  const [plant, setPlant] = useState<string | null>(null);
  const [workshop, setWorkshop] = useState<string | null>(null);
  const [division, setDivision] = useState<string | null>(null);
  const [selectedShift, setSelectedShift] = useState<'A' | 'B'>('A');
  const [otHours, setOtHours] = useState(0);
  const [operators, setOperators] = useState<Operator[]>([{ id: `op-${Date.now()}`, name: '', code: '' }]);

  // ── Which picker box is currently open (null = none)
  const [activeDropdown, setActiveDropdown] = useState<DropdownKind | null>(null);

  // ── Lines
  const [allLines, setAllLines] = useState<Line[]>([]);
  const [loadingLines, setLoadingLines] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedLineId, setSelectedLineId] = useState<string | null>(null);
  const [selectedPartIndex, setSelectedPartIndex] = useState(0);
  const selectedLine = allLines.find((l) => l.id === selectedLineId) ?? null;

  // ── Production data (active phase)
  const [producedBySlot, setProducedBySlot] = useState<Record<number, number | null>>({});
  // Keyed by String(slot.index) for a normal slot, or `${slot.index}:before`
  // / `${slot.index}:after` for a changeover segment — same key scheme as
  // producedSegment and lossReasonBySlot, so each split part-section has its
  // own independent rejection count.
  const [rejectionsBySlot, setRejectionsBySlot] = useState<Record<string, number>>({});
  const [stopsBySlot, setStopsBySlot] = useState<Record<number, StopEvent[]>>({});
  // Mirrors stopsBySlot for reads inside setTimeout/async callbacks below,
  // where a closure over state captured at call time would otherwise be stale.
  const stopsBySlotRef = useRef<Record<number, StopEvent[]>>({});
  useEffect(() => { stopsBySlotRef.current = stopsBySlot; }, [stopsBySlot]);
  const [changeovers, setChangeovers] = useState<Record<number, ChangeoverInfo | null>>({});
  const [producedSegment, setProducedSegment] = useState<Record<string, number | null>>({});

  // ─── Navigation ────────────────────────────────────────────────────────
  // DashboardScreen navigates straight into this screen via the route
  // 'RecordProduction' — there is no separate intermediate "Production"
  // screen/route to target by name (confirmed by DashboardScreen.tsx's
  // SUPERVISOR_OPTIONS config, and by the crash that resulted from guessing
  // one). What the supervisor means by "the Production screen" is this
  // screen's own setup view (pick line/shift) — the same view
  // runAutoFinalize already returns to once a session is closed. So:
  //   - while a session is ACTIVE, "going back" resets this screen to that
  //     setup view (mirrors runAutoFinalize's existing reset exactly) —
  //     no navigation call at all, nothing to guess a route name for;
  //   - from the setup view itself, there's nothing left to go back to
  //     within this screen, so it's a real navigation.goBack() to
  //     Dashboard — only ever called when canGoBack() is true.
  // This is the single source of truth for every "leave/reset this screen"
  // action: header back button, hardware back, and Finalize & End Session.
  const goBackToProduction = () => {
    if (phase === 'active') {
      setPhase('setup');
      setSessionLineId(null);
      setProducedBySlot({});
      setRejectionsBySlot({});
      setStopsBySlot({});
      setChangeovers({});
      setProducedSegment({});
      setSavedSlotIndices(new Set());
      setDeletedSlotIndices(new Set());
      setProductionDate(null);
      return;
    }
    if (navigation.canGoBack()) {
      navigation.goBack();
    }
  };

  // Android hardware back button — while this screen is focused, route it
  // through the exact same logic as the header back button and every other
  // "leave this screen" action, so behavior is consistent everywhere.
  useFocusEffect(
    useCallback(() => {
      const onHardwareBack = () => {
        goBackToProduction();
        return true; // we handled it — don't let the default pop happen
      };
      const sub = BackHandler.addEventListener('hardwareBackPress', onHardwareBack);
      return () => sub.remove();
    }, [navigation, phase])
  );

  // ── Modal states
  const [changeModalVisible, setChangeModalVisible] = useState(false);
  const [changeModalNewPartIndex, setChangeModalNewPartIndex] = useState<number | null>(null);
  const [stopModalVisible, setStopModalVisible] = useState(false);
  const [stopModalSlotIndex, setStopModalSlotIndex] = useState<number | null>(null);
  const [stopModalReason, setStopModalReason] = useState<string | null>(null);

  // ── Loss reasons — keyed by String(slot.index) for a normal slot, or
  // `${slot.index}:before` / `${slot.index}:after` for a changeover segment.
  // Only populated once a shortfall (produced < expected) has actually been
  // confirmed with a reason via the modal below.
  const [lossReasonBySlot, setLossReasonBySlot] = useState<Record<string, LossReason | undefined>>({});
  const [lossModalVisible, setLossModalVisible] = useState(false);
  const [lossModalKey, setLossModalKey] = useState<string | null>(null);
  const [lossModalAmount, setLossModalAmount] = useState(0);
  const [lossModalCode, setLossModalCode] = useState<string | null>(null);
  const [lossModalNote, setLossModalNote] = useState('');
  // Set right before opening the loss modal so Confirm can resume whichever
  // save attempt triggered it (a changeover slot may need two reasons before
  // it can actually save).
  const pendingAfterLossRef = useRef<(() => void) | null>(null);

  // ── Live timer
  const [nowMs, setNowMs] = useState(Date.now());
  const intervalRef = useRef<number | null>(null);

  // ── Saving
  const [saving, setSaving] = useState(false);
  const [startingProduction, setStartingProduction] = useState(false);
  const [persistingSession, setPersistingSession] = useState(false);

  // ── Derived
  const slots = useMemo(() => buildSlots(selectedShift, otHours), [selectedShift, otHours]);

  // Slots the supervisor hasn't deleted — this is what planning totals and
  // the card list are built from, so a deleted hourly card is excluded from
  // both the shift's planned total and the screen, while `slots` itself
  // stays the full, untouched shift schedule (still needed e.g. to walk
  // changeovers/active-part tracking consistently).
  const visibleSlots = useMemo(
    () => slots.filter((s) => !deletedSlotIndices.has(s.index)),
    [slots, deletedSlotIndices]
  );

  // Total expected parts for the WHOLE shift, ignoring downtime, including
  // OT — this is what shows the instant "Start Production" is pressed
  // (slots already factor in otHours), and stays live if OT is edited
  // afterward. Uses the currently selected part for every slot since no
  // changeover exists yet at the moment production starts. Deleted slots
  // (see visibleSlots) don't contribute to this total.
  const shiftPlannedTotal = useMemo(() => {
    if (!selectedLine) return 0;
    const cycle = selectedLine.parts?.[selectedPartIndex]?.cycleTimeSeconds ?? 0;
    if (!cycle) return 0;
    return visibleSlots.reduce((sum, s) => sum + Math.floor((s.productiveMinutes * 60) / cycle), 0);
  }, [visibleSlots, selectedLine, selectedPartIndex]);

  // Part Target Summary — redistributes the FIXED shiftPlannedTotal across
  // whichever parts actually run during the shift (accounting for mid-shift
  // changeovers), grouped by PART NAME so a part that runs in more than one
  // slot/segment (e.g. RH, then LH, then RH again later) contributes to a
  // single combined line instead of appearing as separate repeated rows —
  // RH=410 + RH=262 always displays as one RH=672 line, never two.
  //
  // Approach: work out how many minutes each part NAME is scheduled to run
  // (splitting any changeover slot into its before/after segments and
  // summing minutes by name as we go), turn each name's time-share into an
  // exact proportion of shiftPlannedTotal, then round with the
  // largest-remainder method — floor every share, then hand the few
  // leftover parts to whichever names had the largest fractional
  // remainder — so the rounded integers still sum to exactly
  // shiftPlannedTotal (plain Math.floor/round on each share independently
  // would drift the total up or down).
  const partTargetSummary = useMemo(() => {
    if (!selectedLine || shiftPlannedTotal <= 0) return [];

    const nameFor = (idx: number) => selectedLine.parts?.[idx]?.name ?? `Part ${idx + 1}`;

    const minutesByName: Record<string, number> = {};
    let totalMinutes = 0;
    let active = selectedPartIndex;
    for (const s of visibleSlots) {
      const co = changeovers[s.index];
      if (co) {
        const oldName = nameFor(co.oldPartIndex);
        const newName = nameFor(co.newPartIndex);
        minutesByName[oldName] = (minutesByName[oldName] ?? 0) + co.beforeMinutes;
        minutesByName[newName] = (minutesByName[newName] ?? 0) + co.afterMinutes;
        totalMinutes += co.beforeMinutes + co.afterMinutes;
        active = co.newPartIndex;
      } else {
        const name = nameFor(active);
        minutesByName[name] = (minutesByName[name] ?? 0) + s.productiveMinutes;
        totalMinutes += s.productiveMinutes;
      }
    }
    if (totalMinutes <= 0) return [];

    const raw = Object.entries(minutesByName).map(([name, minutes]) => {
      const exact = (shiftPlannedTotal * minutes) / totalMinutes;
      return { name, floor: Math.floor(exact), remainder: exact - Math.floor(exact) };
    });

    const allocated = raw.reduce((sum, r) => sum + r.floor, 0);
    let remaining = shiftPlannedTotal - allocated;

    const byRemainder = [...raw].sort((a, b) => b.remainder - a.remainder);
    for (let i = 0; i < byRemainder.length && remaining > 0; i++) {
      byRemainder[i].floor += 1;
      remaining--;
    }

    return raw
      .map((r) => ({ name: r.name, target: r.floor }))
      .sort((a, b) => b.target - a.target);
  }, [selectedLine, visibleSlots, changeovers, selectedPartIndex, shiftPlannedTotal]);

  const anyStopRunning = useMemo(
    () => Object.values(stopsBySlot).some((arr) => arr.some((s) => s.running)),
    [stopsBySlot]
  );

  const filteredLines = useMemo(() => {
    return allLines.filter((l) => {
      if (plant && l.plant && String(l.plant).toLowerCase() !== String(plant).toLowerCase()) return false;
      if (workshop && l.workshop && !String(l.workshop).toLowerCase().includes(String(workshop).toLowerCase())) return false;
      if (division && l.division && !String(l.division).toLowerCase().includes(String(division).toLowerCase())) return false;
      return true;
    });
  }, [allLines, plant, workshop, division]);

  // ── Options shown inside whichever picker box is currently open
  const dropdownOptions: DropdownOption[] = useMemo(() => {
    switch (activeDropdown) {
      case 'plant':
        return [{ key: 'ANY', label: 'Any' }, ...PLANTS.map((p) => ({ key: p, label: p }))];
      case 'workshop':
        return [{ key: 'ANY', label: 'Any' }, ...WORKSHOPS.map((w) => ({ key: w, label: w }))];
      case 'division':
        return [{ key: 'ANY', label: 'Any' }, ...DIVISIONS.map((d) => ({ key: d, label: d }))];
      case 'line':
        return filteredLines.map((l) => ({
          key: l.id,
          label: l.lineName ?? l.id,
          sublabel: [l.plant, l.workshop].filter(Boolean).join(' · ') || undefined,
        }));
      case 'part':
        return (selectedLine?.parts ?? []).map((p, i) => ({ key: String(i), label: `${p.name} · ${p.cycleTimeSeconds}s` }));
      case 'shift':
        return (['A', 'B'] as const).map((sh) => ({
          key: sh,
          label: `Shift ${sh} · ${formatAbsMinutesToAmPm(sh === 'A' ? SHIFT_A_START : SHIFT_B_START)} – ${formatAbsMinutesToAmPm(sh === 'A' ? SHIFT_A_END : SHIFT_B_END_ABS)}`,
        }));
      default:
        return [];
    }
  }, [activeDropdown, filteredLines, selectedLine]);

  const dropdownSelectedKey = useMemo(() => {
    switch (activeDropdown) {
      case 'plant': return plant ?? 'ANY';
      case 'workshop': return workshop ?? 'ANY';
      case 'division': return division ?? 'ANY';
      case 'line': return selectedLineId ?? '';
      case 'part': return String(selectedPartIndex);
      case 'shift': return selectedShift;
      default: return '';
    }
  }, [activeDropdown, plant, workshop, division, selectedLineId, selectedPartIndex, selectedShift]);

  // ── Apply the tapped option to the right piece of state.
  // These are plain local updates; the structured write to Firestore happens
  // in one shot in handleStartProduction (or persistSession once a session
  // is already active), so the database always gets a consistent document
  // rather than one field at a time.
  function handleDropdownSelect(key: string) {
    switch (activeDropdown) {
      case 'plant':
        setPlant(key === 'ANY' ? null : key);
        break;
      case 'workshop':
        setWorkshop(key === 'ANY' ? null : key);
        if (!isAssemblyWorkshop(key)) setDivision(null);
        break;
      case 'division':
        setDivision(key === 'ANY' ? null : key);
        break;
      case 'line':
        setSelectedLineId(key);
        setSelectedPartIndex(0);
        break;
      case 'part':
        setSelectedPartIndex(Number(key));
        break;
      case 'shift':
        setSelectedShift(key as 'A' | 'B');
        break;
    }
    setActiveDropdown(null);
  }

  // ── Live timer management
  useEffect(() => {
    if (anyStopRunning) {
      if (!intervalRef.current) {
        intervalRef.current = setInterval(() => setNowMs(Date.now()), 1000) as unknown as number;
      }
    } else {
      if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
    }
    return () => { if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; } };
  }, [anyStopRunning]);

  // ─────────────────────────────────────────────────────────────────────────────
  // LOAD: Profile + lines
  // NOTE: We no longer auto-restore "the supervisor's single session".
  //       Instead we will restore when a specific line is selected.
  // ─────────────────────────────────────────────────────────────────────────────

  // ─────────────────────────────────────────────────────────────────────────────
  // LOAD: active sessions for the "continue where you left off" list
  // ─────────────────────────────────────────────────────────────────────────────

  const loadActiveSessions = async () => {
    if (!user?.uid) { setActiveSessionsList([]); return; }
    setLoadingActiveSessions(true);
    try {
      const snap = await getDocs(collection(db, 'activeSessions'));
      const mine = snap.docs
        .map((d) => ({ docId: d.id, data: d.data() as ActiveSessionDoc }))
        .filter((s) => s.data.supervisorUid === user.uid);
      setActiveSessionsList(mine);
    } catch (e) {
      console.error('[loadActiveSessions]', e);
    } finally {
      setLoadingActiveSessions(false);
    }
  };

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        // 1. Load supervisor profile
        if (user?.uid) {
          const snap = await getDoc(doc(db, 'users', user.uid));
          if (mounted && snap.exists()) {
            const d: any = snap.data();
            setSupervisorName(d.name ?? user?.email ?? '');
            setSupervisorCode(d.employeeCode ?? '');
            if (d.plant) setPlant(d.plant);
          }
        }
        setProfileLoading(false);

        // 2. Load all production lines
        setLoadingLines(true);
        const lineSnap = await getDocs(collection(db, 'productionLines'));
        const docs: Line[] = lineSnap.docs.map((d) => {
          const data: any = d.data();
          const partsArray =
            Array.isArray(data.parts) && data.parts.length ? data.parts :
            Array.isArray(data.models) && data.models.length ? data.models :
            Array.isArray(data.partsList) && data.partsList.length ? data.partsList : [];
          return {
            id: d.id,
            plant: data.plant ?? data.location ?? null,
            workshop: data.workshop ?? data.shop ?? null,
            division: data.division ?? data.unit ?? null,
            lineName: data.lineName ?? data.lineNumber ?? data.name ?? null,
            parts: partsArray.map((p: any) => ({
              name: p.name ?? p.partName ?? '',
              cycleTimeSeconds: Number(p.cycleTimeSeconds ?? p.cycleTime ?? p.cycle ?? 0),
            })),
          };
        });
        if (!mounted) return;
        setAllLines(docs);
        setLoadingLines(false);

        // 3. Load this supervisor's active sessions for the "continue" list
        await loadActiveSessions();

        // 4. Do NOT auto-restore here. Let the user pick a line/card and restore per-line session.
        if (mounted) setPhase('setup');
      } catch (e) {
        console.error('init error', e);
        if (mounted) { setProfileLoading(false); setLoadingLines(false); setPhase('setup'); }
      }
    })();
    return () => { mounted = false; };
  }, [user?.uid]);

  // ─────────────────────────────────────────────────────────────────────────────
  // When a line is selected, try to restore an existing active session for that line.
  // This enables one supervisor to maintain multiple active sessions across lines.
  // ─────────────────────────────────────────────────────────────────────────────

  useEffect(() => {
    let mounted = true;
    if (!selectedLineId) return;
    (async () => {
      try {
        const snap = await getDoc(doc(db, 'activeSessions', selectedLineId));
        if (!mounted) return;
        if (snap.exists()) {
          const sd = snap.data() as ActiveSessionDoc;
          restoreSession(sd, allLines, snap.id);
        }
      } catch (e) {
        console.error('[restore on select] ', e);
      }
    })();
    return () => { mounted = false; };
  }, [selectedLineId, allLines]);

  function restoreSession(sd: ActiveSessionDoc, lineList: Line[], docId: string) {
    setPlant(sd.plant);
    setWorkshop(sd.workshop);
    setDivision(sd.division);
    setSelectedShift(sd.shift);
    setOtHours(sd.otHours);
    setSelectedLineId(sd.lineId);
    setSelectedPartIndex(sd.selectedPartIndex);
    setSupervisorName(sd.supervisorName);
    setSupervisorCode(sd.supervisorCode);
    setOperators(sd.operators?.length ? sd.operators : [{ id: 'op-restored', name: '', code: '' }]);

    // Convert string keys back to number keys
    const cumNum: Record<number, number | null> = {};
    Object.entries(sd.producedBySlot ?? {}).forEach(([k, v]) => { cumNum[Number(k)] = v; });
    setProducedBySlot(cumNum);

    // Rejections are keyed by string (plain slot index, or a
    // '<slot>:before' / '<slot>:after' segment key) both in Firestore and
    // locally, so copy as-is — Number(k) would turn a segment key into NaN.
    setRejectionsBySlot({ ...(sd.rejectionsBySlot ?? {}) });

    const stopsNum: Record<number, StopEvent[]> = {};
    Object.entries(sd.stopsBySlot ?? {}).forEach(([k, v]) => { stopsNum[Number(k)] = v; });
    setStopsBySlot(stopsNum);

    const coNum: Record<number, ChangeoverInfo | null> = {};
    Object.entries(sd.changeovers ?? {}).forEach(([k, v]) => { coNum[Number(k)] = v; });
    setChangeovers(coNum);

    setProducedSegment(sd.producedSegment ?? {});
    setDeletedSlotIndices(new Set(sd.deletedSlotIndices ?? []));

    // Sessions started before this feature existed won't have a
    // productionDate field - fall back to computing it from startedAt (or
    // now, as a last resort) so old in-flight sessions don't immediately
    // look "rolled over" the moment this update ships.
    const startedAtMs = (sd as any).startedAt?.toMillis ? (sd as any).startedAt.toMillis() : Date.now();
    setProductionDate((sd as any).productionDate ?? productionDayKeyFor(startedAtMs));

    setSessionLineId(docId);
    setPhase('active');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // PERSIST SESSION to Firestore whenever production data changes
  // (unchanged except it will now be used to "save session" without deleting)
  // ─────────────────────────────────────────────────────────────────────────────

    const persistSession = async (
    overrideStops?: Record<number, StopEvent[]>,
    lineStopped?: boolean
  ) => {
    // require a selected line id
    if (!selectedLineId) return;

    const stopped = lineStopped ?? anyStopRunning;
    const stopsToSave = overrideStops ?? stopsBySlot;

    setPersistingSession(true);

    // Convert number keys → string for Firestore
    const cumStr: Record<string, number | null> = {};
    Object.entries(producedBySlot).forEach(([k, v]) => { cumStr[k] = v; });
    const rejStr: Record<string, number> = {};
    Object.entries(rejectionsBySlot).forEach(([k, v]) => { rejStr[k] = v; });
    const stopsStr: Record<string, StopEvent[]> = {};
    Object.entries(stopsToSave).forEach(([k, v]) => { stopsStr[k] = v; });
    const coStr: Record<string, ChangeoverInfo | null> = {};
    Object.entries(changeovers).forEach(([k, v]) => { coStr[k] = v; });

    // Compute downtime per-slot and totals. For running stops, use nowMs for end.
    const stopsSummaryBySlot: Record<string, { totalDowntimeMinutes: number; stopCount: number }> = {};
    let totalDowntimeMinutes = 0;
    Object.entries(stopsToSave).forEach(([k, arr]) => {
      let ms = 0;
      arr.forEach((ev) => {
        const end = ev.endAbs ?? (ev.running ? Date.now() : undefined);
        if (end !== undefined) ms += Math.max(0, (end - ev.startAbs));
      });
      const minutes = Math.round((ms / 60000) * 100) / 100;
      stopsSummaryBySlot[k] = { totalDowntimeMinutes: minutes, stopCount: arr.length };
      totalDowntimeMinutes += minutes;
    });
    totalDowntimeMinutes = Math.round(totalDowntimeMinutes);

    // Total rejections across slots
    const totalRejections = Object.values(rejectionsBySlot).reduce((s, v) => s + (v ?? 0), 0);

    // Production-day key (YYYY-MM-DD), pinned at session start via the
    // 6:30 AM cutover - this is what stays stable across midnight during
    // Shift B, unlike a raw new Date() calendar date would.
    const pd = productionDate ?? productionDayKeyFor(Date.now());

    const sessionData: Omit<ActiveSessionDoc, 'startedAt'> & { startedAt?: any; updatedAt: any } & {
      productionDate: string;
      totalDowntimeMinutes: number;
      totalRejections: number;
      stopsSummaryBySlot: Record<string, { totalDowntimeMinutes: number; stopCount: number }>;
    } = {
      lineId: selectedLineId,
      lineName: selectedLine?.lineName ?? null,
      // BUG FIX: use the selected line's own plant/workshop/division rather
      // than the Plant/Workshop/Division filter chips used to narrow the Line
      // list. Those chips are often left on "Any" once the supervisor knows
      // which line to pick, which was silently writing null location data
      // onto every record/session for that line.
      plant: selectedLine?.plant ?? plant ?? null,
      workshop: selectedLine?.workshop ?? workshop ?? null,
      division: selectedLine?.division ?? division ?? null,
      shift: selectedShift,
      otHours,
      selectedPartIndex,
      supervisorName,
      supervisorCode,
      supervisorUid: user?.uid ?? null,
      operators,
      producedBySlot: cumStr,
      rejectionsBySlot: rejStr,
      stopsBySlot: stopsStr,
      changeovers: coStr,
      producedSegment,
      deletedSlotIndices: Array.from(deletedSlotIndices),
      lineStopped: stopped,
      updatedAt: serverTimestamp(),

      // new structured summaries
      productionDate: pd,
      plannedProductionTotal: shiftPlannedTotal,
      totalDowntimeMinutes,
      totalRejections,
      stopsSummaryBySlot,
    };

    const docRef = doc(db, 'activeSessions', sessionLineId ?? selectedLineId);
    try {
      if (!sessionLineId) {
        // create doc (set startedAt only first time)
        await setDoc(docRef, { ...sessionData, startedAt: serverTimestamp() });
        setSessionLineId(selectedLineId);
      } else {
        // update existing
        await updateDoc(docRef, sessionData as any);
      }
    } catch (e) {
      console.error('[persistSession] error', e);
    } finally {
      setPersistingSession(false);
    }
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // START PRODUCTION (unchanged except allows multiple active sessions per supervisor)
  // ─────────────────────────────────────────────────────────────────────────────

  const handleStartProduction = async () => {
    if (!selectedLineId) { Alert.alert('Select a line', 'Choose a production line before starting.'); return; }
    const hasOperator = operators.some((o) => o.name.trim());
    if (!hasOperator) { Alert.alert('Add operator', 'Enter at least one operator name.'); return; }

    setStartingProduction(true);
    const pd = productionDayKeyFor(Date.now());
    try {
      const docRef = doc(db, 'activeSessions', selectedLineId);
      await setDoc(docRef, {
        lineId: selectedLineId,
        lineName: selectedLine?.lineName ?? null,
        plant: selectedLine?.plant ?? plant ?? null,
        workshop: selectedLine?.workshop ?? workshop ?? null,
        division: selectedLine?.division ?? division ?? null,
        shift: selectedShift,
        otHours,
        selectedPartIndex,
        supervisorName,
        supervisorCode,
        supervisorUid: user?.uid ?? null,
        operators,
        producedBySlot: {},
        rejectionsBySlot: {},
        stopsBySlot: {},
        changeovers: {},
        producedSegment: {},
        deletedSlotIndices: [],
        lineStopped: false,
        productionDate: pd,
        plannedProductionTotal: shiftPlannedTotal,
        startedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      setSessionLineId(selectedLineId);
      setProductionDate(pd);
      setSavedSlotIndices(new Set());
      setDeletedSlotIndices(new Set());
      setPhase('active');
    } catch (e) {
      Alert.alert('Error', 'Could not start session. Check your connection.');
    } finally {
      setStartingProduction(false);
    }
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // FINALIZE / END SESSION (new)
  // ─────────────────────────────────────────────────────────────────────────────

  // Sums planned production (cycle time × FULL slot duration, ignoring
  // downtime — same figure as plannedProduction on each slot doc) and actual
  // output, across only the slots the supervisor actually entered data for.
  // Mirrors the exact "does this slot count" condition used when writing
  // productionRecords, so this total always matches what's really in the DB.
  function computeShiftTotals() {
    let planned = 0;
    let actual = 0;
    let activePart = selectedPartIndex;
    for (const s of slots) {
      const co = changeovers[s.index] ?? null;
      if (!co) {
        const produced = producedBySlot[s.index];
        if (produced != null) {
          planned += expectedParts(activePart, s.productiveMinutes);
          actual += produced;
        }
      } else {
        const pb = producedSegment[`${s.index}:before`];
        const pa = producedSegment[`${s.index}:after`];
        if (pb != null) { planned += expectedParts(co.oldPartIndex, co.beforeMinutes); actual += pb; }
        if (pa != null) { planned += expectedParts(co.newPartIndex, co.afterMinutes); actual += pa; }
        activePart = co.newPartIndex;
      }
    }
    return { planned, actual };
  }

  // Writes the whole shift's planned-vs-actual total once, when the
  // supervisor presses "Finalize & End Session" — the "total expected parts
  // of that shift" figure, saved once rather than re-derived from
  // productionRecords every time it's needed.
  async function saveShiftSummary(lineId: string) {
    if (!selectedLine) return;
    const { planned, actual } = computeShiftTotals();
    const prodDate = productionDate ?? productionDayKeyFor(Date.now());
    const summaryId = `${lineId}_${prodDate}_${selectedShift}`;
    // Part-level planned totals for this same production date + shift,
    // grouped by part name (see partTargetSummary above) — computed once
    // here and stored alongside the existing planned/actual totals rather
    // than re-derived from productionRecords on every read. Kept as a
    // simple { name: target } map, extending the existing doc (setDoc with
    // merge: true below) rather than replacing or duplicating any of its
    // current fields.
    const partPlannedTotals: Record<string, number> = {};
    partTargetSummary.forEach((p) => { partPlannedTotals[p.name] = p.target; });
    try {
      await setDoc(
        doc(db, 'shiftSummaries', summaryId),
        {
          lineId,
          lineName: selectedLine.lineName ?? null,
          plant: selectedLine.plant ?? plant ?? null,
          workshop: selectedLine.workshop ?? workshop ?? null,
          division: selectedLine.division ?? division ?? null,
          shift: selectedShift,
          productionDate: prodDate,
          plannedProductionTotal: planned,
          actualProductionTotal: actual,
          partPlannedTotals,
          supervisor: { name: supervisorName, code: supervisorCode, uid: user?.uid ?? null },
          finalizedAt: serverTimestamp(),
        },
        { merge: true }
      );
    } catch (e) {
      console.error('[shift summary] save failed', e);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SUBMIT ALL UNSAVED SLOTS
  //
  // Shared writer for "save whatever wasn't individually saved yet," used by
  // the manual "Finalize & End Session" button. Every slot that has data but
  // was never explicitly saved gets its own productionRecords doc, using the
  // CURRENT (possibly since-changed) OT and planned total, before the
  // session is closed.
  // ─────────────────────────────────────────────────────────────────────────────

  async function submitUnsavedSlots(lineId: string) {
    if (!selectedLine) return;
    const nowTs = Date.now();

    // Freeze any running stops as ending right now, without touching React
    // state - avoids a race with saveSlot's "is anything running" guard,
    // which reads render-scope state that wouldn't have updated yet if we
    // called setStopsBySlot and then immediately saved.
    const frozenStops: Record<number, StopEvent[]> = {};
    Object.entries(stopsBySlot).forEach(([k, arr]) => {
      frozenStops[Number(k)] = arr.map((ev) =>
        ev.running
          ? { ...ev, endAbs: nowTs, running: false, durationMinutes: Math.max(0, Math.round(((nowTs - ev.startAbs) / 60000) * 100) / 100) }
          : ev
      );
    });

    function frozenStoppedMinutes(slotIndex: number): number {
      const arr = frozenStops[slotIndex] ?? [];
      let ms = 0;
      arr.forEach((ev) => {
        if (ev.endAbs !== undefined) ms += Math.max(0, ev.endAbs - ev.startAbs);
      });
      return Math.max(0, Math.round((ms / 60000) * 100) / 100);
    }
    function frozenSegmentMinutes(slotIndex: number, segMin: number, otherMin: number): number {
      const total = frozenStoppedMinutes(slotIndex);
      const totalSeg = segMin + otherMin;
      if (totalSeg <= 0) return 0;
      return Math.max(0, Math.round(total * (segMin / totalSeg) * 100) / 100);
    }
    // Expected/planned parts = cycle time × the slot's FULL designed time
    // (including whatever OT is set right now), never the stop-reduced time.
    // Planned production is a target — it shouldn't shrink just because the
    // line was down; only ACTUAL output (producedThisSlot) reflects real
    // stops.
    function frozenExpected(partIdx: number, minutes: number): number {
      const cycle = selectedLine?.parts?.[partIdx]?.cycleTimeSeconds ?? 0;
      if (!cycle || minutes <= 0) return 0;
      return Math.floor((minutes * 60) / cycle);
    }
    const base = {
      shift: selectedShift,
      plant: selectedLine.plant ?? plant ?? null,
      workshop: selectedLine.workshop ?? workshop ?? null,
      division: selectedLine.division ?? division ?? null,
      lineId,
      lineName: selectedLine.lineName ?? null,
      operators: operators.map((o) => ({ name: o.name, code: o.code })),
      supervisor: { name: supervisorName, code: supervisorCode, uid: user?.uid ?? null },
      productionDate: productionDate ?? productionDayKeyFor(nowTs),
      createdAt: serverTimestamp(),
    };

    // BUG FIX: previously every non-changeover slot in this loop used
    // `selectedPartIndex` directly — the part the session STARTED with —
    // so any slot after a changeover got saved under the wrong part. Track
    // the active part forward through the loop instead, the same way the
    // on-screen cards and activePartIndexBySlot already do.
    let activePart = selectedPartIndex;

    for (const s of slots) {
      if (savedSlotIndices.has(s.index)) continue;
      if (deletedSlotIndices.has(s.index)) continue; // deleted card — no record, no target
      const co = changeovers[s.index] ?? null;
      const stopEventsArr = (frozenStops[s.index] ?? []).map((se) => ({
        reason: se.reason, startAbs: se.startAbs, endAbs: se.endAbs ?? null, durationMinutes: se.durationMinutes ?? null,
      }));

      if (!co) {
        // Each card is independent — the operator enters exactly what was
        // produced in this slot, nothing more.
        const produced = producedBySlot[s.index];
        if (produced == null) continue; // nothing entered for this slot - skip
        const stopped = frozenStoppedMinutes(s.index);
        const productive = Math.max(0, s.productiveMinutes - stopped);
        const expPartsAuto = frozenExpected(activePart, s.productiveMinutes);
        const lossPartsAuto = Math.max(0, expPartsAuto - produced);
        const lossReasonAuto = lossReasonBySlot[String(s.index)] ?? null;
        await addDoc(collection(db, 'productionRecords'), {
          ...base,
          partName: selectedLine.parts?.[activePart]?.name ?? null,
          cycleTimeSeconds: selectedLine.parts?.[activePart]?.cycleTimeSeconds ?? null,
          slotIndex: s.index, slotLabel: s.label,
          slotStartMinutesAbs: s.startMinutesAbs, slotEndMinutesAbs: s.endMinutesAbs,
          slotDurationMinutes: s.durationMinutes, productiveMinutes: productive,
          expectedParts: expPartsAuto,
          producedThisSlot: produced,
          lossParts: lossPartsAuto,
          lossTimeMinutes: lossTimeMinutes(activePart, lossPartsAuto),
          lossReasonCode: lossReasonAuto?.code ?? null,
          lossReasonLabel: lossReasonAuto?.label ?? null,
          lossReasonNote: lossReasonAuto?.note ?? null,
          rejections: rejectionsBySlot[s.index] ?? 0,
          stopEvents: stopEventsArr,
        });
      } else {
        // Changeover — two fully independent records, each with its own
        // produced value as entered (no baseline, no subtraction).
        const stopBefore = frozenSegmentMinutes(s.index, co.beforeMinutes, co.afterMinutes);
        const stopAfter = frozenSegmentMinutes(s.index, co.afterMinutes, co.beforeMinutes);
        const prodBefore = Math.max(0, co.beforeMinutes - stopBefore);
        const prodAfter = Math.max(0, co.afterMinutes - stopAfter);

        const pb = producedSegment[`${s.index}:before`];
        if (pb != null) {
          const expBeforeAuto = frozenExpected(co.oldPartIndex, co.beforeMinutes);
          const lossPartsBeforeAuto = Math.max(0, expBeforeAuto - pb);
          const lossReasonBeforeAuto = lossReasonBySlot[`${s.index}:before`] ?? null;
          await addDoc(collection(db, 'productionRecords'), {
            ...base,
            partName: selectedLine.parts?.[co.oldPartIndex]?.name ?? null,
            cycleTimeSeconds: selectedLine.parts?.[co.oldPartIndex]?.cycleTimeSeconds ?? null,
            slotIndex: s.index,
            slotLabel: `${formatAbsMinutesToAmPm(s.startMinutesAbs)} - ${formatAbsMinutesToAmPm(co.atAbs)} — ${selectedLine.parts?.[co.oldPartIndex]?.name ?? 'Part'}`,
            slotStartMinutesAbs: s.startMinutesAbs, slotEndMinutesAbs: co.atAbs,
            slotDurationMinutes: co.beforeMinutes, productiveMinutes: prodBefore,
            expectedParts: expBeforeAuto,
            producedThisSlot: pb,
            lossParts: lossPartsBeforeAuto,
            lossTimeMinutes: lossTimeMinutes(co.oldPartIndex, lossPartsBeforeAuto),
            lossReasonCode: lossReasonBeforeAuto?.code ?? null,
            lossReasonLabel: lossReasonBeforeAuto?.label ?? null,
            lossReasonNote: lossReasonBeforeAuto?.note ?? null,
            rejections: rejectionsBySlot[`${s.index}:before`] ?? 0, stopEvents: stopEventsArr,
            changeoverInfo: co, partSegment: 'before',
          });
        }
        const pa = producedSegment[`${s.index}:after`];
        if (pa != null) {
          const expAfterAuto = frozenExpected(co.newPartIndex, co.afterMinutes);
          const lossPartsAfterAuto = Math.max(0, expAfterAuto - pa);
          const lossReasonAfterAuto = lossReasonBySlot[`${s.index}:after`] ?? null;
          await addDoc(collection(db, 'productionRecords'), {
            ...base,
            partName: selectedLine.parts?.[co.newPartIndex]?.name ?? null,
            cycleTimeSeconds: selectedLine.parts?.[co.newPartIndex]?.cycleTimeSeconds ?? null,
            slotIndex: s.index,
            slotLabel: `${formatAbsMinutesToAmPm(co.atAbs)} - ${formatAbsMinutesToAmPm(s.endMinutesAbs)} — ${selectedLine.parts?.[co.newPartIndex]?.name ?? 'Part'}`,
            slotStartMinutesAbs: co.atAbs, slotEndMinutesAbs: s.endMinutesAbs,
            slotDurationMinutes: co.afterMinutes, productiveMinutes: prodAfter,
            expectedParts: expAfterAuto,
            producedThisSlot: pa,
            lossParts: lossPartsAfterAuto,
            lossTimeMinutes: lossTimeMinutes(co.newPartIndex, lossPartsAfterAuto),
            lossReasonCode: lossReasonAfterAuto?.code ?? null,
            lossReasonLabel: lossReasonAfterAuto?.label ?? null,
            lossReasonNote: lossReasonAfterAuto?.note ?? null,
            rejections: rejectionsBySlot[`${s.index}:after`] ?? 0, stopEvents: stopEventsArr,
            changeoverInfo: co, partSegment: 'after',
          });
        }
        activePart = co.newPartIndex;
      }
    }

    // Clear any active maintenance breakdown docs for this line, since the
    // session (and any running stop) is being closed. Each running
    // maintenance stop owns its own lineBreakdowns doc (breakdownDocId), so
    // close each one individually rather than a single doc keyed by lineId.
    const runningMaintenanceDocIds = Object.values(stopsBySlot)
      .flat()
      .filter((e) => e.running && e.reason === 'maintenance' && e.breakdownDocId)
      .map((e) => e.breakdownDocId as string);
    for (const docId of runningMaintenanceDocIds) {
      await updateDoc(doc(db, 'lineBreakdowns', docId), {
        active: false,
        resolvedAt: serverTimestamp(),
        fixedBy: {
          uid: user?.uid ?? null,
          name: `Finalized by ${supervisorName || 'supervisor'}`,
        },
      }).catch((e) => console.error('[submitUnsavedSlots] failed to clear breakdown flag:', e.code, e.message));
    }
  }

  const handleFinalizeSession = () => {
    console.log('[handleFinalizeSession] START — about to show the confirm dialog');
    console.log('[handleFinalizeSession] state check', { sessionLineId, selectedLineId, platform: Platform.OS });

    // Same body that used to live only inside Alert.alert's "Finalize & End"
    // button onPress — extracted so both the web and native confirm paths
    // call the exact same logic instead of duplicating it.
    const proceedWithFinalize = async () => {
      console.log('[handleFinalizeSession] CONFIRM (Finalize & End) CALLBACK FIRED');
      try {
        const docId = sessionLineId ?? selectedLineId;
        console.log('[handleFinalizeSession] resolved docId', { docId, sessionLineId, selectedLineId });
        if (docId) {
          console.log('[handleFinalizeSession] calling submitUnsavedSlots(docId)…');
          await submitUnsavedSlots(docId);
          console.log('[handleFinalizeSession] submitUnsavedSlots resolved');

          console.log('[handleFinalizeSession] calling saveShiftSummary(docId)…');
          await saveShiftSummary(docId);
          console.log('[handleFinalizeSession] saveShiftSummary resolved');

          console.log('[handleFinalizeSession] calling deleteDoc(activeSessions/', docId, ')…');
          await deleteDoc(doc(db, 'activeSessions', docId));
          console.log('[handleFinalizeSession] deleteDoc resolved');
        } else {
          console.log('[handleFinalizeSession] SKIPPED Firestore writes — docId is falsy (no active session line resolved)');
        }
        console.log('[handleFinalizeSession] calling loadActiveSessions()…');
        await loadActiveSessions();
        console.log('[handleFinalizeSession] loadActiveSessions resolved');
      } catch (e) {
        console.error('[handleFinalizeSession] EXCEPTION inside confirm callback', e);
        if (Platform.OS === 'web') {
          window.alert(String(e));
        } else {
          Alert.alert('Error', String(e));
        }
      }
      console.log('[handleFinalizeSession] calling goBackToProduction()');
      goBackToProduction();
      console.log('[handleFinalizeSession] END — confirm callback completed');
    };

    try {
      // ROOT CAUSE: react-native-web's Alert.alert has no real native modal
      // to back it — it does not reliably wire up onPress for a multi-button
      // (Cancel/Confirm) dialog. The dialog call itself doesn't throw (hence
      // "no console errors"), it just never invokes either button's onPress
      // on web, so all of this handler's actual work — which lived entirely
      // inside the "Finalize & End" button's onPress — never ran. Android
      // is unaffected because it uses the real native Alert, which does
      // support multi-button callbacks.
      if (Platform.OS === 'web') {
        const confirmed = window.confirm(
          'Finalize & End Session\n\nThis will save any unsaved slots, record the final shift plan and OT, and remove the active session for this line. This action cannot be undone.'
        );
        console.log('[handleFinalizeSession] window.confirm result (web)', confirmed);
        if (!confirmed) {
          console.log('[handleFinalizeSession] Cancel pressed (web)');
          return;
        }
        proceedWithFinalize();
      } else {
        Alert.alert(
          'Finalize & End Session',
          'This will save any unsaved slots, record the final shift plan and OT, and remove the active session for this line. This action cannot be undone.',
          [
            { text: 'Cancel', style: 'cancel', onPress: () => console.log('[handleFinalizeSession] Cancel pressed') },
            { text: 'Finalize & End', style: 'destructive', onPress: proceedWithFinalize },
          ]
        );
        console.log('[handleFinalizeSession] Alert.alert(...) call returned');
      }
    } catch (e) {
      console.error('[handleFinalizeSession] EXCEPTION setting up the confirm dialog', e);
      if (Platform.OS === 'web') {
        window.alert(String(e));
      } else {
        Alert.alert('Error', String(e));
      }
    }
  };

  // NOTE: automatic submission at the 6:30 AM production-day cutover has
  // been removed. Sessions now only close via the supervisor explicitly
  // pressing "Finalize & End Session." productionDate/productionDayKeyFor
  // (above) are unrelated and kept — they only define which calendar day a
  // shift's records are bucketed under, not any auto-submit behavior.


  // ─────────────────────────────────────────────────────────────────────────────
  // OPERATOR HELPERS
  // ─────────────────────────────────────────────────────────────────────────────

  const addOperator = () => setOperators((p) => [...p, { id: `op-${Date.now()}-${p.length}`, name: '', code: '' }]);
  const removeOperator = (id: string) => setOperators((p) => p.length === 1 ? p : p.filter((o) => o.id !== id));
  const updateOperator = (id: string, field: 'name' | 'code', value: string) =>
    setOperators((p) => p.map((o) => o.id === id ? { ...o, [field]: value } : o));

  // ─────────────────────────────────────────────────────────────────────────────
  // CHANGEOVER
  // ─────────────────────────────────────────────────────────────────────────────

  const openAddChangeover = () => {
    if (!selectedLine?.parts?.length) { Alert.alert('No parts', 'Select a line with parts.'); return; }
    setChangeModalNewPartIndex(null);
    setChangeModalVisible(true);
  };

  const confirmChangeover = () => {
    console.log('[confirmChangeover] START');
    try {
      console.log('[confirmChangeover] state check', {
        changeModalNewPartIndex,
        selectedShift,
        selectedLineId,
        selectedLine: selectedLine ? { id: selectedLine.id, lineName: selectedLine.lineName, partsCount: selectedLine.parts?.length ?? 0 } : null,
        visibleSlotsCount: visibleSlots.length,
      });

      if (changeModalNewPartIndex == null) {
        console.log('[confirmChangeover] EARLY RETURN — no part selected, changeModalNewPartIndex is null');
        Alert.alert('Pick part', 'Select the new part first.');
        return;
      }

      // 1. Read the current local time, 2. convert it to the shift's absolute
      // minutes (Shift B runs past midnight, so times after midnight but
      // before noon are shifted +1440 to stay in the same continuously
      // increasing minute frame the slots themselves use).
      const now = new Date();
      let abs = now.getHours() * 60 + now.getMinutes();
      if (selectedShift === 'B' && now.getHours() < 12) abs += 1440;
      console.log('[confirmChangeover] computed abs time', { now: now.toString(), hours: now.getHours(), minutes: now.getMinutes(), abs });

      // 3. Find the slot that actually contains this moment — no fallback.
      // Previously `?? slots[0]` meant that whenever the current time fell
      // outside every slot's window (before the shift started, after it — or
      // its OT — ended, etc.) the changeover silently landed on the FIRST
      // slot instead of the real current one. Require a genuine match; if
      // there isn't one, tell the supervisor instead of guessing.
      console.log('[confirmChangeover] visibleSlots windows', visibleSlots.map((s) => ({ index: s.index, label: s.label, startMinutesAbs: s.startMinutesAbs, endMinutesAbs: s.endMinutesAbs })));
      const slot = visibleSlots.find((s) => abs >= s.startMinutesAbs && abs < s.endMinutesAbs);
      console.log('[confirmChangeover] visibleSlots.find result', slot ? { index: slot.index, label: slot.label } : undefined);
      if (!slot) {
        console.log('[confirmChangeover] EARLY RETURN — no slot contains current time', { abs });
        Alert.alert(
          'Outside shift hours',
          'The current time does not fall within any slot of this shift, so a changeover cannot be recorded right now.'
        );
        return;
      }

      const beforeMinutes = Math.max(0, abs - slot.startMinutesAbs);
      const afterMinutes = Math.max(0, slot.endMinutesAbs - abs);
      console.log('[confirmChangeover] segment minutes', { beforeMinutes, afterMinutes });
      // BUG FIX: this used to be hardcoded to `selectedPartIndex` — the part
      // the session STARTED with — so every changeover after the first one
      // incorrectly treated the original part as "old," reverting the active
      // part instead of continuing from wherever it actually was. Use the
      // real active part for this slot instead, which already accounts for
      // every earlier changeover (see activePartIndexBySlot below).
      const oldIdx = activePartIndexBySlot[slot.index] ?? selectedPartIndex;
      const oldCycle = selectedLine?.parts?.[oldIdx]?.cycleTimeSeconds ?? 0;
      const newCycle = selectedLine?.parts?.[changeModalNewPartIndex]?.cycleTimeSeconds ?? 0;
      console.log('[confirmChangeover] part resolution', { oldIdx, oldCycle, newIdx: changeModalNewPartIndex, newCycle });
      const info: ChangeoverInfo = {
        slotIndex: slot.index, atAbs: abs, oldPartIndex: oldIdx, newPartIndex: changeModalNewPartIndex,
        beforeMinutes, afterMinutes,
        expectedBefore: oldCycle > 0 ? Math.floor((beforeMinutes * 60) / oldCycle) : 0,
        expectedAfter: newCycle > 0 ? Math.floor((afterMinutes * 60) / newCycle) : 0,
      };
      console.log('[confirmChangeover] built ChangeoverInfo', info);
      const nextChangeovers = { ...changeovers, [slot.index]: info };
      console.log('[confirmChangeover] calling setChangeovers');
      setChangeovers(nextChangeovers);
      console.log('[confirmChangeover] calling setProducedSegment (clear before/after)');
      setProducedSegment((p) => ({ ...p, [`${slot.index}:before`]: null, [`${slot.index}:after`]: null }));
      console.log('[confirmChangeover] calling setChangeModalVisible(false)');
      setChangeModalVisible(false);
      // Persist immediately
      console.log('[confirmChangeover] scheduling persistSession() via setTimeout');
      setTimeout(() => {
        console.log('[confirmChangeover] persistSession() firing now (from setTimeout)');
        persistSession();
      }, 100);
      console.log('[confirmChangeover] about to show success Alert.alert — if this is the last log you see, Alert.alert itself is where web execution appears to stop (it does not render a dialog on web, so its callback, if any, never fires — note this particular alert has NO callback, so the changeover IS already fully applied by this point regardless)');
      Alert.alert('Changeover recorded', `Recorded at ${formatAbsMinutesToAmPm(abs)} for ${slot.label}`);
      console.log('[confirmChangeover] END — completed successfully');
    } catch (e) {
      console.error('[confirmChangeover] EXCEPTION', e);
      if (Platform.OS === 'web') {
        window.alert(String(e));
      } else {
        Alert.alert('Error', String(e));
      }
    }
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // LINE STOP / RESUME
  // ─────────────────────────────────────────────────────────────────────────────

  const openStopModalForSlot = (slotIndex: number) => {
    setStopModalSlotIndex(slotIndex);
    setStopModalReason(null);
    setStopModalVisible(true);
  };

  const startStopForSlot = (slotIndex: number, reason: string) => {
    const ts = Date.now();
    const newStop: StopEvent = { reason, startAbs: ts, running: true };
    const nextStops = { ...stopsBySlot, [slotIndex]: [...(stopsBySlot[slotIndex] ?? []), newStop] };
    setStopsBySlot(nextStops);
    setStopModalVisible(false);

    // Persist stopped flag immediately (will include running stop)
    setTimeout(() => persistSession(nextStops, true), 100);

    if (reason === 'maintenance') {
      const breakdownLineId = selectedLine?.id ?? sessionLineId ?? selectedLineId;
      if (breakdownLineId) {
        const slot = slots.find((s) => s.index === slotIndex);
        // addDoc (not setDoc keyed by lineId) — every breakdown gets its own
        // document, so if this line breaks down again later the earlier
        // occurrence stays in Firestore instead of being overwritten. The
        // Technician dashboard's Active tab then shows every currently-open
        // breakdown, and the Fixed tab keeps the full history for the line.
        addDoc(collection(db, 'lineBreakdowns'), {
          lineId: breakdownLineId,
          lineName: selectedLine?.lineName ?? null,
          plant: selectedLine?.plant ?? plant ?? null,
          workshop: selectedLine?.workshop ?? workshop ?? null,
          division: selectedLine?.division ?? division ?? null,
          slotLabel: slot?.label ?? null,
          active: true,
          reportedBy: { uid: user?.uid ?? null, name: supervisorName || user?.name || null },
          startedAt: serverTimestamp(),
          resolvedAt: null,
          fixedBy: null,
        }).then((docRef) => {
          // Patch the new doc's id onto the matching stop event (matched by
          // startAbs, since a slot could in principle log more than one stop
          // over time) so endStopForSlot later closes exactly this record.
          setStopsBySlot((prev) => {
            const arr = prev[slotIndex] ?? [];
            const patched = arr.map((e) => (e.startAbs === ts && e.running ? { ...e, breakdownDocId: docRef.id } : e));
            return { ...prev, [slotIndex]: patched };
          });
        }).catch((e) => {
          console.error('[breakdown] failed to mark line as broken down:', e.code, e.message);
          Alert.alert(
            'Warning',
            'The stop was recorded, but the Technician dashboard could not be notified (breakdown flag failed to save). Check your connection.'
          );
        });
      }
    }
  };

    const endStopForSlot = (slotIndex: number) => {
    const ts = Date.now();

    // Read the running stop's reason NOW from current state — synchronously,
    // before any setState call. setState callbacks run asynchronously so any
    // variable mutated inside them is still the old value when code below runs.
    const currentSlotStops = stopsBySlot[slotIndex] ?? [];
    const runningStop = currentSlotStops.find((e) => e.running) ?? null;
    if (!runningStop) return; // nothing running, bail early

    const endedReason = runningStop.reason;

    // Build the updated stops map synchronously from current state.
    const updatedArr = currentSlotStops.map((e) =>
      e.running
        ? { ...e, endAbs: ts, durationMinutes: Math.max(0, Math.round(((ts - e.startAbs) / 60000) * 100) / 100), running: false }
        : e
    );
    const nextStops: Record<number, StopEvent[]> = { ...stopsBySlot, [slotIndex]: updatedArr };

    // Apply to state and persist.
    setStopsBySlot(nextStops);
    const remaining = Object.values(nextStops).some((arr) => arr.some((s) => s.running));
    setTimeout(() => persistSession(nextStops, remaining), 150);

    // Clear the breakdown doc so both dashboards update in real time.
    // Each stop closes its OWN lineBreakdowns doc (via the id stashed on the
    // stop event when it started) rather than a doc keyed by lineId, so this
    // only resolves the breakdown this stop actually created.
    if (endedReason === 'maintenance') {
      const closeBreakdownDoc = (docId: string) => {
        updateDoc(doc(db, 'lineBreakdowns', docId), {
          active: false,
          resolvedAt: serverTimestamp(),
          resolvedBy: { uid: user?.uid ?? null, name: supervisorName || user?.name || null },
        }).catch((e: any) => {
          console.error('[breakdown] failed to clear breakdown flag:', e.code, e.message);
          Alert.alert(
            'Warning',
            'Line resumed locally, but the Technician dashboard could not be updated. Check your connection and tap Resume again if the breakdown still shows as active.'
          );
        });
      };

      if (runningStop.breakdownDocId) {
        closeBreakdownDoc(runningStop.breakdownDocId);
      } else {
        // The addDoc that creates the breakdown record (in startStopForSlot)
        // may still be in flight on a slow connection. Give it a moment to
        // land in state and retry once before warning the technician side
        // might not have been notified.
        setTimeout(() => {
          const latest = (stopsBySlotRef.current[slotIndex] ?? []).find((e) => e.startAbs === runningStop.startAbs);
          if (latest?.breakdownDocId) {
            closeBreakdownDoc(latest.breakdownDocId);
          } else {
            console.error('[breakdown] no breakdownDocId available to close for slot', slotIndex);
            Alert.alert(
              'Warning',
              'Line resumed locally, but the Technician dashboard could not be updated. Check your connection — the breakdown may still show as active there.'
            );
          }
        }, 1500);
      }
    }
  };

  const slotHasRunningStop = (slotIndex: number) => (stopsBySlot[slotIndex] ?? []).some((s) => s.running);

  // ─────────────────────────────────────────────────────────────────────────────
  // CALCULATIONS
  // ─────────────────────────────────────────────────────────────────────────────

  function totalStoppedMinutesForSlot(slotIndex: number) {
    const arr = stopsBySlot[slotIndex] ?? [];
    let ms = 0;
    arr.forEach((ev) => {
      const end = ev.endAbs ?? (ev.running ? nowMs : undefined);
      if (end !== undefined) ms += Math.max(0, end - ev.startAbs);
    });
    return Math.max(0, Math.round((ms / 60000) * 100) / 100);
  }

  function stoppedMinutesForSegment(slotIndex: number, segMin: number, otherMin: number) {
    const total = totalStoppedMinutesForSlot(slotIndex);
    const totalSeg = segMin + otherMin;
    if (totalSeg <= 0) return 0;
    return Math.max(0, Math.round(total * (segMin / totalSeg) * 100) / 100);
  }

  // Expected/planned parts = cycle time × the slot's FULL designed time
  // (including OT), never the stop-reduced time — see frozenExpected above
  // for why. Callers pass s.productiveMinutes / co.beforeMinutes /
  // co.afterMinutes (raw), not the stop-reduced `productive`/`prodBefore`/
  // `prodAfter` variables.
  function expectedParts(partIdx: number, minutes: number) {
    const cycle = selectedLine?.parts?.[partIdx]?.cycleTimeSeconds ?? 0;
    if (!cycle || minutes <= 0) return 0;
    return Math.floor((minutes * 60) / cycle);
  }

  // Time-equivalent of the parts that could not be made, i.e. how many
  // minutes of run time those lossParts represent at this part's cycle time.
  // Distinct from raw stop-event downtime — this reflects the production-time
  // impact of the shortfall itself (loss can exceed logged downtime when the
  // gap isn't fully explained by a stop, e.g. slow running or quality loss).
  function lossTimeMinutes(partIdx: number, lossParts: number) {
    const cycle = selectedLine?.parts?.[partIdx]?.cycleTimeSeconds ?? 0;
    if (!cycle || lossParts <= 0) return 0;
    return Math.round(((lossParts * cycle) / 60) * 100) / 100;
  }

  function formatElapsed(startMs: number) {
    const s = Math.max(0, Math.floor((nowMs - startMs) / 1000));
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  const activePartIndexBySlot = useMemo(() => {
    const map: Record<number, number> = {};
    let active = selectedPartIndex;
    for (const s of slots) {
      map[s.index] = active;
      const co = changeovers[s.index];
      if (co) active = co.newPartIndex;
    }
    return map;
  }, [slots, selectedPartIndex, changeovers]);

  // The part actually in effect right now — the active part carries forward
  // through every slot after a changeover until another one happens, so
  // whatever it resolves to at the LAST *visible* slot is the current one
  // (used for header display, since selectedPartIndex itself never changes
  // after the session starts). Uses visibleSlots, not slots, so deleting the
  // last hourly card doesn't leave this pointing at a card that's gone.
  const currentActivePartIndex = useMemo(() => {
    if (!visibleSlots.length) return selectedPartIndex;
    return activePartIndexBySlot[visibleSlots[visibleSlots.length - 1].index] ?? selectedPartIndex;
  }, [visibleSlots, activePartIndexBySlot, selectedPartIndex]);

  // ─────────────────────────────────────────────────────────────────────────────
  // SAVE RECORDS
  // ─────────────────────────────────────────────────────────────────────────────

  // BUG FIX: stamp the selected line's own plant/workshop/division (its
  // productionLines document) rather than the transient filter chips used to
  // find the line. A supervisor who selects a line without first narrowing by
  // Plant/Workshop/Division was getting null location fields on every slot,
  // which then silently failed to match Generate Report's filters.
  const buildBaseDoc = () => ({
    shift: selectedShift, plant: selectedLine?.plant ?? plant ?? null, workshop: selectedLine?.workshop ?? workshop ?? null,
    division: selectedLine?.division ?? division ?? null, lineId: selectedLineId, lineName: selectedLine?.lineName ?? null,
    operators: operators.map((o) => ({ name: o.name, code: o.code })),
    supervisor: { name: supervisorName, code: supervisorCode, uid: user?.uid ?? null },
    productionDate: productionDate ?? productionDayKeyFor(Date.now()),
    createdAt: serverTimestamp(),
  });

  function openLossModal(key: string, lossAmount: number) {
    const existing = lossReasonBySlot[key];
    setLossModalKey(key);
    setLossModalAmount(lossAmount);
    setLossModalCode(existing?.code ?? null);
    setLossModalNote(existing?.note ?? '');
    setLossModalVisible(true);
  }

  function confirmLossReason() {
    if (!lossModalKey || !lossModalCode) {
      Alert.alert('Select reason', 'Choose a reason for the shortfall first.');
      return;
    }
    const meta = LOSS_REASONS.find((r) => r.code === lossModalCode);
    const key = lossModalKey;
    setLossReasonBySlot((p) => ({
      ...p,
      [key]: { code: lossModalCode, label: meta?.label ?? lossModalCode, note: lossModalCode === 'K' ? lossModalNote.trim() : undefined },
    }));
    setLossModalVisible(false);
    setLossModalKey(null);
    const resume = pendingAfterLossRef.current;
    pendingAfterLossRef.current = null;
    resume?.();
  }

  // Deletes an hourly card. Blocked once the slot has already been
  // individually saved to Firestore (savedSlotIndices) — that record would
  // still exist in productionRecords, so silently un-planning it here would
  // leave "actual" production without a matching "planned" target for that
  // hour. For a not-yet-saved slot: adds it to deletedSlotIndices (which
  // visibleSlots, shiftPlannedTotal, and partTargetSummary all key off of,
  // so the shift's planned total drops by exactly that slot's target) and
  // clears any data the operator had already entered for it, so nothing
  // stale gets picked up later by Finalize.
  function handleDeleteSlot(slotIndex: number) {
    console.log('[handleDeleteSlot] START', { slotIndex, platform: Platform.OS });
    try {
      console.log('[handleDeleteSlot] savedSlotIndices check', { hasSlot: savedSlotIndices.has(slotIndex), savedSlotIndices: Array.from(savedSlotIndices) });
      if (savedSlotIndices.has(slotIndex)) {
        console.log('[handleDeleteSlot] EARLY RETURN — slot already saved, showing "Already saved" alert');
        if (Platform.OS === 'web') {
          window.alert("This hourly card has already been saved and can't be deleted. If it needs correcting, edit the entry directly instead.");
        } else {
          Alert.alert(
            'Already saved',
            'This hourly card has already been saved and can\'t be deleted. If it needs correcting, edit the entry directly instead.'
          );
        }
        return;
      }

      const slot = slots.find((s) => s.index === slotIndex);
      console.log('[handleDeleteSlot] slots.find result', slot ? { index: slot.index, label: slot.label } : undefined);
      console.log('[handleDeleteSlot] about to show the delete confirm dialog');

      // Same body that used to live only inside Alert.alert's "Delete"
      // button onPress — extracted so both the web and native confirm paths
      // call the exact same logic instead of duplicating it.
      const proceedWithDelete = () => {
        console.log('[handleDeleteSlot] CONFIRM (Delete) CALLBACK FIRED', { slotIndex });
        try {
          console.log('[handleDeleteSlot] calling setDeletedSlotIndices');
          setDeletedSlotIndices((prev) => {
            const next = new Set(prev);
            next.add(slotIndex);
            return next;
          });
          console.log('[handleDeleteSlot] calling setProducedBySlot (clear)');
          setProducedBySlot((p) => { const c = { ...p }; delete c[slotIndex]; return c; });
          console.log('[handleDeleteSlot] calling setRejectionsBySlot (clear)');
          setRejectionsBySlot((p) => {
            const c = { ...p };
            delete c[String(slotIndex)];
            delete c[`${slotIndex}:before`];
            delete c[`${slotIndex}:after`];
            return c;
          });
          console.log('[handleDeleteSlot] calling setStopsBySlot (clear)');
          setStopsBySlot((p) => { const c = { ...p }; delete c[slotIndex]; return c; });
          console.log('[handleDeleteSlot] calling setChangeovers (clear)');
          setChangeovers((p) => { const c = { ...p }; delete c[slotIndex]; return c; });
          console.log('[handleDeleteSlot] calling setProducedSegment (clear)');
          setProducedSegment((p) => {
            const c = { ...p };
            delete c[`${slotIndex}:before`];
            delete c[`${slotIndex}:after`];
            return c;
          });
          console.log('[handleDeleteSlot] calling setLossReasonBySlot (clear)');
          setLossReasonBySlot((p) => {
            const c = { ...p };
            delete c[String(slotIndex)];
            delete c[`${slotIndex}:before`];
            delete c[`${slotIndex}:after`];
            return c;
          });
          console.log('[handleDeleteSlot] scheduling persistSession() via setTimeout');
          setTimeout(() => {
            console.log('[handleDeleteSlot] persistSession() firing now (from setTimeout)');
            persistSession();
          }, 100);
          console.log('[handleDeleteSlot] END — confirm callback completed');
        } catch (e) {
          console.error('[handleDeleteSlot] EXCEPTION inside confirm callback', e);
          if (Platform.OS === 'web') {
            window.alert(String(e));
          } else {
            Alert.alert('Error', String(e));
          }
        }
      };

      // ROOT CAUSE: react-native-web's Alert.alert has no real native modal
      // to back it — it does not reliably wire up onPress for a multi-button
      // (Cancel/Delete) dialog. The call itself doesn't throw (hence "no
      // console errors"), it just never invokes either button's onPress on
      // web, so this handler's actual delete logic — which lived entirely
      // inside the "Delete" button's onPress — never ran. Android is
      // unaffected because it uses the real native Alert, which does
      // support multi-button callbacks.
      if (Platform.OS === 'web') {
        const confirmed = window.confirm(
          `Delete this hour?\n\nThis removes the ${slot?.label ?? 'selected'} card and reduces the shift's planned production by its target. This cannot be undone.`
        );
        console.log('[handleDeleteSlot] window.confirm result (web)', confirmed);
        if (!confirmed) {
          console.log('[handleDeleteSlot] Cancel pressed (web)');
          return;
        }
        proceedWithDelete();
      } else {
        Alert.alert(
          'Delete this hour?',
          `This removes the ${slot?.label ?? 'selected'} card and reduces the shift's planned production by its target. This cannot be undone.`,
          [
            { text: 'Cancel', style: 'cancel', onPress: () => console.log('[handleDeleteSlot] Cancel pressed') },
            { text: 'Delete', style: 'destructive', onPress: proceedWithDelete },
          ]
        );
        console.log('[handleDeleteSlot] Alert.alert(...) call returned');
      }
    } catch (e) {
      console.error('[handleDeleteSlot] EXCEPTION', e);
      if (Platform.OS === 'web') {
        window.alert(String(e));
      } else {
        Alert.alert('Error', String(e));
      }
    }
  }

  // Gate on any un-explained shortfall before actually saving. A normal slot
  // has at most one shortfall to explain; a changeover slot can have one on
  // each side (before/after the part switch) — the modal pops once per
  // missing reason, resuming this same check afterward until everything is
  // either on-target or has a reason attached.
  function attemptSave(slot: Slot) {
    const co = changeovers[slot.index] ?? null;
    if (!co) {
      const produced = producedBySlot[slot.index];
      if (produced == null) { Alert.alert('Missing', 'Enter produced for this slot.'); return; }
      const expParts = expectedParts(selectedPartIndex, slot.productiveMinutes);
      const loss = Math.max(0, expParts - produced);
      const key = String(slot.index);
      if (loss > 0 && !lossReasonBySlot[key]) {
        pendingAfterLossRef.current = () => attemptSave(slot);
        openLossModal(key, loss);
        return;
      }
    } else {
      const pb = producedSegment[`${slot.index}:before`];
      const pa = producedSegment[`${slot.index}:after`];
      if (pb == null) { Alert.alert('Missing', 'Enter BEFORE segment produced.'); return; }
      if (pa == null) { Alert.alert('Missing', 'Enter AFTER segment produced.'); return; }
      const expBefore = expectedParts(co.oldPartIndex, co.beforeMinutes);
      const expAfter = expectedParts(co.newPartIndex, co.afterMinutes);
      const lossBefore = Math.max(0, expBefore - pb);
      const lossAfter = Math.max(0, expAfter - pa);
      const keyBefore = `${slot.index}:before`;
      const keyAfter = `${slot.index}:after`;
      if (lossBefore > 0 && !lossReasonBySlot[keyBefore]) {
        pendingAfterLossRef.current = () => attemptSave(slot);
        openLossModal(keyBefore, lossBefore);
        return;
      }
      if (lossAfter > 0 && !lossReasonBySlot[keyAfter]) {
        pendingAfterLossRef.current = () => attemptSave(slot);
        openLossModal(keyAfter, lossAfter);
        return;
      }
    }
    saveSlot(slot);
  }

  const saveSlot = async (slot: Slot) => {
    if (!selectedLine) { Alert.alert('No line', 'Line not set.'); return; }
    if (anyStopRunning) { Alert.alert('Active stop', 'Resume the line before saving.'); return; }

    const co = changeovers[slot.index] ?? null;
    setSaving(true);
    try {
      if (!co) {
        // Independent record: the operator enters exactly what was produced
        // in this slot — no counter, no baseline, no subtraction.
        const produced = producedBySlot[slot.index];
        if (produced == null) { Alert.alert('Missing', 'Enter produced for this slot.'); return; }
        // BUG FIX: this used to always use `selectedPartIndex` — the part
        // the session STARTED with — so a slot saved after a changeover was
        // recorded under the wrong part. Use the slot's real active part,
        // which already accounts for every earlier changeover.
        const activePart = activePartIndexBySlot[slot.index] ?? selectedPartIndex;
        const stopped = totalStoppedMinutesForSlot(slot.index);
        const productive = Math.max(0, slot.productiveMinutes - stopped);
        const expParts = expectedParts(activePart, slot.productiveMinutes);
        const slotLossParts = Math.max(0, expParts - produced);
        const lossReason = lossReasonBySlot[String(slot.index)] ?? null;
        await addDoc(collection(db, 'productionRecords'), {
          ...buildBaseDoc(),
          partName: selectedLine.parts?.[activePart]?.name ?? null,
          cycleTimeSeconds: selectedLine.parts?.[activePart]?.cycleTimeSeconds ?? null,
          slotIndex: slot.index, slotLabel: slot.label,
          slotStartMinutesAbs: slot.startMinutesAbs, slotEndMinutesAbs: slot.endMinutesAbs,
          slotDurationMinutes: slot.durationMinutes, productiveMinutes: productive,
          expectedParts: expParts,
          producedThisSlot: produced,
          lossParts: slotLossParts,
          // Time-equivalent of the lost parts at this part's cycle time —
          // see lossTimeMinutes() note above for why this differs from raw
          // stop-event downtime.
          lossTimeMinutes: lossTimeMinutes(activePart, slotLossParts),
          lossReasonCode: lossReason?.code ?? null,
          lossReasonLabel: lossReason?.label ?? null,
          lossReasonNote: lossReason?.note ?? null,
          rejections: rejectionsBySlot[slot.index] ?? 0,
          stopEvents: (stopsBySlot[slot.index] ?? []).map((se) => ({ reason: se.reason, startAbs: se.startAbs, endAbs: se.endAbs ?? null, durationMinutes: se.durationMinutes ?? null })),
        });
        Alert.alert('Saved', `Slot ${slot.label} saved.`);
        setSavedSlotIndices((prev) => new Set(prev).add(slot.index));
      } else {
        // Changeover: two fully independent records, each with its own
        // produced value exactly as entered.
        const pb = producedSegment[`${slot.index}:before`];
        const pa = producedSegment[`${slot.index}:after`];
        if (pb == null) { Alert.alert('Missing', 'Enter BEFORE segment produced.'); return; }
        if (pa == null) { Alert.alert('Missing', 'Enter AFTER segment produced.'); return; }
        const stopBefore = stoppedMinutesForSegment(slot.index, co.beforeMinutes, co.afterMinutes);
        const stopAfter = stoppedMinutesForSegment(slot.index, co.afterMinutes, co.beforeMinutes);
        const prodBefore = Math.max(0, co.beforeMinutes - stopBefore);
        const prodAfter = Math.max(0, co.afterMinutes - stopAfter);
        const stopEventsArr = (stopsBySlot[slot.index] ?? []).map((se) => ({ reason: se.reason, startAbs: se.startAbs, endAbs: se.endAbs ?? null, durationMinutes: se.durationMinutes ?? null }));
        const expBefore = expectedParts(co.oldPartIndex, co.beforeMinutes);
        const expAfter = expectedParts(co.newPartIndex, co.afterMinutes);
        const lossReasonBefore = lossReasonBySlot[`${slot.index}:before`] ?? null;
        const lossReasonAfter = lossReasonBySlot[`${slot.index}:after`] ?? null;
        const lossPartsBefore = Math.max(0, expBefore - pb);
        const lossPartsAfter = Math.max(0, expAfter - pa);
        await addDoc(collection(db, 'productionRecords'), {
          ...buildBaseDoc(),
          partName: selectedLine.parts?.[co.oldPartIndex]?.name ?? null,
          cycleTimeSeconds: selectedLine.parts?.[co.oldPartIndex]?.cycleTimeSeconds ?? null,
          slotIndex: slot.index,
          slotLabel: `${formatAbsMinutesToAmPm(slot.startMinutesAbs)} - ${formatAbsMinutesToAmPm(co.atAbs)} — ${selectedLine.parts?.[co.oldPartIndex]?.name ?? 'Part'}`,
          slotStartMinutesAbs: slot.startMinutesAbs, slotEndMinutesAbs: co.atAbs,
          slotDurationMinutes: co.beforeMinutes, productiveMinutes: prodBefore,
          expectedParts: expBefore,
          producedThisSlot: pb,
          lossParts: lossPartsBefore,
          lossTimeMinutes: lossTimeMinutes(co.oldPartIndex, lossPartsBefore),
          lossReasonCode: lossReasonBefore?.code ?? null,
          lossReasonLabel: lossReasonBefore?.label ?? null,
          lossReasonNote: lossReasonBefore?.note ?? null,
          rejections: rejectionsBySlot[`${slot.index}:before`] ?? 0, stopEvents: stopEventsArr,
          changeoverInfo: co, partSegment: 'before',
        });
        await addDoc(collection(db, 'productionRecords'), {
          ...buildBaseDoc(),
          partName: selectedLine.parts?.[co.newPartIndex]?.name ?? null,
          cycleTimeSeconds: selectedLine.parts?.[co.newPartIndex]?.cycleTimeSeconds ?? null,
          slotIndex: slot.index,
          slotLabel: `${formatAbsMinutesToAmPm(co.atAbs)} - ${formatAbsMinutesToAmPm(slot.endMinutesAbs)} — ${selectedLine.parts?.[co.newPartIndex]?.name ?? 'Part'}`,
          slotStartMinutesAbs: co.atAbs, slotEndMinutesAbs: slot.endMinutesAbs,
          slotDurationMinutes: co.afterMinutes, productiveMinutes: prodAfter,
          expectedParts: expAfter,
          producedThisSlot: pa,
          lossParts: lossPartsAfter,
          lossTimeMinutes: lossTimeMinutes(co.newPartIndex, lossPartsAfter),
          lossReasonCode: lossReasonAfter?.code ?? null,
          lossReasonLabel: lossReasonAfter?.label ?? null,
          lossReasonNote: lossReasonAfter?.note ?? null,
          rejections: rejectionsBySlot[`${slot.index}:after`] ?? 0, stopEvents: stopEventsArr,
          changeoverInfo: co, partSegment: 'after',
        });
        Alert.alert('Saved', `Slot ${slot.label} saved (split).`);
        setSavedSlotIndices((prev) => new Set(prev).add(slot.index));
      }
      // Persist session after save so Firestore knows the current data
      persistSession();
    } catch (err) {
      console.error('saveSlot', err);
      Alert.alert('Error', 'Could not save slot.');
    } finally {
      setSaving(false);
    }
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────────

  // ── Phase: loading ──
  if (phase === 'loading' || profileLoading || loadingLines) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.centered}>
          <ActivityIndicator color="#F2A93B" size="large" />
          <Text style={styles.muted}>Loading…</Text>
        </View>
      </SafeAreaView>
    );
  }

  // ── Phase: setup ──
  if (phase === 'setup') {
    return (
      <SafeAreaView style={styles.safeArea}>
        <CalculatorButton />
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <Pressable onPress={goBackToProduction} style={styles.backButton} hitSlop={12}>
            <Ionicons name="arrow-back" size={22} color="#8A96A3" />
            <Text style={styles.backText}>Back</Text>
          </Pressable>

          <Text style={styles.title}>Record Production</Text>
          <Text style={styles.subtitle}>Set up the session before starting</Text>

          {/* SUPERVISOR */}
          <Text style={styles.sectionLabel}>SUPERVISOR</Text>
          <View style={styles.row}>
            <View style={{ flex: 1, marginRight: 8 }}>
              <Text style={styles.label}>Name</Text>
              <TextInput style={styles.input} value={supervisorName} onChangeText={setSupervisorName} placeholder="Supervisor name" placeholderTextColor="#5C6670" />
            </View>
            <View style={{ width: 140 }}>
              <Text style={styles.label}>Emp. Code</Text>
              <TextInput style={styles.input} value={supervisorCode} onChangeText={setSupervisorCode} placeholder="Code" placeholderTextColor="#5C6670" />
            </View>
          </View>

          {/* OPERATORS */}
          <View style={{ marginTop: 16 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <Text style={styles.sectionLabel}>OPERATORS</Text>
              <Pressable onPress={addOperator} style={styles.addChangeBtn} hitSlop={8}>
                <Ionicons name="add-circle" size={18} color="#F2A93B" />
                <Text style={styles.addChangeText}>Add</Text>
              </Pressable>
            </View>
            {operators.map((op, idx) => (
              <View key={op.id} style={{ marginBottom: 10, flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.label}>Operator {idx + 1} Name</Text>
                  <TextInput style={styles.input} value={op.name} onChangeText={(t) => updateOperator(op.id, 'name', t)} placeholder="Name" placeholderTextColor="#5C6670" />
                </View>
                <View style={{ width: 130 }}>
                  <Text style={styles.label}>Code</Text>
                  <TextInput style={styles.input} value={op.code} onChangeText={(t) => updateOperator(op.id, 'code', t)} placeholder="Code" placeholderTextColor="#5C6670" />
                </View>
                {operators.length > 1 && (
                  <Pressable onPress={() => removeOperator(op.id)} hitSlop={10} style={{ paddingBottom: 12 }}>
                    <Ionicons name="trash-outline" size={20} color="#8A96A3" />
                  </Pressable>
                )}
              </View>
            ))}
          </View>

          {/* LOCATION — tap a box, pick from the dropdown that appears */}
          <Text style={[styles.sectionLabel, { marginTop: 8 }]}>LOCATION</Text>
          <PickerBox label="Plant" value={plant} placeholder="Any" onPress={() => setActiveDropdown('plant')} />
          <PickerBox label="Workshop" value={workshop} placeholder="Any" onPress={() => setActiveDropdown('workshop')} />
          {isAssemblyWorkshop(workshop) && (
            <PickerBox label="Division" value={division} placeholder="Any" onPress={() => setActiveDropdown('division')} />
          )}

          {/* LINE SELECTION */}
          {loadError ? (
            <Text style={{ color: '#F0A8A8', marginBottom: 8 }}>{loadError}</Text>
          ) : (
            <PickerBox
              label="Line"
              value={selectedLine?.lineName ?? null}
              placeholder={filteredLines.length ? 'Select a line' : 'No lines found for selected filters'}
              disabled={!filteredLines.length}
              onPress={() => setActiveDropdown('line')}
            />
          )}

          {/* PART */}
          {selectedLine?.parts?.length ? (
            <PickerBox
              label="Part / Model"
              value={selectedLine.parts[selectedPartIndex] ? `${selectedLine.parts[selectedPartIndex].name} · ${selectedLine.parts[selectedPartIndex].cycleTimeSeconds}s` : null}
              placeholder="Select a part"
              onPress={() => setActiveDropdown('part')}
            />
          ) : null}

          {/* SHIFT */}
          <Text style={[styles.sectionLabel, { marginTop: 8 }]}>SHIFT CONFIG</Text>
          <PickerBox
            label="Shift"
            value={`Shift ${selectedShift} · ${formatAbsMinutesToAmPm(selectedShift === 'A' ? SHIFT_A_START : SHIFT_B_START)} – ${formatAbsMinutesToAmPm(selectedShift === 'A' ? SHIFT_A_END : SHIFT_B_END_ABS)}`}
            placeholder="Select shift"
            onPress={() => setActiveDropdown('shift')}
          />
          <View style={{ width: 180, marginBottom: 16 }}>
            <Text style={styles.label}>OT hours (0–4)</Text>
            <TextInput style={styles.input} value={String(otHours)} onChangeText={(t) => setOtHours(Math.max(0, Math.min(4, Math.floor(Number(t) || 0))))} keyboardType="number-pad" placeholder="0" placeholderTextColor="#5C6670" />
          </View>

          {/* START BUTTON */}
          <Pressable
            style={({ pressed }) => [styles.startButton, (startingProduction || pressed) && styles.startButtonPressed]}
            onPress={handleStartProduction}
            disabled={startingProduction}
          >
            {startingProduction ? (
              <ActivityIndicator color="#14181C" />
            ) : (
              <>
                <Ionicons name="play-circle" size={22} color="#14181C" />
                <Text style={styles.startButtonText}>Start Production</Text>
              </>
            )}
          </Pressable>

          {/* CONTINUE ACTIVE SESSION — tap a card to resume instantly, skipping setup */}
          {loadingActiveSessions ? (
            <View style={{ marginTop: 18, alignItems: 'center' }}>
              <ActivityIndicator color="#8A96A3" />
            </View>
          ) : activeSessionsList.length > 0 ? (
            <View style={{ marginTop: 22 }}>
              <Text style={styles.sectionLabel}>CONTINUE ACTIVE SESSION</Text>
              {activeSessionsList.map(({ docId, data: sd }) => {
                const startedMs = (sd as any).startedAt?.toMillis ? (sd as any).startedAt.toMillis() : null;
                return (
                  <Pressable
                    key={docId}
                    onPress={() => restoreSession(sd, allLines, docId)}
                    style={styles.continueCard}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={styles.continueCardTitle}>
                        {sd.lineName ?? docId} · Shift {sd.shift}
                        {sd.lineStopped ? ' · STOPPED' : ''}
                      </Text>
                      <Text style={styles.continueCardMeta}>
                        Started {formatSessionStartedAt(startedMs)}
                        {sd.otHours > 0 ? ` · ${sd.otHours}h OT` : ''}
                      </Text>
                    </View>
                    <Ionicons name="play-circle" size={26} color="#4C9A6A" />
                  </Pressable>
                );
              })}
            </View>
          ) : null}

          <View style={{ height: 40 }} />
        </ScrollView>

        {/* ── Shared picker dropdown for Plant / Workshop / Division / Line / Part / Shift */}
        <Modal visible={activeDropdown !== null} animationType="slide" transparent onRequestClose={() => setActiveDropdown(null)}>
          <View style={styles.modalOverlay}>
            <View style={styles.modalCard}>
              <Text style={styles.modalTitle}>{activeDropdown ? DROPDOWN_TITLES[activeDropdown] : ''}</Text>
              <ScrollView contentContainerStyle={styles.modalScroll}>
                {dropdownOptions.length === 0 ? (
                  <Text style={styles.muted}>No options available</Text>
                ) : (
                  dropdownOptions.map((opt) => {
                    const isSelected = dropdownSelectedKey === opt.key;
                    return (
                      <Pressable
                        key={opt.key}
                        onPress={() => handleDropdownSelect(opt.key)}
                        style={[styles.modalPartRow, isSelected && styles.modalPartRowSelected]}
                      >
                        <Text style={[styles.modalPartText, isSelected && styles.modalPartTextSelected]}>{opt.label}</Text>
                        {opt.sublabel ? <Text style={styles.muted}>{opt.sublabel}</Text> : null}
                      </Pressable>
                    );
                  })
                )}
              </ScrollView>
              <View style={styles.modalFooter}>
                <Pressable onPress={() => setActiveDropdown(null)} style={styles.modalBtn}>
                  <Text style={styles.modalBtnText}>Close</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>
      </SafeAreaView>
    );
  }

  // ── Phase: active ──

  const isLineStopped = anyStopRunning;

  return (
    <SafeAreaView style={styles.safeArea}>
      <CalculatorButton />
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        {/* Header */}
        <View style={styles.activeHeader}>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>
              {selectedLine?.lineName ?? 'Production'}
            </Text>
            <Text style={styles.subtitle}>
              {plant ?? ''}{workshop ? ` · ${workshop}` : ''}{division ? ` · ${division}` : ''} · Shift {selectedShift}
            </Text>
            <Text style={[styles.subtitle, { marginTop: 2, color: '#F2A93B', fontWeight: '700' }]}>
              Date: {formatProductionDayDisplay(productionDate)}
            </Text>
            <Text style={[styles.subtitle, { marginTop: 2, color: '#4C9A6A', fontWeight: '700' }]}>
              Shift Planned Total: {shiftPlannedTotal} parts{otHours > 0 ? ` (incl. ${otHours}h OT)` : ''}
            </Text>

            {partTargetSummary.length > 0 && (
              <View style={styles.partTargetBox}>
                <Text style={styles.partTargetHeading}>Part Targets</Text>
                {partTargetSummary.map((p) => (
                  <View key={p.name} style={styles.partTargetRow}>
                    <Text style={styles.partTargetName}>{p.name}</Text>
                    <Text style={styles.partTargetValue}>{p.target}</Text>
                  </View>
                ))}
              </View>
            )}
          </View>

          {/* Save session (persist only) */}
          <Pressable onPress={() => persistSession()} style={[styles.stopProductionBtn, { borderColor: '#F2A93B' }]}>
            <Ionicons name="save" size={18} color="#F2A93B" />
            <Text style={[styles.stopProductionText, { color: '#F2A93B' }]}>Save Session</Text>
          </Pressable>

          {/* Finalize & End Session */}
          <Pressable onPress={handleFinalizeSession} style={styles.stopProductionBtn}>
            <Ionicons name="stop-circle" size={18} color="#D64545" />
            <Text style={styles.stopProductionText}>Finalize & End</Text>
          </Pressable>
        </View>

        {/* Line stopped banner */}
        {isLineStopped && (
          <View style={styles.stoppedBanner}>
            <Ionicons name="warning" size={18} color="#D64545" />
            <Text style={styles.stoppedBannerText}>LINE IS CURRENTLY STOPPED — Resume before entering data</Text>
          </View>
        )}

        {/* Supervisor + operators summary */}
        <View style={styles.sessionInfo}>
          <Text style={styles.sessionInfoText}>
            👤 {supervisorName}{supervisorCode ? ` (${supervisorCode})` : ''}
            {'  '}·{'  '}
            Operators: {operators.filter((o) => o.name.trim()).map((o) => o.name.trim()).join(', ') || '—'}
          </Text>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text style={styles.sessionInfoText}>
              Part: {selectedLine?.parts?.[currentActivePartIndex]?.name ?? '—'}
            </Text>
            {/* OT editable during active session */}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={styles.sessionInfoText}>OT (h):</Text>
              <TextInput
                style={[styles.input, { width: 60, height: 36 }]}
                value={String(otHours)}
                keyboardType="number-pad"
                onChangeText={(t) => {
                  const v = Math.max(0, Math.min(8, Math.floor(Number(t) || 0)));
                  setOtHours(v);
                  // persist OT change right away
                  setTimeout(() => persistSession(), 200);
                }}
              />
            </View>
          </View>
        </View>

        {/* Changeover manager */}
        <View style={{ marginBottom: 12 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
            <Text style={styles.sectionLabel}>CHANGEOVERS</Text>
            <Pressable onPress={openAddChangeover} style={styles.addChangeBtn} disabled={isLineStopped}>
              <Ionicons name="shuffle" size={16} color={isLineStopped ? '#5C6670' : '#F2A93B'} />
              <Text style={[styles.addChangeText, isLineStopped && { color: '#5C6670' }]}>Add (captures now)</Text>
            </Pressable>
          </View>
          {Object.values(changeovers).length === 0 ? (
            <Text style={styles.muted}>No changeovers</Text>
          ) : Object.values(changeovers).map((co) => co && (
            <View key={co.slotIndex} style={styles.changeRow}>
              <Text style={{ color: '#ECEFF2', fontWeight: '700', fontSize: 12 }}>
                {slots.find((s) => s.index === co.slotIndex)?.label ?? `Slot ${co.slotIndex}`}
              </Text>
              <Text style={{ color: '#8A96A3', fontSize: 12, flex: 1, marginLeft: 8 }}>
                {selectedLine?.parts?.[co.oldPartIndex]?.name ?? '?'} → {selectedLine?.parts?.[co.newPartIndex]?.name ?? '?'} @ {formatAbsMinutesToAmPm(co.atAbs)}
              </Text>
              <Pressable onPress={() => { const idx = co.slotIndex; setChangeovers((p) => { const c = { ...p }; delete c[idx]; return c; }); setTimeout(() => persistSession(), 100); }} style={styles.removeChangeBtn}>
                <Ionicons name="close" size={16} color="#F2A93B" />
              </Pressable>
            </View>
          ))}
        </View>

        <Text style={styles.sectionLabel}>HOURLY SLOTS</Text>

        {/* Slot cards */}
        {(() => {
          const cards: JSX.Element[] = [];
          let activePart = selectedPartIndex;

          // Single shared card renderer used for BOTH a normal (non-changeover)
          // slot and each half of a changeover-split slot. Every card on this
          // screen — split or not — is built from this exact same JSX tree, so
          // structure, styling, controls, and behavior (Stop/Resume, Reject
          // counter, Loss reason, Save button, status indicators, validation)
          // are always identical. Only the data plugged in differs: time
          // range, part name, planned target, the entered/produced value, and
          // which reject/loss key this card reads and writes.
          function renderProductionCard(opts: {
            cardKey: string;
            stopSlotIndex: number;
            timeLabel: string;
            minutesLabel: string;
            partName: string;
            expParts: number;
            enteredValue: number | null;
            onChangeEntered: (v: number | null) => void;
            producedDisplay: number | null;
            rejectKey: string;
            lossKey: string;
            onSave: () => void;
            onDelete: () => void;
          }) {
            const {
              cardKey, stopSlotIndex, timeLabel, minutesLabel, partName, expParts,
              enteredValue, onChangeEntered, producedDisplay, rejectKey, lossKey, onSave, onDelete,
            } = opts;
            const runningStop = slotHasRunningStop(stopSlotIndex);
            const disabled = isLineStopped;

            return (
              <View key={cardKey} style={[styles.slotCard, runningStop && styles.slotCardStopped]}>
                {/* Slot header */}
                <View style={styles.slotHeader}>
                  <Text style={styles.slotLabel}>{timeLabel}</Text>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                    <Text style={styles.muted}>{minutesLabel}</Text>
                    <Pressable
                      onPress={onDelete}
                      disabled={disabled}
                      hitSlop={8}
                      style={[styles.deleteSlotBtn, disabled && styles.disabledBtn]}
                      accessibilityLabel="Delete this hourly card"
                    >
                      <Ionicons name="trash-outline" size={15} color={disabled ? '#5C6670' : '#D64545'} />
                    </Pressable>
                  </View>
                </View>
                <View style={styles.slotInfoRow}>
                  <Text style={styles.muted}>Expected: {expParts}</Text>
                  {producedDisplay != null && (
                    <Text style={{ color: producedDisplay >= expParts ? '#4C9A6A' : '#F2A93B', fontWeight: '700' }}>
                      Produced: {producedDisplay}
                    </Text>
                  )}
                </View>

                {/* Body: input + controls */}
                <View style={styles.slotBody}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.labelSmall}>Produced</Text>
                    <TextInput
                      keyboardType="number-pad"
                      style={[styles.input, disabled && styles.disabledInput]}
                      placeholder="Enter quantity produced"
                      placeholderTextColor="#5C6670"
                      value={enteredValue == null ? '' : String(enteredValue)}
                      onChangeText={(t) => onChangeEntered(t === '' ? null : Number(t.replace(/[^0-9]/g, '')))}
                      editable={!disabled}
                      onEndEditing={() => persistSession()}
                    />
                    <View style={{ marginTop: 8 }}>
                      <Text style={styles.labelSmall}>Rejections</Text>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 }}>
                        <Pressable onPress={() => { setRejectionsBySlot((p) => ({ ...p, [rejectKey]: Math.max(0, (p[rejectKey] ?? 0) - 1) })); setTimeout(() => persistSession(), 100); }} style={[styles.smallBtn, disabled && styles.disabledBtn]} disabled={disabled}><Text style={styles.smallBtnText}>−</Text></Pressable>
                        <Text style={{ color: '#ECEFF2', fontWeight: '700', minWidth: 36, textAlign: 'center' }}>{rejectionsBySlot[rejectKey] ?? 0}</Text>
                        <Pressable onPress={() => { setRejectionsBySlot((p) => ({ ...p, [rejectKey]: (p[rejectKey] ?? 0) + 1 })); setTimeout(() => persistSession(), 100); }} style={[styles.smallBtn, disabled && styles.disabledBtn]} disabled={disabled}><Text style={styles.smallBtnText}>+</Text></Pressable>
                      </View>
                    </View>
                  </View>

                  {/* Right column: part + stop/resume */}
                  <View style={styles.controlsColumn}>
                    <View style={styles.controlBlock}>
                      <Text style={styles.labelSmall}>Part</Text>
                      <View style={styles.smallBox}>
                        <Text style={{ color: '#F2A93B', fontWeight: '700', fontSize: 11 }} numberOfLines={2}>{partName}</Text>
                      </View>
                    </View>
                    <View style={styles.controlBlock}>
                      <Text style={styles.labelSmall}>Line Stop</Text>
                      {runningStop ? (
                        <View style={{ alignItems: 'center', gap: 4 }}>
                          <Text style={{ color: '#D64545', fontWeight: '800', fontSize: 11 }}>STOPPED</Text>
                          {(() => {
                            const arr = stopsBySlot[stopSlotIndex] ?? [];
                            const r = arr.find((x) => x.running);
                            return r ? (
                              <Text style={{ color: '#F2A93B', fontWeight: '700', fontSize: 10.5, textTransform: 'capitalize' }} numberOfLines={1}>
                                {r.reason}
                              </Text>
                            ) : null;
                          })()}
                          <Text style={{ color: '#D64545', fontSize: 12, fontWeight: '700' }}>
                            {(() => { const arr = stopsBySlot[stopSlotIndex] ?? []; const r = arr.find((x) => x.running); return r ? formatElapsed(r.startAbs) : '00:00'; })()}
                          </Text>
                          <Pressable onPress={() => endStopForSlot(stopSlotIndex)} style={styles.resumeBtn}>
                            <Text style={{ color: '#14181C', fontWeight: '800', fontSize: 12 }}>Resume</Text>
                          </Pressable>
                        </View>
                      ) : (
                        <Pressable
                          onPress={() => openStopModalForSlot(stopSlotIndex)}
                          disabled={disabled}
                          style={[styles.stopBtn, disabled && styles.disabledBtn]}
                        >
                          <Text style={{ color: '#F2A93B', fontWeight: '700', fontSize: 12 }}>Stop</Text>
                        </Pressable>
                      )}
                    </View>
                  </View>
                </View>

                {/* Previous stops */}
                {(stopsBySlot[stopSlotIndex] ?? []).filter((ev) => !ev.running).map((ev, i) => (
                  <View key={i} style={styles.stopBadge}>
                    <Ionicons name="time-outline" size={12} color="#8A96A3" />
                    <Text style={styles.stopBadgeText}>{ev.reason} · {ev.durationMinutes?.toFixed(1)} min</Text>
                  </View>
                ))}

                {/* Loss tile — only shown once there's an actual shortfall for this card */}
                {producedDisplay != null && producedDisplay < expParts && (() => {
                  const lossAmt = expParts - producedDisplay;
                  const reason = lossReasonBySlot[lossKey];
                  return (
                    <View style={styles.lossBox}>
                      <View style={styles.lossHeader}>
                        <Ionicons name="trending-down" size={13} color="#D64545" />
                        <Text style={styles.lossTitle}>Loss: {lossAmt} pcs</Text>
                      </View>
                      <Pressable onPress={() => openLossModal(lossKey, lossAmt)} style={reason ? styles.lossReasonPill : styles.lossReasonMissingPill}>
                        <Text style={reason ? styles.lossReasonText : styles.lossReasonMissingText}>
                          {reason ? `${reason.code}. ${reason.label}${reason.note ? ` — ${reason.note}` : ''}` : 'Select reason'}
                        </Text>
                        <Ionicons name={reason ? 'pencil' : 'chevron-forward'} size={11} color={reason ? '#8A96A3' : '#F2A93B'} />
                      </Pressable>
                    </View>
                  );
                })()}

                {/* Save button */}
                <Pressable onPress={onSave} disabled={disabled || saving} style={[styles.updateButton, disabled && styles.updateButtonDisabled]}>
                  <Text style={styles.updateText}>{saving ? 'Saving…' : 'Save Slot'}</Text>
                </Pressable>
              </View>
            );
          }

          for (const s of visibleSlots) {
            const co = changeovers[s.index] ?? null;

            if (!co) {
              const stopped = totalStoppedMinutesForSlot(s.index);
              const productive = Math.max(0, s.productiveMinutes - stopped);
              // Each card is independent — the operator enters exactly what
              // was produced in this slot, so the display value IS the
              // entered value, no baseline involved.
              const producedVal = producedBySlot[s.index];
              // Expected/planned is a fixed target (cycle time × the slot's
              // full designed duration) — it's known the moment production
              // starts, same as the shift-wide planned total, so it always
              // shows the real figure rather than 0 before data is entered.
              const expParts = expectedParts(activePart, s.productiveMinutes);

              cards.push(renderProductionCard({
                cardKey: `slot-${s.index}`,
                stopSlotIndex: s.index,
                timeLabel: s.label,
                minutesLabel: `${productive} min prod.`,
                partName: selectedLine?.parts?.[activePart]?.name ?? '—',
                expParts,
                enteredValue: producedVal,
                onChangeEntered: (v) => setProducedBySlot((p) => ({ ...p, [s.index]: v })),
                producedDisplay: producedVal,
                rejectKey: String(s.index),
                lossKey: String(s.index),
                onSave: () => attemptSave(s),
                onDelete: () => handleDeleteSlot(s.index),
              }));
            } else {
              // Changeover slot — split into a BEFORE card (old part) and an
              // AFTER card (new part), each built from the exact same
              // renderProductionCard used above — only the time range, part,
              // target, and entered value differ. Each is fully independent:
              // the operator enters exactly what was produced in that
              // segment, no counter, no baseline. Deleting either half
              // deletes the whole underlying hourly slot (both segments and
              // its changeover), since they're one hourly card split in two.
              const stopBefore = stoppedMinutesForSegment(s.index, co.beforeMinutes, co.afterMinutes);
              const prodBefore = Math.max(0, co.beforeMinutes - stopBefore);
              const expBefore = expectedParts(co.oldPartIndex, co.beforeMinutes);
              const stopAfter = stoppedMinutesForSegment(s.index, co.afterMinutes, co.beforeMinutes);
              const prodAfter = Math.max(0, co.afterMinutes - stopAfter);
              const expAfter = expectedParts(co.newPartIndex, co.afterMinutes);

              const beforeVal = producedSegment[`${s.index}:before`] ?? null;
              cards.push(renderProductionCard({
                cardKey: `slot-${s.index}-before`,
                stopSlotIndex: s.index,
                timeLabel: `${formatAbsMinutesToAmPm(s.startMinutesAbs)} – ${formatAbsMinutesToAmPm(co.atAbs)}`,
                minutesLabel: `${prodBefore} min prod.`,
                partName: selectedLine?.parts?.[co.oldPartIndex]?.name ?? '—',
                expParts: expBefore,
                enteredValue: beforeVal,
                onChangeEntered: (v) => setProducedSegment((p) => ({ ...p, [`${s.index}:before`]: v })),
                producedDisplay: beforeVal,
                rejectKey: `${s.index}:before`,
                lossKey: `${s.index}:before`,
                onSave: () => attemptSave(s),
                onDelete: () => handleDeleteSlot(s.index),
              }));

              const afterVal = producedSegment[`${s.index}:after`] ?? null;
              cards.push(renderProductionCard({
                cardKey: `slot-${s.index}-after`,
                stopSlotIndex: s.index,
                timeLabel: `${formatAbsMinutesToAmPm(co.atAbs)} – ${formatAbsMinutesToAmPm(s.endMinutesAbs)}`,
                minutesLabel: `${prodAfter} min prod.`,
                partName: selectedLine?.parts?.[co.newPartIndex]?.name ?? '—',
                expParts: expAfter,
                enteredValue: afterVal,
                onChangeEntered: (v) => setProducedSegment((p) => ({ ...p, [`${s.index}:after`]: v })),
                producedDisplay: afterVal,
                rejectKey: `${s.index}:after`,
                lossKey: `${s.index}:after`,
                onSave: () => attemptSave(s),
                onDelete: () => handleDeleteSlot(s.index),
              }));

              activePart = co.newPartIndex;
            }
          }
          return cards;
        })()}

        <View style={{ height: 40 }} />
      </ScrollView>

      {/* ── Changeover modal */}
      <Modal visible={changeModalVisible} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Add Changeover</Text>
            <Text style={styles.modalLabel}>Select the new part</Text>
            <ScrollView contentContainerStyle={styles.modalScroll}>
              {selectedLine?.parts?.map((p, i) => (
                <Pressable key={i} onPress={() => setChangeModalNewPartIndex(i)} style={[styles.modalPartRow, changeModalNewPartIndex === i && styles.modalPartRowSelected]}>
                  <Text style={[styles.modalPartText, changeModalNewPartIndex === i && styles.modalPartTextSelected]}>{p.name} · {p.cycleTimeSeconds}s</Text>
                </Pressable>
              )) ?? <Text style={styles.muted}>No parts</Text>}
            </ScrollView>
            <View style={styles.modalFooter}>
              <Pressable onPress={() => setChangeModalVisible(false)} style={styles.modalBtn}><Text style={styles.modalBtnText}>Cancel</Text></Pressable>
              <Pressable onPress={() => {
                console.log("CONFIRM CLICKED");
                alert("CONFIRM CLICKED");
                confirmChangeover();
              }} style={[styles.modalBtn, styles.modalConfirmBtn]}><Text style={[styles.modalBtnText, styles.modalConfirmBtnText]}>Confirm</Text></Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* ── Stop modal */}
      <Modal visible={stopModalVisible} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Line Stop Reason</Text>
            <ScrollView contentContainerStyle={styles.modalScroll}>
              {STOP_REASONS.map((r) => (
                <Pressable key={r} onPress={() => setStopModalReason(r)} style={[styles.modalPartRow, stopModalReason === r && styles.modalPartRowSelected]}>
                  <Text style={[styles.modalPartText, stopModalReason === r && styles.modalPartTextSelected]}>{r}</Text>
                </Pressable>
              ))}
            </ScrollView>
            <View style={styles.modalFooter}>
              <Pressable onPress={() => setStopModalVisible(false)} style={styles.modalBtn}><Text style={styles.modalBtnText}>Cancel</Text></Pressable>
              <Pressable
                onPress={() => {
                  if (stopModalSlotIndex == null) { setStopModalVisible(false); return; }
                  if (!stopModalReason) { Alert.alert('Select reason', 'Choose a stop reason first.'); return; }
                  startStopForSlot(stopModalSlotIndex, stopModalReason);
                }}
                style={[styles.modalBtn, styles.modalConfirmBtn]}
              >
                <Text style={[styles.modalBtnText, styles.modalConfirmBtnText]}>Start Stop</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* ── Loss reason modal — pops up only when a slot/segment has a
          shortfall (produced < expected) with no reason attached yet */}
      <Modal visible={lossModalVisible} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Reason for Part Loss</Text>
            <Text style={styles.modalLabel}>Shortfall of {lossModalAmount} pc{lossModalAmount === 1 ? '' : 's'} vs. expected for this slot — pick the cause.</Text>
            <ScrollView contentContainerStyle={styles.modalScroll}>
              {LOSS_REASONS.map((r) => (
                <Pressable key={r.code} onPress={() => setLossModalCode(r.code)} style={[styles.modalPartRow, lossModalCode === r.code && styles.modalPartRowSelected]}>
                  <Text style={[styles.modalPartText, lossModalCode === r.code && styles.modalPartTextSelected]}>{r.code}. {r.label}</Text>
                </Pressable>
              ))}
              {lossModalCode === 'K' && (
                <TextInput
                  style={[styles.input, { marginTop: 4 }]}
                  placeholder="Describe the reason…"
                  placeholderTextColor="#5C6670"
                  value={lossModalNote}
                  onChangeText={setLossModalNote}
                />
              )}
            </ScrollView>
            <View style={styles.modalFooter}>
              <Pressable onPress={() => { setLossModalVisible(false); pendingAfterLossRef.current = null; }} style={styles.modalBtn}>
                <Text style={styles.modalBtnText}>Cancel</Text>
              </Pressable>
              <Pressable onPress={confirmLossReason} style={[styles.modalBtn, styles.modalConfirmBtn]}>
                <Text style={[styles.modalBtnText, styles.modalConfirmBtnText]}>Confirm</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#14181C' },
  scroll: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 40 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  backButton: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 8 },
  backText: { color: '#8A96A3', fontSize: 15 },
  title: { color: '#ECEFF2', fontSize: 22, fontWeight: '800' },
  subtitle: { color: '#8A96A3', fontSize: 13, marginTop: 4, marginBottom: 14 },
  sectionLabel: { color: '#F2A93B', fontSize: 12, fontWeight: '800', letterSpacing: 1.4, marginBottom: 8, marginTop: 4 },
  field: { marginBottom: 12 },
  label: { color: '#8A96A3', fontSize: 11.5, marginBottom: 6, fontWeight: '700' },
  labelSmall: { color: '#8A96A3', fontSize: 11, marginBottom: 4, fontWeight: '700' },
  row: { flexDirection: 'row', gap: 8 },
  input: {
    backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C',
    borderRadius: 10, paddingHorizontal: 12, height: 48, color: '#ECEFF2', fontSize: 15,
  },
  disabledInput: { opacity: 0.5, backgroundColor: '#14181C' },
  disabledBtn: { opacity: 0.4 },
  pickerBox: {
    backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C', borderRadius: 10,
    paddingHorizontal: 12, height: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  pickerBoxText: { color: '#ECEFF2', fontSize: 15, flex: 1, marginRight: 8 },
  pickerBoxPlaceholder: { color: '#5C6670' },
  chipsRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  chip: { borderWidth: 1, borderColor: '#2C343C', backgroundColor: '#1D2329', borderRadius: 16, paddingHorizontal: 12, paddingVertical: 8 },
  chipSelected: { borderColor: '#F2A93B', backgroundColor: '#F2A93B22' },
  chipText: { color: '#8A96A3', fontSize: 13, fontWeight: '600' },
  chipTextSelected: { color: '#F2A93B' },
  muted: { color: '#8A96A3', fontSize: 12 },
  lineRow: { padding: 12, borderRadius: 8, borderWidth: 1, borderColor: '#2C343C', marginBottom: 8, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  lineRowActive: { borderColor: '#F2A93B', backgroundColor: '#F2A93B08' },
  lineText: { color: '#ECEFF2', fontWeight: '700' },

  // Start button
  startButton: { height: 58, borderRadius: 12, backgroundColor: '#4C9A6A', alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 10, marginTop: 12 },
  startButtonPressed: { opacity: 0.85 },
  startButtonText: { color: '#14181C', fontSize: 17, fontWeight: '900' },

  // Continue-session cards (setup phase)
  continueCard: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: '#1D2329', borderWidth: 1,
    borderColor: '#4C9A6A55', borderRadius: 10, padding: 12, marginBottom: 8, gap: 10,
  },
  continueCardTitle: { color: '#ECEFF2', fontSize: 14, fontWeight: '800' },
  continueCardMeta: { color: '#8A96A3', fontSize: 11.5, marginTop: 2 },

  // Active phase header
  activeHeader: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 10, gap: 8 },
  stopProductionBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderColor: '#D64545', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, marginLeft: 8 },
  stopProductionText: { color: '#D64545', fontWeight: '700', fontSize: 12 },
  stoppedBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#D6454522',
    borderWidth: 1, borderColor: '#D64545', borderRadius: 10, padding: 12, marginBottom: 12,
  },
  stoppedBannerText: { color: '#D64545', fontWeight: '800', fontSize: 12, flex: 1 },
  sessionInfo: { backgroundColor: '#1D2329', borderRadius: 10, borderWidth: 1, borderColor: '#2C343C', padding: 10, marginBottom: 14, gap: 2 },
  sessionInfoText: { color: '#8A96A3', fontSize: 12 },

  // Part Target Summary (below Shift Planned Total)
  partTargetBox: { marginTop: 8, backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C', borderRadius: 10, padding: 10, gap: 4 },
  partTargetHeading: { color: '#F2A93B', fontSize: 11, fontWeight: '800', letterSpacing: 1.2, marginBottom: 2 },
  partTargetRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 2 },
  partTargetName: { color: '#ECEFF2', fontSize: 13, fontWeight: '600' },
  partTargetValue: { color: '#ECEFF2', fontSize: 13, fontWeight: '800' },

  // Slot cards
  slotCard: { backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C', borderRadius: 12, padding: 12, marginBottom: 12 },
  slotCardStopped: { borderColor: '#D6454555' },
  slotCardChangeover: { borderColor: '#3E7CB155' },
  slotHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  deleteSlotBtn: { padding: 3, borderRadius: 6 },
  slotLabel: { color: '#ECEFF2', fontWeight: '800', fontSize: 13 },
  slotInfoRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 },
  partTargetInline: { color: '#4C9A6A', fontSize: 13, fontWeight: '800' },
  slotBody: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  controlsColumn: { width: 110, gap: 8, paddingTop: 2 },
  controlBlock: { alignItems: 'center', gap: 4 },
  smallBtn: { width: 34, height: 34, borderRadius: 8, borderWidth: 1, borderColor: '#2C343C', alignItems: 'center', justifyContent: 'center', backgroundColor: '#0F1417' },
  smallBtnText: { color: '#ECEFF2', fontSize: 18, fontWeight: '800' },
  smallBox: { width: 100, minHeight: 38, borderRadius: 8, borderWidth: 1, borderColor: '#2C343C', alignItems: 'center', justifyContent: 'center', backgroundColor: '#171B20', padding: 4 },
  stopBtn: { borderWidth: 1, borderColor: '#F2A93B', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, alignItems: 'center' },
  resumeBtn: { backgroundColor: '#4C9A6A', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, alignItems: 'center' },
  updateButton: { marginTop: 10, height: 44, borderRadius: 10, backgroundColor: '#3E7CB1', alignItems: 'center', justifyContent: 'center' },
  updateButtonDisabled: { backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C', opacity: 0.5 },
  updateText: { color: '#fff', fontWeight: '800', fontSize: 13 },
  stopBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4, paddingVertical: 4, paddingHorizontal: 8, backgroundColor: '#2C343C', borderRadius: 6, alignSelf: 'flex-start' },
  stopBadgeText: { color: '#8A96A3', fontSize: 11 },

  // Loss tile
  lossBox: {
    marginTop: 10, backgroundColor: '#D6454511', borderWidth: 1, borderColor: '#D6454555',
    borderRadius: 10, padding: 10, gap: 6,
  },
  lossHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  lossTitle: { color: '#D64545', fontWeight: '800', fontSize: 12.5 },
  lossReasonPill: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8,
    backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C', borderRadius: 8,
    paddingHorizontal: 10, paddingVertical: 8,
  },
  lossReasonText: { color: '#ECEFF2', fontSize: 12, flex: 1 },
  lossReasonMissingPill: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8,
    backgroundColor: '#F2A93B14', borderWidth: 1, borderColor: '#F2A93B', borderRadius: 8,
    paddingHorizontal: 10, paddingVertical: 8,
  },
  lossReasonMissingText: { color: '#F2A93B', fontWeight: '700', fontSize: 12, flex: 1 },

  // Changeovers
  addChangeBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderColor: '#2C343C', padding: 8, borderRadius: 8 },
  addChangeText: { color: '#F2A93B', fontWeight: '700', fontSize: 13 },
  changeRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6, borderTopWidth: 1, borderTopColor: '#2C343C' },
  removeChangeBtn: { padding: 6 },

  // Modals
  modalOverlay: { flex: 1, backgroundColor: '#00000088', alignItems: 'center', justifyContent: 'center', padding: 20 },
  modalCard: { width: '100%', maxWidth: 720, backgroundColor: '#14181C', borderRadius: 12, maxHeight: '80%', padding: 14, borderWidth: 1, borderColor: '#2C343C' },
  modalScroll: { paddingBottom: 12 },
  modalTitle: { color: '#ECEFF2', fontSize: 18, fontWeight: '800', marginBottom: 8 },
  modalLabel: { color: '#8A96A3', marginBottom: 8, fontSize: 13 },
  modalPartRow: { paddingVertical: 12, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, borderColor: '#2C343C', marginBottom: 8, minHeight: 48, justifyContent: 'center' },
  modalPartRowSelected: { borderColor: '#F2A93B', backgroundColor: '#F2A93B08' },
  modalPartText: { color: '#ECEFF2', fontSize: 14 },
  modalPartTextSelected: { color: '#F2A93B', fontWeight: '800' },
  modalFooter: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: '#2C343C' },
  modalBtn: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: '#2C343C', backgroundColor: '#1D2329' },
  modalBtnText: { color: '#ECEFF2', fontWeight: '700' },
  modalConfirmBtn: { backgroundColor: '#F2A93B', borderColor: '#F2A93B' },
  modalConfirmBtnText: { color: '#14181C', fontWeight: '800' },

  // Floating calculator button + modal
  calcFab: {
    position: 'absolute', zIndex: 20, elevation: 20,
    width: CALC_FAB_SIZE, height: CALC_FAB_SIZE, borderRadius: CALC_FAB_SIZE / 2, backgroundColor: '#F2A93B',
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 6, shadowOffset: { width: 0, height: 2 },
  },
  calcModalOverlay: { flex: 1, backgroundColor: '#00000088', alignItems: 'center', justifyContent: 'center', padding: 20 },
  calcCard: {
    width: '100%', maxWidth: 340, backgroundColor: '#14181C', borderRadius: 16,
    padding: 14, borderWidth: 1, borderColor: '#2C343C',
  },
  calcHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  calcTitle: { color: '#ECEFF2', fontSize: 16, fontWeight: '800' },
  calcDisplayBox: {
    backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C', borderRadius: 10,
    paddingHorizontal: 14, paddingVertical: 18, marginBottom: 12, alignItems: 'flex-end',
  },
  calcDisplayText: { color: '#ECEFF2', fontSize: 34, fontWeight: '700' },
  calcExpressionText: { color: '#8A96A3', fontSize: 15, fontWeight: '600', marginBottom: 2 },
  calcRow: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  calcKey: {
    flex: 1, height: 52, borderRadius: 10, backgroundColor: '#1D2329',
    borderWidth: 1, borderColor: '#2C343C', alignItems: 'center', justifyContent: 'center',
  },
  calcKeyWide: { flex: 2.15 },
  calcKeyOperator: { backgroundColor: '#F2A93B', borderColor: '#F2A93B' },
  calcKeyFunc: { backgroundColor: '#2C343C', borderColor: '#2C343C' },
  calcKeyText: { color: '#ECEFF2', fontSize: 18, fontWeight: '700' },
  calcKeyOperatorText: { color: '#14181C', fontWeight: '900' },
  calcKeyFuncText: { color: '#ECEFF2', fontWeight: '800' },
});