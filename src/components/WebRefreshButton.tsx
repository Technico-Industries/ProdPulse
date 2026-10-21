// src/components/WebRefreshButton.tsx
//
// Refresh button for the web build. Every list/overview screen already has
// pull-to-refresh (RefreshControl), which has no gesture on a desktop
// browser — this calls the SAME onRefresh handler and shows the SAME
// `refreshing` flag, so web and mobile refresh identically. Renders nothing
// on iOS/Android, where swipe-down stays the way to refresh.

import React from 'react';
import { ActivityIndicator, Platform, Pressable, StyleProp, ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

export default function WebRefreshButton({
  onRefresh,
  refreshing = false,
  size = 40,
  color = '#ECEFF2',
  style,
}: {
  onRefresh: () => void;
  refreshing?: boolean;
  size?: number;
  color?: string;
  style?: StyleProp<ViewStyle>;
}) {
  if (Platform.OS !== 'web') return null;
  return (
    <Pressable
      onPress={onRefresh}
      disabled={refreshing}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel="Refresh"
      accessibilityState={{ busy: refreshing, disabled: refreshing }}
      // Native browser tooltip on hover.
      {...({ title: 'Refresh' } as object)}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
        {
          width: size,
          height: size,
          borderRadius: 10,
          borderWidth: 1,
          borderColor: hovered || pressed ? '#3A434C' : '#2C343C',
          backgroundColor: pressed ? '#242B32' : hovered ? '#20272D' : '#1D2329',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: refreshing ? 'default' : 'pointer',
        } as ViewStyle,
        style,
      ]}
    >
      {refreshing ? (
        <ActivityIndicator size="small" color={color} />
      ) : (
        <Ionicons name="refresh" size={Math.round(size * 0.48)} color={color} />
      )}
    </Pressable>
  );
}
