// Company endpoints from the managed policy (plan W4): `endpoints.relay` and `endpoints.api` (tests/mopilotEndpoints.private.test.ts) come before the environment, only from a valid file; the strict fallback and no file leave the environment and the defaults alone.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { tick } from './support/async-scenarios.ts';
import { fakeSafe, fs, tempDir } from './support/remoteKit.ts';
import { FakeSocket } from './support/remoteSocket.ts';

const require = createRequire(import.meta.url);
const MP = require.resolve('../electron/platform/managedPolicy.cjs');
const { endpoints } = require('../electron/platform/mopilotEndpoints.cjs');
const KEYS = ['MOPILOT_RELAY_URL', 'MOPILOT_API'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const RELAY = 'wss://relay.acme.example/v1/ws';
const API = 'https://mopilot.acme.example/';
const valid = { state: 'valid', doc: { endpoints: { relay: RELAY, api: API } } };

/** Loads `file` fresh while the resolver answers as `policy` (a module reads its endpoint helper when it loads). */
const fresh = (policy: { state: string; doc: any } | null, file: string) => {
  const target = require.resolve(file);
  const mp = require(MP);
  const original = mp.managedEndpoint;
  mp.managedEndpoint = (name: string) => (policy?.state === 'valid' ? (policy.doc.endpoints?.[name] ?? null) : null);
  delete require.cache[target];
  try {
    return require(file);
  } finally {
    mp.managedEndpoint = original;
    delete require.cache[target];
  }
};

test('managedEndpoint and managedOrgAccess read only a valid file', () => {
  const { managedEndpoint, managedOrgAccess, createManagedPolicy } = require(MP);
  assert.equal(managedEndpoint('relay'), null, 'this machine has no managed file');
  assert.equal(managedOrgAccess(), null);
  const file = (content: string) =>
    createManagedPolicy({
      file: '/etc/x/managed-policy.json',
      platform: 'linux',
      fs: { statSync: () => ({ uid: 0, mode: 0o100644 }), readFileSync: () => content },
    }).effectivePolicy();
  const ok = file(JSON.stringify({ version: 1, endpoints: { relay: RELAY, api: API } }));
  assert.equal(ok.state, 'valid');
  assert.equal(ok.doc.endpoints.relay, RELAY);
  assert.equal(file('{ nope').doc.endpoints, undefined, 'the strict fallback names no endpoint');
});

test('the Host relay path: the policy, then MOPILOT_RELAY_URL, then MoPilot’s own relay where the build has one', () => {
  process.env.MOPILOT_RELAY_URL = 'wss://env.example/v1/ws';
  assert.equal(fresh(valid, '../electron/host/relayPaths.cjs').relayUrl(), RELAY);
  assert.equal(fresh({ state: 'fallback', doc: {} }, '../electron/host/relayPaths.cjs').relayUrl(), 'wss://env.example/v1/ws');
  delete process.env.MOPILOT_RELAY_URL;
  // MoPilot's own where the build has the MoPilot service; none in one without it
  assert.equal(fresh(null, '../electron/host/relayPaths.cjs').relayUrl(), endpoints?.RELAY_URL ?? null);
});

test('the phone relay connects to the policy’s relay unless the app was given one', async (t) => {
  process.env.MOPILOT_RELAY_URL = 'wss://env.example/v1/ws';
  const urls: string[] = [];
  const open = async (policy: any, relayUrl?: string) => {
    const { openRemote } = fresh(policy, '../electron/remote/runtime.cjs');
    const remote = openRemote({
      userData: tempDir(),
      live: { mopilot: { relayToken: async () => 'token' } },
      safeStorage: fakeSafe(),
      fs: { ...fs, readFile: async () => Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' })) },
      flagOn: () => true,
      scope: () => 'owner',
      relayUrl,
      createSocket: (url: string, headers: any) => (urls.push(url), new FakeSocket(url, headers)),
    });
    t.after(() => remote.close());
    await remote.sync();
    await tick();
  };
  await open(valid);
  await open(null);
  await open(valid, 'wss://given.example/v1/ws');
  assert.deepEqual(
    urls.map((u) => u.split('?')[0]),
    [RELAY, 'wss://env.example/v1/ws', 'wss://given.example/v1/ws'],
  );
});

test('the process-wide resolver answers the endpoint and org helpers from its snapshot', () => {
  const { managedPolicy, managedEndpoint, managedOrgAccess } = require(MP);
  const mp = managedPolicy();
  const real = mp.effectivePolicy;
  try {
    mp.effectivePolicy = () => ({
      state: 'valid',
      doc: { endpoints: { relay: RELAY }, orgAccess: { clientId: 'c' } },
      organization: 'Acme',
      problem: null,
    });
    assert.equal(managedEndpoint('relay'), RELAY);
    assert.equal(managedEndpoint('api'), null, 'a valid file that names no api endpoint');
    assert.deepEqual(managedOrgAccess(), { orgAccess: { clientId: 'c' }, organization: 'Acme', problem: null });
    mp.effectivePolicy = () => ({ state: 'valid', doc: {}, organization: null, problem: null });
    assert.equal(managedEndpoint('relay'), null);
    mp.effectivePolicy = () => ({ state: 'fallback', doc: {}, organization: null, problem: 'x' });
    assert.equal(managedOrgAccess(), null);
  } finally {
    mp.effectivePolicy = real;
  }
});
