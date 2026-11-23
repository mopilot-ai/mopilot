// MoMo's home on this Host (M1 H1, designs/momo-m1-home): the grant of an invited account (client-asserted, closed alpha, #4767), the home record (which machine is home, at which epoch) and MoMo's stores opened through the seams under the Host's data dir; without a live grant nothing of it exists, is read or answers.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { HostRefusal } from './hostFs.mjs';
import { createMomoPrefs } from './momoPrefs.mjs';
import { createServiceRegistry } from './momoServiceRegistry.mjs';
import { createMemoryOps } from './momoMemoryOps.mjs';
import { SchemaError } from '../../shared/host/schema.mjs';
import { MOMO_FEATURE } from '../../shared/host/methods/momo.mjs';
import { createMomoTurns, settledAs } from './momoTurns.mjs';
import { createMomoKept } from './momoKept.mjs';

const require = createRequire(import.meta.url);
const { momoStorage, systemClock } = require('../../electron/momo/seams.cjs');
const { SealedJson } = require('../../electron/gateway/sealedFile.cjs');
const { MemoryStore } = require('../../electron/momo/memory.cjs');
const { OpenLoopStore } = require('../../electron/momo/openLoops.cjs');
const { RoutineStore } = require('../../electron/momo/routineStore.cjs');
const { AuditLog } = require('../../electron/momo/audit.cjs');
const { sentinelFileStorage } = require('../../electron/momo/sentinelStore.cjs');

/** What the Host keeps for itself in MoMo's folder, which neither a move nor a Reset takes. */
export const HOST_OWN = ['grant.json', 'home.json', 'chats.json', 'stamps.json', 'google-revoke-owed.json'];
/** What a Reset keeps: the Host's own files and the ids of the turns it deleted (those are sealed with MoMo's data key, so a move carries them). */
export const RESET_KEEPS = [...HOST_OWN, 'turns-void.json'];

/** How many ended moves' ids an old home remembers, so a late or repeated step of one cannot pause it again. */
const CLOSED_KEEP = 20;

/** A grant older than this has run out: scheduled runs stop until the client sends it again (the client does every 30 minutes). */
export const GRANT_MAX_AGE_MS = 7 * 86_400_000;

/** @typedef {{ account: string | null, features: string[], receivedAt: number }} Grant */
/**
 * The home record (design 3.1): `leaseEpoch` is the fencing token, +1 on every move; only the Host holding the current one acts.
 * `state` is what this Host keeps: 'none', 'running' or 'moving' (a Host that is asleep, out of date or signed out cannot say so; the
 * client derives those, shared/momoHomeState.mjs).
 * @typedef {{ homeId: string | null, leaseEpoch: number, state: 'none' | 'running' | 'moving', stateSince: number, lastSeenAt: number, moveId: string | null, bundleHash: string | null, moveDeadline: number | null, targetSignKey: string | null, moveReceipts: Record<string, { leaseEpoch: number, receipt: string }>, closedMoves: string[], movedTo: { name: string, homeId: string, at: number } | null, name: string, account: string | null }} HomeRecord
 */
/** @typedef {{ homeId: string, leaseEpoch: number }} HomeStamp what every outbound action and push of the home carries */

/** @param {any} v @returns {Grant} */
const grantShape = (v) => ({
  account: typeof v?.account === 'string' ? v.account : null,
  features: Array.isArray(v?.features) ? v.features.filter((/** @type {unknown} */ f) => typeof f === 'string') : [],
  receivedAt: Number.isFinite(v?.receivedAt) ? v.receivedAt : 0,
});
/** The target's receipts of the switches it made, by move id, newest last: kept past later moves and restarts, so a repeat of a switch or a discard that finds one tells the same. @param {any} v @returns {Record<string, { leaseEpoch: number, receipt: string }>} */
const receiptsOf = (v) =>
  Object.fromEntries(
    Object.entries(v && typeof v === 'object' && !Array.isArray(v) ? v : {})
      .filter(([, r]) => Number.isSafeInteger(/** @type {any} */ (r)?.leaseEpoch) && typeof (/** @type {any} */ (r)?.receipt) === 'string')
      .slice(-CLOSED_KEEP)
      .map(([id, r]) => [id, { leaseEpoch: /** @type {any} */ (r).leaseEpoch, receipt: /** @type {any} */ (r).receipt }]),
  );

