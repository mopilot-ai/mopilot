// Claude for iOS's floating controls: 48 pt glass circles and capsules in the header and footer, the New chat capsule, and outlined chips.
import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import { Tap } from '../ui/ds/Tap';
import { useTheme } from '../theme';
import { typo } from '../typography';

/** The soft lift every floating control has, as in the baseline (0 2 10 at 5 %). */
const lift = { boxShadow: '0px 2px 10px rgba(0, 0, 0, 0.05)' } as const;

/** A 48 pt round button with one glyph: Back, the drawer, search, the laptop. `badge` adds the green (or grey) state dot at its lower right. */
export function GlassCircle({
  label,
  onPress,
  children,
  badge,
}: {
  label: string;
  onPress: () => void;
  children: ReactNode;
  /** 'on' draws a green dot, 'off' a grey one; absent draws none */
  badge?: 'on' | 'off';
}) {
  const theme = useTheme();
  return (
    <Tap
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={[
        {
          width: 48,
          aspectRatio: 1,
          borderRadius: 24,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: theme.surface,
          borderWidth: 1,
          borderColor: theme.glassLine,
          ...lift,
        },
      ]}
    >
      {children}
      {badge && (
        <View
          accessibilityElementsHidden
          importantForAccessibility="no"
          style={{
            position: 'absolute',
            right: 9,
            bottom: 10,
            width: 9,
            aspectRatio: 1,
            borderRadius: 5,
            borderWidth: 2,
            borderColor: theme.surface,
            backgroundColor: badge === 'on' ? theme.ok : theme.ink3,
          }}
        />
      )}
    </Tap>
  );
}

/** A 48 pt capsule holding several glyph buttons side by side (Claude's ⋯ and history pair). */
export function GlassCapsule({ items }: { items: Array<{ label: string; onPress: () => void; icon: ReactNode }> }) {
  const theme = useTheme();
  return (
    <View
      style={{
        minHeight: 48,
        borderRadius: 24,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 4,
        backgroundColor: theme.surface,
        borderWidth: 1,
        borderColor: theme.glassLine,
        ...lift,
      }}
    >
      {items.map((item) => (
        <Tap
          key={item.label}
          accessibilityRole="button"
          accessibilityLabel={item.label}
          onPress={item.onPress}
          style={[{ width: 40, aspectRatio: 1, alignItems: 'center', justifyContent: 'center' }]}
        >
          {item.icon}
        </Tap>
      ))}
    </View>
  );
}

/** The raised capsule at the bottom of a list ("New chat", "New task"): a glyph and a title on the surface colour. */
export function Capsule({
  title,
  icon,
  onPress,
  disabled = false,
}: {
  title: string;
  icon?: ReactNode;
  onPress: () => void;
  /** held while another action runs: dimmed and not pressable */
  disabled?: boolean;
}) {
  const theme = useTheme();
  return (
    <Tap
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[
        {
          minHeight: 48,
          borderRadius: 24,
          paddingHorizontal: 20,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          backgroundColor: theme.surface,
          borderWidth: 1,
          borderColor: theme.glassLine,
          boxShadow: '0px 2px 14px rgba(0, 0, 0, 0.08)',
        },
        disabled && { opacity: 0.45 },
      ]}
    >
      {icon}
      <Text style={{ ...typo.callout, color: theme.ink }}>{title}</Text>
    </Tap>
  );
}

/** A 40 pt outlined chip above a composer (agent, computer, project): a glyph, a value, tap to change it. */
export function Chip({
  label,
  value,
  icon,
  onPress,
  missing = false,
}: {
  label: string;
  value: string;
  icon?: ReactNode;
  onPress: () => void;
  /** What the chip asks for is not chosen yet (a Host's folder): outlined in amber so it reads as the thing still to do (the words keep the ink that passes contrast). */
  missing?: boolean;
}) {
  const theme = useTheme();
  return (
    <Tap
      accessibilityRole="button"
      accessibilityLabel={`${label}, ${value}`}
      onPress={onPress}
      style={[
        {
          minHeight: 40,
          borderRadius: 20,
          paddingHorizontal: 14,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 7,
          borderWidth: 1,
          borderColor: missing ? theme.amber : theme.line,
          backgroundColor: theme.bg,
        },
      ]}
    >
      {icon}
      <Text numberOfLines={1} style={{ ...typo.subhead, color: theme.ink }}>
        {value}
      </Text>
    </Tap>
  );
}
