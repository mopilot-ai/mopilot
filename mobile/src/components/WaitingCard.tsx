// A hand-off only the Mac finishes (a payment, a sign-in, a check): the Mac's own words and nothing to press.
import { Text, View } from 'react-native';
import { useTheme } from '../theme';
import { Icon } from './Icon';
import type { CardData } from './RequestCard';
import { typo } from '../typography';

export function WaitingCard({ card }: { card: CardData }) {
  const theme = useTheme();
  const words = card.waitingCopy || card.title;
  return (
    <View
      accessible
      accessibilityLabel={words}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 5, paddingBottom: 10 }}
    >
      <Icon name="hand.raised" glyph="✋" size={16} color={theme.amber} />
      <Text style={{ flex: 1, ...typo.subhead, color: theme.ink2 }}>{words}</Text>
    </View>
  );
}
