// A rounded answer button of MoMo's chat cards (a reminder's Snooze, Dismiss and Done, a brief card's Hide and Start): 44 pt high, the strong one filled.
import { Text } from 'react-native';
import { Tap } from '../ui/ds/Tap';
import { useTheme } from '../theme';
import { typo } from '../typography';

export function Pill({
  title,
  strong,
  disabled,
  onPress,
  label,
}: {
  title: string;
  strong?: boolean;
  disabled: boolean;
  onPress: () => void;
  /** what VoiceOver says, when the name alone does not say what it acts on */
  label?: string;
}) {
  const theme = useTheme();
  return (
    <Tap
      accessibilityRole="button"
      accessibilityLabel={label ?? title}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[
        {
          // as wide as its label needs and growing into the row's room: a label that needs two lines makes the pill taller, never spills out of it
          flexGrow: 1,
          flexShrink: 1,
          flexBasis: 'auto',
          minHeight: 44,
          paddingHorizontal: 16,
          paddingVertical: 10,
          borderRadius: 22,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: strong ? theme.btn : theme.sunken,
        },
        disabled && { opacity: 0.45 },
      ]}
    >
      <Text style={{ ...typo.calloutMedium, color: strong ? theme.btnInk : theme.ink, textAlign: 'center' }}>{title}</Text>
    </Tap>
  );
}
