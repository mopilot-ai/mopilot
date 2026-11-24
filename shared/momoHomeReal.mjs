// MoMo's home API over the real Hosts (the Mac's composition; shared/momoHomeFake.mjs is its scripted stand-in): asks every paired machine that can be MoMo's home what it keeps (`host.momoStatus`), believes the one that holds the newest lease (a Host that claims an older one is a home that was moved away from and still answers, so it loses; two that claim the same lease are a conflict no Host wins), composes the view from that with the app's machine list, and serves the intents over the Host's own methods. Where MoMo lives is remembered across restarts, so a home that cannot be asked is shown asleep and a second home can never be chosen beside it. Pure over the ports the caller injects, so the Mac's main process, the phone's channel and the tests (which put real in-process Hosts behind the ports) drive the same rules.
import { createHomeApi, IntentError } from './momoHomeApi.mjs';
import { createIntentRegistry, forwardedIntents } from './momoIntents.mjs';
import { createMoveRunner } from './momoMoveRunner.mjs';
import { composeGoogle } from './momoGoogle/compose.mjs';
import { googleIntents } from './momoGoogle/intents.mjs';
import { homeView } from './momoHomeView.mjs';
import { leaseProblems, lookAtHosts, moveOfStatus } from './momoHomeLook.mjs';
import { createMail } from './momoHomeMail.mjs';
import { createConfirmations } from './momoHomeConfirm.mjs';
import { createChooseHome, createFixes, createMachineAct, createSerial, fitHome, reclaimOf } from './momoHomeFix.mjs';
import { createOlder } from './momoHomeOlder.mjs';
import { createAsk, createSteps, machineSides } from './momoHomeAsk.mjs';
import { createChatOn, createTurns } from './momoHomeTurns.mjs';

/** How long an answer of the Hosts is reused before they are asked again (an intent, and a change a Host tells of, ask at once). */
export const READ_TTL_MS = 5_000;
/** How long one Host may take to say what it keeps: one that hangs is "no answer", never a stalled view. */
export const STATUS_TIMEOUT_MS = 6_000;
/** How long a call that does something (a send, a lane's intent) may take. */
export const CALL_TIMEOUT_MS = 20_000;
/** A burst of machine-row changes (a heartbeat of each machine) is one look. */
export const CHANGE_DEBOUNCE_MS = 1_500;
/**
 * @typedef {import('./momoHomeView.mjs').MachineRecord} MachineRecord
 * @typedef {object} Hosts what the app knows of its machines and how it asks one
 * @property {() => MachineRecord[]} machines the app's machine list in MachineRecord's shape
 * @property {(machineId: string, method: string, params: object, how: { timeoutMs: number }) => Promise<any>} call one request to a machine's Host; a refusal throws with the Host's `code` and its words as the message; a call that takes longer than `timeoutMs` is ended, with whatever it holds open
 * @property {(machineId: string) => Promise<unknown>} [grant] tells that machine's Host that the signed-in account may see MoMo (`host.momoGrant`)
 * @property {(machineId: string) => number | null} [heardAt] when the app last heard from that machine (a heartbeat or an answer), null when never
 * @property {(fn: () => void) => () => void} [onChange] told when a machine's row changed; returns the way to stop
 * @property {(intent: { kind: string, machineId: string, agent?: string }) => Promise<unknown>} [act] what the app itself does for a machine (`update-machine`, `install-agent`, `sign-in-agent`, `set-up-machine`, `wake`); one it does not do throws, and the screen is told why
 * @typedef {import('./momoHomeLook.mjs').HomeNote} HomeNote
 * @typedef {import('./momoHomeLook.mjs').Read} Read
 */

