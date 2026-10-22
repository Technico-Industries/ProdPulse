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
  AppState,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import {
  collection,
  getDocs,
  serverTimestamp,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  Timestamp,
  onSnapshot,
  runTransaction,
} from 'firebase/firestore';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { db } from '../services/firebase';
import { useAuthStore } from '../stores/authStore';
import {
  DraftScope,
  ProductionSlotIdentity,
  RestoreRecord,
  SlotSegment,
  StopLike,
  SyncConflict,
  SyncState,
  createDraft,
  createDraftStore,
  createSessionWriteQueue,
  emptySyncState,
  fieldsForRecordUpdate,
  isCompleteScope,
  planSessionSync,
  productionRecordId,
  resolveRestore,
  saveDraft,
  serializeLossReasons,
  serializeStops,
  syncRetryDelayMs,
  syncStatesEqual,
  threeWayMerge,
  withTimeout,
} from '../utils/productionDraft';
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
import {
  RecordStopEvent,
  completeRunningStops,
  formatElapsedSince,
  freezeRunningStops,
  isAnyStopRunning,
  stopDurationMinutes,
  stopEventsForWindow,
  stopIdOf,
} from '../utils/downtime';

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

// startAbs/endAbs are epoch ms (not schedule minutes, despite the name) —
// startAbs is persisted the moment the line is stopped and is the source of
// truth for the running timer and the final duration (see utils/downtime).
type StopEvent = {
  // Stable interval id, `stop-<startAbs>`. Missing on older stops — use
  // stopIdOf(), which derives the same value.
  id?: string;
  reason: string;
  startAbs: number;
  endAbs?: number;
  durationMinutes?: number;
  running?: boolean;
  // Firestore doc id of the lineBreakdowns record this stop created (maintenance
  // stops only). Each stop gets its OWN auto-id document instead of a
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
  // Added for draft persistence / restore (all optional — older session
  // docs don't have them):
  lossReasonBySlot?: Record<string, { code: string; label: string; note: string | null }>;
  savedSlotIndices?: number[];   // slots whose productionRecords write AND session sync succeeded
  clientUpdatedAtMs?: number;    // device time of the last write (informational)
  sessionInstanceId?: string;    // identifies this run of the line's session (draft scope)
  // Multi-device sync (all optional — older session docs don't have them):
  revision?: number;             // bumped by one on every sync (in a transaction)
  syncConflicts?: Record<string, SyncConflict | null>; // values not kept in a merge (null = dismissed)
  updatedBy?: { uid: string | null; deviceId: string | null };
}

// Thrown inside a sync transaction when the session doc is gone (finalized
// elsewhere) or belongs to a new run of the line's session.
class SessionGoneError extends Error {
  constructor(public kind: 'finalized' | 'replaced') {
    super(kind);
  }
}

// A random id per app install (per browser profile on web), recorded on
// syncs and conflicts so a supervisor can tell their devices apart.
const DEVICE_ID_KEY = 'prodpulse.deviceId';
let deviceIdPromise: Promise<string> | null = null;
function getDeviceId(): Promise<string> {
  deviceIdPromise ??= (async () => {
    try {
      const existing = await AsyncStorage.getItem(DEVICE_ID_KEY);
      if (existing) return existing;
      const id = `dev-${newSessionInstanceId()}`;
      await AsyncStorage.setItem(DEVICE_ID_KEY, id);
      return id;
    } catch {
      return `dev-${newSessionInstanceId()}`;
    }
  })();
  return deviceIdPromise;
}

// Session-save timing: local draft shortly after the last change (cheap,
// on-device), server write after a short pause so typing a number is one
// write, not one per keystroke. A server write that hasn't settled in
// SESSION_WRITE_TIMEOUT_MS is reported as not synced (the draft is kept).
const DRAFT_SAVE_DEBOUNCE_MS = 300;
const SESSION_SAVE_DEBOUNCE_MS = 1200;
const SESSION_WRITE_TIMEOUT_MS = 15000;
const RESTORE_RECORDS_TIMEOUT_MS = 10000;

const draftStore = createDraftStore(AsyncStorage);

function newSessionInstanceId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// A start time entered more than this many minutes before "now" asks the
// supervisor to confirm it (late data entry is allowed, but should be deliberate).
const LATE_START_CONFIRM_MINUTES = 10;

