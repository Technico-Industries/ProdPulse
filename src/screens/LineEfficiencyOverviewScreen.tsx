// src/screens/LineEfficiencyOverviewScreen.tsx
//
// Admin dashboard, third swipe page (after Production and Quality — see
// src/components/AdminDashboardPager.tsx): LIVE status and current-session
// efficiency of every registered production line, as a grid of circular
// progress rings.
//
// DATA — the real collections RecordProductionScreen writes, no mock data:
//   productionLines   master list, read once (+ pull-to-refresh) — every
//                     registered line gets a card, producing or not.
//   activeSessions    onSnapshot listener — a session starting, stopping
//                     (lineStopped + the running stop event in stopsBySlot),
//                     resuming or being finalized (doc deleted) updates the
//                     page by itself. Unsubscribed on unmount.
//   productionRecords ONE onSnapshot listener (not one per line):
//                     productionDate `in` the active sessions' dates, then
//                     matched to each session locally by line + production
//                     date + shift, one record per slot/segment (see
//                     recordsForSession). Saving, re-saving or splitting a
//                     slot updates the page by itself. Re-subscribed only
//                     when the set of session dates changes; unsubscribed on
//                     unmount.
//
// Efficiency and the colour bands are in src/utils/lineEfficiency.ts.
// A running line's card has an admin-only "End Production" action
// (src/utils/endProduction.ts): it archives and closes the line's session
// without submitting unsaved slots.
// This page is deliberately date-free: it shows what is running NOW. The
// Production page keeps its own selected-date metrics and filters.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  ScrollView,
  RefreshControl,
  ActivityIndicator,
  Modal,
  Alert,
  Platform,
  useWindowDimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import WebRefreshButton from '../components/WebRefreshButton';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Svg, { Circle } from 'react-native-svg';
import { collection, getDocs, onSnapshot, query, where } from 'firebase/firestore';
import { db } from '../services/firebase';
import AppDrawer from '../components/AppDrawer';
import { ADMIN_MENU_ITEMS } from '../constants/adminMenu';
import { PLANTS, WORKSHOPS } from '../constants/lineOptions';
import {
  BAND_COLORS,
  BAND_LABELS,
  INACTIVE_COLOR,
  EfficiencyBand,
  EfficiencyRecord,
  LineCard,
  LiveSession,
  RegisteredLine,
  buildLineCards,
  filterLineCards,
  productionFigures,
  summarize,
} from '../utils/lineEfficiency';
import { useAuthStore } from '../stores/authStore';
import { DowntimeStop, LineDowntimeSummary, formatDowntimeMinutes, lineDowntimeSummary } from '../utils/downtime';
import { adminEndProductionSession } from '../services/endProductionSession';
import { EndProductionTarget, confirmAndEndProduction, sessionInstanceOf } from '../utils/endProduction';

// Cross-platform yes/no — Alert buttons don't fire on react-native-web (see
// RecordProductionScreen handleFinalizeSession).
function confirmEndProduction(title: string, message: string): Promise<boolean> {
  if (Platform.OS === 'web') return Promise.resolve(window.confirm(`${title}\n\n${message}`));
  return new Promise((resolve) => {
    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
      { text: 'End Production', style: 'destructive', onPress: () => resolve(true) },
    ], { cancelable: true, onDismiss: () => resolve(false) });
  });
}

function toMillis(ts: any): number | null {
  return ts?.toMillis ? ts.toMillis() : null;
}

