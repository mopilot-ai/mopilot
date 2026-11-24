// What a `home` client (MoMo's home on another of the user's machines) may do on THIS Host: a short allow-list for task chats it started, the lease stamp every request carries, only "Ask for approval" or read-only modes on agents whose mode this Host enforces, and its standing taken away at once, with its sessions fully stopped, when its key is removed.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createStampSink } from '../../shared/momoStamp.mjs';
import { hostPermissionFamily } from '../../shared/host/permissions.mjs';
import { HostRefusal } from './hostFs.mjs';
import { MOMO_FORM } from './momoChats.mjs';
import { createFileSafeStorage } from './secretStore.mjs';
import { hostLinkOn } from './hostLinkFlag.mjs';
import { createFlight, createMarkers, floorOf, repairWhat, stopUnder, trimAside } from './homeGateParts.mjs';

const require = createRequire(import.meta.url);
const { SealedJson } = require('../../electron/gateway/sealedFile.cjs');

/** The requests a home may make: the handshake, the machine's status (which agents are ready), and the chat requests of a task session it started. Nothing else exists for it. */
export const HOME_METHODS = Object.freeze([
  'host.hello',
  'host.status',
  'chat.start',
  'chat.send',
  'chat.stop',
  'chat.subscribe',
  'chat.history',
]);
/** The chat requests that name a task session, which must be one this home started. */
const TASK_METHODS = new Set(['chat.send', 'chat.stop', 'chat.subscribe', 'chat.history']);
/** The only modes a home may start a session in, whatever this machine's own default is. */
export const HOME_MODES = Object.freeze(['default', 'read-only']);
/** What a start may not carry: another agent's session as parent, a borrowed credential, a looser plan base. */
const START_FORBIDDEN = ['sideChat', 'credential', 'planBase', 'goal', 'images', 'files', 'attachments', 'skills'];
/** What a follow-up may not carry: the text is all of it (no goal, files, steering, or another model). */
const SEND_FORBIDDEN = ['sideChat', 'goal', 'images', 'files', 'attachments', 'skills', 'followUp', 'model', 'effort'];
const CHAT_ID = /^[A-Za-z0-9:_.-]{1,200}$/;
/** How many task sessions one Host remembers by default: a start past this is refused, a session in use is never forgotten to make room. */
export const CAP = 1000;
/** How long a start that never became a session is remembered. */
export const PENDING_MS = 10 * 60_000;
/** The most a home's lease may move past the newest this Host has seen in one step: a stamp far ahead would fence out the real home for good. A move is +1 and an owner's reclaim +2, but this Host may have been off or out of reach through several of them, and refusing its true home then would need the owner to Allow again; 16 covers that and still bounds what a compromised home can do (it cannot jump to 2^53-1), and removing the home lets the lease go. */
export const MAX_LEASE_STEP = 16;
/** The highest lease epoch ever believed, the first stamp included. */
export const MAX_LEASE = 10_000;
/** How many of a home's task sessions may run at once on this machine. */
export const MAX_RUNNING = 4;
/** How long a session that is no longer running stays in the table (its approval cards keep saying who started it). */
/** How long a removed home's sessions are given before they are stopped once more. */
export const SETTLE_MS = 1500;
export const ENDED_MS = 24 * 60 * 60_000;

/** What a home is told of a machine's status: which agents are there and how ready they are, and nothing of this machine's policy, spend, push, updates or network. @param {any} status */
export const homeStatus = (status) => ({ harnesses: Array.isArray(status?.harnesses) ? status.harnesses : [] });

/** @typedef {{ id: string, fingerprint: string, name: string, cwd: string, at: number }} Task */
/** @typedef {{ newest: { homeId: string, leaseEpoch: number, by: string | null, was?: string | null } | null, chats: Task[] }} State */

