import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  TextInput,
  StyleSheet,
  SafeAreaView,
  FlatList,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { db } from '../services/firebase';
import { ASSIGN_ROLES } from '../constants/lineOptions';

interface InchargeItem {
  id: string;
  name: string;
  employeeCode: string;
  email: string;
  assign: string;
  active: boolean;
}

export default function ManageInchargeScreen() {
  const navigation = useNavigation<any>();
  const [incharges, setIncharges] = useState<InchargeItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('all');
  const [assignFilter, setAssignFilter] = useState<string | null>(null);

  const fetchIncharges = useCallback(async () => {
    setLoadError(null);
    try {
      const q = query(collection(db, 'users'), where('role', '==', 'supervisor'));
      const snap = await getDocs(q);
      const items: InchargeItem[] = snap.docs
        .map((d) => {
          const data: any = d.data();
          return {
            id: d.id,
            name: data.name ?? 'Unnamed',
            employeeCode: data.employeeCode ?? '',
            email: data.email ?? '—',
            assign: data.assign ?? '',
            active: data.active !== false,
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      setIncharges(items);
    } catch (e) {
      setLoadError('Could not load incharges. Check your connection and try again.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      fetchIncharges();
    }, [fetchIncharges])
  );

  const handleRefresh = () => {
    setRefreshing(true);
    fetchIncharges();
  };

  const filteredIncharges = incharges.filter((s) => {
    if (statusFilter === 'active' && !s.active) return false;
    if (statusFilter === 'inactive' && s.active) return false;
    if (assignFilter && s.assign !== assignFilter) return false;
    const q = searchQuery.trim().toLowerCase();
    if (q) {
      const matchesName = s.name.toLowerCase().includes(q);
      const matchesCode = s.employeeCode.toLowerCase().includes(q);
      if (!matchesName && !matchesCode) return false;
    }
    return true;
  });

  return (
    <SafeAreaView style={styles.safeArea}>
      <Pressable onPress={() => navigation.goBack()} style={styles.backButton} hitSlop={12}>
        <Ionicons name="arrow-back" size={22} color="#8A96A3" />
        <Text style={styles.backText}>Back</Text>
      </Pressable>

      <View style={styles.header}>
        <Text style={styles.title}>Manage Incharge</Text>
        <Text style={styles.subtitle}>Tap an incharge to edit their account</Text>
      </View>

      <View style={styles.searchBar}>
        <Ionicons name="search" size={18} color="#5C6670" />
        <TextInput
          style={styles.searchInput}
          value={searchQuery}
          onChangeText={setSearchQuery}
          placeholder="Search by name or employee code"
          placeholderTextColor="#5C6670"
          autoCapitalize="none"
        />
        {searchQuery.length > 0 && (
          <Pressable onPress={() => setSearchQuery('')} hitSlop={8}>
            <Ionicons name="close-circle" size={18} color="#5C6670" />
          </Pressable>
        )}
      </View>

      <View style={styles.filterGroup}>
        <Text style={styles.filterLabel}>STATUS</Text>
        <View style={styles.chipRow}>
          {(['all', 'active', 'inactive'] as const).map((s) => {
            const selected = statusFilter === s;
            const label = s === 'all' ? 'All' : s === 'active' ? 'Active' : 'Inactive';
            return (
              <Pressable
                key={s}
                onPress={() => setStatusFilter(s)}
                style={[styles.chip, selected && styles.chipSelected]}
              >
                <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{label}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <View style={styles.filterGroup}>
        <Text style={styles.filterLabel}>ASSIGNED AS</Text>
        <View style={styles.chipRow}>
          <Pressable
            onPress={() => setAssignFilter(null)}
            style={[styles.chip, !assignFilter && styles.chipSelected]}
          >
            <Text style={[styles.chipText, !assignFilter && styles.chipTextSelected]}>All</Text>
          </Pressable>
          {ASSIGN_ROLES.map((role) => {
            const selected = assignFilter === role;
            return (
              <Pressable
                key={role}
                onPress={() => setAssignFilter(selected ? null : role)}
                style={[styles.chip, selected && styles.chipSelected]}
              >
                <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{role}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      {!loading && !loadError && incharges.length > 0 && (
        <Text style={styles.resultCount}>
          {filteredIncharges.length} of {incharges.length} incharge{incharges.length === 1 ? '' : 's'}
        </Text>
      )}

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator color="#F2A93B" size="large" />
        </View>
      ) : loadError ? (
        <View style={styles.centered}>
          <Ionicons name="alert-circle" size={22} color="#D64545" />
          <Text style={styles.errorText}>{loadError}</Text>
          <Pressable onPress={fetchIncharges} style={styles.retryButton}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : incharges.length === 0 ? (
        <View style={styles.centered}>
          <Ionicons name="people-outline" size={28} color="#5C6670" />
          <Text style={styles.emptyText}>No incharges registered yet</Text>
        </View>
      ) : filteredIncharges.length === 0 ? (
        <View style={styles.centered}>
          <Ionicons name="search" size={28} color="#5C6670" />
          <Text style={styles.emptyText}>No incharges match your filters</Text>
        </View>
      ) : (
        <FlatList
          data={filteredIncharges}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listContent}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor="#F2A93B" />}
          renderItem={({ item }) => (
            <Pressable
              style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
              onPress={() => navigation.navigate('EditIncharge', { uid: item.id })}
            >
              <View
                style={[
                  styles.avatar,
                  { borderColor: item.active ? '#4C9A6A' : '#5C6670', backgroundColor: item.active ? '#4C9A6A22' : '#5C667022' },
                ]}
              >
                <Text style={[styles.avatarText, { color: item.active ? '#4C9A6A' : '#5C6670' }]}>
                  {item.name.slice(0, 2).toUpperCase()}
                </Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.cardTitle}>{item.name}</Text>
                <Text style={styles.cardSubtitle}>
                  {item.employeeCode ? `${item.employeeCode} · ` : ''}
                  {item.email}
                </Text>
                {item.assign ? <Text style={styles.cardAssign}>{item.assign}</Text> : null}
              </View>
              <View style={[styles.statusBadge, !item.active && styles.statusBadgeInactive]}>
                <Text style={[styles.statusText, !item.active && styles.statusTextInactive]}>
                  {item.active ? 'Active' : 'Inactive'}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={20} color="#5C6670" />
            </Pressable>
          )}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#14181C' },
  backButton: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 20, marginTop: 12 },
  backText: { color: '#8A96A3', fontSize: 15 },
  header: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 12 },
  title: { color: '#ECEFF2', fontSize: 22, fontWeight: '800' },
  subtitle: { color: '#8A96A3', fontSize: 13, marginTop: 4 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 30 },
  errorText: { color: '#F0A8A8', fontSize: 13.5, textAlign: 'center' },
  emptyText: { color: '#5C6670', fontSize: 14 },
  retryButton: {
    borderWidth: 1,
    borderColor: '#2C343C',
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
    marginTop: 4,
  },
  retryText: { color: '#ECEFF2', fontSize: 13, fontWeight: '600' },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginHorizontal: 20,
    backgroundColor: '#1D2329',
    borderWidth: 1,
    borderColor: '#2C343C',
    borderRadius: 10,
    paddingHorizontal: 14,
    height: 46,
    marginBottom: 12,
  },
  searchInput: { flex: 1, color: '#ECEFF2', fontSize: 14.5 },
  filterGroup: { paddingHorizontal: 20, marginBottom: 10, gap: 8 },
  filterLabel: { color: '#5C6670', fontSize: 10.5, fontWeight: '800', letterSpacing: 1.2 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    borderWidth: 1,
    borderColor: '#2C343C',
    backgroundColor: '#1D2329',
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  chipSelected: { borderColor: '#F2A93B', backgroundColor: '#F2A93B22' },
  chipText: { color: '#8A96A3', fontSize: 12.5, fontWeight: '600' },
  chipTextSelected: { color: '#F2A93B' },
  resultCount: { color: '#5C6670', fontSize: 12, paddingHorizontal: 20, paddingBottom: 8 },
  listContent: { paddingHorizontal: 20, paddingBottom: 40, gap: 12 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: '#1D2329',
    borderWidth: 1,
    borderColor: '#2C343C',
    borderRadius: 12,
    padding: 14,
  },
  cardPressed: { backgroundColor: '#242B32', borderColor: '#3A434C' },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 10,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { fontSize: 13, fontWeight: '800' },
  cardTitle: { color: '#ECEFF2', fontSize: 15, fontWeight: '700' },
  cardSubtitle: { color: '#8A96A3', fontSize: 12.5, marginTop: 2 },
  cardAssign: { color: '#3E7CB1', fontSize: 11.5, fontWeight: '700', marginTop: 3 },
  statusBadge: {
    backgroundColor: '#4C9A6A22',
    borderWidth: 1,
    borderColor: '#4C9A6A',
    borderRadius: 8,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  statusBadgeInactive: { backgroundColor: '#5C667022', borderColor: '#5C6670' },
  statusText: { color: '#4C9A6A', fontSize: 11, fontWeight: '700' },
  statusTextInactive: { color: '#8A96A3' },
});