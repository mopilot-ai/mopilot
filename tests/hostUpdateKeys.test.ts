// Key rotation on the Host (host/src/updateKeys.mjs, shared/host/updateSignature.mjs v3, host/src/update.mjs): a signed update can add a key and revoke others; a key not heard from for 180 days is refused; a v2 manifest still works and cannot carry key changes; a revocation survives a restart.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createPairing } from '../host/src/pairing.mjs';
// @ts-ignore: plain ESM without declarations
import { createUpdateKeys } from '../host/src/updateKeys.mjs';
// @ts-ignore: plain ESM without declarations
import { stageUpdate } from '../host/src/update.mjs';
import { STALE_KEY_MS, checkManifest, keyIdOf, signManifest } from '../shared/host/updateSignature.mjs';
import { HOST_ID, KEYS, pemPair } from './support/hostUpdateKit.ts';
import { keySafe } from './support/hostKeySafe.ts';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'host-update-keys-'));
after(() => fs.rmSync(base, { recursive: true, force: true }));
let n = 0;
const mk = () => {
  const dir = path.join(base, `d${n++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const NOW = 1_800_000_000_000;
const SHA = createHash('sha256').update('archive').digest('hex');
const ID = (pem: string) => keyIdOf(pem);

/** A v3 manifest signed by `key`: for the test Host, an hour long, with what it says of keys. */
function v3(key: { pub: string; priv: string }, o: { nextKey?: string; revoke?: string[]; seq?: number; keyId?: string } = {}) {
  const facts = {
    version: '1',
    sha256: SHA,
    url: 'host.tgz',
    hostId: HOST_ID,
    seq: o.seq ?? 1,
    notAfter: NOW + 3_600_000,
    keyId: o.keyId ?? ID(key.pub),
    ...(o.nextKey ? { nextKey: o.nextKey } : {}),
    ...(o.revoke ? { revoke: o.revoke } : {}),
  };
  return { ...facts, signature: signManifest(facts, key.priv) };
}
const check = (m: any, keys: any[], extra: object = {}) => checkManifest(m, { keys, hostId: HOST_ID, now: NOW, floor: null, ...extra });

test('a v3 manifest names its key and is checked against that key alone; a v2 one against each; any change to what a v3 manifest says of keys breaks it', () => {
  const other = pemPair();
  const verdict: any = check(v3(KEYS), [other.pub, KEYS.pub]);
  assert.deepEqual([verdict.ok, verdict.keyId], [true, ID(KEYS.pub)]);
  // named for another key: not accepted though the signature is the other key's
  assert.equal(check(v3(KEYS, { keyId: ID(other.pub) }), [other.pub, KEYS.pub]).ok, false);
  // tampered key facts
  const m = v3(KEYS, { nextKey: other.pub, revoke: [ID(other.pub)] });
  assert.equal(check(m, [KEYS.pub]).ok, true);
  assert.equal(check({ ...m, nextKey: pemPair().pub }, [KEYS.pub]).ok, false);
  assert.equal(check({ ...m, revoke: [] }, [KEYS.pub]).ok, false);
  assert.equal(check({ ...m, keyId: ID(other.pub) }, [KEYS.pub]).ok, false);
  // a v2 manifest (no keyId) is still accepted from any trusted key
  const v2facts = { version: '1', sha256: SHA, url: 'u', hostId: HOST_ID, seq: 1, notAfter: NOW + 1000 };
  const v2 = { ...v2facts, signature: signManifest(v2facts, KEYS.priv) };
  assert.equal(check(v2, [other.pub, KEYS.pub]).ok, true);
});

test('key changes that cannot be used are refused before anything is taken', () => {
  const bad = (o: object) => check(v3(KEYS, o as any), [KEYS.pub]);
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString();
  for (const nextKey of [rsa, 'not a key']) assert.match((bad({ nextKey }) as any).message, /names a key this Host cannot use/);
  assert.match((bad({ revoke: ['short'] }) as any).message, /cannot use/);
  assert.match((bad({ revoke: new Array(21).fill(ID(KEYS.pub)) }) as any).message, /cannot use/);
  // the fields are not even read in a signed non-array
  const facts: any = { ...v3(KEYS), revoke: 'x' };
  assert.equal(check({ ...facts, signature: signManifest(facts, KEYS.priv) }, [KEYS.pub]).ok, false);
  const bareNext: any = { ...v3(KEYS), nextKey: 7 };
  assert.equal(check({ ...bareNext, signature: signManifest(bareNext, KEYS.priv) }, [KEYS.pub]).ok, false);
});

test('a key this Host has not heard from for 180 days is refused with what to do; one heard from since is not', () => {
  const entry = (lastSeen: number | null | undefined) => ({ id: ID(KEYS.pub), pem: KEYS.pub, lastSeen });
  assert.equal(check(v3(KEYS), [entry(NOW - STALE_KEY_MS + 1000)]).ok, true);
  assert.equal(check(v3(KEYS), [entry(null)]).ok, true, 'never seen is not stale');
  assert.equal(check(v3(KEYS), [entry(undefined)]).ok, true);
  const stale: any = check(v3(KEYS), [entry(NOW - STALE_KEY_MS - 1000)]);
  assert.equal(stale.ok, false);
  assert.match(stale.message, /pair the app with it again/);
});

test('the store: the key file, paired apps and added keys are trusted, minus the revoked; a key first seen counts from then; seen is written at most hourly', async () => {
  const config = mk();
  let now = NOW;
  const file: string = KEYS.pub;
  const store = createUpdateKeys({ configDir: config, now: () => now, fileKey: () => file });
  const first = store.entries();
  assert.deepEqual(
    first.map((k: any) => [k.id, k.lastSeen]),
    [[ID(file), null]],
  );
  // a paired app is a key too (its own seen time counts from first sight; the key file never goes stale)
  const app = pemPair();
  const der: string = app.pub.replace(/-----[^-]+-----|\s/g, '');
  fs.writeFileSync(path.join(config, 'pairing.json'), JSON.stringify({ codeHash: null, expires: 0, wrong: 0, clients: { fp: der } }));
  assert.deepEqual(
    store.entries().map((k: any) => k.id),
    [ID(file), ID(app.pub)],
  );
  // seen: not rewritten inside the hour, rewritten after
  now = NOW + 1000;
  store.markSeen(ID(app.pub));
  assert.equal(store.entries().find((k: any) => k.id === ID(app.pub))?.lastSeen, NOW);
  now = NOW + 3_700_000;
  store.markSeen(ID(app.pub));
  assert.equal(store.entries().find((k: any) => k.id === ID(app.pub))?.lastSeen, now);
  assert.equal(store.entries().find((k: any) => k.id === ID(file))?.lastSeen, null);
  // a store that was written is read back by another
  assert.equal(createUpdateKeys({ configDir: config, now: () => now, fileKey: () => file }).entries().length, 2);
  assert.equal(fs.statSync(path.join(config, 'update-keys.json')).mode & 0o777, 0o600);
  // a damaged store is an error, never an empty one that forgets a revocation
  fs.writeFileSync(path.join(config, 'update-keys.json'), 'not json');
  assert.throws(() => createUpdateKeys({ configDir: config, fileKey: () => null }).entries(), /cannot be read/);
  fs.writeFileSync(path.join(config, 'update-keys.json'), '{"added":1}');
  assert.throws(() => createUpdateKeys({ configDir: config, fileKey: () => null }).revoked(), /cannot be read/);
});

test('rotation end to end: the old key adds the next one, the next one revokes the old; the old is then refused, also after a restart; nobody can revoke the key that signs', async () => {
  const dir = mk();
  const config = path.join(dir, 'config');
  fs.mkdirSync(config);
  fs.writeFileSync(path.join(config, 'update-key.pub'), KEYS.pub);
  const next = pemPair();
  const store = () => createUpdateKeys({ configDir: config, now: () => NOW, fileKey: () => KEYS.pub });
  // a manifest whose archive was taken: use a prepared directory version so no download is needed
  const take = async (m: any, ks = store()) => {
    const data = mk();
    fs.mkdirSync(path.join(data, 'updates', 'versions', m.sha256), { recursive: true });
    const manifestFile = path.join(data, 'm.json');
    fs.writeFileSync(manifestFile, JSON.stringify(m));
    return stageUpdate({
      source: manifestFile,
      dataDir: data,
      keys: ks.entries(),
      keyStore: ks,
      hostId: HOST_ID,
      now: () => NOW,
      coreLoads: () => '',
    });
  };
  // 1: the old key signs a manifest that adds the next key
  await take(v3(KEYS, { nextKey: next.pub, seq: 1 }));
  assert.ok(
    store()
      .entries()
      .some((k: any) => k.id === ID(next.pub)),
    'the next key is trusted',
  );
  // 2: the next key signs one that revokes the old key and tries to revoke itself too
  await take(v3(next, { revoke: [ID(KEYS.pub), ID(next.pub)], seq: 2 }));
  const ids = store()
    .entries()
    .map((k: any) => k.id);
  assert.deepEqual(ids, [ID(next.pub)], 'the old key is gone, the signer is not');
  assert.deepEqual(store().revoked(), [ID(KEYS.pub)]);
  // 3: the old key is refused now, with a new store instance too (a restart)
  await assert.rejects(take(v3(KEYS, { seq: 3 })), /not signed by a key this Host trusts/);
  // a revoked key cannot come back through nextKey
  await take(v3(next, { nextKey: KEYS.pub, seq: 4 }));
  assert.deepEqual(
    store()
      .entries()
      .map((k: any) => k.id),
    [ID(next.pub)],
  );
  // a v2 manifest cannot carry key changes: they are not signed, so they are not read
  const facts: any = { version: '1', sha256: SHA, url: 'host.tgz', hostId: HOST_ID, seq: 5, notAfter: NOW + 3_600_000 };
  await take({ ...facts, signature: signManifest(facts, next.priv), nextKey: KEYS.pub, revoke: [ID(next.pub)] });
  assert.deepEqual(
    store()
      .entries()
      .map((k: any) => k.id),
    [ID(next.pub)],
  );
  // taking a manifest says the key was seen
  assert.equal(store().entries()[0].lastSeen, NOW);
});

test('stageUpdate without a key store takes an update as before', async () => {
  const data = mk();
  fs.mkdirSync(path.join(data, 'updates', 'versions', SHA), { recursive: true });
  const m = v3(KEYS);
  const manifestFile = path.join(data, 'm.json');
  fs.writeFileSync(manifestFile, JSON.stringify(m));
  const out = await stageUpdate({
    source: manifestFile,
    dataDir: data,
    keys: [KEYS.pub],
    hostId: HOST_ID,
    now: () => NOW,
    coreLoads: () => '',
  });
  assert.equal(out.staged, false);
});

test('pairing tells when a registered client proves its key, at pairing and at each later connection', async () => {
  const config = mk();
  const seen: string[] = [];
  const pairing = createPairing({ configDir: config, onSeen: (fp: string) => seen.push(fp) });
  const { loadIdentity, pairWith, authenticate } = await import('../electron/host/pairingClient.cjs').then((m) => m.default ?? m);
  const app = loadIdentity(path.join(mk(), 'k.json'), keySafe);
  const rpc = async (m: string, p: any) =>
    m === 'host.challenge'
      ? { nonce: pairing.challenge(), hostId: pairing.hostId() }
      : m === 'host.pair'
        ? pairing.claim(p)
        : pairing.verify(p);
  await pairWith(rpc, app, pairing.issueCode());
  assert.equal(seen.length, 1);
  await authenticate(rpc, app);
  assert.equal(seen.length, 2);
  assert.equal(seen[0], seen[1]);
  assert.equal(
    seen[0],
    ID(`-----BEGIN PUBLIC KEY-----\n${(app.publicKey.match(/.{1,64}/g) ?? []).join('\n')}\n-----END PUBLIC KEY-----\n`),
  );
});

test('a key a signed update adds also connects, and a key it revokes stops connecting: the pairing follows', () => {
  const config = mk();
  const app = pemPair();
  const next = pemPair();
  const der = (pem: string) => pem.replace(/-----[^-]+-----|\s/g, '');
  const pairing = () => createPairing({ configDir: config });
  const store = () => createUpdateKeys({ configDir: config, now: () => NOW, fileKey: () => null });
  // the app is paired
  fs.writeFileSync(
    path.join(config, 'pairing.json'),
    JSON.stringify({ codeHash: null, expires: 0, wrong: 0, clients: { [ID(app.pub)]: der(app.pub) } }),
  );
  assert.equal(pairing().knows(ID(app.pub)), true);
  // the next key is added: it is a client too, and the old one still is
  store().apply({ signedBy: ID(app.pub), nextKey: next.pub });
  assert.deepEqual([pairing().knows(ID(next.pub)), pairing().knows(ID(app.pub))], [true, true]);
  // the same key added again changes nothing
  store().apply({ signedBy: ID(app.pub), nextKey: next.pub });
  assert.equal(pairing().paired(), 2);
  // the old key is revoked by the next: it no longer connects; the signer stays; a key nobody registered is left alone
  store().apply({ signedBy: ID(next.pub), revoke: [ID(app.pub), ID(next.pub), 'f'.repeat(64)] });
  assert.deepEqual([pairing().knows(ID(app.pub)), pairing().knows(ID(next.pub))], [false, true]);
});
