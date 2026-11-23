// A chat on a machine the phone reaches directly, as Thread reads it (X4): the Host's frames folded into the follow feed (shared/remote/phoneChats.mjs), and the phone's own outbox that takes a message to the Host with one key however many tries it needs. `facade` is the runtime Thread is given while the Mac is away.
import { appChatId, appIdPrefix, isHostFamily } from '../../../shared/host/chatIds.mjs';
import { createPhoneChats } from '../../../shared/remote/phoneChats.mjs';
import type { createPhoneHosts } from '../../../shared/remote/phoneHosts.mjs';
import type { MobileRuntime } from '../contracts';
import { createOutbox, sendActions, sendLost, type QueuedSend } from '../outbox';
import { CARD_ANSWERED } from '../../../shared/remote/cardAnswered.mjs';
import { answeredState, failureState, type createCardStore, type ShownCard } from './hostCards';
import { FORM_CHOICES, formCard, formContent, formOf } from './hostForm';
import { hostControls } from './hostControls';
import { createHostSync } from './hostSync';
import { createStartedChats, type StartedStore } from './startedChats';

type Phones = ReturnType<typeof createPhoneHosts>;
// biome-ignore lint/suspicious/noExplicitAny: feed events are the Thread's own loose records (presentation/thread.ts)
type FeedEvent = any;

/**
 * A send that did not reach the machine, or whose answer did not come back, and may be sent again under its key. The outbox reads an error that carries a
 * code as the machine's own answer, so a lost path is thrown as the connection closing, which it sends again.
 */
const reachFailure = (error: unknown) => {
  const code = (error as { code?: string } | null)?.code;
  return code === 'unreachable' || code === 'timeout';
};

export const MACHINE_AWAY = (name: string) => `Will send when ${name} is back`;

/** The cards a Host waits on in one chat, as the Thread's own card rows: a permission is answered from the thread; a question or a link is finished on the machine. */
/** A card as the Thread's card rows read it (components/RequestCard.tsx `CardData`, which the pure parts of the phone do not import). */
export type ThreadCard = {
  id: string;
  rev: number;
  title: string;
  detail: string;
  kind: string;
  where: 'phone' | 'mac-only';
  waitingCopy?: string;
  choices: { key: string; label: string; deny?: boolean }[];
  /** A form card's questions and plain fields, as the thread's question card reads them. */
  questions?: { id: string; question: string; options: { label: string }[]; multiSelect: boolean; isOther: boolean }[];
  schema?: { properties: Record<string, { title: string; description?: string; type: string }> };
};

export function threadCards(shown: ShownCard[], chatId: string, machineName: string): ThreadCard[] {
  return shown
    .filter((c) => (c.card.chatId === chatId || appChatId(c.card.chatId) === chatId) && c.state.kind !== 'closed')
    .map((c) => {
      // a question the Host asked as a form is answered here, as the form; a link, or a question with no form the phone can read, is finished on the machine
      const form = c.card.cardKind === 'question' ? formOf(c.card.form) : null;
      const answerable = c.card.cardKind === 'permission' || !!form;
      return {
        id: c.id,
        rev: 0,
        title: c.card.summary.line,
        detail: c.card.summary.tool,
        kind: c.card.cardKind,
        where: answerable ? ('phone' as const) : ('mac-only' as const),
        viaMachine: true as const,
        ...(answerable ? {} : { waitingCopy: `Answer this on ${machineName}.` }),
        ...(form ? formCard(form) : {}),
        choices: form
          ? FORM_CHOICES
          : c.card.options.map((o) => ({ key: o.optionId, label: o.name, ...(o.kind === 'deny' ? { deny: true } : {}) })),
      };
    });
}

