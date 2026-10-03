// src/screens/PCSPerHourScreen.tsx
//
// Shows: Actual, Man Power (Target), Man Power (Actual), OT, Man Hour, and
// PCS Man Hour for a selected plant/workshop/division/date.
//
// Actual: for the selected plant/workshop/division and date, every matching
// doc in `productionRecords` is an independent slot record (production is
// no longer a running cumulative total, and there is no more "one record =
// one hour" assumption — RecordProductionScreen writes one independent
// record per slot, plus two independent before/after records for any slot
// that contains a changeover). Actual is the sum of `producedThisSlot`
// across ALL matching records, not just one per line. A line that logged
// several split slots (or a changeover) in a day contributes every one of
// those records.
//
// Field mapping matches RecordProductionScreen's actual productionRecords
// schema:
//   plant / workshop / division — filters, same field names on both screens.
//   productionDate               — the shift's production-day key (handles
//                                   Shift B rolling past midnight). Filtering
//                                   by this field, rather than a createdAt
//                                   timestamp range, is what keeps a Shift B
//                                   slot logged after midnight attributed to
//                                   the correct day.
//   producedThisSlot              — this slot/segment's actual output.
//   slotEndMinutesAbs             — this slot/segment's end time, used only
//                                   for the hours/OT timing calc below.
//
// Man Power (Target): the TOTAL number of operators attendance was
// submitted for, on that plant/workshop/division/date — present + absent +
// on leave. This is the full roster accounted for that day, regardless of
// who actually showed up (see AttendanceSheetScreen).
//
// Man Power (Actual): the subset of that same attendance with status ===
// 'present' — who actually showed up.
//
// OT: hours worked beyond the base 8.5h shift, derived per line from its
// LATEST slot/segment's end time (the record with the greatest
// slotEndMinutesAbs for that line) vs. that shift's scheduled end (15:30 for
// Shift A, 03:30 next day for Shift B) — averaged across matching lines.
// This is a timing calculation only, so it's unaffected by how many split
// slots a line logged — it just needs the latest one. It never affects the
// production sum above.
//
// Man Hour: Man Power (Actual) × average hours worked — the real labor
// available that day, which is what actually constrains output (not the
// target headcount).
//
// PCS Man Hour: Actual ÷ Man Hour.
//
// "Submit" writes this computed result to `pcsManHourRecords`, one doc per
// plant/workshop/division/date (deterministic id, so submitting again for
// the same day just overwrites). KPIAnalysisScreen reads directly from that
// collection for its PCS Man Per Hour report instead of recomputing from
// productionRecords/attendanceRecords itself — keeping exactly one source of
// truth for the numbers shown there.

