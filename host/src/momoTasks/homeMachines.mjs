// The user's other machines MoMo's home may use: their ids, names and the opaque link the dialer needs, sealed beside the ledger so they move with the home. A machine is here only after the owner allowed it from the app.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SealedJson } = require('../../../electron/gateway/sealedFile.cjs');

/** @typedef {{ id: string, name: string, link: string, hostId: string, needsAllow?: true }} HomeMachine the machine's own id (its Host's `host.challenge` name) is pinned when the owner allows it: a Host that answers with another one is not that machine */

const HOST_ID = /^[0-9a-f]{32}$/;

/**
 * @param {{ dir: string, safeStorage: import('../../../electron/platform/secretFile.cjs').SafeStorage, now: () => number }} o
 */
export function createHomeMachines({ dir, safeStorage, now }) {
  const name = 'task-machines.json';
  const file = new SealedJson({
    file: path.join(dir, name),
    safeStorage,
    now,
    shape: (/** @type {any} */ v) => ({
      machines: v?.machines && typeof v.machines === 'object' && !Array.isArray(v.machines) ? v.machines : {},
    }),
  });
  /** @param {string} id @param {{ name: unknown, link: unknown, hostId: unknown, needsAllow?: unknown }} m @returns {HomeMachine} */
  const of = (id, m) => ({
    id,
    name: String(m.name),
    link: String(m.link),
    hostId: String(m.hostId),
    ...(m.needsAllow ? { needsAllow: true } : {}),
  });
  /** @returns {Record<string, { name: unknown, link: unknown, hostId: unknown, needsAllow?: unknown }>} */
  const all = () => (fs.existsSync(path.join(dir, name)) ? file.read().machines : {});
  return {
    /** @returns {HomeMachine[]} */
    list: () => Object.entries(all()).map(([id, m]) => of(id, m)),
    /** @param {string} id @returns {HomeMachine | null} */
    get(id) {
      const m = Object.hasOwn(all(), id) ? all()[id] : null;
      return m ? of(id, m) : null;
    },
    /** @param {HomeMachine} machine */
    set: (machine) => {
      // an id is a key of the table: the names an object already has are never one
      if (['__proto__', 'constructor', 'prototype'].includes(machine.id)) return Promise.reject(new Error('That is not a machine id.'));
      if (!HOST_ID.test(machine.hostId)) return Promise.reject(new Error("That machine's Host id is not one MoMo can pin."));
      return file.change((/** @type {any} */ doc) => {
        doc.machines[machine.id] = { name: machine.name, link: machine.link, hostId: machine.hostId };
      });
    },
    /** A move gave this home a key of its own that no machine knows yet: every machine waits for the owner's device to allow it again. */
    needAllowAll: () =>
      file.change((/** @type {any} */ doc) => {
        for (const m of Object.values(doc.machines)) /** @type {any} */ (m).needsAllow = true;
      }),
    /** The owner's device registered the new key there. @param {string} id */
    allowed: (id) =>
      file.change((/** @type {any} */ doc) => {
        if (Object.hasOwn(doc.machines, id)) delete doc.machines[id].needsAllow;
      }),
    /** @param {string} id */
    remove: (id) =>
      file.change((/** @type {any} */ doc) => {
        delete doc.machines[id];
      }),
  };
}
