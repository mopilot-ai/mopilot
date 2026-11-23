// A drawn switch (translucent track that turns blue, white thumb that eases across), identical on every platform; colours and haptics come from the MoPilot design system.
import { useEffect } from 'react';
import Animated, { Easing, interpolate, interpolateColor, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { feedback, radii } from './metrics';
import { switchColors, useTokens } from '../../../src/ui/ds/tokens';
import { useReducedMotionEnabled } from '../../../src/ui/ds/useReducedMotion';
import { selectionHaptic } from '../../../src/ui/ds/haptics';
import { Tap } from '../../../src/ui/ds/Tap';

export type SwitchProps = {
  value: boolean;
  onValueChange: (value: boolean) => void;
  accessibilityLabel: string;
  disabled?: boolean;
  testID?: string;
};

const TRACK_WIDTH = 51;
const TRACK_HEIGHT = 31;
const THUMB = 27;
const INSET = 2;
const TRAVEL = TRACK_WIDTH - THUMB - INSET * 2;
const TOGGLE_MS = 260;
const EASING = Easing.bezier(0.32, 0.72, 0, 1);
// Reaches a 44 pt target without making the row taller than its siblings.
const HIT_SLOP = { top: (44 - TRACK_HEIGHT) / 2, bottom: (44 - TRACK_HEIGHT) / 2 } as const;

export function Switch({ value, onValueChange, accessibilityLabel, disabled = false, testID }: SwitchProps) {
  const reducedMotion = useReducedMotionEnabled();
  const progress = useSharedValue(value ? 1 : 0);
  const { off, on } = switchColors(useTokens());

  useEffect(() => {
    progress.value = withTiming(value ? 1 : 0, { duration: reducedMotion ? 0 : TOGGLE_MS, easing: EASING });
  }, [progress, reducedMotion, value]);

  const trackStyle = useAnimatedStyle(() => ({ backgroundColor: interpolateColor(progress.value, [0, 1], [off, on]) }), [progress, off, on]);
  const thumbStyle = useAnimatedStyle(() => ({ transform: [{ translateX: interpolate(progress.value, [0, 1], [0, TRAVEL]) }] }), [progress]);

  return (
    <Tap
      // a switch shows its own change (the thumb eases across), so a held one shows nothing more
      feel="none"
      onPress={() => {
        selectionHaptic();
        onValueChange(!value);
      }}
      disabled={disabled}
      accessibilityRole="switch"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ checked: value, disabled }}
      aria-checked={value}
      testID={testID}
      hitSlop={HIT_SLOP}
      style={[{ justifyContent: 'center', flexShrink: 0 }, disabled && { opacity: feedback.disabledOpacity }]}
    >
      <Animated.View style={[{ width: TRACK_WIDTH, height: TRACK_HEIGHT, borderRadius: radii.pill, padding: INSET }, trackStyle]}>
        <Animated.View style={[thumbStyleBase, thumbStyle]} />
      </Animated.View>
    </Tap>
  );
}

const thumbStyleBase = {
  width: THUMB,
  height: THUMB,
  borderRadius: radii.pill,
  backgroundColor: '#ffffff',
  shadowColor: '#000',
  shadowOpacity: 0.3,
  shadowRadius: 3,
  shadowOffset: { width: 0, height: 2 },
  elevation: 2,
} as const;
