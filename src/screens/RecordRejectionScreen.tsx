// RecordRejectionScreen.tsx
//
// Quality Control's "Record Rejection" form. Mirrors RecordProductionScreen's
// cascading Plant → Workshop → Division → Line → Part picker (same
// productionLines collection, same isAssemblyWorkshop rule for when Division
// is shown, same dark PickerBox/Modal UI) and its visual language, so this
// screen feels like part of the same app rather than a bolt-on.
//
// Self-contained: its own state, its own Firestore writes to
// `rejectionRecords`, no dependency on RecordProductionScreen's internals.
//
// Rejection entry is a sheet: every type from constants/rejectionTypes.ts is
// listed with a −/+ stepper, and one Save writes one record per type with a
// quantity > 0 in a single batch. Each record's `stage` is the type's
// automatic category, or the user's Visual/Process pick for FOULING. The
// already-recorded total per type for the current date/line/part is read
// back and shown separately from the quantity being entered.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { collection, doc, getDocs, serverTimestamp, query, where, writeBatch } from 'firebase/firestore';
import { db } from '../services/firebase';
import { useAuthStore } from '../stores/authStore';
import { PLANTS, WORKSHOPS, DIVISIONS } from '../constants/lineOptions';
import {
  REJECTION_TYPES,
  buildRejectionEntries,
  sumQtyByRejectionType,
  type RejectionCategory,
  type RejectionType,
} from '../constants/rejectionTypes';

// ─── Types ──────────────────────────────────────────────────────────────────

type Line = {
  id: string;
  plant?: string | null;
  workshop?: string | null;
  division?: string | null;
  lineName?: string | null;
  parts?: { name: string; cycleTimeSeconds: number }[];
};

type DropdownKind = 'plant' | 'workshop' | 'division' | 'line' | 'part' | 'responsibility';
type DropdownOption = { key: string; label: string; sublabel?: string };

const DROPDOWN_TITLES: Record<DropdownKind, string> = {
  plant: 'Select Plant',
  workshop: 'Select Workshop',
  division: 'Select Division',
  line: 'Select Line',
  part: 'Select Part',
  responsibility: 'Select Responsibility',
};

const RESPONSIBILITIES = ['Stamping', 'Plating', 'Assy', 'Welding', 'BOP', 'Bolt Sticking'] as const;

// Same rule RecordProductionScreen uses to decide when Division applies.
function isAssemblyWorkshop(w: string | null) {
  return !!w && w.toLowerCase().includes('assembly');
}

