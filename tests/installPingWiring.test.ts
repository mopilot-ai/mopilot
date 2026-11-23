// Main's install ping wiring: built with usage data from the same channel, token and dev-build gate, given the
// app version and the sign-in state, and started once startup has the sign-in loaded.
import { after, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { loadMain, unloadMain } from './support/electron-main-harness.ts';

after(() => unloadMain());

test('the install ping is built beside usage data and started at startup', async (test) => {
  const h = await loadMain({
    state: { prefs: { updateChannel: 'beta' } },
    before: (h: any) => {
      h.mods['electron/support/installPing.cjs'] = { InstallPing: h.cls('InstallPing') };
      h.mod('platform/install.cjs').reportsToService.mock.mockImplementation((packaged: boolean) => !packaged);
    },
  });
  test.after(() => h.app.emit('will-quit'));
  const p = h.one('InstallPing');
  const t = h.one('Telemetry');
  assert.equal(p.opts.installId, 'install-1');
  assert.equal(p.opts.sharing(), t.consent, 'the usage-data choice in effect');
  assert.equal(p.opts.userData, h.userData);
  assert.equal(p.opts.version, '1.2.3');
  assert.equal(t.opts.version, '1.2.3');
  assert.equal(p.opts.reports, true, 'the gate is read from app.isPackaged');
  assert.equal(t.opts.reports, true);
  assert.equal(p.opts.channel, t.opts.channel);
  assert.equal(p.opts.accessToken, t.opts.accessToken);
  assert.equal(p.opts.signedIn(), null, 'the sign-in state is unknown until the account service exists');
  assert.equal(t.opts.account(), null);
  assert.equal(t.opts.owner(), null);
  assert.equal(t.opts.scope(), null);
  assert.equal(p.start.mock.callCount(), 0);
  await h.ready();
  assert.equal(p.start.mock.callCount(), 1, JSON.stringify(t.error.mock.calls.map((call: any) => call.arguments)));
  h.one('MoPilotAccount').status.mock.mockImplementation(() => ({ signedIn: true, user: null }));
  assert.equal(p.opts.signedIn(), true, 'then the account service says');
  const account = h.one('MoPilotAccount');
  const creds = { user: { id: 'u1' }, deviceId: 'device-1' };
  account.creds = creds;
  account.status.mock.mockImplementation(() => ({ signedIn: true, user: creds.user }));
  assert.equal(t.opts.account(), 'u1');
  assert.equal(t.opts.owner(), creds, 'the credential object is the stable lifetime owner, not a copied status record');
  assert.equal(t.opts.scope(), JSON.stringify(['u1', 'device-1']));
  t.identityChanged = mock.fn();
  account.opts.broadcast(account.status());
  assert.equal(t.identityChanged.mock.callCount(), 1, 'credential installation retires product work before further reads');
  const publications = () => h.windows.flatMap((w: any) => w.webContents.sent).filter(([topic]: any[]) => topic === 'mopilot:event').length;
  const before = publications();
  t.identityChanged = mock.fn(() => {
    throw new Error('optional observer broken');
  });
  assert.doesNotThrow(() => account.opts.broadcast(account.status()));
  assert.ok(publications() > before, 'an optional observer failure cannot suppress the account publication');
});
