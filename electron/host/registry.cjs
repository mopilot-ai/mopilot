// The Host registry: one persisted record per remote machine plus its liveness (heartbeat every 30 s, online for 90 s after the last answer), so the chip and Settings read one answer for "is this machine usable".
const { clock } = require('../platform/ports/clock.cjs');
const { readStoreFile, writeAtomic } = require('../platform/fsutil.cjs');
const { cloudOf } = require('./cloudRecord.cjs');
const { isJsonRecord: isObject } = require('../../shared/jsonRecord.mjs');
const { HostError } = require('./interface.cjs');
const { validSocketPath, validHostKey, booleanFlags } = require('./hostReported.cjs');
const { validIdentity } = require('./sshKey.cjs');
const { normalizeHarness } = require('../../shared/host/logins.mjs');
const { computerNameOf, addressName } = require('../../shared/host/computerName.mjs');

const HEARTBEAT_MS = 30_000;
/** A Host that has not answered for this long counts as offline. */
const ONLINE_MS = 90_000;
const { DROP_OFFLINE_MS } = require('./linkWatch.cjs');
const VERSION = 1;

/** @param {unknown} v */
const text = (v) => typeof v === 'string' && v.trim() !== '';
/** The longest name a machine may be given here. */
const MAX_NAME = 64;

/** What a Host says of its reach into the local network (host/src/localNetwork.mjs); an older Host says nothing, which is 'unknown'. */
const LOCAL_NETWORK = new Set(['allowed', 'denied', 'unknown']);
/** @param {unknown} v @returns {'allowed' | 'denied' | 'unknown'} */
const localNetworkOf = (v) => (LOCAL_NETWORK.has(/** @type {string} */ (v)) ? /** @type {any} */ (v) : 'unknown');
/** Why a machine that does not answer cannot, when nobody is signed in on it (signinWait.cjs). */
const WAITING = {
  restarted: 'The machine restarted and is waiting for someone to sign in.',
  'signed-out': 'The machine is waiting for someone to sign in.',
  locked: 'The machine restarted and FileVault keeps its disk locked until someone unlocks it at the machine.',
  'host-stopped': 'The machine answers over ssh, but its Host does not.',
};
/** @typedef {{ atBoot: 'yes' | 'no' | 'unknown', fileVault: 'on' | 'off' | 'unknown' }} Startup */
/** What a Host's `status` says of its managed policy (plan W2): the generation, who manages it and the keys locked; null from a Host that says nothing or says it is not managed. @param {unknown} v @returns {{ managed: true, generation: string, organization: string, locked: string[], problem: string } | null} */
const policyOf = (v) => {
  const p = /** @type {any} */ (v);
  if (!p || typeof p !== 'object' || p.managed !== true || typeof p.generation !== 'string') return null;
  return {
    managed: true,
    generation: p.generation,
    organization: text(p.organization) ? p.organization : '',
    locked: Array.isArray(p.locked) ? p.locked.filter(text) : [],
    problem: text(p.problem) ? p.problem : '',
  };
};

/** What a Host says of starting at boot (host/src/startup.mjs); an older Host says nothing, which is unknown. @param {unknown} v @returns {Startup} */
const startupOf = (v) => {
  const r = /** @type {any} */ (isObject(v) ? v : {});
  return {
    atBoot: ['yes', 'no'].includes(r.atBoot) ? r.atBoot : 'unknown',
    fileVault: ['on', 'off'].includes(r.fileVault) ? r.fileVault : 'unknown',
  };
};
/** How many waiting cards a Host said found no phone linked to push to (host.status `push.skipped`, #4721); 0 when it says none or nothing. @param {unknown} v */
const pushSkippedOf = (v) => {
  const n = /** @type {any} */ (isObject(v) ? v : {}).skipped;
  return Number.isInteger(n) && n > 0 ? n : 0;
};
/** What a cloud machine's Host said of itself (host.status `cloud`, plan C2): how long it may idle, whether it is stopping and why, the hours run today; null from any other Host. @param {unknown} v */
const cloudStateOf = (v) => {
  const c = /** @type {any} */ (isObject(v) ? v : null);
  if (!c || !Number.isFinite(c.idleMinutes)) return null;
  return {
    idleMinutes: c.idleMinutes,
    stopping: c.stopping === true,
    hoursToday: Number.isFinite(c.hoursToday) ? c.hoursToday : 0,
    ...(c.reason === 'idle' || c.reason === 'hours' ? { reason: c.reason } : {}),
  };
};
/** The system a Host said it runs on; '' for anything else. @param {unknown} v @returns {'darwin' | 'linux' | ''} */
const platformOf = (v) => (v === 'darwin' || v === 'linux' ? v : '');

