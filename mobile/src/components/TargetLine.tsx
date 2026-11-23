// The "To: <label>" line of a browser approval, wherever the card is drawn (in the chat, in the Needs-you sheet): only the Mac's sanitised label, whole, and nothing when the card has none.
import { Text } from 'react-native';
import { useTheme } from '../theme';
import type { CardData } from './RequestCard';
import { typo } from '../typography';

/** The label to show, or '' when the card has no usable one (absent, empty, or not a string). */
export const targetOf = (card: Pick<CardData, 'to'>): string => (typeof card.to === 'string' && card.to.trim() ? card.to : '');

export function TargetLine({ card }: { card: Pick<CardData, 'to'> }) {
  const theme = useTheme();
  const to = targetOf(card);
  // not cut to a line: a destination cut short could hide what it says
  return to ? <Text style={{ ...typo.subhead, color: theme.ink2 }}>{`To: ${to}`}</Text> : null;
}
