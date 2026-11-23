// IPC for the owner's policy (plan U2), registered by ipc/host.cjs (`registeredBy`): the document this Mac keeps, its replacement, and the push to a machine whose connection was just made (electron/host/ownerPolicy.cjs).
const path = require('node:path');
const { createOwnerPolicy } = require('../../host/ownerPolicy.cjs');
const { noteIgnored } = require('../../ignored.cjs');
const { registerMachinePage } = require('./hostMachinePage.cjs');

/**
 * The store, made on first use, and its two channels.
 * @param {object} o
 * @param {(channel: string, fn: (...args: any[]) => unknown) => void} o.handle the Host IPC's own handler (gate, error shape)
 * @param {() => string} o.userData
 * @param {() => { hostFor?: (id: string) => any, list: () => { machines: { id: string, cloud?: { idleMinutes: number, hoursPerDay?: number | null } | null }[] } }} o.service the machines service
 * @returns {{ push: (id: string, host: any) => Promise<unknown> }}
 */
function registerOwnerPolicy({ handle, userData, service }) {
  /** @type {ReturnType<typeof createOwnerPolicy> | null} */
  let store = null;
  const owner = () =>
    (store ??= createOwnerPolicy({
      file: path.join(userData(), 'host-owner-policy.json'),
      hostFor: (id) => service().hostFor?.(id) ?? null,
      machineIds: () =>
        service()
          .list()
          .machines.map((m) => m.id),
      cloudOf: (id) =>
        service()
          .list()
          .machines.find((m) => m.id === id)?.cloud ?? null,
      report: (error) => noteIgnored('send the owner policy to a machine', error),
    }));
  // the machine page's other reads and its device removal (hostMachinePage.cjs)
  registerMachinePage({ handle, service: /** @type {any} */ (service) });
  handle('host:ownerPolicy', () => owner().get());
  handle('host:setOwnerPolicy', (doc) => owner().set(doc));
  return { push: (id, host) => owner().push(id, host) };
}

module.exports = { registerOwnerPolicy, registeredBy: 'host' };
