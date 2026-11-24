// MoMo's tasks on this Host (#5474 "Gets it done", shared/momoTasks): the ledger sealed under the home's storage, sessions started on this machine's agents, the single result card owed to the MoMo chat, the read-only done_means check, restart recovery that never runs anything again by itself, and the view the clients draw. Everything acts only while this Host is the running home; unprompted tasks are held read-only and every MoMo action of a task goes through the gate with the task's origin.
import crypto from 'node:crypto';
import { createTaskManager } from '../../../shared/momoTasks/manager.ts';
import { isUnprompted } from '../../../shared/momoTasks/brief.ts';
import { WatchRetryError } from '../../../shared/momoTasks/watch.ts';
import { createItemStore } from '../../../shared/momoTasks/store.ts';
import { fixId as viewFixId, parseFixId, taskView } from '../../../shared/momoTasks/view.ts';
import { HostRefusal } from '../hostFs.mjs';
import { requireHome } from '../momoHomeGuard.mjs';
import { IntentError } from '../../../shared/momoHomeApi.mjs';
import { TaskRefusal } from '../../../shared/momoTasks/core.ts';
import { createLocalMachine } from '../momoTasks/localMachine.mjs';
import { hostLinkOn } from '../hostLinkFlag.mjs';
import { createHomeKey } from '../momoTasks/homeKey.mjs';
import { createHomeMachines } from '../momoTasks/homeMachines.mjs';
import { createHomeClient } from '../momoTasks/homeClient.mjs';
import { createRemoteMachine, agentsFromStatus } from '../momoTasks/remoteMachine.mjs';
import { createMachineRouter } from '../momoTasks/router.mjs';
import { createStartKeys, createTaskEnds, createTasksSeam } from '../momoTasks/seam.mjs';
import { agentLabel } from '../../../shared/host/agentReadiness.mjs';
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

