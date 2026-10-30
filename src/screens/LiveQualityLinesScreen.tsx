// src/screens/LiveQualityLinesScreen.tsx
//
// "Live Quality Lines" swipe page: Quality % of every line's CURRENT
// production session, as the same floating grid of circular rings as the
// admin Line Efficiency Overview (LineEfficiencyOverviewScreen) — same ring
// size, grid columns, spacing and header — with quality metrics and colours.
//
// Shown in two pagers (src/components/AdminDashboardPager.tsx):
//   admin            Production → Quality → Lines → Live Quality
//   Quality In-charge Quality Overview → Live Quality
// `role` only picks the header pill and the drawer menu, so a Quality
// In-charge never gets admin menu entries.
//
// DATA — the real collections, no mock data. Three listeners for the whole
// page (never one per line), all unsubscribed on unmount:
//   productionLines   names, and the lines with no active session.
//   activeSessions    a session starting, stopping (lineStopped + running
//                     stop event), resuming or being finalized (doc
//                     deleted) updates the page by itself.
//   productionRecords productionDate `in` the active sessions' dates → per
//                     session (line + production date + shift), good parts
//                     Σ producedThisSlot and rejected parts Σ rejections —
//                     the Record Production rejection counter. Saving or
//                     re-saving a slot, or tapping the counter on a saved
//                     slot, updates the page by itself. Re-subscribed only
//                     when the set of session dates changes.
// rejectionRecords (Record Rejection screen) are not read here — they'd
// count the same parts twice. Formulas and thresholds:
// src/utils/liveQuality.ts. Read-only.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  useWindowDimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { PROD_AI_BUTTON_CLEARANCE } from '../utils/prodAIPanelLayout';
import Svg, { Circle } from 'react-native-svg';
import { collection, onSnapshot, query, where, DocumentData } from 'firebase/firestore';
import { db } from '../services/firebase';
import AppDrawer from '../components/AppDrawer';
import { ADMIN_MENU_ITEMS } from '../constants/adminMenu';
import { QUALITY_MENU_ITEMS } from '../constants/qualityMenu';
import { LiveSession, RegisteredLine } from '../utils/lineEfficiency';
import {
  QUALITY_COLORS,
  QUALITY_LABELS,
  QUALITY_THRESHOLDS,
  QualityCard,
  QualityStatus,
  LiveRecord,
  buildQualityCards,
  summarizeQuality,
} from '../utils/liveQuality';

function toMillis(ts: any): number | null {
  return ts?.toMillis ? ts.toMillis() : null;
}

