// A signed Host update (shared/host/updateSignature.mjs, host/src/update.mjs, host/src/cli.mjs): a Host takes an update only from a manifest signed by the app it is paired with (or its update key), made for this Host, still good and newer than the last, read within its size and from its own host, before anything is downloaded; `status` says whether a key is trusted.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { MAX_VALIDITY_MS, checkManifest, signManifest, verifyManifest } from '../shared/host/updateSignature.mjs';
// @ts-ignore: plain ESM without declarations
import { main } from '../host/src/cli.mjs';
import { createPairing } from '../host/src/pairing.mjs';
import { createPaths } from '../host/src/paths.mjs';
import { askHost, startServer } from '../host/src/server.mjs';
import { hostStatus } from '../host/src/status.mjs';
import { hasUpdateKey, readUpdateKey, stageUpdate, trustedUpdateKeys, updatePaths, writeUpdateKey } from '../host/src/update.mjs';
import { HOST_ID, KEYS, TRUST, pemPair, signedFacts, trustDataDir } from './support/hostUpdateKit.ts';
import { createRequire } from 'node:module';

import { coreLoads, writeHostCore } from './support/hostCoreFixture.ts';
import { keySafe } from './support/hostKeySafe.ts';
const require = createRequire(import.meta.url);
const { loadIdentity, pairWith } = require('../electron/host/pairingClient.cjs');
const { buildBundle } = require('../electron/host/bundle.cjs');

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-sign-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const mk = (name: string) => fs.mkdtempSync(path.join(base, `${name}-`));
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** A Host version archive and its facts. */
function release(version: string) {
  const dir = mk('rel');
  fs.mkdirSync(path.join(dir, 'pkg/src'), { recursive: true });
  // the version is in the bytes: two releases made in the same second must not share an archive (and so a checksum)
  fs.writeFileSync(path.join(dir, 'pkg/src/cli.mjs'), `// ${version}\nexport async function main() { return 0; }\n`);
  writeHostCore(path.join(dir, 'pkg'));
  spawnSync('tar', ['-czf', path.join(dir, 'host.tgz'), '-C', path.join(dir, 'pkg'), '.']);
  const bytes = fs.readFileSync(path.join(dir, 'host.tgz'));
  const facts = { version, sha256: sha(bytes), url: 'host.tgz' };
  const manifest = path.join(dir, 'manifest.json');
  const write = (o: Parameters<typeof signedFacts>[1] = {}, edit: (m: any) => any = (m) => m) =>
    fs.writeFileSync(manifest, JSON.stringify(edit(signedFacts(facts, o))));
  write();
  return { dir, bytes, facts, manifest, write };
}
const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
};
/** A body in three pieces, as a download arrives. */
const chunks = (b: Buffer, n = 3) =>
  Readable.from(Array.from({ length: n }, (_, i) => b.subarray(Math.floor((b.length * i) / n), Math.floor((b.length * (i + 1)) / n))));
