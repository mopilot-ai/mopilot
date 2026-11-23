// Host update acceptance must revalidate current signing trust and floor under the trust owner after asynchronous preparation, rather than authorize from an earlier key snapshot.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { coreBuildHere, HOST_CORE_DIR, HOST_CORE_ADDON, HOST_CORE_RECORD } from '../shared/host/coreBuild.mjs';
import { keyIdOf, signManifest } from '../shared/host/updateSignature.mjs';
import { KEYS, pemPair, HOST_ID } from './support/hostUpdateKit.ts';
const require = createRequire(import.meta.url);
const { createUpdateKeys } = require('../host/src/updateKeys.mjs');
const { stageUpdate, updatePaths } = require('../host/src/update.mjs');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'host-current-trust-'));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const NOW = 1_800_000_000_000;
function world() {
  const dir = fs.mkdtempSync(path.join(base, 'run-'));
  const store = createUpdateKeys({ configDir: path.join(dir, 'config'), fileKey: () => KEYS.pub, now: () => NOW });
  const next = pemPair(),
    injected = pemPair();
  store.apply({ signedBy: keyIdOf(KEYS.pub), nextKey: next.pub });
  const keys = store.entries();
  const sha = 'c'.repeat(64),
    data = path.join(dir, 'data');
  const p = updatePaths(data);
  fs.mkdirSync(p.version(sha), { recursive: true });
  const facts = {
    version: '1',
    sha256: sha,
    url: 'https://host.invalid/archive',
    hostId: HOST_ID,
    seq: 1,
    notAfter: NOW + 1000,
    keyId: keyIdOf(KEYS.pub),
    nextKey: injected.pub,
  };
  const manifest = { ...facts, signature: signManifest(facts, KEYS.priv) };
  return { dir, store, next, injected, keys, p, data, manifest };
}

test('revocation while the manifest is being fetched prevents acceptance from the captured key list', async () => {
  const w = world();
  const fetched = async () => {
    w.store.apply({ signedBy: keyIdOf(w.next.pub), revoke: [keyIdOf(KEYS.pub)] });
    return new Response(JSON.stringify(w.manifest));
  };
  await assert.rejects(
    stageUpdate({
      source: 'https://host.invalid/manifest',
      fetchFn: fetched,
      dataDir: w.data,
      keys: w.keys,
      keyStore: w.store,
      hostId: HOST_ID,
      now: () => NOW,
    }),
    { code: 'update_trust_changed' },
  );
  assert.equal(fs.existsSync(w.p.next), false);
  assert.equal(fs.existsSync(w.p.floor), false);
  assert.equal(
    w.store.entries().some((k: any) => k.id === keyIdOf(w.injected.pub)),
    false,
  );
});

test('the acceptance guard reads the current floor before work and does not run a rejected commit', () => {
  const w = world();
  let committed = false;
  assert.throws(
    () =>
      w.store.withCurrentTrust(
        w.manifest,
        { hostId: HOST_ID, now: () => NOW, floor: () => ({ seq: 2, sha256: w.manifest.sha256 }) },
        () => (committed = true),
      ),
    { code: 'update_trust_changed' },
  );
  assert.equal(committed, false);
});

test('a current trusted manifest commits normally and keeps its new key', async () => {
  const w = world();
  await stageUpdate({
    source: 'https://host.invalid/manifest',
    fetchFn: async () => new Response(JSON.stringify(w.manifest)),
    dataDir: w.data,
    keys: w.keys,
    keyStore: w.store,
    hostId: HOST_ID,
    now: () => NOW,
  });
  assert.equal(
    w.store.entries().some((k: any) => k.id === keyIdOf(w.injected.pub)),
    true,
  );
  assert.equal(fs.existsSync(w.p.next), true);
});

test('acceptance keeps the process lock through work and releases it when work fails', () => {
  const w = world();
  const { tryLock } = require('../host/src/pidLock.mjs');
  const context = { hostId: HOST_ID, now: () => NOW, floor: () => null };
  assert.throws(
    () =>
      w.store.withCurrentTrust(w.manifest, context, () => {
        const lock = tryLock(path.join(w.dir, 'config/trust-write.lock'));
        assert.equal(lock.owned, false, 'another writer cannot enter between validation and commit');
        throw new Error('acceptance fault');
      }),
    /acceptance fault/,
  );
  w.store.markSeen('retry');
  assert.equal(fs.existsSync(path.join(w.dir, 'config/trust-write.lock')), false);
});

test('administrator key replacement participates in the same lock and remains retryable', () => {
  const w = world();
  const { writeUpdateKey, readUpdateKey } = require('../host/src/update.mjs');
  const config = path.join(w.dir, 'admin-config');
  writeUpdateKey(config, KEYS.pub);
  const store = createUpdateKeys({ configDir: config, fileKey: () => readUpdateKey(config) });
  const module = new URL('../host/src/update.mjs', import.meta.url).href;
  store.withCurrentTrust(w.manifest, { hostId: HOST_ID, now: () => NOW, floor: () => null }, () => {
    const output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import{writeUpdateKey}from ${JSON.stringify(module)};
      try{writeUpdateKey(${JSON.stringify(config)},${JSON.stringify(w.next.pub)});console.log('written');}
      catch(e){console.log(e.code);}
    `,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(output.trim(), 'trust_busy');
    assert.equal(readUpdateKey(config), KEYS.pub);
  });
  writeUpdateKey(config, w.next.pub);
  assert.equal(readUpdateKey(config), w.next.pub);
});

test('revocation during archive fetch is checked before unpacking or loading its native core', async () => {
  const w = world();
  const source = path.join(w.dir, 'source');
  const core = path.join(source, HOST_CORE_DIR);
  fs.mkdirSync(core, { recursive: true });
  fs.mkdirSync(path.join(source, 'src'));
  fs.writeFileSync(path.join(source, 'src/cli.mjs'), 'export {};');
  const addon = Buffer.from('fake core');
  fs.writeFileSync(path.join(core, HOST_CORE_ADDON), addon);
  fs.writeFileSync(
    path.join(core, HOST_CORE_RECORD),
    JSON.stringify({ build: coreBuildHere(), sha256: createHash('sha256').update(addon).digest('hex') }),
  );
  const archive = path.join(w.dir, 'version.tgz');
  execFileSync('tar', ['-czf', archive, '-C', source, '.']);
  const bytes = fs.readFileSync(archive);
  const facts = { ...w.manifest, sha256: createHash('sha256').update(bytes).digest('hex') };
  const manifest = { ...facts, signature: signManifest(facts, KEYS.priv) };
  let probes = 0;
  await assert.rejects(
    stageUpdate({
      source: 'https://host.invalid/manifest',
      dataDir: w.data,
      keys: w.keys,
      keyStore: w.store,
      hostId: HOST_ID,
      now: () => NOW,
      coreLoads: () => {
        probes++;
        return '';
      },
      fetchFn: async (url: any) => {
        if (String(url).endsWith('/manifest')) return new Response(JSON.stringify(manifest));
        w.store.apply({ signedBy: keyIdOf(w.next.pub), revoke: [keyIdOf(KEYS.pub)] });
        return new Response(bytes);
      },
    }),
    { code: 'update_trust_changed' },
  );
  assert.equal(probes, 0, 'a revoked signer cannot authorize native-code inspection');
  assert.equal(fs.existsSync(w.p.version(manifest.sha256)), false);
  assert.equal(fs.existsSync(w.p.next), false);
});
