// The phone's one tappable: the press look is drawn by the native button at touch-down, so it shows while the JS thread is busy.
import type { ComponentProps, ReactNode } from 'react';
import { Pressable as NativePressable, StyleSheet, type GestureResponderEvent, type StyleProp, type ViewStyle } from 'react-native';
import { Touchable } from 'react-native-gesture-handler';
import { dur, haptic, press } from '../../motion';

/**
 * How a held control looks: `dim` fades to the press opacity, `row` lays the colour under a list row (it keeps its corners),
 * `none` shows nothing (a scrim, a message that opens a menu on a long press, a picture that is the whole screen).
 */
export type TapFeel = 'dim' | 'row' | 'none';

type ButtonProps = ComponentProps<typeof Touchable>;

export type TapProps = Omit<
  ButtonProps,
  'style' | 'onPress' | 'onLongPress' | 'onPressIn' | 'onPressOut' | 'children' | 'animationDuration'
> & {
  /** A plain style: what a press changes is the `feel`, not a function of the press. */
  style?: StyleProp<ViewStyle>;
  /** The touch is only given when the feel is `none`; the native button reports a press without one. */
  onPress?: (event: GestureResponderEvent) => void;
  onLongPress?: () => void;
  /** Called the moment a finger lifts, held or not (the end of a long press). */
  onPressOut?: () => void;
  feel?: TapFeel;
  /** How far a `dim` fades while held; the press opacity of the motion scale unless the design system's own is asked for. */
  dimTo?: number;
  /** The colour a `row` shows while held. */
  rowColor?: string;
  /** The haptic a tap plays after it is pressed, where the reference has one. */
  tick?: keyof typeof haptic;
  children?: ReactNode;
};

/** The native button fades in over the first 60 ms and out over the next 120, the app's own press and snap times. */
const TIMES = { in: dur.fast, out: dur.snap } as const;

export function Tap({ feel = 'dim', dimTo = press.opacity, rowColor, tick, onPress, style, children, ...props }: TapProps) {
  const pressed =
    onPress &&
    ((event: GestureResponderEvent) => {
      if (tick) haptic[tick]();
      onPress(event);
    });
  if (feel === 'none')
    return (
      <NativePressable {...(props as object)} onPress={pressed} style={style}>
        {children}
      </NativePressable>
    );
  // the native button owns the view's opacity (a press fades it and the fade ends at its resting opacity), so a style's opacity is the resting one
  const { opacity = 1, ...resting } = StyleSheet.flatten([style]) as ViewStyle;
  return (
    <Touchable
      accessible
      {...props}
      onPress={pressed && (() => pressed(undefined as never))}
      style={resting}
      animationDuration={TIMES}
      defaultOpacity={opacity}
      activeOpacity={feel === 'dim' ? Math.min(opacity, dimTo) : undefined}
      underlayColor={feel === 'row' ? rowColor : undefined}
      activeUnderlayOpacity={feel === 'row' ? 1 : undefined}
    >
      {children}
    </Touchable>
  );
}