/** @param {unknown} h */
const isHarness = (h) =>
  isObject(h) &&
  text(/** @type {any} */ (h).id) &&
  typeof (/** @type {any} */ (h).detected) === 'boolean' &&
  typeof (/** @type {any} */ (h).signedIn) === 'boolean';

/**
 * What a `status` reply says is still missing on the Host, as one line; '' when it is ready. A reply that is not a status is `null`.
 * @param {unknown} s
 * @returns {string | null}
 */
function setupReason(s) {
  const r = /** @type {any} */ (s);
  if (!isObject(r) || !Array.isArray(r.harnesses) || !r.harnesses.every(isHarness) || !isObject(r.capabilities)) return null;
  if (r.harnesses.length === 0) return 'No agent is installed on this machine.';
  // a Host lists every harness it knows, installed or not: the machine is usable when one of them is ready, and needs setup when none is
  // an agent the Host is still checking, or could not check in time, is not a sign-in the machine lacks
  if (r.harnesses.some((/** @type {any} */ h) => h.detected && (h.signedIn || h.checking === true || h.unsure === true))) return '';
  const signedOut = r.harnesses.find((/** @type {any} */ h) => h.detected);
  if (signedOut) return `${signedOut.id} is not signed in on this machine.`;
  return `${r.harnesses[0].id} is not installed on this machine.`;
}

/**
 * @typedef {{ id: string, name: string, kind: 'ssh' | 'cloud', cloud: ReturnType<typeof cloudOf>, address: string, socketPath: string, hostKey: string, capabilities: Record<string, boolean>, harnesses: { id: string, detected: boolean, signedIn: boolean, installable?: boolean }[], lastHeartbeat: number | null, setup: string, identity: string, localNetwork: 'allowed' | 'denied' | 'unknown', startup: Startup, platform: 'darwin' | 'linux' | '', hostBuild: string, hostAppVersion: string, hostPending: { build: string, since: number } | null, computerName: string, renamed: boolean, policy: ReturnType<typeof policyOf>, pushSkipped: number, cloudState: ReturnType<typeof cloudStateOf> }} HostRecord `computerName`: the name of the computer as its Host last said it ('' before it has, or from an older Host); `renamed`: a person chose `name` (Settings › My machines › Rename), or it is this Mac's or a cloud machine's own, so no answer replaces it; `policy`: the managed policy the Host last reported (null when none); `hostBuild`: the build its Host last said it runs ('' before it has answered, or from a Host that names none); `hostAppVersion`: the version of the app that built it ('' when it names none); `hostPending`: the build a staged update on its Host will become, and since when this app has seen one waiting (null: none; never kept across a restart); `identity`: the key file the machine signs in with ('' for this Mac's own ssh setup); `localNetwork`: what the Host last said of its reach into the local network; `startup`: whether it last said it starts at boot, and FileVault; `platform`: the system it runs on; `pushSkipped`: the waiting cards it last said found no phone linked (never kept across a restart); `cloudState`: what a cloud machine's Host last said of its idle stop (never kept across a restart)
 * @typedef {'restarted' | 'signed-out' | 'locked' | 'host-stopped'} LoginWait `host-stopped`: ssh answers and nobody waits to sign in, yet the Host does not answer
 * @typedef {HostRecord & { rawName: string, status: 'online' | 'offline' | 'needs-setup', reason: string, checked: boolean, linkDroppedAt: number | null, waitingForLogin: Exclude<LoginWait, 'host-stopped'> | null, hostStopped: boolean }} HostRow `name`: what surfaces show (with the address when another machine has the same name); `rawName`: the name itself, which Rename starts from; `waitingForLogin`: an offline machine nobody is signed in on (it restarted since it last answered, or was signed out)
 */

/**
 * @param {object} o
 * @param {string} o.file where the records are kept (the user data dir)
 * @param {(record: HostRecord) => Promise<unknown>} [o.status] asks one Host for its `status` over the tunnel; rejects when it is unreachable
 * @param {number} [o.heartbeatMs]
 * @param {number} [o.onlineMs]
 * @param {(error: Error) => void} [o.report] where a registry file that could not be read or written, or a broken `explain`, is reported
 * @param {(record: HostRecord) => Promise<LoginWait | null>} [o.explain] why a machine that did not answer cannot: whether it waits for someone to sign in
 * @param {(id: string) => number | null | undefined} [o.linkDropped] when the app's live connection to the machine dropped and has not come back (linkWatch.cjs): seconds before a heartbeat would miss; null while that connection is online, undefined when there is none
 */
