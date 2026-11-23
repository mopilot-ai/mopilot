// A plan waiting for approval as a bottom sheet over the chat; closing it leaves a row in the chat that reopens it.
import { ScrollView, Text, View } from 'react-native';
import { Tap } from '../ui/ds/Tap';
import { cardKey, RequestCard, type CardData } from './RequestCard';
import { Button, useStyles } from './ui';
import type { Data } from '../presentation/thread';
import type { useCards } from '../remote/useCards';
import { useTheme } from '../theme';
import { useHardwareBack } from '../useHardwareBack';

export function PlanSheet({
  card,
  answer,
  open,
  close,
}: {
  card: CardData;
  answer: (key: string, values?: Data) => Promise<boolean>;
  /** Closed, the sheet stays mounted but hidden, so what the card holds (an answer on its way, a choice picked) is not lost. */
  open: boolean;
  close: () => void;
}) {
  const theme = useTheme();
  useHardwareBack(close, open);
  return (
    <View
      // the whole overlay is the modal view, so the chat behind it is hidden from a screen reader and the scrim stays reachable
      accessibilityViewIsModal
      style={{ display: open ? 'flex' : 'none', position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, justifyContent: 'flex-end' }}
    >
      <Tap
        accessibilityRole="button"
        accessibilityLabel="Close plan"
        onPress={close}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(8, 12, 9, 0.45)' }}
      />
      <View
        style={{
          backgroundColor: theme.surface,
          borderTopLeftRadius: 26,
          borderTopRightRadius: 26,
          paddingHorizontal: 16,
          paddingTop: 10,
          paddingBottom: 28,
          maxHeight: '80%',
        }}
      >
        <View style={{ alignSelf: 'center', width: 38, height: 5, borderRadius: 3, backgroundColor: theme.line, marginBottom: 10 }} />
        <ScrollView keyboardShouldPersistTaps="handled">
          <RequestCard bare card={card} answer={answer} />
        </ScrollView>
      </View>
    </View>
  );
}

/** What stays in the chat once the sheet is closed: the plan is still waiting, and one tap reads it again. */
export function PlanReminder({ card, open }: { card: CardData; open: () => void }) {
  const styles = useStyles();
  return (
    <View style={{ gap: 8 }}>
      <Text accessibilityRole="header" style={styles.heading}>
        {card.title}
      </Text>
      <Text style={styles.muted}>This plan is waiting for your answer.</Text>
      <Button title="Review plan" onPress={open} />
    </View>
  );
}

/** The open plan of a chat's cards as its sheet: shut while its changes are asked for in the field, and answered through the chat's own cards. */
export function ChatPlanSheet({ cards }: { cards: ReturnType<typeof useCards> }) {
  const plan = cards.sheetPlan;
  if (!plan) return null;
  return (
    <PlanSheet
      key={cardKey(plan)}
      open={!cards.closedPlans.includes(cardKey(plan))}
      card={plan}
      answer={(key, values) => cards.answerCard(plan, key, values)}
      close={() => cards.closePlan(plan)}
    />
  );
}
