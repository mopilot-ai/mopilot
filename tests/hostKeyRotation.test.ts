// Rotating the app's key across its machines (electron/host/keyRotation.cjs, the identity's rotation state in pairingClient.cjs, hostUpdate's v3 manifests): a new key goes to every machine first, the app switches only when all have it, then each machine drops the old one; what cannot be done stops before anything changes or is remembered for the next run.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { checkManifest, keyIdOf } from '../shared/host/updateSignature.mjs';
import { keySafe, openKeyFile } from './support/hostKeySafe.ts';

const require = createRequire(import.meta.url);
const { loadIdentity } = require('../electron/host/pairingClient.cjs');
const { createKeyRotation } = require('../electron/host/keyRotation.cjs');
const { createHostUpdater } = require('../electron/host/hostUpdate.cjs');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'host-key-rotation-'));
after(() => fs.rmSync(base, { recursive: true, force: true }));
let n = 0;
const file = () => path.join(base, `id${n++}.json`);
const pemOfB64 = (b64: string) => `-----BEGIN PUBLIC KEY-----\n${(b64.match(/.{1,64}/g) ?? []).join('\n')}\n-----END PUBLIC KEY-----\n`;

test('the identity keeps a rotation across restarts: one next key until promoted, then the old key only as an id with the machines still to tell', () => {
  const f = file();
  const id = loadIdentity(f, keySafe);
  const first = id.keyId;
  assert.equal(id.retiring(), null);
  const next = id.startRotation();
  assert.equal(id.startRotation().id, next.id, 'asked again it is the same key');
  assert.equal(loadIdentity(f, keySafe).startRotation().id, next.id, 'and after a restart');
  assert.equal(id.keyId, first, 'the app still uses the old key until it is promoted');
  id.promote(['a', 'b']);
  assert.equal(id.keyId, next.id);
  assert.deepEqual(id.retiring(), { id: first, machines: ['a', 'b'] });
  const reread = loadIdentity(f, keySafe);
  assert.equal(reread.keyId, next.id);
  assert.deepEqual(reread.retiring(), { id: first, machines: ['a', 'b'] });
  assert.ok(!('next' in openKeyFile(f)), 'the next key is the current one now');
  // the old private key is not kept
  assert.equal((openKeyFile(f).privateKey as string).length > 0, true);
  assert.equal(openKeyFile(f).retiring.privateKey, undefined);
  id.retired('a');
  id.retired('zzz');
  assert.deepEqual(id.retiring(), { id: first, machines: ['b'] });
  id.retired('b');
  assert.equal(id.retiring(), null);
  id.retired('b');
  // nothing to promote without a start; nothing to retire without machines
  assert.throws(() => id.promote([]), /No rotation is under way/);
  id.startRotation();
  id.promote([]);
  assert.equal(id.retiring(), null);
});

test('a manifest with a key change is v3, names the app’s current key, and the Host’s check accepts exactly that', async () => {
  const id = loadIdentity(file(), keySafe);
  const sent: any[] = [];
  const HOST = 'ab'.repeat(16);
  const updater = createHostUpdater({
    session: async () => ({ close: () => undefined }),
    allowed: () => true,
    channel: async (_d: string, command: string, input?: Buffer) => {
      if (command.includes('process.report')) return { code: 0, stdout: 'linux-x64-gnu\n', stderr: '' };
      if (input && command.includes('manifest.json')) sent.push(JSON.parse(input.toString()));
      return { code: 0, stdout: '', stderr: '' };
    },
    registry: { list: () => [{ id: 'm', address: 'me@box' }], hostKey: () => HOST },
    bundle: async () => ({ file: path.join(base, 'a.tgz'), sha256: 'c'.repeat(64), version: '1' }),
    identity: () => id,
    isCurrent: () => true,
  });
  fs.writeFileSync(path.join(base, 'a.tgz'), 'x');
  const next = id.startRotation();
  await updater.update('m', { nextKey: next.pem });
  await updater.update('m');
  const [withKey, plain] = sent;
  assert.deepEqual([withKey.keyId, withKey.nextKey], [id.keyId, next.pem]);
  assert.equal(plain.keyId, undefined, 'an ordinary update stays a v2 manifest, so a Host from before key rotation takes it');
  const key = pemOfB64(id.publicKey);
  assert.equal((checkManifest(withKey, { keys: [key], hostId: HOST, now: Date.now(), floor: null }) as any).ok, true);
  assert.equal(
    (checkManifest({ ...withKey, nextKey: 'other' }, { keys: [key], hostId: HOST, now: Date.now(), floor: null }) as any).ok,
    false,
  );
  assert.equal(keyIdOf(key), id.keyId);
});

