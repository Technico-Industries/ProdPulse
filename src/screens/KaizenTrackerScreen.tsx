// src/screens/KaizenTrackerScreen.tsx
//
// Kaizen Tracker
// Logs continuous-improvement ideas raised on the floor.
// Firestore collection: `kaizenRecords`
//
// Columns:
//  S.No | Date | Plant | Workshop | Division | Employee Name | Employee Code
//  Improvement Identified | Kaizen Idea | Category | Priority
//  Action Taken | Responsibility | Target Date | Status | Result | Remarks

import React, { useCallback, useEffect, useState } from 'react';
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
  doc,
  getDoc,
  updateDoc,
} from 'firebase/firestore';
import { db } from '../services/firebase';
import { useAuthStore } from '../stores/authStore';
import { PLANTS, WORKSHOPS, DIVISIONS } from '../constants/lineOptions';

// ─── Types ────────────────────────────────────────────────────────────────────

type KaizenStatus   = 'Open' | 'In Progress' | 'Implemented' | 'Closed' | 'Rejected';
type KaizenPriority = 'Low' | 'Medium' | 'High';
type KaizenCategory = 'Safety' | 'Quality' | 'Productivity' | 'Cost' | 'Delivery' | 'Morale' | 'Environment';

interface KaizenRecord {
  id: string;
  sNo: number;
  date: string;          // DD-MM-YY
  plant: string;
  workshop: string;
  division: string;
  employeeName: string;
  employeeCode: string;
  improvementIdentified: string;
  kaizenIdea: string;
  category: KaizenCategory | '';
  priority: KaizenPriority | '';
  actionTaken: string;
  responsibility: string;
  targetDate: string;    // DD-MM-YY
  status: KaizenStatus | '';
  result: string;
  remarks: string;
  submittedBy: string;
  createdAt: any;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const CATEGORIES: { value: KaizenCategory; color: string }[] = [
  { value: 'Safety',       color: '#D64545' },
  { value: 'Quality',      color: '#3E7CB1' },
  { value: 'Productivity', color: '#F2A93B' },
  { value: 'Cost',         color: '#4C9A6A' },
  { value: 'Delivery',     color: '#8A5CF5' },
  { value: 'Morale',       color: '#E07B39' },
  { value: 'Environment',  color: '#4ABFBF' },
];

const PRIORITIES: { value: KaizenPriority; color: string; bg: string }[] = [
  { value: 'Low',    color: '#4C9A6A', bg: '#4C9A6A22' },
  { value: 'Medium', color: '#F2A93B', bg: '#F2A93B22' },
  { value: 'High',   color: '#D64545', bg: '#D6454522' },
];

const STATUSES: { value: KaizenStatus; color: string }[] = [
  { value: 'Open',         color: '#D64545' },
  { value: 'In Progress',  color: '#F2A93B' },
  { value: 'Implemented',  color: '#4C9A6A' },
  { value: 'Closed',       color: '#8A96A3' },
  { value: 'Rejected',     color: '#5C6670' },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function todayDDMMYY() {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yy = String(d.getFullYear()).slice(-2);
  return `${dd}-${mm}-${yy}`;
}

function formatDate(raw: string) {
  const d = raw.replace(/\D/g, '').slice(0, 6);
  if (d.length <= 2) return d;
  if (d.length <= 4) return `${d.slice(0, 2)}-${d.slice(2)}`;
  return `${d.slice(0, 2)}-${d.slice(2, 4)}-${d.slice(4)}`;
}

function catColor(v: string) {
  return CATEGORIES.find((c) => c.value === v)?.color ?? '#8A96A3';
}
function priConfig(v: string) {
  return PRIORITIES.find((p) => p.value === v) ?? PRIORITIES[1];
}
function stColor(v: string) {
  return STATUSES.find((s) => s.value === v)?.color ?? '#8A96A3';
}

// ─── Small reusable components ────────────────────────────────────────────────

function SLabel({ t }: { t: string }) {
  return <Text style={S.sectionLabel}>{t}</Text>;
}
function FLabel({ t }: { t: string }) {
  return <Text style={S.fieldLabel}>{t}</Text>;
}

function Field({
  label, value, onChange, placeholder, multiline, lines,
}: {
  label: string; value: string; onChange: (v: string) => void;
  placeholder?: string; multiline?: boolean; lines?: number;
}) {
  return (
    <View style={S.field}>
      <FLabel t={label} />
      <TextInput
        style={multiline ? S.textArea : S.input}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder ?? ''}
        placeholderTextColor="#5C6670"
        multiline={multiline}
        numberOfLines={lines ?? 1}
        textAlignVertical={multiline ? 'top' : 'center'}
      />
    </View>
  );
}

function DateField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <View style={S.field}>
      <FLabel t={label} />
      <View style={S.dateRow}>
        <Ionicons name="calendar-outline" size={15} color="#5C6670" style={{ marginRight: 6 }} />
        <TextInput
          style={[S.input, { flex: 1, height: 44 }]}
          value={value}
          onChangeText={(t) => onChange(formatDate(t))}
          placeholder="DD-MM-YY"
          placeholderTextColor="#5C6670"
          keyboardType="number-pad"
          maxLength={8}
        />
      </View>
    </View>
  );
}

