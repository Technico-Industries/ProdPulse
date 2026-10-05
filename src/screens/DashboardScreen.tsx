import React, { useCallback, useEffect, useState, useMemo } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  SafeAreaView,
  ScrollView,
  FlatList,
  ActivityIndicator,
  RefreshControl,
  Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { collection, getDocs, onSnapshot, query, where, orderBy, Timestamp, doc, updateDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../services/firebase';
import { useAuthStore } from '../stores/authStore';
import { ADMIN_MENU_ITEMS } from '../constants/adminMenu';
import AdminOverviewScreen from './AdminOverviewScreen';
import { SUPERVISOR_MENU_ITEMS } from '../constants/supervisorMenu';
import SupervisorOverviewScreen from './SupervisorOverviewScreen';

type IconName = keyof typeof Ionicons.glyphMap;

interface OptionConfig {
  key: string;
  title: string;
  subtitle: string;
  icon: IconName;
  accent: string;
  route: string;
}

// The Admin entries used to live here as dashboard cards. The Admin main
// dashboard is now AdminOverviewScreen (a digital production overview), so
// the same list is the hamburger drawer's menu instead — see
// src/constants/adminMenu.ts and src/components/AppDrawer.tsx. Nothing
// was deleted; only the entry point moved. Kept aliased here so the
// `options` selection below stays unchanged for every other role.
const ADMIN_OPTIONS: OptionConfig[] = ADMIN_MENU_ITEMS;

// The Supervisor entries used to live here as dashboard cards. The
// Supervisor main dashboard is now SupervisorOverviewScreen (a digital
// active-session overview), so the same list is that screen's hamburger
// drawer instead — see src/constants/supervisorMenu.ts and
// src/components/AppDrawer.tsx. Nothing was deleted; only the entry point
// moved. Kept aliased here so the `options` selection below is unchanged
// for every other role.
const SUPERVISOR_OPTIONS: OptionConfig[] = SUPERVISOR_MENU_ITEMS;

// Quality Control's own card list — the QualityControlPlaceholder "Coming
// Soon" screen only shows when this list is empty (see the render check
// below), so adding more QC cards here later is the only change needed to
// grow this dashboard further.
const QUALITY_OPTIONS: OptionConfig[] = [
  {
    key: 'record-rejection',
    title: 'Record Rejection',
    subtitle: 'Log rejected parts for a line',
    icon: 'close-circle',
    accent: '#D64545',
    route: 'RecordRejection',
  },
  {
    key: 'quality-analysis',
    title: 'Quality Analysis',
    subtitle: 'Rejections, near-miss, and poka-yoke trends across lines',
    icon: 'shield-checkmark',
    accent: '#4C9A6A',
    route: 'QualityAnalysis',
  },
];

function OptionCard({ config }: { config: OptionConfig }) {
  const navigation = useNavigation<any>();
  return (
    <Pressable
      onPress={() => navigation.navigate(config.route)}
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
      accessibilityRole="button"
      accessibilityLabel={config.title}
    >
      <View style={[styles.iconBadge, { backgroundColor: config.accent + '22', borderColor: config.accent }]}>
        <Ionicons name={config.icon} size={26} color={config.accent} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.cardTitle}>{config.title}</Text>
        <Text style={styles.cardSubtitle}>{config.subtitle}</Text>
      </View>
      <Ionicons name="chevron-forward" size={20} color="#5C6670" />
    </Pressable>
  );
}

// ---------- Technician breakdown list ----------

interface Breakdown {
  id: string; // breakdown doc id
  lineId: string;
  lineName: string;
  plant: string;
  workshop: string;
  division: string;
  slotLabel: string | null;
  reportedByName: string | null;
  fixedByName: string | null;
  resolvedByName: string | null;
  startedAtMs: number | null;
  resolvedAtMs: number | null;
}

function pad2(n: number) {
  return String(n).padStart(2, '0');
}

function startOfDay(d: Date) {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c;
}

function daysAgoStart(days: number) {
  const d = startOfDay(new Date());
  d.setDate(d.getDate() - days);
  return d;
}

