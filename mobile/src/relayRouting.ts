// Scope account-wide relay events and receive failures to the exact selected or joining phone pair.
import { decodeFrame, EnvelopeError } from '../../shared/remote/envelope.mjs';
import { failureOutcome } from './pairingLog';
import { isTransient } from './reconnect';

type Channel = { receive(frame: { pair: string }): Promise<void>; close(): void };
/** What a request says when the link, not the computer, failed. */
const LOST = /^(Connection closed|Connect to a computer first|relay )/i;

const settled = (error: unknown) => failureOutcome(error) === 'badCode' || failureOutcome(error) === 'otherAccount' || isTransient(error);

export function createRelayRouting(o: {
  channels: Map<string, Channel>;
  selectedPair(): string | null;
  /** The pair being connected, whose unreadable frame must end the connection visibly (it is not yet selected, so presence events do not concern it). */
  connecting?(): string | null;
  interrupt(error: string, phase: 'error' | 'offline'): void;
  generation(): number;
  refreshPairs(owner: number): Promise<void>;
  reconciliationError(error: unknown): void;
  /** A pairing failed in a way that says nothing about the account (a bad code, another account, no network): the form says why, and the app carries on. */
  pairingSettled(owner: number): void;
  /** The relay says this committed pair is gone (the computer removed this phone, or its device was revoked): forget it here too. */
  removed?(pair: string): void;
  /** The relay reports a computer's presence (any pair this phone has, not only the selected one). */
  presence?(pair: string, state: unknown, at: unknown): void;
  /** One cheap request to the selected computer, to learn whether it still answers (a `pair.resync` notice can be stale). */
  probe?(): Promise<unknown>;
  /** How long the probe may take before the computer is taken to be not answering. */
  probeMs?: number;
}) {
  let joiningPair: string | null = null;
  let joiningOwner = 0;
  let retiredCommit: { owner: number; generation: number } | null = null;
  const reportCurrent = (owner: number, error: unknown) => {
    if (owner === o.generation()) o.reconciliationError(error);
  };
  const committed = async (owner: number) => {
    const current = o.generation();
    try {
      await o.refreshPairs(current);
    } catch (error) {
      if (owner === o.generation()) throw error;
      if (retiredCommit?.owner === owner && retiredCommit.generation === current && current === o.generation())
        o.reconciliationError(error);
      return false;
    }
    return owner === o.generation();
  };
  return {
    joining(pair: string) {
      joiningPair = pair;
      joiningOwner = o.generation();
    },
    reset() {
      if (joiningPair && joiningOwner !== o.generation()) retiredCommit = { owner: joiningOwner, generation: o.generation() };
      joiningPair = null;
    },
    committed,
    async failed(owner: number, error: unknown) {
      try {
        if (await committed(owner)) settled(error) ? o.pairingSettled(owner) : reportCurrent(owner, error);
      } catch (readError) {
        reportCurrent(owner, readError);
        throw readError;
      }
    },
    event(value: unknown) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return;
      const event = value as { ev?: unknown; pair?: unknown; state?: unknown };
      const pair = event.pair;
      if (typeof pair !== 'string' || !pair) return;
      if (event.ev === 'pair.removed' || event.ev === 'mailbox.dropped') {
        const channel = o.channels.get(pair);
        channel?.close();
        o.channels.delete(pair);
        // read before interrupting, which retires the joining pair
        const making = pair === joiningPair;
        if (pair === o.selectedPair() || making) o.interrupt('Connection interrupted; pair again if necessary', 'error');
        // a pair still being made is cleaned up by the pairing flow, not forgotten here
        if (event.ev === 'pair.removed' && !making) o.removed?.(pair);
      } else if (event.ev === 'machine.presence') {
        o.presence?.(pair, event.state, (event as { at?: unknown }).at);
        if (pair === o.selectedPair() && (event.state === 'gone' || event.state === 'sleeping'))
          o.interrupt('Computer is offline', 'offline');
      }
    },
    /**
     * The computer's sealed `pair.resync` notice: it closed its session with this phone. A notice can be old (the computer restarted since),
     * so a request decides. An answer, even an error, means nothing is wrong; a link that fails is just a lost connection, which reconnects by
     * itself; two requests left without any answer mean the computer is not accepting this phone's messages.
     */
    async resync(pair: string) {
      if (pair !== o.selectedPair() || !o.probe) return;
      const owner = o.generation();
      const current = () => owner === o.generation() && pair === o.selectedPair();
      let outcome: 'answered' | 'lost' | 'silent' = 'silent';
      for (let attempt = 0; attempt < 2 && outcome === 'silent' && current(); attempt++) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        outcome = await Promise.race([
          o.probe().then(
            () => 'answered' as const,
            (error) => (LOST.test(error instanceof Error ? error.message : '') ? ('lost' as const) : ('answered' as const)),
          ),
          new Promise<'silent'>((resolve) => {
            timer = setTimeout(() => resolve('silent'), o.probeMs ?? 8000);
          }),
        ]);
        clearTimeout(timer);
      }
      if (outcome === 'answered' || !current()) return;
      if (outcome === 'lost') return o.interrupt('Connection lost. Reconnecting…', 'offline');
      o.interrupt(
        'Your computer stopped accepting messages from this phone. Restart MoPilot on the computer. If that does not help, remove the computer here and pair it again.',
        'error',
      );
    },
    async receive(frame: { pair: string }) {
      const channel = o.channels.get(frame.pair);
      if (!channel) return;
      try {
        await channel.receive(frame);
      } catch (error) {
        if (o.channels.get(frame.pair) !== channel) return;
        if (frame.pair === o.selectedPair() || (o.connecting && frame.pair === o.connecting())) throw error;
        channel.close();
        o.channels.delete(frame.pair);
      }
    },
  };
}

/** Whether a counter-zero frame has the shape of a pairing reply; a frame that isn't one is skipped, anything else that goes wrong is raised. */
export function isSealedReply(frame: Parameters<typeof decodeFrame>[0]) {
  try {
    const decoded = decodeFrame(frame);
    return decoded.nonce.length === 24 && decoded.box.length >= 16;
  } catch (error) {
    if (error instanceof EnvelopeError) return false;
    throw error;
  }
}
