// What a Host says of a staged update (host/src/update.mjs updateFacts, status.mjs): `pendingUpdate` { version, build } while a staged version waits to be run, so another app does not send its own build meanwhile; nothing before, and nothing once the staged one is gone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { updateFacts, updatePaths } from '../host/src/update.mjs';
// @ts-ignore: plain ESM without declarations
import { hostStatus } from '../host/src/status.mjs';

const SHA = 'a'.repeat(64);
function dirs(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = { configDir: path.join(root, 'config'), dataDir: path.join(root, 'data') };
  fs.mkdirSync(paths.configDir, { recursive: true });
  fs.mkdirSync(updatePaths(paths.dataDir).root, { recursive: true });
  return paths;
}
const stage = (paths: { dataDir: string }, build?: string) => {
  const p = updatePaths(paths.dataDir);
  fs.mkdirSync(path.join(p.version(SHA), 'host'), { recursive: true });
  if (build) fs.writeFileSync(path.join(p.version(SHA), 'host', 'BUILD_ID'), `${build}\n`);
  fs.writeFileSync(p.next, JSON.stringify({ version: '1.2.0', sha256: SHA }));
};

test('no staged update says none; one that is staged says its version and the build it will become', (t) => {
  const paths = dirs(t);
  assert.deepEqual(updateFacts(paths), { updateKey: false });
  stage(paths, 'b9');
  assert.deepEqual(updateFacts(paths), { updateKey: false, pendingUpdate: { version: '1.2.0', build: 'b9' } });
});

test('a staged archive that records no build says an empty one, and a pointer to an archive that is gone says none', (t) => {
  const paths = dirs(t);
  stage(paths);
  assert.deepEqual(updateFacts(paths).pendingUpdate, { version: '1.2.0', build: '' });
  fs.rmSync(updatePaths(paths.dataDir).version(SHA), { recursive: true });
  assert.equal(updateFacts(paths).pendingUpdate, undefined);
});

test('the status carries the pending update only when there is one', () => {
  assert.equal('pendingUpdate' in hostStatus({ running: true }), false);
  assert.deepEqual(hostStatus({ running: true, pendingUpdate: { version: '1.2.0', build: 'b9' } }).pendingUpdate, {
    version: '1.2.0',
    build: 'b9',
  });
});

test('the registry keeps a staged build’s recovery deadline and waits for a fresh report after restart', async (t) => {
  const { createRequire } = await import('node:module');
  const { useFakeClock } = await import('./support/ports/clock.ts');
  const clock = useFakeClock(t, 1_000);
  const { createRegistry } = createRequire(import.meta.url)('../electron/host/registry.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-reg-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'host-registry.json');
  let pending = true;
  let build = 'b9';
  const answer = async () => ({
    harnesses: [],
    capabilities: {},
    ...(pending ? { pendingUpdate: { version: '1.2.0', build } } : {}),
  });
  const registry = createRegistry({ file, status: answer });
  t.after(() => registry.dispose());
  registry.add({ id: 'h1', name: 'box', address: 'me@box' });
  assert.equal(registry.list()[0].hostPending, null);
  await registry.check();
  const seen = registry.list()[0].hostPending;
  assert.equal(seen.build, 'b9');
  await registry.check();
  assert.equal(registry.list()[0].hostPending.since, seen.since, 'it has waited since it was first seen, not since the last look');
  clock.advance(30 * 60_000);
  const again = createRegistry({ file, status: answer });
  t.after(() => again.dispose());
  assert.equal(again.list()[0].hostPending, null, 'saved age alone does not prove an update is still staged');
  await again.check();
  assert.deepEqual(again.list()[0].hostPending, seen, 'the same live build keeps its original wait');
  build = 'b10';
  await again.check();
  assert.deepEqual(again.list()[0].hostPending, { build, since: clock.now() });
  pending = false;
  await again.check();
  assert.equal(again.list()[0].hostPending, null);
  // a Host that names no build for it still has one staged
  const bare = createRegistry({
    file: path.join(root, 'bare.json'),
    status: async () => ({ harnesses: [], capabilities: {}, pendingUpdate: { version: '1.2.0' } }),
  });
  t.after(() => bare.dispose());
  bare.add({ id: 'h2', name: 'box2', address: 'me@box2' });
  await bare.check();
  assert.equal(bare.list()[0].hostPending.build, '');
});

test('unusable saved pending times cannot hide manual recovery', async (t) => {
  const { createRequire } = await import('node:module');
  const { useFakeClock } = await import('./support/ports/clock.ts');
  const clock = useFakeClock(t, 1_000);
  const { createRegistry } = createRequire(import.meta.url)('../electron/host/registry.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-invalid-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'host-registry.json');
  for (const hostPending of [
    null,
    [],
    { since: 0 },
    { build: 'b', since: '0' },
    { build: 'b', since: 0.5 },
    { build: 'b', since: -1 },
    { build: 'b', since: 10_000 },
  ]) {
    fs.writeFileSync(file, JSON.stringify({ version: 1, hosts: [{ id: 'h', name: 'box', address: 'me@box', hostPending }] }));
    const registry = createRegistry({
      file,
      status: async () => ({ harnesses: [], capabilities: {}, pendingUpdate: { build: 'b' } }),
    });
    assert.equal(registry.list()[0].hostPending, null);
    await registry.check();
    assert.deepEqual(registry.list()[0].hostPending, { build: 'b', since: clock.now() });
    registry.dispose();
  }
});
