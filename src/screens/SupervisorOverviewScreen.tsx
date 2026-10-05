// src/screens/SupervisorOverviewScreen.tsx
//
// Supervisor MAIN dashboard — a digital overview of the supervisor's OWN
// active production session(s). Chart-free, like the Admin overview.
//
// ─── ACTIVE SESSION ──────────────────────────────────────────────────────────
// No new session system was invented. This reuses RecordProductionScreen's
// existing one exactly:
//
//   activeSessions/{lineId}  — ONE doc per line that is currently running.
//   Created by handleStartProduction, kept current by persistSession, and
//   deleted by handleFinalizeSession when the supervisor ends the session.
//   Each doc carries supervisorUid, so "my active lines" is precisely the
//   set of activeSessions docs whose supervisorUid === the logged-in uid —
//   the same filter RecordProductionScreen's own loadActiveSessions uses
//   for its "continue where you left off" list.
//
// A supervisor can legitimately run several lines at once (see that
// screen's header comment: "Removed auto-restore of one session per
// supervisor so a supervisor can record for multiple lines"), so the
// dashboard treats every matching doc as one active line of the current
// session, grouped by the session's shift + productionDate.
//
// Lines the supervisor is NOT running have no activeSessions doc with
// their uid, so they are never fetched and never displayed. Factory-wide
// lines are not loaded at all.
//
// ─── PRODUCTION DATA ─────────────────────────────────────────────────────────
// The real `productionRecords` collection written by RecordProductionScreen
// (saveSlot / handleFinalizeSession). Never sampleProductionRecords or any
// mock source. Records are matched on `productionDate` — the 6:30 AM-cutover
// production-day key the session itself is pinned to — then narrowed to the
// active line ids client-side.
//
// ─── FORMULAS ────────────────────────────────────────────────────────────────
// Identical to the Admin overview / GenerateReportScreen / KPIAnalysisScreen,
// so a supervisor and an admin looking at the same line always see the
// same numbers:
//   actual        = Σ producedThisSlot
//   target        = Σ expectedParts
//   achievement   = actual / target * 100      (GenerateReport "efficiency")
//   rejectionPct  = rejections / (actual + rejections) * 100
//   qualityPct    = 100 - rejectionPct
//   downtime      = Σ stopEvents[].durationMinutes
//   lossParts     = Σ lossParts ?? max(0, target - actual)
// Shift Plan is the session doc's own `plannedProductionTotal` field (what
// RecordProductionScreen computed at session start) — read, not recomputed.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  RefreshControl,
  useWindowDimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { collection, getDocs, onSnapshot, query, where } from 'firebase/firestore';
import { db } from '../services/firebase';
import { useAuthStore } from '../stores/authStore';
import { SUPERVISOR_MENU_ITEMS } from '../constants/supervisorMenu';
import AppDrawer from '../components/AppDrawer';

// ─── Types ────────────────────────────────────────────────────────────────────

interface StopEventRecord {
  reason: string;
  durationMinutes?: number | null;
}

// The subset of RecordProductionScreen's ActiveSessionDoc this screen reads.
// Field names are that doc's, unchanged.
interface ActiveSession {
  lineId: string;
  lineName: string | null;
  plant: string | null;
  workshop: string | null;
  division: string | null;
  shift: 'A' | 'B';
  productionDate: string | null;
  plannedProductionTotal: number | null;
  supervisorName: string | null;
  operatorCount: number;
  lineStopped: boolean;
  startedAtMs: number | null;
  updatedAtMs: number | null;
}

interface ProductionRecord {
  id: string;
  shift: 'A' | 'B';
  lineId: string | null;
  lineName: string | null;
  partName: string | null;
  productionDate: string | null;
  expectedParts: number | null;
  producedThisSlot: number | null;
  lossParts: number | null;
  rejections: number | null;
  stopEvents: StopEventRecord[] | null;
}

// ─── Shift windows ────────────────────────────────────────────────────────────
// Mirrors RecordProductionScreen's SHIFT_A_START / SHIFT_A_END /
// SHIFT_B_START / SHIFT_B_END_ABS (those are module-private there), so the
// session header shows a supervisor the same window their recording screen
// does. Absolute minutes, so Shift B's end rolls past midnight.

