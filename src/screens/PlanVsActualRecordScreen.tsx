// src/screens/PlanVsActualRecordScreen.tsx
//
// Step 1 of the Plan vs Actual workflow:
//   1. Admin picks Plant / Workshop / Division + Shift + a single date.
//   2. "Fetch Production Data" pulls that day's ACTUAL output per line from
//      the `productionRecords` collection (written by RecordProductionScreen)
//      — every matching doc is an INDEPENDENT slot (or before/after
//      changeover segment) record, not a running cumulative total, and
//      there's no more "one record = one hour" assumption. Actual is the
//      SUM of `producedThisSlot` across every matching record for that line
//      + productionDate + shift — split slots and changeover segments are
//      ordinary records and are all included; nothing is deduplicated down
//      to a "last" or "highest" record.
//   3. For every line that produced that day, the admin types in the
//      PLANNED quantity. Loss (Planned − Actual, floored at 0) and
//      Production % (Actual / Planned × 100) are computed live as they type.
//      Planned is pre-filled from `shiftSummaries.plannedProductionTotal`
//      when that finalized total exists for the line + productionDate +
//      shift; otherwise it falls back to the live sum of `expectedParts`
//      across the same matching productionRecords used for Actual.
//   4. "Save Plan vs Actual" writes one record per line to a new
//      `planVsActualRecords` collection, and a Recent Records list below
//      shows what's already been saved — same record-screen pattern as
//      PokaYokeRecordScreen / NearMissReportScreen.
//
// This is the first screen in the flow — later steps (e.g. a trend report
// across days) can build on top of `planVsActualRecords`.

import React, { useCallback, useMemo, useState } from 'react';
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
} from 'firebase/firestore';
import { db } from '../services/firebase';
import { useAuthStore } from '../stores/authStore';
import { PLANTS, WORKSHOPS, DIVISIONS } from '../constants/lineOptions';

const SHIFTS: Array<'A' | 'B'> = ['A', 'B'];

