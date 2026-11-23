// Claude's orange spark: twelve rounded rays, long and short in turn, drawn with plain views; it spins for a working line and stays still under Reduce Motion.
import { View } from 'react-native';
import Animated, { useReducedMotion } from 'react-native-reanimated';
import { dur } from '../motion';
import { useTheme } from '../theme';

/** The baseline's ray geometry on a 24-unit square: rays start 2.2 out from the centre and reach 9.5 (even) or 7 (odd), 2.2 thick. */
const UNIT = 24;
const INNER = 2.2;
const LONG = 9.5;
const SHORT = 7;
const THICK = 2.2;
export const RAYS = Array.from({ length: 12 }, (_, i) => ({ angle: i * 30, reach: i % 2 ? SHORT : LONG }));

const turn = { from: { transform: [{ rotate: '0deg' }] }, to: { transform: [{ rotate: '360deg' }] } };

/** `size` is the square it fills in points; `spin` turns it once every 1.1 s, as the baseline's working mark does. */
export function Spark({ size = 22, spin = false, color }: { size?: number; spin?: boolean; color?: string }) {
  const theme = useTheme();
  const reduce = useReducedMotion();
  const k = size / UNIT;
  const tint = color ?? theme.orange;
  const rays = RAYS.map(({ angle, reach }) => (
    // each ray sits on a full-size layer turned about the centre, so one bar position serves every angle
    <View key={angle} style={{ position: 'absolute', top: 0, left: 0, width: size, height: size, transform: [{ rotate: `${angle}deg` }] }}>
      <View
        style={{
          position: 'absolute',
          left: (UNIT / 2 + INNER) * k - (THICK * k) / 2,
          top: (UNIT / 2) * k - (THICK * k) / 2,
          width: (reach - INNER) * k + THICK * k,
          height: THICK * k,
          borderRadius: (THICK * k) / 2,
          backgroundColor: tint,
        }}
      />
    </View>
  ));
  const box = { width: size, height: size };
  if (spin && !reduce)
    return (
      <Animated.View
        accessibilityElementsHidden
        importantForAccessibility="no"
        style={[
          box,
          { animationName: turn, animationDuration: dur.spin, animationIterationCount: 'infinite', animationTimingFunction: 'linear' },
        ]}
      >
        {rays}
      </Animated.View>
    );
  return (
    <View accessibilityElementsHidden importantForAccessibility="no" style={box}>
      {rays}
    </View>
  );
}
