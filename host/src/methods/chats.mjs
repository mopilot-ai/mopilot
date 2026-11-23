// The Host's handler for `host.chats` (feature `chatList`): the chats it holds. The protocol gives it its chat log and epochs; an embedder with no data directory has none to list, and does not offer the feature.
import { UnsupportedError } from '../errors.mjs';
import { chatListOf } from '../chatList.mjs';

/** @param {{ dataDir?: string, log?: Parameters<typeof chatListOf>[0], epochs?: Parameters<typeof chatListOf>[1], chatVisible?: Parameters<typeof chatListOf>[2] }} deps what the protocol was given, and its own chat log and epochs */
export default ({ dataDir, log, epochs, chatVisible }) => {
  const list = dataDir && log && epochs ? chatListOf(log, epochs, chatVisible) : null;
  return {
    handlers: {
      /** @param {{ limit: number }} p @param {unknown} _kind @param {unknown} [who] the connection's standing, which decides what it may see */
      'host.chats': (p, _kind, who) => {
        if (!list) throw new UnsupportedError('This host keeps no chats to list.');
        return list(p, who);
      },
    },
  };
};
