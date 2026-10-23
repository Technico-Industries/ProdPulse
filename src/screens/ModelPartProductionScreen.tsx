// src/screens/ModelPartProductionScreen.tsx
//
// Admin-only "Model / Part Production": total production per model / part
// for a production day or date range, with the Generate Report filters plus
// a supervisor filter. Reached from the admin hamburger drawer
// (constants/adminMenu.ts).
//
// ACCESS — non-admins get the "Access Restricted" view and the content
// component (the only thing that queries Firestore) never mounts; the load
// itself re-checks the role and the users/{uid} profile before reading
// records (utils/modelPartProduction loadRecordsForAdmin).
//
// DATA — one production-date range query per Load (the same one Generate
// Report uses — see services/productionRecordQueries), then every other
// filter, the sorting and the drill-down run in memory on the loaded
// records, so changing them costs no reads. Figures, de-duplication and
// the export all come from utils/modelPartProduction buildReport.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  SafeAreaView,
  ScrollView,
  ActivityIndicator,
  Modal,
  Platform,
  useWindowDimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { collection, getDocs } from 'firebase/firestore';
import { db } from '../services/firebase';
import { useAuthStore } from '../stores/authStore';
import { PLANTS, WORKSHOPS, DIVISIONS } from '../constants/lineOptions';
import { loadModelPartRecords } from '../services/modelPartProductionQueries';
import { exportModelPartToExcel } from '../utils/modelPartExcelExport';
import {
  buildExportTables,
  buildReport,
  canViewModelPartProduction,
  createLatestRequestGuard,
  DetailDimension,
  EMPTY_FILTERS,
  hasActiveFilters,
  loadErrorMessage,
  MPFilters,
  MPLine,
  MPRecord,
  Option,
  partDetail,
  partOptions,
  PartSort,
  resolveLineFields,
  supervisorOptions,
  validateDateRange,
} from '../utils/modelPartProduction';

// ─── Helpers (same as GenerateReportScreen's) ────────────────────────────────

function pad2(n: number) {
  return String(n).padStart(2, '0');
}

function dateStrDaysAgo(days: number) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

const todayStr = () => dateStrDaysAgo(0);

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

// YYYY-MM-DD as the user types — see GenerateReportScreen formatDateInputValue.
function formatDateInputValue(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 8);
  let out = digits.slice(0, 4);
  if (digits.length > 4) out += `-${digits.slice(4, 6)}`;
  if (digits.length > 6) out += `-${digits.slice(6, 8)}`;
  return out;
}

function formatDateTime(ms: number | null) {
  if (!ms) return '—';
  const d = new Date(ms);
  return `${pad2(d.getDate())} ${d.toLocaleString('en-US', { month: 'short' })}, ${d.getHours() % 12 === 0 ? 12 : d.getHours() % 12}:${pad2(d.getMinutes())} ${d.getHours() >= 12 ? 'PM' : 'AM'}`;
}

function formatInt(n: number) {
  return n.toLocaleString('en-US');
}

function isAssemblyWorkshop(w: string | null) {
  return !!w && w.toLowerCase().includes('assembly');
}

const SORTS: { key: PartSort; label: string }[] = [
  { key: 'qty-desc', label: 'Qty ↓' },
  { key: 'qty-asc', label: 'Qty ↑' },
  { key: 'name-asc', label: 'Name A–Z' },
  { key: 'name-desc', label: 'Name Z–A' },
];

const DIMENSIONS: { key: DetailDimension; label: string }[] = [
  { key: 'day', label: 'By day' },
  { key: 'shift', label: 'By shift' },
  { key: 'line', label: 'By line' },
  { key: 'supervisor', label: 'By supervisor' },
];

const CHART_TOP = 10;
const PRODUCED_COLOR = '#4C9A6A';

type DropdownKind = 'plant' | 'workshop' | 'division' | 'line' | 'part' | 'shift' | 'supervisor';

const DROPDOWN_TITLES: Record<DropdownKind, string> = {
  plant: 'Select Plant',
  workshop: 'Select Workshop',
  division: 'Select Division',
  line: 'Select Line',
  part: 'Select Model / Part',
  shift: 'Select Shift',
  supervisor: 'Select Supervisor',
};

