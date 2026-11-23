// Mobile Remote settings are local, flag-gated and bound to the calling preload document.
const { registerRemoteWindows } = require('../../remote/settingsWindows.cjs');
const { createSettingsPairing } = require('../../remote/settingsPairing.cjs');
const { accountScope } = require('../../remote/accountScope.cjs');
const { phoneAccess } = require('../../remote/phoneAccess.cjs');
const { phoneDevices } = require('../../remote/phoneDevices.cjs');

function register(ipcMain, { live, allowed = phoneAccess }) {
  const settings = createSettingsPairing(() => live.remote?.pairing ?? null);
  live.remoteSettings = settings;
  const windows = registerRemoteWindows(ipcMain, (owner) => settings.cancel(owner));
  const owner = (event, token) => windows.owner(event, token);
  // the remote.enabled kill switch and the account's `phone` invite, together
  const visible = () => allowed();
  const scope = () => accountScope(live.mopilot);
  const enabled = () => live.remoteConsent.enabled();
  const state = (token) => ({
    visible: visible(),
    signedIn: !!scope(),
    account: live.mopilot?.creds?.user?.email ?? null,
    enabled: enabled(),
    consentWarning: live.remoteConsent.warning,
    running: !!live.remote?.running,
    // why the relay is turning this Mac away, while it is: at capacity, the account's device limit, or switched off for the account
    refusal: live.remote?.refusal ?? null,
    locked: !!live.remote?.devices?.locked,
    pairing: settings.snapshot(token),
    devices: phoneDevices(live.remote),
  });
  const handle = (channel, fn) => ipcMain.handle(channel, (event, token, ...args) => fn(owner(event, token), ...args));
  handle('remoteSettings:state', (token) => (visible() ? state(token) : { visible: false }));
  handle('remoteSettings:setEnabled', async (_token, value) => {
    if (!visible() || typeof value !== 'boolean') throw new Error('Mobile Remote is unavailable');
    const key = scope();
    if (value && !key) throw new Error('Sign in to MoPilot first');
    try {
      live.remoteConsent.set(value);
    } finally {
      await live.remote?.sync();
    }
    return true;
  });
  handle('remoteSettings:begin', (token) => {
    if (!visible() || !enabled() || live.remote?.devices?.locked) throw new Error('Mobile Remote is unavailable');
    return settings.begin(token);
  });
  handle('remoteSettings:cancel', (token) => settings.cancel(token));
  handle(
    'remoteSettings:answer',
    (token, allow) => visible() && enabled() && !live.remote?.devices?.locked && settings.answer(token, allow),
  );
  handle('remoteSettings:revoke', async (_token, id, pairId) => {
    if (!visible() || !enabled() || typeof id !== 'string' || !id || typeof pairId !== 'string' || !pairId) return false;
    return live.remote?.pairing?.unpair(id, pairId) ?? false;
  });
  // the name this Mac shows for a phone: the person's own words, for two phones that read alike
  handle('remoteSettings:rename', async (_token, id, pairId, name) => {
    if (
      !visible() ||
      !enabled() ||
      typeof id !== 'string' ||
      !id ||
      typeof pairId !== 'string' ||
      !pairId ||
      typeof name !== 'string' ||
      !name.trim()
    )
      return false;
    const device = live.remote?.devices?.get(id);
    if (!device || device.pairId !== pairId) return false;
    await live.remote.devices.rename(id, name);
    return true;
  });
  // the Mac's per-device switch for terminal and frame mirrors; a running mirror notices on its next write or frame
  handle('remoteSettings:setMirrors', async (_token, id, pairId, value) => {
    if (!visible() || !enabled() || typeof id !== 'string' || !id || typeof pairId !== 'string' || !pairId || typeof value !== 'boolean')
      return false;
    const changed = (await live.remote?.devices?.update(id, { mirrors: value }, pairId)) ?? false;
    live.chromePanel?.service?.mirror.recheck();
    return changed;
  });
}
module.exports = { register };
