// The cards in a chat's transcript: an approval as Claude's card (or the quiet line it leaves once answered), a closed plan as a row that reopens it, anything else as the request card.
import { Text, View } from 'react-native';
import { monoFamily } from '../fonts';
import { receiptLine } from '../presentation/receipts';
import type { useCards } from '../remote/useCards';
import { useTheme } from '../theme';
import { ApprovalCard, isApproval } from './ApprovalCard';
import { Icon } from './Icon';
import { PlanReminder } from './PlanSheet';
import { cardKey, RequestCard, type CardData } from './RequestCard';
import { WaitingCard } from './WaitingCard';
import { typo } from '../typography';

/** An answered approval: a check (or a cross for a refusal), where and how it was answered, and the command in mono (else the question). */
export function ResolvedApproval({ card, choice, by }: { card: CardData; choice?: string; by: 'phone' | 'mac' }) {
  const theme = useTheme();
  const refused = !!choice && !!card.choices?.some((c) => c.deny && c.label === choice);
  const words = receiptLine({ by, choice });
  return (
    <View accessible accessibilityLabel={`${words}: ${card.detail || card.title}`} style={{ gap: 2, paddingTop: 5, paddingBottom: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Icon name={refused ? 'xmark' : 'checkmark'} glyph={refused ? '✕' : '✓'} size={14} color={theme.ink2} />
        <Text style={{ flex: 1, ...typo.subhead, color: theme.ink2 }}>{words}</Text>
      </View>
      <Text
        numberOfLines={1}
        style={{
          ...(card.detail ? typo.footnote : typo.subhead),
          fontFamily: card.detail ? monoFamily() : undefined,
          color: theme.ink2,
          paddingLeft: 22,
        }}
      >
        {card.detail || card.title}
      </Text>
    </View>
  );
}

export function ChatCards({ cards }: { cards: ReturnType<typeof useCards> }) {
  return (
    <>
      {cards.shown.map((card) => {
        const key = cardKey(card);
        if (card.where === 'mac-only') return <WaitingCard key={key} card={card} />;
        if (cards.isOpenPlan(card))
          return cards.closedPlans.includes(key) ? <PlanReminder key={key} card={card} open={() => cards.openPlan(card)} /> : null;
        const answered = key in cards.settled;
        if (isApproval(card))
          return answered ? (
            <ResolvedApproval key={key} card={card} by={cards.receipts[key]?.by ?? 'mac'} choice={cards.receipts[key]?.choice} />
          ) : (
            <ApprovalCard key={key} card={card} answer={(choice) => cards.answerCard(card, choice)} comment={cards.comment} />
          );
        return (
          <RequestCard
            key={key}
            card={card}
            answered={answered}
            receipt={cards.receipts[key]}
            answer={(choice, values) => cards.answerCard(card, choice, values)}
          />
        );
      })}
    </>
  );
}
