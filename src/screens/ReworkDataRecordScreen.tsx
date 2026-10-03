// src/screens/ReworkDataRecordScreen.tsx
//
// Rework Data Record:
//   1. Admin picks Plant / Workshop / Division + Line + Shift + a single date.
//   2. "Fetch Production" pulls that line's ACTUAL total output for that
//      day/shift from `productionRecords` — same approach as
//      PlanVsActualRecordScreen: the highest `cumulativeParts` value seen
//      (the running total as of the last slot filled), reconciled against
//      `shiftSummaries` if that session has since been finalized.
//   3. Admin types in the Rework Count for that line/day. Rework % is
//      computed live (Rework / Total Production × 100).
//   4. "Save Rework Record" writes to a new `reworkRecords` collection.
//      Recent Records list below shows what's already been saved.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
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
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import {
  collection,
  addDoc,
  getDocs,
  getDoc,
  doc,
  query,
  where,
  orderBy,
  limit,
  serverTimestamp,
  Timestamp,
} from 'firebase/firestore';
import { db } from '../services/firebase';
import { useAuthStore } from '../stores/authStore';
import { PLANTS, WORKSHOPS, DIVISIONS } from '../constants/lineOptions';

const SHIFTS: Array<'A' | 'B'> = ['A', 'B'];