// Why this state is NOT in MoMo's data folder and not sealed with MoMo's data key: it is the newest lease THIS Host has seen and the task chats THIS Host was asked to run. It belongs to the machine (a fence kept per Host, like `stamps.json` in the home's HOST_OWN list), so a home move must never carry it: a Host that took the old home's lease with it would believe a stale home again. It is sealed with this Host's own key and written durably.
/**
 * @param {object} o
 * @param {string} o.configDir the Host's config folder, where `home-link.json` (sealed with the Host's own key) lives
 * @param {string} o.workDir where each task's folder is made (a folder of its own per task, chosen here, never by the home)
 * @param {(fingerprint: string) => boolean} o.knows whether a client is still registered
 * @param {(chatId: string) => boolean} o.known whether this Host has ever had a chat with that id (loaded now, or kept on disk)
 * @param {(chatId: string) => unknown} o.stop stops a chat the way a person's Stop does (its cards, its tool calls, its turn)
 * @param {(message: string) => void} o.report
 * @param {() => number} o.now
 * @param {number} o.cap how many task sessions are remembered at most
 * @param {() => boolean} o.enabled whether MoMo may use this machine at all (the host-link switch)
 * @param {(chatId: string) => boolean} o.active whether a chat has a turn running or waiting now
 * @param {(chatId: string) => string | undefined} o.modeOf the permission mode a chat was last set to, by anyone
 * @param {{ note: (e: any) => unknown }} [o.audit] the Host's audit record: a lease handed over or let go is a line
 * @param {number} o.settleMs how long a removed home's sessions are given before they are stopped once more (a start in flight lands in that time)
 */