/** A fetch that answers from `routes`, each a status, optional headers and a body. */
const web = (routes: Record<string, { status?: number; headers?: Record<string, string>; body?: Buffer }>) => {
  const asked: string[] = [];
  const fetchFn: any = async (url: string, opts: any) => {
    asked.push(`${url}${opts?.redirect ? ` (${opts.redirect})` : ''}`);
    const r = routes[url];
    if (!r) return { ok: false, status: 404, headers: { get: () => null } };
    const status = r.status ?? 200;
    const headers = Object.fromEntries(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return { ok: status < 300, status, headers: { get: (k: string) => headers[k.toLowerCase()] ?? null }, body: r.body && chunks(r.body) };
  };
  return { fetchFn, asked };
};

test('a manifest verifies only against the key that signed it, with every fact it names', () => {
  const facts = { version: '1.0.0', sha256: 'a'.repeat(64), url: 'host.tgz', hostId: HOST_ID, seq: 5, notAfter: 9_000 };
  const signature = signManifest(facts, KEYS.priv);
  assert.equal(verifyManifest({ ...facts, signature }, KEYS.pub), true);
  for (const changed of [
    { version: '1.0.1' },
    { sha256: 'b'.repeat(64) },
    { url: 'https://evil.test/host.tgz' },
    { hostId: 'cd'.repeat(16) },
    { seq: 6 },
    { notAfter: 9_001 },
  ])
    assert.equal(verifyManifest({ ...facts, ...changed, signature }, KEYS.pub), false, JSON.stringify(changed));
  assert.equal(verifyManifest({ ...facts, signature }, pemPair().pub), false, 'another publisher’s key');
  assert.equal(verifyManifest(facts, KEYS.pub), false, 'unsigned');
  assert.equal(verifyManifest({ ...facts, signature: 42 }, KEYS.pub), false);
  assert.equal(verifyManifest({ ...facts, signature: 'not base64 !' }, KEYS.pub), false);
  assert.equal(verifyManifest({ ...facts, signature }, 'not a key'), false);
});

test('checkManifest: signed, for this Host, not expired, not for too long, and not older than the floor; each refusal says why', () => {
  const now = 1_000_000;
  const facts = { version: '2', sha256: 'a'.repeat(64), url: 'h.tgz' };
  const ok = signedFacts(facts, { seq: 10, now, notAfter: now + 1000 });
  const o = { keys: [KEYS.pub], hostId: HOST_ID, now, floor: null };
  assert.equal((checkManifest(ok, o) as any).ok, true);
  // another key among the trusted ones is fine, and one of them must match
  assert.equal((checkManifest(ok, { ...o, keys: [pemPair().pub, KEYS.pub] }) as any).ok, true);
  const why = (m: any, over: object = {}) => (checkManifest(m, { ...o, ...over }) as any).message;
  assert.match(why(ok, { keys: [pemPair().pub] }), /not signed by a key this Host trusts/);
  assert.match(why(ok, { keys: [] }), /not signed by a key this Host trusts/);
  assert.match(why({ ...ok, signature: undefined }), /not signed/);
  // facts that are not the right shape cannot have been signed
  for (const bad of [{ seq: 0 }, { seq: 1.5 }, { notAfter: 'soon' }, { hostId: 'short' }, { version: 3 }, { url: null }, { sha256: 'xyz' }])
    assert.match(why({ ...ok, ...bad }), /not signed by a key this Host trusts/, JSON.stringify(bad));
  assert.match(why(ok, { hostId: 'cd'.repeat(16) }), /signed for another Host/);
  assert.match(why(signedFacts(facts, { now, notAfter: now - 1 })), /has expired/);
  assert.match(why(signedFacts(facts, { now, notAfter: now + MAX_VALIDITY_MS + 1 })), /good for too long/);
  assert.equal((checkManifest(signedFacts(facts, { now, notAfter: now + MAX_VALIDITY_MS }), o) as any).ok, true);
  // the floor: older is a rollback; the same number must be the same build
  const floor = { seq: 10, sha256: facts.sha256 };
  assert.equal((checkManifest(ok, { ...o, floor }) as any).ok, true);
  assert.equal((checkManifest(signedFacts(facts, { seq: 11, now }), { ...o, floor }) as any).ok, true);
  assert.match(why(signedFacts(facts, { seq: 9, now }), { floor }), /older than the one this Host already has/);
  assert.match(
    why(signedFacts({ ...facts, sha256: 'b'.repeat(64) }, { seq: 10, now }), { floor }),
    /older than the one this Host already has/,
  );
});

test('stageUpdate downloads nothing and keeps nothing unless the manifest passes: no key, unsigned, altered, another Host, expired, rolled back', async () => {
  const fetched: string[] = [];
  const fetchFn: any = async (url: string) => (fetched.push(url), Promise.reject(new Error('offline')));
  const r = release('2.0.0');
  const dataDir = mk('d');
  await assert.rejects(stageUpdate({ source: r.manifest, dataDir, keys: [], hostId: HOST_ID }), /trusts no update key/);
  // unsigned
  r.write({}, ({ signature: _s, ...m }) => m);
  await assert.rejects(stageUpdate({ source: r.manifest, dataDir, fetchFn, ...TRUST }), /not signed by a key this Host trusts/);
  // the archive's address changed after signing
  r.write({}, (m) => ({ ...m, url: 'https://evil.test/host.tgz' }));
  await assert.rejects(stageUpdate({ source: r.manifest, dataDir, fetchFn, ...TRUST }), /not signed by a key/);
  // signed by someone else, signed for another Host, expired
  r.write({ key: pemPair().priv });
  await assert.rejects(stageUpdate({ source: r.manifest, dataDir, fetchFn, ...TRUST }), /not signed by a key/);
  r.write({ hostId: 'cd'.repeat(16) });
  await assert.rejects(stageUpdate({ source: r.manifest, dataDir, fetchFn, ...TRUST }), /signed for another Host/);
  r.write({ notAfter: Date.now() - 1000 });
  await assert.rejects(stageUpdate({ source: r.manifest, dataDir, fetchFn, ...TRUST }), /has expired/);
  assert.deepEqual(fetched, [], 'nothing was fetched for any of them');
  assert.equal(fs.existsSync(updatePaths(dataDir).root), false, 'and nothing was kept');
  // a good one stages; the same content again is fine; an older one is a rollback
  r.write({ seq: 100 });
  assert.equal((await stageUpdate({ source: r.manifest, dataDir, ...TRUST })).staged, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(updatePaths(dataDir).floor, 'utf8')), { seq: 100, sha256: r.facts.sha256 });
  assert.equal(fs.statSync(updatePaths(dataDir).floor).mode & 0o777, 0o600);
  assert.equal((await stageUpdate({ source: r.manifest, dataDir, ...TRUST })).staged, false);
  r.write({ seq: 99 });
  await assert.rejects(stageUpdate({ source: r.manifest, dataDir, ...TRUST }), /older than the one this Host already has/);
  const next = release('2.1.0');
  next.write({ seq: 101 });
  assert.equal((await stageUpdate({ source: next.manifest, dataDir, ...TRUST })).staged, true);
  // the old build, signed afresh with its old number, stays refused; with a newer number it is a new update
  r.write({ seq: 100 });
  await assert.rejects(stageUpdate({ source: r.manifest, dataDir, ...TRUST }), /older than the one this Host already has/);
  // a floor file that is not one is no floor
  fs.writeFileSync(updatePaths(dataDir).floor, 'not json');
  r.write({ seq: 1 });
  assert.equal((await stageUpdate({ source: r.manifest, dataDir, ...TRUST })).staged, false);
  fs.writeFileSync(updatePaths(dataDir).floor, JSON.stringify({ seq: 'x', sha256: 'y' }));
  assert.equal((await stageUpdate({ source: r.manifest, dataDir, ...TRUST })).staged, false);
});

