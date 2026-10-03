import React from 'react';
import { View, Text, Pressable, StyleSheet, SafeAreaView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRoute } from '@react-navigation/native';

export default function ComingSoonReportScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const title: string = route.params?.title ?? 'Report';

  return (
    <SafeAreaView style={styles.safeArea}>
      <Pressable onPress={() => navigation.goBack()} style={styles.backButton} hitSlop={12}>
        <Ionicons name="arrow-back" size={22} color="#8A96A3" />
        <Text style={styles.backText}>Back</Text>
      </Pressable>

      <View style={styles.body}>
        <View style={styles.badge}>
          <Ionicons name="construct" size={28} color="#F2A93B" />
        </View>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.subtitle}>This tracker is coming soon.</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#14181C', paddingHorizontal: 20 },
  backButton: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 12, marginBottom: 20 },
  backText: { color: '#8A96A3', fontSize: 15 },
  body: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingBottom: 80 },
  badge: {
    width: 60,
    height: 60,
    borderRadius: 14,
    backgroundColor: '#F2A93B22',
    borderWidth: 1.5,
    borderColor: '#F2A93B',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 18,
  },
  title: { color: '#ECEFF2', fontSize: 20, fontWeight: '800', textAlign: 'center', paddingHorizontal: 20 },
  subtitle: {
    color: '#8A96A3',
    fontSize: 14,
    textAlign: 'center',
    marginTop: 8,
    paddingHorizontal: 24,
  },
});