// ─── Production record upsert ─────────────────────────────────────────────────
// One productionRecords doc per logical slot: re-saving a slot (or Finalize
// writing a slot that was already saved) updates that doc instead of adding
// another. A slot is identified by productionDate + lineId + shift +
// slotIndex + segment ('full' for a normal slot, 'before'/'after' for the
// two halves of a changeover slot). SlotSegment, ProductionSlotIdentity and
// the deterministic productionRecordId() live in utils/productionDraft.

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
// `keepExistingWhenNull`: fields that, when null here, are left out of an
// UPDATE so the stored value is kept (a new record still gets them as null).
async function upsertProductionRecord(
  id: ProductionSlotIdentity,
  data: Record<string, any>,
  resolved: Map<string, string>,
  options: { keepExistingWhenNull?: string[] } = {}
) {
  const { createdAt: _createdAt, ...fields } = data;
  const updateFields = fieldsForRecordUpdate(fields, options.keepExistingWhenNull);
  const key = productionRecordId(id);
  const cachedDocId = resolved.get(key);
  if (cachedDocId) {
    await setDoc(doc(db, 'productionRecords', cachedDocId), { ...updateFields, updatedAt: serverTimestamp() }, { merge: true });
    return;
  }
  const { ref, exists } = await resolveProductionRecordRef(id);
  if (exists) {
    await setDoc(ref, { ...updateFields, updatedAt: serverTimestamp() }, { merge: true });
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
  // Mirrors savedSlotIndices synchronously — every change goes through
  // applySavedSlots, so a session snapshot built right after a save sees it.
  const savedSlotIndicesRef = useRef<Set<number>>(new Set());
  const applySavedSlots = (next: Set<number>) => {
    savedSlotIndicesRef.current = next;
    setSavedSlotIndices(next);
  };
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
  // Clears the active session from this screen (nothing is written).
  const resetSessionState = () => {
    clearSaveTimers();
    setPhase('setup');
    setSessionLineId(null);
    setProducedBySlot({});
    setRejectionsBySlot({});
    setStopsBySlot({});
    stopsBySlotRef.current = {};
    setStopSync('idle');
    pendingResumeRef.current = null;
    setChangeovers({});
    setProducedSegment({});
    lossReasonBySlotRef.current = {};
    setLossReasonBySlot({});
    applySavedSlots(new Set());
    setDeletedSlotIndices(new Set());
    setProductionDate(null);
    setSessionStartAbs(null);
    setStartTimeText(defaultStartTimeText(selectedShift));
    sessionInstanceRef.current = null;
    confirmedRevisionRef.current = revisionRef.current;
    setSessionSync('saved');
    setRestoreNotice(null);
    clearRetryTimer();
    syncFailuresRef.current = 0;
    serverBaseRef.current = null;
    remoteEndedRef.current = null;
    setRemoteEnded(null);
    syncConflictsRef.current = {};
    setSyncConflicts({});
    setLastSyncedAtMs(null);
  };

  // Leaving an active session first pushes any unsaved change to the server
  // (and waits for a save already in flight). If that fails, the entries
  // stay in the on-device draft, and the supervisor decides whether to leave.
  const leavingRef = useRef(false);
  const goBackToProduction = async () => {
    if (phase === 'active') {
      if (leavingRef.current) return;
      // Ended on another device: nothing can be saved to it any more (the
      // device draft keeps whatever hadn't synced).
      if (remoteEndedRef.current) {
        resetSessionState();
        return;
      }
      if (savingSlotsRef.current.size > 0) {
        notify('Slot still saving', 'Wait for the slot save to finish before leaving this session.');
        return;
      }
      leavingRef.current = true;
      try {
        const ok = hasPendingChanges() ? await flushSessionNow() : true;
        await sessionQueueRef.current.idle();
        if (!ok) {
          const leave = await confirmAsync(
            'Changes not saved to server',
            'Your latest entries could not be saved to the server, so other devices can\'t see them yet. They are kept on this device and will be synced when you reopen this session on this device. Leave anyway?',
            'Leave'
          );
          if (!leave) return;
        }
        resetSessionState();
      } finally {
        leavingRef.current = false;
      }
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
  // Latest reasons, also updated synchronously by confirmLossReason so the
  // save it resumes sees the reason just picked (state only updates on the
  // next render, and the resumed callback is from an earlier one).
  const lossReasonBySlotRef = useRef<Record<string, LossReason | undefined>>({});
  lossReasonBySlotRef.current = lossReasonBySlot;
  const [lossModalVisible, setLossModalVisible] = useState(false);
  const [lossModalKey, setLossModalKey] = useState<string | null>(null);
  const [lossModalAmount, setLossModalAmount] = useState(0);
  const [lossModalCode, setLossModalCode] = useState<string | null>(null);
  const [lossModalNote, setLossModalNote] = useState('');
  // Set right before opening the loss modal so Confirm can resume whichever
  // save attempt triggered it (a changeover slot may need two reasons before
  // it can actually save).
  const pendingAfterLossRef = useRef<(() => void) | null>(null);

  // ── Live timer — display refresh only. Elapsed downtime is always
  // nowMs - the stop's persisted startAbs, never a count of ticks.
  const [nowMs, setNowMs] = useState(Date.now());
  const intervalRef = useRef<number | null>(null);

  // ── Stop / Resume persistence. A stop or resume is only confirmed once
  // its activeSessions write resolves: 'saving' while in flight, 'error' if
  // it failed (the local stop is kept so no downtime is lost, and the card
  // offers a retry).
  const [stopSync, setStopSync] = useState<'idle' | 'saving' | 'error'>('idle');
  // Synchronous guard against a second Stop/Resume tap before the first
  // write settles — state only updates after the next render.
  const stopActionBusyRef = useRef(false);
  // A Resume that hasn't been saved yet: which stop it closes and when it
  // was first tapped. A retry reuses that time, so the saved duration is the
  // real one no matter how long the retry takes.
  const pendingResumeRef = useRef<{ slotIndex: number; stopId: string; endMs: number } | null>(null);

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

  // ── Session persistence (see persistSession / the autosave effect)
  // Every write of activeSessions/{lineId} goes through this queue: one at a
  // time, each built from the CURRENT state when it starts, so an older
  // snapshot can never overwrite a newer one.
  const sessionQueueRef = useRef(createSessionWriteQueue());
  // Bumped on every change to persisted session data; confirmedRevisionRef
  // is the highest revision the server has accepted. Pending = they differ.
  const revisionRef = useRef(0);
  const confirmedRevisionRef = useRef(0);
  const sessionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // activeSessions.sessionInstanceId (or `startedAt:<ms>` for older
  // sessions) — part of the local draft's scope.
  const sessionInstanceRef = useRef<string | null>(null);
  // Set while Finalize runs: no session write may land during/after it.
  const finalizingRef = useRef(false);
  // Bumped whenever a session is started or restored; the autosave effect
  // treats that render as "loaded", not as an edit (unless the restore
  // merged in data the server doesn't have yet — syncAfterRestoreRef).
  const [restoreToken, setRestoreToken] = useState(0);
  const restoreTokenSeenRef = useRef(0);
  const syncAfterRestoreRef = useRef(false);
  const [sessionSync, setSessionSync] = useState<'saved' | 'pending' | 'error'>('saved');
  const [restoreNotice, setRestoreNotice] = useState<string | null>(null);
  const [restoringSession, setRestoringSession] = useState(false);
  const openingSessionRef = useRef(false);

  // ── Multi-device sync
  // The server copy this device last synced (revision + data) — the base of
  // the three-way merge when another device synced in between.
  const serverBaseRef = useRef<{ revision: number; state: SyncState } | null>(null);
  const deviceIdRef = useRef<string | null>(null);
  useEffect(() => { getDeviceId().then((id) => { deviceIdRef.current = id; }); }, []);
  const syncFailuresRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Whether the last sync brought in changes from another device.
  const lastSyncMergedRemoteRef = useRef(false);
  const [lastSyncedAtMs, setLastSyncedAtMs] = useState<number | null>(null);
  // Set once the session doc is finalized/replaced on another device.
  const remoteEndedRef = useRef<'finalized' | 'replaced' | null>(null);
  const [remoteEnded, setRemoteEnded] = useState<'finalized' | 'replaced' | null>(null);
  const [syncConflicts, setSyncConflicts] = useState<Record<string, SyncConflict | null>>({});
  const syncConflictsRef = useRef<Record<string, SyncConflict | null>>({});
  syncConflictsRef.current = syncConflicts;

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

  // Everything a session write reads, refreshed every render. Session writes
  // run from timers, the write queue and lifecycle listeners — reading this
  // ref (never a render's closure) is what keeps them from writing stale data.
  const latestRef = useRef({
    phase, sessionLineId, selectedLineId, selectedLine, plant, workshop, division, selectedShift, otHours,
    selectedPartIndex, supervisorName, supervisorCode, operators, producedBySlot, rejectionsBySlot, producedSegment,
    allChangeovers, deletedSlotIndices, productionDate, shiftPlannedTotal, uid: user?.uid ?? null,
  });
  latestRef.current = {
    phase, sessionLineId, selectedLineId, selectedLine, plant, workshop, division, selectedShift, otHours,
    selectedPartIndex, supervisorName, supervisorCode, operators, producedBySlot, rejectionsBySlot, producedSegment,
    allChangeovers, deletedSlotIndices, productionDate, shiftPlannedTotal, uid: user?.uid ?? null,
  };

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

  // ── Live timer management. The interval only re-renders the display; on
  // start (incl. a restored stopped session) and whenever the app returns to
  // the foreground the clock is re-read at once, so the timer shows the full
  // time since the persisted stop, including time the app was closed.
  useEffect(() => {
    if (anyStopRunning) {
      setNowMs(Date.now());
      if (!intervalRef.current) {
        intervalRef.current = setInterval(() => setNowMs(Date.now()), 1000) as unknown as number;
      }
    } else {
      if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
    }
    const appStateSub = anyStopRunning
      ? AppState.addEventListener('change', (st) => { if (st === 'active') setNowMs(Date.now()); })
      : null;
    return () => {
      appStateSub?.remove();
      if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
    };
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
        // Already showing this session (e.g. restoreSession just set this
        // same line) — don't load and restore it a second time.
        const cur = latestRef.current;
        if (cur.phase === 'active' && cur.sessionLineId === selectedLineId) return;
        const snap = await getDoc(doc(db, 'activeSessions', selectedLineId));
        if (!mounted) return;
        if (snap.exists()) {
          const sd = snap.data() as ActiveSessionDoc;
          await openSession(sd, snap.id);
        }
      } catch (e) {
        console.error('[restore on select] ', e);
      }
    })();
    return () => { mounted = false; };
  }, [selectedLineId, allLines]);

  // "Continue active session" card. Always restores from the CURRENT
  // activeSessions doc — the list is loaded once when the screen opens, so
  // its copy can be missing a stop/resume (or anything else) saved since,
  // and restoring it would overwrite that on the next save.
  const continueSession = async (docId: string) => {
    try {
      const snap = await getDoc(doc(db, 'activeSessions', docId));
      if (!snap.exists()) {
        Alert.alert('Session ended', 'This session has already been finalized.');
        loadActiveSessions();
        return;
      }
      await openSession(snap.data() as ActiveSessionDoc, snap.id);
    } catch (e) {
      console.error('[continueSession]', e);
      Alert.alert('Could not open session', 'The latest session data could not be loaded. Check your connection and try again.');
    }
  };

  // The production date a stored session belongs to (same rule restoreSession
  // pins): its stored productionDate, else derived from its startedAt.
  function storedSessionProductionDate(sd: ActiveSessionDoc): string | null {
    return resolveSessionProductionDate({ storedDate: (sd as any).productionDate, startedAt: sd.startedAt });
  }

  type RestorePlan = {
    state: SyncState;
    base: SyncState;
    baseRevision: number;
    sessionInstance: string | null;
    needsSync: boolean;
    notice: string | null;
  };

  // Opens a stored session: loads this device's draft and the session's saved
  // productionRecords FIRST, merges them (precedence: see
  // utils/productionDraft resolveRestore), and only then shows the session —
  // so nothing loaded late can overwrite what the supervisor types. Opening
  // never writes production records.
  async function openSession(sd: ActiveSessionDoc, docId: string) {
    const cur = latestRef.current;
    if (cur.phase === 'active' && cur.sessionLineId === docId) return;
    if (openingSessionRef.current) return;
    openingSessionRef.current = true;
    setRestoringSession(true);
    try {
      let plan: RestorePlan | null = null;
      try {
        plan = await loadRestorePlan(sd, docId);
      } catch (e) {
        console.warn('[openSession] could not merge draft / saved records — opening the server copy as is', e);
      }
      restoreSession(sd, allLines, docId, plan);
    } finally {
      openingSessionRef.current = false;
      setRestoringSession(false);
    }
  }

  async function loadRestorePlan(sd: ActiveSessionDoc, docId: string): Promise<RestorePlan> {
    const pd = storedSessionProductionDate(sd);
    const startedAtMs = timestampToMillis(sd.startedAt);
    const sessionInstance = sd.sessionInstanceId ?? (startedAtMs != null ? `startedAt:${startedAtMs}` : null);
    const scope: Partial<DraftScope> = {
      uid: user?.uid ?? undefined, lineId: docId, productionDate: pd ?? undefined, shift: sd.shift, sessionInstance: sessionInstance ?? undefined,
    };

    // 1. This device's draft for exactly this user/line/date/shift/session.
    //    (Another device's drafts are never here — only its synced data is.)
    let draft = null;
    if (isCompleteScope(scope)) {
      const loaded = await draftStore.load(scope);
      if (loaded.ok) draft = loaded.draft;
      else if (loaded.reason !== 'missing') console.warn('[restore] local draft ignored:', loaded.reason);
    }

    // 2. Saved records of this line + date + shift (read only).
    let records: RestoreRecord[] | null = null;
    if (pd) {
      try {
        const snap = await withTimeout(
          getDocs(query(
            collection(db, 'productionRecords'),
            where('productionDate', '==', pd),
            where('lineId', '==', sd.lineId ?? docId),
            where('shift', '==', sd.shift)
          )),
          RESTORE_RECORDS_TIMEOUT_MS,
          'loading saved slots'
        );
        records = snap.docs.map((d) => {
          const r: any = d.data();
          const seg = r.partSegment === 'before' || r.partSegment === 'after' ? r.partSegment : null;
          return {
            id: d.id,
            slotIndex: typeof r.slotIndex === 'number' ? r.slotIndex : null,
            partSegment: seg,
            producedThisSlot: typeof r.producedThisSlot === 'number' ? r.producedThisSlot : null,
            rejections: typeof r.rejections === 'number' ? r.rejections : null,
            lossReasonCode: r.lossReasonCode ?? null,
            lossReasonLabel: r.lossReasonLabel ?? null,
            lossReasonNote: r.lossReasonNote ?? null,
            createdAtMs: timestampToMillis(r.createdAt),
            updatedAtMs: timestampToMillis(r.updatedAt),
          };
        });
      } catch (e) {
        console.warn('[restore] saved slot records could not be loaded', e);
      }
    }

    // Slots a set of changeovers splits into BEFORE/AFTER — the same rule as
    // the `changeovers` memo (a changeover on a slot's start doesn't split).
    const storedStart = typeof sd.productionStartMinutesAbs === 'number' ? sd.productionStartMinutesAbs : null;
    const splitSlotsFor = (cos: SyncState['changeovers']) => {
      const list = Object.values(cos).filter(Boolean) as unknown as ChangeoverInfo[];
      const intervals = list.map((co) => ({ start: co.startAbs ?? co.atAbs, end: co.endAbs ?? co.atAbs }));
      const sched = buildSlots(sd.shift, sd.otHours ?? 0, intervals, storedStart);
      const split = new Set<number>();
      for (const co of list) {
        const slot = sched.find((s) => s.index === co.slotIndex);
        if (slot && !isChangeoverAtSlotStart(slot, { start: co.startAbs ?? co.atAbs, end: co.endAbs ?? co.atAbs })) split.add(co.slotIndex);
      }
      return split;
    };

    const server = syncStateFromDoc(sd);
    const serverRevision = typeof sd.revision === 'number' ? sd.revision : 0;
    const r = resolveRestore({
      server,
      serverRevision,
      draft,
      records,
      identity: { productionDate: pd ?? '', lineId: sd.lineId ?? docId, shift: sd.shift },
      sessionStartedAtMs: startedAtMs,
      splitSlotsFor,
      deviceId: deviceIdRef.current,
      nowMs: Date.now(),
    });
    // A draft with nothing beyond the server copy is done with.
    if (draft && !r.draftApplied && isCompleteScope(scope)) draftStore.retire(scope, Number.MAX_SAFE_INTEGER);

    const notices: string[] = [];
    if (r.draftApplied) {
      notices.push(r.conflicts.length
        ? `Recovered unsynced entries from this device. ${r.conflicts.length} clashed with newer changes from another device — the newer values were kept (see below).`
        : 'Recovered entries saved on this device that had not reached the server.');
    }
    if (r.filledFromRecords > 0) notices.push('Filled missing values from saved slot records.');
    if (pd && records == null) notices.push('Saved-slot status could not be checked (offline?) — shown as last stored.');
    return {
      state: r.state, base: r.base, baseRevision: r.baseRevision, sessionInstance,
      needsSync: r.needsSync, notice: notices.join(' ') || null,
    };
  }

  // plan: the merged draft/record data from loadRestorePlan; null restores
  // the session doc exactly as stored.
  function restoreSession(sd: ActiveSessionDoc, lineList: Line[], docId: string, plan: RestorePlan | null = null) {
    setPlant(sd.plant);
    setWorkshop(sd.workshop);
    setDivision(sd.division);
    setSelectedShift(sd.shift);
    setSelectedLineId(sd.lineId);
    setSelectedPartIndex(sd.selectedPartIndex);
    setSupervisorName(sd.supervisorName);
    setSupervisorCode(sd.supervisorCode);

    // Slot values, stops, OT, operators: the merged plan when there is one,
    // else the doc as stored. A running stop comes back with its original
    // persisted startAbs, so the timer continues from the real stop time.
    const server = syncStateFromDoc(sd);
    applySyncStateToScreen(plan?.state ?? server, !!plan?.needsSync);
    if (!(plan?.state ?? server).operators.length) setOperators([{ id: 'op-restored', name: '', code: '' }]);
    setStopSync('idle');
    pendingResumeRef.current = null;

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

    const startedAtMs = timestampToMillis(sd.startedAt);
    sessionInstanceRef.current = plan?.sessionInstance ?? sd.sessionInstanceId ?? (startedAtMs != null ? `startedAt:${startedAtMs}` : null);
    // The server copy this device is now based on — the base of its next
    // sync's merge.
    serverBaseRef.current = {
      revision: plan?.baseRevision ?? (typeof sd.revision === 'number' ? sd.revision : 0),
      state: plan?.base ?? server,
    };
    // Nothing is pending for the data just loaded — unless the merge brought
    // in values the server copy lacks, which the autosave then writes back.
    clearSaveTimers();
    clearRetryTimer();
    syncFailuresRef.current = 0;
    remoteEndedRef.current = null;
    setRemoteEnded(null);
    confirmedRevisionRef.current = revisionRef.current;
    setSessionSync('saved');
    setLastSyncedAtMs(Date.now());
    setRestoreNotice(plan?.notice ?? null);

    setSessionLineId(docId);
    setPhase('active');
  }

  // A session doc → the SyncState it holds.
  function syncStateFromDoc(d: ActiveSessionDoc): SyncState {
    return {
      producedBySlot: { ...(d.producedBySlot ?? {}) },
      producedSegment: { ...(d.producedSegment ?? {}) },
      rejectionsBySlot: { ...(d.rejectionsBySlot ?? {}) },
      lossReasonBySlot: serializeLossReasons(d.lossReasonBySlot ?? {}),
      changeovers: { ...((d.changeovers ?? {}) as unknown as SyncState['changeovers']) },
      deletedSlotIndices: [...(d.deletedSlotIndices ?? [])],
      savedSlotIndices: [...(d.savedSlotIndices ?? [])],
      stopsBySlot: serializeStops((d.stopsBySlot ?? {}) as Record<string, StopLike[]>),
      otHours: typeof d.otHours === 'number' ? d.otHours : 0,
      operators: Array.isArray(d.operators) ? d.operators : [],
      syncConflicts: { ...(d.syncConflicts ?? {}) },
    };
  }

  // Puts a SyncState on screen. Refs (and latestRef) are updated at once, so
  // a sync that starts before the next render already sees it. The render it
  // causes is not treated as an edit by the autosave, unless `syncAfter`.
  function applySyncStateToScreen(s: SyncState, syncAfter = false) {
    const produced: Record<number, number | null> = {};
    Object.entries(s.producedBySlot).forEach(([k, v]) => { produced[Number(k)] = v; });
    const stops: Record<number, StopEvent[]> = {};
    Object.entries(s.stopsBySlot).forEach(([k, v]) => { stops[Number(k)] = Array.isArray(v) ? (v as StopEvent[]) : []; });
    const cos: Record<number, ChangeoverInfo | null> = {};
    Object.entries(s.changeovers).forEach(([k, v]) => { cos[Number(k)] = v as unknown as ChangeoverInfo | null; });
    const reasons: Record<string, LossReason> = {};
    Object.entries(s.lossReasonBySlot).forEach(([k, r]) => {
      if (r?.code) reasons[k] = { code: r.code, label: r.label ?? r.code, ...(r.note ? { note: r.note } : {}) };
    });
    const operatorsNext = s.operators.length ? (s.operators as Operator[]) : latestRef.current.operators;

    latestRef.current = {
      ...latestRef.current,
      producedBySlot: produced,
      producedSegment: { ...s.producedSegment },
      rejectionsBySlot: { ...s.rejectionsBySlot },
      allChangeovers: cos,
      deletedSlotIndices: new Set(s.deletedSlotIndices),
      otHours: s.otHours,
      operators: operatorsNext,
    };
    lossReasonBySlotRef.current = reasons;
    stopsBySlotRef.current = stops;
    syncConflictsRef.current = { ...s.syncConflicts };

    setProducedBySlot(produced);
    setProducedSegment({ ...s.producedSegment });
    setRejectionsBySlot({ ...s.rejectionsBySlot });
    setLossReasonBySlot(reasons);
    setChangeovers(cos);
    setDeletedSlotIndices(new Set(s.deletedSlotIndices));
    applySavedSlots(new Set(s.savedSlotIndices));
    setStopsBySlot(stops);
    setOtHours(s.otHours);
    setOperators(operatorsNext);
    setSyncConflicts({ ...s.syncConflicts });
    syncAfterRestoreRef.current = syncAfter;
    setRestoreToken((t) => t + 1);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SYNC SESSION with Firestore (activeSessions/{lineId})
  //
  // Every write goes through sessionQueueRef (one at a time, in order) and is
  // built when it STARTS, from latestRef / the stop, reason and saved-slot
  // refs — never from the calling render's closure. The on-device draft is
  // written first, so entries survive a failed or unfinished server write.
  //
  // The write is a transaction on the session doc's `revision`: if the
  // server is still at the revision this device last synced, this device's
  // state is written as is; if another device synced in between, the two are
  // three-way merged against that last-synced copy (utils/productionDraft
  // threeWayMerge) — the server value is kept on a clash and the other value
  // is preserved in syncConflicts. Either way revision + 1 is written and the
  // merged result is put on screen. A transaction never runs offline, so an
  // old offline write can never land later over newer data; failed syncs
  // retry with backoff and when the device comes back online.
  //
  // overrideStops: stop & resume write their next stops explicitly; the
  // stops on screen are only replaced by the synced result once it succeeds.
  // extraSavedSlots / preferLocalKeys: Save Slot's slot is marked saved, and
  // its explicitly saved values win any clash.
  // Resolves true once Firestore has accepted the write, false if it failed.
  // ─────────────────────────────────────────────────────────────────────────────

  function currentSyncState(extraSavedSlots: number[] = [], overrideStops?: Record<number, StopEvent[]>): SyncState {
    const L = latestRef.current;
    const producedBySlot: Record<string, number | null> = {};
    Object.entries(L.producedBySlot).forEach(([k, v]) => { producedBySlot[k] = v; });
    const changeovers: SyncState['changeovers'] = {};
    Object.entries(L.allChangeovers).forEach(([k, v]) => { changeovers[k] = v as unknown as Record<string, unknown> | null; });
    const stops: Record<string, StopLike[]> = {};
    Object.entries(overrideStops ?? stopsBySlotRef.current).forEach(([k, v]) => { stops[k] = v; });
    return {
      producedBySlot,
      producedSegment: { ...L.producedSegment },
      rejectionsBySlot: { ...L.rejectionsBySlot },
      lossReasonBySlot: serializeLossReasons(lossReasonBySlotRef.current),
      changeovers,
      deletedSlotIndices: Array.from(L.deletedSlotIndices).sort((a, b) => a - b),
      savedSlotIndices: Array.from(new Set([...savedSlotIndicesRef.current, ...extraSavedSlots])).sort((a, b) => a - b),
      stopsBySlot: serializeStops(stops),
      otHours: L.otHours,
      operators: L.operators.map((o) => ({ id: o.id, name: o.name, code: o.code })),
      syncConflicts: { ...syncConflictsRef.current },
    };
  }

  // Draft scope of the session on screen, or null when there is none (no
  // signed-in user, setup phase, or no pinned date yet).
  function currentDraftScope(): DraftScope | null {
    const L = latestRef.current;
    const scope = {
      uid: L.uid ?? undefined,
      lineId: L.sessionLineId ?? undefined,
      productionDate: L.productionDate ?? undefined,
      shift: L.selectedShift,
      sessionInstance: sessionInstanceRef.current ?? undefined,
    };
    return L.phase === 'active' && isCompleteScope(scope) ? scope : null;
  }

  function buildDraft(local: SyncState = currentSyncState(), revision = revisionRef.current) {
    const scope = currentDraftScope();
    const base = serverBaseRef.current;
    return scope && base ? createDraft(scope, base.state, base.revision, local, Date.now(), revision) : null;
  }

  async function writeLocalDraftNow(local: SyncState = currentSyncState(), revision = revisionRef.current): Promise<boolean> {
    const draft = buildDraft(local, revision);
    if (!draft) return false;
    const ok = await draftStore.save(draft);
    if (!ok) console.warn('[draft] could not save the on-device copy');
    return ok;
  }

  // The activeSessions fields written for a synced state.
  function sessionPayload(s: SyncState, revision: number): Record<string, any> {
    const L = latestRef.current;
    // Downtime per slot and in total; a running stop counts up to now.
    const stopsSummaryBySlot: Record<string, { totalDowntimeMinutes: number; stopCount: number }> = {};
    let totalDowntimeMinutes = 0;
    Object.entries(s.stopsBySlot).forEach(([k, arr]) => {
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
    const totalRejections = Object.values(s.rejectionsBySlot).reduce((sum, v) => sum + (v ?? 0), 0);

    return {
      lineId: L.selectedLineId,
      lineName: L.selectedLine?.lineName ?? null,
      // BUG FIX: use the selected line's own plant/workshop/division rather
      // than the Plant/Workshop/Division filter chips used to narrow the Line
      // list. Those chips are often left on "Any" once the supervisor knows
      // which line to pick, which was silently writing null location data
      // onto every record/session for that line.
      plant: L.selectedLine?.plant ?? L.plant ?? null,
      workshop: L.selectedLine?.workshop ?? L.workshop ?? null,
      division: L.selectedLine?.division ?? L.division ?? null,
      shift: L.selectedShift,
      otHours: s.otHours,
      selectedPartIndex: L.selectedPartIndex,
      supervisorName: L.supervisorName,
      supervisorCode: L.supervisorCode,
      supervisorUid: L.uid,
      operators: s.operators,
      producedBySlot: s.producedBySlot,
      rejectionsBySlot: s.rejectionsBySlot,
      stopsBySlot: s.stopsBySlot,
      changeovers: s.changeovers,
      producedSegment: s.producedSegment,
      deletedSlotIndices: s.deletedSlotIndices,
      lossReasonBySlot: s.lossReasonBySlot,
      savedSlotIndices: s.savedSlotIndices,
      syncConflicts: s.syncConflicts,
      lineStopped: isAnyStopRunning(s.stopsBySlot),
      revision,
      clientUpdatedAtMs: Date.now(),
      updatedBy: { uid: L.uid, deviceId: deviceIdRef.current },
      updatedAt: serverTimestamp(),

      // new structured summaries. productionDate is deliberately NOT part
      // of this payload — it's pinned when the session starts and an update
      // must never overwrite it (see the create branch below).
      plannedProductionTotal: L.shiftPlannedTotal,
      totalDowntimeMinutes,
      totalRejections,
      stopsSummaryBySlot,
    };
  }

  async function writeSessionNow(
    overrideStops?: Record<number, StopEvent[]>,
    extraSavedSlots: number[] = [],
    preferLocalKeys?: Set<string>
  ): Promise<boolean> {
    const L = latestRef.current;
    // Nothing to write outside an active session (e.g. a timer that outlived
    // a reset), while/after Finalize, or once the session ended elsewhere.
    if (finalizingRef.current || remoteEndedRef.current || L.phase !== 'active') return false;
    // require a selected line id
    if (!L.selectedLineId) return false;

    const revision = revisionRef.current;
    const local = currentSyncState(extraSavedSlots, overrideStops);
    // Device copy first: survives a failed or never-finished server write.
    await writeLocalDraftNow(local, revision);

    setPersistingSession(true);
    const docRef = doc(db, 'activeSessions', L.sessionLineId ?? L.selectedLineId);
    const base = serverBaseRef.current;
    let outcome: { merged: SyncState; revision: number; conflicts: number } | null = null;
    try {
      if (!L.sessionLineId) {
        // create doc (set startedAt and productionDate only first time) —
        // this is a genuinely new session, so its production day is pinned
        // here, from now.
        const pd = L.productionDate ?? productionDayKeyFor(Date.now());
        await withTimeout(setDoc(docRef, { ...sessionPayload(local, 1), productionDate: pd, startedAt: serverTimestamp() }), SESSION_WRITE_TIMEOUT_MS, 'session save');
        setSessionLineId(L.selectedLineId);
        setProductionDate(pd);
        sessionStartedAtMsRef.current = Date.now();
        outcome = { merged: local, revision: 1, conflicts: 0 };
      } else {
        const instance = sessionInstanceRef.current;
        await withTimeout(runTransaction(db, async (tx) => {
          const snap = await tx.get(docRef);
          if (!snap.exists()) throw new SessionGoneError('finalized');
          const remoteDoc = snap.data() as ActiveSessionDoc;
          if (instance && remoteDoc.sessionInstanceId && remoteDoc.sessionInstanceId !== instance) throw new SessionGoneError('replaced');
          // Merged only if another device synced since this device's last sync.
          const plan = planSessionSync(
            base,
            local,
            { revision: typeof remoteDoc.revision === 'number' ? remoteDoc.revision : 0, state: syncStateFromDoc(remoteDoc) },
            { preferLocalKeys, deviceId: deviceIdRef.current, nowMs: Date.now() }
          );
          tx.update(docRef, sessionPayload(plan.merged, plan.revision));
          outcome = { merged: plan.merged, revision: plan.revision, conflicts: plan.conflicts.length };
        }), SESSION_WRITE_TIMEOUT_MS, 'session save');
      }
    } catch (e) {
      setPersistingSession(false);
      if (e instanceof SessionGoneError) {
        handleRemoteEnded(e.kind);
        return false;
      }
      console.error('[persistSession] error', e);
      syncFailuresRef.current += 1;
      setSessionSync('error');
      scheduleSyncRetry();
      return false;
    }
    setPersistingSession(false);
    const done = outcome as unknown as { merged: SyncState; revision: number; conflicts: number };

    serverBaseRef.current = { revision: done.revision, state: done.merged };
    confirmedRevisionRef.current = Math.max(confirmedRevisionRef.current, revision);
    syncFailuresRef.current = 0;
    clearRetryTimer();
    setLastSyncedAtMs(Date.now());
    // Bring what the merge took from other devices onto the screen —
    // without undoing anything typed here while the sync was running.
    lastSyncMergedRemoteRef.current = !syncStatesEqual(done.merged, local);
    if (lastSyncMergedRemoteRef.current) {
      const current = currentSyncState(extraSavedSlots);
      const next = threeWayMerge(local, current, done.merged, {
        prefer: 'local', recordConflicts: false, deviceId: deviceIdRef.current, nowMs: Date.now(),
      }).merged;
      if (overrideStops) next.stopsBySlot = done.merged.stopsBySlot;
      applySyncStateToScreen(next);
      if (done.conflicts > 0) setRestoreNotice(`${done.conflicts} change(s) clashed with newer edits from another device — the newer values were kept (see below).`);
    } else if (overrideStops) {
      // Stop / Resume: the stops just synced are now the ones on screen.
      const stops: Record<number, StopEvent[]> = {};
      Object.entries(done.merged.stopsBySlot).forEach(([k, v]) => { stops[Number(k)] = v as StopEvent[]; });
      stopsBySlotRef.current = stops;
      setStopsBySlot(stops);
    }
    if (confirmedRevisionRef.current >= revisionRef.current && !sessionTimerRef.current) setSessionSync('saved');
    // The server has everything up to `revision` — drop the device copy
    // unless a newer edit has been written to it since.
    const scope = currentDraftScope();
    if (scope) draftStore.retire(scope, revision);
    return true;
  }

  // lineStopped is kept for the existing callers; it is now derived from the
  // synced stops themselves.
  const persistSession = (
    overrideStops?: Record<number, StopEvent[]>,
    _lineStopped?: boolean,
    extraSavedSlots?: number[],
    preferLocalKeys?: Set<string>
  ): Promise<boolean> => {
    if (overrideStops || extraSavedSlots) {
      // An explicit change (stop / resume / slot saved) — pending until synced.
      revisionRef.current += 1;
      setSessionSync('pending');
      return sessionQueueRef.current.explicit(() => writeSessionNow(overrideStops, extraSavedSlots, preferLocalKeys));
    }
    return sessionQueueRef.current.latest(() => writeSessionNow());
  };

  function clearSaveTimers() {
    if (sessionTimerRef.current) { clearTimeout(sessionTimerRef.current); sessionTimerRef.current = null; }
    if (draftTimerRef.current) { clearTimeout(draftTimerRef.current); draftTimerRef.current = null; }
  }

  function clearRetryTimer() {
    if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }
  }

  // After a failed sync: try again after 5s, 10s, 20s, 40s, then every 60s
  // while changes are pending (sooner when the device comes back online —
  // see the lifecycle effect).
  function scheduleSyncRetry() {
    if (retryTimerRef.current || remoteEndedRef.current) return;
    retryTimerRef.current = setTimeout(() => {
      retryTimerRef.current = null;
      if (hasPendingChanges()) persistSession();
    }, syncRetryDelayMs(syncFailuresRef.current));
  }

  function retrySyncNow() {
    if (!hasPendingChanges() || remoteEndedRef.current) return;
    clearRetryTimer();
    persistSession();
  }

  function hasPendingChanges() {
    return revisionRef.current > confirmedRevisionRef.current || !!sessionTimerRef.current;
  }

  // Writes now instead of after the debounce (blur, background, leaving).
  // The device draft is written straight away too — the server write may
  // have to wait for one already in flight.
  function flushSessionNow(): Promise<boolean> {
    clearSaveTimers();
    writeLocalDraftNow();
    return persistSession();
  }

  function flushIfPending() {
    if (hasPendingChanges()) flushSessionNow();
  }

  // The session doc was deleted (finalized on another device) or replaced
  // by a new session: stop syncing, keep this device's draft, and say so.
  function handleRemoteEnded(kind: 'finalized' | 'replaced') {
    if (remoteEndedRef.current || finalizingRef.current) return;
    remoteEndedRef.current = kind;
    setRemoteEnded(kind);
    clearSaveTimers();
    clearRetryTimer();
    const unsynced = hasPendingChanges();
    notify(
      kind === 'finalized' ? 'Session finalized on another device' : 'Session replaced on another device',
      (unsynced
        ? 'Entries made on this device that had not synced yet are NOT part of that session\'s records. They are still shown here and kept on this device. '
        : '') + 'This screen no longer saves. Go back to continue.'
    );
  }

  // Autosave: any change to the session's synced data saves the device
  // draft almost at once and the server copy after a short pause. Stops are
  // not watched here — Stop/Resume write them explicitly (awaited, with
  // their own retry). Renders caused by loading/merging server data are
  // skipped (restoreToken), so syncing can't loop between devices.
  useEffect(() => {
    if (phase !== 'active' || !sessionLineId || remoteEndedRef.current) return;
    if (restoreTokenSeenRef.current !== restoreToken) {
      // The render that loaded or merged server data — not an edit.
      restoreTokenSeenRef.current = restoreToken;
      if (!syncAfterRestoreRef.current) return;
      syncAfterRestoreRef.current = false;
    }
    revisionRef.current += 1;
    setSessionSync('pending');
    clearSaveTimers();
    draftTimerRef.current = setTimeout(() => {
      draftTimerRef.current = null;
      writeLocalDraftNow();
    }, DRAFT_SAVE_DEBOUNCE_MS);
    sessionTimerRef.current = setTimeout(() => {
      sessionTimerRef.current = null;
      persistSession();
    }, SESSION_SAVE_DEBOUNCE_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, sessionLineId, restoreToken, producedBySlot, producedSegment, rejectionsBySlot, lossReasonBySlot, storedChangeovers, deletedSlotIndices, otHours, operators, syncConflicts]);

  // Live updates from other devices. A newer revision is put on screen
  // straight away when this device has nothing pending or in flight;
  // otherwise this device's next sync merges it. A deleted or replaced
  // session doc ends syncing here (handleRemoteEnded).
  useEffect(() => {
    if (phase !== 'active' || !sessionLineId) return;
    const unsubscribe = onSnapshot(
      doc(db, 'activeSessions', sessionLineId),
      (snap) => {
        // No base = this screen already left the session (reset clears it
        // synchronously), e.g. its own Finalize just deleted the doc.
        if (snap.metadata.hasPendingWrites || finalizingRef.current || !serverBaseRef.current) return;
        if (!snap.exists()) { handleRemoteEnded('finalized'); return; }
        const d = snap.data() as ActiveSessionDoc;
        const instance = sessionInstanceRef.current;
        if (instance && d.sessionInstanceId && d.sessionInstanceId !== instance) { handleRemoteEnded('replaced'); return; }
        const rev = typeof d.revision === 'number' ? d.revision : 0;
        const base = serverBaseRef.current;
        if (!base || rev <= base.revision) return; // own sync echo, or nothing new
        if (
          hasPendingChanges() || sessionQueueRef.current.busy() || savingSlotsRef.current.size > 0 ||
          stopActionBusyRef.current || leavingRef.current
        ) return; // merged by this device's next sync instead
        const remote = syncStateFromDoc(d);
        serverBaseRef.current = { revision: rev, state: remote };
        applySyncStateToScreen(remote);
        setLastSyncedAtMs(Date.now());
        setRestoreNotice('Updated with changes from another device.');
      },
      (err) => console.warn('[session listener]', err)
    );
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, sessionLineId]);

  // App going to the background (native) or the tab being hidden (web —
  // react-native-web reports visibilitychange as AppState) → save now; back
  // in the foreground, or the browser back online → retry a failed sync at
  // once. On web, pagehide also writes the device draft, which is
  // synchronous there (localStorage); a network write started that late may
  // not finish.
  useEffect(() => {
    if (phase !== 'active') return;
    const sub = AppState.addEventListener('change', (st) => {
      if (st !== 'active') flushIfPending();
      else retrySyncNow();
    });
    // Direct (unqueued) write: localStorage.setItem runs synchronously inside
    // AsyncStorage's web setItem, so it completes before the page goes away.
    const onPageHide = () => {
      const draft = hasPendingChanges() ? buildDraft() : null;
      if (draft) saveDraft(AsyncStorage, draft);
    };
    const onOnline = () => retrySyncNow();
    const web = Platform.OS === 'web' && typeof window !== 'undefined';
    if (web) {
      window.addEventListener('pagehide', onPageHide);
      window.addEventListener('online', onOnline);
    }
    return () => {
      sub.remove();
      if (web) {
        window.removeEventListener('pagehide', onPageHide);
        window.removeEventListener('online', onOnline);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // Leaving the screen entirely (drawer / navigation) — keep pending entries:
  // device draft + server write, then stop the timers.
  useEffect(() => () => {
    clearRetryTimer();
    if (!hasPendingChanges()) return;
    clearSaveTimers();
    writeLocalDraftNow();
    persistSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cross-platform yes/no (Alert buttons don't fire on react-native-web —
  // see handleFinalizeSession).
  function confirmAsync(title: string, message: string, confirmText: string): Promise<boolean> {
    if (Platform.OS === 'web') return Promise.resolve(window.confirm(`${title}\n\n${message}`));
    return new Promise((resolve) => {
      Alert.alert(title, message, [
        { text: 'Stay', style: 'cancel', onPress: () => resolve(false) },
        { text: confirmText, style: 'destructive', onPress: () => resolve(true) },
      ], { cancelable: true, onDismiss: () => resolve(false) });
    });
  }

  // ── Sync conflicts (see threeWayMerge) — shown under the header.
  // "Use this value" applies the value that was not kept, as a new edit.
  function applyConflictValue(c: SyncConflict) {
    const v = c.otherValue as any;
    switch (c.field) {
      case 'producedBySlot':
        setProducedBySlot((p) => ({ ...p, [Number(c.key)]: v ?? null }));
        break;
      case 'producedSegment':
        setProducedSegment((p) => ({ ...p, [c.key]: v ?? null }));
        break;
      case 'rejectionsBySlot':
        setRejectionsBySlot((p) => { const n = { ...p }; if (v == null) delete n[c.key]; else n[c.key] = v; return n; });
        break;
      case 'lossReasonBySlot': {
        const next = { ...lossReasonBySlotRef.current };
        if (v?.code) next[c.key] = { code: v.code, label: v.label ?? v.code, ...(v.note ? { note: v.note } : {}) };
        else delete next[c.key];
        lossReasonBySlotRef.current = next;
        setLossReasonBySlot(next);
        break;
      }
      case 'changeovers':
        setChangeovers((p) => { const n = { ...p }; if (v) n[Number(c.key)] = v; else delete n[Number(c.key)]; return n; });
        markSlotUnsaved(Number(c.key));
        break;
      case 'otHours':
        if (typeof v === 'number') setOtHours(v);
        break;
      case 'operators':
        if (Array.isArray(v) && v.length) setOperators(v);
        break;
      default:
        return; // stops: informational only
    }
    dismissConflict(c.id);
  }

  function dismissConflict(id: string) {
    const next = { ...syncConflictsRef.current, [id]: null };
    syncConflictsRef.current = next;
    setSyncConflicts(next);
  }

  const CONFLICT_FIELD_LABELS: Record<SyncConflict['field'], string> = {
    producedBySlot: 'Produced', producedSegment: 'Produced', rejectionsBySlot: 'Rejections',
    lossReasonBySlot: 'Loss reason', changeovers: 'Changeover', stopsBySlot: 'Line stop', otHours: 'OT hours', operators: 'Operators',
  };

  function describeConflict(c: SyncConflict): string {
    const label = CONFLICT_FIELD_LABELS[c.field] ?? c.field;
    if (!c.key) return label;
    const [idx, seg] = c.key.split(/[:|]/);
    const slot = slots.find((s) => s.index === Number(idx));
    const part = seg === 'before' ? ' (before changeover)' : seg === 'after' ? ' (after changeover)' : '';
    return `${label} · ${slot?.label ?? `slot ${idx}`}${part}`;
  }

  function formatConflictValue(v: unknown): string {
    if (v == null) return 'empty';
    if (typeof v === 'number' || typeof v === 'string') return String(v);
    if (Array.isArray(v)) return v.map((o: any) => o?.name).filter(Boolean).join(', ') || 'none';
    const o = v as any;
    if (o.label) return o.label;
    if (typeof o.startAbs === 'number') return `${o.reason ?? 'stop'}${o.running ? ' (running)' : ''}`;
    if (typeof o.atAbs === 'number') return formatAbsMinutesToAmPm(o.atAbs);
    return 'value';
  }


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
    const sessionInstanceId = newSessionInstanceId();
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
        lossReasonBySlot: {},
        savedSlotIndices: [],
        sessionInstanceId,
        revision: 1,
        syncConflicts: {},
        updatedBy: { uid: user?.uid ?? null, deviceId: deviceIdRef.current },
        clientUpdatedAtMs: Date.now(),
        startedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      setSessionLineId(lineId);
      // Pinned for the lifetime of this session — every record it writes,
      // including Finalize after midnight/the cutover, uses this date.
      setProductionDate(pd);
      setSessionStartAbs(startAbs);
      sessionStartedAtMsRef.current = startedMs;
      sessionInstanceRef.current = sessionInstanceId;
      // Just written in full at revision 1 — that is this device's base, and
      // nothing is pending.
      serverBaseRef.current = {
        revision: 1,
        state: { ...emptySyncState(), otHours, operators: operators.map((o) => ({ id: o.id, name: o.name, code: o.code })) },
      };
      applySyncStateToScreen(serverBaseRef.current.state);
      clearSaveTimers();
      clearRetryTimer();
      syncFailuresRef.current = 0;
      remoteEndedRef.current = null;
      setRemoteEnded(null);
      confirmedRevisionRef.current = revisionRef.current;
      setSessionSync('saved');
      setLastSyncedAtMs(Date.now());
      setRestoreNotice(null);
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
  async function saveShiftSummary(lineId: string, prodDate: string, frozenStops: Record<number, StopEvent[]>) {
    if (!selectedLine) return;
    const { planned, actual } = computeShiftTotals();
    // Every stop interval of the session, whole and unsplit (the
    // activeSessions doc holding them is deleted at Finalize). Audit /
    // summary only — reports total downtime from productionRecords'
    // stopEvents, so nothing here is added to those figures.
    const downtimeIntervals = Object.entries(frozenStops)
      .flatMap(([k, arr]) => (arr ?? []).map((se) => ({
        stopId: stopIdOf(se),
        slotIndex: Number(k),
        reason: se.reason,
        startAbs: se.startAbs,
        endAbs: se.endAbs ?? null,
        durationMinutes: se.durationMinutes ?? (se.endAbs != null ? stopDurationMinutes(se.startAbs, se.endAbs) : null),
      })))
      .sort((a, b) => a.startAbs - b.startAbs);
    const totalDowntimeMinutes = Math.round(downtimeIntervals.reduce((sum, d) => sum + (d.durationMinutes ?? 0), 0) * 100) / 100;
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
          downtimeIntervals,
          totalDowntimeMinutes,
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
  async function submitUnsavedSlots(lineId: string, prodDate: string, frozenStops: Record<number, StopEvent[]>, nowTs: number) {
    if (!selectedLine) return;

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
    // A slot with no reason in memory must not wipe a reason already stored
    // on its record (e.g. one picked at Save Slot before the app restarted).
    const keepStoredLossReason = { keepExistingWhenNull: ['lossReasonCode', 'lossReasonLabel', 'lossReasonNote'] };

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
      if (!co) {
        // Each card is independent — the operator enters exactly what was
        // produced in this slot, nothing more.
        const produced = producedBySlot[s.index];
        if (produced == null) continue; // nothing entered for this slot - skip
        const { events: slotStopEvents, minutes: stopped } = segmentDowntime(frozenStops, prodDate, s, 'full', null, nowTs);
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
          stopEvents: slotStopEvents,
        }, resolvedRecordIdsRef.current, keepStoredLossReason);
        await removeSupersededProductionRecords(slotKey(s.index), 'full', resolvedRecordIdsRef.current);
      } else {
        // Changeover — two fully independent records, each with its own
        // produced value as entered (no baseline, no subtraction).
        const { events: stopEventsBefore, minutes: stopBefore } = segmentDowntime(frozenStops, prodDate, s, 'before', co, nowTs);
        const { events: stopEventsAfter, minutes: stopAfter } = segmentDowntime(frozenStops, prodDate, s, 'after', co, nowTs);
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
            rejections: rejectionsBySlot[`${s.index}:before`] ?? 0, stopEvents: stopEventsBefore,
            changeoverInfo: co, partSegment: 'before',
          }, resolvedRecordIdsRef.current, keepStoredLossReason);
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
            rejections: rejectionsBySlot[`${s.index}:after`] ?? 0, stopEvents: stopEventsAfter,
            changeoverInfo: co, partSegment: 'after',
          }, resolvedRecordIdsRef.current, keepStoredLossReason);
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

  const handleFinalizeSession = async () => {
    // Finalize writes this device's view of the session into
    // productionRecords, so it must first be in sync with every other
    // device's changes.
    if (remoteEndedRef.current) {
      notify('Session already ended', 'This session was finalized or replaced on another device.');
      return;
    }
    if (savingSlotsRef.current.size > 0) {
      notify('Slot still saving', 'Wait for the slot save to finish, then tap Finalize & End again.');
      return;
    }
    clearSaveTimers();
    const synced = await persistSession();
    if (!synced) {
      if (!remoteEndedRef.current) {
        notify(
          'Not synced — cannot finalize yet',
          'This device could not sync with the server (offline?), so changes made on other devices may be missing. Your entries are kept on this device. Try again once connected.'
        );
      }
      return;
    }
    if (lastSyncMergedRemoteRef.current) {
      notify('Updated from another device', 'Changes from another device were just merged in. Review them, then tap Finalize & End again.');
      return;
    }
    console.log('[handleFinalizeSession] START — about to show the confirm dialog');
    console.log('[handleFinalizeSession] state check', { sessionLineId, selectedLineId, platform: Platform.OS });

    // Same body that used to live only inside Alert.alert's "Finalize & End"
    // button onPress — extracted so both the web and native confirm paths
    // call the exact same logic instead of duplicating it.
    const proceedWithFinalize = async () => {
      console.log('[handleFinalizeSession] CONFIRM (Finalize & End) CALLBACK FIRED');
      // Device draft scope, captured before anything is reset.
      const draftScope = currentDraftScope();
      // From here no session write may start (one landing after the
      // deleteDoc below would fail, or race the finalize writes). Let a
      // write already in flight finish first; the device draft is kept
      // until Finalize has succeeded.
      clearSaveTimers();
      finalizingRef.current = true;
      await sessionQueueRef.current.idle();
      let finalized = false;
      try {
        const docId = sessionLineId ?? selectedLineId;
        console.log('[handleFinalizeSession] resolved docId', { docId, sessionLineId, selectedLineId });
        if (docId) {
          // Resolved ONCE from the session itself and passed to every
          // write below, so a session finalized after midnight / the 6:30 AM
          // cutover still files everything under the day it started.
          const prodDate = await resolveActiveSessionProductionDate(docId);
          console.log('[handleFinalizeSession] resolved session productionDate', prodDate);

          // Any stop still running ends now — one timestamp for both the
          // slot records and the shift summary.
          const finalizedAt = Date.now();
          const frozenStops = freezeRunningStops(stopsBySlotRef.current, finalizedAt);

          console.log('[handleFinalizeSession] calling submitUnsavedSlots(docId)…');
          await submitUnsavedSlots(docId, prodDate, frozenStops, finalizedAt);
          console.log('[handleFinalizeSession] submitUnsavedSlots resolved');

          console.log('[handleFinalizeSession] calling saveShiftSummary(docId)…');
          await saveShiftSummary(docId, prodDate, frozenStops);
          console.log('[handleFinalizeSession] saveShiftSummary resolved');

          console.log('[handleFinalizeSession] calling deleteDoc(activeSessions/', docId, ')…');
          // Removed only if no other device synced a change since this one's
          // last sync — otherwise the session stays open with that change
          // (records written above are upserts, so finalizing again later
          // just updates them).
          const baseRevision = serverBaseRef.current?.revision ?? null;
          await runTransaction(db, async (tx) => {
            const ref = doc(db, 'activeSessions', docId);
            const snap = await tx.get(ref);
            if (!snap.exists()) return;
            const rev = (snap.data() as ActiveSessionDoc).revision ?? 0;
            if (baseRevision != null && rev !== baseRevision) {
              throw new Error('Another device changed this session while it was being finalized. The records were saved; reopen the session, review the latest data and tap Finalize & End again.');
            }
            tx.delete(ref);
          });
          console.log('[handleFinalizeSession] deleteDoc resolved');
          finalized = true;
          // Everything is in productionRecords now — the device copy is done.
          if (draftScope) await draftStore.retire(draftScope, Number.MAX_SAFE_INTEGER);
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
      finalizingRef.current = false;
      console.log('[handleFinalizeSession] calling goBackToProduction()');
      // Finalized: the session doc is gone, so there is nothing left to
      // save — just reset. Failed: leave the same way as Back (saves the
      // current entries to the still-existing session, keeps the draft).
      if (finalized) resetSessionState();
      else await goBackToProduction();
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
    const prev = savedSlotIndicesRef.current;
    if (!prev.has(slotIndex)) return;
    const next = new Set(prev);
    next.delete(slotIndex);
    applySavedSlots(next);
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
      // Saved by the autosave effect (storedChangeovers changed).
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

  // Shows a blocking message on both native and web (Alert.alert has no
  // real modal behind it on react-native-web — see handleFinalizeSession).
  const notify = (title: string, message: string) => {
    if (Platform.OS === 'web') window.alert(`${title}\n\n${message}`);
    else Alert.alert(title, message);
  };

  // Stop Line. The stop's start time is captured at the tap and written to
  // activeSessions/{lineId} straight away (awaited) — that persisted
  // startAbs is what the timer and the final duration are computed from, so
  // the line stays stopped, with the timer running from the real stop time,
  // across app close, restart and logout.
  const startStopForSlot = async (slotIndex: number, reason: string) => {
    // One active stop interval at a time: ignore a double tap on "Start
    // Stop", or a stop while another is still running or saving.
    if (stopActionBusyRef.current || isAnyStopRunning(stopsBySlotRef.current)) {
      setStopModalVisible(false);
      return;
    }
    stopActionBusyRef.current = true;
    const ts = Date.now();
    const breakdownLineId = selectedLine?.id ?? sessionLineId ?? selectedLineId;
    // Maintenance stops get their own lineBreakdowns doc. Its id is
    // generated up front (the same auto-id addDoc would use) so it is saved
    // on the stop event together with the stop itself, and Resume can close
    // it even after an app restart.
    const breakdownRef = reason === 'maintenance' && breakdownLineId ? doc(collection(db, 'lineBreakdowns')) : null;
    const newStop: StopEvent = {
      id: stopIdOf({ startAbs: ts }),
      reason,
      startAbs: ts,
      running: true,
      ...(breakdownRef ? { breakdownDocId: breakdownRef.id } : {}),
    };
    const current = stopsBySlotRef.current;
    const nextStops = { ...current, [slotIndex]: [...(current[slotIndex] ?? []), newStop] };
    stopsBySlotRef.current = nextStops;
    setStopsBySlot(nextStops);
    setStopModalVisible(false);
    setStopSync('saving');

    try {
      const ok = await persistSession(nextStops, true);
      if (ok) {
        setStopSync('idle');
      } else {
        // Keep the stop on screen (it really happened, and its start time
        // must not be lost) but flag it as NOT saved; the card offers Retry,
        // and any later successful save of the session — including Resume —
        // writes it.
        setStopSync('error');
        notify(
          'Line stop not saved',
          'The stop is shown on this device but was NOT saved to the server, so it will be lost if the app is closed. Check your connection and tap "Retry save".'
        );
      }
    } finally {
      stopActionBusyRef.current = false;
    }

    if (breakdownRef && breakdownLineId) {
      const slot = slots.find((s) => s.index === slotIndex);
      // A doc per breakdown (not one keyed by lineId), so if this line breaks
      // down again later the earlier occurrence stays in Firestore instead of
      // being overwritten. The Technician dashboard's Active tab then shows
      // every currently-open breakdown, and the Fixed tab keeps the full
      // history for the line.
      setDoc(breakdownRef, {
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
      }).catch((e) => {
        console.error('[breakdown] failed to mark line as broken down:', e.code, e.message);
        Alert.alert(
          'Warning',
          'The stop was recorded, but the Technician dashboard could not be notified (breakdown flag failed to save). Check your connection.'
        );
      });
    }
  };

  // Re-sends the current stops after a failed Stop save.
  const retryStopSync = async () => {
    if (stopActionBusyRef.current) return;
    stopActionBusyRef.current = true;
    setStopSync('saving');
    try {
      const ok = await persistSession(stopsBySlotRef.current, isAnyStopRunning(stopsBySlotRef.current));
      setStopSync(ok ? 'idle' : 'error');
      if (!ok) notify('Still not saved', 'The line stop could not be saved. Check your connection and try again.');
    } finally {
      stopActionBusyRef.current = false;
    }
  };

  // Resume Line. Duration = resume time − the persisted stop time, so time
  // the app was closed counts in full. The completed interval is written
  // first and the stop is only cleared on screen once that write succeeds;
  // if it fails the line stays STOPPED here and in Firestore (nothing is
  // lost) and the next Resume tap retries with the ORIGINAL resume time.
  // Closing an already-closed stop is a no-op (completeRunningStops), so
  // repeated taps or retries can never save the interval twice.
  const endStopForSlot = async (slotIndex: number) => {
    if (stopActionBusyRef.current) return;

    const current = stopsBySlotRef.current;
    const currentSlotStops = current[slotIndex] ?? [];
    const runningStop = currentSlotStops.find((e) => e.running) ?? null;
    if (!runningStop) return; // nothing running, bail early
    stopActionBusyRef.current = true;

    const stopId = stopIdOf(runningStop);
    const pending = pendingResumeRef.current;
    const ts = pending && pending.slotIndex === slotIndex && pending.stopId === stopId ? pending.endMs : Date.now();
    pendingResumeRef.current = { slotIndex, stopId, endMs: ts };

    const endedReason = runningStop.reason;
    const nextStops: Record<number, StopEvent[]> = { ...current, [slotIndex]: completeRunningStops(currentSlotStops, ts) };
    const remaining = isAnyStopRunning(nextStops);

    setStopSync('saving');
    let ok = false;
    try {
      ok = await persistSession(nextStops, remaining);
    } finally {
      stopActionBusyRef.current = false;
    }
    if (!ok) {
      setStopSync('error');
      notify(
        'Resume not saved',
        `The line is still recorded as stopped. Check your connection and tap Resume again — the resume time ${new Date(ts).toLocaleTimeString()} will be kept (${stopDurationMinutes(runningStop.startAbs, ts).toFixed(1)} min of downtime).`
      );
      return;
    }
    pendingResumeRef.current = null;
    // The closed stop is on screen already: a successful sync puts the
    // synced stops (these, plus any another device recorded) on screen.
    setStopSync('idle');

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
            'Line resumed, but the Technician dashboard could not be updated. Check your connection — the breakdown may still show as active there.'
          );
        });
      };

      if (runningStop.breakdownDocId) {
        closeBreakdownDoc(runningStop.breakdownDocId);
      } else {
        // Only stops recorded before the breakdown id was generated up front
        // can be missing it (their addDoc result was never persisted).
        console.error('[breakdown] no breakdownDocId available to close for slot', slotIndex);
        Alert.alert(
          'Warning',
          'Line resumed, but the Technician dashboard could not be updated — the breakdown may still show as active there.'
        );
      }
    }
  };

  const slotHasRunningStop = (slotIndex: number) => (stopsBySlot[slotIndex] ?? []).some((s) => s.running);

  // ─────────────────────────────────────────────────────────────────────────────
  // CALCULATIONS
  // ─────────────────────────────────────────────────────────────────────────────

  // Downtime of one record window — a whole slot ('full') or one side of a
  // changeover ('before'/'after') — by time overlap with EVERY stop of the
  // session, whichever card it was pressed on (see utils/downtime). A stop
  // across an hour boundary is split between the slots it covers, and a
  // changeover slot's BEFORE and AFTER records each get only their own
  // part, so a stop is never counted on two records. `events` is what is
  // stored as the record's stopEvents; `minutes` is their total.
  function segmentWindowAbs(slot: Slot, segment: SlotSegment, co: ChangeoverInfo | null): TimeInterval {
    if (segment === 'full' || !co) return { start: slot.startMinutesAbs, end: slot.endMinutesAbs };
    const w = changeoverSegmentWindows(
      { start: slot.startMinutesAbs, end: slot.endMinutesAbs },
      { start: co.startAbs ?? co.atAbs, end: co.endAbs ?? co.atAbs }
    );
    return segment === 'before' ? w.before : w.after;
  }

  function segmentDowntime(
    stops: Record<number, StopEvent[]>,
    pd: string,
    slot: Slot,
    segment: SlotSegment,
    co: ChangeoverInfo | null,
    atMs: number
  ): { events: RecordStopEvent[]; minutes: number } {
    const w = segmentWindowAbs(slot, segment, co);
    const events = stopEventsForWindow(stops, productionDayMinuteToMillis(pd, w.start), productionDayMinuteToMillis(pd, w.end), atMs);
    const minutes = Math.round(events.reduce((sum, e) => sum + e.durationMinutes, 0) * 100) / 100;
    return { events, minutes };
  }

  // Live per-card downtime for display (running stops count up to now).
  function displayedStoppedMinutes(slot: Slot, segment: SlotSegment, co: ChangeoverInfo | null) {
    const pd = productionDate ?? productionDayKeyFor(sessionStartedAtMsRef.current ?? nowMs);
    return segmentDowntime(stopsBySlot, pd, slot, segment, co, nowMs).minutes;
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
    return formatElapsedSince(startMs, nowMs);
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
    const next = {
      ...lossReasonBySlotRef.current,
      [key]: { code: lossModalCode, label: meta?.label ?? lossModalCode, note: lossModalCode === 'K' ? lossModalNote.trim() : undefined },
    };
    lossReasonBySlotRef.current = next;
    setLossReasonBySlot(next);
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
          // Saved by the autosave effect (deletedSlotIndices changed).
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
    // Reasons from the ref: when the loss modal resumes this check, this
    // function may be an earlier render's copy, whose state lacks the reason
    // that was just picked (which made the modal reopen instead of saving).
    const lossReasonBySlot = lossReasonBySlotRef.current;
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
      let savedMessage = '';
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
        const { events: slotStopEvents, minutes: stopped } = segmentDowntime(stopsBySlot, prodDate, slot, 'full', null, Date.now());
        const productive = Math.max(0, slot.productiveMinutes - stopped);
        const expParts = expectedParts(activePart, slot.productiveMinutes);
        const slotLossParts = Math.max(0, expParts - produced);
        const lossReason = lossReasonBySlotRef.current[String(slot.index)] ?? null;
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
          stopEvents: slotStopEvents,
        }, resolvedRecordIdsRef.current);
        await removeSupersededProductionRecords(slotKey, 'full', resolvedRecordIdsRef.current);
        savedMessage = `Slot ${slot.label} saved.`;
      } else {
        // Changeover: two fully independent records, each with its own
        // produced value exactly as entered.
        const pb = producedSegment[`${slot.index}:before`];
        const pa = producedSegment[`${slot.index}:after`];
        if (pb == null) { Alert.alert('Missing', 'Enter BEFORE segment produced.'); return; }
        if (pa == null) { Alert.alert('Missing', 'Enter AFTER segment produced.'); return; }
        const savedAt = Date.now();
        const { events: stopEventsBefore, minutes: stopBefore } = segmentDowntime(stopsBySlot, prodDate, slot, 'before', co, savedAt);
        const { events: stopEventsAfter, minutes: stopAfter } = segmentDowntime(stopsBySlot, prodDate, slot, 'after', co, savedAt);
        const prodBefore = Math.max(0, co.beforeMinutes - stopBefore);
        const prodAfter = Math.max(0, co.afterMinutes - stopAfter);
        const expBefore = expectedParts(co.oldPartIndex, co.beforeMinutes);
        const expAfter = expectedParts(co.newPartIndex, co.afterMinutes);
        const lossReasonBefore = lossReasonBySlotRef.current[`${slot.index}:before`] ?? null;
        const lossReasonAfter = lossReasonBySlotRef.current[`${slot.index}:after`] ?? null;
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
          rejections: rejectionsBySlot[`${slot.index}:before`] ?? 0, stopEvents: stopEventsBefore,
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
          rejections: rejectionsBySlot[`${slot.index}:after`] ?? 0, stopEvents: stopEventsAfter,
          changeoverInfo: co, partSegment: 'after',
        }, resolvedRecordIdsRef.current);
        await removeSupersededProductionRecords(slotKey, 'split', resolvedRecordIdsRef.current);
        savedMessage = `Slot ${slot.label} saved (split).`;
      }
      // The record is written. Now the session must learn it: this write
      // carries the slot's saved marker and everything entered so far —
      // built when it runs, so input typed during the record write is
      // included, never overwritten. The slot only shows as saved once it
      // succeeds; if it fails, the record stays as written and a retry
      // updates that same record (never adds one).
      // The values just written to the record win any clash with another
      // device's edits of this slot, so the session matches the record.
      const segKeys = co ? [`${slot.index}:before`, `${slot.index}:after`] : [String(slot.index)];
      const savedKeys = new Set<string>([
        ...(co ? segKeys.map((k) => `producedSegment|${k}`) : [`producedBySlot|${slot.index}`]),
        ...segKeys.map((k) => `rejectionsBySlot|${k}`),
        ...segKeys.map((k) => `lossReasonBySlot|${k}`),
      ]);
      const synced = await persistSession(undefined, undefined, [slot.index], savedKeys);
      if (synced) {
        applySavedSlots(new Set(savedSlotIndicesRef.current).add(slot.index));
        Alert.alert('Saved', savedMessage);
      } else {
        notify(
          'Slot saved — session not updated',
          `${savedMessage} The production record was written, but this session's progress could not be updated on the server, so other devices may not show it yet. ` +
            'Your entries are kept on this device and sync is retried automatically. You can also tap Save Slot again — it updates the same record, it never adds another.'
        );
      }
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
          {restoringSession ? (
            <View style={{ marginTop: 18, alignItems: 'center', gap: 6 }}>
              <ActivityIndicator color="#8A96A3" />
              <Text style={styles.muted}>Opening session…</Text>
            </View>
          ) : loadingActiveSessions ? (
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
                    onPress={() => continueSession(docId)}
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
            {/* Session save status (see persistSession) */}
            <Text style={[styles.subtitle, { marginTop: 2, fontWeight: '700', color: remoteEnded || sessionSync === 'error' ? '#D64545' : '#8A96A3' }]}>
              {remoteEnded
                ? `Session ${remoteEnded === 'finalized' ? 'finalized' : 'replaced'} on another device — no longer saving. Go back to continue.`
                : sessionSync === 'error'
                ? 'NOT SYNCED — latest changes are only on this device; other devices can\'t see them yet. Retrying automatically (or tap Save Session).'
                : sessionSync === 'pending' || persistingSession
                ? 'Syncing changes…'
                : `All changes synced${lastSyncedAtMs ? ` · ${new Date(lastSyncedAtMs).toLocaleTimeString()}` : ''}`}
            </Text>
            {restoreNotice && (
              <Text style={[styles.subtitle, { marginTop: 2, color: '#F2A93B' }]}>{restoreNotice}</Text>
            )}
            {/* Values not kept when edits from two devices clashed */}
            {Object.values(syncConflicts).filter((c): c is SyncConflict => !!c).map((c) => (
              <View key={c.id} style={{ marginTop: 6, padding: 8, borderRadius: 8, borderWidth: 1, borderColor: '#F2A93B' }}>
                <Text style={{ color: '#ECEFF2', fontSize: 12 }}>
                  {describeConflict(c)}: kept {formatConflictValue(c.keptValue)} (newer); not kept {formatConflictValue(c.otherValue)}
                </Text>
                <View style={{ flexDirection: 'row', gap: 12, marginTop: 4 }}>
                  {c.field !== 'stopsBySlot' && (
                    <Pressable onPress={() => applyConflictValue(c)} hitSlop={6}>
                      <Text style={{ color: '#F2A93B', fontWeight: '700', fontSize: 12 }}>Use {formatConflictValue(c.otherValue)}</Text>
                    </Pressable>
                  )}
                  <Pressable onPress={() => dismissConflict(c.id)} hitSlop={6}>
                    <Text style={{ color: '#8A96A3', fontWeight: '700', fontSize: 12 }}>Dismiss</Text>
                  </Pressable>
                </View>
              </View>
            ))}

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
          <Pressable
            onPress={async () => {
              const ok = await flushSessionNow();
              if (!ok) notify('Session not saved', 'Could not save to the server. Your entries are kept on this device — check your connection and tap Save Session again.');
            }}
            style={[styles.stopProductionBtn, { borderColor: '#F2A93B' }]}
          >
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
                  // Saved by the autosave effect (otHours changed).
                  setOtHours(v);
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
              <Pressable onPress={() => { const idx = co.slotIndex; setChangeovers((p) => { const c = { ...p }; delete c[idx]; return c; }); markSlotUnsaved(idx); }} style={styles.removeChangeBtn}>
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
                    {savedSlotIndices.has(stopSlotIndex) && (
                      <Text style={{ color: '#4C9A6A', fontSize: 11, fontWeight: '700' }}>✓ Saved</Text>
                    )}
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
                      // onBlur, not onEndEditing: react-native-web's TextInput
                      // never fires onEndEditing. Typing itself is saved by the
                      // autosave effect; leaving the field just saves sooner.
                      onBlur={flushIfPending}
                    />
                    <View style={{ marginTop: 8 }}>
                      <Text style={styles.labelSmall}>Rejections</Text>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 }}>
                        <Pressable onPress={() => { setRejectionsBySlot((p) => ({ ...p, [rejectKey]: Math.max(0, (p[rejectKey] ?? 0) - 1) })); queueRejectionSync(rejectKey); }} style={[styles.smallBtn, disabled && styles.disabledBtn]} disabled={disabled}><Text style={styles.smallBtnText}>−</Text></Pressable>
                        <Text style={{ color: '#ECEFF2', fontWeight: '700', minWidth: 36, textAlign: 'center' }}>{rejectionsBySlot[rejectKey] ?? 0}</Text>
                        <Pressable onPress={() => { setRejectionsBySlot((p) => ({ ...p, [rejectKey]: (p[rejectKey] ?? 0) + 1 })); queueRejectionSync(rejectKey); }} style={[styles.smallBtn, disabled && styles.disabledBtn]} disabled={disabled}><Text style={styles.smallBtnText}>+</Text></Pressable>
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
                          {stopSync !== 'idle' && (
                            <Text style={{ color: stopSync === 'error' ? '#D64545' : '#8A96A3', fontSize: 10, fontWeight: '700', textAlign: 'center' }}>
                              {stopSync === 'saving' ? 'Saving…' : 'NOT SAVED'}
                            </Text>
                          )}
                          {stopSync === 'error' && !pendingResumeRef.current && (
                            <Pressable onPress={retryStopSync} style={[styles.stopBtn, { paddingVertical: 4 }]}>
                              <Text style={{ color: '#F2A93B', fontWeight: '700', fontSize: 11 }}>Retry save</Text>
                            </Pressable>
                          )}
                          <Pressable
                            onPress={() => endStopForSlot(stopSlotIndex)}
                            disabled={stopSync === 'saving'}
                            style={[styles.resumeBtn, stopSync === 'saving' && styles.disabledBtn]}
                          >
                            {stopSync === 'saving'
                              ? <ActivityIndicator size="small" color="#14181C" />
                              : <Text style={{ color: '#14181C', fontWeight: '800', fontSize: 12 }}>Resume</Text>}
                          </Pressable>
                        </View>
                      ) : (
                        <Pressable
                          onPress={() => openStopModalForSlot(stopSlotIndex)}
                          disabled={disabled || stopSync === 'saving'}
                          style={[styles.stopBtn, (disabled || stopSync === 'saving') && styles.disabledBtn]}
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
              const stopped = displayedStoppedMinutes(s, 'full', null);
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
              const stopBefore = displayedStoppedMinutes(s, 'before', co);
              const prodBefore = Math.max(0, co.beforeMinutes - stopBefore);
              const expBefore = expectedParts(co.oldPartIndex, co.beforeMinutes);
              const stopAfter = displayedStoppedMinutes(s, 'after', co);
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