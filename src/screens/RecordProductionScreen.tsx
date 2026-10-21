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
  query,
  where,
  Timestamp,
} from 'firebase/firestore';
import { db } from '../services/firebase';
import { useAuthStore } from '../stores/authStore';
import {
  millisToProductionDayMinute,
  productionDayKeyFor,
  productionDayMinuteToMillis,
  resolveSessionProductionDate,
  timestampToMillis,
} from '../utils/productionDay';
import { PLANTS, WORKSHOPS, DIVISIONS } from '../constants/lineOptions';
import {
  SHIFT_A_START,
  SHIFT_A_END,
  SHIFT_B_START,
  SHIFT_B_END_ABS,
  LUNCH_BREAK,
  ScheduleSlot,
  TimeInterval,
  buildSlots,
  scheduledNonProductive,
  changeoverSegmentWindows,
  changeoverSegmentMinutes,
  expectedPartsFor,
  formatAbsMinutesToAmPm,
  formatTimeInput,
  isChangeoverAtSlotStart,
  parseTimeInput,
  placeChangeoverTime,
  timeOfDayToShiftAbs,
  validateChangeoverInterval,
  validateProductionStartTime,
  formatAbsMinutes24,
} from '../utils/productionSchedule';

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

type Slot = ScheduleSlot;

type ChangeoverInfo = {
  slotIndex: number;
  // Changeover start (kept under its original name for stored sessions and
  // productionRecords.changeoverInfo).
  atAbs: number;
  // Manually entered changeover interval, [startAbs, endAbs). Missing on
  // changeovers recorded before manual entry, which were an instant at atAbs.
  startAbs?: number;
  endAbs?: number;
  durationMinutes?: number;
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
  // Actual production start entered by the supervisor, written once by
  // handleStartProduction and never by persistSession. Missing on sessions
  // started before it existed — those keep the full-shift schedule.
  productionStartMinutesAbs?: number | null; // same absolute-minute frame as the schedule
  productionStartedAt?: any;                 // Timestamp of that instant on the production day
}

// A start time entered more than this many minutes before "now" asks the
// supervisor to confirm it (late data entry is allowed, but should be deliberate).
const LATE_START_CONFIRM_MINUTES = 10;

// ─── Production record upsert ─────────────────────────────────────────────────
// One productionRecords doc per logical slot: re-saving a slot (or Finalize
// writing a slot that was already saved) updates that doc instead of adding
// another. A slot is identified by productionDate + lineId + shift +
// slotIndex + segment ('full' for a normal slot, 'before'/'after' for the
// two halves of a changeover slot).

type SlotSegment = 'full' | 'before' | 'after';

interface ProductionSlotIdentity {
  productionDate: string;
  lineId: string;
  shift: string;
  slotIndex: number;
  segment: SlotSegment;
}

// Deterministic doc ID. Each part is URI-encoded, so it can never contain
// '/' (illegal in an ID) or the '|' separator — distinct identities can't
// collide.
function productionRecordId(id: ProductionSlotIdentity): string {
  return ['pr', id.productionDate, id.lineId, id.shift, String(id.slotIndex), id.segment]
    .map((v) => encodeURIComponent(v))
    .join('|');
}

// Resolves the doc a slot should be written to, in order:
//   1. the canonical (deterministic-ID) doc, if it already exists;
//   2. a legacy addDoc() record for the same slot — records saved before
//      this change have random IDs, and creating a canonical doc next to one
//      would double-count the slot. If several legacy duplicates already
//      exist, the earliest-created one is updated and the rest are left
//      untouched (logged for manual cleanup) — nothing is deleted here;
//   3. otherwise the canonical doc, which will be created.
// Firestore is the source of truth for "was this slot saved" — React state
// (savedSlotIndices) isn't restored with a resumed session.
async function resolveProductionRecordRef(id: ProductionSlotIdentity) {
  const canonicalRef = doc(db, 'productionRecords', productionRecordId(id));
  const canonicalSnap = await getDoc(canonicalRef);
  if (canonicalSnap.exists()) return { ref: canonicalRef, exists: true };

  const legacySnap = await getDocs(
    query(
      collection(db, 'productionRecords'),
      where('productionDate', '==', id.productionDate),
      where('lineId', '==', id.lineId),
      where('shift', '==', id.shift),
      where('slotIndex', '==', id.slotIndex)
    )
  );
  const legacy = legacySnap.docs
    .filter((d) => {
      const seg = (d.data() as any).partSegment ?? null;
      return id.segment === 'full' ? seg == null : seg === id.segment;
    })
    .sort((a, b) => {
      const ta = (a.data() as any).createdAt?.toMillis?.() ?? 0;
      const tb = (b.data() as any).createdAt?.toMillis?.() ?? 0;
      return ta - tb || a.id.localeCompare(b.id);
    });
  if (legacy.length > 1) {
    console.warn(
      '[productionRecords] legacy duplicates for one slot — updating the earliest, the rest need manual cleanup',
      { identity: id, kept: legacy[0].id, duplicates: legacy.slice(1).map((d) => d.id) }
    );
  }
  if (legacy.length) return { ref: legacy[0].ref, exists: true };
  return { ref: canonicalRef, exists: false };
}

