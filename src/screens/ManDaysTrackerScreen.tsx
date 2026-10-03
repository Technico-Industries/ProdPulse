// src/screens/ManDaysTrackerScreen.tsx
//
// Man-Days Tracker
// • Log daily manpower per plant / workshop / division
// • Auto-captures today's date from system clock
// • View: daily log list or monthly summary calendar grid
// • Firestore collection: `manDaysRecords`

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
  Modal,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import {
  collection,
  addDoc,
  getDocs,
  query,
  orderBy,
  serverTimestamp,
  where,
  doc,
  updateDoc,
} from 'firebase/firestore';
import { db } from '../services/firebase';
import { useAuthStore } from '../stores/authStore';
import { PLANTS, WORKSHOPS, DIVISIONS } from '../constants/lineOptions';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ManDayRecord {
  id: string;
  plant: string;
  workshop: string;
  division: string;
  dateISO: string;       // YYYY-MM-DD  (used for grouping/sorting)
  dateDisplay: string;   // DD-MM-YY    (display)
  dayOfWeek: string;     // Mon, Tue …
  month: string;         // YYYY-MM     (monthly grouping)
  present: number;       // fetched from attendanceRecords (status === 'present')
  absent: number;        // fetched from attendanceRecords (status === 'absent')
  onLeave: number;       // fetched from attendanceRecords (status === 'leave')
  totalPresent: number;  // = present (kept as its own field for compatibility with existing reports)
  remarks: string;
  submittedBy: string;
  createdAt: any;
}

type ViewMode = 'daily' | 'monthly';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function todayISO() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function isoToDisplay(iso: string) {
  const [y, m, day] = iso.split('-');
  return `${day}-${m}-${y.slice(2)}`;
}

function isoToDayName(iso: string) {
  return DAY_NAMES[new Date(iso).getDay()];
}

function isoToMonth(iso: string) {
  return iso.slice(0, 7); // YYYY-MM
}

function monthLabel(ym: string) {
  const [y, m] = ym.split('-');
  return `${MONTH_NAMES[parseInt(m, 10) - 1]} ${y}`;
}

function daysInMonth(ym: string) {
  const [y, m] = ym.split('-');
  return new Date(parseInt(y), parseInt(m), 0).getDate();
}

function pad2(n: number) { return String(n).padStart(2, '0'); }

// ─── Sub-components ───────────────────────────────────────────────────────────

function PickerButton({
  label, value, onPress,
}: { label: string; value: string | null; onPress: () => void }) {
  return (
    <View style={S.field}>
      <Text style={S.fieldLabel}>{label}</Text>
      <Pressable style={S.pickerBox} onPress={onPress}>
        <Text style={[S.pickerText, !value && S.pickerPlaceholder]}>
          {value ?? `Select ${label.toLowerCase()}`}
        </Text>
        <Ionicons name="chevron-down" size={18} color="#5C6670" />
      </Pressable>
    </View>
  );
}

