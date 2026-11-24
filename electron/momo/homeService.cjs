// The Mac's real MoMo home API (shared/momoHomeReal.mjs) over this app's paired machines: maps the machines service's rows to the records the home view reads, asks a machine's Host through one paired session per request, keeps where MoMo lives and the newest lease seen in a file under the app's data folder, keeps the messages not yet delivered sealed with the system key, and holds the result in the home slot for the windows' IPC and the phone channel. Both files belong to one account: another account, or a sign-out, never sees them. Absent unless MoMo is allowed and the `momo.home` flag is on, and it follows the flag turning on late; the scripted home (shared/momoHomeFake.mjs) stays for UI tests and a dev run.
const path = require('node:path');
const { readJson, writeAtomic } = require('../platform/fsutil.cjs');
const { readSecret, writeSecret } = require('../platform/secretFile.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { setHomeApi, getHomeApi } = require('./homeSlot.cjs');
const { LOCAL_HOST_ID } = require('../../shared/host/localMachine.mjs');
const { momoAllowed, onMomoAccess, onMomoState, momoUserId } = require('./access.cjs');
const { createLoopbackCatcher } = require('./googleCatcher.cjs');
const { isEnabled } = require('../platform/flags.cjs');

/**
 * @typedef {object} Machines what the machines service gives this module (electron/host/machines.cjs): the list, a row, a paired session, the row-change watch, and what it does for a machine
 * @property {() => { machines: any[] }} list the machines service's list: `{ machines, resolved }`, never the rows alone
 * @property {(id: string) => any} row
 * @property {(id: string) => Promise<{ call: (method: string, params?: object, opts?: { timeoutMs?: number }) => Promise<any>, close: () => void }>} session
 * @property {(fn: () => void) => () => void} onRowChange
 * @property {() => string} [appBuild] the Host build this app carries
 * @property {(id: string) => Promise<unknown>} [updateHost]
 * @property {(id: string) => Promise<unknown>} [startHost]
 * @property {(id: string, harness: string) => Promise<unknown>} [installAgent]
 * @property {(id: string, harness: string, recoveryKey?: string, openHere?: boolean) => Promise<unknown>} [signIn]
 */

/**
 * What a machine of the real machines service says, in the shape the home view reads (shared/momoHomeView.mjs MachineRecord): its row of the list (status,
 * agents, `hostStale`, `repositoryScope`) and its registry row (the id its Host named itself with, the build it runs, its last heartbeat).
 * Every paired machine can be asked, so none is "not set up" for MoMo here; a machine is out of date when the list says its Host is behind this app.
 * @param {any} row @param {any} reg @param {{ isThisDevice: (row: any) => boolean, needBuild?: string }} o
 */
function machineRecordOf(row, reg, { isThisDevice, needBuild }) {
  const agents = Array.isArray(row.agents) ? row.agents : [];
  const hostId = reg?.hostKey || row.repositoryScope;
  return {
    id: row.id,
    hostId: typeof hostId === 'string' && hostId ? hostId : undefined,
    name: row.name,
    isThisDevice: isThisDevice(row),
    // 'attention' is a machine that answers and needs something done on it: its Host can still be asked
    reachable: row.status !== 'offline',
    current: row.hostStale !== true,
    stays: /** @type {'cloud' | 'on'} */ (row.cloud ? 'cloud' : 'on'),
    setUp: reg ? !!reg.socketPath : true,
    // no Host installed on it: it cannot hold MoMo, which is the one definite "no home" the app knows without asking
    hasHost: reg ? !!reg.socketPath : true,
    agents: agents.map((/** @type {any} */ a) => ({
      id: a.id,
      name: a.label ?? a.name ?? a.id,
      installed: a.state !== 'missing',
      signedIn: a.state === 'ready',
    })),
    hostBuild: reg?.hostBuild || undefined,
    hostAppVersion: reg?.hostAppVersion || undefined,
    hostVersionAt: reg?.lastHeartbeat ?? undefined,
    needBuild,
  };
}

/** The two files this Mac keeps for MoMo's home, under MoMo's folder: where MoMo lives with the newest lease seen (a note, not secret), and the messages not yet delivered (sealed). */
const CLIENT_FILES = Object.freeze({ state: 'home-client.json', outbox: 'outbox.json', sent: 'sent.json' });

/** The running service, so Reset MoMo can make it forget at once. @type {{ forget: () => void } | null} */
let active = null;

/**
 * Reset MoMo: a running home forgets where MoMo lived and drops this account's held and sent messages; and whether or not a home is running, this account's
 * own slot is taken out of each file (so the lease note, the highest epoch seen, the held and the sent messages cannot come back when the home starts later).
 * Another account's slot is left alone. A sealed file that cannot be read is never written over.
 * @param {string} momoDir MoMo's folder (userData/momo) @param {{ account?: string | null, safeStorage?: any }} [who] the signed-in account and the system key
 */
const eraseHomeClient = (momoDir, { account = null, safeStorage } = {}) => {
  active?.forget();
  if (!account) return;
  const state = path.join(momoDir, CLIENT_FILES.state);
  const saved = readJson(state);
  if (saved?.accounts?.[account]) {
    const { [account]: _gone, ...rest } = saved.accounts;
    try {
      writeAtomic(state, JSON.stringify({ accounts: rest }));
    } catch (error) {
      noteIgnored('erase this account’s MoMo home note', error);
    }
  }
  for (const name of [CLIENT_FILES.outbox, CLIENT_FILES.sent]) {
    const file = path.join(momoDir, name);
    try {
      const read = safeStorage ? readSecret(file, safeStorage) : null;
      const body = read ? JSON.parse(read.value) : null;
      if (body?.accounts?.[account]) {
        delete body.accounts[account];
        writeSecret(file, JSON.stringify(body), safeStorage, 'MoMo’s unsent messages');
      }
    } catch (error) {
      noteIgnored('erase this account’s held MoMo messages', error);
    }
  }
};

/**
 * The state file, one slot for each account (so one that comes back finds what it kept), written only while `account()` is still the account this was made
 * for: a service that is being stopped cannot write a home under another account.
 * @param {string} file @param {string} mine @param {() => string | null} account
 */
function stateStore(file, mine, account) {
  const slots = () => {
    const f = readJson(file);
    return f && typeof f.accounts === 'object' && f.accounts ? f.accounts : {};
  };
  return {
    read: () => slots()[mine] ?? {},
    /** @param {object} patch */
    write(patch) {
      if (account() !== mine) return;
      try {
        const all = slots();
        writeAtomic(file, JSON.stringify({ accounts: { ...all, [mine]: { ...all[mine], ...patch } } }));
      } catch (error) {
        noteIgnored('keep MoMo’s home state', error);
      }
    },
  };
}

/**
 * A list kept in a sealed file with one slot for each account: the owner's own words are encrypted with the system key, never written in plain text, and what
 * one account kept is never read by another and is not erased when it signs out (it is there when it signs back in). With no key nothing is kept (the send
 * then says so). A file that cannot be read (sealed with another key, damaged) is never written over: the cause is said instead. A write is made only while
 * `account()` is still the account this was made for.
 * @param {string} file @param {string} mine @param {() => string | null} account @param {any} safe
 */
function sealedList(file, mine, account, safe) {
  /** @type {Error | null} */
  let broken = null;
  /** @returns {Record<string, { entries: any[] }>} */
  const slots = () => {
    try {
      const saved = readSecret(file, safe);
      const body = saved ? JSON.parse(saved.value) : null;
      broken = null;
      return body && typeof body.accounts === 'object' && body.accounts ? body.accounts : {};
    } catch (error) {
      broken = /** @type {Error} */ (error);
      noteIgnored('read MoMo’s unsent messages', error);
      return {};
    }
  };
  return {
    /** @returns {any[]} */
    read: () => slots()[mine]?.entries ?? [],
    /** @param {any[]} entries */
    write(entries) {
      if (account() !== mine) return;
      const all = slots();
      if (broken) throw new Error('MoMo can’t read the messages it kept on this Mac, so it will not write over them.');
      writeSecret(file, JSON.stringify({ accounts: { ...all, [mine]: { entries } } }), safe, 'MoMo’s unsent messages');
    },
  };
}

/** How often each Host is told again that this account may see MoMo (a grant lasts days; this keeps it from lapsing while the app runs). */
const GRANT_EVERY_MS = 30 * 60_000;
/** How long one machine may take to answer a grant. */
const GRANT_WAIT_MS = 6_000;

/**
 * Tells every machine's Host that the signed-in account may see MoMo (`host.momoGrant`, the closed-alpha grant the client asserts for an invited account; the
 * server-signed entitlement replaces it later): without it a Host veils MoMo from this Mac. Sent when the service starts, again every half hour, and when a
 * machine comes back up; a machine that cannot be told now is told with the next look.
 * @param {{ machines: Machines, call: (id: string, method: string, params: object, how: { timeoutMs: number }) => Promise<any>, account: string, refresh: () => Promise<unknown>, now: () => number }} o
 * @returns {() => void} stops it
 */
function keepGranted({ machines, call, account, refresh, now }) {
  /** @type {Map<string, number>} */
  const toldAt = new Map();
  /** A machine that did not take the grant is not asked again at every heartbeat: its failures and when it is asked next (30 s, doubling to 5 min). @type {Map<string, { fails: number, until: number }>} */
  const failed = new Map();
  let busy = false;
  let stopped = false;
  const grantAll = async () => {
    if (busy) return;
    busy = true;
    try {
      const up = machines.list().machines.filter((/** @type {any} */ r) => r.status !== 'offline');
      let any = false;
      await Promise.all(
        up.map(async (/** @type {any} */ r) => {
          if (toldAt.has(r.id) && now() - /** @type {number} */ (toldAt.get(r.id)) < GRANT_EVERY_MS - 60_000) return;
          if ((failed.get(r.id)?.until ?? 0) > now()) return;
          try {
            await call(r.id, 'host.momoGrant', { account, features: ['momo'] }, { timeoutMs: GRANT_WAIT_MS });
            toldAt.set(r.id, now());
            failed.delete(r.id);
            any = true;
          } catch (error) {
            const fails = (failed.get(r.id)?.fails ?? 0) + 1;
            failed.set(r.id, { fails, until: now() + Math.min(300_000, 30_000 * 2 ** (fails - 1)) });
            noteIgnored('tell a machine that MoMo is allowed here', error);
          }
        }),
      );
      // a Host that was veiled has MoMo to say now
      if (any && !stopped) await refresh();
    } finally {
      busy = false;
    }
  };
  void grantAll();
  const timer = setInterval(() => void grantAll(), GRANT_EVERY_MS);
  timer.unref?.();
  const off = machines.onRowChange(() => void grantAll());
  return () => {
    stopped = true;
    clearInterval(timer);
    off();
  };
}

/**
 * Starts the real home over `machines` (the machines service of electron/host/machines.cjs) when MoMo is allowed and the flag is on, and stops it when either
 * goes off; it follows the account (another one starts afresh) and a flag that loads or changes after this was called. Returns the way to stop it.
 * @param {object} o
 * @param {Machines} o.machines
 * @param {string} o.dir the app's data folder
 * @param {() => boolean} o.allowed whether MoMo is allowed for this account
 * @param {() => boolean} o.flagOn the `momo.home` flag
 * @param {() => string | null} [o.account] the signed-in account's id
 * @param {any} [o.safeStorage] Electron's, for the sealed outbox
 * @param {(fn: () => void) => () => void} [o.watch] told when allowed, the account or the flag may have changed
 * @param {(row: any) => boolean} [o.isThisDevice]
 * @param {(url: string) => unknown} [o.openExternal] opens the Google consent page in the system browser; without it Google is not signed in from here
 * @param {(session: { call: (method: string, params?: object) => Promise<any> }, method: string) => Promise<unknown>} o.hello the protocol's hello on a new connection, checked against the request that follows (electron/host/helloFirst.cjs, given by the app)
 * @param {(id: string) => Promise<unknown>} [o.wake] wakes a machine that sleeps (a cloud machine)
 * @param {{ status?: number, call?: number }} [o.timeouts] how long a Host may take (a test's own)
 * @param {boolean} [o.testHostCall] expose a call to the home's own Host to an e2e spec (`globalThis.__momoHostCall`)
 * @param {() => number} [o.now] the clock the grants' back-off is counted by (a test's own)
 * @param {() => Promise<typeof import('../../shared/momoHomeReal.mjs')>} [o.load]
 */
function startHomeService({
  machines,
  dir,
  allowed,
  flagOn,
  account = () => 'account',
  safeStorage,
  watch,
  isThisDevice = (row) => row.id === LOCAL_HOST_ID,
  openExternal,
  hello,
  testHostCall = false,
  now = Date.now,
  wake,
  timeouts,
  load,
}) {
  const importReal = load ?? (() => import('../../shared/momoHomeReal.mjs'));
  /** @type {{ dispose: () => void, forget: () => void, account: string | null, stopGrants: () => void } | null} */
  let running = null;
  let starting = false;
  const stateFileName = path.join(dir, 'momo', CLIENT_FILES.state);
  const outboxFile = path.join(dir, 'momo', CLIENT_FILES.outbox);
  const sentFile = path.join(dir, 'momo', CLIENT_FILES.sent);

  /** What the app itself does for a machine: the Remote Run paths that already exist, never a dead end. @param {{ kind: string, machineId: string, agent?: string }} intent */
  const act = async (intent) => {
    const id = intent.machineId;
    const agent = intent.agent ?? '';
    if (intent.kind === 'update-machine' && machines.updateHost) await machines.updateHost(id);
    else if (intent.kind === 'set-up-machine' && machines.startHost) await machines.startHost(id);
    else if (intent.kind === 'install-agent' && machines.installAgent) await machines.installAgent(id, agent);
    else if (intent.kind === 'sign-in-agent' && machines.signIn) await machines.signIn(id, agent, undefined, true);
    else if (intent.kind === 'wake' && wake) await wake(id);
    else throw new Error('MoMo can’t do that from here.');
  };

  async function start() {
    if (running || starting) return;
    starting = true;
    const mine = account();
    try {
      const [{ createRealHome }, { createMomoOutbox }, { createSealer }, { createNodePrimitives }] = await Promise.all([
        importReal(),
        import('../../shared/momoOutbox.mjs'),
        import('../../shared/momoGoogle/seal.mjs'),
        import('../../shared/remote/nodePrimitives.mjs'),
      ]);
      // turned off, or another account signed in, while the modules loaded
      // turned off, or another account signed in, while the modules loaded: nothing is made, and what is wanted now is looked at again
      if (!(allowed() && flagOn()) || account() !== mine) {
        starting = false;
        return void check();
      }
      const stateFile = stateStore(stateFileName, /** @type {string} */ (mine), account);
      /** One paired session for one call; a call that takes too long closes it, so a hung machine leaves no connection behind. @param {string} id @param {string} method @param {object} params @param {{ timeoutMs: number }} how */
      const callHost = async (id, method, params, how) => {
        /** @type {{ call: (method: string, params?: object, opts?: { timeoutMs?: number }) => Promise<any>, close: () => void } | undefined} */
        let session;
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          session?.close();
        }, how.timeoutMs);
        try {
          session = await machines.session(id);
          if (timedOut) throw Object.assign(new Error('The machine did not answer in time.'), { code: 'timeout' });
          // every request of the versioned protocol follows a hello, and the features both ends agreed are checked against the request (a Host without them refuses it as it would any unknown one)
          await hello(session, method);
          return await session.call(method, params);
        } finally {
          clearTimeout(timer);
          session?.close();
        }
      };
      const real = createRealHome({
        hosts: {
          machines: () =>
            machines
              .list()
              .machines.map((/** @type {any} */ row) =>
                machineRecordOf(row, machines.row(row.id), { isThisDevice, needBuild: machines.appBuild?.() }),
              ),
          call: callHost,
          // a Host whose grant lapsed is told again before its look is read
          grant: (id) => callHost(id, 'host.momoGrant', { account: mine, features: ['momo'] }, { timeoutMs: GRANT_WAIT_MS }),
          heardAt: (id) => machines.row(id)?.lastHeartbeat ?? null,
          onChange: (fn) => machines.onRowChange(fn),
          act,
        },
        // the highest lease seen on any Host (a lease note an earlier build kept counts)
        seen: {
          read: () => Math.max(Number(stateFile.read().seen) || 0, Number(stateFile.read().newest?.leaseEpoch) || 0),
          write: (/** @type {number} */ seen) => stateFile.write({ seen, newest: null }),
        },
        kept: {
          read: () => (Array.isArray(stateFile.read().kept) ? stateFile.read().kept : []),
          write: (/** @type {string[]} */ kept) => stateFile.write({ kept }),
        },
        memory: { read: () => stateFile.read().home ?? null, write: (home) => stateFile.write({ home }) },
        outbox: createMomoOutbox({ store: sealedList(outboxFile, /** @type {string} */ (mine), account, safeStorage), now: Date.now }),
        sent: sealedList(sentFile, /** @type {string} */ (mine), account, safeStorage),
        report: (error) => noteIgnored('MoMo’s home: a call to a machine or a write failed', error),
        ...(timeouts ? { timeouts } : {}),
        // Google is signed in on this Mac: the loopback catcher is where the system browser's redirect lands
        ...(openExternal
          ? {
              google: {
                sealer: createSealer(createNodePrimitives()),
                startCatcher: createLoopbackCatcher({ openExternal }),
                client: /** @type {const} */ ('desktop'),
              },
            }
          : {}),
      });
      const stopGrants = keepGranted({
        machines,
        call: callHost,
        account: /** @type {string} */ (mine),
        refresh: () => real.refresh(),
        now,
      });
      running = Object.assign(real, { account: mine, stopGrants });
      active = real;
      setHomeApi(real.api);
      // e2e: a call to the home's own Host as the app makes it, for a spec that reads the Host's ledger (only where `homeOptions` allows it: never a packaged app)
      if (testHostCall) globalThis.__momoHostCall = real.api.hostCall;
    } catch (error) {
      noteIgnored('start MoMo’s home service', error);
    } finally {
      starting = false;
    }
  }

  /** What an account kept stays sealed for when it signs back in; only a Reset takes it away. */
  function stop() {
    if (!running) return;
    running.stopGrants();
    running.dispose();
    running = null;
    active = null;
    setHomeApi(null);
  }

  const check = () => {
    const wanted = allowed() && flagOn() && account() !== null;
    // another account: what the last one had is gone from here, and the new one starts afresh
    if (running && (!wanted || running.account !== account())) stop();
    // never over a scripted home a dev run set
    if (wanted && !running && !getHomeApi()) void start();
  };
  const offs = [watch?.(check)].filter((x) => x);
  check();
  return () => {
    for (const off of offs) off?.();
    stop();
  };
}

