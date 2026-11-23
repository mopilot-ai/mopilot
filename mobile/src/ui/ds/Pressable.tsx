// The design system's pressable: a label every screen reader hears, a 44 pt minimum target and the app's one pressed look.
import type { ReactNode } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { Tap } from './Tap';
import { feedback, MIN_TARGET } from './tokens';

/** The style a pressable has: the minimum target, dimmed while disabled (the held look is the native button's). */
export const pressableStyle = (disabled: boolean, style?: StyleProp<ViewStyle>): StyleProp<ViewStyle> => [
  { minWidth: MIN_TARGET, minHeight: MIN_TARGET, justifyContent: 'center' },
  style,
  disabled && { opacity: feedback.disabledOpacity },
];

export function Pressable({
  label,
  onPress,
  disabled = false,
  role = 'button',
  hint,
  style,
  children,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  role?: 'button' | 'link' | 'tab';
  hint?: string;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  return (
    <Tap
      onPress={onPress}
      disabled={disabled}
      accessibilityRole={role}
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled }}
      dimTo={feedback.pressedOpacity}
      style={pressableStyle(disabled, style)}
    >
      {children}
    </Tap>
  );
}
