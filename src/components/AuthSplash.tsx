// src/components/AuthSplash.tsx
//
// Startup screen shown by App.tsx ONLY while Firebase is restoring the
// authentication session (useAuthStore().initializing). It replaces the
// login screen during that window, so a returning user never sees login
// flash before landing on the dashboard. No artificial delay — it unmounts
// the moment the first auth-state result (and the user's profile) is in.
//
// Same logo asset and background as LoginScreen, so the hand-off to login
// for a signed-out user is seamless.

import React, { useEffect, useRef } from 'react';
import { ActivityIndicator, Animated, Easing, Image, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

export default function AuthSplash() {
  const { width } = useWindowDimensions();
  // Logo is 612×408 — keep that ratio, clamp for phones and wide web windows.
  const logoWidth = Math.max(200, Math.min(width * 0.6, 340));
  const logoHeight = logoWidth * (408 / 612);

  // Gentle fade-in, then a slow "pulse" — built-in Animated, no extra library.
  const opacity = useRef(new Animated.Value(0)).current;
  const scale = useRef(new Animated.Value(0.96)).current;
  useEffect(() => {
    Animated.timing(opacity, { toValue: 1, duration: 350, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(scale, { toValue: 1.02, duration: 900, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(scale, { toValue: 0.96, duration: 900, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ])
    );
    pulse.start();
    return () => pulse.stop();
  }, [opacity, scale]);

  return (
    <View style={styles.container} accessibilityRole="progressbar" accessibilityLabel="Loading ProdPulse">
      <Animated.View style={{ opacity, transform: [{ scale }], alignItems: 'center' }}>
        <Image
          source={require('../../assets/prodpulse-logo.png')}
          style={{ width: logoWidth, height: logoHeight }}
          resizeMode="contain"
        />
      </Animated.View>
      <Animated.View style={[styles.footer, { opacity }]}>
        <ActivityIndicator color="#F2A93B" />
        <Text style={styles.subtitle}>Initializing your workspace</Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0F1417',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  footer: { marginTop: 8, alignItems: 'center', gap: 10 },
  subtitle: { color: '#8A96A3', fontSize: 13, letterSpacing: 0.4 },
});
