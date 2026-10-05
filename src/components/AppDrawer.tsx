// src/components/AppDrawer.tsx
//
// Hamburger side drawer, shared by the Admin and Supervisor dashboards.
// The caller passes the menu entries for its own role (ADMIN_MENU_ITEMS /
// SUPERVISOR_MENU_ITEMS), so one component serves both and neither role
// can accidentally reach the other's screens.
//
// Deliberately NOT @react-navigation/drawer — that package isn't a
// dependency of this project and adding it would mean restructuring
// App.tsx's navigator tree. This is a plain overlay (Modal + Animated
// slide) rendered from inside the dashboard screen, so every existing
// route name, stack and linking entry in App.tsx stays exactly as it was;
// tapping an item just calls navigation.navigate(route) like the old
// dashboard cards did.

import React, { useEffect, useRef } from 'react';
import {
  View,
  Text,
  Pressable,
  Modal,
  Animated,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { AdminMenuItem } from '../constants/adminMenu';
import { useAuthStore } from '../stores/authStore';

interface Props {
  visible: boolean;
  onClose: () => void;
  // The calling dashboard's own menu entries.
  items: AdminMenuItem[];
  // Subtitle under the active "Dashboard" row — "Production overview" for
  // admin, "Active session overview" for supervisor.
  dashboardSubtitle?: string;
}

export default function AppDrawer({ visible, onClose, items, dashboardSubtitle }: Props) {
  const navigation = useNavigation<any>();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const { width } = useWindowDimensions();

  // Narrow phones get a near-full-width sheet; tablets/desktop a fixed panel.
  const panelWidth = Math.min(320, Math.max(260, width * 0.84));

  const slide = useRef(new Animated.Value(-panelWidth)).current;
  const fade = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(slide, {
        toValue: visible ? 0 : -panelWidth,
        duration: visible ? 220 : 180,
        useNativeDriver: true,
      }),
      Animated.timing(fade, {
        toValue: visible ? 1 : 0,
        duration: visible ? 220 : 180,
        useNativeDriver: true,
      }),
    ]).start();
  }, [visible, panelWidth, slide, fade]);

  const go = (route: string) => {
    onClose();
    navigation.navigate(route);
  };

  const handleLogout = async () => {
    onClose();
    await logout();
  };

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose}>
      <View style={styles.root}>
        {/* Scrim — tapping outside closes the drawer */}
        <Animated.View style={[styles.scrim, { opacity: fade }]}>
          <Pressable style={{ flex: 1 }} onPress={onClose} accessibilityLabel="Close menu" />
        </Animated.View>

        <Animated.View
          style={[styles.panel, { width: panelWidth, transform: [{ translateX: slide }] }]}
        >
          <View style={styles.panelHeader}>
            <View style={{ flex: 1 }}>
              <Text style={styles.brand}>ProdPulse</Text>
              <Text style={styles.brandSub} numberOfLines={1}>
                {user?.name || user?.email || 'Admin'}
              </Text>
            </View>
            <Pressable onPress={onClose} hitSlop={12} style={styles.closeBtn} accessibilityLabel="Close menu">
              <Ionicons name="close" size={20} color="#8A96A3" />
            </Pressable>
          </View>

          {/* flex:1 is load-bearing: without it the ScrollView sizes to its
              content inside the panel's flex column and pushes the Log Out
              footer below the screen edge, making it unreachable once the
              menu has more rows than fit. */}
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={styles.list}
            showsVerticalScrollIndicator={false}
          >
            <Text style={styles.sectionLabel}>MENU</Text>

            {/* Dashboard — already here, so it just closes the drawer */}
            <Pressable
              onPress={onClose}
              style={({ pressed }) => [styles.item, styles.itemActive, pressed && styles.itemPressed]}
            >
              <View style={[styles.itemIcon, { backgroundColor: '#3E7CB122', borderColor: '#3E7CB1' }]}>
                <Ionicons name="grid" size={18} color="#3E7CB1" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.itemTitle}>Dashboard</Text>
                <Text style={styles.itemSub} numberOfLines={1}>
                  {dashboardSubtitle ?? 'Production overview'}
                </Text>
              </View>
            </Pressable>

            {items.map((item) => (
              <Pressable
                key={item.key}
                onPress={() => go(item.route)}
                style={({ pressed }) => [styles.item, pressed && styles.itemPressed]}
                accessibilityRole="button"
                accessibilityLabel={item.title}
              >
                <View style={[styles.itemIcon, { backgroundColor: item.accent + '22', borderColor: item.accent }]}>
                  <Ionicons name={item.icon} size={18} color={item.accent} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.itemTitle}>{item.title}</Text>
                  <Text style={styles.itemSub} numberOfLines={1}>{item.subtitle}</Text>
                </View>
                <Ionicons name="chevron-forward" size={16} color="#5C6670" />
              </Pressable>
            ))}
          </ScrollView>

          <Pressable
            onPress={handleLogout}
            style={({ pressed }) => [styles.logout, pressed && styles.itemPressed]}
            accessibilityRole="button"
            accessibilityLabel="Log out"
          >
            <Ionicons name="log-out-outline" size={18} color="#D64545" />
            <Text style={styles.logoutText}>Log Out</Text>
          </Pressable>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, flexDirection: 'row' },
  scrim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#00000099' },
  panel: {
    height: '100%',
    backgroundColor: '#1A1F25',
    borderRightWidth: 1,
    borderRightColor: '#2C343C',
    paddingTop: 44,
  },
  panelHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 18,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#2C343C',
  },
  brand: { color: '#ECEFF2', fontSize: 19, fontWeight: '900', letterSpacing: 0.3 },
  brandSub: { color: '#8A96A3', fontSize: 12, marginTop: 2 },
  closeBtn: {
    width: 34,
    height: 34,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: '#2C343C',
    alignItems: 'center',
    justifyContent: 'center',
  },
  list: { paddingHorizontal: 12, paddingTop: 14, paddingBottom: 20, gap: 6 },
  sectionLabel: {
    color: '#5C6670',
    fontSize: 10.5,
    fontWeight: '800',
    letterSpacing: 1.2,
    marginLeft: 6,
    marginBottom: 6,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  itemActive: { backgroundColor: '#3E7CB118', borderColor: '#3E7CB155' },
  itemPressed: { backgroundColor: '#242B32' },
  itemIcon: {
    width: 34,
    height: 34,
    borderRadius: 9,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  itemTitle: { color: '#ECEFF2', fontSize: 14, fontWeight: '700' },
  itemSub: { color: '#8A96A3', fontSize: 11.5, marginTop: 1 },
  logout: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 22,
    paddingVertical: 16,
    borderTopWidth: 1,
    borderTopColor: '#2C343C',
  },
  logoutText: { color: '#D64545', fontSize: 14, fontWeight: '800' },
});