export function createHomeGate({
  configDir,
  workDir,
  knows,
  known,
  stop,
  report,
  now,
  cap,
  enabled,
  active,
  modeOf,
  settleMs,
  audit = { note: () => undefined },
}) {
  const name = 'home-link.json';
  /** @param {any} v @returns {State} */
  const shape = (v) => ({
    // `by` is the key that holds the lease; none (null) is a floor: the key that held it was removed, or the file is from before keys were recorded, and the epoch stays as a fence nobody holds
    newest:
      v?.newest && typeof v.newest.homeId === 'string' && Number.isSafeInteger(v.newest.leaseEpoch)
        ? {
            homeId: v.newest.homeId,
            leaseEpoch: v.newest.leaseEpoch,
            by: typeof v.newest.by === 'string' ? v.newest.by : null,
            was: typeof v.newest.was === 'string' ? v.newest.was : null,
          }
        : null,
    chats: Array.isArray(v?.chats)
      ? v.chats.filter((/** @type {any} */ c) => c && typeof c.id === 'string' && typeof c.fingerprint === 'string')
      : [],
  });
  const file = new SealedJson({ file: path.join(configDir, name), safeStorage: createFileSafeStorage(configDir), shape, now });
  /** The highest lease this Host has seen, in a file of its own that a repair keeps: it is the fence a damaged state leaves behind. */
  const floorFile = new SealedJson({
    file: path.join(configDir, 'home-floor.json'),
    safeStorage: createFileSafeStorage(configDir),
    shape: (/** @type {any} */ v) => ({
      newest:
        typeof v?.newest?.homeId === 'string' && Number.isSafeInteger(v.newest.leaseEpoch)
          ? { homeId: v.newest.homeId, leaseEpoch: v.newest.leaseEpoch }
          : null,
    }),
    now,
  });
  /** @type {State | null} */
  let mem = null;
  /** The state could not be read: nothing is allowed for a home until the owner's device repairs it, and a file the reader set aside does not make the next read look clean. */
  let damaged = false;
  /** The state as it is now, read once; one that cannot be read allows nothing. @returns {State} */
  const state = () => {
    if (mem) return mem;
    if (damaged) throw new HostRefusal('home_state_unreadable', "MoMo's permissions on this machine can't be read.");
    try {
      const read = fs.existsSync(path.join(configDir, name)) ? file.read() : shape(null);
      // a file that was set aside as unreadable is not an empty record: the fence it held is unknown, so nothing is allowed
      if (file.setAside) throw new Error('unreadable');
      // a holder whose key is no longer registered (removed while this Host was down) holds nothing: the lease is a floor, remembered as that key's
      if (read.newest?.by && !knows(read.newest.by)) read.newest = { ...read.newest, was: read.newest.by, by: null };
      return (mem = read);
    } catch {
      damaged = true;
      trimAside(configDir, [name, 'home-floor.json']);
      throw new HostRefusal('home_state_unreadable', 'This machine cannot read what MoMo may do here, so it allows nothing until it can.');
    }
  };
  /** Keeps the state as it is now, durably. */
  const persist = () =>
    file.change((/** @type {State} */ doc) => {
      const now = /** @type {State} */ (mem);
      doc.newest = now.newest;
      doc.chats = now.chats;
    });
  /** Remembers the highest lease seen beside the state, so a repair can start from it. */
  const keepFloor = () =>
    floorFile.change((/** @type {{ newest: { homeId: string, leaseEpoch: number } | null }} */ doc) => {
      const n = state().newest;
      if (n && n.leaseEpoch > 0 && (!doc.newest || n.leaseEpoch > doc.newest.leaseEpoch))
        doc.newest = { homeId: n.homeId, leaseEpoch: n.leaseEpoch };
    });
  /** The write the last accepted stamp started: the answer waits for it, so a restart cannot forget a lease it said yes to. @type {Promise<unknown> | null} */
  let keeping = null;
  /** The key whose request is being counted, so the lease it advances is kept under it. @type {string | null} */
  let accepting = null;
  const sink = createStampSink({
    read: () => state().newest,
    write: (newest) => {
      state().newest = { ...newest, by: accepting, was: null };
      keeping = persist().then(keepFloor);
    },
  });
  const forbidden = (/** @type {string} */ message) => new HostRefusal('home_not_allowed', message);

  /**
   * Counts a stamp against the newest lease this Host has seen. A lease is held by the key that advanced it. The holder may move it by a few moves. While the holder is registered here, a request above the lease from any other key is refused (`home_lease_held`), not clamped. A lease nobody holds (its holder's key was removed, or the file is from before keys were recorded) is a floor: every request above it is refused (`home_lease_unassigned`) until the owner's device registers a key as the old one's successor (`successor`), so the first key to ask never wins by timing. An epoch below the lease is stale for every key, and the lease's own epoch is no change.
   * @param {any} stamp @param {string} fingerprint the key that sent it
   */
  function checkStamp(stamp, fingerprint) {
    const newest = state().newest;
    const epoch = stamp?.leaseEpoch;
    if (Number.isSafeInteger(epoch) && newest && epoch > newest.leaseEpoch) {
      const holder = newest.by && knows(newest.by) ? newest.by : null;
      if (!holder)
        throw new HostRefusal(
          'home_lease_unassigned',
          'MoMo has no key allowed to hold the lease on this machine. Allow MoMo again from your own device.',
        );
      if (holder !== fingerprint)
        throw new HostRefusal('home_lease_held', 'Another MoMo key holds the lease on this machine, so this request is refused.');
    }
    // a floor of 0 is a lease nobody can name (the state was repaired and its fence could not be read): any real lease is believed once an owner names a holder
    const reach = newest && newest.leaseEpoch > 0 ? newest.leaseEpoch + MAX_LEASE_STEP : MAX_LEASE;
    if (Number.isSafeInteger(epoch) && (epoch > MAX_LEASE || epoch > reach))
      throw new HostRefusal('home_lease_jump', 'MoMo asked with a lease far ahead of the one this machine knows, so it is not believed.');
    accepting = fingerprint;
    const r = sink.accept(stamp);
    if (r.ok) return;
    if (r.reason === 'not-a-stamp') throw new HostRefusal('home_stamp_missing', 'This request does not say which MoMo home it comes from.');
    throw new HostRefusal('home_lease_stale', 'MoMo moved to another machine. This one no longer acts for it here.', {
      leaseEpoch: r.newest?.leaseEpoch,
    });
  }

  /** Stops each task as a person's Stop does, then forgets the ones that stopped (unless `forget` is false); one that could not stop stays recorded, so a sweep tries it again. A start that never became a session (the protocol refused it) is forgotten without a word, and one `done` already stopped is not stopped again unless it runs. @param {Task[]} tasks @param {boolean} [forget] @param {Set<string>} [done] */
  async function stopAll(tasks, forget = true, done = new Set()) {
    let stopped = 0;
    for (const task of tasks) {
      if (!known(task.id) || (done.has(task.id) && !active(task.id))) {
        if (forget) state().chats = state().chats.filter((c) => c.id !== task.id);
        continue;
      }
      try {
        await stop(task.id);
        stopped++;
        done.add(task.id);
        if (forget) state().chats = state().chats.filter((c) => c.id !== task.id);
      } catch (e) {
        report(`A MoMo task session could not be stopped after its home was removed: ${e instanceof Error ? e.message : e}`);
      }
    }
    return stopped;
  }

  /** Homes whose key was removed and whose sessions are being stopped: nothing of theirs is admitted meanwhile. @type {Set<string>} */
  const revoked = new Set();
  /** The requests of each home being admitted now, so a removal waits for them. @type {Map<string, Set<Promise<unknown>>>} */
  const admitting = new Map();
  /** Whether the home is still this Host's to serve (not removed, not being removed). @param {string} fingerprint */
  const standing = (fingerprint) => knows(fingerprint) && !revoked.has(fingerprint);
  /** The sessions of a home that are running or starting now. @param {string} fingerprint */
  const running = (fingerprint) =>
    state().chats.filter((c) => c.fingerprint === fingerprint && (active(c.id) || (!known(c.id) && now() - c.at < PENDING_MS))).length;

  /** A start, or a message to a session with no turn running, would be one more running: refused at the limit. @param {string} chatId @param {string} fingerprint */
  function tooMany(chatId, fingerprint) {
    if (!active(chatId) && running(fingerprint) >= MAX_RUNNING)
      throw new HostRefusal('home_too_many', `MoMo already has ${MAX_RUNNING} tasks running on this machine.`, { key: 'running' });
  }

  let repaired = { stopped: 0, unverified: 0 };
  const flight = createFlight({ now }),
    markers = createMarkers(configDir);

  /** @type {any} */
  const gate = {
    /**
     * What a request of a `home` client may run as, or the refusal. Any other client passes unchanged. Read from the raw request (the parsers drop what they do not know, so the stamp is not in the parsed one), and rebuilt from what a home needs: a hello carries no `moved` list and a status no sign-in hosts.
     * @param {{ fingerprint: string, name: string, kind: string } | null | undefined} principal @param {string} method @param {any} raw
     */
    async admit(principal, method, raw) {
      if (principal?.kind !== 'home') return raw;
      const fp = principal.fingerprint;
      const run = gate.admitNow(principal, method, raw);
      const set = admitting.get(fp) ?? new Set();
      admitting.set(fp, set);
      set.add(run);
      try {
        return await run;
      } finally {
        set.delete(run);
      }
    },
    /** @param {{ fingerprint: string, name: string, kind: string }} principal @param {string} method @param {any} raw */
    async admitNow(principal, method, raw) {
      if (!enabled()) throw forbidden('MoMo is not set up to use this machine.');
      if (!HOME_METHODS.includes(method)) throw forbidden('MoMo may not do that on this machine.');
      if (!standing(principal.fingerprint)) throw forbidden('MoMo was removed from this machine.');
      checkStamp(raw?.home, principal.fingerprint);
      await keeping;
      const { home: _stamp, human: _human, ...params } = raw;
      // a home is not an app: it never says which chats moved away from this Host (that would retire the owner's own chats)
      if (method === 'host.hello')
        return {
          ...(params.protocol === undefined ? {} : { protocol: params.protocol }),
          ...(params.features === undefined ? {} : { features: params.features }),
        };
      if (method === 'host.status') return {};
      const chatId = params.chatId;
      if (typeof chatId !== 'string' || !CHAT_ID.test(chatId)) throw forbidden('That is not a task session.');
      const own = state().chats.find((c) => c.id === chatId);
      if (TASK_METHODS.has(method)) {
        if (own?.fingerprint !== principal.fingerprint) throw forbidden('That session was not started by MoMo here.');
        if (method !== 'chat.send') return params;
        for (const field of SEND_FORBIDDEN) if (params[field] != null) throw forbidden('A follow-up is its text and nothing else.');
        // a message to an idle session starts a turn: it counts toward the limit like a start
        tooMany(chatId, principal.fingerprint);
        // another device of the owner raised this session's mode: MoMo does not feed a session it no longer holds to Ask for approval
        if (modeOf(chatId) !== undefined && !HOME_MODES.includes(/** @type {string} */ (modeOf(chatId))))
          throw new HostRefusal('home_mode_changed', "This session's mode was raised on this machine, so MoMo can no longer send to it.");
        return { ...params, cwd: own.cwd };
      }
      // chat.start: a new chat of this home's own, or the replay of its own earlier start (the ledger answers a repeated key)
      if (own && own.fingerprint !== principal.fingerprint) throw forbidden('That session belongs to another client.');
      if (!own && (known(chatId) || MOMO_FORM.test(chatId))) throw forbidden('That session already exists on this machine.');
      if (!HOME_MODES.includes(params.permission))
        throw new HostRefusal(
          'home_mode_refused',
          'MoMo may start tasks here only in "Ask for approval" or read-only, never with more access.',
          {
            key: 'permission',
          },
        );
      // a mode MoMo asks for must be one this Host holds the agent to: only the first-tier agents' modes are enforced here
      if (typeof params.harness !== 'string' || !hostPermissionFamily(params.harness))
        throw forbidden("This machine can't hold that agent to the mode MoMo asks for, so it does not start it.");
      for (const field of START_FORBIDDEN) if (params[field] != null) throw forbidden('A task starts with its brief and nothing else.');
      if (own) tooMany(chatId, principal.fingerprint);
      const cwd = own?.cwd ?? path.join(workDir, crypto.createHash('sha256').update(chatId).digest('hex').slice(0, 32));
      if (!own) {
        const s = state();
        // a start that never became a session is forgotten after a while, and so is one that ended a day ago; a session in use never is
        s.chats = s.chats.filter((c) => (known(c.id) ? active(c.id) || now() - c.at < ENDED_MS : now() - c.at < PENDING_MS));
        tooMany(chatId, principal.fingerprint);
        if (s.chats.length >= cap) throw forbidden('MoMo has too many task sessions on this machine to start another.');
        try {
          fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
          markers.write(cwd, chatId);
        } catch {
          // the path of this machine's folders is not told to a home
          throw forbidden('This machine could not make a folder for the task.');
        }
        s.chats.push({ id: chatId, fingerprint: principal.fingerprint, name: principal.name, cwd, at: now() });
        await persist();
        // removed while the record was being kept: nothing of it stays, and nothing starts
        if (!standing(principal.fingerprint)) {
          s.chats = s.chats.filter((c) => c.id !== chatId);
          await persist();
          throw forbidden('MoMo was removed from this machine.');
        }
      }
      return { ...params, cwd };
    },
    /**
     * A `chat.start` of a home is with the protocol: the answer says how it ended. A start the protocol refused drops what the gate recorded for it, but only when no other start of that chat is still landing (a replay that is refused must not unrecord the start before it), so a start that does not become a session holds no slot.
     * @param {string} fingerprint @param {unknown} chatId @returns {(ok: boolean) => Promise<void>}
     */
    landing(fingerprint, chatId) {
      if (typeof chatId !== 'string') return async () => undefined;
      const end = flight.begin(chatId, fingerprint);
      return async (ok) => {
        const others = end();
        const own = ok || others ? undefined : state().chats.find((c) => c.id === chatId && c.fingerprint === fingerprint);
        if (!own || known(own.id)) return;
        state().chats = state().chats.filter((c) => c !== own);
        fs.rmSync(own.cwd, { recursive: true, force: true });
        markers.remove(own.cwd);
        await persist();
      };
    },
    /** Whether MoMo's permissions on this machine can be read: a damaged state is a problem the owner's device sees and repairs, and it refuses home clients only. */
    health() {
      try {
        state();
        return 'ok';
      } catch {
        return 'unreadable';
      }
    },
    /**
     * The owner's device (or the local command line) sets the damaged state aside and starts with no home allowed, from the highest lease this Host had seen (a floor nobody holds; an unreadable floor is a lease nobody can name until an owner names a holder). The file is judged again now: one that reads is left alone. What still runs under the task folder is stopped, since the record that named it is gone.
     * @param {{ fingerprint: string, name: string, kind: string }} [by]
     */
    async repair(by = { fingerprint: '', name: '', kind: 'cli' }) {
      const path_ = path.join(configDir, name);
      const aside = file.setAside;
      const existed = fs.existsSync(path_);
      // judged now, not by what was seen before: a file put right since then is not touched
      damaged = false;
      mem = null;
      file.setAside = null;
      try {
        state();
      } catch {
        // still unreadable
      }
      if (!damaged && (existed || !aside)) return false;
      if (fs.existsSync(path_)) fs.renameSync(path_, `${path_}.damaged-${now()}`);
      const floor = floorOf(floorFile);
      mem = shape(null);
      if (floor) mem.newest = { ...floor, by: null, was: null };
      else if (floor === undefined) mem.newest = { homeId: '-', leaseEpoch: 0, by: null, was: null };
      damaged = false;
      file.setAside = null;
      await persist();
      trimAside(configDir, [name, 'home-floor.json']);
      repaired = await stopUnder({ workDir, markers, known, stop, report });
      audit.note({ kind: 'lease.repaired', by, what: repairWhat(repaired) });
      return true;
    },
    /** What the last repair did: the sessions it stopped, and the markers it could not trust (sessions that may still run). */
    lastRepair: () => repaired,
    /** Who started a chat, for the approval card that says "started by MoMo, from <home>"; null for any other chat. @param {string} chatId */
    startedBy(chatId) {
      try {
        const own = state().chats.find((c) => c.id === chatId);
        return own ? { kind: 'momo', home: own.name } : null;
      } catch {
        // a card is still shown without the line; the gate itself fails closed
        return null;
      }
    },
    /** The home's key was removed: what it started is stopped in full, then forgotten, and the lease it advanced is let go (the owner's next Allow starts clean). Answers how many sessions stopped. @param {string} fingerprint */
    async revoke(fingerprint) {
      revoked.add(fingerprint);
      try {
        // a request already past the check, and a start the protocol is still working on, finish first, so every session they make is on the table
        await Promise.allSettled([...(admitting.get(fingerprint) ?? [])]).then(() => flight.settled(fingerprint));
        const mine = () => state().chats.filter((c) => c.fingerprint === fingerprint);
        const done = new Set(),
          held = mine().length > 0 || state().newest?.by === fingerprint;
        const stopped = await stopAll(mine(), false, done);
        // a start that was running while this was: it lands in the next moments, and is stopped again
        if (settleMs > 0) await new Promise((r) => setTimeout(r, settleMs));
        await stopAll(mine(), true, done);
        // the lease this key held stays as a floor nobody holds (older keys stay stale); another key's removal does not touch it
        const lease = state().newest;
        if (lease?.by === fingerprint) {
          state().newest = { ...lease, by: null, was: fingerprint };
          audit.note({ kind: 'lease.floor', by: { fingerprint, name: '', kind: 'home' }, what: { status: 'floor' } });
        }
        // a key that held nothing here leaves no mark on disk (and a Host with the switch off makes no file)
        if (held) await persist();
        return stopped;
      } finally {
        revoked.delete(fingerprint);
      }
    },
    /** After the Host's sessions are recovered: sessions of a home that was removed while this Host was down stop too. @param {(fingerprint: string) => boolean} knowsNow */
    async sweep(knowsNow) {
      try {
        const gone = state().chats.filter((c) => !knowsNow(c.fingerprint));
        const stopped = await stopAll(gone);
        if (gone.length > 0) await persist();
        return stopped;
      } catch (e) {
        // never fails the Host's start: a state that cannot be read allows nothing, and says so
        report(`MoMo home sessions: ${String(/** @type {any} */ (e)?.message ?? e)}`);
        return 0;
      }
    },
    /**
     * The owner's device registered a MoMo home key and said which key it succeeds (the move flow: it registers the new home's key and removes the old one's, in either order): when that is the key that holds the lease, or held it and was removed, the new key holds it from the same epoch. `floor` names a lease nobody holds. Any other claim changes nothing.
     * @param {string} fingerprint the new key @param {string | undefined} succeeds
     */
    async successor(fingerprint, succeeds) {
      const lease = state().newest;
      if (!succeeds || !lease) return false;
      const holds = lease.by === succeeds || (!lease.by && (lease.was === succeeds || succeeds === 'floor'));
      if (!holds) return false;
      state().newest = { ...lease, by: fingerprint, was: null };
      await persist();
      audit.note({ kind: 'lease.handed', by: { fingerprint, name: '', kind: 'home' }, what: { succeeds, status: 'handed' } });
      return true;
    },
    /** The owner's device allowed this key again while its removal was still being finished: it is no longer refused as removed. @param {string} fingerprint */
    allowedAgain: (fingerprint) => void revoked.delete(fingerprint),
    /** The newest lease this Host has seen. */
    newest: () => state().newest,
  };
  return gate;
}