/** @param {{ home: any, sessions: any, harnesses?: () => Promise<any[]>, report: (m: string) => void, env?: Record<string, string | undefined>, now?: () => number }} deps */
export default ({ home, sessions, harnesses, report, env, now = Date.now }) => {
  /** @type {TaskBinding | null} */
  let binding = null;
  /** @type {ReturnType<typeof build> | null} */
  let built = null;
  /** How this home reaches the user's other machines (a dialer over the end-to-end relay session); none until the app binds one, and then only machines the owner allowed. @type {{ dial: Parameters<typeof createHomeClient>[0]['dial'] } | null} */
  let hostLink = null;
  /** The machine id of this Host's own home, as last seen. @type {string | undefined} */
  let thisHome;
  /** @type {ReturnType<typeof setInterval>[]} */
  let timers = [];

  /** Other machines are used only while the host-link switch (`momo.hostLink`, default off) is on for this Host. */
  const needLink = () => {
    if (!hostLinkOn(env)) throw new HostRefusal('home_not_allowed', 'MoMo is not set up to use other machines here.');
  };
  /** @template T @param {() => T | Promise<T>} fn @returns {Promise<T>} */
  const whileHome = async (fn) => {
    requireHome(home);
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
      agents: async () => agentsFromStatus(await harnesses(), 'this machine'),
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
    /** Tells the manager how a session ended or what it waits on, while this Host is the running home; a task that ended is no longer followed. @param {{ untrack: (chatId: string, machineId?: string) => void }} machine */
    const emitFor =
      (machine) =>
      async (
        /** @type {string} */ machineId,
        /** @type {string} */ chatId,
        /** @type {import('../../../shared/momoTasks/types.ts').SessionEvent} */ event,
      ) => {
        // how a session ended is kept either way (./localMachine.mjs); while this Host is not the running home the task manager is told nothing, and reads it when the home is back
        if (!home.stamp()) return;
        const item = await /** @type {ReturnType<typeof createTaskManager>} */ (manager).onEvent(machineId, chatId, event);
        if (item && ['done', 'failed', 'stopped'].includes(item.state)) machine.untrack(chatId, machineId);
      };
    /** @type {{ untrack: (chatId: string, machineId?: string) => void }} */
    const tracker = {
      untrack: (chatId, machineId) =>
        machineId && machineId !== home.stamp()?.homeId ? remote.untrack(chatId, machineId) : local.untrack(chatId),
    };
    /** @type {ReturnType<typeof createLocalMachine>} */
    const local = createLocalMachine({
      sessions,
      home,
      workDir,
      keys,
      ends,
      report,
      nameOf: () => home.record()?.name ?? null,
      emit: emitFor(tracker),
    });
    const homeKey = createHomeKey({ dir, safeStorage, now, homeId: () => home.stamp()?.homeId });
    const machines = createHomeMachines({ dir, safeStorage, now });
    const client = createHomeClient({
      identity: () => homeKey.identity(),
      stamp: () => home.stamp(),
      // a link taken away while a machine is being dialled makes it unreachable (the client words that as offline)
      dial: (machine) => /** @type {any} */ (hostLink).dial(machine),
    });
    const remote = createRemoteMachine({ client, machines, keys, ends, report, emit: emitFor(tracker) });
    const source = machineSource();
    if (source) local.bind(source);
    /**
     * A card or notice carries what a session on any machine (or a page a watch read) wrote: words from outside, as mail is. The MoMo chat is marked as holding outside content BEFORE the row is written, so nothing said in it changes what MoMo remembers or does without the owner's say; a sink that names no chat, or no gate to mark it with, takes nothing, and the card stays owed.
     * @param {import('../../../shared/momoTasks/types.ts').ChatSink & { chatId?: () => string | null }} chat the sink, as `sink()` found it
     * @param {(chat: import('../../../shared/momoTasks/types.ts').ChatSink) => Promise<void>} post
     */
    const outside = async (chat, post) => {
      const chatId = chat.chatId?.();
      const gate = home.service('gate');
      if (!chatId || !gate) throw new HostRefusal('momo_chat_unavailable', "MoMo's chat or gate isn't set up on this machine yet.");
      await gate.taintFor(chatId).toolResult('outside');
      return post(chat);
    };
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
      machines: createMachineRouter({
        local: local.port(),
        remote: remote.port(),
        // this Host's own machine id, kept when its lease is lost mid-flight so its own sessions are still its own
        localId: () => (thisHome = home.stamp()?.homeId ?? thisHome),
      }),
      home: async () => ({
        machineId: /** @type {{ homeId: string }} */ (home.stamp()).homeId,
        harness: binding?.defaultHarness ?? 'claude',
      }),
      check: { ask: (prompt, data) => (binding?.check ? binding.check.ask(prompt, data) : unbound("MoMo's reading of results")) },
      chat: {
        postResult: async (card) => outside(await sink(), (chat) => chat.postResult(card)),
        postWatchChanged: async (notice) => outside(await sink(), (chat) => chat.postWatchChanged(notice)),
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
    return { store, manager, local, remote, homeKey, machines, client, keys, ends };
  }
  const ensure = () => (built ??= build());

  /** The run origin the approval gate reads for a chat: a task's chat is `task`, or `unprompted` when nobody asked for it; any other chat is not ours. @param {string} chatId */
  async function originOf(chatId) {
    const items = await ensure().store.list();
    const item = items.find((i) => i.where.sessionId === chatId);
    if (!item) return null;
    return isUnprompted(item) ? 'unprompted' : 'task';
  }

  /** A key that came with a move is replaced by one of this home's own before it is read, and every machine then waits for the owner's device. */
  const rotated = async () => {
    const { homeKey, machines } = ensure();
    if (await homeKey.rotateIfMoved()) await machines.needAllowAll();
  };

  const api = {
    /** Hands over how this home reaches the user's other machines; none turns other machines off again. @param {typeof hostLink} link */
    bindHostLink(link) {
      if (link) needLink();
      hostLink = link;
    },
    /** MoMo's public key, which the owner's app registers on a machine (`host.clientAdd`, kind `home`) when the owner allows it. */
    homeKey: () =>
      whileHome(() => {
        needLink();
        return rotated().then(() => ensure().homeKey.publicKey());
      }),
    /** The owner allowed MoMo to use a machine (the app registered the key there, and pinned the machine's Host id); it is listed and used from now on. @param {import('../momoTasks/homeMachines.mjs').HomeMachine} machine */
    allowMachine: (machine) =>
      whileHome(() => {
        needLink();
        return ensure().machines.set(machine);
      }),
    /** The owner took MoMo's standing from a machine (or the machine was removed): it is no longer used. @param {string} id */
    disallowMachine: (id) => whileHome(() => ensure().machines.remove(id)),
    /**
     * What the owner's device does when MoMo's home moved (the move's acknowledgement): this home made a key of its own, so for each machine listed it registers `publicKey` (`host.clientAdd`, kind `home`) and removes every `retired` key by its fingerprint (`host.clientRemove`), then calls `keyRegistered(machine.id)`; one that cannot be reached stays "Allow again".
     */
    keyContract: () =>
      whileHome(async () => {
        needLink();
        await rotated();
        const { homeKey, machines } = ensure();
        const retired = await homeKey.retired();
        return {
          publicKey: await homeKey.publicKey(),
          // what the owner's device tells each machine this key succeeds (`host.clientAdd`'s `succeeds`): the key the move retired, or the lease nobody holds
          succeeds: retired.at(-1)?.fingerprint ?? 'floor',
          retired,
          machines: machines
            .list()
            .filter((m) => m.needsAllow)
            .map((m) => ({ id: m.id, name: m.name, hostId: m.hostId })),
        };
      }),
    /** The owner's device registered the new key on a machine and removed the retired ones: the machine is used again, and this home tells it its lease now, before any task. @param {string} id */
    keyRegistered: (id) =>
      whileHome(async () => {
        needLink();
        const { machines, client } = ensure();
        await machines.allowed(id);
        const machine = machines.get(id);
        if (machine)
          await client
            .call(machine, 'host.status', {})
            .catch((e) => report(`MoMo could not tell ${machine.name} its lease yet: ${e.message}`));
      }),
    /** Every machine the owner's device cleared of a retired key: it is no longer listed. @param {string} publicKey */
    retiredGone: (publicKey) => whileHome(() => ensure().homeKey.forgetRetired(publicKey)),
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
      requireHome(home);
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
      requireHome(home);
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
      const { manager, store, local, remote } = ensure();
      // MoMo moved here with its key: this home makes its own, and every machine waits for the owner's device to register it (keyContract)
      if (hostLinkOn(env)) await rotated();
      for (const item of await store.list())
        if (item.where.sessionId && (item.state === 'working' || item.state === 'needs_you'))
          (item.where.machineId === home.stamp()?.homeId ? local : remote).track(item.where.sessionId);
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
      // the connections to other machines close and the key leaves memory: a home that moves holds no standing
      if (built) {
        void built.client.close();
        built.homeKey.drop();
      }
    },
    // one non-empty record of everything this service keeps, through its normal paths (the travel test opens each file on a target Host after a real move)
    seed: async () => {
      const { manager, keys, ends, homeKey, machines } = ensure();
      // the home's key and the machines it may use are kept too, and travel (the key is made anew by the home it arrives at)
      await homeKey.publicKey();
      await machines.set({ id: 'seed', name: 'Seed', link: 'seed', hostId: '0'.repeat(32) });
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
        // the sessions on other machines are stopped first, with the key and the connections still here; only then they and the key leave memory
        await built.manager.reset().catch((e) => report(`MoMo tasks reset: ${e.message}`));
        await built.client.close();
        built.homeKey.drop();
      }
      built = null;
    },
  });
  home.provide('tasks', api);
};
