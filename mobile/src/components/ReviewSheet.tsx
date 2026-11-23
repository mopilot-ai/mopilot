// The Needs-you quick review: the cards one waiting chat asks, answered in a native sheet over the list, so several chats can be cleared without opening each. Only what the computer offers can be chosen; nothing here widens a permission.
import { ScrollView, Text, View } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import type { MobileRuntime } from '../contracts';
import { asksForChanges, cardKey, RequestCard } from './RequestCard';
import { Notice } from './Notice';
import { Button, ErrorLine, useStyles } from './ui';
import { unconfirmedNotice } from '../remote/unconfirmed';
import { useChatCards } from '../remote/useChatCards';
import { useTheme } from '../theme';
import { useHardwareBack } from '../useHardwareBack';
import { typo } from '../typography';
import { useKeyboardLift } from '../useKeyboardLift';
import { useLargeText } from '../useLargeText';

export function ReviewSheet({
  runtime,
  chatId,
  title,
  subtitle,
  position,
  next,
  openChat,
  askChanges,
  close,
}: {
  runtime: MobileRuntime;
  chatId: string;
  title: string;
  subtitle?: string;
  /** "1 of 3": where this chat is among those waiting. */
  position?: string;
  /** The next waiting chat, when there is one. */
  next?: () => void;
  openChat: () => void;
  /** A plan's "Ask for changes", with that card's key: the chat opens asking what should change, which a sheet with no field cannot do; absent, the refusal is sent from here. */
  askChanges?: (card: string) => void;
  close: () => void;
}) {
  const theme = useTheme();
  useHardwareBack(close);
  const styles = useStyles();
  const review = useChatCards(runtime, chatId);
  // at a large text size the footer's buttons would take half the sheet and hide the card's choices behind them: they scroll with the card instead
  const large = useLargeText();
  // a native sheet sits outside the app frame's keyboard avoidance: typing in a question's field must not leave its buttons under the keyboard
  const lift = useKeyboardLift();
  // the sheet's own padding when no keyboard is up, else the keyboard's reach
  const ride = useAnimatedStyle(() => ({ paddingBottom: Math.max(lift.value, 28) }));
  const footer = (
    <View style={{ gap: 8 }}>
      {review.waiting === 0 &&
        review.loaded &&
        (next ? <Button title="Next chat" onPress={next} /> : <Button title="Done" onPress={close} />)}
      <View style={styles.row}>
        {!!review.error && <Button secondary title="Try again" onPress={review.reload} />}
        <Button secondary title="Open chat" onPress={openChat} />
        {review.waiting > 0 && <Button secondary title={next ? 'Later' : 'Close'} onPress={next ?? close} />}
      </View>
    </View>
  );
  return (
    // a native form sheet over the list holds it (its grabber and swipe down are the system's)
    <Animated.View style={[{ flex: 1, paddingHorizontal: 16, paddingTop: 18, gap: 10, backgroundColor: theme.surface }, ride]}>
      <View>
        <Text accessibilityRole="header" numberOfLines={2} style={{ ...typo.bodySemibold, color: theme.ink }}>
          {title}
        </Text>
        {!!(subtitle || position) && (
          <Text style={{ ...typo.caption, color: theme.ink3 }}>{[position, subtitle].filter(Boolean).join(' · ')}</Text>
        )}
      </View>
      <ScrollView keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets contentContainerStyle={{ gap: 14 }}>
        {!review.loaded && !review.error && (
          <Text accessibilityLiveRegion="polite" style={styles.muted}>
            Loading…
          </Text>
        )}
        {review.loaded && review.cards.length === 0 && <Text style={styles.muted}>Nothing is waiting for you in this chat now.</Text>}
        <ErrorLine text={review.error ?? review.answerError} />
        {review.unconfirmed && <Notice {...unconfirmedNotice('answer')} />}
        {review.cards.map((card) => (
          <RequestCard
            key={cardKey(card)}
            bare
            card={card}
            receipt={review.receipts[cardKey(card)] ?? null}
            answer={(key, values) =>
              askChanges && asksForChanges(card, key)
                ? (askChanges(cardKey(card)), Promise.resolve(false))
                : review.answer(card, key, values)
            }
          />
        ))}
        {large && footer}
      </ScrollView>
      {!large && footer}
    </Animated.View>
  );
}
