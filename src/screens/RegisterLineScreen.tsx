import React, { useState, useEffect } from 'react';
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
import { useNavigation, useRoute } from '@react-navigation/native';
import {
  collection,
  addDoc,
  doc,
  getDoc,
  updateDoc,
  serverTimestamp,
} from 'firebase/firestore';
import { db } from '../services/firebase';
import { useAuthStore } from '../stores/authStore';
import { PLANTS, WORKSHOPS, DIVISIONS } from '../constants/lineOptions';

interface PartRow {
  id: string;
  name: string;
  cycleTime: string;
}

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function ChipSelector({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: string[];
  value: string | null;
  onChange: (v: string) => void;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.chipRow}>
        {options.map((opt) => {
          const selected = value === opt;
          return (
            <Pressable
              key={opt}
              onPress={() => onChange(opt)}
              style={[styles.chip, selected && styles.chipSelected]}
            >
              <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{opt}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export default function RegisterLineScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const user = useAuthStore((s) => s.user);

  const lineId: string | undefined = route.params?.lineId;
  const isEditMode = Boolean(lineId);

  const [loadingExisting, setLoadingExisting] = useState(isEditMode);
  const [plant, setPlant] = useState<string | null>(null);
  const [workshop, setWorkshop] = useState<string | null>(null);
  const [division, setDivision] = useState<string | null>(null);
  const [lineName, setLineName] = useState('');
  const [parts, setParts] = useState<PartRow[]>([{ id: makeId(), name: '', cycleTime: '' }]);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!isEditMode) return;
    (async () => {
      try {
        const snap = await getDoc(doc(db, 'productionLines', lineId!));
        if (snap.exists()) {
          const data: any = snap.data();
          setPlant(data.plant ?? null);
          setWorkshop(data.workshop ?? null);
          setDivision(data.division ?? null);
          setLineName(data.lineName ?? '');
          if (Array.isArray(data.parts) && data.parts.length > 0) {
            setParts(
              data.parts.map((p: any) => ({
                id: makeId(),
                name: p.name ?? '',
                cycleTime: String(p.cycleTimeSeconds ?? ''),
              }))
            );
          }
        } else {
          setFormError('This line could not be found. It may have been deleted.');
        }
      } catch (e) {
        setFormError('Could not load this line. Check your connection and try again.');
      } finally {
        setLoadingExisting(false);
      }
    })();
  }, [isEditMode, lineId]);

  const addPart = () => {
    setParts((prev) => [...prev, { id: makeId(), name: '', cycleTime: '' }]);
  };

  const removePart = (id: string) => {
    setParts((prev) => (prev.length === 1 ? prev : prev.filter((p) => p.id !== id)));
  };

  const updatePart = (id: string, field: 'name' | 'cycleTime', value: string) => {
    setParts((prev) => prev.map((p) => (p.id === id ? { ...p, [field]: value } : p)));
  };

  const validate = (): string | null => {
    if (!plant) return 'Select a plant.';
    if (!workshop) return 'Select a workshop.';
    if (!division) return 'Select a division.';
    if (!lineName.trim()) return 'Line name is required.';
    const cleanParts = parts.filter((p) => p.name.trim() || p.cycleTime.trim());
    if (cleanParts.length === 0) return 'Add at least one part.';
    for (const p of cleanParts) {
      if (!p.name.trim()) return 'Every part needs a name.';
      const t = Number(p.cycleTime);
      if (!p.cycleTime.trim() || isNaN(t) || t <= 0) {
        return `Enter a valid cycle time for "${p.name.trim()}".`;
      }
    }
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
      const cleanParts = parts
        .filter((p) => p.name.trim())
        .map((p) => ({ name: p.name.trim(), cycleTimeSeconds: Number(p.cycleTime) }));

      if (isEditMode) {
        await updateDoc(doc(db, 'productionLines', lineId!), {
          plant,
          workshop,
          division,
          lineName: lineName.trim(),
          parts: cleanParts,
          updatedBy: user?.uid ?? null,
          updatedAt: serverTimestamp(),
        });
        Alert.alert('Line Updated', `${lineName.trim()} was saved successfully.`, [
          { text: 'OK', onPress: () => navigation.goBack() },
        ]);
      } else {
        await addDoc(collection(db, 'productionLines'), {
          plant,
          workshop,
          division,
          lineName: lineName.trim(),
          parts: cleanParts,
          createdBy: user?.uid ?? null,
          createdAt: serverTimestamp(),
        });
        Alert.alert('Line Registered', `${lineName.trim()} was saved successfully.`, [
          { text: 'OK', onPress: () => navigation.navigate('Home') },
        ]);
      }
    } catch (e) {
      setFormError('Could not save to Firebase. Check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  };

  if (loadingExisting) {
    return (
      <SafeAreaView style={[styles.safeArea, styles.centered]}>
        <ActivityIndicator color="#F2A93B" size="large" />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <Pressable onPress={() => navigation.goBack()} style={styles.backButton} hitSlop={12}>
            <Ionicons name="arrow-back" size={22} color="#8A96A3" />
            <Text style={styles.backText}>Back</Text>
          </Pressable>

          <Text style={styles.title}>{isEditMode ? 'Edit Line' : 'Register New Line'}</Text>
          <Text style={styles.subtitle}>
            {isEditMode ? 'Update this line\u2019s details and parts' : 'Locate the line and define the parts it runs'}
          </Text>

          <Text style={styles.sectionLabel}>LOCATION</Text>

          <ChipSelector label="PLANT" options={PLANTS} value={plant} onChange={setPlant} />
          <ChipSelector label="WORKSHOP" options={WORKSHOPS} value={workshop} onChange={setWorkshop} />
          <ChipSelector label="DIVISION" options={DIVISIONS} value={division} onChange={setDivision} />

          <View style={styles.field}>
            <Text style={styles.label}>LINE NAME</Text>
            <TextInput
              style={styles.input}
              value={lineName}
              onChangeText={setLineName}
              placeholder="e.g. Line 12"
              placeholderTextColor="#5C6670"
            />
          </View>

          <View style={styles.divider} />

          <View style={styles.partsHeader}>
            <Text style={styles.sectionLabel}>PARTS</Text>
            <Pressable style={styles.addPartButton} onPress={addPart} hitSlop={8}>
              <Ionicons name="add-circle" size={18} color="#F2A93B" />
              <Text style={styles.addPartText}>Add Part</Text>
            </Pressable>
          </View>

          {parts.map((part, index) => (
            <View key={part.id} style={styles.partCard}>
              <View style={styles.partCardHeader}>
                <Text style={styles.partIndex}>PART {index + 1}</Text>
                {parts.length > 1 && (
                  <Pressable onPress={() => removePart(part.id)} hitSlop={10}>
                    <Ionicons name="trash-outline" size={18} color="#8A96A3" />
                  </Pressable>
                )}
              </View>

              <View style={styles.partRow}>
                <View style={[styles.field, { flex: 1.4, marginBottom: 0 }]}>
                  <Text style={styles.label}>PART NAME</Text>
                  <TextInput
                    style={styles.input}
                    value={part.name}
                    onChangeText={(v) => updatePart(part.id, 'name', v)}
                    placeholder="e.g. Swift"
                    placeholderTextColor="#5C6670"
                  />
                </View>
                <View style={[styles.field, { flex: 1, marginBottom: 0 }]}>
                  <Text style={styles.label}>CYCLE TIME (SEC)</Text>
                  <TextInput
                    style={styles.input}
                    value={part.cycleTime}
                    onChangeText={(v) => updatePart(part.id, 'cycleTime', v)}
                    placeholder="e.g. 20"
                    placeholderTextColor="#5C6670"
                    keyboardType="decimal-pad"
                  />
                </View>
              </View>
            </View>
          ))}

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
            {submitting ? (
              <ActivityIndicator color="#14181C" />
            ) : (
              <Text style={styles.submitText}>{isEditMode ? 'Update Line' : 'Register Line'}</Text>
            )}
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#14181C' },
  centered: { alignItems: 'center', justifyContent: 'center' },
  scroll: { flexGrow: 1, paddingHorizontal: 20, paddingTop: 12, paddingBottom: 48 },
  backButton: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 20 },
  backText: { color: '#8A96A3', fontSize: 15 },
  title: { color: '#ECEFF2', fontSize: 24, fontWeight: '800' },
  subtitle: { color: '#8A96A3', fontSize: 14, marginTop: 4, marginBottom: 22 },
  sectionLabel: { color: '#F2A93B', fontSize: 12, fontWeight: '800', letterSpacing: 1.4, marginBottom: 12 },
  field: { marginBottom: 16 },
  label: { color: '#8A96A3', fontSize: 11, letterSpacing: 1, marginBottom: 8, fontWeight: '700' },
  input: {
    backgroundColor: '#1D2329',
    borderWidth: 1,
    borderColor: '#2C343C',
    borderRadius: 10,
    paddingHorizontal: 14,
    height: 52,
    color: '#ECEFF2',
    fontSize: 16,
  },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  chip: {
    borderWidth: 1,
    borderColor: '#2C343C',
    backgroundColor: '#1D2329',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  chipSelected: { borderColor: '#F2A93B', backgroundColor: '#F2A93B22' },
  chipText: { color: '#8A96A3', fontSize: 13.5, fontWeight: '600' },
  chipTextSelected: { color: '#F2A93B' },
  divider: { height: 1, backgroundColor: '#2C343C', marginVertical: 22 },
  partsHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  addPartButton: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  addPartText: { color: '#F2A93B', fontSize: 14, fontWeight: '700' },
  partCard: {
    backgroundColor: '#1D2329',
    borderWidth: 1,
    borderColor: '#2C343C',
    borderRadius: 12,
    padding: 14,
    marginBottom: 14,
  },
  partCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  partIndex: { color: '#8A96A3', fontSize: 11, fontWeight: '800', letterSpacing: 1.2 },
  partRow: { flexDirection: 'row', gap: 12 },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#D6454522',
    borderWidth: 1,
    borderColor: '#D64545',
    borderRadius: 10,
    padding: 12,
    marginBottom: 18,
  },
  errorText: { color: '#F0A8A8', fontSize: 13, flex: 1 },
  submitButton: {
    height: 56,
    borderRadius: 12,
    backgroundColor: '#F2A93B',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
  },
  submitButtonPressed: { opacity: 0.85 },
  submitText: { color: '#14181C', fontSize: 16, fontWeight: '800', letterSpacing: 0.3 },
});