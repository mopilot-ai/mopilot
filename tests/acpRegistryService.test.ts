// Explicit registry installs serialize independent writes, survive restarts, and keep running versions and prior data intact on failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { deferred } from './support/async-scenarios.ts';
import { agent, directory, fakeInstall, rawAgent, response, which } from './support/acp-registry.ts';
import { ACP_CATALOG } from '../shared/harnessCatalog.mjs';

const require = createRequire(import.meta.url);
const { RegistryCatalog } = require('../electron/harness/registry/catalog.cjs');
const { RegistryHarnesses } = require('../electron/harness/registry/service.cjs');
const { installFs } = require('../electron/platform/ports/fs.cjs');

async function fixture(ids = ['first', 'second'], extra: any = {}) {
  const dir = directory();
  const catalog = new RegistryCatalog({ file: path.join(dir, 'catalog.json'), fetch: async () => response(ids.map((id) => rawAgent(id))) });
  const service = new RegistryHarnesses({ dir, catalog, platform: 'linux', arch: 'x64', which, install: fakeInstall, ...extra });
  await catalog.list();
  return { dir, catalog, service };
}

test('installation refuses a native identity collision before creating files or invoking a package manager', async () => {
  let installed = false;
  const { service } = await fixture(['native-collision'], {
    install: async () => {
      installed = true;
    },
  });
  const id = 'registry-native-collision';
  const native = ACP_CATALOG.kimi;
  ACP_CATALOG[id] = native;
  try {
    await assert.rejects(
      service.install('native-collision', () => assert.fail('no package work')),
      /cannot replace a native harness/,
    );
    assert.equal(installed, false);
    assert.equal(fs.existsSync(service.file), false);
    assert.equal(ACP_CATALOG[id], native);
  } finally {
    delete ACP_CATALOG[id];
    service.dispose();
  }
});

test('metadata discovery never installs; explicit installs coalesce by id and serialize without dropping independent agents', async () => {
  const gate = deferred<void>();
  const started: string[] = [];
  const published: string[] = [];
  const { service, dir } = await fixture(undefined, {
    install: async (o: any) => {
      started.push(o.agent.id);
      await gate.promise;
      return fakeInstall(o);
    },
    onInstalled: async (id: string) => {
      published.push(id);
    },
  });
  assert.deepEqual(started, []);
  assert.equal((await service.list()).agents[0].available, true);
  assert.equal(service.resolve('unknown'), null);
  assert.equal(service.resolveAuth('unknown'), null);
  await assert.rejects(
    service.install('forged', () => {}),
    /Choose an agent/,
  );
  const first = service.install('first', () => {});
  assert.equal(
    service.install('first', () => assert.fail('duplicate click')),
    first,
  );
  const second = service.install('second', () => {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ['first']);
  gate.resolve();
  const results = await Promise.all([first, second]);
  assert.deepEqual(started, ['first', 'second']);
  assert.deepEqual(published, ['registry-first', 'registry-second']);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'installed.json'), 'utf8'));
  assert.deepEqual(
    saved.agents.map((a: any) => a.id),
    ['first', 'second'],
  );
  for (const result of results) {
    assert.equal(service.resolve(result.id), result.file);
    const launch = fs.readFileSync(result.file, 'utf8');
    assert.match(launch, /--acp/);
    assert.ok(!launch.includes('.install-'));
    assert.equal(launch.includes('AGENT_HOME='), true);
    const auth = service.resolveAuth(result.id)!;
    assert.equal(fs.readFileSync(auth, 'utf8').includes('--acp'), false, 'terminal auth replaces ACP arguments and environment');
    assert.equal(fs.statSync(result.file).mode & 0o777, 0o700);
  }
  const restored = new RegistryHarnesses({ dir, which });
  assert.equal(restored.resolve('registry-first'), results[0].file);
  assert.equal((await restored.list()).agents[0].installedVersion, '1.2.3');
  await service.install('first', () => assert.fail('already installed'));
  assert.equal(started.length, 2);
  assert.equal(published.length, 3);
  service.dispose();
  restored.dispose();
  await assert.rejects(
    service.install('first', () => {}),
    /closed/,
  );
});

test('updates publish a new launch location while old executables stay intact, and a missing launch can be repaired', async () => {
  const { service, catalog } = await fixture(['updatable']);
  const original = await service.install('updatable', () => {});
  const before = ACP_CATALOG[original.id];
  catalog.agents = [agent('updatable', '2.0.0')];
  assert.equal((await service.list()).agents[0].installedVersion, '1.2.3');
  const next = await service.install('updatable', () => {});
  assert.notEqual(next.file, original.file);
  assert.equal(fs.existsSync(original.file), true, 'running sessions keep their original program');
  assert.equal(before.registry!.version, '1.2.3', 'existing adapter references are immutable');
  assert.equal(ACP_CATALOG[next.id].registry!.version, '2.0.0');
  fs.unlinkSync(next.file);
  assert.equal(service.resolve(next.id), null);
  assert.equal(service.resolveAuth(next.id), null);
  const repaired = await service.install('updatable', () => {});
  assert.notEqual(repaired.file, next.file);
  fs.unlinkSync(path.join(path.dirname(repaired.file), 'authenticate'));
  assert.equal(service.resolveAuth(next.id), null);
  const authenticated = await service.install('updatable', () => {}, { repair: true });
  assert.notEqual(authenticated.file, repaired.file);
  assert.ok(service.resolveAuth(next.id));
  fs.unlinkSync(path.join(path.dirname(authenticated.file), 'agent'));
  const restoredBinary = await service.install('updatable', () => {}, { repair: true });
  assert.notEqual(restoredBinary.file, authenticated.file);
  assert.equal(fs.existsSync(path.join(path.dirname(restoredBinary.file), 'agent')), true);
  await assert.rejects(
    service.install('unknown', () => {}, { repair: true }),
    /Choose an agent/,
  );
  service.dispose();
});

