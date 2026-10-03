import React from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  SafeAreaView,
  StatusBar,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
// Adjust this import to match where your Zustand auth store actually lives.
// Expected shape: { user: { role: 'admin' | 'supervisor' | ... } | null }
import { useAuthStore } from '../stores/authStore';

// ---------- Types ----------

type IconName = keyof typeof Ionicons.glyphMap;

interface HomeCardConfig {
  key: string;
  title: string;
  subtitle: string;
  icon: IconName;
  accent: string;
  route: string;
  adminOnly?: boolean;
}

// ---------- Config ----------

const CARDS: HomeCardConfig[] = [
  {
    key: 'record',
    title: 'Record Production',
    subtitle: 'Log output for this shift',
    icon: 'construct',
    accent: '#F2A93B', // safety amber
    route: 'AdminLogin',
  },
  {
    key: 'register-line',
    title: 'Register New Line',
    subtitle: 'Admin only',
    icon: 'add-circle',
    accent: '#3E7CB1', // signal blue
    route: 'AdminLogin',
  },
  {
    key: 'reports',
    title: 'Reports',
    subtitle: 'Shift & line summaries',
    icon: 'bar-chart',
    accent: '#4C9A6A', // confirm green
    route: 'Reports',
  },
  {
    key: 'settings',
    title: 'Settings',
    subtitle: 'Account & preferences',
    icon: 'settings',
    accent: '#8A96A3', // muted steel
    route: 'Settings',
  },
];

// ---------- Status strip (signature element) ----------

function StatusStrip() {
  const now = new Date();
  const dateStr = now
    .toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
    .toUpperCase();
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

  return (
    <View style={styles.statusStrip}>
      <View style={styles.statusLeft}>
        <View style={styles.liveDot} />
        <Text style={styles.statusMono}>LIVE</Text>
      </View>
      <Text style={styles.statusBrand}>TECHNICO INDUSTRIES</Text>
      <Text style={styles.statusMono}>{dateStr} · {timeStr}</Text>
    </View>
  );
}

// ---------- Card ----------

function HomeCard({ config }: { config: HomeCardConfig }) {
  const navigation = useNavigation<any>();

  return (
    <Pressable
      onPress={() => navigation.navigate(config.route)}
      style={({ pressed }) => [
        styles.card,
        pressed && styles.cardPressed,
      ]}
      android_ripple={{ color: '#2C343C' }}
      accessibilityRole="button"
      accessibilityLabel={config.title}
    >
      {/* corner accent stripe — the one recurring "hazard" motif, used sparingly */}
      <View style={[styles.cornerAccent, { borderTopColor: config.accent }]} />

      <View style={[styles.iconBadge, { backgroundColor: config.accent + '22', borderColor: config.accent }]}>
        <Ionicons name={config.icon} size={30} color={config.accent} />
      </View>

      <Text style={styles.cardTitle}>{config.title}</Text>
      <Text style={styles.cardSubtitle}>{config.subtitle}</Text>
    </Pressable>
  );
}

// ---------- Screen ----------

export default function HomeScreen() {
  const role = useAuthStore((s) => s.user?.role);
  const isAdmin = role === 'admin';

  const visibleCards = CARDS.filter((c) => !c.adminOnly || isAdmin);

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="light-content" backgroundColor="#14181C" />
      <StatusStrip />

      <View style={styles.body}>
        <Text style={styles.greeting}>Shop Floor Control</Text>
        <Text style={styles.greetingSub}>Select a task to continue</Text>

        <View style={styles.grid}>
          {visibleCards.map((card) => (
            <HomeCard key={card.key} config={card} />
          ))}
        </View>
      </View>
    </SafeAreaView>
  );
}

// ---------- Styles ----------

const CARD_GAP = 14;

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#14181C',
  },
  statusStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: '#1D2329',
    borderBottomWidth: 1,
    borderBottomColor: '#2C343C',
  },
  statusLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  liveDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#4C9A6A',
  },
  statusMono: {
    color: '#8A96A3',
    fontSize: 11,
    letterSpacing: 1,
    fontFamily: Platform.select({ ios: 'Courier', android: 'monospace' }),
  },
  statusBrand: {
    color: '#ECEFF2',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 2,
  },
  body: {
    flex: 1,
    paddingHorizontal: 16,
    paddingTop: 20,
  },
  greeting: {
    color: '#ECEFF2',
    fontSize: 24,
    fontWeight: '800',
    letterSpacing: 0.3,
  },
  greetingSub: {
    color: '#8A96A3',
    fontSize: 14,
    marginTop: 2,
    marginBottom: 20,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    rowGap: CARD_GAP,
  },
  card: {
    width: '48%',
    minHeight: 168,
    backgroundColor: '#1D2329',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#2C343C',
    padding: 16,
    justifyContent: 'flex-end',
    overflow: 'hidden',
    // large enough tap target for gloved hands on a factory floor
  },
  cardPressed: {
    backgroundColor: '#242B32',
    borderColor: '#3A434C',
  },
  cornerAccent: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: 36,
    height: 36,
    borderTopWidth: 4,
    borderRightWidth: 4,
    borderRightColor: 'transparent',
    borderTopRightRadius: 14,
  },
  iconBadge: {
    width: 52,
    height: 52,
    borderRadius: 10,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
  },
  cardTitle: {
    color: '#ECEFF2',
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  cardSubtitle: {
    color: '#8A96A3',
    fontSize: 12.5,
    marginTop: 3,
  },
});