// Matches RecordProductionScreen's own live stop timer exactly (formatElapsed):
// ticks every second, MM:SS — so a technician sees the same number a
// supervisor sees on the floor.
function formatElapsedCounter(startedAtMs: number | null, nowMs: number): string {
  if (!startedAtMs) return '--:--';
  const s = Math.max(0, Math.floor((nowMs - startedAtMs) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// For resolved breakdowns, a fixed span rather than a live counter reads better as "Xh Ym"
function formatDurationMinutes(mins: number): string {
  const total = Math.max(0, Math.round(mins));
  if (total < 60) return `${total}m`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function formatClockTime(ms: number): string {
  const d = new Date(ms);
  let h = d.getHours();
  const m = pad2(d.getMinutes());
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m} ${ampm}`;
}

function formatResolvedLabel(ms: number): string {
  const d = new Date(ms);
  const today = startOfDay(new Date());
  const yesterday = daysAgoStart(1);
  const day = startOfDay(d);
  if (day.getTime() === today.getTime()) return `Today, ${formatClockTime(ms)}`;
  if (day.getTime() === yesterday.getTime()) return `Yesterday, ${formatClockTime(ms)}`;
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${formatClockTime(ms)}`;
}

// For a pending material request, "how long has this been waiting" reads
// better as relative time than a live MM:SS counter.
function formatAgo(ms: number | null, nowMs: number): string {
  if (!ms) return '';
  const diffMin = Math.max(0, Math.floor((nowMs - ms) / 60000));
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const h = Math.floor(diffMin / 60);
  if (h < 24) return `${h}h ago`;
  return formatResolvedLabel(ms);
}

const FIXED_PRESETS = [
  { key: 'today', label: 'Today', days: 0 },
  { key: 'yesterday', label: 'Yesterday', days: 1 },
  { key: 'last7', label: 'Last 7 days', days: 6 },
] as const;

function TechnicianBreakdownList() {
  const [tab, setTab] = useState<'active' | 'fixed'>('active');

  // ── Active breakdowns (live)
  const [breakdowns, setBreakdowns] = useState<Breakdown[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(Date.now());

  // ── Fixed (resolved) breakdowns
  const [fixedPreset, setFixedPreset] = useState<(typeof FIXED_PRESETS)[number]['key']>('today');
  const [fixedAll, setFixedAll] = useState<Breakdown[]>([]); // last-7-days window, filtered further client-side
  const [fixedLoading, setFixedLoading] = useState(true);
  const [fixedRefreshing, setFixedRefreshing] = useState(false);
  const [fixedLoadError, setFixedLoadError] = useState<string | null>(null);

  const [liveConnected, setLiveConnected] = useState(false);
  const user = useAuthStore((s) => s.user);

  const mapBreakdownDoc = (d: any): Breakdown => {
    const data: any = d.data();
    return {
      id: d.id,
      lineId: data.lineId ?? d.id,
      lineName: data.lineName ?? 'Unknown line',
      plant: data.plant ?? '—',
      workshop: data.workshop ?? '—',
      division: data.division ?? '—',
      slotLabel: data.slotLabel ?? null,
      reportedByName: data.reportedBy?.name ?? null,
      fixedByName: data.fixedBy?.name ?? null,
      resolvedByName: data.resolvedBy?.name ?? null,
      startedAtMs: data.startedAt?.toMillis ? data.startedAt.toMillis() : null,
      resolvedAtMs: data.resolvedAt?.toMillis ? data.resolvedAt.toMillis() : null,
    };
  };

  // One-off fetch, used for the initial load and as a manual pull-to-refresh
  // trigger. Real-time updates (a supervisor stopping/resuming a line) come
  // from the onSnapshot listener below, not from this.
  const fetchBreakdowns = useCallback(async () => {
    setLoadError(null);
    try {
      const q = query(collection(db, 'lineBreakdowns'), where('active', '==', true));
      const snap = await getDocs(q);
      setBreakdowns(snap.docs.map(mapBreakdownDoc));
    } catch (e) {
      setLoadError('Could not load breakdowns. Check your connection and try again.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Single query for the broadest window (last 7 days); Today/Yesterday are
  // filtered from this in memory so switching presets doesn't refetch.
  // Range-filters on resolvedAt + orderBy the same field, so no composite
  // Firestore index is needed (active is filtered client-side).
  const fetchFixed = useCallback(async () => {
    setFixedLoadError(null);
    try {
      const rangeStart = Timestamp.fromDate(daysAgoStart(6));
      const q = query(
        collection(db, 'lineBreakdowns'),
        where('resolvedAt', '>=', rangeStart),
        orderBy('resolvedAt', 'desc')
      );
      const snap = await getDocs(q);
      const items: Breakdown[] = snap.docs
        .map((d) => {
          const data: any = d.data();
          return {
            id: d.id,
            lineId: data.lineId ?? d.id,
            lineName: data.lineName ?? 'Unknown line',
            plant: data.plant ?? '—',
            workshop: data.workshop ?? '—',
            division: data.division ?? '—',
            slotLabel: data.slotLabel ?? null,
            reportedByName: data.reportedBy?.name ?? null,
            fixedByName: data.fixedBy?.name ?? null,
            startedAtMs: data.startedAt?.toMillis ? data.startedAt.toMillis() : null,
            resolvedAtMs: data.resolvedAt?.toMillis ? data.resolvedAt.toMillis() : null,
            resolvedByName: data.resolvedBy?.name ?? null,
          };
        })
        .filter((b) => b.resolvedAtMs != null);
      setFixedAll(items);
    } catch (e) {
      setFixedLoadError('Could not load fixed machines. Check your connection and try again.');
    } finally {
      setFixedLoading(false);
      setFixedRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      // Initial load so something shows immediately, before the listener's
      // first snapshot arrives.
      fetchBreakdowns();
      fetchFixed();

      // Listener 1 — ACTIVE breakdowns (active === true).
      // Fires instantly when a supervisor logs a maintenance stop or resumes.
      const unsubscribeActive = onSnapshot(
        query(collection(db, 'lineBreakdowns'), where('active', '==', true)),
        (snap) => {
          setBreakdowns(snap.docs.map(mapBreakdownDoc));
          setLoading(false);
          setLoadError(null);
          setLiveConnected(true);
        },
        (err) => {
          console.error('[lineBreakdowns/active] listener error:', err.code, err.message);
          setLoadError('Live updates disconnected. Pull to refresh.');
          setLiveConnected(false);
        }
      );

      // Listener 2 — FIXED breakdowns (active === false, resolvedAt set).
      // When a supervisor resumes the line, the doc flips active→false. Without
      // this listener the Fixed tab only loads once on focus and never updates
      // while the technician is already on screen, so resuming appears to just
      // make the card disappear rather than move to Fixed.
      // NOTE: requires a Firestore composite index on (active ASC, resolvedAt DESC).
      // Firestore will log a direct creation link the first time this runs.
      const rangeStart = Timestamp.fromDate(daysAgoStart(6));
      const unsubscribeFixed = onSnapshot(
        query(
          collection(db, 'lineBreakdowns'),
          where('active', '==', false),
          where('resolvedAt', '>=', rangeStart),
          orderBy('resolvedAt', 'desc')
        ),
        (snap) => {
          const items: Breakdown[] = snap.docs
            .map((d) => {
              const data: any = d.data();
              return {
                id: d.id,
                lineId: data.lineId ?? d.id,
                lineName: data.lineName ?? 'Unknown line',
                plant: data.plant ?? '—',
                workshop: data.workshop ?? '—',
                division: data.division ?? '—',
                slotLabel: data.slotLabel ?? null,
                reportedByName: data.reportedBy?.name ?? null,
                fixedByName: data.fixedBy?.name ?? null,
                resolvedByName: data.resolvedBy?.name ?? null,
                startedAtMs: data.startedAt?.toMillis ? data.startedAt.toMillis() : null,
                resolvedAtMs: data.resolvedAt?.toMillis ? data.resolvedAt.toMillis() : null,
              };
            })
            .filter((b) => b.resolvedAtMs != null);
          setFixedAll(items);
          setFixedLoading(false);
        },
        (err) => {
          console.error('[lineBreakdowns/fixed] listener error:', err.code, err.message);
          // Non-fatal — fixed tab falls back to last fetched data; show pull-to-refresh hint
        }
      );

      // Belt-and-suspenders poll every 3 s so the live elapsed counter stays
      // accurate even if a Firestore push is delayed. Silent — no visual
      // flash — since onSnapshot already keeps the UI live; this is just a
      // background safety net. Refreshes both tabs, not just Active, so a
      // technician sitting on the Fixed tab also stays current.
      const reloadInterval = setInterval(() => {
        fetchBreakdowns();
        fetchFixed();
        setNowMs(Date.now());
      }, 3000);

      const tickInterval = setInterval(() => setNowMs(Date.now()), 1000);

      return () => {
        unsubscribeActive();
        unsubscribeFixed();
        clearInterval(reloadInterval);
        clearInterval(tickInterval);
      };
    }, [fetchBreakdowns, fetchFixed])
  );

  const handleRefresh = () => {
    setRefreshing(true);
    fetchBreakdowns();
  };

  const handleFixedRefresh = () => {
    setFixedRefreshing(true);
    fetchFixed();
  };

  const fixedFiltered = useMemo(() => {
    const preset = FIXED_PRESETS.find((p) => p.key === fixedPreset)!;
    const rangeStartMs = daysAgoStart(preset.days).getTime();
    const rangeEndMs = preset.key === 'yesterday' ? startOfDay(new Date()).getTime() : Date.now();
    return fixedAll.filter((b) => b.resolvedAtMs != null && b.resolvedAtMs >= rangeStartMs && b.resolvedAtMs < rangeEndMs + 1);
  }, [fixedAll, fixedPreset]);

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.tabRow}>
        <Pressable onPress={() => setTab('active')} style={[styles.tabBtn, tab === 'active' && styles.tabBtnActive]}>
          <View style={[styles.liveDot, liveConnected && styles.liveDotConnected]} />
          <Text style={[styles.tabBtnText, tab === 'active' && styles.tabBtnTextActive]}>Active</Text>
          {!loading && !loadError && <Text style={styles.tabBtnCount}>{breakdowns.length}</Text>}
        </Pressable>
        <Pressable onPress={() => setTab('fixed')} style={[styles.tabBtn, tab === 'fixed' && styles.tabBtnActive]}>
          <Ionicons name="checkmark-circle" size={14} color={tab === 'fixed' ? '#4C9A6A' : '#5C6670'} />
          <Text style={[styles.tabBtnText, tab === 'fixed' && styles.tabBtnTextActive]}>Fixed</Text>
        </Pressable>
        {tab === 'active' && (
          <Text style={styles.liveStatusText}>{liveConnected ? 'Live' : 'Connecting…'}</Text>
        )}
      </View>

      {tab === 'active' ? (
        loading ? (
          <View style={styles.centered}>
            <ActivityIndicator color="#F2A93B" size="large" />
          </View>
        ) : loadError ? (
          <View style={styles.centered}>
            <Ionicons name="alert-circle" size={22} color="#D64545" />
            <Text style={styles.errorText}>{loadError}</Text>
            <Pressable onPress={fetchBreakdowns} style={styles.retryButton}>
              <Text style={styles.retryText}>Retry</Text>
            </Pressable>
          </View>
        ) : breakdowns.length === 0 ? (
          <View style={styles.centered}>
            <Ionicons name="checkmark-circle-outline" size={30} color="#4C9A6A" />
            <Text style={styles.emptyText}>No active breakdowns right now</Text>
          </View>
        ) : (
          <FlatList
            data={breakdowns}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.body}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor="#F2A93B" />}
            renderItem={({ item }) => (
              <View style={styles.breakdownCard}>
                  <View style={styles.breakdownTop}>
                    <View style={styles.breakdownIcon}>
                      <Ionicons name="warning" size={20} color="#D64545" />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.breakdownLine}>{item.lineName}</Text>
                      <Text style={styles.breakdownMeta}>
                        {item.plant} · {item.workshop} · {item.division}
                      </Text>
                    </View>
                    <Text style={styles.liveCounter}>{formatElapsedCounter(item.startedAtMs, nowMs)}</Text>
                  </View>
                  <View style={styles.breakdownFooter}>
                    {item.slotLabel && <Text style={styles.breakdownSub}>Slot: {item.slotLabel}</Text>}
                    {item.reportedByName && <Text style={styles.breakdownSub}>Reported by {item.reportedByName}</Text>}
                  </View>

                </View>
            )}
          />
        )
      ) : (
        <View style={{ flex: 1 }}>
          <View style={styles.presetRow}>
            {FIXED_PRESETS.map((p) => {
              const active = fixedPreset === p.key;
              return (
                <Pressable
                  key={p.key}
                  onPress={() => setFixedPreset(p.key)}
                  style={[styles.presetChip, active && styles.presetChipActive]}
                >
                  <Text style={[styles.presetChipText, active && styles.presetChipTextActive]}>{p.label}</Text>
                </Pressable>
              );
            })}
          </View>

          {fixedLoading ? (
            <View style={styles.centered}>
              <ActivityIndicator color="#F2A93B" size="large" />
            </View>
          ) : fixedLoadError ? (
            <View style={styles.centered}>
              <Ionicons name="alert-circle" size={22} color="#D64545" />
              <Text style={styles.errorText}>{fixedLoadError}</Text>
              <Pressable onPress={fetchFixed} style={styles.retryButton}>
                <Text style={styles.retryText}>Retry</Text>
              </Pressable>
            </View>
          ) : fixedFiltered.length === 0 ? (
            <View style={styles.centered}>
              <Ionicons name="build-outline" size={28} color="#5C6670" />
              <Text style={styles.emptyText}>No machines fixed in this range</Text>
            </View>
          ) : (
            <FlatList
              data={fixedFiltered}
              keyExtractor={(item) => item.id}
              contentContainerStyle={styles.body}
              refreshControl={<RefreshControl refreshing={fixedRefreshing} onRefresh={handleFixedRefresh} tintColor="#F2A93B" />}
              renderItem={({ item }) => {
                const downtimeMin = item.startedAtMs && item.resolvedAtMs ? (item.resolvedAtMs - item.startedAtMs) / 60000 : null;
                return (
                  <View style={styles.fixedCard}>
                    {/* Top row: icon + line name + location */}
                    <View style={styles.breakdownTop}>
                      <View style={styles.fixedIcon}>
                        <Ionicons name="checkmark-circle" size={20} color="#4C9A6A" />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.breakdownLine}>{item.lineName}</Text>
                        <Text style={styles.breakdownMeta}>
                          {item.plant} · {item.workshop} · {item.division}
                        </Text>
                      </View>
                    </View>

                    {/* Downtime duration — prominent row */}
                    {downtimeMin != null && (
                      <View style={styles.downtimeRow}>
                        <Ionicons name="timer-outline" size={14} color="#F2A93B" />
                        <Text style={styles.downtimeLabel}>Downtime</Text>
                        <Text style={styles.downtimeValue}>{formatDurationMinutes(downtimeMin)}</Text>
                        {item.startedAtMs != null && item.resolvedAtMs != null && (
                          <Text style={styles.downtimeRange}>
                            {formatClockTime(item.startedAtMs)} – {formatClockTime(item.resolvedAtMs)}
                          </Text>
                        )}
                      </View>
                    )}

                    {/* Footer: technician who fixed it (= logged-in user) + when */}
                    <View style={styles.breakdownFooter}>
                      <Text style={styles.fixedByText}>
                        🔧 Fixed by {user?.name ?? user?.email ?? 'Technician'}
                      </Text>
                      {item.resolvedByName && (
                        <Text style={styles.breakdownSub}>Resumed by {item.resolvedByName}</Text>
                      )}
                      {item.resolvedAtMs != null && (
                        <Text style={styles.breakdownSub}>Fixed {formatResolvedLabel(item.resolvedAtMs)}</Text>
                      )}
                    </View>
                  </View>
                );
              }}
            />
          )}
        </View>
      )}
    </View>
  );
}

// ---------- Restocker material demand list ----------

interface MaterialOrder {
  id: string;
  lineId: string;
  lineName: string;
  plant: string;
  workshop: string;
  division: string;
  partName: string | null;
  detail: string;
  status: 'pending' | 'in_stock' | 'out_of_stock' | 'received';
  requestedByName: string | null;
  respondedByName: string | null;
  receivedByName: string | null;
  createdAtMs: number | null;
  respondedAtMs: number | null;
  receivedAtMs: number | null;
  etaMinutes: number | null;
}

// A restocker's "In Stock" response means supply is on its way — this is
// how long that promise is good for, shown as a live countdown wherever the
// order appears (both here and on MaterialOrderScreen).
const SUPPLY_ETA_MINUTES = 5;

function formatCountdown(etaAtMs: number, nowMs: number): string {
  const remainingSec = Math.max(0, Math.round((etaAtMs - nowMs) / 1000));
  const m = Math.floor(remainingSec / 60);
  const s = remainingSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function RestockerMaterialDemandList() {
  const [tab, setTab] = useState<'pending' | 'responded' | 'delivered'>('pending');
  const user = useAuthStore((s) => s.user);

  // ── Pending demands (live)
  const [pending, setPending] = useState<MaterialOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [liveConnected, setLiveConnected] = useState(false);
  const [nowMs, setNowMs] = useState(Date.now());
  const [respondingId, setRespondingId] = useState<string | null>(null);

  // ── Responded demands (in stock / out of stock) and Delivered (received) -
  // both drawn from the same underlying fetch/listener (respondedAll), just
  // filtered to different statuses, so they can share one date-range preset.
  const [respondedPreset, setRespondedPreset] = useState<(typeof FIXED_PRESETS)[number]['key']>('today');
  const [respondedAll, setRespondedAll] = useState<MaterialOrder[]>([]); // last-7-days window
  const [respondedLoading, setRespondedLoading] = useState(true);
  const [respondedRefreshing, setRespondedRefreshing] = useState(false);
  const [respondedLoadError, setRespondedLoadError] = useState<string | null>(null);

  const mapOrderDoc = (d: any): MaterialOrder => {
    const data: any = d.data();
    return {
      id: d.id,
      lineId: data.lineId ?? d.id,
      lineName: data.lineName ?? 'Unknown line',
      plant: data.plant ?? '—',
      workshop: data.workshop ?? '—',
      division: data.division ?? '—',
      partName: data.partName ?? null,
      detail: data.detail ?? '',
      status: data.status ?? 'pending',
      requestedByName: data.requestedBy?.name ?? null,
      respondedByName: data.respondedBy?.name ?? null,
      receivedByName: data.receivedBy?.name ?? null,
      createdAtMs: data.createdAt?.toMillis ? data.createdAt.toMillis() : null,
      respondedAtMs: data.respondedAt?.toMillis ? data.respondedAt.toMillis() : null,
      receivedAtMs: data.receivedAt?.toMillis ? data.receivedAt.toMillis() : null,
      etaMinutes: data.etaMinutes ?? null,
    };
  };

  // One-off fetch for initial load / pull-to-refresh; the onSnapshot
  // listener below is what keeps this live while the screen is open. Since
  // this never flips `loading` back to true, calling it again on a timer
  // (see the 3s reload below) never re-triggers the full-screen spinner —
  // the list just quietly updates in place.
  const fetchPending = useCallback(async () => {
    setLoadError(null);
    try {
      const q = query(collection(db, 'materialOrders'), where('status', '==', 'pending'));
      const snap = await getDocs(q);
      setPending(snap.docs.map(mapOrderDoc).sort((a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0)));
    } catch (e) {
      setLoadError('Could not load material requests. Check your connection and try again.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Single query for the broadest window (last 7 days); Today/Yesterday are
  // filtered from this in memory so switching presets doesn't refetch.
  // Range-filters on respondedAt + orderBy the same field only (status is
  // filtered client-side), so no composite Firestore index is needed.
  const fetchResponded = useCallback(async () => {
    setRespondedLoadError(null);
    try {
      const rangeStart = Timestamp.fromDate(daysAgoStart(6));
      const q = query(
        collection(db, 'materialOrders'),
        where('respondedAt', '>=', rangeStart),
        orderBy('respondedAt', 'desc')
      );
      const snap = await getDocs(q);
      const items = snap.docs.map(mapOrderDoc).filter((o) => o.status !== 'pending' && o.respondedAtMs != null);
      setRespondedAll(items);
    } catch (e) {
      setRespondedLoadError('Could not load responses. Check your connection and try again.');
    } finally {
      setRespondedLoading(false);
      setRespondedRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      fetchPending();
      fetchResponded();

      // Live — fires instantly when a supervisor submits a new request or
      // another restocker responds to one.
      const unsubscribePending = onSnapshot(
        query(collection(db, 'materialOrders'), where('status', '==', 'pending')),
        (snap) => {
          setPending(snap.docs.map(mapOrderDoc).sort((a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0)));
          setLoading(false);
          setLoadError(null);
          setLiveConnected(true);
        },
        (err) => {
          console.error('[materialOrders/pending] listener error:', err.code, err.message);
          setLoadError('Live updates disconnected. Pull to refresh.');
          setLiveConnected(false);
        }
      );

      const rangeStart = Timestamp.fromDate(daysAgoStart(6));
      const unsubscribeResponded = onSnapshot(
        query(
          collection(db, 'materialOrders'),
          where('respondedAt', '>=', rangeStart),
          orderBy('respondedAt', 'desc')
        ),
        (snap) => {
          setRespondedAll(snap.docs.map(mapOrderDoc).filter((o) => o.status !== 'pending' && o.respondedAtMs != null));
          setRespondedLoading(false);
        },
        (err) => {
          console.error('[materialOrders/responded] listener error:', err.code, err.message);
        }
      );

      // Belt-and-suspenders silent reload every 3s so this stays accurate
      // even if a Firestore push is ever delayed — neither fetch flips
      // `loading`/`respondedLoading` back to true, so there's no spinner
      // flash or screen blink, just the list quietly staying current. Also
      // ticks the 5-minute supply countdown.
      const reloadInterval = setInterval(() => {
        fetchPending();
        fetchResponded();
        setNowMs(Date.now());
      }, 3000);

      return () => {
        unsubscribePending();
        unsubscribeResponded();
        clearInterval(reloadInterval);
      };
    }, [fetchPending, fetchResponded])
  );

  const handleRefresh = () => { setRefreshing(true); fetchPending(); };
  const handleRespondedRefresh = () => { setRespondedRefreshing(true); fetchResponded(); };

  const respondedFiltered = useMemo(() => {
    const preset = FIXED_PRESETS.find((p) => p.key === respondedPreset)!;
    const rangeStartMs = daysAgoStart(preset.days).getTime();
    const rangeEndMs = preset.key === 'yesterday' ? startOfDay(new Date()).getTime() : Date.now();
    return respondedAll.filter(
      (o) =>
        o.status !== 'received' && // received items live under the Delivered tab instead
        o.respondedAtMs != null &&
        o.respondedAtMs >= rangeStartMs &&
        o.respondedAtMs < rangeEndMs + 1
    );
  }, [respondedAll, respondedPreset]);

  const deliveredFiltered = useMemo(() => {
    const preset = FIXED_PRESETS.find((p) => p.key === respondedPreset)!;
    const rangeStartMs = daysAgoStart(preset.days).getTime();
    const rangeEndMs = preset.key === 'yesterday' ? startOfDay(new Date()).getTime() : Date.now();
    // Delivered items are dated by when they were confirmed received, not
    // when the restocker originally responded.
    return respondedAll.filter(
      (o) =>
        o.status === 'received' &&
        o.receivedAtMs != null &&
        o.receivedAtMs >= rangeStartMs &&
        o.receivedAtMs < rangeEndMs + 1
    );
  }, [respondedAll, respondedPreset]);

  // Records the restocker's stock decision. "In Stock" starts the 5-minute
  // supply countdown (etaMinutes), which shows live on both this screen and
  // the supervisor's MaterialOrderScreen. "Out of Stock" just tells the
  // supervisor supply isn't coming, no timer.
  const handleRespond = async (item: MaterialOrder, decision: 'in_stock' | 'out_of_stock') => {
    setRespondingId(item.id);
    try {
      await updateDoc(doc(db, 'materialOrders', item.id), {
        status: decision,
        respondedBy: { uid: user?.uid ?? null, name: user?.name ?? user?.email ?? null },
        respondedAt: serverTimestamp(),
        etaMinutes: decision === 'in_stock' ? SUPPLY_ETA_MINUTES : null,
      });
    } catch (e) {
      Alert.alert('Error', 'Could not save your response. Check your connection and try again.');
    } finally {
      setRespondingId(null);
    }
  };

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.tabRow}>
        <Pressable onPress={() => setTab('pending')} style={[styles.tabBtn, tab === 'pending' && styles.tabBtnActive]}>
          <View style={[styles.liveDot, liveConnected && styles.liveDotConnected]} />
          <Text style={[styles.tabBtnText, tab === 'pending' && styles.tabBtnTextActive]}>Pending</Text>
          {!loading && !loadError && <Text style={styles.tabBtnCount}>{pending.length}</Text>}
        </Pressable>
        <Pressable onPress={() => setTab('responded')} style={[styles.tabBtn, tab === 'responded' && styles.tabBtnActive]}>
          <Ionicons name="checkmark-circle" size={14} color={tab === 'responded' ? '#4C9A6A' : '#5C6670'} />
          <Text style={[styles.tabBtnText, tab === 'responded' && styles.tabBtnTextActive]}>Responded</Text>
        </Pressable>
        <Pressable onPress={() => setTab('delivered')} style={[styles.tabBtn, tab === 'delivered' && styles.tabBtnActive]}>
          <Ionicons name="cube" size={14} color={tab === 'delivered' ? '#3E7CB1' : '#5C6670'} />
          <Text style={[styles.tabBtnText, tab === 'delivered' && styles.tabBtnTextActive]}>Delivered</Text>
        </Pressable>
        {tab === 'pending' && (
          <Text style={styles.liveStatusText}>{liveConnected ? 'Live' : 'Connecting…'}</Text>
        )}
      </View>

      {tab === 'pending' ? (
        loading ? (
          <View style={styles.centered}>
            <ActivityIndicator color="#F2A93B" size="large" />
          </View>
        ) : loadError ? (
          <View style={styles.centered}>
            <Ionicons name="alert-circle" size={22} color="#D64545" />
            <Text style={styles.errorText}>{loadError}</Text>
            <Pressable onPress={fetchPending} style={styles.retryButton}>
              <Text style={styles.retryText}>Retry</Text>
            </Pressable>
          </View>
        ) : pending.length === 0 ? (
          <View style={styles.centered}>
            <Ionicons name="checkmark-circle-outline" size={30} color="#4C9A6A" />
            <Text style={styles.emptyText}>No material requests right now</Text>
          </View>
        ) : (
          <FlatList
            data={pending}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.body}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor="#F2A93B" />}
            renderItem={({ item }) => (
              <View style={styles.breakdownCard}>
                <View style={styles.breakdownTop}>
                  <View style={styles.breakdownIcon}>
                    <Ionicons name="cube" size={20} color="#D64545" />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.breakdownLine}>{item.lineName}</Text>
                    <Text style={styles.breakdownMeta}>
                      {item.plant} · {item.workshop} · {item.division}
                    </Text>
                  </View>
                  <Text style={styles.agoText}>{formatAgo(item.createdAtMs, nowMs)}</Text>
                </View>

                {item.partName && <Text style={styles.demandDetail}>Part: {item.partName}</Text>}
                {!!item.detail && <Text style={styles.demandDetail}>{item.detail}</Text>}

                <View style={styles.breakdownFooter}>
                  {item.requestedByName && <Text style={styles.breakdownSub}>Requested by {item.requestedByName}</Text>}
                </View>

                <View style={styles.stockButtonRow}>
                  <Pressable
                    onPress={() => handleRespond(item, 'in_stock')}
                    disabled={respondingId === item.id}
                    style={[styles.inStockButton, respondingId === item.id && { opacity: 0.6 }]}
                  >
                    {respondingId === item.id ? (
                      <ActivityIndicator color="#14181C" size="small" />
                    ) : (
                      <>
                        <Ionicons name="checkmark-circle" size={15} color="#14181C" />
                        <Text style={styles.inStockButtonText}>In Stock</Text>
                      </>
                    )}
                  </Pressable>
                  <Pressable
                    onPress={() => handleRespond(item, 'out_of_stock')}
                    disabled={respondingId === item.id}
                    style={[styles.outOfStockButton, respondingId === item.id && { opacity: 0.6 }]}
                  >
                    <Ionicons name="close-circle" size={15} color="#D64545" />
                    <Text style={styles.outOfStockButtonText}>Out of Stock</Text>
                  </Pressable>
                </View>
              </View>
            )}
          />
        )
      ) : tab === 'responded' ? (
        <View style={{ flex: 1 }}>
          <View style={styles.presetRow}>
            {FIXED_PRESETS.map((p) => {
              const active = respondedPreset === p.key;
              return (
                <Pressable
                  key={p.key}
                  onPress={() => setRespondedPreset(p.key)}
                  style={[styles.presetChip, active && styles.presetChipActive]}
                >
                  <Text style={[styles.presetChipText, active && styles.presetChipTextActive]}>{p.label}</Text>
                </Pressable>
              );
            })}
          </View>

          {respondedLoading ? (
            <View style={styles.centered}>
              <ActivityIndicator color="#F2A93B" size="large" />
            </View>
          ) : respondedLoadError ? (
            <View style={styles.centered}>
              <Ionicons name="alert-circle" size={22} color="#D64545" />
              <Text style={styles.errorText}>{respondedLoadError}</Text>
              <Pressable onPress={fetchResponded} style={styles.retryButton}>
                <Text style={styles.retryText}>Retry</Text>
              </Pressable>
            </View>
          ) : respondedFiltered.length === 0 ? (
            <View style={styles.centered}>
              <Ionicons name="cube-outline" size={28} color="#5C6670" />
              <Text style={styles.emptyText}>No responses in this range</Text>
            </View>
          ) : (
            <FlatList
              data={respondedFiltered}
              keyExtractor={(item) => item.id}
              contentContainerStyle={styles.body}
              refreshControl={<RefreshControl refreshing={respondedRefreshing} onRefresh={handleRespondedRefresh} tintColor="#F2A93B" />}
              renderItem={({ item }) => {
                // respondedFiltered never contains 'received' items - those
                // moved to the Delivered tab - so this is always in_stock or
                // out_of_stock here.
                const isInStock = item.status === 'in_stock';
                const etaAtMs = isInStock && item.respondedAtMs != null ? item.respondedAtMs + (item.etaMinutes ?? SUPPLY_ETA_MINUTES) * 60000 : null;
                const stillWaiting = etaAtMs != null && nowMs < etaAtMs;
                return (
                  <View style={[styles.fixedCard, !isInStock && styles.outOfStockCard]}>
                    <View style={styles.breakdownTop}>
                      <View style={[styles.fixedIcon, !isInStock && styles.outOfStockIcon]}>
                        <Ionicons name={isInStock ? 'checkmark-circle' : 'close-circle'} size={20} color={isInStock ? '#4C9A6A' : '#D64545'} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.breakdownLine}>{item.lineName}</Text>
                        <Text style={styles.breakdownMeta}>
                          {item.plant} · {item.workshop} · {item.division}
                        </Text>
                      </View>
                    </View>

                    {item.partName && <Text style={styles.demandDetail}>Part: {item.partName}</Text>}
                    {!!item.detail && <Text style={styles.demandDetail}>{item.detail}</Text>}

                    {isInStock && (
                      <View style={styles.downtimeRow}>
                        <Ionicons name="timer-outline" size={14} color="#F2A93B" />
                        <Text style={styles.downtimeLabel}>{stillWaiting ? 'Supply arriving' : 'Supply due'}</Text>
                        <Text style={styles.downtimeValue}>{stillWaiting && etaAtMs != null ? formatCountdown(etaAtMs, nowMs) : 'now'}</Text>
                      </View>
                    )}

                    <View style={styles.breakdownFooter}>
                      <Text style={isInStock ? styles.fixedByText : styles.outOfStockText}>
                        {isInStock ? '📦' : '🚫'} {isInStock ? 'Marked in stock' : 'Marked out of stock'} by {item.respondedByName ?? 'Restocker'}
                      </Text>
                      {item.requestedByName && <Text style={styles.breakdownSub}>Requested by {item.requestedByName}</Text>}
                      {item.respondedAtMs != null && <Text style={styles.breakdownSub}>{formatResolvedLabel(item.respondedAtMs)}</Text>}
                    </View>
                  </View>
                );
              }}
            />
          )}
        </View>
      ) : (
        <View style={{ flex: 1 }}>
          <View style={styles.presetRow}>
            {FIXED_PRESETS.map((p) => {
              const active = respondedPreset === p.key;
              return (
                <Pressable
                  key={p.key}
                  onPress={() => setRespondedPreset(p.key)}
                  style={[styles.presetChip, active && styles.presetChipActive]}
                >
                  <Text style={[styles.presetChipText, active && styles.presetChipTextActive]}>{p.label}</Text>
                </Pressable>
              );
            })}
          </View>

          {respondedLoading ? (
            <View style={styles.centered}>
              <ActivityIndicator color="#F2A93B" size="large" />
            </View>
          ) : respondedLoadError ? (
            <View style={styles.centered}>
              <Ionicons name="alert-circle" size={22} color="#D64545" />
              <Text style={styles.errorText}>{respondedLoadError}</Text>
              <Pressable onPress={fetchResponded} style={styles.retryButton}>
                <Text style={styles.retryText}>Retry</Text>
              </Pressable>
            </View>
          ) : deliveredFiltered.length === 0 ? (
            <View style={styles.centered}>
              <Ionicons name="cube-outline" size={28} color="#5C6670" />
              <Text style={styles.emptyText}>No deliveries confirmed in this range</Text>
            </View>
          ) : (
            <FlatList
              data={deliveredFiltered}
              keyExtractor={(item) => item.id}
              contentContainerStyle={styles.body}
              refreshControl={<RefreshControl refreshing={respondedRefreshing} onRefresh={handleRespondedRefresh} tintColor="#F2A93B" />}
              renderItem={({ item }) => (
                <View style={[styles.fixedCard, styles.receivedCard]}>
                  <View style={styles.breakdownTop}>
                    <View style={[styles.fixedIcon, styles.receivedIcon]}>
                      <Ionicons name="cube" size={20} color="#3E7CB1" />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.breakdownLine}>{item.lineName}</Text>
                      <Text style={styles.breakdownMeta}>
                        {item.plant} · {item.workshop} · {item.division}
                      </Text>
                    </View>
                  </View>

                  {item.partName && <Text style={styles.demandDetail}>Part: {item.partName}</Text>}
                  {!!item.detail && <Text style={styles.demandDetail}>{item.detail}</Text>}

                  <View style={styles.breakdownFooter}>
                    <Text style={styles.receivedText}>
                      ✅ Confirmed received by {item.receivedByName ?? 'Supervisor'}
                    </Text>
                    {item.requestedByName && <Text style={styles.breakdownSub}>Requested by {item.requestedByName}</Text>}
                    {item.respondedByName && <Text style={styles.breakdownSub}>Supplied by {item.respondedByName}</Text>}
                    {item.receivedAtMs != null && <Text style={styles.breakdownSub}>{formatResolvedLabel(item.receivedAtMs)}</Text>}
                  </View>
                </View>
              )}
            />
          )}
        </View>
      )}
    </View>
  );
}


