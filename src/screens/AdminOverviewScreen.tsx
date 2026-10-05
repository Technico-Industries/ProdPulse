// src/screens/AdminOverviewScreen.tsx
//
// Admin MAIN dashboard — a digital production overview for ONE selected day.
//
// Deliberately chart-free: big numbers, clean cards, KPI tiles, status
// chips. The analytics screens (KPIAnalysis / GenerateReport /
// QualityAnalysis) keep their charts; they're reachable from the hamburger
// drawer (src/components/AppDrawer.tsx).
//
// DATA SOURCE — the real `productionRecords` collection written by
// RecordProductionScreen. Same collection, same `createdAt` Timestamp range
// filter and same per-record field names GenerateReportScreen and
// KPIAnalysisScreen already use. Nothing here reads
// sampleProductionRecords (the seed script's collection) or any mock data.
//
// ONE Firestore read per date change for the production side, plus one
// best-effort read of `rejectionRecords` (the QC-logged rejections
// QualityAnalysisScreen reads) for the same day. Every KPI below is then
// computed locally from those two result sets — no per-KPI and no per-line
// queries.
//
// FORMULAS are the project's existing ones, not new inventions:
//   totalProduction  = Σ producedThisSlot          (GenerateReportScreen summary)
//   plannedTotal     = Σ expectedParts             (GenerateReportScreen summary)
//   lossParts        = Σ lossParts ?? max(0, expected - produced)
//   downtimeMinutes  = Σ stopEvents[].durationMinutes
//   efficiency       = produced / expected * 100   (GenerateReportScreen summary)
//   achievementPct   = actual / plan * 100         (KPIAnalysisScreen totals — same figure)
//   rejectionPct     = rejections / (actual + rejections) * 100  (KPIAnalysisScreen totals)
//   qualityPct       = 100 - rejectionPct
//   operatorHours    = Σ operatorCount × productiveMinutes / 60  (KPIAnalysisScreen byLine)
//   pcsPerManHour    = actual / operatorHours      (KPIAnalysisScreen totals)

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  ScrollView,
  TextInput,
  Modal,
  ActivityIndicator,
  useWindowDimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { collection, getDocs, query, where, orderBy, Timestamp } from 'firebase/firestore';
import { db } from '../services/firebase';
import { PLANTS, WORKSHOPS, DIVISIONS } from '../constants/lineOptions';
import AppDrawer from '../components/AppDrawer';
import { ADMIN_MENU_ITEMS } from '../constants/adminMenu';

// ─── Types ────────────────────────────────────────────────────────────────────
// Same field set the other production screens map off each Firestore doc.

interface StopEventRecord {
  reason: string;
  durationMinutes?: number | null;
}

// The authoritative plant / workshop / division for a line, read from the
// `productionLines` collection. See the resolution note on `resolvedRecords`.
interface Line {
  id: string;
  plant: string | null;
  workshop: string | null;
  division: string | null;
  lineName: string | null;
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
  productionDate: string | null;
  expectedParts: number | null;
  producedThisSlot: number | null;
  lossParts: number | null;
  rejections: number | null;
  stopEvents: StopEventRecord[] | null;
  operatorCount: number;
  productiveMinutes: number | null;
  createdAtMs: number | null;
}

// ─── Date helpers (identical to GenerateReportScreen's) ───────────────────────

function pad2(n: number) {
  return String(n).padStart(2, '0');
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function dateStrDaysAgo(days: number) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function isValidDateStr(s: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(`${s}T00:00:00`).getTime());
}

// Auto-inserts the dashes as the admin types — same helper and the same
// YYYY-MM-DD grouping as GenerateReportScreen, because the value feeds the
// same `new Date(`${s}T00:00:00`)` → Timestamp conversion.
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

// "2026-10-05" → "05 Oct 2026". Built from the string's own parts rather
// than Date.toLocaleDateString, so there's no UTC-parse day shift.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function prettyDate(s: string): string {
  if (!isValidDateStr(s)) return s;
  const [y, m, d] = s.split('-');
  return `${d} ${MONTHS[Number(m) - 1]} ${y}`;
}

function relativeDayLabel(s: string): string | null {
  if (s === todayStr()) return 'Today';
  if (s === dateStrDaysAgo(1)) return 'Yesterday';
  return null;
}

function round1(n: number) {
  return Math.round(n * 10) / 10;
}

function formatInt(n: number) {
  return Math.round(n).toLocaleString();
}

