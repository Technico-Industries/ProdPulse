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
  LayoutAnimation,
  UIManager,
  useWindowDimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import WebRefreshButton from '../components/WebRefreshButton';
import { PROD_AI_BUTTON_CLEARANCE } from '../utils/prodAIPanelLayout';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { collection, getDocs, onSnapshot, query, where } from 'firebase/firestore';
import { db } from '../services/firebase';
import AppDrawer from '../components/AppDrawer';
import { ADMIN_MENU_ITEMS } from '../constants/adminMenu';
import { PLANTS, WORKSHOPS, ALL_DIVISIONS, divisionFilterOptions } from '../constants/lineOptions';
import {
  BAND_COLORS,
  BAND_LABELS,
  INACTIVE_COLOR,
  EfficiencyBand,
  EfficiencyRecord,
  LiveLine,
  LiveSession,
  RegisteredLine,
  buildLiveLines,
  filterLineCards,
  lastSavedSlot,
  capsuleFigures,
  formatCapsulePct,
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

// Old-architecture Android needs LayoutAnimation switched on; the new
// architecture (Fabric) supports it as is.
if (
  Platform.OS === 'android' &&
  !(globalThis as any).nativeFabricUIManager &&
  UIManager.setLayoutAnimationEnabledExperimental
) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

// ─── Efficiency capsule ──────────────────────────────────────────────────────
// Pill-shaped bar, filled left → right by efficiency in the line's band
// colour over the dark track the ring used. Two centred lines inside: the
// efficiency, then "actual / planned". Over 100% fills the whole capsule,
// the text keeps the real value. Tapping it expands / collapses the card.
// The text is never truncated (no numberOfLines — on web that becomes a
// CSS ellipsis); the short formats in lineEfficiency.ts keep it inside.

const CAPSULE_HEIGHT = 56;

function EfficiencyCapsule({ card, expanded, onPress }: { card: LiveLine; expanded: boolean; onPress: () => void }) {
  const active = card.status !== 'not_running' && card.efficiency != null;
  const fill = active ? Math.min(1, Math.max(0, (card.efficiency as number) / 100)) : 0;
  const figures = capsuleFigures(card);
  const pct = active ? formatCapsulePct(card.efficiency) : '—';
  const inactive = !active;

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.capsule, pressed && styles.capsulePressed]}
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      accessibilityLabel={`${card.lineName}: ${figures === '— / —' ? 'no production yet' : `${figures.replace(' / ', ' of ')} parts`}, efficiency ${
        active ? `${pct.replace('%', ' percent')}` : 'not available'
      }`}
      accessibilityHint={expanded ? 'Hides slot, rejection and downtime details' : 'Shows slot, rejection and downtime details'}
    >
      {/* Only this track clips (rounded ends on the fill); the text layer
          above it is never clipped. */}
      <View style={styles.capsuleTrack} pointerEvents="none">
        {fill > 0 ? <View style={[styles.capsuleFill, { width: `${fill * 100}%`, backgroundColor: card.color }]} /> : null}
      </View>
      <View style={styles.capsuleContent} pointerEvents="none">
        <Text style={[styles.capsulePct, inactive && styles.capsuleTextInactive]}>{pct}</Text>
        <Text style={[styles.capsuleFigures, inactive && styles.capsuleTextInactive]}>{figures}</Text>
      </View>
    </Pressable>
  );
}

// ─── Expanded details: Last slot · Rejection · Downtime ─────────────────────

