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
  getCountFromServer,
  query,
  orderBy,
  limit,
  serverTimestamp,
} from 'firebase/firestore';
import { db } from '../services/firebase';
import { useAuthStore } from '../stores/authStore';
import { PLANTS, WORKSHOPS, DIVISIONS } from '../constants/lineOptions';

type Status = 'Open' | 'In Progress' | 'Closed';

const STATUS_OPTIONS: Status[] = ['Open', 'In Progress', 'Closed'];

const STATUS_COLOR: Record<Status, string> = {
  Open: '#D64545',
  'In Progress': '#F2A93B',
  Closed: '#4C9A6A',
};

interface PokaYokeRecord {
  id: string;
  sNo: number | null;
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
  status: Status;
  submittedBy: string;
  createdAtMs: number | null;
}

interface Line {
  id: string;
  plant: string | null;
  workshop: string | null;
  division: string | null;
  lineName: string | null;
  lineNo: string | null;
  parts: { name: string }[];
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

function todayDisplay(): string {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yy = String(d.getFullYear());
  return `${dd}-${mm}-${yy}`;
}

export default function PokaYokeRecordScreen() {
  const navigation = useNavigation<any>();
  const user = useAuthStore((s) => s.user);

  // ── Form state
  const [sNo, setSNo] = useState<number | null>(null);
  const [loadingSNo, setLoadingSNo] = useState(true);

  // Line & Part — cascading selection: plant → workshop → division → line → part
  const [plant, setPlant] = useState<string | null>(null);
  const [workshop, setWorkshop] = useState<string | null>(null);
  const [division, setDivision] = useState<string | null>(null);
  const [allLines, setAllLines] = useState<Line[]>([]);
  const [loadingLines, setLoadingLines] = useState(true);
  const [selectedLineId, setSelectedLineId] = useState<string | null>(null);
  const [selectedPartIndex, setSelectedPartIndex] = useState<number | null>(null);
  const [model, setModel] = useState('');

  const [pokaYokeNo, setPokaYokeNo] = useState('');
  const [pokaYokeDetails, setPokaYokeDetails] = useState('');
  const [problem, setProblem] = useState('');
  const [rootCause, setRootCause] = useState('');
  const [actionPlan, setActionPlan] = useState('');
  const [responsibility, setResponsibility] = useState('');
  const [targetDate, setTargetDate] = useState('');
  const [status, setStatus] = useState<Status>('Open');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // ── Recent records
  const [records, setRecords] = useState<PokaYokeRecord[]>([]);
  const [loadingRecords, setLoadingRecords] = useState(true);
  const [recordsError, setRecordsError] = useState<string | null>(null);

  const refreshSNo = useCallback(async () => {
    setLoadingSNo(true);
    try {
      const snap = await getCountFromServer(collection(db, 'pokaYokeRecords'));
      setSNo(snap.data().count + 1);
    } catch (e) {
      console.error('[PokaYoke] S.No count failed:', e);
      setSNo(null);
    } finally {
      setLoadingSNo(false);
    }
  }, []);

  const fetchRecords = useCallback(async () => {
    setRecordsError(null);
    try {
      const q = query(collection(db, 'pokaYokeRecords'), orderBy('createdAt', 'desc'), limit(50));
      const snap = await getDocs(q);
      setRecords(
        snap.docs.map((d) => {
          const data: any = d.data();
          return {
            id: d.id,
            sNo: data.sNo ?? null,
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
      );
    } catch (e: any) {
      console.error('[PokaYoke] fetch failed:', e.code, e.message);
      setRecordsError('Could not load recent records. Check your connection.');
    } finally {
      setLoadingRecords(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      refreshSNo();
      fetchRecords();
    }, [refreshSNo, fetchRecords])
  );

  // Load every production line once; plant/workshop/division just narrow the
  // list client-side (same pattern used across the other report screens).
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const snap = await getDocs(collection(db, 'productionLines'));
        if (!mounted) return;
        setAllLines(
          snap.docs.map((d) => {
            const data: any = d.data();
            return {
              id: d.id,
              plant: data.plant ?? data.location ?? null,
              workshop: data.workshop ?? data.shop ?? null,
              division: data.division ?? data.unit ?? null,
              lineName: data.lineName ?? data.lineNumber ?? data.name ?? null,
              lineNo: data.lineNo ?? data.lineNumber ?? null,
              parts: Array.isArray(data.parts) ? data.parts : [],
            };
          })
        );
      } catch (e) {
        console.error('[PokaYoke] load lines failed:', e);
      } finally {
        if (mounted) setLoadingLines(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

  const filteredLines = useMemo(() => {
    return allLines.filter((l) => {
      if (plant && l.plant && !looseMatch(l.plant, plant)) return false;
      if (workshop && l.workshop && !looseMatch(l.workshop, workshop)) return false;
      if (division && l.division && !looseMatch(l.division, division)) return false;
      return true;
    });
  }, [allLines, plant, workshop, division]);

  // Clear the selected line if it falls outside the current plant/workshop/division
  useEffect(() => {
    if (selectedLineId && !filteredLines.some((l) => l.id === selectedLineId)) {
      setSelectedLineId(null);
      setSelectedPartIndex(null);
    }
  }, [filteredLines, selectedLineId]);

  const selectedLine = useMemo(
    () => allLines.find((l) => l.id === selectedLineId) ?? null,
    [allLines, selectedLineId]
  );
  const selectedPart = selectedPartIndex != null ? selectedLine?.parts?.[selectedPartIndex] ?? null : null;

  const resetForm = () => {
    setPlant(null);
    setWorkshop(null);
    setDivision(null);
    setSelectedLineId(null);
    setSelectedPartIndex(null);
    setModel('');
    setPokaYokeNo('');
    setPokaYokeDetails('');
    setProblem('');
    setRootCause('');
    setActionPlan('');
    setResponsibility('');
    setTargetDate('');
    setStatus('Open');
  };

  const validate = (): string | null => {
    if (!plant) return 'Select a plant.';
    if (!workshop) return 'Select a workshop.';
    if (!division) return 'Select a division.';
    if (!selectedLine) return 'Select a line.';
    if ((selectedLine.parts?.length ?? 0) > 0 && !selectedPart) return 'Select a part.';
    if (!pokaYokeNo.trim()) return 'Poka Yoke No. is required.';
    if (!problem.trim()) return 'Problem is required.';
    if (!responsibility.trim()) return 'Responsibility is required.';
    return null;
  };

  const handleSubmit = async () => {
    const err = validate();
    if (err) {
      setFormError(err);
      return;
    }
    setFormError(null);
    setSubmitting(true);
    try {
      await addDoc(collection(db, 'pokaYokeRecords'), {
        sNo: sNo ?? null,
        plant,
        workshop,
        division,
        lineId: selectedLine?.id ?? null,
        lineName: selectedLine?.lineName ?? '',
        lineNo: selectedLine?.lineNo ?? '',
        partsName: selectedPart?.name ?? '',
        model: model.trim(),
        pokaYokeNo: pokaYokeNo.trim(),
        pokaYokeDetails: pokaYokeDetails.trim(),
        problem: problem.trim(),
        rootCause: rootCause.trim(),
        actionPlan: actionPlan.trim(),
        responsibility: responsibility.trim(),
        targetDate: targetDate.trim() || todayDisplay(),
        status,
        submittedBy: user?.name || user?.email || 'Unknown',
        submittedByUid: user?.uid ?? null,
        createdAt: serverTimestamp(),
      });
      Alert.alert('Saved', `Poka Yoke record #${sNo ?? ''} saved.`);
      resetForm();
      refreshSNo();
      fetchRecords();
    } catch (e: any) {
      console.error('[PokaYoke] submit failed:', e.code, e.message);
      setFormError('Could not save this record. Check your connection and try again.');
    } finally {
      setSubmitting(false);
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

          <Text style={styles.title}>Poka Yoke Breakdown Record</Text>
          <Text style={styles.subtitle}>Log a mistake-proofing device issue and its corrective action</Text>

          <View style={styles.sNoBadge}>
            <Text style={styles.sNoLabel}>S.NO</Text>
            {loadingSNo ? (
              <ActivityIndicator size="small" color="#F2A93B" />
            ) : (
              <Text style={styles.sNoValue}>{sNo ?? '—'}</Text>
            )}
          </View>

          <Text style={styles.sectionLabel}>LINE & PART</Text>

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
            <Text style={styles.label}>LINE</Text>
            {loadingLines ? (
              <ActivityIndicator color="#F2A93B" style={{ alignSelf: 'flex-start' }} />
            ) : filteredLines.length === 0 ? (
              <Text style={styles.emptyText}>No lines match the plant/workshop/division above.</Text>
            ) : (
              <View style={styles.chipRow}>
                {filteredLines.map((l) => {
                  const selected = selectedLineId === l.id;
                  return (
                    <Pressable
                      key={l.id}
                      onPress={() => { setSelectedLineId(selected ? null : l.id); setSelectedPartIndex(null); }}
                      style={[styles.chip, selected && styles.chipSelected]}
                    >
                      <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{l.lineName ?? l.id}</Text>
                    </Pressable>
                  );
                })}
              </View>
            )}
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>PART</Text>
            {!selectedLine ? (
              <Text style={styles.emptyText}>Select a line first.</Text>
            ) : (selectedLine.parts?.length ?? 0) === 0 ? (
              <Text style={styles.emptyText}>This line has no parts configured.</Text>
            ) : (
              <View style={styles.chipRow}>
                {selectedLine.parts.map((p, idx) => {
                  const selected = selectedPartIndex === idx;
                  return (
                    <Pressable key={`${p.name}-${idx}`} onPress={() => setSelectedPartIndex(selected ? null : idx)} style={[styles.chip, selected && styles.chipSelected]}>
                      <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{p.name}</Text>
                    </Pressable>
                  );
                })}
              </View>
            )}
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>MODEL</Text>
            <TextInput style={styles.input} value={model} onChangeText={setModel} placeholder="e.g. Swift" placeholderTextColor="#5C6670" />
          </View>

          <View style={styles.divider} />
          <Text style={styles.sectionLabel}>POKA YOKE</Text>

          <View style={styles.field}>
            <Text style={styles.label}>POKA YOKE NO.</Text>
            <TextInput style={styles.input} value={pokaYokeNo} onChangeText={setPokaYokeNo} placeholder="e.g. PY-014" placeholderTextColor="#5C6670" />
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>POKA YOKE DETAILS</Text>
            <TextInput
              style={[styles.input, styles.textArea]}
              value={pokaYokeDetails}
              onChangeText={setPokaYokeDetails}
              placeholder="How the device works"
              placeholderTextColor="#5C6670"
              multiline
            />
          </View>

          <View style={styles.divider} />
          <Text style={styles.sectionLabel}>ISSUE & CORRECTIVE ACTION</Text>

          <View style={styles.field}>
            <Text style={styles.label}>PROBLEM</Text>
            <TextInput
              style={[styles.input, styles.textArea]}
              value={problem}
              onChangeText={setProblem}
              placeholder="Issue that existed before this Poka-Yoke"
              placeholderTextColor="#5C6670"
              multiline
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>ROOT CAUSE</Text>
            <TextInput
              style={[styles.input, styles.textArea]}
              value={rootCause}
              onChangeText={setRootCause}
              placeholder="Actual cause of the problem"
              placeholderTextColor="#5C6670"
              multiline
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>ACTION PLAN</Text>
            <TextInput
              style={[styles.input, styles.textArea]}
              value={actionPlan}
              onChangeText={setActionPlan}
              placeholder="Planned corrective / preventive action"
              placeholderTextColor="#5C6670"
              multiline
            />
          </View>

          <View style={styles.row}>
            <View style={[styles.field, { flex: 1, marginRight: 10 }]}>
              <Text style={styles.label}>RESPONSIBILITY</Text>
              <TextInput style={styles.input} value={responsibility} onChangeText={setResponsibility} placeholder="Person / department" placeholderTextColor="#5C6670" />
            </View>
            <View style={[styles.field, { flex: 1 }]}>
              <Text style={styles.label}>TARGET DATE</Text>
              <TextInput style={styles.input} value={targetDate} onChangeText={setTargetDate} placeholder="DD-MM-YYYY" placeholderTextColor="#5C6670" />
            </View>
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>STATUS</Text>
            <View style={styles.chipRow}>
              {STATUS_OPTIONS.map((s) => {
                const selected = status === s;
                return (
                  <Pressable
                    key={s}
                    onPress={() => setStatus(s)}
                    style={[
                      styles.chip,
                      selected && { borderColor: STATUS_COLOR[s], backgroundColor: STATUS_COLOR[s] + '22' },
                    ]}
                  >
                    <Text style={[styles.chipText, selected && { color: STATUS_COLOR[s] }]}>{s}</Text>
                  </Pressable>
                );
              })}
            </View>
          </View>

          {formError && (
            <View style={styles.errorBox}>
              <Ionicons name="alert-circle" size={16} color="#D64545" />
              <Text style={styles.errorText}>{formError}</Text>
            </View>
          )}

          <Pressable
            style={({ pressed }) => [styles.submitButton, (submitting || pressed) && styles.submitButtonPressed]}
            onPress={handleSubmit}
            disabled={submitting}
          >
            {submitting ? <ActivityIndicator color="#14181C" /> : <Text style={styles.submitText}>Save Record</Text>}
          </Pressable>

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
                  <Text style={styles.recordTitle}>
                    #{r.sNo ?? '—'} · {r.lineName || 'Unnamed line'}
                  </Text>
                  <View style={[styles.statusBadge, { borderColor: STATUS_COLOR[r.status], backgroundColor: STATUS_COLOR[r.status] + '22' }]}>
                    <Text style={[styles.statusText, { color: STATUS_COLOR[r.status] }]}>{r.status}</Text>
                  </View>
                </View>
                <Text style={styles.recordMeta}>
                  {[r.lineNo && `Line ${r.lineNo}`, r.partsName, r.model].filter(Boolean).join(' · ')}
                </Text>
                {!!r.pokaYokeNo && <Text style={styles.recordDetail}>Poka Yoke No: {r.pokaYokeNo}</Text>}
                {!!r.problem && <Text style={styles.recordDetail}>Problem: {r.problem}</Text>}
                {!!r.rootCause && <Text style={styles.recordDetail}>Root Cause: {r.rootCause}</Text>}
                {!!r.actionPlan && <Text style={styles.recordDetail}>Action Plan: {r.actionPlan}</Text>}
                <View style={styles.recordFooter}>
                  <Text style={styles.recordFooterText}>{r.responsibility || '—'}</Text>
                  <Text style={styles.recordFooterText}>Target: {r.targetDate || '—'}</Text>
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

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#14181C' },
  scroll: { flexGrow: 1, paddingHorizontal: 20, paddingTop: 12, paddingBottom: 48 },
  backButton: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 20 },
  backText: { color: '#8A96A3', fontSize: 15 },
  title: { color: '#ECEFF2', fontSize: 22, fontWeight: '800' },
  subtitle: { color: '#8A96A3', fontSize: 13.5, marginTop: 4, marginBottom: 16 },
  sNoBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C',
    borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, marginBottom: 20, alignSelf: 'flex-start',
  },
  sNoLabel: { color: '#5C6670', fontSize: 10.5, fontWeight: '800', letterSpacing: 0.8 },
  sNoValue: { color: '#F2A93B', fontSize: 16, fontWeight: '800' },
  sectionLabel: { color: '#F2A93B', fontSize: 12, fontWeight: '800', letterSpacing: 1.2, marginBottom: 12 },
  row: { flexDirection: 'row' },
  field: { marginBottom: 16 },
  label: { color: '#8A96A3', fontSize: 11, letterSpacing: 1, marginBottom: 8, fontWeight: '700' },
  input: {
    backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C', borderRadius: 10,
    paddingHorizontal: 14, height: 50, color: '#ECEFF2', fontSize: 15,
  },
  textArea: { height: 84, paddingTop: 12, textAlignVertical: 'top' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  chip: {
    borderWidth: 1, borderColor: '#2C343C', backgroundColor: '#1D2329',
    borderRadius: 20, paddingHorizontal: 16, paddingVertical: 10,
  },
  chipSelected: { borderColor: '#F2A93B', backgroundColor: '#F2A93B22' },
  chipText: { color: '#8A96A3', fontSize: 13.5, fontWeight: '600' },
  chipTextSelected: { color: '#F2A93B' },
  divider: { height: 1, backgroundColor: '#2C343C', marginVertical: 20 },
  errorBox: {
    flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#D6454522',
    borderWidth: 1, borderColor: '#D64545', borderRadius: 10, padding: 12, marginBottom: 16,
  },
  errorText: { color: '#F0A8A8', fontSize: 13, flex: 1 },
  submitButton: {
    height: 54, borderRadius: 12, backgroundColor: '#F2A93B',
    alignItems: 'center', justifyContent: 'center',
  },
  submitButtonPressed: { opacity: 0.85 },
  submitText: { color: '#14181C', fontSize: 15.5, fontWeight: '800' },
  recordsError: { color: '#F0A8A8', fontSize: 13 },
  emptyText: { color: '#5C6670', fontSize: 13.5 },
  recordCard: {
    backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C',
    borderRadius: 12, padding: 14, marginBottom: 12,
  },
  recordTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  recordTitle: { color: '#ECEFF2', fontSize: 14.5, fontWeight: '700', flex: 1, marginRight: 8 },
  statusBadge: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  statusText: { fontSize: 10.5, fontWeight: '800' },
  recordMeta: { color: '#8A96A3', fontSize: 12, marginBottom: 8 },
  recordDetail: { color: '#ECEFF2', fontSize: 12.5, lineHeight: 17, marginBottom: 4 },
  recordFooter: {
    flexDirection: 'row', justifyContent: 'space-between',
    marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: '#2C343C',
  },
  recordFooterText: { color: '#8A96A3', fontSize: 11.5 },
  recordSubmitter: { color: '#5C6670', fontSize: 11, marginTop: 6 },
});