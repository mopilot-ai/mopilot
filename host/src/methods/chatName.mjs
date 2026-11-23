// The Host's handler for `chat.rename` (feature `chatName`): the person's name for a chat, kept on this machine. The runtime names the agent's own session and records that the person chose the name, so no automatic title replaces it; a runtime that cannot is refused here with a short reason, never ignored.
import { UnsupportedError } from '../errors.mjs';

/** @param {{ runtime: { rename?: (chatId: string, name: string) => Promise<void> | void } }} deps what the protocol was given */
export default ({ runtime }) => ({
  effects: {
    /** @param {{ chatId: string, name: string }} p */
    async 'chat.rename'(p) {
      if (!runtime.rename) throw new UnsupportedError('This host cannot rename a chat yet. Update it.');
      await runtime.rename(p.chatId, p.name);
      return { name: p.name };
    },
  },
});
