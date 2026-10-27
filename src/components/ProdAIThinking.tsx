// src/components/ProdAIThinking.tsx
//
// Prod AI's brain mark, and the "thinking" indicator shown while a request
// is with the backend: the brain with three small dots that pulse left to
// right (utils/prodAIThinking). Only ever one on screen — the chat renders
// it once, for the single in-flight request. With reduced motion (OS
// setting / prefers-reduced-motion on web) the dots are static. The loop is
// stopped when the indicator unmounts (reply arrived, error, popup closed).

import React, { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, Platform, StyleSheet, Text, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import {
  THINKING_CYCLE_MS,
  THINKING_DOT_COUNT,
  THINKING_STATIC_OPACITY,
  thinkingDotInputRange,
  thinkingDotOpacityRange,
  thinkingDotRiseRange,
} from '../utils/prodAIThinking';

export function ProdAIBrain({ size = 18, color = '#FFFFFF' }: { size?: number; color?: string }) {
  return <MaterialCommunityIcons name="brain" size={size} color={color} accessibilityElementsHidden importantForAccessibility="no" />;
}

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => { if (alive) setReduced(!!v); })
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (v: boolean) => setReduced(!!v));
    return () => {
      alive = false;
      sub?.remove?.();
    };
  }, []);
  return reduced;
}

export default function ProdAIThinking({ label = 'Prod AI is thinking' }: { label?: string }) {
  const reduced = useReducedMotion();
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (reduced) {
      progress.stopAnimation();
      return;
    }
    progress.setValue(0);
    const loop = Animated.loop(
      Animated.timing(progress, {
        toValue: 1,
        duration: THINKING_CYCLE_MS,
        easing: Easing.linear,
        useNativeDriver: Platform.OS !== 'web',
      })
    );
    loop.start();
    return () => loop.stop();
  }, [reduced, progress]);

  return (
    <View
      style={styles.row}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityLiveRegion="polite"
    >
      <ProdAIBrain size={18} color="#FFFFFF" />
      <View style={styles.dots}>
        {Array.from({ length: THINKING_DOT_COUNT }, (_, i) =>
          reduced ? (
            <View key={i} style={[styles.dot, { opacity: THINKING_STATIC_OPACITY }]} />
          ) : (
            <Animated.View
              key={i}
              style={[
                styles.dot,
                {
                  opacity: progress.interpolate({ inputRange: thinkingDotInputRange(i), outputRange: thinkingDotOpacityRange() }),
                  transform: [{ translateY: progress.interpolate({ inputRange: thinkingDotInputRange(i), outputRange: thinkingDotRiseRange() }) }],
                },
              ]}
            />
          )
        )}
      </View>
      <Text style={styles.text}>Thinking…</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dots: { flexDirection: 'row', alignItems: 'center', gap: 4, height: 12 },
  dot: { width: 5, height: 5, borderRadius: 2.5, backgroundColor: '#FFFFFF' },
  text: { color: '#A3A3A3', fontSize: 13 },
});
