// The Mac introduces a phone to a Host (#2709, P2): a courier. The phone mints its own relay enrollment and sends it here over the
// sealed phone channel; this registers the phone's key on the Host (`host.clientAdd`), hands the Host the enrollment
// (`host.relayEnroll`, naming the client it belongs to) and carries the Host's half back. Nothing secret is kept: the file holds only
// ids (which phone of which machine has an enrollment, and the Host's fingerprint for it) so a switch off can take both away.
const { readStoreFile, writeAtomic } = require('../platform/fsutil.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { helloParams } = require('../../shared/host/schema.mjs');

/** The DER prefix that makes a raw Ed25519 key the SPKI a Host registers. */
const ED_SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const REQUIRED = ['clients', 'relay'];

/** A refusal with a code a phone can act on. @param {string} message @param {string} code */
const refusal = (message, code) => Object.assign(new Error(message), { code });

/**
 * @param {object} o
 * @param {string} o.file where the ids are kept (plain JSON, no secret)
 * @param {(machineId: string) => Promise<{ call: (method: string, params?: object) => Promise<any>, close: () => void }>} o.paired a paired connection to the machine
 * @param {() => boolean} o.allowed whether this install may do this at all (the `host.phoneDirect` flag and Host's gate)
 */
function createPhoneEnroll({ file, paired, allowed }) {
  /** @typedef {{ hostId?: string, fingerprint?: string, offered?: boolean, forgetting?: boolean }} Entry */
  /** @type {Record<string, Record<string, Entry>> | null} */
  let cache = null;
  /** Bumped by every forget, so an enrollment that was running when the switch went off sees it. @type {Map<string, number>} */
  const epochs = new Map();
  const slot = (/** @type {string} */ machine, /** @type {string} */ pair) => `${machine}\n${pair}`;

  /** @returns {Record<string, Record<string, Entry>>} */
  function load() {
    if (cache) return cache;
    const { data, error } = readStoreFile(file, 'the phones given direct access', (d) => d !== null && typeof d === 'object');
    if (error) noteIgnored('read the phones given direct access', error);
    cache = data ?? {};
    return /** @type {Record<string, Record<string, Entry>>} */ (cache);
  }
  /** @param {string} machine @param {string} pair @param {Entry | null} entry */
  function put(machine, pair, entry) {
    const all = load();
    const { [pair]: _old, ...rest } = all[machine] ?? {};
    const next = { ...all, [machine]: entry ? { ...rest, [pair]: entry } : rest };
    if (!Object.keys(next[machine]).length) delete next[machine];
    writeAtomic(file, JSON.stringify(next), undefined, 0o600);
    cache = next;
  }
  const entryOf = (/** @type {string} */ machine, /** @type {string} */ pair) => load()[machine]?.[pair] ?? null;

  /** Takes a phone's client and relay link off the Host. @param {{ call: (m: string, p?: object) => Promise<any> }} s @param {Entry} e */
  async function dropOnHost(s, e) {
    if (e.fingerprint) await s.call('host.clientRemove', { fingerprint: e.fingerprint });
    if (e.hostId) await s.call('host.relayForget', { hostId: e.hostId });
  }

  /** Machines whose pending removals are being retried now. @type {Set<string>} */
  const retrying = new Set();

  return {
    /** Whether the feature is on (the flag and Host's gate). */
    enabled: () => allowed(),
    /** 'on': the phone has an enrollment; 'offered': the owner switched it on and the phone has not enrolled yet; 'off'. */
    stateOf(/** @type {string} */ machine, /** @type {string} */ pair) {
      const e = entryOf(machine, pair);
      if (!e || e.forgetting) return /** @type {'off'} */ ('off');
      return e.hostId ? /** @type {'on'} */ ('on') : /** @type {'offered'} */ ('offered');
    },
    /** The owner's switch on: the phone is told it may enrol. @param {string} machine @param {string} pair */
    offer(machine, pair) {
      if (!allowed()) throw refusal('Direct access is not available.', 'not_allowed');
      if (!entryOf(machine, pair)?.hostId) put(machine, pair, { offered: true });
    },
    /**
     * `machines.enroll`: registers the phone's key, hands the Host the enrollment, answers the Host's half. A failure after the client
     * was added removes it again; a switch off while this runs discards the late reply and takes the Host side away.
     * @param {string} machine @param {string} pair the phone's pair on this Mac
     * @param {{ relay: { hostId: string, secret: string, pairId: string, relayUrl: string }, appPub: string, appEphPub: string, edPub: string, name: string }} p
     * @param {string} machineName
     */
    async enroll(machine, pair, p, machineName) {
      if (!allowed()) throw refusal('Direct access is not available.', 'not_allowed');
      const key = slot(machine, pair);
      const started = epochs.get(key) ?? 0;
      const s = await paired(machine);
      try {
        const hello = await s.call('host.hello', helloParams());
        const features = Array.isArray(hello?.features) ? hello.features : [];
        // an older Host has no client table: the phone says "Update <machine>", and nothing is made
        if (!REQUIRED.every((f) => features.includes(f))) throw refusal(`Update ${machineName}.`, 'update_host');
        const { hostId: hostKey } = await s.call('host.challenge');
        const publicKey = Buffer.concat([ED_SPKI, Buffer.from(p.edPub, 'base64')]).toString('base64');
        const { fingerprint } = await s.call('host.clientAdd', { publicKey, name: p.name, kind: 'phone' });
        /** @type {any} */
        let answer;
        try {
          answer = await s.call('host.relayEnroll', { ...p.relay, appPub: p.appPub, appEphPub: p.appEphPub, client: fingerprint });
        } catch (error) {
          await s.call('host.clientRemove', { fingerprint }).catch((e) => noteIgnored('remove a phone the Host could not enrol', e));
          throw error;
        }
        const mine = { hostId: p.relay.hostId, fingerprint };
        if ((epochs.get(key) ?? 0) !== started) {
          // switched off meanwhile: the late reply is discarded and the Host side goes
          await dropOnHost(s, mine).catch((e) => noteIgnored('remove a phone switched off while it enrolled', e));
          throw refusal('Direct access was switched off.', 'cancelled');
        }
        const old = entryOf(machine, pair);
        put(machine, pair, mine);
        // a phone that enrols again keeps one enrollment: the old relay link goes
        if (old?.hostId && old.hostId !== mine.hostId)
          await dropOnHost(s, { hostId: old.hostId }).catch((e) => noteIgnored('drop a phone’s old relay link', e));
        return { hostPub: answer.hostPub, hostEphPub: answer.hostEphPub, hostKey, name: machineName, features };
      } finally {
        s.close();
      }
    },
    /**
     * `machines.forget` and the owner's switch off: the Host forgets the phone's client and link. A Host that cannot be reached is
     * remembered as still to do (`retry`), so the phone loses access as soon as it is back, whether or not the phone was online.
     * @param {string} machine @param {string} pair
     */
    async forget(machine, pair) {
      const key = slot(machine, pair);
      epochs.set(key, (epochs.get(key) ?? 0) + 1);
      const e = entryOf(machine, pair);
      if (!e) return { removed: false };
      if (!e.hostId && !e.fingerprint) return put(machine, pair, null), { removed: true };
      put(machine, pair, { ...e, forgetting: true });
      try {
        const s = await paired(machine);
        try {
          await s.call('host.hello', helloParams());
          await dropOnHost(s, e);
        } finally {
          s.close();
        }
        put(machine, pair, null);
      } catch (error) {
        noteIgnored('take a phone off a Host', error);
      }
      return { removed: true };
    },
    /** Finishes the removals a Host was away for; called when the machine is online again. @param {string} machine */
    async retry(machine) {
      const todo = Object.entries(load()[machine] ?? {}).filter(([, e]) => e.forgetting);
      if (!todo.length || retrying.has(machine)) return;
      retrying.add(machine);
      try {
        for (const [pair] of todo) await this.forget(machine, pair);
      } finally {
        retrying.delete(machine);
      }
    },
    /** Every phone of a machine and where it stands, for the Mac's switch. @param {string} machine */
    list: (machine) =>
      Object.entries(load()[machine] ?? {}).map(([pair, e]) => ({
        pairId: pair,
        fingerprint: e.fingerprint ?? null,
        state: e.forgetting ? 'off' : e.hostId ? 'on' : 'offered',
      })),
  };
}

module.exports = { createPhoneEnroll };