function PickerBox({ label, value, placeholder, onPress, disabled, style }: {
  label: string; value?: string | null; placeholder: string; onPress: () => void; disabled?: boolean; style?: any;
}) {
  return (
    <View style={[styles.field, style]}>
      <Text style={styles.label}>{label}</Text>
      <Pressable onPress={onPress} disabled={disabled} style={[styles.pickerBox, disabled && styles.disabledInput]} accessibilityRole="button" accessibilityLabel={`${label}: ${value || placeholder}`}>
        <Text style={[styles.pickerBoxText, !value && styles.pickerBoxPlaceholder]} numberOfLines={1}>{value || placeholder}</Text>
        <Ionicons name="chevron-down" size={18} color="#8A96A3" />
      </Pressable>
    </View>
  );
}

// ─── Screen ──────────────────────────────────────────────────────────────────

export default function ModelPartProductionScreen() {
  const navigation = useNavigation<any>();
  const user = useAuthStore((s) => s.user);
  if (!canViewModelPartProduction(user)) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.scroll}>
          <Text style={styles.title}>Access Restricted</Text>
          <Text style={styles.subtitle}>Only admin accounts can view Model / Part Production.</Text>
          <Pressable style={styles.loadButton} onPress={() => navigation.navigate('Home')}>
            <Text style={styles.loadButtonText}>Back to Home</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }
  return <ModelPartProductionContent />;
}

