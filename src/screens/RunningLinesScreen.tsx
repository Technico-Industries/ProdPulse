// src/screens/RunningLinesScreen.tsx
//
// Supervisor "Running Lines" page — one swipe left of the supervisor
// overview (SupervisorDashboardPager), also reachable from the pager's
// tabs on web. Lists EVERY line with an active production session, whoever
// started it, so any supervisor can open one and continue its hourly entry
// (supervisor handover).
//
// Data — no new source and nothing invented:
//   activeSessions/{lineId}  live listener (the session docs
//                            RecordProductionScreen writes);
//   productionRecords        live listener on the sessions' production
//                            dates, narrowed to each session's line + date +
//                            shift and de-duplicated per slot;
//   productionLines          read once, only for the current model's name.
// Figures and statuses come from utils/supervisorHandover
// (buildRunningLineCards). A finalized session's doc is deleted, so it
// drops off this list by itself.
//
// Tapping a card opens RecordProduction with { lineId } — that screen loads
// the line's existing session (the same doc, never a new one).

import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, Pressable, StyleSheet, ScrollView, ActivityIndicator, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { collection, getDocs, onSnapshot, query, where } from 'firebase/firestore';
import { db } from '../services/firebase';
import { useAuthStore } from '../stores/authStore';
import { timestampToMillis } from '../utils/productionDay';
import {
  LinePartsLookup,
  RUNNING_STATUS_COLORS,
  RUNNING_STATUS_LABELS,
  RunningLineCard,
  RunningRecord,
  RunningSession,
  buildRunningLineCards,
  isHandover,
  parseRunningSession,
} from '../utils/supervisorHandover';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function prettyDate(s: string | null): string {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return '—';
  const [y, m, d] = s.split('-');
  return `${d} ${MONTHS[Number(m) - 1]} ${y}`;
}

function formatInt(n: number) {
  return Math.round(n).toLocaleString();
}

function formatVariance(n: number) {
  if (n === 0) return '0';
  return `${n > 0 ? '+' : '−'}${formatInt(Math.abs(n))}`;
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, color ? { color } : null]} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
    </View>
  );
}

