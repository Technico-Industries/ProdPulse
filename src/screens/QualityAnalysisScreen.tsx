// QualityAnalysisScreen.tsx
//
// Quality Control's rejection records search. Reads ONLY the
// `rejectionRecords` collection (written by RejectionRecordScreen when a QC
// inspector logs a rejected part) — no productionRecords, no digital-vs-
// visual comparison, no charts. Pick filters, tap "Search Records", get a
// list of matching rejection cards.
//
// Read-only: this screen never writes back to Firestore.

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
  Alert,
  Animated,
  Modal,
  Dimensions,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { db } from '../services/firebase';
import { PLANTS, WORKSHOPS, DIVISIONS } from '../constants/lineOptions';
import { BarChart, LineChart, PieChart } from 'react-native-gifted-charts';
import { exportQualityToExcel } from '../utils/qualityExcelExport';

// ─── Types ──────────────────────────────────────────────────────────────────

type Line = {
  id: string;
  plant?: string | null;
  workshop?: string | null;
  division?: string | null;
  lineName?: string | null;
  parts?: { name: string }[];
};

const REJECTION_STAGES = ['Visual', 'Process', 'Dimension'] as const;
type RejectionStage = (typeof REJECTION_STAGES)[number];

const RESPONSIBILITIES = ['Stamping', 'Plating', 'Assy', 'Welding', 'BOP', 'Bolt Sticking'] as const;

interface RejectionRecord {
  id: string;
  date: string | null;
  plant: string | null;
  workshop: string | null;
  division: string | null;
  lineId: string | null;
  lineName: string | null;
  partName: string | null;
  stage: RejectionStage | null;
  rejectionQty: number;
  defect: string | null;
  responsibility: string | null;
  remarks: string | null;
  reportedByName: string | null;
  createdAtMs: number | null;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

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
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(`${s}T00:00:00`).getTime());
}

function sameStr(a: string | null | undefined, b: string | null | undefined) {
  if (!a || !b) return true; // an unset field never excludes a record
  return String(a).toLowerCase() === String(b).toLowerCase();
}

// ─── Charts — colors, layout constants, and small shared building blocks ──

const CHART_COLORS = {
  primary: '#D64545',    // this screen's own accent — rejections
  grid: '#2C343C',
  axisText: '#8A96A3',
  slices: ['#D64545', '#F2A93B', '#3E7CB1', '#4C9A6A', '#8A5CF5', '#E8C547', '#E0793C', '#5C6670'],
};

const SCREEN_WIDTH = Dimensions.get('window').width;
const CHART_WIDTH = Math.max(240, SCREEN_WIDTH - 32 - 32 - 24);

// Sums rejectionQty across records, grouped by whatever key keyFn returns —
// the one aggregation every "Rejections by X" chart in this screen needs,
// just with a different keyFn/label per dimension.
function aggregateQty(records: RejectionRecord[], keyFn: (r: RejectionRecord) => string | null) {
  const map = new Map<string, number>();
  records.forEach((r) => {
    const key = keyFn(r) || 'Unspecified';
    map.set(key, (map.get(key) ?? 0) + (r.rejectionQty || 0));
  });
  return Array.from(map.entries())
    .map(([label, qty]) => ({ label, qty }))
    .sort((a, b) => b.qty - a.qty);
}

function shortDateLabel(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return dateStr;
  return `${String(d.getDate()).padStart(2, '0')} ${d.toLocaleString('en-US', { month: 'short' })}`;
}

function ChartCard({
  title,
  subtitle,
  hasData,
  children,
}: {
  title: string;
  subtitle?: string;
  hasData: boolean;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.chartCard}>
      <Text style={styles.chartCardTitle}>{title}</Text>
      {!!subtitle && <Text style={styles.chartCardSubtitle}>{subtitle}</Text>}
      {hasData ? (
        <View style={{ marginTop: 10 }}>{children}</View>
      ) : (
        <Text style={[styles.muted, { marginTop: 10 }]}>Not enough data for this chart.</Text>
      )}
    </View>
  );
}

// Hand-rolled horizontal bar row (animated fill), used for Top Defects and
// any "by X" chart where the label is long/many-valued enough that a
// vertical bar chart's x-axis labels would overlap.
function HorizontalBarRow({ label, value, maxValue, color }: { label: string; value: number; maxValue: number; color: string }) {
  const widthAnim = useRef(new Animated.Value(0)).current;
  const pct = maxValue > 0 ? Math.max(0, Math.min(100, (value / maxValue) * 100)) : 0;

  useEffect(() => {
    Animated.timing(widthAnim, { toValue: pct, duration: 600, useNativeDriver: false }).start();
  }, [pct, widthAnim]);

  const animatedWidth = widthAnim.interpolate({ inputRange: [0, 100], outputRange: ['0%', '100%'] });

  return (
    <View style={styles.hBarRow}>
      <Text style={styles.hBarLabel} numberOfLines={1}>{label}</Text>
      <View style={styles.hBarTrack}>
        <Animated.View style={[styles.hBarFill, { width: animatedWidth, backgroundColor: color }]} />
      </View>
      <Text style={[styles.hBarValue, { color }]}>{value}</Text>
    </View>
  );
}

