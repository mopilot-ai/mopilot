// A build without the MoPilot service (the open-source edition, which has no electron/private): the optional loaders answer
// none, the account is never signed in, the switches keep their built-in defaults, and nothing names MoPilot's relay or
// gateway. Runs in both editions: the private modules are hidden by standing in for the loaders.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fakeSafe } from './support/remoteKit.ts';

mock.module('electron', { exports: {} });
const require = createRequire(import.meta.url);
const ENDPOINTS = require.resolve('../electron/platform/mopilotEndpoints.cjs');
const OPTIONAL = require.resolve('../electron/platform/optionalPrivate.cjs');
const { optionalPrivate } = require(OPTIONAL);
const { hasMoPilotService, FILE } = require('../electron/platform/mopilotPresence.cjs');
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'no-service-'));

/** `file` loaded fresh while this build has no private modules: the loaders answer none. */
function withoutService<T>(file: string, read: (mod: any) => T): T {
  const target = require.resolve(file);
  const mocks = [
    mock.module(ENDPOINTS, { exports: { endpoints: null, hasMoPilotService: () => false, FILE } }),
    mock.module(OPTIONAL, { exports: { optionalPrivate: () => null } }),
  ];
  delete require.cache[target];
  try {
    return read(require(target));
  } finally {
    for (const m of mocks) m.restore();
    delete require.cache[target];
  }
}

test('optionalPrivate: the module, or none when its own file is missing; anything else that fails to load throws', () => {
  const dir = temp();
  const here = path.join(dir, 'here.cjs');
  fs.writeFileSync(here, 'module.exports = { here: true };');
  assert.deepEqual(optionalPrivate(here), { here: true });
  assert.equal(optionalPrivate(path.join(dir, 'absent.cjs')), null);
  // present, but a module it needs is missing: a broken build, not the open-source one
  const broken = path.join(dir, 'broken.cjs');
  fs.writeFileSync(broken, "require('./gone.cjs');");
  assert.throws(() => optionalPrivate(broken), /Cannot find module '\.\/gone\.cjs'/);
  assert.throws(
    () =>
      optionalPrivate(here, () => {
        throw new SyntaxError('Unexpected token');
      }),
    SyntaxError,
  );
});

test('hasMoPilotService asks only whether the service module is there, without loading it', () => {
  const asked: string[] = [];
  assert.equal(
    hasMoPilotService((f: string) => (asked.push(f), f)),
    true,
  );
  assert.equal(
    hasMoPilotService(() => {
      throw Object.assign(new Error('missing'), { code: 'MODULE_NOT_FOUND' });
    }),
    false,
  );
  assert.deepEqual(asked, [FILE]);
  assert.match(FILE, /[/\\]electron[/\\]private[/\\]endpoints[/\\]index\.cjs$/);
});

test('without the service the account is the inert one: never signed in, it calls nothing and says why it cannot sign in', async () => {
  const { MoPilotAccount, NoMoPilotAccount, UNAVAILABLE } = withoutService('../electron/identity/mopilot.cjs', (m) => m);
  assert.equal(MoPilotAccount, NoMoPilotAccount);
  const fetch = mock.method(globalThis, 'fetch', async () => {
    throw new Error('no request may leave');
  });
  try {
    const told: unknown[] = [];
    const a = new MoPilotAccount({ userData: temp(), broadcast: (st: unknown) => told.push(st) });
    const signedOut = {
      signedIn: false,
      signingIn: false,
      user: null,
      balanceMicros: null,
      shareUsageData: null,
      modelCaps: null,
      checkedAt: null,
      unavailable: true,
    };
    assert.deepEqual(a.status(), signedOut);
    assert.deepEqual([a.creds, a.relayRefusal, a.gatewayKey()], [null, null, null]);
    assert.deepEqual(
      await Promise.all([a.modelCaps(), a.accessToken(true), a.relayToken(true), a.api('/me'), a.signOut(), a.setConsent(true)]),
      [null, null, null, null, undefined, undefined],
    );
    a.cancelSignIn();
    assert.deepEqual(await a.signIn(), { ok: false, error: UNAVAILABLE });
    // read at startup, it tells main once that the account is signed out (what an earlier private build left is taken away)
    assert.deepEqual(told, []);
    assert.deepEqual(await a.refreshStatus(), signedOut);
    assert.deepEqual(told, [signedOut]);
    await assert.rejects(a.openWeb('/account'), { message: UNAVAILABLE });
    // the windows' calls still have handlers, answering the same
    const handlers = new Map<string, (...args: any[]) => any>();
    a.register({ handle: (channel: string, fn: any) => handlers.set(channel, fn) });
    assert.deepEqual(
      [...handlers.keys()],
      ['mopilot:status', 'mopilot:refresh', 'mopilot:signIn', 'mopilot:cancelSignIn', 'mopilot:signOut', 'mopilot:openWeb'],
    );
    assert.deepEqual(await handlers.get('mopilot:status')!({}), signedOut);
    assert.deepEqual(await handlers.get('mopilot:refresh')!({}), signedOut);
    assert.deepEqual(await handlers.get('mopilot:signIn')!({}), { ok: false, error: UNAVAILABLE });
    assert.equal(await handlers.get('mopilot:cancelSignIn')!({}), undefined);
    assert.equal(await handlers.get('mopilot:signOut')!({}), undefined);
    await assert.rejects(handlers.get('mopilot:openWeb')!({}, '/billing'), { message: UNAVAILABLE });
    assert.equal(fetch.mock.callCount(), 0);
  } finally {
    fetch.mock.restore();
  }
});

