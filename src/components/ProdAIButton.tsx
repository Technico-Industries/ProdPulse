// src/components/ProdAIButton.tsx
//
// Floating Prod AI launcher on the admin Production overview — the entry
// point that replaced the drawer's menu card. It opens Prod AI as a popup
// over the overview (components/ProdAIPanel) — no navigation, so the
// overview stays mounted and unchanged behind it. The conversation lives in
// stores/prodAIStore, not here, so closing and reopening keeps it.
//
// Rendered only for an admin on a platform where the assistant runs
// (utils/prodPulseAI canOpenProdAI). That is a UI gate — the backend still
// checks the caller's admin profile on every request.
//
// Sits bottom-right, above the dashboard pager's floating page tabs, inside
// the screen's safe area (ScreenContainer). 52px, so it clears the 44px
// minimum touch target. On web, hovering shows an "Open Prod AI" tooltip.
// Monochrome: white button, black brain icon.

import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet, Platform } from 'react-native';
import { useAuthStore } from '../stores/authStore';
import { canOpenProdAI } from '../utils/prodPulseAI';
import { ProdAIBrain } from './ProdAIThinking';
import ProdAIPanel from './ProdAIPanel';

const LABEL = 'Open Prod AI';

// Space the overview's scroll content leaves at the bottom so its last row
// can scroll clear of this button (and the pager tabs below it).
export const PROD_AI_BUTTON_CLEARANCE = 128;

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
          <ProdAIBrain size={24} color="#000000" />
        </Pressable>
      </View>
      <ProdAIPanel visible={open} onClose={() => { setOpen(false); setHovered(false); }} />
    </>
  );
}

const styles = StyleSheet.create({
  // bottom: 56 keeps it above the pager's page tabs (bottom 8, ~36 tall).
  wrap: { position: 'absolute', right: 16, bottom: 56, flexDirection: 'row', alignItems: 'center', gap: 8 },
  fab: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#2B2B2B',
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 6,
  },
  fabHovered: { backgroundColor: '#E5E5E5' },
  fabPressed: { backgroundColor: '#D4D4D4', transform: [{ scale: 0.96 }] },
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
