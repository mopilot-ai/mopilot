// What a paired phone may do with MoMo (electron/remote/methods/momo.cjs): MoMo's main chat and only it, its memory, its open loops, its routines, its brain, a few of its settings and the cards it raises. Memory, routines and the brain go through the handlers the desktop's own windows use (tapped from the IPC registration), so a phone's change is gated, written and broadcast exactly as a window's; the chat is never named by the device, main picks it.
const { RemoteError } = require('./serviceErrors.cjs');
const { readMomoPrefs, MOMO_PROACTIVITY_LIMITS } = require('../../shared/momoPrefs.mjs');
const { acceptSendReceipt } = require('../../shared/sendReceipt.mjs');
const { createChannelRemote } = require('./momoChannelOps.cjs');
/** The approval kind of MoMo's action card (momo/actionAsk.cjs KIND). */
const KIND = 'momoAction';

/** Wraps an ipcMain so every handler registered through it can also be called from main, without an event. */
function tapIpc(/** @type {any} */ ipcMain) {
  /** @type {Map<string, (e: unknown, ...args: any[]) => any>} */
  const handlers = new Map();
  const ipc = new Proxy(ipcMain, {
    get(target, prop) {
      if (prop === 'handle')
        return (/** @type {string} */ channel, /** @type {(e: unknown, ...args: any[]) => any} */ fn) => {
          handlers.set(channel, fn);
          return target.handle(channel, fn);
        };
      if (prop === 'removeHandler')
        return (/** @type {string} */ channel) => {
          handlers.delete(channel);
          return target.removeHandler(channel);
        };
      const v = Reflect.get(target, prop);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return {
    ipc,
    call(/** @type {string} */ channel, /** @type {any[]} */ ...args) {
      const fn = handlers.get(channel);
      if (!fn) throw new RemoteError('failed', 'MoMo is not ready.');
      return fn(null, ...args);
    },
  };
}

/** MoMo's services were not made (yet). */
const notReady = () => {
  throw new RemoteError('failed', 'MoMo is not ready.');
};

/** A refusal a handler gave as a value or a throw, as the phone sees it. */
function refusal(/** @type {any} */ code, /** @type {string} */ message) {
  return new RemoteError(code === 'not_allowed' ? 'forbidden' : 'failed', message || 'MoMo could not do that.');
}

/** The value of a handler that answers `{ value }` or `{ error }` (the chat and routine handlers). */
function valueOf(/** @type {any} */ res) {
  if (res?.error) throw refusal(res.error.code, res.error.message);
  return res?.value;
}

/** The settings a phone may change, each with the prefs.momo key it is saved at (shared/momoPrefs.mjs). */
const PHONE_PREFS = Object.freeze({ paused: 'paused', proactivity: 'routines.proactivity', quietHours: 'routines.quietHours' });
/** What Run now answers while MoMo is paused: a pause holds MoMo's own work, never the user's edits (#3648). */
const PAUSED = 'MoMo is paused. Resume it first.';

/** The settings a phone shows, from prefs.momo as read back (readMomoPrefs). */
function phonePrefsOf(/** @type {ReturnType<typeof readMomoPrefs>} */ s) {
  return {
    paused: s.paused,
    proactivity: s.routines.proactivity,
    quietHours: s.routines.quietHours,
    // what each level allows, from the table MoMo's routines enforce
    levels: Object.entries(MOMO_PROACTIVITY_LIMITS).map(([id, l]) => ({ id, runs: l.runs })),
  };
}

/** What a phone shows of MoMo's settings and identity; a change to any of it tells phones `prefs`. */
const phoneViewKey = (/** @type {unknown} */ momo) => {
  const s = readMomoPrefs(momo);
  return JSON.stringify([s.persona, s.paused, s.routines.proactivity, s.routines.quietHours, s.suggestions]);
};

/** The result of a handler that answers `{ ok, ... }` (the memory handlers). */
function okOf(/** @type {any} */ res) {
  if (!res?.ok) throw refusal(res?.reason, res?.error);
  const { ok: _ok, ...rest } = res;
  return rest;
}

/** A routines handler that throws (the routines IPC): its refusal as the phone sees it. */
async function routinesOf(/** @type {() => any} */ fn) {
  try {
    return await fn();
  } catch (error) {
    throw refusal(/** @type {any} */ (error)?.code, /** @type {any} */ (error)?.message);
  }
}

/**
 * @param {object} o
 * @param {ReturnType<typeof tapIpc>} o.tap the handlers main registered for MoMo's windows
 * @param {{ ensureMainChat: () => Promise<{ chatId: string }>, mainChatId: () => string | null }} o.mainChat ensureMainChat makes it
 *   when there is none; mainChatId only reads it (null before there is one)
 * @param {{ send: (chatId: string, item: object, origin: number | null, wait: true) => Promise<unknown>, stopChat: (chatId: string) => unknown,
 *   state: { get: (chatId: string) => { approvals: any[] } } }} o.controller
 * @param {() => ({ answer: (id: string, result: unknown) => boolean }) | null} o.broker the app's ApprovalBroker
 * @param {() => { tasks: () => any[] } | null} o.routines MoMo's routines service
 * @param {(task: object) => Promise<unknown>} o.runTask runs a scheduled task now, as the scheduler does
 * @param {(approval: object, key: string, agent: string) => object | null} o.answerOf the card's result for a key it offered, or null (capabilities/browser/chromePanelCards.cjs; injected so this module stays out of that layer)
 * @param {() => boolean} o.brainChangeAllowed whether this Mac lets a phone change MoMo's brain (off unless the user turned it on)
 * @param {() => boolean} o.allowed whether MoMo is allowed for the account (momo/access.cjs): settings are read only then
 * @param {() => unknown} o.momoPrefs prefs.momo as saved now
 * @param {(key: string, value: unknown) => { value?: unknown, error?: { code: string, message: string } }} o.setPref one key of
 *   prefs.momo set the way the windows' momoPrefs:set sets it (app/ipc/momoPrefs.cjs)
 * @param {{ chats: any, registry: any, enabled: () => boolean } | null} [o.channels] MoMo's channels (A2, app/momoChannels.cjs): a request may name one with `channelId`
 */
function createMomoRemoteOps({
  tap,
  mainChat,
  controller,
  broker,
  routines,
  runTask,
  answerOf,
  brainChangeAllowed,
  allowed,
  momoPrefs,
  setPref,
  channels = null,
}) {
  const call = (/** @type {string} */ channel, /** @type {any[]} */ ...args) => tap.call(channel, ...args);
  /** MoMo's settings, read only for an account MoMo is allowed for (the service refused first; this is main's own check). */
  const settings = () => {
    if (allowed() !== true) throw refusal('not_allowed', 'MoMo is not available.');
    return readMomoPrefs(momoPrefs());
  };
  /** MoMo's main chat, made when there is none; the only chat a phone reaches here. */
  async function mainChatId() {
    try {
      return (await mainChat.ensureMainChat()).chatId;
    } catch (error) {
      throw refusal(/** @type {any} */ (error)?.code, /** @type {any} */ (error)?.message);
    }
  }
  const channelOps = createChannelRemote({
    call,
    chats: channels?.chats ?? null,
    registry: channels?.registry ?? null,
    enabled: channels?.enabled ?? (() => false),
    allowed,
  });
  /** The journal of the channel a request names (the methods use mainChatId for one that names none), made on first use when `make`; null: the channel has none yet. */
  const chatFor = (/** @type {string} */ channelId, make = true) => channelOps.chatId(channelId, make);
  /** Refuses while MoMo is paused: only for work MoMo starts itself (Run now), as the Mac's runner holds it. */
  const awake = () => {
    if (settings().paused) throw new RemoteError('forbidden', PAUSED);
  };
  return {
    mainChatId,
    chatFor,
    channels: channelOps,
    awake,
    /** Throws unless MoMo is allowed for the account: main's own check for work that touches no MoMo store (a voice note). */
    assertAllowed: () => void settings(),
    /**
     * MoMo's name and color, whether it is paused, and how many of its cards wait for an answer in its main chat and its channels' chats. A status
     * read never makes the main chat: with none yet, nothing waits (only a send or a follow makes it).
     */
    state() {
      const s = settings();
      let chatId;
      try {
        chatId = mainChat.mainChatId();
      } catch (error) {
        throw refusal(/** @type {any} */ (error)?.code, /** @type {any} */ (error)?.message);
      }
      // the cards of main and of every open channel's chat: a card raised in a channel waits there, and counts
      const waiting = (/** @type {string} */ id) => controller.state.get(id).approvals.filter((a) => a.params?.kind === KIND).length;
      const needsYou = [...(chatId ? [chatId] : []), ...channelOps.chatIds()].reduce((n, id) => n + waiting(id), 0);
      // additive: the page shell (`momo.shell`) and its Tasks panel are on, so a phone draws its Chat · Tasks · Files tabs; an older phone ignores both
      return {
        name: s.persona.name,
        color: s.persona.color,
        status: s.paused ? 'paused' : 'online',
        needsYou,
        ...(s.shell ? { shell: true, shellTasks: s.tasksPanel } : {}),
        // additive: suggestions (`momo.suggestions`) are on, so a phone draws Up next's rows and a brief's cards; a Mac that says nothing has none
        ...(s.suggestions ? { suggestions: true } : {}),
      };
    },
    prefs: {
      get: () => phonePrefsOf(settings()),
      /** One setting (the schema let exactly one through), paused or not, as Settings on the Mac. */
      set(/** @type {Record<string, unknown>} */ p) {
        const [key] = Object.keys(p);
        valueOf(setPref(PHONE_PREFS[/** @type {keyof typeof PHONE_PREFS} */ (key)], p[key]));
        return phonePrefsOf(settings());
      },
    },
    async send(
      /** @type {string} */ chatId,
      /** @type {{ id: string, text: string, followUp: string }} */ p,
      /** @type {(() => void) | undefined} */ check = undefined,
      /** @type {(() => void) | undefined} */ admit = undefined,
    ) {
      const item = { id: p.id, text: p.text, attachments: [], opts: { human: true }, followUp: p.followUp };
      settings();
      // MoMo's main chat, or a channel's journal: any other chat is not one a phone reaches here
      if (mainChat.mainChatId() !== chatId && !channelOps.isChannelChat(chatId))
        throw new RemoteError('stale', 'MoMo’s main chat changed. Read it before sending.');
      check?.();
      admit?.();
      const error = acceptSendReceipt(await controller.send(chatId, item, null, true));
      return error ?? null;
    },
    stop: (/** @type {string} */ chatId) => controller.stopChat(chatId),
    /** The momoAction card with this id in the chat, as main holds it, or null. */
    cardOf: (/** @type {string} */ chatId, /** @type {string} */ id) =>
      controller.state.get(chatId).approvals.find((a) => a.id === id && a.params?.kind === KIND) ?? null,
    /** A phone's answer to a card: the sentinel gets it with the answering device's id, which the audit entry records. */
    answerCard(/** @type {any} */ approval, /** @type {string} */ key, /** @type {string} */ device) {
      const result = answerOf(approval, key, 'MoMo');
      if (result == null) throw new RemoteError('invalid', 'Choose an option offered by this request.');
      return !!broker()?.answer(approval.id, { ...result, by: device });
    },
    memory: {
      list: async () => okOf(await call('momoMemory:list', {})),
      search: async (/** @type {string} */ query) => okOf(await call('momoMemory:list', { query })),
      edit: async (/** @type {string} */ factId, /** @type {string} */ text) => okOf(await call('momoMemory:update', factId, { text })),
      forget: async (/** @type {string} */ factId) => okOf(await call('momoMemory:forget', factId)),
      docs: async () => okOf(await call('momoMemory:files')),
      /** The newest changes, each saying whether Undo can still take it back. */
      changes: async () => okOf(await call('momoMemory:changes')),
      /** Undo one change; the store's reason when it refuses (changed since, undone already, gone from the log). */
      undo: async (/** @type {string} */ changeId) => okOf(await call('momoMemory:undo', changeId)),
      /** Facts a newer one replaced, the latest first. */
      past: async () => okOf(await call('momoMemory:past')),
      /** About you, rewritten; MoMo's persona is not the phone's to write. */
      writeAboutYou: async (/** @type {string} */ text) => okOf(await call('momoMemory:writeFile', 'aboutYou', text)),
    },
    loops: {
      list: async () => okOf(await call('momoMemory:loops')),
      /** Done, Dismiss or Snooze a loop, as a nudge card's buttons do on the Mac (momo/loopActs.cjs). */
      act: async (/** @type {string} */ loopId, /** @type {object} */ a) => okOf(await call('momoMemory:loopAct', loopId, a)),
    },
    tasks: {
      /**
       * The Tasks list the Mac derives (momo/tasks.cjs): the cards (main's and every open channel's, each naming its channel), loops and runs, each with
       * its stable id. A phone never names a chat, so the chat a card waits in is the Mac's own and stays out of the answer.
       */
      list: async () => {
        const list = okOf(await call('momoTasks:list'));
        return { ...list, tasks: list.tasks.map(({ chatId: _chat, ...task }) => task) };
      },
      /** The user's mark on a routine run, or the Undo of one (momo/taskMarks.cjs). */
      mark: async (/** @type {string} */ taskId, /** @type {string} */ mark, /** @type {string | undefined} */ undoToken) =>
        okOf(await call('momoTasks:mark', taskId, mark, undoToken)),
    },
    brief: {
      /** Write the morning brief now (momo/briefIpc.cjs); a refusal says why in words. */
      runNow: async () => okOf(await call('momoBrief:runNow')),
    },
    suggestions: {
      /** What MoMo suggested (momo/suggestions.cjs), best first, each with its source line and the inputs of its score. */
      list: async () => okOf(await call('momoSuggestions:list')),
      /** The user's Add, Start or Hide on one: Start sends its first step to MoMo's chat as the user's own message, on the Mac. */
      act: async (/** @type {string} */ id, /** @type {string} */ action) => okOf(await call('momoSuggestions:act', id, action)),
    },
    routines: {
      list: () => routinesOf(() => call('momoRoutines:view')),
      pause: (/** @type {string} */ id) => routinesOf(() => call('momoRoutines:edit', id, { paused: true })),
      resume: (/** @type {string} */ id) => routinesOf(() => call('momoRoutines:edit', id, { paused: false })),
      approve: (/** @type {string} */ id, /** @type {number} */ seen) => routinesOf(() => call('momoRoutines:approve', id, seen)),
      /** Settings' Edit: the store decides what an edit to an approved routine needs. */
      async edit(/** @type {string} */ id, /** @type {object} */ edit) {
        const routine = await routinesOf(() => call('momoRoutines:edit', id, edit));
        if (!routine) throw new RemoteError('gone', "That isn't one of MoMo's routines.");
        return routine;
      },
      /** Remove a routine, or Decline a proposal: one path for both, as in Settings. */
      async remove(/** @type {string} */ id) {
        if (!(await routinesOf(() => call('momoRoutines:remove', id)))) throw new RemoteError('gone', "That isn't one of MoMo's routines.");
      },
      /** Run now: only an approved routine, through the scheduler's own run. */
      async run(/** @type {string} */ id) {
        const view = await routinesOf(() => call('momoRoutines:view'));
        if (!view.routines.some((/** @type {{ id: string }} */ r) => r.id === id))
          throw new RemoteError('gone', "That isn't one of MoMo's routines.");
        const task = routines()
          ?.tasks()
          .find((/** @type {{ id: string }} */ t) => t.id === id);
        if (!task) throw new RemoteError('failed', "MoMo's routines are off. Turn them on from your Mac.");
        await runTask(task);
      },
    },
    sources: {
      /** Whether Calendar and Reminders are connected, from Settings' own list; nothing they hold. */
      status: async () => {
        const { sources } = okOf(await call('momoSources:list'));
        const on = (/** @type {string} */ id) =>
          sources.some((/** @type {{ id: string, connected: boolean }} */ s) => s.id === id && s.connected === true);
        return { calendar: on('calendar'), reminders: on('reminders') };
      },
    },
    brain: {
      get: async () => ({ brain: valueOf(await call('momoChat:brain:get')) }),
      allowedToSet: brainChangeAllowed,
      set: async (/** @type {object} */ brain) => ({ brain: valueOf(await call('momoChat:brain:set', brain)) ?? brain }),
    },
  };
}

/** What MoMo's changes tell paired phones: which part changed, never what (the channel the windows hear it on). */
const CHANGED_AREA = Object.freeze({
  'momoMemory:changed': 'memory',
  'momoRoutines:changed': 'routines',
  'momoSources:changed': 'sources',
  'momoChat:brainChanged': 'brain',
  'momoChannels:changed': 'channels',
});

/**
 * Wiring in main: the ipcMain MoMo registers on (its handlers become callable here) and the broadcast it tells windows
 * with (a change also reaches phones), before MoMo is made; `attach` completes it once it is.
 * @param {{ ipcMain: any, toWindows: (channel: string, payload?: unknown) => void }} o
 */
function wireMomoRemote({ ipcMain, toWindows }) {
  const tap = tapIpc(ipcMain);
  /** @type {(ReturnType<typeof createMomoRemoteOps> & { changed: (area: string) => void, prefsChanged: (prefs: any) => void, activity: { list: () => Promise<unknown> } }) | null} */
  let remote = null;
  /** MoMo's main chat's notes (how many, and the newest) when phones last heard of them: a new one (a nudge) is news for its followers; the first sight is told too (a refetch too many, never one too few). */
  let notesSeen = '';
  return {
    ipc: tap.ipc,
    broadcast(/** @type {string} */ channel, /** @type {any} */ payload) {
      toWindows(channel, payload);
      if (Object.hasOwn(CHANGED_AREA, channel)) remote?.changed(CHANGED_AREA[/** @type {keyof typeof CHANGED_AREA} */ (channel)]);
      // the user's mark on a run (momoTasks:mark) reaches phones as news of the part their Tasks page reads with the loops
      // a suggestion added, started or hidden is news for the same page
      else if (channel === 'momoTasks:marked' || channel === 'momoSuggestions:changed') remote?.changed('memory');
      const meta = channel === 'chats:changed' ? payload?.chat?.meta : null;
      if (meta?.momo === 'main') {
        const list = Array.isArray(meta.notes) ? meta.notes : [];
        const notes = JSON.stringify([list.length, list.at(-1)?.id ?? null]);
        if (notes !== notesSeen) remote?.changed('chat');
        notesSeen = notes;
      }
    },
    /**
     * The operations phones use, once MoMo's services exist (main's `live`); `live.chromePanel`'s service tells the paired
     * phones what changed.
     * @param {{ live: any, mainChat: any, readState: () => any, runAttended: (task: object, o: { unattended: false }) => Promise<unknown>,
     *   allowed: () => boolean, setPref: (key: string, value: unknown) => any }} o allowed: MoMo's access (momo/access.cjs);
     *   setPref: one key of prefs.momo set as the windows' momoPrefs:set does (app/ipc/momoPrefs.cjs); both injected so this layer imports neither
     */
    attach({ live, mainChat, readState, runAttended, allowed, setPref }) {
      const channels = live.momo?.channelsApi;
      let shown = phoneViewKey(readState()?.prefs?.momo);
      remote = {
        ...createMomoRemoteOps({
          tap,
          mainChat,
          controller: live.controller,
          broker: () => live.computerUse?.broker ?? null,
          routines: () => live.momoRoutines ?? null,
          answerOf: (approval, key, agent) => live.chromePanel.service.ops.cardAnswer(approval, key, agent),
          runTask: (task) => runAttended(task, { unattended: false }),
          // off unless the user turned it on from this Mac
          brainChangeAllowed: () => readMomoPrefs(readState()?.prefs?.momo).remote.brainChange,
          allowed,
          momoPrefs: () => readState()?.prefs?.momo,
          setPref,
          channels: channels ? { chats: channels.chats, registry: channels.registry, enabled: channels.enabled } : null,
        }),
        changed: (area) => live.chromePanel?.service.onMomoChanged(area),
        // MoMo's activity list (app/momoActivity.cjs), made with its routines; refused in main too for an account MoMo isn't allowed for
        activity: {
          async list() {
            if (allowed() !== true) throw refusal('not_allowed', 'MoMo is not available.');
            return (live.momoActivity ?? notReady()).list();
          },
        },
        /** A prefs change (any writer's, main.cjs's onPrefs): phones hear `prefs` when what they show of it changed. */
        prefsChanged(/** @type {any} */ prefs) {
          const next = phoneViewKey(prefs?.momo);
          if (next !== shown) remote?.changed('prefs');
          shown = next;
        },
      };
      return remote;
    },
  };
}

module.exports = { createMomoRemoteOps, tapIpc, wireMomoRemote, CHANGED_AREA };