const SHIFT_WINDOWS: Record<'A' | 'B', { start: number; end: number }> = {
  A: { start: 7 * 60, end: 15 * 60 + 30 },
  B: { start: 19 * 60, end: 24 * 60 + 3 * 60 + 30 },
};

function formatAbsMinutesToAmPm(mAbs: number) {
  const m = ((mAbs % 1440) + 1440) % 1440;
  const hh = Math.floor(m / 60);
  const mm = m % 60;
  const suffix = hh >= 12 ? 'PM' : 'AM';
  const hour12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${hour12.toString().padStart(2, '0')}:${mm.toString().padStart(2, '0')} ${suffix}`;
}

function shiftWindowLabel(shift: 'A' | 'B') {
  const w = SHIFT_WINDOWS[shift];
  return `${formatAbsMinutesToAmPm(w.start)} – ${formatAbsMinutesToAmPm(w.end)}`;
}

// ─── Formatting ───────────────────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function prettyDate(s: string | null): string {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return '—';
  const [y, m, d] = s.split('-');
  return `${d} ${MONTHS[Number(m) - 1]} ${y}`;
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

// Same colour bands the Admin overview and the report screens use.
function efficiencyColor(pct: number) {
  return pct >= 85 ? '#4C9A6A' : pct >= 60 ? '#F2A93B' : '#D64545';
}
function rejectionColor(pct: number) {
  return pct <= 2 ? '#4C9A6A' : pct <= 5 ? '#F2A93B' : '#D64545';
}

// ─── Aggregation ──────────────────────────────────────────────────────────────
// One helper, used for both the per-line cards and the session totals, so
// the line numbers always add up to the headline numbers.

interface Totals {
  actual: number;
  target: number;
  rejections: number;
  downtimeMinutes: number;
  lossParts: number;
  achievement: number;
  rejectionPct: number;
  qualityPct: number;
  goodParts: number;
  recordCount: number;
}

function aggregate(records: ProductionRecord[]): Totals {
  let actual = 0;
  let target = 0;
  let rejections = 0;
  let downtimeMinutes = 0;
  let lossParts = 0;

  records.forEach((r) => {
    const produced = r.producedThisSlot ?? 0;
    const expected = r.expectedParts ?? 0;
    actual += produced;
    target += expected;
    lossParts += r.lossParts ?? Math.max(0, expected - produced);
    rejections += r.rejections ?? 0;
    (r.stopEvents ?? []).forEach((se) => {
      downtimeMinutes += se.durationMinutes ?? 0;
    });
  });

  const achievement = target > 0 ? round1((actual / target) * 100) : 0;
  const rejectionPct =
    actual + rejections > 0 ? round1((rejections / (actual + rejections)) * 100) : 0;

  return {
    actual,
    target,
    rejections,
    downtimeMinutes: Math.round(downtimeMinutes),
    lossParts: Math.round(lossParts),
    achievement,
    rejectionPct,
    qualityPct: round1(100 - rejectionPct),
    goodParts: Math.max(0, actual - rejections),
    recordCount: records.length,
  };
}

// ─── Small presentational pieces ──────────────────────────────────────────────

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

function LineStat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={styles.lineStat}>
      <Text style={styles.lineStatLabel}>{label}</Text>
      <Text style={[styles.lineStatValue, color ? { color } : null]} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
    </View>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function SupervisorOverviewScreen() {
  const navigation = useNavigation<any>();
  const user = useAuthStore((s) => s.user);
  const { width } = useWindowDimensions();

  const [drawerOpen, setDrawerOpen] = useState(false);

  const [sessions, setSessions] = useState<ActiveSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsError, setSessionsError] = useState<string | null>(null);

  const [records, setRecords] = useState<ProductionRecord[]>([]);
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [recordsError, setRecordsError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // ── STEP 1: resolve the supervisor's active session(s), live.
  //
  // A listener rather than a one-off read, so starting a line, stopping it,
  // or finalizing a session on the recording screen updates this dashboard
  // without the supervisor doing anything. Filtered by supervisorUid in
  // memory — the same approach loadActiveSessions takes, and it avoids a
  // composite index.
  const subscribeSessions = useCallback(() => {
    if (!user?.uid) {
      setSessions([]);
      setSessionsLoading(false);
      return () => {};
    }
    setSessionsLoading(true);
    setSessionsError(null);
    return onSnapshot(
      collection(db, 'activeSessions'),
      (snap) => {
        const mine: ActiveSession[] = snap.docs
          .map((d) => {
            const data: any = d.data();
            return {
              lineId: data.lineId ?? d.id,
              lineName: data.lineName ?? null,
              plant: data.plant ?? null,
              workshop: data.workshop ?? null,
              division: data.division ?? null,
              shift: data.shift === 'B' ? 'B' : 'A',
              productionDate: data.productionDate ?? null,
              plannedProductionTotal: data.plannedProductionTotal ?? null,
              supervisorName: data.supervisorName ?? null,
              operatorCount: Array.isArray(data.operators) ? data.operators.length : 0,
              lineStopped: data.lineStopped === true,
              startedAtMs: data.startedAt?.toMillis ? data.startedAt.toMillis() : null,
              updatedAtMs: data.updatedAt?.toMillis ? data.updatedAt.toMillis() : null,
              _uid: data.supervisorUid ?? null,
            } as ActiveSession & { _uid: string | null };
          })
          .filter((s: any) => s._uid === user.uid)
          .sort((a, b) => (a.lineName ?? '').localeCompare(b.lineName ?? ''));
        setSessions(mine);
        setSessionsLoading(false);
        setSessionsError(null);
      },
      (err) => {
        console.error('[SupervisorOverview] activeSessions listener error', err);
        setSessionsError('Unable to load active session');
        setSessionsLoading(false);
      }
    );
  }, [user?.uid]);

  useEffect(() => {
    const unsub = subscribeSessions();
    return () => unsub();
  }, [subscribeSessions]);

  // ── STEP 2: the active line ids and production day(s) of that session.
  const activeLineIds = useMemo(() => sessions.map((s) => s.lineId), [sessions]);
  const productionDates = useMemo(
    () => Array.from(new Set(sessions.map((s) => s.productionDate).filter(Boolean) as string[])),
    [sessions]
  );

  // Re-fetch production whenever the active lines change OR any session doc
  // is written (persistSession bumps updatedAt on every save), which is what
  // keeps the numbers current while the supervisor records.
  const fetchSignature = useMemo(
    () =>
      sessions
        .map((s) => `${s.lineId}:${s.productionDate}:${s.updatedAtMs ?? 0}`)
        .sort()
        .join('|'),
    [sessions]
  );

  // ── STEP 3: production records for those production day(s), narrowed to
  // the active lines.
  //
  // Equality on productionDate only (a single-field index Firestore
  // provides automatically) — no composite index needed. lineId is matched
  // in memory because Firestore cannot combine an `in` on one field with an
  // `in` on another. In practice a supervisor's sessions share one
  // production day, so this is one query.
  const fetchRecords = useCallback(
    async (dates: string[], lineIds: string[], isRefresh = false) => {
      if (dates.length === 0 || lineIds.length === 0) {
        setRecords([]);
        setRecordsError(null);
        return;
      }
      if (!isRefresh) setRecordsLoading(true);
      setRecordsError(null);
      try {
        const lineIdSet = new Set(lineIds);
        // `in` caps at 10 values; more than 10 distinct production days
        // across one supervisor's live sessions isn't a real scenario, but
        // slice defensively rather than letting Firestore throw.
        const snap = await getDocs(
          query(collection(db, 'productionRecords'), where('productionDate', 'in', dates.slice(0, 10)))
        );
        const mapped: ProductionRecord[] = snap.docs
          .map((d) => {
            const data: any = d.data();
            return {
              id: d.id,
              shift: data.shift === 'B' ? 'B' : 'A',
              lineId: data.lineId ?? null,
              lineName: data.lineName ?? null,
              partName: data.partName ?? null,
              productionDate: data.productionDate ?? null,
              expectedParts: data.expectedParts ?? null,
              producedThisSlot: data.producedThisSlot ?? null,
              lossParts: data.lossParts ?? null,
              rejections: data.rejections ?? null,
              stopEvents: Array.isArray(data.stopEvents) ? data.stopEvents : null,
            } as ProductionRecord;
          })
          // ONLY this supervisor's active lines. Nothing from another
          // line, another supervisor, or an inactive line reaches the UI.
          .filter((r) => r.lineId != null && lineIdSet.has(r.lineId));
        setRecords(mapped);
      } catch (e) {
        console.error('[SupervisorOverview] productionRecords fetch failed', e);
        setRecords([]);
        setRecordsError('Unable to load production data');
      } finally {
        setRecordsLoading(false);
        setRefreshing(false);
      }
    },
    []
  );

  // Keyed on fetchSignature so an unrelated re-render never refetches.
  const lastSignature = useRef<string>('');
  useEffect(() => {
    if (sessionsLoading) return;
    if (fetchSignature === lastSignature.current) return;
    lastSignature.current = fetchSignature;
    fetchRecords(productionDates, activeLineIds);
  }, [fetchSignature, sessionsLoading, productionDates, activeLineIds, fetchRecords]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchRecords(productionDates, activeLineIds, true);
  }, [fetchRecords, productionDates, activeLineIds]);

  const retry = useCallback(() => {
    lastSignature.current = '';
    setSessionsError(null);
    fetchRecords(productionDates, activeLineIds);
  }, [fetchRecords, productionDates, activeLineIds]);

  // ── Session-wide totals, and one rollup per active line.
  const totals = useMemo(() => aggregate(records), [records]);

  const byLine = useMemo(() => {
    const recordsByLine = new Map<string, ProductionRecord[]>();
    records.forEach((r) => {
      if (!r.lineId) return;
      const list = recordsByLine.get(r.lineId);
      if (list) list.push(r);
      else recordsByLine.set(r.lineId, [r]);
    });
    // Driven by the SESSION list, not by the records — a line that has just
    // started and has no saved slot yet must still appear, showing zeros
    // against its plan rather than vanishing.
    return sessions.map((s) => ({
      session: s,
      totals: aggregate(recordsByLine.get(s.lineId) ?? []),
    }));
  }, [sessions, records]);

  // Shift plan across the active lines — read straight off each session doc's
  // plannedProductionTotal, which RecordProductionScreen already computed.
  const shiftPlanTotal = useMemo(
    () => sessions.reduce((sum, s) => sum + (s.plannedProductionTotal ?? 0), 0),
    [sessions]
  );
  const planProgress = shiftPlanTotal > 0 ? round1((totals.actual / shiftPlanTotal) * 100) : 0;

  // Session header facts. Shift/date come from the session docs themselves.
  const sessionShifts = useMemo(
    () => Array.from(new Set(sessions.map((s) => s.shift))).sort(),
    [sessions]
  );
  const sessionDateLabel = productionDates.length === 1 ? prettyDate(productionDates[0]) : null;
  const supervisorLabel =
    sessions[0]?.supervisorName || user?.name || user?.email || 'Supervisor';
  const stoppedCount = sessions.filter((s) => s.lineStopped).length;

  // ── Responsive: percentage widths in a wrapping row, so nothing can
  // overflow horizontally at any breakpoint.
  const kpiColumns = width >= 1100 ? 4 : width >= 760 ? 3 : 2;
  const kpiWidth = `${100 / kpiColumns - (kpiColumns === 2 ? 1.6 : 1.2)}%`;
  const lineColumns = width >= 1100 ? 3 : width >= 700 ? 2 : 1;
  const lineCardWidth = lineColumns === 1 ? '100%' : `${100 / lineColumns - 1.4}%`;

  const hasSession = sessions.length > 0;

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
          <Text style={styles.brandSub}>Production Overview</Text>
        </View>
        <View style={styles.rolePill}>
          <Text style={styles.rolePillText}>SUPERVISOR</Text>
        </View>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#3E7CB1" />
        }
      >
        {sessionsLoading ? (
          /* ── Resolving the session ─────────────────────────────────── */
          <View style={styles.stateBlock}>
            <ActivityIndicator size="large" color="#3E7CB1" />
            <Text style={styles.stateText}>Loading active session…</Text>
          </View>
        ) : sessionsError ? (
          /* ── Session load failed ───────────────────────────────────── */
          <View style={styles.stateCard}>
            <View style={[styles.stateIcon, { borderColor: '#D64545', backgroundColor: '#D6454522' }]}>
              <Ionicons name="cloud-offline-outline" size={30} color="#D64545" />
            </View>
            <Text style={styles.stateTitle}>Unable to load active session</Text>
            <Text style={styles.stateText}>Check your connection and try again.</Text>
            <Pressable
              onPress={retry}
              style={({ pressed }) => [styles.actionButton, pressed && styles.pressed]}
              accessibilityRole="button"
              accessibilityLabel="Retry"
            >
              <Ionicons name="refresh" size={16} color="#ECEFF2" />
              <Text style={styles.actionText}>Retry</Text>
            </Pressable>
          </View>
        ) : !hasSession ? (
          /* ── No active session ─────────────────────────────────────── */
          /* No factory-wide fallback: nothing is shown rather than data
             from lines this supervisor isn't running. */
          <View style={styles.stateCard}>
            <View style={[styles.stateIcon, { borderColor: '#5C6670', backgroundColor: '#5C667022' }]}>
              <Ionicons name="power-outline" size={30} color="#8A96A3" />
            </View>
            <Text style={styles.stateTitle}>No Active Session</Text>
            <Text style={styles.stateText}>
              There is currently no active production session assigned to you.
            </Text>
            <Pressable
              onPress={() => navigation.navigate('RecordProduction')}
              style={({ pressed }) => [styles.actionButtonPrimary, pressed && styles.pressed]}
              accessibilityRole="button"
              accessibilityLabel="Start production"
            >
              <Ionicons name="play" size={16} color="#0E1216" />
              <Text style={styles.actionTextPrimary}>Start Production</Text>
            </Pressable>
          </View>
        ) : (
          <>
            {/* ── Session banner ──────────────────────────────────── */}
            <View style={styles.sessionCard}>
              <View style={styles.sessionRow}>
                <Ionicons name="person-circle-outline" size={17} color="#8A96A3" />
                <Text style={styles.sessionLabel}>Supervisor</Text>
                <Text style={styles.sessionValue} numberOfLines={1}>
                  {supervisorLabel}
                </Text>
              </View>
              <View style={styles.sessionRow}>
                <Ionicons name="time-outline" size={17} color="#8A96A3" />
                <Text style={styles.sessionLabel}>Session</Text>
                <Text style={styles.sessionValue} numberOfLines={1}>
                  {sessionShifts.map((sh) => `Shift ${sh}`).join(' + ')}
                  {sessionShifts.length === 1 ? ` • ${shiftWindowLabel(sessionShifts[0])}` : ''}
                </Text>
              </View>
              <View style={styles.sessionRow}>
                <Ionicons name="calendar-outline" size={17} color="#8A96A3" />
                <Text style={styles.sessionLabel}>Production Day</Text>
                <Text style={styles.sessionValue} numberOfLines={1}>
                  {sessionDateLabel ?? `${productionDates.length} days`}
                </Text>
              </View>
              <View style={styles.sessionBadges}>
                <View style={styles.sessionBadge}>
                  <View style={[styles.dot, { backgroundColor: '#4C9A6A' }]} />
                  <Text style={styles.sessionBadgeText}>
                    {sessions.length} active {sessions.length === 1 ? 'line' : 'lines'}
                  </Text>
                </View>
                {stoppedCount > 0 ? (
                  <View style={[styles.sessionBadge, styles.sessionBadgeAlert]}>
                    <View style={[styles.dot, { backgroundColor: '#D64545' }]} />
                    <Text style={[styles.sessionBadgeText, { color: '#D64545' }]}>
                      {stoppedCount} stopped
                    </Text>
                  </View>
                ) : null}
                {recordsLoading ? <ActivityIndicator size="small" color="#3E7CB1" /> : null}
              </View>
            </View>

            {recordsError ? (
              /* Production failed but the session resolved — keep the
                 session banner visible rather than blanking the screen. */
              <View style={styles.stateCard}>
                <View style={[styles.stateIcon, { borderColor: '#D64545', backgroundColor: '#D6454522' }]}>
                  <Ionicons name="cloud-offline-outline" size={30} color="#D64545" />
                </View>
                <Text style={styles.stateTitle}>Unable to load production data</Text>
                <Pressable
                  onPress={retry}
                  style={({ pressed }) => [styles.actionButton, pressed && styles.pressed]}
                  accessibilityRole="button"
                  accessibilityLabel="Retry"
                >
                  <Ionicons name="refresh" size={16} color="#ECEFF2" />
                  <Text style={styles.actionText}>Retry</Text>
                </Pressable>
              </View>
            ) : recordsLoading ? (
              <View style={styles.stateBlock}>
                <View style={styles.skeletonHero} />
                <View style={styles.skeletonRow}>
                  <View style={styles.skeletonHalf} />
                  <View style={styles.skeletonHalf} />
                </View>
                <Text style={styles.stateText}>Loading production data…</Text>
              </View>
            ) : (
              <>
                {/* ── Hero: total production ─────────────────────── */}
                <View style={styles.heroCard}>
                  <Text style={styles.heroLabel}>TOTAL PRODUCTION</Text>
                  <Text style={styles.heroValue} numberOfLines={1} adjustsFontSizeToFit>
                    {formatInt(totals.actual)}
                  </Text>
                  <Text style={styles.heroUnit}>Active Session</Text>
                  {totals.recordCount === 0 ? (
                    /* Zeros with no explanation would read as "the line
                       made nothing" rather than "nothing saved yet". */
                    <Text style={styles.heroNote}>No slots saved yet for this session</Text>
                  ) : null}
                </View>

                {/* ── Session KPIs ──────────────────────────────── */}
                <View style={styles.kpiBlock}>
                  <Text style={styles.sectionLabel}>SESSION KPIs</Text>
                  <View style={styles.kpiGrid}>
                    <KpiTile label="Target" value={formatInt(totals.target)} width={kpiWidth} />
                    <KpiTile
                      label="Achievement"
                      value={`${totals.achievement}%`}
                      color={efficiencyColor(totals.achievement)}
                      width={kpiWidth}
                    />
                    <KpiTile
                      label="Quality"
                      value={`${totals.qualityPct}%`}
                      color={rejectionColor(totals.rejectionPct)}
                      width={kpiWidth}
                    />
                    <KpiTile
                      label="Rejection"
                      value={formatInt(totals.rejections)}
                      color={totals.rejections > 0 ? '#D64545' : undefined}
                      width={kpiWidth}
                    />
                    <KpiTile
                      label="Downtime"
                      value={formatMinutes(totals.downtimeMinutes)}
                      color={totals.downtimeMinutes > 0 ? '#F2A93B' : undefined}
                      width={kpiWidth}
                    />
                    <KpiTile
                      label="Efficiency"
                      value={`${totals.achievement}%`}
                      color={efficiencyColor(totals.achievement)}
                      width={kpiWidth}
                    />
                    <KpiTile label="Shift Plan" value={formatInt(shiftPlanTotal)} width={kpiWidth} />
                    <KpiTile
                      label="Plan Progress"
                      value={`${planProgress}%`}
                      color={efficiencyColor(planProgress)}
                      width={kpiWidth}
                    />
                  </View>
                  {/* Two different denominators, so the difference is
                      spelled out rather than left to be guessed at. */}
                  <Text style={styles.kpiFootnote}>
                    Achievement and Efficiency are the same ProdPulse figure — actual ÷ target of the
                    slots saved so far. Plan Progress measures actual against the full shift plan.
                  </Text>
                </View>

                {/* ── Active lines ───────────────────────────────── */}
                <View style={styles.kpiBlock}>
                  <View style={styles.kpiHeader}>
                    <Text style={styles.sectionLabel}>ACTIVE LINES</Text>
                    <Text style={styles.kpiHeaderNote}>{sessions.length} in session</Text>
                  </View>

                  <View style={styles.lineGrid}>
                    {byLine.map(({ session: s, totals: t }) => (
                      <Pressable
                        key={s.lineId}
                        onPress={() => navigation.navigate('RecordProduction')}
                        style={({ pressed }) => [
                          styles.lineCard,
                          { width: lineCardWidth as any },
                          s.lineStopped && styles.lineCardStopped,
                          pressed && styles.pressed,
                        ]}
                        accessibilityRole="button"
                        accessibilityLabel={`${s.lineName ?? 'Line'} — open production recording`}
                      >
                        <View style={styles.lineCardTop}>
                          <View style={{ flex: 1 }}>
                            <Text style={styles.lineName} numberOfLines={1}>
                              {s.lineName ?? 'Unnamed line'}
                            </Text>
                            <Text style={styles.lineMeta} numberOfLines={1}>
                              {[s.division, s.workshop].filter(Boolean).join(' • ') || '—'}
                            </Text>
                          </View>
                          {s.lineStopped ? (
                            <View style={styles.stoppedBadge}>
                              <Text style={styles.stoppedBadgeText}>STOPPED</Text>
                            </View>
                          ) : (
                            <View style={styles.runningBadge}>
                              <View style={[styles.dot, { backgroundColor: '#4C9A6A' }]} />
                              <Text style={styles.runningBadgeText}>RUNNING</Text>
                            </View>
                          )}
                        </View>

                        <View style={styles.lineStatGrid}>
                          <LineStat label="Actual" value={formatInt(t.actual)} />
                          <LineStat label="Target" value={formatInt(t.target)} />
                          <LineStat
                            label="Achievement"
                            value={`${t.achievement}%`}
                            color={efficiencyColor(t.achievement)}
                          />
                          <LineStat
                            label="Quality"
                            value={`${t.qualityPct}%`}
                            color={rejectionColor(t.rejectionPct)}
                          />
                          <LineStat
                            label="Rejection"
                            value={formatInt(t.rejections)}
                            color={t.rejections > 0 ? '#D64545' : undefined}
                          />
                          <LineStat
                            label="Downtime"
                            value={formatMinutes(t.downtimeMinutes)}
                            color={t.downtimeMinutes > 0 ? '#F2A93B' : undefined}
                          />
                        </View>

                        <View style={styles.lineCardFooter}>
                          <Text style={styles.lineFooterText}>
                            Shift {s.shift} · {s.operatorCount}{' '}
                            {s.operatorCount === 1 ? 'operator' : 'operators'} ·{' '}
                            {formatInt(s.plannedProductionTotal ?? 0)} planned
                          </Text>
                          <Ionicons name="chevron-forward" size={15} color="#5C6670" />
                        </View>
                      </Pressable>
                    ))}
                  </View>
                </View>
              </>
            )}
          </>
        )}
      </ScrollView>

      <AppDrawer
        visible={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        items={SUPERVISOR_MENU_ITEMS}
        dashboardSubtitle="Active session overview"
      />
    </View>
  );
}

// ─── Styles — ProdPulse palette, matching the Admin overview ──────────────────

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#14181C' },
  pressed: { opacity: 0.85 },

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
  brand: { color: '#ECEFF2', fontSize: 19, fontWeight: '900', letterSpacing: 0.3 },
  brandSub: { color: '#8A96A3', fontSize: 12.5, marginTop: 1 },
  rolePill: {
    borderWidth: 1,
    borderColor: '#F2A93B',
    backgroundColor: '#F2A93B22',
    borderRadius: 20,
    paddingHorizontal: 11,
    paddingVertical: 4,
  },
  rolePillText: { color: '#F2A93B', fontSize: 10.5, fontWeight: '900', letterSpacing: 1 },

  scroll: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 40, gap: 16 },
  sectionLabel: { color: '#5C6670', fontSize: 10.5, fontWeight: '800', letterSpacing: 1.2 },

  // Session banner
  sessionCard: {
    backgroundColor: '#1D2329',
    borderWidth: 1,
    borderColor: '#2C343C',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 13,
    gap: 9,
  },
  sessionRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sessionLabel: { color: '#5C6670', fontSize: 12, fontWeight: '700', width: 104 },
  sessionValue: { color: '#ECEFF2', fontSize: 13.5, fontWeight: '700', flex: 1 },
  sessionBadges: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
    marginTop: 3,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: '#2C343C',
  },
  sessionBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#14181C',
    borderWidth: 1,
    borderColor: '#2C343C',
    borderRadius: 16,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  sessionBadgeAlert: { borderColor: '#D6454555' },
  sessionBadgeText: { color: '#8A96A3', fontSize: 11.5, fontWeight: '700' },
  dot: { width: 8, height: 8, borderRadius: 4 },

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
  heroNote: { color: '#5C6670', fontSize: 12, marginTop: 10, textAlign: 'center' },

  // KPI grid
  kpiBlock: { gap: 10 },
  kpiHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  kpiHeaderNote: { color: '#5C6670', fontSize: 11.5, fontWeight: '700' },
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
  kpiFootnote: { color: '#5C6670', fontSize: 11, marginTop: 2, lineHeight: 16 },

  // Active line cards
  lineGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  lineCard: {
    backgroundColor: '#1D2329',
    borderWidth: 1,
    borderColor: '#2C343C',
    borderRadius: 12,
    padding: 14,
    gap: 12,
  },
  lineCardStopped: { borderColor: '#D6454555' },
  lineCardTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  lineName: { color: '#ECEFF2', fontSize: 15.5, fontWeight: '800' },
  lineMeta: { color: '#8A96A3', fontSize: 11.5, marginTop: 2 },
  runningBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderWidth: 1,
    borderColor: '#4C9A6A55',
    backgroundColor: '#4C9A6A18',
    borderRadius: 14,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  runningBadgeText: { color: '#4C9A6A', fontSize: 9.5, fontWeight: '900', letterSpacing: 0.6 },
  stoppedBadge: {
    borderWidth: 1,
    borderColor: '#D64545',
    backgroundColor: '#D6454522',
    borderRadius: 14,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  stoppedBadgeText: { color: '#D64545', fontSize: 9.5, fontWeight: '900', letterSpacing: 0.6 },

  lineStatGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  lineStat: {
    width: '30%',
    flexGrow: 1,
    backgroundColor: '#14181C',
    borderWidth: 1,
    borderColor: '#2C343C',
    borderRadius: 9,
    paddingVertical: 9,
    paddingHorizontal: 10,
  },
  lineStatLabel: { color: '#5C6670', fontSize: 10.5, fontWeight: '700' },
  lineStatValue: {
    color: '#ECEFF2',
    fontSize: 17,
    fontWeight: '900',
    marginTop: 3,
    fontVariant: ['tabular-nums'],
  },
  lineCardFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    borderTopWidth: 1,
    borderTopColor: '#2C343C',
    paddingTop: 10,
  },
  lineFooterText: { color: '#8A96A3', fontSize: 11.5, fontWeight: '700', flex: 1 },

  // Loading / empty / error
  stateBlock: { gap: 12, alignItems: 'center', paddingVertical: 20 },
  skeletonHero: {
    width: '100%',
    height: 150,
    borderRadius: 14,
    backgroundColor: '#1D2329',
    borderWidth: 1,
    borderColor: '#2C343C',
  },
  skeletonRow: { flexDirection: 'row', gap: 12, width: '100%' },
  skeletonHalf: {
    flex: 1,
    height: 110,
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
  actionButton: {
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
  actionText: { color: '#ECEFF2', fontSize: 13.5, fontWeight: '700' },
  actionButtonPrimary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    backgroundColor: '#F2A93B',
    borderRadius: 9,
    paddingHorizontal: 20,
    paddingVertical: 11,
    marginTop: 10,
  },
  actionTextPrimary: { color: '#0E1216', fontSize: 13.5, fontWeight: '800' },
});
