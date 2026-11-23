// A machine page's Waiting section (X3): the cards its Host waits on, each in the states of the plan's card table. The Host's reply decides each state; a tap shows progress on the pressed button and disables the others.
import { Text, View } from 'react-native';
import { Tap } from '../ui/ds/Tap';
import { cardLine } from '../../../shared/host/directWords.mjs';
import type { ShownCard } from '../remote/hostCards';
import { useNow } from '../remote/useNow';
import { useTheme } from '../theme';
import { typo } from '../typography';
import { Group, GroupLabel } from './Grouped';

function CardButton({
  label,
  onPress,
  deny = false,
  disabled = false,
  busy = false,
}: {
  label: string;
  onPress: () => void;
  deny?: boolean;
  disabled?: boolean;
  busy?: boolean;
}) {
  const theme = useTheme();
  return (
    <Tap
      accessibilityRole="button"
      accessibilityLabel={label === '…' ? 'Sending' : label}
      accessibilityState={{ disabled, busy }}
      disabled={disabled}
      onPress={onPress}
      style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 14, backgroundColor: theme.surface, opacity: disabled ? 0.5 : 1 }}
    >
      <Text style={{ ...typo.subheadMedium, color: deny ? theme.ink2 : theme.ink }}>{label}</Text>
    </Tap>
  );
}

/** How long a closed card stays on the machine page, so the outcome of a tap is seen. */
export const CLOSED_SHOWN_MS = 4000;

export function MachineApprovals({
  cards,
  machine,
  answer,
}: {
  cards: ShownCard[];
  machine: string;
  answer: (cardId: string, optionId: string) => void;
}) {
  const theme = useTheme();
  const now = useNow(1000);
  // a closed card says how it ended for a few seconds and then leaves the list: the chat keeps the record
  cards = cards.filter((c) => c.closedAt === undefined || now - c.closedAt < CLOSED_SHOWN_MS);
  if (!cards.length) return null;
  return (
    <>
      <GroupLabel>Waiting</GroupLabel>
      <Group>
        {cards.map(({ id, card, state }) => (
          <View key={id} style={{ padding: 16, gap: 10 }}>
            <Text style={{ ...typo.body, color: theme.ink }}>{card.summary.line}</Text>
            {state.kind === 'closed' ? (
              <Text style={{ ...typo.callout, color: theme.ink2 }}>{state.line}</Text>
            ) : (
              <>
                {state.kind === 'unreachable' && (
                  <Text style={{ ...typo.callout, color: theme.warn }}>{cardLine('unreachable', { machine })}</Text>
                )}
                <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
                  {state.kind === 'unreachable' ? (
                    <CardButton label="Try again" onPress={() => answer(id, state.optionId)} />
                  ) : (
                    card.options.map((option) => {
                      const mine = state.kind === 'sending' && state.optionId === option.optionId;
                      return (
                        <CardButton
                          key={option.optionId}
                          label={mine ? '…' : option.name}
                          deny={option.kind === 'deny'}
                          disabled={state.kind === 'sending'}
                          busy={mine}
                          onPress={() => answer(id, option.optionId)}
                        />
                      );
                    })
                  )}
                </View>
              </>
            )}
          </View>
        ))}
      </Group>
    </>
  );
}
