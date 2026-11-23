// A segmented control as Claude for iOS draws it: a row of options on a sunken capsule, the selected one a raised pill with a soft shadow that slides to the option picked.
import { useEffect, useRef, useState } from 'react';
import { Text } from 'react-native';
import { Tap } from '../ui/ds/Tap';
import Animated, { Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';
import { dur, ease } from '../motion';
import { useTheme } from '../theme';
import { typo, typoWeight } from '../typography';

export type SegmentItem = {
  key: string;
  label: string /** What a screen reader says when the label alone is not enough. */;
  name?: string;
  onPress?: () => void;
};

/** The selected pill's shadow: barely there, as Claude's. */
const RAISED = { shadowColor: '#000', shadowOpacity: 0.1, shadowRadius: 3, shadowOffset: { width: 0, height: 1 }, elevation: 1 } as const;

/** The track's padding and the gap between options: the pill's travel is one option plus one gap. */
const PAD = 3;
const GAP = 2;

export function Segmented({ items, selected, margin = 0 }: { items: SegmentItem[]; selected: string; margin?: number }) {
  const theme = useTheme();
  const reduce = useReducedMotion();
  // the track's width, known once it is laid out: the one thing here that is state, since the options' size follows from it
  const [width, setWidth] = useState(0);
  const index = items.findIndex((item) => item.key === selected);
  const each = width > 0 ? (width - 2 * PAD - GAP * (items.length - 1)) / items.length : 0;
  const x = useSharedValue(0);
  const placed = useRef(false);
  useEffect(() => {
    if (width === 0 || index < 0) return;
    const to = index * (each + GAP);
    // the first place is taken, not travelled to
    x.value = reduce || !placed.current ? to : withTiming(to, { duration: dur.base, easing: Easing.bezier(...ease.snap) });
    placed.current = true;
  }, [index, each, width, reduce, x]);
  const slide = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }], width: each }));
  return (
    <Animated.View
      accessibilityRole="tablist"
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      style={{ flexDirection: 'row', backgroundColor: theme.sunken, borderRadius: 999, padding: PAD, gap: GAP, marginHorizontal: margin }}
    >
      {index >= 0 && width > 0 && (
        <Animated.View
          pointerEvents="none"
          style={[
            { position: 'absolute', top: PAD, bottom: PAD, left: PAD, borderRadius: 999, backgroundColor: theme.segment, ...RAISED },
            slide,
          ]}
        />
      )}
      {items.map((item) => {
        const on = item.key === selected;
        return (
          <Tap
            key={item.key}
            accessibilityRole="tab"
            accessibilityLabel={item.name ?? item.label}
            accessibilityState={{ selected: on }}
            onPress={item.onPress}
            hitSlop={{ top: 4, bottom: 4 }}
            style={{
              flex: 1,
              minHeight: 34,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 999,
            }}
          >
            <Text
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.7}
              style={{ ...typo.footnote, fontWeight: on ? typoWeight.semibold : typoWeight.medium, color: theme.ink }}
            >
              {item.label}
            </Text>
          </Tap>
        );
      })}
    </Animated.View>
  );
}