test('an https source is read with redirects followed by hand: only to https on the same host, a few times; and within the size an update may be', async () => {
  const r = release('3.0.0');
  const manifest = Buffer.from(JSON.stringify(signedFacts({ ...r.facts, url: 'https://updates.example.test/host.tgz' })));
  const ok = {
    'https://updates.example.test/m.json': { body: manifest },
    'https://updates.example.test/host.tgz': { body: r.bytes },
  };
  const happy = web(ok);
  assert.equal(
    (await stageUpdate({ source: 'https://updates.example.test/m.json', dataDir: mk('d'), fetchFn: happy.fetchFn, ...TRUST })).staged,
    true,
  );
  assert.ok(
    happy.asked.every((a) => a.endsWith('(manual)')),
    'redirects are never followed by fetch itself',
  );
  // a redirect on the same host is followed (the Location may be relative); another host, http, or too many are not
  const same = web({ ...ok, 'https://updates.example.test/old.json': { status: 302, headers: { location: '/m.json' } } });
  assert.equal(
    (await stageUpdate({ source: 'https://updates.example.test/old.json', dataDir: mk('d'), fetchFn: same.fetchFn, ...TRUST })).staged,
    true,
  );
  for (const location of ['https://evil.test/m.json', 'http://updates.example.test/m.json']) {
    const bad = web({ ...ok, 'https://updates.example.test/old.json': { status: 301, headers: { location } } });
    await assert.rejects(
      stageUpdate({ source: 'https://updates.example.test/old.json', dataDir: mk('d'), fetchFn: bad.fetchFn, ...TRUST }),
      /does not follow/,
      location,
    );
  }
  const loop = web({ 'https://updates.example.test/a': { status: 307, headers: { location: '/a' } } });
  await assert.rejects(
    stageUpdate({ source: 'https://updates.example.test/a', dataDir: mk('d'), fetchFn: loop.fetchFn, ...TRUST }),
    /redirects more than 3 times/,
  );
  assert.equal(loop.asked.length, 4, 'the first ask and three redirects');
  // a redirect that names no place sends the download back to where it was
  const nowhere = web({ 'https://updates.example.test/a': { status: 302 } });
  await assert.rejects(
    stageUpdate({ source: 'https://updates.example.test/a', dataDir: mk('d'), fetchFn: nowhere.fetchFn, ...TRUST }),
    /redirects more than 3 times/,
  );
  // the archive's redirect off the host is refused too, after the manifest passed
  const away = web({
    ...ok,
    'https://updates.example.test/host.tgz': { status: 302, headers: { location: 'https://cdn.evil.test/host.tgz' } },
  });
  await assert.rejects(
    stageUpdate({ source: 'https://updates.example.test/m.json', dataDir: mk('d'), fetchFn: away.fetchFn, ...TRUST }),
    /cdn\.evil\.test/,
  );
  // size: a header that says too much, a body that turns out to be too much, and a local file
  const big = Buffer.alloc(65 * 1024, 1);
  const header = web({
    'https://updates.example.test/m.json': { headers: { 'content-length': String(big.length) }, body: Buffer.from('{}') },
  });
  await assert.rejects(
    stageUpdate({ source: 'https://updates.example.test/m.json', dataDir: mk('d'), fetchFn: header.fetchFn, ...TRUST }),
    /larger than an update may be/,
  );
  const stream = web({ 'https://updates.example.test/m.json': { body: big } });
  await assert.rejects(
    stageUpdate({ source: 'https://updates.example.test/m.json', dataDir: mk('d'), fetchFn: stream.fetchFn, ...TRUST }),
    /larger than an update may be/,
  );
  const none = web({ 'https://updates.example.test/m.json': {} });
  await assert.rejects(
    stageUpdate({ source: 'https://updates.example.test/m.json', dataDir: mk('d'), fetchFn: none.fetchFn, ...TRUST }),
    /JSON/,
  );
  const local = path.join(mk('big'), 'm.json');
  fs.writeFileSync(local, big);
  await assert.rejects(stageUpdate({ source: local, dataDir: mk('d'), ...TRUST }), /larger than an update may be/);
  // an archive over the cap is not read to the end
  const bigArchive = web({
    'https://updates.example.test/m.json': { body: manifest },
    'https://updates.example.test/host.tgz': { headers: { 'content-length': String(257 * 1024 * 1024) }, body: Buffer.from('x') },
  });
  await assert.rejects(
    stageUpdate({ source: 'https://updates.example.test/m.json', dataDir: mk('d'), fetchFn: bigArchive.fetchFn, ...TRUST }),
    /larger than an update may be/,
  );
});

