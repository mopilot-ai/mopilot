// MoMo's tasks on this Host (#5474 "Gets it done", shared/momoTasks): the ledger sealed under the home's storage, sessions started on this machine's agents, the single result card owed to the MoMo chat, the read-only done_means check, restart recovery that never runs anything again by itself, and the view the clients draw. Everything acts only while this Host is the running home; unprompted tasks are held read-only and every MoMo action of a task goes through the gate with the task's origin.
import crypto from 'node:crypto';
import { createTaskManager } from '../../../shared/momoTasks/manager.ts';
import { isUnprompted } from '../../../shared/momoTasks/brief.ts';
import { WatchRetryError } from '../../../shared/momoTasks/watch.ts';
import { createItemStore } from '../../../shared/momoTasks/store.ts';
import { fixId as viewFixId, parseFixId, taskView } from '../../../shared/momoTasks/view.ts';
import { HostRefusal } from '../hostFs.mjs';
import { IntentError } from '../../../shared/momoHomeApi.mjs';
import { TaskRefusal } from '../../../shared/momoTasks/core.ts';
import { createLocalMachine } from '../momoTasks/localMachine.mjs';
import { createStartKeys, createTaskEnds, createTasksSeam } from '../momoTasks/seam.mjs';
import { isHostFamily } from '../../../shared/host/chatIds.mjs';
import { agentLabel, agentsOf } from '../../../shared/host/agentReadiness.mjs';
import { refusalWords } from '../../../shared/host/refusalWords.mjs';
import { turnErrorCode } from '../../../shared/host/turnErrorCode.mjs';

/** How often a working task's chat is looked at for an approval it waits on. */
const POLL_MS = 5_000;
/** How often watches are read and owed cards and notices are delivered again. */
const TICK_MS = 60_000;

/**
 * What the home's wiring gives the tasks beyond the services' own dependencies.
 * @typedef {{
 *   machine?: import('../momoTasks/localMachine.mjs').MachineInfoSource,
 *   defaultHarness?: string,
 *   check?: { ask: (prompt: string, data?: string) => Promise<string> },
 *   chat?: import('../../../shared/momoTasks/types.ts').ChatSink & { chatId?: () => string | null },
 *   offers?: { get: (offerId: string) => { title: string, why: string } | null | Promise<{ title: string, why: string } | null> },
 *   watches?: import('../../../shared/momoTasks/manager.ts').WatchReader,
 * }} TaskBinding
 */

