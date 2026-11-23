// The "New chat…" capsule that floats above the tab bar on the Chats tab: a tap anywhere on it opens the new-chat sheet.
import { Text, View } from 'react-native';
import { Tap } from '../ui/ds/Tap';
import { useTheme } from '../theme';
import { typo } from '../typography';

export function NewChatCapsule({ open, disabled }: { open: () => void; disabled?: boolean }) {
  const theme = useTheme();
  const glyph = { ...typo.title2, color: theme.ink2 } as const;
  return (
    <View pointerEvents="box-none" style={{ paddingHorizontal: 12, paddingBottom: 6 }}>
      <Tap
        accessibilityRole="button"
        accessibilityLabel="New chat"
        accessibilityState={{ disabled: !!disabled }}
        disabled={disabled}
        onPress={open}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          minHeight: 48,
          paddingHorizontal: 14,
          borderRadius: 24,
          borderWidth: 1,
          borderColor: theme.line,
          backgroundColor: theme.surface,
          opacity: disabled ? 0.5 : 1,
        }}
      >
        <Text allowFontScaling={false} style={glyph}>
          +
        </Text>
        <Text style={{ flex: 1, ...typo.subhead, color: theme.ink3 }}>New chat…</Text>
      </Tap>
    </View>
  );
}
