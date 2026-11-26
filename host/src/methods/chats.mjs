// The Host's handler for `host.chats` (feature `chatList`): the chats it holds. The protocol gives it its chat log and epochs; an embedder with no data directory has none to list, and does not offer the feature.
import { UnsupportedError } from '../errors.mjs';
import { chatListOf } from '../chatList.mjs';
import { chatScopeOf } from '../chatScope.mjs';
import { createNativeIndex } from '../nativeIndex.mjs';
import { NATIVE_EVENTS_FEATURE, NATIVE_LIST_FEATURE, wantsNative } from '../../../shared/host/nativeChats.mjs';

/** @param {{ nativeSessions?: { attach?: (index: ReturnType<typeof createNativeIndex>) => { demand: () => Promise<unknown>, watching: () => () => void, notes?: () => { family: string, reason: string, words: string }[] } | void }, dataDir?: string, log?: Parameters<typeof chatListOf>[0] & { index: NonNullable<Parameters<typeof chatListOf>[4]> }, epochs?: Parameters<typeof chatListOf>[1], chatVisible?: Parameters<typeof chatListOf>[2] }} deps what the protocol was given, and its own chat log and epochs */
export default ({ dataDir, log, epochs, chatVisible, nativeSessions }) => {
  const chatIndex = log?.index;
  // sessions started outside MoPilot (#5576, flag `hosts.nativeSessions`): an index only a Host built with the option has, which a discoverer is attached to; a session this Host runs is never one of its rows
  /** @type {ReturnType<typeof createNativeIndex> | null} */
  let native = null;
  /** What the discoverers are told of who is asking (#5576: no scan, title or harness call without a client that may be shown the rows). @type {{ demand: () => Promise<unknown>, watching: () => () => void, notes?: () => { family: string, reason: string, words: string }[] } | null} */
  let consumer = null;
  if (nativeSessions && chatIndex) {
    native = createNativeIndex({
      owned: (id) => chatIndex.has(id),
      announce: (kind, chatId, rev, chat) => chatIndex.announce(kind, chatId, rev, chat),
    });
    consumer = nativeSessions.attach?.(native) ?? null;
    chatIndex.onRow((id) => native?.recheck(id));
  }
  const list = dataDir && log && epochs ? chatListOf(log, epochs, chatVisible, undefined, chatIndex, native ?? undefined) : null;
  /** Whether a client of this standing may be told of native sessions (the hello offers the two features to it only then). @param {unknown} principal */
  const mayList = (principal) => chatScopeOf(undefined)({ principal: () => principal }).native;
  /** The watch each connection has (its `ends` set stands for it), so a second one replaces the first. @type {WeakMap<Set<() => void>, ReturnType<NonNullable<typeof chatIndex>['watch']>>} */
  const watching = new WeakMap();
  /** The stop of the discoverers' watch each connection has, which a second watch of it replaces. @type {WeakMap<Set<() => void>, () => void>} */
  const consumerStops = new WeakMap();
  return {
    // the hello names the native features to a client that may see native sessions, and to no other
    features: { [NATIVE_LIST_FEATURE]: mayList, [NATIVE_EVENTS_FEATURE]: mayList },
    handlers: {
      /** @param {{ limit: number, origin?: 'native' | 'all' }} p @param {unknown} _kind @param {unknown} [who] the connection's standing, which decides what it may see @param {unknown} [_emit] @param {Set<() => void>} [ends] what ends with the connection (its watch, if it has one, numbers the list) */
      'host.chats': (p, _kind, who, _emit, ends) => {
        if (!list) throw new UnsupportedError('This host keeps no chats to list.');
        if (wantsNative(p.origin) && !native) throw new UnsupportedError('This host does not list native sessions.');
        const run = () => list(p, who, () => (ends ? watching.get(ends)?.seq() : 0) ?? 0);
        // a scan happens because a client that may see the rows asked for them (a short wait for one that has not run lately)
        const asked = consumer;
        if (!(wantsNative(p.origin) && asked && mayList(/** @type {any} */ (who)?.principal?.()))) return run();
        // what could not be read comes with the rows (a family and why, in words with the fix), so "nothing" is never mistaken for "nothing there"
        return asked
          .demand()
          .then(run)
          .then((answer) => {
            const notes = asked.notes?.() ?? [];
            return notes.length > 0 ? { ...answer, native: { notes } } : answer;
          });
      },
      /**
       * Starts telling this connection of each change to a chat's row (`{ event: 'chats', seq, op, kind, chat }`, a chat it may not see never). A client takes the answer's `at` as the numbering of the list it reads next: events after that are news, the list itself is only a baseline. A second watch replaces the first.
       * @param {{ native?: true }} p @param {unknown} _kind @param {unknown} who @param {(message: object) => unknown} emit @param {Set<() => void>} ends what ends with the connection
       */
      'host.chats.watch': async (p, _kind, who, emit, ends) => {
        if (!list || !chatIndex) throw new UnsupportedError('This host keeps no chats to list.');
        await chatIndex.ready();
        const before = watching.get(ends);
        if (before) before.stop(), ends.delete(before.stop);
        const resting = consumerStops.get(ends);
        if (resting) resting(), ends.delete(resting), consumerStops.delete(ends);
        const watch = chatIndex.watch(emit, chatScopeOf(chatVisible)(who), { native: !!native && p.native === true });
        watching.set(ends, watch);
        ends.add(watch.stop);
        // while a client that may see native rows listens, the discoverers keep them current; when it ends they rest
        if (native && p.native === true && mayList(/** @type {any} */ (who)?.principal?.()) && consumer) {
          const stop = consumer.watching();
          consumerStops.set(ends, stop);
          ends.add(stop);
        }
        return { watching: true, at: watch.at, generation: watch.generation };
      },
    },
  };
};