/** @param {{ home: any, sessions: any, harnesses?: () => Promise<any[]>, report: (m: string) => void, now?: () => number }} deps */
export default ({ home, sessions, harnesses, report, now = Date.now }) => {
  /** @type {TaskBinding | null} */
  let binding = null;
  /** @type {ReturnType<typeof build> | null} */
  let built = null;
  /** @type {ReturnType<typeof setInterval>[]} */
  let timers = [];

  const away = () => new HostRefusal('momo_home_away', "MoMo's home is not running on this machine.");
  /** @template T @param {() => T | Promise<T>} fn @returns {Promise<T>} */
  const whileHome = async (fn) => {
    if (!home.stamp()) throw away();
    return fn();
  };

  /**
   * The machine as MoMo's tasks see it: the wiring's own source if it gave one, else this Host's harness status when the home's wiring passes it (`deps.harnesses`), read as agents the way a Remote Run machine row reads them. Basic agents are `acp:<id>`.
   * @returns {import('../momoTasks/localMachine.mjs').MachineInfoSource | null}
   */
  function machineSource() {
    if (binding?.machine?.agents) return binding.machine;
    if (!harnesses) return null;
    return {
      name: binding?.machine?.name,
      outdated: binding?.machine?.outdated,
      installable: binding?.machine?.installable,
      agents: async () =>
        agentsOf(await harnesses(), 'this machine').map((a) => ({
          id: isHostFamily(a.id) ? a.id : `acp:${a.id}`,
          state: a.state,
        })),
    };
  }

  function build() {
    const dir = home.storage.dir;
    const safeStorage = home.data.safeStorage;
    const store = createItemStore(createTasksSeam({ dir, safeStorage, home, now }), { now });
    const keys = createStartKeys({ dir, safeStorage, now });
    const ends = createTaskEnds({ dir, safeStorage, now });
    // each task works in a folder of its own under the home's work folder, not in its storage: a move or Reset never carries or deletes what a task made
    const workDir = home.workDir('tasks');
    /** @type {ReturnType<typeof createTaskManager> | null} */
    let manager = null;
    /** @type {ReturnType<typeof createLocalMachine>} */
    const local = createLocalMachine({
      sessions,
      home,
      workDir,
      keys,
      ends,
      report,
      nameOf: () => home.record()?.name ?? null,
      emit: async (machineId, chatId, event) => {
        // how a session ended is kept either way (./localMachine.mjs); while this Host is not the running home the task manager is told nothing, and reads it when the home is back
        if (!home.stamp()) return;
        const item = await /** @type {ReturnType<typeof createTaskManager>} */ (manager).onEvent(machineId, chatId, event);
        // a task that ended is no longer followed
        if (item && ['done', 'failed', 'stopped'].includes(item.state)) local.untrack(chatId);
      },
    });
    const source = machineSource();
    if (source) local.bind(source);
    const unbound = (/** @type {string} */ what) => Promise.reject(new Error(`${what} is not set up on this machine yet.`));
    // the chat's sink as it is now: not set up, or no MoMo chat to post to yet, refuses; the card stays owed
    const sink = async () => {
      const chat = binding?.chat;
      if (!chat) return unbound('Posting to the MoMo chat');
      if (typeof chat.chatId === 'function' && !chat.chatId())
        throw new HostRefusal('momo_chat_unavailable', "MoMo's chat isn't open yet.");
      return chat;
    };
    manager = createTaskManager({
      store,
      clock: { now },
      // the words of a Remote Run chat, handed in: the task core imports nothing from the Host's tables
      words: { refusalWords, agentLabel, turnErrorCode },
      randomId: () => crypto.randomUUID(),
      machines: local.port(),
      home: async () => ({
        machineId: /** @type {{ homeId: string }} */ (home.stamp()).homeId,
        harness: binding?.defaultHarness ?? 'claude',
      }),
      check: { ask: (prompt, data) => (binding?.check ? binding.check.ask(prompt, data) : unbound("MoMo's reading of results")) },
      chat: {
        postResult: async (card) => (await sink()).postResult(card),
        postWatchChanged: async (notice) => (await sink()).postWatchChanged(notice),
      },
      // read through the binding when asked, so a reader bound after the home started is found; none yet: a tool is refused and a due check waits
      watches: {
        toolIsReadOnly: async (tool) => (binding?.watches ? binding.watches.toolIsReadOnly(tool) : false),
        read: async (watch) => {
          if (!binding?.watches) throw new WatchRetryError('The watch reader is not set up on this machine yet.');
          return binding.watches.read(watch);
        },
      },
    });
    return { store, manager, local, keys, ends };
  }
  const ensure = () => (built ??= build());

  /** The run origin the approval gate reads for a chat: a task's chat is `task`, or `unprompted` when nobody asked for it; any other chat is not ours. @param {string} chatId */
  async function originOf(chatId) {
    const items = await ensure().store.list();
    const item = items.find((i) => i.where.sessionId === chatId);
    if (!item) return null;
    return isUnprompted(item) ? 'unprompted' : 'task';
  }

  const api = {
    /** The clients' intents of this lane, set below. @type {Record<string, (intent: any) => Promise<unknown>>} */
    intents: {},
    /** Hands over what the services' dependencies do not carry: this machine's name and agents, the brain's tool-less reading, the MoMo chat to post cards to, and the watch reader. Called by the home's wiring and by other lanes, any time, each with its own parts. @param {TaskBinding} next */
    bind(next) {
      // merged into what is already bound, so two callers (the home's wiring, the notice lane) never drop each other's parts
      binding = { ...binding, ...Object.fromEntries(Object.entries(next).filter(([, part]) => part !== undefined)) };
      const source = machineSource();
      if (source) built?.local.bind(source);
    },
    /** @param {import('../../../shared/momoTasks/types.ts').CreateInput} input */
    create: (input) => whileHome(() => ensure().manager.create(input)),
    /** @param {import('../../../shared/momoTasks/types.ts').CreateInput & { watch: unknown }} input */
    createWatch: (input) => whileHome(() => ensure().manager.createWatch(input)),
    /** @param {string} id */
    stop: (id) => whileHome(() => ensure().manager.stop(id)),
    /** @param {string} id */
    resume: (id) => whileHome(() => ensure().manager.resume(id)),
    /** Reads the due watches and delivers what is owed now (also on a timer). */
    tickNow: () => whileHome(async () => ({ watches: await ensure().manager.tick(), delivered: await ensure().manager.flushCards() })),
    /** The tasks as the clients draw them (shared/momoView.ts MomoTaskView). */
    async view() {
      if (!home.stamp()) return [];
      const items = await ensure().store.list();
      const id = home.stamp()?.homeId;
      return items.map((item) =>
        taskView(item, (machineId) => (machineId === id ? (binding?.machine?.name ?? home.record()?.name ?? null) : null)),
      );
    },
    /**
     * One tap on a task's fix button. Retry, Start again and Run on a named machine act here; the rest (Install, Sign in, Update, Open the session, Review) are the client's own flows and come back to it by name.
     * @param {string} itemId @param {string} fixId
     */
    async act(itemId, fixId) {
      if (!home.stamp()) throw away();
      const { manager, store } = ensure();
      const item = await store.get(itemId);
      if (!item) throw new TaskRefusal('unknown_item', 'No such task.');
      const { action, machineId, harness } = parseFixId(fixId);
      // Retry and Start again are the client's own fallback for any task that may be started; every other button is one the task's own failure offered
      const own = action === 'retry' || action === 'startAgain';
      if (!(own && !machineId && !harness) && !(item.lastError?.fixes ?? []).some((f) => viewFixId(f) === fixId))
        throw new TaskRefusal('not_offered', 'That is not something this task offers now.');
      if (own) return { done: await manager.retry(itemId) };
      // Run on another machine comes back to the client, which asks which one and sends `task.runElsewhere`: a machine is only ever taken from there, checked against the ones MoMo lists
      return { client: action };
    },
    /**
     * Run a task on another machine, with the agent it already has. The machine is checked against the ones MoMo lists before the task is touched.
     * @param {string} itemId @param {string} machineId
     */
    async runElsewhere(itemId, machineId) {
      if (!home.stamp()) throw away();
      const { manager, store } = ensure();
      const item = await store.get(itemId);
      if (!item) throw new TaskRefusal('unknown_item', 'No such task.');
      return { done: await manager.retry(itemId, { machineId, harness: item.where.harness }) };
    },
    /** Check now on a watch: read it at once, tell a change as usual. @param {string} id */
    checkNow: (id) => whileHome(() => ensure().manager.checkNow(id)),
    /** Snooze a watch for a length of time (ms), counted on this home's clock. @param {string} id @param {number} forMs */
    snooze: (id, forMs) => whileHome(() => ensure().manager.snooze(id, forMs)),
    /** Looks at the working tasks' chats now (also on a timer): one that waits on an approval becomes needs_you. */
    pollNow: () => whileHome(() => ensure().local.poll()),
    /** Delivers the cards and watch notices the chat is owed (also on a timer, and when the home starts). */
    deliver: () => whileHome(() => ensure().manager.flushCards()),
    originOf,
    /**
     * A MoMo action of a task's chat through the gate, under the task's origin: a task nobody asked for can only read, whatever its model says.
     * @param {string} chatId @param {any} input the gate's action request, without origin @param {() => unknown} exec
     */
    async guardedRun(chatId, input, exec) {
      const origin = await originOf(chatId);
      if (!origin) return { refused: true, reason: 'not_a_task' };
      const gate = home.service('gate');
      if (!gate) return { refused: true, reason: 'gate_unavailable' };
      return gate.run({ ...input, chatId, origin }, exec);
    },
  };

  /** A refusal of the tasks or the home is told to the client as what it is; anything else is a failure to report. @param {(intent: any) => Promise<unknown>} run */
  const told = (run) => async (/** @type {any} */ intent) => {
    try {
      return await run(intent);
    } catch (error) {
      if (error instanceof TaskRefusal || error instanceof HostRefusal) throw new IntentError(error.message);
      throw error;
    }
  };
  /**
   * What the clients' intents do (shared/momoIntents.mjs, lane `tasks`): the handlers the home's registry takes, `registry.register('tasks', home.service('tasks').intents)`. Fix buttons go through `act`.
   */
  Object.assign(api.intents, {
    'task.stop': told(({ id }) => api.stop(id)),
    // a watch is a task in the watching state: stopping it is the same stop
    'task.stopWatching': told(({ id }) => api.stop(id)),
    // a button on a result card: its fix id is one the card offered (Retry, Start again, Run on a named machine); the rest are the client's own flows and come back by name
    'task.check': told(({ id }) => api.checkNow(id)),
    'task.snooze': told(({ id, forMs }) => api.snooze(id, forMs)),
    'task.act': told(({ id, fixId }) => api.act(id, fixId)),
    'task.retry': told(({ id }) => api.act(id, 'retry')),
    'task.runElsewhere': told(({ id, machineId }) => api.runElsewhere(id, machineId)),
    // an offer of the brief that the user starts is a task they asked for, from a suggestion
    'brief.start': told(async ({ offerId }) => {
      const offer = await binding?.offers?.get(offerId);
      if (!offer) throw new IntentError('That offer is not there anymore.');
      return api.create({ title: offer.title, doneMeans: offer.why, origin: 'suggestion', userStarted: true });
    }),
  });

  home.use('tasks', {
    start: async () => {
      const { manager, store, local } = ensure();
      for (const item of await store.list())
        if (item.where.sessionId && (item.state === 'working' || item.state === 'needs_you')) local.track(item.where.sessionId);
      local.attach();
      // tasks that were running when the home last stopped: asked about, never started again
      await manager.recover();
      // a failing round is reported and the next one still runs
      const every = (/** @type {() => Promise<unknown>} */ round, /** @type {number} */ ms, /** @type {string} */ what) =>
        timers.push(setInterval(() => void round().catch((e) => report(`MoMo tasks ${what}: ${e.message}`)), ms));
      every(api.pollNow, POLL_MS, 'poll');
      every(api.tickNow, TICK_MS, 'tick');
      for (const t of timers) t.unref?.();
    },
    // paused (a move begins, a Cancel): nothing is written, but the sessions' ends are still kept, so the home finds them when it runs again
    pause: () => {
      for (const t of timers) clearInterval(t);
      timers = [];
    },
    // one non-empty record of everything this service keeps, through its normal paths (the travel test opens each file on a target Host after a real move)
    seed: async () => {
      const { manager, keys, ends } = ensure();
      await manager.createWatch({
        title: 'Seed',
        doneMeans: 'Seed',
        origin: 'matter',
        watch: { kind: 'http', url: 'https://status.example.com/seed', everyMinutes: 60 },
      });
      await keys.set('seed:1', 'seed-chat');
      await ends.set('seed-chat', { kind: 'finished', report: 'seed' });
    },
    // Reset MoMo: the sessions of running tasks are stopped before their ledger is deleted
    wipe: async () => {
      for (const t of timers) clearInterval(t);
      timers = [];
      if (built) {
        built.local.detach();
        await built.manager.reset().catch((e) => report(`MoMo tasks reset: ${e.message}`));
      }
      built = null;
    },
  });
  home.provide('tasks', api);
};