/** A random id of 32 hex digits as a version-4 UUID (Claude Code refuses a session id that is not one). */
export const uuidOf = (hex: string) =>
  `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${'89ab'[hex.charCodeAt(16) % 4]}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;

/** What a chat is called until the machine names it. */
const titleOf = (text: string) => text.trim().split('\n')[0].slice(0, 80);

export type { StartedChat } from './startedChats';

export function createHostChatKit(o: {
  /** Whether machine chats go through the machine itself (hostChatFlag.ts, the `host.phoneChat` flag's phone side); off by default. */
  enabled?: () => boolean;
  /** Where the switch comes from, for Settings › About. */
  why?: () => string;
  /** The Mac told its `host.phoneChat` flag (machine.hello). */
  told?: (on: boolean, mac?: string) => void;
  /** The machines' sessions; read when used, since the sessions' own events come to this kit. */
  phones: () => Phones;
  cards: ReturnType<typeof createCardStore>;
  newId: () => string;
  now?: () => number;
  changed: () => void;
  /** Where the chats the phone started are kept between runs (the sealed vault): by machine, what the Host took. */
  store?: StartedStore;
  /** Runs `fn` after `ms` and says how to cancel it (the clock the phone asks a Host again for titles by). */
  later?: (fn: () => void, ms: number) => () => void;
}) {
  const feed = new Set<(event: FeedEvent) => void>();
  // a card raised or closed while a chat is open: the machine's cards are read again, one read at a time and one more after it if another change came meanwhile
  const reading = new Set<string>();
  const again = new Set<string>();
  const cardsMoved = (machineId: string) => {
    if (reading.has(machineId)) return void again.add(machineId);
    reading.add(machineId);
    void o
      .phones()
      .refresh(machineId)
      .catch(() => undefined)
      .finally(() => {
        reading.delete(machineId);
        if (again.delete(machineId)) cardsMoved(machineId);
      });
  };
  const chats = createPhoneChats({
    host: (machineId: string) => o.phones().session(machineId),
    hostKeyOf: (machineId: string) => o.phones().hostKeyOf(machineId),
    emit: (chatId: string, event: FeedEvent) => feed.forEach((fn) => fn({ ...event, chatId })),
    cardsMoved,
  });
  const clock = o.now ?? Date.now;
  const started = createStartedChats({ store: o.store });
  const runs = new Map<string, () => void>();
  /** The chats being started, as the messages they begin with: shown from the tap, gone once the machine took them, Not sent if it did not. */
  const starts = new Map<string, QueuedSend>();
  let queued: QueuedSend[] = [];
  const outbox = createOutbox({
    online: (machineId) => o.phones().enrolled(machineId) && o.phones().reachable(machineId) !== false,
    ready: async () => true,
    // the Host answers a repeated key once
    idempotent: () => true,
    send: async (item) => {
      try {
        return await chats.send(item.pairId, { chatId: item.chatId, text: item.text, sendId: item.id });
      } catch (error) {
        throw reachFailure(error) ? new Error('Connection closed') : error;
      }
    },
    lost: sendLost,
    newId: o.newId,
    now: clock,
    onChange: (items) => {
      queued = items;
      o.changed();
    },
  });
  const hostSync = createHostSync({
    session: (machineId) => o.phones().session(machineId),
    enrolled: (machineId) => o.phones().enrolled(machineId),
    started,
    starting: () => new Set([...starts.values()].map((i) => i.chatId)),
    clock,
    changed: o.changed,
    later: o.later,
  });
  return {
    chats,
    outbox,
    items: () => [...queued, ...starts.values()],
    /** Tries the queued messages of a machine again (the path came back). */
    flush(machineId: string) {
      if (queued.some((i) => i.pairId === machineId)) void outbox.flush(machineId);
    },
    /**
     * Names a new chat for an agent the way the Mac names one (`acp:host-claude:<uuid>`), once: asking again with the same result is the same chat,
     * so a start whose answer was lost does not make a second chat.
     */
    begin: (harness: string) => ({ chatId: `${appIdPrefix(harness)}${uuidOf(o.newId())}`, startId: o.newId(), harness }),
    /** Starts the chat on the machine itself with its first message; the chat is then known as one that runs there. @param {string} machineId */
    async start(machineId: string, begun: { chatId: string; startId: string; harness: string }, input: { text: string; cwd?: string }) {
      await chats.start(machineId, {
        chatId: begun.chatId,
        startId: begun.startId,
        harness: isHostFamily(begun.harness) ? begun.harness : `acp:${begun.harness}`,
        text: input.text,
        human: true,
        ...(input.cwd ? { cwd: input.cwd } : {}),
      });
      started.set(begun.chatId, {
        chatId: begun.chatId,
        machineId,
        title: titleOf(input.text),
        at: clock(),
        harness: isHostFamily(begun.harness) ? begun.harness : `acp:${begun.harness}`,
      });
      started.keep(machineId);
      o.changed();
      return begun.chatId;
    },
    /**
     * Starts the chat and returns at once: its first message shows in the chat from now as sending, and the machine's answer settles it (gone when
     * it took it, Not sent with the reason and Retry when it did not; a retry is the same start, under the same key).
     * @param {string} machineId
     */
    launch(machineId: string, begun: { chatId: string; startId: string; harness: string }, input: { text: string; cwd?: string }) {
      const item: QueuedSend = {
        id: begun.startId,
        pairId: machineId,
        chatId: begun.chatId,
        text: input.text,
        attachments: [],
        at: clock(),
        status: 'sending',
        error: null,
      };
      const run = () => {
        starts.set(item.id, { ...item, status: 'sending', error: null });
        o.changed();
        // a start that fails is the message's own state: it is read from the list, not thrown
        this.start(machineId, begun, input)
          .then(
            () => void starts.delete(item.id),
            (error: unknown) =>
              void starts.set(item.id, {
                ...item,
                status: 'failed',
                error: error instanceof Error ? error.message : String(error),
                attempted: true,
              }),
          )
          .finally(() => o.changed());
      };
      started.set(begun.chatId, {
        chatId: begun.chatId,
        machineId,
        title: titleOf(input.text),
        at: clock(),
        harness: isHostFamily(begun.harness) ? begun.harness : `acp:${begun.harness}`,
      });
      runs.set(item.id, run);
      run();
      return begun.chatId;
    },
    starts: {
      /** Sends a start the machine did not take again. @param {string} id */
      retry(id: string) {
        if (starts.get(id)?.status !== 'failed') return false;
        runs.get(id)?.();
        return true;
      },
      /** Drops a start the machine did not take. @param {string} id */
      cancel(id: string) {
        if (starts.get(id)?.status !== 'failed') return false;
        starts.delete(id);
        o.changed();
        return true;
      },
    },
    /** What a chat the phone started is called until the machine names it: the first line of what it was asked. @param {string} chatId */
    titleOf: (chatId: string) => started.get(chatId)?.title,
    /** The agent a chat the phone started runs on, by the name the wire moves a chat with. @param {string} chatId */
    harnessOf: (chatId: string) => started.get(chatId)?.harness,
    /** The agent each chat moves to with its next message, and the permission mode this phone last set: the Host holds both and tells the phone only when asked, so they outlive the screen that set them. */
    held: { moving: new Map<string, string>(), permits: new Map<string, string>() },
    /** A fresh id, for a tap that must be one request however often it is tried. */
    newId: o.newId,
    /** The machine a chat the phone started runs on, if it did. @param {string} chatId */
    hostOf: (chatId: string) => started.get(chatId)?.machineId,
    /** The chats the phone started on a machine, newest first. @param {string} machineId */
    startedOn: started.on,
    /** Direct access to a machine was given up: the chats this phone started on it are not its any more. @param {string} machineId */
    forgetStarted(machineId: string) {
      hostSync.cancel(machineId);
      started.forget(machineId);
    },
    /** Reads the Host's own list of its chats for a machine (see hostSync.ts); says whether the Host answered. @param {string} machineId */
    sync: hostSync.sync,
    /** Puts back the chats this phone started before the app closed, for the machines it is still enrolled with. @param {string[]} machineIds */
    async restore(machineIds: string[]) {
      await started.restore(machineIds);
      o.changed();
    },
    cards: o.cards,
    /** Whether machine chats go through the machine itself: the flag's phone side. */
    enabled: o.enabled ?? (() => false),
    /** Why the switch is as it is: 'saved' (an override), 'build', 'mac' or 'off'. */
    why: o.why ?? (() => 'off'),
    told: o.told ?? (() => undefined),
    onFeed(fn: (event: FeedEvent) => void) {
      feed.add(fn);
      return () => void feed.delete(fn);
    },
  };
}

export type HostChatKit = ReturnType<typeof createHostChatKit>;

/**
 * Whether a chat is one the machine holds: this phone started it there, a message of this phone's is still waiting for or refused by the machine, or
 * the machine holds a card that waits on it (a chat some other client started on it, which the Mac need not know). Such a chat is read and written
 * through the machine whatever the Mac does, since its card is only there.
 */
export const heldByMachine = (
  kit:
    | {
        hostOf(chatId: string): string | undefined;
        items(): { pairId: string; chatId: string }[];
        cards: { list(): { state: { kind: string }; card: { chatId: string } }[] };
      }
    | undefined,
  machineId: string | undefined,
  chatId: string | undefined,
): boolean =>
  !!kit &&
  !!machineId &&
  !!chatId &&
  (kit.hostOf(chatId) === machineId ||
    kit.items().some((i) => i.pairId === machineId && i.chatId === chatId) ||
    kit.cards.list().some((c) => c.state.kind === 'waiting' && (c.card.chatId === chatId || appChatId(c.card.chatId) === chatId)));

/** Whether this chat is read and written through the machine itself right now: the switch is on, the phone is enrolled with the machine, and the Mac is away (or the machine holds the chat, `heldByMachine`). */
export const goesDirect = (o: {
  on: boolean;
  kit: HostChatKit | null | undefined;
  machineId?: string;
  phones?: Phones;
  macAway: boolean;
}) => o.on && !!o.kit && !!o.machineId && !!o.phones?.enrolled(o.machineId) && o.macAway;

/** The messages of one chat that wait in the phone's own outbox for the machine, or were refused by it: what Thread shows beside the Mac's queue, so a message never vanishes. */
export const kitQueued = (kit: HostChatKit, machineId: string, chatId: string): QueuedSend[] =>
  kit.items().filter((i) => i.pairId === machineId && i.chatId === chatId);

/** What a message waiting for the machine says under it: the machine's name, not the Mac's. */
export const machineQueuedLine = (direct: NonNullable<MobileRuntime['direct']>, machineId: string) =>
  MACHINE_AWAY(direct.phones.records().find((r) => r.machineId === machineId)?.name ?? 'the machine');

/** Changes and Terminal are the Mac's screens, which read the chat from the Mac: a chat only the machine holds (the phone started it there) has neither. */
export function macScreens(
  base: MobileRuntime,
  hostId: string | undefined,
  chatId: string,
  screens: { review?: () => void; terminal?: () => void },
): { review?: () => void; terminal?: () => void } {
  return hostId && base.direct?.chat.hostOf(chatId) === hostId ? {} : screens;
}

/** What a request for a chat only the machine holds answers while the phone has no call for it: no surface, else a refusal in the machine's name that greys the control. */
function machineOnly(method: string, machineName: string): Promise<unknown> {
  if (method === 'surface.current') return Promise.resolve({});
  return Promise.reject(
    Object.assign(new Error(`This is not offered for chats on ${machineName} from the phone yet.`), { code: 'unsupported' }),
  );
}

/** The runtime Thread is given for a machine's chat: the reads and writes of the chat go to the Host, anything else to the runtime it wraps. */
export function facade(base: MobileRuntime, kit: HostChatKit, machineId: string, machineName: string, phones: Phones): MobileRuntime {
  let rev = 0;
  /** The agent each chat moves to with its next message, and the permission mode this phone last set: the Host holds both, and tells the phone only when it is asked. */
  const { moving, permits } = kit.held;
  const cardsOf = (chatId: string) => threadCards(kit.cards.list(), chatId, machineName);
  return {
    ...base,
    get direct() {
      return base.direct;
    },
    snapshot() {
      const snap = base.snapshot();
      return { ...snap, outbox: [...snap.outbox, ...kit.items().filter((i) => i.pairId === machineId)] };
    },
    subscribe: (fn) => base.subscribe(fn),
    onEvent(fn) {
      const own = kit.onFeed(fn as (event: FeedEvent) => void);
      const mac = base.onEvent(fn);
      // a card the Host raises or closes reaches the chat the card belongs to
      const cards = kit.cards.subscribe(() => {
        for (const chatId of kit.chats.followed()) {
          (fn as (event: FeedEvent) => void)({ ev: 'cards.changed', chatId, rev, cards: cardsOf(chatId) });
        }
      });
      return () => {
        own();
        mac();
        cards();
      };
    },
    async request(method, params) {
      const chatId = String((params as { chatId?: unknown }).chatId);
      switch (method) {
        case 'chat.follow': {
          // what the Host waits on is read first, so a card that is up shows with the chat
          await phones.refresh(machineId);
          const snap = await kit.chats.follow(machineId, chatId);
          rev = snap.rev;
          return { ...snap, session: { ...snap.session, cards: cardsOf(chatId) } };
        }
        case 'card.answer': {
          const { cardId, key, values } = params as { cardId: string; key: string; values?: Record<string, unknown> };
          // a question the Host asked as a form is answered as that form: Skip cancels it, Send accepts the values the person gave
          const form = formOf(kit.cards.list().find((c) => c.id === cardId)?.card.form);
          const answer = form
            ? key === 'cancel'
              ? { action: 'cancel' }
              : { action: 'accept', content: formContent(form, values ?? {}) }
            : undefined;
          let failed: { code?: string; message?: string } | null = null;
          await phones.answer(
            machineId,
            machineName,
            cardId,
            key,
            (error, name, optionId) => ((failed = error), failureState(error, name, optionId)),
            (kind) => answeredState(kind, null),
            answer,
          );
          if (failed)
            throw new Error(
              (failed as { code?: string }).code === 'card_answered' ? CARD_ANSWERED : String((failed as { message?: string }).message),
            );
          return { answered: true };
        }
        case 'chat.unfollow':
          return kit.chats.unfollow(chatId);
        case 'chat.stop':
          return kit.chats.stop(machineId, chatId);
        case 'chat.read':
          // the Host's history is read whole when the chat opens: there is no older page to ask for
          return { rows: [], more: false, omitted: 0 };
        // the controls of a chat only the machine holds come from the machine: its agents, the agent the chat moves to, the permission mode
        case 'options.get': {
          if (kit.hostOf(chatId) !== machineId) return base.request(method, params);
          // a switch the Host has settled (its journal says so) is no longer held: the chat runs on the agent it moved to
          const running = kit.chats.agentOf(chatId) ?? kit.harnessOf(chatId);
          if (moving.get(chatId) === running) moving.delete(chatId);
          return hostControls({
            machineName,
            agents: phones.agents(machineId) as never,
            current: running,
            pending: moving.get(chatId),
            permission: permits.get(chatId),
          });
        }
        case 'chat.switch': {
          if (kit.hostOf(chatId) !== machineId) return base.request(method, params);
          const { harness } = params as { harness: string };
          const done = (await kit.chats.switchTo(machineId, chatId, kit.newId(), { harness })) as { pending?: { harness?: string } | null };
          // the chat's own agent takes an earlier choice back; any other is held until its next message
          if (done?.pending?.harness) moving.set(chatId, done.pending.harness);
          else moving.delete(chatId);
          return done;
        }
        case 'options.set': {
          if (kit.hostOf(chatId) !== machineId) return base.request(method, params);
          const { value } = params as { value?: string };
          // only the permission mode is the Host's to set from the phone; its models are not listed to it yet
          if (typeof value !== 'string') return machineOnly(method, machineName);
          const done = await kit.chats.permit(machineId, chatId, kit.newId(), value);
          permits.set(chatId, value);
          return done;
        }
        default:
          // a chat only the machine holds (this phone started it there) is unknown to the Mac, which answers gone, forbidden or, from a stand-in, another chat's settings
          if (kit.hostOf(chatId) === machineId) return machineOnly(method, machineName);
          return base.request(method, params);
      }
    },
    send(chatId, text, attachments = [], _skills = [], _momo, pictures = []) {
      if (attachments.length || pictures.length) throw new Error(`Pictures and files are not sent to ${machineName} from the phone yet.`);
      return kit.outbox.add({ pairId: machineId, chatId, text, attachments: [] });
    },
    cancelSend: (id) => kit.starts.cancel(id) || kit.outbox.cancel(id) || base.cancelSend(id),
    editSend: (id, text) => kit.outbox.edit(id, text) || base.editSend(id, text),
    retrySend: (id) => kit.starts.retry(id) || kit.outbox.retry(id) || base.retrySend(id),
  };
}

export { sendActions };
