// What the home screen shows while a pairing is under way: the wait for the computer's Connect with the safety number a tap away, a pairing that is finishing, or one left unfinished.
import { Text } from 'react-native';
import type { MobileSnapshot } from '../contracts';
import { useHardwareBack } from '../useHardwareBack';
import { Button, Card, Heading, useStyles } from './ui';
import { SafetyDetail } from './SafetyDetail';
import { supportV2 } from '../ui/support/adapters';
import { PairingConfirm } from '../ui/support/PairingConfirm';

type Props = { state: MobileSnapshot; busy: boolean; cancel: () => void };

/** The new pairing wait behind the phone v2 flag, else the cards below. */
export const PairingCards = (props: Props) => (supportV2() ? <PairingStep {...props} /> : <ClassicPairingCards {...props} />);

function PairingStep({ state, busy, cancel }: Props) {
  useHardwareBack(cancel, !!state.pendingPair && !state.pairingCommit && !state.pairCleanup);
  const phase = state.pairingCommit
    ? 'finishing'
    : state.pendingPair && state.pairCleanup
      ? 'unfinished'
      : state.pendingPair
        ? 'confirm'
        : null;
  return phase ? <PairingConfirm vm={{ phase, safetyNumber: state.safetyNumber ?? null, busy }} onCancel={cancel} /> : null;
}

function ClassicPairingCards({ state, busy, cancel }: Props) {
  const styles = useStyles();
  // on the safety-number screen back is Cancel pairing, with no second question; a pairing that is finishing, or one left unfinished, has no such control
  useHardwareBack(cancel, !!state.pendingPair && !state.pairingCommit && !state.pairCleanup);
  if (state.pairingCommit)
    return (
      <Card>
        <Heading>Finishing pairing…</Heading>
        <Text style={styles.muted}>Please wait.</Text>
      </Card>
    );
  if (!state.pendingPair) return null;
  if (state.pairCleanup)
    return (
      <Card>
        <Heading>Unfinished pairing</Heading>
        <Text style={styles.muted}>Remove the unfinished pairing before pairing again.</Text>
        <Button secondary title="Remove unfinished pairing" disabled={busy} onPress={cancel} />
      </Card>
    );
  return (
    <Card>
      <Heading>Confirm on your computer</Heading>
      <Text style={styles.text}>Click Connect in MoPilot on your computer.</Text>
      {state.safetyNumber && <SafetyDetail number={state.safetyNumber} />}
      <Button secondary quietDanger title="Cancel pairing" onPress={cancel} />
    </Card>
  );
}
