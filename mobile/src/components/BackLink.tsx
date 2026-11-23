// The Back link (a chevron and where it goes) at the top of a screen that sits one level below another.
import { Icon } from './Icon';
import { Text } from 'react-native';
import { Tap } from '../ui/ds/Tap';
import { useHardwareBack } from '../useHardwareBack';
import { useTheme } from '../theme';
import { typo } from '../typography';

export function BackLink({ onPress, label = 'Back' }: { onPress: () => void; label?: string }) {
  const theme = useTheme();
  useHardwareBack(onPress);
  return (
    <Tap
      accessibilityRole="button"
      accessibilityLabel={label === 'Back' ? label : `Back to ${label}`}
      onPress={onPress}
      style={{ minHeight: 44, minWidth: 88, flexDirection: 'row', alignItems: 'center', gap: 4 }}
    >
      <Icon name="chevron.left" glyph="‹" size={17} />
      <Text style={{ ...typo.callout, color: theme.ink }}>{label}</Text>
    </Tap>
  );
}