function PickerModal({
  visible, title, options, value, onSelect, onClose,
}: {
  visible: boolean; title: string; options: string[];
  value: string | null; onSelect: (v: string) => void; onClose: () => void;
}) {
  return (
    <Modal visible={visible} animationType="slide" transparent>
      <View style={S.modalOverlay}>
        <View style={S.modalCard}>
          <Text style={S.modalTitle}>{title}</Text>
          <ScrollView contentContainerStyle={{ paddingBottom: 12 }}>
            {options.map((o) => (
              <Pressable
                key={o}
                style={[S.modalRow, value === o && S.modalRowSel]}
                onPress={() => { onSelect(o); onClose(); }}
              >
                <Text style={[S.modalRowText, value === o && S.modalRowTextSel]}>{o}</Text>
                {value === o && <Ionicons name="checkmark" size={18} color="#F2A93B" />}
              </Pressable>
            ))}
          </ScrollView>
          <View style={S.modalFooter}>
            <Pressable style={S.modalCancelBtn} onPress={onClose}>
              <Text style={S.modalCancelText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function CounterField({
  label, value, onChange, color,
}: { label: string; value: number; onChange: (v: number) => void; color?: string }) {
  return (
    <View style={S.counterWrap}>
      {/* Label + big number in the centre */}
      <Text style={[S.counterLabel, color ? { color } : {}]}>{label}</Text>
      <Text style={[S.counterBigNum, color ? { color } : {}]}>{value}</Text>
      {/* − / + row below the number */}
      <View style={S.counterRow}>
        <Pressable
          style={S.counterBtn}
          onPress={() => onChange(Math.max(0, value - 1))}
          hitSlop={10}
        >
          <Ionicons name="remove" size={20} color="#ECEFF2" />
        </Pressable>
        <Pressable
          style={[S.counterBtn, S.counterBtnPlus, color ? { backgroundColor: color + '22', borderColor: color } : {}]}
          onPress={() => onChange(value + 1)}
          hitSlop={10}
        >
          <Ionicons name="add" size={20} color={color ?? '#ECEFF2'} />
        </Pressable>
      </View>
    </View>
  );
}

// ─── Monthly calendar grid ────────────────────────────────────────────────────

function MonthlyGrid({
  month, records,
}: { month: string; records: ManDayRecord[] }) {
  const total = daysInMonth(month);
  const [y, m] = month.split('-');

  // Map day-number → total present
  const byDay: Record<number, number> = {};
  records.forEach((r) => {
    if (r.month === month) {
      const day = parseInt(r.dateISO.slice(8), 10);
      byDay[day] = (byDay[day] ?? 0) + r.totalPresent;
    }
  });

  const monthTotal = Object.values(byDay).reduce((a, b) => a + b, 0);
  const daysLogged = Object.keys(byDay).length;
  const avgPerDay = daysLogged > 0 ? (monthTotal / daysLogged).toFixed(1) : '—';

  // Build calendar cells; start from weekday of the 1st
  const firstDow = new Date(parseInt(y), parseInt(m) - 1, 1).getDay();
  const cells: (number | null)[] = [
    ...Array(firstDow).fill(null),
    ...Array.from({ length: total }, (_, i) => i + 1),
  ];
  // Pad to full weeks
  while (cells.length % 7 !== 0) cells.push(null);

  const todayDay = todayISO().slice(0, 7) === month
    ? parseInt(todayISO().slice(8), 10) : -1;

  return (
    <View style={S.monthBlock}>
      {/* Month header */}
      <View style={S.monthHeader}>
        <Text style={S.monthTitle}>{monthLabel(month)}</Text>
        <View style={S.monthStats}>
          <View style={S.statChip}>
            <Text style={S.statChipLabel}>Total</Text>
            <Text style={S.statChipValue}>{monthTotal}</Text>
          </View>
          <View style={S.statChip}>
            <Text style={S.statChipLabel}>Days</Text>
            <Text style={S.statChipValue}>{daysLogged}/{total}</Text>
          </View>
          <View style={S.statChip}>
            <Text style={S.statChipLabel}>Avg/day</Text>
            <Text style={S.statChipValue}>{avgPerDay}</Text>
          </View>
        </View>
      </View>

      {/* Day-of-week header */}
      <View style={S.calRow}>
        {DAY_NAMES.map((d) => (
          <Text key={d} style={S.calDow}>{d}</Text>
        ))}
      </View>

      {/* Weeks */}
      {Array.from({ length: cells.length / 7 }, (_, wi) => (
        <View key={wi} style={S.calRow}>
          {cells.slice(wi * 7, wi * 7 + 7).map((day, di) => {
            if (!day) return <View key={di} style={S.calCell} />;
            const count = byDay[day];
            const isToday = day === todayDay;
            const hasData = count !== undefined;
            return (
              <View
                key={di}
                style={[
                  S.calCell,
                  hasData && S.calCellFilled,
                  isToday && S.calCellToday,
                ]}
              >
                <Text style={[S.calDayNum, isToday && S.calDayToday]}>{day}</Text>
                {hasData && (
                  <Text style={S.calCount}>{count}</Text>
                )}
              </View>
            );
          })}
        </View>
      ))}
    </View>
  );
}

// ─── Main Screen ──────────────────────────────────────────────────────────────

export default function ManDaysTrackerScreen() {
  const navigation = useNavigation<any>();
  const user = useAuthStore((s) => s.user);

  // ── Filters (shared between form & view)
  const [plant,    setPlant]    = useState<string | null>(null);
  const [workshop, setWorkshop] = useState<string | null>(null);
  const [division, setDivision] = useState<string | null>(null);

  // ── Modals
  const [plantModal,    setPlantModal]    = useState(false);
  const [workshopModal, setWorkshopModal] = useState(false);
  const [divisionModal, setDivisionModal] = useState(false);

  // ── Form (attendance is FETCHED, not manually counted)
  const today = todayISO();
  const [fetching,   setFetching]   = useState(false);
  const [hasFetched, setHasFetched] = useState(false);
  const [present,    setPresent]    = useState(0);
  const [absent,     setAbsent]     = useState(0);
  const [onLeave,    setOnLeave]    = useState(0);
  const [remarks,    setRemarks]    = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError,  setFormError]  = useState<string | null>(null);

  // ── Records & view
  const [records,        setRecords]        = useState<ManDayRecord[]>([]);
  const [recordsLoading, setRecordsLoading] = useState(true);
  const [viewMode,       setViewMode]       = useState<ViewMode>('daily');
  const [selectedMonth,  setSelectedMonth]  = useState(today.slice(0, 7));

  // ── Edit
  const [editRecord,    setEditRecord]    = useState<ManDayRecord | null>(null);
  const [editPresent,   setEditPresent]   = useState(0);
  const [editAbsent,    setEditAbsent]    = useState(0);
  const [editOnLeave,   setEditOnLeave]   = useState(0);
  const [editRefreshing, setEditRefreshing] = useState(false);
  const [editRemarks,   setEditRemarks]   = useState('');
  const [editError,     setEditError]     = useState<string | null>(null);
  const [editSaving,    setEditSaving]    = useState(false);

  // Selecting a different plant/workshop/division invalidates whatever was
  // fetched for the previous combination.
  useEffect(() => {
    setHasFetched(false);
    setPresent(0);
    setAbsent(0);
    setOnLeave(0);
  }, [plant, workshop, division]);

  // ── Fetch today's attendance for the selected plant/workshop/division
  // from `attendanceRecords` (written by AttendanceSheetScreen).
  const fetchAttendance = useCallback(async () => {
    if (!plant || !workshop || !division) return;
    setFetching(true);
    setFormError(null);
    try {
      const snap = await getDocs(
        query(
          collection(db, 'attendanceRecords'),
          where('plant', '==', plant),
          where('workshop', '==', workshop),
          where('division', '==', division),
          where('date', '==', today)
        )
      );
      let p = 0, a = 0, l = 0;
      snap.docs.forEach((d) => {
        const status = (d.data() as any).status;
        if (status === 'present') p += 1;
        else if (status === 'absent') a += 1;
        else if (status === 'leave') l += 1;
      });
      setPresent(p);
      setAbsent(a);
      setOnLeave(l);
      setHasFetched(true);
    } catch (e) {
      console.error('[ManDaysTracker] fetchAttendance failed:', e);
      setFormError('Could not load attendance data. Check your connection and try again.');
    } finally {
      setFetching(false);
    }
  }, [plant, workshop, division, today]);

  // ── Load records
  const loadRecords = useCallback(async () => {
    setRecordsLoading(true);
    try {
      const snap = await getDocs(
        query(collection(db, 'manDaysRecords'), orderBy('dateISO', 'desc'))
      );
      setRecords(snap.docs.map((d) => {
        const data: any = d.data();
        return {
          id: d.id,
          plant:        data.plant        ?? '',
          workshop:     data.workshop     ?? '',
          division:     data.division     ?? '',
          dateISO:      data.dateISO      ?? '',
          dateDisplay:  data.dateDisplay  ?? '',
          dayOfWeek:    data.dayOfWeek    ?? '',
          month:        data.month        ?? '',
          present:      data.present      ?? data.operators ?? 0,
          absent:       data.absent       ?? data.absentees ?? 0,
          onLeave:      data.onLeave      ?? 0,
          totalPresent: data.totalPresent ?? 0,
          remarks:      data.remarks      ?? '',
          submittedBy:  data.submittedBy  ?? '',
          createdAt:    data.createdAt,
        };
      }));
    } catch (e) {
      console.error('loadRecords', e);
    } finally {
      setRecordsLoading(false);
    }
  }, []);

  useEffect(() => { loadRecords(); }, [loadRecords]);

  // ── Filtered records
  const filteredRecords = records.filter((r) => {
    if (plant    && r.plant    !== plant)    return false;
    if (workshop && r.workshop !== workshop) return false;
    if (division && r.division !== division) return false;
    return true;
  });

  // RULE: only one manpower log per plant/workshop/division per day. Surface
  // it as soon as all three are picked, before the admin even fetches/submits.
  const todaysExistingEntry = useMemo(() => {
    if (!plant || !workshop || !division) return null;
    return records.find(
      (r) => r.plant === plant && r.workshop === workshop && r.division === division && r.dateISO === today
    ) ?? null;
  }, [records, plant, workshop, division, today]);

  // ── Submit
  const handleSubmit = async () => {
    if (!plant)    { setFormError('Select a plant.');    return; }
    if (!workshop) { setFormError('Select a workshop.'); return; }
    if (!division) { setFormError('Select a division.'); return; }
    if (!hasFetched) { setFormError('Tap "Fetch Attendance" first.'); return; }

    // RULE: only one manpower log per plant/workshop/division per day.
    // If one already exists for today, block the duplicate and offer to
    // edit the existing entry instead of silently creating a second one.
    const existing = records.find(
      (r) => r.plant === plant && r.workshop === workshop && r.division === division && r.dateISO === today
    );
    if (existing) {
      setFormError(null);
      Alert.alert(
        'Already Logged Today',
        `Manpower for ${division} (${workshop}, ${plant}) was already logged today. Edit the existing entry instead of creating a duplicate.`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Edit Existing', onPress: () => openEdit(existing) },
        ]
      );
      return;
    }

    setFormError(null);
    setSubmitting(true);
    try {
      await addDoc(collection(db, 'manDaysRecords'), {
        plant, workshop, division,
        dateISO:      today,
        dateDisplay:  isoToDisplay(today),
        dayOfWeek:    isoToDayName(today),
        month:        isoToMonth(today),
        present, absent, onLeave,
        totalPresent: present,
        remarks: remarks.trim(),
        submittedBy:    user?.name ?? user?.email ?? 'Unknown',
        submittedByUid: user?.uid ?? null,
        createdAt: serverTimestamp(),
      });
      setHasFetched(false); setPresent(0); setAbsent(0); setOnLeave(0);
      setRemarks('');
      Alert.alert('Saved', `Manpower logged for ${isoToDisplay(today)}.`);
      loadRecords();
    } catch (e) {
      console.error('submit', e);
      setFormError('Could not save. Check your connection.');
    } finally {
      setSubmitting(false);
    }
  };

  // ── Edit
  const openEdit = (r: ManDayRecord) => {
    setEditRecord(r);
    setEditPresent(r.present);
    setEditAbsent(r.absent);
    setEditOnLeave(r.onLeave);
    setEditRemarks(r.remarks);
    setEditError(null);
  };

  // Re-pull attendance for this record's exact date/plant/workshop/division -
  // useful if attendance was corrected on AttendanceSheetScreen after this
  // man-days entry was originally saved.
  const refreshEditFromAttendance = async () => {
    if (!editRecord) return;
    setEditRefreshing(true);
    setEditError(null);
    try {
      const snap = await getDocs(
        query(
          collection(db, 'attendanceRecords'),
          where('plant', '==', editRecord.plant),
          where('workshop', '==', editRecord.workshop),
          where('division', '==', editRecord.division),
          where('date', '==', editRecord.dateISO)
        )
      );
      let p = 0, a = 0, l = 0;
      snap.docs.forEach((d) => {
        const status = (d.data() as any).status;
        if (status === 'present') p += 1;
        else if (status === 'absent') a += 1;
        else if (status === 'leave') l += 1;
      });
      setEditPresent(p);
      setEditAbsent(a);
      setEditOnLeave(l);
    } catch (e) {
      console.error('[ManDaysTracker] refreshEditFromAttendance failed:', e);
      setEditError('Could not refresh from the attendance sheet. Check your connection.');
    } finally {
      setEditRefreshing(false);
    }
  };

  const handleUpdate = async () => {
    if (!editRecord) return;
    setEditError(null);
    setEditSaving(true);
    try {
      await updateDoc(doc(db, 'manDaysRecords', editRecord.id), {
        present:  editPresent,
        absent:   editAbsent,
        onLeave:  editOnLeave,
        totalPresent: editPresent,
        remarks: editRemarks.trim(),
        updatedBy:  user?.name ?? user?.email ?? 'Unknown',
        updatedAt:  serverTimestamp(),
      });
      setEditRecord(null);
      loadRecords();
    } catch (e) {
      console.error('update', e);
      setEditError('Could not save. Check your connection.');
    } finally {
      setEditSaving(false);
    }
  };

  // ── Month navigation
  const shiftMonth = (delta: number) => {
    const [y, m] = selectedMonth.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    setSelectedMonth(`${d.getFullYear()}-${pad2(d.getMonth() + 1)}`);
  };

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={S.safeArea}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={S.scroll} keyboardShouldPersistTaps="handled">

          {/* Back */}
          <Pressable onPress={() => navigation.goBack()} style={S.backBtn} hitSlop={12}>
            <Ionicons name="arrow-back" size={22} color="#8A96A3" />
            <Text style={S.backText}>Back</Text>
          </Pressable>

          <Text style={S.title}>Man-Days Tracker</Text>
          <Text style={S.subtitle}>Log daily manpower and track monthly totals</Text>

          {/* ── Today's date pill ── */}
          <View style={S.datePill}>
            <Ionicons name="calendar" size={15} color="#F2A93B" />
            <Text style={S.datePillText}>
              {isoToDayName(today)}, {isoToDisplay(today)}
            </Text>
            <View style={S.datePillLive}>
              <View style={S.liveDot} />
              <Text style={S.liveTxt}>TODAY</Text>
            </View>
          </View>

          {/* ── Location ── */}
          <Text style={S.sectionLabel}>LOCATION</Text>

          <View style={S.row}>
            <View style={{ flex: 1 }}>
              <PickerButton label="Plant"    value={plant}    onPress={() => setPlantModal(true)} />
            </View>
            <View style={{ flex: 1 }}>
              <PickerButton label="Workshop" value={workshop} onPress={() => setWorkshopModal(true)} />
            </View>
          </View>
          <PickerButton label="Division" value={division} onPress={() => setDivisionModal(true)} />

          {/* ── Attendance (fetched, not manually counted) ── */}
          <Text style={S.sectionLabel}>TODAY'S MANPOWER</Text>
          <Text style={S.fetchHint}>
            Pulled from the Attendance Sheet for this Plant / Workshop / Division, for today.
          </Text>

          {todaysExistingEntry && (
            <Pressable style={S.dupeBanner} onPress={() => openEdit(todaysExistingEntry)}>
              <Ionicons name="alert-circle" size={16} color="#F2A93B" />
              <Text style={S.dupeBannerText}>
                Already logged today — Present {todaysExistingEntry.present}, Absent {todaysExistingEntry.absent}, On Leave {todaysExistingEntry.onLeave}. Tap to edit instead.
              </Text>
            </Pressable>
          )}

          <Pressable
            style={({ pressed }) => [
              S.fetchBtn,
              (!plant || !workshop || !division || fetching) && S.fetchBtnDisabled,
              pressed && { opacity: 0.85 },
            ]}
            onPress={fetchAttendance}
            disabled={!plant || !workshop || !division || fetching}
          >
            {fetching ? (
              <ActivityIndicator color="#14181C" />
            ) : (
              <>
                <Ionicons name="cloud-download-outline" size={18} color="#14181C" />
                <Text style={S.fetchBtnText}>{hasFetched ? 'Re-fetch Attendance' : 'Fetch Attendance'}</Text>
              </>
            )}
          </Pressable>

          {hasFetched && (
            <View style={S.countersGrid}>
              <View style={[S.statCard, { borderColor: '#4C9A6A44' }]}>
                <Text style={[S.statCardValue, { color: '#4C9A6A' }]}>{present}</Text>
                <Text style={S.statCardLabel}>Present</Text>
              </View>
              <View style={[S.statCard, { borderColor: '#D6454544' }]}>
                <Text style={[S.statCardValue, { color: '#D64545' }]}>{absent}</Text>
                <Text style={S.statCardLabel}>Absent</Text>
              </View>
              <View style={[S.statCard, { borderColor: '#F2A93B44' }]}>
                <Text style={[S.statCardValue, { color: '#F2A93B' }]}>{onLeave}</Text>
                <Text style={S.statCardLabel}>On Leave</Text>
              </View>
            </View>
          )}

          {/* Total present pill */}
          {hasFetched && (
            <View style={S.totalRow}>
              <Text style={S.totalLabel}>Total Present</Text>
              <View style={S.totalBadge}>
                <Text style={S.totalValue}>{present}</Text>
              </View>
            </View>
          )}

          {/* Remarks */}
          <View style={S.field}>
            <Text style={S.fieldLabel}>REMARKS (optional)</Text>
            <TextInput
              style={S.textArea}
              value={remarks}
              onChangeText={setRemarks}
              placeholder="e.g. 2 operators on leave, holiday shift…"
              placeholderTextColor="#5C6670"
              multiline
              numberOfLines={3}
              textAlignVertical="top"
            />
          </View>

          {/* Error */}
          {formError && (
            <View style={S.errorBox}>
              <Ionicons name="alert-circle" size={16} color="#D64545" />
              <Text style={S.errorText}>{formError}</Text>
            </View>
          )}

          {/* Submit */}
          <Pressable
            style={({ pressed }) => [S.submitBtn, (submitting || pressed) && { opacity: 0.85 }]}
            onPress={handleSubmit}
            disabled={submitting}
          >
            {submitting
              ? <ActivityIndicator color="#14181C" />
              : <><Ionicons name="checkmark-circle" size={20} color="#14181C" /><Text style={S.submitText}>Log Manpower</Text></>
            }
          </Pressable>

          {/* ── Records section ── */}
          <View style={S.divider} />

          {/* View toggle */}
          <View style={S.viewToggle}>
            <Pressable
              style={[S.toggleBtn, viewMode === 'daily'   && S.toggleBtnActive]}
              onPress={() => setViewMode('daily')}
            >
              <Ionicons name="list"    size={15} color={viewMode === 'daily'   ? '#14181C' : '#8A96A3'} />
              <Text style={[S.toggleBtnText, viewMode === 'daily'   && S.toggleBtnTextActive]}>Daily Log</Text>
            </Pressable>
            <Pressable
              style={[S.toggleBtn, viewMode === 'monthly' && S.toggleBtnActive]}
              onPress={() => setViewMode('monthly')}
            >
              <Ionicons name="calendar" size={15} color={viewMode === 'monthly' ? '#14181C' : '#8A96A3'} />
              <Text style={[S.toggleBtnText, viewMode === 'monthly' && S.toggleBtnTextActive]}>Monthly</Text>
            </Pressable>
          </View>

          {/* Filters row */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
            <View style={{ flexDirection: 'row', gap: 8, paddingBottom: 2 }}>
              {[
                { label: plant    ?? 'All Plants',    onClear: () => setPlant(null),    active: !!plant },
                { label: workshop ?? 'All Workshops', onClear: () => setWorkshop(null), active: !!workshop },
                { label: division ?? 'All Divisions', onClear: () => setDivision(null), active: !!division },
              ].map((f, i) => (
                <Pressable
                  key={i}
                  style={[S.filterChip, f.active && S.filterChipActive]}
                  onPress={f.active ? f.onClear : undefined}
                >
                  <Text style={[S.filterChipText, f.active && S.filterChipTextActive]}>{f.label}</Text>
                  {f.active && <Ionicons name="close" size={13} color="#F2A93B" />}
                </Pressable>
              ))}
            </View>
          </ScrollView>

          {recordsLoading ? (
            <View style={S.centered}>
              <ActivityIndicator color="#F2A93B" />
              <Text style={S.muted}>Loading records…</Text>
            </View>
          ) : viewMode === 'daily' ? (
            // ── Daily log list ──
            filteredRecords.length === 0 ? (
              <View style={S.centered}>
                <Ionicons name="document-outline" size={28} color="#5C6670" />
                <Text style={S.muted}>No records yet</Text>
              </View>
            ) : (
              filteredRecords.map((r) => (
                <View key={r.id} style={S.recordCard}>
                  {/* Header row */}
                  <View style={S.recordHeader}>
                    <View>
                      <Text style={S.recordDate}>{r.dayOfWeek}, {r.dateDisplay}</Text>
                      <Text style={S.recordLocation}>{r.plant} · {r.workshop} · {r.division}</Text>
                    </View>
                    <Pressable onPress={() => openEdit(r)} style={S.editBtn} hitSlop={10}>
                      <Ionicons name="pencil" size={15} color="#3E7CB1" />
                    </Pressable>
                  </View>
                  {/* Counts */}
                  <View style={S.recordCounts}>
                    <View style={S.countChip}>
                      <Text style={[S.countChipNum, { color: '#4C9A6A' }]}>{r.present}</Text>
                      <Text style={S.countChipLbl}>Present</Text>
                    </View>
                    <View style={S.countChip}>
                      <Text style={[S.countChipNum, { color: '#D64545' }]}>{r.absent}</Text>
                      <Text style={S.countChipLbl}>Absent</Text>
                    </View>
                    <View style={S.countChip}>
                      <Text style={[S.countChipNum, { color: '#F2A93B' }]}>{r.onLeave}</Text>
                      <Text style={S.countChipLbl}>On Leave</Text>
                    </View>
                  </View>
                  {/* Footer */}
                  <View style={S.recordFooter}>
                    <View style={S.totalPresentBadge}>
                      <Text style={S.totalPresentTxt}>Total present: {r.totalPresent}</Text>
                    </View>
                    {r.remarks ? <Text style={S.recordRemarks}>{r.remarks}</Text> : null}
                  </View>
                </View>
              ))
            )
          ) : (
            // ── Monthly view ──
            <>
              {/* Month navigator */}
              <View style={S.monthNav}>
                <Pressable onPress={() => shiftMonth(-1)} style={S.monthNavBtn} hitSlop={10}>
                  <Ionicons name="chevron-back" size={20} color="#ECEFF2" />
                </Pressable>
                <Text style={S.monthNavLabel}>{monthLabel(selectedMonth)}</Text>
                <Pressable onPress={() => shiftMonth(1)} style={S.monthNavBtn} hitSlop={10}>
                  <Ionicons name="chevron-forward" size={20} color="#ECEFF2" />
                </Pressable>
              </View>

              <MonthlyGrid month={selectedMonth} records={filteredRecords} />

              {/* Monthly breakdown list */}
              <Text style={[S.sectionLabel, { marginTop: 16 }]}>DAILY BREAKDOWN</Text>
              {filteredRecords
                .filter((r) => r.month === selectedMonth)
                .map((r) => (
                  <View key={r.id} style={S.monthDayRow}>
                    <View style={S.monthDayDate}>
                      <Text style={S.monthDayNum}>{r.dateISO.slice(8)}</Text>
                      <Text style={S.monthDayName}>{r.dayOfWeek}</Text>
                    </View>
                    <View style={{ flex: 1, flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                      <Text style={S.monthDayLocation}>{r.division}</Text>
                    </View>
                    <View style={S.monthDayPresent}>
                      <Text style={S.monthDayPresentNum}>{r.totalPresent}</Text>
                      <Text style={S.monthDayPresentLbl}>present</Text>
                    </View>
                    <Pressable onPress={() => openEdit(r)} hitSlop={10} style={{ paddingLeft: 8 }}>
                      <Ionicons name="pencil" size={14} color="#3E7CB1" />
                    </Pressable>
                  </View>
                ))}
              {filteredRecords.filter((r) => r.month === selectedMonth).length === 0 && (
                <View style={S.centered}>
                  <Text style={S.muted}>No entries for {monthLabel(selectedMonth)}</Text>
                </View>
              )}
            </>
          )}

          <View style={{ height: 40 }} />
        </ScrollView>
      </KeyboardAvoidingView>

      {/* ── Pickers ── */}
      <PickerModal visible={plantModal}    title="Select Plant"    options={PLANTS}    value={plant}    onSelect={setPlant}    onClose={() => setPlantModal(false)} />
      <PickerModal visible={workshopModal} title="Select Workshop" options={WORKSHOPS} value={workshop} onSelect={setWorkshop} onClose={() => setWorkshopModal(false)} />
      <PickerModal visible={divisionModal} title="Select Division" options={DIVISIONS} value={division} onSelect={setDivision} onClose={() => setDivisionModal(false)} />

      {/* ── Edit modal ── */}
      <Modal visible={editRecord !== null} animationType="slide" transparent>
        <View style={S.editOverlay}>
          <View style={S.editCard}>
            <View style={S.editHeader}>
              <View>
                <Text style={S.editTitle}>Edit Entry</Text>
                {editRecord && (
                  <Text style={S.editSubtitle}>
                    {editRecord.dayOfWeek}, {editRecord.dateDisplay} · {editRecord.division}
                  </Text>
                )}
              </View>
              <Pressable onPress={() => setEditRecord(null)} hitSlop={12}>
                <Ionicons name="close" size={22} color="#8A96A3" />
              </Pressable>
            </View>

            <ScrollView
              contentContainerStyle={S.editScroll}
              keyboardShouldPersistTaps="handled"
            >
              <Text style={S.sectionLabel}>MANPOWER</Text>

              <Pressable
                style={({ pressed }) => [S.fetchBtn, editRefreshing && S.fetchBtnDisabled, pressed && { opacity: 0.85 }]}
                onPress={refreshEditFromAttendance}
                disabled={editRefreshing}
              >
                {editRefreshing ? (
                  <ActivityIndicator color="#14181C" />
                ) : (
                  <>
                    <Ionicons name="refresh" size={18} color="#14181C" />
                    <Text style={S.fetchBtnText}>Refresh from Attendance Sheet</Text>
                  </>
                )}
              </Pressable>

              <View style={S.countersGrid}>
                <View style={[S.statCard, { borderColor: '#4C9A6A44' }]}>
                  <Text style={[S.statCardValue, { color: '#4C9A6A' }]}>{editPresent}</Text>
                  <Text style={S.statCardLabel}>Present</Text>
                </View>
                <View style={[S.statCard, { borderColor: '#D6454544' }]}>
                  <Text style={[S.statCardValue, { color: '#D64545' }]}>{editAbsent}</Text>
                  <Text style={S.statCardLabel}>Absent</Text>
                </View>
                <View style={[S.statCard, { borderColor: '#F2A93B44' }]}>
                  <Text style={[S.statCardValue, { color: '#F2A93B' }]}>{editOnLeave}</Text>
                  <Text style={S.statCardLabel}>On Leave</Text>
                </View>
              </View>

              <View style={[S.totalRow, { marginTop: 4 }]}>
                <Text style={S.totalLabel}>Total Present</Text>
                <View style={S.totalBadge}>
                  <Text style={S.totalValue}>{editPresent}</Text>
                </View>
              </View>

              <View style={[S.field, { marginTop: 12 }]}>
                <Text style={S.fieldLabel}>REMARKS</Text>
                <TextInput
                  style={S.textArea}
                  value={editRemarks}
                  onChangeText={setEditRemarks}
                  placeholder="Notes…"
                  placeholderTextColor="#5C6670"
                  multiline
                  numberOfLines={3}
                  textAlignVertical="top"
                />
              </View>

              {editError && (
                <View style={S.errorBox}>
                  <Ionicons name="alert-circle" size={16} color="#D64545" />
                  <Text style={S.errorText}>{editError}</Text>
                </View>
              )}

              <View style={S.editActions}>
                <Pressable style={S.cancelBtn} onPress={() => setEditRecord(null)}>
                  <Text style={S.cancelBtnText}>Cancel</Text>
                </Pressable>
                <Pressable
                  style={({ pressed }) => [S.saveBtn, (editSaving || pressed) && { opacity: 0.85 }]}
                  onPress={handleUpdate}
                  disabled={editSaving}
                >
                  {editSaving
                    ? <ActivityIndicator color="#14181C" size="small" />
                    : <><Ionicons name="checkmark" size={18} color="#14181C" /><Text style={S.saveBtnText}>Save Changes</Text></>
                  }
                </Pressable>
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const S = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#14181C' },
  scroll:   { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 40 },
  centered: { alignItems: 'center', gap: 8, paddingVertical: 32 },
  muted:    { color: '#5C6670', fontSize: 13 },

  backBtn:  { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 12 },
  backText: { color: '#8A96A3', fontSize: 15 },

  title:    { color: '#ECEFF2', fontSize: 23, fontWeight: '800' },
  subtitle: { color: '#8A96A3', fontSize: 13, marginTop: 4, marginBottom: 16 },

  sectionLabel: {
    color: '#F2A93B', fontSize: 11.5, fontWeight: '800',
    letterSpacing: 1.4, marginBottom: 10, marginTop: 4,
  },
  fieldLabel: {
    color: '#8A96A3', fontSize: 11, fontWeight: '700',
    letterSpacing: 0.8, marginBottom: 6,
  },
  field: { marginBottom: 12 },
  row:   { flexDirection: 'row', gap: 10 },

  // Date pill
  datePill: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C',
    borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, marginBottom: 18,
  },
  datePillText: { color: '#ECEFF2', fontWeight: '700', fontSize: 14, flex: 1 },
  datePillLive: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  liveDot:      { width: 7, height: 7, borderRadius: 4, backgroundColor: '#4C9A6A' },
  liveTxt:      { color: '#4C9A6A', fontSize: 10, fontWeight: '800', letterSpacing: 1 },

  // Picker
  pickerBox: {
    backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C',
    borderRadius: 10, paddingHorizontal: 12, height: 48,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  pickerText:        { color: '#ECEFF2', fontSize: 14, flex: 1, marginRight: 6 },
  pickerPlaceholder: { color: '#5C6670' },

  // Counters
  countersGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 4 },

  fetchHint: { color: '#5C6670', fontSize: 12, marginBottom: 12, lineHeight: 16 },
  dupeBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: '#F2A93B1A', borderWidth: 1, borderColor: '#F2A93B55',
    borderRadius: 10, padding: 12, marginBottom: 14,
  },
  dupeBannerText: { color: '#F2A93B', fontSize: 12.5, flex: 1, lineHeight: 17 },
  fetchBtn: {
    height: 52, borderRadius: 12, backgroundColor: '#3E7CB1',
    alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8, marginBottom: 14,
  },
  fetchBtnDisabled: { opacity: 0.5 },
  fetchBtnText: { color: '#14181C', fontSize: 15, fontWeight: '800' },
  statCard: {
    flex: 1, backgroundColor: '#1D2329', borderRadius: 12,
    borderWidth: 1, padding: 14, alignItems: 'center',
  },
  statCardValue: { fontSize: 26, fontWeight: '900', marginBottom: 4 },
  statCardLabel: { color: '#8A96A3', fontSize: 11, fontWeight: '700', letterSpacing: 0.4 },
  counterWrap: {
    width: '47%',
    backgroundColor: '#1D2329', borderRadius: 12,
    borderWidth: 1, borderColor: '#2C343C',
    padding: 14, alignItems: 'center',
  },
  counterLabel: {
    color: '#8A96A3', fontSize: 11.5, fontWeight: '700',
    letterSpacing: 0.6, marginBottom: 8, alignSelf: 'flex-start',
  },
  counterBigNum: {
    color: '#ECEFF2', fontSize: 36, fontWeight: '900',
    lineHeight: 42, marginBottom: 12,
  },
  counterRow: { flexDirection: 'row', gap: 12, alignItems: 'center' },
  counterBtn: {
    width: 44, height: 44, borderRadius: 10,
    borderWidth: 1, borderColor: '#2C343C', backgroundColor: '#0F1417',
    alignItems: 'center', justifyContent: 'center',
  },
  counterBtnPlus: { borderColor: '#3A434C', backgroundColor: '#1A2028' },
  counterInput: {
    // kept for edit modal compat but not used in main counter anymore
    flex: 1, height: 44, backgroundColor: '#0F1417',
    borderWidth: 1, borderColor: '#2C343C', borderRadius: 8,
    color: '#ECEFF2', fontSize: 18, fontWeight: '800', textAlign: 'center',
    paddingVertical: 0,
  },

  // Total
  totalRow:   { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  totalLabel: { color: '#8A96A3', fontSize: 14, fontWeight: '700' },
  totalBadge: {
    backgroundColor: '#F2A93B22', borderWidth: 1.5, borderColor: '#F2A93B',
    borderRadius: 20, paddingHorizontal: 18, paddingVertical: 6,
  },
  totalValue: { color: '#F2A93B', fontSize: 22, fontWeight: '900' },

  // Remarks
  textArea: {
    backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C',
    borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10,
    minHeight: 80, color: '#ECEFF2', fontSize: 14.5, lineHeight: 20,
  },

  // Error
  errorBox: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: '#D6454522', borderWidth: 1, borderColor: '#D64545',
    borderRadius: 10, padding: 12, marginBottom: 14,
  },
  errorText: { color: '#F0A8A8', fontSize: 13, flex: 1 },

  // Submit
  submitBtn: {
    height: 56, borderRadius: 12, backgroundColor: '#4C9A6A',
    alignItems: 'center', justifyContent: 'center',
    flexDirection: 'row', gap: 8,
  },
  submitText: { color: '#fff', fontSize: 16, fontWeight: '900' },

  divider: { height: 1, backgroundColor: '#2C343C', marginVertical: 22 },

  // View toggle
  viewToggle: {
    flexDirection: 'row', backgroundColor: '#1D2329', borderWidth: 1,
    borderColor: '#2C343C', borderRadius: 10, padding: 4, marginBottom: 14, gap: 4,
  },
  toggleBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 6, paddingVertical: 10, borderRadius: 8,
  },
  toggleBtnActive:     { backgroundColor: '#F2A93B' },
  toggleBtnText:       { color: '#8A96A3', fontWeight: '700', fontSize: 13 },
  toggleBtnTextActive: { color: '#14181C' },

  // Filter chips
  filterChip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    borderWidth: 1, borderColor: '#2C343C', backgroundColor: '#1D2329',
    borderRadius: 16, paddingHorizontal: 12, paddingVertical: 7,
  },
  filterChipActive:    { borderColor: '#F2A93B', backgroundColor: '#F2A93B11' },
  filterChipText:      { color: '#8A96A3', fontSize: 12.5, fontWeight: '600' },
  filterChipTextActive:{ color: '#F2A93B' },

  // Record card
  recordCard: {
    backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C',
    borderRadius: 12, padding: 14, marginBottom: 10,
  },
  recordHeader:   { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 },
  recordDate:     { color: '#ECEFF2', fontWeight: '800', fontSize: 14 },
  recordLocation: { color: '#8A96A3', fontSize: 12, marginTop: 2 },
  editBtn: {
    width: 32, height: 32, borderRadius: 8, borderWidth: 1, borderColor: '#3E7CB133',
    backgroundColor: '#3E7CB111', alignItems: 'center', justifyContent: 'center',
  },
  recordCounts: { flexDirection: 'row', gap: 8, marginBottom: 10 },
  countChip: {
    flex: 1, backgroundColor: '#14181C', borderRadius: 8,
    borderWidth: 1, borderColor: '#2C343C', alignItems: 'center', paddingVertical: 8,
  },
  countChipNum: { fontSize: 18, fontWeight: '900' },
  countChipLbl: { color: '#5C6670', fontSize: 10, marginTop: 2 },
  recordFooter:     { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  totalPresentBadge:{ backgroundColor: '#4C9A6A22', borderWidth: 1, borderColor: '#4C9A6A', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 },
  totalPresentTxt:  { color: '#4C9A6A', fontWeight: '700', fontSize: 12 },
  recordRemarks:    { color: '#5C6670', fontSize: 12, flex: 1 },

  // Monthly calendar
  monthNav: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  monthNavBtn:   { padding: 8, borderRadius: 8, borderWidth: 1, borderColor: '#2C343C', backgroundColor: '#1D2329' },
  monthNavLabel: { color: '#ECEFF2', fontSize: 17, fontWeight: '800' },

  monthBlock: { backgroundColor: '#1D2329', borderRadius: 12, borderWidth: 1, borderColor: '#2C343C', padding: 12, marginBottom: 4 },
  monthHeader: { marginBottom: 12 },
  monthTitle:  { color: '#ECEFF2', fontWeight: '800', fontSize: 15, marginBottom: 8 },
  monthStats:  { flexDirection: 'row', gap: 8 },
  statChip: {
    flex: 1, backgroundColor: '#14181C', borderRadius: 8, borderWidth: 1,
    borderColor: '#2C343C', alignItems: 'center', paddingVertical: 8,
  },
  statChipLabel: { color: '#5C6670', fontSize: 10, marginBottom: 2 },
  statChipValue: { color: '#F2A93B', fontWeight: '800', fontSize: 15 },

  calRow:  { flexDirection: 'row' },
  calDow:  { flex: 1, textAlign: 'center', color: '#5C6670', fontSize: 11, fontWeight: '700', paddingBottom: 6 },
  calCell: { flex: 1, aspectRatio: 1, alignItems: 'center', justifyContent: 'center', borderRadius: 6, margin: 1 },
  calCellFilled: { backgroundColor: '#3E7CB122', borderWidth: 1, borderColor: '#3E7CB144' },
  calCellToday:  { borderWidth: 1.5, borderColor: '#F2A93B' },
  calDayNum:     { color: '#8A96A3', fontSize: 11, fontWeight: '600' },
  calDayToday:   { color: '#F2A93B', fontWeight: '800' },
  calCount:      { color: '#3E7CB1', fontSize: 10, fontWeight: '800' },

  // Monthly day breakdown rows
  monthDayRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#1D2329',
  },
  monthDayDate:       { width: 42, alignItems: 'center', marginRight: 10 },
  monthDayNum:        { color: '#ECEFF2', fontWeight: '800', fontSize: 16 },
  monthDayName:       { color: '#5C6670', fontSize: 11 },
  monthDayLocation:   { color: '#8A96A3', fontSize: 12.5, alignSelf: 'center' },
  monthDayPresent:    { alignItems: 'center', marginLeft: 'auto' },
  monthDayPresentNum: { color: '#4C9A6A', fontWeight: '900', fontSize: 17 },
  monthDayPresentLbl: { color: '#5C6670', fontSize: 10 },

  // Modals
  modalOverlay: { flex: 1, backgroundColor: '#000000AA', alignItems: 'center', justifyContent: 'center', padding: 20 },
  modalCard:    { width: '100%', maxWidth: 480, backgroundColor: '#14181C', borderRadius: 14, maxHeight: '75%', padding: 16, borderWidth: 1, borderColor: '#2C343C' },
  modalTitle:   { color: '#ECEFF2', fontSize: 18, fontWeight: '800', marginBottom: 12 },
  modalRow:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 13, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, borderColor: '#2C343C', marginBottom: 8 },
  modalRowSel:     { borderColor: '#F2A93B', backgroundColor: '#F2A93B0D' },
  modalRowText:    { color: '#ECEFF2', fontSize: 15 },
  modalRowTextSel: { color: '#F2A93B', fontWeight: '700' },
  modalFooter:     { paddingTop: 10, borderTopWidth: 1, borderTopColor: '#2C343C', alignItems: 'flex-end' },
  modalCancelBtn:  { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: '#2C343C' },
  modalCancelText: { color: '#ECEFF2', fontWeight: '600' },

  // Edit modal
  editOverlay: { flex: 1, backgroundColor: '#000000BB', justifyContent: 'flex-end' },
  editCard: { backgroundColor: '#14181C', borderTopLeftRadius: 20, borderTopRightRadius: 20, borderWidth: 1, borderBottomWidth: 0, borderColor: '#2C343C', maxHeight: '88%' },
  editHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 18, paddingBottom: 14, borderBottomWidth: 1, borderBottomColor: '#2C343C' },
  editTitle:    { color: '#ECEFF2', fontSize: 18, fontWeight: '800' },
  editSubtitle: { color: '#8A96A3', fontSize: 12, marginTop: 2 },
  editScroll:   { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 32 },
  editActions: { flexDirection: 'row', gap: 10, marginTop: 18 },
  cancelBtn:     { flex: 1, height: 50, borderRadius: 12, borderWidth: 1, borderColor: '#2C343C', alignItems: 'center', justifyContent: 'center' },
  cancelBtnText: { color: '#8A96A3', fontSize: 15, fontWeight: '700' },
  saveBtn:       { flex: 2, height: 50, borderRadius: 12, backgroundColor: '#F2A93B', alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 6 },
  saveBtnText:   { color: '#14181C', fontSize: 15, fontWeight: '900' },
});