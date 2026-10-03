// src/screens/MaterialOrderScreen.tsx
//
// Lets a supervisor request material for a line: pick Plant / Workshop /
// Division / Line / Part (same tap-a-box → modal-list pattern used in
// RecordProductionScreen), then describe the specific item needed
// (e.g. "ARM", "BKT", "pin") in a free-text box. Submits to the
// `materialOrders` collection as a pending request.

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
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { collection, getDocs, addDoc, updateDoc, doc, onSnapshot, query, where, orderBy, Timestamp, serverTimestamp } from 'firebase/firestore';
import { db } from '../services/firebase';
import { useAuthStore } from '../stores/authStore';
import { PLANTS, WORKSHOPS, DIVISIONS } from '../constants/lineOptions';

// A restocker's "In Stock" response promises supply within this window —
// shown as a live countdown below. Must match SUPPLY_ETA_MINUTES in
// DashboardScreen.tsx (the restocker side that starts this timer).
const SUPPLY_ETA_MINUTES = 5;

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function formatClockTime(ms: number): string {
  const d = new Date(ms);
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m} ${ampm}`;
}

function formatAgo(ms: number | null, nowMs: number): string {
  if (!ms) return '';
  const diffMin = Math.max(0, Math.floor((nowMs - ms) / 60000));
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const h = Math.floor(diffMin / 60);
  return h < 24 ? `${h}h ago` : formatClockTime(ms);
}

function formatCountdown(etaAtMs: number, nowMs: number): string {
  const remainingSec = Math.max(0, Math.round((etaAtMs - nowMs) / 1000));
  const m = Math.floor(remainingSec / 60);
  const s = remainingSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

interface MyOrder {
  id: string;
  lineName: string;
  partName: string | null;
  detail: string;
  status: 'pending' | 'in_stock' | 'out_of_stock' | 'received';
  createdAtMs: number | null;
  respondedAtMs: number | null;
  respondedByName: string | null;
  receivedAtMs: number | null;
  etaMinutes: number | null;
}

// ─── Types ────────────────────────────────────────────────────────────────────

type Line = {
  id: string;
  plant?: string | null;
  workshop?: string | null;
  division?: string | null;
  lineName?: string | null;
  parts?: { name: string; cycleTimeSeconds: number }[];
};

type DropdownKind = 'plant' | 'workshop' | 'division' | 'line' | 'part';
type DropdownOption = { key: string; label: string; sublabel?: string };

const DROPDOWN_TITLES: Record<DropdownKind, string> = {
  plant: 'Select Plant',
  workshop: 'Select Workshop',
  division: 'Select Division',
  line: 'Select Line',
  part: 'Select Part / Model',
};

// ─── Dropdown picker box (tap → modal list), same pattern as RecordProductionScreen ──

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

// ─── Component ────────────────────────────────────────────────────────────────

export default function MaterialOrderScreen() {
  const navigation = useNavigation<any>();
  const user = useAuthStore((s) => s.user);

  const [plant, setPlant] = useState<string | null>(null);
  const [workshop, setWorkshop] = useState<string | null>(null);
  const [division, setDivision] = useState<string | null>(null);
  const [selectedLineId, setSelectedLineId] = useState<string | null>(null);
  const [selectedPartIndex, setSelectedPartIndex] = useState<number | null>(null);
  const [detail, setDetail] = useState('');

  const [allLines, setAllLines] = useState<Line[]>([]);
  const [loadingLines, setLoadingLines] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [activeDropdown, setActiveDropdown] = useState<DropdownKind | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // ── Your requests today (live) — reflects a restocker's In Stock / Out of
  // Stock response the moment they respond, including the 5-minute supply
  // countdown started by "In Stock".
  const [myOrders, setMyOrders] = useState<MyOrder[]>([]);
  const [myOrdersLoading, setMyOrdersLoading] = useState(true);
  const [nowMs, setNowMs] = useState(Date.now());
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      // Range-filters on createdAt + orderBy the same field only (so no
      // composite index is needed), then keeps just this supervisor's own
      // requests client-side.
      const rangeStart = Timestamp.fromDate(startOfToday());
      const unsubscribe = onSnapshot(
        query(collection(db, 'materialOrders'), where('createdAt', '>=', rangeStart), orderBy('createdAt', 'desc')),
        (snap) => {
          const mine = snap.docs
            .map((d) => {
              const data: any = d.data();
              return {
                id: d.id,
                lineName: data.lineName ?? 'Unknown line',
                partName: data.partName ?? null,
                detail: data.detail ?? '',
                status: data.status ?? 'pending',
                createdAtMs: data.createdAt?.toMillis ? data.createdAt.toMillis() : null,
                respondedAtMs: data.respondedAt?.toMillis ? data.respondedAt.toMillis() : null,
                respondedByName: data.respondedBy?.name ?? null,
                receivedAtMs: data.receivedAt?.toMillis ? data.receivedAt.toMillis() : null,
                etaMinutes: data.etaMinutes ?? null,
                requestedByUid: data.requestedBy?.uid ?? null,
              } as MyOrder & { requestedByUid: string | null };
            })
            .filter((o) => o.requestedByUid === user?.uid);
          setMyOrders(mine);
          setMyOrdersLoading(false);
        },
        (err) => {
          console.error('[materialOrders/mine] listener error:', err.code, err.message);
          setMyOrdersLoading(false);
        }
      );

      const tickInterval = setInterval(() => setNowMs(Date.now()), 1000);

      return () => {
        unsubscribe();
        clearInterval(tickInterval);
      };
    }, [user?.uid])
  );

  const selectedLine = allLines.find((l) => l.id === selectedLineId) ?? null;

  // ── Load all production lines once, same source RecordProductionScreen uses
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
        setLoadingLines(false);
      } catch (e) {
        if (mounted) {
          setLoadError('Could not load lines. Check your connection and try again.');
          setLoadingLines(false);
        }
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
        return PLANTS.map((p) => ({ key: p, label: p }));
      case 'workshop':
        return WORKSHOPS.map((w) => ({ key: w, label: w }));
      case 'division':
        return DIVISIONS.map((d) => ({ key: d, label: d }));
      case 'line':
        return filteredLines.map((l) => ({
          key: l.id,
          label: l.lineName ?? l.id,
          sublabel: [l.plant, l.workshop].filter(Boolean).join(' · ') || undefined,
        }));
      case 'part':
        return (selectedLine?.parts ?? []).map((p, i) => ({ key: String(i), label: `${p.name} · ${p.cycleTimeSeconds}s` }));
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
      case 'part': return selectedPartIndex == null ? '' : String(selectedPartIndex);
      default: return '';
    }
  }, [activeDropdown, plant, workshop, division, selectedLineId, selectedPartIndex]);

  function handleDropdownSelect(key: string) {
    switch (activeDropdown) {
      case 'plant':
        setPlant(key);
        // Changing a location filter can invalidate the line/part already
        // chosen, so clear anything downstream rather than leave a stale pick.
        setSelectedLineId(null);
        setSelectedPartIndex(null);
        break;
      case 'workshop':
        setWorkshop(key);
        setSelectedLineId(null);
        setSelectedPartIndex(null);
        break;
      case 'division':
        setDivision(key);
        setSelectedLineId(null);
        setSelectedPartIndex(null);
        break;
      case 'line':
        setSelectedLineId(key);
        setSelectedPartIndex(null);
        break;
      case 'part':
        setSelectedPartIndex(Number(key));
        break;
    }
    setActiveDropdown(null);
  }

  const validate = (): string | null => {
    if (!plant) return 'Select a plant.';
    if (!workshop) return 'Select a workshop.';
    if (!division) return 'Select a division.';
    if (!selectedLineId) return 'Select a line.';
    if (selectedPartIndex == null) return 'Select a part.';
    if (!detail.trim()) return 'Describe the material you need (e.g. ARM, BKT, pin).';
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
      const part = selectedLine?.parts?.[selectedPartIndex!] ?? null;
      await addDoc(collection(db, 'materialOrders'), {
        plant,
        workshop,
        division,
        lineId: selectedLineId,
        lineName: selectedLine?.lineName ?? null,
        partName: part?.name ?? null,
        detail: detail.trim(),
        status: 'pending',
        requestedBy: { uid: user?.uid ?? null, name: user?.name ?? user?.email ?? null },
        createdAt: serverTimestamp(),
      });
      Alert.alert('Order Submitted', 'Your material request has been sent.', [
        { text: 'OK', onPress: () => navigation.goBack() },
      ]);
    } catch (e) {
      setFormError('Could not submit the order. Check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleConfirmReceived = async (item: MyOrder) => {
    setConfirmingId(item.id);
    try {
      await updateDoc(doc(db, 'materialOrders', item.id), {
        status: 'received',
        receivedBy: { uid: user?.uid ?? null, name: user?.name ?? user?.email ?? null },
        receivedAt: serverTimestamp(),
      });
    } catch (e) {
      Alert.alert('Error', 'Could not confirm receipt. Check your connection and try again.');
    } finally {
      setConfirmingId(null);
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

          <Text style={styles.title}>Material Order</Text>
          <Text style={styles.subtitle}>Select the line and part, then describe what's needed</Text>

          {loadingLines ? (
            <View style={styles.centered}>
              <ActivityIndicator color="#F2A93B" size="large" />
            </View>
          ) : loadError ? (
            <View style={styles.errorBox}>
              <Ionicons name="alert-circle" size={16} color="#D64545" />
              <Text style={styles.errorText}>{loadError}</Text>
            </View>
          ) : (
            <>
              <Text style={styles.sectionLabel}>LOCATION & LINE</Text>

              <PickerBox label="PLANT" value={plant} placeholder="Select plant" onPress={() => setActiveDropdown('plant')} />
              <PickerBox label="WORKSHOP" value={workshop} placeholder="Select workshop" onPress={() => setActiveDropdown('workshop')} />
              <PickerBox label="DIVISION" value={division} placeholder="Select division" onPress={() => setActiveDropdown('division')} />
              <PickerBox
                label="LINE"
                value={selectedLine?.lineName ?? null}
                placeholder={filteredLines.length ? 'Select line' : 'No lines match these filters'}
                onPress={() => setActiveDropdown('line')}
                disabled={filteredLines.length === 0}
              />
              <PickerBox
                label="PART"
                value={selectedPartIndex != null ? selectedLine?.parts?.[selectedPartIndex]?.name : null}
                placeholder={selectedLine?.parts?.length ? 'Select part' : 'Select a line first'}
                onPress={() => setActiveDropdown('part')}
                disabled={!selectedLine?.parts?.length}
              />

              <View style={styles.divider} />

              <Text style={styles.sectionLabel}>MATERIAL DETAIL</Text>
              <View style={styles.field}>
                <Text style={styles.label}>WHAT DO YOU NEED?</Text>
                <TextInput
                  style={styles.textArea}
                  value={detail}
                  onChangeText={setDetail}
                  placeholder="e.g. ARM, BKT, pin — describe the specific item"
                  placeholderTextColor="#5C6670"
                  multiline
                  numberOfLines={4}
                  textAlignVertical="top"
                />
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
                {submitting ? (
                  <ActivityIndicator color="#14181C" />
                ) : (
                  <Text style={styles.submitText}>Submit Order</Text>
                )}
              </Pressable>

              <View style={styles.divider} />

              <Text style={styles.sectionLabel}>YOUR REQUESTS TODAY</Text>
              {myOrdersLoading ? (
                <ActivityIndicator color="#F2A93B" style={{ marginVertical: 12 }} />
              ) : myOrders.length === 0 ? (
                <Text style={styles.muted}>No requests submitted today</Text>
              ) : (
                myOrders.map((item) => {
                  const isInStock = item.status === 'in_stock';
                  const isOutOfStock = item.status === 'out_of_stock';
                  const isReceived = item.status === 'received';
                  const etaAtMs = isInStock && item.respondedAtMs != null ? item.respondedAtMs + (item.etaMinutes ?? SUPPLY_ETA_MINUTES) * 60000 : null;
                  const stillWaiting = etaAtMs != null && nowMs < etaAtMs;
                  return (
                    <View
                      key={item.id}
                      style={[
                        styles.orderCard,
                        isInStock && styles.orderCardInStock,
                        isOutOfStock && styles.orderCardOutOfStock,
                        isReceived && styles.orderCardReceived,
                      ]}
                    >
                      <View style={styles.orderTopRow}>
                        <Text style={styles.orderLine}>{item.lineName}</Text>
                        <Text
                          style={[
                            styles.orderStatusBadge,
                            isInStock && styles.orderStatusInStock,
                            isOutOfStock && styles.orderStatusOutOfStock,
                            isReceived && styles.orderStatusReceived,
                          ]}
                        >
                          {isReceived ? 'RECEIVED' : isInStock ? 'SUPPLY COMING' : isOutOfStock ? 'OUT OF STOCK' : 'WAITING'}
                        </Text>
                      </View>
                      {item.partName && <Text style={styles.orderDetail}>Part: {item.partName}</Text>}
                      {!!item.detail && <Text style={styles.orderDetail}>{item.detail}</Text>}
                      {isInStock && etaAtMs != null && (
                        <View style={styles.countdownRow}>
                          <Ionicons name="timer-outline" size={13} color="#F2A93B" />
                          <Text style={styles.countdownText}>
                            {stillWaiting ? `Arriving in ${formatCountdown(etaAtMs, nowMs)}` : 'Should be here any moment'}
                          </Text>
                        </View>
                      )}
                      {isInStock && (
                        <Pressable
                          onPress={() => handleConfirmReceived(item)}
                          disabled={confirmingId === item.id}
                          style={({ pressed }) => [
                            styles.confirmButton,
                            (confirmingId === item.id || pressed) && styles.confirmButtonPressed,
                          ]}
                        >
                          {confirmingId === item.id ? (
                            <ActivityIndicator color="#14181C" size="small" />
                          ) : (
                            <>
                              <Ionicons name="checkmark-circle" size={16} color="#14181C" />
                              <Text style={styles.confirmButtonText}>Confirm Material Received</Text>
                            </>
                          )}
                        </Pressable>
                      )}
                      <Text style={styles.orderMeta}>
                        {isReceived
                          ? `You confirmed receipt ${formatAgo(item.receivedAtMs, nowMs)}`
                          : item.status === 'pending'
                          ? `Requested ${formatAgo(item.createdAtMs, nowMs)}`
                          : `${item.respondedByName ?? 'Restocker'} responded ${item.respondedAtMs != null ? formatAgo(item.respondedAtMs, nowMs) : ''}`}
                      </Text>
                    </View>
                  );
                })
              )}
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>

      {/* ── Dropdown modal (shared by all picker boxes) */}
      <Modal visible={activeDropdown !== null} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{activeDropdown ? DROPDOWN_TITLES[activeDropdown] : ''}</Text>
            <ScrollView contentContainerStyle={styles.modalScroll}>
              {dropdownOptions.length === 0 ? (
                <Text style={styles.muted}>No options available</Text>
              ) : (
                dropdownOptions.map((opt) => (
                  <Pressable
                    key={opt.key}
                    onPress={() => handleDropdownSelect(opt.key)}
                    style={[styles.modalRow, dropdownSelectedKey === opt.key && styles.modalRowSelected]}
                  >
                    <Text style={[styles.modalRowText, dropdownSelectedKey === opt.key && styles.modalRowTextSelected]}>
                      {opt.label}
                    </Text>
                    {opt.sublabel && <Text style={styles.modalRowSublabel}>{opt.sublabel}</Text>}
                  </Pressable>
                ))
              )}
            </ScrollView>
            <View style={styles.modalFooter}>
              <Pressable onPress={() => setActiveDropdown(null)} style={styles.modalBtn}>
                <Text style={styles.modalBtnText}>Cancel</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#14181C' },
  scroll: { flexGrow: 1, paddingHorizontal: 20, paddingTop: 12, paddingBottom: 48 },
  backButton: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 20 },
  backText: { color: '#8A96A3', fontSize: 15 },
  title: { color: '#ECEFF2', fontSize: 24, fontWeight: '800' },
  subtitle: { color: '#8A96A3', fontSize: 14, marginTop: 4, marginBottom: 22 },
  sectionLabel: { color: '#F2A93B', fontSize: 12, fontWeight: '800', letterSpacing: 1.4, marginBottom: 12, marginTop: 4 },
  centered: { alignItems: 'center', justifyContent: 'center', paddingVertical: 40 },

  field: { marginBottom: 16 },
  label: { color: '#8A96A3', fontSize: 11, letterSpacing: 1, marginBottom: 8, fontWeight: '700' },
  pickerBox: {
    backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C', borderRadius: 10,
    paddingHorizontal: 14, height: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  pickerBoxText: { color: '#ECEFF2', fontSize: 15, flex: 1, marginRight: 8 },
  pickerBoxPlaceholder: { color: '#5C6670' },
  disabledInput: { opacity: 0.5, backgroundColor: '#14181C' },

  textArea: {
    backgroundColor: '#1D2329',
    borderWidth: 1,
    borderColor: '#2C343C',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    minHeight: 110,
    color: '#ECEFF2',
    fontSize: 15,
  },

  divider: { height: 1, backgroundColor: '#2C343C', marginVertical: 22 },

  errorBox: {
    flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#D6454522',
    borderWidth: 1, borderColor: '#D64545', borderRadius: 10, padding: 12, marginBottom: 18,
  },
  errorText: { color: '#F0A8A8', fontSize: 13, flex: 1 },
  muted: { color: '#8A96A3', fontSize: 13, textAlign: 'center', paddingVertical: 20 },

  // Your Requests Today
  orderCard: {
    backgroundColor: '#1D2329',
    borderWidth: 1,
    borderColor: '#2C343C',
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
  },
  orderCardInStock: { borderColor: '#4C9A6A55' },
  orderCardOutOfStock: { borderColor: '#D6454555' },
  orderCardReceived: { borderColor: '#3E7CB155', backgroundColor: '#1D232955' },
  orderTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  orderLine: { color: '#ECEFF2', fontSize: 14.5, fontWeight: '800', flex: 1, marginRight: 8 },
  orderStatusBadge: {
    color: '#8A96A3',
    fontSize: 10.5,
    fontWeight: '800',
    letterSpacing: 0.5,
    backgroundColor: '#2C343C',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
    overflow: 'hidden',
  },
  orderStatusInStock: { color: '#4C9A6A', backgroundColor: '#4C9A6A22' },
  orderStatusOutOfStock: { color: '#D64545', backgroundColor: '#D6454522' },
  orderStatusReceived: { color: '#3E7CB1', backgroundColor: '#3E7CB122' },
  orderDetail: { color: '#8A96A3', fontSize: 12.5, marginTop: 2 },
  countdownRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 },
  countdownText: { color: '#F2A93B', fontSize: 12.5, fontWeight: '700' },
  orderMeta: { color: '#5C6670', fontSize: 11, marginTop: 8 },
  confirmButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    backgroundColor: '#4C9A6A',
    borderRadius: 8,
    height: 42,
    marginTop: 10,
  },
  confirmButtonPressed: { opacity: 0.85 },
  confirmButtonText: { color: '#14181C', fontSize: 13, fontWeight: '800' },


  submitButton: {
    height: 56, borderRadius: 12, backgroundColor: '#F2A93B',
    alignItems: 'center', justifyContent: 'center', marginTop: 4,
  },
  submitButtonPressed: { opacity: 0.85 },
  submitText: { color: '#14181C', fontSize: 16, fontWeight: '800', letterSpacing: 0.3 },

  // ── Modal
  modalOverlay: { flex: 1, backgroundColor: '#00000088', alignItems: 'center', justifyContent: 'center', padding: 20 },
  modalCard: { width: '100%', maxWidth: 720, backgroundColor: '#14181C', borderRadius: 12, maxHeight: '80%', padding: 14, borderWidth: 1, borderColor: '#2C343C' },
  modalScroll: { paddingBottom: 12 },
  modalTitle: { color: '#ECEFF2', fontSize: 18, fontWeight: '800', marginBottom: 8 },
  modalRow: { paddingVertical: 12, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, borderColor: '#2C343C', marginBottom: 8, minHeight: 48, justifyContent: 'center' },
  modalRowSelected: { borderColor: '#F2A93B', backgroundColor: '#F2A93B08' },
  modalRowText: { color: '#ECEFF2', fontSize: 14 },
  modalRowTextSelected: { color: '#F2A93B', fontWeight: '800' },
  modalRowSublabel: { color: '#8A96A3', fontSize: 12, marginTop: 2 },
  modalFooter: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: '#2C343C' },
  modalBtn: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: '#2C343C', backgroundColor: '#1D2329' },
  modalBtnText: { color: '#ECEFF2', fontWeight: '700' },
});