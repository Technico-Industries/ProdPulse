// src/screens/QualityOverviewScreen.tsx
//
// Quality Control MAIN dashboard — a summary of the Quality Report.
//
// ─── SOURCE OF TRUTH ─────────────────────────────────────────────────────────
// The existing Quality Report is QualityAnalysisScreen. It reads ONLY the
// `rejectionRecords` collection (written by RecordRejectionScreen), with a
// From/To range on the record's `date` string field, and computes every
// figure by summing `rejectionQty`. This dashboard does exactly the same:
//
//   one query  : rejectionRecords where date >= from && date <= to
//   total      : Σ rejectionQty                       (report "Total Rejection Qty")
//   records    : number of rejection docs             (report "Total Records")
//   groupings  : aggregateQty(records, keyFn) — the report's own helper,
//                Σ rejectionQty per key, sorted high → low
//
// No productionRecords, no production quantity, no Quality % / Rejection
// Rate — the Quality Report has no production denominator, so those
// figures aren't part of it and aren't invented here.
//
// Every section below (division → line tree, defect donut, stage,
// responsibility, part, plant/workshop, daily totals, recent entries) is
// aggregated in memory from that single result set. Expanding a division
// never touches Firestore.
//
// ─── FIELDS (RecordRejectionScreen's schema, unchanged) ──────────────────────
//   date, plant, workshop, division, lineId, lineName, partName, stage,
//   rejectionQty, defect, responsibility, remarks, reportedBy.name, createdAt
//
// Division is stamped on the record itself. RecordRejectionScreen only asks
// for (and stores) a division under the Assembly workshop, so other
// workshops' records carry division: null. The report charts those as
// "Unspecified"; here they're labelled by their workshop instead
// ("Welding Shop · no division") so the ranking stays readable — the
// grouping and totals are otherwise identical.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { useNavigation } from '@react-navigation/native';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { PieChart } from 'react-native-gifted-charts';
import { db } from '../services/firebase';
import AppDrawer from '../components/AppDrawer';
import { QUALITY_MENU_ITEMS } from '../constants/qualityMenu';
import { PLANTS } from '../constants/lineOptions';

// ─── Types (QualityAnalysisScreen's RejectionRecord, same mapping) ────────────

interface RejectionRecord {
  id: string;
  date: string | null;
  plant: string | null;
  workshop: string | null;
  division: string | null;
  lineId: string | null;
  lineName: string | null;
  partName: string | null;
  stage: string | null;
  rejectionQty: number;
  defect: string | null;
  responsibility: string | null;
  remarks: string | null;
  reportedByName: string | null;
  createdAtMs: number | null;
}

interface DateRange {
  from: string;
  to: string;
}

// Same palette QualityAnalysisScreen's charts use.
const SLICE_COLORS = ['#D64545', '#F2A93B', '#3E7CB1', '#4C9A6A', '#8A5CF5', '#E8C547', '#E0793C', '#5C6670'];
// Donut shows the top defects individually; the remainder is folded into
// one "Other defects" slice so the ring always sums to the total.
const DONUT_TOP = 7;

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

// "2026-10-05" → "05 Oct 2026", from the string's own parts (no UTC shift).
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function prettyDate(s: string): string {
  if (!isValidDateStr(s)) return s;
  const [y, m, d] = s.split('-');
  return `${d} ${MONTHS[Number(m) - 1]} ${y}`;
}

function rangeLabel(r: DateRange): string {
  return r.from === r.to ? prettyDate(r.from) : `${prettyDate(r.from)} – ${prettyDate(r.to)}`;
}

function formatInt(n: number) {
  return Math.round(n).toLocaleString();
}

function pct(part: number, whole: number) {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0;
}

// QualityAnalysisScreen's sameStr: an unset record field never excludes it.
function sameStr(a: string | null | undefined, b: string | null | undefined) {
  if (!a || !b) return true;
  return String(a).toLowerCase() === String(b).toLowerCase();
}

// QualityAnalysisScreen's aggregateQty — Σ rejectionQty per key, high → low.
// Extended only with a record count, which the report's Excel export also
// tabulates per group.
function aggregateQty(records: RejectionRecord[], keyFn: (r: RejectionRecord) => string | null) {
  const map = new Map<string, { qty: number; count: number }>();
  records.forEach((r) => {
    const key = keyFn(r) || 'Unspecified';
    const cur = map.get(key) ?? { qty: 0, count: 0 };
    cur.qty += r.rejectionQty || 0;
    cur.count += 1;
    map.set(key, cur);
  });
  return Array.from(map.entries())
    .map(([label, v]) => ({ label, qty: v.qty, count: v.count }))
    .sort((a, b) => b.qty - a.qty || a.label.localeCompare(b.label));
}

