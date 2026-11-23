// MoMo's memory in the turns of its chats on a Host: the same <momo-context> block the Mac app gives a MoMo chat's turn (the user's own preferences, the saved facts), plus the owner's standing rules in a section of their own. The turn code every harness shares asks `momoContextFor(chatId)` at each turn; only the process that set a provider gets an answer, so a Host that is the home sets one while it runs and takes it back when it stops.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { setMomoContextProvider, memoryContextProvider } = require('../../electron/momo/contract/context.cjs');

/** The origin of a fact MoMo inferred itself, which a turn on a Host does not carry (electron/momo/memoryFacts.cjs). */
export const INFERRED = ['extracted'];

/**
 * @param {object} o
 * @param {{ stamp: () => unknown, stores: () => { memory?: any } | null, chats: { carriesMemory: (chatId: string) => boolean } | null, service: (id: string) => unknown }} o.home
 * @returns {() => void} takes the provider back
 */
export function installMomoContext({ home }) {
  /** Whether the learning service has been told the brain reads the rules now: once while there are rules. */
  let told = false;
  const learning = () =>
    /** @type {{ ownerRules?: () => { text: string, kind?: string }[], appliedBy?: (who: string) => unknown } | undefined} */ (
      home.service('learning')
    );
  return setMomoContextProvider(
    memoryContextProvider({
      store: {
        // the facts a turn carries are the owner's own and what a chat of theirs saved (through the gate): never what a background pass inferred from outside text (origin 'extracted'), which stays out until the owner makes it their own
        summary: (/** @type {any} */ o) =>
          home.stores()?.memory?.summary({ ...o, excludeOrigins: INFERRED }) ?? { persona: '', aboutYou: '', facts: [] },
        available: () => home.stores()?.memory?.available?.() === true,
      },
      // only the running home speaks for MoMo, and a data chat (a brief, a reading turn) carries no memory of its own
      allowed: () => !!home.stamp(),
      isMomoChat: (/** @type {string} */ chatId) => !!home.chats?.carriesMemory(chatId),
      ownerRules: () => {
        const rules = learning()?.ownerRules?.() ?? [];
        // the Rules page shows a rule as applied only once something has read it: the brain does, from this turn
        if (rules.length && !told) {
          told = true;
          learning()?.appliedBy?.('brain');
        } else if (!rules.length) told = false;
        return rules;
      },
    }),
  );
}