type M = { id: string; name?: string; address: string; status?: string };
function world(machines: M[], o: { fail?: (id: string, change: any) => Error | null; stale?: string[]; newer?: string[] } = {}) {
  const id = loadIdentity(file(), keySafe);
  const sent: [string, any][] = [];
  let list = machines;
  const rotation = createKeyRotation({
    registry: { list: () => list },
    updater: {
      update: async (m: string, change: any) => {
        const refused = o.fail?.(m, change);
        if (refused) throw refused;
        sent.push([m, change]);
      },
    },
    identity: () => id,
    current: (r: { id: string }) => !(o.stale ?? []).includes(r.id),
    newer: (r: { id: string }) => (o.newer ?? []).includes(r.id),
  });
  return { id, sent, rotation, drop: (gone: string) => (list = list.filter((m) => m.id !== gone)) };
}
const box = (id: string, extra: object = {}): M => ({ id, name: id, address: `me@${id}`, status: 'online', ...extra });

test('every machine takes the new key, then the app switches, then each drops the old one', async () => {
  const w = world([box('a'), box('b')]);
  const old = w.id.keyId;
  const out = await w.rotation.rotate();
  assert.deepEqual(out, { machines: 2, pending: [] });
  assert.deepEqual(
    w.sent.map(([m, c]) => [m, Object.keys(c)[0]]),
    [
      ['a', 'nextKey'],
      ['b', 'nextKey'],
      ['a', 'revoke'],
      ['b', 'revoke'],
    ],
  );
  assert.notEqual(w.id.keyId, old);
  assert.deepEqual(w.sent[2][1], { revoke: [old] });
  assert.equal(w.sent[0][1].nextKey.includes('BEGIN PUBLIC KEY'), true);
  assert.equal(w.id.retiring(), null);
});

test('a partial key distribution keeps the app identity, reports remote changes honestly, and retries the same key', async () => {
  let down = true;
  const w = world([box('a'), box('b', { name: 'build-box' })], { fail: (id) => (id === 'b' && down ? new Error('No route') : null) });
  const old = w.id.keyId;
  await assert.rejects(
    w.rotation.rotate(),
    (e: any) =>
      e.code === 'rotation_failed' &&
      /Could not confirm the new key on build-box: No route/.test(e.message) &&
      /This Mac still uses its current key/.test(e.message) &&
      /Some machines may already trust the new key/.test(e.message) &&
      !/Nothing was changed/.test(e.message),
  );
  assert.equal(w.id.keyId, old, 'the app still uses the old key');
  const tried = w.sent[0][1].nextKey;
  down = false;
  await w.rotation.rotate();
  assert.equal(w.sent.find(([m, c]) => m === 'b' && c.nextKey)?.[1].nextKey, tried, 'the same next key');
  assert.notEqual(w.id.keyId, old);
});

test('a machine that is offline, has no ssh or is out of date blocks the rotation before anything is sent, and says which', async () => {
  const w = world([box('a'), box('b', { status: 'offline' }), box('c', { address: 'relay:x' }), box('d')], { stale: ['d'] });
  await assert.rejects(
    w.rotation.rotate(),
    (e: any) => e.code === 'rotation_blocked' && /online and up to date first: b, d\./.test(e.message) && /: c\./.test(e.message),
  );
  assert.deepEqual(w.sent, []);
  // a machine without a name is named by its id
  const unnamed = world([{ id: 'x', address: 'relay:x' }]);
  await assert.rejects(unnamed.rotation.rotate(), /: x\./);
  const unnamedFail = world([{ id: 'y', address: 'me@y' }], { fail: () => new Error('boom') });
  await assert.rejects(unnamedFail.rotation.rotate(), /Could not confirm the new key on y: Boom/);
});

