// Claude for iOS's round down-arrow above the composer: shown when a reply has grown past the fold of a view that does not follow it, with a small mark when a card needs the person's answer below.
import { View } from 'react-native';
import { Tap } from '../ui/ds/Tap';
import { Icon } from './Icon';
import { useTheme } from '../theme';

export function JumpToLatest({ onPress, answer = false }: { onPress: () => void; answer?: boolean }) {
  const theme = useTheme();
  return (
    <Tap
      accessibilityRole="button"
      accessibilityLabel={answer ? 'Jump to the latest message, an answer is waiting' : 'Jump to the latest message'}
      onPress={onPress}
      // 44 pt hit area around a 36 pt circle
      hitSlop={4}
      style={{
        position: 'absolute',
        alignSelf: 'center',
        bottom: 12,
        width: 36,
        height: 36,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 18,
        borderWidth: 1,
        borderColor: theme.line,
        backgroundColor: theme.surface,
      }}
    >
      <Icon name="arrow.down" glyph="↓" size={16} color={theme.ink} />
      {/* a card needs an answer below: the arrow says so, since the view will not move to it */}
      {answer && (
        <View
          testID="answer-mark"
          style={{
            position: 'absolute',
            top: -2,
            right: -2,
            width: 12,
            height: 12,
            borderRadius: 6,
            backgroundColor: theme.amber,
            borderWidth: 2,
            borderColor: theme.surface,
          }}
        />
      )}
    </Tap>
  );
}