test('failure before commit preserves the previous installation; a failed admission callback remains retryable after commit', async () => {
  const { service, catalog, dir } = await fixture(['failures']);
  const first = await service.install('failures', () => {});
  const saved = fs.readFileSync(path.join(dir, 'installed.json'), 'utf8');
  catalog.agents = [agent('failures', '2.0.0')];
  service.installer = async () => {
    throw new Error('download failed');
  };
  await assert.rejects(
    service.install('failures', () => {}),
    /download failed/,
  );
  assert.equal(service.resolve(first.id), first.file);
  assert.equal(fs.readFileSync(path.join(dir, 'installed.json'), 'utf8'), saved);
  service.installer = fakeInstall;
  const previous = installFs({
    ...fs,
    renameSync: (a: any, b: any) => {
      if (String(b).endsWith('installed.json')) throw new Error('disk full');
      return fs.renameSync(a, b);
    },
  });
  try {
    await assert.rejects(
      service.install('failures', () => {}),
      /disk full/,
    );
  } finally {
    installFs(previous);
  }
  assert.equal(fs.readFileSync(path.join(dir, 'installed.json'), 'utf8'), saved);
  assert.equal(fs.readdirSync(path.dirname(first.file)).includes('launch'), true);
  service.onInstalled = async () => {
    throw new Error('admission failed');
  };
  await assert.rejects(
    service.install('failures', () => {}),
    /admission failed/,
  );
  const committed = service.resolve(first.id);
  assert.notEqual(committed, first.file);
  service.onInstalled = async () => {};
  assert.equal((await service.install('failures', () => {})).file, committed);
  assert.equal(
    fs.readdirSync(dir).some((file) => file.startsWith('.install-')),
    false,
  );
  service.dispose();
});

test('disposal retires an installer and queued effects before publication, even if the external installer ignores abort', async () => {
  for (const rejects of [false, true]) {
    const gate = deferred<any>();
    let started = 0;
    let published = 0;
    const { service, dir } = await fixture(['retire', 'queued'], {
      install: async (o: any) => {
        started++;
        await gate.promise;
        return fakeInstall(o);
      },
      onInstalled: async () => {
        published++;
      },
    });
    const running = service.install('retire', () => {});
    const queued = service.install('queued', () => {});
    const done = Promise.allSettled([running, queued]);
    await new Promise((resolve) => setImmediate(resolve));
    service.dispose();
    if (rejects) gate.reject(new Error('stopped'));
    else gate.resolve();
    assert.ok((await done).every((result) => result.status === 'rejected'));
    assert.equal(started, 1);
    assert.equal(published, 0);
    assert.equal(fs.existsSync(path.join(dir, 'installed.json')), false);
    assert.equal(
      fs.readdirSync(dir).some((file) => file.startsWith('.install-')),
      false,
    );
  }
});

test('unavailable platforms and corrupt durable records never execute an installer or overwrite the records', async () => {
  for (const options of [{ platform: 'win32' }, { which: () => null }]) {
    const { service } = await fixture(['unavailable'], { ...options, install: () => assert.fail('unsupported install') });
    assert.equal((await service.list()).agents[0].available, false);
    await assert.rejects(
      service.install('unavailable', () => {}),
      /no usable distribution/,
    );
    service.dispose();
  }
  for (const value of ['{', JSON.stringify({ agents: [agent('broken')], locations: { broken: '../elsewhere' } })]) {
    const dir = directory();
    const file = path.join(dir, 'installed.json');
    fs.writeFileSync(file, value);
    const catalog = new RegistryCatalog({ file: path.join(dir, 'catalog.json'), fetch: async () => response([rawAgent('broken')]) });
    const service = new RegistryHarnesses({ dir, catalog, which });
    assert.match((await service.list()).error!, /could not be read/);
    await assert.rejects(
      service.install('broken', () => {}),
      /could not be read/,
    );
    assert.equal(fs.readFileSync(file, 'utf8'), value);
    service.dispose();
  }
});

test('removed agents retain pinned repair, and corrected launch metadata at the same version remains an update', async () => {
  const { service, catalog } = await fixture(['retained']);
  await service.install('retained', () => undefined);
  catalog.agents = [];
  let row = (await service.list()).agents[0];
  assert.equal(row.id, 'retained');
  assert.equal(row.repairAvailable, true);
  assert.equal(row.needsUpdate, false);
  const repaired = await service.install('retained', () => undefined, { repair: true });
  assert.ok(fs.existsSync(repaired.file));
  const corrected = agent('retained');
  corrected.distribution.npx!.args = ['--corrected'];
  catalog.agents = [corrected];
  row = (await service.list()).agents[0];
  assert.equal(row.installedVersion, corrected.version);
  assert.equal(row.needsUpdate, true);
  await service.install('retained', () => undefined);
  assert.equal((await service.list()).agents[0].needsUpdate, false);
  catalog.agents = [{ ...agent('retained'), distribution: { binary: {} } }];
  row = (await service.list()).agents[0];
  assert.equal(row.available, false);
  assert.equal(row.repairAvailable, true);
  assert.equal(row.needsUpdate, true);
  service.dispose();
});