// Creates the slot's record on first save, otherwise overwrites it with the
// latest values. createdAt is only written on create (the original creation
// time is kept on every later save); updatedAt is stamped every time.
// `resolved` caches which doc each slot resolved to, so later saves in the
// same session skip the lookup and always hit the same document.
async function upsertProductionRecord(
  id: ProductionSlotIdentity,
  data: Record<string, any>,
  resolved: Map<string, string>
) {
  const { createdAt: _createdAt, ...fields } = data;
  const key = productionRecordId(id);
  const cachedDocId = resolved.get(key);
  if (cachedDocId) {
    await setDoc(doc(db, 'productionRecords', cachedDocId), { ...fields, updatedAt: serverTimestamp() }, { merge: true });
    return;
  }
  const { ref, exists } = await resolveProductionRecordRef(id);
  if (exists) {
    await setDoc(ref, { ...fields, updatedAt: serverTimestamp() }, { merge: true });
  } else {
    await setDoc(ref, { ...fields, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
  }
  resolved.set(key, ref.id);
}

// A slot is stored either as one 'full' record or as 'before' + 'after'.
// When its shape changes after it was saved (a changeover added to, or
// removed from, an already-saved slot), the superseded record(s) are
// deleted so the slot is never counted twice. Call after writing `keep`.
async function removeSupersededProductionRecords(
  slot: Omit<ProductionSlotIdentity, 'segment'>,
  keep: 'full' | 'split',
  resolved: Map<string, string>
) {
  const stale: SlotSegment[] = keep === 'full' ? ['before', 'after'] : ['full'];
  for (const segment of stale) {
    const id: ProductionSlotIdentity = { ...slot, segment };
    const { ref, exists } = await resolveProductionRecordRef(id);
    if (exists) await deleteDoc(ref);
    resolved.delete(productionRecordId(id));
  }
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

// Production day (6:30 AM cutover) and session date pinning live in
// src/utils/productionDay.ts.

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

// Default Production Start Time for a shift: its scheduled start (Shift A
// 07:00, Shift B 19:00). The supervisor overwrites it when production
// actually started later.
function defaultStartTimeText(shift: 'A' | 'B'): string {
  return formatAbsMinutes24(shift === 'A' ? SHIFT_A_START : SHIFT_B_START);
}

// Planned parts for a list of slots on one part (the shift's planned total
// before any changeover exists).
function plannedTotalFor(slotList: Slot[], line: Line | null, partIndex: number): number {
  const cycle = line?.parts?.[partIndex]?.cycleTimeSeconds ?? 0;
  if (!cycle) return 0;
  return slotList.reduce((sum, s) => sum + expectedPartsFor(cycle, s.productiveMinutes), 0);
}

// Division only applies under the Assembly workshop. Matched by substring
// rather than an exact hardcoded string so this keeps working even if the
// exact label in lineOptions.ts changes (e.g. "Assembly" vs "Assembly Shop").
function isAssemblyWorkshop(w: string | null) {
  return !!w && w.toLowerCase().includes('assembly');
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
  // Production Start Time as typed on the setup screen (24-hour "HH:MM").
  // Defaults to the selected shift's start (see defaultStartTimeText).
  const [startTimeText, setStartTimeText] = useState(() => defaultStartTimeText('A'));
  // The active session's stored production start (absolute minutes), or
  // null for a legacy session that has none.
  const [sessionStartAbs, setSessionStartAbs] = useState<number | null>(null);
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
  // Latest counts for the deferred record sync below (syncSavedSlotRejections).
  const rejectionsBySlotRef = useRef<Record<string, number>>({});
  rejectionsBySlotRef.current = rejectionsBySlot;
  const [stopsBySlot, setStopsBySlot] = useState<Record<number, StopEvent[]>>({});
  // Mirrors stopsBySlot for reads inside setTimeout/async callbacks below,
  // where a closure over state captured at call time would otherwise be stale.
  const stopsBySlotRef = useRef<Record<number, StopEvent[]>>({});
  useEffect(() => { stopsBySlotRef.current = stopsBySlot; }, [stopsBySlot]);
  // Changeovers as entered/restored. Everything else reads `changeovers`
  // below, which recomputes each one's segment minutes from the shared
  // schedule (see the Derived section).
  const [storedChangeovers, setChangeovers] = useState<Record<number, ChangeoverInfo | null>>({});
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
      setSessionStartAbs(null);
      setStartTimeText(defaultStartTimeText(selectedShift));
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
  // Manually entered changeover time, 24-hour "HH:MM" (display string; the
  // colon is inserted automatically) — never taken from the device clock.
  // Parsed with parseTimeInput into minutes; the string itself is never used
  // in calculations.
  const [changeTimeText, setChangeTimeText] = useState('');
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
  // Synchronous guard against overlapping writes from rapid taps — `saving`
  // only disables the button after the next render.
  const savingSlotsRef = useRef<Set<number>>(new Set());
  // Slot identity → productionRecords doc ID it resolved to (see
  // upsertProductionRecord).
  const resolvedRecordIdsRef = useRef<Map<string, string>>(new Map());
  // Original start time of the current session (epoch ms) — last-resort
  // source for its production date (see resolveActiveSessionProductionDate).
  const sessionStartedAtMsRef = useRef<number | null>(null);
  const [startingProduction, setStartingProduction] = useState(false);
  const [persistingSession, setPersistingSession] = useState(false);

  // ── Derived
  // Every changeover's [start, end) interval. Legacy changeovers (recorded
  // before manual entry) are an instant at atAbs.
  const changeoverIntervals = useMemo<TimeInterval[]>(
    () =>
      Object.values(storedChangeovers)
        .filter((co): co is ChangeoverInfo => !!co)
        .map((co) => ({ start: co.startAbs ?? co.atAbs, end: co.endAbs ?? co.atAbs })),
    [storedChangeovers]
  );

  // Production start the schedule is built from: the active session's
  // stored start, or — on the setup screen — the typed time once it is a
  // valid time inside the shift (the "not in the future" rule is checked
  // against the clock when Start Production is pressed).
  const setupStartCheck = validateProductionStartTime(startTimeText, selectedShift, otHours);
  const effectiveStartAbs = phase === 'active'
    ? sessionStartAbs
    : setupStartCheck.ok ? setupStartCheck.startAbs : null;

  // Hourly slots from the shared schedule (src/utils/productionSchedule.ts):
  // lunch-adjusted windows, with breaks, startup reserve and changeover time
  // already taken out of productiveMinutes — so a changeover that runs past
  // its own slot's end reduces the following slot too. Slots before the
  // production start are left out and the slot it falls in is clipped to it.
  const slots = useMemo(
    () => buildSlots(selectedShift, otHours, changeoverIntervals, effectiveStartAbs),
    [selectedShift, otHours, changeoverIntervals, effectiveStartAbs]
  );

  // Every changeover with its BEFORE/AFTER productive minutes recomputed
  // from the same schedule, so removing or adding another changeover, or
  // changing OT, can never leave stale minutes behind. This is what gets
  // persisted, validated and listed.
  const allChangeovers = useMemo(() => {
    const nonProductive = [...scheduledNonProductive(selectedShift, otHours), ...changeoverIntervals];
    const result: Record<number, ChangeoverInfo | null> = {};
    Object.entries(storedChangeovers).forEach(([k, co]) => {
      if (!co) return;
      const slot = slots.find((s) => s.index === co.slotIndex);
      if (!slot) return;
      const startAbs = co.startAbs ?? co.atAbs;
      const endAbs = co.endAbs ?? co.atAbs;
      // A changeover on the slot's start switches the part for the whole
      // slot: no BEFORE time, the slot's full minutes go to the new part.
      const { beforeMinutes, afterMinutes } = isChangeoverAtSlotStart(slot, { start: startAbs, end: endAbs })
        ? { beforeMinutes: 0, afterMinutes: slot.productiveMinutes }
        : changeoverSegmentMinutes(slot, { start: startAbs, end: endAbs }, nonProductive);
      const oldCycle = selectedLine?.parts?.[co.oldPartIndex]?.cycleTimeSeconds ?? 0;
      const newCycle = selectedLine?.parts?.[co.newPartIndex]?.cycleTimeSeconds ?? 0;
      result[Number(k)] = {
        ...co,
        atAbs: startAbs,
        startAbs,
        endAbs,
        durationMinutes: endAbs - startAbs,
        beforeMinutes,
        afterMinutes,
        expectedBefore: expectedPartsFor(oldCycle, beforeMinutes),
        expectedAfter: expectedPartsFor(newCycle, afterMinutes),
      };
    });
    return result;
  }, [storedChangeovers, slots, selectedShift, otHours, changeoverIntervals, selectedLine]);

  // Changeovers that SPLIT their slot into BEFORE/AFTER cards and records.
  // A changeover exactly on a slot's start is left out: that slot stays one
  // full card (segment 'full') on the new part — see activePartIndexBySlot —
  // so no zero-length BEFORE card or record is ever created.
  const changeovers = useMemo(() => {
    const result: Record<number, ChangeoverInfo | null> = {};
    for (const [k, co] of Object.entries(allChangeovers)) {
      const slot = co && slots.find((s) => s.index === co.slotIndex);
      if (co && slot && isChangeoverAtSlotStart(slot, { start: co.atAbs, end: co.endAbs ?? co.atAbs })) continue;
      result[Number(k)] = co;
    }
    return result;
  }, [allChangeovers, slots]);

  // The part running in each slot (for a split slot: the part at its start).
  // Carried forward through every changeover, including a part switch at a
  // slot's start, which takes effect for that slot itself. Every path that
  // needs "which part is this slot on" — cards, saves, Finalize, totals —
  // reads this one map.
  const activePartIndexBySlot = useMemo(() => {
    const map: Record<number, number> = {};
    let active = selectedPartIndex;
    for (const s of slots) {
      const co = allChangeovers[s.index];
      if (co && !changeovers[s.index]) active = co.newPartIndex; // switch at slot start
      map[s.index] = active;
      if (co && changeovers[s.index]) active = co.newPartIndex;
    }
    return map;
  }, [slots, selectedPartIndex, allChangeovers, changeovers]);

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
  const shiftPlannedTotal = useMemo(
    () => plannedTotalFor(visibleSlots, selectedLine, selectedPartIndex),
    [visibleSlots, selectedLine, selectedPartIndex]
  );

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
    for (const s of visibleSlots) {
      const co = changeovers[s.index];
      if (co) {
        const oldName = nameFor(co.oldPartIndex);
        const newName = nameFor(co.newPartIndex);
        minutesByName[oldName] = (minutesByName[oldName] ?? 0) + co.beforeMinutes;
        minutesByName[newName] = (minutesByName[newName] ?? 0) + co.afterMinutes;
        totalMinutes += co.beforeMinutes + co.afterMinutes;
      } else {
        const name = nameFor(activePartIndexBySlot[s.index] ?? selectedPartIndex);
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
  }, [selectedLine, visibleSlots, changeovers, activePartIndexBySlot, selectedPartIndex, shiftPlannedTotal]);

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
        setStartTimeText(defaultStartTimeText(key as 'A' | 'B'));
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

    // The start time stored when the session began — never re-derived from
    // the clock. Legacy sessions without it keep the full-shift schedule.
    const storedStart = sd.productionStartMinutesAbs;
    setSessionStartAbs(typeof storedStart === 'number' && Number.isFinite(storedStart) ? storedStart : null);

    // Keep the session's ORIGINAL production date — reopening the app or
    // resuming the session on a later day must never move its records to
    // today. Sessions started before the productionDate field existed derive
    // it from their original startedAt, and get it written back so it's
    // pinned from now on. Only when neither exists (shouldn't happen —
    // startedAt is written on create) is the current day used, and that is
    // pinned too, so Finalize can't pick a different date later.
    const storedDate = (sd as any).productionDate;
    let pd = resolveSessionProductionDate({ storedDate, startedAt: sd.startedAt });
    if (!pd) {
      console.warn('[restoreSession] session has no productionDate or startedAt — pinning the current production day', { docId });
      pd = productionDayKeyFor(Date.now());
    }
    sessionStartedAtMsRef.current = timestampToMillis(sd.startedAt);
    setProductionDate(pd);
    if (storedDate !== pd) {
      updateDoc(doc(db, 'activeSessions', docId), { productionDate: pd })
        .catch((e) => console.error('[restoreSession] failed to pin productionDate', e));
    }

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
    Object.entries(allChangeovers).forEach(([k, v]) => { coStr[k] = v; });

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

    const sessionData: Omit<ActiveSessionDoc, 'startedAt'> & { startedAt?: any; updatedAt: any } & {
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

      // new structured summaries. productionDate is deliberately NOT part
      // of this payload — it's pinned when the session starts and an update
      // must never overwrite it (see the create branch below).
      plannedProductionTotal: shiftPlannedTotal,
      totalDowntimeMinutes,
      totalRejections,
      stopsSummaryBySlot,
    };

    const docRef = doc(db, 'activeSessions', sessionLineId ?? selectedLineId);
    try {
      if (!sessionLineId) {
        // create doc (set startedAt and productionDate only first time) —
        // this is a genuinely new session, so its production day is pinned
        // here, from now.
        const pd = productionDate ?? productionDayKeyFor(Date.now());
        await setDoc(docRef, { ...sessionData, productionDate: pd, startedAt: serverTimestamp() });
        setSessionLineId(selectedLineId);
        setProductionDate(pd);
        sessionStartedAtMsRef.current = Date.now();
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

    // The ONLY place a session's production date is calculated from the
    // current time (persistSession's create branch aside) — see
    // resolveActiveSessionProductionDate for every later read.
    const startedMs = Date.now();
    const pd = productionDayKeyFor(startedMs);

    // Production Start Time: a valid time inside the shift, not in the
    // future, measured on the same production day the session is pinned to.
    const nowAbs = millisToProductionDayMinute(pd, startedMs);
    const startCheck = validateProductionStartTime(startTimeText, selectedShift, otHours, nowAbs);
    if (!startCheck.ok) {
      if (Platform.OS === 'web') window.alert(startCheck.error);
      else Alert.alert('Invalid production start time', startCheck.error);
      return;
    }
    const startAbs = startCheck.startAbs;
    const begin = () => beginSession(selectedLineId, startAbs, startedMs, pd);

    // An earlier time is allowed (data entered after production began), but
    // confirmed so it isn't a typo. Same web/native confirm split as
    // handleFinalizeSession — Alert buttons don't fire on react-native-web.
    if (nowAbs - startAbs > LATE_START_CONFIRM_MINUTES) {
      const message =
        `Production started at ${formatAbsMinutes24(startAbs)}, ${nowAbs - startAbs} minutes before the current time (${formatAbsMinutes24(nowAbs)}). ` +
        `Slots and targets will be counted from ${formatAbsMinutes24(startAbs)}.`;
      if (Platform.OS === 'web') {
        if (window.confirm(`Confirm production start time\n\n${message}`)) begin();
      } else {
        Alert.alert('Confirm production start time', message, [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Start Production', onPress: begin },
        ]);
      }
      return;
    }
    begin();
  };

  const beginSession = async (lineId: string, startAbs: number, startedMs: number, pd: string) => {
    setStartingProduction(true);
    // Planned total from the schedule for THIS start time (no changeovers or
    // deleted slots exist yet), rather than the last render's value.
    const plannedTotal = plannedTotalFor(buildSlots(selectedShift, otHours, [], startAbs), selectedLine, selectedPartIndex);
    try {
      const docRef = doc(db, 'activeSessions', lineId);
      await setDoc(docRef, {
        lineId,
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
        plannedProductionTotal: plannedTotal,
        productionStartMinutesAbs: startAbs,
        productionStartedAt: Timestamp.fromMillis(productionDayMinuteToMillis(pd, startAbs)),
        startedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      setSessionLineId(lineId);
      // Pinned for the lifetime of this session — every record it writes,
      // including Finalize after midnight/the cutover, uses this date.
      setProductionDate(pd);
      setSessionStartAbs(startAbs);
      sessionStartedAtMsRef.current = startedMs;
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

  // The production date this session's records belong to: the one pinned
  // in activeSessions/{lineId} when the session started, falling back to
  // the date pinned in state, then to the session's original startedAt.
  // Never the current time — a session finalized (or a slot saved) after
  // midnight / the 6:30 AM cutover keeps its original date. Throws if no
  // date can be resolved rather than guessing one.
  async function resolveActiveSessionProductionDate(lineId: string): Promise<string> {
    let storedDate: unknown;
    let startedAt: unknown;
    try {
      const snap = await getDoc(doc(db, 'activeSessions', lineId));
      if (snap.exists()) {
        const data = snap.data() as any;
        storedDate = data.productionDate;
        startedAt = data.startedAt;
      }
    } catch (e) {
      console.warn('[productionDate] could not read the active session — using the pinned date', e);
    }
    const pd =
      resolveSessionProductionDate({ storedDate, pinnedDate: productionDate, startedAt }) ??
      resolveSessionProductionDate({ startedAt: sessionStartedAtMsRef.current });
    if (!pd) throw new Error('Could not determine the production date of this session. Check your connection and try again.');
    return pd;
  }

  // ── Rejection counter on an already-saved slot ──────────────────────────
  // The counter stays editable after a slot is saved, but persistSession only
  // writes it to activeSessions, and Finalize skips saved slots — so a tap
  // after saving would never reach that slot's productionRecords doc, which
  // is what the QC dashboards read. Each tap marks its key; shortly after the
  // last tap, the `rejections` field (and updatedAt) of the slot's EXISTING
  // record is updated to the counter's value. Nothing else on the record is
  // touched, and no record is ever created here — an unsaved slot gets its
  // count when it's saved, exactly as before.
  const dirtyRejectionKeysRef = useRef<Set<string>>(new Set());
  const rejectionSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Line + shift the pending taps belong to, vs. the one on screen now. If
  // the supervisor switches line/shift (or Finalize resets the session)
  // before the sync runs, the pending taps are dropped rather than written
  // with another session's — or a reset — counter value.
  const rejectionSyncScopeRef = useRef<string | null>(null);
  const currentSyncScopeRef = useRef<string>('');
  currentSyncScopeRef.current = `${selectedLineId ?? ''}|${selectedShift}`;

  function queueRejectionSync(rejectKey: string) {
    const scope = `${selectedLineId ?? ''}|${selectedShift}`;
    if (rejectionSyncScopeRef.current !== scope) dirtyRejectionKeysRef.current.clear();
    rejectionSyncScopeRef.current = scope;
    dirtyRejectionKeysRef.current.add(rejectKey);
    if (rejectionSyncTimerRef.current) clearTimeout(rejectionSyncTimerRef.current);
    rejectionSyncTimerRef.current = setTimeout(() => {
      rejectionSyncTimerRef.current = null;
      syncSavedSlotRejections().catch((e) => console.warn('[rejections] could not update the saved slot record', e));
    }, 600);
  }

  async function syncSavedSlotRejections() {
    const keys = Array.from(dirtyRejectionKeysRef.current);
    dirtyRejectionKeysRef.current.clear();
    if (rejectionSyncScopeRef.current !== currentSyncScopeRef.current) return;
    // Same identity a slot Save writes (slotKey in the save handler).
    const lineId = selectedLineId;
    if (!keys.length || !lineId || !selectedShift) return;
    const prodDate = await resolveActiveSessionProductionDate(sessionLineId ?? lineId);
    for (const key of keys) {
      // Same key scheme as the cards: '3' → slot 3, '3:before' / '3:after'
      // → that half of a changeover slot.
      const [idxStr, seg] = key.split(':');
      const slotIndex = Number(idxStr);
      if (!Number.isInteger(slotIndex)) continue;
      // Counter cleared (session finalized / reset) — nothing to sync.
      if (!(key in rejectionsBySlotRef.current)) continue;
      const segment: SlotSegment = seg === 'before' || seg === 'after' ? seg : 'full';
      const id: ProductionSlotIdentity = { productionDate: prodDate, lineId, shift: selectedShift, slotIndex, segment };
      const recordKey = productionRecordId(id);
      const cachedDocId = resolvedRecordIdsRef.current.get(recordKey);
      let ref = cachedDocId ? doc(db, 'productionRecords', cachedDocId) : null;
      if (!ref) {
        const resolved = await resolveProductionRecordRef(id);
        if (!resolved.exists) continue; // slot not saved yet
        ref = resolved.ref;
        resolvedRecordIdsRef.current.set(recordKey, ref.id);
      }
      await updateDoc(ref, { rejections: rejectionsBySlotRef.current[key] ?? 0, updatedAt: serverTimestamp() });
    }
  }

  // Sums planned production (cycle time × FULL slot duration, ignoring
  // downtime — same figure as plannedProduction on each slot doc) and actual
  // output, across only the slots the supervisor actually entered data for.
  // Mirrors the exact "does this slot count" condition used when writing
  // productionRecords, so this total always matches what's really in the DB.
  function computeShiftTotals() {
    let planned = 0;
    let actual = 0;
    for (const s of slots) {
      const co = changeovers[s.index] ?? null;
      if (!co) {
        const produced = producedBySlot[s.index];
        if (produced != null) {
          planned += expectedParts(activePartIndexBySlot[s.index] ?? selectedPartIndex, s.productiveMinutes);
          actual += produced;
        }
      } else {
        const pb = producedSegment[`${s.index}:before`];
        const pa = producedSegment[`${s.index}:after`];
        if (pb != null) { planned += expectedParts(co.oldPartIndex, co.beforeMinutes); actual += pb; }
        if (pa != null) { planned += expectedParts(co.newPartIndex, co.afterMinutes); actual += pa; }
      }
    }
    return { planned, actual };
  }

  // Writes the whole shift's planned-vs-actual total once, when the
  // supervisor presses "Finalize & End Session" — the "total expected parts
  // of that shift" figure, saved once rather than re-derived from
  // productionRecords every time it's needed.
  // prodDate is the session's original production date, resolved once by
  // Finalize (see resolveActiveSessionProductionDate) so the summary always
  // matches the productionRecords written alongside it.
  async function saveShiftSummary(lineId: string, prodDate: string) {
    if (!selectedLine) return;
    const { planned, actual } = computeShiftTotals();
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

  // prodDate: the session's original production date (see
  // resolveActiveSessionProductionDate) — used for both the record IDs and
  // the productionDate field, never the time Finalize happens to run.
  async function submitUnsavedSlots(lineId: string, prodDate: string) {
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
      return expectedPartsFor(selectedLine?.parts?.[partIdx]?.cycleTimeSeconds ?? 0, minutes);
    }
    const slotKey = (slotIndex: number) => ({ productionDate: prodDate, lineId, shift: selectedShift, slotIndex });
    const slotId = (slotIndex: number, segment: SlotSegment): ProductionSlotIdentity => ({ ...slotKey(slotIndex), segment });
    const base = {
      shift: selectedShift,
      plant: selectedLine.plant ?? plant ?? null,
      workshop: selectedLine.workshop ?? workshop ?? null,
      division: selectedLine.division ?? division ?? null,
      lineId,
      lineName: selectedLine.lineName ?? null,
      operators: operators.map((o) => ({ name: o.name, code: o.code })),
      supervisor: { name: supervisorName, code: supervisorCode, uid: user?.uid ?? null },
      productionDate: prodDate,
      createdAt: serverTimestamp(),
    };

    // Same changeover rules as an individual save — refuse to write anything
    // if a changeover (e.g. one restored from an older session) is invalid.
    for (const co of Object.values(allChangeovers)) {
      if (!co || deletedSlotIndices.has(co.slotIndex)) continue;
      const error = changeoverError(co);
      if (error) throw new Error(`Changeover at ${formatAbsMinutesToAmPm(co.atAbs)}: ${error}`);
    }

    for (const s of slots) {
      if (s.isBreak) continue; // lunch — no production record
      if (savedSlotIndices.has(s.index)) continue;
      if (deletedSlotIndices.has(s.index)) continue; // deleted card — no record, no target
      const co = changeovers[s.index] ?? null;
      // The slot's real part (accounts for every changeover, including ones
      // in slots already saved and skipped above) — same map the cards use.
      const activePart = activePartIndexBySlot[s.index] ?? selectedPartIndex;
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
        await upsertProductionRecord(slotId(s.index, 'full'), {
          ...base,
          partName: selectedLine.parts?.[activePart]?.name ?? null,
          cycleTimeSeconds: selectedLine.parts?.[activePart]?.cycleTimeSeconds ?? null,
          slotIndex: s.index, slotLabel: s.label,
          slotStartMinutesAbs: s.startMinutesAbs, slotEndMinutesAbs: s.endMinutesAbs, hourStartMinutesAbs: s.hourStartAbs,
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
        }, resolvedRecordIdsRef.current);
        await removeSupersededProductionRecords(slotKey(s.index), 'full', resolvedRecordIdsRef.current);
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
          await upsertProductionRecord(slotId(s.index, 'before'), {
            ...base,
            partName: selectedLine.parts?.[co.oldPartIndex]?.name ?? null,
            cycleTimeSeconds: selectedLine.parts?.[co.oldPartIndex]?.cycleTimeSeconds ?? null,
            slotIndex: s.index,
            slotLabel: `${formatAbsMinutesToAmPm(s.startMinutesAbs)} - ${formatAbsMinutesToAmPm(co.atAbs)} — ${selectedLine.parts?.[co.oldPartIndex]?.name ?? 'Part'}`,
            slotStartMinutesAbs: s.startMinutesAbs, slotEndMinutesAbs: co.atAbs, hourStartMinutesAbs: s.hourStartAbs,
            slotDurationMinutes: co.atAbs - s.startMinutesAbs, productiveMinutes: prodBefore,
            expectedParts: expBeforeAuto,
            producedThisSlot: pb,
            lossParts: lossPartsBeforeAuto,
            lossTimeMinutes: lossTimeMinutes(co.oldPartIndex, lossPartsBeforeAuto),
            lossReasonCode: lossReasonBeforeAuto?.code ?? null,
            lossReasonLabel: lossReasonBeforeAuto?.label ?? null,
            lossReasonNote: lossReasonBeforeAuto?.note ?? null,
            rejections: rejectionsBySlot[`${s.index}:before`] ?? 0, stopEvents: stopEventsArr,
            changeoverInfo: co, partSegment: 'before',
          }, resolvedRecordIdsRef.current);
        }
        const pa = producedSegment[`${s.index}:after`];
        if (pa != null) {
          const expAfterAuto = frozenExpected(co.newPartIndex, co.afterMinutes);
          const lossPartsAfterAuto = Math.max(0, expAfterAuto - pa);
          const lossReasonAfterAuto = lossReasonBySlot[`${s.index}:after`] ?? null;
          await upsertProductionRecord(slotId(s.index, 'after'), {
            ...base,
            partName: selectedLine.parts?.[co.newPartIndex]?.name ?? null,
            cycleTimeSeconds: selectedLine.parts?.[co.newPartIndex]?.cycleTimeSeconds ?? null,
            slotIndex: s.index,
            slotLabel: `${formatAbsMinutesToAmPm(changeoverAfterStart(s, co))} - ${formatAbsMinutesToAmPm(s.endMinutesAbs)} — ${selectedLine.parts?.[co.newPartIndex]?.name ?? 'Part'}`,
            slotStartMinutesAbs: changeoverAfterStart(s, co), slotEndMinutesAbs: s.endMinutesAbs, hourStartMinutesAbs: s.hourStartAbs,
            slotDurationMinutes: s.endMinutesAbs - changeoverAfterStart(s, co), productiveMinutes: prodAfter,
            expectedParts: expAfterAuto,
            producedThisSlot: pa,
            lossParts: lossPartsAfterAuto,
            lossTimeMinutes: lossTimeMinutes(co.newPartIndex, lossPartsAfterAuto),
            lossReasonCode: lossReasonAfterAuto?.code ?? null,
            lossReasonLabel: lossReasonAfterAuto?.label ?? null,
            lossReasonNote: lossReasonAfterAuto?.note ?? null,
            rejections: rejectionsBySlot[`${s.index}:after`] ?? 0, stopEvents: stopEventsArr,
            changeoverInfo: co, partSegment: 'after',
          }, resolvedRecordIdsRef.current);
        }
        if (pb != null || pa != null) {
          await removeSupersededProductionRecords(slotKey(s.index), 'split', resolvedRecordIdsRef.current);
        }
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
          // Resolved ONCE from the session itself and passed to every
          // write below, so a session finalized after midnight / the 6:30 AM
          // cutover still files everything under the day it started.
          const prodDate = await resolveActiveSessionProductionDate(docId);
          console.log('[handleFinalizeSession] resolved session productionDate', prodDate);

          console.log('[handleFinalizeSession] calling submitUnsavedSlots(docId)…');
          await submitUnsavedSlots(docId, prodDate);
          console.log('[handleFinalizeSession] submitUnsavedSlots resolved');

          console.log('[handleFinalizeSession] calling saveShiftSummary(docId)…');
          await saveShiftSummary(docId, prodDate);
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
    // Start blank — the supervisor types the actual changeover time.
    setChangeTimeText('');
    setChangeModalVisible(true);
  };

  // Adding or removing a changeover changes how a slot is stored (one
  // 'full' record vs 'before' + 'after'), so a slot saved earlier must be
  // saved again — Finalize skips saved slots. The re-save replaces the old
  // record(s); see removeSupersededProductionRecords.
  function markSlotUnsaved(slotIndex: number) {
    setSavedSlotIndices((prev) => {
      if (!prev.has(slotIndex)) return prev;
      const next = new Set(prev);
      next.delete(slotIndex);
      return next;
    });
  }

  // Every OTHER changeover's interval (a single-time changeover is an
  // instant, start === end), for the overlap check.
  function otherChangeoverIntervals(slotIndex: number): TimeInterval[] {
    return Object.values(storedChangeovers)
      .filter((o): o is ChangeoverInfo => !!o && o.slotIndex !== slotIndex)
      .map((o) => ({ start: o.startAbs ?? o.atAbs, end: o.endAbs ?? o.atAbs }));
  }

  // Shared changeover rule check, used when a changeover is added AND again
  // before any record carrying it is written (individual save and Finalize),
  // so no save path can store a changeover that falls in lunch, clashes with
  // another changeover, or lies outside the shift.
  function changeoverError(co: ChangeoverInfo): string | null {
    return validateChangeoverInterval({
      interval: { start: co.startAbs ?? co.atAbs, end: co.endAbs ?? co.atAbs },
      slots: visibleSlots,
      otherIntervals: otherChangeoverIntervals(co.slotIndex),
      // Single-time changeovers are an instant; older sessions may still
      // hold start/end intervals, which are validated as intervals.
      allowInstant: true,
    });
  }

  // Resolves the typed changeover time to the slot it affects, or explains
  // why it can't be used. Shared by the live preview in the modal and by
  // Confirm, so what the supervisor sees is exactly what gets recorded.
  function resolveChangeoverEntry(text: string):
    | { ok: true; atAbs: number; slot: Slot; atSlotStart: boolean }
    | { ok: false; error: string } {
    const minuteOfDay = parseTimeInput(text);
    if (minuteOfDay == null) {
      return { ok: false, error: 'Enter the changeover time as HH:MM in 24-hour format (00–23 : 00–59), e.g. 10:20 or 14:05.' };
    }
    const atAbs = timeOfDayToShiftAbs(minuteOfDay, selectedShift);
    const placement = placeChangeoverTime(atAbs, visibleSlots, otherChangeoverIntervals(-1));
    if (!placement.ok) return placement;
    if (storedChangeovers[placement.slot.index]) {
      return { ok: false, error: `${placement.slot.label} already has a changeover. Remove it first if it needs correcting.` };
    }
    return { ok: true, atAbs, slot: placement.slot, atSlotStart: placement.atSlotStart };
  }

  const confirmChangeover = () => {
    try {
      if (changeModalNewPartIndex == null) {
        Alert.alert('Pick part', 'Select the new part first.');
        return;
      }

      // The manually entered time is the only source — the device clock is
      // never used here.
      const entry = resolveChangeoverEntry(changeTimeText);
      if (!entry.ok) {
        if (Platform.OS === 'web') window.alert(entry.error);
        else Alert.alert('Invalid changeover time', entry.error);
        return;
      }
      const { atAbs, slot, atSlotStart } = entry;

      // The part running in this slot before the changeover — accounts for
      // every earlier changeover (see activePartIndexBySlot).
      const oldIdx = activePartIndexBySlot[slot.index] ?? selectedPartIndex;
      if (oldIdx === changeModalNewPartIndex) {
        Alert.alert('Same part', `${selectedLine?.parts?.[oldIdx]?.name ?? 'This part'} is already running in ${slot.label}. Pick a different part.`);
        return;
      }
      // Stored in the existing changeover shape: one time, so start === end
      // and duration 0. Segment minutes/expected parts are recomputed from
      // the shared schedule by the `allChangeovers` memo; stored here only
      // as a snapshot.
      const info: ChangeoverInfo = {
        slotIndex: slot.index, atAbs, startAbs: atAbs, endAbs: atAbs, durationMinutes: 0,
        oldPartIndex: oldIdx, newPartIndex: changeModalNewPartIndex,
        beforeMinutes: 0, afterMinutes: 0, expectedBefore: 0, expectedAfter: 0,
      };

      setChangeovers((p) => ({ ...p, [slot.index]: info }));
      setProducedSegment((p) => ({ ...p, [`${slot.index}:before`]: null, [`${slot.index}:after`]: null }));
      markSlotUnsaved(slot.index);
      setChangeModalVisible(false);
      // Persist immediately
      setTimeout(() => persistSession(), 100);
      Alert.alert(
        'Changeover recorded',
        atSlotStart
          ? `${formatAbsMinutesToAmPm(atAbs)} — ${slot.label} runs entirely on the new part.`
          : `${formatAbsMinutesToAmPm(atAbs)} — ${slot.label} split into ${formatAbsMinutesToAmPm(slot.startMinutesAbs)}–${formatAbsMinutesToAmPm(atAbs)} and ${formatAbsMinutesToAmPm(atAbs)}–${formatAbsMinutesToAmPm(slot.endMinutesAbs)}.`
      );
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
    return expectedPartsFor(selectedLine?.parts?.[partIdx]?.cycleTimeSeconds ?? 0, minutes);
  }

  // Where a changeover slot's AFTER segment starts: the changeover's end
  // time, or the slot's own end when the changeover runs past it.
  function changeoverAfterStart(slot: Slot, co: ChangeoverInfo) {
    return changeoverSegmentWindows(
      { start: slot.startMinutesAbs, end: slot.endMinutesAbs },
      { start: co.startAbs ?? co.atAbs, end: co.endAbs ?? co.atAbs }
    ).after.start;
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
  const buildBaseDoc = (prodDate: string) => ({
    shift: selectedShift, plant: selectedLine?.plant ?? plant ?? null, workshop: selectedLine?.workshop ?? workshop ?? null,
    division: selectedLine?.division ?? division ?? null, lineId: selectedLineId, lineName: selectedLine?.lineName ?? null,
    operators: operators.map((o) => ({ name: o.name, code: o.code })),
    supervisor: { name: supervisorName, code: supervisorCode, uid: user?.uid ?? null },
    productionDate: prodDate,
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
      // Same part and minutes saveSlot uses, so the loss-reason prompt
      // matches the loss that actually gets stored.
      const expParts = expectedParts(activePartIndexBySlot[slot.index] ?? selectedPartIndex, slot.productiveMinutes);
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

    if (!selectedLineId) { Alert.alert('No line', 'Line not set.'); return; }
    if (savingSlotsRef.current.has(slot.index)) return; // a save for this slot is already in flight

    if (slot.isBreak) return; // lunch — nothing to record

    const co = changeovers[slot.index] ?? null;
    if (co) {
      const error = changeoverError(co);
      if (error) { Alert.alert('Invalid changeover time', `${error}\n\nRemove this changeover and add it again with valid times.`); return; }
    }
    savingSlotsRef.current.add(slot.index);
    setSaving(true);
    try {
      // The session's original production date (not today's) — the same
      // date Finalize uses, so a slot saved now and the remaining slots
      // finalized after the cutover share one date and one set of IDs.
      const prodDate = await resolveActiveSessionProductionDate(sessionLineId ?? selectedLineId);
      const baseDoc = buildBaseDoc(prodDate);
      const slotKey = { productionDate: prodDate, lineId: selectedLineId, shift: selectedShift, slotIndex: slot.index };
      const slotId = (segment: SlotSegment): ProductionSlotIdentity => ({ ...slotKey, segment });
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
        await upsertProductionRecord(slotId('full'), {
          ...baseDoc,
          partName: selectedLine.parts?.[activePart]?.name ?? null,
          cycleTimeSeconds: selectedLine.parts?.[activePart]?.cycleTimeSeconds ?? null,
          slotIndex: slot.index, slotLabel: slot.label,
          slotStartMinutesAbs: slot.startMinutesAbs, slotEndMinutesAbs: slot.endMinutesAbs, hourStartMinutesAbs: slot.hourStartAbs,
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
        }, resolvedRecordIdsRef.current);
        await removeSupersededProductionRecords(slotKey, 'full', resolvedRecordIdsRef.current);
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
        await upsertProductionRecord(slotId('before'), {
          ...baseDoc,
          partName: selectedLine.parts?.[co.oldPartIndex]?.name ?? null,
          cycleTimeSeconds: selectedLine.parts?.[co.oldPartIndex]?.cycleTimeSeconds ?? null,
          slotIndex: slot.index,
          slotLabel: `${formatAbsMinutesToAmPm(slot.startMinutesAbs)} - ${formatAbsMinutesToAmPm(co.atAbs)} — ${selectedLine.parts?.[co.oldPartIndex]?.name ?? 'Part'}`,
          slotStartMinutesAbs: slot.startMinutesAbs, slotEndMinutesAbs: co.atAbs, hourStartMinutesAbs: slot.hourStartAbs,
          slotDurationMinutes: co.atAbs - slot.startMinutesAbs, productiveMinutes: prodBefore,
          expectedParts: expBefore,
          producedThisSlot: pb,
          lossParts: lossPartsBefore,
          lossTimeMinutes: lossTimeMinutes(co.oldPartIndex, lossPartsBefore),
          lossReasonCode: lossReasonBefore?.code ?? null,
          lossReasonLabel: lossReasonBefore?.label ?? null,
          lossReasonNote: lossReasonBefore?.note ?? null,
          rejections: rejectionsBySlot[`${slot.index}:before`] ?? 0, stopEvents: stopEventsArr,
          changeoverInfo: co, partSegment: 'before',
        }, resolvedRecordIdsRef.current);
        await upsertProductionRecord(slotId('after'), {
          ...baseDoc,
          partName: selectedLine.parts?.[co.newPartIndex]?.name ?? null,
          cycleTimeSeconds: selectedLine.parts?.[co.newPartIndex]?.cycleTimeSeconds ?? null,
          slotIndex: slot.index,
          slotLabel: `${formatAbsMinutesToAmPm(changeoverAfterStart(slot, co))} - ${formatAbsMinutesToAmPm(slot.endMinutesAbs)} — ${selectedLine.parts?.[co.newPartIndex]?.name ?? 'Part'}`,
          slotStartMinutesAbs: changeoverAfterStart(slot, co), slotEndMinutesAbs: slot.endMinutesAbs, hourStartMinutesAbs: slot.hourStartAbs,
          slotDurationMinutes: slot.endMinutesAbs - changeoverAfterStart(slot, co), productiveMinutes: prodAfter,
          expectedParts: expAfter,
          producedThisSlot: pa,
          lossParts: lossPartsAfter,
          lossTimeMinutes: lossTimeMinutes(co.newPartIndex, lossPartsAfter),
          lossReasonCode: lossReasonAfter?.code ?? null,
          lossReasonLabel: lossReasonAfter?.label ?? null,
          lossReasonNote: lossReasonAfter?.note ?? null,
          rejections: rejectionsBySlot[`${slot.index}:after`] ?? 0, stopEvents: stopEventsArr,
          changeoverInfo: co, partSegment: 'after',
        }, resolvedRecordIdsRef.current);
        await removeSupersededProductionRecords(slotKey, 'split', resolvedRecordIdsRef.current);
        Alert.alert('Saved', `Slot ${slot.label} saved (split).`);
        setSavedSlotIndices((prev) => new Set(prev).add(slot.index));
      }
      // Persist session after save so Firestore knows the current data
      persistSession();
    } catch (err) {
      console.error('saveSlot', err);
      Alert.alert('Error', 'Could not save slot. Your entries are kept — tap Save Slot to retry.');
    } finally {
      savingSlotsRef.current.delete(slot.index);
      setSaving(savingSlotsRef.current.size > 0);
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

          {/* PRODUCTION START TIME — the actual start, typed by the supervisor (24-hour) */}
          <View style={{ width: 180 }}>
            <Text style={styles.label}>Production Start Time</Text>
            <TextInput
              style={styles.input}
              value={startTimeText}
              onChangeText={(t) => setStartTimeText(formatTimeInput(t))}
              placeholder="HH:MM"
              placeholderTextColor="#5C6670"
              keyboardType="number-pad"
              maxLength={5}
            />
          </View>
          {(() => {
            // Live preview: the first slot this start produces, or why the
            // time can't be used. The future-time check runs against the
            // clock here and again when Start Production is pressed.
            if (startTimeText.replace(/\D/g, '').length < 4) {
              return (
                <Text style={[styles.muted, { marginTop: 8 }]}>
                  24-hour time production actually started, e.g. 1415 → 14:15.
                </Text>
              );
            }
            const nowMsSetup = Date.now();
            const pdSetup = productionDayKeyFor(nowMsSetup);
            const check = validateProductionStartTime(startTimeText, selectedShift, otHours, millisToProductionDayMinute(pdSetup, nowMsSetup));
            if (!check.ok) return <Text style={[styles.muted, { marginTop: 8, color: '#F0A8A8' }]}>{check.error}</Text>;
            const first = slots[0];
            return first ? (
              <Text style={[styles.muted, { marginTop: 8 }]}>
                First slot: {formatAbsMinutesToAmPm(first.startMinutesAbs)} – {formatAbsMinutesToAmPm(first.endMinutesAbs)}
                {first.isBreak ? ' (lunch break)' : ` · ${first.productiveMinutes} productive min`}
              </Text>
            ) : null;
          })()}

          {/* START BUTTON */}
          <Pressable
            style={({ pressed }) => [
              styles.startButton,
              (startingProduction || pressed) && styles.startButtonPressed,
              !setupStartCheck.ok && { opacity: 0.45 },
            ]}
            onPress={handleStartProduction}
            disabled={startingProduction || !setupStartCheck.ok}
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
                // The entered production start when the session has one,
                // otherwise when the session document was created.
                const startedMs = timestampToMillis(sd.productionStartedAt) ?? timestampToMillis(sd.startedAt);
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
              {sessionStartAbs != null ? ` · Production start: ${formatAbsMinutes24(sessionStartAbs)}` : ''}
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
              <Text style={[styles.addChangeText, isLineStopped && { color: '#5C6670' }]}>Add</Text>
            </Pressable>
          </View>
          {Object.values(allChangeovers).length === 0 ? (
            <Text style={styles.muted}>No changeovers</Text>
          ) : Object.values(allChangeovers).map((co) => co && (
            <View key={co.slotIndex} style={styles.changeRow}>
              <Text style={{ color: '#ECEFF2', fontWeight: '700', fontSize: 12 }}>
                {slots.find((s) => s.index === co.slotIndex)?.label ?? `Slot ${co.slotIndex}`}
              </Text>
              <Text style={{ color: '#8A96A3', fontSize: 12, flex: 1, marginLeft: 8 }}>
                {selectedLine?.parts?.[co.oldPartIndex]?.name ?? '?'} → {selectedLine?.parts?.[co.newPartIndex]?.name ?? '?'} · {formatAbsMinutesToAmPm(co.startAbs ?? co.atAbs)}{(co.endAbs ?? co.atAbs) > (co.startAbs ?? co.atAbs) ? ` – ${formatAbsMinutesToAmPm(co.endAbs ?? co.atAbs)} (${co.durationMinutes ?? 0} min)` : ''}
              </Text>
              <Pressable onPress={() => { const idx = co.slotIndex; setChangeovers((p) => { const c = { ...p }; delete c[idx]; return c; }); markSlotUnsaved(idx); setTimeout(() => persistSession(), 100); }} style={styles.removeChangeBtn}>
                <Ionicons name="close" size={16} color="#F2A93B" />
              </Pressable>
            </View>
          ))}
        </View>

        <Text style={styles.sectionLabel}>HOURLY SLOTS</Text>

        {/* Slot cards */}
        {(() => {
          const cards: JSX.Element[] = [];

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
                        <Pressable onPress={() => { setRejectionsBySlot((p) => ({ ...p, [rejectKey]: Math.max(0, (p[rejectKey] ?? 0) - 1) })); setTimeout(() => persistSession(), 100); queueRejectionSync(rejectKey); }} style={[styles.smallBtn, disabled && styles.disabledBtn]} disabled={disabled}><Text style={styles.smallBtnText}>−</Text></Pressable>
                        <Text style={{ color: '#ECEFF2', fontWeight: '700', minWidth: 36, textAlign: 'center' }}>{rejectionsBySlot[rejectKey] ?? 0}</Text>
                        <Pressable onPress={() => { setRejectionsBySlot((p) => ({ ...p, [rejectKey]: (p[rejectKey] ?? 0) + 1 })); setTimeout(() => persistSession(), 100); queueRejectionSync(rejectKey); }} style={[styles.smallBtn, disabled && styles.disabledBtn]} disabled={disabled}><Text style={styles.smallBtnText}>+</Text></Pressable>
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

          // Actual production window, shown when it differs from the nominal
          // hour in the label (the slots either side of lunch). A slot
          // clipped to the production start already shows it in its label.
          const windowPrefix = (s: Slot) =>
            !s.startAdjusted && (s.startMinutesAbs !== s.hourStartAbs || s.endMinutesAbs !== s.hourEndAbs)
              ? `${formatAbsMinutesToAmPm(s.startMinutesAbs)}–${formatAbsMinutesToAmPm(s.endMinutesAbs)} · `
              : '';

          for (const s of visibleSlots) {
            const co = changeovers[s.index] ?? null;

            if (s.isBreak) {
              cards.push(
                <View key={`slot-${s.index}`} style={[styles.slotCard, { opacity: 0.6 }]}>
                  <View style={styles.slotHeader}>
                    <Text style={styles.slotLabel}>{s.label}</Text>
                    <Text style={styles.muted}>0 min prod.</Text>
                  </View>
                  <Text style={styles.muted}>
                    Lunch break {formatAbsMinutesToAmPm(LUNCH_BREAK.start)} – {formatAbsMinutesToAmPm(LUNCH_BREAK.end)} · no production
                  </Text>
                </View>
              );
              continue;
            }

            if (!co) {
              const activePart = activePartIndexBySlot[s.index] ?? selectedPartIndex;
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
                minutesLabel: `${windowPrefix(s)}${productive} min prod.`,
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
                timeLabel: `${formatAbsMinutesToAmPm(changeoverAfterStart(s, co))} – ${formatAbsMinutesToAmPm(s.endMinutesAbs)}`,
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
            {/* Actual changeover time, typed by the supervisor (24-hour) */}
            <View style={{ marginTop: 10 }}>
              <Text style={styles.modalLabel}>Changeover time (24-hour)</Text>
              <TextInput
                value={changeTimeText}
                onChangeText={(t) => setChangeTimeText(formatTimeInput(t))}
                placeholder="HH:MM"
                placeholderTextColor="#5C6670"
                keyboardType="number-pad"
                maxLength={5}
                style={styles.input}
              />
            </View>
            {(() => {
              // Live preview: what the entered time will do, or why it can't
              // be used. Nothing shown until four digits are entered.
              if (changeTimeText.replace(/\D/g, '').length < 4) {
                return (
                  <Text style={[styles.muted, { marginTop: 8 }]}>
                    Type 4 digits, e.g. 1020 → 10:20. No changeover during lunch ({formatAbsMinutesToAmPm(LUNCH_BREAK.start)} – {formatAbsMinutesToAmPm(LUNCH_BREAK.end)}).
                  </Text>
                );
              }
              const entry = resolveChangeoverEntry(changeTimeText);
              if (!entry.ok) return <Text style={[styles.muted, { marginTop: 8, color: '#F0A8A8' }]}>{entry.error}</Text>;
              const { atAbs, slot, atSlotStart } = entry;
              return (
                <Text style={[styles.muted, { marginTop: 8 }]}>
                  {formatAbsMinutesToAmPm(atAbs)} · {atSlotStart
                    ? `${slot.label} will run entirely on the new part.`
                    : `${slot.label} splits into ${formatAbsMinutesToAmPm(slot.startMinutesAbs)}–${formatAbsMinutesToAmPm(atAbs)} (current part) and ${formatAbsMinutesToAmPm(atAbs)}–${formatAbsMinutesToAmPm(slot.endMinutesAbs)} (new part).`}
                </Text>
              );
            })()}
            <View style={styles.modalFooter}>
              <Pressable onPress={() => setChangeModalVisible(false)} style={styles.modalBtn}><Text style={styles.modalBtnText}>Cancel</Text></Pressable>
              <Pressable onPress={confirmChangeover} style={[styles.modalBtn, styles.modalConfirmBtn]}><Text style={[styles.modalBtnText, styles.modalConfirmBtnText]}>Confirm</Text></Pressable>
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