test('without the private endpoints the loader answers no endpoints and no flags endpoint', () => {
  const m = mock.module(OPTIONAL, { exports: { optionalPrivate: () => null } });
  delete require.cache[ENDPOINTS];
  try {
    const e = require(ENDPOINTS);
    assert.deepEqual([e.endpoints, e.FLAGS_URL], [null, null]);
  } finally {
    m.restore();
    delete require.cache[ENDPOINTS];
  }
  // with them (a private build), the flags endpoint is theirs
  const e = require(ENDPOINTS);
  assert.equal(e.FLAGS_URL, e.endpoints?.FLAGS_URL ?? null);
});

test('without the service there is no MoPilot origin, relay or gateway, and the phone names no relay of its own', () => {
  assert.equal(
    withoutService('../electron/platform/install.cjs', (m) => m.API_BASE),
    null,
  );
  const saved = process.env.MOPILOT_RELAY_URL;
  delete process.env.MOPILOT_RELAY_URL;
  try {
    assert.equal(
      withoutService('../electron/host/relayPaths.cjs', (m) => m.relayUrl()),
      null,
    );
    // a self-hosted relay the user names is still theirs to use
    process.env.MOPILOT_RELAY_URL = 'wss://own.example/v1/ws';
    assert.equal(
      withoutService('../electron/host/relayPaths.cjs', (m) => m.relayUrl()),
      'wss://own.example/v1/ws',
    );
  } finally {
    if (saved === undefined) delete process.env.MOPILOT_RELAY_URL;
    else process.env.MOPILOT_RELAY_URL = saved;
  }
  assert.equal(
    withoutService('../electron/remote/runtime.cjs', (m) => m.DEFAULT_RELAY_URL),
    null,
  );
});

test('a machine is not enrolled over a relay this build does not name, and the lane never opens a socket', async () => {
  const { createRelayPaths } = require('../electron/host/relayPaths.cjs');
  const { NO_RELAY } = require('../electron/host/relayLane.cjs');
  const sockets: string[] = [];
  const paths = createRelayPaths({
    dir: temp(),
    url: () => null,
    getToken: async () => 'token',
    safeStorage: fakeSafe(),
    createSocket: (url: string) => {
      sockets.push(url);
      throw new Error('no socket may open');
    },
  });
  try {
    paths.lane.start?.();
    await assert.rejects(
      paths.enroll('box', async () => ({})),
      { message: NO_RELAY },
    );
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(sockets, []);
  } finally {
    paths.dispose();
  }
});

test('without a flags endpoint the switches are the built-in defaults: no cache is read, nothing is fetched or scheduled', async () => {
  const { Flags, defaultsFor } = require('../electron/platform/flags.cjs');
  const dir = temp();
  const file = path.join(dir, 'flags.json');
  // a cache another build of the app left in the same data folder
  const key = Object.keys(defaultsFor(process.platform)).find((k) => defaultsFor(process.platform)[k] === true)!;
  fs.writeFileSync(file, JSON.stringify({ fetchedAt: Date.now(), version: '1', channel: 'stable', schema: 2, flags: { [key]: false } }));
  const fetch = mock.fn(async () => ({ ok: true, json: async () => ({}) }));
  const flags = new Flags({ file, url: null, version: '1', channel: () => 'stable', fetch });
  assert.equal(flags.isEnabled(key), true);
  assert.equal(await flags.refresh(), false);
  flags.start();
  assert.equal(flags.timer, null);
  flags.stop();
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(fs.readFileSync(file, 'utf8').includes(key), true, 'the other build’s cache is left alone');
});