// Division only applies under the Assembly workshop for now (that's the only
// one with divisions entered in lineOptions.ts). Matched by substring rather
// than an exact hardcoded string so this keeps working even if the exact
// label changes (e.g. "Assembly" vs "Assembly Shop").
function isAssemblyWorkshop(w: string | null) {
  return !!w && w.toLowerCase().includes('assembly');
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface ProductionRecordDoc {
  plant: string | null;
  workshop: string | null;
  division: string | null;
  shift: string | null;
  productionDate: string | null;
  lineId: string | null;
  lineName: string | null;
  // This slot/segment's actual output — see RecordProductionScreen. Every
  // matching doc is independent and additive; there is no running total.
  producedThisSlot: number | null;
  // This slot/segment's own target slice (cycle time × that slot's full
  // designed time, ignoring stops) — additive across slots, used as the
  // live fallback for Planned before a shift is finalized.
  expectedParts: number | null;
  createdAtMs: number | null;
}

interface ActualRow {
  lineId: string;
  lineName: string;
  actual: number;
  plannedFetched: number;
}

interface SavedPlanRecord {
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
// Loose match tolerates minor naming differences between filter chips and
// whatever a record actually has saved (e.g. legacy "Assembly" vs "Assembly Shop").
function looseMatch(record: string | null | undefined, filter: string | null | undefined) {
  const a = normalizeStr(record);
  const b = normalizeStr(filter);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

function round1(n: number) {
  return Math.round(n * 10) / 10;
}

export default function PlanVsActualRecordScreen() {
  const navigation = useNavigation<any>();
  const user = useAuthStore((s) => s.user);

  // ── Filters
  const [plant, setPlant] = useState<string | null>(null);
  const [workshop, setWorkshop] = useState<string | null>(null);
  const [division, setDivision] = useState<string | null>(null);
  const [shift, setShift] = useState<'A' | 'B' | null>(null);
  const [dateStr, setDateStr] = useState(todayStr());

  // ── Fetched actuals for the selected date/filters
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [hasFetched, setHasFetched] = useState(false);
  const [actualRows, setActualRows] = useState<ActualRow[]>([]);

  // ── Planned quantity per line, typed in by the admin (lineId -> text)
  const [plannedByLine, setPlannedByLine] = useState<Record<string, string>>({});

  // ── Save
  const [saving, setSaving] = useState(false);

  // ── Recent records
  const [records, setRecords] = useState<SavedPlanRecord[]>([]);
  const [loadingRecords, setLoadingRecords] = useState(true);
  const [recordsError, setRecordsError] = useState<string | null>(null);

  const fetchRecords = useCallback(async () => {
    setRecordsError(null);
    try {
      const q = query(collection(db, 'planVsActualRecords'), orderBy('createdAt', 'desc'), limit(50));
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
            planned: data.planned ?? 0,
            actual: data.actual ?? 0,
            loss: data.loss ?? 0,
            productionPct: data.productionPct ?? 0,
            submittedBy: data.submittedBy ?? '',
            createdAtMs: data.createdAt?.toMillis ? data.createdAt.toMillis() : null,
          };
        })
      );
    } catch (e: any) {
      console.error('[PlanVsActual] fetch records failed:', e.code, e.message);
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

  // ─────────────────────────────────────────────────────────────────────────────
  // FETCH PRODUCTION DATA — actual output per line for the selected date
  // ─────────────────────────────────────────────────────────────────────────────

  const handleFetchProduction = async () => {
    if (!plant) { Alert.alert('Select a plant', 'Choose a plant first.'); return; }
    if (!workshop) { Alert.alert('Select a workshop', 'Choose a workshop first.'); return; }
    if (isAssemblyWorkshop(workshop) && !division) { Alert.alert('Select a division', 'Choose a division first.'); return; }
    if (!shift) { Alert.alert('Select a shift', 'Choose a shift first.'); return; }
    if (!isValidDateStr(dateStr)) { Alert.alert('Invalid date', 'Enter the date as YYYY-MM-DD.'); return; }

    setFetching(true);
    setFetchError(null);
    try {
      // Filter by productionDate — the shift's production-day key written by
      // RecordProductionScreen (handles Shift B rolling past midnight) —
      // rather than a createdAt timestamp range, which would misattribute a
      // late-night Shift B slot to the wrong calendar day.
      const q = query(collection(db, 'productionRecords'), where('productionDate', '==', dateStr));
      const snap = await getDocs(q);

      const all: ProductionRecordDoc[] = snap.docs.map((d) => {
        const data: any = d.data();
        return {
          plant: data.plant ?? null,
          workshop: data.workshop ?? null,
          division: data.division ?? null,
          shift: data.shift ?? null,
          productionDate: data.productionDate ?? null,
          lineId: data.lineId ?? null,
          lineName: data.lineName ?? null,
          producedThisSlot: data.producedThisSlot ?? null,
          expectedParts: data.expectedParts ?? null,
          createdAtMs: data.createdAt?.toMillis ? data.createdAt.toMillis() : null,
        };
      });

      const filtered = all.filter(
        (r) =>
          looseMatch(r.plant, plant) &&
          looseMatch(r.workshop, workshop) &&
          (!isAssemblyWorkshop(workshop) || looseMatch(r.division, division)) &&
          r.shift === shift
      );

      // ACTUAL: sum `producedThisSlot` across EVERY matching record for a
      // line + productionDate + shift. Each record — a slot, or a
      // before/after changeover segment — is an independent, additive
      // figure; there is no running/cumulative total to dedupe down to a
      // "last" or "highest" value anymore.
      //
      // PLANNED (fallback): sum `expectedParts` across the same matching
      // records — each slot's OWN target slice (cycle time × that slot's
      // full designed time, ignoring stops — see RecordProductionScreen),
      // so it's additive across slots the same way Actual is. This fallback
      // covers a session that's still in progress; once finalized, the
      // authoritative shiftSummaries total (below) takes over instead.
      const byLine = new Map<string, ActualRow>();
      filtered.forEach((r) => {
        // Group by line + productionDate + shift. productionDate and shift
        // are already pinned by the query/filter above, so folding them
        // into the key is defensive rather than load-bearing — but it keeps
        // this screen correct even if the fetch strategy above changes.
        const key = `${r.lineId ?? r.lineName ?? 'unknown'}_${r.productionDate ?? dateStr}_${r.shift ?? shift}`;
        const produced = r.producedThisSlot ?? 0;
        const expected = r.expectedParts ?? 0;
        const existing = byLine.get(key);
        if (!existing) {
          byLine.set(key, { lineId: r.lineId ?? r.lineName ?? 'unknown', lineName: r.lineName ?? 'Unknown line', actual: produced, plannedFetched: expected });
        } else {
          existing.actual += produced;
          existing.plannedFetched += expected;
        }
      });

      let rows = Array.from(byLine.values()).sort((a, b) => a.lineName.localeCompare(b.lineName));

      // Reconcile with shiftSummaries — the single authoritative total
      // RecordProductionScreen writes once a session is finalized (manual
      // "Finalize & End" or the 6:30 AM auto-submit). When it exists, it's
      // the source of truth (covers slots that may have been auto-submitted
      // without an individual productionRecords doc for every minute of the
      // shift); the summed fallback above only applies while a session is
      // still in progress and hasn't finalized yet.
      await Promise.all(
        rows.map(async (row) => {
          try {
            const snap = await getDoc(doc(db, 'shiftSummaries', `${row.lineId}_${dateStr}_${shift}`));
            if (snap.exists()) {
              const total = (snap.data() as any)?.plannedProductionTotal;
              if (typeof total === 'number') row.plannedFetched = total;
            }
          } catch (e) {
            console.error('[PlanVsActual] shiftSummaries lookup failed for', row.lineId, e);
          }
        })
      );
      setActualRows(rows);
      // Pre-fill Planned with the fetched target (shiftSummaries total, or
      // the live sum of expectedParts) for each line — the admin no longer
      // has to type this in by hand, though the field stays editable below
      // in case a manual override is needed.
      const fetchedPlanned: Record<string, string> = {};
      rows.forEach((row) => { fetchedPlanned[row.lineId] = String(row.plannedFetched); });
      setPlannedByLine(fetchedPlanned);
      setHasFetched(true);
    } catch (e: any) {
      console.error('[PlanVsActual] fetch production failed:', e.code, e.message);
      setFetchError('Could not load production data. Check your connection and try again.');
    } finally {
      setFetching(false);
    }
  };

  const rowsWithComputed = useMemo(() => {
    return actualRows.map((row) => {
      const plannedRaw = plannedByLine[row.lineId] ?? '';
      const planned = Math.max(0, Math.floor(Number(plannedRaw) || 0));
      const loss = Math.max(0, planned - row.actual);
      const productionPct = planned > 0 ? round1((row.actual / planned) * 100) : 0;
      return { ...row, plannedRaw, planned, loss, productionPct };
    });
  }, [actualRows, plannedByLine]);

  // ─────────────────────────────────────────────────────────────────────────────
  // SAVE — one record per line that has a planned quantity entered
  // ─────────────────────────────────────────────────────────────────────────────

  const handleSave = async () => {
    const toSave = rowsWithComputed.filter((r) => r.plannedRaw.trim() !== '' && r.planned > 0);
    if (toSave.length === 0) {
      Alert.alert('Nothing to save', 'Enter a planned quantity for at least one line.');
      return;
    }

    setSaving(true);
    try {
      for (const row of toSave) {
        await addDoc(collection(db, 'planVsActualRecords'), {
          date: dateStr,
          plant,
          workshop,
          division,
          shift,
          lineId: row.lineId,
          lineName: row.lineName,
          planned: row.planned,
          actual: row.actual,
          loss: row.loss,
          productionPct: row.productionPct,
          submittedBy: user?.name || user?.email || 'Unknown',
          submittedByUid: user?.uid ?? null,
          createdAt: serverTimestamp(),
        });
      }
      Alert.alert('Saved', `Plan vs Actual saved for ${toSave.length} line${toSave.length === 1 ? '' : 's'}.`);
      setPlannedByLine({});
      fetchRecords();
    } catch (e: any) {
      console.error('[PlanVsActual] save failed:', e.code, e.message);
      Alert.alert('Error', 'Could not save. Check your connection and try again.');
    } finally {
      setSaving(false);
    }
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <Pressable onPress={() => navigation.goBack()} style={styles.backButton} hitSlop={12}>
            <Ionicons name="arrow-back" size={22} color="#8A96A3" />
            <Text style={styles.backText}>Back</Text>
          </Pressable>

          <Text style={styles.title}>Plan vs Actual</Text>
          <Text style={styles.subtitle}>Pick a plant, workshop, division, shift and date, then fetch that day's production</Text>

          {/* FILTERS */}
          <Text style={styles.sectionLabel}>PLANT / WORKSHOP / DIVISION / SHIFT</Text>

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
                  <Pressable
                    key={w}
                    onPress={() => {
                      const next = selected ? null : w;
                      setWorkshop(next);
                      // Divisions are scoped to a workshop — drop a stale
                      // division pick from a different workshop.
                      if (!isAssemblyWorkshop(next)) setDivision(null);
                    }}
                    style={[styles.chip, selected && styles.chipSelected]}
                  >
                    <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{w}</Text>
                  </Pressable>
                );
              })}
            </View>
          </View>

          {isAssemblyWorkshop(workshop) && (
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
          )}

          <View style={styles.field}>
            <Text style={styles.label}>SHIFT</Text>
            <View style={styles.chipRow}>
              {SHIFTS.map((s) => {
                const selected = shift === s;
                return (
                  <Pressable key={s} onPress={() => setShift(selected ? null : s)} style={[styles.chip, selected && styles.chipSelected]}>
                    <Text style={[styles.chipText, selected && styles.chipTextSelected]}>Shift {s}</Text>
                  </Pressable>
                );
              })}
            </View>
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>DATE</Text>
            <TextInput style={styles.input} value={dateStr} onChangeText={setDateStr} placeholder="YYYY-MM-DD" placeholderTextColor="#5C6670" autoCapitalize="none" />
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
                <Ionicons name="cloud-download-outline" size={19} color="#14181C" />
                <Text style={styles.fetchButtonText}>Fetch Production Data</Text>
              </>
            )}
          </Pressable>

          {fetchError && (
            <View style={styles.errorBox}>
              <Ionicons name="alert-circle" size={16} color="#D64545" />
              <Text style={styles.errorText}>{fetchError}</Text>
            </View>
          )}

          {/* TABLE */}
          {hasFetched && !fetchError && (
            <>
              <View style={styles.divider} />
              <Text style={styles.sectionLabel}>PLAN VS ACTUAL — {dateStr} · SHIFT {shift}</Text>
              <Text style={styles.plannedHint}>Planned is fetched from the shift's saved total once finalized (or summed live from each slot while still in progress) — edit if it needs adjusting.</Text>

              {rowsWithComputed.length === 0 ? (
                <Text style={styles.emptyText}>No production recorded for this plant/workshop/division/shift on this date.</Text>
              ) : (
                <>
                  <View style={styles.tableHeaderRow}>
                    <Text style={[styles.tableHeaderCell, { flex: 1.5 }]}>LINE</Text>
                    <Text style={[styles.tableHeaderCell, styles.tableCellCenter]}>PLANNED</Text>
                    <Text style={[styles.tableHeaderCell, styles.tableCellCenter]}>ACTUAL</Text>
                    <Text style={[styles.tableHeaderCell, styles.tableCellCenter]}>LOSS</Text>
                    <Text style={[styles.tableHeaderCell, styles.tableCellCenter]}>%</Text>
                  </View>

                  {rowsWithComputed.map((row) => (
                    <View key={row.lineId} style={styles.tableRow}>
                      <Text style={[styles.tableCell, { flex: 1.5, fontWeight: '700', color: '#ECEFF2' }]} numberOfLines={2}>
                        {row.lineName}
                      </Text>
                      <TextInput
                        style={styles.plannedInput}
                        value={plannedByLine[row.lineId] ?? ''}
                        onChangeText={(t) => setPlannedByLine((prev) => ({ ...prev, [row.lineId]: t.replace(/[^0-9]/g, '') }))}
                        placeholder="0"
                        placeholderTextColor="#5C6670"
                        keyboardType="number-pad"
                      />
                      <Text style={[styles.tableCell, styles.tableCellCenter]}>{row.actual}</Text>
                      <Text style={[styles.tableCell, styles.tableCellCenter, { color: row.loss > 0 ? '#D64545' : '#8A96A3' }]}>{row.loss}</Text>
                      <Text
                        style={[
                          styles.tableCell,
                          styles.tableCellCenter,
                          { fontWeight: '800', color: row.planned === 0 ? '#5C6670' : row.productionPct >= 90 ? '#4C9A6A' : row.productionPct >= 70 ? '#F2A93B' : '#D64545' },
                        ]}
                      >
                        {row.planned > 0 ? `${row.productionPct}%` : '—'}
                      </Text>
                    </View>
                  ))}

                  <Pressable
                    style={({ pressed }) => [styles.submitButton, (saving || pressed) && styles.submitButtonPressed]}
                    onPress={handleSave}
                    disabled={saving}
                  >
                    {saving ? <ActivityIndicator color="#14181C" /> : <Text style={styles.submitText}>Save Plan vs Actual</Text>}
                  </Pressable>
                </>
              )}
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
                      { color: r.productionPct >= 90 ? '#4C9A6A' : r.productionPct >= 70 ? '#F2A93B' : '#D64545' },
                    ]}
                  >
                    {r.productionPct}%
                  </Text>
                </View>
                <Text style={styles.recordMeta}>
                  {[r.plant, r.workshop, r.division, r.shift ? `Shift ${r.shift}` : null].filter(Boolean).join(' · ')}{r.date ? ` · ${r.date}` : ''}
                </Text>
                <View style={styles.recordStatsRow}>
                  <Text style={styles.recordStat}>Planned: <Text style={styles.recordStatVal}>{r.planned}</Text></Text>
                  <Text style={styles.recordStat}>Actual: <Text style={styles.recordStatVal}>{r.actual}</Text></Text>
                  <Text style={styles.recordStat}>Loss: <Text style={[styles.recordStatVal, r.loss > 0 && { color: '#D64545' }]}>{r.loss}</Text></Text>
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
  plannedHint: { color: '#8A96A3', fontSize: 12, marginTop: -8, marginBottom: 12, lineHeight: 16 },
  field: { marginBottom: 16 },
  label: { color: '#8A96A3', fontSize: 11, letterSpacing: 1, marginBottom: 8, fontWeight: '700' },
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

  tableHeaderRow: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingBottom: 8,
    borderBottomWidth: 1, borderBottomColor: '#2C343C', marginBottom: 4,
  },
  tableHeaderCell: { flex: 1, color: '#5C6670', fontSize: 10, fontWeight: '800', letterSpacing: 0.6 },
  tableRow: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: '#1D2329',
    borderWidth: 1, borderColor: '#2C343C', borderRadius: 10,
    paddingHorizontal: 10, paddingVertical: 10, marginBottom: 8, gap: 4,
  },
  tableCell: { flex: 1, color: '#ECEFF2', fontSize: 13 },
  tableCellCenter: { textAlign: 'center' },
  plannedInput: {
    flex: 1, backgroundColor: '#14181C', borderWidth: 1, borderColor: '#2C343C',
    borderRadius: 8, height: 38, color: '#F2A93B', fontSize: 14, fontWeight: '700',
    textAlign: 'center', paddingHorizontal: 4,
  },

  submitButton: {
    height: 54, borderRadius: 12, backgroundColor: '#F2A93B',
    alignItems: 'center', justifyContent: 'center', marginTop: 8,
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