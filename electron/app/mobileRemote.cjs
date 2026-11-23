// Connect the opted-in account's sealed Mobile Remote channel to the shared phone service.
const { openRemote } = require('../remote/runtime.cjs');
const { accountScope } = require('../remote/accountScope.cjs');
const { gateRemote } = require('../remote/gate.cjs');
const { phoneAccess } = require('../remote/phoneAccess.cjs');

function openMobileRemote({ userData, live, safeStorage, fs }, makeRemote = openRemote) {
  const scope = () => accountScope(live.mopilot);
  let unsubscribe = () => undefined;
  live.remote = makeRemote({
    userData,
    live,
    safeStorage,
    fs,
    scope,
    // the kill switch and a signed-in account, together (electron/remote/phoneAccess.cjs)
    flagOn: phoneAccess,
    optedIn: () => live.remoteConsent.enabled(),
    confirm: (req) => live.remoteSettings?.confirm(req) ?? Promise.resolve(null),
    onChannel: (channel) => {
      const service = live.chromePanel?.service;
      if (!service) return;
      unsubscribe();
      unsubscribe = () => undefined;
      if (channel) {
        gateRemote({ service, transport: channel, enabled: () => true });
        const pairing = live.remote?.pairing;
        if (pairing) unsubscribe = pairing.onEvent((event) => live.remoteSettings?.event(pairing, event));
      } else {
        live.remoteSettings?.retire();
        service.detach();
      }
    },
  });
  void live.remote.sync();
  return live.remote;
}
module.exports = { openMobileRemote };
