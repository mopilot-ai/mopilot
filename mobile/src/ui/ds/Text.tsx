// The design system's text: a type-scale variant and a tone from the palette; it scales with the system text size and is never capped.
import type { ReactNode } from 'react';
import { Text as NativeText, type StyleProp, type TextStyle } from 'react-native';
import { typo } from '../../typography';
import { useTokens, type Theme } from './tokens';

export type TextVariant = keyof typeof typo;
export type TextTone = 'ink' | 'ink2' | 'ink3' | 'accent' | 'warn' | 'ok' | 'bad';

/** The style of a variant in a tone: size, line height and weight from the scale, colour from the palette. */
export const textStyle = (tokens: Theme, variant: TextVariant, tone: TextTone): TextStyle => ({ ...typo[variant], color: tokens[tone] });

export function Text({
  variant = 'body',
  tone = 'ink',
  style,
  children,
  ...rest
}: {
  variant?: TextVariant;
  tone?: TextTone;
  style?: StyleProp<TextStyle>;
  children?: ReactNode;
  numberOfLines?: number;
  selectable?: boolean;
  accessibilityRole?: 'header' | 'text' | 'link';
}) {
  return (
    <NativeText {...rest} style={[textStyle(useTokens(), variant, tone), style]}>
      {children}
    </NativeText>
  );
}