test('the keys a Host trusts: its update key file and every app paired with it; a broken key file stops updates instead of switching verification off', async () => {
  const config = mk('cfg');
  assert.deepEqual(trustedUpdateKeys(config), []);
  assert.equal(hasUpdateKey(config), false);
  // an app paired with the Host is trusted, and so is the key file
  const app = loadIdentity(path.join(mk('app'), 'k.json'), keySafe);
  const pairing = createPairing({ configDir: config });
  await pairWith(
    async (m: string, p: any) => (m === 'host.challenge' ? { nonce: pairing.challenge(), hostId: pairing.hostId() } : pairing.claim(p)),
    app,
    pairing.issueCode(),
  );
  assert.equal(hasUpdateKey(config), true, 'a paired app is a key');
  const [pairedEntry] = trustedUpdateKeys(config);
  const paired = pairedEntry.pem;
  assert.equal(
    verifyManifest(signedFacts({ version: '1', sha256: 'a'.repeat(64), url: 'u' }, { hostId: pairing.hostId() }), paired),
    false,
    'the test publisher is not the app',
  );
  const facts = { version: '1', sha256: 'a'.repeat(64), url: 'u', hostId: pairing.hostId(), seq: 1, notAfter: 5 };
  assert.equal(verifyManifest({ ...facts, signature: app.signManifest(facts) }, paired), true, 'the app’s own signature verifies');
  writeUpdateKey(config, KEYS.pub);
  assert.equal(readUpdateKey(config), KEYS.pub);
  assert.deepEqual(
    trustedUpdateKeys(config).map((k: any) => k.pem),
    [KEYS.pub, paired],
  );
  assert.equal(fs.statSync(path.join(config, 'update-key.pub')).mode & 0o777, 0o600);
  // not a key, and a key of another kind, are refused when written and when read
  assert.throws(() => writeUpdateKey(config, 'not a key'), /not an Ed25519 public key/);
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString();
  assert.throws(() => writeUpdateKey(config, rsa), /not an Ed25519 public key/);
  fs.writeFileSync(path.join(config, 'update-key.pub'), 'not a key');
  assert.throws(() => readUpdateKey(config), /is not an Ed25519 public key/);
  fs.writeFileSync(path.join(config, 'update-key.pub'), rsa);
  assert.throws(() => readUpdateKey(config), /is not an Ed25519 public key/);
  const unreadable = mk('cfg');
  fs.mkdirSync(path.join(unreadable, 'update-key.pub'));
  assert.throws(() => readUpdateKey(unreadable), /cannot be read \(EISDIR\)/);
  // a pairing file that cannot be read is no key (status), and updates then fail with the pairing's own error
  const broken = mk('cfg');
  fs.writeFileSync(path.join(broken, 'pairing.json'), 'not json');
  assert.equal(hasUpdateKey(broken), false);
  assert.throws(() => trustedUpdateKeys(broken), /cannot be read/);
});