// Division only applies under the Assembly workshop for now, same rule as
// PlanVsActualRecordScreen - matched by substring so it keeps working even
// if the exact label changes (e.g. "Assembly" vs "Assembly Shop").
function isAssemblyWorkshop(w: string | null) {
  return !!w && w.toLowerCase().includes('assembly');
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface ProductionLine {
  id: string;
  plant: string | null;
  workshop: string | null;
  division: string | null;
  lineName: string;
}

interface ProductionRecordDoc {
  plant: string | null;
  workshop: string | null;
  division: string | null;
  shift: string | null;
  lineId: string | null;
  lineName: string | null;
  cumulativeParts: number | null;
  createdAtMs: number | null;
}

interface SavedReworkRecord {
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

function normalizeStr(s: string | null | undefined) {
  return (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}
function looseMatch(record: string | null | undefined, filter: string | null | undefined) {
  const a = normalizeStr(record);
  const b = normalizeStr(filter);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

function round1(n: number) {
  return Math.round(n * 10) / 10;
}

function ChipSelector({
  label,
  options,
  value,
  onChange,
  emptyHint,
}: {
  label: string;
  options: string[];
  value: string | null;
  onChange: (v: string) => void;
  emptyHint?: string;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      {options.length === 0 && emptyHint ? (
        <Text style={styles.hintText}>{emptyHint}</Text>
      ) : (
        <View style={styles.chipRow}>
          {options.map((opt) => {
            const selected = value === opt;
            return (
              <Pressable key={opt} onPress={() => onChange(opt)} style={[styles.chip, selected && styles.chipSelected]}>
                <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{opt}</Text>
              </Pressable>
            );
          })}
        </View>
      )}
    </View>
  );
}

export default function ReworkDataRecordScreen() {
  const navigation = useNavigation<any>();
  const user = useAuthStore((s) => s.user);

  // ── Filters
  const [plant, setPlant] = useState<string | null>(null);
  const [workshop, setWorkshop] = useState<string | null>(null);
  const [division, setDivision] = useState<string | null>(null);
  const [shift, setShift] = useState<'A' | 'B' | null>(null);
  const [dateStr, setDateStr] = useState(todayStr());

  // ── Registered lines (for the Line selector)
  const [allLines, setAllLines] = useState<ProductionLine[]>([]);
  const [loadingLines, setLoadingLines] = useState(true);
  const [selectedLineId, setSelectedLineId] = useState<string | null>(null);

  // ── Fetched production total for the selected line/date/shift
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [hasFetched, setHasFetched] = useState(false);
  const [totalProduction, setTotalProduction] = useState(0);

  // ── Rework count typed in by the admin
  const [reworkCountRaw, setReworkCountRaw] = useState('');

  // ── Save
  const [saving, setSaving] = useState(false);

  // ── Recent records
  const [records, setRecords] = useState<SavedReworkRecord[]>([]);
  const [loadingRecords, setLoadingRecords] = useState(true);
  const [recordsError, setRecordsError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setLoadingLines(true);
      try {
        const snap = await getDocs(collection(db, 'productionLines'));
        setAllLines(
          snap.docs.map((d) => {
            const data: any = d.data();
            return {
              id: d.id,
              plant: data.plant ?? null,
              workshop: data.workshop ?? null,
              division: data.division ?? null,
              lineName: data.lineName ?? 'Unnamed line',
            };
          })
        );
      } catch (e) {
        console.error('[ReworkData] failed to load lines:', e);
      } finally {
        setLoadingLines(false);
      }
    })();
  }, []);

  const availableLines = useMemo(() => {
    if (!plant || !workshop) return [];
    if (isAssemblyWorkshop(workshop) && !division) return [];
    return allLines.filter(
      (l) =>
        looseMatch(l.plant, plant) &&
        looseMatch(l.workshop, workshop) &&
        (!isAssemblyWorkshop(workshop) || looseMatch(l.division, division))
    );
  }, [allLines, plant, workshop, division]);

  const selectedLine = allLines.find((l) => l.id === selectedLineId) ?? null;

  // Reset downstream selections whenever an upstream filter changes
  useEffect(() => {
    setSelectedLineId(null);
    setHasFetched(false);
  }, [plant, workshop, division]);

  useEffect(() => {
    setHasFetched(false);
  }, [selectedLineId, shift, dateStr]);

  const fetchRecords = useCallback(async () => {
    setRecordsError(null);
    try {
      const q = query(collection(db, 'reworkRecords'), orderBy('createdAt', 'desc'), limit(50));
      const snap = await getDocs(q);
      setRecords(
        snap.docs.map((d) => {
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
      );
    } catch (e: any) {
      console.error('[ReworkData] fetch records failed:', e.code, e.message);
      setRecordsError('Could not load recent records. Check your connection.');
    } finally {
      setLoadingRecords(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      fetchRecords();
    }, [fetchRecords])
  );

  // ─────────────────────────────────────────────────────────────────────────
  // FETCH PRODUCTION — total actual output for the selected line/date/shift
  // ─────────────────────────────────────────────────────────────────────────

  const handleFetchProduction = async () => {
    if (!plant) { Alert.alert('Select a plant', 'Choose a plant first.'); return; }
    if (!workshop) { Alert.alert('Select a workshop', 'Choose a workshop first.'); return; }
    if (isAssemblyWorkshop(workshop) && !division) { Alert.alert('Select a division', 'Choose a division first.'); return; }
    if (!selectedLineId) { Alert.alert('Select a line', 'Choose a line first.'); return; }
    if (!shift) { Alert.alert('Select a shift', 'Choose a shift first.'); return; }
    if (!isValidDateStr(dateStr)) { Alert.alert('Invalid date', 'Enter the date as YYYY-MM-DD.'); return; }

    setFetching(true);
    setFetchError(null);
    try {
      const fromTs = Timestamp.fromDate(new Date(`${dateStr}T00:00:00`));
      const toTs = Timestamp.fromDate(new Date(`${dateStr}T23:59:59.999`));
      const q = query(
        collection(db, 'productionRecords'),
        where('createdAt', '>=', fromTs),
        where('createdAt', '<=', toTs),
        orderBy('createdAt', 'asc')
      );
      const snap = await getDocs(q);

      const all: ProductionRecordDoc[] = snap.docs.map((d) => {
        const data: any = d.data();
        return {
          plant: data.plant ?? null,
          workshop: data.workshop ?? null,
          division: data.division ?? null,
          shift: data.shift ?? null,
          lineId: data.lineId ?? null,
          lineName: data.lineName ?? null,
          cumulativeParts: data.cumulativeParts ?? null,
          createdAtMs: data.createdAt?.toMillis ? data.createdAt.toMillis() : null,
        };
      });

      // Highest cumulativeParts seen for this exact line + shift that day -
      // cumulativeParts is already a running total, so the max value is the
      // actual total as of whichever slot was filled last. Summing would
      // double-count.
      let actual = 0;
      all.forEach((r) => {
        if (r.lineId !== selectedLineId || r.shift !== shift) return;
        const cum = r.cumulativeParts ?? 0;
        if (cum > actual) actual = cum;
      });

      // Reconcile with shiftSummaries - the authoritative total written once
      // a session is finalized (manual "Finalize & End" or the 6:30 AM
      // auto-submit), same reconciliation PlanVsActualRecordScreen does.
      try {
        const summarySnap = await getDoc(doc(db, 'shiftSummaries', `${selectedLineId}_${dateStr}_${shift}`));
        if (summarySnap.exists()) {
          const total = (summarySnap.data() as any)?.actualProductionTotal ?? (summarySnap.data() as any)?.cumulativeParts;
          if (typeof total === 'number' && total > actual) actual = total;
        }
      } catch (e) {
        console.error('[ReworkData] shiftSummaries lookup failed:', e);
      }

      setTotalProduction(actual);
      setHasFetched(true);
    } catch (e: any) {
      console.error('[ReworkData] fetch production failed:', e.code, e.message);
      setFetchError('Could not load production data. Check your connection and try again.');
    } finally {
      setFetching(false);
    }
  };

  const reworkCount = Math.max(0, Math.floor(Number(reworkCountRaw) || 0));
  const reworkPct = totalProduction > 0 ? round1((reworkCount / totalProduction) * 100) : 0;

  // ─────────────────────────────────────────────────────────────────────────
  // SAVE
  // ─────────────────────────────────────────────────────────────────────────

  const handleSave = async () => {
    if (!hasFetched || !selectedLine) {
      Alert.alert('Fetch production first', 'Tap "Fetch Production" before saving.');
      return;
    }
    setSaving(true);
    try {
      await addDoc(collection(db, 'reworkRecords'), {
        date: dateStr,
        plant,
        workshop,
        division: isAssemblyWorkshop(workshop) ? division : null,
        shift,
        lineId: selectedLineId,
        lineName: selectedLine.lineName,
        totalProduction,
        reworkCount,
        reworkPct,
        submittedBy: user?.name || user?.email || 'Unknown',
        submittedByUid: user?.uid ?? null,
        createdAt: serverTimestamp(),
      });
      Alert.alert('Saved', `Rework record for ${selectedLine.lineName} saved.`);
      setReworkCountRaw('');
      setHasFetched(false);
      fetchRecords();
    } catch (e: any) {
      console.error('[ReworkData] save failed:', e.code, e.message);
      Alert.alert('Error', 'Could not save this record. Check your connection and try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <Pressable onPress={() => navigation.goBack()} style={styles.backButton} hitSlop={12}>
            <Ionicons name="arrow-back" size={22} color="#8A96A3" />
            <Text style={styles.backText}>Back</Text>
          </Pressable>

          <Text style={styles.title}>Rework Data Record</Text>
          <Text style={styles.subtitle}>
            Fetch a line's total production for a day, then log how many parts needed rework.
          </Text>

          <Text style={styles.sectionLabel}>LOCATION</Text>
          <ChipSelector label="PLANT" options={PLANTS} value={plant} onChange={setPlant} />
          <ChipSelector label="WORKSHOP" options={WORKSHOPS} value={workshop} onChange={setWorkshop} />
          {isAssemblyWorkshop(workshop) && (
            <ChipSelector label="DIVISION" options={DIVISIONS} value={division} onChange={setDivision} />
          )}

          <ChipSelector
            label="LINE"
            options={availableLines.map((l) => l.lineName)}
            value={selectedLine?.lineName ?? null}
            onChange={(name) => {
              const match = availableLines.find((l) => l.lineName === name);
              setSelectedLineId(match?.id ?? null);
            }}
            emptyHint={
              loadingLines
                ? 'Loading lines…'
                : !plant || !workshop || (isAssemblyWorkshop(workshop) && !division)
                ? 'Select Plant, Workshop, and Division above to see lines.'
                : 'No lines registered for this combination.'
            }
          />

          <Text style={[styles.sectionLabel, { marginTop: 4 }]}>SHIFT & DATE</Text>
          <ChipSelector label="SHIFT" options={SHIFTS} value={shift} onChange={(v) => setShift(v as 'A' | 'B')} />

          <View style={styles.field}>
            <Text style={styles.label}>DATE</Text>
            <TextInput
              style={styles.input}
              value={dateStr}
              onChangeText={setDateStr}
              placeholder="YYYY-MM-DD"
              placeholderTextColor="#5C6670"
            />
          </View>

          <Pressable
            style={({ pressed }) => [styles.fetchButton, (fetching || pressed) && styles.fetchButtonPressed]}
            onPress={handleFetchProduction}
            disabled={fetching}
          >
            {fetching ? (
              <ActivityIndicator color="#14181C" />
            ) : (
              <>
                <Ionicons name="cloud-download-outline" size={18} color="#14181C" />
                <Text style={styles.fetchButtonText}>Fetch Production</Text>
              </>
            )}
          </Pressable>

          {fetchError && (
            <View style={styles.errorBox}>
              <Ionicons name="alert-circle" size={16} color="#D64545" />
              <Text style={styles.errorText}>{fetchError}</Text>
            </View>
          )}

          {hasFetched && !fetchError && (
            <>
              <View style={styles.divider} />
              <Text style={styles.sectionLabel}>
                REWORK — {selectedLine?.lineName} · {dateStr} · SHIFT {shift}
              </Text>

              <View style={styles.totalCard}>
                <Text style={styles.totalLabel}>TOTAL PRODUCTION</Text>
                <Text style={styles.totalValue}>{totalProduction}</Text>
              </View>

              <View style={styles.field}>
                <Text style={styles.label}>REWORK COUNT</Text>
                <TextInput
                  style={styles.input}
                  value={reworkCountRaw}
                  onChangeText={(t) => setReworkCountRaw(t.replace(/[^0-9]/g, ''))}
                  placeholder="0"
                  placeholderTextColor="#5C6670"
                  keyboardType="number-pad"
                />
              </View>

              <View style={styles.pctCard}>
                <Text style={styles.pctLabel}>REWORK %</Text>
                <Text
                  style={[
                    styles.pctValue,
                    { color: reworkPct <= 2 ? '#4C9A6A' : reworkPct <= 5 ? '#F2A93B' : '#D64545' },
                  ]}
                >
                  {reworkPct}%
                </Text>
              </View>

              <Pressable
                style={({ pressed }) => [styles.submitButton, (saving || pressed) && styles.submitButtonPressed]}
                onPress={handleSave}
                disabled={saving}
              >
                {saving ? <ActivityIndicator color="#14181C" /> : <Text style={styles.submitText}>Save Rework Record</Text>}
              </Pressable>
            </>
          )}

          <View style={styles.divider} />
          <Text style={styles.sectionLabel}>RECENT RECORDS</Text>

          {loadingRecords ? (
            <ActivityIndicator color="#F2A93B" style={{ marginVertical: 20 }} />
          ) : recordsError ? (
            <Text style={styles.recordsError}>{recordsError}</Text>
          ) : records.length === 0 ? (
            <Text style={styles.emptyText}>No records yet.</Text>
          ) : (
            records.map((r) => (
              <View key={r.id} style={styles.recordCard}>
                <View style={styles.recordTopRow}>
                  <Text style={styles.recordTitle}>{r.lineName || 'Unnamed line'}</Text>
                  <Text
                    style={[
                      styles.recordPct,
                      { color: r.reworkPct <= 2 ? '#4C9A6A' : r.reworkPct <= 5 ? '#F2A93B' : '#D64545' },
                    ]}
                  >
                    {r.reworkPct}%
                  </Text>
                </View>
                <Text style={styles.recordMeta}>
                  {[r.plant, r.workshop, r.division, r.shift ? `Shift ${r.shift}` : null].filter(Boolean).join(' · ')}
                  {r.date ? ` · ${r.date}` : ''}
                </Text>
                <View style={styles.recordStatsRow}>
                  <Text style={styles.recordStat}>Total: <Text style={styles.recordStatVal}>{r.totalProduction}</Text></Text>
                  <Text style={styles.recordStat}>Rework: <Text style={styles.recordStatVal}>{r.reworkCount}</Text></Text>
                </View>
                {!!r.submittedBy && <Text style={styles.recordSubmitter}>Logged by {r.submittedBy}</Text>}
              </View>
            ))
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#14181C' },
  scroll: { flexGrow: 1, paddingHorizontal: 20, paddingTop: 12, paddingBottom: 48 },
  backButton: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 20 },
  backText: { color: '#8A96A3', fontSize: 15 },
  title: { color: '#ECEFF2', fontSize: 22, fontWeight: '800' },
  subtitle: { color: '#8A96A3', fontSize: 13.5, marginTop: 4, marginBottom: 16, lineHeight: 18 },
  sectionLabel: { color: '#F2A93B', fontSize: 12, fontWeight: '800', letterSpacing: 1.2, marginBottom: 12 },
  field: { marginBottom: 16 },
  label: { color: '#8A96A3', fontSize: 11, letterSpacing: 1, marginBottom: 8, fontWeight: '700' },
  hintText: { color: '#5C6670', fontSize: 12.5 },
  input: {
    backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C', borderRadius: 10,
    paddingHorizontal: 14, height: 50, color: '#ECEFF2', fontSize: 15,
  },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  chip: {
    borderWidth: 1, borderColor: '#2C343C', backgroundColor: '#1D2329',
    borderRadius: 20, paddingHorizontal: 16, paddingVertical: 10,
  },
  chipSelected: { borderColor: '#F2A93B', backgroundColor: '#F2A93B22' },
  chipText: { color: '#8A96A3', fontSize: 13.5, fontWeight: '600' },
  chipTextSelected: { color: '#F2A93B' },
  divider: { height: 1, backgroundColor: '#2C343C', marginVertical: 20 },

  fetchButton: {
    height: 52, borderRadius: 12, backgroundColor: '#3E7CB1',
    alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8, marginTop: 4,
  },
  fetchButtonPressed: { opacity: 0.85 },
  fetchButtonText: { color: '#14181C', fontSize: 15, fontWeight: '800' },

  errorBox: {
    flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#D6454522',
    borderWidth: 1, borderColor: '#D64545', borderRadius: 10, padding: 12, marginTop: 14,
  },
  errorText: { color: '#F0A8A8', fontSize: 13, flex: 1 },
  emptyText: { color: '#5C6670', fontSize: 13.5 },

  totalCard: {
    backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C',
    borderRadius: 12, padding: 16, marginBottom: 16, alignItems: 'center',
  },
  totalLabel: { color: '#5C6670', fontSize: 10.5, fontWeight: '800', letterSpacing: 0.8, marginBottom: 6 },
  totalValue: { color: '#ECEFF2', fontSize: 28, fontWeight: '800' },

  pctCard: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C',
    borderRadius: 12, paddingHorizontal: 16, paddingVertical: 14, marginBottom: 16,
  },
  pctLabel: { color: '#8A96A3', fontSize: 12, fontWeight: '700', letterSpacing: 0.6 },
  pctValue: { fontSize: 20, fontWeight: '900' },

  submitButton: {
    height: 54, borderRadius: 12, backgroundColor: '#F2A93B',
    alignItems: 'center', justifyContent: 'center',
  },
  submitButtonPressed: { opacity: 0.85 },
  submitText: { color: '#14181C', fontSize: 15.5, fontWeight: '800' },

  recordsError: { color: '#F0A8A8', fontSize: 13 },
  recordCard: {
    backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C',
    borderRadius: 12, padding: 14, marginBottom: 12,
  },
  recordTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  recordTitle: { color: '#ECEFF2', fontSize: 14.5, fontWeight: '700', flex: 1, marginRight: 8 },
  recordPct: { fontSize: 15, fontWeight: '900' },
  recordMeta: { color: '#8A96A3', fontSize: 12, marginBottom: 10 },
  recordStatsRow: { flexDirection: 'row', gap: 16, marginBottom: 6 },
  recordStat: { color: '#5C6670', fontSize: 12 },
  recordStatVal: { color: '#ECEFF2', fontWeight: '700' },
  recordSubmitter: { color: '#5C6670', fontSize: 11, marginTop: 4 },
});