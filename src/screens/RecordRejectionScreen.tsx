// RecordRejectionScreen.tsx
//
// Quality Control's "Record Rejection" form. Mirrors RecordProductionScreen's
// cascading Plant → Workshop → Division → Line → Part picker (same
// productionLines collection, same isAssemblyWorkshop rule for when Division
// is shown, same dark PickerBox/Modal UI) and its visual language, so this
// screen feels like part of the same app rather than a bolt-on.
//
// Self-contained: its own state, its own Firestore write (a new
// `rejectionRecords` collection — nothing existing is read from or written
// to), no dependency on RecordProductionScreen's internals.

import React, { useEffect, useMemo, useState } from 'react';
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
import { useNavigation } from '@react-navigation/native';
import { collection, getDocs, addDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../services/firebase';
import { useAuthStore } from '../stores/authStore';
import { PLANTS, WORKSHOPS, DIVISIONS } from '../constants/lineOptions';

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

const REJECTION_STAGES = ['Visual', 'Process', 'Dimension'] as const;
type RejectionStage = (typeof REJECTION_STAGES)[number];

const DEFECTS = ['Angle more', 'Angle ng', 'Angleless', 'ANGLEMORE', 'ARM', 'ARM BEND', 'Arm Dent', 
    'B GAP', 'B SHORT', 'B Short', 'B.C', 'B.CRACK', 'B.D', 'B.DAMAGE', 'B.GAP', 'B.H.C', 
    'B.NG', 'B.P.C', 'B.S', 'B.Short', 'B.SHORT', 'Base plat crack', 'BATCH CODE', 
    'BATCH CODE NG', 'Batch code NG', 'BatchCode', 'BC NG', 'BCND', 'BCNG', 'BD', 'BEND', 
    'Bend', 'BG', 'BGAP', 'BKT HOLE MISS', 'Blank Short', 'BOLT CRACK', 'BOLT G', 'Bolt G', 
    'BOLT GAP', 'BOLT.G', 'BURR', 'Burr', 'Bush damage', 'BUSH G', 'Bush Gap', 'Bush GAP', 
    'Bush taper', 'CDNG', 'DENT', 'Dent', 'Dent mark', 'Dia NG', 'Double B/C', 'F.BEND', 
    'F.CDNG', 'Femal B shot', 'Femal bend', 'Female Bend', 'Female CDNG', 'FEMALE.B', 
    'Fouling', 'FOULING', 'G.O', 'Gap', 'GAUGE OUT', 'Gauge out', 'GO', 'H. Shift', 'H.C', 
    'H.D', 'H.GAP', 'H.Gap', 'H.M', 'H.S', 'HC', 'HEAD GAP', 'HM', 'Hole', 'Hole ng', 
    'HOLE NG', 'Hole NG', 'Hole Shift', 'HOLE.G', 'HOLE.NG', 'J.M', 'JERK.M', 'LOGO NG', 
    'LOGO.M', 'M.L', 'M.NG', 'MALE H.NG', 'ML', 'Movement', 'Movement Large', 'Movement NG', 
    'NO-DOT', 'NOGO NG', 'NUT NG', 'P.Dent', 'P.DENT', 'P.NT', 'Part Bend', 'Pin Crack', 
    'PIN DENT', 'PIN.BEND', 'PIN.D', 'PIN.H.D', 'plating ng', 'Plating ng', 'Plating NG', 
    'PLATTING', 'PLAY', 'Play', 'PNG', 'R.C', 'R.M', 'RC', 'RG', 'RIVET NG', 'Rivit miss', 
    'Rivit ng', 'RM Band', 'RNG', 'ROD', 'ROD BEND', 'Rod Gap', 'S.C', 'S.F', 'S.P', 'SC', 
    'Scratch', 'Seat Fault', 'SF', 'SP', 'Stopper NG', 'T.D', 'T.M', 'T.NG', 'TD', 'TH', 'TH D', 
    'TH.D', 'THD', 'TM', 'Tool Mark', 'W.P', 'W.PIN', 'W.S', 'WARSER MISS', 'Washer miss', 
    'weld miss', 'WELDING NG', 'Wrong ass', 'WRONG ASSEMBLE', 'Wrong Assy', 'Wrong assy', 
    'Wrong pin', 'Wrong Pin'] as const;

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

// ─── Reusable SEARCHABLE picker — same field/box look as PickerBox, and the
// exact same modal chrome (overlay, card, row styling) as the plain
// dropdowns above, just with a filter box pinned above the list. Built
// generically (plain string options + onSelect) so it can be dropped in
// for any other long dropdown later — Defect is the first use, not the
// only one.
function SearchablePickerBox({
  label,
  value,
  placeholder,
  options,
  onSelect,
  disabled,
  modalTitle,
}: {
  label: string;
  value?: string | null;
  placeholder: string;
  options: string[];
  onSelect: (value: string) => void;
  disabled?: boolean;
  modalTitle: string;
}) {
  const [visible, setVisible] = useState(false);
  const [query, setQuery] = useState('');

  // Instant client-side filter — case-insensitive substring match. The
  // full option list is already loaded (never more than a few dozen
  // items for anything this is meant for), so there's no debounce/async
  // needed: every keystroke just re-filters in place.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.toLowerCase().includes(q));
  }, [options, query]);

  function open() {
    setQuery('');
    setVisible(true);
  }

  function select(opt: string) {
    onSelect(opt);
    setVisible(false);
    setQuery('');
  }

  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <Pressable onPress={open} disabled={disabled} style={[styles.pickerBox, disabled && styles.disabledInput]}>
        <Text style={[styles.pickerBoxText, !value && styles.pickerBoxPlaceholder]} numberOfLines={1}>
          {value || placeholder}
        </Text>
        <Ionicons name="search" size={17} color="#8A96A3" />
      </Pressable>

      <Modal visible={visible} animationType="slide" transparent onRequestClose={() => setVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{modalTitle}</Text>

            <View style={styles.searchBoxRow}>
              <Ionicons name="search" size={16} color="#8A96A3" />
              <TextInput
                style={styles.searchInput}
                value={query}
                onChangeText={setQuery}
                placeholder="Type to filter…"
                placeholderTextColor="#5C6670"
                autoFocus
                autoCapitalize="none"
                autoCorrect={false}
              />
              {query.length > 0 && (
                <Pressable onPress={() => setQuery('')} hitSlop={8} accessibilityLabel="Clear search">
                  <Ionicons name="close-circle" size={16} color="#5C6670" />
                </Pressable>
              )}
            </View>

            <ScrollView contentContainerStyle={styles.modalScroll} keyboardShouldPersistTaps="handled">
              {filtered.length === 0 ? (
                <Text style={styles.muted}>No matches for "{query}"</Text>
              ) : (
                filtered.map((opt) => {
                  const isSelected = value === opt;
                  return (
                    <Pressable
                      key={opt}
                      onPress={() => select(opt)}
                      style={[styles.modalPartRow, isSelected && styles.modalPartRowSelected]}
                    >
                      <Text style={[styles.modalPartText, isSelected && styles.modalPartTextSelected]}>{opt}</Text>
                    </Pressable>
                  );
                })
              )}
            </ScrollView>

            <View style={styles.modalFooter}>
              <Pressable onPress={() => setVisible(false)} style={styles.modalBtn}>
                <Text style={styles.modalBtnText}>Close</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

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
  const [stage, setStage] = useState<RejectionStage | null>(null);
  const [qty, setQty] = useState('');
  const [defect, setDefect] = useState<string | null>(null);
  const [responsibility, setResponsibility] = useState<string | null>(null);
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
      case 'responsibility': return responsibility ?? '';
      default: return '';
    }
  }, [activeDropdown, plant, workshop, division, selectedLineId, selectedPartIndex, responsibility]);

  function handleDropdownSelect(key: string) {
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
        setResponsibility(key);
        break;
    }
    setActiveDropdown(null);
  }

  // After a successful save, only the rejection-specific fields reset — the
  // location/line stays selected, since a QC inspector logging several
  // rejections in a row for the same line shouldn't have to re-pick
  // plant/workshop/division/line/part each time.
  function resetRejectionFields() {
    setStage(null);
    setQty('');
    setDefect(null);
    setResponsibility(null);
    setRemarks('');
  }

  async function handleSave() {
    if (!plant) { Alert.alert('Missing field', 'Select a plant.'); return; }
    if (!workshop) { Alert.alert('Missing field', 'Select a workshop.'); return; }
    if (isAssemblyWorkshop(workshop) && !division) { Alert.alert('Missing field', 'Select a division.'); return; }
    if (!selectedLine) { Alert.alert('Missing field', 'Select a line.'); return; }
    if (selectedPartIndex == null || !selectedLine.parts?.[selectedPartIndex]) {
      Alert.alert('Missing field', 'Select a part.'); return;
    }
    if (!isValidDateKey(date)) { Alert.alert('Invalid date', 'Enter the date as YYYY-MM-DD.'); return; }
    if (!stage) { Alert.alert('Missing field', 'Select a rejection stage.'); return; }
    const qtyNum = Number(qty);
    if (!qty || !Number.isFinite(qtyNum) || qtyNum <= 0) {
      Alert.alert('Invalid quantity', 'Enter a rejection quantity greater than 0.'); return;
    }
    if (!defect) { Alert.alert('Missing field', 'Select a defect.'); return; }
    if (!responsibility) { Alert.alert('Missing field', 'Select a responsibility.'); return; }

    setSaving(true);
    try {
      await addDoc(collection(db, 'rejectionRecords'), {
        date,
        plant,
        workshop,
        division: division ?? null,
        lineId: selectedLine.id,
        lineName: selectedLine.lineName ?? null,
        partName: selectedLine.parts[selectedPartIndex].name,
        stage,
        rejectionQty: qtyNum,
        defect,
        responsibility,
        remarks: remarks.trim() || null,
        reportedBy: { uid: user?.uid ?? null, name: user?.name ?? null },
        createdAt: serverTimestamp(),
      });
      Alert.alert('Saved', 'Rejection record saved.');
      resetRejectionFields();
    } catch (e) {
      console.error('[RecordRejection] save', e);
      Alert.alert('Error', 'Could not save the rejection record. Check your connection.');
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
        <Text style={styles.subtitle}>Log a rejected part for a line</Text>

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

        <Text style={[styles.sectionLabel, { marginTop: 8 }]}>REJECTION DETAILS</Text>

        <View style={styles.field}>
          <Text style={styles.label}>Rejection Stage</Text>
          <View style={styles.chipsRow}>
            {REJECTION_STAGES.map((s) => (
              <Pressable
                key={s}
                onPress={() => setStage(s)}
                style={[styles.chip, stage === s && styles.chipSelected]}
              >
                <Text style={[styles.chipText, stage === s && styles.chipTextSelected]}>{s}</Text>
              </Pressable>
            ))}
          </View>
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>Rejection Qty</Text>
          <TextInput
            style={styles.input}
            value={qty}
            onChangeText={(t) => setQty(t.replace(/[^0-9]/g, ''))}
            keyboardType="number-pad"
            placeholder="0"
            placeholderTextColor="#5C6670"
          />
        </View>

        <SearchablePickerBox
          label="Defect"
          value={defect}
          placeholder="Search or select a defect"
          options={DEFECTS as unknown as string[]}
          onSelect={setDefect}
          modalTitle="Select Defect"
        />
        <PickerBox
          label="Responsibility"
          value={responsibility}
          placeholder="Select responsibility"
          onPress={() => setActiveDropdown('responsibility')}
        />

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
              <Text style={styles.saveButtonText}>Save Rejection</Text>
            </>
          )}
        </Pressable>
      </ScrollView>

      <Modal visible={activeDropdown !== null} animationType="slide" transparent onRequestClose={() => setActiveDropdown(null)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{activeDropdown ? DROPDOWN_TITLES[activeDropdown] : ''}</Text>
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

  saveButton: { height: 58, borderRadius: 12, backgroundColor: '#4C9A6A', alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 10, marginTop: 12, marginBottom: 20 },
  saveButtonPressed: { opacity: 0.85 },
  saveButtonText: { color: '#14181C', fontSize: 17, fontWeight: '900' },

  modalOverlay: { flex: 1, backgroundColor: '#00000088', alignItems: 'center', justifyContent: 'center', padding: 20 },
  modalCard: { width: '100%', maxWidth: 720, backgroundColor: '#14181C', borderRadius: 12, maxHeight: '80%', padding: 14, borderWidth: 1, borderColor: '#2C343C' },
  modalScroll: { paddingBottom: 12 },
  modalTitle: { color: '#ECEFF2', fontSize: 18, fontWeight: '800', marginBottom: 8 },
  searchBoxRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C', borderRadius: 10,
    paddingHorizontal: 12, height: 44, marginBottom: 10,
  },
  searchInput: { flex: 1, color: '#ECEFF2', fontSize: 14, height: '100%' },
  modalPartRow: { paddingVertical: 12, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, borderColor: '#2C343C', marginBottom: 8, minHeight: 48, justifyContent: 'center' },
  modalPartRowSelected: { borderColor: '#F2A93B', backgroundColor: '#F2A93B08' },
  modalPartText: { color: '#ECEFF2', fontSize: 14 },
  modalPartTextSelected: { color: '#F2A93B', fontWeight: '800' },
  modalFooter: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: '#2C343C' },
  modalBtn: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: '#2C343C', backgroundColor: '#1D2329' },
  modalBtnText: { color: '#ECEFF2', fontWeight: '700' },
});