function divisionLabel(r: RejectionRecord): string {
  if (r.division && r.division.trim()) return r.division.trim();
  return r.workshop ? `${r.workshop} · no division` : 'Unspecified';
}

function lineLabel(r: RejectionRecord): string {
  return r.lineName || r.lineId || 'Unspecified line';
}

// ─── Date range modal ─────────────────────────────────────────────────────────

const PRESETS: { label: string; get: () => DateRange }[] = [
  { label: 'Today', get: () => ({ from: todayStr(), to: todayStr() }) },
  { label: 'Yesterday', get: () => ({ from: dateStrDaysAgo(1), to: dateStrDaysAgo(1) }) },
  { label: 'Last 7 days', get: () => ({ from: dateStrDaysAgo(6), to: todayStr() }) },
  // QualityAnalysisScreen's own default window.
  { label: 'Last 30 days', get: () => ({ from: dateStrDaysAgo(30), to: todayStr() }) },
];

function DateRangeModal({
  visible,
  value,
  onClose,
  onApply,
}: {
  visible: boolean;
  value: DateRange;
  onClose: () => void;
  onApply: (next: DateRange) => void;
}) {
  const [from, setFrom] = useState(value.from);
  const [to, setTo] = useState(value.to);

  useEffect(() => {
    if (visible) {
      setFrom(value.from);
      setTo(value.to);
    }
  }, [visible, value]);

  const bothValid = isValidDateStr(from) && isValidDateStr(to);
  const ordered = bothValid && from <= to;
  const hint = !bothValid
    ? 'Enter both dates as YYYY-MM-DD.'
    : !ordered
    ? '"From" date must be on or before "To" date.'
    : rangeLabel({ from, to });

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.modalScrim} onPress={onClose}>
        <Pressable style={styles.modalCard} onPress={(e) => e.stopPropagation()}>
          <Text style={styles.modalTitle}>Report Period</Text>

          <View style={styles.presetRow}>
            {PRESETS.map((p) => {
              const v = p.get();
              const active = from === v.from && to === v.to;
              return (
                <Pressable
                  key={p.label}
                  onPress={() => {
                    setFrom(v.from);
                    setTo(v.to);
                  }}
                  style={[styles.presetChip, active && styles.presetChipActive]}
                >
                  <Text style={[styles.presetChipText, active && styles.presetChipTextActive]}>{p.label}</Text>
                </Pressable>
              );
            })}
          </View>

          <View style={styles.modalFields}>
            {[
              { label: 'FROM', value: from, set: setFrom },
              { label: 'TO', value: to, set: setTo },
            ].map((f) => (
              <View key={f.label} style={{ flex: 1, gap: 6 }}>
                <Text style={styles.modalFieldLabel}>{f.label}</Text>
                <View style={styles.modalInputRow}>
                  <Ionicons name="calendar-outline" size={15} color="#5C6670" />
                  <TextInput
                    style={styles.modalInput}
                    value={f.value}
                    onChangeText={(t) => f.set(formatDateInputValue(t))}
                    placeholder="YYYY-MM-DD"
                    placeholderTextColor="#5C6670"
                    keyboardType="number-pad"
                    maxLength={10}
                  />
                </View>
              </View>
            ))}
          </View>
          <Text style={[styles.modalHint, bothValid && !ordered && { color: '#F0A8A8' }]}>{hint}</Text>

          <View style={styles.modalActions}>
            <Pressable onPress={onClose} style={[styles.modalBtn, styles.modalBtnGhost]}>
              <Text style={styles.modalBtnGhostText}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                if (ordered) onApply({ from, to });
              }}
              disabled={!ordered}
              style={[styles.modalBtn, styles.modalBtnPrimary, !ordered && styles.modalBtnDisabled]}
            >
              <Text style={styles.modalBtnPrimaryText}>Apply</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ─── Small presentational pieces ──────────────────────────────────────────────

