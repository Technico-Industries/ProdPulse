// src/screens/LiveDashboardScreen.tsx
//
// The page the admin Production Overview's "Live Dashboard" button opens in a
// new browser tab (/live-dashboard). It is part of this same web app, so the
// new tab restores the admin's existing sign-in. Admins only; the content is
// a placeholder until the live dashboard is built.

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuthStore } from '../stores/authStore';

export default function LiveDashboardScreen() {
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Ionicons name="tv-outline" size={22} color="#ECEFF2" />
        <Text style={styles.brand}>ProdPulse · Live Dashboard</Text>
      </View>

      <View style={styles.body}>
        {isAdmin ? (
          <>
            <View style={styles.badge}>
              <Ionicons name="construct" size={28} color="#F2A93B" />
            </View>
            <Text style={styles.title}>Live Dashboard</Text>
            <Text style={styles.subtitle}>This dashboard is coming soon.</Text>
          </>
        ) : (
          <>
            <View style={[styles.badge, styles.badgeDenied]}>
              <Ionicons name="lock-closed" size={28} color="#E5534B" />
            </View>
            <Text style={styles.title}>Admins only</Text>
            <Text style={styles.subtitle}>The Live Dashboard is available to admin accounts.</Text>
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#14181C' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#2C343C',
  },
  brand: { color: '#ECEFF2', fontSize: 16, fontWeight: '900', letterSpacing: 0.3 },
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
  badgeDenied: { backgroundColor: '#E5534B22', borderColor: '#E5534B' },
  title: { color: '#ECEFF2', fontSize: 20, fontWeight: '800', textAlign: 'center', paddingHorizontal: 20 },
  subtitle: { color: '#8A96A3', fontSize: 14, textAlign: 'center', marginTop: 8, paddingHorizontal: 24 },
});
