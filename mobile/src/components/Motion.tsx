// The phone's moving parts: rows that fade in and make room, a chevron that turns, and Claude's thinking dots.
import { Icon } from './Icon';
import type { ReactNode } from 'react';
import { View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { Easing, FadeIn, FadeInDown, FadeOut, LayoutAnimationConfig, LinearTransition } from 'react-native-reanimated';
import { dur, ease } from '../motion';
import { useTheme } from '../theme';

/** A new row fades in over dur.base on Claude's enter curve while the rows around it make room in one short timed move (dur.base, ease.snap: no spring, so nothing drifts for half a second). */
const entering = FadeIn.duration(dur.base).easing(Easing.bezier(...ease.enter));
/** Your own sent bubble also rises 8pt into place while it fades in (the design spec: fade 200 ms + rise 8pt), on the same curve. */
const rising = FadeInDown.duration(dur.base)
  .easing(Easing.bezier(...ease.enter))
  .withInitialValues({ transform: [{ translateY: 8 }] });
const leaving = FadeOut.duration(dur.snap).easing(Easing.bezier(...ease.exit));
const layout = LinearTransition.duration(dur.base).easing(Easing.bezier(...ease.snap));

/**
 * A row of a list that animates in when it arrives and makes room when one above it changes size. `fade` false is for a row that
 * must not fade: the person's own message, which is already on screen as the queued bubble when the computer's copy of it lands. `rise` adds the 8pt rise of the sent bubble. `leave` false is for a row whose replacement is drawn in the same frame (no fade out over it).
 */
export function Enter({
  children,
  fade = true,
  leave = true,
  rise = false,
  hold = false,
  onLayout,
  style,
}: {
  children: ReactNode;
  fade?: boolean;
  leave?: boolean;
  rise?: boolean;
  /** True for a render in which earlier messages joined above the row: its place changes by what joined, and it must jump there with the list's offset, not glide (a glide carries the reader's text away, #4696, #4734). */
  hold?: boolean;
  onLayout?: (event: LayoutChangeEvent) => void;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Animated.View
      style={style}
      entering={fade ? (rise ? rising : entering) : undefined}
      exiting={leave ? leaving : undefined}
      layout={hold ? undefined : layout}
      onLayout={onLayout}
    >
      {children}
    </Animated.View>
  );
}

/** Rows already there when the list first shows do not animate in: only what arrives later does. */
export function SkipFirstEntrance({ children }: { children: ReactNode }) {
  return <LayoutAnimationConfig skipEntering>{children}</LayoutAnimationConfig>;
}

/** A disclosure chevron that turns a quarter when open, in dur.snap. */
export function Chevron({ open, color }: { open: boolean; color?: string }) {
  const theme = useTheme();
  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={{ transform: [{ rotate: open ? '90deg' : '0deg' }], transitionProperty: 'transform', transitionDuration: dur.snap }}
    >
      <Icon name="chevron.right" glyph="›" size={12} color={color ?? theme.ink3} />
    </Animated.View>
  );
}

/** Three dots that hop in turn over 1.9 s, each 150 ms after the one before: the Claude Design System's "thinking". */
const hop = {
  '0%': { transform: [{ translateY: 0 }] },
  '20%': { transform: [{ translateY: -3 }] },
  '40%': { transform: [{ translateY: 0 }] },
};
export function ThinkingDots({ color }: { color?: string }) {
  const theme = useTheme();
  return (
    <View accessibilityElementsHidden importantForAccessibility="no" style={{ flexDirection: 'row', gap: 3, alignItems: 'center' }}>
      {[0, 150, 300].map((delay) => (
        <Animated.View
          key={delay}
          style={{
            width: 4,
            height: 4,
            borderRadius: 2,
            backgroundColor: color ?? theme.ink3,
            animationName: hop,
            animationDuration: 1900,
            animationDelay: delay,
            animationIterationCount: 'infinite',
          }}
        />
      ))}
    </View>
  );
}
