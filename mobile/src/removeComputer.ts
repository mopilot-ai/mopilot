// Forgets one paired computer: the relay is asked to drop the pair (bounded), then its keys are deleted here whatever the relay said.
export type RemoveComputerDeps = {
  /** Why no removal may start now (a pairing is unfinished), or null. */
  blocked(): string | null;
  hasPair(pairId: string): Promise<boolean>;
  signedIn(): boolean;
  /** The connection counter: a change means something else took over the connection. */
  generation(): number;
  selectedPair(): string | null;
  /** The computer an attempt is trying to reach, if any. */
  reaching(): string | null;
  relayConnected(): boolean;
  /** Opens and authenticates the relay connection for the given owner. */
  connectRelay(owner: number): Promise<unknown>;
  relayRemove(pairId: string): Promise<unknown>;
  closeChannel(pairId: string): void;
  /** Deletes the pair from the vault; false when it was not there. */
  removePair(pairId: string): Promise<boolean>;
  /** Reads the pair list again for the given owner and shows it, if that owner is still current. */
  showPairs(owner: number): Promise<void>;
  disconnect(): void;
  publishError(note: string | null): void;
  timeoutMs?: number;
};

/** Drops a pair from the vault and shows the list again, retrying if a connection change retired the read. */
async function forgetPair(o: RemoveComputerDeps, pairId: string) {
  const removed = await o.removePair(pairId);
  for (let attempt = 0; removed && attempt < 3; attempt++) {
    const read = o.generation();
    await o.showPairs(read);
    if (read === o.generation()) return;
  }
}

/** Removals run one after another: each may open the relay connection and close it again. */
export function createUnpairing(o: RemoveComputerDeps) {
  let queue: Promise<void> = Promise.resolve();
  return {
    forget: (pairId: string) => forgetPair(o, pairId),
    async unpair(pairId: string) {
      const task = queue.then(() => removeComputer(o, pairId));
      queue = task.catch(() => undefined);
      await task;
    },
  };
}

async function removeComputer(o: RemoveComputerDeps, pairId: string) {
  const blocked = o.blocked();
  if (blocked) throw new Error(blocked);
  if (!(await o.hasPair(pairId))) return;
  // an attempt to reach this computer is called off: it would close the socket the removal goes through
  if (o.reaching() === pairId) o.disconnect();
  const owner = o.generation();
  // the relay connection of the open session is used as it is; a closed one is opened for this and closed again
  const opened = !o.relayConnected();
  let note: string | null = null;
  if (o.signedIn()) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          if (opened) await o.connectRelay(owner);
          await o.relayRemove(pairId);
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('timed out')), o.timeoutMs ?? 8000);
        }),
      ]);
    } catch (error) {
      // already gone at the relay is what was asked for
      if (!(error instanceof Error) || error.message !== 'relay: unknown_pair')
        note = 'Could not reach the relay. Remove this phone on your computer as well.';
    } finally {
      clearTimeout(timer);
    }
  }
  // nothing took over the connection while the relay was asked (a pairing, a sign-in, another computer)
  const mine = owner === o.generation();
  try {
    o.closeChannel(pairId);
    await forgetPair(o, pairId);
  } finally {
    // a connection opened for this is closed; the open session goes only if it was this computer's
    if (o.selectedPair() === pairId || (mine && opened)) o.disconnect();
  }
  if (mine) o.publishError(note);
}