test('#4912: a machine added by command is named with the way out, and the rest of the reasons are not mixed with it', async () => {
  const w = world([box('a'), box('c', { address: 'relay:x' })]);
  await assert.rejects(
    w.rotation.rotate(),
    (e: any) =>
      e.code === 'rotation_blocked' &&
      /No ssh to give a new key: c\. Remove it, rotate, then add it again\./.test(e.message) &&
      !/up to date/.test(e.message),
  );
  assert.deepEqual(w.sent, [], 'nothing is sent, and the app keeps the key the machine trusts');
  // once it is removed the rotation goes through
  w.drop('c');
  assert.equal((await w.rotation.rotate()).machines, 1);
});

test('#4923: a Host newer than the app blocks the rotation, which would replace it with this app’s older build', async () => {
  const w = world([box('a'), box('n')], { newer: ['n'] });
  await assert.rejects(w.rotation.rotate(), (e: any) => e.code === 'rotation_blocked' && /Update MoPilot first: n\./.test(e.message));
  assert.deepEqual(w.sent, []);
});

test('a machine that does not drop the old key is remembered and told on the next run; one that was removed meanwhile is forgotten', async () => {
  let refuse = true;
  const w = world([box('a'), box('b'), box('c')], { fail: (id, c) => (c.revoke && id === 'b' && refuse ? new Error('asleep') : null) });
  const old = w.id.keyId;
  const first = await w.rotation.rotate();
  assert.deepEqual(first, { machines: 2, pending: [{ id: 'b', error: 'Asleep.' }] });
  assert.deepEqual(w.id.retiring(), { id: old, machines: ['b'] });
  // the machine comes back; another that was waiting is gone
  refuse = false;
  const again = await w.rotation.rotate();
  assert.deepEqual(again, { machines: 1, pending: [] });
  assert.equal(w.id.retiring(), null);
  assert.deepEqual(w.sent.at(-1), ['b', { revoke: [old] }]);
  // a retiring machine that left the list is dropped without being asked
  const gone = world([box('a'), box('b')], { fail: (_id, c) => (c.revoke ? new Error('asleep') : null) });
  await gone.rotation.rotate();
  gone.drop('b');
  const fin = await gone.rotation.rotate();
  assert.equal(gone.id.retiring()?.machines.includes('b'), false);
  assert.deepEqual(
    fin.pending.map((p: any) => p.id),
    ['a'],
  );
  assert.equal(fin.machines, 1);
});

test('no machines: the key is simply replaced', async () => {
  const w = world([]);
  const old = w.id.keyId;
  assert.deepEqual(await w.rotation.rotate(), { machines: 0, pending: [] });
  assert.notEqual(w.id.keyId, old);
  assert.equal(w.id.retiring(), null);
});

test('a connection that lives across a rotation names the key the app has now, so it can still sign in', () => {
  const { pinned, authenticate } = require('../electron/host/pairingClient.cjs');
  const id = loadIdentity(file(), keySafe);
  const held = pinned(id, null, () => undefined);
  const before = held.publicKey;
  id.startRotation();
  id.promote([]);
  assert.notEqual(held.publicKey, before, 'the connection reads the new key');
  assert.equal(held.publicKey, id.publicKey);
  assert.equal(held.pin.expected, null);
  assert.equal(typeof authenticate, 'function');
});

test('a machine paired while the rotation runs stops it before the app switches, and a second call joins the one under way', async () => {
  const added = box('late');
  let list = [box('a')];
  const id = loadIdentity(file(), keySafe);
  const sent: string[] = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => (release = r));
  const rotation = createKeyRotation({
    registry: { list: () => list },
    updater: {
      update: async (m: string) => {
        sent.push(m);
        await gate;
        list = [...list, added];
      },
    },
    identity: () => id,
    current: () => true,
  });
  const old = id.keyId;
  const first = rotation.rotate();
  const second = rotation.rotate();
  assert.equal(first, second, 'one rotation at a time');
  release();
  await assert.rejects(
    first,
    (e: any) =>
      e.code === 'rotation_failed' &&
      /added during the rotation/.test(e.message) &&
      /Some machines may already trust the new key/.test(e.message),
  );
  assert.equal(id.keyId, old, 'nothing was switched');
  assert.deepEqual(sent, ['a']);
  // the next call is a new rotation
  assert.notEqual(rotation.rotate(), first);
});
