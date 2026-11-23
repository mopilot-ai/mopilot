// The row above a chat's first message: a quiet centered line that loads earlier messages on a tap, or says where the chat starts.
import { Text, View } from 'react-native';
import { Tap } from '../ui/ds/Tap';
import { useTheme } from '../theme';
import { ErrorLine } from './ui';
import { typo } from '../typography';

export function EarlierRow({
  more,
  omitted,
  busy,
  error,
  load,
}: {
  /** false once the oldest message is in; the row then only says where the chat starts */
  more: boolean;
  /** the Mac keeps the earlier messages itself (it has no page to send) */
  omitted: boolean;
  busy: boolean;
  error: string | null;
  load: () => void;
}) {
  const theme = useTheme();
  const quiet = { ...typo.subhead, color: theme.ink2, textAlign: 'center' as const };
  if (!more)
    return (
      <Text style={{ ...quiet, paddingVertical: 8 }}>
        {omitted ? 'Earlier messages are only in MoPilot on your computer.' : 'This is the start of the chat.'}
      </Text>
    );
  return (
    <View>
      <ErrorLine text={error} />
      <Tap
        accessibilityRole="button"
        accessibilityLabel={busy ? 'Loading earlier messages' : 'Load earlier messages'}
        accessibilityState={{ disabled: busy, busy }}
        disabled={busy}
        onPress={load}
        hitSlop={8}
        style={{ minHeight: 44, alignItems: 'center', justifyContent: 'center', opacity: busy ? 0.5 : 1 }}
      >
        <Text style={quiet}>{busy ? 'Loading…' : 'Load earlier messages'}</Text>
      </Tap>
    </View>
  );
}
