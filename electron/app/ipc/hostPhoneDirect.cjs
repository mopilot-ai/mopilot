// The Mac's side of a phone's direct access, as main wires it (#2709, P2): the courier (electron/host/phoneEnroll.cjs) on the phone facade
// and the owner's switch, `host:phoneDirectList` and `host:phoneDirectSet`, behind `host.phoneDirect`.
const path = require('node:path');
const { createPhoneEnroll } = require('../../host/phoneEnroll.cjs');
const { isEnabled } = require('../../platform/flags.cjs');

/**
 * @param {object} o
 * @param {any} o.deps main's dependencies
 * @param {(channel: string, fn: (...args: any[]) => unknown) => void} o.handle the gated, error-as-value handler of Host's IPC
 * @param {() => { pairedFor: (id: string) => Promise<any> }} o.service the machines service
 * @param {() => boolean} o.allowed Host's gate
 * @param {() => void} o.changed tells the paired phones
 */
function registerPhoneDirect({ deps, handle, service, allowed, changed }) {
  const phoneDirect = createPhoneEnroll({
    file: path.join(deps.app.getPath('userData'), 'host-phone-direct.json'),
    paired: (id) => service().pairedFor(id),
    allowed: () => allowed() && isEnabled('host.phoneDirect'),
  });
  handle('host:phoneDirectList', (machineId) => phoneDirect.list(String(machineId)));
  handle('host:phoneDirectSet', async (machineId, pairId, on) => {
    if (on) phoneDirect.offer(String(machineId), String(pairId));
    else await phoneDirect.forget(String(machineId), String(pairId));
    changed();
  });
  // the phone facade (hostPhone.cjs) carries it to machines.enroll and machines.forget
  if (deps.live.hostPhone) {
    deps.live.hostPhone.phoneDirect = phoneDirect;
    // machine.hello tells a phone whether it may follow a machine's chat itself (X4)
    deps.live.hostPhone.phoneChat = { enabled: () => allowed() && isEnabled('host.phoneChat') };
  }
}

module.exports = { registerPhoneDirect, registeredBy: 'host' };