/** @param {any} v @returns {HomeRecord} */
const homeShape = (v) => ({
  homeId: typeof v?.homeId === 'string' ? v.homeId : null,
  leaseEpoch: Number.isSafeInteger(v?.leaseEpoch) && v.leaseEpoch > 0 ? v.leaseEpoch : 0,
  state: v?.state === 'running' || v?.state === 'moving' ? v.state : 'none',
  stateSince: Number.isFinite(v?.stateSince) ? v.stateSince : 0,
  lastSeenAt: Number.isFinite(v?.lastSeenAt) ? v.lastSeenAt : 0,
  moveId: typeof v?.moveId === 'string' ? v.moveId : null,
  bundleHash: typeof v?.bundleHash === 'string' ? v.bundleHash : null,
  moveDeadline: Number.isFinite(v?.moveDeadline) ? v.moveDeadline : null,
  moveReceipts: receiptsOf(v?.moveReceipts),
  closedMoves: Array.isArray(v?.closedMoves)
    ? v.closedMoves.filter((/** @type {unknown} */ i) => typeof i === 'string').slice(-CLOSED_KEEP)
    : [],
  targetSignKey: typeof v?.targetSignKey === 'string' ? v.targetSignKey : null,
  movedTo:
    typeof v?.movedTo?.name === 'string' && typeof v.movedTo.homeId === 'string' && Number.isFinite(v.movedTo.at)
      ? { name: v.movedTo.name, homeId: v.movedTo.homeId, at: v.movedTo.at }
      : null,
  name: typeof v?.name === 'string' ? v.name : '',
  account: typeof v?.account === 'string' ? v.account : null,
});

/**
 * @param {object} o
 * @param {string} o.hostId this Host's own id (host/src/pairing.mjs `hostId`): the home is named by it, never by what a client says
 * @param {string} o.dataDir the Host's data dir; MoMo's folder is `momo/` in it
 * @param {import('../../electron/platform/secretFile.cjs').SafeStorage} o.safeStorage the Host's key file (./secretStore.mjs)
 * @param {{ now: () => number }} [o.clock]
 * @param {import('../../electron/platform/secretFile.cjs').SafeStorage & { forget?: () => void }} [o.dataSafeStorage] seals MoMo's stores (memory, audit, turns…) with a key of their own, so a move carries that key and the home's own files stay on the Host's (default: the Host's)
 * @param {string | null} [o.dataKeyDir] the folder of that key's file, when it is a file (a move copies and deletes it)
 * @param {(chatId: string) => boolean} [o.isMomoChat] the chats a memory fact may come from (the home's chats, H2)
 * @param {(message: string) => void} [o.report]
 */
