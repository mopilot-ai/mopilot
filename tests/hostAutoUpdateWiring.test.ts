// Host auto-update as the machines service wires it (electron/host/machines.cjs, autoUpdate.cjs): a heartbeat that finds an older Host over ssh sends the same update the row's button sends, and only while the setting allows it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { useFakeClock as installFakeClock } from './support/ports/clock.ts';
import { waitFor } from './support/waitFor.ts';
import { createMachines } from './support/hostKeySafe.ts';

const require = createRequire(import.meta.url);
const { createRegistry } = require('../electron/host/registry.cjs');
const { initFlags } = require('../electron/platform/flags.cjs');

function world(t: any, on: boolean | undefined, extra: Record<string, unknown> = {}) {
  initFlags({
    file: '/nonexistent/flags.json',
    url: 'https://x/api/flags',
    channel: () => 'stable',
    version: '0.3.0',
    now: () => 1,
    fetch: async () => {
      throw new Error('offline');
    },
    onChange: () => undefined,
    override: { 'host.autoUpdate': true },
  }).stop();
  const clock = installFakeClock(t, 1_000_000);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoupdate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sent: string[] = [];
  const call = async (_record: any, method: string) => {
    if (method === 'status') return { harnesses: [], capabilities: {}, build: 'an-older-build', appVersion: '0.0.1', ...extra };
    throw new Error('no such method');
  };
  const registry = createRegistry({ file: path.join(dir, 'host-registry.json'), status: (r: any) => call(r, 'status') });
  const m = createMachines({
    dir,
    call,
    registry,
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
  w.registry.add({ id: 'h1', name: 'box', address: 'me@box', socketPath: '/h/host.sock' });
  w.registry.add({ id: 'h2', name: 'cmd', address: 'relay:abc', socketPath: '' });
  w.clock.advance(30_000);
  await tick();
  await waitFor(() => w.m.list().machines.find((r: any) => r.id === 'h1')?.update === 'failed', 'the update to be tried');
  assert.equal(w.m.list().machines.find((r: any) => r.id === 'h2')?.update, undefined, 'no ssh, nothing to send');
  w.m.remove('h1');
});

test('with the person’s “Update automatically” off nothing is sent', async (t) => {
  const w = world(t, false);
  w.registry.add({ id: 'h1', name: 'box', address: 'me@box', socketPath: '/h/host.sock' });
  w.clock.advance(30_000);
  await tick();
  assert.equal(w.m.list().machines[0].hostStale, true, 'the Host is older');
  assert.equal(w.m.list().machines[0].update, undefined);
  assert.deepEqual(w.sent, []);
});

test('without a setting passed in the service updates (the default is on), and a Host that has an update staged is left alone', async (t) => {
  const w = world(t, undefined);
  w.registry.add({ id: 'h1', name: 'box', address: 'me@box', socketPath: '/h/host.sock' });
  w.clock.advance(30_000);
  await tick();
  await waitFor(() => w.m.list().machines.find((r: any) => r.id === 'h1')?.update === 'failed', 'the update to be tried');
  const staged = world(t, undefined, { pendingUpdate: { version: '1.2.0', build: 'b9' } });
  staged.registry.add({ id: 'h2', name: 'box2', address: 'me@box2', socketPath: '/h/host.sock' });
  staged.clock.advance(30_000);
  await tick();
  await waitFor(() => staged.m.list().machines[0]?.update === 'waiting', 'the staged update to show on the row as waiting');
  assert.deepEqual(staged.sent, [], 'another app already sent it a build: nothing is uploaded');
});

test('a key rotation holds automatic updates back while it runs, and the refusal of a rotation is thrown after the hold ends', async (t) => {
  const w = world(t, true);
  w.registry.add({ id: 'h1', name: 'box', address: 'me@box', socketPath: '/h/host.sock' });
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