// ---------- Quality Control placeholder ----------
//
// Quality Control's real screen doesn't exist yet — this is a deliberate
// "Coming Soon" stand-in, kept as its own component (like
// TechnicianBreakdownList / RestockerMaterialDemandList above) so the
// eventual QC module just replaces this component's body. Nothing in the
// main DashboardScreen render below needs to change when that happens.
function QualityControlPlaceholder() {
  return (
    <View style={styles.centered}>
      <View style={styles.qcIconBadge}>
        <Ionicons name="checkmark-done-circle" size={40} color="#4C9A6A" />
      </View>
      <Text style={styles.qcTitle}>Quality Control Module</Text>
      <Text style={styles.emptyText}>Coming Soon</Text>
    </View>
  );
}

// ---------- Main dashboard ----------

export default function DashboardScreen() {
  const navigation = useNavigation<any>();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);

  const isAdmin = user?.role === 'admin';
  const isTechnician = !isAdmin && user?.assign === 'Technician';
  const isRestocker = !isAdmin && user?.assign === 'Restocker';
  const isQualityControl = !isAdmin && user?.assign === 'Quality Control';
  const options = isAdmin ? ADMIN_OPTIONS : isQualityControl ? QUALITY_OPTIONS : SUPERVISOR_OPTIONS;

  const handleLogout = async () => {
    await logout();
    navigation.replace('AdminLogin');
  };

  const headerTitle = isAdmin
    ? 'Admin Dashboard'
    : isTechnician
    ? 'Technician Dashboard'
    : isRestocker
    ? 'Restocker Dashboard'
    : isQualityControl
    ? 'Quality Control Dashboard'
    : 'Supervisor Dashboard';

  // Admin's main dashboard is the digital production overview — its own
  // header (hamburger + ProdPulse + ADMIN) lives inside that screen, so it
  // deliberately replaces this screen's generic header/card list rather
  // than rendering below it. Every other role is untouched.
  if (isAdmin) {
    return <AdminOverviewScreen />;
  }

  // Plain Supervisor (assign 'Supervisor' or unset) gets the digital
  // active-session overview, with its own header + hamburger drawer. The
  // Technician, Restocker and Quality Control branches below are
  // deliberately untouched — they keep the original header and card list.
  if (!isTechnician && !isRestocker && !isQualityControl) {
    return <SupervisorOverviewScreen />;
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>{headerTitle}</Text>
          <Text style={styles.subtitle}>{user?.email}</Text>
        </View>
        <Pressable onPress={handleLogout} style={styles.logoutButton} hitSlop={10}>
          <Ionicons name="log-out-outline" size={22} color="#8A96A3" />
        </Pressable>
      </View>

      {isTechnician ? (
        <TechnicianBreakdownList />
      ) : isRestocker ? (
        <RestockerMaterialDemandList />
      ) : isQualityControl && QUALITY_OPTIONS.length === 0 ? (
        <QualityControlPlaceholder />
      ) : (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1, paddingBottom: 24 }}>
          <View style={styles.body}>
            {options.map((opt) => (
              <OptionCard key={opt.key} config={opt} />
            ))}
          </View>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#14181C' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 20,
  },
  title: { color: '#ECEFF2', fontSize: 22, fontWeight: '800' },
  subtitle: { color: '#8A96A3', fontSize: 13, marginTop: 2 },
  logoutButton: {
    width: 40,
    height: 40,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#2C343C',
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: { paddingHorizontal: 20, gap: 12 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    backgroundColor: '#1D2329',
    borderWidth: 1,
    borderColor: '#2C343C',
    borderRadius: 12,
    padding: 16,
    minHeight: 78,
  },
  cardPressed: { backgroundColor: '#242B32', borderColor: '#3A434C' },
  iconBadge: {
    width: 46,
    height: 46,
    borderRadius: 10,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardTitle: { color: '#ECEFF2', fontSize: 15.5, fontWeight: '700' },
  cardSubtitle: { color: '#8A96A3', fontSize: 12.5, marginTop: 2 },

  // Technician view — tab switcher
  tabRow: { flexDirection: 'row', paddingHorizontal: 20, gap: 10, marginBottom: 14 },
  tabBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#2C343C',
    backgroundColor: '#1D2329',
  },
  tabBtnActive: { borderColor: '#F2A93B', backgroundColor: '#F2A93B18' },
  tabBtnText: { color: '#8A96A3', fontSize: 13, fontWeight: '700' },
  tabBtnTextActive: { color: '#ECEFF2' },
  tabBtnCount: {
    color: '#D64545',
    fontSize: 11.5,
    fontWeight: '800',
    backgroundColor: '#D6454522',
    borderRadius: 10,
    paddingHorizontal: 7,
    paddingVertical: 1,
    overflow: 'hidden',
  },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#D64545' },
  liveDotConnected: { backgroundColor: '#4C9A6A' },
  liveStatusText: { color: '#5C6670', fontSize: 11, fontWeight: '700', marginLeft: 'auto', alignSelf: 'center' },

  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 30 },
  qcIconBadge: {
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 1.5,
    borderColor: '#4C9A6A',
    backgroundColor: '#4C9A6A22',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  qcTitle: { color: '#ECEFF2', fontSize: 17, fontWeight: '800' },
  errorText: { color: '#F0A8A8', fontSize: 13.5, textAlign: 'center' },
  emptyText: { color: '#5C6670', fontSize: 14, textAlign: 'center' },
  retryButton: {
    borderWidth: 1,
    borderColor: '#2C343C',
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
    marginTop: 4,
  },
  retryText: { color: '#ECEFF2', fontSize: 13, fontWeight: '600' },

  // Fixed-machines date presets
  presetRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 20, marginBottom: 12 },
  presetChip: {
    borderWidth: 1,
    borderColor: '#2C343C',
    backgroundColor: '#1D2329',
    borderRadius: 16,
    paddingHorizontal: 13,
    paddingVertical: 7,
  },
  presetChipActive: { borderColor: '#F2A93B', backgroundColor: '#F2A93B22' },
  presetChipText: { color: '#8A96A3', fontSize: 12.5, fontWeight: '600' },
  presetChipTextActive: { color: '#F2A93B' },

  breakdownCard: {
    backgroundColor: '#1D2329',
    borderWidth: 1,
    borderColor: '#D6454555',
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
  },
  fixedCard: {
    backgroundColor: '#1D2329',
    borderWidth: 1,
    borderColor: '#2C343C',
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
  },
  breakdownTop: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 10 },
  breakdownIcon: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: '#D6454522',
    borderWidth: 1.5,
    borderColor: '#D64545',
    alignItems: 'center',
    justifyContent: 'center',
  },
  fixedIcon: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: '#4C9A6A22',
    borderWidth: 1.5,
    borderColor: '#4C9A6A',
    alignItems: 'center',
    justifyContent: 'center',
  },
  breakdownLine: { color: '#ECEFF2', fontSize: 16, fontWeight: '800' },
  breakdownMeta: { color: '#8A96A3', fontSize: 12.5, marginTop: 2 },
  breakdownFooter: { borderTopWidth: 1, borderTopColor: '#2C343C', paddingTop: 8, gap: 3 },
  breakdownSub: { color: '#8A96A3', fontSize: 12 },
  liveCounter: { color: '#D64545', fontSize: 17, fontWeight: '800', fontVariant: ['tabular-nums'] },
  downtimeBadge: {
    color: '#4C9A6A',
    fontSize: 13,
    fontWeight: '800',
    backgroundColor: '#4C9A6A22',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
    overflow: 'hidden',
  },
  downtimeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#F2A93B11',
    borderWidth: 1,
    borderColor: '#F2A93B33',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    marginBottom: 10,
  },
  downtimeLabel: { color: '#F2A93B', fontSize: 12, fontWeight: '700' },
  downtimeValue: { color: '#F2A93B', fontSize: 15, fontWeight: '900' },
  downtimeRange: { color: '#8A96A3', fontSize: 11, flex: 1, textAlign: 'right' },
  fixedByText: { color: '#4C9A6A', fontSize: 12.5, fontWeight: '700' },

  // Restocker material demand
  agoText: { color: '#8A96A3', fontSize: 11.5, fontWeight: '700' },
  demandDetail: { color: '#ECEFF2', fontSize: 13, marginBottom: 6 },
  stockButtonRow: { flexDirection: 'row', gap: 10, marginTop: 8 },
  inStockButton: {
    flex: 1,
    flexDirection: 'row',
    gap: 6,
    backgroundColor: '#4C9A6A',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  inStockButtonText: { color: '#14181C', fontSize: 13, fontWeight: '800' },
  outOfStockButton: {
    flex: 1,
    flexDirection: 'row',
    gap: 6,
    backgroundColor: '#1D2329',
    borderWidth: 1,
    borderColor: '#D64545',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  outOfStockButtonText: { color: '#D64545', fontSize: 13, fontWeight: '800' },
  outOfStockCard: { borderColor: '#D6454555' },
  outOfStockIcon: { backgroundColor: '#D6454522', borderColor: '#D64545' },
  outOfStockText: { color: '#D64545', fontSize: 12.5, fontWeight: '700' },
  receivedCard: { borderColor: '#3E7CB155' },
  receivedIcon: { backgroundColor: '#3E7CB122', borderColor: '#3E7CB1' },
  receivedText: { color: '#3E7CB1', fontSize: 12.5, fontWeight: '700' },

});