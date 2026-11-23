// A system symbol (SF Symbols on iOS) with a text glyph where the platform has none, and the round button that holds one.
import type { ReactNode } from 'react';
import { Text } from 'react-native';
import { Tap } from '../ui/ds/Tap';
import { SymbolView, type SFSymbol } from 'expo-symbols';
import { useTheme } from '../theme';

export function Icon({ name, glyph, size = 22, color }: { name: SFSymbol; glyph: string; size?: number; color?: string }) {
  const theme = useTheme();
  const tint = color ?? theme.ink;
  return (
    <SymbolView
      name={name}
      size={size}
      tintColor={tint}
      fallback={
        <Text allowFontScaling={false} style={{ fontSize: size, color: tint }}>
          {glyph}
        </Text>
      }
    />
  );
}

/** An icon button for a bar: a 44 pt hit area, dimmed while held, as in the references' bars. */
export function IconButton({ label, children, onPress }: { label: string; children: ReactNode; onPress: () => void }) {
  return (
    <Tap
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      onPress={onPress}
      style={[{ minWidth: 38, minHeight: 38, alignItems: 'center', justifyContent: 'center' }]}
    >
      {children}
    </Tap>
  );
}