// ─── Searchable picker (used for Line and Part — both can have far more
// options than a chips row holds comfortably) ──────────────────────────────

function SearchablePickerBox({
  label,
  value,
  placeholder,
  options,
  onSelect,
  onClear,
  disabled,
  modalTitle,
}: {
  label: string;
  value?: string | null;
  placeholder: string;
  options: string[];
  onSelect: (value: string) => void;
  onClear: () => void;
  disabled?: boolean;
  modalTitle: string;
}) {
  const [visible, setVisible] = useState(false);
  const [q, setQ] = useState('');

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((o) => o.toLowerCase().includes(needle));
  }, [options, q]);

  function open() {
    setQ('');
    setVisible(true);
  }

  function select(opt: string) {
    onSelect(opt);
    setVisible(false);
    setQ('');
  }

  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={styles.pickerRow}>
        <Pressable onPress={open} disabled={disabled} style={[styles.pickerBox, disabled && styles.disabledInput, { flex: 1 }]}>
          <Text style={[styles.pickerBoxText, !value && styles.pickerBoxPlaceholder]} numberOfLines={1}>
            {value || placeholder}
          </Text>
          <Ionicons name="search" size={16} color="#8A96A3" />
        </Pressable>
        {!!value && (
          <Pressable onPress={onClear} style={styles.pickerClearBtn} hitSlop={8}>
            <Ionicons name="close" size={16} color="#8A96A3" />
          </Pressable>
        )}
      </View>

      <Modal visible={visible} animationType="slide" transparent onRequestClose={() => setVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{modalTitle}</Text>

            <View style={styles.searchBoxRow}>
              <Ionicons name="search" size={16} color="#8A96A3" />
              <TextInput
                style={styles.searchInput}
                value={q}
                onChangeText={setQ}
                placeholder="Type to filter…"
                placeholderTextColor="#5C6670"
                autoFocus
                autoCapitalize="none"
                autoCorrect={false}
              />
              {q.length > 0 && (
                <Pressable onPress={() => setQ('')} hitSlop={8}>
                  <Ionicons name="close-circle" size={16} color="#5C6670" />
                </Pressable>
              )}
            </View>

            <ScrollView contentContainerStyle={styles.modalScroll} keyboardShouldPersistTaps="handled">
              {filtered.length === 0 ? (
                <Text style={styles.muted}>No matches for "{q}"</Text>
              ) : (
                filtered.map((opt) => {
                  const isSelected = value === opt;
                  return (
                    <Pressable
                      key={opt}
                      onPress={() => select(opt)}
                      style={[styles.modalOptRow, isSelected && styles.modalOptRowSelected]}
                    >
                      <Text style={[styles.modalOptText, isSelected && styles.modalOptTextSelected]}>{opt}</Text>
                    </Pressable>
                  );
                })
              )}
            </ScrollView>

            <View style={styles.modalFooter}>
              <Pressable onPress={() => setVisible(false)} style={styles.modalBtn}>
                <Text style={styles.modalBtnText}>Close</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

// ─── Component ────────────────────────────────────────────────────────────

export default function QualityAnalysisScreen() {
  const navigation = useNavigation<any>();

  // ── Filters
  const [fromDate, setFromDate] = useState(dateStrDaysAgo(30));
  const [toDate, setToDate] = useState(todayStr());
  const [plant, setPlant] = useState<string | null>(null);
  const [workshop, setWorkshop] = useState<string | null>(null);
  const [division, setDivision] = useState<string | null>(null);
  const [selectedLineId, setSelectedLineId] = useState<string | null>(null);
  const [selectedPart, setSelectedPart] = useState<string | null>(null);
  const [stage, setStage] = useState<RejectionStage | null>(null);
  const [responsibility, setResponsibility] = useState<string | null>(null);

  // ── Lines (for the Line/Part pickers) — same productionLines collection
  // and field-fallback shape RecordRejectionScreen reads, loaded once and
  // filtered client-side as plant/workshop/division change.
  const [allLines, setAllLines] = useState<Line[]>([]);
  const [loadingLines, setLoadingLines] = useState(true);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        setLoadingLines(true);
        const snap = await getDocs(collection(db, 'productionLines'));
        const docs: Line[] = snap.docs.map((d) => {
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
            parts: partsArray.map((p: any) => ({ name: p.name ?? p.partName ?? '' })),
          };
        });
        if (mounted) setAllLines(docs);
      } catch (e) {
        console.error('[QualityAnalysis] load lines', e);
      } finally {
        if (mounted) setLoadingLines(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

  const filteredLines = useMemo(() => {
    return allLines.filter((l) => {
      if (plant && l.plant && String(l.plant).toLowerCase() !== String(plant).toLowerCase()) return false;
      if (workshop && l.workshop && !String(l.workshop).toLowerCase().includes(String(workshop).toLowerCase())) return false;
      if (division && l.division && !String(l.division).toLowerCase().includes(String(division).toLowerCase())) return false;
      return true;
    });
  }, [allLines, plant, workshop, division]);

  const lineOptions = useMemo(() => filteredLines.map((l) => l.lineName || l.id).filter(Boolean) as string[], [filteredLines]);
  const selectedLine = filteredLines.find((l) => l.id === selectedLineId) ?? null;

  // Part options are independent of the selected line — the union of every
  // part name across the plant/workshop/division-filtered lines — so
  // filtering by Part alone (e.g. "every rejection of Bracket-X, any line")
  // works without first having to pick one specific line.
  const partOptions = useMemo(() => {
    const set = new Set<string>();
    filteredLines.forEach((l) => (l.parts ?? []).forEach((p) => { if (p.name) set.add(p.name); }));
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [filteredLines]);

  function selectLine(name: string) {
    const found = filteredLines.find((l) => (l.lineName || l.id) === name);
    setSelectedLineId(found?.id ?? null);
  }

  // ── Data
  const [records, setRecords] = useState<RejectionRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [exportingExcel, setExportingExcel] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);

  async function handleSearch() {
    if (!isValidDateStr(fromDate) || !isValidDateStr(toDate)) {
      setLoadError('Enter both dates as YYYY-MM-DD.');
      return;
    }
    if (fromDate > toDate) {
      setLoadError('"From" date must be on or before "To" date.');
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const snap = await getDocs(query(
        collection(db, 'rejectionRecords'),
        where('date', '>=', fromDate),
        where('date', '<=', toDate),
      ));

      const all: RejectionRecord[] = snap.docs.map((d) => {
        const data: any = d.data();
        return {
          id: d.id,
          date: data.date ?? null,
          plant: data.plant ?? null,
          workshop: data.workshop ?? null,
          division: data.division ?? null,
          lineId: data.lineId ?? null,
          lineName: data.lineName ?? null,
          partName: data.partName ?? null,
          stage: data.stage ?? null,
          rejectionQty: data.rejectionQty ?? 0,
          defect: data.defect ?? null,
          responsibility: data.responsibility ?? null,
          remarks: data.remarks ?? null,
          reportedByName: data.submittedBy?.name ?? data.reportedBy?.name ?? null,
          createdAtMs: data.createdAt?.toMillis ? data.createdAt.toMillis() : null,
        };
      });

      console.log('[QualityAnalysis] fetched', all.length, 'rejection records for', fromDate, 'to', toDate);
      setRecords(all);
      setHasSearched(true);
    } catch (e) {
      console.error('[QualityAnalysis] fetch failed', e);
      setLoadError('Could not load rejection records. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }

  async function handleExportExcel() {
    if (exportingExcel) return;
    setExportingExcel(true);
    try {
      await exportQualityToExcel({
        records: filteredRecords,
        paretoRows: paretoData.map((row, index) => ({
          defect: row.label,
          rejectionQty: row.qty,
          cumulativePercentage: row.cumulativePct,
          rank: index + 1,
        })),
        filters: {
          fromDate,
          toDate,
          plant,
          workshop,
          division,
          line: selectedLineId ? allLines.find((line) => line.id === selectedLineId)?.lineName ?? selectedLineId : null,
          part: selectedPart,
          stage,
          responsibility,
        },
      });
      Alert.alert(
        'Export complete',
        Platform.OS === 'web' ? 'The Excel file has downloaded.' : 'Choose where to save or send the Excel file.',
      );
    } catch (error) {
      console.error('[QualityAnalysis] excel export', error);
      Alert.alert('Export failed', 'Could not generate the Excel file. Please try again.');
    } finally {
      setExportingExcel(false);
    }
  }

  const filteredRecords = useMemo(() => {
    return records.filter((r) => {
      if (plant && !sameStr(r.plant, plant)) return false;
      if (workshop && !sameStr(r.workshop, workshop)) return false;
      if (division && !sameStr(r.division, division)) return false;
      if (selectedLineId && r.lineId !== selectedLineId) return false;
      if (selectedPart && !sameStr(r.partName, selectedPart)) return false;
      if (stage && r.stage !== stage) return false;
      if (responsibility && !sameStr(r.responsibility, responsibility)) return false;
      return true;
    });
  }, [records, plant, workshop, division, selectedLineId, selectedPart, stage, responsibility]);

  const sortedRecords = useMemo(
    () => filteredRecords.slice().sort((a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0)),
    [filteredRecords]
  );

  // ── Graphical Analysis — hidden until the button is pressed, and every
  // chart below is built from filteredRecords, so it always reflects
  // whatever filters are currently active, not the raw fetch.
  const [showGraphs, setShowGraphs] = useState(false);

  const summary = useMemo(() => {
    const totalQty = filteredRecords.reduce((s, r) => s + (r.rejectionQty || 0), 0);
    const uniqueDefects = new Set(filteredRecords.map((r) => r.defect).filter(Boolean)).size;
    const uniqueParts = new Set(filteredRecords.map((r) => r.partName).filter(Boolean)).size;
    const uniqueLines = new Set(filteredRecords.map((r) => r.lineId ?? r.lineName).filter(Boolean)).size;
    return { totalRecords: filteredRecords.length, totalQty, uniqueDefects, uniqueParts, uniqueLines };
  }, [filteredRecords]);

  // Rejection Trend — total qty per day
  const trendByDate = useMemo(() => {
    const map = new Map<string, number>();
    filteredRecords.forEach((r) => {
      if (!r.date) return;
      map.set(r.date, (map.get(r.date) ?? 0) + (r.rejectionQty || 0));
    });
    return Array.from(map.entries())
      .map(([dateKey, qty]) => ({ dateKey, dateLabel: shortDateLabel(dateKey), qty }))
      .sort((a, b) => a.dateKey.localeCompare(b.dateKey));
  }, [filteredRecords]);

  const byPlant = useMemo(() => aggregateQty(filteredRecords, (r) => r.plant), [filteredRecords]);
  const byWorkshop = useMemo(() => aggregateQty(filteredRecords, (r) => r.workshop), [filteredRecords]);
  const byDivision = useMemo(() => aggregateQty(filteredRecords, (r) => r.division), [filteredRecords]);
  const byLine = useMemo(() => aggregateQty(filteredRecords, (r) => r.lineName), [filteredRecords]);
  const byPart = useMemo(() => aggregateQty(filteredRecords, (r) => r.partName), [filteredRecords]);
  const byStage = useMemo(() => aggregateQty(filteredRecords, (r) => r.stage), [filteredRecords]);
  const byResponsibility = useMemo(() => aggregateQty(filteredRecords, (r) => r.responsibility), [filteredRecords]);

  // Top Defects — capped to the top 10 so the horizontal-bar list and the
  // donut both stay readable even with dozens of distinct defect codes.
  const byDefectAll = useMemo(() => aggregateQty(filteredRecords, (r) => r.defect), [filteredRecords]);
  const topDefects = useMemo(() => byDefectAll.slice(0, 10), [byDefectAll]);

  // Pareto — same top-10 defects, plus a running cumulative % of the total
  // across ALL defects (not just the top 10), the classic Pareto definition.
  const paretoData = useMemo(() => {
    const grandTotal = byDefectAll.reduce((s, d) => s + d.qty, 0);
    let running = 0;
    return topDefects.map((d) => {
      running += d.qty;
      return { ...d, cumulativePct: grandTotal > 0 ? Math.round((running / grandTotal) * 1000) / 10 : 0 };
    });
  }, [topDefects, byDefectAll]);

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <Pressable onPress={() => navigation.goBack()} style={styles.backButton} hitSlop={12}>
          <Ionicons name="arrow-back" size={22} color="#8A96A3" />
          <Text style={styles.backText}>Back</Text>
        </Pressable>

        <Text style={styles.title}>Quality Analysis</Text>
        <Text style={styles.subtitle}>Search logged rejection records</Text>

        <Text style={styles.sectionLabel}>FILTERS</Text>

        <View style={styles.rowGap}>
          <View style={[styles.field, { flex: 1 }]}>
            <Text style={styles.fieldLabel}>FROM DATE</Text>
            <TextInput
              style={styles.input}
              value={fromDate}
              onChangeText={setFromDate}
              placeholder="YYYY-MM-DD"
              placeholderTextColor="#5C6670"
            />
          </View>
          <View style={[styles.field, { flex: 1 }]}>
            <Text style={styles.fieldLabel}>TO DATE</Text>
            <TextInput
              style={styles.input}
              value={toDate}
              onChangeText={setToDate}
              placeholder="YYYY-MM-DD"
              placeholderTextColor="#5C6670"
            />
          </View>
        </View>

        <View style={styles.field}>
          <Text style={styles.fieldLabel}>PLANT</Text>
          <View style={styles.chipsRow}>
            {PLANTS.map((p) => {
              const selected = plant === p;
              return (
                <Pressable
                  key={p}
                  onPress={() => { setPlant(selected ? null : p); setSelectedLineId(null); }}
                  style={[styles.chip, selected && styles.chipSelected]}
                >
                  <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{p}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        <View style={styles.field}>
          <Text style={styles.fieldLabel}>WORKSHOP</Text>
          <View style={styles.chipsRow}>
            {WORKSHOPS.map((w) => {
              const selected = workshop === w;
              return (
                <Pressable
                  key={w}
                  onPress={() => { setWorkshop(selected ? null : w); setSelectedLineId(null); }}
                  style={[styles.chip, selected && styles.chipSelected]}
                >
                  <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{w}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        <View style={styles.field}>
          <Text style={styles.fieldLabel}>DIVISION</Text>
          <View style={styles.chipsRow}>
            {DIVISIONS.map((dv) => {
              const selected = division === dv;
              return (
                <Pressable
                  key={dv}
                  onPress={() => { setDivision(selected ? null : dv); setSelectedLineId(null); }}
                  style={[styles.chip, selected && styles.chipSelected]}
                >
                  <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{dv}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        <SearchablePickerBox
          label="LINE"
          value={selectedLine?.lineName || selectedLine?.id || null}
          placeholder={loadingLines ? 'Loading lines…' : 'Any line'}
          options={lineOptions}
          onSelect={selectLine}
          onClear={() => setSelectedLineId(null)}
          disabled={loadingLines}
          modalTitle="Select Line"
        />

        <SearchablePickerBox
          label="PART"
          value={selectedPart}
          placeholder="Any part"
          options={partOptions}
          onSelect={setSelectedPart}
          onClear={() => setSelectedPart(null)}
          disabled={loadingLines}
          modalTitle="Select Part"
        />

        <View style={styles.field}>
          <Text style={styles.fieldLabel}>REJECTION STAGE</Text>
          <View style={styles.chipsRow}>
            {REJECTION_STAGES.map((s) => {
              const selected = stage === s;
              return (
                <Pressable key={s} onPress={() => setStage(selected ? null : s)} style={[styles.chip, selected && styles.chipSelected]}>
                  <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{s}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        <View style={styles.field}>
          <Text style={styles.fieldLabel}>RESPONSIBILITY</Text>
          <View style={styles.chipsRow}>
            {RESPONSIBILITIES.map((r) => {
              const selected = responsibility === r;
              return (
                <Pressable key={r} onPress={() => setResponsibility(selected ? null : r)} style={[styles.chip, selected && styles.chipSelected]}>
                  <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{r}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        {loadError && <Text style={[styles.errorText, { marginBottom: 12 }]}>{loadError}</Text>}

        <Pressable
          style={({ pressed }) => [styles.analyzeButton, (loading || pressed) && styles.analyzeButtonPressed]}
          onPress={handleSearch}
          disabled={loading}
        >
          {loading ? (
            <ActivityIndicator color="#14181C" />
          ) : (
            <>
              <Ionicons name="search" size={18} color="#14181C" />
              <Text style={styles.analyzeButtonText}>Search Records</Text>
            </>
          )}
        </Pressable>

        {hasSearched && !loadError && (
          <>
            <Pressable
              style={({ pressed }) => [styles.graphsToggle, pressed && { opacity: 0.85 }]}
              onPress={() => setShowGraphs((v) => !v)}
            >
              <Text style={styles.graphsToggleText}>📊 Graphical Analysis</Text>
              <Ionicons name={showGraphs ? 'chevron-up' : 'chevron-down'} size={18} color="#F2A93B" />
            </Pressable>
            <Pressable
              onPress={handleExportExcel}
              disabled={exportingExcel}
              style={[styles.excelButton, exportingExcel && styles.excelButtonDisabled]}
            >
              {exportingExcel ? (
                <ActivityIndicator size="small" color="#4C9A6A" />
              ) : (
                <Ionicons name="grid-outline" size={16} color="#4C9A6A" />
              )}
              <Text style={styles.excelButtonText}>{exportingExcel ? 'Exporting…' : 'Export Excel'}</Text>
            </Pressable>
          </>
        )}

        {hasSearched && showGraphs && !loadError && (
          filteredRecords.length === 0 ? (
            <View style={styles.centered}>
              <Ionicons name="stats-chart-outline" size={26} color="#5C6670" />
              <Text style={styles.emptyText}>No rejection records match these filters.</Text>
            </View>
          ) : (
            <>
              {/* Summary cards */}
              <View style={styles.summaryGrid}>
                <View style={styles.summaryCard}>
                  <Text style={styles.summaryValue}>{summary.totalRecords}</Text>
                  <Text style={styles.summaryLabel}>Total Records</Text>
                </View>
                <View style={styles.summaryCard}>
                  <Text style={[styles.summaryValue, { color: CHART_COLORS.primary }]}>{summary.totalQty}</Text>
                  <Text style={styles.summaryLabel}>Total Rejection Qty</Text>
                </View>
                <View style={styles.summaryCard}>
                  <Text style={styles.summaryValue}>{summary.uniqueDefects}</Text>
                  <Text style={styles.summaryLabel}>Unique Defects</Text>
                </View>
                <View style={styles.summaryCard}>
                  <Text style={styles.summaryValue}>{summary.uniqueParts}</Text>
                  <Text style={styles.summaryLabel}>Unique Parts</Text>
                </View>
                <View style={styles.summaryCard}>
                  <Text style={styles.summaryValue}>{summary.uniqueLines}</Text>
                  <Text style={styles.summaryLabel}>Unique Lines</Text>
                </View>
              </View>

              {/* Rejection Trend */}
              <ChartCard title="Rejection Trend" subtitle="Total rejection quantity over time" hasData={trendByDate.length > 0}>
                <LineChart
                  data={trendByDate.map((d) => ({ value: d.qty, label: d.dateLabel, labelTextStyle: { color: CHART_COLORS.axisText, fontSize: 9 } }))}
                  color={CHART_COLORS.primary}
                  dataPointsColor={CHART_COLORS.primary}
                  width={CHART_WIDTH}
                  height={200}
                  noOfSections={4}
                  yAxisTextStyle={{ color: CHART_COLORS.axisText, fontSize: 10 }}
                  xAxisLabelTextStyle={{ color: CHART_COLORS.axisText, fontSize: 9 }}
                  xAxisColor={CHART_COLORS.grid}
                  yAxisColor={CHART_COLORS.grid}
                  rulesColor={CHART_COLORS.grid}
                  rulesType="dashed"
                  isAnimated
                  animationDuration={700}
                  curved
                  thickness={2}
                  areaChart
                  startFillColor={CHART_COLORS.primary}
                  startOpacity={0.15}
                  endOpacity={0.02}
                />
              </ChartCard>

              {/* Rejections by Plant / Workshop / Division */}
              {([
                { title: 'Rejections by Plant', data: byPlant },
                { title: 'Rejections by Workshop', data: byWorkshop },
                { title: 'Rejections by Division', data: byDivision },
                { title: 'Rejections by Stage', data: byStage },
                { title: 'Rejections by Responsibility', data: byResponsibility },
              ] as const).map(({ title, data }) => (
                <ChartCard key={title} title={title} hasData={data.length > 0}>
                  <BarChart
                    data={data.map((d) => ({ value: d.qty, label: d.label, labelTextStyle: { color: CHART_COLORS.axisText, fontSize: 9 }, frontColor: CHART_COLORS.primary }))}
                    width={CHART_WIDTH}
                    height={200}
                    barWidth={22}
                    spacing={18}
                    initialSpacing={12}
                    endSpacing={12}
                    noOfSections={4}
                    yAxisTextStyle={{ color: CHART_COLORS.axisText, fontSize: 10 }}
                    xAxisLabelTextStyle={{ color: CHART_COLORS.axisText, fontSize: 9 }}
                    xAxisColor={CHART_COLORS.grid}
                    yAxisColor={CHART_COLORS.grid}
                    rulesColor={CHART_COLORS.grid}
                    rulesType="dashed"
                    isAnimated
                    animationDuration={700}
                  />
                </ChartCard>
              ))}

              {/* Rejections by Line / Part — horizontal, capped to top 12 (can have many distinct values) */}
              {([
                { title: 'Rejections by Line', data: byLine.slice(0, 12), capped: byLine.length > 12 },
                { title: 'Rejections by Part', data: byPart.slice(0, 12), capped: byPart.length > 12 },
              ] as const).map(({ title, data, capped }) => {
                const maxVal = Math.max(1, ...data.map((d) => d.qty));
                return (
                  <ChartCard key={title} title={title} subtitle={capped ? 'Top 12 shown' : undefined} hasData={data.length > 0}>
                    <View style={{ width: '100%' }}>
                      {data.map((d) => (
                        <HorizontalBarRow key={d.label} label={d.label} value={d.qty} maxValue={maxVal} color={CHART_COLORS.primary} />
                      ))}
                    </View>
                  </ChartCard>
                );
              })}

              {/* Top Defects (Bar) */}
              <ChartCard title="Top Defects" subtitle="Highest rejection quantity by defect code" hasData={topDefects.length > 0}>
                <View style={{ width: '100%' }}>
                  {topDefects.map((d) => (
                    <HorizontalBarRow
                      key={d.label}
                      label={d.label}
                      value={d.qty}
                      maxValue={Math.max(1, ...topDefects.map((x) => x.qty))}
                      color={CHART_COLORS.primary}
                    />
                  ))}
                </View>
              </ChartCard>

              {/* Defect Distribution (Donut) */}
              <ChartCard title="Defect Distribution" subtitle="Share of total rejections by defect" hasData={topDefects.length > 0}>
                <View style={styles.donutRow}>
                  <PieChart
                    data={topDefects.map((d, i) => ({ value: d.qty, color: CHART_COLORS.slices[i % CHART_COLORS.slices.length], text: '' }))}
                    donut
                    radius={72}
                    innerRadius={44}
                    innerCircleColor="#14181C"
                    centerLabelComponent={() => (
                      <View style={{ alignItems: 'center' }}>
                        <Text style={styles.donutCenterValue}>{topDefects.reduce((s, d) => s + d.qty, 0)}</Text>
                        <Text style={styles.donutCenterLabel}>rejected</Text>
                      </View>
                    )}
                  />
                  <View style={styles.donutLegend}>
                    {topDefects.map((d, i) => (
                      <View key={d.label} style={styles.donutLegendRow}>
                        <View style={[styles.donutLegendDot, { backgroundColor: CHART_COLORS.slices[i % CHART_COLORS.slices.length] }]} />
                        <Text style={styles.donutLegendText} numberOfLines={1}>{d.label}</Text>
                        <Text style={styles.donutLegendValue}>{d.qty}</Text>
                      </View>
                    ))}
                  </View>
                </View>
              </ChartCard>

              {/* Pareto (Top Defects) — bars = qty, line = cumulative % (scaled onto the bar
                  axis for visibility; point labels always show the real percentage) */}
              <ChartCard title="Pareto — Top Defects" subtitle="Defect quantity with cumulative % (line, scaled for visibility)" hasData={paretoData.length > 0}>
                <BarChart
                  data={paretoData.map((d) => ({ value: d.qty, label: d.label, labelTextStyle: { color: CHART_COLORS.axisText, fontSize: 9 }, frontColor: CHART_COLORS.primary }))}
                  lineData={paretoData.map((d) => ({
                    value: Math.max(1, ...paretoData.map((x) => x.qty)) * (d.cumulativePct / 100),
                    dataPointText: `${d.cumulativePct}%`,
                    textColor: '#F2A93B',
                    textFontSize: 10,
                    textShiftY: -14,
                  }))}
                  showLine
                  lineConfig={{ color: '#F2A93B', thickness: 2, curved: true, dataPointsColor: '#F2A93B', dataPointsRadius: 4 }}
                  width={CHART_WIDTH}
                  height={200}
                  barWidth={22}
                  spacing={18}
                  initialSpacing={12}
                  endSpacing={12}
                  noOfSections={4}
                  yAxisTextStyle={{ color: CHART_COLORS.axisText, fontSize: 10 }}
                  xAxisLabelTextStyle={{ color: CHART_COLORS.axisText, fontSize: 9 }}
                  xAxisColor={CHART_COLORS.grid}
                  yAxisColor={CHART_COLORS.grid}
                  rulesColor={CHART_COLORS.grid}
                  rulesType="dashed"
                  isAnimated
                  animationDuration={700}
                />
              </ChartCard>
            </>
          )
        )}

        {hasSearched && (
          <>
            <Text style={[styles.sectionLabel, { marginTop: 22 }]}>
              RECORDS ({sortedRecords.length})
            </Text>

            {sortedRecords.length === 0 ? (
              <View style={styles.centered}>
                <Ionicons name="document-text-outline" size={26} color="#5C6670" />
                <Text style={styles.emptyText}>No rejection records match these filters.</Text>
              </View>
            ) : (
              sortedRecords.map((r) => (
                <View key={r.id} style={styles.recordCard}>
                  <View style={styles.recordTopRow}>
                    <Text style={styles.recordLine} numberOfLines={1}>{r.lineName || 'Unnamed line'}</Text>
                    <View style={styles.stageBadge}>
                      <Text style={styles.stageBadgeText}>{r.stage || '—'}</Text>
                    </View>
                  </View>

                  <Text style={styles.recordMeta}>{r.date || 'No date'}</Text>
                  <Text style={styles.recordMeta}>
                    {[r.plant, r.workshop, r.division].filter(Boolean).join(' · ') || 'No location'}
                  </Text>
                  <Text style={styles.recordMeta}>Part: {r.partName || '—'}</Text>

                  <View style={styles.recordDetailRow}>
                    <Text style={styles.recordDefect} numberOfLines={1}>{r.defect || 'Unspecified defect'}</Text>
                    <Text style={styles.recordQty}>{r.rejectionQty} pcs</Text>
                  </View>

                  <Text style={styles.recordMeta}>Responsibility: {r.responsibility || '—'}</Text>
                  {!!r.remarks && <Text style={styles.recordRemarks}>"{r.remarks}"</Text>}
                  {!!r.reportedByName && <Text style={styles.recordMeta}>Reported by {r.reportedByName}</Text>}
                </View>
              ))
            )}
          </>
        )}

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Styles — same dark theme/tokens used across the app ──────────────────

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#14181C' },
  scroll: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 40 },
  centered: { alignItems: 'center', justifyContent: 'center', gap: 10, paddingVertical: 30 },
  backButton: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 12 },
  backText: { color: '#8A96A3', fontSize: 15 },
  title: { color: '#ECEFF2', fontSize: 23, fontWeight: '800' },
  subtitle: { color: '#8A96A3', fontSize: 13, marginTop: 4, marginBottom: 20, lineHeight: 18 },
  sectionLabel: { color: '#F2A93B', fontSize: 11.5, fontWeight: '800', letterSpacing: 1.4, marginBottom: 10, marginTop: 6 },
  fieldLabel: { color: '#8A96A3', fontSize: 11, fontWeight: '700', letterSpacing: 0.8, marginBottom: 6 },
  field: { marginBottom: 14 },
  rowGap: { flexDirection: 'row', gap: 12, marginBottom: 14 },
  input: {
    backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C',
    borderRadius: 10, paddingHorizontal: 12, color: '#ECEFF2', fontSize: 14.5, height: 48,
  },
  chipsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderColor: '#2C343C', backgroundColor: '#1D2329', borderRadius: 20, paddingHorizontal: 14, paddingVertical: 9 },
  chipSelected: { borderColor: '#F2A93B', backgroundColor: '#F2A93B22' },
  chipText: { color: '#8A96A3', fontSize: 13, fontWeight: '600' },
  chipTextSelected: { color: '#F2A93B' },
  muted: { color: '#8A96A3', fontSize: 12 },
  errorText: { color: '#F0A8A8', fontSize: 13.5, textAlign: 'center' },
  emptyText: { color: '#5C6670', fontSize: 14, textAlign: 'center' },
  disabledInput: { opacity: 0.5, backgroundColor: '#14181C' },

  pickerRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  pickerBox: {
    backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C', borderRadius: 10,
    paddingHorizontal: 12, height: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  pickerBoxText: { color: '#ECEFF2', fontSize: 15, flex: 1, marginRight: 8 },
  pickerBoxPlaceholder: { color: '#5C6670' },
  pickerClearBtn: {
    width: 40, height: 48, borderRadius: 10, borderWidth: 1, borderColor: '#2C343C',
    backgroundColor: '#1D2329', alignItems: 'center', justifyContent: 'center',
  },

  modalOverlay: { flex: 1, backgroundColor: '#00000088', alignItems: 'center', justifyContent: 'center', padding: 20 },
  modalCard: { width: '100%', maxWidth: 720, backgroundColor: '#14181C', borderRadius: 12, maxHeight: '80%', padding: 14, borderWidth: 1, borderColor: '#2C343C' },
  modalScroll: { paddingBottom: 12 },
  modalTitle: { color: '#ECEFF2', fontSize: 18, fontWeight: '800', marginBottom: 8 },
  searchBoxRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C', borderRadius: 10,
    paddingHorizontal: 12, height: 44, marginBottom: 10,
  },
  searchInput: { flex: 1, color: '#ECEFF2', fontSize: 14, height: '100%' },
  modalOptRow: { paddingVertical: 12, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, borderColor: '#2C343C', marginBottom: 8, minHeight: 48, justifyContent: 'center' },
  modalOptRowSelected: { borderColor: '#F2A93B', backgroundColor: '#F2A93B08' },
  modalOptText: { color: '#ECEFF2', fontSize: 14 },
  modalOptTextSelected: { color: '#F2A93B', fontWeight: '800' },
  modalFooter: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: '#2C343C' },
  modalBtn: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: '#2C343C', backgroundColor: '#1D2329' },
  modalBtnText: { color: '#ECEFF2', fontWeight: '700' },

  analyzeButton: { height: 56, borderRadius: 12, backgroundColor: '#F2A93B', alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 10, marginTop: 4 },
  analyzeButtonPressed: { opacity: 0.85 },
  analyzeButtonText: { color: '#14181C', fontSize: 16, fontWeight: '900' },

  // ── Rejection record cards
  recordCard: {
    backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C', borderRadius: 10,
    padding: 14, marginBottom: 10,
  },
  recordTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  recordLine: { color: '#ECEFF2', fontSize: 14.5, fontWeight: '800', flex: 1, marginRight: 8 },
  stageBadge: { borderWidth: 1, borderColor: '#3E7CB1', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  stageBadgeText: { color: '#3E7CB1', fontSize: 10.5, fontWeight: '800' },
  recordMeta: { color: '#8A96A3', fontSize: 11.5, marginTop: 2 },
  recordDetailRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 6 },
  recordDefect: { color: '#ECEFF2', fontSize: 14, fontWeight: '700', flex: 1, marginRight: 8 },
  recordQty: { color: '#D64545', fontSize: 14, fontWeight: '800' },
  recordRemarks: { color: '#8A96A3', fontSize: 12, fontStyle: 'italic', marginTop: 6 },

  // ── Graphical Analysis
  graphsToggle: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    height: 50, borderRadius: 12, borderWidth: 1, borderColor: '#F2A93B',
    backgroundColor: '#F2A93B15', marginTop: 14,
  },
  graphsToggleText: { color: '#F2A93B', fontSize: 15, fontWeight: '800' },
  excelButton: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
    minHeight: 42, borderWidth: 1, borderColor: '#4C9A6A', borderRadius: 10,
    paddingHorizontal: 14, marginTop: 8,
  },
  excelButtonDisabled: { opacity: 0.5 },
  excelButtonText: { color: '#4C9A6A', fontWeight: '700', fontSize: 13 },

  summaryGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 18 },
  summaryCard: {
    flexGrow: 1, minWidth: '30%', backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C',
    borderRadius: 10, paddingVertical: 14, alignItems: 'center', gap: 4,
  },
  summaryValue: { color: '#ECEFF2', fontSize: 18, fontWeight: '800' },
  summaryLabel: { color: '#8A96A3', fontSize: 11, fontWeight: '700', textAlign: 'center' },

  chartCard: {
    backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C',
    borderRadius: 12, padding: 14, marginTop: 14,
  },
  chartCardTitle: { color: '#ECEFF2', fontSize: 15, fontWeight: '800' },
  chartCardSubtitle: { color: '#8A96A3', fontSize: 11.5, marginTop: 2 },

  hBarRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  hBarLabel: { color: '#ECEFF2', fontSize: 12, width: 90 },
  hBarTrack: { flex: 1, height: 10, borderRadius: 5, backgroundColor: '#2C343C', overflow: 'hidden' },
  hBarFill: { height: '100%', borderRadius: 5 },
  hBarValue: { fontSize: 12, fontWeight: '800', width: 40, textAlign: 'right' },

  donutRow: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  donutCenterValue: { color: '#ECEFF2', fontSize: 16, fontWeight: '900' },
  donutCenterLabel: { color: '#8A96A3', fontSize: 10 },
  donutLegend: { flex: 1, gap: 6 },
  donutLegendRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  donutLegendDot: { width: 9, height: 9, borderRadius: 5 },
  donutLegendText: { color: '#ECEFF2', fontSize: 12, flex: 1 },
  donutLegendValue: { color: '#8A96A3', fontSize: 12, fontWeight: '700' },
});