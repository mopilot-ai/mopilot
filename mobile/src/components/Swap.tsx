// Content that replaces other content in the same place (a step, a tab's steps): the new content fades in over dur.base on the enter curve and the old is gone at once; the first draw does not animate, and Reduce Motion cuts it (the layout animation's system default).
import type { ReactNode } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import Animated, { Easing, FadeIn, LayoutAnimationConfig } from 'react-native-reanimated';
import { dur, ease } from '../motion';

const arrive = FadeIn.duration(dur.base).easing(Easing.bezier(...ease.enter));

/** `id` names what is shown: a new id fades the new children in. */
export function Swap({ id, children, style }: { id: string; children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <LayoutAnimationConfig skipEntering>
      <Animated.View key={id} entering={arrive} style={style}>
        {children}
      </Animated.View>
    </LayoutAnimationConfig>
  );
}