test('mopilot-host update takes a manifest the paired app signed for this Host, and nothing else; trust-update-key keeps a key from standard input', async () => {
  const dir = mk('cli');
  const paths = createPaths({ dataDir: dir, env: {} });
  const r = release('4.0.0');
  // a Host that trusts nothing refuses, with how to fix it
  const none = io();
  assert.equal(await main(['update', '--manifest', r.manifest, '--data-dir', dir], { ...none.io, env: {}, coreLoads }), 1);
  assert.match(none.err[0], /trusts no update key/);
  assert.equal(fs.existsSync(path.join(dir, 'updates')), false);
  // the key arrives on standard input, as the installer gives it
  const stdin = Readable.from([Buffer.from(KEYS.pub)]);
  const trust = io();
  assert.equal(await main(['trust-update-key', '--data-dir', dir], { ...trust.io, env: {}, stdin: stdin as any }), 0);
  assert.equal(readUpdateKey(paths.configDir), KEYS.pub);
  const bad = io();
  assert.equal(
    await main(['trust-update-key', '--data-dir', dir], { ...bad.io, env: {}, stdin: Readable.from([Buffer.from('nonsense')]) as any }),
    1,
  );
  assert.match(bad.err[0], /not an Ed25519 public key/);
  assert.equal(readUpdateKey(paths.configDir), KEYS.pub, 'the key is as it was');
  // no standard input at all, and one that fails with something that is not an Error
  const nostdin = io();
  assert.equal(await main(['trust-update-key', '--data-dir', dir], { ...nostdin.io, env: {} }), 1);
  assert.match(nostdin.err[0], /on standard input/);
  const broken = io();
  const failing = {
    [Symbol.asyncIterator]() {
      throw 'the pipe broke';
    },
  };
  assert.equal(await main(['trust-update-key', '--data-dir', dir], { ...broken.io, env: {}, stdin: failing as any }), 1);
  assert.equal(broken.err[0], 'the pipe broke');
  // a manifest for this Host stages; one for another does not
  const hostId = createPairing({ configDir: paths.configDir }).hostId();
  r.write({ hostId: 'cd'.repeat(16) });
  const other = io();
  assert.equal(await main(['update', '--manifest', r.manifest, '--data-dir', dir], { ...other.io, env: {}, coreLoads }), 1);
  assert.match(other.err[0], /signed for another Host/);
  r.write({ hostId });
  const mine = io();
  assert.equal(await main(['update', '--manifest', r.manifest, '--data-dir', dir], { ...mine.io, env: {}, coreLoads }), 0);
  assert.match(mine.out[0], /Staged version 4\.0\.0/);
});

test('status says whether a key is trusted for updates, offline from the config dir and from a running Host', async () => {
  const dir = mk('cli');
  const paths = createPaths({ dataDir: dir, env: {} });
  const off = hostStatus({ running: false });
  assert.ok(off.isolation.blocked.some((l: string) => /updates are refused: this Host trusts no update key/.test(l)));
  const on = hostStatus({ running: false, updateKey: true });
  assert.ok(on.isolation.delivered.some((l: string) => /updates are taken only from a manifest signed/.test(l)));
  assert.ok(!on.isolation.blocked.some((l: string) => /updates are refused/.test(l)));
  // offline `status` reads the key file; a running Host reports it too
  const before: string[] = [];
  assert.equal(await main(['status', '--data-dir', dir], { out: (l: string) => before.push(l), err: () => {}, env: {} }), 0);
  assert.ok(JSON.parse(before[0]).isolation.blocked.some((l: string) => /updates are refused/.test(l)));
  trustDataDir(dir);
  const after = [] as string[];
  assert.equal(await main(['status', '--data-dir', dir], { out: (l: string) => after.push(l), err: () => {}, env: {} }), 0);
  assert.ok(JSON.parse(after[0]).isolation.delivered.some((l: string) => /updates are taken only from/.test(l)));
  const server = await startServer({ paths, updateKey: true });
  try {
    assert.ok(
      ((await askHost(paths.socketPath, 'status')) as any).isolation.delivered.some((l: string) => /updates are taken only from/.test(l)),
    );
  } finally {
    await server.close();
  }
});

test('the Host bundle builder writes an unsigned manifest: the app signs one for each Host it updates', () => {
  const built = buildBundle({ root: path.join(import.meta.dirname, '..'), outDir: mk('b1') });
  const manifest = JSON.parse(fs.readFileSync(built.manifest, 'utf8'));
  assert.deepEqual(Object.keys(manifest).sort(), ['sha256', 'url', 'version']);
});