/**
 * @param {object} o
 * @param {Hosts} o.hosts
 * @param {() => number} [o.now]
 * @param {{ read: () => string[], write: (kept: string[]) => void }} [o.kept] the older MoMos the owner chose to keep, kept across runs (they are not told again)
 * @param {{ read: () => number, write: (seen: number) => void }} [o.seen] the highest lease this account has seen on any Host, kept across runs: a new home starts above it
 * @param {{ read: () => HomeNote | null, write: (note: HomeNote | null) => void }} [o.memory] where MoMo was last seen to live, kept across runs (per account)
 * @param {ReturnType<typeof import('./momoOutbox.mjs').createMomoOutbox>} o.outbox this device's outbox for messages to MoMo
 * @param {{ read: () => { id: string, text: string, at: number }[], write: (list: { id: string, text: string, at: number }[]) => void }} o.sent where the messages already sent are kept (sealed, per account)
 * @param {() => string} [o.newId]
 * @param {(error: unknown) => void} o.report told of a failure nobody else is
 * @param {(fn: () => void, ms: number) => unknown} [o.schedule] how a debounce waits (a test's own)
 * @param {(handle: unknown) => void} [o.cancel] how a wait that was scheduled is given up
 * @param {{ status?: number, call?: number }} [o.timeouts] how long a Host may take to say what it keeps, and to do something (a test's own)
 * @param {{ sealer: import('./momoGoogle/seal.mjs').Sealer, startCatcher: () => Promise<import('./momoGoogle/signIn.mjs').Catcher>, client?: 'desktop' | 'ios' }} [o.google] this device's own Google sign-in (its browser catcher): the Google lane is a device lane, so without it those kinds stay pending
 */
