// src/screens/GenerateReportScreen.tsx
//
// Admin-only production report. Lets the admin filter productionRecords
// (written by RecordProductionScreen) by plant / workshop / division / line /
// shift / date range, then shows:
//   1. Summary stat cards (produced, expected, efficiency, rejections, downtime)
//   2. A per-line/per-day breakdown table, including manpower — Operator
//      Count and Operator Names for that line + productionDate + shift,
//      read straight off each productionRecords doc's `operators` array
//      (the same roster RecordProductionScreen stamps onto every slot/segment
//      record for a session — see its `operators` field). Unioned across all
//      records in the group and de-duplicated by name, since split slots and
//      changeover segments repeat the same session roster on every record.
//   3. A flat list of every matching slot record
// "Share Summary" uses React Native's built-in Share API — no extra deps.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  SafeAreaView,
  ScrollView,
  KeyboardAvoidingView,
  FlatList,
  ActivityIndicator,
  Alert,
  Share,
  Modal,
  Dimensions,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { collection, getDocs, query, where, orderBy, Timestamp } from 'firebase/firestore';
import { db } from '../services/firebase';
import { PLANTS, WORKSHOPS, DIVISIONS } from '../constants/lineOptions';
// npm install react-native-gifted-charts react-native-svg
import { BarChart, LineChart, PieChart } from 'react-native-gifted-charts';
// npm install xlsx-js-style && npx expo install expo-file-system expo-sharing
// (xlsx-js-style, not xlsx — the plain SheetJS Community build strips cell
// styles on write, so it can't produce the styled report in reportExcelExport.ts)
import { exportReportToExcel, ExcelDetailRow, ExcelLineSummaryRow, ExcelHourlySourceRow } from '../utils/reportExcelExport';

// ─── Types ────────────────────────────────────────────────────────────────────

type Line = {
  id: string;
  plant?: string | null;
  workshop?: string | null;
  division?: string | null;
  lineName?: string | null;
  parts?: { name: string }[];
};

interface StopEventRecord {
  reason: string;
  startAbs: number;
  endAbs?: number | null;
  durationMinutes?: number | null;
}

interface ProductionRecord {
  id: string;
  shift: 'A' | 'B';
  plant: string | null;
  workshop: string | null;
  division: string | null;
  lineId: string | null;
  lineName: string | null;
  partName: string | null;
  slotIndex: number | null;
  slotLabel: string | null;
  slotStartMinutesAbs: number | null;
  slotEndMinutesAbs: number | null;
  productionDate: string | null;
  // expectedParts = this slot/segment's own target (cycle time × its duration)
  expectedParts: number | null;
  // producedThisSlot = exactly what the operator entered for this slot/segment —
  // every saved slot or split is a fully independent record now, no running
  // counter and no "last slot holds the session total" logic anywhere.
  producedThisSlot: number | null;
  // lossParts = expectedParts - producedThisSlot (parts that could not be made)
  lossParts: number | null;
  // lossTimeMinutes = lossParts converted to minutes using this slot's cycle
  // time — the production-time equivalent of the shortfall
  lossTimeMinutes: number | null;
  lossReasonLabel: string | null;
  rejections: number | null;
  stopEvents: StopEventRecord[] | null;
  supervisorName: string | null;
  // The session's operator roster, as stamped by RecordProductionScreen onto
  // every slot/segment record for that session (see its `operators` field) —
  // the same array repeats across every record in a group, which is fine
  // since the BY LINE rollup de-dupes by name.
  operators: { name: string; code: string }[] | null;
  createdAtMs: number | null;
}

type LineDayBreakdown = {
  key: string;
  // The exact Firestore productionLines doc id for this group's line — not
  // displayed anywhere, only used to scope the per-line "View Slot Records"
  // fetch to `where('lineId', '==', lineId)`.
  lineId: string;
  lineName: string;
  shift: 'A' | 'B' | null;
  dateLabel: string;
  records: number;
  // Every value below is a plain sum across the independent records in this
  // productionDate + line + shift group — no cumulative counters, no
  // "highest slot index wins" logic.
  totalProduction: number;
  totalExpected: number;
  lossParts: number;
  lossTimeMinutes: number;
  rejections: number;
  downtimeMinutes: number;
  // Unique operator names across every record in this line + productionDate
  // + shift group (see ProductionRecord.operators). operatorCount is just
  // operatorNames.length, kept as its own field since it's shown on its own
  // in the card/share text.
  operatorNames: string[];
  operatorCount: number;
};

// ─── Constants ────────────────────────────────────────────────────────────────

// ─── Constants ────────────────────────────────────────────────────────────────

const SHIFTS = ['All', 'A', 'B'] as const;

// ─── Dropdown picker (tap-a-box → select from list) ────────────────────────────
// Matches the picker pattern used in RecordProductionScreen: each filter is a
// single box; tapping it opens a modal list of the valid options for that
// field. Keeping the same pattern here keeps the two screens' filter UIs
// consistent for supervisors/admins moving between them.

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Case/whitespace-insensitive equality. Filters (Plant/Workshop/Division) are
// drawn from the same PLANTS/WORKSHOPS/DIVISIONS constants that productionLines
// and productionRecords are written with, but hand-edited Firestore data can
// drift in case or trailing spaces — used everywhere a filter value is
// compared against a record/line field so the line picker and the actual
// report query always agree on what "matches" means.
function sameValue(a: string | null | undefined, b: string | null | undefined) {
  if (a == null || b == null) return false;
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

// Fallback for when a supervisor saved a slot with real downtime but never
// went through the manual loss-reason confirmation (lossReasonLabel stays
// null in that case) - derives a reason directly from the slot's own
// stopEvents instead of showing loss parts with no explanation at all.
function deriveReasonFromStops(events: StopEventRecord[] | null): string | null {
  if (!events || events.length === 0) return null;
  const reasons = Array.from(new Set(events.map((e) => e.reason).filter(Boolean)));
  if (reasons.length === 0) return null;
  return reasons.join(', ');
}

// Division only applies under the Assembly workshop. Matched by substring
// rather than an exact hardcoded string so this doesn't silently break if the
// exact label in lineOptions.ts changes (e.g. "Assembly" vs "Assembly Shop").
function isAssemblyWorkshop(w: string | null) {
  return !!w && w.toLowerCase().includes('assembly');
}

function pad2(n: number) {
  return String(n).padStart(2, '0');
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function isValidDateStr(s: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(`${s}T00:00:00`).getTime());
}

// Reusable formatter for the From/To TextInputs — auto-inserts the dashes
// as the user types so they never have to type "-" themselves. Strips
// everything but digits first (so backspacing over a dash, or pasting a
// pre-formatted date, both normalize correctly), then re-inserts a dash
// after the 4th digit and after the 6th digit.
//
// NOTE: this is deliberately YYYY-MM-DD grouping (dash after digit 4, dash
// after digit 6) rather than DD-MM-YYYY (dash after digit 2, dash after
// digit 4) — fromDate/toDate feed straight into isValidDateStr's
// /^\d{4}-\d{2}-\d{2}$/ check and into `new Date(`${fromDate}T00:00:00`)`
// for the Firestore Timestamp range query above, both of which require
// YYYY-MM-DD. Matching the DD-MM-YYYY grouping shown in the original
// examples would silently break both. Same 8-digit/10-character cap either
// way — only the grouping differs.
function formatDateInputValue(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 8);
  const year = digits.slice(0, 4);
  const month = digits.slice(4, 6);
  const day = digits.slice(6, 8);
  let out = year;
  if (month) out += `-${month}`;
  if (day) out += `-${day}`;
  return out;
}

