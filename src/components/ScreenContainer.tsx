// src/components/ScreenContainer.tsx
//
// Single shared safe-area boundary for every screen in the app. Applied
// centrally in App.tsx (via withScreenContainer) rather than imported
// individually into each screen file — this is the one place that knows
// about react-native-safe-area-context, so no screen needs its own
// SafeAreaView, manual paddingTop, or StatusBar.currentHeight handling.
//
// edges: ['top', 'bottom'] means every screen respects both the top status
// bar/notch AND the bottom gesture/navigation bar — the two overlaps
// reported on Android. Left/right are omitted since none of these screens
// are laid out landscape-edge-to-edge.

import React from 'react';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function ScreenContainer({ children }: { children: React.ReactNode }) {
  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top', 'bottom']}>
      {children}
    </SafeAreaView>
  );
}