// A multiline field whose box grows and shrinks over dur.sheet instead of jumping: the field lays out at its natural height off to the side of the flow, and the box's height follows it on a CSS transition, so everything stacked around the box (the pill, the transcript above) moves in the same frames. At rest the box is a plain height held in state: no shared value and no animated style exist for it, because one of each, mounted in every open chat, kept the UI thread busy all the time (about 3 s of every 9, #4986).
import type { ComponentProps, ComponentType } from 'react';
import { useRef, useState } from 'react';
import Animated, { cubicBezier, useReducedMotion } from 'react-native-reanimated';
import type { StyleProp, TextInputProps, TextStyle } from 'react-native';
import { dur, ease } from '../motion';
import { Field } from './ui';

/** The box's height on its way. It is in the style for as long as the field is focused, before any height changes: a transition must be there when the height changes, not added by the same update (the first growth then jumped, and only the shrink after it moved). An unfocused field has none, so every height it takes is taken at once. */
const grow = { transitionProperty: 'height', transitionDuration: dur.sheet, transitionTimingFunction: cubicBezier(...ease.snap) } as const;

/** A height that differs from the last by less than this is the same height measured again (the native field lays out more than once for one edit). */
const SAME = 0.5;

export function GrowingField({
  minHeight,
  maxHeight,
  style,
  onLayout,
  onFocus,
  onBlur,
  input: Input = Field,
  ...props
}: Omit<TextInputProps, 'style'> & {
  minHeight: number;
  maxHeight: number;
  style?: StyleProp<TextStyle>;
  /** The field to draw: the app's styled one by default, or a plain TextInput. */
  input?: ComponentType<TextInputProps & ComponentProps<typeof Field>>;
}) {
  const reduce = useReducedMotion();
  const [height, setHeight] = useState(minHeight);
  // focused: the box carries its transition, so a height typed in is reached over dur.sheet; a height taken while nobody types is taken at once
  const [focusedNow, setFocusedNow] = useState(false);
  const placed = useRef(false);
  const target = useRef(minHeight);
  return (
    <Animated.View style={[{ overflow: 'hidden', minHeight, height }, focusedNow && !reduce ? grow : null]}>
      <Input
        {...props}
        onFocus={(event) => {
          setFocusedNow(true);
          onFocus?.(event);
        }}
        onBlur={(event) => {
          setFocusedNow(false);
          onBlur?.(event);
        }}
        onLayout={(event) => {
          onLayout?.(event);
          const next = Math.max(minHeight, Math.min(maxHeight, event.nativeEvent.layout.height));
          // the same height reported again must not restart a move that is already on its way
          if (placed.current && Math.abs(next - target.current) < SAME) return;
          target.current = next;
          // the first measure, text that arrives while nobody is typing (a draft restored after the screen opened) and Reduce Motion take the height at once:
          // the box has no transition then (see `grow`)
          setHeight(next);
          placed.current = true;
        }}
        style={[style, { position: 'absolute', top: 0, left: 0, right: 0, minHeight, maxHeight }]}
      />
    </Animated.View>
  );
}
