// The real owned preload and Settings IPC preserve the pair shown to the user across replacement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { rig } from './support/remotePairingRig.ts';
import { makePhone, helloFor } from './support/remotePhone.ts';
const require = createRequire(import.meta.url);
const { createConsent } = require('../electron/remote/consent.cjs');
const { register } = require('../electron/app/ipc/remoteSettings.cjs');
const { buildApi } = require('../electron/bridge/spec.cjs');
const spec = require('../electron/bridge/remoteSettings.cjs');

test('a stale Settings removal cannot delete or invalidate a newer pairing', async () => {
  const r = rig();
  const phone = makePhone();
  const begun = await r.svc.begin();
  await r.svc.handleHello(helloFor(phone, begun.payload));
  const previous = r.devices.get(phone.id);
  const handles = new Map<string, Function>();
  const listeners = new Map<string, Function>();
  const live: any = { mopilot: { creds: { user: { id: 'u' }, deviceId: 'd' } }, remote: { devices: r.devices, pairing: r.svc } };
  live.remoteConsent = createConsent(
    live,
    () => ({ prefs: { mobileRemoteOwner: JSON.stringify(['u', 'd']) } }),
    () => ({}),
    () => 'unused',
  );
  register(
    { handle: (name: string, fn: Function) => handles.set(name, fn), on: (name: string, fn: Function) => listeners.set(name, fn) },
    {
      live,
      readState: () => ({ prefs: { mobileRemoteOwner: JSON.stringify(['u', 'd']) } }),
      patchPrefs: () => undefined,
      STATE_FILE: () => 'unused',
      allowed: () => true,
    },
  );
  const sender: any = new EventEmitter();
  sender.mainFrame = {};
  sender.isDestroyed = () => false;
  const event: any = { sender, senderFrame: sender.mainFrame };
  const api = buildApi(
    { remoteSettings: spec },
    {
      ipcRenderer: {
        sendSync: (name: string) => {
          listeners.get(name)!(event);
          return event.returnValue;
        },
        invoke: (name: string, ...args: unknown[]) => Promise.resolve(handles.get(name)!(event, ...args)),
      },
      webUtils: {},
    },
  ).remoteSettings;
  const displayed = (await api.state()).devices[0];
  await r.devices.add({ ...previous, pairId: 'p_current_pair' });
  const lease = r.devices.lease(phone.id, 'p_current_pair');
  assert.equal(await api.revoke(displayed.id, previous.pairId), false);
  assert.equal(r.devices.get(phone.id).pairId, 'p_current_pair');
  assert.equal(r.devices.currentLease(lease), true);
  assert.equal(displayed.pairId, previous.pairId);
  for (const claim of [undefined, null, '', 42]) assert.equal(await api.revoke(phone.id, claim), false);
  assert.equal(await api.revoke(phone.id, 'p_current_pair'), true);
  assert.equal(r.devices.get(phone.id), null);
});
