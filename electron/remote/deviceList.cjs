// The phones paired to this Mac, kept sealed by safeStorage (devices.key, 0600, written whole): id, name, public keys, pair id, each direction's ratchet state, last seen and the time the pair key was last rotated. Every change is written before it counts (an unavailable store leaves the list as it was), changes are written one at a time in the order they were made, and a pair key older than 30 days is reported to the rotation hook.
const { readSealedJson, writeSealedJson, RemoteStoreError } = require('./sealedJson.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { cleanDeviceName, MAX_NAME } = require('./deviceName.cjs');

const ROTATE_AFTER_MS = 30 * 24 * 3600_000;

/**
 * @typedef {{ ctr: number, chain: string }} RatchetState chain as hex
 * @typedef {{ id: string, name: string, pairId: string, pub: string, edPub: string, createdAt: number, rotatedAt: number,
 *   lastSeenAt: number | null, tx: RatchetState, rx: RatchetState, mirrors?: boolean }} Device mirrors: the Mac turned terminal and frame mirrors on for this phone (absent: off)
 */

const cleanName = (/** @type {unknown} */ n) => cleanDeviceName(n) || 'Phone';

class DeviceList {
  /**
   * @param {{ file: string, safe: import('./sealedJson.cjs').SafeStorage | null, fs: import('./sealedJson.cjs').FsPromises,
   *   now?: () => number, onRotationDue?: (d: Device) => unknown }} o
   */
  constructor(o) {
    this.o = o;
    this.now = o.now ?? Date.now;
    /** @type {Map<string, Device>} */
    this.devices = new Map();
    /** @type {Promise<void> | null} */
    this.loaded = null;
    this.queue = Promise.resolve();
    this.locked = false;
    this.uncertainActivation = false;
    /** @type {Set<string>} */
    this.retiredPairs = new Set();
    /** @type {Map<string, { token: object, pending: number }>} */
    this.intents = new Map();
    /** @type {Set<(list: Device[]) => void>} */
    this.listeners = new Set();
  }

  /** Reads the file once; a file that can't be opened stays an error and is never replaced. */
  load() {
    this.loaded ??= this.#read().catch((e) => {
      this.loaded = null;
      throw e;
    });
    return this.loaded;
  }

  async #read() {
    const read = await readSealedJson(this.o);
    if (!read.found) return;
    const list = read.value?.devices;
    if (read.value?.v !== 1 || !Array.isArray(list)) throw new RemoteStoreError('corrupt', 'The device list is not what this app writes');
    // names saved by an earlier version are cleaned as they are read: Settings and the terminal switch show them as stored
    for (const d of list) if (typeof d?.id === 'string') this.devices.set(d.id, { ...d, name: cleanName(d.name) });
  }

  /** @returns {Device[]} copies, oldest first */
  list() {
    return [...this.devices.values()].map((d) => structuredClone(d));
  }

  /** @param {string} id */
  get(id) {
    const d = this.devices.get(id);
    return d ? structuredClone(d) : null;
  }

  /** @param {string} pairId */
  byPair(pairId) {
    for (const d of this.devices.values()) if (d.pairId === pairId) return structuredClone(d);
    return null;
  }

  /** @param {(list: Device[]) => void} fn @returns {() => void} */
  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Adds a phone, or replaces the one with the same id (a re-pair: new pair key, counters back at zero).
   * @param {Omit<Device, 'createdAt' | 'rotatedAt' | 'lastSeenAt'> & Partial<Device>} device
   */
  add(device) {
    const at = this.now();
    return this.#intent(device.id, () =>
      this.#change((m) => {
        m.set(device.id, { createdAt: at, rotatedAt: at, lastSeenAt: null, ...device, name: cleanName(device.name) });
        return true;
      }),
    );
  }

  /** @param {string} id @param {string} name @returns {Promise<boolean>} false when the phone isn't paired */
  rename(id, name) {
    return this.#change((m) => {
      const d = m.get(id);
      if (!d) return false;
      d.name = cleanName(name);
      return true;
    });
  }

  /** Stage an inactive pair before the approved commit; a restart ignores an unfinished stage. */
  addGuarded(device, current, committing) {
    const at = this.now();
    return this.#intent(device.id, () => {
      const run = this.queue.then(async () => {
        await this.load();
        if (this.locked) throw new RemoteStoreError('unreadable', 'The device list needs recovery');
        const before = this.list();
        const next = new Map(before.map((d) => [d.id, structuredClone(d)]));
        next.set(device.id, { createdAt: at, rotatedAt: at, lastSeenAt: null, ...device, name: cleanName(device.name) });
        if (!current()) return false;
        await this.#write({ v: 1, devices: before, pending: [...next.values()] });
        if (!current()) return false;
        committing();
        try {
          await this.#write({ v: 1, devices: [...next.values()] });
        } catch (error) {
          if (!this.locked) throw error;
          this.uncertainActivation = true;
          const uncertain = new RemoteStoreError('unreadable', 'The pairing outcome is uncertain; restart and check paired devices');
          uncertain.cause = error;
          throw uncertain;
        }
        this.devices = next;
        for (const fn of this.listeners) {
          try {
            fn(this.list());
          } catch (error) {
            noteIgnored('tell a device-list listener', error);
          }
        }
        return true;
      });
      this.queue = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    });
  }

  /** Remove only the exact pair: a late relay event must not remove a replacement. */
  removePair(/** @type {string} */ id, /** @type {string} */ pairId) {
    const current = this.devices.get(id);
    if (current && current.pairId !== pairId && !this.intents.get(id)?.pending) return Promise.resolve(false);
    return this.#intent(id, () =>
      this.#change((m) => {
        if (m.get(id)?.pairId !== pairId) return false;
        return m.delete(id);
      }),
    );
  }

  /** @param {string} id @returns {Promise<boolean>} */
  remove(id) {
    return this.#intent(id, () => this.#change((m) => m.delete(id)));
  }

  /** A relay removal retires effects immediately, even if its durable deletion later fails. */
  retirePair(/** @type {string} */ pairId) {
    this.retiredPairs.add(pairId);
  }

  isRetired(/** @type {string} */ pairId) {
    return this.retiredPairs.has(pairId);
  }

  /** An effect lease is valid only while its pair remains current and no removal or replacement is pending. */
  lease(/** @type {string} */ id, /** @type {string} */ pairId) {
    const device = this.devices.get(id);
    if (this.locked || this.retiredPairs.has(pairId) || !device || device.pairId !== pairId) return null;
    let state = this.intents.get(id);
    if (!state) this.intents.set(id, (state = { token: {}, pending: 0 }));
    if (state.pending) return null;
    return { id, pairId, token: state.token };
  }

  currentLease(/** @type {{ id: string, pairId: string, token: object } | null} */ lease) {
    if (this.locked || !lease || this.retiredPairs.has(lease.pairId)) return false;
    const state = this.intents.get(lease.id);
    return !!state && !state.pending && state.token === lease.token && this.devices.get(lease.id)?.pairId === lease.pairId;
  }

  #intent(/** @type {string} */ id, /** @type {() => Promise<boolean>} */ change) {
    let state = this.intents.get(id);
    if (!state) this.intents.set(id, (state = { token: {}, pending: 0 }));
    state.token = {};
    state.pending++;
    return change().finally(() => {
      state.pending--;
      if (!state.pending && !this.devices.has(id)) this.intents.delete(id);
    });
  }

  /**
   * Merges ratchet state, last seen or a new rotation time into a phone. `pairId` names the pair the caller holds state for: a
   * re-pair gives the same phone a new pair, and the old pair's late write must not land on it (false then).
   * @param {string} id @param {Partial<Pick<Device, 'tx' | 'rx' | 'lastSeenAt' | 'rotatedAt' | 'pub' | 'edPub' | 'mirrors'>>} patch @param {string} [pairId]
   */
  update(id, patch, pairId) {
    return this.#change((m) => {
      const d = m.get(id);
      if (!d || (pairId !== undefined && d.pairId !== pairId)) return false;
      Object.assign(d, patch);
      return true;
    });
  }

  /** The phones whose pair key is 30 days old or older. */
  dueForRotation() {
    return this.list().filter((d) => this.now() - d.rotatedAt >= ROTATE_AFTER_MS);
  }

  /** Calls the rotation hook for each due phone; the hook's failure is noted and doesn't stop the others. */
  async checkRotation() {
    for (const d of this.dueForRotation()) {
      try {
        await this.o.onRotationDue?.(d);
      } catch (error) {
        noteIgnored('rotate a phone pair key', error);
      }
    }
  }

  /** A failed sealed write can have renamed its file; no effect may use the old in-memory snapshot. */
  async #write(value) {
    try {
      await writeSealedJson({ ...this.o, value });
    } catch (error) {
      if (/** @type {any} */ (error)?.renamed === true) this.locked = true;
      throw error;
    }
  }

  /**
   * One change at a time, in call order: the change is applied to a copy, written, and only then becomes the list.
   * @param {(m: Map<string, Device>) => boolean} apply
   * @returns {Promise<boolean>}
   */
  #change(apply) {
    const run = this.queue.then(async () => {
      await this.load();
      if (this.locked) throw new RemoteStoreError('unreadable', 'The device list needs recovery');
      const next = new Map([...this.devices].map(([k, v]) => [k, structuredClone(v)]));
      if (!apply(next)) return false;
      await this.#write({ v: 1, devices: [...next.values()] });
      this.devices = next;
      const snapshot = this.list();
      for (const fn of this.listeners) {
        try {
          fn(snapshot);
        } catch (error) {
          noteIgnored('tell a device-list listener', error);
        }
      }
      return true;
    });
    // the next change waits for this one whether it worked or not
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

module.exports = { DeviceList, ROTATE_AFTER_MS, MAX_NAME };
