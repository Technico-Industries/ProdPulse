// src/components/LiveDashboardButton.tsx
//
// "Live Dashboard" button for the web build of the admin Production Overview,
// shown right of WebRefreshButton and styled like it. Opens this web app's
// /live-dashboard page (LiveDashboardScreen) in a new tab — same origin, so
// the tab is already signed in. EXPO_PUBLIC_LIVE_DASHBOARD_URL overrides the
// address. Renders nothing on iOS/Android, exactly like WebRefreshButton.

import React from 'react';
import { Platform, Pressable, Text, ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

function liveDashboardUrl(): string {
  return process.env.EXPO_PUBLIC_LIVE_DASHBOARD_URL?.trim() || '/live-dashboard';
}

export default function LiveDashboardButton({ size = 40, color = '#ECEFF2' }: { size?: number; color?: string }) {
  if (Platform.OS !== 'web') return null;
  return (
    <Pressable
      onPress={() => window.open(liveDashboardUrl(), '_blank', 'noopener,noreferrer')}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel="Live Dashboard (opens in a new tab)"
      // Native browser tooltip on hover.
      {...({ title: 'Live Dashboard' } as object)}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) =>
        ({
          height: size,
          paddingHorizontal: 12,
          borderRadius: 10,
          borderWidth: 1,
          borderColor: hovered || pressed ? '#3A434C' : '#2C343C',
          backgroundColor: pressed ? '#242B32' : hovered ? '#20272D' : '#1D2329',
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
          cursor: 'pointer',
        }) as ViewStyle
      }
    >
      <Ionicons name="tv-outline" size={Math.round(size * 0.45)} color={color} />
      <Text style={{ color, fontSize: 13, fontWeight: '700' }}>Live Dashboard</Text>
    </Pressable>
  );
}