function KpiTile({ label, value, color, width }: { label: string; value: string; color?: string; width: string }) {
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

// A compact ranked list card: label · qty · share, sorted high → low.
function RankedCard({
  title,
  rows,
  total,
  limit,
  width,
}: {
  title: string;
  rows: { label: string; qty: number; count: number }[];
  total: number;
  limit?: number;
  width: string;
}) {
  const shown = limit ? rows.slice(0, limit) : rows;
  return (
    <View style={[styles.card, { width: width as any }]}>
      <View style={styles.cardHeader}>
        <Text style={styles.cardLabel}>{title}</Text>
        {limit && rows.length > limit ? <Text style={styles.cardMeta}>Top {limit} of {rows.length}</Text> : null}
      </View>
      {shown.map((r, i) => (
        <View key={r.label} style={[styles.rankRow, i > 0 && styles.rowBorder]}>
          <Text style={styles.rankLabel} numberOfLines={1}>
            {r.label}
          </Text>
          <Text style={styles.rankShare}>{pct(r.qty, total)}%</Text>
          <Text style={styles.rankQty}>{formatInt(r.qty)}</Text>
        </View>
      ))}
    </View>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function QualityOverviewScreen() {
  const navigation = useNavigation<any>();
  const { width } = useWindowDimensions();

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [range, setRange] = useState<DateRange>({ from: todayStr(), to: todayStr() });
  // Client-side, over the fetched set — the same Plant filter the report has.
  const [plant, setPlant] = useState<string | null>(null);

  // null while loading, so a new period never shows the previous one's data.
  const [records, setRecords] = useState<RejectionRecord[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Drops a slow response for a previously selected period.
  const requestId = useRef(0);

  // The Quality Report's exact query (QualityAnalysisScreen.handleSearch).
  const fetchRange = useCallback(async (r: DateRange) => {
    const id = ++requestId.current;
    setLoading(true);
    setLoadError(null);
    setRecords(null);
    try {
      const snap = await getDocs(
        query(collection(db, 'rejectionRecords'), where('date', '>=', r.from), where('date', '<=', r.to))
      );
      if (id !== requestId.current) return;
      setRecords(
        snap.docs.map((d) => {
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
        })
      );
    } catch (e) {
      if (id !== requestId.current) return;
      console.error('[QualityOverview] rejectionRecords fetch failed', e);
      setLoadError('Unable to load quality report.');
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRange(range);
  }, [range, fetchRange]);

  const filtered = useMemo(
    () => (records ?? []).filter((r) => !plant || sameStr(r.plant, plant)),
    [records, plant]
  );

  // ── Summary — the report's own summary cards.
  const summary = useMemo(() => {
    const totalQty = filtered.reduce((s, r) => s + (r.rejectionQty || 0), 0);
    return {
      totalQty,
      totalRecords: filtered.length,
      uniqueDefects: new Set(filtered.map((r) => r.defect).filter(Boolean)).size,
      uniqueParts: new Set(filtered.map((r) => r.partName).filter(Boolean)).size,
      uniqueLines: new Set(filtered.map((r) => r.lineId ?? r.lineName).filter(Boolean)).size,
    };
  }, [filtered]);

  // ── Division → line tree, both levels high → low.
  const divisions = useMemo(() => {
    const byDiv = new Map<string, RejectionRecord[]>();
    filtered.forEach((r) => {
      const key = divisionLabel(r);
      const list = byDiv.get(key);
      if (list) list.push(r);
      else byDiv.set(key, [r]);
    });
    return Array.from(byDiv.entries())
      .map(([label, recs]) => {
        const lines = aggregateQty(recs, lineLabel).map((l) => ({
          ...l,
          parts: Array.from(
            new Set(recs.filter((r) => lineLabel(r) === l.label).map((r) => r.partName).filter(Boolean) as string[])
          ),
        }));
        return { label, qty: recs.reduce((s, r) => s + (r.rejectionQty || 0), 0), count: recs.length, lines };
      })
      .sort((a, b) => b.qty - a.qty || a.label.localeCompare(b.label));
  }, [filtered]);

  // Highest division opens by default each time the data changes.
  useEffect(() => {
    setExpanded(divisions.length ? new Set([divisions[0].label]) : new Set());
  }, [divisions]);

  const toggle = (label: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });

  // ── Defect distribution.
  const byDefect = useMemo(() => aggregateQty(filtered, (r) => r.defect), [filtered]);
  const donutSlices = useMemo(() => {
    const top = byDefect.slice(0, DONUT_TOP).map((d, i) => ({ ...d, color: SLICE_COLORS[i] }));
    const rest = byDefect.slice(DONUT_TOP);
    if (rest.length) {
      top.push({
        label: `Other defects (${rest.length} types)`,
        qty: rest.reduce((s, d) => s + d.qty, 0),
        count: rest.reduce((s, d) => s + d.count, 0),
        color: SLICE_COLORS[DONUT_TOP],
      });
    }
    return top.filter((s) => s.qty > 0);
  }, [byDefect]);

  // ── Remaining Quality Report breakdowns.
  const byStage = useMemo(() => aggregateQty(filtered, (r) => r.stage), [filtered]);
  const byResponsibility = useMemo(() => aggregateQty(filtered, (r) => r.responsibility), [filtered]);
  const byPart = useMemo(() => aggregateQty(filtered, (r) => r.partName), [filtered]);
  const byPlant = useMemo(() => aggregateQty(filtered, (r) => r.plant), [filtered]);
  const byWorkshop = useMemo(() => aggregateQty(filtered, (r) => r.workshop), [filtered]);
  const byDate = useMemo(
    () =>
      aggregateQty(filtered, (r) => r.date)
        .filter((d) => d.label !== 'Unspecified')
        .sort((a, b) => b.label.localeCompare(a.label))
        .map((d) => ({ ...d, label: prettyDate(d.label) })),
    [filtered]
  );
  const recent = useMemo(
    () => filtered.slice().sort((a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0)).slice(0, 5),
    [filtered]
  );

  // ── Responsive layout — percentage widths in wrapping rows, no overflow.
  const isWide = width >= 900;
  const kpiColumns = width >= 1100 ? 5 : width >= 700 ? 3 : 2;
  const kpiWidth = `${100 / kpiColumns - (kpiColumns === 2 ? 1.6 : 1.2)}%`;
  const infoColumns = width >= 1100 ? 3 : width >= 700 ? 2 : 1;
  const infoWidth = infoColumns === 1 ? '100%' : `${100 / infoColumns - (infoColumns === 2 ? 1.6 : 1.2)}%`;
  const donutRadius = isWide ? 104 : Math.max(78, Math.min(104, (width - 64) / 3.4));

  const isMultiDay = range.from !== range.to;
  const isEmptyPeriod = !loading && !loadError && records !== null && records.length === 0;
  const isEmptyPlant = !loading && !loadError && records !== null && records.length > 0 && filtered.length === 0;

  return (
    <View style={styles.root}>
      {/* ── Header ───────────────────────────────────────────────────── */}
      <View style={styles.header}>
        <Pressable
          onPress={() => setDrawerOpen(true)}
          hitSlop={12}
          style={({ pressed }) => [styles.hamburger, pressed && styles.pressed]}
          accessibilityRole="button"
          accessibilityLabel="Open menu"
        >
          <Ionicons name="menu" size={22} color="#ECEFF2" />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.brand}>ProdPulse</Text>
          <Text style={styles.brandSub}>Quality Report</Text>
        </View>
        <View style={styles.rolePill}>
          <Text style={styles.rolePillText}>QUALITY</Text>
        </View>
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {/* ── Period + plant ─────────────────────────────────────────── */}
        <View style={styles.block}>
          <Text style={styles.sectionLabel}>REPORT PERIOD</Text>
          <View style={styles.dateRow}>
            <Pressable
              onPress={() => setPickerOpen(true)}
              style={({ pressed }) => [styles.dateButton, pressed && styles.pressed]}
              accessibilityRole="button"
              accessibilityLabel={`Change report period, currently ${rangeLabel(range)}`}
            >
              <Ionicons name="calendar-outline" size={16} color="#4C9A6A" />
              <Text style={styles.dateButtonText}>{rangeLabel(range)}</Text>
              <Ionicons name="chevron-down" size={16} color="#8A96A3" />
            </Pressable>
            {range.from === todayStr() && range.to === todayStr() ? (
              <View style={styles.relPill}>
                <Text style={styles.relPillText}>Today</Text>
              </View>
            ) : (
              <Pressable onPress={() => setRange({ from: todayStr(), to: todayStr() })} style={styles.todayLink} hitSlop={8}>
                <Text style={styles.todayLinkText}>Jump to today</Text>
              </Pressable>
            )}
            {loading ? <ActivityIndicator size="small" color="#4C9A6A" style={{ marginLeft: 'auto' }} /> : null}
          </View>
          <View style={styles.presetRow}>
            {[null, ...PLANTS].map((p) => {
              const active = plant === p;
              return (
                <Pressable
                  key={p ?? 'all'}
                  onPress={() => setPlant(p)}
                  style={[styles.presetChip, active && styles.presetChipActive]}
                >
                  <Text style={[styles.presetChipText, active && styles.presetChipTextActive]}>{p ?? 'All plants'}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        {loading ? (
          <View style={styles.stateBlock}>
            <View style={styles.skeletonHero} />
            <View style={styles.skeletonRow}>
              <View style={styles.skeletonHalf} />
              <View style={styles.skeletonHalf} />
            </View>
            <Text style={styles.stateText}>Loading quality report…</Text>
          </View>
        ) : loadError ? (
          <View style={styles.stateCard}>
            <View style={[styles.stateIcon, { borderColor: '#D64545', backgroundColor: '#D6454522' }]}>
              <Ionicons name="cloud-offline-outline" size={30} color="#D64545" />
            </View>
            <Text style={styles.stateTitle}>Unable to load quality report.</Text>
            <Text style={styles.stateText}>Check your connection and try again.</Text>
            <Pressable
              onPress={() => fetchRange(range)}
              style={({ pressed }) => [styles.retryButton, pressed && styles.pressed]}
              accessibilityRole="button"
              accessibilityLabel="Retry"
            >
              <Ionicons name="refresh" size={16} color="#ECEFF2" />
              <Text style={styles.retryText}>Retry</Text>
            </Pressable>
          </View>
        ) : isEmptyPeriod || isEmptyPlant ? (
          <View style={styles.stateCard}>
            <View style={[styles.stateIcon, { borderColor: '#5C6670', backgroundColor: '#5C667022' }]}>
              <Ionicons name="document-text-outline" size={30} color="#8A96A3" />
            </View>
            <Text style={styles.stateTitle}>NO QUALITY DATA</Text>
            <Text style={styles.stateText}>
              {isEmptyPlant
                ? `${records?.length} rejection records exist for this period, but none for ${plant}.`
                : 'No quality/rejection records were found for the selected period.'}
            </Text>
            <Text style={styles.stateDate}>{rangeLabel(range)}</Text>
          </View>
        ) : (
          <>
            {/* ── Total rejections ─────────────────────────────────── */}
            <View style={styles.heroCard}>
              <Text style={styles.heroLabel}>TOTAL REJECTIONS</Text>
              <Text style={styles.heroValue} numberOfLines={1} adjustsFontSizeToFit>
                {formatInt(summary.totalQty)}
              </Text>
              <Text style={styles.heroUnit}>Rejected Parts</Text>
              <View style={styles.heroFooter}>
                <View style={styles.heroChip}>
                  <Ionicons name="calendar-outline" size={13} color="#8A96A3" />
                  <Text style={styles.heroChipText}>{rangeLabel(range)}</Text>
                </View>
                {plant ? (
                  <View style={[styles.heroChip, styles.heroChipScoped]}>
                    <Ionicons name="business-outline" size={13} color="#4C9A6A" />
                    <Text style={[styles.heroChipText, { color: '#4C9A6A' }]}>{plant}</Text>
                  </View>
                ) : null}
              </View>
            </View>

            {/* ── Quality Report summary KPIs ──────────────────────── */}
            <View style={styles.grid}>
              <KpiTile label="Total Rejection Qty" value={formatInt(summary.totalQty)} color="#D64545" width={kpiWidth} />
              <KpiTile label="Rejection Records" value={formatInt(summary.totalRecords)} width={kpiWidth} />
              <KpiTile label="Unique Defects" value={formatInt(summary.uniqueDefects)} width={kpiWidth} />
              <KpiTile label="Lines Affected" value={formatInt(summary.uniqueLines)} width={kpiWidth} />
              <KpiTile label="Parts Affected" value={formatInt(summary.uniqueParts)} width={kpiWidth} />
            </View>

            {/* ── Division ranking + defect donut ──────────────────── */}
            <View style={[styles.mainRow, !isWide && styles.mainRowStacked]}>
              <View style={[styles.block, isWide && { flex: 3 }]}>
                <View style={styles.blockHeader}>
                  <Text style={styles.sectionLabel}>REJECTION BY DIVISION</Text>
                  <Text style={styles.cardMeta}>High → low</Text>
                </View>
                {divisions.map((d) => {
                  const open = expanded.has(d.label);
                  const share = pct(d.qty, summary.totalQty);
                  return (
                    <View key={d.label} style={[styles.divCard, open && styles.divCardOpen]}>
                      <Pressable
                        onPress={() => toggle(d.label)}
                        style={({ pressed }) => [styles.divHeader, pressed && styles.pressed]}
                        accessibilityRole="button"
                        accessibilityState={{ expanded: open }}
                        accessibilityLabel={`${d.label}, ${d.qty} rejections. ${open ? 'Collapse' : 'Expand'}`}
                      >
                        <Ionicons name={open ? 'chevron-down' : 'chevron-forward'} size={18} color="#8A96A3" />
                        <View style={{ flex: 1 }}>
                          <Text style={styles.divName} numberOfLines={1}>
                            {d.label}
                          </Text>
                          <Text style={styles.divMeta}>
                            {d.lines.length} {d.lines.length === 1 ? 'line' : 'lines'} · {share}% of total
                          </Text>
                        </View>
                        <View style={{ alignItems: 'flex-end' }}>
                          <Text style={styles.divQty}>{formatInt(d.qty)}</Text>
                          <Text style={styles.divQtyUnit}>rejects</Text>
                        </View>
                      </Pressable>
                      <View style={styles.shareTrack}>
                        <View style={[styles.shareFill, { width: `${share}%` }]} />
                      </View>
                      {open ? (
                        <View style={styles.lineList}>
                          {d.lines.map((l, i) => (
                            <View key={l.label} style={[styles.lineRow, i > 0 && styles.rowBorder]}>
                              <View style={{ flex: 1 }}>
                                <Text style={styles.lineName} numberOfLines={1}>
                                  {l.label}
                                </Text>
                                <Text style={styles.lineSub} numberOfLines={1}>
                                  {[l.parts.join(', '), `${l.count} ${l.count === 1 ? 'entry' : 'entries'}`]
                                    .filter(Boolean)
                                    .join(' · ')}
                                </Text>
                              </View>
                              <Text style={styles.lineQty}>{formatInt(l.qty)}</Text>
                            </View>
                          ))}
                        </View>
                      ) : null}
                    </View>
                  );
                })}
              </View>

              <View style={[styles.block, isWide && { flex: 2 }]}>
                <Text style={styles.sectionLabel}>QUALITY TYPE (DEFECT) DISTRIBUTION</Text>
                <View style={[styles.card, { alignItems: 'center' }]}>
                  <PieChart
                    data={donutSlices.map((s) => ({ value: s.qty, color: s.color }))}
                    donut
                    radius={donutRadius}
                    innerRadius={donutRadius * 0.64}
                    innerCircleColor="#1D2329"
                    centerLabelComponent={() => (
                      <View style={{ alignItems: 'center' }}>
                        <Text style={styles.donutCenterValue}>{formatInt(summary.totalQty)}</Text>
                        <Text style={styles.donutCenterLabel}>REJECTS</Text>
                      </View>
                    )}
                  />
                  <View style={styles.legend}>
                    {donutSlices.map((s) => (
                      <View key={s.label} style={styles.legendRow}>
                        <View style={[styles.legendDot, { backgroundColor: s.color }]} />
                        <Text style={styles.legendText} numberOfLines={1}>
                          {s.label}
                        </Text>
                        <Text style={styles.legendShare}>{pct(s.qty, summary.totalQty)}%</Text>
                        <Text style={styles.legendValue}>{formatInt(s.qty)}</Text>
                      </View>
                    ))}
                  </View>
                </View>
              </View>
            </View>

            {/* ── Remaining Quality Report information ─────────────── */}
            <View style={styles.block}>
              <Text style={styles.sectionLabel}>MORE FROM THE QUALITY REPORT</Text>
              <View style={styles.grid}>
                <RankedCard title="BY REJECTION STAGE" rows={byStage} total={summary.totalQty} width={infoWidth} />
                <RankedCard title="BY RESPONSIBILITY" rows={byResponsibility} total={summary.totalQty} width={infoWidth} />
                <RankedCard title="TOP PARTS" rows={byPart} total={summary.totalQty} limit={5} width={infoWidth} />
                {!plant && byPlant.length > 1 ? (
                  <RankedCard title="BY PLANT" rows={byPlant} total={summary.totalQty} width={infoWidth} />
                ) : null}
                <RankedCard title="BY WORKSHOP" rows={byWorkshop} total={summary.totalQty} width={infoWidth} />
                {isMultiDay ? (
                  <RankedCard title="DAILY REJECTIONS" rows={byDate} total={summary.totalQty} limit={7} width={infoWidth} />
                ) : null}
              </View>
            </View>

            {/* ── Latest entries ───────────────────────────────────── */}
            <View style={styles.block}>
              <View style={styles.blockHeader}>
                <Text style={styles.sectionLabel}>LATEST REJECTION ENTRIES</Text>
                <Pressable onPress={() => navigation.navigate('QualityAnalysis')} hitSlop={8}>
                  <Text style={styles.todayLinkText}>Open full Quality Report ›</Text>
                </Pressable>
              </View>
              <View style={styles.card}>
                {recent.map((r, i) => (
                  <View key={r.id} style={[styles.entryRow, i > 0 && styles.rowBorder]}>
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text style={styles.entryTitle} numberOfLines={1}>
                        {r.defect || '—'} · {r.lineName || '—'}
                      </Text>
                      <Text style={styles.entryMeta} numberOfLines={2}>
                        {[
                          r.partName,
                          r.stage,
                          r.responsibility,
                          isMultiDay && r.date ? prettyDate(r.date) : null,
                          r.reportedByName ? `by ${r.reportedByName}` : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </Text>
                      {r.remarks ? (
                        <Text style={styles.entryRemarks} numberOfLines={2}>
                          "{r.remarks}"
                        </Text>
                      ) : null}
                    </View>
                    <Text style={styles.entryQty}>{formatInt(r.rejectionQty || 0)}</Text>
                  </View>
                ))}
              </View>
              <Text style={styles.footnote}>
                Line/part/stage/responsibility filters, the Pareto chart, every record and Excel export are in
                Quality Analysis (menu ☰).
              </Text>
            </View>
          </>
        )}
      </ScrollView>

      <DateRangeModal
        visible={pickerOpen}
        value={range}
        onClose={() => setPickerOpen(false)}
        onApply={(next) => {
          setPickerOpen(false);
          if (next.from !== range.from || next.to !== range.to) setRange(next);
        }}
      />

      <AppDrawer
        visible={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        items={QUALITY_MENU_ITEMS}
        dashboardSubtitle="Quality report summary"
      />
    </View>
  );
}

// ─── Styles — ProdPulse palette, same tokens as the other overviews ───────────

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
  pressed: { backgroundColor: '#242B32', borderColor: '#3A434C' },
  brand: { color: '#ECEFF2', fontSize: 19, fontWeight: '900', letterSpacing: 0.3 },
  brandSub: { color: '#8A96A3', fontSize: 12.5, marginTop: 1 },
  rolePill: {
    borderWidth: 1,
    borderColor: '#4C9A6A',
    backgroundColor: '#4C9A6A22',
    borderRadius: 20,
    paddingHorizontal: 11,
    paddingVertical: 4,
  },
  rolePillText: { color: '#4C9A6A', fontSize: 10.5, fontWeight: '900', letterSpacing: 1 },

  scroll: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 40, gap: 16 },
  sectionLabel: { color: '#5C6670', fontSize: 10.5, fontWeight: '800', letterSpacing: 1.2 },
  block: { gap: 10 },
  blockHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  footnote: { color: '#5C6670', fontSize: 11 },
  rowBorder: { borderTopWidth: 1, borderTopColor: '#2C343C' },

  // Period
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
    flexShrink: 1,
  },
  dateButtonText: { color: '#ECEFF2', fontSize: 15, fontWeight: '700', flexShrink: 1 },
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
  presetRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  presetChip: {
    borderWidth: 1,
    borderColor: '#2C343C',
    backgroundColor: '#1D2329',
    borderRadius: 16,
    paddingHorizontal: 13,
    paddingVertical: 7,
  },
  presetChipActive: { borderColor: '#4C9A6A', backgroundColor: '#4C9A6A22' },
  presetChipText: { color: '#8A96A3', fontSize: 12.5, fontWeight: '600' },
  presetChipTextActive: { color: '#4C9A6A' },

  // Hero
  heroCard: {
    backgroundColor: '#1D2329',
    borderWidth: 1,
    borderColor: '#D6454555',
    borderRadius: 14,
    paddingVertical: 26,
    paddingHorizontal: 20,
    alignItems: 'center',
  },
  heroLabel: { color: '#8A96A3', fontSize: 11.5, fontWeight: '900', letterSpacing: 1.6 },
  heroValue: {
    color: '#D64545',
    fontSize: 56,
    fontWeight: '900',
    letterSpacing: -1.5,
    marginTop: 6,
    fontVariant: ['tabular-nums'],
  },
  heroUnit: { color: '#8A96A3', fontSize: 13.5, marginTop: 2 },
  heroFooter: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 8, marginTop: 18 },
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
  heroChipScoped: { borderColor: '#4C9A6A', backgroundColor: '#4C9A6A18' },

  // KPI tiles
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
  kpiValue: { color: '#ECEFF2', fontSize: 25, fontWeight: '900', fontVariant: ['tabular-nums'], marginTop: 8 },

  // Division ranking + donut
  mainRow: { flexDirection: 'row', gap: 16, alignItems: 'flex-start' },
  mainRowStacked: { flexDirection: 'column', alignItems: 'stretch' },
  divCard: {
    backgroundColor: '#1D2329',
    borderWidth: 1,
    borderColor: '#2C343C',
    borderRadius: 12,
    overflow: 'hidden',
  },
  divCardOpen: { borderColor: '#D6454555' },
  divHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderWidth: 0,
  },
  divName: { color: '#ECEFF2', fontSize: 15, fontWeight: '900' },
  divMeta: { color: '#8A96A3', fontSize: 11.5, marginTop: 2 },
  divQty: { color: '#D64545', fontSize: 20, fontWeight: '900', fontVariant: ['tabular-nums'] },
  divQtyUnit: { color: '#5C6670', fontSize: 10, fontWeight: '700' },
  shareTrack: { height: 3, backgroundColor: '#14181C' },
  shareFill: { height: 3, backgroundColor: '#D64545' },
  lineList: { paddingHorizontal: 14, paddingLeft: 42, paddingBottom: 4, backgroundColor: '#191E23' },
  lineRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10 },
  lineName: { color: '#ECEFF2', fontSize: 13.5, fontWeight: '700' },
  lineSub: { color: '#8A96A3', fontSize: 11.5, marginTop: 1 },
  lineQty: { color: '#ECEFF2', fontSize: 15, fontWeight: '900', fontVariant: ['tabular-nums'] },

  card: {
    backgroundColor: '#1D2329',
    borderWidth: 1,
    borderColor: '#2C343C',
    borderRadius: 12,
    padding: 14,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  cardLabel: { color: '#8A96A3', fontSize: 11, fontWeight: '900', letterSpacing: 1.2 },
  cardMeta: { color: '#5C6670', fontSize: 11, fontWeight: '700' },

  donutCenterValue: { color: '#ECEFF2', fontSize: 26, fontWeight: '900', fontVariant: ['tabular-nums'] },
  donutCenterLabel: { color: '#8A96A3', fontSize: 10.5, fontWeight: '800', letterSpacing: 1.2 },
  legend: { alignSelf: 'stretch', marginTop: 16, gap: 8 },
  legendRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  legendDot: { width: 10, height: 10, borderRadius: 5 },
  legendText: { color: '#ECEFF2', fontSize: 13, flex: 1 },
  legendShare: { color: '#5C6670', fontSize: 11.5, fontWeight: '700', fontVariant: ['tabular-nums'] },
  legendValue: {
    color: '#ECEFF2',
    fontSize: 13.5,
    fontWeight: '900',
    minWidth: 40,
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },

  // Ranked cards
  rankRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8 },
  rankLabel: { color: '#ECEFF2', fontSize: 13, fontWeight: '600', flex: 1 },
  rankShare: { color: '#5C6670', fontSize: 11.5, fontWeight: '700', fontVariant: ['tabular-nums'] },
  rankQty: {
    color: '#ECEFF2',
    fontSize: 14,
    fontWeight: '900',
    minWidth: 40,
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },

  // Latest entries
  entryRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 },
  entryTitle: { color: '#ECEFF2', fontSize: 13.5, fontWeight: '800' },
  entryMeta: { color: '#8A96A3', fontSize: 11.5 },
  entryRemarks: { color: '#8A96A3', fontSize: 11.5, fontStyle: 'italic' },
  entryQty: { color: '#D64545', fontSize: 16, fontWeight: '900', fontVariant: ['tabular-nums'] },

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
  stateDate: { color: '#ECEFF2', fontSize: 14, fontWeight: '800' },
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

  // Period modal
  modalScrim: {
    flex: 1,
    backgroundColor: '#000000AA',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  modalCard: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: '#1A1F25',
    borderWidth: 1,
    borderColor: '#2C343C',
    borderRadius: 14,
    padding: 18,
    gap: 12,
  },
  modalTitle: { color: '#ECEFF2', fontSize: 16.5, fontWeight: '800' },
  modalFields: { flexDirection: 'row', gap: 10 },
  modalFieldLabel: { color: '#5C6670', fontSize: 10.5, fontWeight: '800', letterSpacing: 1.2 },
  modalInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderColor: '#2C343C',
    backgroundColor: '#14181C',
    borderRadius: 10,
    paddingHorizontal: 10,
  },
  modalInput: { flex: 1, minWidth: 0, height: 44, color: '#ECEFF2', fontSize: 14.5 },
  modalHint: { color: '#5C6670', fontSize: 12 },
  modalActions: { flexDirection: 'row', gap: 10, justifyContent: 'flex-end', marginTop: 2 },
  modalBtn: { borderRadius: 9, paddingHorizontal: 18, paddingVertical: 10 },
  modalBtnGhost: { borderWidth: 1, borderColor: '#2C343C' },
  modalBtnGhostText: { color: '#8A96A3', fontSize: 13.5, fontWeight: '700' },
  modalBtnPrimary: { backgroundColor: '#4C9A6A' },
  modalBtnPrimaryText: { color: '#0E1216', fontSize: 13.5, fontWeight: '800' },
  modalBtnDisabled: { opacity: 0.4 },
});