import React, { useState } from 'react';
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
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { collection, getDocs, query, where, doc, setDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../services/firebase';
import { useAuthStore } from '../stores/authStore';
import { PLANTS, WORKSHOPS, DIVISIONS } from '../constants/lineOptions';

// ─── Constants ────────────────────────────────────────────────────────────────
// Mirrors RecordProductionScreen — both shifts run 8.5 base hours; OT shows
// up as the last slot ending later than this.
const SHIFT_A_START = 7 * 60;
const SHIFT_A_END = 15 * 60 + 30;
const SHIFT_B_START = 19 * 60;
const SHIFT_B_END_ABS = 24 * 60 + 3 * 60 + 30;
const BASE_SHIFT_HOURS = 8.5;

// ─── Types ────────────────────────────────────────────────────────────────────

interface LineResult {
  lineId: string;
  lineName: string;
  shift: string | null;
  // Sum of `producedThisSlot` across every matching slot/segment record for
  // this line — NOT a single record's value.
  production: number;
  otHours: number;
  // Label/timestamp of this line's LATEST slot (by slotEndMinutesAbs, tie
  // broken by createdAt) — used only for the hours/OT timing calc and the
  // "last slot" hint shown in the UI, not for production.
  lastSlotLabel: string | null;
  lastSlotAtMs: number | null;
  hours: number;
}

interface PcsPerHourResult {
  actual: number;
  manPowerTarget: number;
  manPowerActual: number;
  otHours: number;
  manHour: number;
  pcsManHour: number;
  avgHours: number;
  lines: LineResult[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function pad2(n: number) {
  return String(n).padStart(2, '0');
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function isValidDateStr(s: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(`${s}T00:00:00`).getTime());
}

function round1(n: number) {
  return Math.round(n * 10) / 10;
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function formatClockTime(minutesAbs: number): string {
  const m = ((minutesAbs % 1440) + 1440) % 1440;
  let h = Math.floor(m / 60);
  const min = m % 60;
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${pad2(min)} ${ampm}`;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function PCSPerHourScreen() {
  const navigation = useNavigation<any>();
  const user = useAuthStore((s) => s.user);

  const [plant, setPlant] = useState<string | null>(null);
  const [workshop, setWorkshop] = useState<string | null>(null);
  const [division, setDivision] = useState<string | null>(null);
  const [dateStr, setDateStr] = useState(todayStr());

  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [result, setResult] = useState<PcsPerHourResult | null>(null);
  const [pushing, setPushing] = useState(false);

  const handleFetch = async () => {
    if (!plant || !workshop || !division) {
      setFetchError('Select plant, workshop, and division first.');
      return;
    }
    if (!isValidDateStr(dateStr)) {
      setFetchError('Enter a valid date (YYYY-MM-DD).');
      return;
    }
    setFetching(true);
    setFetchError(null);
    setResult(null);
    try {
      // Filter by productionDate — the shift's production-day key written by
      // RecordProductionScreen (handles Shift B rolling past midnight) —
      // rather than a createdAt timestamp range, which would misattribute a
      // late-night Shift B slot to the wrong calendar day.
      const [prodSnap, attSnap] = await Promise.all([
        getDocs(query(collection(db, 'productionRecords'), where('productionDate', '==', dateStr))),
        getDocs(query(collection(db, 'attendanceRecords'), where('date', '==', dateStr))),
      ]);

      // Every matching doc is an independent slot (or before/after
      // changeover segment) record — split slots are NOT cumulative, so we
      // sum `producedThisSlot` across ALL of them per line, whatever their
      // count. Separately, we track each line's LATEST slot/segment (by
      // slotEndMinutesAbs, falling back to createdAt) purely to derive that
      // line's hours/OT — a timing calc that only ever needs the latest end
      // time, never a sum, and never feeds into the production total above.
      interface LineAccum {
        lineId: string;
        lineName: string;
        shift: string | null;
        production: number;
        latestSlotEndAbs: number | null;
        latestCreatedAtMs: number | null;
        latestSlotLabel: string | null;
      }
      const accByLine = new Map<string, LineAccum>();
      prodSnap.docs.forEach((d) => {
        const data: any = d.data();
        if (data.plant !== plant || data.workshop !== workshop || data.division !== division) return;
        const lineId: string = data.lineId ?? d.id;
        const shift: string | null = data.shift ?? null;
        const slotEnd: number | null = data.slotEndMinutesAbs ?? null;
        const createdAtMs = data.createdAt?.toMillis ? data.createdAt.toMillis() : null;
        // productionRecords stores this slot/segment's actual output as
        // `producedThisSlot` (see RecordProductionScreen) — NOT `produced`.
        const produced: number = data.producedThisSlot ?? 0;

        const existing = accByLine.get(lineId);
        if (!existing) {
          accByLine.set(lineId, {
            lineId,
            lineName: data.lineName ?? 'Unknown line',
            shift,
            production: produced,
            latestSlotEndAbs: slotEnd,
            latestCreatedAtMs: createdAtMs,
            latestSlotLabel: data.slotLabel ?? null,
          });
          return;
        }

        existing.production += produced;
        // Docs can arrive in any order, so compare slotEndMinutesAbs
        // (falling back to createdAt) so hours/OT always reflect the
        // slot/segment that actually ends latest for this line, not just
        // the last-seen doc.
        const isLater =
          slotEnd != null &&
          (existing.latestSlotEndAbs == null || slotEnd > existing.latestSlotEndAbs);
        if (isLater) {
          existing.latestSlotEndAbs = slotEnd;
          existing.latestSlotLabel = data.slotLabel ?? null;
          existing.latestCreatedAtMs = createdAtMs;
          existing.shift = shift;
        }
      });

      const lines: LineResult[] = Array.from(accByLine.values())
        .map((acc): LineResult => {
          const shiftStart = acc.shift === 'B' ? SHIFT_B_START : SHIFT_A_START;
          const shiftEnd = acc.shift === 'B' ? SHIFT_B_END_ABS : SHIFT_A_END;
          const slotEnd = acc.latestSlotEndAbs;
          const hours = slotEnd != null ? Math.max(0, round2((slotEnd - shiftStart) / 60)) : BASE_SHIFT_HOURS;
          const otHours = slotEnd != null ? Math.max(0, round2((slotEnd - shiftEnd) / 60)) : 0;
          return {
            lineId: acc.lineId,
            lineName: acc.lineName,
            shift: acc.shift,
            production: acc.production,
            otHours,
            lastSlotLabel: acc.latestSlotLabel,
            lastSlotAtMs: acc.latestCreatedAtMs,
            hours,
          };
        })
        .sort((a, b) => a.lineName.localeCompare(b.lineName));

      const actual = lines.reduce((s, l) => s + l.production, 0);
      const avgHours = lines.length > 0 ? round2(lines.reduce((s, l) => s + l.hours, 0) / lines.length) : BASE_SHIFT_HOURS;
      const avgOtHours = lines.length > 0 ? round2(lines.reduce((s, l) => s + l.otHours, 0) / lines.length) : 0;

      const attendanceForDivision = attSnap.docs.filter((d) => {
        const data: any = d.data();
        return data.plant === plant && data.workshop === workshop && data.division === division;
      });
      // Target = everyone attendance was submitted for that day (present +
      // absent + on leave); Actual = just the present subset.
      const manPowerTarget = attendanceForDivision.length;
      const manPowerActual = attendanceForDivision.filter((d) => (d.data() as any).status === 'present').length;

      // Man Hour uses ACTUAL manpower — the real labor available that day —
      // not the target, since that's the true constraint on output.
      const manHour = manPowerActual > 0 ? round2(manPowerActual * avgHours) : 0;
      const pcsManHour = manHour > 0 ? round2(actual / manHour) : 0;

      setResult({ actual, manPowerTarget, manPowerActual, otHours: avgOtHours, manHour, pcsManHour, avgHours, lines });
    } catch (e) {
      console.error('[PCSPerHour] fetch failed:', e);
      setFetchError('Could not load data. Check your connection and try again.');
    } finally {
      setFetching(false);
    }
  };

  const handleSubmit = async () => {
    if (!result || !plant || !workshop || !division) return;
    setPushing(true);
    try {
      const safeId = (s: string) => s.replace(/[^a-zA-Z0-9]+/g, '-');
      const docId = `${safeId(plant)}_${safeId(workshop)}_${safeId(division)}_${dateStr}`;
      await setDoc(doc(db, 'pcsManHourRecords', docId), {
        plant,
        workshop,
        division,
        date: dateStr,
        actual: result.actual,
        manPowerTarget: result.manPowerTarget,
        manPowerActual: result.manPowerActual,
        otHours: result.otHours,
        manHour: result.manHour,
        pcsManHour: result.pcsManHour,
        avgHours: result.avgHours,
        lines: result.lines.map((l) => ({
          lineId: l.lineId,
          lineName: l.lineName,
          shift: l.shift,
          production: l.production,
          hours: l.hours,
          otHours: l.otHours,
        })),
        submittedBy: user?.name ?? user?.email ?? 'Unknown',
        submittedByUid: user?.uid ?? null,
        createdAt: serverTimestamp(),
      });
      Alert.alert('Submitted', `PCS Man Hour saved for ${division} on ${dateStr}.\n\nThis is what KPI Analysis will show for this day.`);
    } catch (e) {
      console.error('[PCSPerHour] submit failed:', e);
      Alert.alert('Error', 'Could not save this report. Check your connection and try again.');
    } finally {
      setPushing(false);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <Pressable onPress={() => navigation.goBack()} style={styles.backButton} hitSlop={12}>
          <Ionicons name="arrow-back" size={22} color="#8A96A3" />
          <Text style={styles.backText}>Back</Text>
        </Pressable>

        <Text style={styles.title}>PCS Man Per Hour</Text>
        <Text style={styles.subtitle}>
          Actual vs. Man Power Target/Actual, OT, Man Hour, and PCS Man Hour — for the selected division and date
        </Text>

        <View style={styles.field}>
          <Text style={styles.label}>PLANT</Text>
          <View style={styles.chipRow}>
            {PLANTS.map((p) => {
              const selected = plant === p;
              return (
                <Pressable key={p} onPress={() => setPlant(selected ? null : p)} style={[styles.chip, selected && styles.chipSelected]}>
                  <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{p}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>WORKSHOP</Text>
          <View style={styles.chipRow}>
            {WORKSHOPS.map((w) => {
              const selected = workshop === w;
              return (
                <Pressable key={w} onPress={() => setWorkshop(selected ? null : w)} style={[styles.chip, selected && styles.chipSelected]}>
                  <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{w}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>DIVISION</Text>
          <View style={styles.chipRow}>
            {DIVISIONS.map((d) => {
              const selected = division === d;
              return (
                <Pressable key={d} onPress={() => setDivision(selected ? null : d)} style={[styles.chip, selected && styles.chipSelected]}>
                  <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{d}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>DATE</Text>
          <TextInput
            style={styles.input}
            value={dateStr}
            onChangeText={setDateStr}
            placeholder="YYYY-MM-DD"
            placeholderTextColor="#5C6670"
            autoCapitalize="none"
          />
        </View>

        {fetchError && (
          <View style={styles.errorBox}>
            <Ionicons name="alert-circle" size={16} color="#D64545" />
            <Text style={styles.errorText}>{fetchError}</Text>
          </View>
        )}

        <Pressable
          style={({ pressed }) => [styles.fetchButton, (fetching || pressed) && styles.fetchButtonPressed]}
          onPress={handleFetch}
          disabled={fetching}
        >
          {fetching ? <ActivityIndicator color="#14181C" /> : <Text style={styles.fetchButtonText}>Fetch</Text>}
        </Pressable>

        {result && (
          <>
            <View style={styles.divider} />

            {result.manPowerActual === 0 ? (
              <View style={styles.warnBox}>
                <Ionicons name="alert-circle" size={16} color="#F2A93B" />
                <Text style={styles.warnText}>
                  No "Present" attendance found for {division} on {dateStr}. Submit attendance first — PCS Man Hour can't be calculated without a headcount.
                </Text>
              </View>
            ) : (
              <View style={styles.headline}>
                <Text style={styles.headlineValue}>{result.pcsManHour}</Text>
                <Text style={styles.headlineLabel}>PCS MAN HOUR</Text>
              </View>
            )}

            <View style={styles.statGrid}>
              <View style={styles.statCard}>
                <Text style={[styles.statValue, { color: '#3E7CB1' }]}>{result.actual}</Text>
                <Text style={styles.statLabel}>Actual</Text>
              </View>
              <View style={styles.statCard}>
                <Text style={[styles.statValue, { color: '#8A96A3' }]}>{result.manPowerTarget}</Text>
                <Text style={styles.statLabel}>Man Power (Target)</Text>
              </View>
              <View style={styles.statCard}>
                <Text style={[styles.statValue, { color: '#4C9A6A' }]}>{result.manPowerActual}</Text>
                <Text style={styles.statLabel}>Man Power (Actual)</Text>
              </View>
              <View style={styles.statCard}>
                <Text style={[styles.statValue, { color: '#F2A93B' }]}>{result.otHours}h</Text>
                <Text style={styles.statLabel}>OT</Text>
              </View>
              <View style={styles.statCard}>
                <Text style={[styles.statValue, { color: '#3E7CB1' }]}>{result.manHour}</Text>
                <Text style={styles.statLabel}>Man Hour</Text>
              </View>
              <View style={styles.statCard}>
                <Text style={[styles.statValue, { color: '#F2A93B' }]}>{result.pcsManHour}</Text>
                <Text style={styles.statLabel}>PCS Man Hour</Text>
              </View>
            </View>

            <Pressable
              style={({ pressed }) => [styles.pushButton, (pushing || pressed) && styles.fetchButtonPressed]}
              onPress={handleSubmit}
              disabled={pushing}
            >
              {pushing
                ? <ActivityIndicator color="#14181C" />
                : <><Ionicons name="cloud-upload-outline" size={18} color="#14181C" /><Text style={styles.pushButtonText}>Submit</Text></>
              }
            </Pressable>
            <Text style={styles.pushHint}>Saves this result so KPI Analysis can show it in the PCS Man Per Hour report.</Text>

            <Text style={[styles.fieldLabel, { marginTop: 18, marginBottom: 8 }]}>BY LINE ({result.lines.length})</Text>
            {result.lines.length === 0 ? (
              <Text style={styles.muted}>No production records found for {division} on {dateStr}.</Text>
            ) : (
              result.lines.map((l) => (
                <View key={l.lineId} style={styles.lineCard}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.lineCardTitle}>{l.lineName}</Text>
                    <Text style={styles.lineCardMeta}>
                      Shift {l.shift ?? '—'} · {l.hours}h{l.otHours > 0 ? ` (${l.otHours}h OT)` : ''}
                      {l.lastSlotLabel ? ` · last slot: ${l.lastSlotLabel}` : ''}
                    </Text>
                  </View>
                  <Text style={styles.lineCardStat}>{l.production} pcs</Text>
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

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#14181C' },
  scroll: { flexGrow: 1, paddingHorizontal: 20, paddingTop: 12, paddingBottom: 48 },
  backButton: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 12 },
  backText: { color: '#8A96A3', fontSize: 15 },
  title: { color: '#ECEFF2', fontSize: 23, fontWeight: '800' },
  subtitle: { color: '#8A96A3', fontSize: 13, marginTop: 4, marginBottom: 20, lineHeight: 18 },

  field: { marginBottom: 14 },
  label: { color: '#8A96A3', fontSize: 11, fontWeight: '700', letterSpacing: 0.6, marginBottom: 8 },
  fieldLabel: { color: '#8A96A3', fontSize: 11, fontWeight: '700', letterSpacing: 0.8 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  chip: {
    borderWidth: 1, borderColor: '#2C343C', backgroundColor: '#1D2329',
    borderRadius: 20, paddingHorizontal: 16, paddingVertical: 10,
  },
  chipSelected: { borderColor: '#F2A93B', backgroundColor: '#F2A93B22' },
  chipText: { color: '#8A96A3', fontSize: 13.5, fontWeight: '600' },
  chipTextSelected: { color: '#F2A93B' },

  input: {
    backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C',
    borderRadius: 10, paddingHorizontal: 14, height: 50, color: '#ECEFF2', fontSize: 15,
  },

  errorBox: {
    flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#D6454522',
    borderWidth: 1, borderColor: '#D64545', borderRadius: 10, padding: 12, marginBottom: 14,
  },
  errorText: { color: '#F0A8A8', fontSize: 13, flex: 1 },

  warnBox: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 8, backgroundColor: '#F2A93B18',
    borderWidth: 1, borderColor: '#F2A93B55', borderRadius: 10, padding: 12, marginBottom: 16,
  },
  warnText: { color: '#F2A93B', fontSize: 12.5, flex: 1, lineHeight: 17 },

  fetchButton: { height: 54, borderRadius: 12, backgroundColor: '#F2A93B', alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  fetchButtonPressed: { opacity: 0.85 },
  fetchButtonText: { color: '#14181C', fontSize: 15, fontWeight: '900' },

  pushButton: {
    height: 50, borderRadius: 12, backgroundColor: '#4C9A6A', alignItems: 'center', justifyContent: 'center',
    flexDirection: 'row', gap: 8, marginTop: 14,
  },
  pushButtonText: { color: '#14181C', fontSize: 14.5, fontWeight: '900' },
  pushHint: { color: '#5C6670', fontSize: 11.5, textAlign: 'center', marginTop: 8, lineHeight: 16 },

  divider: { height: 1, backgroundColor: '#2C343C', marginVertical: 22 },

  headline: { alignItems: 'center', marginBottom: 20 },
  headlineValue: { color: '#F2A93B', fontSize: 44, fontWeight: '900' },
  headlineLabel: { color: '#8A96A3', fontSize: 12.5, fontWeight: '700', letterSpacing: 1, marginTop: 2 },

  statGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  statCard: {
    flexGrow: 1, minWidth: '28%', backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C',
    borderRadius: 10, paddingVertical: 14, alignItems: 'center', gap: 4,
  },
  statValue: { color: '#ECEFF2', fontSize: 18, fontWeight: '800' },
  statLabel: { color: '#8A96A3', fontSize: 11, fontWeight: '700', textAlign: 'center' },

  muted: { color: '#8A96A3', fontSize: 12 },
  lineCard: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C',
    borderRadius: 10, padding: 12, marginBottom: 8,
  },
  lineCardTitle: { color: '#ECEFF2', fontSize: 14, fontWeight: '700' },
  lineCardMeta: { color: '#8A96A3', fontSize: 11.5, marginTop: 2 },
  lineCardStat: { color: '#3E7CB1', fontSize: 15, fontWeight: '800' },
});