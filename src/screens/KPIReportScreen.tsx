import React, { useRef, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  SafeAreaView,
  ScrollView,
  Animated,
  Dimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';

type IconName = keyof typeof Ionicons.glyphMap;

interface ReportModule {
  key: string;
  title: string;
  icon: IconName;
  accent: string;
  description: string;
}

const REPORT_MODULES: ReportModule[] = [
  {
    key: 'near-miss',
    title: 'Near-Miss Report',
    icon: 'alert-circle',
    accent: '#D64545',
    description: 'Log incidents that could have caused injury or damage but didn\u2019t, so safety risks get caught before they become accidents.',
  },
  {
    key: 'man-days',
    title: 'Man-Days Tracker',
    icon: 'people',
    accent: '#3E7CB1',
    description: 'Track total man-days worked per line, shift, or project to monitor labor allocation and cost over time.',
  },
  {
    key: 'poka-yoke',
    title: 'Poka Yoke Breakdown Tracker',
    icon: 'shield-checkmark',
    accent: '#4C9A6A',
    description: 'Record failures or bypasses of error-proofing (poka-yoke) devices across lines to catch quality risks early.',
  },
  {
    key: 'pcs-per-hour',
    title: 'PCS Man Per Hour',
    icon: 'speedometer',
    accent: '#F2A93B',
    description: 'Measures pieces produced per operator per hour \u2014 a core labor-efficiency metric for the floor.',
  },
  {
    key: 'plan-vs-actual',
    title: 'Plan vs Actual Target',
    icon: 'trending-up',
    accent: '#3E7CB1',
    description: 'Compares planned production targets against actual output to spot shortfalls by line or shift.',
  },
  {
    key: 'rework-pct',
    title: 'Rework Data %',
    icon: 'refresh-circle',
    accent: '#F2A93B',
    description: 'Tracks the percentage of parts that required rework before passing quality inspection.',
  },
  {
    key: 'kaizen',
    title: 'Kaizen Tracker',
    icon: 'bulb',
    accent: '#4C9A6A',
    description: 'Logs continuous-improvement ideas raised on the floor, along with their status and impact.',
  },
  {
    key: 'attendance',
    title: 'Attendance Sheet',
    icon: 'calendar',
    accent: '#3E7CB1',
    description: 'Daily attendance record for operators and staff, organized by line and shift.',
  },
];

// Card size: two columns, 12px padding each side, 12px gap between
const SCREEN_W = Dimensions.get('window').width;
const CARD_SIZE = Math.floor((SCREEN_W - 20 * 2 - 12) / 2);

// ─── Flip Card ────────────────────────────────────────────────────────────────
// FIX: Don't use position:absolute for the faces — instead swap visibility so
// the wrapper always has a real measured height (CARD_SIZE × CARD_SIZE).
// This prevents the collapsed-height bug that caused all cards to stack/overlap.

function FlipCard({ module, onOpen }: { module: ReportModule; onOpen: () => void }) {
  const anim = useRef(new Animated.Value(0)).current;
  const [flipped, setFlipped] = useState(false);

  const toggleFlip = () => {
    const toValue = flipped ? 0 : 1;
    setFlipped(!flipped);
    Animated.spring(anim, {
      toValue,
      useNativeDriver: true,
      friction: 8,
      tension: 60,
    }).start();
  };

  // Front rotates 0→180, back rotates 180→360
  const frontRotateY = anim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '180deg'],
  });
  const backRotateY = anim.interpolate({
    inputRange: [0, 1],
    outputRange: ['180deg', '360deg'],
  });
  // Fade each face out just before the halfway point so there's no see-through moment
  const frontOpacity = anim.interpolate({
    inputRange: [0, 0.45, 0.55, 1],
    outputRange: [1, 1, 0, 0],
  });
  const backOpacity = anim.interpolate({
    inputRange: [0, 0.45, 0.55, 1],
    outputRange: [0, 0, 1, 1],
  });

  return (
    // Fixed size wrapper — both faces are absolute inside it so the wrapper
    // always contributes real height to the grid (no collapsing).
    <View style={[styles.cardWrap, { width: CARD_SIZE, height: CARD_SIZE }]}>

      {/* FRONT */}
      <Animated.View
        style={[
          styles.face,
          {
            opacity: frontOpacity,
            transform: [{ perspective: 1200 }, { rotateY: frontRotateY }],
            // Hide from touch when flipped so info-button behind it isn't triggered
            pointerEvents: flipped ? 'none' : 'auto',
          },
        ]}
      >
        <Pressable
          style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
          onPress={onOpen}
        >
          {/* Info toggle — top-right */}
          <Pressable onPress={toggleFlip} hitSlop={12} style={styles.infoBadge}>
            <Ionicons name="information-circle-outline" size={20} color="#5C6670" />
          </Pressable>

          <View style={[styles.iconBadge, { backgroundColor: module.accent + '22', borderColor: module.accent }]}>
            <Ionicons name={module.icon} size={26} color={module.accent} />
          </View>
          <Text style={styles.cardTitle} numberOfLines={3}>{module.title}</Text>
        </Pressable>
      </Animated.View>

      {/* BACK */}
      <Animated.View
        style={[
          styles.face,
          {
            opacity: backOpacity,
            transform: [{ perspective: 1200 }, { rotateY: backRotateY }],
            pointerEvents: flipped ? 'auto' : 'none',
          },
        ]}
      >
        <View style={[styles.card, { borderColor: module.accent + '66', backgroundColor: '#1A2028' }]}>
          {/* Close toggle */}
          <Pressable onPress={toggleFlip} hitSlop={12} style={styles.infoBadge}>
            <Ionicons name="close-circle-outline" size={20} color="#5C6670" />
          </Pressable>

          <View style={[styles.accentDot, { backgroundColor: module.accent }]} />
          <Text style={styles.backDescription} numberOfLines={7}>
            {module.description}
          </Text>
        </View>
      </Animated.View>
    </View>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function KPIReportScreen() {
  const navigation = useNavigation<any>();

  // Pair modules into rows of 2 for the grid
  const rows: ReportModule[][] = [];
  for (let i = 0; i < REPORT_MODULES.length; i += 2) {
    rows.push(REPORT_MODULES.slice(i, i + 2));
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <Pressable onPress={() => navigation.goBack()} style={styles.backButton} hitSlop={12}>
        <Ionicons name="arrow-back" size={22} color="#8A96A3" />
        <Text style={styles.backText}>Back</Text>
      </Pressable>

      <View style={styles.header}>
        <Text style={styles.title}>KPI Report</Text>
        <Text style={styles.subtitle}>Reports & trackers</Text>
      </View>

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {rows.map((row, ri) => (
          <View key={ri} style={styles.row}>
            {row.map((mod) => (
              <FlipCard
                key={mod.key}
                module={mod}
                onOpen={() => {
                  if (mod.key === 'near-miss') return navigation.navigate('NearMissReport');
                  if (mod.key === 'man-days')  return navigation.navigate('ManDaysTracker');
                  if (mod.key === 'poka-yoke') return navigation.navigate('PokaYokeRecord');
                  if (mod.key === 'kaizen') return navigation.navigate('KaizenTracker');
                  if (mod.key === 'plan-vs-actual') return navigation.navigate('PlanVsActualRecords');
                  if (mod.key === 'rework-pct') return navigation.navigate('ReworkDataRecord');
                  if (mod.key === 'attendance') return navigation.navigate('AttendanceSheet');
                  if (mod.key === 'pcs-per-hour') return navigation.navigate('PCSPerHour');
                  navigation.navigate('ComingSoonReport', { title: mod.title });
                }}
              />
            ))}
            {/* If the last row has only 1 card, fill the gap so alignment holds */}
            {row.length === 1 && <View style={{ width: CARD_SIZE }} />}
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#14181C' },

  backButton: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 20, marginTop: 12,
  },
  backText: { color: '#8A96A3', fontSize: 15 },

  header: { paddingHorizontal: 20, paddingTop: 14, paddingBottom: 14 },
  title:  { color: '#ECEFF2', fontSize: 22, fontWeight: '800' },
  subtitle: { color: '#8A96A3', fontSize: 13, marginTop: 4 },

  scroll: { paddingHorizontal: 20, paddingBottom: 40 },

  // Each row is a flex row with a fixed gap between the two cards
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 12,
  },

  // Card wrapper: fixed size so the grid never collapses
  cardWrap: {
    // width + height set inline from CARD_SIZE
  },

  // Both faces are absolute so they occupy exactly the same space as the wrapper
  face: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    backfaceVisibility: 'hidden',
  },

  card: {
    flex: 1,
    backgroundColor: '#1D2329',
    borderWidth: 1,
    borderColor: '#2C343C',
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 14,
    overflow: 'hidden',
  },
  cardPressed: { backgroundColor: '#242B32', borderColor: '#3A434C' },

  infoBadge: {
    position: 'absolute',
    top: 8,
    right: 8,
    zIndex: 10,
  },

  iconBadge: {
    width: 52,
    height: 52,
    borderRadius: 13,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },

  cardTitle: {
    color: '#ECEFF2',
    fontSize: 12.5,
    fontWeight: '700',
    textAlign: 'center',
    lineHeight: 17,
  },

  // Back face
  accentDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginBottom: 10,
  },
  backDescription: {
    color: '#ECEFF2',
    fontSize: 11.5,
    lineHeight: 17,
    textAlign: 'center',
    paddingHorizontal: 4,
  },
});