function formatClock(ms: number): string {
  const d = new Date(ms);
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h % 12 === 0 ? 12 : h % 12}:${m} ${h < 12 ? 'AM' : 'PM'}`;
}

function formatInt(n: number) {
  return Math.round(n).toLocaleString();
}

// One onSnapshot per chunk of ≤ 10 values (Firestore's `in` limit —
// normally a single chunk). `onData` gets the merged docs of every chunk
// once all of them have reported.
function listenIn<T>(
  coll: string,
  field: string,
  values: string[],
  map: (id: string, data: DocumentData) => T,
  onData: (rows: T[]) => void,
  onError: (err: unknown) => void
): () => void {
  const chunks: string[][] = [];
  for (let i = 0; i < values.length; i += 10) chunks.push(values.slice(i, i + 10));
  const byChunk: T[][] = chunks.map(() => []);
  const ready = chunks.map(() => false);
  const unsubs = chunks.map((c, i) =>
    onSnapshot(
      query(collection(db, coll), where(field, 'in', c)),
      (snap) => {
        byChunk[i] = snap.docs.map((d) => map(d.id, d.data()));
        ready[i] = true;
        if (ready.every(Boolean)) onData(byChunk.flat());
      },
      onError
    )
  );
  return () => unsubs.forEach((u) => u());
}

// ─── Circular progress ring ──────────────────────────────────────────────────
// Same dimensions as LineEfficiencyOverviewScreen's EfficiencyRing.

const RING_SIZE = 72;
const RING_STROKE = 7;

function QualityRing({ card }: { card: QualityCard }) {
  const r = (RING_SIZE - RING_STROKE) / 2;
  const circumference = 2 * Math.PI * r;
  const fill = card.qualityPct != null ? Math.min(1, Math.max(0, card.qualityPct / 100)) : 0;
  return (
    <View style={{ width: RING_SIZE, height: RING_SIZE }}>
      <Svg width={RING_SIZE} height={RING_SIZE}>
        <Circle cx={RING_SIZE / 2} cy={RING_SIZE / 2} r={r} stroke="#2C343C" strokeWidth={RING_STROKE} fill="none" />
        {fill > 0 ? (
          <Circle
            cx={RING_SIZE / 2}
            cy={RING_SIZE / 2}
            r={r}
            stroke={card.color}
            strokeWidth={RING_STROKE}
            fill="none"
            strokeLinecap="round"
            strokeDasharray={`${circumference} ${circumference}`}
            strokeDashoffset={circumference * (1 - fill)}
            // Start at 12 o'clock and run clockwise.
            transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
          />
        ) : null}
      </Svg>
      <View style={styles.ringCenter} pointerEvents="none">
        <Text
          style={[styles.ringValue, { color: card.qualityPct != null ? card.color : '#8A96A3' }]}
          numberOfLines={1}
          adjustsFontSizeToFit
        >
          {card.qualityPct != null ? `${card.qualityPct.toFixed(1)}%` : '—'}
        </Text>
      </View>
    </View>
  );
}

// ─── Line tile ───────────────────────────────────────────────────────────────

function QualityTile({ card, width }: { card: QualityCard; width: string }) {
  const runColor = card.runState === 'running' ? '#4C9A6A' : '#D64545';
  const rejectedText =
    card.rejectedParts == null
      ? 'Rejected: —'
      : `Rejected: ${formatInt(card.rejectedParts)} ${card.rejectedParts === 1 ? 'part' : 'parts'}`;
  const rejectionText = `Rejection: ${card.rejectionPct != null ? `${card.rejectionPct.toFixed(1)}%` : '—'}`;
  // Running, or the recorded stop reason (never invented — a stop with no
  // recorded reason is just "Stopped").
  const runText =
    card.runState === 'stopped' && card.stop?.sinceMs
      ? `${card.runLabel} · since ${formatClock(card.stop.sinceMs)}`
      : card.runLabel;
  const unavailableHint =
    card.status !== 'unavailable'
      ? null
      : card.goodParts == null
      ? 'Data unavailable'
      : card.rejectedParts == null
      ? 'No rejection counter on saved slots'
      : 'No slots saved yet';

  return (
    <View style={[styles.cell, { width: width as any }]}>
      <View
        style={styles.tile}
        accessible
        accessibilityLabel={`${card.lineName}: quality ${
          card.qualityPct != null ? `${card.qualityPct.toFixed(1)} percent` : 'unavailable'
        }, ${QUALITY_LABELS[card.status]}. ${rejectedText}. ${rejectionText}. ${runText}.`}
      >
        <QualityRing card={card} />
        <Text style={styles.tileName} numberOfLines={2}>
          {card.lineName}
        </Text>
        <View style={styles.figures}>
          <Text style={styles.figuresValue} numberOfLines={1} adjustsFontSizeToFit>
            {rejectedText}
          </Text>
          <Text style={styles.figuresSub} numberOfLines={1} adjustsFontSizeToFit>
            {rejectionText}
          </Text>
        </View>
        <View style={[styles.badge, { borderColor: `${card.color}88`, backgroundColor: `${card.color}22` }]}>
          <Text
            style={[styles.badgeText, { color: card.status === 'unavailable' ? '#8A96A3' : card.color }]}
            numberOfLines={1}
          >
            {QUALITY_LABELS[card.status]}
          </Text>
        </View>
        <View style={styles.runRow}>
          <Ionicons name={card.runState === 'running' ? 'play' : 'pause'} size={9} color={runColor} />
          <Text style={[styles.runText, { color: runColor }]} numberOfLines={2}>
            {runText}
          </Text>
        </View>
        <Text style={styles.tileMeta} numberOfLines={2}>
          {[
            `Shift ${card.session.shift ?? '—'}`,
            unavailableHint,
            // Some (not all) saved slots pre-date the counter — they're left out.
            card.status !== 'unavailable' && card.legacyRecords > 0
              ? `${card.legacyRecords} legacy ${card.legacyRecords === 1 ? 'slot' : 'slots'} excluded`
              : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </Text>
      </View>
    </View>
  );
}

function SummaryTile({ label, value, sub, color }: { label: string; value: string; sub?: string; color: string }) {
  return (
    <View style={styles.summaryTile}>
      <Text style={[styles.summaryValue, { color }]} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
      <Text style={styles.summaryLabel} numberOfLines={1}>
        {label}
      </Text>
      {sub ? (
        <Text style={styles.summarySub} numberOfLines={1} adjustsFontSizeToFit>
          {sub}
        </Text>
      ) : null}
    </View>
  );
}

const LEGEND: { status: QualityStatus; range: string }[] = [
  { status: 'good', range: `≥ ${QUALITY_THRESHOLDS.good}%` },
  { status: 'warning', range: `${QUALITY_THRESHOLDS.warning}–${QUALITY_THRESHOLDS.good}%` },
  { status: 'critical', range: `< ${QUALITY_THRESHOLDS.warning}%` },
  { status: 'unavailable', range: '' },
];

// ─── Screen ──────────────────────────────────────────────────────────────────

export default function LiveQualityLinesScreen({ role }: { role: 'admin' | 'quality' }) {
  const { width } = useWindowDimensions();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const accent = role === 'admin' ? '#3E7CB1' : '#4C9A6A';

  const [lines, setLines] = useState<RegisteredLine[]>([]);
  const [linesLoaded, setLinesLoaded] = useState(false);
  const [linesError, setLinesError] = useState(false);

  const [sessions, setSessions] = useState<LiveSession[]>([]);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [sessionsError, setSessionsError] = useState(false);

  // null while loading / after an error, so a gauge never shows a figure
  // built from half the data (see buildQualityCards).
  const [prodRecords, setProdRecords] = useState<LiveRecord[] | null>(null);
  const [prodError, setProdError] = useState(false);

  // Bumped by Retry to re-open every listener.
  const [epoch, setEpoch] = useState(0);
  const retry = useCallback(() => setEpoch((n) => n + 1), []);

  // ── productionLines + activeSessions
  useEffect(() => {
    const unsubLines = onSnapshot(
      collection(db, 'productionLines'),
      (snap) => {
        setLines(
          snap.docs.map((d) => {
            const data: any = d.data();
            return {
              id: d.id,
              lineName: data.lineName ?? null,
              plant: data.plant ?? null,
              workshop: data.workshop ?? null,
              division: data.division ?? null,
            };
          })
        );
        setLinesError(false);
        setLinesLoaded(true);
      },
      (err) => {
        console.error('[LiveQualityLines] productionLines listener error', err);
        setLinesError(true);
        setLinesLoaded(true);
      }
    );
    const unsubSessions = onSnapshot(
      collection(db, 'activeSessions'),
      (snap) => {
        setSessions(
          snap.docs.map((d) => {
            const data: any = d.data();
            return {
              lineId: data.lineId ?? d.id,
              lineName: data.lineName ?? null,
              shift: data.shift ?? null,
              productionDate: data.productionDate ?? null,
              lineStopped: data.lineStopped === true,
              stopsBySlot: data.stopsBySlot ?? null,
              startedAtMs: toMillis(data.startedAt),
              updatedAtMs: toMillis(data.updatedAt),
            };
          })
        );
        setSessionsError(false);
        setSessionsLoaded(true);
      },
      (err) => {
        console.error('[LiveQualityLines] activeSessions listener error', err);
        setSessionsError(true);
        setSessionsLoaded(true);
      }
    );
    return () => {
      unsubLines();
      unsubSessions();
    };
  }, [epoch]);

  // ── productionRecords for the live sessions' dates.
  const datesKey = useMemo(
    () => Array.from(new Set(sessions.map((s) => s.productionDate).filter(Boolean) as string[])).sort().join('|'),
    [sessions]
  );

  useEffect(() => {
    if (!sessionsLoaded) return;
    const dates = datesKey ? datesKey.split('|') : [];
    setProdError(false);
    if (dates.length === 0) {
      setProdRecords([]);
      return;
    }
    setProdRecords(null);
    const unsubProd = listenIn<LiveRecord>(
      'productionRecords',
      'productionDate',
      dates,
      (id, data) => ({
        id,
        lineId: data.lineId ?? null,
        shift: data.shift ?? null,
        productionDate: data.productionDate ?? null,
        expectedParts: data.expectedParts ?? null,
        producedThisSlot: data.producedThisSlot ?? null,
        // The Record Production rejection counter. Left null (not 0) when
        // missing, so a legacy record is never read as "0 rejected".
        rejections: typeof data.rejections === 'number' && Number.isFinite(data.rejections) ? data.rejections : null,
        slotIndex: typeof data.slotIndex === 'number' ? data.slotIndex : null,
        partSegment: data.partSegment ?? null,
        createdAtMs: toMillis(data.createdAt),
        updatedAtMs: toMillis(data.updatedAt),
      }),
      (rows) => {
        setProdRecords(rows);
        setProdError(false);
      },
      (err) => {
        console.error('[LiveQualityLines] productionRecords listener error', err);
        setProdRecords(null);
        setProdError(true);
      }
    );
    return () => unsubProd();
  }, [sessionsLoaded, datesKey, epoch]);

  const { cards, notRunning } = useMemo(
    () => buildQualityCards(lines, sessions, prodRecords),
    [lines, sessions, prodRecords]
  );
  const summary = useMemo(() => summarizeQuality(cards), [cards]);

  // ── Responsive grid — LineEfficiencyOverviewScreen's breakpoints.
  const columns =
    width >= 1200 ? 9 : width >= 900 ? 7 : width >= 700 ? 6 : width >= 520 ? 5 : width >= 380 ? 4 : 3;
  const tileWidth = `${100 / columns}%`;

  const initialLoading = !linesLoaded || !sessionsLoaded;
  const recordsLoading = !prodError && cards.length > 0 && prodRecords == null;
  const partialError = prodError
    ? 'Production data for the running lines could not be loaded — quality is unavailable.'
    : linesError
    ? 'Production lines could not be loaded — showing live sessions only.'
    : null;

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
          <Text style={styles.brandSub}>Live Quality Lines</Text>
        </View>
        <View style={[styles.rolePill, { borderColor: accent, backgroundColor: `${accent}22` }]}>
          <Text style={[styles.rolePillText, { color: accent }]}>{role === 'admin' ? 'ADMIN' : 'QUALITY'}</Text>
        </View>
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {/* ── Live notice ─────────────────────────────────────────────── */}
        <View style={styles.liveRow}>
          <View style={styles.livePill}>
            <View style={styles.liveDot} />
            <Text style={styles.livePillText}>LIVE</Text>
          </View>
          <Text style={styles.liveText}>
            Quality of each active session: good parts vs. the Record Production rejection counter (saved slots).
          </Text>
          {recordsLoading ? <ActivityIndicator size="small" color="#4C9A6A" /> : null}
        </View>

        {initialLoading ? (
          <View style={styles.stateCard}>
            <ActivityIndicator color="#4C9A6A" />
            <Text style={styles.stateText}>Loading live quality…</Text>
          </View>
        ) : sessionsError ? (
          <View style={styles.stateCard}>
            <View style={[styles.stateIcon, { borderColor: '#D64545', backgroundColor: '#D6454522' }]}>
              <Ionicons name="cloud-offline-outline" size={30} color="#D64545" />
            </View>
            <Text style={styles.stateTitle}>Unable to load live line status.</Text>
            <Text style={styles.stateText}>Check your connection and try again.</Text>
            <Pressable
              onPress={retry}
              style={({ pressed }) => [styles.retryButton, pressed && styles.pressed]}
              accessibilityRole="button"
              accessibilityLabel="Retry"
            >
              <Ionicons name="refresh" size={16} color="#ECEFF2" />
              <Text style={styles.retryText}>Retry</Text>
            </Pressable>
          </View>
        ) : (
          <>
            {/* ── Summary — from the same cards the gauges render ─────── */}
            <View style={styles.summaryRow}>
              <SummaryTile
                label="Active"
                value={String(summary.activeSessions)}
                sub={`${summary.running} running · ${summary.stopped} stopped`}
                color="#ECEFF2"
              />
              <SummaryTile label="Good" value={String(summary.good)} color={QUALITY_COLORS.good} />
              <SummaryTile label="Warning" value={String(summary.warning)} color={QUALITY_COLORS.warning} />
              <SummaryTile label="Critical" value={String(summary.critical)} color={QUALITY_COLORS.critical} />
              <SummaryTile
                label="Rejected"
                value={summary.totalRejected != null ? formatInt(summary.totalRejected) : '—'}
                sub="parts"
                color="#ECEFF2"
              />
            </View>

            {/* Partial failures: keep what loaded on screen, say what's missing. */}
            {partialError ? (
              <View style={styles.warnBanner}>
                <Ionicons name="warning-outline" size={16} color="#F2A93B" />
                <Text style={styles.warnText}>{partialError}</Text>
                <Pressable onPress={retry} hitSlop={8} accessibilityRole="button">
                  <Text style={styles.linkText}>Retry</Text>
                </Pressable>
              </View>
            ) : null}

            {/* ── Legend ──────────────────────────────────────────────── */}
            <View style={styles.legend}>
              {LEGEND.map(({ status, range }) => (
                <View key={status} style={styles.legendItem}>
                  <View style={[styles.legendDot, { backgroundColor: QUALITY_COLORS[status] }]} />
                  <Text style={styles.legendText}>
                    {QUALITY_LABELS[status]}
                    {range ? <Text style={styles.legendRange}> {range}</Text> : null}
                  </Text>
                </View>
              ))}
            </View>

            {/* ── Grid ────────────────────────────────────────────────── */}
            {cards.length === 0 ? (
              <View style={styles.stateCard}>
                <View style={[styles.stateIcon, { borderColor: '#5C6670', backgroundColor: '#5C667022' }]}>
                  <Ionicons name="pause-circle-outline" size={30} color="#8A96A3" />
                </View>
                <Text style={styles.stateTitle}>No active production sessions</Text>
                <Text style={styles.stateText}>Gauges appear here as soon as a supervisor starts a session.</Text>
              </View>
            ) : (
              <View style={styles.grid}>
                {cards.map((card) => (
                  <QualityTile key={card.lineId} card={card} width={tileWidth} />
                ))}
              </View>
            )}

            {/* ── Lines with no active session, muted ─────────────────── */}
            {notRunning.length > 0 ? (
              <View style={styles.notRunning}>
                <Text style={styles.sectionLabel}>NOT RUNNING · {notRunning.length}</Text>
                <View style={styles.notRunningList}>
                  {notRunning.map((l) => (
                    <View key={l.lineId} style={styles.notRunningChip}>
                      <Ionicons name="power" size={10} color="#5C6670" />
                      <Text style={styles.notRunningText} numberOfLines={1}>
                        {l.lineName}
                      </Text>
                    </View>
                  ))}
                </View>
              </View>
            ) : null}
          </>
        )}
      </ScrollView>

      <AppDrawer
        visible={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        items={role === 'admin' ? ADMIN_MENU_ITEMS : QUALITY_MENU_ITEMS}
        dashboardSubtitle={role === 'admin' ? undefined : 'Quality report summary'}
      />
    </View>
  );
}

// ─── Styles — LineEfficiencyOverviewScreen's, plus the quality extras ───────

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
  rolePill: { borderWidth: 1, borderRadius: 20, paddingHorizontal: 11, paddingVertical: 4 },
  rolePillText: { fontSize: 10.5, fontWeight: '900', letterSpacing: 1 },

  // Bottom padding clears the pager's floating page tabs.
  // Clears the pager's page tabs and the floating Prod AI button (admin).
  scroll: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: PROD_AI_BUTTON_CLEARANCE, gap: 16 },

  liveRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  livePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderWidth: 1,
    borderColor: '#4C9A6A88',
    backgroundColor: '#4C9A6A22',
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#4C9A6A' },
  livePillText: { color: '#4C9A6A', fontSize: 10.5, fontWeight: '900', letterSpacing: 1 },
  liveText: { flex: 1, color: '#8A96A3', fontSize: 12 },

  summaryRow: { flexDirection: 'row', gap: 8 },
  summaryTile: {
    flex: 1,
    minWidth: 0,
    backgroundColor: '#1D2329',
    borderWidth: 1,
    borderColor: '#2C343C',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 6,
    alignItems: 'center',
    gap: 2,
  },
  summaryValue: { fontSize: 22, fontWeight: '900', fontVariant: ['tabular-nums'] },
  summaryLabel: { color: '#8A96A3', fontSize: 11, fontWeight: '700' },
  summarySub: { color: '#5C6670', fontSize: 9.5, fontWeight: '700' },

  warnBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderColor: '#F2A93B66',
    backgroundColor: '#F2A93B14',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  warnText: { flex: 1, color: '#F2A93B', fontSize: 12, fontWeight: '600' },
  linkText: { color: '#3E7CB1', fontSize: 12.5, fontWeight: '700' },

  legend: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 14, rowGap: 6 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendDot: { width: 9, height: 9, borderRadius: 5 },
  legendText: { color: '#ECEFF2', fontSize: 11.5, fontWeight: '700' },
  legendRange: { color: '#8A96A3', fontWeight: '600' },

  // Each cell is exactly 1/columns wide with its own gutter, so a partial
  // last row stays left-aligned at the same tile size. No card behind a
  // line: the gauge and its details float directly on the page background.
  grid: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -5 },
  cell: { paddingHorizontal: 5, paddingVertical: 10 },
  tile: { flex: 1, alignItems: 'center', gap: 7 },
  ringCenter: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: RING_STROKE + 3,
  },
  ringValue: { fontSize: 13.5, fontWeight: '900' },
  tileName: { color: '#ECEFF2', fontSize: 12, fontWeight: '800', textAlign: 'center', width: '100%' },
  figures: { alignItems: 'center', width: '100%', marginTop: -3 },
  figuresValue: { color: '#C3CBD3', fontSize: 11, fontWeight: '700', fontVariant: ['tabular-nums'] },
  figuresSub: { color: '#8A96A3', fontSize: 10.5, fontWeight: '600', fontVariant: ['tabular-nums'], marginTop: 1 },
  badge: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 6, paddingVertical: 1, maxWidth: '100%' },
  badgeText: { fontSize: 9.5, fontWeight: '800' },
  runRow: { flexDirection: 'row', alignItems: 'center', gap: 4, maxWidth: '100%' },
  runText: { fontSize: 10, fontWeight: '700', flexShrink: 1, textAlign: 'center' },
  tileMeta: { color: '#8A96A3', fontSize: 9.5, fontWeight: '600', textAlign: 'center', width: '100%' },

  sectionLabel: { color: '#5C6670', fontSize: 10.5, fontWeight: '800', letterSpacing: 1.2 },
  notRunning: { gap: 8 },
  notRunningList: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  notRunningChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderWidth: 1,
    borderColor: '#2C343C',
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
    maxWidth: '100%',
  },
  notRunningText: { color: '#5C6670', fontSize: 11, fontWeight: '700', flexShrink: 1 },

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
    width: 60,
    height: 60,
    borderRadius: 30,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  stateTitle: { color: '#ECEFF2', fontSize: 16, fontWeight: '800', textAlign: 'center' },
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
  retryText: { color: '#ECEFF2', fontSize: 14, fontWeight: '700' },
});
