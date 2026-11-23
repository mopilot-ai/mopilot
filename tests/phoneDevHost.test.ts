// A development build's dev host: the MOPILOT_DEV_HOST parser, the endpoints it selects, the Expo config it adds (local-network ATS exception only) and the plain ws: pairing it allows when the build trusts a plain relay.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { createPhonePairing } from '../shared/remote/phonePairing.mjs';
import { PRODUCTION, resolveEndpoints } from '../mobile/src/endpoints.ts';
import { prim, setup } from './support/phonePairingFixture.ts';

const require = createRequire(import.meta.url);
const { isLocalHost, parseDevHost, devHostFromEnv } = require('../mobile/config/devHost.js');
const appConfig = require('../mobile/app.config.js');

test('only a bare http origin on this machine or its local network is a dev host', () => {
  assert.deepEqual(parseDevHost(' http://192.168.86.228:8787 '), {
    origin: 'http://192.168.86.228:8787',
    relayUrl: 'ws://192.168.86.228:8787/v1/ws',
  });
  for (const ok of [
    'http://localhost:8787',
    'http://127.0.0.1',
    'http://10.0.0.5:1',
    'http://172.16.0.1:9',
    'http://172.31.9.9',
    'http://my-mac.local:8787',
  ])
    assert.ok(parseDevHost(ok), ok);
  for (const bad of [
    undefined,
    42,
    '',
    '  ',
    'not a url',
    'https://192.168.1.2:8787',
    'ws://192.168.1.2:8787',
    'http://example.com',
    'http://172.32.0.1',
    'http://192.169.1.1',
    'http://192.168.1.1.evil.com',
    'http://10.evil.com',
    'http://172.16.0.1.example.org',
    'http://localhost.evil.com',
    'http://[::1]:8787',
    'http://u:p@192.168.1.2',
    'http://192.168.1.2/x',
    'http://192.168.1.2/?a=1',
    'http://192.168.1.2/#x',
  ])
    assert.equal(parseDevHost(bad), null, String(bad));
  assert.equal(isLocalHost('relay.mopilot.ai'), false);
});

test('the build environment names a dev host, nothing, or fails loudly', () => {
  assert.equal(devHostFromEnv({}), null);
  assert.equal(devHostFromEnv({ MOPILOT_DEV_HOST: '  ' }), null);
  assert.equal(devHostFromEnv({ MOPILOT_DEV_HOST: 'http://localhost:8787' }).relayUrl, 'ws://localhost:8787/v1/ws');
  assert.throws(() => devHostFromEnv({ MOPILOT_DEV_HOST: 'https://relay.mopilot.ai' }), /MOPILOT_DEV_HOST must be an http/);
});

test('the endpoints are MoPilot’s unless the build carries a valid dev host', () => {
  assert.deepEqual(resolveEndpoints(undefined, true), { ...PRODUCTION, dev: false });
  assert.deepEqual(resolveEndpoints('https://evil.example', true), { ...PRODUCTION, dev: false });
  assert.deepEqual(resolveEndpoints('http://192.168.1.2:8787', true), {
    relayUrl: 'ws://192.168.1.2:8787/v1/ws',
    accountOrigin: 'http://192.168.1.2:8787',
    dev: true,
  });
});

test('a release build keeps MoPilot’s endpoints even when the dev host is set', () => {
  assert.deepEqual(resolveEndpoints('http://192.168.1.2:8787', false), { ...PRODUCTION, dev: false });
});

test('the Expo config gains the dev host and the local-network exception only when MOPILOT_DEV_HOST is set', () => {
  const before = process.env.MOPILOT_DEV_HOST;
  const base = { config: { ios: { infoPlist: { Keep: 1 } }, extra: { keep: true } } };
  try {
    delete process.env.MOPILOT_DEV_HOST;
    const plain = appConfig(base);
    assert.equal(plain.extra.devHost, undefined);
    assert.equal(plain.ios.infoPlist, base.config.ios.infoPlist, 'production keeps the Info.plist it had');

    process.env.MOPILOT_DEV_HOST = 'http://192.168.86.228:8787';
    const dev = appConfig(base);
    assert.equal(dev.extra.devHost, 'http://192.168.86.228:8787');
    assert.equal(dev.extra.keep, true);
    assert.equal(dev.extra.devClient, undefined, 'a release build is not marked as a dev client');
    assert.deepEqual(dev.ios.infoPlist.NSAppTransportSecurity, { NSAllowsLocalNetworking: true });
    assert.equal(dev.ios.infoPlist.Keep, 1);
    assert.match(dev.ios.infoPlist.NSLocalNetworkUsageDescription, /dev host/);
    assert.equal(appConfig({ config: {} }).ios.infoPlist.Keep, undefined);

    process.env.MOPILOT_DEV_CLIENT = '1';
    assert.equal(appConfig(base).extra.devClient, true);
    delete process.env.MOPILOT_DEV_CLIENT;

    process.env.MOPILOT_DEV_HOST = 'http://example.com';
    assert.throws(() => appConfig(base), /MOPILOT_DEV_HOST/);
  } finally {
    if (before === undefined) delete process.env.MOPILOT_DEV_HOST;
    else process.env.MOPILOT_DEV_HOST = before;
  }
});

