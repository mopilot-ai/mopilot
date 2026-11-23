// The home screen's computer pieces: the empty state before any computer is paired, Connect for a paired one not yet connected, and what waits to be sent.
import { Text, View } from 'react-native';
import type { MobileRuntime, MobileSnapshot } from '../contracts';
import { QUEUED_LINE } from '../macLink';
import { useOutbox } from '../outboxView';
import { PAIR_HINT } from './Onboarding';
import { Icon } from './Icon';
import { QueuedMessages, queueCalls } from './QueuedMessages';
import { Button, Heading, useStyles } from './ui';

/** Nothing paired yet: Claude for iOS's empty state, one line and one Add a computer button. */
export function PairFirst({ pair }: { pair: () => void }) {
  const styles = useStyles();
  return (
    <View style={{ alignItems: 'center', gap: 10, paddingVertical: 32 }}>
      <Icon name="laptopcomputer" glyph="▭" size={40} color={styles.muted.color} />
      <Heading>No computer of yours yet</Heading>
      <Text style={[styles.muted, { textAlign: 'center' }]}>{PAIR_HINT}</Text>
      <View style={{ alignSelf: 'center' }}>
        <Button title="Add a computer" onPress={pair} />
      </View>
    </View>
  );
}

/** Paired but not connected yet (a pairing just finished, or the person disconnected): the one Mac to connect, with Connect. */
export function ConnectPaired({ state, busy, connect }: { state: MobileSnapshot; busy: boolean; connect: (pairId: string) => void }) {
  const styles = useStyles();
  const pair = state.pairs.find((p) => p.pairId === state.selectedPair) ?? state.pairs[0];
  const name = pair.name?.trim() || 'Computer';
  return (
    <View style={{ alignItems: 'center', gap: 10, paddingVertical: 32 }}>
      <Icon name="laptopcomputer" glyph="▭" size={40} color={styles.muted.color} />
      <Heading>{name}</Heading>
      <Text style={[styles.muted, { textAlign: 'center' }]}>Paired. Connect to see its chats.</Text>
      <View style={{ alignSelf: 'stretch' }}>
        <Button title="Connect" label={`Connect ${name}`} disabled={busy} onPress={() => connect(pair.pairId)} />
      </View>
    </View>
  );
}

/** What waits to be sent, above the chat list, connected or not (a message the Mac refused stays here until it is sent again or cancelled). */
export function UnsentMessages({
  state,
  runtime,
  queue,
}: {
  state: MobileSnapshot;
  runtime: MobileRuntime;
  queue: ReturnType<typeof queueCalls>;
}) {
  const styles = useStyles();
  // read here: a send's progress draws this list, not the home around it
  const outbox = useOutbox(runtime);
  if (!state.user || state.pendingPair || state.pairingCommit || !outbox.length) return null;
  return (
    <>
      <Heading>Unsent messages</Heading>
      {state.phase !== 'online' && <Text style={styles.muted}>{`${QUEUED_LINE}.`}</Text>}
      <QueuedMessages rises={false} pins={false} items={outbox} {...queue} />
    </>
  );
}
