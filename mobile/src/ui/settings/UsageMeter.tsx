// A usage bar: the share left, filling on the enter curve when a reading arrives or changes, still when the person asked for reduced motion.
import { useEffect } from 'react';
import { View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { metrics, motion, useReducedMotionEnabled, useTokens } from './settingsAdapters';
import type { Tone } from './usageModel';

export function UsageMeter({ left, tone }: { left: number | null; tone: Tone }) {
  const theme = useTokens();
  const reduce = useReducedMotionEnabled();
  const fill = useSharedValue(0);
  useEffect(() => {
    const to = Math.max(0, Math.min(100, left ?? 0));
    fill.value = reduce ? to : withTiming(to, { duration: motion.fill, easing: Easing.bezier(...motion.curve) });
  }, [left, reduce, fill]);
  const style = useAnimatedStyle(() => ({ width: `${fill.value}%` }));
  const color = tone === 'bad' ? theme.bad : tone === 'warn' ? theme.warn : tone === 'quiet' ? theme.ink3 : theme.accent;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ height: metrics.meter, borderRadius: metrics.meterRadius, backgroundColor: theme.sunken, overflow: 'hidden' }}
    >
      <Animated.View style={[{ height: metrics.meter, borderRadius: metrics.meterRadius, backgroundColor: color }, style]} />
    </View>
  );
}