test('plain ws: pairing is read only when the build trusts exactly that plain relay', async () => {
  const s = setup();
  const { payload } = await s.desktop.begin();
  const plain = 'ws://192.168.86.228:8787/v1/ws';
  const build = (relayUrl: string, plainRelay = true) =>
    createPhonePairing({ prim, relayUrl, plainRelay, store: s.store, transport: s.transport, now: () => 100 });
  // a production build refuses a plain QR before anything else
  await assert.rejects(build('wss://relay.example/ws').begin({ ...payload, relay: plain }, 'phone'), /invalid relay/);
  // a build that was not told its relay is the dev host's refuses a plain QR even when its own relay URL is plain
  await assert.rejects(build(plain, false).begin({ ...payload, relay: plain }, 'phone'), /invalid relay/);
  // a dev build refuses a QR that names another relay, plain or not
  await assert.rejects(build(plain).begin({ ...payload, relay: 'ws://192.168.86.99:8787/v1/ws' }, 'phone'), /untrusted relay/);
  await assert.rejects(build(plain).begin({ ...payload, relay: 'wss://relay.example/ws' }, 'phone'), /untrusted relay/);
  // and still refuses credentials in the URL
  await assert.rejects(
    build('ws://u@192.168.86.228:8787/v1/ws').begin({ ...payload, relay: 'ws://u@192.168.86.228:8787/v1/ws' }, 'phone'),
    /invalid relay/,
  );
  // the same relay is accepted
  const pending = await build(plain).begin({ ...payload, relay: plain }, 'phone');
  assert.match(pending.pairId, /^p_/);
});

test('a development build reads its dev host from the Expo config (its sign-in there: tests/mobileDevHostSignIn.test.ts)', async (t) => {
  const { mock } = t;
  const mobile = createRequire(new URL('../mobile/package.json', import.meta.url));
  // the config the build carries is read when the module loads: a dev-client build (no __DEV__) with a dev host
  const devHostAddress = 'http://192.168.86.228:8787';
  mock.module(mobile.resolve('expo-constants'), {
    defaultExport: { expoConfig: { extra: { devHost: devHostAddress, devClient: true } } },
  });
  // loaded by variable path: the phone's React Native types stay out of the node typecheck
  const endpointsModule = '../mobile/src/platform/endpoints.ts';
  const { endpointsOf, announce } = await import(endpointsModule);
  const devHost = devHostAddress;
  const dev = { relayUrl: 'ws://192.168.86.228:8787/v1/ws', accountOrigin: devHost, dev: true };
  const release = { ...PRODUCTION, dev: false };
  const of = (extra: object | undefined, devGlobal?: unknown) => endpointsOf({ expoConfig: extra && { extra } }, devGlobal);
  // a release build (no __DEV__, no dev-client flag) ignores the dev host that is set
  assert.deepEqual(of({ devHost }), release);
  assert.deepEqual(of({ devHost }, false), release);
  // a development build, or one made with the explicit dev-client flag, uses it
  assert.deepEqual(of({ devHost }, true), dev);
  assert.deepEqual(of({ devHost, devClient: true }), dev);
  assert.deepEqual(of({ devHost, devClient: 'yes' }), release, 'only the boolean true counts');
  // a build whose Expo config has no extra, or no config at all
  assert.deepEqual(endpointsOf({ expoConfig: {} }, false), release);
  assert.deepEqual(endpointsOf({ expoConfig: null }, false), release);
  assert.deepEqual(endpointsOf({}, true), release);
  assert.deepEqual(of(undefined, undefined), release);
  // the build says which servers it uses when they are not MoPilot's
  const said: string[] = [];
  announce(endpointsOf({ expoConfig: { extra: { devHost } } }, true), (l: string) => said.push(l), true);
  announce(endpointsOf({ expoConfig: { extra: { devHost } } }, false), (l: string) => said.push(l), true);
  announce(endpointsOf({}, false), (l: string) => said.push(l), false);
  assert.equal(said.length, 2);
  assert.match(said[0], /dev endpoints: relay ws:\/\/192\.168\.86\.228:8787\/v1\/ws, account http:\/\/192\.168\.86\.228:8787/);
  assert.match(said[1], /dev host is configured but ignored/);
  // the module as the build loaded it points at the dev host
  assert.deepEqual((await import(endpointsModule)).endpoints, dev);
});
