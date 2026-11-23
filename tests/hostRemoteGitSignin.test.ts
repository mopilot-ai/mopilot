// Real remote control calls reject old Hosts before sending Git login, and capability refusal stays a recoverable failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { hostWorld, onlineRemote } from './support/host-wire-kit.ts';
import { GIT_LOGIN, GIT_SIGNIN_FEATURE } from '../shared/host/gitLogin.mjs';

const require = createRequire(import.meta.url);
const { FEATURES } = require('../shared/host/schema.mjs');
const { createSignin } = require('../electron/host/signin.cjs');

test('paired older Hosts never receive parameter-gated Git login calls; ordinary harness sign-in still works', async (t) => {
  const w = hostWorld(t);
  w.net.handlers['host.hello'] = () => ({
    protocol: { minor: 1, floor: 1 },
    features: FEATURES.filter((f: string) => f !== GIT_SIGNIN_FEATURE),
  });
  w.net.handlers['host.login'] = (params) => ({ harness: params.harness, state: 'waiting' });
  const { host } = await onlineRemote(w);
  const writes = w.net.last.written.length;
  for (const call of ['login', 'loginStatus', 'loginCancel']) {
    await assert.rejects(host[call]({ harness: GIT_LOGIN }), (e: any) => e.code === 'feature_missing' && /Update/.test(e.message));
    assert.equal(w.net.last.written.length, writes, 'the unsafe call never leaves this app');
  }
  assert.equal((await host.login({ harness: 'codex' })).state, 'waiting');
  const signin = createSignin({
    call: (_id: string, method: string, params: any) => host[method](params),
    verify: async () => ({ signedIn: true }),
    openExternal() {},
  });
  t.after(() => signin.dispose());
  const view = await signin.start({ hostId: 'build-box', harness: GIT_LOGIN });
  assert.equal(view.state, 'failed', 'a reachable Host lacking the feature is not a disconnected machine');
  assert.equal(view.reason, 'host_update');
  assert.match(view.error, /Update/);
});

test('a capable paired Host receives the parsed Git target without operation recovery metadata', async (t) => {
  const w = hostWorld(t);
  w.net.handlers['host.hello'] = () => ({ protocol: { minor: 1, floor: 1 }, features: FEATURES });
  w.net.handlers['host.login'] = (params) => ({ harness: params.harness, state: 'waiting' });
  const { host } = await onlineRemote(w);
  assert.equal((await host.login({ harness: GIT_LOGIN, recoveryKey: 'main-only' })).state, 'waiting');
  assert.deepEqual(w.net.last.written.at(-1).params, { harness: GIT_LOGIN });
});

test('a capability refusal while polling is failed immediately, with the update route retained', async (t) => {
  for (const code of ['feature_missing', 'unsupported']) {
    const w = hostWorld(t);
    w.net.handlers['host.hello'] = () => ({ protocol: { minor: 1, floor: 1 }, features: FEATURES });
    w.net.handlers['host.login'] = () => ({ state: 'waiting' });
    w.net.handlers['host.loginStatus'] = () => {
      throw Object.assign(new Error('Update this Host to finish sign-in.'), { code });
    };
    const { host } = await onlineRemote(w);
    const signin = createSignin({
      call: (_id: string, method: string, params: any) => host[method](params),
      verify: async () => ({ signedIn: true }),
      openExternal() {},
    });
    t.after(() => signin.dispose());
    const view = await signin.start({ hostId: 'build-box', harness: GIT_LOGIN });
    assert.equal(view.state, 'failed');
    assert.equal(view.reason, 'host_update');
    assert.match(view.error, /Update/);
    assert.equal(w.net.last.written.filter((call: any) => call.method === 'host.loginStatus').length, 1);
  }
});

test('an unstructured connection rejection stays unreachable rather than claiming a Host capability', async () => {
  const signin = createSignin({
    call: async () => {
      throw null;
    },
    verify: async () => ({ signedIn: true }),
    openExternal() {},
  });
  assert.equal((await signin.start({ hostId: 'build-box', harness: GIT_LOGIN })).state, 'unreachable');
});

test('the Git update reason is scoped to Git, and ignores a refusal from a cancelled attempt', async () => {
  const refused = Object.assign(new Error('Update Host'), { code: 'feature_missing' });
  let reject!: (reason: Error) => void;
  const signin = createSignin({
    call: async (_id: string, method: string, params: any) => {
      if (method === 'loginCancel') return {};
      if (params.harness !== GIT_LOGIN) throw refused;
      return new Promise((_resolve, rejectCall) => (reject = rejectCall));
    },
    verify: async () => ({ signedIn: true }),
    openExternal() {},
  });
  const regular = await signin.start({ hostId: 'build-box', harness: 'codex' });
  assert.deepEqual([regular.state, regular.reason], ['failed', null]);
  const prior = signin.start({ hostId: 'build-box', harness: GIT_LOGIN });
  assert.equal(signin.cancel('build-box', GIT_LOGIN), true);
  const next = signin.start({ hostId: 'build-box', harness: GIT_LOGIN });
  reject(refused);
  assert.equal((await prior).state, 'cancelled');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(signin.status('build-box', GIT_LOGIN).state, 'starting');
  reject(refused);
  assert.equal((await next).reason, 'host_update');
});