/**
 * The app's own wiring: the real home over `machines`, while MoMo is allowed and the `momo.home` flag is on, following the account and the switches.
 * @param {Machines} machines
 * @param {{ app: { getPath: (name: string) => string, isPackaged?: boolean }, shell: { openExternal: (url: string) => unknown } }} d the app's own handles
 * @param {{ hello: Parameters<typeof startHomeService>[0]['hello'], wake?: (id: string) => Promise<unknown>, safeStorage?: any }} more what the app gives besides: the protocol's hello, waking a machine that sleeps, and Electron's system key
 */
const homeOptions = (machines, d, more) => ({
  machines,
  dir: d.app.getPath('userData'),
  allowed: momoAllowed,
  flagOn: () => isEnabled('momo.home'),
  account: momoUserId,
  safeStorage: more.safeStorage,
  watch: (/** @type {() => void} */ fn) => {
    const offs = [onMomoAccess(fn), onMomoState(fn)];
    return () => offs.forEach((off) => off());
  },
  // Google is signed in on this Mac: its consent page opens in the system browser and the loopback catcher takes the redirect
  openExternal: (/** @type {string} */ url) => d.shell.openExternal(url),
  hello: more.hello,
  // a spec's own hook, never in a packaged app (`isPackaged` must say so: an app that does not say is not trusted)
  testHostCall: d.app.isPackaged === false && !!process.env.MOPILOT_MOMO_TEST_HOST_CALL,
  wake: more.wake,
});
const attachMomoHome = (machines, d, more) => startHomeService(homeOptions(machines, d, more));

module.exports = { startHomeService, attachMomoHome, homeOptions, machineRecordOf, eraseHomeClient };