function ModelPartProductionContent() {
  const navigation = useNavigation<any>();
  const user = useAuthStore((s) => s.user);
  const { width } = useWindowDimensions();
  const wide = width >= 900;

  // ── Date range: what's typed vs what's loaded
  const [fromDate, setFromDate] = useState(todayStr());
  const [toDate, setToDate] = useState(todayStr());
  const [loadedRange, setLoadedRange] = useState<{ from: string; to: string } | null>(null);
  const [rangeError, setRangeError] = useState<string | null>(null);

  const [filters, setFilters] = useState<MPFilters>(EMPTY_FILTERS);
  const [sort, setSort] = useState<PartSort>('qty-desc');
  const [activeDropdown, setActiveDropdown] = useState<DropdownKind | null>(null);
  const [expandedPart, setExpandedPart] = useState<string | null>(null);
  const [dimension, setDimension] = useState<DetailDimension>('day');

  const [allLines, setAllLines] = useState<MPLine[]>([]);
  const [loadingLines, setLoadingLines] = useState(true);

  const [loaded, setLoaded] = useState<MPRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [exporting, setExporting] = useState(false);
  const [exportMsg, setExportMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const guardRef = useRef(createLatestRequestGuard());
  useEffect(() => () => guardRef.current.cancel(), []);

  // Lines — same read and field fallbacks as GenerateReportScreen.
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const snap = await getDocs(collection(db, 'productionLines'));
        if (!mounted) return;
        setAllLines(snap.docs.map((d) => {
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
        }));
      } catch (e) {
        console.error('[ModelPartProduction] load lines', e);
      } finally {
        if (mounted) setLoadingLines(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

  const load = async (from: string, to: string) => {
    const err = validateDateRange(from, to);
    setRangeError(err);
    if (err) return;
    const token = guardRef.current.next();
    setLoading(true);
    setLoadError(null);
    setExportMsg(null);
    try {
      const records = await loadModelPartRecords(user, from, to);
      if (!guardRef.current.isCurrent(token)) return;
      setLoaded(records);
      setLoadedRange({ from, to });
      setExpandedPart(null);
    } catch (e) {
      if (!guardRef.current.isCurrent(token)) return;
      console.error('[ModelPartProduction] load', e);
      setLoadError(loadErrorMessage(e));
    } finally {
      if (guardRef.current.isCurrent(token)) setLoading(false);
    }
  };

  // Today's production on open — one load, like a daily review.
  useEffect(() => { load(fromDate, toDate); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Filter option lists
  const scopedLines = useMemo(() => allLines.filter((l) => {
    const eq = (a?: string | null, b?: string | null) => !b || !a || a.trim().toLowerCase() === b.trim().toLowerCase();
    return eq(l.plant, filters.plant) && eq(l.workshop, filters.workshop) && eq(l.division, filters.division);
  }), [allLines, filters.plant, filters.workshop, filters.division]);

  const resolved = useMemo(() => resolveLineFields(loaded, allLines), [loaded, allLines]);
  const parts = useMemo(
    () => partOptions(filters.lineId ? allLines.filter((l) => l.id === filters.lineId) : scopedLines, resolved),
    [filters.lineId, allLines, scopedLines, resolved]
  );
  const supervisors = useMemo(() => supervisorOptions(resolved), [resolved]);

  // Stale selections are cleared, never left filtering out everything unseen.
  useEffect(() => {
    if (!isAssemblyWorkshop(filters.workshop) && filters.division) setFilters((f) => ({ ...f, division: null }));
  }, [filters.workshop]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (filters.lineId && !loadingLines && !scopedLines.some((l) => l.id === filters.lineId)) setFilters((f) => ({ ...f, lineId: null }));
  }, [scopedLines, filters.lineId, loadingLines]);
  useEffect(() => {
    if (filters.partKey && !parts.some((p) => p.key === filters.partKey)) setFilters((f) => ({ ...f, partKey: null }));
  }, [parts, filters.partKey]);
  useEffect(() => {
    if (filters.supervisorKey && !supervisors.some((s) => s.key === filters.supervisorKey)) setFilters((f) => ({ ...f, supervisorKey: null }));
  }, [supervisors, filters.supervisorKey]);

  const report = useMemo(() => buildReport(resolved, filters, sort), [resolved, filters, sort]);
  const chartRows = useMemo(
    () => [...report.parts].sort((a, b) => b.produced - a.produced).slice(0, CHART_TOP).filter((p) => p.produced > 0),
    [report.parts]
  );
  const chartMax = chartRows.length ? chartRows[0].produced : 0;

  const lineLabel = filters.lineId ? allLines.find((l) => l.id === filters.lineId)?.lineName ?? filters.lineId : null;
  const partLabel = filters.partKey ? parts.find((p) => p.key === filters.partKey)?.label ?? null : null;
  const supervisorLabel = filters.supervisorKey ? supervisors.find((s) => s.key === filters.supervisorKey)?.label ?? null : null;
  const rangeLabel = loadedRange ? (loadedRange.from === loadedRange.to ? loadedRange.from : `${loadedRange.from} → ${loadedRange.to}`) : null;
  const rangeDirty = !!loadedRange && (fromDate !== loadedRange.from || toDate !== loadedRange.to);

  const handleExport = async () => {
    if (exporting || !loadedRange) return;
    setExporting(true);
    setExportMsg(null);
    try {
      const tables = buildExportTables(report, {
        fromDate: loadedRange.from, toDate: loadedRange.to,
        plant: filters.plant, workshop: filters.workshop, division: filters.division,
        lineName: lineLabel, partName: partLabel, shift: filters.shift, supervisorName: supervisorLabel,
      });
      await exportModelPartToExcel(tables, loadedRange.from, loadedRange.to);
      setExportMsg({ ok: true, text: Platform.OS === 'web' ? 'The Excel file has downloaded.' : 'Choose where to save or send the Excel file.' });
    } catch (e) {
      console.error('[ModelPartProduction] export', e);
      setExportMsg({ ok: false, text: 'Could not generate the Excel file. Please try again.' });
    } finally {
      setExporting(false);
    }
  };

  // ── Dropdown
  const dropdownOptions: Option[] = useMemo(() => {
    switch (activeDropdown) {
      case 'plant': return [{ key: 'ANY', label: 'Any' }, ...PLANTS.map((p) => ({ key: p, label: p }))];
      case 'workshop': return [{ key: 'ANY', label: 'Any' }, ...WORKSHOPS.map((w) => ({ key: w, label: w }))];
      case 'division': return [{ key: 'ANY', label: 'Any' }, ...DIVISIONS.map((d) => ({ key: d, label: d }))];
      case 'line': return [{ key: 'ANY', label: 'All lines' }, ...scopedLines.map((l) => ({ key: l.id, label: l.lineName ?? l.id }))];
      case 'part': return [{ key: 'ANY', label: 'All models / parts' }, ...parts];
      case 'shift': return [{ key: 'All', label: 'All shifts' }, { key: 'A', label: 'Shift A' }, { key: 'B', label: 'Shift B' }];
      case 'supervisor': return [{ key: 'ANY', label: 'All supervisors' }, ...supervisors];
      default: return [];
    }
  }, [activeDropdown, scopedLines, parts, supervisors]);

  const selectedKey = (() => {
    switch (activeDropdown) {
      case 'plant': return filters.plant ?? 'ANY';
      case 'workshop': return filters.workshop ?? 'ANY';
      case 'division': return filters.division ?? 'ANY';
      case 'line': return filters.lineId ?? 'ANY';
      case 'part': return filters.partKey ?? 'ANY';
      case 'shift': return filters.shift;
      case 'supervisor': return filters.supervisorKey ?? 'ANY';
      default: return '';
    }
  })();

  const select = (key: string) => {
    const v = key === 'ANY' ? null : key;
    setFilters((f) => {
      switch (activeDropdown) {
        case 'plant': return { ...f, plant: v };
        case 'workshop': return { ...f, workshop: v };
        case 'division': return { ...f, division: v };
        case 'line': return { ...f, lineId: v };
        case 'part': return { ...f, partKey: v };
        case 'shift': return { ...f, shift: key as MPFilters['shift'] };
        case 'supervisor': return { ...f, supervisorKey: v };
        default: return f;
      }
    });
    setActiveDropdown(null);
  };

  const fieldStyle = wide ? styles.fieldWide : null;
  const s = report.summary;

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={[styles.scroll, wide && styles.scrollWide]} keyboardShouldPersistTaps="handled">
        <Pressable onPress={() => navigation.goBack()} style={styles.backButton} hitSlop={12}>
          <Ionicons name="arrow-back" size={22} color="#8A96A3" />
          <Text style={styles.backText}>Back</Text>
        </Pressable>

        <Text style={styles.title}>Model / Part Production</Text>
        <Text style={styles.subtitle}>
          {rangeLabel ? `Production date ${rangeLabel}` : 'Total production by model / part'}
        </Text>

        {/* DATE */}
        <Text style={styles.sectionLabel}>PRODUCTION DATE</Text>
        <View style={styles.chipsRow}>
          {DATE_PRESETS.map((p) => {
            const active = loadedRange?.from === p.from() && loadedRange?.to === p.to();
            return (
              <Pressable
                key={p.key}
                onPress={() => { const f = p.from(); const t = p.to(); setFromDate(f); setToDate(t); load(f, t); }}
                style={[styles.chip, active && styles.chipSelected]}
                disabled={loading}
              >
                <Text style={[styles.chipText, active && styles.chipTextSelected]}>{p.label}</Text>
              </Pressable>
            );
          })}
        </View>
        <View style={[styles.row, { marginTop: 10 }]}>
          <View style={{ flex: 1 }}>
            <Text style={styles.label}>From</Text>
            <TextInput style={styles.input} value={fromDate} onChangeText={(v) => setFromDate(formatDateInputValue(v))}
              placeholder="YYYY-MM-DD" placeholderTextColor="#5C6670" keyboardType="number-pad" maxLength={10} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.label}>To</Text>
            <TextInput style={styles.input} value={toDate} onChangeText={(v) => setToDate(formatDateInputValue(v))}
              placeholder="YYYY-MM-DD" placeholderTextColor="#5C6670" keyboardType="number-pad" maxLength={10} />
          </View>
          <Pressable
            style={({ pressed }) => [styles.loadButton, styles.loadButtonInline, (loading || pressed) && styles.pressed]}
            onPress={() => load(fromDate, toDate)}
            disabled={loading}
            accessibilityRole="button"
            accessibilityLabel="Load production for the selected dates"
          >
            {loading ? <ActivityIndicator color="#14181C" /> : <Text style={styles.loadButtonText}>Load</Text>}
          </Pressable>
        </View>
        {rangeError && <Text style={styles.inlineError}>{rangeError}</Text>}
        {rangeDirty && !rangeError && <Text style={styles.hint}>Press Load to show these dates.</Text>}
        <Text style={styles.hint}>
          Records are grouped by production date: a Shift B night stays on the date it started, including its after-midnight slots.
        </Text>

        {/* FILTERS */}
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionLabel}>FILTERS</Text>
          {hasActiveFilters(filters) && (
            <Pressable onPress={() => setFilters(EMPTY_FILTERS)} hitSlop={8} accessibilityRole="button">
              <Text style={styles.resetText}>Clear filters</Text>
            </Pressable>
          )}
        </View>
        <View style={wide ? styles.filterGrid : null}>
          <PickerBox style={fieldStyle} label="Plant" value={filters.plant} placeholder="Any" onPress={() => setActiveDropdown('plant')} />
          <PickerBox style={fieldStyle} label="Workshop" value={filters.workshop} placeholder="Any" onPress={() => setActiveDropdown('workshop')} />
          {isAssemblyWorkshop(filters.workshop) && (
            <PickerBox style={fieldStyle} label="Division" value={filters.division} placeholder="Any" onPress={() => setActiveDropdown('division')} />
          )}
          <PickerBox style={fieldStyle} label="Line" value={lineLabel} placeholder={loadingLines ? 'Loading lines…' : 'All lines'} disabled={loadingLines} onPress={() => setActiveDropdown('line')} />
          <PickerBox style={fieldStyle} label="Model / Part" value={partLabel} placeholder={parts.length ? 'All models / parts' : 'No parts available'} disabled={!parts.length} onPress={() => setActiveDropdown('part')} />
          <PickerBox style={fieldStyle} label="Shift" value={filters.shift === 'All' ? null : `Shift ${filters.shift}`} placeholder="All shifts" onPress={() => setActiveDropdown('shift')} />
          <PickerBox style={fieldStyle} label="Supervisor" value={supervisorLabel} placeholder={supervisors.length ? 'All supervisors' : 'None in these dates'} disabled={!supervisors.length} onPress={() => setActiveDropdown('supervisor')} />
        </View>

        {/* RESULTS */}
        {loadError ? (
          <View style={styles.centered}>
            <Ionicons name="alert-circle" size={22} color="#D64545" />
            <Text style={styles.errorText}>{loadError}</Text>
            <Pressable onPress={() => load(fromDate, toDate)} style={styles.retryButton}>
              <Text style={styles.retryText}>Retry</Text>
            </Pressable>
          </View>
        ) : !loadedRange ? (
          <View style={styles.centered}><ActivityIndicator color="#F2A93B" /></View>
        ) : (
          <View style={loading ? styles.stale : null}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionLabel}>SUMMARY</Text>
              <Pressable
                onPress={handleExport}
                disabled={exporting || report.records.length === 0}
                style={[styles.excelButton, (exporting || report.records.length === 0) && styles.disabledInput]}
                hitSlop={8}
                accessibilityRole="button"
              >
                {exporting ? <ActivityIndicator size="small" color="#4C9A6A" /> : <Ionicons name="grid-outline" size={16} color="#4C9A6A" />}
                <Text style={styles.excelButtonText}>{exporting ? 'Exporting…' : 'Export Excel'}</Text>
              </Pressable>
            </View>
            {exportMsg && <Text style={exportMsg.ok ? styles.okText : styles.inlineError}>{exportMsg.text}</Text>}

            <View style={styles.statGrid}>
              <Stat wide={wide} value={formatInt(s.produced)} label="Produced (good)" color={PRODUCED_COLOR} />
              <Stat wide={wide} value={formatInt(s.rejected)} label="Rejected" color="#D64545" />
              <Stat wide={wide} value={formatInt(s.output)} label="Total output" />
              <Stat wide={wide} value={formatInt(s.partCount)} label="Models / Parts" />
              <Stat wide={wide} value={formatInt(s.lineCount)} label="Lines" />
              <Stat wide={wide} value={formatInt(s.records)} label="Slot records" />
            </View>
            <Text style={styles.hint}>
              Produced is the good output supervisors record per slot; rejected parts are counted separately, so total output = produced + rejected
              {s.quality.rejectionPct != null ? ` (rejection ${s.quality.rejectionPct}%)` : ''}.
              {s.legacyRejectionRecords > 0 ? ` ${s.legacyRejectionRecords} older record(s) have no rejection counter and add 0 rejected.` : ''}
            </Text>
            {report.duplicates.length > 0 && (
              <View style={styles.notice}>
                <Ionicons name="copy-outline" size={16} color="#F2A93B" />
                <Text style={styles.noticeText}>
                  {report.duplicates.length} duplicate record(s) of slots already counted ({formatInt(report.duplicateProduced)} pcs) are excluded.
                  Generate Report still adds them. They are listed in the export; nothing was changed in the database.
                </Text>
              </View>
            )}

            {report.records.length === 0 ? (
              <View style={styles.centered}>
                <Ionicons name="document-text-outline" size={28} color="#5C6670" />
                <Text style={styles.emptyText}>
                  {loaded.length === 0 ? 'No production was recorded on these dates.' : 'No production records match these filters.'}
                </Text>
                {hasActiveFilters(filters) && (
                  <Pressable onPress={() => setFilters(EMPTY_FILTERS)} style={styles.retryButton}>
                    <Text style={styles.retryText}>Clear filters</Text>
                  </Pressable>
                )}
              </View>
            ) : (
              <>
                {/* CHART — top models / parts by produced; the table below is the full list */}
                <View style={[styles.card, { marginTop: 14 }]}>
                  <Text style={styles.cardTitle}>Produced by model / part</Text>
                  <Text style={styles.cardSub}>
                    {report.parts.length > chartRows.length ? `Top ${chartRows.length} of ${report.parts.length} · ` : ''}good parts, {rangeLabel}
                  </Text>
                  {chartRows.map((p) => (
                    <Pressable key={p.key} onPress={() => setExpandedPart(p.key)} style={styles.barRow} accessibilityLabel={`${p.partName}: ${p.produced} produced`}>
                      <Text style={styles.barLabel} numberOfLines={1}>{p.partName}</Text>
                      <View style={styles.barTrack}>
                        <View style={[styles.barFill, { width: `${chartMax > 0 ? Math.max(1, (p.produced / chartMax) * 100) : 0}%` }]} />
                      </View>
                      <Text style={styles.barValue}>{formatInt(p.produced)}</Text>
                    </Pressable>
                  ))}
                </View>

                {/* TABLE */}
                <View style={styles.sectionHeader}>
                  <Text style={styles.sectionLabel}>BY MODEL / PART</Text>
                </View>
                <View style={[styles.chipsRow, { marginBottom: 10 }]}>
                  {SORTS.map((o) => (
                    <Pressable key={o.key} onPress={() => setSort(o.key)} style={[styles.chip, sort === o.key && styles.chipSelected]}>
                      <Text style={[styles.chipText, sort === o.key && styles.chipTextSelected]}>{o.label}</Text>
                    </Pressable>
                  ))}
                </View>
                <View style={styles.card}>
                  <View style={styles.tableHead}>
                    <Text style={[styles.th, { flex: 2.2, textAlign: 'left' }]}>Model / Part</Text>
                    <Text style={styles.th}>Produced</Text>
                    <Text style={styles.th}>Rejected</Text>
                    <Text style={styles.th}>Lines</Text>
                    {wide && <Text style={[styles.th, { flex: 1.6 }]}>Latest saved</Text>}
                  </View>
                  {report.parts.map((p) => {
                    const open = expandedPart === p.key;
                    return (
                      <View key={p.key} style={styles.tr}>
                        <Pressable onPress={() => setExpandedPart(open ? null : p.key)} style={styles.trMain} accessibilityRole="button" accessibilityLabel={`${p.partName} details`}>
                          <View style={{ flex: 2.2, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                            <Ionicons name={open ? 'chevron-down' : 'chevron-forward'} size={14} color="#8A96A3" />
                            <View style={{ flex: 1 }}>
                              <Text style={styles.tdName} numberOfLines={2}>{p.partName}</Text>
                              {!wide && <Text style={styles.tdMeta}>Latest {formatDateTime(p.latestMs)}</Text>}
                            </View>
                          </View>
                          <Text style={[styles.td, { color: '#ECEFF2', fontWeight: '800' }]}>{formatInt(p.produced)}</Text>
                          <Text style={styles.td}>{formatInt(p.rejected)}</Text>
                          <Text style={styles.td}>{p.lineCount}</Text>
                          {wide && <Text style={[styles.td, { flex: 1.6 }]}>{formatDateTime(p.latestMs)}</Text>}
                        </Pressable>
                        {open && (
                          <View style={styles.detail}>
                            <Text style={styles.tdMeta}>{p.lineNames.join(', ') || 'Unknown line'} · {p.records} slot record(s)</Text>
                            <View style={[styles.chipsRow, { marginVertical: 8 }]}>
                              {DIMENSIONS.map((d) => (
                                <Pressable key={d.key} onPress={() => setDimension(d.key)} style={[styles.chipSmall, dimension === d.key && styles.chipSelected]}>
                                  <Text style={[styles.chipText, dimension === d.key && styles.chipTextSelected]}>{d.label}</Text>
                                </Pressable>
                              ))}
                            </View>
                            {partDetail(report.records, p.key, dimension).map((d) => (
                              <View key={d.key} style={styles.detailRow}>
                                <Text style={styles.detailLabel} numberOfLines={1}>{d.label}</Text>
                                <Text style={styles.detailValue}>{formatInt(d.produced)}</Text>
                                <Text style={styles.detailReject}>{formatInt(d.rejected)} rej</Text>
                              </View>
                            ))}
                          </View>
                        )}
                      </View>
                    );
                  })}
                </View>
              </>
            )}
          </View>
        )}
      </ScrollView>

      <Modal visible={activeDropdown !== null} transparent animationType="fade" onRequestClose={() => setActiveDropdown(null)}>
        <Pressable style={styles.modalOverlay} onPress={() => setActiveDropdown(null)}>
          <Pressable style={styles.modalCard} onPress={() => {}}>
            <Text style={styles.modalTitle}>{activeDropdown ? DROPDOWN_TITLES[activeDropdown] : ''}</Text>
            <ScrollView contentContainerStyle={{ paddingBottom: 12 }}>
              {dropdownOptions.map((o) => {
                const sel = o.key === selectedKey;
                return (
                  <Pressable key={o.key} onPress={() => select(o.key)} style={[styles.modalRow, sel && styles.modalRowSelected]}>
                    <Text style={[styles.modalRowText, sel && styles.modalRowTextSelected]}>{o.label}</Text>
                  </Pressable>
                );
              })}
            </ScrollView>
            <View style={styles.modalFooter}>
              <Pressable onPress={() => setActiveDropdown(null)} style={styles.modalBtn}>
                <Text style={styles.modalBtnText}>Close</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

function Stat({ value, label, color, wide }: { value: string; label: string; color?: string; wide: boolean }) {
  return (
    <View style={[styles.statCard, wide && styles.statCardWide]}>
      <Text style={[styles.statValue, color ? { color } : null]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

// Same palette and control styles as GenerateReportScreen.
const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#14181C' },
  scroll: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 40 },
  scrollWide: { paddingHorizontal: 28, maxWidth: 1200, width: '100%', alignSelf: 'center' },
  centered: { alignItems: 'center', justifyContent: 'center', gap: 10, paddingVertical: 30 },
  backButton: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 8 },
  backText: { color: '#8A96A3', fontSize: 15 },
  title: { color: '#ECEFF2', fontSize: 22, fontWeight: '800' },
  subtitle: { color: '#8A96A3', fontSize: 13, marginTop: 4, marginBottom: 14 },
  sectionLabel: { color: '#F2A93B', fontSize: 12, fontWeight: '800', letterSpacing: 1.4, marginBottom: 8, marginTop: 4 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 18 },
  field: { marginBottom: 12 },
  fieldWide: { width: '32%', marginRight: '1.3%' },
  filterGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  label: { color: '#8A96A3', fontSize: 11.5, marginBottom: 6, fontWeight: '700' },
  row: { flexDirection: 'row', gap: 8, alignItems: 'flex-end' },
  input: {
    backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C',
    borderRadius: 10, paddingHorizontal: 12, height: 48, color: '#ECEFF2', fontSize: 15,
  },
  disabledInput: { opacity: 0.5 },
  pickerBox: {
    backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C', borderRadius: 10,
    paddingHorizontal: 12, height: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  pickerBoxText: { color: '#ECEFF2', fontSize: 15, flex: 1, marginRight: 8 },
  pickerBoxPlaceholder: { color: '#5C6670' },
  resetText: { color: '#F2A93B', fontSize: 12.5, fontWeight: '700' },
  chipsRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  chip: { borderWidth: 1, borderColor: '#2C343C', backgroundColor: '#1D2329', borderRadius: 16, paddingHorizontal: 12, paddingVertical: 8 },
  chipSmall: { borderWidth: 1, borderColor: '#2C343C', backgroundColor: '#1D2329', borderRadius: 14, paddingHorizontal: 10, paddingVertical: 6 },
  chipSelected: { borderColor: '#F2A93B', backgroundColor: '#F2A93B22' },
  chipText: { color: '#8A96A3', fontSize: 13, fontWeight: '600' },
  chipTextSelected: { color: '#F2A93B' },
  hint: { color: '#8A96A3', fontSize: 11.5, marginTop: 8, lineHeight: 16 },
  inlineError: { color: '#F0A8A8', fontSize: 12.5, marginTop: 8 },
  okText: { color: '#8FD1A6', fontSize: 12.5, marginBottom: 8 },
  errorText: { color: '#F0A8A8', fontSize: 13.5, textAlign: 'center' },
  emptyText: { color: '#8A96A3', fontSize: 14, textAlign: 'center' },
  retryButton: { borderWidth: 1, borderColor: '#2C343C', borderRadius: 8, paddingHorizontal: 16, paddingVertical: 8, marginTop: 4 },
  retryText: { color: '#ECEFF2', fontSize: 13, fontWeight: '600' },
  loadButton: { height: 48, borderRadius: 10, backgroundColor: '#F2A93B', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20, marginTop: 14 },
  loadButtonInline: { marginTop: 0, minWidth: 84 },
  loadButtonText: { color: '#14181C', fontSize: 15, fontWeight: '900' },
  pressed: { opacity: 0.85 },
  stale: { opacity: 0.55 },
  excelButton: { flexDirection: 'row', alignItems: 'center', gap: 5, borderWidth: 1, borderColor: '#4C9A6A', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  excelButtonText: { color: '#4C9A6A', fontWeight: '700', fontSize: 12 },

  statGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  statCard: {
    width: '31%', flexGrow: 1, backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C',
    borderRadius: 10, paddingVertical: 14, paddingHorizontal: 6, alignItems: 'center', gap: 4,
  },
  statCardWide: { width: '15%' },
  statValue: { color: '#ECEFF2', fontSize: 18, fontWeight: '800' },
  statLabel: { color: '#8A96A3', fontSize: 11, fontWeight: '700', textAlign: 'center' },

  notice: {
    flexDirection: 'row', gap: 8, alignItems: 'flex-start', marginTop: 10, padding: 10, borderRadius: 10,
    borderWidth: 1, borderColor: '#F2A93B55', backgroundColor: '#F2A93B12',
  },
  noticeText: { flex: 1, color: '#ECEFF2', fontSize: 12, lineHeight: 17 },

  card: { backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C', borderRadius: 12, padding: 12 },
  cardTitle: { color: '#ECEFF2', fontSize: 15, fontWeight: '800' },
  cardSub: { color: '#8A96A3', fontSize: 11.5, marginTop: 2, marginBottom: 10 },
  barRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 5 },
  barLabel: { width: '30%', color: '#ECEFF2', fontSize: 12.5, fontWeight: '600' },
  barTrack: { flex: 1, height: 12, justifyContent: 'center' },
  barFill: { height: 12, borderTopRightRadius: 4, borderBottomRightRadius: 4, backgroundColor: PRODUCED_COLOR },
  barValue: { minWidth: 56, textAlign: 'right', color: '#ECEFF2', fontSize: 12.5, fontWeight: '700' },

  tableHead: { flexDirection: 'row', paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: '#2C343C' },
  th: { flex: 1, color: '#8A96A3', fontSize: 11, fontWeight: '800', textAlign: 'right' },
  tr: { borderBottomWidth: 1, borderBottomColor: '#2C343C' },
  trMain: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10 },
  tdName: { color: '#ECEFF2', fontSize: 13.5, fontWeight: '700' },
  tdMeta: { color: '#8A96A3', fontSize: 11, marginTop: 2 },
  td: { flex: 1, color: '#8A96A3', fontSize: 13, textAlign: 'right' },
  detail: { paddingLeft: 20, paddingBottom: 10 },
  detailRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 5, gap: 10 },
  detailLabel: { flex: 1, color: '#ECEFF2', fontSize: 12.5 },
  detailValue: { color: '#ECEFF2', fontSize: 12.5, fontWeight: '800', minWidth: 60, textAlign: 'right' },
  detailReject: { color: '#8A96A3', fontSize: 11.5, minWidth: 60, textAlign: 'right' },

  modalOverlay: { flex: 1, backgroundColor: '#00000088', alignItems: 'center', justifyContent: 'center', padding: 20 },
  modalCard: { width: '100%', maxWidth: 720, backgroundColor: '#14181C', borderRadius: 12, maxHeight: '80%', padding: 14, borderWidth: 1, borderColor: '#2C343C' },
  modalTitle: { color: '#ECEFF2', fontSize: 18, fontWeight: '800', marginBottom: 8 },
  modalRow: { paddingVertical: 12, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, borderColor: '#2C343C', marginBottom: 8, minHeight: 48, justifyContent: 'center' },
  modalRowSelected: { borderColor: '#F2A93B', backgroundColor: '#F2A93B08' },
  modalRowText: { color: '#ECEFF2', fontSize: 14 },
  modalRowTextSelected: { color: '#F2A93B', fontWeight: '800' },
  modalFooter: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: '#2C343C' },
  modalBtn: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: '#2C343C', backgroundColor: '#1D2329' },
  modalBtnText: { color: '#ECEFF2', fontWeight: '700' },
});