function formatClock(ms: number): string {
  const d = new Date(ms);
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h % 12 === 0 ? 12 : h % 12}:${m} ${h < 12 ? 'AM' : 'PM'}`;
}

// ─── Circular progress ring ──────────────────────────────────────────────────

// Compact gauges so more lines fit per row (see `columns` below).
const RING_SIZE = 72;
const RING_STROKE = 7;

function EfficiencyRing({ card }: { card: LineCard }) {
  const r = (RING_SIZE - RING_STROKE) / 2;
  const circumference = 2 * Math.PI * r;
  // Only an active line with a real figure fills the ring; >100% caps at a
  // full ring (the number still shows the true value).
  const fill =
    card.status !== 'not_running' && card.efficiency != null
      ? Math.min(1, Math.max(0, card.efficiency / 100))
      : 0;
  const label =
    card.status === 'not_running' || card.efficiency == null ? '—' : `${card.efficiency.toFixed(1)}%`;

  return (
    <View style={{ width: RING_SIZE, height: RING_SIZE }}>
      <Svg width={RING_SIZE} height={RING_SIZE}>
        <Circle
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={r}
          stroke="#2C343C"
          strokeWidth={RING_STROKE}
          fill="none"
        />
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
          style={[styles.ringValue, { color: card.status === 'not_running' ? '#8A96A3' : card.color }]}
          numberOfLines={1}
          adjustsFontSizeToFit
        >
          {label}
        </Text>
      </View>
    </View>
  );
}

// ─── Line card ───────────────────────────────────────────────────────────────

function LineTile({
  card,
  width,
  ending,
  onEnd,
  downtime,
}: {
  card: LineCard;
  width: string;
  ending: boolean;
  onEnd: ((card: LineCard) => void) | null;
  // The session's downtime so far (null for a line that isn't running).
  downtime: LineDowntimeSummary | null;
}) {
  const badgeColor =
    card.status === 'running' ? '#4C9A6A' : card.status === 'stopped' ? '#D64545' : INACTIVE_COLOR;
  const icon =
    card.status === 'running' ? 'play' : card.status === 'stopped' ? 'pause' : 'power';

  let detail: string | null = null;
  if (card.status === 'stopped') {
    // The badge already says Maintenance / Quality Hold for those reasons;
    // otherwise show the recorded reason. No reason recorded → nothing
    // extra, the badge just says "Stopped".
    const parts: string[] = [];
    if (card.stop?.label && card.badge === 'Stopped') parts.push(card.stop.label);
    if (card.stop?.sinceMs) parts.push(`since ${formatClock(card.stop.sinceMs)}`);
    detail = parts.length ? parts.join(' · ') : null;
  } else if (card.status === 'running') {
    detail = card.efficiency == null ? 'No slots saved yet' : null;
  }

  const meta = card.status !== 'not_running' && card.session ? `Shift ${card.session.shift ?? '—'}` : null;
  // Kept after the line resumes, and added to by every later stop of the
  // same session — not just the stop in progress.
  const currentStopText =
    card.status === 'stopped' && downtime?.currentStopMinutes != null
      ? `Current stop ${formatDowntimeMinutes(downtime.currentStopMinutes)}`
      : null;
  const totalDowntimeText = downtime ? `Shift downtime ${formatDowntimeMinutes(downtime.totalMinutes)}` : null;
  const figures = productionFigures(card);

  return (
    <View style={[styles.cell, { width: width as any }]}>
      <View
        style={styles.tile}
        accessible
        accessibilityLabel={`${card.lineName}: ${figures === '— / —' ? '' : `${figures.replace(' / ', ' of ')} parts, `}${card.badge}${
          card.status !== 'not_running' && card.efficiency != null ? `, efficiency ${card.efficiency.toFixed(1)} percent` : ''
        }${detail ? `, ${detail}` : ''}${currentStopText ? `, ${currentStopText}` : ''}${totalDowntimeText ? `, ${totalDowntimeText}` : ''}`}
      >
        <EfficiencyRing card={card} />
        <Text style={styles.tileName} numberOfLines={2}>
          {card.lineName}
        </Text>
        <View style={styles.figures}>
          <Text style={styles.figuresValue} numberOfLines={1} adjustsFontSizeToFit>
            {figures}
          </Text>
          <Text style={styles.figuresLabel} numberOfLines={1}>
            Actual / Target
          </Text>
        </View>
        <View style={[styles.badge, { borderColor: `${badgeColor}88`, backgroundColor: `${badgeColor}22` }]}>
          <Ionicons name={icon as any} size={9} color={badgeColor} />
          <Text style={[styles.badgeText, { color: badgeColor }]} numberOfLines={1}>
            {card.badge}
          </Text>
        </View>
        {detail ? (
          <Text style={styles.tileDetail} numberOfLines={2}>
            {detail}
          </Text>
        ) : null}
        {currentStopText ? (
          <Text style={[styles.tileDowntime, { color: '#D64545' }]} numberOfLines={1} adjustsFontSizeToFit>
            {currentStopText}
          </Text>
        ) : null}
        {totalDowntimeText ? (
          <Text
            style={[styles.tileDowntime, { color: (downtime?.totalMinutes ?? 0) > 0 ? '#F2A93B' : '#8A96A3' }]}
            numberOfLines={1}
            adjustsFontSizeToFit
          >
            {totalDowntimeText}
          </Text>
        ) : null}
        {meta ? (
          <Text style={styles.tileMeta} numberOfLines={2}>
            {meta}
          </Text>
        ) : null}
      </View>
      {/* Running lines only — a stopped or inactive line has no action. */}
      {card.status === 'running' && card.session && onEnd ? (
        <Pressable
          onPress={() => onEnd(card)}
          disabled={ending}
          style={({ pressed }) => [styles.endBtn, ending && styles.endBtnBusy, pressed && styles.pressed]}
          accessibilityRole="button"
          accessibilityLabel={`End production for ${card.lineName}`}
          accessibilityState={{ disabled: ending, busy: ending }}
        >
          {ending ? (
            <ActivityIndicator size="small" color="#D64545" />
          ) : (
            <Text style={styles.endBtnText} numberOfLines={1}>
              End Production
            </Text>
          )}
        </Pressable>
      ) : null}
    </View>
  );
}

// ─── Plant / Workshop filter ─────────────────────────────────────────────────
// Same chip + picker as the Production page (AdminOverviewScreen).

function FilterChip({ label, value, onPress }: { label: string; value: string | null; onPress: () => void }) {
  const active = !!value;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.filterChip, active && styles.filterChipActive, pressed && styles.pressed]}
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
            {/* "All" (null) is the cleared state — no filter applied */}
            {[null, ...options].map((opt) => {
              const selected = opt === value;
              return (
                <Pressable
                  key={opt ?? '__all'}
                  onPress={() => onSelect(opt)}
                  style={({ pressed }) => [styles.optionRow, selected && styles.optionRowActive, pressed && styles.pressed]}
                >
                  <Text style={[styles.optionText, selected && styles.optionTextActive]}>{opt ?? 'All'}</Text>
                  {selected ? <Ionicons name="checkmark" size={17} color="#3E7CB1" /> : null}
                </Pressable>
              );
            })}
          </ScrollView>
          <View style={styles.modalActions}>
            <Pressable onPress={onClose} style={styles.modalBtnGhost}>
              <Text style={styles.modalBtnGhostText}>Close</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// Plant / Workshop survive a reload or app restart, like the Production
// page's filters.
const FILTERS_KEY = 'prodpulse.lineEfficiency.filters.v1';

// ─── Screen ──────────────────────────────────────────────────────────────────

const LEGEND: { band: EfficiencyBand; range: string }[] = [
  { band: 'excellent', range: '> 90%' },
  { band: 'warning', range: '75–90%' },
  { band: 'poor', range: '50–75%' },
  { band: 'critical', range: '< 50%' },
];

export default function LineEfficiencyOverviewScreen() {
  const { width } = useWindowDimensions();
  const [drawerOpen, setDrawerOpen] = useState(false);

  const [plant, setPlant] = useState<string | null>(null);
  const [workshop, setWorkshop] = useState<string | null>(null);
  const [openFilter, setOpenFilter] = useState<'plant' | 'workshop' | null>(null);
  const [filtersLoaded, setFiltersLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(FILTERS_KEY)
      .then((raw) => {
        if (cancelled || !raw) return;
        const saved = JSON.parse(raw);
        // Only values still in lineOptions.ts, so a removed label can't come
        // back as a filter that never matches.
        if (saved?.plant && PLANTS.includes(saved.plant)) setPlant(saved.plant);
        if (saved?.workshop && WORKSHOPS.includes(saved.workshop)) setWorkshop(saved.workshop);
      })
      .catch((e) => console.warn('[LineEfficiency] could not restore filters', e))
      .finally(() => {
        if (!cancelled) setFiltersLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!filtersLoaded) return;
    AsyncStorage.setItem(FILTERS_KEY, JSON.stringify({ plant, workshop })).catch((e) =>
      console.warn('[LineEfficiency] could not save filters', e)
    );
  }, [filtersLoaded, plant, workshop]);

  const [lines, setLines] = useState<RegisteredLine[]>([]);
  const [linesLoaded, setLinesLoaded] = useState(false);
  const [linesError, setLinesError] = useState<string | null>(null);

  const [sessions, setSessions] = useState<LiveSession[]>([]);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [sessionsError, setSessionsError] = useState<string | null>(null);

  const [records, setRecords] = useState<EfficiencyRecord[]>([]);
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [recordsError, setRecordsError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // ── productionLines (master list)
  const fetchLines = useCallback(async () => {
    try {
      const snap = await getDocs(collection(db, 'productionLines'));
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
      setLinesError(null);
    } catch (e) {
      console.error('[LineEfficiency] productionLines fetch failed', e);
      setLinesError('Unable to load production lines.');
    } finally {
      setLinesLoaded(true);
    }
  }, []);

  useEffect(() => {
    fetchLines();
  }, [fetchLines]);

  // ── activeSessions, live. One listener for the lifetime of the page.
  useEffect(() => {
    const unsub = onSnapshot(
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
              sessionInstance: sessionInstanceOf(data),
            };
          })
        );
        setSessionsError(null);
        setSessionsLoaded(true);
      },
      (err) => {
        console.error('[LineEfficiency] activeSessions listener error', err);
        setSessionsError('Unable to load live line status.');
        setSessionsLoaded(true);
      }
    );
    return () => unsub();
  }, []);

  // ── productionRecords for the live sessions' production dates.
  const sessionDates = useMemo(
    () => Array.from(new Set(sessions.map((s) => s.productionDate).filter(Boolean) as string[])).sort(),
    [sessions]
  );
  const datesKey = sessionDates.join('|');
  // Bumped by Retry to re-open the listener after an error.
  const [recordsEpoch, setRecordsEpoch] = useState(0);

  useEffect(() => {
    if (!sessionsLoaded) return;
    const dates = datesKey ? datesKey.split('|') : [];
    if (dates.length === 0) {
      setRecords([]);
      setRecordsError(null);
      setRecordsLoading(false);
      return;
    }
    setRecordsLoading(true);
    setRecordsError(null);
    // `in` takes at most 10 values — one listener per chunk (normally one).
    const chunks: string[][] = [];
    for (let i = 0; i < dates.length; i += 10) chunks.push(dates.slice(i, i + 10));
    const byChunk: EfficiencyRecord[][] = chunks.map(() => []);
    const ready = chunks.map(() => false);
    const unsubs = chunks.map((c, i) =>
      onSnapshot(
        query(collection(db, 'productionRecords'), where('productionDate', 'in', c)),
        (snap) => {
          byChunk[i] = snap.docs.map((d) => {
            const data: any = d.data();
            return {
              id: d.id,
              lineId: data.lineId ?? null,
              shift: data.shift ?? null,
              productionDate: data.productionDate ?? null,
              expectedParts: data.expectedParts ?? null,
              producedThisSlot: data.producedThisSlot ?? null,
              slotIndex: typeof data.slotIndex === 'number' ? data.slotIndex : null,
              partSegment: data.partSegment ?? null,
              createdAtMs: toMillis(data.createdAt),
              updatedAtMs: toMillis(data.updatedAt),
            };
          });
          ready[i] = true;
          setRecords(byChunk.flat());
          setRecordsError(null);
          if (ready.every(Boolean)) setRecordsLoading(false);
        },
        (err) => {
          console.error('[LineEfficiency] productionRecords listener error', err);
          setRecordsError('Unable to load production data for the running lines.');
          setRecordsLoading(false);
        }
      )
    );
    return () => unsubs.forEach((u) => u());
  }, [sessionsLoaded, datesKey, recordsEpoch]);

  // Pull-to-refresh: the roster. Sessions and records are already live.
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await fetchLines();
    } finally {
      setRefreshing(false);
    }
  }, [fetchLines]);

  const retry = useCallback(() => {
    fetchLines();
    setRecordsEpoch((n) => n + 1);
  }, [fetchLines]);

  const allCards = useMemo(() => buildLineCards(lines, sessions, records), [lines, sessions, records]);
  // Client-side over the same data — changing a filter never re-queries.
  const cards = useMemo(() => filterLineCards(allCards, { plant, workshop }), [allCards, plant, workshop]);
  const counts = useMemo(() => summarize(cards), [cards]);

  // ── Downtime per running line, from its activeSessions stopsBySlot (the
  // persisted stop intervals) — so it survives refreshes and is the same on
  // every device. The clock ticks only while a line is stopped.
  const anyStopped = useMemo(() => sessions.some((s) => s.lineStopped), [sessions]);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    setNowMs(Date.now());
    if (!anyStopped) return;
    const id = setInterval(() => setNowMs(Date.now()), 15000);
    return () => clearInterval(id);
  }, [anyStopped, sessions]);
  const downtimeByLine = useMemo(() => {
    const map = new Map<string, LineDowntimeSummary>();
    sessions.forEach((s) =>
      map.set(s.lineId, lineDowntimeSummary(s.stopsBySlot as Record<string, DowntimeStop[]> | null, nowMs))
    );
    return map;
  }, [sessions, nowMs]);
  const activeFilterCount = [plant, workshop].filter(Boolean).length;

  // ── End Production (admin) — see utils/endProduction. The UI check below
  // is not the permission: the transaction re-reads the admin's profile.
  const authUser = useAuthStore((s) => s.user);
  const isAdmin = authUser?.role === 'admin';
  const endingRef = useRef<Set<string>>(new Set());
  const [endingLines, setEndingLines] = useState<Set<string>>(new Set());
  const [endResult, setEndResult] = useState<{ ok: boolean; message: string } | null>(null);
  const endProduction = useCallback(async (card: LineCard) => {
    if (!authUser) return;
    const target: EndProductionTarget = {
      lineId: card.lineId,
      lineName: card.lineName,
      sessionInstance: card.session?.sessionInstance ?? null,
    };
    const outcome = await confirmAndEndProduction(target, {
      inFlight: endingRef.current,
      confirm: confirmEndProduction,
      end: (t) => adminEndProductionSession(t, { uid: authUser.uid, name: authUser.name, email: authUser.email }),
      onBusyChange: (lineId, busy) =>
        setEndingLines((prev) => {
          const next = new Set(prev);
          if (busy) next.add(lineId);
          else next.delete(lineId);
          return next;
        }),
    });
    // The activeSessions listener takes the line off "running" by itself.
    if (outcome.kind === 'ended') setEndResult({ ok: true, message: outcome.message });
    else if (outcome.kind === 'error') setEndResult({ ok: false, message: outcome.message });
  }, [authUser]);

  // ── Responsive grid. Percentage widths in a wrapping row, so nothing can
  // overflow horizontally at any breakpoint.
  const columns =
    width >= 1200 ? 9 : width >= 900 ? 7 : width >= 700 ? 6 : width >= 520 ? 5 : width >= 380 ? 4 : 3;
  const tileWidth = `${100 / columns}%`;

  const initialLoading = !linesLoaded || !sessionsLoaded || (recordsLoading && records.length === 0);
  const fatalError = (linesError && lines.length === 0) || (sessionsError && sessions.length === 0)
    ? linesError ?? sessionsError
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
          <Text style={styles.brandSub}>Line Efficiency Overview</Text>
        </View>
        <WebRefreshButton onRefresh={onRefresh} refreshing={refreshing} />
        <View style={styles.rolePill}>
          <Text style={styles.rolePillText}>ADMIN</Text>
        </View>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#3E7CB1" colors={['#3E7CB1']} />}
      >
        {/* ── Live notice ─────────────────────────────────────────────── */}
        <View style={styles.liveRow}>
          <View style={styles.livePill}>
            <View style={styles.liveDot} />
            <Text style={styles.livePillText}>LIVE</Text>
          </View>
          <Text style={styles.liveText}>
            Current status of every line. Efficiency covers the saved slots of each line's active session.
          </Text>
          {recordsLoading && !initialLoading ? <ActivityIndicator size="small" color="#3E7CB1" /> : null}
        </View>

        {initialLoading ? (
          <View style={styles.stateCard}>
            <ActivityIndicator color="#3E7CB1" />
            <Text style={styles.stateText}>Loading line status…</Text>
          </View>
        ) : fatalError ? (
          <View style={styles.stateCard}>
            <View style={[styles.stateIcon, { borderColor: '#D64545', backgroundColor: '#D6454522' }]}>
              <Ionicons name="cloud-offline-outline" size={30} color="#D64545" />
            </View>
            <Text style={styles.stateTitle}>{fatalError}</Text>
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
        ) : allCards.length === 0 ? (
          <View style={styles.stateCard}>
            <View style={[styles.stateIcon, { borderColor: '#5C6670', backgroundColor: '#5C667022' }]}>
              <Ionicons name="git-network-outline" size={30} color="#8A96A3" />
            </View>
            <Text style={styles.stateTitle}>No Production Lines</Text>
            <Text style={styles.stateText}>No lines are registered yet. Add lines from Manage Lines.</Text>
          </View>
        ) : (
          <>
            {/* ── Plant / Workshop ────────────────────────────────────── */}
            <View style={styles.filterBlock}>
              <View style={styles.filterHeader}>
                <Text style={styles.sectionLabel}>FILTERS</Text>
                {activeFilterCount > 0 ? (
                  <Pressable
                    onPress={() => {
                      setPlant(null);
                      setWorkshop(null);
                    }}
                    hitSlop={8}
                  >
                    <Text style={styles.linkText}>Clear all</Text>
                  </Pressable>
                ) : null}
              </View>
              <View style={styles.filterRow}>
                <FilterChip label="Plant" value={plant} onPress={() => setOpenFilter('plant')} />
                <FilterChip label="Workshop" value={workshop} onPress={() => setOpenFilter('workshop')} />
              </View>
            </View>

            {/* ── Summary ─────────────────────────────────────────────── */}
            <View style={styles.summaryRow}>
              <SummaryTile label="Total lines" value={counts.total} color="#ECEFF2" />
              <SummaryTile label="Running" value={counts.running} color="#4C9A6A" />
              <SummaryTile label="Stopped" value={counts.stopped} color="#D64545" />
              <SummaryTile label="Not running" value={counts.notRunning} color="#8A96A3" />
            </View>

            {/* Partial failures: keep what loaded on screen, say what's missing. */}
            {recordsError || (linesError && lines.length > 0) || (sessionsError && sessions.length > 0) ? (
              <View style={styles.warnBanner}>
                <Ionicons name="warning-outline" size={16} color="#F2A93B" />
                <Text style={styles.warnText}>
                  {recordsError ?? linesError ?? sessionsError} Pull down to retry.
                </Text>
              </View>
            ) : null}

            {/* ── End Production result ───────────────────────────────── */}
            {endResult ? (
              <View style={[styles.warnBanner, endResult.ok && styles.okBanner]} accessibilityLiveRegion="polite">
                <Ionicons
                  name={endResult.ok ? 'checkmark-circle-outline' : 'alert-circle-outline'}
                  size={16}
                  color={endResult.ok ? '#4C9A6A' : '#D64545'}
                />
                <Text style={[styles.warnText, { color: endResult.ok ? '#4C9A6A' : '#D64545' }]}>{endResult.message}</Text>
                <Pressable onPress={() => setEndResult(null)} hitSlop={8} accessibilityRole="button" accessibilityLabel="Dismiss">
                  <Ionicons name="close" size={16} color="#8A96A3" />
                </Pressable>
              </View>
            ) : null}

            {/* ── Legend ──────────────────────────────────────────────── */}
            <View style={styles.legend}>
              {LEGEND.map(({ band, range }) => (
                <View key={band} style={styles.legendItem}>
                  <View style={[styles.legendDot, { backgroundColor: BAND_COLORS[band] }]} />
                  <Text style={styles.legendText}>
                    {BAND_LABELS[band]} <Text style={styles.legendRange}>{range}</Text>
                  </Text>
                </View>
              ))}
              <View style={styles.legendItem}>
                <View style={[styles.legendDot, { backgroundColor: INACTIVE_COLOR }]} />
                <Text style={styles.legendText}>Not running</Text>
              </View>
            </View>

            {/* ── Grid ────────────────────────────────────────────────── */}
            {cards.length === 0 ? (
              <View style={styles.stateCard}>
                <View style={[styles.stateIcon, { borderColor: '#5C6670', backgroundColor: '#5C667022' }]}>
                  <Ionicons name="funnel-outline" size={28} color="#8A96A3" />
                </View>
                <Text style={styles.stateTitle}>No lines match these filters</Text>
                <Text style={styles.stateText}>
                  None of the {allCards.length} registered lines are in {[plant, workshop].filter(Boolean).join(' · ')}.
                </Text>
                <Pressable
                  onPress={() => {
                    setPlant(null);
                    setWorkshop(null);
                  }}
                  style={({ pressed }) => [styles.retryButton, pressed && styles.pressed]}
                  accessibilityRole="button"
                >
                  <Text style={styles.retryText}>Clear filters</Text>
                </Pressable>
              </View>
            ) : (
              <View style={styles.grid}>
                {cards.map((card) => (
                  <LineTile
                    key={card.lineId}
                    card={card}
                    width={tileWidth}
                    ending={endingLines.has(card.lineId)}
                    onEnd={isAdmin ? endProduction : null}
                    downtime={card.status !== 'not_running' ? downtimeByLine.get(card.lineId) ?? null : null}
                  />
                ))}
              </View>
            )}
          </>
        )}
      </ScrollView>

      <OptionPickerModal
        visible={openFilter !== null}
        title={openFilter === 'plant' ? 'Select Plant' : 'Select Workshop'}
        options={openFilter === 'plant' ? PLANTS : WORKSHOPS}
        value={openFilter === 'plant' ? plant : workshop}
        onClose={() => setOpenFilter(null)}
        onSelect={(next) => {
          if (openFilter === 'plant') setPlant(next);
          else if (openFilter === 'workshop') setWorkshop(next);
          setOpenFilter(null);
        }}
      />

      <AppDrawer visible={drawerOpen} onClose={() => setDrawerOpen(false)} items={ADMIN_MENU_ITEMS} />
    </View>
  );
}

function SummaryTile({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <View style={styles.summaryTile}>
      <Text style={[styles.summaryValue, { color }]}>{value}</Text>
      <Text style={styles.summaryLabel} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

// ─── Styles — ProdPulse palette, matching the other overview pages ───────────

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
    borderColor: '#3E7CB1',
    backgroundColor: '#3E7CB122',
    borderRadius: 20,
    paddingHorizontal: 11,
    paddingVertical: 4,
  },
  rolePillText: { color: '#3E7CB1', fontSize: 10.5, fontWeight: '900', letterSpacing: 1 },

  // Bottom padding clears the pager's floating page tabs.
  scroll: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 72, gap: 16 },

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
    backgroundColor: '#1D2329',
    borderWidth: 1,
    borderColor: '#2C343C',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 8,
    alignItems: 'center',
    gap: 2,
  },
  summaryValue: { fontSize: 22, fontWeight: '900' },
  summaryLabel: { color: '#8A96A3', fontSize: 11, fontWeight: '700' },

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
  okBanner: { borderColor: '#4C9A6A66', backgroundColor: '#4C9A6A14' },

  endBtn: {
    alignSelf: 'center',
    marginTop: 7,
    minHeight: 26,
    minWidth: 96,
    borderWidth: 1,
    borderColor: '#D6454588',
    backgroundColor: '#D6454518',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  endBtnBusy: { opacity: 0.6 },
  endBtnText: { color: '#D64545', fontSize: 10.5, fontWeight: '800' },

  legend: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 14, rowGap: 6 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendDot: { width: 9, height: 9, borderRadius: 5 },
  legendText: { color: '#ECEFF2', fontSize: 11.5, fontWeight: '700' },
  legendRange: { color: '#8A96A3', fontWeight: '600' },

  // Each cell is exactly 1/columns wide with its own gutter, so a partial
  // last row stays left-aligned at the same tile size.
  grid: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -5 },
  cell: { paddingHorizontal: 5, paddingVertical: 10 },
  // No card behind a line: the gauge and its details float directly on the
  // page background, so the ring is the only shape in each cell.
  tile: {
    flex: 1,
    alignItems: 'center',
    gap: 7,
  },
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
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 6,
    paddingVertical: 1,
    maxWidth: '100%',
  },
  badgeText: { fontSize: 9.5, fontWeight: '800', flexShrink: 1 },
  // Actual / Target: readable, but quieter than the ring's percentage.
  figures: { alignItems: 'center', width: '100%', marginTop: -3 },
  figuresValue: { color: '#C3CBD3', fontSize: 11.5, fontWeight: '700', fontVariant: ['tabular-nums'] },
  figuresLabel: { color: '#5C6670', fontSize: 8.5, fontWeight: '700', letterSpacing: 0.4, marginTop: 1 },
  tileDetail: { color: '#8A96A3', fontSize: 10, fontWeight: '600', textAlign: 'center', width: '100%' },
  tileMeta: { color: '#8A96A3', fontSize: 9.5, fontWeight: '600', textAlign: 'center', width: '100%' },
  tileDowntime: { fontSize: 9.5, fontWeight: '700', textAlign: 'center', width: '100%', fontVariant: ['tabular-nums'] },

  // Plant / Workshop filter — same look as the Production page's.
  filterBlock: { gap: 8 },
  filterHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sectionLabel: { color: '#5C6670', fontSize: 10.5, fontWeight: '800', letterSpacing: 1.2 },
  linkText: { color: '#3E7CB1', fontSize: 12.5, fontWeight: '700' },
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
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 2 },
  modalBtnGhost: { borderWidth: 1, borderColor: '#2C343C', borderRadius: 9, paddingHorizontal: 18, paddingVertical: 10 },
  modalBtnGhostText: { color: '#8A96A3', fontSize: 13.5, fontWeight: '700' },

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