function createRegistry({
  file,
  status = async () => null,
  heartbeatMs = HEARTBEAT_MS,
  onlineMs = ONLINE_MS,
  report = () => undefined,
  explain = async () => null,
  linkDropped = () => undefined,
}) {
  /** @type {Map<string, HostRecord>} */
  let records = new Map();
  /** Ids whose first answer (or first failure) has arrived since this process started. @type {Set<string>} */
  const checked = new Set();
  /** Why the last attempt to reach each Host failed. @type {Map<string, string>} */
  const failures = new Map();
  /** Machines that did not answer because nobody is signed in on them, while that lasts. @type {Map<string, LoginWait>} */
  const waiting = new Map();
  /** Hosts with a status call in flight: a second beat for the same record joins it instead of overlapping. @type {Map<string, { record: HostRecord, done: Promise<void> }>} */
  const inflight = new Map();
  /** @type {Set<() => void>} */
  const listeners = new Set();
  /** @type {any} */
  let timer = null;
  let disposed = false;
  /** @type {Error | null} */
  let loadError = null;
  /** Unreadable entries stay on disk until repaired. They are never used as machine records. @type {unknown[]} */
  let unreadableRows = [];

  const changed = () => {
    for (const fn of [...listeners]) fn();
  };

  /** Read the file; an unreadable one keeps what is in memory, is copied aside by the reader, and is reported. */
  function load() {
    const { data, error } = readStoreFile(file, 'the Host registry', (d) => isObject(d) && Array.isArray(d.hosts));
    loadError = error;
    if (error) return report(error);
    if (!data) return;
    const next = new Map();
    const rejected = [];
    for (const raw of data.hosts) {
      if (!isObject(raw) || !text(raw.id) || !text(raw.name) || !text(raw.address)) {
        rejected.push(raw);
        continue;
      }
      next.set(raw.id, {
        id: raw.id,
        name: raw.name,
        kind: cloudOf(raw.cloud) ? 'cloud' : 'ssh',
        cloud: cloudOf(raw.cloud),
        address: raw.address,
        socketPath: validSocketPath(raw.socketPath) ? raw.socketPath : '',
        hostKey: validHostKey(raw.hostKey) ? raw.hostKey : '',
        capabilities: booleanFlags(raw.capabilities),
        harnesses: Array.isArray(raw.harnesses) ? raw.harnesses.filter(isHarness) : [],
        lastHeartbeat: Number.isFinite(raw.lastHeartbeat) ? raw.lastHeartbeat : null,
        setup: typeof raw.setup === 'string' ? raw.setup : '',
        identity: validIdentity(raw.identity) ? raw.identity : '',
        localNetwork: localNetworkOf(raw.localNetwork),
        startup: startupOf(raw.startup),
        platform: platformOf(raw.platform),
        hostBuild: text(raw.hostBuild) ? raw.hostBuild : '',
        computerName: computerNameOf(raw.computerName),
        // a machine saved before names were asked for has no flag: a name that is just its address was never chosen
        renamed:
          typeof raw.renamed === 'boolean' ? raw.renamed : Boolean(cloudOf(raw.cloud)) || raw.name !== addressName(String(raw.address)),
        hostAppVersion: text(raw.hostAppVersion) ? raw.hostAppVersion : '',
        hostPending: null,
        policy: policyOf(raw.policy),
        pushSkipped: 0,
        cloudState: null,
      });
    }
    records = next;
    unreadableRows = rejected;
    changed();
  }

  /** Write `next` and make it the registry; on a failed write nothing changes and the error goes to the caller. @param {Map<string, HostRecord>} next */
  function commit(next) {
    const remaining = unreadableRows.filter((raw) => !isObject(raw) || !next.has(/** @type {string} */ (raw.id)));
    writeAtomic(file, `${JSON.stringify({ version: VERSION, hosts: [...next.values(), ...remaining] }, null, 2)}\n`);
    records = next;
    unreadableRows = remaining;
    changed();
  }

  /** An address as a surface says it: a machine joined through the relay is `relay:` and the first six characters of its id. @param {string} address */
  const spoken = (address) => (address.startsWith('relay:') ? address.slice(0, 12) : address);

  /**
   * The name a surface shows: the machine's name, with its address when another machine has the same one (a computer reached by one IP from two networks, two Macs named alike), the full address when even the host part is the same too.
   * @param {HostRecord} r
   */
  function shownName(r) {
    const same = [...records.values()].filter((o) => o.id !== r.id && o.name.toLowerCase() === r.name.toLowerCase());
    if (same.length === 0) return r.name;
    const host = addressName(r.address).toLowerCase();
    return `${r.name} (${spoken(same.some((o) => addressName(o.address).toLowerCase() === host) ? r.address : addressName(r.address))})`;
  }

  /** @param {HostRecord} r @returns {HostRow} */
  function row(r) {
    const age = r.lastHeartbeat === null ? Infinity : clock.now() - r.lastHeartbeat;
    const live = linkDropped(r.id);
    // a heartbeat from the future (the clock moved back) proves nothing; the app's live connection that is up is proof of life too (its own pings and every frame count), so a status ask that timed out on a busy Host never calls the machine offline
    // a live connection that dropped and stayed down for the window, with no heartbeat answered since, is offline now: not 90 s after the last good heartbeat (#5135)
    const gone = typeof live === 'number' && clock.now() - live >= DROP_OFFLINE_MS && (r.lastHeartbeat === null || r.lastHeartbeat <= live);
    const fresh = !gone && ((age >= 0 && age < onlineMs) || live === null);
    const state = !fresh ? 'offline' : r.setup ? 'needs-setup' : 'online';
    const failedAsk = r.lastHeartbeat !== null && failures.get(r.id)?.startsWith('Unreachable:');
    const wait = state === 'offline' ? (waiting.get(r.id) ?? null) : null;
    // a Host that does not answer while ssh does is not a wait for anyone to sign in
    const signedOutWait = wait === 'host-stopped' ? null : wait;
    const reason =
      state === 'offline' ? (failures.get(r.id) ?? (r.lastHeartbeat === null ? 'Not reached yet.' : 'No answer for 90 seconds.')) : r.setup;
    return {
      ...r,
      name: shownName(r),
      rawName: r.name,
      status: state,
      reason,
      checked: checked.has(r.id),
      // while the machine still counts as online: the live connection says when it dropped (null while it is up, even if a beat failed on a busy Host); with none, a failed last ask says the link dropped at the last answer. It reads Reconnecting… until the registry calls the machine offline
      linkDroppedAt: fresh ? (live !== undefined ? live : failedAsk ? r.lastHeartbeat : null) : null,
      waitingForLogin: signedOutWait,
      hostStopped: state === 'offline' && waiting.get(r.id) === 'host-stopped',
    };
  }

  /** How soon an agent the Host could not read yet is asked about again, by try: it settles without a click and without hammering a Host whose probe is slow. */
  const RECHECK_MS = [5000, 10000, 20000, 30000];
  const RECHECK_MAX = 8;
  /** @type {Map<string, { n: number, timer: any }>} */
  const rechecks = new Map();
  /** After an answer that still has an agent `checking` or `unsure`: ask the machine again soon; any answer without one ends the retries. @param {string} id @param {{ checking?: boolean, unsure?: boolean }[]} harnesses */
  function recheck(id, harnesses) {
    const open = rechecks.get(id);
    clock.clearTimeout(open?.timer);
    if (!harnesses.some((h) => h.checking === true || h.unsure === true)) return void rechecks.delete(id);
    const n = open?.n ?? 0;
    // the retries stop after a few tries; the 30 s heartbeat goes on asking
    if (n >= RECHECK_MAX) return;
    const timer = clock.setTimeout(
      () => {
        const r = records.get(id);
        if (!disposed && r) void ask(r);
      },
      RECHECK_MS[Math.min(n, RECHECK_MS.length - 1)],
    );
    rechecks.set(id, { n: n + 1, timer });
  }

  /** @param {string} id */
  const need = (id) => {
    const r = records.get(id);
    if (!r) throw new HostError('invalid', 'That machine is not in the registry.');
    return r;
  };

  /** One status call for `id`; its answer counts only while the record is the one it was asked about. @param {HostRecord} asked */
  async function beat(asked) {
    let answer;
    try {
      // a call that never settles must not stop the beats that follow
      let timeout;
      const gave = new Promise((_, reject) => {
        timeout = clock.setTimeout(() => reject(new Error('no answer')), heartbeatMs);
      });
      answer = await Promise.race([status(asked), gave]).finally(() => clock.clearTimeout(timeout));
    } catch (e) {
      if (records.get(asked.id) !== asked || disposed) return;
      const unreachable = `Unreachable: ${String(/** @type {any} */ (e)?.message || e)}`;
      // a machine known to wait for a sign-in keeps saying so while it is asked again
      const wait = waiting.get(asked.id);
      failures.set(asked.id, wait ? WAITING[wait] : unreachable);
      checked.add(asked.id);
      changed();
      // asked on the side: a slow probe never holds up the next beat, and its answer counts only for this record
      void why(asked, unreachable);
      return;
    }
    // the machine was removed or replaced while the call was out
    if (disposed || records.get(asked.id) !== asked) return;
    const setup = setupReason(answer);
    checked.add(asked.id);
    if (setup === null) {
      failures.set(asked.id, 'The machine sent a status this app cannot read.');
      return changed();
    }
    const s = /** @type {any} */ (answer);
    // the computer's own name, when its Host says one: a machine nobody named follows it; an older Host says none and the last one stands
    const computerName = computerNameOf(s.computerName) || asked.computerName;
    failures.delete(asked.id);
    waiting.delete(asked.id);
    const next = new Map(records);
    next.set(asked.id, {
      ...asked,
      computerName,
      name: !asked.renamed && computerName ? computerName : asked.name,
      capabilities: booleanFlags(s.capabilities),
      harnesses: s.harnesses.map(normalizeHarness),
      setup,
      lastHeartbeat: clock.now(),
      localNetwork: localNetworkOf(s.localNetwork),
      startup: startupOf(s.startup),
      platform: platformOf(s.platform),
      hostBuild: text(s.build) ? s.build : '',
      hostAppVersion: text(s.appVersion) ? s.appVersion : '',
      hostPending: s.pendingUpdate
        ? { build: text(s.pendingUpdate.build) ? s.pendingUpdate.build : '', since: asked.hostPending?.since ?? clock.now() }
        : null,
      policy: policyOf(s.policy),
      pushSkipped: pushSkippedOf(s.push),
      cloudState: cloudStateOf(s.cloud),
    });
    recheck(asked.id, s.harnesses);
    try {
      commit(next);
    } catch (e) {
      // the answer still proves the machine is up for this run; only the file is behind
      records = next;
      report(/** @type {Error} */ (e));
      changed();
    }
  }

  /**
   * After a failed call: whether the machine waits for someone to sign in, which then is its reason; otherwise `unreachable` is.
   * @param {HostRecord} asked @param {string} unreachable
   */
  async function why(asked, unreachable) {
    // a probe that broke says nothing of the machine; why it broke is reported, and the plain failure stands
    const wait = await explain(asked).catch((/** @type {Error} */ e) => (report(e), null));
    // the machine was removed or replaced while the question was out (an answer replaces the record too)
    if (disposed || records.get(asked.id) !== asked) return;
    const reason = wait ? WAITING[wait] : unreachable;
    if (wait) waiting.set(asked.id, wait);
    else waiting.delete(asked.id);
    if (failures.get(asked.id) === reason) return;
    failures.set(asked.id, reason);
    changed();
  }

  /** Ask every machine for its status now; resolves when all have answered or failed. */
  function check() {
    return Promise.all([...records.values()].map(ask)).then(() => undefined);
  }

  /** One status call for the machine, joining the one under way. @param {HostRecord} r */
  function ask(r) {
    const running = inflight.get(r.id);
    if (running?.record === r) return running.done;
    const entry = {
      record: r,
      done: beat(r).finally(() => {
        if (inflight.get(r.id) === entry) inflight.delete(r.id);
      }),
    };
    inflight.set(r.id, entry);
    return entry.done;
  }

  load();

  return {
    /** The machines, each with its status and one-line reason. */
    list: () => [...records.values()].map(row),
    /** True once every machine has answered (or failed to) since this process started; the chip says "Resolving hosts…" until then. */
    resolved: () => [...records.keys()].every((id) => checked.has(id)),
    /** The address of a machine, from its record only; there is no fallback to the name or to a guess. @param {string} id */
    address: (id) => need(id).address,
    /** Where the machine's Host listens, from its record only (empty when none was recorded). @param {string} id */
    socketPath: (id) => need(id).socketPath,
    /** The name the machine's Host had when it was paired (pairingClient.cjs), '' until then. @param {string} id */
    hostKey: (id) => need(id).hostKey,
    /** Keeps the name of a machine's Host: a proof is made only for a Host with it. @param {string} id @param {string} hostKey */
    pin(id, hostKey) {
      const record = need(id);
      if (!validHostKey(hostKey) || record.hostKey === hostKey) return;
      commit(new Map(records).set(id, { ...record, hostKey }));
    },
    /**
     * The name every surface shows for the machine (Settings › My machines › Rename), trimmed; refused empty, too long or with control characters.
     * A status call out while it changes is not counted (its record was replaced), and the next beat asks again.
     * @param {string} id @param {string} name
     */
    rename(id, name) {
      const record = need(id);
      const next = typeof name === 'string' ? name.trim() : '';
      if (!next || next.length > MAX_NAME || /[\p{Cc}]/u.test(next))
        throw new HostError('invalid', `Give the machine a name of up to ${MAX_NAME} characters.`);
      // what Rename started from, shown or plain, is no new name: saving it unchanged neither writes nor makes a followed name the person's own
      if (next === record.name || next === shownName(record)) return;
      commit(new Map(records).set(id, { ...record, name: next, renamed: true }));
    },
    /** @param {{ id: string, name?: string, cloud?: unknown, address: string, socketPath?: string, hostKey?: string, capabilities?: Record<string, boolean>, harnesses?: HostRecord['harnesses'], identity?: string, startup?: unknown, platform?: unknown, renamed?: boolean }} h `startup` and `platform`: what the Host's status said; `renamed`: the name is not to be replaced by the Host's (this Mac's own) */
    add(h) {
      if (!text(h?.id)) throw new HostError('invalid', 'A machine needs an id.');
      if (!text(h.address)) throw new HostError('invalid', 'A machine needs an address.');
      const prior = records.get(h.id);
      const record = /** @type {HostRecord} */ ({
        id: h.id,
        // a machine added again keeps the name the person gave it
        name: prior?.renamed ? prior.name : text(h.name) ? h.name : h.id,
        kind: cloudOf(h.cloud) ? 'cloud' : 'ssh',
        cloud: cloudOf(h.cloud),
        address: h.address,
        socketPath: validSocketPath(h.socketPath) ? h.socketPath : '',
        hostKey: validHostKey(h.hostKey) ? h.hostKey : '',
        capabilities: booleanFlags(h.capabilities),
        harnesses: Array.isArray(h.harnesses) ? h.harnesses.filter(isHarness) : [],
        lastHeartbeat: null,
        setup: '',
        identity: validIdentity(h.identity) ? h.identity : '',
        localNetwork: 'unknown',
        startup: startupOf(h.startup),
        platform: platformOf(h.platform),
        hostBuild: '',
        computerName: '',
        renamed: prior?.renamed === true || h.renamed === true || Boolean(cloudOf(h.cloud)),
        hostAppVersion: '',
        hostPending: null,
        policy: null,
        pushSkipped: 0,
        cloudState: null,
      });
      commit(new Map(records).set(record.id, record));
      return row(record);
    },
    /** @param {string} id */
    remove(id) {
      need(id);
      const next = new Map(records);
      next.delete(id);
      commit(next);
      checked.delete(id);
      failures.delete(id);
      waiting.delete(id);
      clock.clearTimeout(rechecks.get(id)?.timer);
      rechecks.delete(id);
    },
    check,
    /** Begin the heartbeat: one check now, then one every 30 s. */
    start() {
      if (timer !== null || disposed) return;
      timer = clock.setInterval(() => void check(), heartbeatMs);
      void check();
    },
    /** Stop the heartbeat (Host access was lost); `start` begins it again. */
    stop() {
      clock.clearInterval(timer);
      timer = null;
      for (const r of rechecks.values()) clock.clearTimeout(r.timer);
      rechecks.clear();
    },
    /** @param {() => void} fn @returns {() => void} */
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** The error from the last read of the file, if it could not be read. */
    loadError: () => loadError,
    /** The persisted rows do not give a complete answer about which machines are registered. */
    membershipIncomplete: () => loadError !== null || unreadableRows.length > 0,
    reload: load,
    dispose() {
      disposed = true;
      clock.clearInterval(timer);
      timer = null;
      for (const r of rechecks.values()) clock.clearTimeout(r.timer);
      rechecks.clear();
      listeners.clear();
    },
  };
}

module.exports = { createRegistry, setupReason, HEARTBEAT_MS, ONLINE_MS };
