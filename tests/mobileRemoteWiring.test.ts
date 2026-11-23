// Startup wires the opted-in account's transport, confirmation and retirement to the phone service.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createConsent } = require('../electron/remote/consent.cjs');
const { openMobileRemote } = require('../electron/app/mobileRemote.cjs');

test('the production composition gates the shared service and retires its old pairing listener', async () => {
  let options: any;
  let callback: any;
  let unsubscribed = 0;
  let retired = 0;
  const received: any[] = [];
  const service: any = {
    transport: null,
    attach(channel: any) {
      this.transport = channel;
    },
    detach() {
      this.transport = null;
    },
  };
  const pairing = {
    onEvent(fn: any) {
      callback = fn;
      return () => {
        unsubscribed++;
      };
    },
  };
  const live: any = {
    mopilot: { creds: { user: { id: 'u' }, deviceId: 'd' } },
    chromePanel: { service },
    remoteSettings: {
      confirm: async () => 'allow',
      retire: () => {
        retired++;
      },
      event: (...args: any[]) => received.push(args),
    },
  };
  let prefs: any = {};
  live.remoteConsent = createConsent(
    live,
    () => ({ prefs }),
    () => ({}),
    () => 'x',
  );
  const remote = { pairing, sync: async () => {} };
  openMobileRemote({ userData: '/tmp', live, safeStorage: {}, fs: {} }, (o: any) => {
    options = o;
    return remote;
  });
  assert.equal(options.optedIn(), false);
  prefs = { mobileRemoteOwner: options.scope() };
  assert.equal(options.optedIn(), true);
  assert.equal(await options.confirm({}), 'allow');
  const channel = {};
  options.onChannel(channel);
  assert.equal(service.transport, channel);
  callback({ state: 'paired' });
  assert.deepEqual(received, [[pairing, { state: 'paired' }]]);
  options.onChannel(null);
  assert.equal(service.transport, null);
  assert.equal(unsubscribed, 1);
  assert.equal(retired, 1);
  live.remote.pairing = null;
  options.onChannel(channel);
  options.onChannel(null);
  delete live.remoteSettings;
  assert.equal(await options.confirm({}), null);
  delete live.chromePanel;
  options.onChannel(channel);
  live.mopilot.creds = null;
  assert.equal(options.optedIn(), false);
});
