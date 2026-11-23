// The phone without the MoPilot service (the open-source edition): mobile/src/platform/auth.ts signs in nowhere and calls
// nothing, mobile/src/service.ts names no hosted account or relay, and Metro bundles mobile/src/private/<path> in place of mobile/src/<path> only where the checkout has it
// (mobile/config/privateModules.js).
import assert from 'node:assert/strict';
import path from 'node:path';
import { mock, test } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../mobile/package.json', import.meta.url));
mock.module(require.resolve('expo-constants'), {
  defaultExport: { expoConfig: { extra: {} }, deviceName: 'Pixel 8', platform: { android: {} } },
});
const authModulePath = '../mobile/src/platform/auth.ts';
const auth = await import(authModulePath);
const { privateCounterpart, resolvePrivate, SRC, PRIVATE } = require('./config/privateModules.js');

test('the stand-in account: signing in, refreshing, a relay token and deleting say why they fail; nothing is sent', async () => {
  const fetch = mock.method(globalThis, 'fetch', async () => {
    throw new Error('no request may leave');
  });
  try {
    for (const call of [auth.authorize('install'), auth.refresh('rt', 'op'), auth.relayToken('at'), auth.deleteAccount('at', 'DELETE')])
      await assert.rejects(call, { message: auth.UNAVAILABLE });
    assert.equal(await auth.revoke('rt'), false, 'no service reached');
    assert.equal(await auth.accountFeatures('at'), null, 'no answer is not a no');
    assert.equal(auth.thisPhoneName(), 'Pixel 8');
    assert.equal(fetch.mock.callCount(), 0);
  } finally {
    fetch.mock.restore();
  }
});

test('the stand-in names no hosted service: a release build has no account origin or relay of its own', async () => {
  const servicePath = '../mobile/src/service.ts';
  const endpointsPath = '../mobile/src/endpoints.ts';
  const { PRODUCTION } = await import(servicePath);
  assert.deepEqual(PRODUCTION, { relayUrl: '', accountOrigin: '' });
  const { resolveEndpoints } = await import(endpointsPath);
  assert.deepEqual(resolveEndpoints(undefined, false), { relayUrl: '', accountOrigin: '', dev: false });
});

test('a source file is bundled from its private counterpart where there is one, and anything else as it is', () => {
  const shared = path.join(SRC, 'platform', 'auth.ts');
  const counterpart = path.join(PRIVATE, 'platform', 'auth.ts');
  assert.equal(
    privateCounterpart(shared, (f: string) => f === counterpart),
    counterpart,
  );
  assert.equal(
    privateCounterpart(shared, () => false),
    shared,
  );
  // a private file, or one outside the phone's sources, is never redirected
  assert.equal(
    privateCounterpart(counterpart, () => true),
    counterpart,
  );
  const outside = path.join(SRC, '..', '..', 'shared', 'remote', 'envelope.mjs');
  assert.equal(
    privateCounterpart(outside, () => true),
    outside,
  );
  // the resolver keeps what Metro answered, with the file swapped; an asset or an empty module passes as it is
  const answers: Record<string, any> = { auth: { type: 'sourceFile', filePath: shared }, empty: { type: 'empty' } };
  const context = { resolveRequest: (_c: unknown, name: string) => answers[name] };
  const resolve = resolvePrivate(null, (f: string) => f === counterpart);
  assert.deepEqual(resolve(context, 'auth', 'ios'), { type: 'sourceFile', filePath: counterpart });
  assert.deepEqual(resolve(context, 'empty', 'ios'), { type: 'empty' });
  // a config's own resolver answers first
  const upstream = resolvePrivate(
    (_c: unknown, name: string) => answers[name === 'x' ? 'auth' : name],
    () => false,
  );
  assert.deepEqual(upstream({ resolveRequest: () => assert.fail('the config resolver answers') }, 'x', null), answers.auth);
});

test("the app's Metro config resolves through the private modules", () => {
  const config = require('./metro.config.js');
  const swapped = config.resolver.resolveRequest(
    { resolveRequest: () => ({ type: 'sourceFile', filePath: path.join(SRC, 'platform', 'auth.ts') }) },
    './platform/auth',
    'ios',
  );
  // the private account where this checkout has it, else the stand-in
  assert.deepEqual(swapped, { type: 'sourceFile', filePath: privateCounterpart(path.join(SRC, 'platform', 'auth.ts')) });
});