function formatMinutes(mins: number): string {
  const total = Math.max(0, Math.round(mins));
  if (total < 60) return `${total} min`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

// Case/whitespace-insensitive equality — same helper GenerateReportScreen
// and KPIAnalysisScreen compare filter values with, so "matches" means the
// same thing on all three screens even when hand-edited Firestore data
// drifts in case or trailing spaces.
function sameValue(a: string | null | undefined, b: string | null | undefined) {
  if (a == null || b == null) return false;
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

// Division only applies under the Assembly workshop — matched by substring
// rather than an exact label, exactly as GenerateReportScreen does it.
function isAssemblyWorkshop(w: string | null) {
  return !!w && w.toLowerCase().includes('assembly');
}

// ─── Saved selection ──────────────────────────────────────────────────────────
//
// Date + Plant + Workshop + Division survive a page reload / app restart, so
// the admin lands back on exactly the view they left. Stored in
// AsyncStorage (localStorage on web — the same dependency firebase.ts
// already uses for auth persistence), under one versioned key so the shape
// can change later without reading a stale object.

const PREFS_KEY = 'prodpulse.adminOverview.selection.v1';

interface SavedSelection {
  selectedDate: string;
  plant: string | null;
  workshop: string | null;
  division: string | null;
}

// Shared colour bands — the same thresholds GenerateReportScreen and
// KPIAnalysisScreen already colour their stat cards with.
function efficiencyColor(pct: number) {
  return pct >= 85 ? '#4C9A6A' : pct >= 60 ? '#F2A93B' : '#D64545';
}
function rejectionColor(pct: number) {
  return pct <= 2 ? '#4C9A6A' : pct <= 5 ? '#F2A93B' : '#D64545';
}

// ─── Date picker modal ────────────────────────────────────────────────────────

function DatePickerModal({
  visible,
  value,
  onClose,
  onApply,
}: {
  visible: boolean;
  value: string;
  onClose: () => void;
  onApply: (next: string) => void;
}) {
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    if (visible) setDraft(value);
  }, [visible, value]);

  const valid = isValidDateStr(draft);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.modalScrim} onPress={onClose}>
        <Pressable style={styles.modalCard} onPress={(e) => e.stopPropagation()}>
          <Text style={styles.modalTitle}>Select Date</Text>

          <View style={styles.presetRow}>
            {[
              { label: 'Today', get: todayStr },
              { label: 'Yesterday', get: () => dateStrDaysAgo(1) },
              { label: '7 days ago', get: () => dateStrDaysAgo(7) },
            ].map((p) => {
              const v = p.get();
              const active = draft === v;
              return (
                <Pressable
                  key={p.label}
                  onPress={() => setDraft(v)}
                  style={[styles.presetChip, active && styles.presetChipActive]}
                >
                  <Text style={[styles.presetChipText, active && styles.presetChipTextActive]}>
                    {p.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <View style={styles.modalInputRow}>
            <Ionicons name="calendar-outline" size={16} color="#5C6670" />
            <TextInput
              style={styles.modalInput}
              value={draft}
              onChangeText={(t) => setDraft(formatDateInputValue(t))}
              placeholder="YYYY-MM-DD"
              placeholderTextColor="#5C6670"
              keyboardType="number-pad"
              maxLength={10}
            />
          </View>
          <Text style={styles.modalHint}>
            {valid ? prettyDate(draft) : 'Enter the date as YYYY-MM-DD.'}
          </Text>

          <View style={styles.modalActions}>
            <Pressable onPress={onClose} style={[styles.modalBtn, styles.modalBtnGhost]}>
              <Text style={styles.modalBtnGhostText}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                if (valid) onApply(draft);
              }}
              disabled={!valid}
              style={[styles.modalBtn, styles.modalBtnPrimary, !valid && styles.modalBtnDisabled]}
            >
              <Text style={styles.modalBtnPrimaryText}>Apply</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ─── Filter picker (tap-a-chip → modal list) ──────────────────────────────────
//
// Same "single box opens a modal list" pattern GenerateReportScreen and
// RecordProductionScreen use for Plant / Workshop / Division, condensed
// into a chip so three filters fit on one row on a phone.

function FilterChip({
  label,
  value,
  onPress,
}: {
  label: string;
  value: string | null;
  onPress: () => void;
}) {
  const active = !!value;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.filterChip, active && styles.filterChipActive, pressed && styles.dateButtonPressed]}
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${value ?? 'All'}`}
    >
      <Text style={styles.filterChipLabel}>{label}</Text>
      <Text style={[styles.filterChipValue, active && styles.filterChipValueActive]} numberOfLines={1}>
        {value ?? 'All'}
      </Text>
      <Ionicons name="chevron-down" size={14} color={active ? '#3E7CB1' : '#8A96A3'} />
    </Pressable>
  );
}

function OptionPickerModal({
  visible,
  title,
  options,
  value,
  onClose,
  onSelect,
}: {
  visible: boolean;
  title: string;
  options: string[];
  value: string | null;
  onClose: () => void;
  onSelect: (next: string | null) => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.modalScrim} onPress={onClose}>
        <Pressable style={styles.modalCard} onPress={(e) => e.stopPropagation()}>
          <Text style={styles.modalTitle}>{title}</Text>
          <ScrollView style={styles.optionList} showsVerticalScrollIndicator={false}>
            {/* "All" is the cleared state — no filter applied */}
            <Pressable
              onPress={() => onSelect(null)}
              style={({ pressed }) => [styles.optionRow, value === null && styles.optionRowActive, pressed && styles.dateButtonPressed]}
            >
              <Text style={[styles.optionText, value === null && styles.optionTextActive]}>All</Text>
              {value === null ? <Ionicons name="checkmark" size={17} color="#3E7CB1" /> : null}
            </Pressable>
            {options.map((opt) => {
              const selected = sameValue(opt, value);
              return (
                <Pressable
                  key={opt}
                  onPress={() => onSelect(opt)}
                  style={({ pressed }) => [styles.optionRow, selected && styles.optionRowActive, pressed && styles.dateButtonPressed]}
                >
                  <Text style={[styles.optionText, selected && styles.optionTextActive]}>{opt}</Text>
                  {selected ? <Ionicons name="checkmark" size={17} color="#3E7CB1" /> : null}
                </Pressable>
              );
            })}
          </ScrollView>
          <View style={styles.modalActions}>
            <Pressable onPress={onClose} style={[styles.modalBtn, styles.modalBtnGhost]}>
              <Text style={styles.modalBtnGhostText}>Close</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ─── KPI tile ─────────────────────────────────────────────────────────────────

function KpiTile({
  label,
  value,
  color,
  width,
}: {
  label: string;
  value: string;
  color?: string;
  width: string;
}) {
  return (
    <View style={[styles.kpiTile, { width: width as any }]}>
      <Text style={styles.kpiLabel} numberOfLines={2}>
        {label}
      </Text>
      <Text style={[styles.kpiValue, color ? { color } : null]} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
    </View>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function AdminOverviewScreen() {
  const { width } = useWindowDimensions();

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectedDate, setSelectedDate] = useState(todayStr());

  // Plant / Workshop / Division — null means "All". Purely client-side
  // filters over the day's single fetch, so changing one never re-queries
  // Firestore.
  const [plant, setPlant] = useState<string | null>(null);
  const [workshop, setWorkshop] = useState<string | null>(null);
  const [division, setDivision] = useState<string | null>(null);
  const [openFilter, setOpenFilter] = useState<'plant' | 'workshop' | 'division' | null>(null);

  // Saved selection is restored before the first fetch, so the dashboard
  // never flashes today/unfiltered data on its way to the stored view.
  const [prefsLoaded, setPrefsLoaded] = useState(false);

  const [allLines, setAllLines] = useState<Line[]>([]);
  const [records, setRecords] = useState<ProductionRecord[]>([]);
  // QC-logged rejections for the same day (rejectionRecords, the collection
  // QualityAnalysisScreen reads). Best-effort: null means "not available",
  // which renders as "—" rather than a misleading 0.
  const [qcRejections, setQcRejections] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hasLoaded, setHasLoaded] = useState(false);

  // One query per date change. Everything on this screen is derived from
  // its result set in the useMemo below.
  const fetchDay = useCallback(async (dateStr: string) => {
    if (!isValidDateStr(dateStr)) return;
    setLoading(true);
    setLoadError(null);
    try {
      // Local business day → the same Timestamp range GenerateReportScreen
      // builds. `new Date('YYYY-MM-DDTHH:mm:ss')` (no trailing Z) is parsed
      // in the device's local zone, so 00:00:00 → 23:59:59.999 is the local
      // day, not a UTC one.
      const fromTs = Timestamp.fromDate(new Date(`${dateStr}T00:00:00`));
      const toTs = Timestamp.fromDate(new Date(`${dateStr}T23:59:59.999`));

      const snap = await getDocs(
        query(
          collection(db, 'productionRecords'),
          where('createdAt', '>=', fromTs),
          where('createdAt', '<=', toTs),
          orderBy('createdAt', 'asc')
        )
      );

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
          productionDate: data.productionDate ?? null,
          expectedParts: data.expectedParts ?? null,
          producedThisSlot: data.producedThisSlot ?? null,
          lossParts: data.lossParts ?? null,
          rejections: data.rejections ?? null,
          stopEvents: Array.isArray(data.stopEvents) ? data.stopEvents : null,
          // Same precedence KPIAnalysisScreen uses: the stamped operator
          // roster if present, otherwise the record's own operatorCount.
          operatorCount: Array.isArray(data.operators)
            ? data.operators.length
            : data.operatorCount ?? 0,
          productiveMinutes: data.productiveMinutes ?? null,
          createdAtMs: data.createdAt?.toMillis ? data.createdAt.toMillis() : null,
        };
      });
      setRecords(mapped);

      // Secondary, non-blocking read — a failure here (rules, offline) must
      // not take the whole dashboard down with it.
      try {
        const qcSnap = await getDocs(
          query(collection(db, 'rejectionRecords'), where('date', '==', dateStr))
        );
        setQcRejections(
          qcSnap.docs.reduce((sum, d) => sum + ((d.data() as any).rejectionQty ?? 0), 0)
        );
      } catch (qcErr) {
        console.warn('[AdminOverview] rejectionRecords read failed', qcErr);
        setQcRejections(null);
      }
    } catch (e) {
      console.error('[AdminOverview] productionRecords fetch failed', e);
      setRecords([]);
      setQcRejections(null);
      setLoadError('Unable to load production data.');
    } finally {
      setLoading(false);
      setHasLoaded(true);
    }
  }, []);

  // ── Restore the saved selection once, on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(PREFS_KEY);
        if (!cancelled && raw) {
          const saved: Partial<SavedSelection> = JSON.parse(raw);
          if (typeof saved.selectedDate === 'string' && isValidDateStr(saved.selectedDate)) {
            setSelectedDate(saved.selectedDate);
          }
          // Only accept values still present in lineOptions.ts — a label
          // removed from the constants shouldn't come back as a filter that
          // can never match anything.
          if (saved.plant && PLANTS.includes(saved.plant)) setPlant(saved.plant);
          if (saved.workshop && WORKSHOPS.includes(saved.workshop)) setWorkshop(saved.workshop);
          if (saved.division && DIVISIONS.includes(saved.division)) setDivision(saved.division);
        }
      } catch (e) {
        console.warn('[AdminOverview] could not restore saved selection', e);
      } finally {
        if (!cancelled) setPrefsLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Persist it on every change (after the restore, so the initial
  // defaults never overwrite what was stored).
  useEffect(() => {
    if (!prefsLoaded) return;
    const payload: SavedSelection = { selectedDate, plant, workshop, division };
    AsyncStorage.setItem(PREFS_KEY, JSON.stringify(payload)).catch((e) =>
      console.warn('[AdminOverview] could not save selection', e)
    );
  }, [prefsLoaded, selectedDate, plant, workshop, division]);

  // ── Division only exists under the Assembly workshop (same rule as
  // GenerateReportScreen) — clear it when the workshop moves away.
  useEffect(() => {
    if (!isAssemblyWorkshop(workshop) && division) setDivision(null);
  }, [workshop, division]);

  // ── productionLines, fetched once. Not per date: the line roster doesn't
  // change between days, and it's what resolves each record's real
  // plant/workshop/division below.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const snap = await getDocs(collection(db, 'productionLines'));
        if (cancelled) return;
        setAllLines(
          snap.docs.map((d) => {
            const data: any = d.data();
            return {
              id: d.id,
              plant: data.plant ?? null,
              workshop: data.workshop ?? null,
              division: data.division ?? null,
              lineName: data.lineName ?? null,
            };
          })
        );
      } catch (e) {
        // Non-fatal: without the roster each record falls back to its own
        // stamped plant/workshop/division (see resolvedRecords).
        console.warn('[AdminOverview] productionLines fetch failed', e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!prefsLoaded) return;
    fetchDay(selectedDate);
  }, [prefsLoaded, selectedDate, fetchDay]);

  // ── Same fix GenerateReportScreen applies: some already-saved records
  // carry a null or mismatched plant/workshop/division (a supervisor-side
  // stamping bug), so resolve those from the authoritative productionLines
  // doc via lineId and fall back to the record's own fields only when the
  // line can't be found (e.g. since deleted).
  const resolvedRecords = useMemo(() => {
    if (allLines.length === 0) return records;
    const lineById = new Map(allLines.map((l) => [l.id, l]));
    return records.map((r) => {
      const line = r.lineId ? lineById.get(r.lineId) : undefined;
      if (!line) return r;
      return {
        ...r,
        plant: line.plant ?? r.plant,
        workshop: line.workshop ?? r.workshop,
        division: line.division ?? r.division,
        lineName: line.lineName ?? r.lineName,
      };
    });
  }, [records, allLines]);

  const filteredRecords = useMemo(
    () =>
      resolvedRecords.filter((r) => {
        if (plant && !sameValue(r.plant, plant)) return false;
        if (workshop && !sameValue(r.workshop, workshop)) return false;
        if (division && !sameValue(r.division, division)) return false;
        return true;
      }),
    [resolvedRecords, plant, workshop, division]
  );

  // ── Aggregates — all computed locally from the single fetch above.
  const metrics = useMemo(() => {
    let totalProduction = 0;
    let plannedTotal = 0;
    let lossParts = 0;
    let rejections = 0;
    let downtimeMinutes = 0;
    let operatorHours = 0;
    const lineIds = new Set<string>();
    const shifts = new Set<string>();

    filteredRecords.forEach((r) => {
      const produced = r.producedThisSlot ?? 0;
      const expected = r.expectedParts ?? 0;
      totalProduction += produced;
      plannedTotal += expected;
      lossParts += r.lossParts ?? Math.max(0, expected - produced);
      rejections += r.rejections ?? 0;
      (r.stopEvents ?? []).forEach((se) => {
        downtimeMinutes += se.durationMinutes ?? 0;
      });
      operatorHours += (r.operatorCount || 0) * ((r.productiveMinutes ?? 0) / 60);
      if (r.lineId) lineIds.add(r.lineId);
      if (r.shift) shifts.add(r.shift);
    });

    const efficiency = plannedTotal > 0 ? round1((totalProduction / plannedTotal) * 100) : 0;
    const rejectionPct =
      totalProduction + rejections > 0
        ? round1((rejections / (totalProduction + rejections)) * 100)
        : 0;

    return {
      totalProduction,
      plannedTotal,
      lossParts: Math.round(lossParts),
      rejections,
      downtimeMinutes: Math.round(downtimeMinutes),
      operatorHours: round1(operatorHours),
      efficiency,
      rejectionPct,
      qualityPct: round1(100 - rejectionPct),
      goodParts: Math.max(0, totalProduction - rejections),
      pcsPerManHour: operatorHours > 0 ? round1(totalProduction / operatorHours) : 0,
      linesRunning: lineIds.size,
      shifts: Array.from(shifts).sort(),
      recordCount: filteredRecords.length,
    };
  }, [filteredRecords]);

  // ── Responsive tile sizing. Percentage widths inside a wrapping row, so
  // nothing can overflow horizontally at any breakpoint.
  const kpiColumns = width >= 1100 ? 4 : width >= 760 ? 3 : 2;
  const kpiWidth = `${100 / kpiColumns - (kpiColumns === 2 ? 1.6 : 1.2)}%`;
  const isWide = width >= 760;

  // `prefsLoaded` keeps the skeleton up until the saved selection has been
  // restored, so the first paint is already the right date and filters.
  const busy = loading || !prefsLoaded;
  const ready = hasLoaded && !busy && !loadError;
  // Two distinct empties: nothing recorded that day at all, vs. records
  // exist but the Plant/Workshop/Division filters exclude all of them.
  const isEmptyDay = ready && records.length === 0;
  const isEmptyFiltered = ready && records.length > 0 && filteredRecords.length === 0;
  const activeFilterCount = [plant, workshop, division].filter(Boolean).length;
  const relLabel = relativeDayLabel(selectedDate);

  return (
    <View style={styles.root}>
      {/* ── Header ───────────────────────────────────────────────────── */}
      <View style={styles.header}>
        <Pressable
          onPress={() => setDrawerOpen(true)}
          hitSlop={12}
          style={({ pressed }) => [styles.hamburger, pressed && styles.hamburgerPressed]}
          accessibilityRole="button"
          accessibilityLabel="Open menu"
        >
          <Ionicons name="menu" size={22} color="#ECEFF2" />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.brand}>ProdPulse</Text>
          <Text style={styles.brandSub}>Production Overview</Text>
        </View>
        <View style={styles.rolePill}>
          <Text style={styles.rolePillText}>ADMIN</Text>
        </View>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        {/* ── Date selector ──────────────────────────────────────────── */}
        <View style={styles.dateBlock}>
          <Text style={styles.sectionLabel}>DATE</Text>
          <View style={styles.dateRow}>
            <Pressable
              onPress={() => setPickerOpen(true)}
              style={({ pressed }) => [styles.dateButton, pressed && styles.dateButtonPressed]}
              accessibilityRole="button"
              accessibilityLabel={`Change date, currently ${prettyDate(selectedDate)}`}
            >
              <Ionicons name="calendar-outline" size={16} color="#3E7CB1" />
              <Text style={styles.dateButtonText}>{prettyDate(selectedDate)}</Text>
              <Ionicons name="chevron-down" size={16} color="#8A96A3" />
            </Pressable>
            {relLabel ? (
              <View style={styles.relPill}>
                <Text style={styles.relPillText}>{relLabel}</Text>
              </View>
            ) : (
              <Pressable onPress={() => setSelectedDate(todayStr())} style={styles.todayLink} hitSlop={8}>
                <Text style={styles.todayLinkText}>Jump to today</Text>
              </Pressable>
            )}
            {busy ? (
              <ActivityIndicator size="small" color="#3E7CB1" style={{ marginLeft: 'auto' }} />
            ) : null}
          </View>
        </View>

        {/* ── Plant / Workshop / Division ────────────────────────────── */}
        {/* Applied client-side over the day's single fetch — changing one
            never triggers another Firestore read. */}
        <View style={styles.dateBlock}>
          <View style={styles.kpiHeader}>
            <Text style={styles.sectionLabel}>FILTERS</Text>
            {activeFilterCount > 0 ? (
              <Pressable
                onPress={() => {
                  setPlant(null);
                  setWorkshop(null);
                  setDivision(null);
                }}
                hitSlop={8}
              >
                <Text style={styles.todayLinkText}>Clear all</Text>
              </Pressable>
            ) : null}
          </View>
          <View style={styles.filterRow}>
            <FilterChip label="Plant" value={plant} onPress={() => setOpenFilter('plant')} />
            <FilterChip label="Workshop" value={workshop} onPress={() => setOpenFilter('workshop')} />
            {/* Division only exists under Assembly — same rule as the
                other admin report screens. */}
            {isAssemblyWorkshop(workshop) ? (
              <FilterChip label="Division" value={division} onPress={() => setOpenFilter('division')} />
            ) : null}
          </View>
        </View>

        {busy ? (
          /* ── Loading skeleton ─────────────────────────────────────── */
          <View style={styles.stateBlock}>
            <View style={styles.skeletonHero} />
            <View style={styles.skeletonRow}>
              <View style={styles.skeletonHalf} />
              <View style={styles.skeletonHalf} />
            </View>
            <Text style={styles.stateText}>Loading production data…</Text>
          </View>
        ) : loadError ? (
          /* ── Error state ──────────────────────────────────────────── */
          <View style={styles.stateCard}>
            <View style={[styles.stateIcon, { borderColor: '#D64545', backgroundColor: '#D6454522' }]}>
              <Ionicons name="cloud-offline-outline" size={30} color="#D64545" />
            </View>
            <Text style={styles.stateTitle}>Unable to load production data.</Text>
            <Text style={styles.stateText}>Check your connection and try again.</Text>
            <Pressable
              onPress={() => fetchDay(selectedDate)}
              style={({ pressed }) => [styles.retryButton, pressed && styles.dateButtonPressed]}
              accessibilityRole="button"
              accessibilityLabel="Retry"
            >
              <Ionicons name="refresh" size={16} color="#ECEFF2" />
              <Text style={styles.retryText}>Retry</Text>
            </Pressable>
          </View>
        ) : isEmptyDay ? (
          /* ── Empty state — nothing recorded that day at all ───────── */
          <View style={styles.stateCard}>
            <View style={[styles.stateIcon, { borderColor: '#5C6670', backgroundColor: '#5C667022' }]}>
              <Ionicons name="document-text-outline" size={30} color="#8A96A3" />
            </View>
            <Text style={styles.stateTitle}>No Production Data</Text>
            <Text style={styles.stateText}>
              No production records were found for {prettyDate(selectedDate)}.
            </Text>
          </View>
        ) : isEmptyFiltered ? (
          /* ── Empty state — the day has records, the filters exclude
                 all of them. Called out separately so the zeros are never
                 mistaken for "nothing was produced". ─────────────────── */
          <View style={styles.stateCard}>
            <View style={[styles.stateIcon, { borderColor: '#F2A93B', backgroundColor: '#F2A93B22' }]}>
              <Ionicons name="funnel-outline" size={28} color="#F2A93B" />
            </View>
            <Text style={styles.stateTitle}>No Records Match These Filters</Text>
            <Text style={styles.stateText}>
              {records.length} production {records.length === 1 ? 'record' : 'records'} exist for{' '}
              {prettyDate(selectedDate)}, but none match{' '}
              {[plant, workshop, division].filter(Boolean).join(' · ')}.
            </Text>
            <Pressable
              onPress={() => {
                setPlant(null);
                setWorkshop(null);
                setDivision(null);
              }}
              style={({ pressed }) => [styles.retryButton, pressed && styles.dateButtonPressed]}
              accessibilityRole="button"
              accessibilityLabel="Clear filters"
            >
              <Ionicons name="close-circle-outline" size={16} color="#ECEFF2" />
              <Text style={styles.retryText}>Clear Filters</Text>
            </Pressable>
          </View>
        ) : (
          <>
            {/* ── Hero: total production ───────────────────────────── */}
            <View style={styles.heroCard}>
              <Text style={styles.heroLabel}>TOTAL PRODUCTION</Text>
              <Text style={styles.heroValue} numberOfLines={1} adjustsFontSizeToFit>
                {formatInt(metrics.totalProduction)}
              </Text>
              <Text style={styles.heroUnit}>Parts Produced</Text>

              <View style={styles.heroFooter}>
                <View style={styles.heroChip}>
                  <Ionicons name="git-branch-outline" size={13} color="#8A96A3" />
                  <Text style={styles.heroChipText}>
                    {metrics.linesRunning} {metrics.linesRunning === 1 ? 'line' : 'lines'}
                  </Text>
                </View>
                <View style={styles.heroChip}>
                  <Ionicons name="time-outline" size={13} color="#8A96A3" />
                  <Text style={styles.heroChipText}>
                    {metrics.shifts.length ? `Shift ${metrics.shifts.join(' + ')}` : 'No shift'}
                  </Text>
                </View>
                <View style={styles.heroChip}>
                  <Ionicons name="layers-outline" size={13} color="#8A96A3" />
                  <Text style={styles.heroChipText}>{metrics.recordCount} records</Text>
                </View>
                {/* Makes a filtered total unmistakable — without this a
                    scoped number reads as the whole plant's output. */}
                {activeFilterCount > 0 ? (
                  <View style={[styles.heroChip, styles.heroChipScoped]}>
                    <Ionicons name="funnel-outline" size={13} color="#3E7CB1" />
                    <Text style={[styles.heroChipText, { color: '#3E7CB1' }]}>
                      {[plant, workshop, division].filter(Boolean).join(' · ')}
                    </Text>
                  </View>
                ) : null}
              </View>
            </View>

            {/* ── Quality + Rejection ──────────────────────────────── */}
            <View style={[styles.duoRow, !isWide && styles.duoRowStacked]}>
              <View style={[styles.duoCard, { borderColor: rejectionColor(metrics.rejectionPct) + '55' }]}>
                <Text style={styles.duoLabel}>QUALITY</Text>
                <Text
                  style={[styles.duoValue, { color: rejectionColor(metrics.rejectionPct) }]}
                  numberOfLines={1}
                  adjustsFontSizeToFit
                >
                  {metrics.qualityPct}%
                </Text>
                <Text style={styles.duoUnit}>First Pass Quality</Text>
                <View style={styles.duoBreakdown}>
                  <View style={styles.duoLine}>
                    <Text style={styles.duoLineLabel}>Total Produced</Text>
                    <Text style={styles.duoLineValue}>{formatInt(metrics.totalProduction)}</Text>
                  </View>
                  <View style={styles.duoLine}>
                    <Text style={styles.duoLineLabel}>Good Parts</Text>
                    <Text style={[styles.duoLineValue, { color: '#4C9A6A' }]}>
                      {formatInt(metrics.goodParts)}
                    </Text>
                  </View>
                  <View style={styles.duoLine}>
                    <Text style={styles.duoLineLabel}>QC Logged Rejections</Text>
                    <Text style={styles.duoLineValue}>
                      {qcRejections === null ? '—' : formatInt(qcRejections)}
                    </Text>
                  </View>
                </View>
              </View>

              <View style={[styles.duoCard, { borderColor: '#D6454555' }]}>
                <Text style={styles.duoLabel}>REJECTION</Text>
                <Text style={[styles.duoValue, { color: '#D64545' }]} numberOfLines={1} adjustsFontSizeToFit>
                  {formatInt(metrics.rejections)}
                </Text>
                <Text style={styles.duoUnit}>Parts Rejected</Text>
                <View style={styles.duoBreakdown}>
                  <View style={styles.duoLine}>
                    <Text style={styles.duoLineLabel}>Rejection %</Text>
                    <Text style={[styles.duoLineValue, { color: rejectionColor(metrics.rejectionPct) }]}>
                      {metrics.rejectionPct}%
                    </Text>
                  </View>
                  <View style={styles.duoLine}>
                    <Text style={styles.duoLineLabel}>Loss Parts</Text>
                    <Text style={styles.duoLineValue}>{formatInt(metrics.lossParts)}</Text>
                  </View>
                  <View style={styles.duoLine}>
                    <Text style={styles.duoLineLabel}>Downtime</Text>
                    <Text style={styles.duoLineValue}>{formatMinutes(metrics.downtimeMinutes)}</Text>
                  </View>
                </View>
              </View>
            </View>

            {/* ── Daily KPIs ───────────────────────────────────────── */}
            <View style={styles.kpiBlock}>
              <View style={styles.kpiHeader}>
                <Text style={styles.sectionLabel}>DAILY KPIs</Text>
                <Text style={styles.kpiHeaderDate}>{prettyDate(selectedDate)}</Text>
              </View>

              <View style={styles.kpiGrid}>
                <KpiTile label="Production Target" value={formatInt(metrics.plannedTotal)} width={kpiWidth} />
                <KpiTile label="Actual Production" value={formatInt(metrics.totalProduction)} width={kpiWidth} />
                <KpiTile
                  label="Achievement"
                  value={`${metrics.efficiency}%`}
                  color={efficiencyColor(metrics.efficiency)}
                  width={kpiWidth}
                />
                <KpiTile
                  label="Efficiency"
                  value={`${metrics.efficiency}%`}
                  color={efficiencyColor(metrics.efficiency)}
                  width={kpiWidth}
                />
                <KpiTile
                  label="Quality"
                  value={`${metrics.qualityPct}%`}
                  color={rejectionColor(metrics.rejectionPct)}
                  width={kpiWidth}
                />
                <KpiTile
                  label="Rejection"
                  value={formatInt(metrics.rejections)}
                  color={metrics.rejections > 0 ? '#D64545' : undefined}
                  width={kpiWidth}
                />
                <KpiTile
                  label="Downtime"
                  value={formatMinutes(metrics.downtimeMinutes)}
                  color={metrics.downtimeMinutes > 0 ? '#F2A93B' : undefined}
                  width={kpiWidth}
                />
                <KpiTile label="Loss Parts" value={formatInt(metrics.lossParts)} width={kpiWidth} />
                <KpiTile label="PCS / Man-Hour" value={`${metrics.pcsPerManHour}`} width={kpiWidth} />
                <KpiTile label="Operator Hours" value={`${metrics.operatorHours}`} width={kpiWidth} />
                <KpiTile label="Lines Running" value={`${metrics.linesRunning}`} width={kpiWidth} />
                <KpiTile label="Slot Records" value={formatInt(metrics.recordCount)} width={kpiWidth} />
              </View>

              {/* Achievement and Efficiency are one and the same figure in
                  ProdPulse (actual ÷ target) — shown under both names only
                  because both labels are already used across the existing
                  report screens. */}
              <Text style={styles.kpiFootnote}>
                Achievement and Efficiency are the same ProdPulse figure: actual ÷ target.
              </Text>
            </View>

            {/* ── Status strip ─────────────────────────────────────── */}
            <View style={styles.statusRow}>
              <View style={styles.statusItem}>
                <View style={[styles.statusDot, { backgroundColor: efficiencyColor(metrics.efficiency) }]} />
                <Text style={styles.statusText}>
                  {metrics.efficiency >= 85
                    ? 'On target'
                    : metrics.efficiency >= 60
                    ? 'Below target'
                    : 'Critical shortfall'}
                </Text>
              </View>
              <View style={styles.statusItem}>
                <View style={[styles.statusDot, { backgroundColor: rejectionColor(metrics.rejectionPct) }]} />
                <Text style={styles.statusText}>
                  {metrics.rejectionPct <= 2
                    ? 'Quality stable'
                    : metrics.rejectionPct <= 5
                    ? 'Quality watch'
                    : 'Quality alert'}
                </Text>
              </View>
              <View style={styles.statusItem}>
                <View
                  style={[
                    styles.statusDot,
                    { backgroundColor: metrics.downtimeMinutes > 0 ? '#F2A93B' : '#4C9A6A' },
                  ]}
                />
                <Text style={styles.statusText}>
                  {metrics.downtimeMinutes > 0
                    ? `${formatMinutes(metrics.downtimeMinutes)} downtime`
                    : 'No downtime logged'}
                </Text>
              </View>
            </View>
          </>
        )}
      </ScrollView>

      <OptionPickerModal
        visible={openFilter !== null}
        title={
          openFilter === 'plant'
            ? 'Select Plant'
            : openFilter === 'workshop'
            ? 'Select Workshop'
            : 'Select Division'
        }
        options={openFilter === 'plant' ? PLANTS : openFilter === 'workshop' ? WORKSHOPS : DIVISIONS}
        value={openFilter === 'plant' ? plant : openFilter === 'workshop' ? workshop : division}
        onClose={() => setOpenFilter(null)}
        onSelect={(next) => {
          if (openFilter === 'plant') setPlant(next);
          else if (openFilter === 'workshop') setWorkshop(next);
          else if (openFilter === 'division') setDivision(next);
          setOpenFilter(null);
        }}
      />

      <DatePickerModal
        visible={pickerOpen}
        value={selectedDate}
        onClose={() => setPickerOpen(false)}
        onApply={(next) => {
          setPickerOpen(false);
          if (next !== selectedDate) setSelectedDate(next);
        }}
      />

      <AppDrawer
        visible={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        items={ADMIN_MENU_ITEMS}
      />
    </View>
  );
}

// ─── Styles — ProdPulse palette, unchanged from the rest of the app ───────────

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#14181C' },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#2C343C',
  },
  hamburger: {
    width: 40,
    height: 40,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#2C343C',
    backgroundColor: '#1D2329',
    alignItems: 'center',
    justifyContent: 'center',
  },
  hamburgerPressed: { backgroundColor: '#242B32', borderColor: '#3A434C' },
  brand: { color: '#ECEFF2', fontSize: 19, fontWeight: '900', letterSpacing: 0.3 },
  brandSub: { color: '#8A96A3', fontSize: 12.5, marginTop: 1 },
  rolePill: {
    borderWidth: 1,
    borderColor: '#3E7CB1',
    backgroundColor: '#3E7CB122',
    borderRadius: 20,
    paddingHorizontal: 11,
    paddingVertical: 4,
  },
  rolePillText: { color: '#3E7CB1', fontSize: 10.5, fontWeight: '900', letterSpacing: 1 },

  scroll: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 40, gap: 16 },

  sectionLabel: { color: '#5C6670', fontSize: 10.5, fontWeight: '800', letterSpacing: 1.2 },

  // Date selector
  dateBlock: { gap: 8 },
  dateRow: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  dateButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    backgroundColor: '#1D2329',
    borderWidth: 1,
    borderColor: '#2C343C',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  dateButtonPressed: { backgroundColor: '#242B32', borderColor: '#3A434C' },
  dateButtonText: { color: '#ECEFF2', fontSize: 15, fontWeight: '700' },
  relPill: {
    borderWidth: 1,
    borderColor: '#4C9A6A',
    backgroundColor: '#4C9A6A22',
    borderRadius: 16,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  relPillText: { color: '#4C9A6A', fontSize: 11, fontWeight: '800' },
  todayLink: { paddingVertical: 4 },
  todayLinkText: { color: '#3E7CB1', fontSize: 12.5, fontWeight: '700' },

  // Hero
  heroCard: {
    backgroundColor: '#1D2329',
    borderWidth: 1,
    borderColor: '#2C343C',
    borderRadius: 14,
    paddingVertical: 26,
    paddingHorizontal: 20,
    alignItems: 'center',
  },
  heroLabel: { color: '#8A96A3', fontSize: 11.5, fontWeight: '900', letterSpacing: 1.6 },
  heroValue: {
    color: '#ECEFF2',
    fontSize: 56,
    fontWeight: '900',
    letterSpacing: -1.5,
    marginTop: 6,
    fontVariant: ['tabular-nums'],
  },
  heroUnit: { color: '#8A96A3', fontSize: 13.5, marginTop: 2 },
  heroFooter: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 8,
    marginTop: 18,
  },
  heroChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#14181C',
    borderWidth: 1,
    borderColor: '#2C343C',
    borderRadius: 16,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  heroChipText: { color: '#8A96A3', fontSize: 11.5, fontWeight: '700' },
  heroChipScoped: { borderColor: '#3E7CB1', backgroundColor: '#3E7CB118' },

  // Plant / Workshop / Division filter chips
  filterRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  filterChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    backgroundColor: '#1D2329',
    borderWidth: 1,
    borderColor: '#2C343C',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 150,
    maxWidth: 260,
  },
  filterChipActive: { borderColor: '#3E7CB155', backgroundColor: '#3E7CB112' },
  filterChipLabel: { color: '#5C6670', fontSize: 11, fontWeight: '800', letterSpacing: 0.6 },
  filterChipValue: { color: '#8A96A3', fontSize: 13, fontWeight: '700', flex: 1, textAlign: 'right' },
  filterChipValueActive: { color: '#ECEFF2' },

  // Option list inside the filter modal
  optionList: { maxHeight: 300 },
  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    borderRadius: 9,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  optionRowActive: { borderColor: '#3E7CB155', backgroundColor: '#3E7CB118' },
  optionText: { color: '#8A96A3', fontSize: 14, fontWeight: '600' },
  optionTextActive: { color: '#ECEFF2', fontWeight: '800' },

  // Quality / Rejection pair
  duoRow: { flexDirection: 'row', gap: 12 },
  duoRowStacked: { flexDirection: 'column' },
  duoCard: {
    flex: 1,
    backgroundColor: '#1D2329',
    borderWidth: 1,
    borderRadius: 14,
    padding: 18,
  },
  duoLabel: { color: '#8A96A3', fontSize: 11, fontWeight: '900', letterSpacing: 1.4 },
  duoValue: {
    fontSize: 38,
    fontWeight: '900',
    marginTop: 6,
    letterSpacing: -0.8,
    fontVariant: ['tabular-nums'],
  },
  duoUnit: { color: '#8A96A3', fontSize: 12.5, marginTop: 1 },
  duoBreakdown: {
    marginTop: 14,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#2C343C',
    gap: 7,
  },
  duoLine: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  duoLineLabel: { color: '#8A96A3', fontSize: 12.5, flexShrink: 1 },
  duoLineValue: { color: '#ECEFF2', fontSize: 13.5, fontWeight: '800', fontVariant: ['tabular-nums'] },

  // KPI grid
  kpiBlock: { gap: 10 },
  kpiHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  kpiHeaderDate: { color: '#5C6670', fontSize: 11.5, fontWeight: '700' },
  kpiGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  kpiTile: {
    backgroundColor: '#1D2329',
    borderWidth: 1,
    borderColor: '#2C343C',
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 14,
    minHeight: 84,
    justifyContent: 'space-between',
  },
  kpiLabel: { color: '#8A96A3', fontSize: 11.5, fontWeight: '700' },
  kpiValue: {
    color: '#ECEFF2',
    fontSize: 25,
    fontWeight: '900',
    fontVariant: ['tabular-nums'],
    marginTop: 8,
  },
  kpiFootnote: { color: '#5C6670', fontSize: 11, marginTop: 2 },

  // Status strip
  statusRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 14,
    backgroundColor: '#1D2329',
    borderWidth: 1,
    borderColor: '#2C343C',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  statusItem: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { color: '#8A96A3', fontSize: 12.5, fontWeight: '700' },

  // Loading / empty / error
  stateBlock: { gap: 12, alignItems: 'center' },
  skeletonHero: {
    width: '100%',
    height: 160,
    borderRadius: 14,
    backgroundColor: '#1D2329',
    borderWidth: 1,
    borderColor: '#2C343C',
  },
  skeletonRow: { flexDirection: 'row', gap: 12, width: '100%' },
  skeletonHalf: {
    flex: 1,
    height: 120,
    borderRadius: 14,
    backgroundColor: '#1D2329',
    borderWidth: 1,
    borderColor: '#2C343C',
  },
  stateCard: {
    backgroundColor: '#1D2329',
    borderWidth: 1,
    borderColor: '#2C343C',
    borderRadius: 14,
    paddingVertical: 36,
    paddingHorizontal: 24,
    alignItems: 'center',
    gap: 8,
  },
  stateIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  stateTitle: { color: '#ECEFF2', fontSize: 16.5, fontWeight: '800', textAlign: 'center' },
  stateText: { color: '#8A96A3', fontSize: 13, textAlign: 'center' },
  retryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    borderWidth: 1,
    borderColor: '#2C343C',
    backgroundColor: '#14181C',
    borderRadius: 9,
    paddingHorizontal: 18,
    paddingVertical: 10,
    marginTop: 8,
  },
  retryText: { color: '#ECEFF2', fontSize: 13.5, fontWeight: '700' },

  // Date picker modal
  modalScrim: {
    flex: 1,
    backgroundColor: '#000000AA',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  modalCard: {
    width: '100%',
    maxWidth: 380,
    backgroundColor: '#1A1F25',
    borderWidth: 1,
    borderColor: '#2C343C',
    borderRadius: 14,
    padding: 18,
    gap: 12,
  },
  modalTitle: { color: '#ECEFF2', fontSize: 16.5, fontWeight: '800' },
  presetRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  presetChip: {
    borderWidth: 1,
    borderColor: '#2C343C',
    backgroundColor: '#1D2329',
    borderRadius: 16,
    paddingHorizontal: 13,
    paddingVertical: 7,
  },
  presetChipActive: { borderColor: '#3E7CB1', backgroundColor: '#3E7CB122' },
  presetChipText: { color: '#8A96A3', fontSize: 12.5, fontWeight: '600' },
  presetChipTextActive: { color: '#3E7CB1' },
  modalInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderColor: '#2C343C',
    backgroundColor: '#14181C',
    borderRadius: 10,
    paddingHorizontal: 12,
  },
  modalInput: { flex: 1, height: 44, color: '#ECEFF2', fontSize: 15 },
  modalHint: { color: '#5C6670', fontSize: 12 },
  modalActions: { flexDirection: 'row', gap: 10, justifyContent: 'flex-end', marginTop: 2 },
  modalBtn: { borderRadius: 9, paddingHorizontal: 18, paddingVertical: 10 },
  modalBtnGhost: { borderWidth: 1, borderColor: '#2C343C' },
  modalBtnGhostText: { color: '#8A96A3', fontSize: 13.5, fontWeight: '700' },
  modalBtnPrimary: { backgroundColor: '#3E7CB1' },
  modalBtnPrimaryText: { color: '#0E1216', fontSize: 13.5, fontWeight: '800' },
  modalBtnDisabled: { opacity: 0.4 },
});