function dateStrDaysAgo(days: number) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function firstOfMonthStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-01`;
}

const DATE_PRESETS: { key: string; label: string; from: () => string; to: () => string }[] = [
  { key: 'today', label: 'Today', from: todayStr, to: todayStr },
  { key: 'yesterday', label: 'Yesterday', from: () => dateStrDaysAgo(1), to: () => dateStrDaysAgo(1) },
  { key: 'last7', label: 'Last 7 days', from: () => dateStrDaysAgo(6), to: todayStr },
  { key: 'month', label: 'This month', from: firstOfMonthStr, to: todayStr },
];

function formatDateLabel(ms: number | null) {
  if (!ms) return '—';
  const d = new Date(ms);
  return `${pad2(d.getDate())} ${d.toLocaleString('en-US', { month: 'short' })}`;
}

function dateKey(ms: number | null) {
  if (!ms) return 'unknown';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function formatDateTime(ms: number | null) {
  if (!ms) return '—';
  const d = new Date(ms);
  return `${pad2(d.getDate())} ${d.toLocaleString('en-US', { month: 'short' })}, ${d.getHours() % 12 === 0 ? 12 : d.getHours() % 12}:${pad2(d.getMinutes())} ${d.getHours() >= 12 ? 'PM' : 'AM'}`;
}

// ─── Component ────────────────────────────────────────────────────────────────

// Cards whose content genuinely grows with data count (a horizontal bar
// chart's rows, or a per-line/per-operator status list) should size exactly
// to that content up to `cap`, and only then scroll internally — so a
// report with 3 lines stays compact, and a report with 40 lines scrolls
// inside its own card instead of stretching the whole page.
function ScrollCappedBody({ naturalHeight, cap, children }: { naturalHeight: number; cap: number; children: React.ReactNode }) {
  if (naturalHeight <= cap) return <>{children}</>;
  return (
    <ScrollView style={{ maxHeight: cap }} nestedScrollEnabled showsVerticalScrollIndicator>
      {children}
    </ScrollView>
  );
}

export default function GenerateReportScreen() {
  const navigation = useNavigation<any>();

  // ── Filters
  const [plant, setPlant] = useState<string | null>(null);
  const [workshop, setWorkshop] = useState<string | null>(null);
  const [division, setDivision] = useState<string | null>(null);
  const [selectedLineId, setSelectedLineId] = useState<string | null>(null);
  const [partFilter, setPartFilter] = useState<string | null>(null);
  const [shiftFilter, setShiftFilter] = useState<(typeof SHIFTS)[number]>('All');
  const [fromDate, setFromDate] = useState(todayStr());
  const [toDate, setToDate] = useState(todayStr());

  // ── Which picker box is currently open (null = none)
  const [activeDropdown, setActiveDropdown] = useState<DropdownKind | null>(null);

  // ── Report Charts section — expand/collapse, built entirely from the
  // already-generated `records`/`byLine` data below; never triggers its own
  // Firestore query.
  const [showCharts, setShowCharts] = useState(false);

  // ── Lines (for the line filter + plant/workshop/division → lineName lookups)
  const [allLines, setAllLines] = useState<Line[]>([]);
  const [loadingLines, setLoadingLines] = useState(true);

  // ── Report state
  const [generating, setGenerating] = useState(false);
  const [hasGenerated, setHasGenerated] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [records, setRecords] = useState<ProductionRecord[]>([]);
  const [exportingExcel, setExportingExcel] = useState(false);

  // ── Per-line "View Slot Records" (lazy-loaded, one Firestore query per
  // line per report session). `lineSlotRecordsOpen` is keyed by the BY LINE
  // card's own `key` (line+date+shift group) so each card's disclosure
  // toggles independently. `lineSlotRecordsCache`/`Loading`/`Error` are
  // keyed by `lineId` instead — several cards can share the same line
  // (different dates/shifts), and per the requirement they all reuse the
  // same fetched-for-this-line data rather than re-querying Firestore.
  const [lineSlotRecordsOpen, setLineSlotRecordsOpen] = useState<Record<string, boolean>>({});
  const [lineSlotRecordsCache, setLineSlotRecordsCache] = useState<Record<string, ProductionRecord[]>>({});
  const [lineSlotRecordsLoading, setLineSlotRecordsLoading] = useState<Record<string, boolean>>({});
  const [lineSlotRecordsError, setLineSlotRecordsError] = useState<Record<string, string | null>>({});

  // ── Timing: ref stores when handleGenerate was called so the useEffect
  // below can measure wall-clock time from button tap to render commit.
  const generateStartRef = useRef<number>(0);

  // ── Timing point: fires after React commits the render that includes
  // hasGenerated === true, giving the total time from button tap to
  // the user actually seeing the report.
  useEffect(() => {
    if (hasGenerated && generateStartRef.current > 0) {
      console.log(
        `[GenerateReport] render commit after hasGenerated — ${Date.now() - generateStartRef.current}ms since button tap`
      );
    }
  }, [hasGenerated]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const snap = await getDocs(collection(db, 'productionLines'));
        if (!mounted) return;
        setAllLines(
          snap.docs.map((d) => {
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
              parts: partsArray.map((p: any) => ({ name: p.name ?? p.partName ?? '' })).filter((p: any) => p.name),
            };
          })
        );
      } catch (e) {
        console.error('[GenerateReport] load lines', e);
      } finally {
        if (mounted) setLoadingLines(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

  const filteredLines = useMemo(() => {
    return allLines.filter((l) => {
      if (plant && l.plant && !sameValue(l.plant, plant)) return false;
      if (workshop && l.workshop && !sameValue(l.workshop, workshop)) return false;
      if (division && l.division && !sameValue(l.division, division)) return false;
      return true;
    });
  }, [allLines, plant, workshop, division]);

  // BUG FIX: Division is only shown for the "Assembly" workshop, but the
  // previous version left a stale `division` value set after switching to a
  // different workshop — the field disappeared from the UI while silently
  // filtering out every record. Clear it whenever it's no longer applicable.
  useEffect(() => {
    if (!isAssemblyWorkshop(workshop) && division) setDivision(null);
  }, [workshop]); // eslint-disable-line react-hooks/exhaustive-deps

  // Clear a selected line if it falls outside the current plant/workshop/division filters
  useEffect(() => {
    if (selectedLineId && !filteredLines.some((l) => l.id === selectedLineId)) {
      setSelectedLineId(null);
    }
  }, [filteredLines, selectedLineId]);

  // Parts available to filter by: the selected line's parts, or every distinct
  // part name across the currently filtered lines when no single line is picked.
  const availableParts = useMemo(() => {
    const source = selectedLineId
      ? allLines.filter((l) => l.id === selectedLineId)
      : filteredLines;
    const names = new Set<string>();
    source.forEach((l) => (l.parts ?? []).forEach((p) => { if (p.name) names.add(p.name); }));
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [selectedLineId, filteredLines, allLines]);

  // Clear the part filter if it's no longer offered under the current line/location filters
  useEffect(() => {
    if (partFilter && !availableParts.includes(partFilter)) setPartFilter(null);
  }, [availableParts, partFilter]);

  // ─────────────────────────────────────────────────────────────────────────────
  // GENERATE REPORT
  // ─────────────────────────────────────────────────────────────────────────────

  const handleGenerate = async () => {
    if (!isValidDateStr(fromDate) || !isValidDateStr(toDate)) {
      Alert.alert('Invalid date', 'Enter dates as YYYY-MM-DD.');
      return;
    }
    if (fromDate > toDate) {
      Alert.alert('Invalid range', '"From" date must be on or before "To" date.');
      return;
    }

    generateStartRef.current = Date.now(); // ── Timing: capture button-tap time
    setGenerating(true);
    setLoadError(null);
    // A new report generation starts a new "session" for the lazy per-line
    // slot-record fetches below — without this, a line's cache entry from a
    // PREVIOUS fromDate/toDate would still be keyed only by lineId and get
    // reused here, showing records from the wrong date range under the
    // newly generated report.
    setLineSlotRecordsOpen({});
    setLineSlotRecordsCache({});
    setLineSlotRecordsLoading({});
    setLineSlotRecordsError({});
    try {
      const fromTs = Timestamp.fromDate(new Date(`${fromDate}T00:00:00`));
      const toTs = Timestamp.fromDate(new Date(`${toDate}T23:59:59.999`));
      // Only range-filter in Firestore (createdAt); everything else is filtered
      // client-side below to avoid needing composite indexes.
      // Exception: when a specific line is selected, lineId is pushed into
      // the query too — this is the one added server-side constraint.
      console.log('[GenerateReport] selectedLineId at query time:', selectedLineId);
      const q = selectedLineId
        ? query(
            collection(db, 'productionRecords'),
            where('createdAt', '>=', fromTs),
            where('createdAt', '<=', toTs),
            where('lineId', '==', selectedLineId),
            orderBy('createdAt', 'asc')
          )
        : query(
            collection(db, 'productionRecords'),
            where('createdAt', '>=', fromTs),
            where('createdAt', '<=', toTs),
            orderBy('createdAt', 'asc')
          );

      // TEMPORARY DEBUG LOGGING — confirms at runtime which collection and
      // filters this query actually used. Safe to remove once the
      // sampleProductionRecord(s) tracing is done; deliberately does not
      // log full document contents (employee data lives in `operators`).
      console.log('[GenerateReport] FIRESTORE COLLECTION = productionRecords');
      console.log('[GenerateReport] QUERY DATE RANGE:', { fromDate, toDate, selectedLineId, shiftFilter });

      // ── Timing point 1: before Firestore network read
      const t0 = Date.now();
      console.log('[GenerateReport] 1 before getDocs');

      const snap = await getDocs(q);

      // TEMPORARY DEBUG LOGGING — see note above.
      console.log('[GenerateReport] DOCUMENT COUNT:', snap.size);

      // ── Timing point 2: after getDocs — captures pure Firestore latency
      console.log(`[GenerateReport] 2 after getDocs — ${Date.now() - t0}ms — ${snap.docs.length} docs`);

      const all: ProductionRecord[] = snap.docs.map((d) => {
        const data: any = d.data();
        return {
          id: d.id,
          shift: data.shift ?? 'A',
          plant: data.plant ?? null,
          workshop: data.workshop ?? null,
          division: data.division ?? null,
          lineId: data.lineId ?? null,
          lineName: data.lineName ?? null,
          partName: data.partName ?? null,
          slotIndex: data.slotIndex ?? null,
          slotLabel: data.slotLabel ?? null,
          slotStartMinutesAbs: data.slotStartMinutesAbs ?? null,
          slotEndMinutesAbs: data.slotEndMinutesAbs ?? null,
          productionDate: data.productionDate ?? null,
          expectedParts: data.expectedParts ?? null,
          producedThisSlot: data.producedThisSlot ?? null,
          lossParts: data.lossParts ?? null,
          lossTimeMinutes: data.lossTimeMinutes ?? null,
          lossReasonLabel: data.lossReasonLabel ?? null,
          rejections: data.rejections ?? null,
          stopEvents: Array.isArray(data.stopEvents) ? data.stopEvents : null,
          supervisorName: data.supervisor?.name ?? null,
          operators: Array.isArray(data.operators)
            ? data.operators.map((o: any) => ({ name: o?.name ?? '', code: o?.code ?? '' })).filter((o: any) => o.name)
            : null,
          createdAtMs: data.createdAt?.toMillis ? data.createdAt.toMillis() : null,
        };
      });

      // ── Timing point 3: after mapping snap.docs → ProductionRecord objects
      console.log(`[GenerateReport] 3 after map — ${Date.now() - t0}ms — ${all.length} records`);

      // BUG FIX: some already-saved records have null/mismatched
      // plant/workshop/division (a supervisor-side bug in how those got
      // stamped — see RecordProductionScreen). Rather than trust each
      // record's own copy of that data, resolve it from the authoritative
      // productionLines doc via lineId. Falls back to the record's own
      // fields if the line can't be found (e.g. since deleted).
      const lineById = new Map(allLines.map((l) => [l.id, l]));
      const resolved: ProductionRecord[] = all.map((r) => {
        const line = r.lineId ? lineById.get(r.lineId) : undefined;
        return {
          ...r,
          plant: line?.plant ?? r.plant,
          workshop: line?.workshop ?? r.workshop,
          division: line?.division ?? r.division,
          lineName: line?.lineName ?? r.lineName,
        };
      });

      const filtered = resolved.filter((r) => {
        if (plant && !sameValue(r.plant, plant)) return false;
        if (workshop && !sameValue(r.workshop, workshop)) return false;
        if (division && !sameValue(r.division, division)) return false;
        if (selectedLineId && r.lineId !== selectedLineId) return false;
        if (partFilter && !sameValue(r.partName, partFilter)) return false;
        if (shiftFilter !== 'All' && r.shift !== shiftFilter) return false;
        return true;
      });

      // ── Timing point 4: after client-side filter
      console.log(`[GenerateReport] 4 after filter — ${Date.now() - t0}ms — ${filtered.length} records after filters`);

      setRecords(filtered);
      setHasGenerated(true);

      // ── Timing point 5: after setRecords/setHasGenerated enqueued
      // (state updates are asynchronous; actual render happens later —
      // see the useEffect on hasGenerated for the render-commit time)
      console.log(`[GenerateReport] 5 after setRecords — ${Date.now() - t0}ms total JS time`);
    } catch (e) {
      console.error('[GenerateReport] generate', e);
      setLoadError('Could not load report data. Check your connection and try again.');
    } finally {
      setGenerating(false);
    }
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // PER-LINE SLOT RECORDS (lazy — only queried when a BY LINE card's "View
  // Slot Records" button is pressed)
  // ─────────────────────────────────────────────────────────────────────────────
  //
  // Mirrors handleGenerate's own query/mapping/line-resolution logic exactly,
  // just scoped to one lineId and reading the SAME fromDate/toDate/shiftFilter/
  // partFilter the admin currently has selected on screen (not the specific
  // date/shift of the card that was pressed — a card is only the trigger,
  // the line is the scope). Never runs until the button is pressed, and never
  // re-runs for a line that's already cached for this report session.
  const handleToggleLineSlotRecords = async (card: LineDayBreakdown) => {
    const cardKey = card.key;
    const lineId = card.lineId;

    // Card is already open → this press just closes it. No Firestore call,
    // and any already-fetched data for this line stays cached for later.
    if (lineSlotRecordsOpen[cardKey]) {
      setLineSlotRecordsOpen((prev) => ({ ...prev, [cardKey]: false }));
      return;
    }

    setLineSlotRecordsOpen((prev) => ({ ...prev, [cardKey]: true }));

    // Already fetched this line during the current report session (from
    // this card or another card for the same line) → reuse it, no query.
    if (lineSlotRecordsCache[lineId]) return;

    setLineSlotRecordsLoading((prev) => ({ ...prev, [lineId]: true }));
    setLineSlotRecordsError((prev) => ({ ...prev, [lineId]: null }));
    try {
      const fromTs = Timestamp.fromDate(new Date(`${fromDate}T00:00:00`));
      const toTs = Timestamp.fromDate(new Date(`${toDate}T23:59:59.999`));

      // Exact Firestore lineId for this line, plus the currently selected
      // From/To range — same composite pattern as the selectedLineId branch
      // in handleGenerate above. If this needs a composite index Firestore
      // doesn't already have, that error is surfaced as-is below rather
      // than worked around.
      const q = query(
        collection(db, 'productionRecords'),
        where('lineId', '==', lineId),
        where('createdAt', '>=', fromTs),
        where('createdAt', '<=', toTs),
        orderBy('createdAt', 'asc')
      );

      console.log('[GenerateReport] slot fetch:', { lineId, fromDate, toDate });

      const snap = await getDocs(q);

      console.log('[GenerateReport] slot fetch result:', snap.size, 'records');

      const mapped: ProductionRecord[] = snap.docs.map((d) => {
        const data: any = d.data();
        return {
          id: d.id,
          shift: data.shift ?? 'A',
          plant: data.plant ?? null,
          workshop: data.workshop ?? null,
          division: data.division ?? null,
          lineId: data.lineId ?? null,
          lineName: data.lineName ?? null,
          partName: data.partName ?? null,
          slotIndex: data.slotIndex ?? null,
          slotLabel: data.slotLabel ?? null,
          slotStartMinutesAbs: data.slotStartMinutesAbs ?? null,
          slotEndMinutesAbs: data.slotEndMinutesAbs ?? null,
          productionDate: data.productionDate ?? null,
          expectedParts: data.expectedParts ?? null,
          producedThisSlot: data.producedThisSlot ?? null,
          lossParts: data.lossParts ?? null,
          lossTimeMinutes: data.lossTimeMinutes ?? null,
          lossReasonLabel: data.lossReasonLabel ?? null,
          rejections: data.rejections ?? null,
          stopEvents: Array.isArray(data.stopEvents) ? data.stopEvents : null,
          supervisorName: data.supervisor?.name ?? null,
          operators: Array.isArray(data.operators)
            ? data.operators.map((o: any) => ({ name: o?.name ?? '', code: o?.code ?? '' })).filter((o: any) => o.name)
            : null,
          createdAtMs: data.createdAt?.toMillis ? data.createdAt.toMillis() : null,
        };
      });

      // Same plant/workshop/division/lineName resolution-from-productionLines
      // fallback as handleGenerate, for consistency with the main report.
      const lineById = new Map(allLines.map((l) => [l.id, l]));
      const resolved: ProductionRecord[] = mapped.map((r) => {
        const line = r.lineId ? lineById.get(r.lineId) : undefined;
        return {
          ...r,
          plant: line?.plant ?? r.plant,
          workshop: line?.workshop ?? r.workshop,
          division: line?.division ?? r.division,
          lineName: line?.lineName ?? r.lineName,
        };
      });

      // lineId is already server-side filtered above; only the currently
      // selected Shift and Part filters need applying client-side here.
      const filtered = resolved.filter((r) => {
        if (partFilter && !sameValue(r.partName, partFilter)) return false;
        if (shiftFilter !== 'All' && r.shift !== shiftFilter) return false;
        return true;
      });

      setLineSlotRecordsCache((prev) => ({ ...prev, [lineId]: filtered }));
    } catch (e: any) {
      console.error('[GenerateReport] slot records fetch failed for line', lineId, e);
      // Surface the exact Firebase error (e.g. a missing-composite-index
      // message) rather than a generic fallback string.
      setLineSlotRecordsError((prev) => ({
        ...prev,
        [lineId]: e?.message ? String(e.message) : 'Could not load slot records for this line.',
      }));
    } finally {
      setLineSlotRecordsLoading((prev) => ({ ...prev, [lineId]: false }));
    }
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // AGGREGATES
  // ─────────────────────────────────────────────────────────────────────────────

  const summary = useMemo(() => {
    // Every saved slot or split is an independent record — Total Produced
    // and Total Expected are just plain sums, no "last cumulative wins" or
    // session-level planned total to reconcile.
    let totalProduction = 0;
    let totalExpected = 0;
    let lossParts = 0;
    let lossTimeMinutes = 0;
    let rejections = 0;
    let downtimeMinutes = 0;
    records.forEach((r) => {
      totalProduction += r.producedThisSlot ?? 0;
      totalExpected += r.expectedParts ?? 0;
      lossParts += r.lossParts ?? Math.max(0, (r.expectedParts ?? 0) - (r.producedThisSlot ?? 0));
      lossTimeMinutes += r.lossTimeMinutes ?? 0;
      rejections += r.rejections ?? 0;
      (r.stopEvents ?? []).forEach((se) => { downtimeMinutes += se.durationMinutes ?? 0; });
    });

    const efficiency = totalExpected > 0 ? Math.round((totalProduction / totalExpected) * 1000) / 10 : 0;
    return {
      totalProduction,
      plannedTotal: totalExpected,
      lossParts: Math.round(lossParts),
      lossTimeMinutes: Math.round(lossTimeMinutes),
      rejections,
      downtimeMinutes: Math.round(downtimeMinutes),
      efficiency,
      count: records.length,
    };
  }, [records]);

  const byLine = useMemo<LineDayBreakdown[]>(() => {
    // operatorSet is tracked alongside each group but not part of the public
    // LineDayBreakdown shape — finalized into a sorted, de-duped
    // operatorNames array (and its length as operatorCount) below.
    const map = new Map<string, LineDayBreakdown & { operatorSet: Set<string> }>();
    records.forEach((r) => {
      // Group by productionDate + line + shift — a line can run more than
      // one part/session in the same shift now (via changeovers), and this
      // key treats all of them as one group for the "BY LINE" rollup.
      const pd = r.productionDate ?? dateKey(r.createdAtMs);
      const key = `${r.lineId ?? 'unknown'}__${pd}__${r.shift}`;
      const downtime = (r.stopEvents ?? []).reduce((sum, se) => sum + (se.durationMinutes ?? 0), 0);
      const produced = r.producedThisSlot ?? 0;
      const expected = r.expectedParts ?? 0;
      const loss = r.lossParts ?? Math.max(0, expected - produced);
      const existing = map.get(key);
      if (existing) {
        existing.records += 1;
        existing.totalProduction += produced;
        existing.totalExpected += expected;
        existing.lossParts += loss;
        existing.lossTimeMinutes += r.lossTimeMinutes ?? 0;
        existing.rejections += r.rejections ?? 0;
        existing.downtimeMinutes += downtime;
        (r.operators ?? []).forEach((o) => { if (o.name) existing.operatorSet.add(o.name); });
      } else {
        const operatorSet = new Set<string>();
        (r.operators ?? []).forEach((o) => { if (o.name) operatorSet.add(o.name); });
        map.set(key, {
          key,
          lineId: r.lineId ?? 'unknown',
          lineName: r.lineName ?? 'Unknown line',
          shift: r.shift ?? null,
          dateLabel: formatDateLabel(r.createdAtMs),
          records: 1,
          totalProduction: produced,
          totalExpected: expected,
          lossParts: loss,
          lossTimeMinutes: r.lossTimeMinutes ?? 0,
          rejections: r.rejections ?? 0,
          downtimeMinutes: downtime,
          operatorNames: [],
          operatorCount: 0,
          operatorSet,
        });
      }
    });
    return Array.from(map.values())
      .map(({ operatorSet, ...rest }) => {
        const operatorNames = Array.from(operatorSet).sort((a, b) => a.localeCompare(b));
        return { ...rest, operatorNames, operatorCount: operatorNames.length };
      })
      .sort((a, b) => (a.lineName + a.dateLabel).localeCompare(b.lineName + b.dateLabel));
  }, [records]);

  // ── Chart data: Production vs Planned, one pair per line ───────────────
  // Collapses byLine (which is grouped by line + date + shift) down to a
  // single produced/planned total per line, across every date/shift the
  // current filters matched — this is purely a re-aggregation of byLine,
  // so it uses the already-generated report data and never queries
  // Firestore again.
  const lineTotals = useMemo(() => {
    const map = new Map<string, { lineName: string; produced: number; planned: number }>();
    byLine.forEach((b) => {
      const existing = map.get(b.lineName);
      if (existing) {
        existing.produced += b.totalProduction;
        existing.planned += b.totalExpected;
      } else {
        map.set(b.lineName, { lineName: b.lineName, produced: b.totalProduction, planned: b.totalExpected });
      }
    });
    return Array.from(map.values()).sort((a, b) => a.lineName.localeCompare(b.lineName));
  }, [byLine]);

  // gifted-charts' BarChart has no dedicated "grouped bar" prop — the
  // documented way to get a grouped/paired bar chart is a flat bar list
  // where each pair (produced, planned) uses a small `spacing` to sit
  // close together, and the label is set once on the first bar of the
  // pair so it renders centered under that pair.
  const PRODUCED_COLOR = '#4C9A6A';
  const PLANNED_COLOR = '#F2A93B';
  const GROUP_INNER_SPACING = 2;
  const GROUP_OUTER_SPACING = 22;
  const BAR_WIDTH = 16;

  // Horizontal bar charts (Efficiency by Line, Downtime, Part-wise
  // Production, Operator Distribution) — sized so a report with just a
  // couple of bars still reads as a real chart (180px floor) rather than a
  // squashed sliver, while more bars still get proportionally more room.
  const HBAR_WIDTH = 18;
  const HBAR_SPACING = 22;
  function horizontalBarChartHeight(count: number) {
    if (count === 0) return 0;
    return Math.max(180, count * 55);
  }

  // Vertical bar / line charts don't need MORE height for more bars (that's
  // a width concern — more bars sit side by side, handled by the existing
  // horizontal ScrollView on those charts) — they just need a fixed height
  // for the value scale itself.
  const VBAR_CHART_HEIGHT = 240;
  const LINE_CHART_HEIGHT = 260;

  // Cards whose content genuinely grows with data count (a horizontal bar
  // chart's rows, or a per-line/per-operator status list) should size
  // exactly to that content up to this cap, and only then scroll
  // internally — so a report with 3 lines stays compact, and a report with
  // 40 lines scrolls inside its own card instead of stretching the whole
  // page.
  const CHART_SCROLL_CAP = 340;
  const LIST_SCROLL_CAP = 220;

  const productionVsPlannedBarData = useMemo(() => {
    const data: any[] = [];
    lineTotals.forEach((l) => {
      data.push({
        value: l.produced,
        frontColor: PRODUCED_COLOR,
        spacing: GROUP_INNER_SPACING,
        label: l.lineName,
        labelTextStyle: { color: '#8A96A3', fontSize: 10.5 },
      });
      data.push({
        value: l.planned,
        frontColor: PLANNED_COLOR,
        spacing: GROUP_OUTER_SPACING,
      });
    });
    return data;
  }, [lineTotals]);

  const chartWidth = Math.max(
    Dimensions.get('window').width - 40,
    lineTotals.length * (BAR_WIDTH * 2 + GROUP_INNER_SPACING + GROUP_OUTER_SPACING) + 40
  );

  // ── Chart data: Efficiency by Line ──────────────────────────────────────
  // Re-aggregates lineTotals (already computed above) into a % figure per
  // line, color-coded by the standard efficiency bands.
  function efficiencyColor(pct: number) {
    if (pct >= 95) return '#4C9A6A'; // green
    if (pct >= 85) return '#D9C441'; // yellow
    if (pct >= 70) return '#E07B39'; // orange
    return '#D64545'; // red
  }

  const efficiencyByLine = useMemo(() => {
    return lineTotals
      .map((l) => ({
        lineName: l.lineName,
        efficiency: l.planned > 0 ? Math.round((l.produced / l.planned) * 1000) / 10 : 0,
      }))
      .sort((a, b) => b.efficiency - a.efficiency);
  }, [lineTotals]);

  const efficiencyBarData = useMemo(
    () =>
      efficiencyByLine.map((l) => ({
        value: l.efficiency,
        label: l.lineName,
        frontColor: efficiencyColor(l.efficiency),
        labelTextStyle: { color: '#8A96A3', fontSize: 10.5 },
      })),
    [efficiencyByLine]
  );

  // ── Chart data: Production Trend ────────────────────────────────────────
  // Groups every matching record by its productionDate (falling back to a
  // date derived from createdAt for older records without that field —
  // same fallback used by byLine above) and sums producedThisSlot. Works
  // for a single-day report (one point) or a multi-day range (a real trend
  // line) without any special-casing.
  const productionTrend = useMemo(() => {
    const map = new Map<string, number>();
    records.forEach((r) => {
      const pd = r.productionDate ?? dateKey(r.createdAtMs);
      map.set(pd, (map.get(pd) ?? 0) + (r.producedThisSlot ?? 0));
    });
    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, produced]) => ({ date, produced }));
  }, [records]);

  const productionTrendLineData = useMemo(
    () =>
      productionTrend.map((p) => ({
        value: p.produced,
        // Trim to MM-DD so multi-week ranges don't overlap on screen; the
        // full date is still available via the point's dataPointText/tooltip.
        label: p.date.slice(5),
        labelTextStyle: { color: '#8A96A3', fontSize: 10 },
        dataPointText: String(p.produced),
      })),
    [productionTrend]
  );

  const trendChartWidth = Math.max(
    Dimensions.get('window').width - 40,
    productionTrend.length * 56 + 40
  );

  // ── Chart data: Loss Analysis ───────────────────────────────────────────
  // Groups every record's lossParts by its reason — lossReasonLabel when the
  // supervisor logged one explicitly, otherwise the same derived-from-stops
  // fallback the record list below already uses, otherwise "Unspecified".
  const LOSS_CHART_COLORS = ['#D64545', '#E07B39', '#D9C441', '#3E7CB1', '#8A5CF5', '#4C9A6A', '#8A96A3'];

  const lossByReason = useMemo(() => {
    const map = new Map<string, number>();
    records.forEach((r) => {
      const loss = r.lossParts ?? Math.max(0, (r.expectedParts ?? 0) - (r.producedThisSlot ?? 0));
      if (loss <= 0) return;
      const reason = r.lossReasonLabel || deriveReasonFromStops(r.stopEvents) || 'Unspecified';
      map.set(reason, (map.get(reason) ?? 0) + loss);
    });
    const totalLoss = Array.from(map.values()).reduce((s, v) => s + v, 0);
    return Array.from(map.entries())
      .map(([reason, parts], i) => ({
        reason,
        parts,
        pct: totalLoss > 0 ? Math.round((parts / totalLoss) * 1000) / 10 : 0,
        color: LOSS_CHART_COLORS[i % LOSS_CHART_COLORS.length],
      }))
      .sort((a, b) => b.parts - a.parts);
  }, [records]);

  const lossDonutData = useMemo(
    () => lossByReason.map((l) => ({ value: l.parts, color: l.color, text: `${l.pct}%` })),
    [lossByReason]
  );
  const totalLossParts = useMemo(() => lossByReason.reduce((s, l) => s + l.parts, 0), [lossByReason]);

  // ── Chart data: Downtime Analysis ───────────────────────────────────────
  // Sums every stop event's durationMinutes by its reason, across every
  // matching record.
  const downtimeByReason = useMemo(() => {
    const map = new Map<string, number>();
    records.forEach((r) => {
      (r.stopEvents ?? []).forEach((se) => {
        const reason = se.reason || 'Unspecified';
        map.set(reason, (map.get(reason) ?? 0) + (se.durationMinutes ?? 0));
      });
    });
    return Array.from(map.entries())
      .map(([reason, minutes]) => ({ reason, minutes: Math.round(minutes) }))
      .sort((a, b) => b.minutes - a.minutes);
  }, [records]);

  const downtimeBarData = useMemo(
    () =>
      downtimeByReason.map((d, i) => ({
        value: d.minutes,
        label: d.reason,
        frontColor: LOSS_CHART_COLORS[i % LOSS_CHART_COLORS.length],
        labelTextStyle: { color: '#8A96A3', fontSize: 10.5 },
      })),
    [downtimeByReason]
  );

  // ── Chart data: Rejection Analysis ──────────────────────────────────────
  // Sums rejections by part name across every matching record.
  const rejectionsByPart = useMemo(() => {
    const map = new Map<string, number>();
    records.forEach((r) => {
      if (!r.rejections) return;
      const part = r.partName || 'Unknown part';
      map.set(part, (map.get(part) ?? 0) + r.rejections);
    });
    return Array.from(map.entries())
      .map(([part, rejections]) => ({ part, rejections }))
      .sort((a, b) => b.rejections - a.rejections);
  }, [records]);

  const rejectionBarData = useMemo(
    () =>
      rejectionsByPart.map((p) => ({
        value: p.rejections,
        label: p.part,
        frontColor: '#D64545',
        labelTextStyle: { color: '#8A96A3', fontSize: 10.5 },
      })),
    [rejectionsByPart]
  );

  // ── Chart data: Part-wise Production ────────────────────────────────────
  // Sums producedThisSlot by part name across every matching record.
  const productionByPart = useMemo(() => {
    const map = new Map<string, number>();
    records.forEach((r) => {
      const part = r.partName || 'Unknown part';
      map.set(part, (map.get(part) ?? 0) + (r.producedThisSlot ?? 0));
    });
    return Array.from(map.entries())
      .map(([part, produced]) => ({ part, produced }))
      .sort((a, b) => b.produced - a.produced);
  }, [records]);

  const partProductionBarData = useMemo(
    () =>
      productionByPart.map((p, i) => ({
        value: p.produced,
        label: p.part,
        frontColor: LOSS_CHART_COLORS[i % LOSS_CHART_COLORS.length],
        labelTextStyle: { color: '#8A96A3', fontSize: 10.5 },
      })),
    [productionByPart]
  );

  // ── Chart data: Operator Distribution ───────────────────────────────────
  // Each record carries its whole session's operator roster (see
  // ProductionRecord.operators) — there's no per-operator split of a
  // slot's output, so a slot's full producedThisSlot and a +1 to "slots
  // worked" are attributed to every operator listed on that record, same
  // as the BY LINE table's operator rollup does for headcount.
  const operatorDistribution = useMemo(() => {
    const map = new Map<string, { name: string; produced: number; slots: number }>();
    records.forEach((r) => {
      const produced = r.producedThisSlot ?? 0;
      (r.operators ?? []).forEach((o) => {
        if (!o.name) return;
        const existing = map.get(o.name);
        if (existing) {
          existing.produced += produced;
          existing.slots += 1;
        } else {
          map.set(o.name, { name: o.name, produced, slots: 1 });
        }
      });
    });
    return Array.from(map.values()).sort((a, b) => b.produced - a.produced);
  }, [records]);

  const operatorBarData = useMemo(
    () =>
      operatorDistribution.map((o) => ({
        value: o.produced,
        label: o.name,
        frontColor: '#3E7CB1',
        labelTextStyle: { color: '#8A96A3', fontSize: 10.5 },
      })),
    [operatorDistribution]
  );

  const handleShare = async () => {
    const lineName = selectedLineId ? allLines.find((l) => l.id === selectedLineId)?.lineName ?? null : null;
    const lines = [
      `Production Report`,
      `${fromDate} to ${toDate}`,
      plant ? `Plant: ${plant}` : null,
      workshop ? `Workshop: ${workshop}` : null,
      division ? `Division: ${division}` : null,
      lineName ? `Line: ${lineName}` : null,
      partFilter ? `Part: ${partFilter}` : null,
      shiftFilter !== 'All' ? `Shift: ${shiftFilter}` : null,
      '',
      `Total Produced: ${summary.totalProduction} / Planned: ${summary.plannedTotal}`,
      `Efficiency: ${summary.efficiency}% | Loss Parts: ${summary.lossParts} | Time Loss: ${summary.lossTimeMinutes} min`,
      `Rejections: ${summary.rejections}`,
      `Downtime: ${summary.downtimeMinutes} min`,
      `Slots recorded: ${summary.count}`,
      '',
      ...byLine.map((b) => {
        const base = `${b.lineName} (${b.dateLabel}): ${b.totalProduction}/${b.totalExpected} produced, ${b.rejections} rejections`;
        return b.operatorCount > 0
          ? `${base}\n  Operators (${b.operatorCount}): ${b.operatorNames.join(', ')}`
          : base;
      }),
    ].filter((l): l is string => l != null);

    try {
      await Share.share({ message: lines.join('\n') });
    } catch (e) {
      console.error('[GenerateReport] share', e);
    }
  };

  // Builds the workbook purely from the already-generated `records` /
  // `summary` / `byLine` — no new Firestore query. Mirrors handleShare's
  // pattern (same filter/loss-reason values), just exported as three sheets
  // instead of one text message.
  const handleExportExcel = async () => {
    if (exportingExcel) return;
    setExportingExcel(true);
    try {
      const lineName = selectedLineId ? allLines.find((l) => l.id === selectedLineId)?.lineName ?? null : null;

      const detailRows: ExcelDetailRow[] = records.map((r) => {
        const downtimeMinutes = (r.stopEvents ?? []).reduce((sum, se) => sum + (se.durationMinutes ?? 0), 0);
        return {
          productionDate: r.productionDate ?? dateKey(r.createdAtMs),
          shift: r.shift,
          plant: r.plant,
          workshop: r.workshop,
          division: r.division,
          lineName: r.lineName,
          partName: r.partName,
          slot: r.slotLabel ?? (r.slotIndex != null ? `Slot ${r.slotIndex}` : null),
          produced: r.producedThisSlot,
          planned: r.expectedParts,
          lossParts: r.lossParts,
          lossTimeMinutes: r.lossTimeMinutes,
          lossReason: r.lossReasonLabel || deriveReasonFromStops(r.stopEvents),
          rejections: r.rejections,
          downtimeMinutes,
          supervisorName: r.supervisorName,
          operatorCount: r.operators?.length ?? 0,
          operatorNames: (r.operators ?? []).map((o) => o.name).join(', '),
        };
      });

      const lineSummaryRows: ExcelLineSummaryRow[] = byLine.map((b) => ({
        lineName: b.lineName,
        dateLabel: b.dateLabel,
        shift: b.shift,
        records: b.records,
        totalProduction: b.totalProduction,
        totalExpected: b.totalExpected,
        lossParts: b.lossParts,
        lossTimeMinutes: b.lossTimeMinutes,
        rejections: b.rejections,
        downtimeMinutes: b.downtimeMinutes,
        operatorCount: b.operatorCount,
        operatorNames: b.operatorNames,
      }));

      // Source rows for the HOURLY REPORT / HOURLY - <line> sheets — same
      // `records` this screen already loaded, no new Firestore query. Uses
      // the SUMMARY/BY LINE `lossParts` fallback (r.lossParts ?? Math.max(0,
      // expected - produced)), NOT the raw value the flat detailRows above
      // use, so hourly totals reconcile with the SUMMARY sheet's Loss Parts.
      const hourlyRows: ExcelHourlySourceRow[] = records.map((r) => {
        const planned = r.expectedParts ?? 0;
        const produced = r.producedThisSlot ?? 0;
        const downtimeMinutes = (r.stopEvents ?? []).reduce((sum, se) => sum + (se.durationMinutes ?? 0), 0);
        const operatorNames = Array.from(new Set((r.operators ?? []).map((o) => o.name).filter(Boolean)));
        return {
          productionDate: r.productionDate ?? dateKey(r.createdAtMs),
          shift: r.shift,
          lineName: r.lineName,
          partName: r.partName,
          slotStartMinutesAbs: r.slotStartMinutesAbs,
          slotEndMinutesAbs: r.slotEndMinutesAbs,
          planned,
          produced,
          lossParts: r.lossParts ?? Math.max(0, planned - produced),
          lossTimeMinutes: r.lossTimeMinutes ?? 0,
          lossReason: r.lossReasonLabel || deriveReasonFromStops(r.stopEvents),
          rejections: r.rejections ?? 0,
          downtimeMinutes,
          supervisorName: r.supervisorName,
          operatorNames,
        };
      });

      await exportReportToExcel({
        filters: { fromDate, toDate, plant, workshop, division, lineName, partFilter, shiftFilter },
        summary,
        detailRows,
        lineSummaryRows,
        hourlyRows,
      });

      Alert.alert(
        'Export complete',
        Platform.OS === 'web' ? 'The Excel file has downloaded.' : 'Choose where to save or send the Excel file.'
      );
    } catch (e) {
      console.error('[GenerateReport] excel export', e);
      Alert.alert('Export failed', 'Could not generate the Excel file. Please try again.');
    } finally {
      setExportingExcel(false);
    }
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // FILTER PICKERS
  // ─────────────────────────────────────────────────────────────────────────────

  const dropdownOptions: DropdownOption[] = useMemo(() => {
    switch (activeDropdown) {
      case 'plant':
        return [{ key: 'ANY', label: 'Any' }, ...PLANTS.map((p) => ({ key: p, label: p }))];
      case 'workshop':
        return [{ key: 'ANY', label: 'Any' }, ...WORKSHOPS.map((w) => ({ key: w, label: w }))];
      case 'division':
        return [{ key: 'ANY', label: 'Any' }, ...DIVISIONS.map((d) => ({ key: d, label: d }))];
      case 'line':
        return [
          { key: 'ALL', label: 'All lines' },
          ...filteredLines.map((l) => ({
            key: l.id,
            label: l.lineName ?? l.id,
            sublabel: [l.plant, l.workshop].filter(Boolean).join(' · ') || undefined,
          })),
        ];
      case 'part':
        return [{ key: 'ALL', label: 'All parts' }, ...availableParts.map((p) => ({ key: p, label: p }))];
      case 'shift':
        return SHIFTS.map((s) => ({ key: s, label: s === 'All' ? 'All shifts' : `Shift ${s}` }));
      default:
        return [];
    }
  }, [activeDropdown, filteredLines, availableParts]);

  const dropdownSelectedKey = useMemo(() => {
    switch (activeDropdown) {
      case 'plant': return plant ?? 'ANY';
      case 'workshop': return workshop ?? 'ANY';
      case 'division': return division ?? 'ANY';
      case 'line': return selectedLineId ?? 'ALL';
      case 'part': return partFilter ?? 'ALL';
      case 'shift': return shiftFilter;
      default: return '';
    }
  }, [activeDropdown, plant, workshop, division, selectedLineId, partFilter, shiftFilter]);

  function handleDropdownSelect(key: string) {
    switch (activeDropdown) {
      case 'plant':
        setPlant(key === 'ANY' ? null : key);
        break;
      case 'workshop':
        setWorkshop(key === 'ANY' ? null : key);
        break;
      case 'division':
        setDivision(key === 'ANY' ? null : key);
        break;
      case 'line':
        setSelectedLineId(key === 'ALL' ? null : key);
        setPartFilter(null); // part list depends on the line, so start fresh
        break;
      case 'part':
        setPartFilter(key === 'ALL' ? null : key);
        break;
      case 'shift':
        setShiftFilter(key as (typeof SHIFTS)[number]);
        break;
    }
    setActiveDropdown(null);
  }

  const hasActiveFilters = !!(plant || workshop || division || selectedLineId || partFilter || shiftFilter !== 'All');

  const resetFilters = () => {
    setPlant(null);
    setWorkshop(null);
    setDivision(null);
    setSelectedLineId(null);
    setPartFilter(null);
    setShiftFilter('All');
  };

  // ── Slot-record row — identical markup/styles to the original
  // always-visible SLOT RECORDS list, now reused inside each BY LINE
  // card's disclosure section instead of one screen-wide list.
  const renderSlotRecordRow = (r: ProductionRecord) => (
    <View style={styles.recordRow}>
      <View style={{ flex: 1 }}>
        <Text style={styles.recordLine}>{r.lineName ?? '—'} · Shift {r.shift}</Text>
        <Text style={styles.recordMeta}>
          {r.slotLabel ?? '—'} · {r.partName ?? '—'} · {formatDateTime(r.createdAtMs)}
        </Text>
        {r.supervisorName && <Text style={styles.recordMeta}>Supervisor: {r.supervisorName}</Text>}
      </View>
      <View style={{ alignItems: 'flex-end', gap: 2 }}>
        {/* Slot produced / expected-for-this-slot */}
        <Text style={styles.recordStat}>
          {r.producedThisSlot ?? 0} / {r.expectedParts ?? 0}
        </Text>
        {/* Loss parts for this slot */}
        {(r.lossParts ?? 0) > 0 && (() => {
          const reason = r.lossReasonLabel || deriveReasonFromStops(r.stopEvents);
          return (
            <Text style={styles.recordLoss}>
              {r.lossParts} loss{r.lossTimeMinutes ? ` · ${r.lossTimeMinutes}m` : ''}
              {' · '}
              {reason ? reason : <Text style={styles.recordLossNoReason}>no reason logged</Text>}
            </Text>
          );
        })()}
        {!!r.rejections && <Text style={styles.recordReject}>{r.rejections} rej</Text>}
      </View>
    </View>
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <Pressable onPress={() => navigation.goBack()} style={styles.backButton} hitSlop={12}>
          <Ionicons name="arrow-back" size={22} color="#8A96A3" />
          <Text style={styles.backText}>Back</Text>
        </Pressable>

        <Text style={styles.title}>Generate Report</Text>
        <Text style={styles.subtitle}>Filter and export a production summary</Text>

        {/* FILTERS */}
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text style={styles.sectionLabel}>FILTERS</Text>
          {hasActiveFilters && (
            <Pressable onPress={resetFilters} hitSlop={8}>
              <Text style={styles.resetText}>Reset</Text>
            </Pressable>
          )}
        </View>

        <PickerBox label="Plant" value={plant} placeholder="Any" onPress={() => setActiveDropdown('plant')} />
        <PickerBox label="Workshop" value={workshop} placeholder="Any" onPress={() => setActiveDropdown('workshop')} />
        {isAssemblyWorkshop(workshop) && (
          <PickerBox label="Division" value={division} placeholder="Any" onPress={() => setActiveDropdown('division')} />
        )}

        {loadingLines ? (
          <View style={styles.field}>
            <Text style={styles.label}>Line</Text>
            <ActivityIndicator color="#F2A93B" />
          </View>
        ) : (
          <PickerBox
            label="Line"
            value={selectedLineId ? filteredLines.find((l) => l.id === selectedLineId)?.lineName ?? null : null}
            placeholder="All lines"
            onPress={() => setActiveDropdown('line')}
          />
        )}

        <PickerBox
          label="Part / Model"
          value={partFilter}
          placeholder={availableParts.length ? 'All parts' : 'No parts available'}
          disabled={!availableParts.length}
          onPress={() => setActiveDropdown('part')}
        />

        <PickerBox
          label="Shift"
          value={shiftFilter === 'All' ? null : `Shift ${shiftFilter}`}
          placeholder="All shifts"
          onPress={() => setActiveDropdown('shift')}
        />

        <View style={styles.field}>
          <Text style={styles.label}>Quick range</Text>
          <View style={styles.chipsRow}>
            {DATE_PRESETS.map((preset) => {
              const active = fromDate === preset.from() && toDate === preset.to();
              return (
                <Pressable
                  key={preset.key}
                  onPress={() => { setFromDate(preset.from()); setToDate(preset.to()); }}
                  style={[styles.chip, active && styles.chipSelected]}
                >
                  <Text style={[styles.chipText, active && styles.chipTextSelected]}>{preset.label}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        <View style={styles.row}>
          <View style={{ flex: 1, marginRight: 8 }}>
            <Text style={styles.label}>From</Text>
            <TextInput
              style={styles.input}
              value={fromDate}
              onChangeText={(v) => setFromDate(formatDateInputValue(v))}
              placeholder="YYYY-MM-DD"
              placeholderTextColor="#5C6670"
              autoCapitalize="none"
              keyboardType="number-pad"
              maxLength={10}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.label}>To</Text>
            <TextInput
              style={styles.input}
              value={toDate}
              onChangeText={(v) => setToDate(formatDateInputValue(v))}
              placeholder="YYYY-MM-DD"
              placeholderTextColor="#5C6670"
              autoCapitalize="none"
              keyboardType="number-pad"
              maxLength={10}
            />
          </View>
        </View>

        {/* GENERATE BUTTON */}
        <Pressable
          style={({ pressed }) => [styles.generateButton, (generating || pressed) && styles.generateButtonPressed]}
          onPress={handleGenerate}
          disabled={generating}
        >
          {generating ? (
            <ActivityIndicator color="#14181C" />
          ) : (
            <>
              <Ionicons name="stats-chart" size={20} color="#14181C" />
              <Text style={styles.generateButtonText}>Generate Report</Text>
            </>
          )}
        </Pressable>

        {loadError && (
          <View style={styles.centered}>
            <Ionicons name="alert-circle" size={22} color="#D64545" />
            <Text style={styles.errorText}>{loadError}</Text>
            <Pressable onPress={handleGenerate} style={styles.retryButton}>
              <Text style={styles.retryText}>Retry</Text>
            </Pressable>
          </View>
        )}

        {/* RESULTS */}
        {hasGenerated && !loadError && (
          <>
            {records.length === 0 ? (
              <View style={styles.centered}>
                <Ionicons name="document-text-outline" size={28} color="#5C6670" />
                <Text style={styles.emptyText}>No production records match these filters.</Text>
              </View>
            ) : (
              <>
                <View style={styles.resultsHeader}>
                  <Text style={styles.sectionLabel}>SUMMARY</Text>
                  <View style={styles.resultsHeaderActions}>
                    <Pressable onPress={() => setShowCharts((v) => !v)} style={styles.viewChartsButton} hitSlop={8}>
                      <Text style={styles.viewChartsButtonIcon}>📈</Text>
                      <Text style={styles.viewChartsButtonText}>{showCharts ? 'Hide Charts' : 'View Charts'}</Text>
                    </Pressable>
                    <Pressable
                      onPress={handleExportExcel}
                      disabled={exportingExcel}
                      style={[styles.excelButton, exportingExcel && styles.excelButtonDisabled]}
                      hitSlop={8}
                    >
                      {exportingExcel ? (
                        <ActivityIndicator size="small" color="#4C9A6A" />
                      ) : (
                        <Ionicons name="grid-outline" size={16} color="#4C9A6A" />
                      )}
                      <Text style={styles.excelButtonText}>{exportingExcel ? 'Exporting…' : 'Export Excel'}</Text>
                    </Pressable>
                    <Pressable onPress={handleShare} style={styles.shareButton} hitSlop={8}>
                      <Ionicons name="share-outline" size={16} color="#F2A93B" />
                      <Text style={styles.shareButtonText}>Share</Text>
                    </Pressable>
                  </View>
                </View>

                <View style={styles.statGrid}>
                  {/* Total Production = Σ producedThisSlot across every independent saved record */}
                  <View style={styles.statCard}>
                    <Text style={[styles.statValue, { color: '#4C9A6A' }]}>{summary.totalProduction}</Text>
                    <Text style={styles.statLabel}>Total Produced</Text>
                  </View>
                  {/* Planned = shift-wide target without downtime deducted */}
                  <View style={styles.statCard}>
                    <Text style={styles.statValue}>{summary.plannedTotal}</Text>
                    <Text style={styles.statLabel}>Planned</Text>
                  </View>
                  {/* Efficiency = totalProduction / plannedTotal */}
                  <View style={styles.statCard}>
                    <Text style={[styles.statValue, { color: summary.efficiency >= 85 ? '#4C9A6A' : summary.efficiency >= 60 ? '#F2A93B' : '#D64545' }]}>
                      {summary.efficiency}%
                    </Text>
                    <Text style={styles.statLabel}>Efficiency</Text>
                  </View>
                  {/* Loss Parts = parts that couldn't be produced (expected − actual per slot) */}
                  <View style={styles.statCard}>
                    <Text style={[styles.statValue, { color: '#E07B39' }]}>{summary.lossParts}</Text>
                    <Text style={styles.statLabel}>Loss Parts</Text>
                  </View>
                  {/* Time Loss = lossParts converted to minutes via cycle time */}
                  <View style={styles.statCard}>
                    <Text style={[styles.statValue, { color: '#E07B39' }]}>{summary.lossTimeMinutes}m</Text>
                    <Text style={styles.statLabel}>Time Loss</Text>
                  </View>
                  {/* Rejections = quality rejects */}
                  <View style={styles.statCard}>
                    <Text style={[styles.statValue, { color: '#D64545' }]}>{summary.rejections}</Text>
                    <Text style={styles.statLabel}>Rejections</Text>
                  </View>
                  {/* Downtime */}
                  <View style={styles.statCard}>
                    <Text style={styles.statValue}>{summary.downtimeMinutes}m</Text>
                    <Text style={styles.statLabel}>Downtime</Text>
                  </View>
                </View>

                {showCharts && (
                  <View style={styles.chartsSection}>
                    <Text style={styles.sectionLabel}>REPORT CHARTS</Text>

                    <View style={styles.chartCard}>
                      <Text style={styles.chartTitle}>Production vs Planned</Text>
                      <Text style={styles.chartSubtitle}>By production line — which lines hit target</Text>

                      <View style={styles.chartLegendRow}>
                        <View style={styles.legendItem}>
                          <View style={[styles.legendDot, { backgroundColor: PRODUCED_COLOR }]} />
                          <Text style={styles.legendText}>Produced</Text>
                        </View>
                        <View style={styles.legendItem}>
                          <View style={[styles.legendDot, { backgroundColor: PLANNED_COLOR }]} />
                          <Text style={styles.legendText}>Planned</Text>
                        </View>
                      </View>

                      {lineTotals.length === 0 ? (
                        <Text style={styles.muted}>No line data for this selection.</Text>
                      ) : (
                        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                          <BarChart
                            data={productionVsPlannedBarData}
                            width={chartWidth}
                            height={VBAR_CHART_HEIGHT}
                            barWidth={BAR_WIDTH}
                            barBorderRadius={4}
                            noOfSections={4}
                            xAxisThickness={1}
                            xAxisColor="#2C343C"
                            yAxisThickness={0}
                            yAxisTextStyle={{ color: '#8A96A3', fontSize: 10.5 }}
                            xAxisLabelTextStyle={{ color: '#8A96A3', fontSize: 10.5 }}
                            rulesColor="#2C343C"
                            rulesType="dashed"
                            hideRules={false}
                            isAnimated
                          />
                        </ScrollView>
                      )}

                      {/* Explicit per-line target status — the bars already show this
                          visually, but this makes "which lines achieved target" a
                          direct read rather than a bar-height comparison. */}
                      <ScrollCappedBody naturalHeight={lineTotals.length * 30 + 20} cap={LIST_SCROLL_CAP}>
                        <View style={styles.lineStatusList}>
                          {lineTotals.map((l) => {
                            const metTarget = l.planned > 0 && l.produced >= l.planned;
                            return (
                              <View key={l.lineName} style={styles.lineStatusRow}>
                                <View style={[styles.lineStatusDot, { backgroundColor: metTarget ? '#4C9A6A' : '#D64545' }]} />
                                <Text style={styles.lineStatusName} numberOfLines={1}>{l.lineName}</Text>
                                <Text style={styles.lineStatusValue}>{l.produced} / {l.planned}</Text>
                              </View>
                            );
                          })}
                        </View>
                      </ScrollCappedBody>
                    </View>

                    {/* 1. Efficiency by Line — horizontal bar, color-coded by band */}
                    <View style={[styles.chartCard, { marginTop: 14 }]}>
                      <Text style={styles.chartTitle}>Efficiency by Line</Text>
                      <Text style={styles.chartSubtitle}>Produced ÷ Planned, per line</Text>

                      <View style={styles.chartLegendRow}>
                        <View style={styles.legendItem}><View style={[styles.legendDot, { backgroundColor: '#4C9A6A' }]} /><Text style={styles.legendText}>≥95%</Text></View>
                        <View style={styles.legendItem}><View style={[styles.legendDot, { backgroundColor: '#D9C441' }]} /><Text style={styles.legendText}>85–94%</Text></View>
                        <View style={styles.legendItem}><View style={[styles.legendDot, { backgroundColor: '#E07B39' }]} /><Text style={styles.legendText}>70–84%</Text></View>
                        <View style={styles.legendItem}><View style={[styles.legendDot, { backgroundColor: '#D64545' }]} /><Text style={styles.legendText}>&lt;70%</Text></View>
                      </View>

                      {efficiencyByLine.length === 0 ? (
                        <Text style={styles.muted}>No line data for this selection.</Text>
                      ) : efficiencyByLine.length === 1 ? (
                        // One line doesn't need a chart's worth of axes and
                        // spacing — a compact progress bar reads faster.
                        <View style={styles.compactEfficiencyCard}>
                          <View style={styles.compactEfficiencyHeader}>
                            <Text style={styles.compactEfficiencyLine} numberOfLines={1}>{efficiencyByLine[0].lineName}</Text>
                            <Text style={[styles.compactEfficiencyPct, { color: efficiencyColor(efficiencyByLine[0].efficiency) }]}>
                              {efficiencyByLine[0].efficiency}%
                            </Text>
                          </View>
                          <View style={styles.compactEfficiencyTrack}>
                            <View
                              style={[
                                styles.compactEfficiencyFill,
                                {
                                  width: `${Math.max(0, Math.min(100, efficiencyByLine[0].efficiency))}%`,
                                  backgroundColor: efficiencyColor(efficiencyByLine[0].efficiency),
                                },
                              ]}
                            />
                          </View>
                        </View>
                      ) : (
                        <ScrollCappedBody naturalHeight={horizontalBarChartHeight(efficiencyByLine.length)} cap={CHART_SCROLL_CAP}>
                          <BarChart
                            data={efficiencyBarData}
                            horizontal
                            width={Dimensions.get('window').width - 100}
                            height={horizontalBarChartHeight(efficiencyByLine.length)}
                            barWidth={HBAR_WIDTH}
                            spacing={HBAR_SPACING}
                            barBorderRadius={4}
                            noOfSections={4}
                            maxValue={Math.max(100, ...efficiencyByLine.map((l) => l.efficiency))}
                            xAxisThickness={0}
                            yAxisThickness={0}
                            yAxisTextStyle={{ color: '#8A96A3', fontSize: 11 }}
                            xAxisLabelTextStyle={{ color: '#8A96A3', fontSize: 10.5 }}
                            rulesColor="#2C343C"
                            rulesType="dashed"
                            isAnimated
                          />
                        </ScrollCappedBody>
                      )}
                    </View>

                    {/* 2. Production Trend — line chart, works for 1 day or a range */}
                    <View style={[styles.chartCard, { marginTop: 14 }]}>
                      <Text style={styles.chartTitle}>Production Trend</Text>
                      <Text style={styles.chartSubtitle}>Produced quantity by production date</Text>

                      {productionTrend.length === 0 ? (
                        <Text style={styles.muted}>No production data for this selection.</Text>
                      ) : productionTrend.length === 1 ? (
                        // A single point doesn't really read as a "trend" — show
                        // it as a plain stat instead of a one-dot line chart.
                        <View style={styles.singleTrendPoint}>
                          <Text style={styles.singleTrendValue}>{productionTrend[0].produced}</Text>
                          <Text style={styles.singleTrendLabel}>produced on {productionTrend[0].date}</Text>
                        </View>
                      ) : (
                        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                          <LineChart
                            data={productionTrendLineData}
                            width={trendChartWidth}
                            height={LINE_CHART_HEIGHT}
                            color="#3E7CB1"
                            thickness={2}
                            dataPointsColor="#3E7CB1"
                            dataPointsRadius={4}
                            textColor="#8A96A3"
                            textFontSize={10}
                            startFillColor="#3E7CB1"
                            endFillColor="#3E7CB1"
                            startOpacity={0.25}
                            endOpacity={0.02}
                            areaChart
                            yAxisThickness={0}
                            xAxisThickness={1}
                            xAxisColor="#2C343C"
                            yAxisTextStyle={{ color: '#8A96A3', fontSize: 10.5 }}
                            rulesColor="#2C343C"
                            rulesType="dashed"
                            isAnimated
                          />
                        </ScrollView>
                      )}
                    </View>

                    {/* 3. Loss Analysis — donut, grouped by loss reason */}
                    <View style={[styles.chartCard, { marginTop: 14 }]}>
                      <Text style={styles.chartTitle}>Loss Analysis</Text>
                      <Text style={styles.chartSubtitle}>Loss parts grouped by reason</Text>

                      {lossByReason.length === 0 ? (
                        <Text style={styles.muted}>No loss recorded for this selection.</Text>
                      ) : (
                        <View style={styles.donutRow}>
                          <PieChart
                            data={lossDonutData}
                            donut
                            radius={72}
                            innerRadius={46}
                            innerCircleColor="#1D2329"
                            centerLabelComponent={() => (
                              <View style={{ alignItems: 'center' }}>
                                <Text style={styles.donutCenterValue}>{totalLossParts}</Text>
                                <Text style={styles.donutCenterLabel}>lost</Text>
                              </View>
                            )}
                          />
                          <View style={styles.donutLegend}>
                            <ScrollCappedBody naturalHeight={lossByReason.length * 26} cap={160}>
                              {lossByReason.map((l) => (
                                <View key={l.reason} style={styles.donutLegendRow}>
                                  <View style={[styles.legendDot, { backgroundColor: l.color }]} />
                                  <Text style={styles.donutLegendReason} numberOfLines={1}>{l.reason}</Text>
                                  <Text style={styles.donutLegendStat}>{l.parts} · {l.pct}%</Text>
                                </View>
                              ))}
                            </ScrollCappedBody>
                          </View>
                        </View>
                      )}
                    </View>

                    {/* 4. Downtime Analysis — horizontal bar, grouped by stop reason */}
                    <View style={[styles.chartCard, { marginTop: 14 }]}>
                      <Text style={styles.chartTitle}>Downtime Analysis</Text>
                      <Text style={styles.chartSubtitle}>Minutes lost, grouped by stop reason</Text>

                      {downtimeByReason.length === 0 ? (
                        <Text style={styles.muted}>No stops recorded for this selection.</Text>
                      ) : (
                        <ScrollCappedBody naturalHeight={horizontalBarChartHeight(downtimeByReason.length)} cap={CHART_SCROLL_CAP}>
                          <BarChart
                            data={downtimeBarData}
                            horizontal
                            width={Dimensions.get('window').width - 100}
                            height={horizontalBarChartHeight(downtimeByReason.length)}
                            barWidth={HBAR_WIDTH}
                            spacing={HBAR_SPACING}
                            barBorderRadius={4}
                            noOfSections={4}
                            xAxisThickness={0}
                            yAxisThickness={0}
                            yAxisTextStyle={{ color: '#8A96A3', fontSize: 11 }}
                            xAxisLabelTextStyle={{ color: '#8A96A3', fontSize: 10.5 }}
                            rulesColor="#2C343C"
                            rulesType="dashed"
                            isAnimated
                          />
                        </ScrollCappedBody>
                      )}
                    </View>

                    {/* 6. Rejection Analysis — vertical bar, grouped by part */}
                    <View style={[styles.chartCard, { marginTop: 14 }]}>
                      <Text style={styles.chartTitle}>Rejection Analysis</Text>
                      <Text style={styles.chartSubtitle}>Rejections grouped by part</Text>

                      {rejectionsByPart.length === 0 ? (
                        <Text style={styles.muted}>No rejections recorded for this selection.</Text>
                      ) : (
                        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                          <BarChart
                            data={rejectionBarData}
                            width={Math.max(Dimensions.get('window').width - 80, rejectionsByPart.length * 60)}
                            height={VBAR_CHART_HEIGHT}
                            barWidth={20}
                            barBorderRadius={4}
                            noOfSections={4}
                            xAxisThickness={1}
                            xAxisColor="#2C343C"
                            yAxisThickness={0}
                            yAxisTextStyle={{ color: '#8A96A3', fontSize: 10.5 }}
                            xAxisLabelTextStyle={{ color: '#8A96A3', fontSize: 10.5 }}
                            rulesColor="#2C343C"
                            rulesType="dashed"
                            isAnimated
                          />
                        </ScrollView>
                      )}
                    </View>

                    {/* 7. Part-wise Production — horizontal bar, grouped by part */}
                    <View style={[styles.chartCard, { marginTop: 14 }]}>
                      <Text style={styles.chartTitle}>Part-wise Production</Text>
                      <Text style={styles.chartSubtitle}>Produced quantity grouped by part</Text>

                      {productionByPart.length === 0 ? (
                        <Text style={styles.muted}>No production data for this selection.</Text>
                      ) : productionByPart.length <= 2 ? (
                        // 1–2 parts don't need a bar chart's worth of axes —
                        // simple side-by-side stat cards read faster.
                        <View style={styles.compactStatRow}>
                          {productionByPart.map((p, i) => (
                            <View key={p.part} style={[styles.compactStatCard, { borderLeftWidth: 3, borderLeftColor: LOSS_CHART_COLORS[i % LOSS_CHART_COLORS.length] }]}>
                              <Text style={styles.compactStatValue}>{p.produced}</Text>
                              <Text style={styles.compactStatLabel} numberOfLines={2}>{p.part}</Text>
                            </View>
                          ))}
                        </View>
                      ) : (
                        <ScrollCappedBody naturalHeight={horizontalBarChartHeight(productionByPart.length)} cap={CHART_SCROLL_CAP}>
                          <BarChart
                            data={partProductionBarData}
                            horizontal
                            width={Dimensions.get('window').width - 100}
                            height={horizontalBarChartHeight(productionByPart.length)}
                            barWidth={HBAR_WIDTH}
                            spacing={HBAR_SPACING}
                            barBorderRadius={4}
                            noOfSections={4}
                            xAxisThickness={0}
                            yAxisThickness={0}
                            yAxisTextStyle={{ color: '#8A96A3', fontSize: 11 }}
                            xAxisLabelTextStyle={{ color: '#8A96A3', fontSize: 10.5 }}
                            rulesColor="#2C343C"
                            rulesType="dashed"
                            isAnimated
                          />
                        </ScrollCappedBody>
                      )}
                    </View>

                    {/* 8. Operator Distribution — horizontal bar, produced qty per operator */}
                    <View style={[styles.chartCard, { marginTop: 14 }]}>
                      <Text style={styles.chartTitle}>Operator Distribution</Text>
                      <Text style={styles.chartSubtitle}>Total produced by operator (bar) — slots worked listed alongside</Text>

                      {operatorDistribution.length === 0 ? (
                        <Text style={styles.muted}>No operator data for this selection.</Text>
                      ) : operatorDistribution.length === 1 ? (
                        // One operator doesn't need a bar+list combo — a
                        // compact summary card reads faster.
                        <View style={styles.compactOperatorCard}>
                          <Text style={styles.compactOperatorName}>{operatorDistribution[0].name}</Text>
                          <Text style={styles.compactOperatorValue}>{operatorDistribution[0].produced}</Text>
                          <Text style={styles.compactOperatorLabel}>
                            pcs produced · {operatorDistribution[0].slots} slot{operatorDistribution[0].slots === 1 ? '' : 's'} worked
                          </Text>
                        </View>
                      ) : (
                        <>
                          <ScrollCappedBody naturalHeight={horizontalBarChartHeight(operatorDistribution.length)} cap={CHART_SCROLL_CAP}>
                            <BarChart
                              data={operatorBarData}
                              horizontal
                              width={Dimensions.get('window').width - 100}
                              height={horizontalBarChartHeight(operatorDistribution.length)}
                              barWidth={HBAR_WIDTH}
                              spacing={HBAR_SPACING}
                              barBorderRadius={4}
                              noOfSections={4}
                              xAxisThickness={0}
                              yAxisThickness={0}
                              yAxisTextStyle={{ color: '#8A96A3', fontSize: 11 }}
                              xAxisLabelTextStyle={{ color: '#8A96A3', fontSize: 10.5 }}
                              rulesColor="#2C343C"
                              rulesType="dashed"
                              isAnimated
                            />
                          </ScrollCappedBody>
                          {/* Bar chart only carries one value per operator (Total
                              Produced) — Slots Worked is shown here alongside it
                              since gifted-charts' bars don't support a second
                              metric per bar. */}
                          <ScrollCappedBody naturalHeight={operatorDistribution.length * 30 + 20} cap={LIST_SCROLL_CAP}>
                            <View style={styles.lineStatusList}>
                              {operatorDistribution.map((o) => (
                                <View key={o.name} style={styles.lineStatusRow}>
                                  <View style={[styles.lineStatusDot, { backgroundColor: '#3E7CB1' }]} />
                                  <Text style={styles.lineStatusName} numberOfLines={1}>{o.name}</Text>
                                  <Text style={styles.lineStatusValue}>{o.produced} pcs · {o.slots} slot{o.slots === 1 ? '' : 's'}</Text>
                                </View>
                              ))}
                            </View>
                          </ScrollCappedBody>
                        </>
                      )}
                    </View>
                  </View>
                )}

                <Text style={[styles.sectionLabel, { marginTop: 18 }]}>BY LINE</Text>
                {byLine.map((b) => {
                  const eff = b.totalExpected > 0
                    ? Math.round((b.totalProduction / b.totalExpected) * 1000) / 10
                    : 0;
                  const isOpen = !!lineSlotRecordsOpen[b.key];
                  const isLoading = !!lineSlotRecordsLoading[b.lineId];
                  const lineError = lineSlotRecordsError[b.lineId];
                  const lineRecords = lineSlotRecordsCache[b.lineId];
                  return (
                    <View key={b.key} style={styles.lineCard}>
                      <View style={styles.lineCardTopRow}>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.lineCardTitle}>{b.lineName}</Text>
                          <Text style={styles.lineCardMeta}>{b.dateLabel} · Shift {b.shift ?? '—'} · {b.records} slot{b.records === 1 ? '' : 's'}</Text>
                          {b.operatorCount > 0 && (
                            <Text style={styles.lineCardOperators}>
                              Operators ({b.operatorCount}): {b.operatorNames.join(', ')}
                            </Text>
                          )}
                        </View>
                        <View style={{ alignItems: 'flex-end', gap: 2 }}>
                          {/* Produced / Expected · Efficiency */}
                          <Text style={styles.lineCardStat}>
                            {b.totalProduction} / {b.totalExpected} · {eff}%
                          </Text>
                          {/* Loss parts */}
                          {b.lossParts > 0 && (
                            <Text style={styles.lineCardLoss}>
                              {b.lossParts} loss parts{b.lossTimeMinutes > 0 ? ` · ${Math.round(b.lossTimeMinutes)}m lost` : ''}
                            </Text>
                          )}
                          {/* Rejections */}
                          {b.rejections > 0 && (
                            <Text style={styles.lineCardReject}>{b.rejections} rejected</Text>
                          )}
                        </View>
                      </View>

                      <Pressable
                        onPress={() => handleToggleLineSlotRecords(b)}
                        style={styles.viewSlotRecordsButton}
                      >
                        <Ionicons name={isOpen ? 'chevron-up' : 'chevron-down'} size={14} color="#3E7CB1" />
                        <Text style={styles.viewSlotRecordsButtonText}>
                          {isOpen ? 'Hide Slot Records' : 'View Slot Records'}
                        </Text>
                      </Pressable>

                      {isOpen && (
                        <View style={[styles.lineSlotRecordsSection, styles.slotRecordsContainer]}>
                          {isLoading ? (
                            <ActivityIndicator color="#F2A93B" style={{ paddingVertical: 12 }} />
                          ) : lineError ? (
                            <Text style={styles.errorText}>{lineError}</Text>
                          ) : !lineRecords || lineRecords.length === 0 ? (
                            <Text style={styles.emptyText}>No slot records for this line under the current filters.</Text>
                          ) : (
                            <FlatList
                              data={lineRecords}
                              keyExtractor={(item) => item.id}
                              initialNumToRender={15}
                              maxToRenderPerBatch={15}
                              windowSize={5}
                              removeClippedSubviews={true}
                              renderItem={({ item: r }) => renderSlotRecordRow(r)}
                            />
                          )}
                        </View>
                      )}
                    </View>
                  );
                })}
              </>
            )}
          </>
        )}

        <View style={{ height: 40 }} />
      </ScrollView>
      </KeyboardAvoidingView>

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

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#14181C' },
  scroll: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 40 },
  centered: { alignItems: 'center', justifyContent: 'center', gap: 10, paddingVertical: 30 },
  backButton: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 8 },
  backText: { color: '#8A96A3', fontSize: 15 },
  title: { color: '#ECEFF2', fontSize: 22, fontWeight: '800' },
  subtitle: { color: '#8A96A3', fontSize: 13, marginTop: 4, marginBottom: 14 },
  sectionLabel: { color: '#F2A93B', fontSize: 12, fontWeight: '800', letterSpacing: 1.4, marginBottom: 8, marginTop: 4 },
  field: { marginBottom: 12 },
  label: { color: '#8A96A3', fontSize: 11.5, marginBottom: 6, fontWeight: '700' },
  row: { flexDirection: 'row', gap: 8 },
  input: {
    backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C',
    borderRadius: 10, paddingHorizontal: 12, height: 48, color: '#ECEFF2', fontSize: 15,
  },
  disabledInput: { opacity: 0.5, backgroundColor: '#14181C' },
  pickerBox: {
    backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C', borderRadius: 10,
    paddingHorizontal: 12, height: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  pickerBoxText: { color: '#ECEFF2', fontSize: 15, flex: 1, marginRight: 8 },
  pickerBoxPlaceholder: { color: '#5C6670' },
  resetText: { color: '#F2A93B', fontSize: 12.5, fontWeight: '700' },
  chipsRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  chip: { borderWidth: 1, borderColor: '#2C343C', backgroundColor: '#1D2329', borderRadius: 16, paddingHorizontal: 12, paddingVertical: 8 },
  chipSelected: { borderColor: '#F2A93B', backgroundColor: '#F2A93B22' },
  chipText: { color: '#8A96A3', fontSize: 13, fontWeight: '600' },
  chipTextSelected: { color: '#F2A93B' },
  muted: { color: '#8A96A3', fontSize: 12 },
  errorText: { color: '#F0A8A8', fontSize: 13.5, textAlign: 'center' },
  emptyText: { color: '#5C6670', fontSize: 14, textAlign: 'center' },
  retryButton: { borderWidth: 1, borderColor: '#2C343C', borderRadius: 8, paddingHorizontal: 16, paddingVertical: 8, marginTop: 4 },
  retryText: { color: '#ECEFF2', fontSize: 13, fontWeight: '600' },

  // Generate button
  generateButton: { height: 56, borderRadius: 12, backgroundColor: '#F2A93B', alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 10, marginTop: 14 },
  generateButtonPressed: { opacity: 0.85 },
  generateButtonText: { color: '#14181C', fontSize: 16, fontWeight: '900' },

  // Results
  resultsHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 22 },
  resultsHeaderActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  shareButton: { flexDirection: 'row', alignItems: 'center', gap: 5, borderWidth: 1, borderColor: '#F2A93B', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  shareButtonText: { color: '#F2A93B', fontWeight: '700', fontSize: 12 },
  excelButton: { flexDirection: 'row', alignItems: 'center', gap: 5, borderWidth: 1, borderColor: '#4C9A6A', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  excelButtonDisabled: { opacity: 0.5 },
  excelButtonText: { color: '#4C9A6A', fontWeight: '700', fontSize: 12 },
  viewChartsButton: { flexDirection: 'row', alignItems: 'center', gap: 5, borderWidth: 1, borderColor: '#3E7CB1', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  viewChartsButtonIcon: { fontSize: 13 },
  viewChartsButtonText: { color: '#3E7CB1', fontWeight: '700', fontSize: 12 },

  // Report Charts section
  chartsSection: { marginTop: 18 },
  chartCard: { backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C', borderRadius: 12, padding: 12 },
  chartTitle: { color: '#ECEFF2', fontSize: 15, fontWeight: '800' },
  chartSubtitle: { color: '#8A96A3', fontSize: 11.5, marginTop: 2, marginBottom: 6 },
  chartLegendRow: { flexDirection: 'row', gap: 16, marginBottom: 6, flexWrap: 'wrap' },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendDot: { width: 10, height: 10, borderRadius: 5 },
  legendText: { color: '#8A96A3', fontSize: 12, fontWeight: '600' },
  lineStatusList: { marginTop: 10, borderTopWidth: 1, borderTopColor: '#2C343C', paddingTop: 8, gap: 8 },
  lineStatusRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  lineStatusDot: { width: 8, height: 8, borderRadius: 4 },
  lineStatusName: { flex: 1, color: '#ECEFF2', fontSize: 12.5, fontWeight: '600' },
  lineStatusValue: { color: '#8A96A3', fontSize: 12, fontWeight: '700' },

  singleTrendPoint: { alignItems: 'center', paddingVertical: 20, gap: 4 },
  compactEfficiencyCard: { paddingVertical: 12, gap: 8 },
  compactEfficiencyHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  compactEfficiencyLine: { color: '#ECEFF2', fontSize: 15, fontWeight: '700', flex: 1, marginRight: 10 },
  compactEfficiencyPct: { fontSize: 20, fontWeight: '900' },
  compactEfficiencyTrack: { height: 10, borderRadius: 5, backgroundColor: '#2C343C', overflow: 'hidden' },
  compactEfficiencyFill: { height: '100%', borderRadius: 5 },
  compactStatRow: { flexDirection: 'row', gap: 10, paddingVertical: 4 },
  compactStatCard: { flex: 1, alignItems: 'center', gap: 4, paddingVertical: 16, backgroundColor: '#171B20', borderRadius: 10 },
  compactStatValue: { fontSize: 22, fontWeight: '900', color: '#ECEFF2' },
  compactStatLabel: { color: '#8A96A3', fontSize: 11.5, textAlign: 'center' },
  compactOperatorCard: { alignItems: 'center', paddingVertical: 20, gap: 4 },
  compactOperatorName: { color: '#ECEFF2', fontSize: 17, fontWeight: '800' },
  compactOperatorValue: { color: '#3E7CB1', fontSize: 30, fontWeight: '900' },
  compactOperatorLabel: { color: '#8A96A3', fontSize: 12 },
  singleTrendValue: { color: '#3E7CB1', fontSize: 32, fontWeight: '900' },
  singleTrendLabel: { color: '#8A96A3', fontSize: 12 },

  donutRow: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  donutCenterValue: { color: '#ECEFF2', fontSize: 18, fontWeight: '800' },
  donutCenterLabel: { color: '#8A96A3', fontSize: 10.5 },
  donutLegend: { flex: 1, gap: 8 },
  donutLegendRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  donutLegendReason: { flex: 1, color: '#ECEFF2', fontSize: 12.5, fontWeight: '600' },
  donutLegendStat: { color: '#8A96A3', fontSize: 11.5, fontWeight: '700' },

  statGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  statCard: {
    width: '31%', backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C',
    borderRadius: 10, paddingVertical: 14, alignItems: 'center', gap: 4,
  },
  statValue: { color: '#ECEFF2', fontSize: 18, fontWeight: '800' },
  statLabel: { color: '#8A96A3', fontSize: 11, fontWeight: '700' },

  lineCard: {
    backgroundColor: '#1D2329', borderWidth: 1,
    borderColor: '#2C343C', borderRadius: 10, padding: 12, marginBottom: 8,
  },
  // The original single-row content (line name/meta/operators on the left,
  // stats on the right) — unchanged, just named so it can sit above the
  // new "View Slot Records" button/section within the now-column lineCard.
  lineCardTopRow: { flexDirection: 'row', alignItems: 'center' },
  lineCardTitle: { color: '#ECEFF2', fontSize: 14, fontWeight: '700' },
  lineCardMeta: { color: '#8A96A3', fontSize: 11.5, marginTop: 2 },
  lineCardOperators: { color: '#8A96A3', fontSize: 11.5, marginTop: 2 },
  lineCardStat: { color: '#ECEFF2', fontSize: 13, fontWeight: '700' },
  lineCardReject: { color: '#D64545', fontSize: 11, marginTop: 2 },

  recordRow: {
    flexDirection: 'row', alignItems: 'center', borderTopWidth: 1, borderTopColor: '#2C343C',
    paddingVertical: 10,
  },
  recordLine: { color: '#ECEFF2', fontSize: 13, fontWeight: '700' },
  recordMeta: { color: '#8A96A3', fontSize: 11.5, marginTop: 2 },
  recordStat: { color: '#ECEFF2', fontSize: 13, fontWeight: '700' },
  recordReject: { color: '#D64545', fontSize: 11, marginTop: 2 },
  recordLoss:   { color: '#E07B39', fontSize: 11, marginTop: 2 },
  recordLossNoReason: { color: '#8A96A3', fontStyle: 'italic' },
  lineCardLoss: { color: '#E07B39', fontSize: 11, marginTop: 2 },

  // Per-BY-LINE-card "View Slot Records" toggle + its lazy disclosure section
  viewSlotRecordsButton: {
    flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start',
    marginTop: 10, borderWidth: 1, borderColor: '#3E7CB1', borderRadius: 8,
    paddingHorizontal: 10, paddingVertical: 6,
  },
  viewSlotRecordsButtonText: { color: '#3E7CB1', fontWeight: '700', fontSize: 12 },
  lineSlotRecordsSection: { marginTop: 10, borderTopWidth: 1, borderTopColor: '#2C343C', paddingTop: 4 },
  // Distinct surface for the fetched slot-record section so it reads as
  // separate from the BY LINE card it's nested in — a slight green tint
  // using the theme's existing green (#4C9A6A, already used for the Excel
  // button/"good" efficiency elsewhere on this screen), following the same
  // <hex><alpha> tint pattern chipSelected already uses for #F2A93B22.
  slotRecordsContainer: {
    backgroundColor: '#4C9A6A14',
    borderWidth: 1,
    borderColor: '#4C9A6A55',
    borderRadius: 8,
    padding: 8,
  },

  // Picker dropdown modal
  modalOverlay: { flex: 1, backgroundColor: '#00000088', alignItems: 'center', justifyContent: 'center', padding: 20 },
  modalCard: { width: '100%', maxWidth: 720, backgroundColor: '#14181C', borderRadius: 12, maxHeight: '80%', padding: 14, borderWidth: 1, borderColor: '#2C343C' },
  modalScroll: { paddingBottom: 12 },
  modalTitle: { color: '#ECEFF2', fontSize: 18, fontWeight: '800', marginBottom: 8 },
  modalPartRow: { paddingVertical: 12, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, borderColor: '#2C343C', marginBottom: 8, minHeight: 48, justifyContent: 'center' },
  modalPartRowSelected: { borderColor: '#F2A93B', backgroundColor: '#F2A93B08' },
  modalPartText: { color: '#ECEFF2', fontSize: 14 },
  modalPartTextSelected: { color: '#F2A93B', fontWeight: '800' },
  modalFooter: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: '#2C343C' },
  modalBtn: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: '#2C343C', backgroundColor: '#1D2329' },
  modalBtnText: { color: '#ECEFF2', fontWeight: '700' },
});