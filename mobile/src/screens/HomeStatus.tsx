// What the home screen says about the account above the chat list: sign-in, loading, pairing, and one line while the Mac is away with nothing kept to show.
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import type { MobileRuntime, MobileSnapshot } from '../contracts';
import { NewSessionRow } from '../components/HomeSections';
import { Button, ErrorLine, Title, useStyles } from '../components/ui';
import { ErrorRecovery } from '../components/ErrorRecovery';
import { DevHostTag } from '../components/DevHostTag';
import { traceLine } from '../launchTrace';
import { Welcome } from './Welcome';
import { NotificationsCard } from '../push/NotificationsCard';
import type { PushController, PushUi } from '../push/controller';
import { PairingCards } from '../components/PairingCards';
import { ConnectPaired, PairFirst, UnsentMessages } from '../components/ComputersSection';
import { queueCalls } from '../components/QueuedMessages';
import { awayFromMac } from '../macLink';
import { plainError } from '../pairingLog';
import { accountRecoveryMessage, accountRequiresSignIn } from '../accountRecovery';
import { PAIR_LOST_LINE } from '../pairLost';
import { REFUSAL_TEXT } from '../../../shared/remote/relayRefusal.mjs';

/** When the person last pressed Retry on a computer this phone cannot read, and how long that is remembered. */
let retriedAt = 0;
const TRIED_FOR_MS = 60_000;

/** An account with somewhere to show chats has the Chats header and its drawer; the other states (signing in, loading, an error) have neither. */
export const headed = (state: MobileSnapshot) => !!state.user && ['ready', 'offline', 'online'].includes(state.phase);

