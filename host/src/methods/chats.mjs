// The Host's handler for `host.chats` (feature `chatList`): the chats it holds. The protocol gives it its chat log and epochs; an embedder with no data directory has none to list, and does not offer the feature.
import { UnsupportedError } from '../errors.mjs';
import { chatListOf } from '../chatList.mjs';
import { chatScopeOf } from '../chatScope.mjs';

/** @param {{ dataDir?: string, log?: Parameters<typeof chatListOf>[0] & { index: NonNullable<Parameters<typeof chatListOf>[4]> }, epochs?: Parameters<typeof chatListOf>[1], chatVisible?: Parameters<typeof chatListOf>[2] }} deps what the protocol was given, and its own chat log and epochs */
export default ({ dataDir, log, epochs, chatVisible }) => {
  const chatIndex = log?.index;
  const list = dataDir && log && epochs ? chatListOf(log, epochs, chatVisible, undefined, chatIndex) : null;
  /** The watch each connection has (its `ends` set stands for it), so a second one replaces the first. @type {WeakMap<Set<() => void>, ReturnType<NonNullable<typeof chatIndex>['watch']>>} */
  const watching = new WeakMap();
  return {
    handlers: {
      /** @param {{ limit: number }} p @param {unknown} _kind @param {unknown} [who] the connection's standing, which decides what it may see @param {unknown} [_emit] @param {Set<() => void>} [ends] what ends with the connection (its watch, if it has one, numbers the list) */
      'host.chats': (p, _kind, who, _emit, ends) => {
        if (!list) throw new UnsupportedError('This host keeps no chats to list.');
        return list(p, who, () => (ends ? watching.get(ends)?.seq() : 0) ?? 0);
      },
      /**
       * Starts telling this connection of each change to a chat's row (`{ event: 'chats', seq, op, kind, chat }`, a chat it may not see never). A client takes the answer's `at` as the numbering of the list it reads next: events after that are news, the list itself is only a baseline. A second watch replaces the first.
       * @param {unknown} _p @param {unknown} _kind @param {unknown} who @param {(message: object) => unknown} emit @param {Set<() => void>} ends what ends with the connection
       */
      'host.chats.watch': async (_p, _kind, who, emit, ends) => {
        if (!list || !chatIndex) throw new UnsupportedError('This host keeps no chats to list.');
        await chatIndex.ready();
        const before = watching.get(ends);
        if (before) before.stop(), ends.delete(before.stop);
        const watch = chatIndex.watch(emit, chatScopeOf(chatVisible)(who));
        watching.set(ends, watch);
        ends.add(watch.stop);
        return { watching: true, at: watch.at, generation: watch.generation };
      },
    },
  };
};
