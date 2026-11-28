// A Host too old to hold MoMo's home refuses `host.momoHomeStart` itself (#5626): every start names the oldest Host release the client lets hold a home, the Host compares its OWN version, and a client that misjudged it is told why in the Host's words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createMomoHome } from '../host/src/momoHome.mjs';
// @ts-ignore
import { createFileSafeStorage } from '../host/src/secretStore.mjs';
// @ts-ignore
import { hostAppVersion, recorded } from '../host/src/hostRelease.mjs';
import { servedHost } from './support/hostClientsWorld.ts';
// @ts-ignore
import { helloParams } from '../shared/host/schema.mjs';
import { createSteps } from '../shared/momoHomeAsk.mjs';
import { HOME_MIN_HOST_VERSION, releaseOf } from '../shared/host/momoHomeClient.mjs';

const start = { homeId: 'home-aaaa-1111', name: 'Studio' };

async function hostAt(t: any, hostVersion?: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-too-old-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = createMomoHome({
    hostId: 'home-aaaa-1111',
    dataDir: path.join(dir, 'data'),
    safeStorage: createFileSafeStorage(path.join(dir, 'config')),
    clock: { now: () => 1_700_000_000_000 },
  });
  t.after(() => home.close());
  const host = await servedHost(t, { momo: home, ...(hostVersion === undefined ? {} : { hostVersion }) });
  const { conn } = await host.paired('mac', 'Mac');
  await conn.request('host.momoGrant', { account: 'a1', features: ['momo'] });
  // a new hello names the feature the grant opened
  await conn.call('host.hello', helloParams());
  return { conn, home };
}

test('a Host older than the minimum refuses the start with host_too_old, its version and what is needed, and holds no home', async (t) => {
  const { conn, home } = await hostAt(t, '0.4.60');
  const refused = await conn.request('host.momoHomeStart', { ...start, minVersion: '0.4.67' }).then(
    () => null,
    (e: any) => e,
  );
  assert.equal(refused?.code, 'host_too_old');
  assert.match(refused.message, /needs a MoPilot update before it can hold MoMo's home/);
  assert.deepEqual(home.status().home, null, 'nothing was started');
});

test('a Host at or above the minimum starts the home; so does one with no minimum named (an older client)', async (t) => {
  const same = await hostAt(t, '0.4.67');
  assert.equal((await same.conn.request('host.momoHomeStart', { ...start, minVersion: '0.4.67' })).home.leaseEpoch, 1);
  const newer = await hostAt(t, '1.0.0');
  assert.equal((await newer.conn.request('host.momoHomeStart', { ...start, minVersion: '0.4.67' })).home.leaseEpoch, 1);
  const old = await hostAt(t, '0.1.0');
  assert.equal((await old.conn.request('host.momoHomeStart', start)).home.leaseEpoch, 1, 'no minimum: the client judged it');
});

test('a Host whose version has no order (dev, unpacked) is never "too old"; the default is the archive’s own record', async (t) => {
  const dev = await hostAt(t, '');
  assert.equal((await dev.conn.request('host.momoHomeStart', { ...start, minVersion: '9.9.9' })).home.leaseEpoch, 1);
  const own = await hostAt(t);
  // this checkout is not unpacked from an archive: no APP_VERSION beside it, so the default has no order either
  assert.equal(hostAppVersion, recorded('APP_VERSION'));
  assert.equal(releaseOf(hostAppVersion), null);
  assert.equal((await own.conn.request('host.momoHomeStart', { ...start, minVersion: '9.9.9' })).home.leaseEpoch, 1);
  assert.equal(recorded('NO_SUCH_FILE'), '');
  assert.match(recorded('package.json'), /"name"/, 'a file the archive keeps beside the bundle is read and trimmed');
});

test('a minimum that is not a release version is refused as a bad request', async (t) => {
  const { conn } = await hostAt(t, '1.0.0');
  for (const minVersion of ['latest', '1.2', 7, '', null])
    await assert.rejects(conn.request('host.momoHomeStart', { ...start, minVersion }), /not a release version/, String(minVersion));
});

test('the client names the minimum on every start (and only there), and a host_too_old refusal reaches the owner in the Host’s words', async () => {
  assert.ok(releaseOf(HOME_MIN_HOST_VERSION), 'the minimum is a release');
  const calls: { method: string; params: any }[] = [];
  const run = createSteps({
    call: async (_id: string, method: string, params: any) => {
      calls.push({ method, params });
      if (method === 'host.momoHomeStart')
        throw Object.assign(new Error('Mac mini needs a MoPilot update before it can hold MoMo’s home.'), { code: 'host_too_old' });
      return { leaseEpoch: 3 };
    },
    told: new Set<string>(),
    report: () => undefined,
  });
  const done = await run([
    { call: 'host.momoStandDown', host: 'studio', params: { homeId: 'home-aaaa-1111', leaseEpoch: 3, name: 'Studio' } } as any,
    { call: 'host.momoHomeStart', host: 'mini', params: { name: 'Mac mini', floor: 3, climbTo: 2 } },
  ]);
  assert.deepEqual(calls[0], { method: 'host.momoStandDown', params: { homeId: 'home-aaaa-1111', leaseEpoch: 3, name: 'Studio' } });
  assert.deepEqual(calls[1], { method: 'host.momoHomeStart', params: { name: 'Mac mini', floor: 3, minVersion: HOME_MIN_HOST_VERSION } });
  assert.deepEqual(done, { ran: false, failure: 'Mac mini needs a MoPilot update before it can hold MoMo’s home.' });
});
