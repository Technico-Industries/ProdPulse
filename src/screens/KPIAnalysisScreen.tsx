// src/screens/KPIAnalysisScreen.tsx
//
// Admin picks Plant / Workshop / Division + a date range + ONE KPI, then taps
// "Show Report" to see it rendered on this same screen.
//
// Rejection % Tracker and Loss Details are computed live from the
// `productionRecords` collection written by RecordProductionScreen.
// Every other KPI — Attendance Sheet (attendanceRecords), Man-Days
// (manDaysRecords), Near-Miss (nearMissReports), Poka Yoke
// (pokaYokeRecords), Plan vs Actual (planVsActualRecords), Rework %
// (reworkRecords), Kaizen (kaizenRecords), and PCS Man Per Hour
// (pcsManHourRecords, written by PCSPerHourScreen's "Push to Database") —
// has its own real Firestore collection, and is fetched/rendered inline on
// this screen exactly as submitted. This screen does not recompute PCS Man
// Hour itself; it just reads what PCSPerHourScreen already pushed.

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
  Dimensions,
  Animated,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { collection, getDocs, query, where, orderBy, Timestamp } from 'firebase/firestore';
import { db } from '../services/firebase';
import { PLANTS, WORKSHOPS, DIVISIONS } from '../constants/lineOptions';
// Charting: react-native-gifted-charts (peer dep: react-native-svg). If these
// aren't installed yet: `npx expo install react-native-gifted-charts react-native-svg`
// (or the plain npm/yarn equivalent for a bare RN project).
import { BarChart, LineChart, PieChart } from 'react-native-gifted-charts';
// npm install xlsx-js-style (same fork used by reportExcelExport.ts) &&
// npx expo install expo-file-system expo-sharing
import { exportKpiAnalysisToExcel } from '../utils/kpiExcelExport';

// ─── Types ────────────────────────────────────────────────────────────────────

type IconName = keyof typeof Ionicons.glyphMap;

interface KpiOption {
  key: string;
  title: string;
  icon: IconName;
  accent: string;
  computable: boolean; // has a real data source wired up below
}

interface StopEventRecord {
  reason: string;
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
  // The part running on this slot/segment (see RecordProductionScreen's
  // `partName` field) — used to break rejections down by part.
  partName: string | null;
  // The shift's production-day key (handles Shift B rolling past midnight —
  // see RecordProductionScreen). Used to group records by day for the
  // rejection-% and loss trend charts, since it's more reliable than
  // bucketing createdAtMs by calendar day.
  productionDate: string | null;
  expectedParts: number | null;
  producedThisSlot: number | null;
  // lossParts = expectedParts - producedThisSlot for this slot/segment (the
  // shortfall against target) — independent of stopEvents, since a slot can
  // fall short of target with NO downtime logged at all (e.g. a manually
  // confirmed loss reason like a power failure with no stop-event entry).
  // See RecordProductionScreen's LOSS_REASONS picker / lossReasonLabel field.
  lossParts: number | null;
  // The supervisor's manually-selected reason for that shortfall (from
  // RecordProductionScreen's LOSS_REASONS list) — separate from
  // stopEvents[].reason, which comes from a different picker (STOP_REASONS)
  // tied specifically to logged downtime.
  lossReasonLabel: string | null;
  rejections: number | null;
  stopEvents: StopEventRecord[] | null;
  operatorCount: number;
  productiveMinutes: number | null;
  createdAtMs: number | null;
}

type LineBreakdown = {
  lineId: string;
  lineName: string;
  plan: number;
  actual: number;
  rejections: number;
  operatorHours: number;
  downtimeMinutes: number;
};

// PCS Man Per Hour — mirrors PCSPerHourScreen's methodology exactly, just
// summed across every day in the selected date range instead of one day.
interface PcsPerHourLine {
  lineId: string;
  lineName: string;
  production: number;
  hours: number;
  otHours: number;
}

interface PcsPerHourDay {
  dateKey: string;    // YYYY-MM-DD, local
  dateLabel: string;
  actual: number;
  manPowerTarget: number;
  manPowerActual: number;
  avgHours: number;
  avgOtHours: number;
  manHour: number;
  pcsManHour: number;
  lines: PcsPerHourLine[];
}

type NearMissIntensity = 'Low' | 'Medium' | 'High' | 'Critical';
type NearMissStatus = 'Open' | 'In Progress' | 'Closed' | 'Pending';

interface NearMissRecord {
  id: string;
  date: string;
  plant: string | null;
  workshop: string | null;
  division: string | null;
  areaMachine: string;
  intensity: NearMissIntensity;
  description: string;
  actionTaken: string;
  tdc: string;
  responsibility: string;
  status: NearMissStatus;
  closedOn: string;
  submittedBy: string;
  createdAtMs: number | null;
}

interface ManDayRecord {
  id: string;
  plant: string;
  workshop: string;
  division: string;
  dateISO: string;
  dateDisplay: string;
  dayOfWeek: string;
  month: string;
  present: number;
  absent: number;
  onLeave: number;
  totalPresent: number;
  remarks: string;
  submittedBy: string;
  createdAtMs: number | null;
}

type PokaYokeStatus = 'Open' | 'In Progress' | 'Closed';

interface PokaYokeRecord {
  id: string;
  sNo: number | null;
  plant: string | null;
  workshop: string | null;
  division: string | null;
  lineName: string;
  lineNo: string;
  partsName: string;
  model: string;
  pokaYokeNo: string;
  pokaYokeDetails: string;
  problem: string;
  rootCause: string;
  actionPlan: string;
  responsibility: string;
  targetDate: string;
  status: PokaYokeStatus;
  submittedBy: string;
  createdAtMs: number | null;
}

const NEAR_MISS_INTENSITY_COLOR: Record<NearMissIntensity, string> = {
  Low: '#4C9A6A',
  Medium: '#F2A93B',
  High: '#E07B39',
  Critical: '#D64545',
};

const NEAR_MISS_STATUS_COLOR: Record<NearMissStatus, string> = {
  Open: '#D64545',
  'In Progress': '#F2A93B',
  Closed: '#4C9A6A',
  Pending: '#8A96A3',
};

const POKA_YOKE_STATUS_COLOR: Record<PokaYokeStatus, string> = {
  Open: '#D64545',
  'In Progress': '#F2A93B',
  Closed: '#4C9A6A',
};

interface PlanVsActualRecord {
  id: string;
  date: string;
  plant: string | null;
  workshop: string | null;
  division: string | null;
  shift: string | null;
  lineName: string;
  planned: number;
  actual: number;
  loss: number;
  productionPct: number;
  submittedBy: string;
  createdAtMs: number | null;
}

interface ReworkRecord {
  id: string;
  date: string;
  plant: string | null;
  workshop: string | null;
  division: string | null;
  shift: string | null;
  lineName: string;
  totalProduction: number;
  reworkCount: number;
  reworkPct: number;
  submittedBy: string;
  createdAtMs: number | null;
}

type KaizenStatus = 'Open' | 'In Progress' | 'Implemented' | 'Closed' | 'Rejected';

interface KaizenRecord {
  id: string;
  sNo: number;
  date: string;
  plant: string | null;
  workshop: string | null;
  division: string | null;
  employeeName: string;
  employeeCode: string;
  improvementIdentified: string;
  kaizenIdea: string;
  category: string;
  priority: string;
  actionTaken: string;
  responsibility: string;
  targetDate: string;
  status: KaizenStatus;
  result: string;
  remarks: string;
  submittedBy: string;
  createdAtMs: number | null;
}

const KAIZEN_STATUS_COLOR: Record<KaizenStatus, string> = {
  Open: '#D64545',
  'In Progress': '#F2A93B',
  Implemented: '#4C9A6A',
  Closed: '#8A96A3',
  Rejected: '#5C6670',
};

type AttendanceStatus = 'present' | 'absent' | 'leave';

interface AttendanceRecord {
  id: string;
  operatorId: string;
  operatorName: string;
  operatorCode: string;
  plant: string | null;
  workshop: string | null;
  division: string | null;
  date: string;
  shift: string | null;
  status: AttendanceStatus;
  submittedBy: string;
  createdAtMs: number | null;
}

const ATTENDANCE_STATUS_COLOR: Record<AttendanceStatus, string> = {
  present: '#4C9A6A',
  absent: '#D64545',
  leave: '#F2A93B',
};

// ─── Constants ────────────────────────────────────────────────────────────────

