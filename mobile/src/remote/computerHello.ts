// Every hello observes name and native-correlation capability under the same captured pair/generation, ignoring retired replies.
import { learnComputerName, nameSaved } from '../computerName';
import type { createMessageIdentity } from './messageIdentity';
export function createComputerHello(
  identities: ReturnType<typeof createMessageIdentity>,
  owner: () => {
    generation: number;
    selectedPair: string | null;
    vault: { updatePair: (pairId: string, change: (pair: { name?: string }) => unknown) => Promise<boolean> };
    updatePairs: (generation: number) => Promise<void>;
  },
) {
  return (answer: Promise<unknown>) => {
    const captured = owner();
    const pairId = captured.selectedPair;
    if (!pairId) return;
    const current = () => captured.generation === owner().generation && pairId === owner().selectedPair;
    identities.observe(pairId, answer, current);
    void learnComputerName({
      hello: () => answer,
      save: (name) => captured.vault.updatePair(pairId, (pair) => nameSaved(pair, name)),
      current,
      saved: () => captured.updatePairs(captured.generation),
    }).catch(() => undefined);
  };
}
