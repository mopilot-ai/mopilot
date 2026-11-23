// IPC for a machine's page (Remote Run X2) and a row's Check again: the client table, a client's removal, the audit record's last lines and the Host's status, each read from or done on the machine's own Host (electron/host/machinePageCalls.cjs). Registered by hostOwnerPolicy.cjs (`registeredBy`), which the machine page's rules and spending already go through.
const { createMachinePageCalls } = require('../../host/machinePageCalls.cjs');

/**
 * @param {object} o
 * @param {(channel: string, fn: (...args: any[]) => unknown) => void} o.handle the Host IPC's own handler (gate, error shape)
 * @param {() => { pairedFor: (id: string) => Promise<any>, selfFingerprint?: () => string, check: () => Promise<void>, startHost: (id: string) => Promise<void> }} o.service the machines service
 */
function registerMachinePage({ handle, service }) {
  const calls = createMachinePageCalls({
    pairedFor: (id) => service().pairedFor(id),
    selfFingerprint: () => service().selfFingerprint?.() ?? '',
  });
  handle('host:clients', (id) => calls.clients(String(id)));
  handle('host:removeClient', (id, fingerprint) => calls.removeClient(String(id), String(fingerprint)));
  handle('host:audit', (id) => calls.audit(String(id)));
  handle('host:hostStatus', (id) => calls.hostStatus(String(id)));
  // a machine row's Check again: every machine is asked for its status now
  handle('host:check', () => service().check());
  // a row that says its Host is not running: start it there over ssh
  handle('host:startHost', (id) => service().startHost(String(id)));
}

module.exports = { registerMachinePage, registeredBy: 'hostOwnerPolicy' };