const KPI_OPTIONS: KpiOption[] = [
  { key: 'pcs-per-hour', title: 'PCS Man Per Hour', icon: 'speedometer', accent: '#F2A93B', computable: true },
  { key: 'plan-vs-actual', title: 'Plan vs Actual Target', icon: 'trending-up', accent: '#3E7CB1', computable: true },
  { key: 'rejection-pct', title: 'Rejection % Tracker', icon: 'close-circle', accent: '#D64545', computable: true },
  { key: 'loss-details', title: 'Loss Details', icon: 'document-text', accent: '#8A96A3', computable: true },
  { key: 'near-miss', title: 'Near-Miss Report', icon: 'alert-circle', accent: '#D64545', computable: true },
  { key: 'man-days', title: 'Man-Days Tracker', icon: 'people', accent: '#3E7CB1', computable: true },
  { key: 'poka-yoke', title: 'Poka Yoke Breakdown Tracker', icon: 'shield-checkmark', accent: '#4C9A6A', computable: true },
  { key: 'rework-pct', title: 'Rework Data %', icon: 'refresh-circle', accent: '#F2A93B', computable: true },
  { key: 'kaizen', title: 'Kaizen Tracker', icon: 'bulb', accent: '#4C9A6A', computable: true },
  { key: 'attendance', title: 'Attendance Sheet', icon: 'calendar', accent: '#3E7CB1', computable: true },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function pad2(n: number) {
  return String(n).padStart(2, '0');
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// Fallback date key ('YYYY-MM-DD', local) for productionRecords docs saved
// before `productionDate` existed. Only used when that field is missing —
// productionDate is otherwise always preferred since it correctly reflects
// the shift's production day rather than the calendar day a record's
// timestamp happens to fall on.
// Fallback for when a slot fell short of target but was never run through
// the manual loss-reason confirmation (lossReasonLabel stays null in that
// case) — derives a reason from the slot's own stopEvents instead of
// lumping every unexplained shortfall into "Unspecified". Mirrors
// GenerateReportScreen's deriveReasonFromStops exactly, so the two screens
// agree on what a given record's loss reason is.
function deriveReasonFromStops(events: StopEventRecord[] | null): string | null {
  if (!events || events.length === 0) return null;
  const reasons = Array.from(new Set(events.map((e) => e.reason).filter(Boolean)));
  if (reasons.length === 0) return null;
  return reasons.join(', ');
}

function dateKeyFromMs(ms: number | null): string {
  if (!ms) return 'unknown';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function isValidDateStr(s: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(`${s}T00:00:00`).getTime());
}

// Auto-inserts "-" as the user types a date, matching GenerateReportScreen's
// From/To date fields: YYYY, then YYYY-MM, then YYYY-MM-DD. Digits are the
// only thing that matters for the format — every hyphen (typed, pasted, or
// left over from a previous value) is stripped first and reinserted at the
// right spots, so backspacing over a "-" just removes the digit before it
// instead of leaving a stray/duplicate "-", and pasting "20260901" or
// "2026-09-01" both land on the same normalized "2026-09-01".
function formatDateInput(value: string): string {
  const digits = value.replace(/[^0-9]/g, '').slice(0, 8); // YYYYMMDD, max 8 digits
  if (digits.length <= 4) return digits;
  if (digits.length <= 6) return `${digits.slice(0, 4)}-${digits.slice(4)}`;
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6)}`;
}

// Case/whitespace-insensitive equality so stray casing differences in older
// records don't silently exclude them from a filter.
// Loose equality for plant/workshop/division filters. Records saved before
// the workshop/division lists were standardized may hold older values (e.g.
// "Assembly" instead of "Assembly Shop", "S.Jack" instead of "S. Jack") — so
// besides ignoring case/whitespace, a substring match (after stripping
// punctuation/spaces) also counts as equal, so legacy records still show up.
function normalizeStr(s: string | null | undefined) {
  return (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}
function sameStr(a: string | null | undefined, b: string | null | undefined) {
  const na = normalizeStr(a);
  const nb = normalizeStr(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

function round1(n: number) {
  return Math.round(n * 10) / 10;
}

// ─── Charting ───────────────────────────────────────────────────────────────
// One shared palette so every chart on this screen (Plan vs Actual today,
// more KPIs later) reads consistently rather than each chart picking its own
// colors.
const CHART_COLORS = {
  planned: '#3E7CB1',   // this KPI's own accent — the "target/plan" series
  actual: '#4C9A6A',    // green — the "what really happened" series
  grid: '#2C343C',
  axisText: '#8A96A3',
  achievement: {
    green: '#4C9A6A',   // >= 95%
    yellow: '#E8C547',  // 85–94%
    orange: '#E0793C',  // 70–84%
    red: '#D64545',     // < 70%
  },
  pcs: {
    ratio: '#F2A93B',      // PCS/Man-Hr — matches this KPI's own accent
    production: '#4C9A6A', // green — output
    manpower: '#8A5CF5',   // purple — headcount, matches Manage Manpower's accent
  },
  rejection: {
    rate: '#D64545',    // this KPI's own accent — Rejection % Tracker
    good: '#4C9A6A',
  },
  loss: {
    downtime: '#E0793C',    // this KPI's own accent — Loss Details
    lostPieces: '#D64545',
  },
  // Cycled through for the Loss Reason donut's slices, since the number of
  // distinct stop reasons isn't fixed — a longer, fixed legend/color map
  // would either run out of colors or list reasons that never occur.
  donutPalette: ['#D64545', '#E0793C', '#F2A93B', '#E8C547', '#4C9A6A', '#3E7CB1', '#8A5CF5', '#5C6670'],
};

function achievementColor(pct: number): string {
  if (pct >= 95) return CHART_COLORS.achievement.green;
  if (pct >= 85) return CHART_COLORS.achievement.yellow;
  if (pct >= 70) return CHART_COLORS.achievement.orange;
  return CHART_COLORS.achievement.red;
}

function achievementTierLabel(pct: number): string {
  if (pct >= 95) return 'On target';
  if (pct >= 85) return 'Near target';
  if (pct >= 70) return 'Below target';
  return 'Critical';
}

// 'YYYY-MM-DD' -> 'DD Mon', for compact chart x-axis labels
function shortDateLabel(dateStr: string): string {
  if (!dateStr || dateStr === 'unknown') return '—';
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!y || !m || !d) return dateStr;
  const dt = new Date(y, m - 1, d);
  return `${pad2(d)} ${dt.toLocaleString('en-US', { month: 'short' })}`;
}

const SCREEN_WIDTH = Dimensions.get('window').width;
// Chart card horizontal padding (see styles.chartCard) subtracted out so the
// chart itself never overflows/gets clipped on narrower phones.
const CHART_WIDTH = Math.max(240, SCREEN_WIDTH - 32 - 32 - 24);

// Shared shell for every chart on this screen — title/subtitle, an optional
// legend row, optional axis captions, and a "No data available" fallback so
// no chart ever renders as a blank/empty canvas. The actual chart component
// is passed in as children.
function ChartCard({
  title,
  subtitle,
  xAxisLabel,
  yAxisLabel,
  legend,
  hasData,
  children,
}: {
  title: string;
  subtitle: string;
  xAxisLabel?: string;
  yAxisLabel?: string;
  legend?: { color: string; label: string }[];
  hasData: boolean;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.chartCard}>
      <Text style={styles.chartTitle}>{title}</Text>
      <Text style={styles.chartSubtitle}>{subtitle}</Text>

      {!hasData ? (
        <View style={styles.chartEmptyBox}>
          <Ionicons name="bar-chart-outline" size={26} color="#5C6670" />
          <Text style={styles.chartEmptyText}>No data available</Text>
        </View>
      ) : (
        <>
          {!!legend?.length && (
            <View style={styles.chartLegendRow}>
              {legend.map((l) => (
                <View key={l.label} style={styles.chartLegendItem}>
                  <View style={[styles.chartLegendDot, { backgroundColor: l.color }]} />
                  <Text style={styles.chartLegendText}>{l.label}</Text>
                </View>
              ))}
            </View>
          )}
          {!!yAxisLabel && <Text style={styles.chartAxisLabelY}>Y-Axis: {yAxisLabel}</Text>}
          <View style={styles.chartBody}>{children}</View>
          {!!xAxisLabel && <Text style={styles.chartAxisLabelX}>X-Axis: {xAxisLabel}</Text>}
        </>
      )}
    </View>
  );
}

// Achievement %'s bars are built by hand with plain Views + Animated rather
// than gifted-charts' `horizontal` BarChart mode — that mode was rendering
// with a large fixed empty height regardless of the `height` prop, and bars
// whose value exceeded ~50 overflowed off the right edge of the card
// instead of scaling to the given width/maxValue. A single proportional-
// width bar per line is simple enough to fully control directly, and it
// sidesteps that class of layout bug entirely.
function AchievementBarRow({
  label,
  pct,
  color,
  onPress,
}: {
  label: string;
  pct: number;
  color: string;
  onPress: () => void;
}) {
  const widthAnim = useRef(new Animated.Value(0)).current;
  const clamped = Math.max(0, Math.min(100, pct));

  useEffect(() => {
    Animated.timing(widthAnim, {
      toValue: clamped,
      duration: 700,
      useNativeDriver: false, // animating a percentage width, not transform/opacity
    }).start();
  }, [clamped, widthAnim]);

  const animatedWidth = widthAnim.interpolate({ inputRange: [0, 100], outputRange: ['0%', '100%'] });

  return (
    <Pressable onPress={onPress} style={styles.achievementRow}>
      <Text style={styles.achievementRowLabel} numberOfLines={1}>{label}</Text>
      <View style={styles.achievementRowTrack}>
        <Animated.View style={[styles.achievementRowFill, { width: animatedWidth, backgroundColor: color }]} />
      </View>
      <Text style={[styles.achievementRowValue, { color }]}>{pct}%</Text>
    </Pressable>
  );
}

// Generic horizontal bar row — same visual/animation as AchievementBarRow,
// but for a raw value scaled against the group's own max (Rejections by
// Line, Downtime Minutes by Line) rather than a fixed 0–100% scale. Reuses
// AchievementBarRow's styles since the shape is identical.
function MetricBarRow({
  label,
  value,
  maxValue,
  color,
  valueLabel,
  onPress,
}: {
  label: string;
  value: number;
  maxValue: number;
  color: string;
  valueLabel: string;
  onPress: () => void;
}) {
  const widthAnim = useRef(new Animated.Value(0)).current;
  const pct = maxValue > 0 ? Math.max(0, Math.min(100, (value / maxValue) * 100)) : 0;

  useEffect(() => {
    Animated.timing(widthAnim, {
      toValue: pct,
      duration: 700,
      useNativeDriver: false, // animating a percentage width, not transform/opacity
    }).start();
  }, [pct, widthAnim]);

  const animatedWidth = widthAnim.interpolate({ inputRange: [0, 100], outputRange: ['0%', '100%'] });

  return (
    <Pressable onPress={onPress} style={styles.achievementRow}>
      <Text style={styles.achievementRowLabel} numberOfLines={1}>{label}</Text>
      <View style={styles.achievementRowTrack}>
        <Animated.View style={[styles.achievementRowFill, { width: animatedWidth, backgroundColor: color }]} />
      </View>
      <Text style={[styles.achievementRowValue, { color }]}>{valueLabel}</Text>
    </Pressable>
  );
}

function dayLabelFromKey(key: string): string {
  if (key === 'unknown') return 'Unknown date';
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return `${pad2(d)} ${dt.toLocaleString('en-US', { month: 'short' })} ${y}`;
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// 'YYYY-MM' -> 'Mon YYYY', for month-grouped chart labels (Near-Miss and
// Poka Yoke monthly trends). Shared with manDaysTotals' own inline version
// of this same mapping.
function monthLabelFromKey(ym: string): string {
  if (!ym || ym === 'unknown') return 'Unknown';
  const [y, m] = ym.split('-');
  const idx = parseInt(m, 10) - 1;
  if (!y || Number.isNaN(idx) || idx < 0 || idx > 11) return ym;
  return `${MONTH_NAMES[idx]} ${y}`;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function KPIAnalysisScreen() {
  const navigation = useNavigation<any>();

  // ── Filters
  const [plant, setPlant] = useState<string | null>(null);
  const [workshop, setWorkshop] = useState<string | null>(null);
  const [division, setDivision] = useState<string | null>(null);
  const [fromDate, setFromDate] = useState(todayStr());
  const [toDate, setToDate] = useState(todayStr());
  const [selectedKpiKey, setSelectedKpiKey] = useState<string | null>(null);

  // ── Report state
  const [generating, setGenerating] = useState(false);
  const [hasGenerated, setHasGenerated] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rawRecords, setRawRecords] = useState<ProductionRecord[]>([]);
  const [nearMissRecords, setNearMissRecords] = useState<NearMissRecord[]>([]);
  const [manDaysRecords, setManDaysRecords] = useState<ManDayRecord[]>([]);
  const [pokaYokeRecords, setPokaYokeRecords] = useState<PokaYokeRecord[]>([]);
  const [planVsActualRecords, setPlanVsActualRecords] = useState<PlanVsActualRecord[]>([]);
  // Tap-to-see-value tooltip for the Plan vs Actual bar charts (the line
  // chart below has its own built-in drag/tap tooltip via pointerConfig).
  const [pvaBarTooltip, setPvaBarTooltip] = useState<{ chart: 'byLine' | 'achievement'; label: string; lines: string[] } | null>(null);
  const [pcsBarTooltip, setPcsBarTooltip] = useState<{ label: string; lines: string[] } | null>(null);
  const [rejectionBarTooltip, setRejectionBarTooltip] = useState<{ chart: 'byLine' | 'byPart'; label: string; lines: string[] } | null>(null);
  const [lossBarTooltip, setLossBarTooltip] = useState<{ chart: 'byLine' | 'reason'; label: string; lines: string[] } | null>(null);
  const [attendanceBarTooltip, setAttendanceBarTooltip] = useState<{ label: string; lines: string[] } | null>(null);
  const [manDaysBarTooltip, setManDaysBarTooltip] = useState<{ chart: 'byDivision' | 'byMonth'; label: string; lines: string[] } | null>(null);
  const [nearMissBarTooltip, setNearMissBarTooltip] = useState<{ label: string; lines: string[] } | null>(null);
  const [pokaYokeBarTooltip, setPokaYokeBarTooltip] = useState<{ label: string; lines: string[] } | null>(null);
  const [reworkBarTooltip, setReworkBarTooltip] = useState<{ chart: 'byLine' | 'byDate'; label: string; lines: string[] } | null>(null);
  const [kaizenBarTooltip, setKaizenBarTooltip] = useState<{ label: string; lines: string[] } | null>(null);
  const [reworkRecords, setReworkRecords] = useState<ReworkRecord[]>([]);
  const [kaizenRecords, setKaizenRecords] = useState<KaizenRecord[]>([]);
  const [attendanceRecords, setAttendanceRecords] = useState<AttendanceRecord[]>([]);
  const [pcsPerHourDays, setPcsPerHourDays] = useState<PcsPerHourDay[]>([]);
  const [expandedAttendanceDivision, setExpandedAttendanceDivision] = useState<string | null>(null);
  const [reportKpiKey, setReportKpiKey] = useState<string | null>(null); // KPI the current results belong to
  const [exportingExcel, setExportingExcel] = useState(false);

  const selectedKpi = KPI_OPTIONS.find((k) => k.key === selectedKpiKey) ?? null;

  // Plant/workshop/division applied client-side against the fetched date range,
  // so switching those chips after generating updates the report instantly.
  const filteredRecords = useMemo(() => {
    return rawRecords.filter((r) => {
      if (plant && !sameStr(r.plant, plant)) return false;
      if (workshop && !sameStr(r.workshop, workshop)) return false;
      if (division && !sameStr(r.division, division)) return false;
      return true;
    });
  }, [rawRecords, plant, workshop, division]);

  const filteredNearMiss = useMemo(() => {
    return nearMissRecords.filter((r) => {
      if (plant && !sameStr(r.plant, plant)) return false;
      if (workshop && !sameStr(r.workshop, workshop)) return false;
      if (division && !sameStr(r.division, division)) return false;
      return true;
    });
  }, [nearMissRecords, plant, workshop, division]);

  const filteredPokaYoke = useMemo(() => {
    return pokaYokeRecords.filter((r) => {
      if (plant && !sameStr(r.plant, plant)) return false;
      if (workshop && !sameStr(r.workshop, workshop)) return false;
      if (division && !sameStr(r.division, division)) return false;
      return true;
    });
  }, [pokaYokeRecords, plant, workshop, division]);

  // Near-Miss aggregates — severity/status breakdowns plus a monthly trend,
  // for the three Near-Miss charts.
  const nearMissTotals = useMemo(() => {
    const bySeverity = (['Low', 'Medium', 'High', 'Critical'] as NearMissIntensity[])
      .map((level) => ({ level, count: filteredNearMiss.filter((r) => r.intensity === level).length }))
      .filter((s) => s.count > 0);

    const byStatus = (['Open', 'In Progress', 'Closed', 'Pending'] as NearMissStatus[])
      .map((status) => ({ status, count: filteredNearMiss.filter((r) => r.status === status).length }))
      .filter((s) => s.count > 0);

    // Monthly trend — grouped by the report's own `date` field, falling
    // back to the calendar month of createdAtMs for any record that was
    // saved without one.
    const byMonthMap = new Map<string, number>();
    filteredNearMiss.forEach((r) => {
      const ym = (r.date && r.date.length >= 7 ? r.date.slice(0, 7) : null) ?? dateKeyFromMs(r.createdAtMs).slice(0, 7);
      byMonthMap.set(ym, (byMonthMap.get(ym) ?? 0) + 1);
    });
    const byMonth = Array.from(byMonthMap.entries())
      .filter(([ym]) => ym !== 'unknown') // dateKeyFromMs(null) -> 'unknown', unchanged by .slice(0,7)
      .map(([ym, count]) => ({ ym, label: monthLabelFromKey(ym), count }))
      .sort((a, b) => a.ym.localeCompare(b.ym));

    return { bySeverity, byStatus, byMonth };
  }, [filteredNearMiss]);

  // Poka Yoke aggregates — status distribution, per-line breakdown, and an
  // Open-vs-Closed monthly trend, for the three Poka Yoke charts.
  const pokaYokeTotals = useMemo(() => {
    const byStatus = (['Open', 'In Progress', 'Closed'] as PokaYokeStatus[])
      .map((status) => ({ status, count: filteredPokaYoke.filter((r) => r.status === status).length }))
      .filter((s) => s.count > 0);

    const byLineMap = new Map<string, number>();
    filteredPokaYoke.forEach((r) => {
      const key = r.lineName || 'Unspecified';
      byLineMap.set(key, (byLineMap.get(key) ?? 0) + 1);
    });
    const byLine = Array.from(byLineMap.entries())
      .map(([lineName, count]) => ({ lineName, count }))
      .sort((a, b) => b.count - a.count);

    // Open vs Closed trend — PokaYokeRecord has no submission-date string
    // field (only `targetDate`, a due date, and `createdAtMs`), so the month
    // is derived from createdAtMs. "Open" here also includes "In Progress",
    // since both represent work that hasn't been closed out yet.
    const byMonthMap = new Map<string, { open: number; closed: number }>();
    filteredPokaYoke.forEach((r) => {
      const ym = dateKeyFromMs(r.createdAtMs).slice(0, 7);
      if (ym === 'unknown') return; // dateKeyFromMs(null) -> 'unknown', unchanged by .slice(0,7)
      const existing = byMonthMap.get(ym) ?? { open: 0, closed: 0 };
      if (r.status === 'Closed') existing.closed += 1;
      else existing.open += 1;
      byMonthMap.set(ym, existing);
    });
    const openVsClosedTrend = Array.from(byMonthMap.entries())
      .map(([ym, v]) => ({ ym, label: monthLabelFromKey(ym), ...v }))
      .sort((a, b) => a.ym.localeCompare(b.ym));

    return { byStatus, byLine, openVsClosedTrend };
  }, [filteredPokaYoke]);

  const filteredPlanVsActual = useMemo(() => {
    return planVsActualRecords.filter((r) => {
      if (plant && !sameStr(r.plant, plant)) return false;
      if (workshop && !sameStr(r.workshop, workshop)) return false;
      if (division && !sameStr(r.division, division)) return false;
      return true;
    });
  }, [planVsActualRecords, plant, workshop, division]);

  const filteredRework = useMemo(() => {
    return reworkRecords.filter((r) => {
      if (plant && !sameStr(r.plant, plant)) return false;
      if (workshop && !sameStr(r.workshop, workshop)) return false;
      if (division && !sameStr(r.division, division)) return false;
      return true;
    });
  }, [reworkRecords, plant, workshop, division]);

  const filteredKaizen = useMemo(() => {
    return kaizenRecords.filter((r) => {
      if (plant && !sameStr(r.plant, plant)) return false;
      if (workshop && !sameStr(r.workshop, workshop)) return false;
      if (division && !sameStr(r.division, division)) return false;
      return true;
    });
  }, [kaizenRecords, plant, workshop, division]);

  // Rework aggregates — % trend over time, per-line breakdown, and raw
  // count over time, for the three Rework charts.
  const reworkTotals = useMemo(() => {
    // Trend — grouped by the record's own `date` field, falling back to
    // createdAtMs for any record saved without one.
    const byDateMap = new Map<string, { production: number; rework: number }>();
    filteredRework.forEach((r) => {
      const key = r.date || dateKeyFromMs(r.createdAtMs);
      const existing = byDateMap.get(key);
      if (existing) {
        existing.production += r.totalProduction;
        existing.rework += r.reworkCount;
      } else {
        byDateMap.set(key, { production: r.totalProduction, rework: r.reworkCount });
      }
    });
    const byDate = Array.from(byDateMap.entries())
      .filter(([date]) => date !== 'unknown')
      .map(([date, v]) => ({
        date,
        dateLabel: dayLabelFromKey(date),
        reworkCount: v.rework,
        reworkPct: v.production > 0 ? round1((v.rework / v.production) * 100) : 0,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));

    // By line
    const byLineMap = new Map<string, { production: number; rework: number }>();
    filteredRework.forEach((r) => {
      const key = r.lineName || 'Unnamed line';
      const existing = byLineMap.get(key);
      if (existing) {
        existing.production += r.totalProduction;
        existing.rework += r.reworkCount;
      } else {
        byLineMap.set(key, { production: r.totalProduction, rework: r.reworkCount });
      }
    });
    const byLine = Array.from(byLineMap.entries())
      .map(([lineName, v]) => ({
        lineName,
        reworkCount: v.rework,
        reworkPct: v.production > 0 ? round1((v.rework / v.production) * 100) : 0,
      }))
      .sort((a, b) => b.reworkCount - a.reworkCount);

    return { byDate, byLine };
  }, [filteredRework]);

  // Kaizen aggregates — status distribution, per-category breakdown, and a
  // monthly Implemented trend, for the three Kaizen charts.
  const kaizenTotals = useMemo(() => {
    const byStatus = (['Open', 'In Progress', 'Implemented', 'Closed', 'Rejected'] as KaizenStatus[])
      .map((status) => ({ status, count: filteredKaizen.filter((r) => r.status === status).length }))
      .filter((s) => s.count > 0);

    const byCategoryMap = new Map<string, number>();
    filteredKaizen.forEach((r) => {
      const key = r.category || 'Uncategorized';
      byCategoryMap.set(key, (byCategoryMap.get(key) ?? 0) + 1);
    });
    const byCategory = Array.from(byCategoryMap.entries())
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count);

    // Monthly Implemented trend — grouped by the record's own `date` field,
    // falling back to createdAtMs for older records, counting only ideas
    // whose status is currently 'Implemented'.
    const byMonthMap = new Map<string, number>();
    filteredKaizen
      .filter((r) => r.status === 'Implemented')
      .forEach((r) => {
        const ym = (r.date && r.date.length >= 7 ? r.date.slice(0, 7) : null) ?? dateKeyFromMs(r.createdAtMs).slice(0, 7);
        byMonthMap.set(ym, (byMonthMap.get(ym) ?? 0) + 1);
      });
    const implementedByMonth = Array.from(byMonthMap.entries())
      .filter(([ym]) => ym !== 'unknown')
      .map(([ym, count]) => ({ ym, label: monthLabelFromKey(ym), count }))
      .sort((a, b) => a.ym.localeCompare(b.ym));

    return { byStatus, byCategory, implementedByMonth };
  }, [filteredKaizen]);

  const filteredManDays = useMemo(() => {
    return manDaysRecords.filter((r) => {
      if (plant    && !sameStr(r.plant,    plant))    return false;
      if (workshop && !sameStr(r.workshop, workshop)) return false;
      if (division && !sameStr(r.division, division)) return false;
      return true;
    });
  }, [manDaysRecords, plant, workshop, division]);

  const filteredAttendance = useMemo(() => {
    return attendanceRecords.filter((r) => {
      if (plant    && !sameStr(r.plant,    plant))    return false;
      if (workshop && !sameStr(r.workshop, workshop)) return false;
      if (division && !sameStr(r.division, division)) return false;
      return true;
    });
  }, [attendanceRecords, plant, workshop, division]);

  // Attendance aggregates
  const attendanceTotals = useMemo(() => {
    const total = filteredAttendance.length;
    const present = filteredAttendance.filter((r) => r.status === 'present').length;
    const absent = filteredAttendance.filter((r) => r.status === 'absent').length;
    const leave = filteredAttendance.filter((r) => r.status === 'leave').length;
    const pct = (n: number) => (total > 0 ? round1((n / total) * 100) : 0);

    // Group by division
    const byDivMap = new Map<string, { present: number; absent: number; leave: number; total: number }>();
    filteredAttendance.forEach((r) => {
      const key = r.division || 'Unknown';
      const ex = byDivMap.get(key);
      if (ex) {
        if (r.status === 'present') ex.present += 1;
        else if (r.status === 'absent') ex.absent += 1;
        else ex.leave += 1;
        ex.total += 1;
      } else {
        byDivMap.set(key, {
          present: r.status === 'present' ? 1 : 0,
          absent: r.status === 'absent' ? 1 : 0,
          leave: r.status === 'leave' ? 1 : 0,
          total: 1,
        });
      }
    });
    const byDivision = Array.from(byDivMap.entries())
      .map(([division, v]) => ({
        division,
        ...v,
        presentPct: v.total > 0 ? round1((v.present / v.total) * 100) : 0,
        absentPct: v.total > 0 ? round1((v.absent / v.total) * 100) : 0,
        leavePct: v.total > 0 ? round1((v.leave / v.total) * 100) : 0,
      }))
      .sort((a, b) => b.total - a.total);

    // Group by date
    const byDateMap = new Map<string, { present: number; absent: number; leave: number; total: number }>();
    filteredAttendance.forEach((r) => {
      const key = r.date || 'Unknown';
      const ex = byDateMap.get(key);
      if (ex) {
        if (r.status === 'present') ex.present += 1;
        else if (r.status === 'absent') ex.absent += 1;
        else ex.leave += 1;
        ex.total += 1;
      } else {
        byDateMap.set(key, {
          present: r.status === 'present' ? 1 : 0,
          absent: r.status === 'absent' ? 1 : 0,
          leave: r.status === 'leave' ? 1 : 0,
          total: 1,
        });
      }
    });
    const byDate = Array.from(byDateMap.entries())
      .map(([date, v]) => ({ date, ...v, presentPct: v.total > 0 ? round1((v.present / v.total) * 100) : 0 }))
      .sort((a, b) => a.date.localeCompare(b.date));

    return {
      total, present, absent, leave,
      presentPct: pct(present), absentPct: pct(absent), leavePct: pct(leave),
      byDivision, byDate,
    };
  }, [filteredAttendance]);

  // Man-days aggregates
  const manDaysTotals = useMemo(() => {
    const totalPresent = filteredManDays.reduce((s, r) => s + r.totalPresent, 0);
    const totalAbsent  = filteredManDays.reduce((s, r) => s + r.absent,       0);
    const totalOnLeave = filteredManDays.reduce((s, r) => s + r.onLeave,      0);
    const uniqueDays   = new Set(filteredManDays.map((r) => r.dateISO)).size;
    const avgPerDay    = uniqueDays > 0 ? round1(totalPresent / uniqueDays) : 0;

    // Group by division
    const byDivMap = new Map<string, { present: number; absent: number; onLeave: number; total: number; days: Set<string> }>();
    filteredManDays.forEach((r) => {
      const key = r.division || 'Unknown';
      const ex  = byDivMap.get(key);
      if (ex) {
        ex.present  += r.present;
        ex.absent   += r.absent;
        ex.onLeave  += r.onLeave;
        ex.total    += r.totalPresent;
        ex.days.add(r.dateISO);
      } else {
        byDivMap.set(key, { present: r.present, absent: r.absent, onLeave: r.onLeave, total: r.totalPresent, days: new Set([r.dateISO]) });
      }
    });
    const byDivision = Array.from(byDivMap.entries())
      .map(([division, v]) => ({ division, ...v, avgPerDay: v.days.size > 0 ? round1(v.total / v.days.size) : 0 }))
      .sort((a, b) => b.total - a.total);

    // Group by date for daily trend (include submittedBy list per date)
    const byDateMap = new Map<string, { dateDisplay: string; dayOfWeek: string; total: number; submittedBy: string[] }>();
    filteredManDays.forEach((r) => {
      const ex = byDateMap.get(r.dateISO);
      if (ex) {
        ex.total += r.totalPresent;
        if (r.submittedBy && !ex.submittedBy.includes(r.submittedBy)) ex.submittedBy.push(r.submittedBy);
      } else {
        byDateMap.set(r.dateISO, { dateDisplay: r.dateDisplay, dayOfWeek: r.dayOfWeek, total: r.totalPresent, submittedBy: r.submittedBy ? [r.submittedBy] : [] });
      }
    });
    const byDate = Array.from(byDateMap.entries())
      .map(([dateISO, v]) => ({ dateISO, ...v }))
      .sort((a, b) => a.dateISO.localeCompare(b.dateISO));

    // Group by month (YYYY-MM)
    // Group by month, with per-division breakdown inside each month.
    // Structure: Map<YYYY-MM, { ...totals, divisions: Map<divisionName, {...}> }>
    type MonthDivEntry = { present: number; absent: number; onLeave: number; total: number; days: Set<string> };
    type MonthEntry = MonthDivEntry & { submittedBy: string[]; divisions: Map<string, MonthDivEntry> };

    const byMonthMap = new Map<string, MonthEntry>();

    filteredManDays.forEach((r) => {
      const ym  = r.month || r.dateISO.slice(0, 7);
      const div = r.division || 'Unknown';

      // ── Month level
      if (!byMonthMap.has(ym)) {
        byMonthMap.set(ym, { present: 0, absent: 0, onLeave: 0, total: 0, days: new Set(), submittedBy: [], divisions: new Map() });
      }
      const mo = byMonthMap.get(ym)!;
      mo.present  += r.present;
      mo.absent   += r.absent;
      mo.onLeave  += r.onLeave;
      mo.total    += r.totalPresent;
      mo.days.add(r.dateISO);
      if (r.submittedBy && !mo.submittedBy.includes(r.submittedBy)) mo.submittedBy.push(r.submittedBy);

      // ── Division level inside this month
      if (!mo.divisions.has(div)) {
        mo.divisions.set(div, { present: 0, absent: 0, onLeave: 0, total: 0, days: new Set() });
      }
      const de = mo.divisions.get(div)!;
      de.present  += r.present;
      de.absent   += r.absent;
      de.onLeave  += r.onLeave;
      de.total    += r.totalPresent;
      de.days.add(r.dateISO);
    });

    const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const byMonth = Array.from(byMonthMap.entries())
      .map(([ym, mo]) => {
        const [y, m] = ym.split('-');
        const label      = `${MONTH_NAMES[parseInt(m, 10) - 1]} ${y}`;
        const daysLogged = mo.days.size;
        // avgManpower = average total present per logged day for the whole month
        const avgManpower = daysLogged > 0 ? round1(mo.total / daysLogged) : 0;
        const divisions = Array.from(mo.divisions.entries())
          .map(([division, de]) => ({
            division,
            present:    de.present,
            absent:     de.absent,
            onLeave:    de.onLeave,
            total:      de.total,
            daysLogged: de.days.size,
            avgPerDay:  de.days.size > 0 ? round1(de.total / de.days.size) : 0,
          }))
          .sort((a, b) => b.total - a.total);
        return { ym, label, daysLogged, avgManpower, total: mo.total, present: mo.present, absent: mo.absent, onLeave: mo.onLeave, submittedBy: mo.submittedBy, divisions };
      })
      .sort((a, b) => a.ym.localeCompare(b.ym));

    return { totalPresent, totalAbsent, totalOnLeave, uniqueDays, avgPerDay, byDivision, byDate, byMonth };
  }, [filteredManDays]);

  // ─────────────────────────────────────────────────────────────────────────────
  // SHOW REPORT
  // ─────────────────────────────────────────────────────────────────────────────

  const handleShowReport = async () => {
    if (!selectedKpi) {
      Alert.alert('Select a KPI', 'Choose which KPI to report on first.');
      return;
    }

    if (!selectedKpi.computable) {
      // No Firestore collection behind this KPI yet — same fallback the
      // KPI Report hub already uses instead of showing fabricated numbers.
      navigation.navigate('ComingSoonReport', { title: selectedKpi.title });
      return;
    }

    if (!isValidDateStr(fromDate) || !isValidDateStr(toDate)) {
      Alert.alert('Invalid date', 'Enter dates as YYYY-MM-DD.');
      return;
    }
    if (fromDate > toDate) {
      Alert.alert('Invalid range', '"From" date must be on or before "To" date.');
      return;
    }

    setGenerating(true);
    setLoadError(null);
    try {
      const fromTs = Timestamp.fromDate(new Date(`${fromDate}T00:00:00`));
      const toTs = Timestamp.fromDate(new Date(`${toDate}T23:59:59.999`));

      if (selectedKpi.key === 'attendance') {
        const q = query(
          collection(db, 'attendanceRecords'),
          where('createdAt', '>=', fromTs),
          where('createdAt', '<=', toTs),
          orderBy('createdAt', 'desc')
        );
        const snap = await getDocs(q);
        const all: AttendanceRecord[] = snap.docs.map((d) => {
          const data: any = d.data();
          return {
            id: d.id,
            operatorId: data.operatorId ?? '',
            operatorName: data.operatorName ?? '',
            operatorCode: data.operatorCode ?? '',
            plant: data.plant ?? null,
            workshop: data.workshop ?? null,
            division: data.division ?? null,
            date: data.date ?? '',
            shift: data.shift ?? null,
            status: data.status ?? 'present',
            submittedBy: data.submittedBy?.name ?? '',
            createdAtMs: data.createdAt?.toMillis ? data.createdAt.toMillis() : null,
          };
        });
        console.log('[KPIAnalysis] fetched', all.length, 'attendance records for', fromDate, 'to', toDate);
        setAttendanceRecords(all);
        setExpandedAttendanceDivision(null);
        setAttendanceBarTooltip(null);
        setReportKpiKey(selectedKpi.key);
        setHasGenerated(true);
        setGenerating(false);
        return;
      }

      if (selectedKpi.key === 'man-days') {
        const q = query(
          collection(db, 'manDaysRecords'),
          where('createdAt', '>=', fromTs),
          where('createdAt', '<=', toTs),
          orderBy('createdAt', 'asc')
        );
        const snap = await getDocs(q);
        const all: ManDayRecord[] = snap.docs.map((d) => {
          const data: any = d.data();
          return {
            id:           d.id,
            plant:        data.plant        ?? '',
            workshop:     data.workshop     ?? '',
            division:     data.division     ?? '',
            dateISO:      data.dateISO      ?? '',
            dateDisplay:  data.dateDisplay  ?? '',
            dayOfWeek:    data.dayOfWeek    ?? '',
            month:        data.month        ?? '',
            present:      data.present      ?? 0,
            absent:       data.absent       ?? 0,
            onLeave:      data.onLeave      ?? 0,
            totalPresent: data.totalPresent ?? 0,
            remarks:      data.remarks      ?? '',
            submittedBy:  data.submittedBy  ?? '',
            createdAtMs:  data.createdAt?.toMillis ? data.createdAt.toMillis() : null,
          };
        });
        console.log('[KPIAnalysis] fetched', all.length, 'man-days records for', fromDate, 'to', toDate);
        setManDaysRecords(all);
        setManDaysBarTooltip(null);
        setReportKpiKey(selectedKpi.key);
        setHasGenerated(true);
        setGenerating(false);
        return;
      }

      if (selectedKpi.key === 'near-miss') {
        const q = query(
          collection(db, 'nearMissReports'),
          where('createdAt', '>=', fromTs),
          where('createdAt', '<=', toTs),
          orderBy('createdAt', 'desc')
        );
        const snap = await getDocs(q);
        const all: NearMissRecord[] = snap.docs.map((d) => {
          const data: any = d.data();
          return {
            id: d.id,
            date: data.date ?? '',
            plant: data.plant ?? null,
            workshop: data.workshop ?? null,
            division: data.division ?? null,
            areaMachine: data.areaMachine ?? '',
            intensity: data.intensity ?? 'Low',
            description: data.description ?? '',
            actionTaken: data.actionTaken ?? '',
            tdc: data.tdc ?? '',
            status: data.status ?? 'Open',
            responsibility: data.responsibility ?? '',
            closedOn: data.closedOn ?? '',
            submittedBy: data.submittedBy ?? '',
            createdAtMs: data.createdAt?.toMillis ? data.createdAt.toMillis() : null,
          };
        });
        console.log('[KPIAnalysis] fetched', all.length, 'near-miss records for', fromDate, 'to', toDate);
        setNearMissRecords(all);
        setNearMissBarTooltip(null);
        setReportKpiKey(selectedKpi.key);
        setHasGenerated(true);
        setGenerating(false);
        return;
      }

      if (selectedKpi.key === 'poka-yoke') {
        const q = query(
          collection(db, 'pokaYokeRecords'),
          where('createdAt', '>=', fromTs),
          where('createdAt', '<=', toTs),
          orderBy('createdAt', 'desc')
        );
        const snap = await getDocs(q);
        const all: PokaYokeRecord[] = snap.docs.map((d) => {
          const data: any = d.data();
          return {
            id: d.id,
            sNo: data.sNo ?? null,
            plant: data.plant ?? null,
            workshop: data.workshop ?? null,
            division: data.division ?? null,
            lineName: data.lineName ?? '',
            lineNo: data.lineNo ?? '',
            partsName: data.partsName ?? '',
            model: data.model ?? '',
            pokaYokeNo: data.pokaYokeNo ?? '',
            pokaYokeDetails: data.pokaYokeDetails ?? '',
            problem: data.problem ?? '',
            rootCause: data.rootCause ?? '',
            actionPlan: data.actionPlan ?? '',
            responsibility: data.responsibility ?? '',
            targetDate: data.targetDate ?? '',
            status: data.status ?? 'Open',
            submittedBy: data.submittedBy ?? '',
            createdAtMs: data.createdAt?.toMillis ? data.createdAt.toMillis() : null,
          };
        });
        console.log('[KPIAnalysis] fetched', all.length, 'poka-yoke records for', fromDate, 'to', toDate);
        setPokaYokeRecords(all);
        setPokaYokeBarTooltip(null);
        setReportKpiKey(selectedKpi.key);
        setHasGenerated(true);
        setGenerating(false);
        return;
      }

      if (selectedKpi.key === 'plan-vs-actual') {
        const q = query(
          collection(db, 'planVsActualRecords'),
          where('createdAt', '>=', fromTs),
          where('createdAt', '<=', toTs),
          orderBy('createdAt', 'desc')
        );
        const snap = await getDocs(q);
        const all: PlanVsActualRecord[] = snap.docs.map((d) => {
          const data: any = d.data();
          return {
            id: d.id,
            date: data.date ?? '',
            plant: data.plant ?? null,
            workshop: data.workshop ?? null,
            division: data.division ?? null,
            shift: data.shift ?? null,
            lineName: data.lineName ?? '',
            planned: data.planned ?? 0,
            actual: data.actual ?? 0,
            loss: data.loss ?? 0,
            productionPct: data.productionPct ?? 0,
            submittedBy: data.submittedBy ?? '',
            createdAtMs: data.createdAt?.toMillis ? data.createdAt.toMillis() : null,
          };
        });
        console.log('[KPIAnalysis] fetched', all.length, 'plan-vs-actual records for', fromDate, 'to', toDate);
        setPlanVsActualRecords(all);
        setPvaBarTooltip(null);
        setReportKpiKey(selectedKpi.key);
        setHasGenerated(true);
        setGenerating(false);
        return;
      }

      if (selectedKpi.key === 'rework-pct') {
        const q = query(
          collection(db, 'reworkRecords'),
          where('createdAt', '>=', fromTs),
          where('createdAt', '<=', toTs),
          orderBy('createdAt', 'desc')
        );
        const snap = await getDocs(q);
        const all: ReworkRecord[] = snap.docs.map((d) => {
          const data: any = d.data();
          return {
            id: d.id,
            date: data.date ?? '',
            plant: data.plant ?? null,
            workshop: data.workshop ?? null,
            division: data.division ?? null,
            shift: data.shift ?? null,
            lineName: data.lineName ?? '',
            totalProduction: data.totalProduction ?? 0,
            reworkCount: data.reworkCount ?? 0,
            reworkPct: data.reworkPct ?? 0,
            submittedBy: data.submittedBy ?? '',
            createdAtMs: data.createdAt?.toMillis ? data.createdAt.toMillis() : null,
          };
        });
        console.log('[KPIAnalysis] fetched', all.length, 'rework records for', fromDate, 'to', toDate);
        setReworkRecords(all);
        setReworkBarTooltip(null);
        setReportKpiKey(selectedKpi.key);
        setHasGenerated(true);
        setGenerating(false);
        return;
      }

      if (selectedKpi.key === 'kaizen') {
        const q = query(
          collection(db, 'kaizenRecords'),
          where('createdAt', '>=', fromTs),
          where('createdAt', '<=', toTs),
          orderBy('createdAt', 'desc')
        );
        const snap = await getDocs(q);
        const all: KaizenRecord[] = snap.docs.map((d) => {
          const data: any = d.data();
          return {
            id: d.id,
            sNo: data.sNo ?? 0,
            date: data.date ?? '',
            plant: data.plant ?? null,
            workshop: data.workshop ?? null,
            division: data.division ?? null,
            employeeName: data.employeeName ?? '',
            employeeCode: data.employeeCode ?? '',
            improvementIdentified: data.improvementIdentified ?? '',
            kaizenIdea: data.kaizenIdea ?? '',
            category: data.category ?? '',
            priority: data.priority ?? '',
            actionTaken: data.actionTaken ?? '',
            responsibility: data.responsibility ?? '',
            targetDate: data.targetDate ?? '',
            status: data.status ?? 'Open',
            result: data.result ?? '',
            remarks: data.remarks ?? '',
            submittedBy: data.submittedBy ?? '',
            createdAtMs: data.createdAt?.toMillis ? data.createdAt.toMillis() : null,
          };
        });
        console.log('[KPIAnalysis] fetched', all.length, 'kaizen records for', fromDate, 'to', toDate);
        setKaizenRecords(all);
        setKaizenBarTooltip(null);
        setReportKpiKey(selectedKpi.key);
        setHasGenerated(true);
        setGenerating(false);
        return;
      }

      if (selectedKpi.key === 'pcs-per-hour') {
        const q = query(
          collection(db, 'pcsManHourRecords'),
          where('createdAt', '>=', fromTs),
          where('createdAt', '<=', toTs),
          orderBy('createdAt', 'asc')
        );
        const snap = await getDocs(q);
        const days: PcsPerHourDay[] = snap.docs
          .map((d) => d.data() as any)
          .filter((data) => {
            if (plant && !sameStr(data.plant, plant)) return false;
            if (workshop && !sameStr(data.workshop, workshop)) return false;
            if (division && !sameStr(data.division, division)) return false;
            return true;
          })
          .map((data) => {
            const dateKey: string = data.date || 'unknown';
            const lines: PcsPerHourLine[] = Array.isArray(data.lines)
              ? data.lines.map((l: any) => ({
                  lineId: l.lineId ?? '',
                  lineName: l.lineName ?? 'Unknown line',
                  production: l.production ?? 0,
                  hours: l.hours ?? 0,
                  otHours: l.otHours ?? 0,
                }))
              : [];
            return {
              dateKey,
              dateLabel: dayLabelFromKey(dateKey),
              actual: data.actual ?? 0,
              manPowerTarget: data.manPowerTarget ?? 0,
              manPowerActual: data.manPowerActual ?? 0,
              avgHours: data.avgHours ?? 0,
              avgOtHours: data.otHours ?? 0,
              manHour: data.manHour ?? 0,
              pcsManHour: data.pcsManHour ?? 0,
              lines,
            };
          })
          .sort((a, b) => a.dateKey.localeCompare(b.dateKey));

        console.log('[KPIAnalysis] fetched', days.length, 'PCS Man Hour record(s) for', fromDate, 'to', toDate);
        setPcsPerHourDays(days);
        setReportKpiKey(selectedKpi.key);
        setHasGenerated(true);
        setGenerating(false);
        return;
      }

      const q = query(
        collection(db, 'productionRecords'),
        where('createdAt', '>=', fromTs),
        where('createdAt', '<=', toTs),
        orderBy('createdAt', 'asc')
      );
      const snap = await getDocs(q);

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
          productionDate: data.productionDate ?? null,
          expectedParts: data.expectedParts ?? null,
          producedThisSlot: data.producedThisSlot ?? null,
          lossParts: data.lossParts ?? null,
          lossReasonLabel: data.lossReasonLabel ?? null,
          rejections: data.rejections ?? null,
          stopEvents: Array.isArray(data.stopEvents) ? data.stopEvents : null,
          operatorCount: Array.isArray(data.operators) ? data.operators.length : 0,
          productiveMinutes: data.productiveMinutes ?? null,
          createdAtMs: data.createdAt?.toMillis ? data.createdAt.toMillis() : null,
        };
      });

      console.log('[KPIAnalysis] fetched', all.length, 'raw records for', fromDate, 'to', toDate);
      setRawRecords(all);
      setRejectionBarTooltip(null);
      setLossBarTooltip(null);
      setReportKpiKey(selectedKpi.key);
      setHasGenerated(true);
    } catch (e: any) {
      console.error('[KPIAnalysis] generate failed:', e.code, e.message, e);
      const collectionName =
        selectedKpi.key === 'attendance' ? 'attendanceRecords' :
        selectedKpi.key === 'near-miss' ? 'nearMissReports' :
        selectedKpi.key === 'man-days' ? 'manDaysRecords' :
        selectedKpi.key === 'poka-yoke' ? 'pokaYokeRecords' :
        selectedKpi.key === 'plan-vs-actual' ? 'planVsActualRecords' :
        selectedKpi.key === 'rework-pct' ? 'reworkRecords' :
        selectedKpi.key === 'kaizen' ? 'kaizenRecords' :
        'productionRecords';
      const message =
        e.code === 'permission-denied'
          ? `Permission denied reading ${collectionName}. Check your Firestore security rules.`
          : e.code === 'failed-precondition'
          ? 'This query needs a Firestore index that doesn\u2019t exist yet. Check the Metro terminal for a link to create it.'
          : e.code === 'unavailable' || e.code === 'network-request-failed'
          ? 'Network error. Check your connection and try again.'
          : `Could not load report data (${e.code ?? 'unknown error'}). Check the Metro terminal for details.`;
      setLoadError(message);
    } finally {
      setGenerating(false);
    }
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // EXPORT EXCEL
  // ─────────────────────────────────────────────────────────────────────────────
  // Builds the KPI_ANALYSIS_REPORT.xlsx workbook. This ALWAYS fetches all 10
  // KPI collections fresh for the current date range + plant/workshop/division
  // filters — it does NOT reuse whatever "Show Report" happened to load for
  // the currently-selected KPI (that only populates one collection's state;
  // the other 9 would still be empty/stale, producing fake "0 / No data"
  // sheets for KPIs the user hasn't clicked on screen). Every sheet in the
  // exported workbook therefore reflects its own real Firestore collection,
  // independent of which single KPI is on screen when Export is pressed.
  const handleExportExcel = async () => {
    if (exportingExcel) return;

    if (!isValidDateStr(fromDate) || !isValidDateStr(toDate)) {
      Alert.alert('Invalid date', 'Enter dates as YYYY-MM-DD.');
      return;
    }
    if (fromDate > toDate) {
      Alert.alert('Invalid range', '"From" date must be on or before "To" date.');
      return;
    }

    setExportingExcel(true);
    try {
      const fromTs = Timestamp.fromDate(new Date(`${fromDate}T00:00:00`));
      const toTs = Timestamp.fromDate(new Date(`${toDate}T23:59:59.999`));
      const inPWD = (p: string | null, w: string | null, d: string | null) =>
        (!plant || sameStr(p, plant)) && (!workshop || sameStr(w, workshop)) && (!division || sameStr(d, division));

      const [
        attendanceSnap, manDaysSnap, nearMissSnap, pokaYokeSnap,
        planVsActualSnap, reworkSnap, kaizenSnap, pcsSnap, productionSnap,
      ] = await Promise.all([
        getDocs(query(collection(db, 'attendanceRecords'), where('createdAt', '>=', fromTs), where('createdAt', '<=', toTs), orderBy('createdAt', 'desc'))),
        getDocs(query(collection(db, 'manDaysRecords'), where('createdAt', '>=', fromTs), where('createdAt', '<=', toTs), orderBy('createdAt', 'asc'))),
        getDocs(query(collection(db, 'nearMissReports'), where('createdAt', '>=', fromTs), where('createdAt', '<=', toTs), orderBy('createdAt', 'desc'))),
        getDocs(query(collection(db, 'pokaYokeRecords'), where('createdAt', '>=', fromTs), where('createdAt', '<=', toTs), orderBy('createdAt', 'desc'))),
        getDocs(query(collection(db, 'planVsActualRecords'), where('createdAt', '>=', fromTs), where('createdAt', '<=', toTs), orderBy('createdAt', 'desc'))),
        getDocs(query(collection(db, 'reworkRecords'), where('createdAt', '>=', fromTs), where('createdAt', '<=', toTs), orderBy('createdAt', 'desc'))),
        getDocs(query(collection(db, 'kaizenRecords'), where('createdAt', '>=', fromTs), where('createdAt', '<=', toTs), orderBy('createdAt', 'desc'))),
        getDocs(query(collection(db, 'pcsManHourRecords'), where('createdAt', '>=', fromTs), where('createdAt', '<=', toTs), orderBy('createdAt', 'asc'))),
        getDocs(query(collection(db, 'productionRecords'), where('createdAt', '>=', fromTs), where('createdAt', '<=', toTs), orderBy('createdAt', 'asc'))),
      ]);

      const attendanceForExport: AttendanceRecord[] = attendanceSnap.docs
        .map((d) => {
          const data: any = d.data();
          return {
            id: d.id,
            operatorId: data.operatorId ?? '',
            operatorName: data.operatorName ?? '',
            operatorCode: data.operatorCode ?? '',
            plant: data.plant ?? null,
            workshop: data.workshop ?? null,
            division: data.division ?? null,
            date: data.date ?? '',
            shift: data.shift ?? null,
            status: data.status ?? 'present',
            submittedBy: data.submittedBy?.name ?? '',
            createdAtMs: data.createdAt?.toMillis ? data.createdAt.toMillis() : null,
          };
        })
        .filter((r) => inPWD(r.plant, r.workshop, r.division));

      const manDaysForExport: ManDayRecord[] = manDaysSnap.docs
        .map((d) => {
          const data: any = d.data();
          return {
            id: d.id,
            plant: data.plant ?? '',
            workshop: data.workshop ?? '',
            division: data.division ?? '',
            dateISO: data.dateISO ?? '',
            dateDisplay: data.dateDisplay ?? '',
            dayOfWeek: data.dayOfWeek ?? '',
            month: data.month ?? '',
            present: data.present ?? 0,
            absent: data.absent ?? 0,
            onLeave: data.onLeave ?? 0,
            totalPresent: data.totalPresent ?? 0,
            remarks: data.remarks ?? '',
            submittedBy: data.submittedBy ?? '',
            createdAtMs: data.createdAt?.toMillis ? data.createdAt.toMillis() : null,
          };
        })
        .filter((r) => inPWD(r.plant, r.workshop, r.division));

      const nearMissForExport: NearMissRecord[] = nearMissSnap.docs
        .map((d) => {
          const data: any = d.data();
          return {
            id: d.id,
            date: data.date ?? '',
            plant: data.plant ?? null,
            workshop: data.workshop ?? null,
            division: data.division ?? null,
            areaMachine: data.areaMachine ?? '',
            intensity: data.intensity ?? 'Low',
            description: data.description ?? '',
            actionTaken: data.actionTaken ?? '',
            tdc: data.tdc ?? '',
            status: data.status ?? 'Open',
            responsibility: data.responsibility ?? '',
            closedOn: data.closedOn ?? '',
            submittedBy: data.submittedBy ?? '',
            createdAtMs: data.createdAt?.toMillis ? data.createdAt.toMillis() : null,
          };
        })
        .filter((r) => inPWD(r.plant, r.workshop, r.division));

      const pokaYokeForExport: PokaYokeRecord[] = pokaYokeSnap.docs
        .map((d) => {
          const data: any = d.data();
          return {
            id: d.id,
            sNo: data.sNo ?? null,
            plant: data.plant ?? null,
            workshop: data.workshop ?? null,
            division: data.division ?? null,
            lineName: data.lineName ?? '',
            lineNo: data.lineNo ?? '',
            partsName: data.partsName ?? '',
            model: data.model ?? '',
            pokaYokeNo: data.pokaYokeNo ?? '',
            pokaYokeDetails: data.pokaYokeDetails ?? '',
            problem: data.problem ?? '',
            rootCause: data.rootCause ?? '',
            actionPlan: data.actionPlan ?? '',
            responsibility: data.responsibility ?? '',
            targetDate: data.targetDate ?? '',
            status: data.status ?? 'Open',
            submittedBy: data.submittedBy ?? '',
            createdAtMs: data.createdAt?.toMillis ? data.createdAt.toMillis() : null,
          };
        })
        .filter((r) => inPWD(r.plant, r.workshop, r.division));

      const planVsActualForExport: PlanVsActualRecord[] = planVsActualSnap.docs
        .map((d) => {
          const data: any = d.data();
          return {
            id: d.id,
            date: data.date ?? '',
            plant: data.plant ?? null,
            workshop: data.workshop ?? null,
            division: data.division ?? null,
            shift: data.shift ?? null,
            lineName: data.lineName ?? '',
            planned: data.planned ?? 0,
            actual: data.actual ?? 0,
            loss: data.loss ?? 0,
            productionPct: data.productionPct ?? 0,
            submittedBy: data.submittedBy ?? '',
            createdAtMs: data.createdAt?.toMillis ? data.createdAt.toMillis() : null,
          };
        })
        .filter((r) => inPWD(r.plant, r.workshop, r.division));

      const reworkForExport: ReworkRecord[] = reworkSnap.docs
        .map((d) => {
          const data: any = d.data();
          return {
            id: d.id,
            date: data.date ?? '',
            plant: data.plant ?? null,
            workshop: data.workshop ?? null,
            division: data.division ?? null,
            shift: data.shift ?? null,
            lineName: data.lineName ?? '',
            totalProduction: data.totalProduction ?? 0,
            reworkCount: data.reworkCount ?? 0,
            reworkPct: data.reworkPct ?? 0,
            submittedBy: data.submittedBy ?? '',
            createdAtMs: data.createdAt?.toMillis ? data.createdAt.toMillis() : null,
          };
        })
        .filter((r) => inPWD(r.plant, r.workshop, r.division));

      const kaizenForExport: KaizenRecord[] = kaizenSnap.docs
        .map((d) => {
          const data: any = d.data();
          return {
            id: d.id,
            sNo: data.sNo ?? 0,
            date: data.date ?? '',
            plant: data.plant ?? null,
            workshop: data.workshop ?? null,
            division: data.division ?? null,
            employeeName: data.employeeName ?? '',
            employeeCode: data.employeeCode ?? '',
            improvementIdentified: data.improvementIdentified ?? '',
            kaizenIdea: data.kaizenIdea ?? '',
            category: data.category ?? '',
            priority: data.priority ?? '',
            actionTaken: data.actionTaken ?? '',
            responsibility: data.responsibility ?? '',
            targetDate: data.targetDate ?? '',
            status: data.status ?? 'Open',
            result: data.result ?? '',
            remarks: data.remarks ?? '',
            submittedBy: data.submittedBy ?? '',
            createdAtMs: data.createdAt?.toMillis ? data.createdAt.toMillis() : null,
          };
        })
        .filter((r) => inPWD(r.plant, r.workshop, r.division));

      const pcsPerHourForExport: PcsPerHourDay[] = pcsSnap.docs
        .map((d) => d.data() as any)
        .filter((data) => inPWD(data.plant ?? null, data.workshop ?? null, data.division ?? null))
        .map((data) => {
          const dateKey: string = data.date || 'unknown';
          const lines: PcsPerHourLine[] = Array.isArray(data.lines)
            ? data.lines.map((l: any) => ({
                lineId: l.lineId ?? '',
                lineName: l.lineName ?? 'Unknown line',
                production: l.production ?? 0,
                hours: l.hours ?? 0,
                otHours: l.otHours ?? 0,
              }))
            : [];
          return {
            dateKey,
            dateLabel: dayLabelFromKey(dateKey),
            actual: data.actual ?? 0,
            manPowerTarget: data.manPowerTarget ?? 0,
            manPowerActual: data.manPowerActual ?? 0,
            avgHours: data.avgHours ?? 0,
            avgOtHours: data.otHours ?? 0,
            manHour: data.manHour ?? 0,
            pcsManHour: data.pcsManHour ?? 0,
            lines,
          };
        })
        .sort((a, b) => a.dateKey.localeCompare(b.dateKey));

      const productionForExport: ProductionRecord[] = productionSnap.docs
        .map((d) => {
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
            lossReasonLabel: data.lossReasonLabel ?? null,
            rejections: data.rejections ?? null,
            stopEvents: Array.isArray(data.stopEvents) ? data.stopEvents : null,
            operatorCount: Array.isArray(data.operators) ? data.operators.length : 0,
            productiveMinutes: data.productiveMinutes ?? null,
            createdAtMs: data.createdAt?.toMillis ? data.createdAt.toMillis() : null,
          };
        })
        .filter((r) => inPWD(r.plant, r.workshop, r.division));

      await exportKpiAnalysisToExcel({
        filters: { plant, workshop, division, fromDate, toDate },
        pcsPerHourDays: pcsPerHourForExport,
        planVsActualRecords: planVsActualForExport,
        productionRecords: productionForExport,
        nearMissRecords: nearMissForExport,
        manDaysRecords: manDaysForExport,
        pokaYokeRecords: pokaYokeForExport,
        reworkRecords: reworkForExport,
        kaizenRecords: kaizenForExport,
        attendanceRecords: attendanceForExport,
      });

      Alert.alert(
        'Export complete',
        Platform.OS === 'web' ? 'The Excel file has downloaded.' : 'Choose where to save or send the Excel file.'
      );
    } catch (e) {
      console.error('[KPIAnalysis] excel export', e);
      Alert.alert('Export failed', 'Could not generate the Excel file. Please try again.');
    } finally {
      setExportingExcel(false);
    }
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // AGGREGATES — computed once per line, reused across all 4 computable KPIs
  // ─────────────────────────────────────────────────────────────────────────────

  const byLine = useMemo<LineBreakdown[]>(() => {
    const map = new Map<string, LineBreakdown>();
    filteredRecords.forEach((r) => {
      const key = r.lineId ?? 'unknown';
      const downtime = (r.stopEvents ?? []).reduce((sum, se) => sum + (se.durationMinutes ?? 0), 0);
      const operatorHours = (r.operatorCount || 0) * ((r.productiveMinutes ?? 0) / 60);
      const existing = map.get(key);
      if (existing) {
        existing.plan += r.expectedParts ?? 0;
        existing.actual += r.producedThisSlot ?? 0;
        existing.rejections += r.rejections ?? 0;
        existing.operatorHours += operatorHours;
        existing.downtimeMinutes += downtime;
      } else {
        map.set(key, {
          lineId: key,
          lineName: r.lineName ?? 'Unknown line',
          plan: r.expectedParts ?? 0,
          actual: r.producedThisSlot ?? 0,
          rejections: r.rejections ?? 0,
          operatorHours,
          downtimeMinutes: downtime,
        });
      }
    });
    return Array.from(map.values()).sort((a, b) => a.lineName.localeCompare(b.lineName));
  }, [filteredRecords]);

  const lossByReason = useMemo(() => {
    const map = new Map<string, number>();
    filteredRecords.forEach((r) => {
      (r.stopEvents ?? []).forEach((se) => {
        map.set(se.reason, (map.get(se.reason) ?? 0) + (se.durationMinutes ?? 0));
      });
    });
    return Array.from(map.entries())
      .map(([reason, minutes]) => ({ reason, minutes: Math.round(minutes) }))
      .sort((a, b) => b.minutes - a.minutes);
  }, [filteredRecords]);

  // Loss Reason (pieces, not downtime) — for the "Loss Reason" donut. A
  // shortfall can happen with NO downtime logged at all (e.g. a power
  // failure the supervisor confirmed through RecordProductionScreen's
  // LOSS_REASONS picker but never opened a stop event for), so this can't
  // be derived from stopEvents alone the way lossByReason (downtime, above)
  // is. Groups each record's lossParts by lossReasonLabel — the supervisor's
  // explicit reason — falling back to the stop-event reasons only when no
  // manual reason was given, and "Unspecified" only as a last resort. Same
  // precedence GenerateReportScreen's Loss Analysis chart uses, so the two
  // screens agree on totals.
  const lossPartsByReason = useMemo(() => {
    const map = new Map<string, number>();
    filteredRecords.forEach((r) => {
      const loss = r.lossParts ?? Math.max(0, (r.expectedParts ?? 0) - (r.producedThisSlot ?? 0));
      if (loss <= 0) return;
      const reason = r.lossReasonLabel || deriveReasonFromStops(r.stopEvents) || 'Unspecified';
      map.set(reason, (map.get(reason) ?? 0) + loss);
    });
    return Array.from(map.entries())
      .map(([reason, parts]) => ({ reason, parts: Math.round(parts) }))
      .sort((a, b) => b.parts - a.parts);
  }, [filteredRecords]);

  // Rejections by Part — same shape as byLine, grouped by partName instead
  // of line. A record with no part logged (older sessions, or a line with
  // no configured parts) is bucketed under "Unspecified" so it isn't
  // silently dropped from the chart.
  const rejectionByPart = useMemo(() => {
    const map = new Map<string, { produced: number; rejections: number }>();
    filteredRecords.forEach((r) => {
      const key = r.partName || 'Unspecified';
      const produced = r.producedThisSlot ?? 0;
      const rejections = r.rejections ?? 0;
      const existing = map.get(key);
      if (existing) {
        existing.produced += produced;
        existing.rejections += rejections;
      } else {
        map.set(key, { produced, rejections });
      }
    });
    return Array.from(map.entries())
      .map(([partName, v]) => ({
        partName,
        rejections: v.rejections,
        rejectionPct: v.produced + v.rejections > 0 ? round1((v.rejections / (v.produced + v.rejections)) * 100) : 0,
      }))
      .sort((a, b) => b.rejections - a.rejections);
  }, [filteredRecords]);

  // Rejection % trend — grouped by productionDate (falling back to the
  // calendar day of createdAtMs for older records saved before that field
  // existed — see ProductionRecord.productionDate).
  const rejectionByDate = useMemo(() => {
    const map = new Map<string, { produced: number; rejections: number }>();
    filteredRecords.forEach((r) => {
      const key = r.productionDate ?? dateKeyFromMs(r.createdAtMs);
      const produced = r.producedThisSlot ?? 0;
      const rejections = r.rejections ?? 0;
      const existing = map.get(key);
      if (existing) {
        existing.produced += produced;
        existing.rejections += rejections;
      } else {
        map.set(key, { produced, rejections });
      }
    });
    return Array.from(map.entries())
      .filter(([date]) => date !== 'unknown')
      .map(([date, v]) => ({
        date,
        dateLabel: dayLabelFromKey(date),
        rejections: v.rejections,
        rejectionPct: v.produced + v.rejections > 0 ? round1((v.rejections / (v.produced + v.rejections)) * 100) : 0,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }, [filteredRecords]);

  // Loss trend — lost pieces (plan − actual, floored at 0) per day, the
  // same figure behind the "Est. Lost Pieces" stat card, just broken out
  // over time instead of summed for the whole range.
  const lossByDate = useMemo(() => {
    const map = new Map<string, { plan: number; actual: number; downtimeMinutes: number }>();
    filteredRecords.forEach((r) => {
      const key = r.productionDate ?? dateKeyFromMs(r.createdAtMs);
      const plan = r.expectedParts ?? 0;
      const actual = r.producedThisSlot ?? 0;
      const downtime = (r.stopEvents ?? []).reduce((sum, se) => sum + (se.durationMinutes ?? 0), 0);
      const existing = map.get(key);
      if (existing) {
        existing.plan += plan;
        existing.actual += actual;
        existing.downtimeMinutes += downtime;
      } else {
        map.set(key, { plan, actual, downtimeMinutes: downtime });
      }
    });
    return Array.from(map.entries())
      .filter(([date]) => date !== 'unknown')
      .map(([date, v]) => ({
        date,
        dateLabel: dayLabelFromKey(date),
        lostPieces: Math.max(0, v.plan - v.actual),
        downtimeMinutes: Math.round(v.downtimeMinutes),
      }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }, [filteredRecords]);

  const totals = useMemo(() => {
    const plan = byLine.reduce((s, b) => s + b.plan, 0);
    const actual = byLine.reduce((s, b) => s + b.actual, 0);
    const rejections = byLine.reduce((s, b) => s + b.rejections, 0);
    const operatorHours = byLine.reduce((s, b) => s + b.operatorHours, 0);
    const downtimeMinutes = byLine.reduce((s, b) => s + b.downtimeMinutes, 0);
    const lostPieces = byLine.reduce((s, b) => s + Math.max(0, b.plan - b.actual), 0);
    return {
      plan, actual, rejections, operatorHours: round1(operatorHours), downtimeMinutes: Math.round(downtimeMinutes),
      achievementPct: plan > 0 ? round1((actual / plan) * 100) : 0,
      rejectionPct: actual + rejections > 0 ? round1((rejections / (actual + rejections)) * 100) : 0,
      pcsPerManHour: operatorHours > 0 ? round1(actual / operatorHours) : 0,
      lostPieces,
    };
  }, [byLine]);

  // Aggregate across every day fetched for PCS Man Per Hour
  const pcsPerHourTotals = useMemo(() => {
    const totalActual = pcsPerHourDays.reduce((s, d) => s + d.actual, 0);
    const totalManHour = pcsPerHourDays.reduce((s, d) => s + d.manHour, 0);
    const avgManPowerActual = pcsPerHourDays.length > 0
      ? round1(pcsPerHourDays.reduce((s, d) => s + d.manPowerActual, 0) / pcsPerHourDays.length)
      : 0;
    const avgOtHours = pcsPerHourDays.length > 0
      ? round1(pcsPerHourDays.reduce((s, d) => s + d.avgOtHours, 0) / pcsPerHourDays.length)
      : 0;
    return {
      totalActual,
      totalManHour: round1(totalManHour),
      pcsManHour: totalManHour > 0 ? round1(totalActual / totalManHour) : 0,
      avgManPowerActual,
      avgOtHours,
      days: pcsPerHourDays.length,
    };
  }, [pcsPerHourDays]);

  // ─────────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <Pressable onPress={() => navigation.goBack()} style={styles.backButton} hitSlop={12}>
          <Ionicons name="arrow-back" size={22} color="#8A96A3" />
          <Text style={styles.backText}>Back</Text>
        </Pressable>

        <Text style={styles.title}>KPI Analysis</Text>
        <Text style={styles.subtitle}>Pick a plant, workshop, division and KPI, then show the report</Text>

        {/* FILTERS */}
        <Text style={styles.sectionLabel}>FILTERS</Text>

        <View style={styles.field}>
          <Text style={styles.fieldLabel}>Plant</Text>
          <View style={styles.chipsRow}>
            <Pressable style={[styles.chip, !plant && styles.chipSelected]} onPress={() => setPlant(null)}>
              <Text style={[styles.chipText, !plant && styles.chipTextSelected]}>Any</Text>
            </Pressable>
            {PLANTS.map((p) => (
              <Pressable key={p} onPress={() => setPlant(plant === p ? null : p)} style={[styles.chip, plant === p && styles.chipSelected]}>
                <Text style={[styles.chipText, plant === p && styles.chipTextSelected]}>{p}</Text>
              </Pressable>
            ))}
          </View>
        </View>

        <View style={styles.field}>
          <Text style={styles.fieldLabel}>Workshop</Text>
          <View style={styles.chipsRow}>
            <Pressable style={[styles.chip, !workshop && styles.chipSelected]} onPress={() => setWorkshop(null)}>
              <Text style={[styles.chipText, !workshop && styles.chipTextSelected]}>Any</Text>
            </Pressable>
            {WORKSHOPS.map((w) => (
              <Pressable key={w} onPress={() => setWorkshop(workshop === w ? null : w)} style={[styles.chip, workshop === w && styles.chipSelected]}>
                <Text style={[styles.chipText, workshop === w && styles.chipTextSelected]}>{w}</Text>
              </Pressable>
            ))}
          </View>
        </View>

        <View style={styles.field}>
          <Text style={styles.fieldLabel}>Division</Text>
          <View style={styles.chipsRow}>
            <Pressable style={[styles.chip, !division && styles.chipSelected]} onPress={() => setDivision(null)}>
              <Text style={[styles.chipText, !division && styles.chipTextSelected]}>Any</Text>
            </Pressable>
            {DIVISIONS.map((d) => (
              <Pressable key={d} onPress={() => setDivision(division === d ? null : d)} style={[styles.chip, division === d && styles.chipSelected]}>
                <Text style={[styles.chipText, division === d && styles.chipTextSelected]}>{d}</Text>
              </Pressable>
            ))}
          </View>
        </View>

        <View style={styles.rowGap}>
          <View style={{ flex: 1 }}>
            <Text style={styles.fieldLabel}>From</Text>
            <TextInput style={styles.input} value={fromDate} onChangeText={(text) => setFromDate(formatDateInput(text))} placeholder="YYYY-MM-DD" placeholderTextColor="#5C6670" autoCapitalize="none" keyboardType="number-pad" maxLength={10} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.fieldLabel}>To</Text>
            <TextInput style={styles.input} value={toDate} onChangeText={(text) => setToDate(formatDateInput(text))} placeholder="YYYY-MM-DD" placeholderTextColor="#5C6670" autoCapitalize="none" keyboardType="number-pad" maxLength={10} />
          </View>
        </View>

        {/* KPI SELECTION */}
        <Text style={[styles.sectionLabel, { marginTop: 18 }]}>SELECT KPI</Text>
        <View style={styles.chipsRow}>
          {KPI_OPTIONS.map((k) => (
            <Pressable
              key={k.key}
              onPress={() => setSelectedKpiKey(selectedKpiKey === k.key ? null : k.key)}
              style={[
                styles.kpiChip,
                selectedKpiKey === k.key && { borderColor: k.accent, backgroundColor: k.accent + '22' },
              ]}
            >
              <Ionicons name={k.icon} size={15} color={selectedKpiKey === k.key ? k.accent : '#8A96A3'} />
              <Text style={[styles.chipText, selectedKpiKey === k.key && { color: k.accent }]}>{k.title}</Text>
            </Pressable>
          ))}
        </View>

        {/* SHOW REPORT BUTTON */}
        <Pressable
          style={({ pressed }) => [styles.showReportButton, (generating || pressed) && styles.showReportButtonPressed]}
          onPress={handleShowReport}
          disabled={generating}
        >
          {generating ? (
            <ActivityIndicator color="#14181C" />
          ) : (
            <>
              <Ionicons name="stats-chart" size={20} color="#14181C" />
              <Text style={styles.showReportButtonText}>Show Report</Text>
            </>
          )}
        </Pressable>

        {loadError && (
          <View style={styles.centered}>
            <Ionicons name="alert-circle" size={22} color="#D64545" />
            <Text style={styles.errorText}>{loadError}</Text>
            <Pressable onPress={handleShowReport} style={styles.retryButton}>
              <Text style={styles.retryText}>Retry</Text>
            </Pressable>
          </View>
        )}

        {/* RESULTS */}
        {hasGenerated && !loadError && reportKpiKey && (
          (reportKpiKey === 'attendance' ? filteredAttendance.length === 0
            : reportKpiKey === 'near-miss' ? filteredNearMiss.length === 0
            : reportKpiKey === 'man-days' ? filteredManDays.length === 0
            : reportKpiKey === 'poka-yoke' ? filteredPokaYoke.length === 0
            : reportKpiKey === 'plan-vs-actual' ? filteredPlanVsActual.length === 0
            : reportKpiKey === 'rework-pct' ? filteredRework.length === 0
            : reportKpiKey === 'kaizen' ? filteredKaizen.length === 0
            : reportKpiKey === 'pcs-per-hour' ? pcsPerHourDays.length === 0
            : filteredRecords.length === 0) ? (
            <View style={styles.centered}>
              <Ionicons name="document-text-outline" size={28} color="#5C6670" />
              <Text style={styles.emptyText}>
                {reportKpiKey === 'attendance'
                  ? 'No attendance records match these filters for this date range.'
                  : reportKpiKey === 'near-miss'
                  ? 'No near-miss reports match these filters for this date range.'
                  : reportKpiKey === 'man-days'
                  ? 'No man-days records match these filters for this date range.'
                  : reportKpiKey === 'poka-yoke'
                  ? 'No poka-yoke records match these filters for this date range.'
                  : reportKpiKey === 'plan-vs-actual'
                  ? 'No Plan vs Actual records match these filters for this date range.'
                  : reportKpiKey === 'rework-pct'
                  ? 'No rework records match these filters for this date range.'
                  : reportKpiKey === 'kaizen'
                  ? 'No Kaizen records match these filters for this date range.'
                  : reportKpiKey === 'pcs-per-hour'
                  ? 'No PCS Man Hour data has been pushed for these filters in this date range. Push it from the PCS Man Per Hour screen first.'
                  : 'No production records match these filters for this date range.'}
              </Text>
            </View>
          ) : (
            <>
              <View style={[styles.resultsHeader, { marginTop: 22 }]}>
                <Text style={styles.sectionLabel}>
                  {KPI_OPTIONS.find((k) => k.key === reportKpiKey)?.title.toUpperCase()}
                </Text>
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
              </View>

              {/* ── Near-Miss Report */}
              {reportKpiKey === 'near-miss' && (
                <>
                  <View style={styles.statGrid}>
                    <View style={styles.statCard}>
                      <Text style={styles.statValue}>{filteredNearMiss.length}</Text>
                      <Text style={styles.statLabel}>Total Reports</Text>
                    </View>
                    <View style={styles.statCard}>
                      <Text style={[styles.statValue, { color: '#D64545' }]}>
                        {filteredNearMiss.filter((r) => r.status === 'Open').length}
                      </Text>
                      <Text style={styles.statLabel}>Open</Text>
                    </View>
                    <View style={styles.statCard}>
                      <Text style={[styles.statValue, { color: '#4C9A6A' }]}>
                        {filteredNearMiss.filter((r) => r.status === 'Closed').length}
                      </Text>
                      <Text style={styles.statLabel}>Closed</Text>
                    </View>
                  </View>

                  <Text style={[styles.fieldLabel, { marginTop: 14, marginBottom: 8 }]}>BY INTENSITY</Text>
                  <View style={styles.statGrid}>
                    {(['Low', 'Medium', 'High', 'Critical'] as NearMissIntensity[]).map((level) => {
                      const count = filteredNearMiss.filter((r) => r.intensity === level).length;
                      return (
                        <View key={level} style={styles.statCard}>
                          <Text style={[styles.statValue, { color: NEAR_MISS_INTENSITY_COLOR[level] }]}>{count}</Text>
                          <Text style={styles.statLabel}>{level}</Text>
                        </View>
                      );
                    })}
                  </View>

                  {/* Chart 1 — Near Miss by Severity */}
                  <ChartCard
                    title="Near Miss by Severity"
                    subtitle="Reports grouped by intensity, this date range"
                    legend={nearMissTotals.bySeverity.map((s) => ({ color: NEAR_MISS_INTENSITY_COLOR[s.level], label: `${s.level} (${s.count})` }))}
                    hasData={nearMissTotals.bySeverity.length > 0}
                  >
                    <View style={{ alignItems: 'center', paddingVertical: 4 }}>
                      <PieChart
                        data={nearMissTotals.bySeverity.map((s) => ({
                          value: s.count,
                          color: NEAR_MISS_INTENSITY_COLOR[s.level],
                          text: s.level,
                        }))}
                        donut
                        radius={90}
                        innerRadius={54}
                        innerCircleColor="#1D2329"
                        centerLabelComponent={() => (
                          <View style={{ alignItems: 'center' }}>
                            <Text style={{ color: '#ECEFF2', fontSize: 18, fontWeight: '800' }}>{filteredNearMiss.length}</Text>
                            <Text style={{ color: '#8A96A3', fontSize: 10 }}>reports</Text>
                          </View>
                        )}
                      />
                    </View>
                  </ChartCard>

                  {/* Chart 2 — Near Miss by Status */}
                  <ChartCard
                    title="Near Miss by Status"
                    subtitle="Reports grouped by status, this date range"
                    xAxisLabel="Reports"
                    yAxisLabel="Status"
                    hasData={nearMissTotals.byStatus.length > 0}
                  >
                    <View style={{ width: '100%' }}>
                      {nearMissTotals.byStatus.map((s) => (
                        <MetricBarRow
                          key={s.status}
                          label={s.status}
                          value={s.count}
                          maxValue={Math.max(1, ...nearMissTotals.byStatus.map((x) => x.count))}
                          color={NEAR_MISS_STATUS_COLOR[s.status]}
                          valueLabel={String(s.count)}
                          onPress={() => setNearMissBarTooltip({ label: s.status, lines: [`${s.count} report${s.count === 1 ? '' : 's'}`] })}
                        />
                      ))}
                    </View>
                  </ChartCard>
                  {nearMissBarTooltip && (
                    <View style={styles.chartTooltipInline}>
                      <Text style={styles.chartTooltipTitle}>{nearMissBarTooltip.label}</Text>
                      {nearMissBarTooltip.lines.map((l) => (
                        <Text key={l} style={styles.chartTooltipText}>{l}</Text>
                      ))}
                    </View>
                  )}

                  {/* Chart 3 — Monthly Trend */}
                  <ChartCard
                    title="Monthly Trend"
                    subtitle="Near-miss reports logged per month"
                    xAxisLabel="Month"
                    yAxisLabel="Reports"
                    legend={[{ color: '#D64545', label: 'Reports' }]}
                    hasData={nearMissTotals.byMonth.length > 0}
                  >
                    <LineChart
                      data={nearMissTotals.byMonth.map((m) => ({
                        value: m.count,
                        label: m.label,
                        labelTextStyle: { color: CHART_COLORS.axisText, fontSize: 9 },
                        dataPointText: String(m.count),
                      }))}
                      color="#D64545"
                      dataPointsColor="#D64545"
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
                      startFillColor="#D64545"
                      startOpacity={0.15}
                      endOpacity={0.02}
                    />
                  </ChartCard>

                  <Text style={[styles.fieldLabel, { marginTop: 14, marginBottom: 8 }]}>REPORTS</Text>
                  {filteredNearMiss.map((r) => (
                    <View key={r.id} style={styles.nearMissCard}>
                      <View style={styles.nearMissTopRow}>
                        <Text style={styles.nearMissArea}>{r.areaMachine || 'Unspecified area'}</Text>
                        <View
                          style={[
                            styles.nearMissBadge,
                            { borderColor: NEAR_MISS_INTENSITY_COLOR[r.intensity], backgroundColor: NEAR_MISS_INTENSITY_COLOR[r.intensity] + '22' },
                          ]}
                        >
                          <Text style={[styles.nearMissBadgeText, { color: NEAR_MISS_INTENSITY_COLOR[r.intensity] }]}>
                            {r.intensity}
                          </Text>
                        </View>
                      </View>
                      <Text style={styles.nearMissMeta}>
                        {[r.plant, r.workshop, r.division].filter(Boolean).join(' · ')} {r.date ? `· ${r.date}` : ''}
                      </Text>

                      {!!r.description && (
                        <View style={styles.nearMissField}>
                          <Text style={styles.nearMissFieldLabel}>DESCRIPTION</Text>
                          <Text style={styles.nearMissDesc}>{r.description}</Text>
                        </View>
                      )}

                      {!!r.actionTaken && (
                        <View style={styles.nearMissField}>
                          <Text style={styles.nearMissFieldLabel}>ACTION TAKEN</Text>
                          <Text style={styles.nearMissDesc}>{r.actionTaken}</Text>
                        </View>
                      )}

                      <View style={styles.nearMissDetailGrid}>
                        <View style={styles.nearMissDetailItem}>
                          <Text style={styles.nearMissFieldLabel}>RESPONSIBILITY</Text>
                          <Text style={styles.nearMissDetailValue}>{r.responsibility || '—'}</Text>
                        </View>
                        <View style={styles.nearMissDetailItem}>
                          <Text style={styles.nearMissFieldLabel}>TDC</Text>
                          <Text style={styles.nearMissDetailValue}>{r.tdc || '—'}</Text>
                        </View>
                        <View style={styles.nearMissDetailItem}>
                          <Text style={styles.nearMissFieldLabel}>CLOSED ON</Text>
                          <Text style={styles.nearMissDetailValue}>{r.closedOn || '—'}</Text>
                        </View>
                      </View>

                      <View style={styles.nearMissFooter}>
                        <View
                          style={[
                            styles.nearMissStatusBadge,
                            { borderColor: NEAR_MISS_STATUS_COLOR[r.status], backgroundColor: NEAR_MISS_STATUS_COLOR[r.status] + '22' },
                          ]}
                        >
                          <Text style={[styles.nearMissStatusText, { color: NEAR_MISS_STATUS_COLOR[r.status] }]}>{r.status}</Text>
                        </View>
                        {!!r.submittedBy && <Text style={styles.nearMissSubmitter}>By {r.submittedBy}</Text>}
                      </View>
                    </View>
                  ))}
                </>
              )}

              {/* ── Poka Yoke Breakdown Tracker */}
              {reportKpiKey === 'poka-yoke' && (
                <>
                  <View style={styles.statGrid}>
                    <View style={styles.statCard}>
                      <Text style={styles.statValue}>{filteredPokaYoke.length}</Text>
                      <Text style={styles.statLabel}>Total Records</Text>
                    </View>
                    <View style={styles.statCard}>
                      <Text style={[styles.statValue, { color: '#D64545' }]}>
                        {filteredPokaYoke.filter((r) => r.status === 'Open').length}
                      </Text>
                      <Text style={styles.statLabel}>Open</Text>
                    </View>
                    <View style={styles.statCard}>
                      <Text style={[styles.statValue, { color: '#F2A93B' }]}>
                        {filteredPokaYoke.filter((r) => r.status === 'In Progress').length}
                      </Text>
                      <Text style={styles.statLabel}>In Progress</Text>
                    </View>
                    <View style={styles.statCard}>
                      <Text style={[styles.statValue, { color: '#4C9A6A' }]}>
                        {filteredPokaYoke.filter((r) => r.status === 'Closed').length}
                      </Text>
                      <Text style={styles.statLabel}>Closed</Text>
                    </View>
                  </View>

                  {/* Chart 1 — Status Distribution */}
                  <ChartCard
                    title="Status Distribution"
                    subtitle="Poka Yoke records grouped by status, this date range"
                    legend={pokaYokeTotals.byStatus.map((s) => ({ color: POKA_YOKE_STATUS_COLOR[s.status], label: `${s.status} (${s.count})` }))}
                    hasData={pokaYokeTotals.byStatus.length > 0}
                  >
                    <View style={{ alignItems: 'center', paddingVertical: 4 }}>
                      <PieChart
                        data={pokaYokeTotals.byStatus.map((s) => ({
                          value: s.count,
                          color: POKA_YOKE_STATUS_COLOR[s.status],
                          text: s.status,
                        }))}
                        donut
                        radius={90}
                        innerRadius={54}
                        innerCircleColor="#1D2329"
                        centerLabelComponent={() => (
                          <View style={{ alignItems: 'center' }}>
                            <Text style={{ color: '#ECEFF2', fontSize: 18, fontWeight: '800' }}>{filteredPokaYoke.length}</Text>
                            <Text style={{ color: '#8A96A3', fontSize: 10 }}>records</Text>
                          </View>
                        )}
                      />
                    </View>
                  </ChartCard>

                  {/* Chart 2 — Poka Yoke by Line */}
                  <ChartCard
                    title="Poka Yoke by Line"
                    subtitle="Records per line, this date range"
                    xAxisLabel="Line"
                    yAxisLabel="Records"
                    legend={[{ color: '#4C9A6A', label: 'Records' }]}
                    hasData={pokaYokeTotals.byLine.length > 0}
                  >
                    <BarChart
                      data={pokaYokeTotals.byLine.map((l) => ({
                        value: l.count,
                        label: l.lineName,
                        labelTextStyle: { color: CHART_COLORS.axisText, fontSize: 9 },
                        frontColor: '#4C9A6A',
                        onPress: () => setPokaYokeBarTooltip({ label: l.lineName, lines: [`${l.count} record${l.count === 1 ? '' : 's'}`] }),
                      }))}
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
                  {pokaYokeBarTooltip && (
                    <View style={styles.chartTooltipInline}>
                      <Text style={styles.chartTooltipTitle}>{pokaYokeBarTooltip.label}</Text>
                      {pokaYokeBarTooltip.lines.map((l) => (
                        <Text key={l} style={styles.chartTooltipText}>{l}</Text>
                      ))}
                    </View>
                  )}

                  {/* Chart 3 — Open vs Closed Trend */}
                  <ChartCard
                    title="Open vs Closed Trend"
                    subtitle="Open (incl. In Progress) vs Closed records, by month logged"
                    xAxisLabel="Month"
                    yAxisLabel="Records"
                    legend={[
                      { color: POKA_YOKE_STATUS_COLOR.Open, label: 'Open' },
                      { color: POKA_YOKE_STATUS_COLOR.Closed, label: 'Closed' },
                    ]}
                    hasData={pokaYokeTotals.openVsClosedTrend.length > 0}
                  >
                    <LineChart
                      data={pokaYokeTotals.openVsClosedTrend.map((m) => ({
                        value: m.open,
                        label: m.label,
                        labelTextStyle: { color: CHART_COLORS.axisText, fontSize: 9 },
                      }))}
                      data2={pokaYokeTotals.openVsClosedTrend.map((m) => ({ value: m.closed }))}
                      color1={POKA_YOKE_STATUS_COLOR.Open}
                      color2={POKA_YOKE_STATUS_COLOR.Closed}
                      dataPointsColor1={POKA_YOKE_STATUS_COLOR.Open}
                      dataPointsColor2={POKA_YOKE_STATUS_COLOR.Closed}
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
                      pointerConfig={{
                        pointerStripHeight: 160,
                        pointerStripColor: CHART_COLORS.grid,
                        pointerStripWidth: 2,
                        pointerColor: POKA_YOKE_STATUS_COLOR.Open,
                        radius: 5,
                        pointerLabelWidth: 130,
                        pointerLabelHeight: 70,
                        activatePointersOnLongPress: false,
                        autoAdjustPointerLabelPosition: true,
                        pointerLabelComponent: (items: any[]) => (
                          <View style={styles.chartTooltip}>
                            <Text style={styles.chartTooltipTitle}>{pokaYokeTotals.openVsClosedTrend[items?.[0]?.index ?? 0]?.label ?? ''}</Text>
                            <Text style={[styles.chartTooltipText, { color: POKA_YOKE_STATUS_COLOR.Open }]}>Open: {items?.[0]?.value ?? 0}</Text>
                            <Text style={[styles.chartTooltipText, { color: POKA_YOKE_STATUS_COLOR.Closed }]}>Closed: {items?.[1]?.value ?? 0}</Text>
                          </View>
                        ),
                      }}
                    />
                  </ChartCard>

                  <Text style={[styles.fieldLabel, { marginTop: 14, marginBottom: 8 }]}>RECORDS</Text>
                  {filteredPokaYoke.map((r) => (
                    <View key={r.id} style={styles.pokaYokeCard}>
                      <View style={styles.pokaYokeTopRow}>
                        <Text style={styles.pokaYokeTitle}>
                          {r.lineName || 'Unnamed line'}{r.partsName ? ` · ${r.partsName}` : ''}
                        </Text>
                        <View
                          style={[
                            styles.pokaYokeBadge,
                            { borderColor: POKA_YOKE_STATUS_COLOR[r.status], backgroundColor: POKA_YOKE_STATUS_COLOR[r.status] + '22' },
                          ]}
                        >
                          <Text style={[styles.pokaYokeBadgeText, { color: POKA_YOKE_STATUS_COLOR[r.status] }]}>{r.status}</Text>
                        </View>
                      </View>
                      <Text style={styles.pokaYokeMeta}>
                        {[r.plant, r.workshop, r.division].filter(Boolean).join(' · ')}
                        {r.model ? ` · ${r.model}` : ''}
                        {r.lineNo ? ` · Line ${r.lineNo}` : ''}
                      </Text>

                      {!!r.pokaYokeNo && <Text style={styles.pokaYokeDetail}>Poka Yoke No: {r.pokaYokeNo}</Text>}
                      {!!r.problem && (
                        <View style={styles.pokaYokeField}>
                          <Text style={styles.pokaYokeFieldLabel}>PROBLEM</Text>
                          <Text style={styles.pokaYokeDesc}>{r.problem}</Text>
                        </View>
                      )}
                      {!!r.rootCause && (
                        <View style={styles.pokaYokeField}>
                          <Text style={styles.pokaYokeFieldLabel}>ROOT CAUSE</Text>
                          <Text style={styles.pokaYokeDesc}>{r.rootCause}</Text>
                        </View>
                      )}
                      {!!r.actionPlan && (
                        <View style={styles.pokaYokeField}>
                          <Text style={styles.pokaYokeFieldLabel}>ACTION PLAN</Text>
                          <Text style={styles.pokaYokeDesc}>{r.actionPlan}</Text>
                        </View>
                      )}

                      <View style={styles.pokaYokeFooter}>
                        <Text style={styles.pokaYokeFooterText}>{r.responsibility || '—'}</Text>
                        <Text style={styles.pokaYokeFooterText}>Target: {r.targetDate || '—'}</Text>
                      </View>
                      {!!r.submittedBy && <Text style={styles.pokaYokeSubmitter}>Logged by {r.submittedBy}</Text>}
                    </View>
                  ))}
                </>
              )}

              {/* ── PCS Man Per Hour */}
              {reportKpiKey === 'pcs-per-hour' && (
                <>
                  <View style={styles.statGrid}>
                    <View style={styles.statCard}>
                      <Text style={styles.statValue}>{pcsPerHourTotals.pcsManHour}</Text>
                      <Text style={styles.statLabel}>PCS / Man-Hr</Text>
                    </View>
                    <View style={styles.statCard}>
                      <Text style={styles.statValue}>{pcsPerHourTotals.totalActual}</Text>
                      <Text style={styles.statLabel}>Total Produced</Text>
                    </View>
                    <View style={styles.statCard}>
                      <Text style={styles.statValue}>{pcsPerHourTotals.totalManHour}</Text>
                      <Text style={styles.statLabel}>Total Man-Hours</Text>
                    </View>
                    <View style={styles.statCard}>
                      <Text style={styles.statValue}>{pcsPerHourTotals.avgManPowerActual}</Text>
                      <Text style={styles.statLabel}>Avg Man Power (Present)</Text>
                    </View>
                    <View style={styles.statCard}>
                      <Text style={styles.statValue}>{pcsPerHourTotals.avgOtHours}h</Text>
                      <Text style={styles.statLabel}>Avg OT</Text>
                    </View>
                    <View style={styles.statCard}>
                      <Text style={styles.statValue}>{pcsPerHourTotals.days}</Text>
                      <Text style={styles.statLabel}>Days</Text>
                    </View>
                  </View>

                  {(() => {
                    const sortedDays = [...pcsPerHourDays].sort((a, b) => a.dateKey.localeCompare(b.dateKey));

                    // Chart 1 — PCS/Man Hour Trend
                    const trendData = sortedDays.map((d) => ({
                      value: d.pcsManHour,
                      label: shortDateLabel(d.dateKey),
                      labelTextStyle: { color: CHART_COLORS.axisText, fontSize: 9 },
                      dataPointText: String(d.pcsManHour),
                    }));

                    // Chart 2 — Production by Day
                    const productionBarData = sortedDays.map((d) => ({
                      value: d.actual,
                      label: shortDateLabel(d.dateKey),
                      labelTextStyle: { color: CHART_COLORS.axisText, fontSize: 9 },
                      frontColor: CHART_COLORS.pcs.production,
                      onPress: () => setPcsBarTooltip({ label: d.dateLabel, lines: [`Produced: ${d.actual} pcs`] }),
                    }));

                    // Chart 3 — Manpower vs Production. gifted-charts' bar+line
                    // combo shares one y-axis, so a raw overlay of headcount
                    // (single/double digits) against production (hundreds)
                    // would flatten the manpower line to nearly nothing.
                    // Scale manpower onto production's range for visibility;
                    // the tooltip and point labels always show the real,
                    // unscaled headcount.
                    const maxProduction = Math.max(1, ...sortedDays.map((d) => d.actual));
                    const maxManpower = Math.max(1, ...sortedDays.map((d) => d.manPowerActual));
                    const manpowerScale = maxManpower > 0 ? maxProduction / maxManpower : 1;
                    const dualProductionData = sortedDays.map((d) => ({
                      value: d.actual,
                      label: shortDateLabel(d.dateKey),
                      labelTextStyle: { color: CHART_COLORS.axisText, fontSize: 9 },
                      frontColor: CHART_COLORS.pcs.production,
                    }));
                    const dualManpowerLineData = sortedDays.map((d) => ({
                      value: round1(d.manPowerActual * manpowerScale),
                      dataPointText: String(d.manPowerActual),
                      textColor: CHART_COLORS.pcs.manpower,
                      textFontSize: 10,
                      textShiftY: -14,
                    }));

                    return (
                      <>
                        <ChartCard
                          title="PCS/Man Hour Trend"
                          subtitle="Pieces produced per man-hour, over time"
                          xAxisLabel="Date"
                          yAxisLabel="PCS / Man-Hr"
                          legend={[{ color: CHART_COLORS.pcs.ratio, label: 'PCS/Man-Hr' }]}
                          hasData={sortedDays.length > 0}
                        >
                          <LineChart
                            data={trendData}
                            color={CHART_COLORS.pcs.ratio}
                            dataPointsColor={CHART_COLORS.pcs.ratio}
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
                            startFillColor={CHART_COLORS.pcs.ratio}
                            startOpacity={0.15}
                            endOpacity={0.02}
                            pointerConfig={{
                              pointerStripHeight: 160,
                              pointerStripColor: CHART_COLORS.grid,
                              pointerStripWidth: 2,
                              pointerColor: CHART_COLORS.pcs.ratio,
                              radius: 5,
                              pointerLabelWidth: 130,
                              pointerLabelHeight: 60,
                              activatePointersOnLongPress: false,
                              autoAdjustPointerLabelPosition: true,
                              pointerLabelComponent: (items: any[]) => (
                                <View style={styles.chartTooltip}>
                                  <Text style={styles.chartTooltipTitle}>{sortedDays[items?.[0]?.index ?? 0]?.dateLabel ?? ''}</Text>
                                  <Text style={[styles.chartTooltipText, { color: CHART_COLORS.pcs.ratio }]}>
                                    {items?.[0]?.value ?? 0} pcs/man-hr
                                  </Text>
                                </View>
                              ),
                            }}
                          />
                        </ChartCard>

                        <ChartCard
                          title="Production by Day"
                          subtitle="Total pieces produced each day"
                          xAxisLabel="Date"
                          yAxisLabel="Parts (count)"
                          legend={[{ color: CHART_COLORS.pcs.production, label: 'Produced' }]}
                          hasData={sortedDays.length > 0}
                        >
                          <BarChart
                            data={productionBarData}
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
                        {pcsBarTooltip && (
                          <View style={styles.chartTooltipInline}>
                            <Text style={styles.chartTooltipTitle}>{pcsBarTooltip.label}</Text>
                            {pcsBarTooltip.lines.map((l) => (
                              <Text key={l} style={styles.chartTooltipText}>{l}</Text>
                            ))}
                          </View>
                        )}

                        <ChartCard
                          title="Manpower vs Production"
                          subtitle="Present headcount against pieces produced, per day (manpower line scaled to fit — see labels for actual headcount)"
                          xAxisLabel="Date"
                          yAxisLabel="Parts (count)"
                          legend={[
                            { color: CHART_COLORS.pcs.production, label: 'Produced' },
                            { color: CHART_COLORS.pcs.manpower, label: 'Manpower (present)' },
                          ]}
                          hasData={sortedDays.length > 0}
                        >
                          <BarChart
                            data={dualProductionData}
                            lineData={dualManpowerLineData}
                            showLine
                            lineConfig={{
                              color: CHART_COLORS.pcs.manpower,
                              thickness: 2,
                              curved: true,
                              dataPointsColor: CHART_COLORS.pcs.manpower,
                              dataPointsRadius: 4,
                            }}
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
                    );
                  })()}

                  <Text style={[styles.fieldLabel, { marginTop: 14, marginBottom: 8 }]}>BY DAY</Text>
                  {pcsPerHourDays.map((d) => (
                    <View key={d.dateKey} style={styles.pcsDayCard}>
                      <View style={styles.pcsDayHeader}>
                        <Text style={styles.pcsDayLabel}>{d.dateLabel}</Text>
                        {d.manPowerActual === 0 ? (
                          <Text style={styles.pcsDayNoAtt}>No attendance</Text>
                        ) : (
                          <Text style={styles.pcsDayPcs}>{d.pcsManHour} pcs/man-hr</Text>
                        )}
                      </View>
                      <View style={styles.pcsDayStatRow}>
                        <Text style={styles.pcsDayStat}>Actual: <Text style={styles.pcsDayStatVal}>{d.actual}</Text></Text>
                        <Text style={styles.pcsDayStat}>Present: <Text style={styles.pcsDayStatVal}>{d.manPowerActual}/{d.manPowerTarget}</Text></Text>
                        <Text style={styles.pcsDayStat}>Man-Hr: <Text style={styles.pcsDayStatVal}>{d.manHour}</Text></Text>
                        {d.avgOtHours > 0 && <Text style={styles.pcsDayStat}>OT: <Text style={styles.pcsDayStatVal}>{d.avgOtHours}h</Text></Text>}
                      </View>
                      {d.lines.length > 0 && (
                        <View style={styles.pcsDayLines}>
                          {d.lines.map((l) => (
                            <View key={l.lineId} style={styles.pcsLineRow}>
                              <Text style={styles.pcsLineName} numberOfLines={1}>{l.lineName}</Text>
                              <Text style={styles.pcsLineStat}>{l.production} pcs · {l.hours}h{l.otHours > 0 ? ` (+${l.otHours}h OT)` : ''}</Text>
                            </View>
                          ))}
                        </View>
                      )}
                    </View>
                  ))}
                </>
              )}

              {/* ── Plan vs Actual */}
              {reportKpiKey === 'plan-vs-actual' && (
                <>
                  {(() => {
                    const totalPlanned = filteredPlanVsActual.reduce((s, r) => s + r.planned, 0);
                    const totalActual = filteredPlanVsActual.reduce((s, r) => s + r.actual, 0);
                    const totalLoss = filteredPlanVsActual.reduce((s, r) => s + r.loss, 0);
                    const overallPct = totalPlanned > 0 ? round1((totalActual / totalPlanned) * 100) : 0;
                    return (
                      <View style={styles.statGrid}>
                        <View style={styles.statCard}>
                          <Text style={styles.statValue}>{totalPlanned}</Text>
                          <Text style={styles.statLabel}>Planned</Text>
                        </View>
                        <View style={styles.statCard}>
                          <Text style={styles.statValue}>{totalActual}</Text>
                          <Text style={styles.statLabel}>Actual</Text>
                        </View>
                        <View style={styles.statCard}>
                          <Text style={[styles.statValue, totalLoss > 0 && { color: '#D64545' }]}>{totalLoss}</Text>
                          <Text style={styles.statLabel}>Loss</Text>
                        </View>
                        <View style={styles.statCard}>
                          <Text style={[styles.statValue, { color: overallPct >= 90 ? '#4C9A6A' : overallPct >= 70 ? '#F2A93B' : '#D64545' }]}>
                            {overallPct}%
                          </Text>
                          <Text style={styles.statLabel}>Achievement</Text>
                        </View>
                      </View>
                    );
                  })()}

                  {/* ── Charts ── */}
                  {(() => {
                    // By-line totals (feeds chart 1 and chart 2)
                    const byLineMap = new Map<string, { planned: number; actual: number }>();
                    filteredPlanVsActual.forEach((r) => {
                      const key = r.lineName || 'Unknown line';
                      const ex = byLineMap.get(key) ?? { planned: 0, actual: 0 };
                      ex.planned += r.planned;
                      ex.actual += r.actual;
                      byLineMap.set(key, ex);
                    });
                    const byLineArr = Array.from(byLineMap.entries()).map(([lineName, v]) => ({ lineName, ...v }));

                    // Chart 1 — Grouped Bar: Planned vs Actual by Line
                    const groupedBarData: any[] = [];
                    byLineArr.forEach((row, i) => {
                      groupedBarData.push({
                        value: row.planned,
                        label: row.lineName.length > 8 ? `${row.lineName.slice(0, 7)}…` : row.lineName,
                        labelTextStyle: { color: CHART_COLORS.axisText, fontSize: 9 },
                        frontColor: CHART_COLORS.planned,
                        spacing: 2,
                        topLabelComponent: () => <Text style={styles.chartBarTopLabel}>{row.planned}</Text>,
                        onPress: () => setPvaBarTooltip({ chart: 'byLine', label: row.lineName, lines: [`Planned: ${row.planned}`] }),
                      });
                      groupedBarData.push({
                        value: row.actual,
                        frontColor: CHART_COLORS.actual,
                        spacing: i === byLineArr.length - 1 ? 0 : 18,
                        topLabelComponent: () => <Text style={styles.chartBarTopLabel}>{row.actual}</Text>,
                        onPress: () => setPvaBarTooltip({ chart: 'byLine', label: row.lineName, lines: [`Actual: ${row.actual}`] }),
                      });
                    });

                    // Chart 2 — Achievement % horizontal bar, color-coded by tier.
                    // Rendered with AchievementBarRow (plain Views), not
                    // gifted-charts, so achievementBarData below only needs
                    // the plain values each row consumes — no chart-library
                    // data-point shape required.
                    const achievementArr = byLineArr
                      .map((row) => ({
                        lineName: row.lineName,
                        pct: row.planned > 0 ? round1((row.actual / row.planned) * 100) : 0,
                      }))
                      .sort((a, b) => b.pct - a.pct);

                    // Chart 3 — Daily Trend line: Planned vs Actual over time
                    const byDateMap = new Map<string, { planned: number; actual: number }>();
                    filteredPlanVsActual.forEach((r) => {
                      const key = r.date || 'unknown';
                      const ex = byDateMap.get(key) ?? { planned: 0, actual: 0 };
                      ex.planned += r.planned;
                      ex.actual += r.actual;
                      byDateMap.set(key, ex);
                    });
                    const byDateArr = Array.from(byDateMap.entries())
                      .map(([date, v]) => ({ date, ...v }))
                      .sort((a, b) => a.date.localeCompare(b.date));
                    const plannedTrendData = byDateArr.map((d) => ({
                      value: d.planned,
                      label: shortDateLabel(d.date),
                      labelTextStyle: { color: CHART_COLORS.axisText, fontSize: 9 },
                      dataPointText: String(d.planned),
                      // Planned's label sits ABOVE its point, Actual's sits
                      // BELOW (see actualTrendData) — with two series this
                      // close in value, same-position labels just overlap
                      // into an unreadable stack, so they need to be offset
                      // in opposite directions rather than both defaulting
                      // to "just above the point".
                      textShiftY: -18,
                      textShiftX: -4,
                      textColor: CHART_COLORS.planned,
                      textFontSize: 10,
                    }));
                    const actualTrendData = byDateArr.map((d) => ({
                      value: d.actual,
                      dataPointText: String(d.actual),
                      textShiftY: 16,
                      textShiftX: 4,
                      textColor: CHART_COLORS.actual,
                      textFontSize: 10,
                    }));

                    return (
                      <>
                        <ChartCard
                          title="Planned vs Actual by Line"
                          subtitle="Total planned and actual output for each line in this date range"
                          xAxisLabel="Line"
                          yAxisLabel="Parts (count)"
                          legend={[
                            { color: CHART_COLORS.planned, label: 'Planned' },
                            { color: CHART_COLORS.actual, label: 'Actual' },
                          ]}
                          hasData={byLineArr.length > 0}
                        >
                          <BarChart
                            data={groupedBarData}
                            width={CHART_WIDTH}
                            height={200}
                            barWidth={18}
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
                        {pvaBarTooltip?.chart === 'byLine' && (
                          <View style={styles.chartTooltipInline}>
                            <Text style={styles.chartTooltipTitle}>{pvaBarTooltip.label}</Text>
                            {pvaBarTooltip.lines.map((l) => (
                              <Text key={l} style={styles.chartTooltipText}>{l}</Text>
                            ))}
                          </View>
                        )}

                        <ChartCard
                          title="Achievement %"
                          subtitle="Actual production as a percentage of the planned target, per line"
                          xAxisLabel="Achievement %"
                          yAxisLabel="Line"
                          legend={[
                            { color: CHART_COLORS.achievement.green, label: '≥ 95% On target' },
                            { color: CHART_COLORS.achievement.yellow, label: '85–94% Near target' },
                            { color: CHART_COLORS.achievement.orange, label: '70–84% Below target' },
                            { color: CHART_COLORS.achievement.red, label: '< 70% Critical' },
                          ]}
                          hasData={achievementArr.length > 0}
                        >
                          <View style={{ width: '100%' }}>
                            {achievementArr.map((row) => (
                              <AchievementBarRow
                                key={row.lineName}
                                label={row.lineName}
                                pct={row.pct}
                                color={achievementColor(row.pct)}
                                onPress={() =>
                                  setPvaBarTooltip({
                                    chart: 'achievement',
                                    label: row.lineName,
                                    lines: [`${row.pct}% — ${achievementTierLabel(row.pct)}`],
                                  })
                                }
                              />
                            ))}
                          </View>
                        </ChartCard>
                        {pvaBarTooltip?.chart === 'achievement' && (
                          <View style={styles.chartTooltipInline}>
                            <Text style={styles.chartTooltipTitle}>{pvaBarTooltip.label}</Text>
                            {pvaBarTooltip.lines.map((l) => (
                              <Text key={l} style={styles.chartTooltipText}>{l}</Text>
                            ))}
                          </View>
                        )}

                        <ChartCard
                          title="Daily Trend"
                          subtitle="Planned vs Actual output over time"
                          xAxisLabel="Date"
                          yAxisLabel="Parts (count)"
                          legend={[
                            { color: CHART_COLORS.planned, label: 'Planned' },
                            { color: CHART_COLORS.actual, label: 'Actual' },
                          ]}
                          hasData={byDateArr.length > 0}
                        >
                          <LineChart
                            data={plannedTrendData}
                            data2={actualTrendData}
                            color1={CHART_COLORS.planned}
                            color2={CHART_COLORS.actual}
                            dataPointsColor1={CHART_COLORS.planned}
                            dataPointsColor2={CHART_COLORS.actual}
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
                            startFillColor1={CHART_COLORS.planned}
                            startFillColor2={CHART_COLORS.actual}
                            startOpacity={0.15}
                            endOpacity={0.02}
                            pointerConfig={{
                              pointerStripHeight: 160,
                              pointerStripColor: CHART_COLORS.grid,
                              pointerStripWidth: 2,
                              pointerColor: CHART_COLORS.planned,
                              radius: 5,
                              pointerLabelWidth: 130,
                              pointerLabelHeight: 70,
                              activatePointersOnLongPress: false,
                              autoAdjustPointerLabelPosition: true,
                              pointerLabelComponent: (items: any[]) => (
                                <View style={styles.chartTooltip}>
                                  <Text style={styles.chartTooltipTitle}>{byDateArr[items?.[0]?.index ?? 0]?.date ?? ''}</Text>
                                  <Text style={[styles.chartTooltipText, { color: CHART_COLORS.planned }]}>
                                    Planned: {items?.[0]?.value ?? 0}
                                  </Text>
                                  <Text style={[styles.chartTooltipText, { color: CHART_COLORS.actual }]}>
                                    Actual: {items?.[1]?.value ?? 0}
                                  </Text>
                                </View>
                              ),
                            }}
                          />
                        </ChartCard>
                      </>
                    );
                  })()}

                  <Text style={[styles.fieldLabel, { marginTop: 14, marginBottom: 8 }]}>RECORDS</Text>
                  {filteredPlanVsActual.map((r) => (
                    <View key={r.id} style={styles.nearMissCard}>
                      <View style={styles.nearMissTopRow}>
                        <Text style={styles.nearMissArea}>{r.lineName || 'Unnamed line'}</Text>
                        <Text
                          style={[
                            styles.nearMissBadgeText,
                            { color: r.productionPct >= 90 ? '#4C9A6A' : r.productionPct >= 70 ? '#F2A93B' : '#D64545', fontSize: 14 },
                          ]}
                        >
                          {r.productionPct}%
                        </Text>
                      </View>
                      <Text style={styles.nearMissMeta}>
                        {[r.plant, r.workshop, r.division, r.shift ? `Shift ${r.shift}` : null].filter(Boolean).join(' · ')}
                        {r.date ? ` · ${r.date}` : ''}
                      </Text>

                      <View style={styles.nearMissDetailGrid}>
                        <View style={styles.nearMissDetailItem}>
                          <Text style={styles.nearMissFieldLabel}>PLANNED</Text>
                          <Text style={styles.nearMissDetailValue}>{r.planned}</Text>
                        </View>
                        <View style={styles.nearMissDetailItem}>
                          <Text style={styles.nearMissFieldLabel}>ACTUAL</Text>
                          <Text style={styles.nearMissDetailValue}>{r.actual}</Text>
                        </View>
                        <View style={styles.nearMissDetailItem}>
                          <Text style={styles.nearMissFieldLabel}>LOSS</Text>
                          <Text style={[styles.nearMissDetailValue, r.loss > 0 && { color: '#D64545' }]}>{r.loss}</Text>
                        </View>
                      </View>

                      <View style={styles.nearMissFooter}>
                        {!!r.submittedBy && <Text style={styles.nearMissSubmitter}>Logged by {r.submittedBy}</Text>}
                      </View>
                    </View>
                  ))}
                </>
              )}

              {/* ── Rework Data % */}
              {reportKpiKey === 'rework-pct' && (
                <>
                  {(() => {
                    const totalProduction = filteredRework.reduce((s, r) => s + r.totalProduction, 0);
                    const totalRework = filteredRework.reduce((s, r) => s + r.reworkCount, 0);
                    const overallReworkPct = totalProduction > 0 ? round1((totalRework / totalProduction) * 100) : 0;
                    return (
                      <View style={styles.statGrid}>
                        <View style={styles.statCard}>
                          <Text style={styles.statValue}>{totalProduction}</Text>
                          <Text style={styles.statLabel}>Total Produced</Text>
                        </View>
                        <View style={styles.statCard}>
                          <Text style={[styles.statValue, totalRework > 0 && { color: '#D64545' }]}>{totalRework}</Text>
                          <Text style={styles.statLabel}>Reworked</Text>
                        </View>
                        <View style={styles.statCard}>
                          <Text style={[styles.statValue, { color: overallReworkPct <= 2 ? '#4C9A6A' : overallReworkPct <= 5 ? '#F2A93B' : '#D64545' }]}>
                            {overallReworkPct}%
                          </Text>
                          <Text style={styles.statLabel}>Rework %</Text>
                        </View>
                      </View>
                    );
                  })()}

                  {/* Chart 1 — Rework % trend */}
                  <ChartCard
                    title="Rework %"
                    subtitle="Rework rate over time"
                    xAxisLabel="Date"
                    yAxisLabel="Rework %"
                    legend={[{ color: '#F2A93B', label: 'Rework %' }]}
                    hasData={reworkTotals.byDate.length > 0}
                  >
                    <LineChart
                      data={reworkTotals.byDate.map((d) => ({
                        value: d.reworkPct,
                        label: shortDateLabel(d.date),
                        labelTextStyle: { color: CHART_COLORS.axisText, fontSize: 9 },
                      }))}
                      color="#F2A93B"
                      dataPointsColor="#F2A93B"
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
                      startFillColor="#F2A93B"
                      startOpacity={0.15}
                      endOpacity={0.02}
                      pointerConfig={{
                        pointerStripHeight: 160,
                        pointerStripColor: CHART_COLORS.grid,
                        pointerStripWidth: 2,
                        pointerColor: '#F2A93B',
                        radius: 5,
                        pointerLabelWidth: 130,
                        pointerLabelHeight: 60,
                        activatePointersOnLongPress: false,
                        autoAdjustPointerLabelPosition: true,
                        pointerLabelComponent: (items: any[]) => (
                          <View style={styles.chartTooltip}>
                            <Text style={styles.chartTooltipTitle}>{reworkTotals.byDate[items?.[0]?.index ?? 0]?.dateLabel ?? ''}</Text>
                            <Text style={[styles.chartTooltipText, { color: '#F2A93B' }]}>{items?.[0]?.value ?? 0}% reworked</Text>
                          </View>
                        ),
                      }}
                    />
                  </ChartCard>

                  {/* Chart 2 — Rework by Line */}
                  <ChartCard
                    title="Rework by Line"
                    subtitle="Reworked pieces per line, this date range"
                    xAxisLabel="Reworked (pcs)"
                    yAxisLabel="Line"
                    hasData={reworkTotals.byLine.some((l) => l.reworkCount > 0)}
                  >
                    <View style={{ width: '100%' }}>
                      {reworkTotals.byLine
                        .filter((l) => l.reworkCount > 0)
                        .map((l) => (
                          <MetricBarRow
                            key={l.lineName}
                            label={l.lineName}
                            value={l.reworkCount}
                            maxValue={Math.max(1, ...reworkTotals.byLine.map((x) => x.reworkCount))}
                            color="#F2A93B"
                            valueLabel={String(l.reworkCount)}
                            onPress={() =>
                              setReworkBarTooltip({ chart: 'byLine', label: l.lineName, lines: [`${l.reworkCount} reworked · ${l.reworkPct}%`] })
                            }
                          />
                        ))}
                    </View>
                  </ChartCard>
                  {reworkBarTooltip?.chart === 'byLine' && (
                    <View style={styles.chartTooltipInline}>
                      <Text style={styles.chartTooltipTitle}>{reworkBarTooltip.label}</Text>
                      {reworkBarTooltip.lines.map((l) => (
                        <Text key={l} style={styles.chartTooltipText}>{l}</Text>
                      ))}
                    </View>
                  )}

                  {/* Chart 3 — Rework Count */}
                  <ChartCard
                    title="Rework Count"
                    subtitle="Reworked pieces per day, this date range"
                    xAxisLabel="Date"
                    yAxisLabel="Reworked (pcs)"
                    legend={[{ color: '#D64545', label: 'Reworked' }]}
                    hasData={reworkTotals.byDate.some((d) => d.reworkCount > 0)}
                  >
                    <BarChart
                      data={reworkTotals.byDate.map((d) => ({
                        value: d.reworkCount,
                        label: shortDateLabel(d.date),
                        labelTextStyle: { color: CHART_COLORS.axisText, fontSize: 9 },
                        frontColor: '#D64545',
                        onPress: () =>
                          setReworkBarTooltip({ chart: 'byDate', label: d.dateLabel, lines: [`${d.reworkCount} reworked · ${d.reworkPct}%`] }),
                      }))}
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
                  {reworkBarTooltip?.chart === 'byDate' && (
                    <View style={styles.chartTooltipInline}>
                      <Text style={styles.chartTooltipTitle}>{reworkBarTooltip.label}</Text>
                      {reworkBarTooltip.lines.map((l) => (
                        <Text key={l} style={styles.chartTooltipText}>{l}</Text>
                      ))}
                    </View>
                  )}

                  <Text style={[styles.fieldLabel, { marginTop: 14, marginBottom: 8 }]}>RECORDS</Text>
                  {filteredRework.map((r) => (
                    <View key={r.id} style={styles.nearMissCard}>
                      <View style={styles.nearMissTopRow}>
                        <Text style={styles.nearMissArea}>{r.lineName || 'Unnamed line'}</Text>
                        <Text
                          style={[
                            styles.nearMissBadgeText,
                            { color: r.reworkPct <= 2 ? '#4C9A6A' : r.reworkPct <= 5 ? '#F2A93B' : '#D64545', fontSize: 14 },
                          ]}
                        >
                          {r.reworkPct}%
                        </Text>
                      </View>
                      <Text style={styles.nearMissMeta}>
                        {[r.plant, r.workshop, r.division, r.shift ? `Shift ${r.shift}` : null].filter(Boolean).join(' · ')}
                        {r.date ? ` · ${r.date}` : ''}
                      </Text>

                      <View style={styles.nearMissDetailGrid}>
                        <View style={styles.nearMissDetailItem}>
                          <Text style={styles.nearMissFieldLabel}>TOTAL PRODUCTION</Text>
                          <Text style={styles.nearMissDetailValue}>{r.totalProduction}</Text>
                        </View>
                        <View style={styles.nearMissDetailItem}>
                          <Text style={styles.nearMissFieldLabel}>REWORK COUNT</Text>
                          <Text style={[styles.nearMissDetailValue, r.reworkCount > 0 && { color: '#D64545' }]}>{r.reworkCount}</Text>
                        </View>
                      </View>

                      <View style={styles.nearMissFooter}>
                        {!!r.submittedBy && <Text style={styles.nearMissSubmitter}>Logged by {r.submittedBy}</Text>}
                      </View>
                    </View>
                  ))}
                </>
              )}

              {/* ── Kaizen Tracker */}
              {reportKpiKey === 'kaizen' && (
                <>
                  <View style={styles.statGrid}>
                    <View style={styles.statCard}>
                      <Text style={styles.statValue}>{filteredKaizen.length}</Text>
                      <Text style={styles.statLabel}>Total Ideas</Text>
                    </View>
                    <View style={styles.statCard}>
                      <Text style={[styles.statValue, { color: '#D64545' }]}>
                        {filteredKaizen.filter((r) => r.status === 'Open').length}
                      </Text>
                      <Text style={styles.statLabel}>Open</Text>
                    </View>
                    <View style={styles.statCard}>
                      <Text style={[styles.statValue, { color: '#F2A93B' }]}>
                        {filteredKaizen.filter((r) => r.status === 'In Progress').length}
                      </Text>
                      <Text style={styles.statLabel}>In Progress</Text>
                    </View>
                    <View style={styles.statCard}>
                      <Text style={[styles.statValue, { color: '#4C9A6A' }]}>
                        {filteredKaizen.filter((r) => r.status === 'Implemented').length}
                      </Text>
                      <Text style={styles.statLabel}>Implemented</Text>
                    </View>
                  </View>

                  {/* Chart 1 — Kaizen Status */}
                  <ChartCard
                    title="Kaizen Status"
                    subtitle="Ideas grouped by status, this date range"
                    legend={kaizenTotals.byStatus.map((s) => ({ color: KAIZEN_STATUS_COLOR[s.status], label: `${s.status} (${s.count})` }))}
                    hasData={kaizenTotals.byStatus.length > 0}
                  >
                    <View style={{ alignItems: 'center', paddingVertical: 4 }}>
                      <PieChart
                        data={kaizenTotals.byStatus.map((s) => ({
                          value: s.count,
                          color: KAIZEN_STATUS_COLOR[s.status],
                          text: s.status,
                        }))}
                        donut
                        radius={90}
                        innerRadius={54}
                        innerCircleColor="#1D2329"
                        centerLabelComponent={() => (
                          <View style={{ alignItems: 'center' }}>
                            <Text style={{ color: '#ECEFF2', fontSize: 18, fontWeight: '800' }}>{filteredKaizen.length}</Text>
                            <Text style={{ color: '#8A96A3', fontSize: 10 }}>ideas</Text>
                          </View>
                        )}
                      />
                    </View>
                  </ChartCard>

                  {/* Chart 2 — Kaizen by Category */}
                  <ChartCard
                    title="Kaizen by Category"
                    subtitle="Ideas per category, this date range"
                    xAxisLabel="Category"
                    yAxisLabel="Ideas"
                    legend={[{ color: '#4C9A6A', label: 'Ideas' }]}
                    hasData={kaizenTotals.byCategory.length > 0}
                  >
                    <BarChart
                      data={kaizenTotals.byCategory.map((c) => ({
                        value: c.count,
                        label: c.category,
                        labelTextStyle: { color: CHART_COLORS.axisText, fontSize: 9 },
                        frontColor: '#4C9A6A',
                        onPress: () => setKaizenBarTooltip({ label: c.category, lines: [`${c.count} idea${c.count === 1 ? '' : 's'}`] }),
                      }))}
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
                  {kaizenBarTooltip && (
                    <View style={styles.chartTooltipInline}>
                      <Text style={styles.chartTooltipTitle}>{kaizenBarTooltip.label}</Text>
                      {kaizenBarTooltip.lines.map((l) => (
                        <Text key={l} style={styles.chartTooltipText}>{l}</Text>
                      ))}
                    </View>
                  )}

                  {/* Chart 3 — Monthly Implemented Kaizens */}
                  <ChartCard
                    title="Monthly Implemented Kaizens"
                    subtitle="Ideas marked Implemented, by month"
                    xAxisLabel="Month"
                    yAxisLabel="Implemented"
                    legend={[{ color: KAIZEN_STATUS_COLOR.Implemented, label: 'Implemented' }]}
                    hasData={kaizenTotals.implementedByMonth.length > 0}
                  >
                    <LineChart
                      data={kaizenTotals.implementedByMonth.map((m) => ({
                        value: m.count,
                        label: m.label,
                        labelTextStyle: { color: CHART_COLORS.axisText, fontSize: 9 },
                      }))}
                      color={KAIZEN_STATUS_COLOR.Implemented}
                      dataPointsColor={KAIZEN_STATUS_COLOR.Implemented}
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
                      startFillColor={KAIZEN_STATUS_COLOR.Implemented}
                      startOpacity={0.15}
                      endOpacity={0.02}
                    />
                  </ChartCard>

                  <Text style={[styles.fieldLabel, { marginTop: 14, marginBottom: 8 }]}>RECORDS</Text>
                  {filteredKaizen.map((r) => {
                    const statusColor = KAIZEN_STATUS_COLOR[r.status] ?? '#8A96A3';
                    return (
                      <View key={r.id} style={styles.pokaYokeCard}>
                        <View style={styles.pokaYokeTopRow}>
                          <Text style={styles.pokaYokeTitle}>
                            {r.employeeName || 'Unnamed employee'}{r.employeeCode ? ` (${r.employeeCode})` : ''}
                          </Text>
                          <View style={[styles.pokaYokeBadge, { borderColor: statusColor, backgroundColor: statusColor + '22' }]}>
                            <Text style={[styles.pokaYokeBadgeText, { color: statusColor }]}>{r.status || '—'}</Text>
                          </View>
                        </View>
                        <Text style={styles.pokaYokeMeta}>
                          {[r.plant, r.workshop, r.division].filter(Boolean).join(' · ')}
                          {r.date ? ` · ${r.date}` : ''}
                          {r.category ? ` · ${r.category}` : ''}
                          {r.priority ? ` · ${r.priority} priority` : ''}
                        </Text>

                        {!!r.improvementIdentified && (
                          <View style={styles.pokaYokeField}>
                            <Text style={styles.pokaYokeFieldLabel}>IMPROVEMENT IDENTIFIED</Text>
                            <Text style={styles.pokaYokeDesc}>{r.improvementIdentified}</Text>
                          </View>
                        )}
                        {!!r.kaizenIdea && (
                          <View style={styles.pokaYokeField}>
                            <Text style={styles.pokaYokeFieldLabel}>KAIZEN IDEA</Text>
                            <Text style={styles.pokaYokeDesc}>{r.kaizenIdea}</Text>
                          </View>
                        )}
                        {!!r.actionTaken && (
                          <View style={styles.pokaYokeField}>
                            <Text style={styles.pokaYokeFieldLabel}>ACTION TAKEN</Text>
                            <Text style={styles.pokaYokeDesc}>{r.actionTaken}</Text>
                          </View>
                        )}
                        {!!r.result && (
                          <View style={styles.pokaYokeField}>
                            <Text style={styles.pokaYokeFieldLabel}>RESULT / IMPACT</Text>
                            <Text style={styles.pokaYokeDesc}>{r.result}</Text>
                          </View>
                        )}

                        <View style={styles.pokaYokeFooter}>
                          <Text style={styles.pokaYokeFooterText}>{r.responsibility || '—'}</Text>
                          <Text style={styles.pokaYokeFooterText}>Target: {r.targetDate || '—'}</Text>
                        </View>
                        {!!r.submittedBy && <Text style={styles.pokaYokeSubmitter}>Logged by {r.submittedBy}</Text>}
                      </View>
                    );
                  })}
                </>
              )}

              {/* ── Rejection % */}
              {reportKpiKey === 'rejection-pct' && (
                <>
                  <View style={styles.statGrid}>
                    <View style={styles.statCard}>
                      <Text style={[styles.statValue, { color: totals.rejectionPct <= 2 ? '#4C9A6A' : totals.rejectionPct <= 5 ? '#F2A93B' : '#D64545' }]}>
                        {totals.rejectionPct}%
                      </Text>
                      <Text style={styles.statLabel}>Rejection Rate</Text>
                    </View>
                    <View style={styles.statCard}>
                      <Text style={styles.statValue}>{totals.rejections}</Text>
                      <Text style={styles.statLabel}>Rejected</Text>
                    </View>
                    <View style={styles.statCard}>
                      <Text style={styles.statValue}>{totals.actual}</Text>
                      <Text style={styles.statLabel}>Good Parts</Text>
                    </View>
                  </View>

                  {/* Chart 1 — Rejection % over time */}
                  <ChartCard
                    title="Rejection % Trend"
                    subtitle="Rejection rate over time"
                    xAxisLabel="Date"
                    yAxisLabel="Rejection %"
                    legend={[{ color: CHART_COLORS.rejection.rate, label: 'Rejection %' }]}
                    hasData={rejectionByDate.length > 0}
                  >
                    <LineChart
                      data={rejectionByDate.map((d) => ({
                        value: d.rejectionPct,
                        label: shortDateLabel(d.date),
                        labelTextStyle: { color: CHART_COLORS.axisText, fontSize: 9 },
                      }))}
                      color={CHART_COLORS.rejection.rate}
                      dataPointsColor={CHART_COLORS.rejection.rate}
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
                      startFillColor={CHART_COLORS.rejection.rate}
                      startOpacity={0.15}
                      endOpacity={0.02}
                      pointerConfig={{
                        pointerStripHeight: 160,
                        pointerStripColor: CHART_COLORS.grid,
                        pointerStripWidth: 2,
                        pointerColor: CHART_COLORS.rejection.rate,
                        radius: 5,
                        pointerLabelWidth: 130,
                        pointerLabelHeight: 60,
                        activatePointersOnLongPress: false,
                        autoAdjustPointerLabelPosition: true,
                        pointerLabelComponent: (items: any[]) => (
                          <View style={styles.chartTooltip}>
                            <Text style={styles.chartTooltipTitle}>{rejectionByDate[items?.[0]?.index ?? 0]?.dateLabel ?? ''}</Text>
                            <Text style={[styles.chartTooltipText, { color: CHART_COLORS.rejection.rate }]}>
                              {items?.[0]?.value ?? 0}% rejected
                            </Text>
                          </View>
                        ),
                      }}
                    />
                  </ChartCard>

                  {/* Chart 2 — Rejections by Line */}
                  <ChartCard
                    title="Rejections by Line"
                    subtitle="Rejected pieces per line, this date range"
                    xAxisLabel="Rejected (pcs)"
                    yAxisLabel="Line"
                    hasData={byLine.some((b) => b.rejections > 0)}
                  >
                    <View style={{ width: '100%' }}>
                      {byLine
                        .filter((b) => b.rejections > 0)
                        .sort((a, b) => b.rejections - a.rejections)
                        .map((b) => (
                          <MetricBarRow
                            key={b.lineId}
                            label={b.lineName}
                            value={b.rejections}
                            maxValue={Math.max(1, ...byLine.map((x) => x.rejections))}
                            color={CHART_COLORS.rejection.rate}
                            valueLabel={String(b.rejections)}
                            onPress={() =>
                              setRejectionBarTooltip({
                                chart: 'byLine',
                                label: b.lineName,
                                lines: [`${b.rejections} rejected of ${b.actual + b.rejections} pcs`],
                              })
                            }
                          />
                        ))}
                    </View>
                  </ChartCard>
                  {rejectionBarTooltip?.chart === 'byLine' && (
                    <View style={styles.chartTooltipInline}>
                      <Text style={styles.chartTooltipTitle}>{rejectionBarTooltip.label}</Text>
                      {rejectionBarTooltip.lines.map((l) => (
                        <Text key={l} style={styles.chartTooltipText}>{l}</Text>
                      ))}
                    </View>
                  )}

                  {/* Chart 3 — Rejections by Part */}
                  <ChartCard
                    title="Rejections by Part"
                    subtitle="Rejected pieces per part, this date range"
                    xAxisLabel="Part"
                    yAxisLabel="Rejected (pcs)"
                    legend={[{ color: CHART_COLORS.rejection.rate, label: 'Rejected' }]}
                    hasData={rejectionByPart.some((p) => p.rejections > 0)}
                  >
                    <BarChart
                      data={rejectionByPart
                        .filter((p) => p.rejections > 0)
                        .map((p) => ({
                          value: p.rejections,
                          label: p.partName,
                          labelTextStyle: { color: CHART_COLORS.axisText, fontSize: 9 },
                          frontColor: CHART_COLORS.rejection.rate,
                          onPress: () =>
                            setRejectionBarTooltip({
                              chart: 'byPart',
                              label: p.partName,
                              lines: [`${p.rejections} rejected · ${p.rejectionPct}%`],
                            }),
                        }))}
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
                  {rejectionBarTooltip?.chart === 'byPart' && (
                    <View style={styles.chartTooltipInline}>
                      <Text style={styles.chartTooltipTitle}>{rejectionBarTooltip.label}</Text>
                      {rejectionBarTooltip.lines.map((l) => (
                        <Text key={l} style={styles.chartTooltipText}>{l}</Text>
                      ))}
                    </View>
                  )}

                  <Text style={[styles.fieldLabel, { marginTop: 14, marginBottom: 8 }]}>BY LINE</Text>
                  {byLine.map((b) => {
                    const pct = b.actual + b.rejections > 0 ? round1((b.rejections / (b.actual + b.rejections)) * 100) : 0;
                    return (
                      <View key={b.lineId} style={styles.lineCard}>
                        <Text style={styles.lineCardTitle}>{b.lineName}</Text>
                        <Text style={[styles.lineCardStat, { color: pct > 5 ? '#D64545' : '#ECEFF2' }]}>{b.rejections} rejected · {pct}%</Text>
                      </View>
                    );
                  })}
                </>
              )}

              {/* ── Man-Days Tracker */}
              {reportKpiKey === 'man-days' && (
                <>
                  {/* Summary stat cards */}
                  <View style={styles.statGrid}>
                    <View style={styles.statCard}>
                      <Text style={[styles.statValue, { color: '#3E7CB1' }]}>{manDaysTotals.totalPresent}</Text>
                      <Text style={styles.statLabel}>Total Man-Days</Text>
                    </View>
                    <View style={styles.statCard}>
                      <Text style={styles.statValue}>{manDaysTotals.uniqueDays}</Text>
                      <Text style={styles.statLabel}>Days Logged</Text>
                    </View>
                    <View style={styles.statCard}>
                      <Text style={[styles.statValue, { color: '#F2A93B' }]}>{manDaysTotals.avgPerDay}</Text>
                      <Text style={styles.statLabel}>Avg / Day</Text>
                    </View>
                  </View>

                  {/* Attendance breakdown */}
                  <Text style={[styles.fieldLabel, { marginTop: 14, marginBottom: 8 }]}>ATTENDANCE</Text>
                  <View style={styles.statGrid}>
                    <View style={styles.statCard}>
                      <Text style={[styles.statValue, { color: '#4C9A6A' }]}>{manDaysTotals.totalPresent}</Text>
                      <Text style={styles.statLabel}>Present</Text>
                    </View>
                    <View style={styles.statCard}>
                      <Text style={[styles.statValue, { color: '#D64545' }]}>{manDaysTotals.totalAbsent}</Text>
                      <Text style={styles.statLabel}>Absent</Text>
                    </View>
                    <View style={styles.statCard}>
                      <Text style={[styles.statValue, { color: '#F2A93B' }]}>{manDaysTotals.totalOnLeave}</Text>
                      <Text style={styles.statLabel}>On Leave</Text>
                    </View>
                  </View>

                  {/* Chart 1 — Man Days Trend */}
                  <ChartCard
                    title="Man Days Trend"
                    subtitle="Total man-days logged per day"
                    xAxisLabel="Date"
                    yAxisLabel="Man-Days"
                    legend={[{ color: '#3E7CB1', label: 'Man-Days' }]}
                    hasData={manDaysTotals.byDate.length > 0}
                  >
                    <LineChart
                      data={manDaysTotals.byDate.map((d) => ({
                        value: d.total,
                        label: shortDateLabel(d.dateISO),
                        labelTextStyle: { color: CHART_COLORS.axisText, fontSize: 9 },
                      }))}
                      color="#3E7CB1"
                      dataPointsColor="#3E7CB1"
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
                      startFillColor="#3E7CB1"
                      startOpacity={0.15}
                      endOpacity={0.02}
                      pointerConfig={{
                        pointerStripHeight: 160,
                        pointerStripColor: CHART_COLORS.grid,
                        pointerStripWidth: 2,
                        pointerColor: '#3E7CB1',
                        radius: 5,
                        pointerLabelWidth: 130,
                        pointerLabelHeight: 60,
                        activatePointersOnLongPress: false,
                        autoAdjustPointerLabelPosition: true,
                        pointerLabelComponent: (items: any[]) => (
                          <View style={styles.chartTooltip}>
                            <Text style={styles.chartTooltipTitle}>{manDaysTotals.byDate[items?.[0]?.index ?? 0]?.dateDisplay ?? ''}</Text>
                            <Text style={[styles.chartTooltipText, { color: '#3E7CB1' }]}>
                              {items?.[0]?.value ?? 0} man-days
                            </Text>
                          </View>
                        ),
                      }}
                    />
                  </ChartCard>

                  {/* Chart 2 — Manpower by Division */}
                  <ChartCard
                    title="Manpower by Division"
                    subtitle="Total man-days per division, this date range"
                    xAxisLabel="Division"
                    yAxisLabel="Man-Days"
                    legend={[{ color: '#3E7CB1', label: 'Man-Days' }]}
                    hasData={manDaysTotals.byDivision.length > 0}
                  >
                    <BarChart
                      data={manDaysTotals.byDivision.map((d) => ({
                        value: d.total,
                        label: d.division,
                        labelTextStyle: { color: CHART_COLORS.axisText, fontSize: 9 },
                        frontColor: '#3E7CB1',
                        onPress: () =>
                          setManDaysBarTooltip({
                            chart: 'byDivision',
                            label: d.division,
                            lines: [`${d.total} man-days · avg ${d.avgPerDay}/day`],
                          }),
                      }))}
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
                  {manDaysBarTooltip?.chart === 'byDivision' && (
                    <View style={styles.chartTooltipInline}>
                      <Text style={styles.chartTooltipTitle}>{manDaysBarTooltip.label}</Text>
                      {manDaysBarTooltip.lines.map((l) => (
                        <Text key={l} style={styles.chartTooltipText}>{l}</Text>
                      ))}
                    </View>
                  )}

                  {/* Chart 3 — Monthly Average Manpower */}
                  <ChartCard
                    title="Monthly Average Manpower"
                    subtitle="Average man-days per logged day, by month"
                    xAxisLabel="Month"
                    yAxisLabel="Avg / Day"
                    legend={[{ color: '#F2A93B', label: 'Avg Manpower / Day' }]}
                    hasData={manDaysTotals.byMonth.length > 0}
                  >
                    <BarChart
                      data={manDaysTotals.byMonth.map((mo) => ({
                        value: mo.avgManpower,
                        label: mo.label,
                        labelTextStyle: { color: CHART_COLORS.axisText, fontSize: 9 },
                        frontColor: '#F2A93B',
                        onPress: () =>
                          setManDaysBarTooltip({
                            chart: 'byMonth',
                            label: mo.label,
                            lines: [`avg ${mo.avgManpower} / day · ${mo.daysLogged} day${mo.daysLogged !== 1 ? 's' : ''} logged`],
                          }),
                      }))}
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
                  {manDaysBarTooltip?.chart === 'byMonth' && (
                    <View style={styles.chartTooltipInline}>
                      <Text style={styles.chartTooltipTitle}>{manDaysBarTooltip.label}</Text>
                      {manDaysBarTooltip.lines.map((l) => (
                        <Text key={l} style={styles.chartTooltipText}>{l}</Text>
                      ))}
                    </View>
                  )}

                  {/* By division */}
                  {manDaysTotals.byDivision.length > 0 && (
                    <>
                      <Text style={[styles.fieldLabel, { marginTop: 14, marginBottom: 8 }]}>BY DIVISION</Text>
                      {manDaysTotals.byDivision.map((d) => (
                        <View key={d.division} style={styles.manDaysDivCard}>
                          <View style={styles.manDaysDivHeader}>
                            <Text style={styles.manDaysDivTitle}>{d.division}</Text>
                            <View style={styles.manDaysTotalBadge}>
                              <Text style={styles.manDaysTotalBadgeText}>{d.total} man-days</Text>
                            </View>
                          </View>
                          <View style={styles.manDaysRoleRow}>
                            <View style={styles.manDaysRoleChip}>
                              <View style={[styles.manDaysRoleDot, { backgroundColor: '#4C9A6A' }]} />
                              <Text style={styles.manDaysRoleLabel}>Present</Text>
                              <Text style={[styles.manDaysRoleVal, { color: '#4C9A6A' }]}>{d.present}</Text>
                            </View>
                            <View style={styles.manDaysRoleChip}>
                              <View style={[styles.manDaysRoleDot, { backgroundColor: '#D64545' }]} />
                              <Text style={styles.manDaysRoleLabel}>Absent</Text>
                              <Text style={[styles.manDaysRoleVal, { color: '#D64545' }]}>{d.absent}</Text>
                            </View>
                            <View style={styles.manDaysRoleChip}>
                              <View style={[styles.manDaysRoleDot, { backgroundColor: '#F2A93B' }]} />
                              <Text style={styles.manDaysRoleLabel}>Leave</Text>
                              <Text style={[styles.manDaysRoleVal, { color: '#F2A93B' }]}>{d.onLeave}</Text>
                            </View>
                            <Text style={styles.manDaysDivAvg}>~{d.avgPerDay}/day</Text>
                          </View>
                        </View>
                      ))}
                    </>
                  )}

                  {/* Monthly summary — each month has avg manpower + per-division breakdown */}
                  {manDaysTotals.byMonth.length > 0 && (
                    <>
                      <Text style={[styles.fieldLabel, { marginTop: 14, marginBottom: 8 }]}>MONTHLY SUMMARY</Text>
                      {manDaysTotals.byMonth.map((mo) => (
                        <View key={mo.ym} style={styles.manDaysMonthCard}>

                          {/* ── Month header: name + total + avg manpower ── */}
                          <View style={styles.manDaysMonthHeader}>
                            <View style={{ flex: 1, marginRight: 10 }}>
                              <Text style={styles.manDaysMonthLabel}>{mo.label}</Text>
                              <Text style={styles.manDaysMonthDays}>{mo.daysLogged} day{mo.daysLogged !== 1 ? 's' : ''} logged</Text>
                            </View>
                            <View style={{ alignItems: 'flex-end', gap: 4 }}>
                              <View style={styles.manDaysMonthBadge}>
                                <Text style={styles.manDaysMonthBadgeNum}>{mo.total}</Text>
                                <Text style={styles.manDaysMonthBadgeLbl}>total man-days</Text>
                              </View>
                              {/* Avg manpower — whole month */}
                              <View style={styles.manDaysAvgBadge}>
                                <Ionicons name="trending-up" size={11} color="#F2A93B" />
                                <Text style={styles.manDaysAvgBadgeText}>avg {mo.avgManpower} / day</Text>
                              </View>
                            </View>
                          </View>

                          {/* ── Month-level attendance totals ── */}
                          <View style={[styles.manDaysRoleRow, { marginBottom: 12 }]}>
                            <View style={styles.manDaysRoleChip}>
                              <View style={[styles.manDaysRoleDot, { backgroundColor: '#4C9A6A' }]} />
                              <Text style={styles.manDaysRoleLabel}>Present</Text>
                              <Text style={[styles.manDaysRoleVal, { color: '#4C9A6A' }]}>{mo.present}</Text>
                            </View>
                            <View style={styles.manDaysRoleChip}>
                              <View style={[styles.manDaysRoleDot, { backgroundColor: '#D64545' }]} />
                              <Text style={styles.manDaysRoleLabel}>Absent</Text>
                              <Text style={[styles.manDaysRoleVal, { color: '#D64545' }]}>{mo.absent}</Text>
                            </View>
                            <View style={styles.manDaysRoleChip}>
                              <View style={[styles.manDaysRoleDot, { backgroundColor: '#F2A93B' }]} />
                              <Text style={styles.manDaysRoleLabel}>Leave</Text>
                              <Text style={[styles.manDaysRoleVal, { color: '#F2A93B' }]}>{mo.onLeave}</Text>
                            </View>
                          </View>

                          {/* ── Per-division breakdown inside this month ── */}
                          {mo.divisions.length > 0 && (
                            <View style={styles.manDaysDivSection}>
                              <Text style={styles.manDaysDivSectionLabel}>BY DIVISION</Text>
                              {mo.divisions.map((d) => (
                                <View key={d.division} style={styles.manDaysDivRow}>
                                  {/* Division name + avg */}
                                  <View style={styles.manDaysDivRowLeft}>
                                    <Text style={styles.manDaysDivRowName}>{d.division}</Text>
                                    <Text style={styles.manDaysDivRowDays}>{d.daysLogged}d · avg {d.avgPerDay}/day</Text>
                                  </View>
                                  {/* Total present */}
                                  <Text style={styles.manDaysDivRowTotal}>{d.total}</Text>
                                  {/* Mini attendance chips */}
                                  <View style={styles.manDaysMiniRoles}>
                                    <Text style={[styles.manDaysMiniRole, { color: '#4C9A6A' }]}>{d.present}</Text>
                                    {d.absent > 0 && (
                                      <>
                                        <Text style={styles.manDaysMiniSep}>·</Text>
                                        <Text style={[styles.manDaysMiniRole, { color: '#D64545' }]}>{d.absent}↓</Text>
                                      </>
                                    )}
                                    {d.onLeave > 0 && (
                                      <>
                                        <Text style={styles.manDaysMiniSep}>·</Text>
                                        <Text style={[styles.manDaysMiniRole, { color: '#F2A93B' }]}>{d.onLeave} L</Text>
                                      </>
                                    )}
                                  </View>
                                </View>
                              ))}
                            </View>
                          )}

                          {/* ── Supervisors who submitted data this month ── */}
                          {mo.submittedBy.length > 0 && (
                            <View style={styles.manDaysSubmittedRow}>
                              <Ionicons name="person-circle-outline" size={13} color="#5C6670" />
                              <Text style={styles.manDaysSubmittedText}>
                                {mo.submittedBy.join(', ')}
                              </Text>
                            </View>
                          )}
                        </View>
                      ))}
                    </>
                  )}

                  {/* Daily log with supervisor name */}
                  <Text style={[styles.fieldLabel, { marginTop: 14, marginBottom: 8 }]}>DAILY LOG</Text>
                  {manDaysTotals.byDate.map((d) => (
                    <View key={d.dateISO} style={styles.manDaysDayRow}>
                      <View style={styles.manDaysDayLeft}>
                        <Text style={styles.manDaysDayNum}>{d.dateDisplay}</Text>
                        <Text style={styles.manDaysDayName}>{d.dayOfWeek}</Text>
                      </View>
                      <View style={{ flex: 1 }}>
                        <View style={styles.manDaysDayBarRow}>
                          <View style={styles.manDaysDayBar}>
                            <View style={[styles.manDaysDayFill, { flex: d.total }]} />
                          </View>
                          <Text style={styles.manDaysDayTotal}>{d.total}</Text>
                        </View>
                        {d.submittedBy.length > 0 && (
                          <Text style={styles.manDaysDaySupervisor} numberOfLines={1}>
                            {d.submittedBy.join(', ')}
                          </Text>
                        )}
                      </View>
                    </View>
                  ))}
                </>
              )}

              {/* ── Attendance Sheet */}
              {reportKpiKey === 'attendance' && (
                <>
                  {/* Summary stat cards */}
                  <View style={styles.statGrid}>
                    <View style={styles.statCard}>
                      <Text style={styles.statValue}>{attendanceTotals.total}</Text>
                      <Text style={styles.statLabel}>Total Marked</Text>
                    </View>
                    <View style={styles.statCard}>
                      <Text style={[styles.statValue, { color: ATTENDANCE_STATUS_COLOR.present }]}>{attendanceTotals.present}</Text>
                      <Text style={styles.statLabel}>Present ({attendanceTotals.presentPct}%)</Text>
                    </View>
                    <View style={styles.statCard}>
                      <Text style={[styles.statValue, { color: ATTENDANCE_STATUS_COLOR.absent }]}>{attendanceTotals.absent}</Text>
                      <Text style={styles.statLabel}>Absent ({attendanceTotals.absentPct}%)</Text>
                    </View>
                    <View style={styles.statCard}>
                      <Text style={[styles.statValue, { color: ATTENDANCE_STATUS_COLOR.leave }]}>{attendanceTotals.leave}</Text>
                      <Text style={styles.statLabel}>On Leave ({attendanceTotals.leavePct}%)</Text>
                    </View>
                  </View>

                  {/* Chart 1 — Attendance % breakdown */}
                  <ChartCard
                    title="Attendance %"
                    subtitle="Present, absent, and on-leave marks, this date range"
                    legend={[
                      { color: ATTENDANCE_STATUS_COLOR.present, label: `Present (${attendanceTotals.presentPct}%)` },
                      { color: ATTENDANCE_STATUS_COLOR.absent, label: `Absent (${attendanceTotals.absentPct}%)` },
                      { color: ATTENDANCE_STATUS_COLOR.leave, label: `On Leave (${attendanceTotals.leavePct}%)` },
                    ]}
                    hasData={attendanceTotals.total > 0}
                  >
                    <View style={{ alignItems: 'center', paddingVertical: 4 }}>
                      <PieChart
                        data={[
                          { value: attendanceTotals.present, color: ATTENDANCE_STATUS_COLOR.present, text: 'Present' },
                          { value: attendanceTotals.absent, color: ATTENDANCE_STATUS_COLOR.absent, text: 'Absent' },
                          { value: attendanceTotals.leave, color: ATTENDANCE_STATUS_COLOR.leave, text: 'Leave' },
                        ].filter((d) => d.value > 0)}
                        donut
                        radius={90}
                        innerRadius={54}
                        innerCircleColor="#1D2329"
                        centerLabelComponent={() => (
                          <View style={{ alignItems: 'center' }}>
                            <Text style={{ color: '#ECEFF2', fontSize: 18, fontWeight: '800' }}>{attendanceTotals.total}</Text>
                            <Text style={{ color: '#8A96A3', fontSize: 10 }}>marked</Text>
                          </View>
                        )}
                      />
                    </View>
                  </ChartCard>

                  {/* Chart 2 — Attendance by Division */}
                  <ChartCard
                    title="Attendance by Division"
                    subtitle="Present rate per division, this date range"
                    xAxisLabel="Present %"
                    yAxisLabel="Division"
                    hasData={attendanceTotals.byDivision.length > 0}
                  >
                    <View style={{ width: '100%' }}>
                      {attendanceTotals.byDivision.map((d) => (
                        <MetricBarRow
                          key={d.division}
                          label={d.division}
                          value={d.presentPct}
                          maxValue={100}
                          color={ATTENDANCE_STATUS_COLOR.present}
                          valueLabel={`${d.presentPct}%`}
                          onPress={() =>
                            setAttendanceBarTooltip({
                              label: d.division,
                              lines: [`${d.present} present · ${d.absent} absent · ${d.leave} leave`, `${d.presentPct}% present of ${d.total} marked`],
                            })
                          }
                        />
                      ))}
                    </View>
                  </ChartCard>
                  {attendanceBarTooltip && (
                    <View style={styles.chartTooltipInline}>
                      <Text style={styles.chartTooltipTitle}>{attendanceBarTooltip.label}</Text>
                      {attendanceBarTooltip.lines.map((l) => (
                        <Text key={l} style={styles.chartTooltipText}>{l}</Text>
                      ))}
                    </View>
                  )}

                  {/* Chart 3 — Daily Attendance Trend */}
                  <ChartCard
                    title="Daily Attendance Trend"
                    subtitle="Present rate over time"
                    xAxisLabel="Date"
                    yAxisLabel="Present %"
                    legend={[{ color: ATTENDANCE_STATUS_COLOR.present, label: 'Present %' }]}
                    hasData={attendanceTotals.byDate.length > 0}
                  >
                    <LineChart
                      data={attendanceTotals.byDate.map((d) => ({
                        value: d.presentPct,
                        label: shortDateLabel(d.date),
                        labelTextStyle: { color: CHART_COLORS.axisText, fontSize: 9 },
                      }))}
                      color={ATTENDANCE_STATUS_COLOR.present}
                      dataPointsColor={ATTENDANCE_STATUS_COLOR.present}
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
                      startFillColor={ATTENDANCE_STATUS_COLOR.present}
                      startOpacity={0.15}
                      endOpacity={0.02}
                      pointerConfig={{
                        pointerStripHeight: 160,
                        pointerStripColor: CHART_COLORS.grid,
                        pointerStripWidth: 2,
                        pointerColor: ATTENDANCE_STATUS_COLOR.present,
                        radius: 5,
                        pointerLabelWidth: 130,
                        pointerLabelHeight: 60,
                        activatePointersOnLongPress: false,
                        autoAdjustPointerLabelPosition: true,
                        pointerLabelComponent: (items: any[]) => (
                          <View style={styles.chartTooltip}>
                            <Text style={styles.chartTooltipTitle}>{attendanceTotals.byDate[items?.[0]?.index ?? 0]?.date ?? ''}</Text>
                            <Text style={[styles.chartTooltipText, { color: ATTENDANCE_STATUS_COLOR.present }]}>
                              {items?.[0]?.value ?? 0}% present
                            </Text>
                          </View>
                        ),
                      }}
                    />
                  </ChartCard>

                  {/* By division */}
                  {attendanceTotals.byDivision.length > 0 && (
                    <>
                      <Text style={[styles.fieldLabel, { marginTop: 14, marginBottom: 8 }]}>BY DIVISION</Text>
                      {attendanceTotals.byDivision.map((d) => {
                        const isExpanded = expandedAttendanceDivision === d.division;
                        const divisionRecords = filteredAttendance
                          .filter((r) => (r.division || 'Unknown') === d.division)
                          .sort((a, b) => b.date.localeCompare(a.date) || a.operatorName.localeCompare(b.operatorName));
                        return (
                          <View key={d.division}>
                            <Pressable
                              onPress={() => setExpandedAttendanceDivision(isExpanded ? null : d.division)}
                              style={styles.manDaysDivCard}
                            >
                              <View style={styles.manDaysDivHeader}>
                                <Text style={styles.manDaysDivTitle}>{d.division}</Text>
                                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                                  <View style={styles.manDaysTotalBadge}>
                                    <Text style={styles.manDaysTotalBadgeText}>{d.total} marked</Text>
                                  </View>
                                  <Ionicons name={isExpanded ? 'chevron-up' : 'chevron-down'} size={16} color="#8A96A3" />
                                </View>
                              </View>
                              <View style={styles.manDaysRoleRow}>
                                <View style={styles.manDaysRoleChip}>
                                  <View style={[styles.manDaysRoleDot, { backgroundColor: ATTENDANCE_STATUS_COLOR.present }]} />
                                  <Text style={styles.manDaysRoleLabel}>Present</Text>
                                  <Text style={[styles.manDaysRoleVal, { color: ATTENDANCE_STATUS_COLOR.present }]}>{d.present}</Text>
                                </View>
                                <View style={styles.manDaysRoleChip}>
                                  <View style={[styles.manDaysRoleDot, { backgroundColor: ATTENDANCE_STATUS_COLOR.absent }]} />
                                  <Text style={styles.manDaysRoleLabel}>Absent</Text>
                                  <Text style={[styles.manDaysRoleVal, { color: ATTENDANCE_STATUS_COLOR.absent }]}>{d.absent}</Text>
                                </View>
                                <View style={styles.manDaysRoleChip}>
                                  <View style={[styles.manDaysRoleDot, { backgroundColor: ATTENDANCE_STATUS_COLOR.leave }]} />
                                  <Text style={styles.manDaysRoleLabel}>Leave</Text>
                                  <Text style={[styles.manDaysRoleVal, { color: ATTENDANCE_STATUS_COLOR.leave }]}>{d.leave}</Text>
                                </View>
                                <Text style={styles.manDaysDivAvg}>{d.presentPct}% present</Text>
                              </View>
                            </Pressable>

                            {isExpanded && (
                              <View style={styles.attendanceSheetBox}>
                                <Text style={styles.attendanceSheetTitle}>
                                  FULL ATTENDANCE SHEET · {d.division} ({divisionRecords.length})
                                </Text>
                                {divisionRecords.map((r) => (
                                  <View key={r.id} style={styles.attendanceOpRow}>
                                    <View style={{ flex: 1 }}>
                                      <Text style={styles.attendanceOpName}>{r.operatorName || 'Unnamed'}</Text>
                                      <Text style={styles.attendanceOpMeta}>
                                        {r.operatorCode ? `${r.operatorCode} · ` : ''}{r.date}
                                        {r.shift ? ` · Shift ${r.shift}` : ''}
                                        {r.submittedBy ? ` · ${r.submittedBy}` : ''}
                                      </Text>
                                    </View>
                                    <View style={[styles.attendanceStatusBadge, { borderColor: ATTENDANCE_STATUS_COLOR[r.status] }]}>
                                      <Text style={[styles.attendanceStatusBadgeText, { color: ATTENDANCE_STATUS_COLOR[r.status] }]}>
                                        {r.status === 'present' ? 'Present' : r.status === 'absent' ? 'Absent' : 'On Leave'}
                                      </Text>
                                    </View>
                                  </View>
                                ))}
                              </View>
                            )}
                          </View>
                        );
                      })}
                    </>
                  )}

                  {/* Daily log */}
                  {attendanceTotals.byDate.length > 0 && (
                    <>
                      <Text style={[styles.fieldLabel, { marginTop: 14, marginBottom: 8 }]}>DAILY LOG</Text>
                      {attendanceTotals.byDate.map((d) => (
                        <View key={d.date} style={styles.manDaysDayRow}>
                          <View style={styles.manDaysDayLeft}>
                            <Text style={styles.manDaysDayNum}>{d.date}</Text>
                            <Text style={styles.manDaysDayName}>{d.total} marked</Text>
                          </View>
                          <View style={{ flex: 1 }}>
                            <View style={styles.manDaysDayBarRow}>
                              <View style={styles.manDaysDayBar}>
                                {d.present > 0 && <View style={{ flex: d.present, backgroundColor: ATTENDANCE_STATUS_COLOR.present }} />}
                                {d.absent > 0 && <View style={{ flex: d.absent, backgroundColor: ATTENDANCE_STATUS_COLOR.absent }} />}
                                {d.leave > 0 && <View style={{ flex: d.leave, backgroundColor: ATTENDANCE_STATUS_COLOR.leave }} />}
                              </View>
                              <Text style={styles.manDaysDayTotal}>{d.presentPct}%</Text>
                            </View>
                          </View>
                        </View>
                      ))}
                    </>
                  )}
                </>
              )}

              {/* ── Loss Details */}
              {reportKpiKey === 'loss-details' && (
                <>
                  <View style={styles.statGrid}>
                    <View style={styles.statCard}>
                      <Text style={styles.statValue}>{totals.downtimeMinutes}m</Text>
                      <Text style={styles.statLabel}>Total Downtime</Text>
                    </View>
                    <View style={styles.statCard}>
                      <Text style={styles.statValue}>{totals.lostPieces}</Text>
                      <Text style={styles.statLabel}>Est. Lost Pieces</Text>
                    </View>
                  </View>

                  {/* Chart 1 — Loss Reason breakdown */}
                  <ChartCard
                    title="Loss Reason"
                    subtitle="Lost pieces by reason, this date range"
                    legend={lossPartsByReason.map((l, i) => ({
                      color: CHART_COLORS.donutPalette[i % CHART_COLORS.donutPalette.length],
                      label: `${l.reason} (${l.parts})`,
                    }))}
                    hasData={lossPartsByReason.length > 0}
                  >
                    <View style={{ alignItems: 'center', paddingVertical: 4 }}>
                      <PieChart
                        data={lossPartsByReason.map((l, i) => ({
                          value: l.parts,
                          color: CHART_COLORS.donutPalette[i % CHART_COLORS.donutPalette.length],
                          text: l.reason,
                          onPress: () =>
                            setLossBarTooltip({ chart: 'reason', label: l.reason, lines: [`${l.parts} pcs lost`] }),
                        }))}
                        donut
                        radius={90}
                        innerRadius={54}
                        innerCircleColor="#1D2329"
                        centerLabelComponent={() => (
                          <View style={{ alignItems: 'center' }}>
                            <Text style={{ color: '#ECEFF2', fontSize: 18, fontWeight: '800' }}>{totals.lostPieces}</Text>
                            <Text style={{ color: '#8A96A3', fontSize: 10 }}>lost</Text>
                          </View>
                        )}
                      />
                    </View>
                  </ChartCard>
                  {lossBarTooltip?.chart === 'reason' && (
                    <View style={styles.chartTooltipInline}>
                      <Text style={styles.chartTooltipTitle}>{lossBarTooltip.label}</Text>
                      {lossBarTooltip.lines.map((l) => (
                        <Text key={l} style={styles.chartTooltipText}>{l}</Text>
                      ))}
                    </View>
                  )}

                  {/* Chart 2 — Downtime Minutes by Line */}
                  <ChartCard
                    title="Downtime Minutes by Line"
                    subtitle="Total stopped time per line, this date range"
                    xAxisLabel="Downtime (min)"
                    yAxisLabel="Line"
                    hasData={byLine.some((b) => b.downtimeMinutes > 0)}
                  >
                    <View style={{ width: '100%' }}>
                      {byLine
                        .filter((b) => b.downtimeMinutes > 0)
                        .sort((a, b) => b.downtimeMinutes - a.downtimeMinutes)
                        .map((b) => (
                          <MetricBarRow
                            key={b.lineId}
                            label={b.lineName}
                            value={Math.round(b.downtimeMinutes)}
                            maxValue={Math.max(1, ...byLine.map((x) => Math.round(x.downtimeMinutes)))}
                            color={CHART_COLORS.loss.downtime}
                            valueLabel={`${Math.round(b.downtimeMinutes)}m`}
                            onPress={() =>
                              setLossBarTooltip({
                                chart: 'byLine',
                                label: b.lineName,
                                lines: [`${Math.round(b.downtimeMinutes)}m downtime`, `${Math.max(0, b.plan - b.actual)} pcs lost`],
                              })
                            }
                          />
                        ))}
                    </View>
                  </ChartCard>
                  {lossBarTooltip?.chart === 'byLine' && (
                    <View style={styles.chartTooltipInline}>
                      <Text style={styles.chartTooltipTitle}>{lossBarTooltip.label}</Text>
                      {lossBarTooltip.lines.map((l) => (
                        <Text key={l} style={styles.chartTooltipText}>{l}</Text>
                      ))}
                    </View>
                  )}

                  {/* Chart 3 — Loss Trend over time */}
                  <ChartCard
                    title="Loss Trend"
                    subtitle="Est. lost pieces (planned − actual) over time"
                    xAxisLabel="Date"
                    yAxisLabel="Lost pieces"
                    legend={[{ color: CHART_COLORS.loss.lostPieces, label: 'Lost pieces' }]}
                    hasData={lossByDate.length > 0}
                  >
                    <LineChart
                      data={lossByDate.map((d) => ({
                        value: d.lostPieces,
                        label: shortDateLabel(d.date),
                        labelTextStyle: { color: CHART_COLORS.axisText, fontSize: 9 },
                      }))}
                      color={CHART_COLORS.loss.lostPieces}
                      dataPointsColor={CHART_COLORS.loss.lostPieces}
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
                      startFillColor={CHART_COLORS.loss.lostPieces}
                      startOpacity={0.15}
                      endOpacity={0.02}
                      pointerConfig={{
                        pointerStripHeight: 160,
                        pointerStripColor: CHART_COLORS.grid,
                        pointerStripWidth: 2,
                        pointerColor: CHART_COLORS.loss.lostPieces,
                        radius: 5,
                        pointerLabelWidth: 140,
                        pointerLabelHeight: 60,
                        activatePointersOnLongPress: false,
                        autoAdjustPointerLabelPosition: true,
                        pointerLabelComponent: (items: any[]) => (
                          <View style={styles.chartTooltip}>
                            <Text style={styles.chartTooltipTitle}>{lossByDate[items?.[0]?.index ?? 0]?.dateLabel ?? ''}</Text>
                            <Text style={[styles.chartTooltipText, { color: CHART_COLORS.loss.lostPieces }]}>
                              {items?.[0]?.value ?? 0} pcs lost
                            </Text>
                          </View>
                        ),
                      }}
                    />
                  </ChartCard>

                  <Text style={[styles.fieldLabel, { marginTop: 14, marginBottom: 8 }]}>DOWNTIME BY REASON</Text>
                  {lossByReason.length === 0 ? (
                    <Text style={styles.muted}>No stops recorded in this range.</Text>
                  ) : (
                    lossByReason.map((l) => (
                      <View key={l.reason} style={styles.lineCard}>
                        <Text style={styles.lineCardTitle}>{l.reason}</Text>
                        <Text style={styles.lineCardStat}>{l.minutes}m</Text>
                      </View>
                    ))
                  )}
                  <Text style={[styles.fieldLabel, { marginTop: 14, marginBottom: 8 }]}>BY LINE</Text>
                  {byLine.map((b) => (
                    <View key={b.lineId} style={styles.lineCard}>
                      <Text style={styles.lineCardTitle}>{b.lineName}</Text>
                      <Text style={styles.lineCardStat}>{Math.max(0, b.plan - b.actual)} lost · {Math.round(b.downtimeMinutes)}m down</Text>
                    </View>
                  ))}
                </>
              )}
            </>
          )
        )}

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#14181C' },
  scroll: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 40 },
  centered: { alignItems: 'center', justifyContent: 'center', gap: 10, paddingVertical: 30 },
  backButton: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 12 },
  backText: { color: '#8A96A3', fontSize: 15 },
  title: { color: '#ECEFF2', fontSize: 23, fontWeight: '800' },
  subtitle: { color: '#8A96A3', fontSize: 13, marginTop: 4, marginBottom: 20, lineHeight: 18 },
  sectionLabel: { color: '#F2A93B', fontSize: 11.5, fontWeight: '800', letterSpacing: 1.4, marginBottom: 10, marginTop: 6 },
  resultsHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  excelButton: { flexDirection: 'row', alignItems: 'center', gap: 5, borderWidth: 1, borderColor: '#4C9A6A', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  excelButtonDisabled: { opacity: 0.5 },
  excelButtonText: { color: '#4C9A6A', fontWeight: '700', fontSize: 12 },
  fieldLabel: { color: '#8A96A3', fontSize: 11, fontWeight: '700', letterSpacing: 0.8, marginBottom: 6 },
  field: { marginBottom: 14 },
  rowGap: { flexDirection: 'row', gap: 12 },
  input: {
    backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C',
    borderRadius: 10, paddingHorizontal: 12, color: '#ECEFF2', fontSize: 14.5, height: 48,
  },
  chipsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderColor: '#2C343C', backgroundColor: '#1D2329', borderRadius: 20, paddingHorizontal: 14, paddingVertical: 9 },
  chipSelected: { borderColor: '#F2A93B', backgroundColor: '#F2A93B22' },
  chipText: { color: '#8A96A3', fontSize: 13, fontWeight: '600' },
  chipTextSelected: { color: '#F2A93B' },
  kpiChip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    borderWidth: 1, borderColor: '#2C343C', backgroundColor: '#1D2329',
    borderRadius: 20, paddingHorizontal: 14, paddingVertical: 9,
  },
  muted: { color: '#8A96A3', fontSize: 12 },
  errorText: { color: '#F0A8A8', fontSize: 13.5, textAlign: 'center' },
  emptyText: { color: '#5C6670', fontSize: 14, textAlign: 'center' },
  retryButton: { borderWidth: 1, borderColor: '#2C343C', borderRadius: 8, paddingHorizontal: 16, paddingVertical: 8, marginTop: 4 },
  retryText: { color: '#ECEFF2', fontSize: 13, fontWeight: '600' },

  showReportButton: { height: 56, borderRadius: 12, backgroundColor: '#F2A93B', alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 10, marginTop: 16 },
  showReportButtonPressed: { opacity: 0.85 },
  showReportButtonText: { color: '#14181C', fontSize: 16, fontWeight: '900' },

  statGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  statCard: {
    flexGrow: 1, minWidth: '30%', backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C',
    borderRadius: 10, paddingVertical: 14, alignItems: 'center', gap: 4,
  },
  statValue: { color: '#ECEFF2', fontSize: 18, fontWeight: '800' },
  statLabel: { color: '#8A96A3', fontSize: 11, fontWeight: '700', textAlign: 'center' },

  lineCard: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C',
    borderRadius: 10, padding: 12, marginBottom: 8,
  },
  lineCardTitle: { color: '#ECEFF2', fontSize: 14, fontWeight: '700' },
  lineCardStat: { color: '#ECEFF2', fontSize: 13, fontWeight: '700' },

  pcsDayCard: {
    backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C',
    borderRadius: 10, padding: 12, marginBottom: 10,
  },
  pcsDayHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  pcsDayLabel: { color: '#ECEFF2', fontSize: 14, fontWeight: '700' },
  pcsDayPcs: { color: '#F2A93B', fontSize: 13, fontWeight: '800' },
  pcsDayNoAtt: { color: '#8A96A3', fontSize: 11.5, fontStyle: 'italic' },
  pcsDayStatRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 14, marginBottom: 4 },
  pcsDayStat: { color: '#8A96A3', fontSize: 12 },
  pcsDayStatVal: { color: '#ECEFF2', fontWeight: '700' },
  pcsDayLines: { marginTop: 6, borderTopWidth: 1, borderTopColor: '#2C343C', paddingTop: 8, gap: 4 },
  pcsLineRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  pcsLineName: { color: '#8A96A3', fontSize: 12, flex: 1 },
  pcsLineStat: { color: '#8A96A3', fontSize: 12 },

  nearMissCard: {
    backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C',
    borderRadius: 10, padding: 12, marginBottom: 10,
  },
  nearMissTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  nearMissArea: { color: '#ECEFF2', fontSize: 14, fontWeight: '700', flex: 1, marginRight: 8 },
  nearMissBadge: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  nearMissBadgeText: { fontSize: 10.5, fontWeight: '800' },
  nearMissMeta: { color: '#8A96A3', fontSize: 11.5, marginBottom: 8 },
  nearMissField: { marginBottom: 8 },
  nearMissFieldLabel: { color: '#5C6670', fontSize: 9.5, fontWeight: '800', letterSpacing: 0.6, marginBottom: 3 },
  nearMissDesc: { color: '#ECEFF2', fontSize: 12.5, lineHeight: 17 },
  nearMissDetailGrid: { flexDirection: 'row', gap: 10, marginBottom: 10, marginTop: 2 },
  nearMissDetailItem: { flex: 1 },
  nearMissDetailValue: { color: '#ECEFF2', fontSize: 12, fontWeight: '600' },
  nearMissFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4, paddingTop: 8, borderTopWidth: 1, borderTopColor: '#2C343C' },
  nearMissStatusBadge: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  nearMissStatusText: { fontSize: 10.5, fontWeight: '800' },
  nearMissSubmitter: { color: '#5C6670', fontSize: 11 },

  // ── Poka Yoke styles
  pokaYokeCard: {
    backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C',
    borderRadius: 10, padding: 12, marginBottom: 10,
  },
  pokaYokeTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  pokaYokeTitle: { color: '#ECEFF2', fontSize: 14, fontWeight: '700', flex: 1, marginRight: 8 },
  pokaYokeBadge: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  pokaYokeBadgeText: { fontSize: 10.5, fontWeight: '800' },
  pokaYokeMeta: { color: '#8A96A3', fontSize: 11.5, marginBottom: 8 },
  pokaYokeDetail: { color: '#ECEFF2', fontSize: 12.5, lineHeight: 17, marginBottom: 6 },
  pokaYokeField: { marginBottom: 8 },
  pokaYokeFieldLabel: { color: '#5C6670', fontSize: 9.5, fontWeight: '800', letterSpacing: 0.6, marginBottom: 3 },
  pokaYokeDesc: { color: '#ECEFF2', fontSize: 12.5, lineHeight: 17 },
  pokaYokeFooter: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 4, paddingTop: 8, borderTopWidth: 1, borderTopColor: '#2C343C' },
  pokaYokeFooterText: { color: '#8A96A3', fontSize: 11.5 },
  pokaYokeSubmitter: { color: '#5C6670', fontSize: 11, marginTop: 6 },

  // ── Man-Days styles
  manDaysDivCard: {
    backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C',
    borderRadius: 10, padding: 12, marginBottom: 8,
  },
  manDaysDivHeader: {
    flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between', marginBottom: 10,
  },
  manDaysDivTitle:    { color: '#ECEFF2', fontSize: 14, fontWeight: '700', flex: 1, marginRight: 8 },
  manDaysTotalBadge:  { backgroundColor: '#3E7CB122', borderWidth: 1, borderColor: '#3E7CB1', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 3 },
  manDaysTotalBadgeText: { color: '#3E7CB1', fontSize: 12, fontWeight: '800' },
  manDaysRoleRow:     { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  manDaysRoleChip:    { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#14181C', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 5 },
  manDaysRoleDot:     { width: 6, height: 6, borderRadius: 3 },
  manDaysRoleLabel:   { color: '#5C6670', fontSize: 11 },
  manDaysRoleVal:     { fontSize: 12, fontWeight: '800' },
  manDaysDivAvg:      { color: '#8A96A3', fontSize: 11, marginLeft: 'auto' },

  manDaysDayRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#1D2329',
  },
  manDaysDayLeft:  { width: 72 },
  manDaysDayNum:   { color: '#ECEFF2', fontWeight: '700', fontSize: 12 },
  manDaysDayName:  { color: '#5C6670', fontSize: 11 },
  manDaysDayBar:   { flex: 1, height: 6, backgroundColor: '#1D2329', borderRadius: 3, flexDirection: 'row', overflow: 'hidden' },
  manDaysDayFill:  { backgroundColor: '#3E7CB1', borderRadius: 3 },
  manDaysDayBarRow:  { flexDirection: 'row', alignItems: 'center', gap: 8 },
  manDaysDayTotal:   { color: '#3E7CB1', fontWeight: '800', fontSize: 14, width: 32, textAlign: 'right' },
  manDaysDaySupervisor: { color: '#5C6670', fontSize: 10.5, marginTop: 2 },

  // Monthly card
  manDaysMonthCard: {
    backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C',
    borderRadius: 12, padding: 14, marginBottom: 10,
  },
  manDaysMonthHeader: {
    flexDirection: 'row', alignItems: 'flex-start',
    justifyContent: 'space-between', marginBottom: 10,
  },
  manDaysMonthLabel:    { color: '#ECEFF2', fontSize: 16, fontWeight: '800' },
  manDaysMonthDays:     { color: '#5C6670', fontSize: 11.5, marginTop: 2 },
  manDaysMonthBadge:    { alignItems: 'center', backgroundColor: '#3E7CB122', borderWidth: 1, borderColor: '#3E7CB1', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 6 },
  manDaysMonthBadgeNum: { color: '#3E7CB1', fontSize: 20, fontWeight: '900', lineHeight: 24 },
  manDaysMonthBadgeLbl: { color: '#3E7CB1', fontSize: 10, fontWeight: '700' },
  manDaysSubmittedRow:  { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 10, paddingTop: 8, borderTopWidth: 1, borderTopColor: '#2C343C' },
  manDaysSubmittedText: { color: '#8A96A3', fontSize: 11.5, flex: 1 },

  // Avg manpower badge on month card
  manDaysAvgBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: '#F2A93B18', borderWidth: 1, borderColor: '#F2A93B55',
    borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3,
  },
  manDaysAvgBadgeText: { color: '#F2A93B', fontSize: 11.5, fontWeight: '700' },

  // Per-division section inside month card
  manDaysDivSection: {
    borderTopWidth: 1, borderTopColor: '#2C343C', paddingTop: 10, marginTop: 2,
  },
  manDaysDivSectionLabel: {
    color: '#5C6670', fontSize: 9.5, fontWeight: '800', letterSpacing: 1,
    marginBottom: 6,
  },
  manDaysDivRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#14181C', gap: 8,
  },
  manDaysDivRowLeft:  { flex: 1 },
  manDaysDivRowName:  { color: '#ECEFF2', fontSize: 13, fontWeight: '700' },
  manDaysDivRowDays:  { color: '#5C6670', fontSize: 11, marginTop: 1 },
  manDaysDivRowTotal: {
    color: '#3E7CB1', fontWeight: '900', fontSize: 18,
    minWidth: 36, textAlign: 'right',
  },
  manDaysMiniRoles: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  manDaysMiniRole:  { fontSize: 11.5, fontWeight: '700' },
  manDaysMiniSep:   { color: '#2C343C', fontSize: 11 },

  // ── Attendance drill-down (full sheet for a division)
  attendanceSheetBox: {
    backgroundColor: '#14181C', borderWidth: 1, borderColor: '#2C343C',
    borderRadius: 10, padding: 10, marginTop: -4, marginBottom: 8,
  },
  attendanceSheetTitle: {
    color: '#5C6670', fontSize: 9.5, fontWeight: '800', letterSpacing: 0.8, marginBottom: 8,
  },
  attendanceOpRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C',
    borderRadius: 8, padding: 10, marginBottom: 6, gap: 8,
  },
  attendanceOpName: { color: '#ECEFF2', fontSize: 13.5, fontWeight: '700' },
  attendanceOpMeta: { color: '#8A96A3', fontSize: 11, marginTop: 2 },
  attendanceStatusBadge: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 9, paddingVertical: 4 },
  attendanceStatusBadgeText: { fontSize: 11, fontWeight: '800' },

  // ── Charts (shared shell — see ChartCard)
  chartCard: {
    backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C',
    borderRadius: 14, padding: 16, marginTop: 14,
  },
  chartTitle: { color: '#ECEFF2', fontSize: 15, fontWeight: '800' },
  chartSubtitle: { color: '#8A96A3', fontSize: 11.5, marginTop: 2, marginBottom: 10, lineHeight: 15 },
  chartLegendRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginBottom: 10 },
  chartLegendItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  chartLegendDot: { width: 9, height: 9, borderRadius: 4.5 },
  chartLegendText: { color: '#8A96A3', fontSize: 10.5, fontWeight: '600' },
  chartAxisLabelY: { color: '#5C6670', fontSize: 9.5, fontWeight: '700', letterSpacing: 0.4, marginBottom: 4 },
  chartAxisLabelX: { color: '#5C6670', fontSize: 9.5, fontWeight: '700', letterSpacing: 0.4, marginTop: 8, textAlign: 'center' },
  chartBody: { alignItems: 'center' },
  chartBarTopLabel: { color: '#ECEFF2', fontSize: 9, fontWeight: '700', marginBottom: 2 },
  chartEmptyBox: {
    alignItems: 'center', justifyContent: 'center', paddingVertical: 32, gap: 8,
  },
  chartEmptyText: { color: '#5C6670', fontSize: 12.5, fontWeight: '600' },
  // Tooltip rendered by LineChart's own pointerConfig (float above the touch point)
  chartTooltip: {
    backgroundColor: '#0E1114', borderWidth: 1, borderColor: '#2C343C', borderRadius: 8,
    padding: 8, minWidth: 110,
  },
  // Tooltip rendered by us below a BarChart on tap (see pvaBarTooltip)
  chartTooltipInline: {
    backgroundColor: '#0E1114', borderWidth: 1, borderColor: '#2C343C', borderRadius: 8,
    padding: 10, marginTop: -6, marginBottom: 4,
  },
  chartTooltipTitle: { color: '#ECEFF2', fontSize: 12, fontWeight: '800', marginBottom: 2 },
  chartTooltipText: { color: '#8A96A3', fontSize: 11.5, fontWeight: '600' },

  // ── Achievement % bar rows (hand-built, see AchievementBarRow)
  achievementRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  achievementRowLabel: { color: '#8A96A3', fontSize: 11, fontWeight: '600', width: 72 },
  achievementRowTrack: {
    flex: 1, height: 18, borderRadius: 9, backgroundColor: '#14181C',
    borderWidth: 1, borderColor: '#2C343C', overflow: 'hidden',
  },
  achievementRowFill: { height: '100%', borderRadius: 9 },
  achievementRowValue: { fontSize: 12, fontWeight: '800', width: 44, textAlign: 'right' },
});