function DetailBlocks({
  card,
  downtime,
  stacked,
}: {
  card: LiveLine;
  downtime: LineDowntimeSummary | null;
  stacked: boolean;
}) {
  const last = lastSavedSlot(card.slots);
  const blocks: [string, string][] = [
    ['Last slot', last ? `${last.label} · ${last.pcs.toLocaleString()} pcs` : 'No slot yet'],
    [
      'Rejection',
      card.rejections == null
        ? '—'
        : `${card.rejections.toLocaleString()}${card.rejectionPct != null ? ` · ${card.rejectionPct.toFixed(1)}%` : ''}`,
    ],
    ['Downtime', formatDowntimeMinutes(downtime?.totalMinutes ?? 0)],
  ];
  return (
    <View style={stacked ? styles.blocksStacked : styles.blocksSide}>
      {blocks.map(([label, value]) => (
        <View key={label} style={stacked ? styles.blockStacked : styles.blockSide} accessible accessibilityLabel={`${label}: ${value}`}>
          <Text style={styles.blockLabel} numberOfLines={1}>
            {label}
          </Text>
          <Text style={styles.blockValue} numberOfLines={2}>
            {value}
          </Text>
        </View>
      ))}
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
  expanded,
  sideBySide,
  onToggle,
  onCardPress,
}: {
  card: LiveLine;
  width: string;
  ending: boolean;
  onEnd: ((card: LiveLine) => void) | null;
  // The session's downtime so far (null for a line that isn't running).
  downtime: LineDowntimeSummary | null;
  // Expanded across the whole grid row, with Last slot / Rejection / Downtime.
  expanded: boolean;
  // Wide enough for the three blocks beside the capsule; else under it.
  sideBySide: boolean;
  onToggle: (lineId: string) => void;
  // A tap on the card outside the capsule (collapses another expanded card).
  onCardPress: (lineId: string) => void;
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

  const capsule = <EfficiencyCapsule card={card} expanded={expanded} onPress={() => onToggle(card.lineId)} />;
  // Collapsed card: capsule + line name, nothing else.
  const head = (
    <>
      {capsule}
      <Pressable
        onPress={() => onCardPress(card.lineId)}
        style={styles.tile}
        accessible
        accessibilityLabel={`${card.lineName}: ${figures === '— / —' ? '' : `${figures.replace(' / ', ' of ')} parts, `}${card.badge}${
          card.status !== 'not_running' && card.efficiency != null ? `, efficiency ${card.efficiency.toFixed(1)} percent` : ''
        }${detail ? `, ${detail}` : ''}${currentStopText ? `, ${currentStopText}` : ''}${totalDowntimeText ? `, ${totalDowntimeText}` : ''}`}
      >
        <Text style={styles.tileName} numberOfLines={2}>
          {card.lineName}
        </Text>
        {/* Running / Stopped (or its reason) / Not Running — always visible. */}
        <View style={[styles.badge, styles.tileBadge, { borderColor: `${badgeColor}88`, backgroundColor: `${badgeColor}22` }]}>
          <Ionicons name={icon as any} size={9} color={badgeColor} />
          <Text style={[styles.badgeText, { color: badgeColor }]} numberOfLines={1}>
            {card.badge}
          </Text>
        </View>
      </Pressable>
    </>
  );

  if (!expanded) {
    return <View style={[styles.cell, { width: width as any }]}>{head}</View>;
  }

  // Expanded section, in order: status badge + shift · (stop details) ·
  // Last slot / Rejection / Downtime · End Production. Shift downtime is
  // only in the Downtime block.
  const section = (
    <View style={[styles.expandedSection, !sideBySide && styles.expandedSectionStacked]}>
      {/* The status badge is on the card itself (under the name). */}
      {meta || card.supervisorName ? (
        <View style={styles.statusLine}>
          {meta ? <Text style={styles.statusShift}>{meta}</Text> : null}
          {card.supervisorName ? (
            <View style={styles.supervisor} accessible accessibilityLabel={`Supervisor ${card.supervisorName}`}>
              <Ionicons name="person-outline" size={12} color="#8A96A3" />
              <Text style={styles.supervisorName}>{card.supervisorName}</Text>
            </View>
          ) : null}
        </View>
      ) : null}
      {detail || currentStopText ? (
        <Text style={styles.statusDetail} numberOfLines={2}>
          {detail}
          {detail && currentStopText ? ' · ' : ''}
          {currentStopText ? <Text style={{ color: '#D64545' }}>{currentStopText}</Text> : null}
        </Text>
      ) : null}
      <DetailBlocks card={card} downtime={downtime} stacked={!sideBySide} />
      {/* Running lines only — a stopped or inactive line has no action. */}
      {card.status === 'running' && card.session && onEnd ? (
        <Pressable
          onPress={() => onEnd(card)}
          disabled={ending}
          style={({ pressed }) => [styles.endBtn, styles.endBtnFull, ending && styles.endBtnBusy, pressed && styles.pressed]}
          accessibilityRole="button"
          accessibilityLabel={`End production on ${card.lineName}`}
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

  // Spans the whole row. Capsule + name on the left with the section beside
  // it — or, on a narrow phone, the section under the capsule.
  return (
    <View style={[styles.cell, styles.cellExpanded]}>
      <View style={styles.expandedPanel}>
        {sideBySide ? (
          <View style={styles.expandedRow}>
            <View style={styles.expandedLeft}>{head}</View>
            {section}
          </View>
        ) : (
          <>
            {head}
            {section}
          </>
        )}
      </View>
    </View>
  );
}

// ─── Plant / Workshop / Division filter ──────────────────────────────────────
// Same chip + picker as the Production page (AdminOverviewScreen). Also used
// by the QC Lines page (LiveQualityLinesScreen).

export function FilterChip({ label, value, onPress }: { label: string; value: string | null; onPress: () => void }) {
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

export function OptionPickerModal({
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

// Plant / Workshop / Division survive a reload or app restart, like the Production
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
  const [division, setDivision] = useState<string | null>(null);
  const [openFilter, setOpenFilter] = useState<'plant' | 'workshop' | 'division' | null>(null);
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
        if (saved?.division && ALL_DIVISIONS.includes(saved.division)) setDivision(saved.division);
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
    AsyncStorage.setItem(FILTERS_KEY, JSON.stringify({ plant, workshop, division })).catch((e) =>
      console.warn('[LineEfficiency] could not save filters', e)
    );
  }, [filtersLoaded, plant, workshop, division]);

  // A division the chosen workshop doesn't have can never match — clear it.
  useEffect(() => {
    if (division && !divisionFilterOptions(workshop).includes(division)) setDivision(null);
  }, [workshop, division]);

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
              // Slot schedule, for the expanded card's "Last slot" window.
              otHours: typeof data.otHours === 'number' ? data.otHours : null,
              productionStartMinutesAbs:
                typeof data.productionStartMinutesAbs === 'number' ? data.productionStartMinutesAbs : null,
              plant: data.plant ?? null,
              workshop: data.workshop ?? null,
              scheduleProfile: typeof data.scheduleProfile === 'string' ? data.scheduleProfile : null,
              deletedSlotIndices: Array.isArray(data.deletedSlotIndices) ? data.deletedSlotIndices : null,
              // Supervisor shown in the expanded card: whoever last synced
              // the session (follows a handover), else the session starter.
              supervisorName: data.supervisorName ?? null,
              currentSupervisorName: data.updatedBy?.name ?? null,
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
              // Rejection counter, for the expanded card (null on legacy records).
              rejections: typeof data.rejections === 'number' ? data.rejections : null,
              supervisorName: data.supervisor?.name ?? data.sessionSupervisor?.name ?? null,
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

  // Same cards, same order as buildLineCards, plus the expanded view's
  // fields (saved slots, rejections) from the same listener data.
  const allCards = useMemo(() => buildLiveLines(lines, sessions, records, nowMs), [lines, sessions, records, nowMs]);
  // Client-side over the same data — changing a filter never re-queries.
  const cards = useMemo(
    () => filterLineCards(allCards, { plant, workshop, division }) as LiveLine[],
    [allCards, plant, workshop, division]
  );
  const counts = useMemo(() => summarize(cards), [cards]);

  // ── Expanded card (one at a time). Capsule tap toggles; a tap on any
  // other card collapses the open one.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const animateLayout = () =>
    LayoutAnimation.configureNext({
      duration: 200,
      create: { type: LayoutAnimation.Types.easeInEaseOut, property: LayoutAnimation.Properties.opacity },
      update: { type: LayoutAnimation.Types.easeInEaseOut },
      delete: { type: LayoutAnimation.Types.easeInEaseOut, property: LayoutAnimation.Properties.opacity },
    });
  const toggleExpanded = useCallback((lineId: string) => {
    animateLayout();
    setExpandedId((cur) => (cur === lineId ? null : lineId));
  }, []);
  const onCardPress = useCallback(
    (lineId: string) => {
      if (expandedId && expandedId !== lineId) {
        animateLayout();
        setExpandedId(null);
      }
    },
    [expandedId]
  );
  const downtimeByLine = useMemo(() => {
    const map = new Map<string, LineDowntimeSummary>();
    sessions.forEach((s) =>
      map.set(s.lineId, lineDowntimeSummary(s.stopsBySlot as Record<string, DowntimeStop[]> | null, nowMs))
    );
    return map;
  }, [sessions, nowMs]);
  const activeFilterCount = [plant, workshop, division].filter(Boolean).length;

  // ── End Production (admin) — see utils/endProduction. The UI check below
  // is not the permission: the transaction re-reads the admin's profile.
  const authUser = useAuthStore((s) => s.user);
  const isAdmin = authUser?.role === 'admin';
  const endingRef = useRef<Set<string>>(new Set());
  const [endingLines, setEndingLines] = useState<Set<string>>(new Set());
  const [endResult, setEndResult] = useState<{ ok: boolean; message: string } | null>(null);
  const endProduction = useCallback(async (card: LiveLine) => {
    if (!authUser) return;
    const target: EndProductionTarget = {
      lineId: card.lineId,
      lineName: card.lineName,
      sessionInstance: card.session?.sessionInstance ?? null,
    };
    const outcome = await confirmAndEndProduction(target, {
      inFlight: endingRef.current,
      // Always asks first: "End production on DHL-01?"
      confirm: (_title, message) => confirmEndProduction(`End production on ${card.lineName}?`, message),
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
  // Phones: 2 columns under 400 px, 3 up to tablet width; tablets and up
  // keep their counts.
  const columns = width >= 1200 ? 9 : width >= 900 ? 7 : width >= 700 ? 6 : width >= 400 ? 3 : 2;
  const tileWidth = `${100 / columns}%`;
  // An expanded card spans the row (screen width minus the 16 px page
  // padding each side). Below ~560 px the three detail blocks go under the
  // capsule instead of beside it.
  const sideBySide = width - 32 >= 560;

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
            {/* ── Plant / Workshop / Division ─────────────────────────── */}
            <View style={styles.filterBlock}>
              <View style={styles.filterHeader}>
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
                    <Text style={styles.linkText}>Clear all</Text>
                  </Pressable>
                ) : null}
              </View>
              <View style={styles.filterRow}>
                <FilterChip label="Plant" value={plant} onPress={() => setOpenFilter('plant')} />
                <FilterChip label="Workshop" value={workshop} onPress={() => setOpenFilter('workshop')} />
                <FilterChip label="Division" value={division} onPress={() => setOpenFilter('division')} />
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
                  None of the {allCards.length} registered lines are in {[plant, workshop, division].filter(Boolean).join(' · ')}.
                </Text>
                <Pressable
                  onPress={() => {
                    setPlant(null);
                    setWorkshop(null);
                    setDivision(null);
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
                    expanded={expandedId === card.lineId}
                    sideBySide={sideBySide}
                    onToggle={toggleExpanded}
                    onCardPress={onCardPress}
                  />
                ))}
              </View>
            )}
          </>
        )}
      </ScrollView>

      <OptionPickerModal
        visible={openFilter !== null}
        title={openFilter === 'plant' ? 'Select Plant' : openFilter === 'workshop' ? 'Select Workshop' : 'Select Division'}
        options={openFilter === 'plant' ? PLANTS : openFilter === 'workshop' ? WORKSHOPS : divisionFilterOptions(workshop)}
        value={openFilter === 'plant' ? plant : openFilter === 'workshop' ? workshop : division}
        onClose={() => setOpenFilter(null)}
        onSelect={(next) => {
          if (openFilter === 'plant') setPlant(next);
          else if (openFilter === 'workshop') setWorkshop(next);
          else if (openFilter === 'division') setDivision(next);
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
  // In the expanded section: full width, same colours, a real touch target.
  endBtnFull: { alignSelf: 'stretch', marginTop: 0, minHeight: 44 },
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
  // Compact: a collapsed card is just the capsule and the line name.
  cell: { paddingHorizontal: 5, paddingVertical: 6 },
  // No card behind a line: the capsule and its name float directly on the
  // page background.
  tile: {
    alignItems: 'center',
    marginTop: 6,
  },

  // Capsule gauge — the ring's dark track, filled with the band colour.
  // White text with a soft shadow stays readable over the fill and the track.
  capsule: {
    width: '100%',
    height: CAPSULE_HEIGHT,
    borderRadius: CAPSULE_HEIGHT / 2,
    justifyContent: 'center',
  },
  capsulePressed: { opacity: 0.8 },
  capsuleTrack: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    borderRadius: CAPSULE_HEIGHT / 2,
    backgroundColor: '#2C343C',
    overflow: 'hidden',
  },
  capsuleFill: { position: 'absolute', left: 0, top: 0, bottom: 0 },
  capsuleContent: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  capsulePct: {
    flexShrink: 0,
    textAlign: 'center',
    color: '#FFFFFF',
    fontSize: 16,
    lineHeight: 20,
    fontWeight: '900',
    fontVariant: ['tabular-nums'],
    textShadowColor: 'rgba(0,0,0,0.35)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
  capsuleFigures: {
    flexShrink: 0,
    textAlign: 'center',
    color: 'rgba(255,255,255,0.85)',
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
    textShadowColor: 'rgba(0,0,0,0.35)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
  // Not running / nothing saved: the same grey "—" as before.
  capsuleTextInactive: { color: '#8A96A3' },

  // Expanded card: the whole grid row, on a subtle panel.
  cellExpanded: { width: '100%' },
  expandedPanel: {
    padding: 12,
    backgroundColor: '#1D2329',
    borderWidth: 1,
    borderColor: '#2C343C',
    borderRadius: 14,
  },
  expandedRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 14 },
  expandedLeft: { width: 260, maxWidth: '45%' },
  // Status line, details, blocks and End Production, top to bottom.
  expandedSection: { flex: 1, minWidth: 0, gap: 10 },
  expandedSectionStacked: { marginTop: 10 },
  statusLine: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 12, rowGap: 4 },
  supervisor: { flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 1 },
  supervisorName: { color: '#ECEFF2', fontSize: 12.5, fontWeight: '700', flexShrink: 1 },
  statusShift: { color: '#8A96A3', fontSize: 11.5, fontWeight: '700' },
  statusDetail: { color: '#8A96A3', fontSize: 11.5, fontWeight: '600', fontVariant: ['tabular-nums'] },
  blocksSide: { flexDirection: 'row', gap: 8 },
  blockSide: {
    flex: 1,
    minWidth: 0,
    minHeight: CAPSULE_HEIGHT,
    justifyContent: 'center',
    gap: 3,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
    backgroundColor: '#14181C',
  },
  blocksStacked: { gap: 6 },
  blockStacked: {
    gap: 2,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 10,
    backgroundColor: '#14181C',
  },
  blockLabel: { color: '#8A96A3', fontSize: 11, fontWeight: '700' },
  blockValue: { color: '#ECEFF2', fontSize: 13.5, fontWeight: '800', fontVariant: ['tabular-nums'] },
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
  tileBadge: { marginTop: 5 },

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
