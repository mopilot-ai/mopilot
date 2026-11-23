// The dev host's agent switch and its pace: a chat moved to another agent waits for its next message as the Mac holds it (`switching`, the target named by the menus, a note row when it settles), and `latency` stands in for the relay on the calls that change or read a chat's controls.
import { HARNESSES } from './fakeData.mjs';

/** The calls a phone's model sheet makes (writes and the reads after them) that `latency` slows. */
const SLOWED = ['options', 'choose', 'permit', 'switchHarness', 'harnesses', 'setChatAccount'];

/**
 * @param {object} o
 * @param {Map<string, any>} o.chats
 * @param {(line: string) => void} o.log
 * @param {(ms: number) => Promise<void>} o.sleep
 * @param {number} [o.latency] milliseconds each slowed call takes (0: answers at once)
 * @param {string} [o.refuse] when set, every agent switch is refused with this message (to see a refusal on a phone)
 */
export function createFakeSwitch({ chats, log, sleep, latency = 0, refuse = '' }) {
  /** @type {Map<string, string>} the agent a chat moves to with its next message */
  const waiting = new Map();
  const labelOf = (/** @type {string} */ id) => HARNESSES.find((h) => h.id === id)?.label ?? id;
  return {
    /** The agent the chat's menus name: the one it moves to while a move waits, else the one it runs on. */
    shownFor: (/** @type {string} */ chatId) => waiting.get(chatId) ?? chats.get(chatId)?.harness,
    held: (/** @type {string} */ chatId) => waiting.has(chatId),
    /** The app's agent switch: its own agent again calls a waiting move off; a chat the app does not know is refused. */
    async switchHarness(/** @type {{ chatId: string, harness: string }} */ p) {
      const chat = chats.get(p.chatId);
      if (!chat) throw new Error("That chat isn't in MoPilot.");
      if (refuse) throw new Error(refuse);
      if (p.harness === chat.harness) waiting.delete(p.chatId);
      else waiting.set(p.chatId, p.harness);
      log(`app: switch ${p.chatId} to ${p.harness}`);
    },
    /** The chat's next message: a waiting move settles, and the chat says so in a note row. */
    settle(/** @type {string} */ chatId, /** @type {(chat: any, role: string, text: string) => void} */ row) {
      const to = waiting.get(chatId);
      if (!to) return;
      waiting.delete(chatId);
      const chat = chats.get(chatId);
      chat.harness = to;
      row(chat, 'note', `Moved to ${labelOf(to)}`);
      log(`app: ${chatId} moved to ${to}`);
    },
    /** `ops` with each slowed call taking `latency` first. */
    slow(/** @type {Record<string, any>} */ ops) {
      if (!latency) return ops;
      const slowed = { ...ops };
      for (const name of SLOWED) {
        const call = ops[name];
        if (typeof call === 'function') slowed[name] = async (/** @type {any[]} */ ...args) => (await sleep(latency), call(...args));
      }
      return slowed;
    },
  };
}