export default function RunningLinesScreen() {
  const navigation = useNavigation<any>();
  const user = useAuthStore((s) => s.user);
  const { width } = useWindowDimensions();

  const [sessions, setSessions] = useState<RunningSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [records, setRecords] = useState<RunningRecord[]>([]);
  const [recordsError, setRecordsError] = useState<string | null>(null);
  const [partsByLine, setPartsByLine] = useState<LinePartsLookup>({});
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [retryToken, setRetryToken] = useState(0);

  // Every active session, live.
  useEffect(() => {
    setSessionsLoading(true);
    setSessionsError(null);
    return onSnapshot(
      collection(db, 'activeSessions'),
      (snap) => {
        setSessions(snap.docs.map((d) => parseRunningSession(d.id, d.data())));
        setSessionsLoading(false);
        setSessionsError(null);
      },
      (err) => {
        console.error('[RunningLines] activeSessions listener error', err);
        setSessionsError('Unable to load running lines');
        setSessionsLoading(false);
      }
    );
  }, [retryToken]);

  // Part names for "current model". Optional — a failure just falls back to
  // the newest saved record's part name.
  useEffect(() => {
    getDocs(collection(db, 'productionLines'))
      .then((snap) => {
        const map: LinePartsLookup = {};
        snap.docs.forEach((d) => {
          const data: any = d.data();
          const parts =
            Array.isArray(data.parts) && data.parts.length ? data.parts :
            Array.isArray(data.models) && data.models.length ? data.models :
            Array.isArray(data.partsList) ? data.partsList : [];
          map[d.id] = parts.map((p: any) => ({ name: p?.name ?? p?.partName ?? '' }));
        });
        setPartsByLine(map);
      })
      .catch((e) => console.warn('[RunningLines] productionLines read failed', e));
  }, [retryToken]);

  // Saved slot records of the sessions' production dates, live. Equality /
  // `in` on productionDate only — no composite index.
  const dates = useMemo(
    () => Array.from(new Set(sessions.map((s) => s.productionDate).filter(Boolean) as string[])).sort().slice(0, 10),
    [sessions]
  );
  const datesKey = dates.join(',');
  useEffect(() => {
    if (!dates.length) {
      setRecords([]);
      setRecordsError(null);
      return;
    }
    return onSnapshot(
      query(collection(db, 'productionRecords'), where('productionDate', 'in', dates)),
      (snap) => {
        setRecords(
          snap.docs.map((d) => {
            const r: any = d.data();
            return {
              id: d.id,
              lineId: r.lineId ?? null,
              shift: r.shift ?? null,
              productionDate: r.productionDate ?? null,
              expectedParts: typeof r.expectedParts === 'number' ? r.expectedParts : null,
              producedThisSlot: typeof r.producedThisSlot === 'number' ? r.producedThisSlot : null,
              rejections: typeof r.rejections === 'number' ? r.rejections : null,
              partName: r.partName ?? null,
              slotIndex: typeof r.slotIndex === 'number' ? r.slotIndex : null,
              partSegment: r.partSegment ?? null,
              createdAtMs: timestampToMillis(r.createdAt),
              updatedAtMs: timestampToMillis(r.updatedAt),
            };
          })
        );
        setRecordsError(null);
      },
      (err) => {
        console.error('[RunningLines] productionRecords listener error', err);
        setRecordsError('Production figures could not be loaded');
      }
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datesKey, retryToken]);

  // "Awaiting entry" depends on the time of day.
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 60000);
    return () => clearInterval(id);
  }, []);

  const cards = useMemo(() => buildRunningLineCards(sessions, records, partsByLine, nowMs), [sessions, records, partsByLine, nowMs]);
  const columns = width >= 1100 ? 3 : width >= 700 ? 2 : 1;
  const cardWidth = columns === 1 ? '100%' : `${100 / columns - 1.4}%`;

  const open = (c: RunningLineCard) => navigation.navigate('RecordProduction', { lineId: c.lineId, requestedAt: Date.now() });

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.brand}>Running Lines</Text>
          <Text style={styles.brandSub}>Open a line to continue its production entry</Text>
        </View>
        {!sessionsLoading && !sessionsError ? (
          <View style={styles.countPill}>
            <Text style={styles.countPillText}>{cards.length} LIVE</Text>
          </View>
        ) : null}
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {sessionsLoading ? (
          <View style={styles.stateBlock}>
            <ActivityIndicator size="large" color="#3E7CB1" />
            <Text style={styles.stateText}>Loading running lines…</Text>
          </View>
        ) : sessionsError ? (
          <View style={styles.stateCard}>
            <Ionicons name="cloud-offline-outline" size={30} color="#D64545" />
            <Text style={styles.stateTitle}>{sessionsError}</Text>
            <Text style={styles.stateText}>Check your connection and try again.</Text>
            <Pressable
              onPress={() => setRetryToken((t) => t + 1)}
              style={({ pressed }) => [styles.actionButton, pressed && styles.pressed]}
              accessibilityRole="button"
              accessibilityLabel="Retry"
            >
              <Ionicons name="refresh" size={16} color="#ECEFF2" />
              <Text style={styles.actionText}>Retry</Text>
            </Pressable>
          </View>
        ) : cards.length === 0 ? (
          <View style={styles.stateCard}>
            <Ionicons name="power-outline" size={30} color="#8A96A3" />
            <Text style={styles.stateTitle}>No lines running</Text>
            <Text style={styles.stateText}>No production line has an active session right now.</Text>
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
            {recordsError ? (
              <View style={styles.warnRow}>
                <Ionicons name="warning-outline" size={15} color="#F2A93B" />
                <Text style={styles.warnText}>{recordsError} — plan and actual may show 0.</Text>
              </View>
            ) : null}
            <View style={styles.grid}>
              {cards.map((c) => {
                const color = RUNNING_STATUS_COLORS[c.status];
                const mine = !isHandover(c.session.startedBy.uid, user?.uid);
                const varianceColor = c.planToDate === 0 && c.actual === 0 ? undefined : c.variance >= 0 ? '#4C9A6A' : '#D64545';
                return (
                  <Pressable
                    key={c.lineId}
                    onPress={() => open(c)}
                    style={({ pressed }) => [styles.card, { width: cardWidth as any, borderColor: `${color}55` }, pressed && styles.pressed]}
                    accessibilityRole="button"
                    accessibilityLabel={`${c.lineName}, ${RUNNING_STATUS_LABELS[c.status]} — open production entry`}
                  >
                    <View style={styles.cardTop}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.lineName} numberOfLines={1}>{c.lineName}</Text>
                        <Text style={styles.meta} numberOfLines={1}>{c.section ?? '—'}</Text>
                      </View>
                      <View style={[styles.badge, { borderColor: `${color}66`, backgroundColor: `${color}1F` }]}>
                        <View style={[styles.dot, { backgroundColor: color }]} />
                        <Text style={[styles.badgeText, { color }]}>{RUNNING_STATUS_LABELS[c.status].toUpperCase()}</Text>
                      </View>
                    </View>

                    <Text style={styles.metaStrong} numberOfLines={1}>
                      Model: {c.model ?? '—'}
                    </Text>
                    <Text style={styles.meta} numberOfLines={1}>
                      Shift {c.shift} · {prettyDate(c.productionDate)}
                    </Text>
                    <Text style={styles.meta} numberOfLines={2}>
                      Started by {mine ? 'you' : c.startedBy ?? 'another supervisor'}
                      {c.lastUpdatedBy ? ` · last entry by ${c.lastUpdatedBy}` : ''}
                    </Text>

                    <View style={styles.statRow}>
                      <Stat label="Plan to date" value={formatInt(c.planToDate)} />
                      <Stat label="Actual (good)" value={formatInt(c.actual)} />
                      <Stat label="Variance" value={formatVariance(c.variance)} color={varianceColor} />
                      <Stat label="Shift plan" value={c.shiftPlan != null ? formatInt(c.shiftPlan) : '—'} />
                    </View>

                    <View style={styles.footer}>
                      <Text style={styles.footerText} numberOfLines={2}>
                        {c.slots.completed.length} saved
                        {c.slots.awaiting.length ? ` · ${c.slots.awaiting.length} awaiting entry` : ''}
                        {c.rejections ? ` · ${formatInt(c.rejections)} rejected` : ''}
                      </Text>
                      <View style={styles.openBtn}>
                        <Text style={styles.openBtnText}>{mine ? 'Continue' : 'Continue entry'}</Text>
                        <Ionicons name="chevron-forward" size={14} color="#0E1216" />
                      </View>
                    </View>
                  </Pressable>
                );
              })}
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#14181C' },
  pressed: { opacity: 0.85 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#2C343C',
  },
  brand: { color: '#ECEFF2', fontSize: 19, fontWeight: '900', letterSpacing: 0.3 },
  brandSub: { color: '#8A96A3', fontSize: 12.5, marginTop: 1 },
  countPill: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#4C9A6A66',
    backgroundColor: '#4C9A6A1F',
  },
  countPillText: { color: '#4C9A6A', fontSize: 10.5, fontWeight: '900', letterSpacing: 1 },
  // Bottom padding clears the pager's page tabs.
  scroll: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 80, gap: 12 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  card: {
    backgroundColor: '#1C2228',
    borderRadius: 14,
    borderWidth: 1,
    padding: 14,
    gap: 4,
  },
  cardTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 4 },
  lineName: { color: '#ECEFF2', fontSize: 15.5, fontWeight: '800' },
  meta: { color: '#8A96A3', fontSize: 12 },
  metaStrong: { color: '#ECEFF2', fontSize: 12.5, fontWeight: '700' },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
  },
  badgeText: { fontSize: 9.5, fontWeight: '900', letterSpacing: 0.6 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  statRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
  stat: {
    flexGrow: 1,
    flexBasis: '45%',
    backgroundColor: '#14181C',
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 10,
  },
  statLabel: { color: '#5C6670', fontSize: 10.5, fontWeight: '700' },
  statValue: { color: '#ECEFF2', fontSize: 16, fontWeight: '800', marginTop: 2 },
  footer: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10 },
  footerText: { color: '#8A96A3', fontSize: 11.5, fontWeight: '700', flex: 1 },
  openBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#3E7CB1',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  openBtnText: { color: '#0E1216', fontSize: 12.5, fontWeight: '800' },
  warnRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  warnText: { color: '#F2A93B', fontSize: 12, flex: 1 },
  stateBlock: { gap: 12, alignItems: 'center', paddingVertical: 20 },
  stateCard: {
    alignItems: 'center',
    gap: 10,
    padding: 24,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#2C343C',
    backgroundColor: '#1C2228',
  },
  stateTitle: { color: '#ECEFF2', fontSize: 16.5, fontWeight: '800', textAlign: 'center' },
  stateText: { color: '#8A96A3', fontSize: 13, textAlign: 'center' },
  actionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#2C343C',
    backgroundColor: '#14181C',
    marginTop: 6,
  },
  actionText: { color: '#ECEFF2', fontSize: 13.5, fontWeight: '700' },
  actionButtonPrimary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: '#4C9A6A',
    marginTop: 6,
  },
  actionTextPrimary: { color: '#0E1216', fontSize: 13.5, fontWeight: '800' },
});
