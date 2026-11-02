// src/components/WebKeyboardToggle.tsx
//
// Enable / disable the built-in on-screen keyboard (OnScreenKeyboard.web).
// Web only — renders nothing on Android/iOS.
//   variant="row":  a switch row for the hamburger drawer (every dashboard
//                   that has one: Admin, Supervisor, Quality).
//   variant="icon": a header button for the Technician / Restocker
//                   dashboards, which have no drawer.

import React from 'react';
import { Platform, Pressable, StyleSheet, Text, View, ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useWebKeyboardStore } from '../stores/webKeyboardStore';

const ACCENT = '#3E7CB1';

export default function WebKeyboardToggle({ variant = 'row' }: { variant?: 'row' | 'icon' }) {
  const enabled = useWebKeyboardStore((s) => s.enabled);
  const toggle = useWebKeyboardStore((s) => s.toggle);
  if (Platform.OS !== 'web') return null;

  const label = enabled ? 'On-screen keyboard: on' : 'On-screen keyboard: off';

  if (variant === 'icon') {
    return (
      <Pressable
        onPress={toggle}
        hitSlop={8}
        accessibilityRole="switch"
        accessibilityState={{ checked: enabled }}
        accessibilityLabel={label}
        {...({ title: label } as object)}
        style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
          styles.iconBtn,
          enabled && { borderColor: ACCENT, backgroundColor: `${ACCENT}22` },
          (pressed || hovered) && !enabled && { backgroundColor: '#20272D' },
          { cursor: 'pointer' } as ViewStyle,
        ]}
      >
        <Ionicons name={enabled ? 'keypad' : 'keypad-outline'} size={20} color={enabled ? ACCENT : '#8A96A3'} />
      </Pressable>
    );
  }

  return (
    <Pressable
      onPress={toggle}
      accessibilityRole="switch"
      accessibilityState={{ checked: enabled }}
      accessibilityLabel={label}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: '#242B32' }]}
    >
      <View style={[styles.rowIcon, { backgroundColor: `${ACCENT}22`, borderColor: ACCENT }]}>
        <Ionicons name="keypad" size={18} color={ACCENT} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.rowTitle}>On-screen Keyboard</Text>
        <Text style={styles.rowSub} numberOfLines={1}>
          {enabled ? 'Shows when you tap a text field' : 'Off — use your own keyboard'}
        </Text>
      </View>
      <View style={[styles.track, enabled && styles.trackOn]}>
        <View style={[styles.thumb, enabled && styles.thumbOn]} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  iconBtn: {
    width: 40,
    height: 40,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#2C343C',
    alignItems: 'center',
    justifyContent: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 10,
  },
  rowIcon: {
    width: 34,
    height: 34,
    borderRadius: 9,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowTitle: { color: '#ECEFF2', fontSize: 14, fontWeight: '700' },
  rowSub: { color: '#8A96A3', fontSize: 11.5, marginTop: 1 },
  track: {
    width: 40,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#2C343C',
    padding: 3,
    justifyContent: 'center',
  },
  trackOn: { backgroundColor: ACCENT },
  thumb: { width: 16, height: 16, borderRadius: 8, backgroundColor: '#8A96A3' },
  thumbOn: { backgroundColor: '#FFFFFF', alignSelf: 'flex-end' },
});
