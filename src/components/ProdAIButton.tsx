// src/components/ProdAIButton.tsx
//
// Floating Prod AI launcher over the admin dashboard pager (mounted by
// components/AdminDashboardPager, so it stays on every overview page). It
// opens Prod AI as a popup (components/ProdAIPanel) — no navigation, so the
// overview stays mounted and unchanged behind it. The conversation lives in
// stores/prodAIStore, not here, so closing and reopening keeps it.
//
// Rendered for an admin on web, Android and iOS (utils/prodPulseAI
// canOpenProdAI). That is a UI gate — the backend still checks the caller's
// admin profile on every request.
//
// Bottom-right, above the pager's floating page tabs. Plain React Native
// positioning (absolute, inside the screen's safe area — ScreenContainer
// applies the insets); zIndex keeps it above the pager's ScrollView on web
// and iOS, elevation on Android. 52px, clear of the 44px minimum touch
// target. Monochrome: near-black surface, grey border, white brain. On web,
// hovering shows an "Open Prod AI" tooltip.

import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet, Platform } from 'react-native';
import { useAuthStore } from '../stores/authStore';
import { canOpenProdAI } from '../utils/prodPulseAI';
import { ProdAIBrain } from './ProdAIThinking';
import ProdAIPanel from './ProdAIPanel';

const LABEL = 'Open Prod AI';

export { PROD_AI_BUTTON_CLEARANCE } from '../utils/prodAIPanelLayout';

export default function ProdAIButton() {
  const role = useAuthStore((s) => s.user?.role ?? null);
  const [hovered, setHovered] = useState(false);
  const [open, setOpen] = useState(false);

  if (!canOpenProdAI(role, Platform.OS)) return null;

  return (
    <>
      <View style={styles.wrap} pointerEvents="box-none">
        {hovered && !open ? (
          <View style={styles.tooltip} pointerEvents="none">
            <Text style={styles.tooltipText}>{LABEL}</Text>
          </View>
        ) : null}
        <Pressable
          onPress={() => setOpen(true)}
          onHoverIn={() => setHovered(true)}
          onHoverOut={() => setHovered(false)}
          hitSlop={6}
          style={({ pressed, focused }: { pressed: boolean; focused?: boolean }) => [
            styles.fab,
            hovered && styles.fabHovered,
            pressed && styles.fabPressed,
            focused && Platform.OS === 'web' && ({ outlineColor: '#FFFFFF', outlineWidth: 2, outlineStyle: 'solid', outlineOffset: 3 } as any),
          ]}
          accessibilityRole="button"
          accessibilityLabel={LABEL}
          accessibilityHint="Opens the Prod AI production assistant"
          accessibilityState={{ expanded: open }}
        >
          <ProdAIBrain size={24} color="#FFFFFF" />
        </Pressable>
      </View>
      <ProdAIPanel visible={open} onClose={() => { setOpen(false); setHovered(false); }} />
    </>
  );
}

const styles = StyleSheet.create({
  // bottom: 56 keeps it above the pager's page tabs (bottom 8, ~36 tall).
  wrap: {
    position: 'absolute',
    right: 16,
    bottom: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    zIndex: 20,
    elevation: 20,
  },
  fab: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: '#151515',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#3A3A3A',
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 8,
  },
  fabHovered: { backgroundColor: '#242424' },
  fabPressed: { backgroundColor: '#2E2E2E', transform: [{ scale: 0.96 }] },
  tooltip: {
    backgroundColor: '#151515',
    borderWidth: 1,
    borderColor: '#2B2B2B',
    borderRadius: 8,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  tooltipText: { color: '#FFFFFF', fontSize: 12, fontWeight: '600' },
});