function todayKey(): string {
  const d = new Date();
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

// Alert.alert is a no-op on react-native-web, so the web build falls back to
// window.alert (same approach as ManageLinesScreen / RecordProductionScreen).
function notify(title: string, message: string) {
  if (Platform.OS === 'web') window.alert(`${title}\n\n${message}`);
  else Alert.alert(title, message);
}

function emptyEntryQty(): Record<string, number> {
  const m: Record<string, number> = {};
  for (const t of REJECTION_TYPES) m[t.name] = 0;
  return m;
}

function isValidDateKey(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00`);
  return !Number.isNaN(d.getTime());
}

// ─── Reusable picker box — same visual language as Record Production ──────

function PickerBox({
  label,
  value,
  placeholder,
  onPress,
  disabled,
}: {
  label: string;
  value?: string | null;
  placeholder: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <Pressable
        onPress={onPress}
        disabled={disabled}
        style={[styles.pickerBox, disabled && styles.disabledInput]}
      >
        <Text style={[styles.pickerBoxText, !value && styles.pickerBoxPlaceholder]} numberOfLines={1}>
          {value || placeholder}
        </Text>
        <Ionicons name="chevron-down" size={18} color="#8A96A3" />
      </Pressable>
    </View>
  );
}

// ─── One line of the rejection entry sheet: type + category on the left,
// −/qty/+ stepper on the right. Wraps to two lines on narrow screens rather
// than overflowing. Once a type has a quantity it shows its own
// Responsibility picker; types without an automatic category (FOULING) also
// get a Visual/Process chip row. Memoised so tapping +/− on one row
// doesn't re-render the other 34.
const RejectionEntryRow = React.memo(function RejectionEntryRow({
  type,
  qty,
  manualCategory,
  responsibility,
  recordedQty,
  disabled,
  onChangeQty,
  onSelectCategory,
  onPickResponsibility,
}: {
  type: RejectionType;
  qty: number;
  manualCategory: RejectionCategory | null;
  responsibility: string | null;
  recordedQty: number | null;
  disabled: boolean;
  onChangeQty: (name: string, delta: number) => void;
  onSelectCategory: (name: string, category: RejectionCategory) => void;
  onPickResponsibility: (name: string) => void;
}) {
  const isManual = type.category === null;
  const missingCategory = isManual && qty > 0 && !manualCategory;
  return (
    <View style={[styles.entryRow, qty > 0 && styles.entryRowActive, missingCategory && styles.entryRowError]}>
      <View style={styles.entryMain}>
        <View style={styles.entryInfo}>
          <Text style={styles.entryName}>{type.name}</Text>
          <View style={styles.entryMetaRow}>
            <View style={[styles.categoryBadge, isManual && styles.categoryBadgeManual]}>
              <Text style={[styles.categoryBadgeText, isManual && styles.categoryBadgeTextManual]}>
                {type.category ?? 'Manual'}
              </Text>
            </View>
            {recordedQty != null ? (
              <Text style={styles.recordedText}>Recorded: {recordedQty}</Text>
            ) : null}
          </View>
        </View>

        <View style={styles.stepper}>
          <Pressable
            onPress={() => onChangeQty(type.name, -1)}
            disabled={disabled || qty <= 0}
            style={[styles.stepperBtn, (disabled || qty <= 0) && styles.stepperBtnDisabled]}
            accessibilityLabel={`Decrease ${type.name}`}
            hitSlop={4}
          >
            <Ionicons name="remove" size={22} color="#ECEFF2" />
          </Pressable>
          <Text style={[styles.stepperValue, qty > 0 && styles.stepperValueActive]}>{qty}</Text>
          <Pressable
            onPress={() => onChangeQty(type.name, 1)}
            disabled={disabled}
            style={[styles.stepperBtn, disabled && styles.stepperBtnDisabled]}
            accessibilityLabel={`Increase ${type.name}`}
            hitSlop={4}
          >
            <Ionicons name="add" size={22} color="#ECEFF2" />
          </Pressable>
        </View>
      </View>

      {isManual ? (
        <View style={styles.manualCategoryBlock}>
          <Text style={styles.label}>Category{qty > 0 ? ' *' : ''}</Text>
          <View style={styles.chipsRow}>
            {(type.manualCategories ?? []).map((c) => (
              <Pressable
                key={c}
                onPress={() => onSelectCategory(type.name, c)}
                disabled={disabled}
                style={[styles.chip, manualCategory === c && styles.chipSelected]}
              >
                <Text style={[styles.chipText, manualCategory === c && styles.chipTextSelected]}>{c}</Text>
              </Pressable>
            ))}
          </View>
          {missingCategory ? (
            <Text style={styles.errorText}>Please select Visual or Process for {type.name}.</Text>
          ) : null}
        </View>
      ) : null}

      {qty > 0 ? (
        <View style={styles.rowResponsibility}>
          <Text style={styles.label}>Responsibility *</Text>
          <Pressable
            onPress={() => onPickResponsibility(type.name)}
            disabled={disabled}
            style={[styles.rowPickerBox, !responsibility && styles.rowPickerBoxEmpty]}
            accessibilityLabel={`Responsibility for ${type.name}`}
          >
            <Text style={[styles.pickerBoxText, !responsibility && styles.rowPickerPlaceholder]} numberOfLines={1}>
              {responsibility || 'Select responsibility'}
            </Text>
            <Ionicons name="chevron-down" size={16} color="#8A96A3" />
          </Pressable>
        </View>
      ) : null}
    </View>
  );
});

// ─── Component ────────────────────────────────────────────────────────────

export default function RecordRejectionScreen() {
  const navigation = useNavigation<any>();
  const user = useAuthStore((s) => s.user);

  // ── Location / line cascade (Plant → Workshop → Division → Line → Part)
  const [allLines, setAllLines] = useState<Line[]>([]);
  const [loadingLines, setLoadingLines] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [plant, setPlant] = useState<string | null>(null);
  const [workshop, setWorkshop] = useState<string | null>(null);
  const [division, setDivision] = useState<string | null>(null);
  const [selectedLineId, setSelectedLineId] = useState<string | null>(null);
  const [selectedPartIndex, setSelectedPartIndex] = useState<number | null>(null);

  const selectedLine = allLines.find((l) => l.id === selectedLineId) ?? null;

  // ── Rejection-specific fields
  const [date, setDate] = useState(todayKey());
  // Quantity being entered NOW per type (not the historical total), and the
  // Visual/Process pick for types without an automatic category (FOULING),
  // keyed by type name so one type's pick can never apply to another.
  const [entryQty, setEntryQty] = useState<Record<string, number>>(emptyEntryQty);
  const [manualCategories, setManualCategories] = useState<Record<string, RejectionCategory | null>>({});
  // Responsibility is chosen per rejection type; responsibilityTarget is the
  // type whose picker is open in the shared dropdown modal.
  const [responsibilities, setResponsibilities] = useState<Record<string, string | null>>({});
  const [responsibilityTarget, setResponsibilityTarget] = useState<string | null>(null);
  const [remarks, setRemarks] = useState('');

  const [activeDropdown, setActiveDropdown] = useState<DropdownKind | null>(null);
  const [saving, setSaving] = useState(false);

  // Same productionLines collection and field-fallback shape RecordProductionScreen
  // reads — read-only here, nothing about it is modified.
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        setLoadingLines(true);
        const snap = await getDocs(collection(db, 'productionLines'));
        const docs: Line[] = snap.docs.map((d) => {
          const data: any = d.data();
          const partsArray =
            Array.isArray(data.parts) && data.parts.length ? data.parts :
            Array.isArray(data.models) && data.models.length ? data.models :
            Array.isArray(data.partsList) && data.partsList.length ? data.partsList : [];
          return {
            id: d.id,
            plant: data.plant ?? data.location ?? null,
            workshop: data.workshop ?? data.shop ?? null,
            division: data.division ?? data.unit ?? null,
            lineName: data.lineName ?? data.lineNumber ?? data.name ?? null,
            parts: partsArray.map((p: any) => ({
              name: p.name ?? p.partName ?? '',
              cycleTimeSeconds: Number(p.cycleTimeSeconds ?? p.cycleTime ?? p.cycle ?? 0),
            })),
          };
        });
        if (!mounted) return;
        setAllLines(docs);
      } catch (e) {
        console.error('[RecordRejection] load lines', e);
        if (mounted) setLoadError('Could not load production lines. Check your connection.');
      } finally {
        if (mounted) setLoadingLines(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

  const filteredLines = useMemo(() => {
    return allLines.filter((l) => {
      if (plant && l.plant && String(l.plant).toLowerCase() !== String(plant).toLowerCase()) return false;
      if (workshop && l.workshop && !String(l.workshop).toLowerCase().includes(String(workshop).toLowerCase())) return false;
      if (division && l.division && !String(l.division).toLowerCase().includes(String(division).toLowerCase())) return false;
      return true;
    });
  }, [allLines, plant, workshop, division]);

  const dropdownOptions: DropdownOption[] = useMemo(() => {
    switch (activeDropdown) {
      case 'plant':
        return PLANTS.map((p: string) => ({ key: p, label: p }));
      case 'workshop':
        return WORKSHOPS.map((w: string) => ({ key: w, label: w }));
      case 'division':
        return DIVISIONS.map((d: string) => ({ key: d, label: d }));
      case 'line':
        return filteredLines.map((l) => ({
          key: l.id,
          label: l.lineName ?? l.id,
          sublabel: [l.plant, l.workshop].filter(Boolean).join(' · ') || undefined,
        }));
      case 'part':
        return (selectedLine?.parts ?? []).map((p, i) => ({ key: String(i), label: p.name }));
      case 'responsibility':
        return RESPONSIBILITIES.map((r) => ({ key: r, label: r }));
      default:
        return [];
    }
  }, [activeDropdown, filteredLines, selectedLine]);

  const dropdownSelectedKey = useMemo(() => {
    switch (activeDropdown) {
      case 'plant': return plant ?? '';
      case 'workshop': return workshop ?? '';
      case 'division': return division ?? '';
      case 'line': return selectedLineId ?? '';
      case 'part': return selectedPartIndex != null ? String(selectedPartIndex) : '';
      case 'responsibility': return (responsibilityTarget && responsibilities[responsibilityTarget]) ?? '';
      default: return '';
    }
  }, [activeDropdown, plant, workshop, division, selectedLineId, selectedPartIndex, responsibilityTarget, responsibilities]);

  // Entries belong to one location/line/part — any change there discards
  // them so they can't be saved against a different part by accident.
  function clearEntries() {
    setEntryQty(emptyEntryQty());
    setManualCategories({});
    setResponsibilities({});
  }

  function handleDropdownSelect(key: string) {
    if (activeDropdown && activeDropdown !== 'responsibility' && key !== dropdownSelectedKey) clearEntries();
    switch (activeDropdown) {
      case 'plant':
        setPlant(key);
        setWorkshop(null); setDivision(null); setSelectedLineId(null); setSelectedPartIndex(null);
        break;
      case 'workshop':
        setWorkshop(key);
        if (!isAssemblyWorkshop(key)) setDivision(null);
        setSelectedLineId(null); setSelectedPartIndex(null);
        break;
      case 'division':
        setDivision(key);
        setSelectedLineId(null); setSelectedPartIndex(null);
        break;
      case 'line':
        setSelectedLineId(key);
        setSelectedPartIndex(null);
        break;
      case 'part':
        setSelectedPartIndex(Number(key));
        break;
      case 'responsibility':
        if (responsibilityTarget) {
          const target = responsibilityTarget;
          setResponsibilities((prev) => ({ ...prev, [target]: key }));
        }
        break;
    }
    setActiveDropdown(null);
  }

  // ── Entry sheet handlers (stable so memoised rows don't re-render).
  const handleChangeQty = useCallback((name: string, delta: number) => {
    setEntryQty((prev) => ({ ...prev, [name]: Math.max(0, (prev[name] ?? 0) + delta) }));
  }, []);

  const handlePickResponsibility = useCallback((name: string) => {
    setResponsibilityTarget(name);
    setActiveDropdown('responsibility');
  }, []);

  const handleSelectCategory = useCallback((name: string, category: RejectionCategory) => {
    setManualCategories((prev) => ({ ...prev, [name]: category }));
  }, []);

  const totalToSave = useMemo(
    () => Object.values(entryQty).reduce((sum, q) => sum + q, 0),
    [entryQty]
  );

  // ── Search: only filters which rows are visible. Hidden rows keep their
  // quantities and are still saved, so the note below the box calls them out.
  const [typeSearch, setTypeSearch] = useState('');
  const visibleTypes = useMemo(() => {
    const q = typeSearch.trim().toLowerCase();
    return q ? REJECTION_TYPES.filter((t) => t.name.toLowerCase().includes(q)) : REJECTION_TYPES;
  }, [typeSearch]);
  const hiddenEnteredCount = useMemo(() => {
    if (visibleTypes.length === REJECTION_TYPES.length) return 0;
    const visible = new Set(visibleTypes.map((t) => t.name));
    return REJECTION_TYPES.filter((t) => !visible.has(t.name) && (entryQty[t.name] ?? 0) > 0).length;
  }, [visibleTypes, entryQty]);

  // ── Already-recorded totals: SUM(rejectionQty) for the exact current context
  // (date + plant + workshop + division + line + part). One Firestore query
  // on equality filters only (no composite index needed), the rest of the
  // context is matched locally, then aggregated into { defect: qty }.
  const selectedPartName =
    selectedLine && selectedPartIndex != null ? selectedLine.parts?.[selectedPartIndex]?.name ?? null : null;
  const contextComplete =
    isValidDateKey(date) && !!plant && !!workshop && (!isAssemblyWorkshop(workshop) || !!division) &&
    !!selectedLineId && !!selectedPartName;

  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [countsLoading, setCountsLoading] = useState(false);
  const [countsError, setCountsError] = useState<string | null>(null);
  const [countsVersion, setCountsVersion] = useState(0);
  const countsRequestId = useRef(0);

  const refreshCounts = useCallback(() => setCountsVersion((v) => v + 1), []);

  useEffect(() => {
    const requestId = ++countsRequestId.current;
    // Drop the previous context's numbers immediately so they're never shown
    // against a different date/line/part.
    setCounts(null);
    setCountsError(null);
    if (!contextComplete || !selectedLineId || !selectedPartName) {
      setCountsLoading(false);
      return;
    }
    setCountsLoading(true);
    (async () => {
      try {
        const snap = await getDocs(
          query(
            collection(db, 'rejectionRecords'),
            where('date', '==', date),
            where('lineId', '==', selectedLineId),
            where('partName', '==', selectedPartName),
          )
        );
        const totals = sumQtyByRejectionType(
          snap.docs
            .map((d) => d.data() as any)
            .filter((data) =>
              data.plant === plant && data.workshop === workshop && (data.division ?? null) === (division ?? null)
            )
        );
        if (countsRequestId.current === requestId) setCounts(totals);
      } catch (e) {
        console.error('[RecordRejection] load counts', e);
        if (countsRequestId.current === requestId) setCountsError('Could not load counts.');
      } finally {
        if (countsRequestId.current === requestId) setCountsLoading(false);
      }
    })();
  }, [contextComplete, date, plant, workshop, division, selectedLineId, selectedPartName, countsVersion]);

  const countsNote = countsError
    ? 'Could not load already-recorded totals.'
    : !contextComplete
      ? 'Select date, location, line and part to start entering rejections.'
      : null;

  // After a successful save only the entry sheet resets — date, location,
  // line and part stay selected so the inspector can log the next batch for
  // the same part straight away.
  function resetRejectionFields() {
    clearEntries();
    setRemarks('');
  }

  async function handleSave() {
    if (!isValidDateKey(date)) { notify('Invalid date', 'Enter the date as YYYY-MM-DD.'); return; }
    if (!plant) { notify('Missing field', 'Select a plant.'); return; }
    if (!workshop) { notify('Missing field', 'Select a workshop.'); return; }
    if (isAssemblyWorkshop(workshop) && !division) { notify('Missing field', 'Select a division.'); return; }
    if (!selectedLine) { notify('Missing field', 'Select a line.'); return; }
    const part = selectedPartIndex != null ? selectedLine.parts?.[selectedPartIndex] : undefined;
    if (!part) { notify('Missing field', 'Select a part.'); return; }

    // One entry per type with qty > 0 — never one per tap.
    const built = buildRejectionEntries(entryQty, manualCategories, responsibilities);
    if (built.error !== null) {
      notify('Cannot save', built.error); return;
    }
    const { entries } = built;

    setSaving(true);
    try {
      // All records in one atomic batch: either the whole sheet is saved or
      // nothing is, so a failure never leaves a partial submission behind.
      const batch = writeBatch(db);
      const shared = {
        date,
        plant,
        workshop,
        division: division ?? null,
        lineId: selectedLine.id,
        lineName: selectedLine.lineName ?? null,
        partName: part.name,
        remarks: remarks.trim() || null,
        reportedBy: { uid: user?.uid ?? null, name: user?.name ?? null },
      };
      for (const e of entries) {
        batch.set(doc(collection(db, 'rejectionRecords')), {
          ...shared,
          stage: e.stage,
          rejectionQty: e.qty,
          defect: e.type.name,
          responsibility: e.responsibility,
          createdAt: serverTimestamp(),
        });
      }
      await batch.commit();
      const total = entries.reduce((s, e) => s + e.qty, 0);
      notify('Saved', `${entries.length} rejection record${entries.length === 1 ? '' : 's'} saved (${total} part${total === 1 ? '' : 's'}).`);
      resetRejectionFields();
      refreshCounts();
    } catch (e) {
      // Entered quantities are kept so the user can retry.
      console.error('[RecordRejection] save', e);
      notify('Error', 'Could not save the rejections. Nothing was saved — check your connection and try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <Pressable onPress={() => navigation.goBack()} style={styles.backButton} hitSlop={12}>
          <Ionicons name="arrow-back" size={22} color="#8A96A3" />
          <Text style={styles.backText}>Back</Text>
        </Pressable>

        <Text style={styles.title}>Record Rejection</Text>
        <Text style={styles.subtitle}>Log rejected parts for a line</Text>

        <Text style={styles.sectionLabel}>DATE</Text>
        <View style={styles.field}>
          <Text style={styles.label}>Date</Text>
          <TextInput
            style={styles.input}
            value={date}
            onChangeText={setDate}
            placeholder="YYYY-MM-DD"
            placeholderTextColor="#5C6670"
            autoCapitalize="none"
          />
        </View>

        <Text style={[styles.sectionLabel, { marginTop: 8 }]}>LOCATION</Text>
        <PickerBox label="Plant" value={plant} placeholder="Select a plant" onPress={() => setActiveDropdown('plant')} />
        <PickerBox
          label="Workshop"
          value={workshop}
          placeholder="Select a workshop"
          disabled={!plant}
          onPress={() => setActiveDropdown('workshop')}
        />
        {isAssemblyWorkshop(workshop) && (
          <PickerBox label="Division" value={division} placeholder="Select a division" onPress={() => setActiveDropdown('division')} />
        )}

        {loadError ? (
          <Text style={{ color: '#F0A8A8', marginBottom: 8 }}>{loadError}</Text>
        ) : (
          <PickerBox
            label="Line"
            value={selectedLine?.lineName ?? null}
            placeholder={loadingLines ? 'Loading lines…' : filteredLines.length ? 'Select a line' : 'No lines found for selected filters'}
            disabled={loadingLines || !filteredLines.length}
            onPress={() => setActiveDropdown('line')}
          />
        )}

        {selectedLine?.parts?.length ? (
          <PickerBox
            label="Part"
            value={selectedPartIndex != null ? selectedLine.parts[selectedPartIndex]?.name ?? null : null}
            placeholder="Select a part"
            onPress={() => setActiveDropdown('part')}
          />
        ) : null}

        <View style={styles.detailsHeader}>
          <Text style={[styles.sectionLabel, { marginTop: 8, marginBottom: 0 }]}>REJECTION DETAILS</Text>
          <Text style={styles.totalInline}>
            To save: <Text style={styles.totalInlineValue}>{totalToSave}</Text>
          </Text>
        </View>

        {countsLoading || countsNote ? (
          <View style={styles.countsStatusRow}>
            {countsLoading ? <ActivityIndicator size="small" color="#8A96A3" /> : null}
            <Text style={[styles.muted, countsError && { color: '#F0A8A8' }]}>
              {countsLoading ? 'Loading already-recorded totals…' : countsNote}
            </Text>
          </View>
        ) : null}

        <View style={styles.searchBoxRow}>
          <Ionicons name="search" size={16} color="#8A96A3" />
          <TextInput
            style={styles.searchInput}
            value={typeSearch}
            onChangeText={setTypeSearch}
            placeholder="Search rejection type…"
            placeholderTextColor="#5C6670"
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
          />
          {typeSearch.length > 0 && (
            <Pressable onPress={() => setTypeSearch('')} hitSlop={8} accessibilityLabel="Clear search">
              <Ionicons name="close-circle" size={18} color="#5C6670" />
            </Pressable>
          )}
        </View>

        {typeSearch.trim() ? (
          <Text style={[styles.muted, { marginBottom: 8 }]}>
            Showing {visibleTypes.length} of {REJECTION_TYPES.length} types
            {hiddenEnteredCount > 0
              ? ` · ${hiddenEnteredCount} hidden type${hiddenEnteredCount === 1 ? ' has' : 's have'} quantities and will still be saved`
              : ''}
          </Text>
        ) : null}

        <View style={styles.entryHeaderRow}>
          <Text style={styles.entryHeaderText}>Rejection type · Category</Text>
          <Text style={styles.entryHeaderText}>Qty to add</Text>
        </View>

        {visibleTypes.length === 0 ? (
          <Text style={[styles.muted, styles.searchEmpty]}>No rejection types match "{typeSearch.trim()}"</Text>
        ) : null}

        {visibleTypes.map((t) => (
          <RejectionEntryRow
            key={t.name}
            type={t}
            qty={entryQty[t.name] ?? 0}
            manualCategory={manualCategories[t.name] ?? null}
            responsibility={responsibilities[t.name] ?? null}
            recordedQty={counts ? counts[t.name] ?? 0 : null}
            disabled={!contextComplete || saving}
            onChangeQty={handleChangeQty}
            onSelectCategory={handleSelectCategory}
            onPickResponsibility={handlePickResponsibility}
          />
        ))}

        <View style={{ height: 8 }} />

        <View style={styles.field}>
          <Text style={styles.label}>Remarks (optional)</Text>
          <TextInput
            style={[styles.input, styles.remarksInput]}
            value={remarks}
            onChangeText={setRemarks}
            placeholder="Additional notes"
            placeholderTextColor="#5C6670"
            multiline
          />
        </View>

        <View style={styles.totalBar}>
          <Text style={styles.totalBarLabel}>Total Rejections to Save</Text>
          <Text style={styles.totalBarValue}>{totalToSave}</Text>
        </View>

        <Pressable
          style={({ pressed }) => [styles.saveButton, (saving || pressed) && styles.saveButtonPressed]}
          onPress={handleSave}
          disabled={saving}
        >
          {saving ? (
            <ActivityIndicator color="#14181C" />
          ) : (
            <>
              <Ionicons name="save-outline" size={20} color="#14181C" />
              <Text style={styles.saveButtonText}>Save Rejections</Text>
            </>
          )}
        </Pressable>
      </ScrollView>

      <Modal visible={activeDropdown !== null} animationType="slide" transparent onRequestClose={() => setActiveDropdown(null)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{activeDropdown ? DROPDOWN_TITLES[activeDropdown] : ''}</Text>
            {activeDropdown === 'responsibility' && responsibilityTarget ? (
              <Text style={[styles.muted, { marginBottom: 8 }]}>For {responsibilityTarget}</Text>
            ) : null}
            <ScrollView contentContainerStyle={styles.modalScroll}>
              {dropdownOptions.length === 0 ? (
                <Text style={styles.muted}>No options available</Text>
              ) : (
                dropdownOptions.map((opt) => {
                  const isSelected = dropdownSelectedKey === opt.key;
                  return (
                    <Pressable
                      key={opt.key}
                      onPress={() => handleDropdownSelect(opt.key)}
                      style={[styles.modalPartRow, isSelected && styles.modalPartRowSelected]}
                    >
                      <Text style={[styles.modalPartText, isSelected && styles.modalPartTextSelected]}>{opt.label}</Text>
                      {opt.sublabel ? <Text style={styles.muted}>{opt.sublabel}</Text> : null}
                    </Pressable>
                  );
                })
              )}
            </ScrollView>
            <View style={styles.modalFooter}>
              <Pressable onPress={() => setActiveDropdown(null)} style={styles.modalBtn}>
                <Text style={styles.modalBtnText}>Close</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

// ─── Styles — same dark theme/tokens used across the app ──────────────────

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#14181C' },
  scroll: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 40 },
  backButton: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 8 },
  backText: { color: '#8A96A3', fontSize: 15 },
  title: { color: '#ECEFF2', fontSize: 22, fontWeight: '800' },
  subtitle: { color: '#8A96A3', fontSize: 13, marginTop: 4, marginBottom: 14 },
  sectionLabel: { color: '#F2A93B', fontSize: 12, fontWeight: '800', letterSpacing: 1.4, marginBottom: 8, marginTop: 4 },
  field: { marginBottom: 12 },
  label: { color: '#8A96A3', fontSize: 11.5, marginBottom: 6, fontWeight: '700' },
  input: {
    backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C',
    borderRadius: 10, paddingHorizontal: 12, height: 48, color: '#ECEFF2', fontSize: 15,
  },
  remarksInput: { height: 88, paddingTop: 12, textAlignVertical: 'top' },
  disabledInput: { opacity: 0.5, backgroundColor: '#14181C' },
  pickerBox: {
    backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C', borderRadius: 10,
    paddingHorizontal: 12, height: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  pickerBoxText: { color: '#ECEFF2', fontSize: 15, flex: 1, marginRight: 8 },
  pickerBoxPlaceholder: { color: '#5C6670' },
  chipsRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  chip: { borderWidth: 1, borderColor: '#2C343C', backgroundColor: '#1D2329', borderRadius: 16, paddingHorizontal: 14, paddingVertical: 10 },
  chipSelected: { borderColor: '#F2A93B', backgroundColor: '#F2A93B22' },
  chipText: { color: '#8A96A3', fontSize: 13, fontWeight: '600' },
  chipTextSelected: { color: '#F2A93B' },
  muted: { color: '#8A96A3', fontSize: 12 },
  errorText: { color: '#F0A8A8', fontSize: 12, marginTop: 6 },
  countsStatusRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },

  // Rejection entry sheet
  detailsHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 8 },
  totalInline: { color: '#8A96A3', fontSize: 13, fontWeight: '700' },
  totalInlineValue: { color: '#F2A93B', fontSize: 15, fontWeight: '900' },
  searchBoxRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C', borderRadius: 10,
    paddingHorizontal: 12, height: 46, marginBottom: 8,
  },
  searchInput: { flex: 1, color: '#ECEFF2', fontSize: 15, height: '100%' },
  searchEmpty: { textAlign: 'center', paddingVertical: 16 },
  entryHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 12, marginBottom: 6 },
  entryHeaderText: { color: '#5C6670', fontSize: 11, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase' },
  entryRow: { backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, marginBottom: 8 },
  entryRowActive: { borderColor: '#F2A93B88' },
  entryRowError: { borderColor: '#F0A8A8' },
  entryMain: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', rowGap: 8, columnGap: 12 },
  entryInfo: { flexGrow: 1, flexShrink: 1, flexBasis: 160, minWidth: 0 },
  entryName: { color: '#ECEFF2', fontSize: 15, fontWeight: '700' },
  entryMetaRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  categoryBadge: { borderWidth: 1, borderColor: '#2C343C', backgroundColor: '#14181C', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2 },
  categoryBadgeManual: { borderColor: '#F2A93B66' },
  categoryBadgeText: { color: '#8A96A3', fontSize: 11.5, fontWeight: '700' },
  categoryBadgeTextManual: { color: '#F2A93B' },
  recordedText: { color: '#5C6670', fontSize: 11.5 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 6, marginLeft: 'auto' },
  stepperBtn: { width: 44, height: 44, borderRadius: 10, borderWidth: 1, borderColor: '#2C343C', backgroundColor: '#14181C', alignItems: 'center', justifyContent: 'center' },
  stepperBtnDisabled: { opacity: 0.35 },
  stepperValue: { minWidth: 40, textAlign: 'center', color: '#8A96A3', fontSize: 18, fontWeight: '800', fontVariant: ['tabular-nums'] },
  stepperValueActive: { color: '#F2A93B' },
  rowResponsibility: { marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: '#2C343C' },
  rowPickerBox: {
    backgroundColor: '#14181C', borderWidth: 1, borderColor: '#2C343C', borderRadius: 10,
    paddingHorizontal: 12, height: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  rowPickerBoxEmpty: { borderColor: '#F2A93B66' },
  rowPickerPlaceholder: { color: '#F2A93B' },
  manualCategoryBlock: { marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: '#2C343C' },
  totalBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, marginTop: 4 },
  totalBarLabel: { color: '#ECEFF2', fontSize: 14, fontWeight: '700' },
  totalBarValue: { color: '#F2A93B', fontSize: 22, fontWeight: '900', fontVariant: ['tabular-nums'] },

  saveButton: { height: 58, borderRadius: 12, backgroundColor: '#4C9A6A', alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 10, marginTop: 12, marginBottom: 20 },
  saveButtonPressed: { opacity: 0.85 },
  saveButtonText: { color: '#14181C', fontSize: 17, fontWeight: '900' },

  modalOverlay: { flex: 1, backgroundColor: '#00000088', alignItems: 'center', justifyContent: 'center', padding: 20 },
  modalCard: { width: '100%', maxWidth: 720, backgroundColor: '#14181C', borderRadius: 12, maxHeight: '80%', padding: 14, borderWidth: 1, borderColor: '#2C343C' },
  modalScroll: { paddingBottom: 12 },
  modalTitle: { color: '#ECEFF2', fontSize: 18, fontWeight: '800', marginBottom: 8 },
  modalPartRow: { paddingVertical: 12, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, borderColor: '#2C343C', marginBottom: 8, minHeight: 48, justifyContent: 'center' },
  modalPartRowSelected: { borderColor: '#F2A93B', backgroundColor: '#F2A93B08' },
  modalPartText: { color: '#ECEFF2', fontSize: 14 },
  modalPartTextSelected: { color: '#F2A93B', fontWeight: '800' },
  modalFooter: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: '#2C343C' },
  modalBtn: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: '#2C343C', backgroundColor: '#1D2329' },
  modalBtnText: { color: '#ECEFF2', fontWeight: '700' },
});