export function createMomoHome({
  hostId,
  dataDir,
  safeStorage,
  dataSafeStorage = safeStorage,
  dataKeyDir = null,
  clock = systemClock,
  isMomoChat = () => false,
  report = () => undefined,
}) {
  if (typeof hostId !== 'string' || !hostId) throw new Error('MoMo’s home needs this Host’s own id.');
  const storage = momoStorage({ dir: path.join(dataDir, 'momo'), keySource: { kind: 'key-file', safeStorage } });
  const now = () => clock.now();
  /** One sealed file of this folder; nothing is made on the disk until a change is written. @template T @param {string} name @param {(v: any) => T} shape */
  const sealed = (name, shape) => new SealedJson({ file: path.join(storage.dir, name), safeStorage: storage.safeStorage, shape, now });
  const grantFile = sealed('grant.json', grantShape);
  const homeFile = sealed('home.json', homeShape);
  /** A file that is not there is the empty record, read without making MoMo's folder (an uninvited client leaves no trace). @template T @param {{ read: () => T }} file @param {string} name @param {(v: any) => T} shape @returns {T} */
  const read = (file, name, shape) => (fs.existsSync(path.join(storage.dir, name)) ? file.read() : shape(null));
  const unknown = (/** @type {string} */ method) => new SchemaError(`Unknown request: ${method}`);

  /** The grant as kept (this process is its only writer, so what was read stays until `grant` writes it), or the empty one when it cannot be read (then nobody is granted, and the next call tries again). @type {Grant | null} */
  let grantNow = null;
  /** @returns {Grant} */
  const readGrant = () => {
    if (grantNow) return grantNow;
    try {
      return (grantNow = read(grantFile, 'grant.json', grantShape));
    } catch (error) {
      report(`MoMo's grant could not be read: ${/** @type {Error} */ (error).message}`);
      return grantShape(null);
    }
  };
  /** A grant is live for seven days after it was received; one from the future (this Host's clock moved back) is not live until the clock is back. @param {Grant} g */
  const live = (g) => {
    const age = now() - g.receivedAt;
    return !!g.account && g.features.includes(MOMO_FEATURE) && age >= 0 && age <= GRANT_MAX_AGE_MS;
  };

  /** @type {ReturnType<typeof opened> | null} */
  let stores = null;
  const opened = () => ({
    memory: new MemoryStore({ dir: storage.dir, safeStorage: dataSafeStorage, isMomoChat }),
    loops: new OpenLoopStore({ dir: storage.dir, safeStorage: dataSafeStorage }),
    routines: new RoutineStore({ dir: storage.dir, safeStorage: dataSafeStorage }),
    audit: new AuditLog({ dir: path.join(storage.dir, 'audit'), safeStorage: dataSafeStorage }),
    approvals: sentinelFileStorage({ file: path.join(storage.dir, 'approvals.bin'), safeStorage: dataSafeStorage }),
    turns: createMomoTurns({ dir: storage.dir, safeStorage: dataSafeStorage, now }),
  });

  /** The home record as kept, for the same reason; null when it cannot be read (then the Host says so and never starts over it). @type {HomeRecord | null} */
  let homeNow = null;
  /** @returns {HomeRecord | null} */
  const readHome = () => {
    if (homeNow) return homeNow;
    try {
      return (homeNow = read(homeFile, 'home.json', homeShape));
    } catch (error) {
      report(`MoMo's home record could not be read: ${/** @type {Error} */ (error).message}`);
      return null;
    }
  };

  /** Who is told when the home's record changes (a connection's veil tells its client that this Host is, or is no longer, the running home). @type {Set<(e: { running: boolean, state: string }) => void>} */
  const watchers = new Set();
  const told = () => {
    const e = { running: !!home.stamp(), state: /** @type {{ state: string }} */ (readHome()).state };
    for (const fn of watchers) {
      try {
        fn(e);
      } catch (error) {
        report(`A listener of MoMo's home failed: ${/** @type {Error} */ (error).message}`);
      }
    }
  };
  /** What the home keeps beside its record: the ids a Reset deleted, and the newest lease seen (host/src/momoKept.mjs). */
  const beside = createMomoKept({ dir: storage.dir, hostSafe: storage.safeStorage, dataSafe: dataSafeStorage, now, report });

  const registry = createServiceRegistry({ report, running: () => !!home.stamp() });

  const home = {
    /** MoMo's folder, and nothing that seals: a service keeps its state in it through `data` (the key that travels with a move). */
    storage: Object.defineProperty({ dir: storage.dir }, 'safeStorage', {
      enumerable: false,
      get() {
        throw new Error(
          "home.storage seals nothing: keep a service's state with home.data.sealed(name, shape), the key that travels with a move",
        );
      },
    }),
    /** The Host's OWN key and folder, for the files in `HOST_OWN` only (the home's grant and record, the chat registry, the stamps): a file sealed with it cannot be opened after a move. */
    hostOnlyStorage: storage,
    /** A move of the home to or from this Host (./momoMove.mjs), set by the serve entry. @type {ReturnType<typeof import('./momoMove.mjs').createMomoMove> | null} */
    move: null,
    /** The home's chats (./momoChats.mjs), set by the serve entry once the Host's sessions exist. @type {ReturnType<typeof import('./momoChats.mjs').createMomoChats> | null} */
    chats: null,
    ...createMemoryOps({ stores: () => home.stores(), machine: () => home.machine() }),
    /** What its routines read: how often MoMo reaches out, quiet hours, paused (./momoPrefs.mjs). */
    prefs: createMomoPrefs({ home: { storage, data: { safeStorage: dataSafeStorage } }, now }),
    /** The registry of the lanes' intents run on this Host, built from each lane service's `intents` map (see momoWiring.mjs), set by the serve entry. @type {(() => ReturnType<typeof import('../../shared/momoIntents.mjs').createIntentRegistry>) | null} */
    intentRegistry: null,
    /** The rows of MoMo's chat beyond the harness's words (./momoRows.mjs), set by the serve entry. @type {ReturnType<typeof import('./momoRows.mjs').createMomoRows> | null} */
    rows: null,
    /** The names of the tools a chat is offered by the Host's registry (set by the wiring when the Host has one). @type {((chatId: string) => string[]) | null} */
    toolsOf: null,
    /** What the services' ports read on every call: MoMo's brain and the chat's row writer, set by the serve entry. @type {import('./momoSeams.mjs').SeamDeps | null} */
    seams: null,
    /** The approval gate and its taint tracker (the gate lane's service), set when that service loads. @type {any} */
    gate: null,
    /** MoMo's scheduler (./momoScheduler.mjs), set by the serve entry. @type {ReturnType<typeof import('./momoScheduler.mjs').createMomoScheduler> | null} */
    scheduler: null,
    /** The day (brief, catch-up, notes tidy; ./momoDaily.mjs), set with the scheduler. @type {ReturnType<typeof import('./momoDaily.mjs').createMomoDaily> | null} */
    daily: null,
    /** MoMo's own push (./momoPush.mjs), set by the serve entry. @type {ReturnType<typeof import('./momoPush.mjs').createMomoPush> | null} */
    push: null,
    /** What a notification's buttons do (./momoIntents.mjs), set by the serve entry. @type {ReturnType<typeof import('./momoIntents.mjs').createMomoIntents> | null} */
    intents: null,
    /** This machine's own name, for what a refusal says of it. */
    machine: () => os.hostname(),
    /** Whether a live grant of the account that owns the home (when there is one) is held: the home is active, for the whole Host (its scheduled runs, its tools and its stores). */
    granted() {
      const g = readGrant();
      const h = readHome();
      return live(g) && (!h?.homeId || h.account === g.account);
    },
    /**
     * An invited account's client sends its grant (and again every 30 minutes): a Host keeps it sealed. A grant without
     * the `momo` feature is a revoke: it is erased and answered as for a request no Host knows. Another account's grant or
     * revoke is refused the same way while a home or a live grant belongs to the first. Says how long the last one had run
     * out, so the client can tell the person MoMo paused.
     * @param {{ account: string, features: string[] }} p
     */
    async grant({ account, features }) {
      const before = readGrant();
      const h = readHome();
      // whose MoMo this is: the home's account, else the account of a grant still live; nobody else may grant or revoke it
      const owner = h?.homeId ? h.account : live(before) ? before.account : null;
      if (!h || (owner && owner !== account)) throw unknown('host.momoGrant');
      if (!features.includes(MOMO_FEATURE)) {
        if (owner && fs.existsSync(path.join(storage.dir, 'grant.json'))) await grantFile.erase();
        grantNow = null;
        throw unknown('host.momoGrant');
      }
      const lapsedForMs = before.receivedAt && !live(before) ? Math.max(0, now() - (before.receivedAt + GRANT_MAX_AGE_MS)) : null;
      await grantFile.change((g) => Object.assign(g, { account, features, receivedAt: now() }));
      grantNow = null;
      return { granted: true, expiresAt: now() + GRANT_MAX_AGE_MS, lapsedForMs };
    },
    /** What this Host holds: the home record (null when none, or "unavailable" when it could not be read) and when the grant runs out. */
    status() {
      const h = readHome();
      return {
        version: 1,
        keys: storage.keys,
        grantExpiresAt: readGrant().receivedAt + GRANT_MAX_AGE_MS,
        home: !h
          ? { state: 'unavailable' }
          : h.state === 'none' && !h.movedTo
            ? null
            : {
                homeId: h.homeId,
                leaseEpoch: h.leaseEpoch,
                state: h.state,
                stateSince: h.stateSince,
                lastSeenAt: h.lastSeenAt,
                moveId: h.moveId,
                bundleHash: h.bundleHash,
                moveDeadline: h.moveDeadline,
                // sealed and past its time: the old home stays paused (the target may have switched), and says it needs the two machines asked
                moveExpired: h.state === 'moving' && h.bundleHash !== null && h.moveDeadline !== null && now() > h.moveDeadline,
                movedTo: h.movedTo,
                name: h.name,
              },
      };
    },
    /**
     * Make this Host MoMo's home. Another home refuses it (`home_exists`, naming that machine); the same home asking
     * again is answered as it is; a record that cannot be read refuses it rather than start over on top of it.
     * @param {{ name: string }} p
     */
    async start({ name }) {
      const homeId = hostId;
      const before = readHome();
      if (!before) throw new HostRefusal('home_unavailable', "MoMo's home record on this machine cannot be read, so it was left as it is.");
      await home.swap(before.leaseEpoch, (h) => {
        // a machine MoMo moved away from is not the home again by a start: the new home holds the lease, and this one would be a second
        if (h.state === 'none' && h.movedTo)
          throw new HostRefusal('home_moved', `MoMo moved to ${h.movedTo.name}.`, { name: h.movedTo.name, homeId: h.movedTo.homeId });
        if (h.state !== 'none' && h.homeId !== homeId)
          throw new HostRefusal('home_exists', `MoMo's home is ${h.name}.`, { name: h.name, homeId: h.homeId });
        if (h.state !== 'none') return false;
        Object.assign(h, { homeId, name, state: 'running', account: readGrant().account });
        return true;
      });
      home.stores();
      await home.lifecycle('start');
      return home.status();
    },
    /**
     * The one place the record changes: a compare-and-swap on the lease epoch. `change` edits the record and says whether it is a new
     * lease (the epoch moves on by one and the state clock restarts); a caller whose `expected` epoch is not the current one is
     * stale and refused, so two writers (a move and a start, two moves) never both win. A relay authority (design 3.3) replaces this
     * function and nothing else.
     * @param {number} expected the epoch the caller read
     * @param {(h: HomeRecord) => boolean | number} change true: the next epoch; a number: that epoch (a move's, which must be newer)
     */
    async swap(expected, change) {
      try {
        await homeFile.change((h) => {
          if (h.leaseEpoch !== expected)
            throw new HostRefusal('home_lease_stale', 'MoMo moved on while this was being done.', { leaseEpoch: h.leaseEpoch });
          const before = h.state;
          const fresh = change(h);
          const at = now();
          if (typeof fresh === 'number') {
            if (fresh <= h.leaseEpoch)
              throw new HostRefusal('home_lease_stale', 'That lease is not newer than this one.', { leaseEpoch: h.leaseEpoch });
            h.leaseEpoch = fresh;
          } else if (fresh) h.leaseEpoch += 1;
          if (fresh || h.state !== before) h.stateSince = at;
          h.lastSeenAt = at;
        });
      } finally {
        // a refusal means what was read is out of date too
        homeNow = null;
      }
      told();
    },
    // the services plugged into the home (./momoServiceRegistry.mjs)
    ...registry,
    /**
     * Reset MoMo on this Host: services pause and wipe, the stores let go, and every file MoMo's stores kept is deleted. The home record, the
     * grant, the chat registry and the data key stay, so the home goes on, empty. Refused while a move is under way.
     */
    async reset() {
      if (readHome()?.state === 'moving') throw new HostRefusal('move_in_progress', 'MoMo is being moved; reset it afterwards.');
      await home.lifecycle('pause');
      await home.lifecycle('wipe');
      await home.close();
      // the turn ids it held read as settled afterwards: without them an old id would read "unknown", which means "never sent, safe to send"
      const old = createMomoTurns({ dir: storage.dir, safeStorage: dataSafeStorage, now }).ids();
      await beside.voidAll(old);
      // the stage folders of a move that never finished (beside MoMo's folder and its key) go too
      for (const stage of [`${storage.dir}.incoming`, dataKeyDir ? `${dataKeyDir}.incoming` : null])
        if (stage) fs.rmSync(stage, { recursive: true, force: true });
      for (const entry of fs.existsSync(storage.dir) ? fs.readdirSync(storage.dir) : [])
        if (!RESET_KEEPS.includes(entry)) fs.rmSync(path.join(storage.dir, entry), { recursive: true, force: true });
      // the person who resets a machine MoMo moved away from means to start over on it: its tombstone goes, so it may be a home again (a new one, with its own lease)
      const kept = readHome();
      if (kept?.state === 'none' && kept.movedTo) await home.swap(kept.leaseEpoch, (r) => ((r.movedTo = null), false));
      if (home.stamp()) await home.lifecycle('start');
      return home.status();
    },
    /** The home record as kept, null when it cannot be read; a move reads it to know its own state. */
    record: readHome,
    /** The key that seals MoMo's stores and where its file is (a move copies it, a wipe deletes it), and `sealed`: one file in MoMo's folder sealed with that key, which is what a service uses for its state. */
    data: {
      safeStorage: dataSafeStorage,
      keyDir: dataKeyDir,
      /** @template T @param {string} name @param {(raw: unknown) => T} shape */
      sealed: (name, shape) => new SealedJson({ file: path.join(storage.dir, name), safeStorage: dataSafeStorage, shape, now }),
    },
    /** Stops what MoMo's chats are running right now (a move must not seal while a turn goes on acting); set by the serve entry once the chats exist. @type {() => Promise<unknown>} */
    stopTurns: async () => undefined,
    /** The turns in flight when a move begins end as interrupted: they are never replayed on the new home without asking. */
    async parkTurns() {
      // a paused home has no open stores (after a restart too): the ledger is read from its file, so a begin sent again still parks what is open
      await (stores?.turns ?? createMomoTurns({ dir: storage.dir, safeStorage: dataSafeStorage, now })).interruptOpen();
    },
    /** Whether this Host may become the home at `leaseEpoch`: it can read its record, it is no home, and the lease is newer than any it had. Throws the refusal, so a move checks it before it changes a file. @param {number} leaseEpoch */
    canAdopt(leaseEpoch) {
      const h = readHome();
      if (!h) throw new HostRefusal('home_unavailable', "MoMo's home record on this machine cannot be read, so it was left as it is.");
      if (h.state !== 'none') throw new HostRefusal('home_exists', `MoMo's home is ${h.name}.`, { name: h.name, homeId: h.homeId });
      if (!(leaseEpoch > h.leaseEpoch))
        throw new HostRefusal('home_lease_stale', 'That lease is not newer than this one.', { leaseEpoch: h.leaseEpoch });
    },
    /**
     * Take a stamp that arrived from another Host or a push: refused when it is older than the newest lease this Host has seen for a home, or at
     * the same lease from another machine (the sink, shared/momoStamp.mjs). The newest is kept across restarts. @param {unknown} stamp
     */
    receiveStamp: (stamp) => beside.receiveStamp(stamp),
    /** This Host's own clock, which a move's deadlines are measured on. */
    now,
    /** This Host's own id: what names the home on every record and receipt. */
    hostId,
    /**
     * A move arrived and was checked: this Host is the home at the lease `leaseEpoch` the move's switch made (newer than the one it
     * had, which is none), running, with the bundle's hash. Refused when this Host already is a home.
     * @param {{ homeId: string, name: string, leaseEpoch: number, bundleHash: string, moveId: string, receipt: string }} p
     */
    async adopt({ homeId, name, leaseEpoch, bundleHash, moveId, receipt }) {
      home.canAdopt(leaseEpoch);
      await home.swap(/** @type {HomeRecord} */ (readHome()).leaseEpoch, (r) => {
        Object.assign(r, {
          homeId,
          name,
          state: 'running',
          moveId,
          bundleHash,
          moveDeadline: null,
          targetSignKey: null,
          // the target's signed receipt for this switch, kept (with earlier ones) so it can be told again after a restart or a later move, whoever asks
          moveReceipts: Object.fromEntries(Object.entries({ ...r.moveReceipts, [moveId]: { leaseEpoch, receipt } }).slice(-CLOSED_KEEP)),
          movedTo: null,
          account: readGrant().account,
        });
        return leaseEpoch;
      });
      // the ids a Reset deleted came in the bundle: read them afresh
      beside.forgetCache();
      home.stores();
      await home.lifecycle('start');
    },
    /**
     * The move's last step on the old home, after its data and key were deleted: it is no home any more, at the new lease (so a stale
     * writer is refused for good), and says where MoMo went.
     * @param {{ name: string, homeId: string, leaseEpoch: number }} p
     */
    async tombstone({ name, homeId, leaseEpoch }) {
      const h = readHome();
      if (!h) throw new HostRefusal('home_unavailable', "MoMo's home record on this machine cannot be read, so it was left as it is.");
      await home.swap(h.leaseEpoch, (r) => {
        Object.assign(r, {
          homeId: null,
          name: '',
          state: 'none',
          moveId: null,
          bundleHash: null,
          moveDeadline: null,
          targetSignKey: null,
          movedTo: { name, homeId, at: now() },
        });
        return leaseEpoch;
      });
    },
    /** What an outbound action or push of this home carries: its machine and lease epoch; null when this Host is not the running home. @returns {HomeStamp | null} */
    stamp() {
      const h = readHome();
      return h?.state === 'running' && h.homeId && home.granted() ? { homeId: h.homeId, leaseEpoch: h.leaseEpoch } : null;
    },
    /**
     * Whether `stamp` is the current lease of the running home: an older epoch, another machine's id, or any stamp while the home is
     * moving or not granted is refused. @param {unknown} stamp @returns {boolean}
     */
    current(stamp) {
      const mine = home.stamp();
      const s = /** @type {any} */ (stamp);
      return !!mine && !!s && s.homeId === mine.homeId && s.leaseEpoch === mine.leaseEpoch;
    },
    /** MoMo's stores while this Host is the home and the grant is live, else null; made once, on first use. */
    stores() {
      if (!home.stamp()) return null;
      if (!stores) {
        stores = opened();
        // turns this Host accepted and never ended before it restarted did not finish (design 1: the turn ledger)
        stores.turns.recover().catch((error) => report(`MoMo's turn ledger could not be recovered: ${error.message}`));
      }
      return stores;
    },
    /**
     * A turn of a MoMo chat ended (any event path, so with no client watching): the ledger settles the chat's accepted turn, even while
     * the home is moving (a turn in flight finishes or is parked as interrupted, design 3.1).
     * @param {string} chatId @param {any} end the `turnEnd` event
     */
    turnEnded(chatId, end) {
      if (!stores || !home.chats?.isMomoChat(chatId)) return;
      stores.turns
        .settle(chatId, settledAs(end))
        // the owner's words of that turn are no longer kept (host/src/momoServices/ownerWords.mjs)
        .then(() => home.service('ownerWords')?.settled?.(chatId))
        .catch((error) => report(`MoMo's turn ledger could not settle a turn: ${error.message}`));
    },
    /** What a device asks after a lost connection: the turn as the home kept it, `unknown` when it never saw it. @param {string} turnId */
    async turn(turnId) {
      const kept = home.stores();
      if (!kept) throw new HostRefusal('momo_home_away', "MoMo's home is not running on this machine.");
      const known = kept.turns.status(turnId);
      if (/** @type {string} */ (known.state) !== 'unknown') return known;
      // a turn a Reset deleted is settled for good; one the home never saw reads unknown (a copy that arrives later is accepted once: the same id is the same turn)
      if (beside.voided(turnId)) return { turnId, state: /** @type {const} */ ('cancelled'), void: true };
      return known;
    },
    /** Whether the id belongs to a turn a Reset deleted. @param {string} turnId */
    voided: (turnId) => beside.voided(turnId),
    /** Be told when the record changes, with whether this Host is the running home now; returns the way to stop. @param {(e: { running: boolean, state: string }) => void} fn */
    watch(fn) {
      watchers.add(fn);
      return () => void watchers.delete(fn);
    },
    /** Let go of the folder (the audit log's lock) when the Host stops. */
    async close() {
      await stores?.audit.close();
      stores = null;
    },
  };
  return home;
}
