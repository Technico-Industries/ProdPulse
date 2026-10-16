// src/components/AdminDashboardPager.tsx
//
// Admin's main dashboard: the production overview, with the quality overview
// one swipe to the left, the live line efficiency overview after it and the
// live quality lines page last. The Quality In-charge dashboard uses the same
// pager (QualityDashboardPager below): quality overview → live quality lines.
// A horizontal paging ScrollView, so it follows the
// finger on Android/iOS and on mobile web (react-native-web maps
// pagingEnabled to CSS scroll-snap). Desktop browsers can't drag a scroll
// area with the mouse, so the page tabs at the bottom are also tappable.
//
// Each page is sized from the measured container rather than flex, so the
// overview screens' own vertical ScrollViews (and pull-to-refresh) keep
// working inside the pager on web too.

import React, { useRef, useState } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet, LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import AdminOverviewScreen from '../screens/AdminOverviewScreen';
import QualityOverviewScreen from '../screens/QualityOverviewScreen';
import LineEfficiencyOverviewScreen from '../screens/LineEfficiencyOverviewScreen';
import LiveQualityLinesScreen from '../screens/LiveQualityLinesScreen';

interface Page {
  key: string;
  label: string;
  color: string;
  Component: React.ComponentType;
}

const AdminLiveQualityLines = () => <LiveQualityLinesScreen role="admin" />;
const QualityLiveQualityLines = () => <LiveQualityLinesScreen role="quality" />;

const ADMIN_PAGES: Page[] = [
  { key: 'production', label: 'Production', color: '#3E7CB1', Component: AdminOverviewScreen },
  { key: 'quality', label: 'Quality', color: '#4C9A6A', Component: QualityOverviewScreen },
  { key: 'lines', label: 'Lines', color: '#8B5CF6', Component: LineEfficiencyOverviewScreen },
  { key: 'quality-lines', label: 'QC Lines', color: '#E0793C', Component: AdminLiveQualityLines },
];

const QUALITY_PAGES: Page[] = [
  { key: 'quality', label: 'Quality', color: '#4C9A6A', Component: QualityOverviewScreen },
  { key: 'quality-lines', label: 'QC Lines', color: '#E0793C', Component: QualityLiveQualityLines },
];

export default function AdminDashboardPager() {
  return <DashboardPager pages={ADMIN_PAGES} />;
}

export function QualityDashboardPager() {
  return <DashboardPager pages={QUALITY_PAGES} />;
}

function DashboardPager({ pages: PAGES }: { pages: Page[] }) {
  const scrollRef = useRef<ScrollView>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [page, setPage] = useState(0);
  const pageRef = useRef(0);

  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (size && size.width === width && size.height === height) return;
    setSize({ width, height });
    // Keep the current page in view after a resize / rotation.
    requestAnimationFrame(() => scrollRef.current?.scrollTo({ x: pageRef.current * width, animated: false }));
  };

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (!size?.width) return;
    const next = Math.round(e.nativeEvent.contentOffset.x / size.width);
    if (next !== pageRef.current && next >= 0 && next < PAGES.length) {
      pageRef.current = next;
      setPage(next);
    }
  };

  const goTo = (idx: number) => {
    if (!size) return;
    scrollRef.current?.scrollTo({ x: idx * size.width, animated: true });
  };

  return (
    <View style={styles.root} onLayout={onLayout}>
      {size && (
        <ScrollView
          ref={scrollRef}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          onScroll={onScroll}
          scrollEventThrottle={16}
          keyboardShouldPersistTaps="handled"
          style={styles.root}
        >
          {PAGES.map(({ key, Component }) => (
            <View key={key} style={{ width: size.width, height: size.height }}>
              <Component />
            </View>
          ))}
        </ScrollView>
      )}

      <View style={styles.tabsWrap} pointerEvents="box-none">
        <View style={styles.tabs}>
          {PAGES.map((p, i) => {
            const active = i === page;
            return (
              <Pressable
                key={p.key}
                onPress={() => goTo(i)}
                hitSlop={6}
                style={[styles.tab, active && { backgroundColor: `${p.color}33` }]}
                accessibilityRole="tab"
                accessibilityState={{ selected: active }}
                accessibilityLabel={`${p.label} overview`}
              >
                <View style={[styles.dot, { backgroundColor: active ? p.color : '#5C6670' }]} />
                <Text style={[styles.tabText, active && { color: p.color }]}>{p.label}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#14181C' },
  tabsWrap: { position: 'absolute', left: 0, right: 0, bottom: 8, alignItems: 'center' },
  tabs: {
    flexDirection: 'row',
    gap: 4,
    padding: 4,
    borderRadius: 999,
    backgroundColor: '#1C2228EE',
    borderWidth: 1,
    borderColor: '#2C343C',
  },
  // 10px sides so four tabs still fit a 360px-wide phone.
  tab: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 999 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  tabText: { color: '#8A96A3', fontSize: 12, fontWeight: '800' },
});