/**
 * The gate over this Host's parts: each task's folder beside the data dir, a chat known from the sessions or the epoch table, the full Stop, and the end of a home's sessions when its key is forgotten (by the owner, the CLI or a signed revocation). Start `sweep` once the Host's sessions are recovered.
 * @param {{ paths: { configDir: string, dataDir: string }, pairing: { stillKnows: (fingerprint: string) => boolean, onAdded: (fn: (fingerprint: string, kind: string, succeeds: string | undefined) => Promise<unknown> | undefined | void) => void, onForgotten: (fn: (fingerprint: string, kind: string) => void) => void }, sessions: { state: { has: (chatId: string) => boolean, get: (chatId: string) => { turn?: string } } }, epochs: { current: (chatId: string) => number }, policy: { modeOf: (chatId: string) => string | undefined }, audit: { note: (e: any) => unknown }, report: (message: string) => void }} o
 */
export function homeGateFor({ paths, pairing, sessions, epochs, policy, audit, report }) {
  /** The protocol, given once the Host's sessions are recovered (`sweep`): a removal before then has nothing running to stop. @type {{ asHost: (method: 'chat.stop', p: { chatId: string }) => unknown } | null} */
  let host = null;
  const gate = createHomeGate({
    configDir: paths.configDir,
    // outside the data dir: a default-mode agent can read beside its folder, and the journals and ledgers are not to be there
    workDir: path.join(path.dirname(paths.dataDir), `${path.basename(paths.dataDir)}-momo-tasks`),
    knows: pairing.stillKnows,
    known: (chatId) => sessions.state.has(chatId) || epochs.current(chatId) > 0,
    stop: (chatId) => /** @type {NonNullable<typeof host>} */ (host).asHost('chat.stop', { chatId }),
    report,
    now: Date.now,
    cap: CAP,
    enabled: () => hostLinkOn(),
    active: (chatId) => sessions.state.has(chatId) && ['running', 'awaitingUser'].includes(String(sessions.state.get(chatId).turn)),
    modeOf: (chatId) => policy.modeOf(chatId),
    settleMs: SETTLE_MS,
    audit,
  });
  pairing.onForgotten(
    (fingerprint, kind) =>
      void (kind === 'home' && gate.revoke(fingerprint).catch((/** @type {any} */ e) => report(`MoMo home sessions: ${e.message}`))),
  );
  pairing.onAdded((fingerprint, kind, succeeds) =>
    kind === 'home' && (gate.allowedAgain(fingerprint), succeeds)
      ? gate.successor(fingerprint, succeeds).catch((/** @type {any} */ e) => {
          report(`MoMo home sessions: ${e.message}`);
          throw e;
        })
      : undefined,
  );
  const sweep = gate.sweep;
  /** After the Host's sessions are recovered, with the protocol that stops them as a person's Stop does. @param {(fingerprint: string) => boolean} knowsNow @param {NonNullable<typeof host>} protocol */
  gate.sweep = (knowsNow, protocol) => ((host = protocol), sweep(knowsNow));
  return gate;
}
