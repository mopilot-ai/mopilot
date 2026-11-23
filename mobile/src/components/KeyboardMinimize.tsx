// Shared composer control for putting away the software keyboard while preserving the draft.
import { Keyboard } from 'react-native';
import { Tap } from '../ui/ds/Tap';
import { Icon } from './Icon';
import { useTheme } from '../theme';

export function KeyboardMinimize() {
  const theme = useTheme();
  return (
    <Tap
      accessibilityRole="button"
      accessibilityLabel="Minimize keyboard"
      onPress={Keyboard.dismiss}
      hitSlop={8}
      style={{ width: 36, minHeight: 36, aspectRatio: 1, alignItems: 'center', justifyContent: 'center' }}
    >
      <Icon name="keyboard.chevron.compact.down" glyph="⌄" size={18} color={theme.ink2} />
    </Tap>
  );
}