/** `run` is the app's action runner (busy state, errors for the current account only). */
export function HomeStatus({
  state,
  runtime,
  busy,
  error,
  run,
  push,
  pushUi,
  devEndpoints,
  pair,
  signOut,
  listed = false,
  newSession,
  uninvited = false,
}: {
  state: MobileSnapshot;
  runtime: MobileRuntime;
  busy: boolean;
  error: string | null;
  run: (fn: () => Promise<void>) => Promise<void>;
  push?: PushController;
  pushUi: PushUi;
  devEndpoints?: { relayUrl: string; accountOrigin: string };
  pair: () => void;
  /** Leaves the account (the app's own sign-out), for an error that only signing in again clears. */
  signOut: () => void;
  /** The chat list is drawn under this (online, or kept from before the Mac went away). */
  listed?: boolean;
  /** Starts a chat on a machine the phone reaches itself, while the Mac is away and there is no list to hang the New session row on. */
  newSession?: () => void;
  /** The account service says this account has no Mobile Remote. */
  uninvited?: boolean;
}) {
  const styles = useStyles();
  // a Retry that ends on the same line says so, so a repeat is not mistaken for nothing happening; the Retry's own connect leaves this screen
  // (it is not drawn while the phone is offline), so the time of the Retry is kept outside it and ends with another error or a minute (the Retry's own connect reaches online before the next frame is refused again, so an online phase does not end it)
  const [, redraw] = useState(0);
  useEffect(() => {
    if (state.phase === 'error' && state.error !== PAIR_LOST_LINE) retriedAt = 0;
  }, [state.phase, state.error]);
  const tried = Date.now() - retriedAt < TRIED_FOR_MS;
  const keepAccount = !!state.user && !accountRequiresSignIn(error ?? state.error);
  const retryPair = state.pairs.find((p) => p.pairId === state.selectedPair) ?? (state.pairs.length === 1 ? state.pairs[0] : undefined);
  // the app's name heads the waiting states; an account with no computer has its own empty state instead, and a Mac that went away
  // changes nothing on the page (its glyphs turn gray), so it is not a waiting state either
  const away = awayFromMac(state);
  const connectable = !!state.user && state.phase === 'ready' && state.pairs.length > 0 && !state.pendingPair && !state.pairingCommit;
  const named =
    !(state.user && state.phase === 'online') &&
    state.phase !== 'signedOut' &&
    !(state.user && state.pairs.length === 0) &&
    !away &&
    !connectable;
  // on the Chats list's own 24 pt margins; under the header the list starts right away, without it the page leaves room at the top
  return (
    <View style={{ paddingHorizontal: 24, paddingTop: headed(state) ? 0 : 20, gap: 16 }}>
      {named && <Title>MoPilot</Title>}
      {named && <Text style={styles.muted}>Your chats, connected to your computer.</Text>}
      {devEndpoints && <DevHostTag host={new URL(devEndpoints.accountOrigin).host} trace={traceLine()} />}
      {/* while the Mac is away its reason is on its row in Settings › Computers, not on the home page */}
      <ErrorLine text={away ? null : accountRecoveryMessage(plainError(error ?? state.error))} />
      {state.phase === 'loading' && (
        <Text accessibilityLiveRegion="polite" style={styles.muted}>
          Loading your account…
        </Text>
      )}
      {state.catchingUp && (
        <Text accessibilityLiveRegion="polite" style={styles.muted}>
          Catching up with your computer…
        </Text>
      )}
      <ErrorRecovery
        failed={state.phase === 'error'}
        signedIn={!!state.user}
        busy={busy}
        preserveAccount={keepAccount}
        retry={
          keepAccount && state.user
            ? retryPair
              ? () => {
                  retriedAt = Date.now();
                  redraw((n) => n + 1);
                  void run(() => runtime.connect(retryPair.pairId));
                }
              : state.pairs.length
                ? undefined // several computers: the person picks one below
                : () => void run(() => runtime.start())
            : () => void run(() => runtime.start())
        }
        signOut={signOut}
      />
      {tried && !busy && state.phase === 'error' && state.error === PAIR_LOST_LINE && (
        <Text accessibilityLiveRegion="polite" style={styles.muted}>
          Tried again just now: still the same.
        </Text>
      )}
      {/* a computer this phone cannot catch up with: only that computer is paired again, the account stays */}
      {state.phase === 'error' && state.error === PAIR_LOST_LINE && retryPair && (
        <Button
          title="Pair again"
          disabled={busy}
          onPress={() =>
            void run(async () => {
              await runtime.unpair(retryPair.pairId);
              pair();
            })
          }
        />
      )}
      {state.phase === 'error' &&
        keepAccount &&
        state.user &&
        !retryPair &&
        state.pairs.map((saved) => (
          <Button
            key={saved.pairId}
            secondary
            title={`Reconnect ${saved.name?.trim() || 'Computer'}`}
            disabled={busy}
            onPress={() => void run(() => runtime.connect(saved.pairId))}
          />
        ))}
      {state.phase === 'signedOut' && (
        <Welcome
          busy={busy}
          signIn={() => {
            void run(() => runtime.signIn());
          }}
        />
      )}
      {push && <ErrorLine text={pushUi.notice} />}
      {/* asked once a computer is connected, when a notification can mean something; pairing comes first */}
      {push && state.user && state.phase === 'online' && pushUi.step === 'explain' && (
        <NotificationsCard push={push} step={pushUi.step} busy={pushUi.busy} />
      )}
      <PairingCards
        state={state}
        busy={busy}
        cancel={() => {
          void run(() => runtime.cancelPairing());
        }}
      />
      {state.user &&
        !state.pendingPair &&
        !state.pairingCommit &&
        state.phase !== 'online' &&
        state.pairs.length === 0 &&
        (uninvited ? (
          <Text
            style={[styles.muted, { paddingTop: 8 }]}
          >{`MoPilot on your phone isn't available for ${state.user.email ?? 'this account'} yet.`}</Text>
        ) : (
          <PairFirst pair={pair} />
        ))}
      {connectable && (
        <ConnectPaired
          state={state}
          busy={busy}
          connect={(pairId) => {
            void run(() => runtime.connect(pairId));
          }}
        />
      )}
      {/* the relay turned this phone away: the Mac may well be there, so the page says what is true, over a kept chat list too */}
      {away && state.refusal && (
        <Text accessibilityRole="alert" style={[styles.muted, { paddingTop: 8 }]}>
          {REFUSAL_TEXT[state.refusal]}
        </Text>
      )}
      {away && !state.refusal && !listed && (
        <>
          <Text style={[styles.muted, { paddingTop: 8 }]}>Your computer is offline. Your chats show here once it reconnects.</Text>
          {newSession && <NewSessionRow onPress={newSession} />}
        </>
      )}
      <UnsentMessages state={state} runtime={runtime} queue={queueCalls(runtime)} />
    </View>
  );
}
