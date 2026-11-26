// The owner's policy document on this Mac (plan U2): kept in a private file, checked with the shared parser, and sent to each machine after its connection is made and whenever it changes. The Host keeps the last copy and enforces it with the app away.
const path = require('node:path');
const { fs } = require('../platform/ports/fs.cjs');
const { writePrivate } = require('../platform/fsutil.cjs');
const { isJsonRecord } = require('../../shared/jsonRecord.mjs');
const { parseOwnerPolicy, DEFAULT_POLICY } = require('../../shared/host/policy.mjs');

/** A refusal the window shows as it is. @param {string} message */
const invalid = (message) => Object.assign(new Error(message), { code: 'invalid' });

/**
 * @param {object} o
 * @param {string} o.file where the document is kept
 * @param {(id: string) => { policy?: (p: { doc: object }) => Promise<{ generation: string }>, controlledByCode?: boolean } | null} o.hostFor a machine's connection (null when it has none); `controlledByCode`: a Mac this one only controls, which takes no policy from it
 * @param {() => string[]} o.machineIds the machines in the list
 * @param {(id: string) => { idleMinutes: number, hoursPerDay?: number | null } | null} [o.cloudOf] the cloud settings of a machine, or null for any other: only a cloud machine's document has a `cloud` block, which is what makes its Host stop itself when idle
 * @param {(error: Error) => void} o.report a push that failed for another reason than an older Host
 */
function createOwnerPolicy({ file, hostFor, machineIds, cloudOf = () => null, report }) {
  /** The stored document; a file that is missing or unreadable holds the defaults. */
  const read = () => {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      return isJsonRecord(raw) ? parseOwnerPolicy(raw, invalid) : parseOwnerPolicy({ version: DEFAULT_POLICY.version }, invalid);
    } catch {
      return parseOwnerPolicy({ version: DEFAULT_POLICY.version }, invalid);
    }
  };
  /** @param {string} id @param {{ policy?: (p: { doc: object }) => Promise<{ generation: string }>, controlledByCode?: boolean } | null} [given] a connection being made (asking `hostFor` for it then would make another), waited for until it answers @returns {Promise<{ id: string, ok: boolean, generation?: string, code?: string }>} */
  async function push(id, given) {
    const host = given ?? hostFor(id);
    if (!host?.policy) return { id, ok: false, code: 'offline' };
    try {
      // a connection just made is not up, and nothing else brings it up: the document goes when it answers (a machine that is away is sent it when it is next reached)
      if (given) await /** @type {any} */ (given).connect?.();
      const cloud = cloudOf(id);
      const { generation } = await host.policy({
        doc: cloud
          ? { ...read(), cloud: { idleMinutes: cloud.idleMinutes, ...(cloud.hoursPerDay ? { hoursPerDay: cloud.hoursPerDay } : {}) } }
          : read(),
      });
      return { id, ok: true, generation };
    } catch (error) {
      const code = /** @type {any} */ (error)?.code ?? 'failed';
      // an older Host keeps no policy, and a Mac this one only controls (paired by code) takes none from it: nothing to send, nothing to
      // report; a `forbidden` from any other Mac is a real refusal and is reported
      if (code !== 'feature_missing' && !(code === 'forbidden' && host.controlledByCode)) report(/** @type {Error} */ (error));
      return { id, ok: false, code };
    }
  }
  return {
    /** The owner's document now. */
    get: read,
    /** Keeps a new document (refused whole when invalid) and sends it to every machine; a machine that is away gets it when its connection is next made. @param {unknown} doc */
    async set(doc) {
      const clean = parseOwnerPolicy(doc, invalid);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      writePrivate(file, JSON.stringify(clean));
      return { doc: clean, machines: await Promise.all(machineIds().map((id) => push(id))) };
    },
    /** Sends the document to one machine, as its connection is made. */
    push,
  };
}

module.exports = { createOwnerPolicy };
