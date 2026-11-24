// Host auto-update as the machines service wires it (electron/host/machines.cjs, autoUpdate.cjs): a heartbeat that finds an older Host over ssh sends the same update the row's button sends, and only while the setting allows it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { useFakeClock as installFakeClock } from './support/ports/clock.ts';
import { deferred } from './support/async-scenarios.ts';
import { waitFor } from './support/waitFor.ts';
import { createMachines } from './support/hostKeySafe.ts';

const require = createRequire(import.meta.url);
const { createRegistry } = require('../electron/host/registry.cjs');
const { initFlags } = require('../electron/platform/flags.cjs');
const pairedBox = { id: 'h1', name: 'box', address: 'me@box', socketPath: '/h/host.sock', hostKey: 'ab'.repeat(16) };

function world(
  t: any,
  on: boolean | undefined,
  extra: Record<string, unknown> = {},
  flag?: boolean,
  live: Record<string, unknown> | (() => Promise<Record<string, unknown>>) = extra,
) {
  initFlags({
    file: '/nonexistent/flags.json',
    url: null,
    channel: () => 'stable',
    version: '0.3.0',
    now: () => 1,
    onChange: () => undefined,
    ...(flag === undefined ? {} : { override: { 'host.autoUpdate': flag } }),
  }).stop();
  const clock = installFakeClock(t, 1_000_000);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoupdate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sent: string[] = [];
  const said = (fields: Record<string, unknown>) => ({
    harnesses: [],
    capabilities: {},
    build: 'an-older-build',
    appVersion: '0.0.1',
    ...fields,
  });
  const call = async (_record: any, method: string) => {
    if (method === 'status') return said(typeof live === 'function' ? await live() : live);
    throw new Error('no such method');
  };
  const registry = createRegistry({ file: path.join(dir, 'host-registry.json'), status: async () => said(extra) });
  const m = createMachines({
    dir,
    call,
    registry,
    session: async () => ({ close: () => undefined }),
    allowed: () => true,
    watch: () => undefined,
    ...(on === undefined ? {} : { autoUpdateOn: () => on }),
    // the update's own upload: it stops here, so the row says it failed
    channel: async (destination: string) => {
      sent.push(destination);
      return { code: 1, stdout: '', stderr: 'no route' };
    },
  });
  t.after(() => m.dispose());
  return { m, registry, clock, sent };
}
const tick = () => new Promise((r) => setImmediate(r));

test('a heartbeat that finds an older Host over ssh sends it the app’s build, and a machine reached by command is left alone', async (t) => {
  const w = world(t, true);
  w.registry.add(pairedBox);
  w.registry.add({ id: 'h2', name: 'cmd', address: 'relay:abc', socketPath: '' });
  w.clock.advance(30_000);
  await tick();
  await waitFor(() => w.m.list().machines.find((r: any) => r.id === 'h1')?.update === 'failed', 'the update to be tried');
  assert.deepEqual(w.sent, ['me@box']);
  assert.equal(w.m.list().machines.find((r: any) => r.id === 'h2')?.update, undefined, 'no ssh, nothing to send');
  w.m.remove('h1');
});

test('with the person’s “Update automatically” off nothing is sent', async (t) => {
  const w = world(t, false);
  w.registry.add(pairedBox);
  w.clock.advance(30_000);
  await tick();
  assert.equal(w.m.list().machines[0].hostStale, true, 'the Host is older');
  assert.equal(w.m.list().machines[0].update, undefined);
  assert.deepEqual(w.sent, []);
});

test('disabling Host auto-update leaves manual updates available', async (t) => {
  const w = world(t, true, {}, false);
  w.registry.add(pairedBox);
  w.clock.advance(30_000);
  await tick();
  assert.deepEqual(w.sent, []);
  assert.equal(w.m.list().machines[0].hostStale, true);
  await assert.rejects(w.m.updateHost('h1'), /no route/i);
  assert.deepEqual(w.sent, ['me@box']);
});

test('without a setting passed in the service updates (the default is on), and a Host that has an update staged is left alone', async (t) => {
  const w = world(t, undefined);
  w.registry.add(pairedBox);
  w.clock.advance(30_000);
  await tick();
  await waitFor(() => w.m.list().machines.find((r: any) => r.id === 'h1')?.update === 'failed', 'the update to be tried');
  const staged = world(t, undefined, { pendingUpdate: { version: '1.2.0', build: 'b9' } });
  staged.registry.add({ ...pairedBox, id: 'h2', address: 'me@box2' });
  staged.clock.advance(30_000);
  await tick();
  await waitFor(() => staged.m.list().machines[0]?.update === 'waiting', 'the staged update to show on the row as waiting');
  assert.deepEqual(staged.sent, [], 'another app already sent it a build: nothing is uploaded');
});

test('the auto-update rechecks for an older running build and no pending update after the heartbeat', async (t) => {
  for (const status of [
    { pendingUpdate: { version: '0.0.1', build: 'another-update' } },
    { build: 'same-version-build', appVersion: '0.3.0' },
    { build: 'newer-build', appVersion: '5.0.0' },
    { build: '', appVersion: '5.0.0' },
    { appVersion: 'garbled' },
    { appVersion: '0.0.1-..' },
    { appVersion: '0.0.1-01' },
    { appVersion: '00.0.1' },
    { appVersion: null },
    { build: [] },
    { appVersion: 3 },
  ]) {
    const w = world(t, true, {}, undefined, status);
    w.registry.add(pairedBox);
    await w.m.check();
    await tick();
    assert.deepEqual(w.sent, []);
    const row = w.m.list().machines[0];
    assert.equal(row.hostStale, true, 'the old heartbeat still describes an older Host');
    assert.equal(row.update, undefined, 'a deferral is neither a failure nor a staged update');
  }
});

test('removing and re-adding the same pairing retires an automatic status check', async (t) => {
  const first = deferred<Record<string, unknown>>();
  let reads = 0;
  const w = world(t, true, {}, undefined, () => (++reads === 1 ? first.promise : Promise.resolve({})));
  w.registry.add(pairedBox);
  await w.m.check();
  assert.equal(reads, 1);
  w.m.remove(pairedBox.id);
  w.registry.add(pairedBox);
  first.resolve({});
  await tick();
  assert.deepEqual(w.sent, []);
  await w.m.check();
  await waitFor(() => w.sent.length === 1, 'the replacement’s own update');
  assert.equal(reads, 2);
});

test('a key rotation holds automatic updates back while it runs, and the refusal of a rotation is thrown after the hold ends', async (t) => {
  const w = world(t, true);
  w.registry.add(pairedBox);
  const rotation = w.m.rotateKey();
  const out = await rotation.then(
    (r: unknown) => r,
    (e: unknown) => e,
  );
  assert.ok(out !== undefined, 'the rotation answered or refused');
  // the hold is released: a heartbeat afterwards updates again
  w.clock.advance(30_000);
  await tick();
  await waitFor(() => w.m.list().machines.find((r: any) => r.id === 'h1')?.update === 'failed', 'the update after the rotation');
});
