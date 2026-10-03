// src/screens/NearMissReportScreen.tsx
//
// Near-Miss Report — form + live records table.
// Stores to Firestore collection: `nearMissReports`

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
  updateDoc,
} from 'firebase/firestore';
import { db } from '../services/firebase';
import { useAuthStore } from '../stores/authStore';
import { PLANTS, WORKSHOPS, DIVISIONS } from '../constants/lineOptions';

// ─── Types ────────────────────────────────────────────────────────────────────

type Intensity = 'Low' | 'Medium' | 'High' | 'Critical';
type Status    = 'Open' | 'In Progress' | 'Closed' | 'Pending';

interface NearMissRecord {
  id: string;
  date: string;           // DD-MM-YY
  plant: string;
  workshop: string;
  division: string;
  areaMachine: string;
  intensity: Intensity;
  description: string;
  actionTaken: string;
  tdc: string;            // DD-MM-YY
  responsibility: string;
  status: Status;
  closedOn: string;       // DD-MM-YY or ''
  submittedBy: string;
  createdAt: any;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const INTENSITIES: { value: Intensity; color: string; bg: string }[] = [
  { value: 'Low',      color: '#4C9A6A', bg: '#4C9A6A22' },
  { value: 'Medium',   color: '#F2A93B', bg: '#F2A93B22' },
  { value: 'High',     color: '#E07B39', bg: '#E07B3922' },
  { value: 'Critical', color: '#D64545', bg: '#D6454522' },
];

const STATUSES: { value: Status; color: string }[] = [
  { value: 'Open',        color: '#D64545' },
  { value: 'In Progress', color: '#F2A93B' },
  { value: 'Closed',      color: '#4C9A6A' },
  { value: 'Pending',     color: '#8A96A3' },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Returns today as DD-MM-YY from system clock (no network needed). */
function todayDDMMYY(): string {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yy = String(d.getFullYear()).slice(-2);
  return `${dd}-${mm}-${yy}`;
}

/** Enforce DD-MM-YY format as user types. */
function formatDateInput(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 6);
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}-${digits.slice(2)}`;
  return `${digits.slice(0, 2)}-${digits.slice(2, 4)}-${digits.slice(4)}`;
}

function intensityConfig(v: Intensity) {
  return INTENSITIES.find((i) => i.value === v) ?? INTENSITIES[0];
}
function statusConfig(v: Status) {
  return STATUSES.find((s) => s.value === v) ?? STATUSES[0];
}

// ─── Small reusable components ────────────────────────────────────────────────

function SectionLabel({ children }: { children: string }) {
  return <Text style={S.sectionLabel}>{children}</Text>;
}

function FieldLabel({ children }: { children: string }) {
  return <Text style={S.fieldLabel}>{children}</Text>;
}

function ChipRow<T extends string>({
  options,
  value,
  onChange,
  colorMap,
}: {
  options: { value: T; color: string; bg?: string }[];
  value: T | null;
  onChange: (v: T) => void;
  colorMap?: boolean;
}) {
  return (
    <View style={S.chipsRow}>
      {options.map((opt) => {
        const sel = value === opt.value;
        return (
          <Pressable
            key={opt.value}
            onPress={() => onChange(opt.value)}
            style={[
              S.chip,
              sel && { borderColor: opt.color, backgroundColor: opt.bg ?? opt.color + '22' },
            ]}
          >
            <Text style={[S.chipText, sel && { color: opt.color }]}>{opt.value}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function DateField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <View style={{ flex: 1 }}>
      <FieldLabel>{label}</FieldLabel>
      <View style={S.dateRow}>
        <Ionicons name="calendar-outline" size={16} color="#5C6670" style={{ marginRight: 6 }} />
        <TextInput
          style={[S.input, { flex: 1, height: 44 }]}
          value={value}
          onChangeText={(t) => onChange(formatDateInput(t))}
          placeholder={placeholder ?? 'DD-MM-YY'}
          placeholderTextColor="#5C6670"
          keyboardType="number-pad"
          maxLength={8}
        />
      </View>
    </View>
  );
}

// ─── Records table ────────────────────────────────────────────────────────────

function RecordsTable({ records, loading, onEdit }: { records: NearMissRecord[]; loading: boolean; onEdit: (r: NearMissRecord) => void }) {
  if (loading) {
    return (
      <View style={S.tableLoading}>
        <ActivityIndicator color="#F2A93B" />
        <Text style={S.muted}>Loading records…</Text>
      </View>
    );
  }
  if (records.length === 0) {
    return (
      <View style={S.tableEmpty}>
        <Ionicons name="document-outline" size={28} color="#5C6670" />
        <Text style={S.muted}>No near-miss reports yet</Text>
      </View>
    );
  }

  const COL_WIDTHS = {
    edit:   44,
    date:   70,
    area:   130,
    int:    72,
    desc:   180,
    action: 160,
    tdc:    70,
    resp:   100,
    status: 90,
    closed: 70,
  };
  const totalW = Object.values(COL_WIDTHS).reduce((a, b) => a + b, 0);

  const TH = ({ w, children }: { w: number; children: string }) => (
    <View style={[S.th, { width: w }]}>
      <Text style={S.thText}>{children}</Text>
    </View>
  );
  const TD = ({
    w,
    children,
    color,
    bg,
  }: {
    w: number;
    children: string;
    color?: string;
    bg?: string;
  }) => (
    <View style={[S.td, { width: w }, bg ? { backgroundColor: bg, borderRadius: 4 } : {}]}>
      <Text style={[S.tdText, color ? { color } : {}]} numberOfLines={3}>
        {children}
      </Text>
    </View>
  );

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator>
      <View style={{ width: totalW }}>
        {/* Header */}
        <View style={S.tableHeader}>
          <TH w={COL_WIDTHS.edit}> </TH>
          <TH w={COL_WIDTHS.date}>Date</TH>
          <TH w={COL_WIDTHS.area}>Area / Machine</TH>
          <TH w={COL_WIDTHS.int}>Intensity</TH>
          <TH w={COL_WIDTHS.desc}>Description</TH>
          <TH w={COL_WIDTHS.action}>Action Taken</TH>
          <TH w={COL_WIDTHS.tdc}>TDC</TH>
          <TH w={COL_WIDTHS.resp}>Responsibility</TH>
          <TH w={COL_WIDTHS.status}>Status</TH>
          <TH w={COL_WIDTHS.closed}>Closed On</TH>
        </View>

        {/* Rows */}
        {records.map((r, idx) => {
          const iCfg = intensityConfig(r.intensity);
          const sCfg = statusConfig(r.status);
          return (
            <View
              key={r.id}
              style={[S.tableRow, idx % 2 === 1 && S.tableRowAlt]}
            >
              <Pressable
                style={[S.td, { width: COL_WIDTHS.edit, alignItems: 'center', justifyContent: 'center' }]}
                onPress={() => onEdit(r)}
                hitSlop={8}
              >
                <Ionicons name="pencil" size={14} color="#3E7CB1" />
              </Pressable>
              <TD w={COL_WIDTHS.date}>{r.date}</TD>
              <TD w={COL_WIDTHS.area}>{r.areaMachine}</TD>
              <TD w={COL_WIDTHS.int} color={iCfg.color} bg={iCfg.bg}>
                {r.intensity}
              </TD>
              <TD w={COL_WIDTHS.desc}>{r.description}</TD>
              <TD w={COL_WIDTHS.action}>{r.actionTaken}</TD>
              <TD w={COL_WIDTHS.tdc}>{r.tdc}</TD>
              <TD w={COL_WIDTHS.resp}>{r.responsibility}</TD>
              <TD w={COL_WIDTHS.status} color={sCfg.color}>
                {r.status}
              </TD>
              <TD w={COL_WIDTHS.closed}>{r.closedOn || '—'}</TD>
            </View>
          );
        })}
      </View>
    </ScrollView>
  );
}

// ─── Main Screen ──────────────────────────────────────────────────────────────

export default function NearMissReportScreen() {
  const navigation = useNavigation<any>();
  const user = useAuthStore((s) => s.user);

  // ── Form state
  const [plant,          setPlant]          = useState<string | null>(null);
  const [workshop,       setWorkshop]       = useState<string | null>(null);
  const [division,       setDivision]       = useState<string | null>(null);
  const [date,           setDate]           = useState(todayDDMMYY());
  const [areaMachine,    setAreaMachine]    = useState('');
  const [intensity,      setIntensity]      = useState<Intensity | null>(null);
  const [description,    setDescription]    = useState('');
  const [actionTaken,    setActionTaken]    = useState('');
  const [tdc,            setTdc]            = useState('');
  const [responsibility, setResponsibility] = useState('');
  const [status,         setStatus]         = useState<Status | null>(null);
  const [closedOn,       setClosedOn]       = useState('');

  // ── Records
  const [records,        setRecords]        = useState<NearMissRecord[]>([]);
  const [recordsLoading, setRecordsLoading] = useState(true);

  // ── UI
  const [submitting, setSubmitting] = useState(false);
  const [formError,  setFormError]  = useState<string | null>(null);
  const [showTable,  setShowTable]  = useState(false);

  // ── Edit modal
  const [editRecord,       setEditRecord]       = useState<NearMissRecord | null>(null);
  const [editPlant,        setEditPlant]        = useState('');
  const [editWorkshop,     setEditWorkshop]     = useState('');
  const [editDivision,     setEditDivision]     = useState('');
  const [editDate,         setEditDate]         = useState('');
  const [editArea,         setEditArea]         = useState('');
  const [editIntensity,    setEditIntensity]    = useState<Intensity | null>(null);
  const [editDesc,         setEditDesc]         = useState('');
  const [editAction,       setEditAction]       = useState('');
  const [editTdc,          setEditTdc]          = useState('');
  const [editResp,         setEditResp]         = useState('');
  const [editStatus,       setEditStatus]       = useState<Status | null>(null);
  const [editClosedOn,     setEditClosedOn]     = useState('');
  const [editSubmitting,   setEditSubmitting]   = useState(false);
  const [editError,        setEditError]        = useState<string | null>(null);
  const [editPlantModal,   setEditPlantModal]   = useState(false);
  const [editWsModal,      setEditWsModal]      = useState(false);
  const [editDivModal,     setEditDivModal]     = useState(false);

  // Plant picker modal
  const [plantModal,    setPlantModal]    = useState(false);
  const [workshopModal, setWorkshopModal] = useState(false);
  const [divisionModal, setDivisionModal] = useState(false);

  // ── Load records
  const loadRecords = useCallback(async () => {
    try {
      setRecordsLoading(true);
      const snap = await getDocs(
        query(collection(db, 'nearMissReports'), orderBy('createdAt', 'desc'))
      );
      const docs: NearMissRecord[] = snap.docs.map((d) => {
        const data: any = d.data();
        return {
          id:             d.id,
          date:           data.date ?? '',
          plant:          data.plant ?? '',
          workshop:       data.workshop ?? '',
          division:       data.division ?? '',
          areaMachine:    data.areaMachine ?? '',
          intensity:      data.intensity ?? 'Low',
          description:    data.description ?? '',
          actionTaken:    data.actionTaken ?? '',
          tdc:            data.tdc ?? '',
          responsibility: data.responsibility ?? '',
          status:         data.status ?? 'Open',
          closedOn:       data.closedOn ?? '',
          submittedBy:    data.submittedBy ?? '',
          createdAt:      data.createdAt,
        };
      });
      setRecords(docs);
    } catch (e) {
      console.error('loadRecords', e);
    } finally {
      setRecordsLoading(false);
    }
  }, []);

  useEffect(() => { loadRecords(); }, [loadRecords]);

  // ── Open edit modal, pre-fill all fields from the record
  const openEdit = (r: NearMissRecord) => {
    setEditRecord(r);
    setEditPlant(r.plant);
    setEditWorkshop(r.workshop);
    setEditDivision(r.division);
    setEditDate(r.date);
    setEditArea(r.areaMachine);
    setEditIntensity(r.intensity);
    setEditDesc(r.description);
    setEditAction(r.actionTaken);
    setEditTdc(r.tdc);
    setEditResp(r.responsibility);
    setEditStatus(r.status);
    setEditClosedOn(r.closedOn ?? '');
    setEditError(null);
  };

  const closeEdit = () => setEditRecord(null);

  const handleUpdate = async () => {
    if (!editRecord) return;
    if (!editPlant)        { setEditError('Select a plant.');            return; }
    if (!editWorkshop)     { setEditError('Select a workshop.');         return; }
    if (!editDivision)     { setEditError('Select a division.');         return; }
    if (!editArea.trim())  { setEditError('Enter area / machine no.');   return; }
    if (!editIntensity)    { setEditError('Select problem intensity.');  return; }
    if (!editDesc.trim())  { setEditError('Enter a description.');       return; }
    if (!editAction.trim()){ setEditError('Enter action taken.');        return; }
    if (!editTdc.trim())   { setEditError('Enter target date (TDC).');  return; }
    if (!editResp.trim())  { setEditError('Enter responsibility.');      return; }
    if (!editStatus)       { setEditError('Select a status.');           return; }
    if (editStatus === 'Closed' && !editClosedOn.trim()) {
      setEditError('Enter the closed-on date since status is Closed.');
      return;
    }
    setEditError(null);
    setEditSubmitting(true);
    try {
      await updateDoc(doc(db, 'nearMissReports', editRecord.id), {
        plant:          editPlant,
        workshop:       editWorkshop,
        division:       editDivision,
        date:           editDate,
        areaMachine:    editArea.trim(),
        intensity:      editIntensity,
        description:    editDesc.trim(),
        actionTaken:    editAction.trim(),
        tdc:            editTdc,
        responsibility: editResp.trim(),
        status:         editStatus,
        closedOn:       editStatus === 'Closed' ? editClosedOn.trim() : '',
        updatedBy:      user?.name ?? user?.email ?? 'Unknown',
        updatedAt:      serverTimestamp(),
      });
      closeEdit();
      loadRecords();
    } catch (e) {
      console.error('handleUpdate', e);
      setEditError('Could not save. Check your connection and try again.');
    } finally {
      setEditSubmitting(false);
    }
  };

  // ── Validate & submit
  const handleSubmit = async () => {
    if (!plant)          { setFormError('Select a plant.');            return; }
    if (!workshop)       { setFormError('Select a workshop.');         return; }
    if (!division)       { setFormError('Select a division.');         return; }
    if (!areaMachine.trim()) { setFormError('Enter area / machine no.'); return; }
    if (!intensity)      { setFormError('Select problem intensity.');  return; }
    if (!description.trim()) { setFormError('Enter a description.');   return; }
    if (!actionTaken.trim()) { setFormError('Enter action taken.');    return; }
    if (!tdc.trim())     { setFormError('Enter target date (TDC).');   return; }
    if (!responsibility.trim()) { setFormError('Enter responsibility.'); return; }
    if (!status)         { setFormError('Select a status.');           return; }
    if (status === 'Closed' && !closedOn.trim()) {
      setFormError('Enter the closed-on date since status is Closed.');
      return;
    }
    setFormError(null);
    setSubmitting(true);
    try {
      await addDoc(collection(db, 'nearMissReports'), {
        date, plant, workshop, division,
        areaMachine:    areaMachine.trim(),
        intensity,
        description:    description.trim(),
        actionTaken:    actionTaken.trim(),
        tdc,
        responsibility: responsibility.trim(),
        status,
        closedOn:       status === 'Closed' ? closedOn.trim() : '',
        submittedBy:    user?.name ?? user?.email ?? 'Unknown',
        submittedByUid: user?.uid ?? null,
        createdAt:      serverTimestamp(),
      });

      // Reset form
      setPlant(null); setWorkshop(null); setDivision(null);
      setDate(todayDDMMYY()); setAreaMachine('');
      setIntensity(null); setDescription(''); setActionTaken('');
      setTdc(''); setResponsibility(''); setStatus(null); setClosedOn('');

      Alert.alert('Submitted', 'Near-miss report saved successfully.');
      loadRecords();
    } catch (e) {
      console.error('submit', e);
      setFormError('Could not submit. Check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  };

  // ─── Render ─────────────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={S.safeArea}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={S.scroll}
          keyboardShouldPersistTaps="handled"
        >
          {/* Back */}
          <Pressable onPress={() => navigation.goBack()} style={S.backBtn} hitSlop={12}>
            <Ionicons name="arrow-back" size={22} color="#8A96A3" />
            <Text style={S.backText}>Back</Text>
          </Pressable>

          <Text style={S.title}>Near-Miss Report</Text>
          <Text style={S.subtitle}>
            Log safety incidents that didn't cause injury so risks are caught early
          </Text>

          {/* ── LOCATION ── */}
          <SectionLabel>LOCATION</SectionLabel>

          <View style={S.field}>
            <FieldLabel>PLANT</FieldLabel>
            <Pressable
              style={S.pickerBox}
              onPress={() => setPlantModal(true)}
            >
              <Text style={[S.pickerText, !plant && S.pickerPlaceholder]}>
                {plant ?? 'Select plant'}
              </Text>
              <Ionicons name="chevron-down" size={18} color="#5C6670" />
            </Pressable>
          </View>

          <View style={S.field}>
            <FieldLabel>WORKSHOP</FieldLabel>
            <Pressable
              style={S.pickerBox}
              onPress={() => setWorkshopModal(true)}
            >
              <Text style={[S.pickerText, !workshop && S.pickerPlaceholder]}>
                {workshop ?? 'Select workshop'}
              </Text>
              <Ionicons name="chevron-down" size={18} color="#5C6670" />
            </Pressable>
          </View>

          <View style={S.field}>
            <FieldLabel>DIVISION</FieldLabel>
            <Pressable
              style={S.pickerBox}
              onPress={() => setDivisionModal(true)}
            >
              <Text style={[S.pickerText, !division && S.pickerPlaceholder]}>
                {division ?? 'Select division'}
              </Text>
              <Ionicons name="chevron-down" size={18} color="#5C6670" />
            </Pressable>
          </View>

          {/* ── DATE + AREA ── */}
          <SectionLabel>INCIDENT DETAILS</SectionLabel>

          <View style={[S.rowGap, { marginBottom: 14 }]}>
            <DateField label="DATE" value={date} onChange={setDate} />
            <View style={{ flex: 1 }}>
              <FieldLabel>AREA / MACHINE NO.</FieldLabel>
              <TextInput
                style={[S.input, { height: 44 }]}
                value={areaMachine}
                onChangeText={setAreaMachine}
                placeholder="e.g. BP-03, Welding Line 2"
                placeholderTextColor="#5C6670"
              />
            </View>
          </View>

          {/* ── INTENSITY ── */}
          <View style={S.field}>
            <FieldLabel>PROBLEM INTENSITY</FieldLabel>
            <ChipRow
              options={INTENSITIES}
              value={intensity}
              onChange={setIntensity}
            />
          </View>

          {/* ── DESCRIPTION ── */}
          <View style={S.field}>
            <FieldLabel>DESCRIPTION</FieldLabel>
            <TextInput
              style={S.textArea}
              value={description}
              onChangeText={setDescription}
              placeholder="Describe what happened and how the incident was near-missed…"
              placeholderTextColor="#5C6670"
              multiline
              numberOfLines={4}
              textAlignVertical="top"
            />
          </View>

          {/* ── ACTION TAKEN ── */}
          <View style={S.field}>
            <FieldLabel>ACTION TAKEN</FieldLabel>
            <TextInput
              style={S.textArea}
              value={actionTaken}
              onChangeText={setActionTaken}
              placeholder="Immediate corrective actions applied…"
              placeholderTextColor="#5C6670"
              multiline
              numberOfLines={3}
              textAlignVertical="top"
            />
          </View>

          {/* ── TDC + RESPONSIBILITY ── */}
          <View style={S.rowGap}>
            <DateField
              label="TDC (Target Date)"
              value={tdc}
              onChange={setTdc}
              placeholder="DD-MM-YY"
            />
            <View style={{ flex: 1 }}>
              <FieldLabel>RESPONSIBILITY</FieldLabel>
              <TextInput
                style={[S.input, { height: 44 }]}
                value={responsibility}
                onChangeText={setResponsibility}
                placeholder="e.g. Maintenance, QC"
                placeholderTextColor="#5C6670"
              />
            </View>
          </View>

          {/* ── STATUS ── */}
          <View style={[S.field, { marginTop: 14 }]}>
            <FieldLabel>STATUS</FieldLabel>
            <ChipRow
              options={STATUSES}
              value={status}
              onChange={(v) => {
                setStatus(v);
                if (v !== 'Closed') setClosedOn('');
              }}
            />
          </View>

          {/* ── CLOSED ON (only when Closed) ── */}
          {status === 'Closed' && (
            <View style={[S.field, { marginTop: 2 }]}>
              <DateField
                label="CLOSED ON"
                value={closedOn}
                onChange={setClosedOn}
              />
            </View>
          )}

          {/* ── ERROR ── */}
          {formError && (
            <View style={S.errorBox}>
              <Ionicons name="alert-circle" size={16} color="#D64545" />
              <Text style={S.errorText}>{formError}</Text>
            </View>
          )}

          {/* ── SUBMIT ── */}
          <Pressable
            style={({ pressed }) => [
              S.submitBtn,
              (submitting || pressed) && { opacity: 0.85 },
            ]}
            onPress={handleSubmit}
            disabled={submitting}
          >
            {submitting ? (
              <ActivityIndicator color="#14181C" />
            ) : (
              <>
                <Ionicons name="checkmark-circle" size={20} color="#14181C" />
                <Text style={S.submitText}>Submit Report</Text>
              </>
            )}
          </Pressable>

          {/* ── RECORDS TABLE ── */}
          <View style={S.divider} />

          <Pressable
            style={S.tableToggle}
            onPress={() => setShowTable((v) => !v)}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Ionicons name="list" size={18} color="#F2A93B" />
              <Text style={S.tableToggleText}>
                {showTable ? 'Hide Records' : `View Records (${records.length})`}
              </Text>
            </View>
            <Ionicons
              name={showTable ? 'chevron-up' : 'chevron-down'}
              size={18}
              color="#F2A93B"
            />
          </Pressable>

          {showTable && (
            <View style={S.tableWrap}>
              <RecordsTable records={records} loading={recordsLoading} onEdit={openEdit} />
            </View>
          )}

          <View style={{ height: 40 }} />
        </ScrollView>
      </KeyboardAvoidingView>

      {/* ── Plant picker modal ── */}
      <Modal visible={plantModal} animationType="slide" transparent>
        <View style={S.modalOverlay}>
          <View style={S.modalCard}>
            <Text style={S.modalTitle}>Select Plant</Text>
            <ScrollView contentContainerStyle={{ paddingBottom: 12 }}>
              {PLANTS.map((p) => (
                <Pressable
                  key={p}
                  style={[S.modalRow, plant === p && S.modalRowSel]}
                  onPress={() => { setPlant(p); setPlantModal(false); }}
                >
                  <Text style={[S.modalRowText, plant === p && S.modalRowTextSel]}>{p}</Text>
                </Pressable>
              ))}
            </ScrollView>
            <View style={S.modalFooter}>
              <Pressable style={S.modalCancelBtn} onPress={() => setPlantModal(false)}>
                <Text style={S.modalCancelText}>Cancel</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* ── Workshop picker modal ── */}
      <Modal visible={workshopModal} animationType="slide" transparent>
        <View style={S.modalOverlay}>
          <View style={S.modalCard}>
            <Text style={S.modalTitle}>Select Workshop</Text>
            <ScrollView contentContainerStyle={{ paddingBottom: 12 }}>
              {WORKSHOPS.map((w) => (
                <Pressable
                  key={w}
                  style={[S.modalRow, workshop === w && S.modalRowSel]}
                  onPress={() => { setWorkshop(w); setWorkshopModal(false); }}
                >
                  <Text style={[S.modalRowText, workshop === w && S.modalRowTextSel]}>{w}</Text>
                </Pressable>
              ))}
            </ScrollView>
            <View style={S.modalFooter}>
              <Pressable style={S.modalCancelBtn} onPress={() => setWorkshopModal(false)}>
                <Text style={S.modalCancelText}>Cancel</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* ── Division picker modal ── */}
      <Modal visible={divisionModal} animationType="slide" transparent>
        <View style={S.modalOverlay}>
          <View style={S.modalCard}>
            <Text style={S.modalTitle}>Select Division</Text>
            <ScrollView contentContainerStyle={{ paddingBottom: 12 }}>
              {DIVISIONS.map((d) => (
                <Pressable
                  key={d}
                  style={[S.modalRow, division === d && S.modalRowSel]}
                  onPress={() => { setDivision(d); setDivisionModal(false); }}
                >
                  <Text style={[S.modalRowText, division === d && S.modalRowTextSel]}>{d}</Text>
                </Pressable>
              ))}
            </ScrollView>
            <View style={S.modalFooter}>
              <Pressable style={S.modalCancelBtn} onPress={() => setDivisionModal(false)}>
                <Text style={S.modalCancelText}>Cancel</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* ═══════════════════════════════════════════════════════
          EDIT RECORD MODAL
          Slides up when user taps the pencil icon on a table row.
          ═══════════════════════════════════════════════════════ */}
      <Modal visible={editRecord !== null} animationType="slide" transparent>
        <View style={S.editOverlay}>
          <View style={S.editCard}>
            {/* Header */}
            <View style={S.editHeader}>
              <Text style={S.editTitle}>Edit Report</Text>
              <Pressable onPress={closeEdit} hitSlop={12} style={S.editCloseBtn}>
                <Ionicons name="close" size={22} color="#8A96A3" />
              </Pressable>
            </View>

            <ScrollView
              contentContainerStyle={S.editScroll}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              {/* Location */}
              <SectionLabel>LOCATION</SectionLabel>
              <View style={S.field}>
                <FieldLabel>PLANT</FieldLabel>
                <Pressable style={S.pickerBox} onPress={() => setEditPlantModal(true)}>
                  <Text style={[S.pickerText, !editPlant && S.pickerPlaceholder]}>
                    {editPlant || 'Select plant'}
                  </Text>
                  <Ionicons name="chevron-down" size={18} color="#5C6670" />
                </Pressable>
              </View>
              <View style={S.field}>
                <FieldLabel>WORKSHOP</FieldLabel>
                <Pressable style={S.pickerBox} onPress={() => setEditWsModal(true)}>
                  <Text style={[S.pickerText, !editWorkshop && S.pickerPlaceholder]}>
                    {editWorkshop || 'Select workshop'}
                  </Text>
                  <Ionicons name="chevron-down" size={18} color="#5C6670" />
                </Pressable>
              </View>

              <View style={S.field}>
                <FieldLabel>DIVISION</FieldLabel>
                <Pressable style={S.pickerBox} onPress={() => setEditDivModal(true)}>
                  <Text style={[S.pickerText, !editDivision && S.pickerPlaceholder]}>
                    {editDivision || 'Select division'}
                  </Text>
                  <Ionicons name="chevron-down" size={18} color="#5C6670" />
                </Pressable>
              </View>

              {/* Date + Area */}
              <SectionLabel>INCIDENT DETAILS</SectionLabel>
              <View style={[S.rowGap, { marginBottom: 14 }]}>
                <DateField label="DATE" value={editDate} onChange={setEditDate} />
                <View style={{ flex: 1 }}>
                  <FieldLabel>AREA / MACHINE NO.</FieldLabel>
                  <TextInput
                    style={[S.input, { height: 44 }]}
                    value={editArea}
                    onChangeText={setEditArea}
                    placeholder="e.g. BP-03"
                    placeholderTextColor="#5C6670"
                  />
                </View>
              </View>

              {/* Intensity */}
              <View style={S.field}>
                <FieldLabel>PROBLEM INTENSITY</FieldLabel>
                <ChipRow options={INTENSITIES} value={editIntensity} onChange={setEditIntensity} />
              </View>

              {/* Description */}
              <View style={S.field}>
                <FieldLabel>DESCRIPTION</FieldLabel>
                <TextInput
                  style={S.textArea}
                  value={editDesc}
                  onChangeText={setEditDesc}
                  placeholder="Describe what happened…"
                  placeholderTextColor="#5C6670"
                  multiline
                  numberOfLines={3}
                  textAlignVertical="top"
                />
              </View>

              {/* Action Taken */}
              <View style={S.field}>
                <FieldLabel>ACTION TAKEN</FieldLabel>
                <TextInput
                  style={S.textArea}
                  value={editAction}
                  onChangeText={setEditAction}
                  placeholder="Corrective actions applied…"
                  placeholderTextColor="#5C6670"
                  multiline
                  numberOfLines={3}
                  textAlignVertical="top"
                />
              </View>

              {/* TDC + Responsibility */}
              <View style={S.rowGap}>
                <DateField label="TDC (Target Date)" value={editTdc} onChange={setEditTdc} />
                <View style={{ flex: 1 }}>
                  <FieldLabel>RESPONSIBILITY</FieldLabel>
                  <TextInput
                    style={[S.input, { height: 44 }]}
                    value={editResp}
                    onChangeText={setEditResp}
                    placeholder="e.g. Maintenance"
                    placeholderTextColor="#5C6670"
                  />
                </View>
              </View>

              {/* Status */}
              <View style={[S.field, { marginTop: 14 }]}>
                <FieldLabel>STATUS</FieldLabel>
                <ChipRow
                  options={STATUSES}
                  value={editStatus}
                  onChange={(v) => {
                    setEditStatus(v);
                    if (v !== 'Closed') setEditClosedOn('');
                  }}
                />
              </View>

              {/* Closed On */}
              {editStatus === 'Closed' && (
                <View style={[S.field, { marginTop: 2 }]}>
                  <DateField label="CLOSED ON" value={editClosedOn} onChange={setEditClosedOn} />
                </View>
              )}

              {/* Error */}
              {editError && (
                <View style={S.errorBox}>
                  <Ionicons name="alert-circle" size={16} color="#D64545" />
                  <Text style={S.errorText}>{editError}</Text>
                </View>
              )}

              {/* Actions */}
              <View style={S.editActions}>
                <Pressable style={S.cancelBtn} onPress={closeEdit}>
                  <Text style={S.cancelBtnText}>Cancel</Text>
                </Pressable>
                <Pressable
                  style={({ pressed }) => [S.saveBtn, (editSubmitting || pressed) && { opacity: 0.85 }]}
                  onPress={handleUpdate}
                  disabled={editSubmitting}
                >
                  {editSubmitting
                    ? <ActivityIndicator color="#14181C" size="small" />
                    : <><Ionicons name="checkmark" size={18} color="#14181C" /><Text style={S.saveBtnText}>Save Changes</Text></>
                  }
                </Pressable>
              </View>
            </ScrollView>
          </View>
        </View>

        {/* Nested modals for plant/workshop inside edit modal */}
        <Modal visible={editPlantModal} animationType="fade" transparent>
          <View style={S.modalOverlay}>
            <View style={S.modalCard}>
              <Text style={S.modalTitle}>Select Plant</Text>
              <ScrollView contentContainerStyle={{ paddingBottom: 12 }}>
                {PLANTS.map((p) => (
                  <Pressable
                    key={p}
                    style={[S.modalRow, editPlant === p && S.modalRowSel]}
                    onPress={() => { setEditPlant(p); setEditPlantModal(false); }}
                  >
                    <Text style={[S.modalRowText, editPlant === p && S.modalRowTextSel]}>{p}</Text>
                  </Pressable>
                ))}
              </ScrollView>
              <View style={S.modalFooter}>
                <Pressable style={S.modalCancelBtn} onPress={() => setEditPlantModal(false)}>
                  <Text style={S.modalCancelText}>Cancel</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>

        <Modal visible={editWsModal} animationType="fade" transparent>
          <View style={S.modalOverlay}>
            <View style={S.modalCard}>
              <Text style={S.modalTitle}>Select Workshop</Text>
              <ScrollView contentContainerStyle={{ paddingBottom: 12 }}>
                {WORKSHOPS.map((w) => (
                  <Pressable
                    key={w}
                    style={[S.modalRow, editWorkshop === w && S.modalRowSel]}
                    onPress={() => { setEditWorkshop(w); setEditWsModal(false); }}
                  >
                    <Text style={[S.modalRowText, editWorkshop === w && S.modalRowTextSel]}>{w}</Text>
                  </Pressable>
                ))}
              </ScrollView>
              <View style={S.modalFooter}>
                <Pressable style={S.modalCancelBtn} onPress={() => setEditWsModal(false)}>
                  <Text style={S.modalCancelText}>Cancel</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>

        <Modal visible={editDivModal} animationType="fade" transparent>
          <View style={S.modalOverlay}>
            <View style={S.modalCard}>
              <Text style={S.modalTitle}>Select Division</Text>
              <ScrollView contentContainerStyle={{ paddingBottom: 12 }}>
                {DIVISIONS.map((d) => (
                  <Pressable
                    key={d}
                    style={[S.modalRow, editDivision === d && S.modalRowSel]}
                    onPress={() => { setEditDivision(d); setEditDivModal(false); }}
                  >
                    <Text style={[S.modalRowText, editDivision === d && S.modalRowTextSel]}>{d}</Text>
                  </Pressable>
                ))}
              </ScrollView>
              <View style={S.modalFooter}>
                <Pressable style={S.modalCancelBtn} onPress={() => setEditDivModal(false)}>
                  <Text style={S.modalCancelText}>Cancel</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>
      </Modal>

    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const S = StyleSheet.create({
  safeArea:   { flex: 1, backgroundColor: '#14181C' },
  scroll:     { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 40 },

  backBtn:    { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 12 },
  backText:   { color: '#8A96A3', fontSize: 15 },

  title:    { color: '#ECEFF2', fontSize: 23, fontWeight: '800' },
  subtitle: { color: '#8A96A3', fontSize: 13, marginTop: 4, marginBottom: 20, lineHeight: 18 },

  sectionLabel: {
    color: '#F2A93B', fontSize: 11.5, fontWeight: '800',
    letterSpacing: 1.4, marginBottom: 10, marginTop: 6,
  },
  fieldLabel: {
    color: '#8A96A3', fontSize: 11, fontWeight: '700',
    letterSpacing: 0.8, marginBottom: 6,
  },

  field:  { marginBottom: 14 },
  rowGap: { flexDirection: 'row', gap: 12, marginBottom: 0 },

  input: {
    backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C',
    borderRadius: 10, paddingHorizontal: 12, color: '#ECEFF2', fontSize: 14.5,
    height: 48,
  },
  dateRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C',
    borderRadius: 10, paddingHorizontal: 12, height: 44,
  },
  textArea: {
    backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C',
    borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10,
    minHeight: 90, color: '#ECEFF2', fontSize: 14.5, lineHeight: 20,
  },

  pickerBox: {
    backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C',
    borderRadius: 10, paddingHorizontal: 14, height: 50,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  pickerText:        { color: '#ECEFF2', fontSize: 14.5, flex: 1, marginRight: 8 },
  pickerPlaceholder: { color: '#5C6670' },

  chipsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    borderWidth: 1, borderColor: '#2C343C', backgroundColor: '#1D2329',
    borderRadius: 20, paddingHorizontal: 14, paddingVertical: 9,
  },
  chipText: { color: '#8A96A3', fontSize: 13, fontWeight: '600' },

  errorBox: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: '#D6454522', borderWidth: 1, borderColor: '#D64545',
    borderRadius: 10, padding: 12, marginBottom: 14,
  },
  errorText: { color: '#F0A8A8', fontSize: 13, flex: 1 },

  submitBtn: {
    height: 56, borderRadius: 12, backgroundColor: '#F2A93B',
    alignItems: 'center', justifyContent: 'center',
    flexDirection: 'row', gap: 8, marginTop: 6,
  },
  submitText: { color: '#14181C', fontSize: 16, fontWeight: '900', letterSpacing: 0.3 },

  divider: { height: 1, backgroundColor: '#2C343C', marginVertical: 22 },

  tableToggle: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C',
    borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, marginBottom: 12,
  },
  tableToggleText: { color: '#F2A93B', fontWeight: '700', fontSize: 14 },

  tableWrap: {
    borderWidth: 1, borderColor: '#2C343C', borderRadius: 10, overflow: 'hidden',
  },

  // Table
  tableLoading: { alignItems: 'center', gap: 8, paddingVertical: 32 },
  tableEmpty:   { alignItems: 'center', gap: 8, paddingVertical: 32 },
  muted:        { color: '#5C6670', fontSize: 13 },

  tableHeader: {
    flexDirection: 'row', backgroundColor: '#1A2028',
    borderBottomWidth: 1, borderBottomColor: '#2C343C',
  },
  th: { paddingHorizontal: 8, paddingVertical: 10 },
  thText: { color: '#F2A93B', fontSize: 11, fontWeight: '800', letterSpacing: 0.6 },

  tableRow:    { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#1D2329' },
  tableRowAlt: { backgroundColor: '#191E24' },
  td:          { paddingHorizontal: 8, paddingVertical: 9, justifyContent: 'center' },
  tdText:      { color: '#ECEFF2', fontSize: 12, lineHeight: 16 },

  // Modals
  modalOverlay: {
    flex: 1, backgroundColor: '#000000AA',
    alignItems: 'center', justifyContent: 'center', padding: 20,
  },
  modalCard: {
    width: '100%', maxWidth: 480, backgroundColor: '#14181C',
    borderRadius: 14, maxHeight: '75%', padding: 16,
    borderWidth: 1, borderColor: '#2C343C',
  },
  modalTitle:      { color: '#ECEFF2', fontSize: 18, fontWeight: '800', marginBottom: 12 },
  modalRow:        { paddingVertical: 14, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, borderColor: '#2C343C', marginBottom: 8 },
  modalRowSel:     { borderColor: '#F2A93B', backgroundColor: '#F2A93B0D' },
  modalRowText:    { color: '#ECEFF2', fontSize: 15 },
  modalRowTextSel: { color: '#F2A93B', fontWeight: '700' },
  modalFooter:     { paddingTop: 10, borderTopWidth: 1, borderTopColor: '#2C343C', alignItems: 'flex-end' },
  modalCancelBtn:  { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: '#2C343C' },
  modalCancelText: { color: '#ECEFF2', fontWeight: '600' },

  // ── Edit modal
  editOverlay: {
    flex: 1,
    backgroundColor: '#000000BB',
    justifyContent: 'flex-end',
  },
  editCard: {
    backgroundColor: '#14181C',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    borderBottomWidth: 0,
    borderColor: '#2C343C',
    maxHeight: '93%',
  },
  editHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#2C343C',
  },
  editTitle:    { color: '#ECEFF2', fontSize: 18, fontWeight: '800' },
  editCloseBtn: { padding: 4 },
  editScroll:   { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 32 },

  editActions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 18,
  },
  cancelBtn: {
    flex: 1,
    height: 50,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#2C343C',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelBtnText: { color: '#8A96A3', fontSize: 15, fontWeight: '700' },
  saveBtn: {
    flex: 2,
    height: 50,
    borderRadius: 12,
    backgroundColor: '#F2A93B',
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 6,
  },
  saveBtnText: { color: '#14181C', fontSize: 15, fontWeight: '900' },
});