import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  SafeAreaView,
  FlatList,
  ActivityIndicator,
  RefreshControl,
  Alert,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { collection, getDocs, orderBy, query, deleteDoc, doc } from 'firebase/firestore';
import { db } from '../services/firebase';
import { WORKSHOPS, DIVISIONS } from '../constants/lineOptions';

interface LineItem {
  id: string;
  plant: string;
  workshop: string;
  division: string;
  lineName: string;
  partCount: number;
}

export default function ManageLinesScreen() {
  const navigation = useNavigation<any>();
  const [lines, setLines] = useState<LineItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [filterWorkshop, setFilterWorkshop] = useState<string | null>(null);
  const [filterDivision, setFilterDivision] = useState<string | null>(null);

  const fetchLines = useCallback(async () => {
    setLoadError(null);
    try {
      const q = query(collection(db, 'productionLines'), orderBy('lineName'));
      const snap = await getDocs(q);
      setLines(
        snap.docs.map((d) => {
          const data: any = d.data();
          return {
            id: d.id,
            plant: data.plant ?? '—',
            workshop: data.workshop ?? '—',
            division: data.division ?? '—',
            lineName: data.lineName ?? '—',
            partCount: Array.isArray(data.parts) ? data.parts.length : 0,
          };
        })
      );
    } catch (e) {
      setLoadError('Could not load lines. Check your connection and try again.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Refresh every time this screen comes back into focus (e.g. after editing a line)
  useFocusEffect(
    useCallback(() => {
      fetchLines();
    }, [fetchLines])
  );

  const handleRefresh = () => {
    setRefreshing(true);
    fetchLines();
  };

  const filteredLines = lines.filter((line) => {
    if (filterWorkshop && line.workshop !== filterWorkshop) return false;
    if (filterDivision && line.division !== filterDivision) return false;
    return true;
  });

  const hasActiveFilters = Boolean(filterWorkshop || filterDivision);
  const clearFilters = () => {
    setFilterWorkshop(null);
    setFilterDivision(null);
  };

  const handleDelete = (item: LineItem) => {
    console.log('[handleDelete] START', { id: item.id, lineName: item.lineName, platform: Platform.OS });

    // Same body that used to live only inside Alert.alert's "Delete" button
    // onPress — extracted so both the web and native confirm paths call the
    // exact same logic instead of duplicating it.
    const proceedWithDelete = async () => {
      console.log('[handleDelete] CONFIRM (Delete) CALLBACK FIRED', { id: item.id });
      setDeletingId(item.id);
      try {
        console.log('[handleDelete] calling deleteDoc(productionLines/', item.id, ')…');
        await deleteDoc(doc(db, 'productionLines', item.id));
        console.log('[handleDelete] deleteDoc resolved — updating local state');
        setLines((prev) => prev.filter((l) => l.id !== item.id));
        console.log('[handleDelete] END — deletion completed');
      } catch (e) {
        console.error('[handleDelete] EXCEPTION during delete', e);
        if (Platform.OS === 'web') {
          window.alert('Could not delete this line. Check your connection and try again.');
        } else {
          Alert.alert('Error', 'Could not delete this line. Check your connection and try again.');
        }
      } finally {
        setDeletingId(null);
      }
    };

    console.log('[handleDelete] about to show the delete confirm dialog');

    // ROOT CAUSE: react-native-web's Alert.alert has no real native modal to
    // back it — it does not reliably wire up onPress for a multi-button
    // (Cancel/Delete) dialog. The call itself doesn't throw, it just never
    // invokes either button's onPress on web, so this handler's actual
    // delete logic — which lived entirely inside the "Delete" button's
    // onPress — never ran. Android/iOS are unaffected because they use the
    // real native Alert, which does support multi-button callbacks.
    if (Platform.OS === 'web') {
      const confirmed = window.confirm(
        `Delete Line\n\nRemove ${item.lineName} (${item.plant} · ${item.workshop})? This cannot be undone.`
      );
      console.log('[handleDelete] window.confirm result (web)', confirmed);
      if (!confirmed) {
        console.log('[handleDelete] Cancel pressed (web)');
        return;
      }
      proceedWithDelete();
    } else {
      Alert.alert(
        'Delete Line',
        `Remove ${item.lineName} (${item.plant} \u00b7 ${item.workshop})? This cannot be undone.`,
        [
          { text: 'Cancel', style: 'cancel', onPress: () => console.log('[handleDelete] Cancel pressed') },
          { text: 'Delete', style: 'destructive', onPress: proceedWithDelete },
        ]
      );
      console.log('[handleDelete] Alert.alert(...) call returned');
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <Pressable onPress={() => navigation.goBack()} style={styles.backButton} hitSlop={12}>
        <Ionicons name="arrow-back" size={22} color="#8A96A3" />
        <Text style={styles.backText}>Back</Text>
      </Pressable>

      <View style={styles.header}>
        <Text style={styles.title}>Manage Lines</Text>
        <Text style={styles.subtitle}>Tap a line to edit its details or models</Text>
      </View>

      <View style={styles.filters}>
        <View style={styles.filterGroup}>
          <Text style={styles.filterLabel}>WORKSHOP</Text>
          <View style={styles.chipRow}>
            <Pressable
              onPress={() => setFilterWorkshop(null)}
              style={[styles.chip, !filterWorkshop && styles.chipSelected]}
            >
              <Text style={[styles.chipText, !filterWorkshop && styles.chipTextSelected]}>All</Text>
            </Pressable>
            {WORKSHOPS.map((w) => {
              const selected = filterWorkshop === w;
              return (
                <Pressable
                  key={w}
                  onPress={() => setFilterWorkshop(selected ? null : w)}
                  style={[styles.chip, selected && styles.chipSelected]}
                >
                  <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{w}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        <View style={styles.filterGroup}>
          <Text style={styles.filterLabel}>DIVISION</Text>
          <View style={styles.chipRow}>
            <Pressable
              onPress={() => setFilterDivision(null)}
              style={[styles.chip, !filterDivision && styles.chipSelected]}
            >
              <Text style={[styles.chipText, !filterDivision && styles.chipTextSelected]}>All</Text>
            </Pressable>
            {DIVISIONS.map((d) => {
              const selected = filterDivision === d;
              return (
                <Pressable
                  key={d}
                  onPress={() => setFilterDivision(selected ? null : d)}
                  style={[styles.chip, selected && styles.chipSelected]}
                >
                  <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{d}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        {hasActiveFilters && (
          <Pressable onPress={clearFilters} style={styles.clearFiltersButton} hitSlop={8}>
            <Ionicons name="close-circle" size={14} color="#8A96A3" />
            <Text style={styles.clearFiltersText}>Clear filters</Text>
          </Pressable>
        )}
      </View>

      {!loading && !loadError && lines.length > 0 && (
        <Text style={styles.resultCount}>
          {filteredLines.length} of {lines.length} line{lines.length === 1 ? '' : 's'}
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
          <Pressable onPress={fetchLines} style={styles.retryButton}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : lines.length === 0 ? (
        <View style={styles.centered}>
          <Ionicons name="layers-outline" size={28} color="#5C6670" />
          <Text style={styles.emptyText}>No lines registered yet</Text>
        </View>
      ) : filteredLines.length === 0 ? (
        <View style={styles.centered}>
          <Ionicons name="filter-outline" size={28} color="#5C6670" />
          <Text style={styles.emptyText}>No lines match these filters</Text>
          <Pressable onPress={clearFilters} style={styles.retryButton}>
            <Text style={styles.retryText}>Clear filters</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={filteredLines}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listContent}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor="#F2A93B" />}
          renderItem={({ item }) => (
            <View style={[styles.card, deletingId === item.id && styles.cardDeleting]}>
              <Pressable
                style={styles.cardMain}
                onPress={() => navigation.navigate('RegisterLine', { lineId: item.id })}
              >
                <View style={styles.lineNumberBadge}>
                  <Text style={styles.lineNumberText}>{item.lineName.slice(0, 2).toUpperCase()}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.cardTitle}>{item.lineName}</Text>
                  <Text style={styles.cardSubtitle}>
                    {item.plant} · {item.workshop} · {item.division}
                  </Text>
                  <Text style={styles.cardMeta}>
                    {item.partCount} part{item.partCount === 1 ? '' : 's'}
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={20} color="#5C6670" />
              </Pressable>

              <View style={styles.cardDivider} />

              <View style={styles.cardActions}>
                <Pressable
                  style={styles.actionButton}
                  onPress={() => navigation.navigate('RegisterLine', { lineId: item.id })}
                  hitSlop={8}
                >
                  <Ionicons name="create-outline" size={16} color="#3E7CB1" />
                  <Text style={styles.actionTextEdit}>Edit</Text>
                </Pressable>
                <View style={styles.actionDivider} />
                <Pressable
                  style={styles.actionButton}
                  onPress={() => handleDelete(item)}
                  disabled={deletingId === item.id}
                  hitSlop={8}
                >
                  {deletingId === item.id ? (
                    <ActivityIndicator size="small" color="#D64545" />
                  ) : (
                    <>
                      <Ionicons name="trash-outline" size={16} color="#D64545" />
                      <Text style={styles.actionTextDelete}>Delete</Text>
                    </>
                  )}
                </Pressable>
              </View>
            </View>
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
  header: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 8 },
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
  filters: { paddingHorizontal: 20, paddingBottom: 10, gap: 12 },
  filterGroup: { gap: 8 },
  filterLabel: { color: '#5C6670', fontSize: 10.5, fontWeight: '800', letterSpacing: 1.2 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    borderWidth: 1,
    borderColor: '#2C343C',
    backgroundColor: '#1D2329',
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  chipSelected: { borderColor: '#F2A93B', backgroundColor: '#F2A93B22' },
  chipText: { color: '#8A96A3', fontSize: 12, fontWeight: '600' },
  chipTextSelected: { color: '#F2A93B' },
  clearFiltersButton: { flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start' },
  clearFiltersText: { color: '#8A96A3', fontSize: 12.5, fontWeight: '600' },
  resultCount: { color: '#5C6670', fontSize: 12, paddingHorizontal: 20, paddingBottom: 8 },
  listContent: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 40, gap: 12 },
  card: {
    backgroundColor: '#1D2329',
    borderWidth: 1,
    borderColor: '#2C343C',
    borderRadius: 12,
    overflow: 'hidden',
  },
  cardDeleting: { opacity: 0.5 },
  cardMain: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    padding: 14,
  },
  lineNumberBadge: {
    width: 46,
    height: 46,
    borderRadius: 10,
    backgroundColor: '#3E7CB122',
    borderWidth: 1.5,
    borderColor: '#3E7CB1',
    alignItems: 'center',
    justifyContent: 'center',
  },
  lineNumberText: { color: '#3E7CB1', fontSize: 14, fontWeight: '800' },
  cardTitle: { color: '#ECEFF2', fontSize: 15, fontWeight: '700' },
  cardSubtitle: { color: '#8A96A3', fontSize: 12.5, marginTop: 2 },
  cardMeta: { color: '#5C6670', fontSize: 11.5, marginTop: 3 },
  cardDivider: { height: 1, backgroundColor: '#2C343C' },
  cardActions: { flexDirection: 'row' },
  actionDivider: { width: 1, backgroundColor: '#2C343C' },
  actionButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 12,
  },
  actionTextEdit: { color: '#3E7CB1', fontSize: 13, fontWeight: '700' },
  actionTextDelete: { color: '#D64545', fontSize: 13, fontWeight: '700' },
});