export function createRealHome({
  hosts,
  now = Date.now,
  seen: seenMemory,
  kept: keptMemory,
  memory,
  outbox,
  newId = () => crypto.randomUUID(),
  report,
  sent,
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (handle) => clearTimeout(/** @type {any} */ (handle)),
  timeouts = {},
  google,
}) {
  const statusMs = timeouts.status ?? STATUS_TIMEOUT_MS;
  const callMs = timeouts.call ?? CALL_TIMEOUT_MS;
  /** The newest answer of the Hosts that was applied, stale or not. @type {Read | null} */
  let cache = null;
  /** Reads are numbered: only the newest one that finishes writes the cache, and one still running when something changed is not shared with what asks afterwards. */
  let started = 0;
  let applied = 0;
  let epoch = 0;
  /** @type {{ epoch: number, promise: Promise<Read> } | null} */
  let inflight = null;
  /** Where MoMo was last seen to live: seeded from what the last run kept, so a home that cannot be asked is shown asleep, never as a first run. @type {HomeNote | null} */
  let remembered = memory?.read() ?? null;
  /** Hosts that did not answer, and when they are asked again (a hung tunnel is not asked every beat). @type {Map<string, { fails: number, until: number }>} */
  const quiet = new Map();
  /** The rows the home Host holds beyond the chat's words (`host.momoRows`), by id, and where to read from next; reset when the home changes. @type {Map<string, any>} */
  let rows = new Map();
  let rowsNext = 0;
  /** @type {string} */
  let rowsOf = '';
  /** Google's part of the view, from the home's Host, read off the critical path. @type {{ sources: any[], setupGoogle: string } | null} */
  let googlePart = null;
  let sideAt = 0;
  /** @type {Promise<void> | null} */
  let sideRunning = null;
  let listeners = 0;
  let scheduled = false;
  /** @type {unknown} */
  let waiting = null;
  /** False once this composition was stopped: nothing it still has under way writes anything or tells anyone. */
  let alive = true;
  /** Counted up when what was remembered is forgotten: a read or a write that began before is not applied. */
  let gen = 0;
  const live = (/** @type {number} */ g) => alive && g === gen;
  /** Until when the owner's confirmed fresh start lets a home be made though one was remembered: used once, and it lapses. */
  let freshUntil = 0;
  const FRESH_MS = 10 * 60_000;
  /** The highest lease this account has seen on any Host: a home started afresh starts above it, so the old one cannot win when it comes back. */
  let epochSeen = Math.max(0, remembered?.leaseEpoch ?? 0, seenMemory?.read() ?? 0);
  const confirm = createConfirmations({ now, newId });
  /** The steps of the shared rules that were done or refused, and the reason the last one was refused (until the Hosts are looked at again). @type {Set<string>} */
  const told = new Set();
  /** @type {string | null} */
  let failure = null;
  /** @type {ReturnType<typeof createHomeApi>} */
  let api;

  /** One call to a Host that gives up: a hung tunnel is "no answer", never a stalled view. @param {string} id @param {string} method @param {object} params @param {number} ms */
  const callWithin = (id, method, params, ms) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(Object.assign(new Error('The machine did not answer in time.'), { code: 'timeout' })), ms);
      Promise.resolve()
        .then(() => hosts.call(id, method, params, { timeoutMs: ms }))
        .then(resolve, reject)
        .finally(() => clearTimeout(t));
    });

  /** The cache is stale from now on and what is running is not shared with the next ask. */
  const invalidate = () => {
    epoch++;
    inflight = null;
    if (cache) cache = { ...cache, at: 0 };
  };

  /** What a Host says of MoMo's home: its look, which needs no live grant (momoHomeAsk.mjs); a lapsed grant is sent again. */
  const askHost = createAsk({
    call: (id, method, params) => callWithin(id, method, params, statusMs),
    grant: hosts.grant,
  });
  /** The lease and stand-down steps the shared rules ask for. */
  const runSteps = createSteps({ call: (id, method, params) => callWithin(id, method, params, callMs), told, report, now });

  /** @param {HomeNote | null} next */
  function remember(next) {
    if (!alive) return;
    remembered = next;
    memory?.write(next);
  }

  /** Asks the Hosts and decides which one is the home (the shared rules). @param {boolean} force */
  function ask(force) {
    return lookAtHosts({
      hosts,
      look: askHost,
      status: (id) => callWithin(id, 'host.momoStatus', {}, statusMs),
      seen: () => epochSeen,
      fresh: () => freshUntil > now(),
      remembered,
      quiet,
      now,
      force,
      report,
    });
  }

  /** The Hosts' answer, reused for a few seconds, shared while one is being asked, and never overwritten by an older one; one that was out when something changed is stale from the start. @param {boolean} [force] */
  async function read(force = false) {
    if (!force && cache && cache.at && now() - cache.at < READ_TTL_MS) return cache;
    if (inflight && inflight.epoch === epoch) return inflight.promise;
    const mine = ++started;
    const g = gen;
    const e0 = epoch;
    const promise = ask(force).then((answer) => {
      const result = e0 === epoch ? answer : { ...answer, at: 0 };
      if (mine > applied && live(g)) {
        applied = mine;
        cache = result;
        if (result.note && JSON.stringify(result.note) !== JSON.stringify(remembered)) remember(result.note);
        if (result.decision.floor > epochSeen) {
          epochSeen = result.decision.floor;
          seenMemory?.write(epochSeen);
        }
        void settle(result);
      }
      return cache ?? result;
    });
    inflight = { epoch, promise };
    const done = () => {
      if (inflight?.promise === promise) inflight = null;
    };
    promise.then(done, done);
    return promise;
  }

  /** What follows an answer that was applied: the steps of the shared rules, the rows and Google off the critical path, and the held messages that may go now. @param {Read} r */
  async function settle(r) {
    const g = gen;
    if (r.decision.steps.length === 0) failure = null;
    else
      void runSteps(r.decision.steps).then((done) => {
        if (!live(g)) return;
        if (done.ran) older.retired(r.decision.replaced);
        if (done.failure) failure = done.failure;
        // the Hosts changed: they are asked again and every client hears it
        if (done.ran || done.failure) {
          invalidate();
          void emitNow();
        }
      });
    if (r.home && r.home.status.home.state === 'running') {
      void refreshSide(r.home);
      void mail.flush(r.home);
    }
  }

  /** Reads what the home Host wrote or changed since last time; a row with an id held replaces it. A Host that does not serve rows (older) leaves the chat as it is. @param {string} machineId @param {string} lease */
  async function readRows(machineId, lease) {
    const g = gen;
    if (lease !== rowsOf) {
      rows = new Map();
      rowsNext = 0;
      rowsOf = lease;
    }
    try {
      const answer = await callWithin(machineId, 'host.momoRows', rowsNext ? { after: rowsNext } : {}, statusMs);
      if (!live(g) || lease !== rowsOf) return;
      for (const row of Array.isArray(answer?.rows) ? answer.rows : []) if (typeof row?.id === 'string') rows.set(row.id, row);
      if (Number.isSafeInteger(answer?.next)) rowsNext = answer.next;
    } catch (error) {
      report(error);
    }
  }

  /** The rows and Google's part, read after the view is answered, then told if they changed. @param {NonNullable<Read['home']>} home */
  function refreshSide(home) {
    if (sideRunning !== null) return sideRunning;
    const gs = gen;
    sideRunning = (async () => {
      try {
        const before = JSON.stringify([[...rows.entries()], googlePart]);
        await readRows(home.machine.id, `${home.status.home.homeId}:${home.status.home.leaseEpoch}`);
        const g = await composeGoogle({ call: (method, params) => callWithin(home.machine.id, method, params, statusMs) });
        if (!live(gs)) return;
        googlePart = { sources: g.sources, setupGoogle: g.setupGoogle };
        sideAt = now();
        if (JSON.stringify([[...rows.entries()], googlePart]) !== before) void emitNow();
      } finally {
        sideRunning = null;
      }
    })();
    return sideRunning;
  }

  /** The chat on the home machine MoMo's turns go to (momoHomeTurns.mjs): the Host starts or finds it; the first agent that can think is the one. */
  const chatOn = createChatOn({ call: callWithin, callMs });

  const mail = createMail({
    outbox,
    now,
    sent,
    send: (machine, params) => callWithin(machine.id, 'chat.send', params, callMs),
    chatOn,
    report,
    alive: () => alive,
    epoch: () => gen,
    lineage: () => (remembered ? [remembered.homeId, ...remembered.lineage] : []),
  });

  /** The Host's rows with this device's own sends that the Host does not hold yet, and a waiting row while MoMo sleeps, oldest first. @param {Read} r */
  function chatRows(r) {
    const held = new Set(rows.keys());
    const mine = mail.rows().filter((x) => !held.has(x.id));
    const asleep = !r.home || r.home.status.home.state !== 'running';
    const waiting = mail.waitingRow(asleep, remembered ? { machineId: remembered.machineId, name: remembered.name } : null);
    return [...rows.values(), ...mine, ...waiting].sort((a, b) => a.at - b.at);
  }

  async function compose() {
    const r = await read();
    // a stale side part is read again behind this answer
    if (r.home && now() - sideAt > READ_TTL_MS) void refreshSide(r.home);
    const status = r.status;
    const stuck = runner.view() ?? moveOfStatus(r);
    const composed = {
      home: homeView({
        status,
        heardAt: r.heardAt,
        now: now(),
        machines: r.machines,
        move: stuck,
        sources: googlePart?.sources ?? [],
        sink: null,
      }),
      rest: {
        chat: chatRows(r),
        problems: [...leaseProblems({ ...r, failure }), ...older.problems(r), ...mail.problems()],
        ...(googlePart ? { setup: { step: 'done', google: googlePart.setupGoogle, notifications: 'unknown' } } : {}),
      },
    };
    return composed;
  }

  const machineSide = machineSides({ machines: () => hosts.machines(), call: callWithin, callMs });
  const runner = createMoveRunner({
    home: () => (cache?.home ? { id: cache.home.machine.id, name: cache.home.machine.name } : null),
    machine: machineSide,
    newId,
    now,
    // a step of the move or its end: the Hosts are asked again and every client hears the fresh view
    changed: () => {
      invalidate();
      void emitNow();
    },
  });

  /** Everyone with a listener hears the fresh view now (a change this device made), without comparing. */
  async function emitNow() {
    if (!listeners || !alive) return;
    try {
      await api.changed();
    } catch (error) {
      report(error);
    }
  }

  /** A call to the machine that is the home now: what the lanes that run on the Host are forwarded over. Goes through a fresh read, never a cache that a move made stale. @param {string} method @param {object} params */
  const callHome = async (method, params) => {
    const home = (await read()).home;
    if (!home) throw new IntentError('MoMo isn’t running anywhere right now.');
    return callWithin(home.machine.id, method, params, callMs);
  };

  const machineAct = createMachineAct({ machines: () => hosts.machines(), act: hosts.act, invalidate, refresh: () => read(true) });

  /** The home's own Host decides what a lease-bound intent may do, and every call here goes through a fresh look: nothing is judged from what was seen before. */
  const running = () => true;

  const turns = createTurns({
    read,
    call: callWithin,
    chatOn,
    mail,
    timeouts: { status: statusMs, call: callMs },
    newId,
  });
  const older = createOlder({
    read,
    invalidate,
    confirm,
    memory: keptMemory,
    run: runSteps,
    call: (id, method, params) => callWithin(id, method, params, callMs),
    machines: () => hosts.machines(),
  });
  const fixes = createFixes({
    read,
    invalidate,
    quiet,
    mail,
    confirm,
    now,
    remembered: () => remembered,
    remember,
    older,
    checkAgain: () => {
      told.clear();
      failure = null;
    },
    startedFresh: () => void (freshUntil = now() + FRESH_MS),
    dropRows: () => {
      rows = new Map();
      rowsNext = 0;
    },
  });
  const chooseHome = createChooseHome({
    machines: () => hosts.machines(),
    read,
    invalidate,
    run: runSteps,
    remembered: () => remembered,
    fresh: { active: () => freshUntil > now(), use: () => void (freshUntil = 0) },
  });
  const one = createSerial();
  const registry = createIntentRegistry({ running });
  registry.register('home', {
    'choose-home': one(chooseHome),
    send: async ({ turnId, text }) => {
      if (!text.trim()) throw new IntentError('Write a message first.');
      const home = (await read(true)).home;
      const running = home?.status.home.state === 'running' ? home : null;
      await mail.take({ turnId, text, home: running, homeId: running?.status.home.homeId ?? remembered?.homeId ?? '' });
    },
    move: one(async ({ toId }) => {
      fitHome(hosts.machines(), toId);
      older.movable(await read(), toId);
      return runner.start(toId);
    }),
    'move-cancel': () => runner.cancel(),
    'move-retry': async () => {
      await read();
      return runner.retry();
    },
    'move-stay': () => runner.stay(),
    'move-ack': () => runner.acknowledge(),
    // the owner's Reclaim: the runner asks the target first; a move this device did not run is found by asking the other machines (momoHomeFix.mjs)
    reclaim: reclaimOf({ read, runner }),
    // wakes the machine MoMo lives on (a closed lid or a stopped cloud machine): what the app does for it, not a Host call
    wake: async () => {
      const r = await read();
      if (r.home?.status.home.state === 'running') throw new IntentError('MoMo is awake.');
      const at = r.home?.machine.id ?? remembered?.machineId;
      if (!at) throw new IntentError('Nothing is asleep.');
      await machineAct('wake')({ machineId: at });
    },
    'update-machine': machineAct('update-machine'),
    'set-up-machine': machineAct('set-up-machine'),
    'install-agent': machineAct('install-agent'),
    'sign-in-agent': machineAct('sign-in-agent'),
    // a fix the view offered (momoHomeFix.mjs); a turn stopped, and what the home says of a message (momoHomeTurns.mjs)
    fix: one(({ id }) => fixes(id)),
    'stop-turn': turns.stop,
    'check-turn': turns.check,
  });

  // every other lane's kinds run on the home's Host (host.momoLaneIntent); they are refused there, in its words, when the home is not running
  for (const [lane, handlers] of Object.entries(forwardedIntents(callHome))) registry.register(/** @type {any} */ (lane), handlers);
  // this device's own sign-in (the browser is here): its kinds are registered only where a device gave its catcher
  if (google)
    registry.register(
      'google',
      googleIntents({ call: callHome, sealer: google.sealer, startCatcher: google.startCatcher, client: google.client ?? 'desktop' }),
    );
  api = createHomeApi({ compose, intents: registry.intents() });
  // who listens: a change is looked at only when a window or a phone is there to hear it, and each one is told only when what it last had is not the view now
  const onChanged = api.onChanged;
  api.onChanged = (fn) => {
    listeners++;
    let last = '';
    const stop = onChanged((payload) => {
      const sig = JSON.stringify([payload.view, payload.movedAwayTo]);
      if (sig === last) return;
      last = sig;
      fn(payload);
    });
    return () => {
      listeners--;
      stop();
    };
  };
  const off = hosts.onChange?.(() => {
    if (!listeners || scheduled || !alive) return;
    scheduled = true;
    waiting = schedule(() => {
      scheduled = false;
      waiting = null;
      emitNow().catch(report);
    }, CHANGE_DEBOUNCE_MS);
  });

  return {
    // the home API every client calls, and `hostCall`: one call to the home's Host, which the phone's Google sign-in relays through (`momo.home.google`)
    api: Object.assign(api, { hostCall: callHome }),
    /** What the one table still has no handler for. */
    pending: () => registry.pending(),
    /** Asks the Hosts again at once, reads the rows and Google, and tells every listener the fresh view. */
    refresh: async () => {
      invalidate();
      const r = await read(true);
      if (r.home) await refreshSide(r.home);
      await api.changed();
    },
    /** Reset MoMo: nothing is remembered of where it lived, and no message is kept; what a look began before it is not applied. */
    forget() {
      gen++;
      remember(null);
      rows = new Map();
      rowsNext = 0;
      mail.forget();
      confirm.clear();
      googlePart = null;
      freshUntil = 0;
      epochSeen = 0;
      seenMemory?.write(0);
      told.clear();
      failure = null;
      older.forget();
      quiet.clear();
      invalidate();
    },
    /** The service stops (sign-out, another account, the flag off): nothing under way writes or tells anyone any more. */
    dispose() {
      alive = false;
      gen++;
      off?.();
      if (waiting) cancel(waiting);
      waiting = null;
      scheduled = false;
      inflight = null;
    },
  };
}
