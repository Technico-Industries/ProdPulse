// src/screens/AttendanceSheetScreen.tsx
//
// Daily attendance marking.
//
// Flow: pick Plant + Workshop → today's full operator roster for that
// plant/workshop loads (operators aren't tagged with a division or shift
// in the `operators` collection — see ManageManpowerScreen — so this
// screen doesn't filter the roster by either up front). Mark whichever
// operators you have status for (Present / Absent / On Leave); anyone
// left untouched stays unmarked. On Submit, pick ONE division AND ONE
// shift — only the operators you actually marked get submitted, tagged
// with that division, that shift, and today's date. Untouched operators
// stay on the list, available to submit against a different
// division/shift afterward (same day or later).
//
// Firestore collection: `attendanceRecords`, one doc per operator per day
// (deterministic id `${operatorId}_${date}` so a correction just
// overwrites instead of duplicating — including a correction to shift).

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
  Modal,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { collection, getDocs, query, where, orderBy, doc, setDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../services/firebase';
import { useAuthStore } from '../stores/authStore';
import { PLANTS, WORKSHOPS, DIVISIONS } from '../constants/lineOptions';

const SHIFTS: Array<'A' | 'B'> = ['A', 'B'];

// ─── Types ────────────────────────────────────────────────────────────────────

type AttendanceStatus = 'present' | 'absent' | 'leave';

interface Operator {
  id: string;
  name: string;
  code: string;
  plant: string;
  workshop: string;
}

interface ExistingAttendance {
  status: AttendanceStatus;
  division: string;
  shift: string;
}

const STATUS_LABEL: Record<AttendanceStatus, string> = {
  present: 'Present',
  absent: 'Absent',
  leave: 'On Leave',
};

const STATUS_COLOR: Record<AttendanceStatus, string> = {
  present: '#4C9A6A',
  absent: '#D64545',
  leave: '#F2A93B',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function pad2(n: number) {
  return String(n).padStart(2, '0');
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function todayDisplay() {
  const d = new Date();
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

function round1(n: number) {
  return Math.round(n * 10) / 10;
}

function normalize(s: string) {
  return s.trim().toLowerCase();
}

function summarize(statuses: AttendanceStatus[]) {
  const total = statuses.length;
  const present = statuses.filter((s) => s === 'present').length;
  const absent = statuses.filter((s) => s === 'absent').length;
  const leave = statuses.filter((s) => s === 'leave').length;
  const pct = (n: number) => (total > 0 ? round1((n / total) * 100) : 0);
  return { total, present, absent, leave, presentPct: pct(present), absentPct: pct(absent), leavePct: pct(leave) };
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function AttendanceSheetScreen() {
  const navigation = useNavigation<any>();
  const user = useAuthStore((s) => s.user);
  const date = todayISO();

  // ── Location
  const [plant, setPlant] = useState<string | null>(null);
  const [workshop, setWorkshop] = useState<string | null>(null);

  // ── Roster + today's already-submitted attendance
  const [operators, setOperators] = useState<Operator[]>([]);
  const [loadingOperators, setLoadingOperators] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [existingAttendance, setExistingAttendance] = useState<Record<string, ExistingAttendance>>({});
  const [searchQuery, setSearchQuery] = useState('');

  // ── Local marks for operators not yet submitted today
  const [marks, setMarks] = useState<Record<string, AttendanceStatus>>({});

  // ── Editing an already-submitted operator (status and/or division/shift correction)
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editStatus, setEditStatus] = useState<AttendanceStatus | null>(null);
  const [editDivision, setEditDivision] = useState<string | null>(null);
  const [editShift, setEditShift] = useState<'A' | 'B' | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);

  // ── Submit flow
  const [divisionModalVisible, setDivisionModalVisible] = useState(false);
  const [pendingDivision, setPendingDivision] = useState<string | null>(null);
  const [pendingShift, setPendingShift] = useState<'A' | 'B' | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const fetchRoster = useCallback(async () => {
    if (!plant || !workshop) return;
    setLoadingOperators(true);
    setLoadError(null);
    setMarks({});
    setSearchQuery('');
    try {
      const [opSnap, attSnap] = await Promise.all([
        getDocs(query(collection(db, 'operators'), orderBy('name', 'asc'))),
        getDocs(query(collection(db, 'attendanceRecords'), where('date', '==', date))),
      ]);

      const roster: Operator[] = opSnap.docs
        .map((d) => {
          const data: any = d.data();
          return { id: d.id, name: data.name ?? '', code: data.code ?? '', plant: data.plant ?? '', workshop: data.workshop ?? '' };
        })
        .filter((o) => o.plant === plant && o.workshop === workshop);

      const attendanceByOperator: Record<string, ExistingAttendance> = {};
      attSnap.docs.forEach((d) => {
        const data: any = d.data();
        if (!data.operatorId) return;
        // Only keep entries for operators actually on this roster
        if (roster.some((o) => o.id === data.operatorId)) {
          attendanceByOperator[data.operatorId] = { status: data.status ?? 'present', division: data.division ?? '', shift: data.shift ?? '' };
        }
      });

      setOperators(roster);
      setExistingAttendance(attendanceByOperator);
    } catch (e) {
      console.error('[AttendanceSheet] fetch failed:', e);
      setLoadError('Could not load operators. Check your connection and try again.');
    } finally {
      setLoadingOperators(false);
    }
  }, [plant, workshop, date]);

  useFocusEffect(
    useCallback(() => {
      if (plant && workshop) fetchRoster();
    }, [fetchRoster, plant, workshop])
  );

  const toggleMark = (operatorId: string, status: AttendanceStatus) => {
    if (existingAttendance[operatorId]) return; // already submitted today — locked
    setMarks((prev) => {
      const next = { ...prev };
      if (next[operatorId] === status) delete next[operatorId];
      else next[operatorId] = status;
      return next;
    });
  };

  const markedOperators = useMemo(
    () => operators.filter((o) => marks[o.id] && !existingAttendance[o.id]),
    [operators, marks, existingAttendance]
  );
  const unmarkedCount = operators.filter((o) => !marks[o.id] && !existingAttendance[o.id]).length;
  const submittedCount = operators.filter((o) => existingAttendance[o.id]).length;

  // Search only narrows what's shown — counts and submission above still
  // consider the whole roster, so a marked-but-filtered-out operator still
  // gets submitted.
  const visibleOperators = useMemo(() => {
    const q = normalize(searchQuery);
    if (!q) return operators;
    return operators.filter((o) => normalize(o.name).includes(q) || normalize(o.code).includes(q));
  }, [operators, searchQuery]);

  // Today's submissions grouped by division, for the summary section —
  // covers every division already submitted today for this plant/workshop.
  const todaysByDivision = useMemo(() => {
    const map = new Map<string, AttendanceStatus[]>();
    Object.values(existingAttendance).forEach((a) => {
      const arr = map.get(a.division) ?? [];
      arr.push(a.status);
      map.set(a.division, arr);
    });
    return Array.from(map.entries())
      .map(([division, statuses]) => ({ division, ...summarize(statuses) }))
      .sort((a, b) => a.division.localeCompare(b.division));
  }, [existingAttendance]);

  const openSubmit = () => {
    if (markedOperators.length === 0) {
      Alert.alert('Nothing marked', 'Mark at least one operator as Present, Absent, or On Leave first.');
      return;
    }
    setPendingDivision(null);
    setPendingShift(null);
    setDivisionModalVisible(true);
  };

  const handleConfirmSubmit = async () => {
    if (!pendingDivision) {
      Alert.alert('Select a division', 'Choose which division this attendance belongs to.');
      return;
    }
    if (!pendingShift) {
      Alert.alert('Select a shift', 'Choose which shift this attendance belongs to.');
      return;
    }
    setSubmitting(true);
    try {
      await Promise.all(
        markedOperators.map((op) =>
          setDoc(doc(db, 'attendanceRecords', `${op.id}_${date}`), {
            operatorId: op.id,
            operatorName: op.name,
            operatorCode: op.code,
            plant,
            workshop,
            division: pendingDivision,
            date,
            shift: pendingShift,
            status: marks[op.id],
            submittedBy: { uid: user?.uid ?? null, name: user?.name ?? user?.email ?? null },
            createdAt: serverTimestamp(),
          })
        )
      );

      const summary = summarize(markedOperators.map((op) => marks[op.id]));

      // Lock the just-submitted operators locally so they drop out of the
      // actionable list immediately, without waiting on a refetch.
      setExistingAttendance((prev) => {
        const next = { ...prev };
        markedOperators.forEach((op) => { next[op.id] = { status: marks[op.id], division: pendingDivision!, shift: pendingShift! }; });
        return next;
      });
      setMarks({});
      setDivisionModalVisible(false);

      Alert.alert(
        'Attendance Submitted',
        `${pendingDivision} · Shift ${pendingShift} · ${date}\n\n` +
          `Total Manpower: ${summary.total}\n` +
          `Present: ${summary.present} (${summary.presentPct}%)\n` +
          `Absent: ${summary.absent} (${summary.absentPct}%)\n` +
          `On Leave: ${summary.leave} (${summary.leavePct}%)`
      );
    } catch (e) {
      console.error('[AttendanceSheet] submit failed:', e);
      Alert.alert('Error', 'Could not save attendance. Check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const startEdit = (operatorId: string) => {
    const existing = existingAttendance[operatorId];
    if (!existing) return;
    setEditingId(operatorId);
    setEditStatus(existing.status);
    setEditDivision(existing.division);
    setEditShift((existing.shift as 'A' | 'B') || null);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditStatus(null);
    setEditDivision(null);
    setEditShift(null);
  };

  const handleSaveEdit = async (op: Operator) => {
    if (!editStatus || !editDivision || !editShift) {
      Alert.alert('Incomplete', 'Choose a status, a division, and a shift.');
      return;
    }
    setSavingEdit(true);
    try {
      await setDoc(
        doc(db, 'attendanceRecords', `${op.id}_${date}`),
        {
          operatorId: op.id,
          operatorName: op.name,
          operatorCode: op.code,
          plant,
          workshop,
          division: editDivision,
          date,
          shift: editShift,
          status: editStatus,
          editedBy: { uid: user?.uid ?? null, name: user?.name ?? user?.email ?? null },
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
      setExistingAttendance((prev) => ({ ...prev, [op.id]: { status: editStatus, division: editDivision, shift: editShift } }));
      cancelEdit();
    } catch (e) {
      console.error('[AttendanceSheet] edit failed:', e);
      Alert.alert('Error', 'Could not save the change. Check your connection and try again.');
    } finally {
      setSavingEdit(false);
    }
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <Pressable onPress={() => navigation.goBack()} style={styles.backButton} hitSlop={12}>
          <Ionicons name="arrow-back" size={22} color="#8A96A3" />
          <Text style={styles.backText}>Back</Text>
        </Pressable>

        <Text style={styles.title}>Attendance Sheet</Text>
        <Text style={styles.subtitle}>Pick a plant and workshop, mark attendance, then submit against a division and shift</Text>

        <View style={styles.datePill}>
          <Ionicons name="calendar-outline" size={15} color="#8A96A3" />
          <Text style={styles.datePillText}>{todayDisplay()}</Text>
          <View style={styles.livePill}>
            <View style={styles.liveDot} />
            <Text style={styles.liveTxt}>TODAY</Text>
          </View>
        </View>

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

        {!plant || !workshop ? (
          <View style={styles.emptyBox}>
            <Ionicons name="people-outline" size={26} color="#5C6670" />
            <Text style={styles.emptyText}>Select a plant and workshop to load the operator roster</Text>
          </View>
        ) : loadingOperators ? (
          <ActivityIndicator color="#F2A93B" style={{ marginVertical: 24 }} />
        ) : loadError ? (
          <View style={styles.errorBox}>
            <Ionicons name="alert-circle" size={16} color="#D64545" />
            <Text style={styles.errorText}>{loadError}</Text>
          </View>
        ) : operators.length === 0 ? (
          <View style={styles.emptyBox}>
            <Ionicons name="people-outline" size={26} color="#5C6670" />
            <Text style={styles.emptyText}>No operators found for this plant and workshop</Text>
          </View>
        ) : (
          <>
            <View style={styles.rosterHeader}>
              <Text style={styles.sectionLabel}>OPERATORS ({operators.length})</Text>
              <Text style={styles.rosterMeta}>{submittedCount} submitted · {unmarkedCount} unmarked</Text>
            </View>

            <View style={styles.searchRow}>
              <Ionicons name="search" size={17} color="#5C6670" style={{ marginRight: 8 }} />
              <TextInput
                style={styles.searchInput}
                value={searchQuery}
                onChangeText={setSearchQuery}
                placeholder="Search by name or code…"
                placeholderTextColor="#5C6670"
                autoCapitalize="none"
              />
              {searchQuery.length > 0 && (
                <Pressable onPress={() => setSearchQuery('')} hitSlop={8}>
                  <Ionicons name="close-circle" size={18} color="#5C6670" />
                </Pressable>
              )}
            </View>

            {visibleOperators.length === 0 ? (
              <View style={styles.emptyBox}>
                <Ionicons name="search-outline" size={24} color="#5C6670" />
                <Text style={styles.emptyText}>No operators match "{searchQuery}"</Text>
              </View>
            ) : (
              visibleOperators.map((op) => {
              const submitted = existingAttendance[op.id];
              const mark = marks[op.id];
              const isEditing = editingId === op.id;
              return (
                <View key={op.id} style={[styles.opCard, submitted && !isEditing && styles.opCardLocked]}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.opName}>{op.name}</Text>
                    <Text style={styles.opMeta}>{op.code}</Text>
                  </View>

                  {isEditing ? (
                    <View style={{ gap: 10 }}>
                      <View>
                        <Text style={styles.editLabel}>STATUS</Text>
                        <View style={styles.statusRow}>
                          {(['present', 'absent', 'leave'] as AttendanceStatus[]).map((s) => {
                            const active = editStatus === s;
                            return (
                              <Pressable
                                key={s}
                                onPress={() => setEditStatus(s)}
                                style={[
                                  styles.statusChip,
                                  active && { backgroundColor: STATUS_COLOR[s] + '22', borderColor: STATUS_COLOR[s] },
                                ]}
                              >
                                <Text style={[styles.statusChipText, active && { color: STATUS_COLOR[s] }]}>
                                  {STATUS_LABEL[s]}
                                </Text>
                              </Pressable>
                            );
                          })}
                        </View>
                      </View>
                      <View>
                        <Text style={styles.editLabel}>DIVISION</Text>
                        <View style={styles.chipRow}>
                          {DIVISIONS.map((d) => {
                            const active = editDivision === d;
                            return (
                              <Pressable key={d} onPress={() => setEditDivision(d)} style={[styles.chip, active && styles.chipSelected]}>
                                <Text style={[styles.chipText, active && styles.chipTextSelected]}>{d}</Text>
                              </Pressable>
                            );
                          })}
                        </View>
                      </View>
                      <View>
                        <Text style={styles.editLabel}>SHIFT</Text>
                        <View style={styles.chipRow}>
                          {SHIFTS.map((s) => {
                            const active = editShift === s;
                            return (
                              <Pressable key={s} onPress={() => setEditShift(s)} style={[styles.chip, active && styles.chipSelected]}>
                                <Text style={[styles.chipText, active && styles.chipTextSelected]}>Shift {s}</Text>
                              </Pressable>
                            );
                          })}
                        </View>
                      </View>
                      <View style={styles.editActionsRow}>
                        <Pressable onPress={cancelEdit} style={styles.editCancelBtn} disabled={savingEdit}>
                          <Text style={styles.editCancelBtnText}>Cancel</Text>
                        </Pressable>
                        <Pressable
                          onPress={() => handleSaveEdit(op)}
                          style={[styles.editSaveBtn, savingEdit && { opacity: 0.6 }]}
                          disabled={savingEdit}
                        >
                          {savingEdit ? <ActivityIndicator color="#14181C" size="small" /> : <Text style={styles.editSaveBtnText}>Save</Text>}
                        </Pressable>
                      </View>
                    </View>
                  ) : submitted ? (
                    <Pressable onPress={() => startEdit(op.id)} style={[styles.submittedBadge, { borderColor: STATUS_COLOR[submitted.status] }]}>
                      <Ionicons name="checkmark-circle" size={13} color={STATUS_COLOR[submitted.status]} />
                      <Text style={[styles.submittedBadgeText, { color: STATUS_COLOR[submitted.status] }]}>
                        {STATUS_LABEL[submitted.status]} · {submitted.division}{submitted.shift ? ` · Shift ${submitted.shift}` : ''}
                      </Text>
                      <Ionicons name="pencil" size={12} color="#5C6670" style={{ marginLeft: 2 }} />
                    </Pressable>
                  ) : (
                    <View style={styles.statusRow}>
                      {(['present', 'absent', 'leave'] as AttendanceStatus[]).map((s) => {
                        const active = mark === s;
                        return (
                          <Pressable
                            key={s}
                            onPress={() => toggleMark(op.id, s)}
                            style={[
                              styles.statusChip,
                              active && { backgroundColor: STATUS_COLOR[s] + '22', borderColor: STATUS_COLOR[s] },
                            ]}
                          >
                            <Text style={[styles.statusChipText, active && { color: STATUS_COLOR[s] }]}>
                              {STATUS_LABEL[s]}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  )}
                </View>
              );
              })
            )}

            <Pressable
              style={({ pressed }) => [
                styles.submitButton,
                (markedOperators.length === 0 || pressed) && styles.submitButtonPressed,
              ]}
              onPress={openSubmit}
              disabled={markedOperators.length === 0}
            >
              <Ionicons name="cloud-upload-outline" size={19} color="#14181C" />
              <Text style={styles.submitButtonText}>
                Submit Attendance {markedOperators.length > 0 ? `(${markedOperators.length})` : ''}
              </Text>
            </Pressable>

            {todaysByDivision.length > 0 && (
              <>
                <View style={styles.divider} />
                <Text style={styles.sectionLabel}>TODAY'S SUBMITTED DIVISIONS</Text>
                {todaysByDivision.map((d) => (
                  <View key={d.division} style={styles.summaryCard}>
                    <Text style={styles.summaryDivision}>{d.division}</Text>
                    <View style={styles.summaryStatGrid}>
                      <View style={styles.summaryStat}>
                        <Text style={styles.summaryStatValue}>{d.total}</Text>
                        <Text style={styles.summaryStatLabel}>Total Manpower</Text>
                      </View>
                      <View style={styles.summaryStat}>
                        <Text style={[styles.summaryStatValue, { color: '#4C9A6A' }]}>{d.present}</Text>
                        <Text style={styles.summaryStatLabel}>Present ({d.presentPct}%)</Text>
                      </View>
                      <View style={styles.summaryStat}>
                        <Text style={[styles.summaryStatValue, { color: '#D64545' }]}>{d.absent}</Text>
                        <Text style={styles.summaryStatLabel}>Absent ({d.absentPct}%)</Text>
                      </View>
                      <View style={styles.summaryStat}>
                        <Text style={[styles.summaryStatValue, { color: '#F2A93B' }]}>{d.leave}</Text>
                        <Text style={styles.summaryStatLabel}>On Leave ({d.leavePct}%)</Text>
                      </View>
                    </View>
                  </View>
                ))}
              </>
            )}
          </>
        )}

        <View style={{ height: 40 }} />
      </ScrollView>

      {/* Division + shift picker modal */}
      <Modal visible={divisionModalVisible} animationType="slide" transparent onRequestClose={() => setDivisionModalVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Select Division &amp; Shift</Text>
            <Text style={styles.modalSubtitle}>
              {markedOperators.length} marked operator{markedOperators.length === 1 ? '' : 's'} will be submitted for this division, shift, and today's date.
            </Text>
            <Text style={styles.modalFieldLabel}>DIVISION</Text>
            <View style={styles.chipRow}>
              {DIVISIONS.map((d) => {
                const selected = pendingDivision === d;
                return (
                  <Pressable key={d} onPress={() => setPendingDivision(d)} style={[styles.chip, selected && styles.chipSelected]}>
                    <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{d}</Text>
                  </Pressable>
                );
              })}
            </View>
            <Text style={[styles.modalFieldLabel, { marginTop: 14 }]}>SHIFT</Text>
            <View style={styles.chipRow}>
              {SHIFTS.map((s) => {
                const selected = pendingShift === s;
                return (
                  <Pressable key={s} onPress={() => setPendingShift(s)} style={[styles.chip, selected && styles.chipSelected]}>
                    <Text style={[styles.chipText, selected && styles.chipTextSelected]}>Shift {s}</Text>
                  </Pressable>
                );
              })}
            </View>
            <View style={styles.modalFooter}>
              <Pressable onPress={() => setDivisionModalVisible(false)} style={styles.modalBtn} disabled={submitting}>
                <Text style={styles.modalBtnText}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={handleConfirmSubmit}
                style={[styles.modalBtn, styles.modalBtnPrimary, (!pendingDivision || !pendingShift || submitting) && { opacity: 0.6 }]}
                disabled={!pendingDivision || !pendingShift || submitting}
              >
                {submitting ? <ActivityIndicator color="#14181C" size="small" /> : <Text style={styles.modalBtnPrimaryText}>Submit</Text>}
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
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
  subtitle: { color: '#8A96A3', fontSize: 13, marginTop: 4, marginBottom: 16, lineHeight: 18 },

  datePill: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C',
    borderRadius: 10, paddingHorizontal: 14, height: 48, marginBottom: 18,
  },
  datePillText: { color: '#ECEFF2', fontWeight: '700', fontSize: 14, flex: 1 },
  livePill: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  liveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#4C9A6A' },
  liveTxt: { color: '#4C9A6A', fontSize: 10, fontWeight: '800', letterSpacing: 1 },

  field: { marginBottom: 14 },
  label: { color: '#8A96A3', fontSize: 11, fontWeight: '700', letterSpacing: 0.6, marginBottom: 8 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  chip: {
    borderWidth: 1, borderColor: '#2C343C', backgroundColor: '#1D2329',
    borderRadius: 20, paddingHorizontal: 16, paddingVertical: 10,
  },
  chipSelected: { borderColor: '#F2A93B', backgroundColor: '#F2A93B22' },
  chipText: { color: '#8A96A3', fontSize: 13.5, fontWeight: '600' },
  chipTextSelected: { color: '#F2A93B' },

  sectionLabel: { color: '#F2A93B', fontSize: 11.5, fontWeight: '800', letterSpacing: 1.4 },
  rosterHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8, marginBottom: 12 },
  rosterMeta: { color: '#5C6670', fontSize: 11.5 },

  searchRow: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: '#1D2329',
    borderWidth: 1, borderColor: '#2C343C', borderRadius: 10,
    paddingHorizontal: 12, height: 46, marginBottom: 14,
  },
  searchInput: { flex: 1, color: '#ECEFF2', fontSize: 14.5 },

  emptyBox: { alignItems: 'center', gap: 8, paddingVertical: 28 },
  emptyText: { color: '#5C6670', fontSize: 13.5, textAlign: 'center', paddingHorizontal: 20 },
  errorBox: {
    flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#D6454522',
    borderWidth: 1, borderColor: '#D64545', borderRadius: 10, padding: 12, marginBottom: 14,
  },
  errorText: { color: '#F0A8A8', fontSize: 13, flex: 1 },

  opCard: {
    backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C',
    borderRadius: 12, padding: 12, marginBottom: 10, gap: 10,
  },
  opCardLocked: { opacity: 0.85 },
  opName: { color: '#ECEFF2', fontSize: 14.5, fontWeight: '700' },
  opMeta: { color: '#8A96A3', fontSize: 12, marginTop: 2 },
  statusRow: { flexDirection: 'row', gap: 8, marginTop: 4 },
  statusChip: {
    flex: 1, borderWidth: 1, borderColor: '#2C343C', backgroundColor: '#14181C',
    borderRadius: 8, paddingVertical: 8, alignItems: 'center',
  },
  statusChipText: { color: '#8A96A3', fontSize: 12, fontWeight: '700' },
  submittedBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start',
    borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5,
  },
  submittedBadgeText: { fontSize: 11.5, fontWeight: '700' },

  editLabel: { color: '#5C6670', fontSize: 9.5, fontWeight: '800', letterSpacing: 0.8, marginBottom: 6 },
  editActionsRow: { flexDirection: 'row', gap: 10, marginTop: 2 },
  editCancelBtn: {
    flex: 1, borderWidth: 1, borderColor: '#2C343C', backgroundColor: '#14181C',
    borderRadius: 8, paddingVertical: 10, alignItems: 'center',
  },
  editCancelBtnText: { color: '#8A96A3', fontSize: 12.5, fontWeight: '700' },
  editSaveBtn: {
    flex: 1, backgroundColor: '#F2A93B', borderRadius: 8, paddingVertical: 10, alignItems: 'center',
  },
  editSaveBtnText: { color: '#14181C', fontSize: 12.5, fontWeight: '800' },

  submitButton: {
    height: 54, borderRadius: 12, backgroundColor: '#F2A93B',
    alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8, marginTop: 8,
  },
  submitButtonPressed: { opacity: 0.6 },
  submitButtonText: { color: '#14181C', fontSize: 15, fontWeight: '900' },

  divider: { height: 1, backgroundColor: '#2C343C', marginVertical: 22 },

  summaryCard: {
    backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C',
    borderRadius: 12, padding: 14, marginBottom: 10,
  },
  summaryDivision: { color: '#ECEFF2', fontSize: 15, fontWeight: '800', marginBottom: 10 },
  summaryStatGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  summaryStat: { flexGrow: 1, minWidth: '22%', alignItems: 'center', gap: 3 },
  summaryStatValue: { color: '#ECEFF2', fontSize: 17, fontWeight: '800' },
  summaryStatLabel: { color: '#8A96A3', fontSize: 10, fontWeight: '700', textAlign: 'center' },

  modalOverlay: { flex: 1, backgroundColor: '#00000088', alignItems: 'center', justifyContent: 'center', padding: 20 },
  modalCard: { width: '100%', maxWidth: 480, backgroundColor: '#14181C', borderRadius: 12, padding: 16, borderWidth: 1, borderColor: '#2C343C' },
  modalTitle: { color: '#ECEFF2', fontSize: 18, fontWeight: '800', marginBottom: 6 },
  modalSubtitle: { color: '#8A96A3', fontSize: 12.5, marginBottom: 14, lineHeight: 17 },
  modalFieldLabel: { color: '#5C6670', fontSize: 10.5, fontWeight: '800', letterSpacing: 0.8, marginBottom: 8 },
  modalFooter: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 16, paddingTop: 12, borderTopWidth: 1, borderTopColor: '#2C343C' },
  modalBtn: { paddingHorizontal: 16, paddingVertical: 11, borderRadius: 8, borderWidth: 1, borderColor: '#2C343C', backgroundColor: '#1D2329' },
  modalBtnText: { color: '#ECEFF2', fontWeight: '700' },
  modalBtnPrimary: { backgroundColor: '#F2A93B', borderColor: '#F2A93B' },
  modalBtnPrimaryText: { color: '#14181C', fontWeight: '800' },
});