function PickerBtn({
  label, value, placeholder, onPress,
}: { label: string; value: string; placeholder: string; onPress: () => void }) {
  return (
    <View style={S.field}>
      <FLabel t={label} />
      <Pressable style={S.pickerBox} onPress={onPress}>
        <Text style={[S.pickerText, !value && S.pickerPlh]}>{value || placeholder}</Text>
        <Ionicons name="chevron-down" size={17} color="#5C6670" />
      </Pressable>
    </View>
  );
}

function PickerModal({
  visible, title, options, value, onSelect, onClose,
}: {
  visible: boolean; title: string; options: string[];
  value: string; onSelect: (v: string) => void; onClose: () => void;
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
                {value === o && <Ionicons name="checkmark" size={18} color="#4C9A6A" />}
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

function ChipRow<T extends string>({
  options, value, onChange,
}: { options: { value: T; color: string; bg?: string }[]; value: T | ''; onChange: (v: T) => void }) {
  return (
    <View style={S.chipsRow}>
      {options.map((o) => {
        const sel = value === o.value;
        return (
          <Pressable
            key={o.value}
            onPress={() => onChange(o.value)}
            style={[S.chip, sel && { borderColor: o.color, backgroundColor: o.bg ?? o.color + '22' }]}
          >
            <Text style={[S.chipText, sel && { color: o.color }]}>{o.value}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// ─── Records table ────────────────────────────────────────────────────────────

const COLS = [
  { key: 'sNo',                   label: 'S.No',          w: 52  },
  { key: 'date',                  label: 'Date',          w: 76  },
  { key: 'division',              label: 'Division',      w: 96  },
  { key: 'employeeName',          label: 'Employee',      w: 110 },
  { key: 'employeeCode',          label: 'Code',          w: 72  },
  { key: 'category',              label: 'Category',      w: 96  },
  { key: 'priority',              label: 'Priority',      w: 72  },
  { key: 'improvementIdentified', label: 'Improvement',   w: 170 },
  { key: 'kaizenIdea',            label: 'Kaizen Idea',   w: 180 },
  { key: 'actionTaken',           label: 'Action',        w: 150 },
  { key: 'responsibility',        label: 'Responsible',   w: 100 },
  { key: 'targetDate',            label: 'Target',        w: 76  },
  { key: 'status',                label: 'Status',        w: 96  },
  { key: 'result',                label: 'Result',        w: 140 },
];
const EDIT_W    = 44;
const TOTAL_W   = COLS.reduce((s, c) => s + c.w, 0) + EDIT_W;

function RecordsTable({
  records, loading, onEdit,
}: { records: KaizenRecord[]; loading: boolean; onEdit: (r: KaizenRecord) => void }) {
  if (loading) return (
    <View style={S.tableCenter}><ActivityIndicator color="#4C9A6A" /><Text style={S.muted}>Loading…</Text></View>
  );
  if (records.length === 0) return (
    <View style={S.tableCenter}>
      <Ionicons name="bulb-outline" size={28} color="#5C6670" />
      <Text style={S.muted}>No Kaizen records yet</Text>
    </View>
  );

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator>
      <View style={{ width: TOTAL_W }}>
        <View style={[S.tableRow, S.tableHeader]}>
          <View style={[S.th, { width: EDIT_W }]} />
          {COLS.map((c) => (
            <View key={c.key} style={[S.th, { width: c.w }]}>
              <Text style={S.thText}>{c.label}</Text>
            </View>
          ))}
        </View>
        {records.map((r, idx) => (
          <View key={r.id} style={[S.tableRow, idx % 2 === 1 && S.tableRowAlt]}>
            <Pressable
              style={[S.td, { width: EDIT_W, alignItems: 'center', justifyContent: 'center' }]}
              onPress={() => onEdit(r)} hitSlop={8}
            >
              <Ionicons name="pencil" size={13} color="#3E7CB1" />
            </Pressable>
            {COLS.map((c) => {
              const val = String((r as any)[c.key] ?? '—');
              let color: string | undefined;
              if (c.key === 'category') color = catColor(val);
              if (c.key === 'priority') color = priConfig(val).color;
              if (c.key === 'status')   color = stColor(val);
              return (
                <View key={c.key} style={[S.td, { width: c.w }]}>
                  <Text style={[S.tdText, color ? { color, fontWeight: '700' } : {}]} numberOfLines={3}>
                    {val}
                  </Text>
                </View>
              );
            })}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

// ─── Empty form ───────────────────────────────────────────────────────────────

const EMPTY_FORM = {
  plant: '', workshop: '', division: '',
  employeeName: '', employeeCode: '',
  improvementIdentified: '', kaizenIdea: '',
  category: '' as KaizenCategory | '',
  priority: '' as KaizenPriority | '',
  actionTaken: '', responsibility: '',
  targetDate: '',
  status: '' as KaizenStatus | '',
  result: '', remarks: '',
};

type FormState = typeof EMPTY_FORM;

// ─── Form fields renderer (shared by add + edit) ──────────────────────────────

function KaizenForm({
  f, setF,
  plantM, wsM, divM,
}: {
  f: FormState;
  setF: React.Dispatch<React.SetStateAction<FormState>>;
  plantM: () => void; wsM: () => void; divM: () => void;
}) {
  const set = (k: keyof FormState) => (v: any) => setF((p) => ({ ...p, [k]: v }));
  return (
    <>
      {/* Location */}
      <SLabel t="LOCATION" />
      <View style={S.row}>
        <View style={{ flex: 1 }}>
          <PickerBtn label="PLANT"    value={f.plant}    placeholder="Select plant"    onPress={plantM} />
        </View>
        <View style={{ flex: 1 }}>
          <PickerBtn label="WORKSHOP" value={f.workshop} placeholder="Select workshop" onPress={wsM} />
        </View>
      </View>
      <PickerBtn label="DIVISION" value={f.division} placeholder="Select division" onPress={divM} />

      {/* Employee */}
      <SLabel t="EMPLOYEE" />
      <View style={S.row}>
        <View style={{ flex: 2 }}>
          <Field label="EMPLOYEE NAME" value={f.employeeName} onChange={set('employeeName')} placeholder="Full name" />
        </View>
        <View style={{ flex: 1 }}>
          <Field label="EMP. CODE" value={f.employeeCode} onChange={set('employeeCode')} placeholder="e.g. EMP-12" />
        </View>
      </View>

      {/* Core idea */}
      <SLabel t="KAIZEN IDEA" />
      <Field
        label="EMPLOYEE IDENTIFIES IMPROVEMENT"
        value={f.improvementIdentified}
        onChange={set('improvementIdentified')}
        placeholder="What problem or waste did the employee identify?"
        multiline lines={3}
      />
      <Field
        label="KAIZEN IDEA SUBMITTED"
        value={f.kaizenIdea}
        onChange={set('kaizenIdea')}
        placeholder="The specific improvement idea proposed by the employee…"
        multiline lines={4}
      />

      {/* Category & Priority */}
      <SLabel t="CLASSIFICATION" />
      <View style={S.field}>
        <FLabel t="CATEGORY" />
        <ChipRow options={CATEGORIES} value={f.category} onChange={set('category')} />
      </View>
      <View style={S.field}>
        <FLabel t="PRIORITY" />
        <ChipRow options={PRIORITIES} value={f.priority} onChange={set('priority')} />
      </View>

      {/* Action */}
      <SLabel t="ACTION & RESPONSIBILITY" />
      <Field
        label="ACTION TAKEN"
        value={f.actionTaken}
        onChange={set('actionTaken')}
        placeholder="Steps taken to implement or review the idea…"
        multiline lines={3}
      />
      <View style={S.row}>
        <View style={{ flex: 1 }}>
          <Field label="RESPONSIBILITY" value={f.responsibility} onChange={set('responsibility')} placeholder="e.g. Maintenance, IE" />
        </View>
        <View style={{ flex: 1 }}>
          <DateField label="TARGET DATE" value={f.targetDate} onChange={set('targetDate')} />
        </View>
      </View>

      {/* Status */}
      <SLabel t="STATUS & RESULT" />
      <View style={S.field}>
        <FLabel t="STATUS" />
        <ChipRow options={STATUSES} value={f.status} onChange={set('status')} />
      </View>
      <Field
        label="RESULT / IMPACT"
        value={f.result}
        onChange={set('result')}
        placeholder="What was the measurable outcome after implementation?"
        multiline lines={2}
      />
      <Field
        label="REMARKS"
        value={f.remarks}
        onChange={set('remarks')}
        placeholder="Any additional notes…"
        multiline lines={2}
      />
    </>
  );
}

// ─── Main Screen ──────────────────────────────────────────────────────────────

export default function KaizenTrackerScreen() {
  const navigation = useNavigation<any>();
  const user = useAuthStore((s) => s.user);

  const today = todayDDMMYY();

  // Form
  const [f, setF] = useState<FormState>({ ...EMPTY_FORM });

  // Pickers (form)
  const [plantM,    setPlantM]    = useState(false);
  const [wsM,       setWsM]       = useState(false);
  const [divM,      setDivM]      = useState(false);

  // Records
  const [records,   setRecords]   = useState<KaizenRecord[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [showTable, setShowTable] = useState(false);

  // Submit
  const [submitting, setSubmitting] = useState(false);
  const [formError,  setFormError]  = useState<string | null>(null);

  // Edit
  const [editRecord,  setEditRecord]  = useState<KaizenRecord | null>(null);
  const [editF,       setEditF]       = useState<FormState>({ ...EMPTY_FORM });
  const [editPlantM,  setEditPlantM]  = useState(false);
  const [editWsM,     setEditWsM]     = useState(false);
  const [editDivM,    setEditDivM]    = useState(false);
  const [editSaving,  setEditSaving]  = useState(false);
  const [editError,   setEditError]   = useState<string | null>(null);

  // Load records
  const loadRecords = useCallback(async () => {
    setLoading(true);
    try {
      const snap = await getDocs(
        query(collection(db, 'kaizenRecords'), orderBy('sNo', 'asc'))
      );
      setRecords(snap.docs.map((d) => {
        const data: any = d.data();
        return {
          id:                    d.id,
          sNo:                   data.sNo                   ?? 0,
          date:                  data.date                  ?? '',
          plant:                 data.plant                 ?? '',
          workshop:              data.workshop              ?? '',
          division:              data.division              ?? '',
          employeeName:          data.employeeName          ?? '',
          employeeCode:          data.employeeCode          ?? '',
          improvementIdentified: data.improvementIdentified ?? '',
          kaizenIdea:            data.kaizenIdea            ?? '',
          category:              data.category              ?? '',
          priority:              data.priority              ?? '',
          actionTaken:           data.actionTaken           ?? '',
          responsibility:        data.responsibility        ?? '',
          targetDate:            data.targetDate            ?? '',
          status:                data.status                ?? '',
          result:                data.result                ?? '',
          remarks:               data.remarks               ?? '',
          submittedBy:           data.submittedBy           ?? '',
          createdAt:             data.createdAt,
        };
      }));
    } catch (e) { console.error('loadRecords', e); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { loadRecords(); }, [loadRecords]);

  // Auto-fill Employee Name / Employee Code from the logged-in user's own
  // profile (users/{uid}), same source RecordProductionScreen uses for
  // supervisor name/code. Still editable in case someone is logging on
  // behalf of another employee.
  useEffect(() => {
    if (!user?.uid) return;
    (async () => {
      try {
        const snap = await getDoc(doc(db, 'users', user.uid));
        if (!snap.exists()) return;
        const data: any = snap.data();
        setF((prev) => ({
          ...prev,
          employeeName: prev.employeeName || data.name || user.name || '',
          employeeCode: prev.employeeCode || data.employeeCode || '',
        }));
      } catch (e) {
        console.error('[Kaizen] auto-fill profile failed:', e);
      }
    })();
  }, [user?.uid]);

  // Validate
  const validate = (d: FormState): string | null => {
    if (!d.plant)                        return 'Select a plant.';
    if (!d.workshop)                     return 'Select a workshop.';
    if (!d.division)                     return 'Select a division.';
    if (!d.employeeName.trim())          return 'Enter employee name.';
    if (!d.improvementIdentified.trim()) return 'Describe the improvement identified.';
    if (!d.kaizenIdea.trim())            return 'Enter the Kaizen idea.';
    if (!d.category)                     return 'Select a category.';
    if (!d.priority)                     return 'Select priority.';
    if (!d.responsibility.trim())        return 'Enter responsibility.';
    if (!d.status)                       return 'Select a status.';
    return null;
  };

  // Submit
  const handleSubmit = async () => {
    const err = validate(f);
    if (err) { setFormError(err); return; }
    setFormError(null);
    setSubmitting(true);
    try {
      const sNo = records.length + 1;
      await addDoc(collection(db, 'kaizenRecords'), {
        sNo,
        date:                  today,
        plant:                 f.plant,
        workshop:              f.workshop,
        division:              f.division,
        employeeName:          f.employeeName.trim(),
        employeeCode:          f.employeeCode.trim(),
        improvementIdentified: f.improvementIdentified.trim(),
        kaizenIdea:            f.kaizenIdea.trim(),
        category:              f.category,
        priority:              f.priority,
        actionTaken:           f.actionTaken.trim(),
        responsibility:        f.responsibility.trim(),
        targetDate:            f.targetDate.trim(),
        status:                f.status,
        result:                f.result.trim(),
        remarks:               f.remarks.trim(),
        submittedBy:           user?.name ?? user?.email ?? 'Unknown',
        submittedByUid:        user?.uid ?? null,
        createdAt:             serverTimestamp(),
      });
      setF({ ...EMPTY_FORM });
      Alert.alert('Saved', `Kaizen record #${sNo} saved.`);
      loadRecords();
    } catch (e) {
      console.error('submit', e);
      setFormError('Could not save. Check your connection.');
    } finally { setSubmitting(false); }
  };

  // Open edit
  const openEdit = (r: KaizenRecord) => {
    setEditRecord(r);
    setEditF({
      plant: r.plant, workshop: r.workshop, division: r.division,
      employeeName: r.employeeName, employeeCode: r.employeeCode,
      improvementIdentified: r.improvementIdentified, kaizenIdea: r.kaizenIdea,
      category: r.category, priority: r.priority,
      actionTaken: r.actionTaken, responsibility: r.responsibility,
      targetDate: r.targetDate, status: r.status,
      result: r.result, remarks: r.remarks,
    });
    setEditError(null);
  };

  const handleUpdate = async () => {
    if (!editRecord) return;
    const err = validate(editF);
    if (err) { setEditError(err); return; }
    setEditError(null);
    setEditSaving(true);
    try {
      await updateDoc(doc(db, 'kaizenRecords', editRecord.id), {
        plant:                 editF.plant,
        workshop:              editF.workshop,
        division:              editF.division,
        employeeName:          editF.employeeName.trim(),
        employeeCode:          editF.employeeCode.trim(),
        improvementIdentified: editF.improvementIdentified.trim(),
        kaizenIdea:            editF.kaizenIdea.trim(),
        category:              editF.category,
        priority:              editF.priority,
        actionTaken:           editF.actionTaken.trim(),
        responsibility:        editF.responsibility.trim(),
        targetDate:            editF.targetDate.trim(),
        status:                editF.status,
        result:                editF.result.trim(),
        remarks:               editF.remarks.trim(),
        updatedBy:  user?.name ?? user?.email ?? 'Unknown',
        updatedAt:  serverTimestamp(),
      });
      setEditRecord(null);
      loadRecords();
    } catch (e) {
      console.error('update', e);
      setEditError('Could not save. Check your connection.');
    } finally { setEditSaving(false); }
  };

  // ─── Render ─────────────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={S.safeArea}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={S.scroll} keyboardShouldPersistTaps="handled">

          <Pressable onPress={() => navigation.goBack()} style={S.backBtn} hitSlop={12}>
            <Ionicons name="arrow-back" size={22} color="#8A96A3" />
            <Text style={S.backText}>Back</Text>
          </Pressable>

          <Text style={S.title}>Kaizen Tracker</Text>
          <Text style={S.subtitle}>Log continuous-improvement ideas from the floor</Text>

          {/* Date pill — auto-captured */}
          <View style={S.datePill}>
            <Ionicons name="calendar" size={15} color="#4C9A6A" />
            <Text style={S.datePillText}>{today}</Text>
            <View style={S.livePill}>
              <View style={S.liveDot} />
              <Text style={S.liveTxt}>AUTO DATE</Text>
            </View>
          </View>

          {/* Form */}
          <KaizenForm
            f={f} setF={setF}
            plantM={() => setPlantM(true)}
            wsM={() => setWsM(true)}
            divM={() => setDivM(true)}
          />

          {formError && (
            <View style={S.errorBox}>
              <Ionicons name="alert-circle" size={16} color="#D64545" />
              <Text style={S.errorText}>{formError}</Text>
            </View>
          )}

          <Pressable
            style={({ pressed }) => [S.submitBtn, (submitting || pressed) && { opacity: 0.85 }]}
            onPress={handleSubmit}
            disabled={submitting}
          >
            {submitting
              ? <ActivityIndicator color="#14181C" />
              : <><Ionicons name="bulb" size={20} color="#14181C" /><Text style={S.submitText}>Submit Kaizen</Text></>
            }
          </Pressable>

          {/* Records */}
          <View style={S.divider} />
          <Pressable style={S.tableToggle} onPress={() => setShowTable((v) => !v)}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Ionicons name="list" size={18} color="#4C9A6A" />
              <Text style={S.tableToggleText}>
                {showTable ? 'Hide Records' : `View Records (${records.length})`}
              </Text>
            </View>
            <Ionicons name={showTable ? 'chevron-up' : 'chevron-down'} size={18} color="#4C9A6A" />
          </Pressable>

          {showTable && (
            <View style={S.tableWrap}>
              <RecordsTable records={records} loading={loading} onEdit={openEdit} />
            </View>
          )}

          <View style={{ height: 40 }} />
        </ScrollView>
      </KeyboardAvoidingView>

      {/* Pickers — form */}
      <PickerModal visible={plantM} title="Select Plant"    options={PLANTS}    value={f.plant}    onSelect={(v) => setF((p) => ({ ...p, plant: v }))}    onClose={() => setPlantM(false)} />
      <PickerModal visible={wsM}    title="Select Workshop" options={WORKSHOPS} value={f.workshop} onSelect={(v) => setF((p) => ({ ...p, workshop: v }))} onClose={() => setWsM(false)} />
      <PickerModal visible={divM}   title="Select Division" options={DIVISIONS} value={f.division} onSelect={(v) => setF((p) => ({ ...p, division: v }))} onClose={() => setDivM(false)} />

      {/* ══════════════════════════════
          EDIT MODAL
          ══════════════════════════════ */}
      <Modal visible={editRecord !== null} animationType="slide" transparent>
        <View style={S.editOverlay}>
          <View style={S.editCard}>
            <View style={S.editHeader}>
              <View>
                <Text style={S.editTitle}>Edit Kaizen</Text>
                {editRecord && (
                  <Text style={S.editSubtitle}>
                    #{editRecord.sNo} · {editRecord.date} · {editRecord.employeeName}
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
              showsVerticalScrollIndicator={false}
            >
              <KaizenForm
                f={editF} setF={setEditF}
                plantM={() => setEditPlantM(true)}
                wsM={() => setEditWsM(true)}
                divM={() => setEditDivM(true)}
              />

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

        {/* Nested pickers for edit modal */}
        <PickerModal visible={editPlantM} title="Select Plant"    options={PLANTS}    value={editF.plant}    onSelect={(v) => setEditF((p) => ({ ...p, plant: v }))}    onClose={() => setEditPlantM(false)} />
        <PickerModal visible={editWsM}    title="Select Workshop" options={WORKSHOPS} value={editF.workshop} onSelect={(v) => setEditF((p) => ({ ...p, workshop: v }))} onClose={() => setEditWsM(false)} />
        <PickerModal visible={editDivM}   title="Select Division" options={DIVISIONS} value={editF.division} onSelect={(v) => setEditF((p) => ({ ...p, division: v }))} onClose={() => setEditDivM(false)} />
      </Modal>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const S = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#14181C' },
  scroll:   { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 40 },

  backBtn:  { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 12 },
  backText: { color: '#8A96A3', fontSize: 15 },

  title:    { color: '#ECEFF2', fontSize: 23, fontWeight: '800' },
  subtitle: { color: '#8A96A3', fontSize: 13, marginTop: 4, marginBottom: 14, lineHeight: 18 },

  datePill: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C',
    borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, marginBottom: 18,
  },
  datePillText: { color: '#ECEFF2', fontWeight: '700', fontSize: 14, flex: 1 },
  livePill:     { flexDirection: 'row', alignItems: 'center', gap: 5 },
  liveDot:      { width: 7, height: 7, borderRadius: 4, backgroundColor: '#4C9A6A' },
  liveTxt:      { color: '#4C9A6A', fontSize: 10, fontWeight: '800', letterSpacing: 1 },

  sectionLabel: {
    color: '#4C9A6A', fontSize: 11.5, fontWeight: '800',
    letterSpacing: 1.4, marginBottom: 8, marginTop: 10,
  },
  fieldLabel: {
    color: '#8A96A3', fontSize: 11, fontWeight: '700',
    letterSpacing: 0.6, marginBottom: 6,
  },
  field:  { marginBottom: 12 },
  row:    { flexDirection: 'row', gap: 10 },

  input: {
    backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C',
    borderRadius: 10, paddingHorizontal: 12, height: 48,
    color: '#ECEFF2', fontSize: 14.5,
  },
  textArea: {
    backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C',
    borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10,
    minHeight: 88, color: '#ECEFF2', fontSize: 14.5, lineHeight: 20,
  },
  dateRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C',
    borderRadius: 10, paddingHorizontal: 12, height: 48,
  },
  pickerBox: {
    backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C',
    borderRadius: 10, paddingHorizontal: 12, height: 48,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  pickerText: { color: '#ECEFF2', fontSize: 14, flex: 1, marginRight: 6 },
  pickerPlh:  { color: '#5C6670' },

  chipsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    borderWidth: 1, borderColor: '#2C343C', backgroundColor: '#1D2329',
    borderRadius: 20, paddingHorizontal: 14, paddingVertical: 9,
  },
  chipText: { color: '#8A96A3', fontSize: 12.5, fontWeight: '600' },

  muted: { color: '#5C6670', fontSize: 13 },

  errorBox: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: '#D6454522', borderWidth: 1, borderColor: '#D64545',
    borderRadius: 10, padding: 12, marginBottom: 14,
  },
  errorText: { color: '#F0A8A8', fontSize: 13, flex: 1 },

  submitBtn: {
    height: 56, borderRadius: 12, backgroundColor: '#4C9A6A',
    alignItems: 'center', justifyContent: 'center',
    flexDirection: 'row', gap: 8, marginTop: 6,
  },
  submitText: { color: '#14181C', fontSize: 16, fontWeight: '900' },

  divider:     { height: 1, backgroundColor: '#2C343C', marginVertical: 22 },
  tableToggle: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C',
    borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, marginBottom: 12,
  },
  tableToggleText: { color: '#4C9A6A', fontWeight: '700', fontSize: 14 },
  tableWrap:   { borderWidth: 1, borderColor: '#2C343C', borderRadius: 10, overflow: 'hidden' },
  tableCenter: { alignItems: 'center', gap: 8, paddingVertical: 32 },

  tableRow:    { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#1A1F24' },
  tableHeader: { backgroundColor: '#1A2028', borderBottomColor: '#2C343C' },
  tableRowAlt: { backgroundColor: '#191E24' },
  th:          { paddingHorizontal: 8, paddingVertical: 10 },
  thText:      { color: '#4C9A6A', fontSize: 10.5, fontWeight: '800', letterSpacing: 0.5 },
  td:          { paddingHorizontal: 8, paddingVertical: 9, justifyContent: 'center' },
  tdText:      { color: '#ECEFF2', fontSize: 12, lineHeight: 16 },

  modalOverlay:    { flex: 1, backgroundColor: '#000000AA', alignItems: 'center', justifyContent: 'center', padding: 20 },
  modalCard:       { width: '100%', maxWidth: 480, backgroundColor: '#14181C', borderRadius: 14, maxHeight: '75%', padding: 16, borderWidth: 1, borderColor: '#2C343C' },
  modalTitle:      { color: '#ECEFF2', fontSize: 18, fontWeight: '800', marginBottom: 12 },
  modalRow:        { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 13, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, borderColor: '#2C343C', marginBottom: 8 },
  modalRowSel:     { borderColor: '#4C9A6A', backgroundColor: '#4C9A6A0D' },
  modalRowText:    { color: '#ECEFF2', fontSize: 15 },
  modalRowTextSel: { color: '#4C9A6A', fontWeight: '700' },
  modalFooter:     { paddingTop: 10, borderTopWidth: 1, borderTopColor: '#2C343C', alignItems: 'flex-end' },
  modalCancelBtn:  { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: '#2C343C' },
  modalCancelText: { color: '#ECEFF2', fontWeight: '600' },

  editOverlay:  { flex: 1, backgroundColor: '#000000BB', justifyContent: 'flex-end' },
  editCard:     { backgroundColor: '#14181C', borderTopLeftRadius: 20, borderTopRightRadius: 20, borderWidth: 1, borderBottomWidth: 0, borderColor: '#2C343C', maxHeight: '94%' },
  editHeader:   { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 18, paddingBottom: 14, borderBottomWidth: 1, borderBottomColor: '#2C343C' },
  editTitle:    { color: '#ECEFF2', fontSize: 18, fontWeight: '800' },
  editSubtitle: { color: '#8A96A3', fontSize: 12, marginTop: 2 },
  editScroll:   { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 32 },
  editActions:  { flexDirection: 'row', gap: 10, marginTop: 18 },
  cancelBtn:    { flex: 1, height: 50, borderRadius: 12, borderWidth: 1, borderColor: '#2C343C', alignItems: 'center', justifyContent: 'center' },
  cancelBtnText:{ color: '#8A96A3', fontSize: 15, fontWeight: '700' },
  saveBtn:      { flex: 2, height: 50, borderRadius: 12, backgroundColor: '#4C9A6A', alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 6 },
  saveBtnText:  { color: '#14181C', fontSize: 15, fontWeight: '900' },
});