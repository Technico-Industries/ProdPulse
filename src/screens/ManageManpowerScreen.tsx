// src/screens/ManageManpowerScreen.tsx
//
// Manage Operators
// Firestore collection: `operators`
//
//  ADD:    Plant, Workshop, Operator Name, Operator Code, Date of Joining
//          (auto-filled with today's date), Mobile Number.
//  DELETE: Search existing operators by name or code, then remove one.

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
  query,
  orderBy,
  deleteDoc,
  doc,
  serverTimestamp,
} from 'firebase/firestore';
import { db } from '../services/firebase';
import { useAuthStore } from '../stores/authStore';
import { PLANTS, WORKSHOPS } from '../constants/lineOptions';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Operator {
  id: string;
  name: string;
  code: string;
  plant: string;
  workshop: string;
  mobile: string;
  dateOfJoining: string;
  addedBy: string;
  createdAtMs: number | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function todayDDMMYY() {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yy = String(d.getFullYear()).slice(-2);
  return `${dd}-${mm}-${yy}`;
}

function normalize(s: string) {
  return s.trim().toLowerCase();
}

export default function ManageManpowerScreen() {
  const navigation = useNavigation<any>();
  const user = useAuthStore((s) => s.user);

  // ── Add form
  const [plant, setPlant] = useState<string | null>(null);
  const [workshop, setWorkshop] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [mobile, setMobile] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  // ── Operators list (also used for search + delete)
  const [operators, setOperators] = useState<Operator[]>([]);
  const [loadingOperators, setLoadingOperators] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const today = todayDDMMYY();

  const fetchOperators = useCallback(async () => {
    setListError(null);
    try {
      const snap = await getDocs(query(collection(db, 'operators'), orderBy('name', 'asc')));
      setOperators(
        snap.docs.map((d) => {
          const data: any = d.data();
          return {
            id: d.id,
            name: data.name ?? '',
            code: data.code ?? '',
            plant: data.plant ?? '',
            workshop: data.workshop ?? '',
            mobile: data.mobile ?? '',
            dateOfJoining: data.dateOfJoining ?? '',
            addedBy: data.addedBy ?? '',
            createdAtMs: data.createdAt?.toMillis ? data.createdAt.toMillis() : null,
          };
        })
      );
    } catch (e) {
      console.error('[ManageManpower] fetch operators failed:', e);
      setListError('Could not load operators. Check your connection.');
    } finally {
      setLoadingOperators(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      fetchOperators();
    }, [fetchOperators])
  );

  const filteredOperators = useMemo(() => {
    const q = normalize(searchQuery);
    if (!q) return operators;
    return operators.filter((o) => normalize(o.name).includes(q) || normalize(o.code).includes(q));
  }, [operators, searchQuery]);

  // ─────────────────────────────────────────────────────────────────────────────
  // ADD OPERATOR
  // ─────────────────────────────────────────────────────────────────────────────

  const validate = (): string | null => {
    if (!plant) return 'Select a plant.';
    if (!workshop) return 'Select a workshop.';
    if (!name.trim()) return 'Enter operator name.';
    if (!code.trim()) return 'Enter operator code.';
    if (!/^\d{10}$/.test(mobile.trim())) return 'Enter a valid 10-digit mobile number.';
    return null;
  };

  const handleAdd = async () => {
    const err = validate();
    if (err) { setAddError(err); return; }

    const dupe = operators.some((o) => normalize(o.code) === normalize(code));
    if (dupe) { setAddError(`Operator code "${code.trim()}" is already in use.`); return; }

    setAddError(null);
    setAdding(true);
    try {
      await addDoc(collection(db, 'operators'), {
        name: name.trim(),
        code: code.trim(),
        plant,
        workshop,
        mobile: mobile.trim(),
        dateOfJoining: today,
        addedBy: user?.name || user?.email || 'Unknown',
        addedByUid: user?.uid ?? null,
        createdAt: serverTimestamp(),
      });
      Alert.alert('Added', `${name.trim()} was added as an operator.`);
      setName('');
      setCode('');
      setMobile('');
      fetchOperators();
    } catch (e) {
      console.error('[ManageManpower] add failed:', e);
      setAddError('Could not save. Check your connection and try again.');
    } finally {
      setAdding(false);
    }
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // DELETE OPERATOR
  // ─────────────────────────────────────────────────────────────────────────────

  const handleDelete = (op: Operator) => {
    Alert.alert(
      'Delete Operator?',
      `Remove ${op.name}${op.code ? ` (${op.code})` : ''}? This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setDeletingId(op.id);
            try {
              await deleteDoc(doc(db, 'operators', op.id));
              setOperators((prev) => prev.filter((o) => o.id !== op.id));
            } catch (e) {
              console.error('[ManageManpower] delete failed:', e);
              Alert.alert('Error', 'Could not delete. Check your connection and try again.');
            } finally {
              setDeletingId(null);
            }
          },
        },
      ]
    );
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

          <Text style={styles.title}>Manage Operators</Text>
          <Text style={styles.subtitle}>Add new operators, or search and remove existing ones</Text>

          {/* ADD OPERATOR */}
          <Text style={styles.sectionLabel}>ADD NEW OPERATOR</Text>

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

          <View style={styles.row}>
            <View style={[styles.field, { flex: 1.4, marginRight: 10 }]}>
              <Text style={styles.label}>OPERATOR NAME</Text>
              <TextInput style={styles.input} value={name} onChangeText={setName} placeholder="Full name" placeholderTextColor="#5C6670" />
            </View>
            <View style={[styles.field, { flex: 1 }]}>
              <Text style={styles.label}>OPERATOR CODE</Text>
              <TextInput style={styles.input} value={code} onChangeText={setCode} placeholder="e.g. OP-104" placeholderTextColor="#5C6670" autoCapitalize="characters" />
            </View>
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>DATE OF JOINING</Text>
            <View style={styles.datePill}>
              <Ionicons name="calendar-outline" size={15} color="#8A96A3" />
              <Text style={styles.datePillText}>{today}</Text>
              <View style={styles.livePill}>
                <View style={styles.liveDot} />
                <Text style={styles.liveTxt}>TODAY</Text>
              </View>
            </View>
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>MOBILE NUMBER</Text>
            <TextInput
              style={styles.input}
              value={mobile}
              onChangeText={(t) => setMobile(t.replace(/[^0-9]/g, '').slice(0, 10))}
              placeholder="10-digit mobile number"
              placeholderTextColor="#5C6670"
              keyboardType="number-pad"
              maxLength={10}
            />
          </View>

          {addError && (
            <View style={styles.errorBox}>
              <Ionicons name="alert-circle" size={16} color="#D64545" />
              <Text style={styles.errorText}>{addError}</Text>
            </View>
          )}

          <Pressable
            style={({ pressed }) => [styles.addButton, (adding || pressed) && styles.addButtonPressed]}
            onPress={handleAdd}
            disabled={adding}
          >
            {adding ? (
              <ActivityIndicator color="#14181C" />
            ) : (
              <>
                <Ionicons name="person-add" size={19} color="#14181C" />
                <Text style={styles.addButtonText}>Add Operator</Text>
              </>
            )}
          </Pressable>

          <View style={styles.divider} />

          {/* SEARCH & DELETE */}
          <Text style={styles.sectionLabel}>SEARCH & DELETE OPERATORS</Text>

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

          {loadingOperators ? (
            <ActivityIndicator color="#F2A93B" style={{ marginVertical: 24 }} />
          ) : listError ? (
            <View style={styles.errorBox}>
              <Ionicons name="alert-circle" size={16} color="#D64545" />
              <Text style={styles.errorText}>{listError}</Text>
            </View>
          ) : filteredOperators.length === 0 ? (
            <View style={styles.emptyBox}>
              <Ionicons name="people-outline" size={26} color="#5C6670" />
              <Text style={styles.emptyText}>
                {operators.length === 0 ? 'No operators added yet.' : 'No operators match your search.'}
              </Text>
            </View>
          ) : (
            filteredOperators.map((op) => (
              <View key={op.id} style={styles.opCard}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.opName}>{op.name}</Text>
                  <Text style={styles.opMeta}>
                    {op.code}{op.plant ? ` · ${op.plant}` : ''}{op.workshop ? ` · ${op.workshop}` : ''}
                  </Text>
                  <Text style={styles.opMeta}>
                    {op.mobile ? `📱 ${op.mobile}` : 'No mobile on file'}{op.dateOfJoining ? ` · Joined ${op.dateOfJoining}` : ''}
                  </Text>
                </View>
                <Pressable
                  onPress={() => handleDelete(op)}
                  disabled={deletingId === op.id}
                  style={styles.deleteButton}
                  hitSlop={8}
                >
                  {deletingId === op.id ? (
                    <ActivityIndicator size="small" color="#D64545" />
                  ) : (
                    <Ionicons name="trash-outline" size={19} color="#D64545" />
                  )}
                </Pressable>
              </View>
            ))
          )}

          <View style={{ height: 24 }} />
        </ScrollView>
      </KeyboardAvoidingView>
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
  subtitle: { color: '#8A96A3', fontSize: 13, marginTop: 4, marginBottom: 18, lineHeight: 18 },
  sectionLabel: { color: '#8A5CF5', fontSize: 11.5, fontWeight: '800', letterSpacing: 1.4, marginBottom: 12, marginTop: 6 },
  field: { marginBottom: 14 },
  label: { color: '#8A96A3', fontSize: 11, fontWeight: '700', letterSpacing: 0.6, marginBottom: 8 },
  row: { flexDirection: 'row' },
  input: {
    backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C', borderRadius: 10,
    paddingHorizontal: 12, height: 48, color: '#ECEFF2', fontSize: 14.5,
  },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  chip: {
    borderWidth: 1, borderColor: '#2C343C', backgroundColor: '#1D2329',
    borderRadius: 20, paddingHorizontal: 16, paddingVertical: 10,
  },
  chipSelected: { borderColor: '#8A5CF5', backgroundColor: '#8A5CF522' },
  chipText: { color: '#8A96A3', fontSize: 13.5, fontWeight: '600' },
  chipTextSelected: { color: '#8A5CF5' },

  datePill: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C',
    borderRadius: 10, paddingHorizontal: 14, height: 48,
  },
  datePillText: { color: '#ECEFF2', fontWeight: '700', fontSize: 14, flex: 1 },
  livePill: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  liveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#4C9A6A' },
  liveTxt: { color: '#4C9A6A', fontSize: 10, fontWeight: '800', letterSpacing: 1 },

  errorBox: {
    flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#D6454522',
    borderWidth: 1, borderColor: '#D64545', borderRadius: 10, padding: 12, marginBottom: 14,
  },
  errorText: { color: '#F0A8A8', fontSize: 13, flex: 1 },

  addButton: {
    height: 54, borderRadius: 12, backgroundColor: '#8A5CF5',
    alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8,
  },
  addButtonPressed: { opacity: 0.85 },
  addButtonText: { color: '#14181C', fontSize: 15.5, fontWeight: '900' },

  divider: { height: 1, backgroundColor: '#2C343C', marginVertical: 24 },

  searchRow: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: '#1D2329',
    borderWidth: 1, borderColor: '#2C343C', borderRadius: 10,
    paddingHorizontal: 12, height: 46, marginBottom: 16,
  },
  searchInput: { flex: 1, color: '#ECEFF2', fontSize: 14.5 },

  emptyBox: { alignItems: 'center', gap: 8, paddingVertical: 28 },
  emptyText: { color: '#5C6670', fontSize: 13.5, textAlign: 'center' },

  opCard: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: '#1D2329',
    borderWidth: 1, borderColor: '#2C343C', borderRadius: 12,
    padding: 14, marginBottom: 10, gap: 10,
  },
  opName: { color: '#ECEFF2', fontSize: 15, fontWeight: '700' },
  opMeta: { color: '#8A96A3', fontSize: 12, marginTop: 3 },
  deleteButton: {
    width: 38, height: 38, borderRadius: 10, borderWidth: 1, borderColor: '#D6454555',
    alignItems: 'center', justifyContent: 'center',
  },
});