// Computer access (#1364): the store keeps its keys encrypted, fails closed when it can't be read, and a revoked,
// expired or re-paired device gets none of what it had.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AccessStore, StoreError, DEFAULT_SCOPES, IDLE_MS } = require('../electron/computerAccess/store.cjs');
const { newKeyPair } = require('../electron/computerAccess/handshake.cjs');

/** A safeStorage stand-in: "encrypts" by tagging, and refuses text it did not tag (another keychain). */
function fakeSafe(o: { available?: boolean | (() => boolean) } = {}) {
  return {
    isEncryptionAvailable: typeof o.available === 'function' ? o.available : () => o.available ?? true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => {
      const s = b.toString();
      if (!s.startsWith('enc:')) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
      return s.slice(4);
    },
  };
}

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-access-'));
  file = path.join(dir, 'computer-access', 'store.json');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** Writes a saved store with this (decrypted) content. */
function saved(inner: unknown, outer: Record<string, unknown> = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ v: 1, data: Buffer.from(`enc:${JSON.stringify(inner)}`).toString('base64'), ...outer }));
}

const validInner = () => ({
  v: 1,
  identity: newKeyPair(),
  enabled: true,
  lan: false,
  devices: [{ id: '0123456789abcdef', name: 'Phone', key: newKeyPair().x, scopes: { browser: true }, pairedAt: 1, lastSeen: 2 }],
  hosts: [{ id: 'fedcba9876543210', name: 'Studio', key: newKeyPair().x, address: '[::1]', port: 47616, pairedAt: 3 }],
});

test('a new store is off, has no devices, and saves its identity encrypted once it is first asked for', () => {
  const s = new AccessStore({ file, safeStorage: fakeSafe() });
  assert.equal(s.problem(), null);
  assert.equal(s.enabled(), false);
  assert.equal(s.lan(), false);
  assert.deepEqual(s.devices(), []);
  assert.deepEqual(s.hosts(), []);
  assert.equal(fs.existsSync(file), false);
  const id = s.identity();
  assert.equal(s.identity(), id);
  const text = fs.readFileSync(file, 'utf8');
  // the private key is never in the file in the clear
  assert.equal(text.includes(id.d), false);
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600');
  // another process run reads the same identity back
  assert.deepEqual(new AccessStore({ file, safeStorage: fakeSafe() }).identity(), id);
});

test('without safeStorage nothing is saved and access cannot be turned on', () => {
  const s = new AccessStore({ file, safeStorage: fakeSafe({ available: false }) });
  assert.equal(s.available, false);
  assert.throws(
    () => s.identity(),
    (e: any) => e instanceof StoreError && e.code === 'unavailable',
  );
  assert.throws(() => s.setEnabled(true), { code: 'unavailable' });
  assert.equal(s.enabled(), false);
  assert.equal(fs.existsSync(file), false);
  const t = new AccessStore({
    file,
    safeStorage: fakeSafe({
      available: () => {
        throw new Error('keychain locked');
      },
    }),
  });
  assert.equal(t.available, false);
});

test('switches, devices and computers are kept across process runs', () => {
  let now = 10_000;
  const s = new AccessStore({ file, safeStorage: fakeSafe(), now: () => now });
  s.setEnabled(true);
  s.setLan(true);
  const key = newKeyPair().x;
  const d = s.addDevice({ name: 'Du’s iPhone', key });
  assert.deepEqual(d.scopes, DEFAULT_SCOPES);
  assert.equal(d.expired, false);
  assert.equal(d.hostOnlyApprovals, false);
  const h = s.addHost({ name: 'Studio Mac', key: newKeyPair().x, address: 'studio.local', port: 47616 });
  const r = new AccessStore({ file, safeStorage: fakeSafe(), now: () => now });
  assert.equal(r.enabled(), true);
  assert.equal(r.lan(), true);
  assert.equal(r.deviceByKey(key).id, d.id);
  assert.deepEqual(r.hosts(), [h]);
  r.setEnabled(false);
  r.setLan(false);
  assert.equal(r.enabled(), false);
  assert.equal(r.lan(), false);
  now += 1;
});

test('a device revoked or idle for 30 days is not found by its key; touching it keeps it', () => {
  let now = 1_000;
  const s = new AccessStore({ file, safeStorage: fakeSafe(), now: () => now });
  const key = newKeyPair().x;
  const d = s.addDevice({ name: 'Phone', key, scopes: { browser: true, apps: true, files: 'yes' } });
  assert.deepEqual(d.scopes, { browser: true, chrome: false, apps: true, files: false });
  now += IDLE_MS - 10;
  s.touchDevice(d.id);
  now += IDLE_MS - 10;
  assert.equal(s.deviceByKey(key)?.id, d.id);
  now += 20;
  assert.equal(s.deviceByKey(key), null);
  assert.equal(s.devices()[0].expired, true);
  // re-pairing the same key: a new id, so none of the old device's grants follow it
  const again = s.addDevice({ name: 'Phone', key });
  assert.notEqual(again.id, d.id);
  assert.equal(s.devices().length, 1);
  assert.equal(s.revokeDevice(again.id), true);
  assert.equal(s.revokeDevice(again.id), false);
  assert.equal(s.deviceByKey(key), null);
  assert.equal(s.deviceByKey('nope'), null);
});

test('device settings: scopes and approvals on this Mac only; an unknown device or key is refused', () => {
  const s = new AccessStore({ file, safeStorage: fakeSafe() });
  const d = s.addDevice({ name: 'Phone', key: newKeyPair().x });
  const other = s.addDevice({ name: 'Tablet', key: newKeyPair().x });
  s.setDevice(d.id, { scopes: { chrome: true } });
  s.setDevice(d.id, { hostOnlyApprovals: true });
  s.setDevice(d.id, {});
  s.setDevice(other.id, { scopes: 'everything' });
  s.touchDevice(d.id);
  const [a, b] = s.devices();
  assert.deepEqual(a.scopes, { browser: false, chrome: true, apps: false, files: false });
  assert.equal(a.hostOnlyApprovals, true);
  assert.equal(b.id, other.id);
  assert.equal(b.hostOnlyApprovals, false);
  assert.deepEqual(b.scopes, { browser: false, chrome: false, apps: false, files: false });
  assert.equal(b.lastSeen, null);
  assert.equal(typeof a.lastSeen, 'number');
  assert.throws(() => s.setDevice('0000000000000000', { hostOnlyApprovals: true }), { code: 'no_device' });
  assert.throws(() => s.addDevice({ name: 'x', key: 'short' }), { code: 'bad_device' });
  assert.throws(() => s.addDevice(null), { code: 'bad_device' });
  // the same key in a non-canonical spelling is not taken (pinned keys are compared as text)
  const key = newKeyPair().x;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const odd = key.slice(0, 42) + alphabet[alphabet.indexOf(key[42]) + 1];
  assert.throws(() => s.addDevice({ name: 'x', key: odd }), { code: 'bad_device' });
});

test('computers: added, replaced by key, removed; a bad address or port is refused', () => {
  const s = new AccessStore({ file, safeStorage: fakeSafe() });
  const key = newKeyPair().x;
  const a = s.addHost({ name: 'Studio', key, address: '192.168.1.2', port: 47616 });
  const b = s.addHost({ name: 'Studio', key, address: '192.168.1.3', port: 47616 });
  assert.notEqual(a.id, b.id);
  assert.deepEqual(
    s.hosts().map((h: any) => h.address),
    ['192.168.1.3'],
  );
  assert.equal(s.removeHost(b.id), true);
  assert.equal(s.removeHost(b.id), false);
  assert.throws(() => s.addHost({ name: 'x', key, address: 'a b', port: 1 }), { code: 'bad_host' });
  assert.throws(() => s.addHost({ name: 'x', key, address: 'h', port: 0 }), { code: 'bad_host' });
  assert.throws(() => s.addHost({ name: 'x', key: 'k', address: 'h', port: 1 }), { code: 'bad_host' });
  assert.throws(() => s.addHost(undefined), { code: 'bad_host' });
});

test('a valid saved store is read as it was', () => {
  const inner = validInner();
  saved(inner);
  const s = new AccessStore({ file, safeStorage: fakeSafe(), now: () => 5 });
  assert.equal(s.problem(), null);
  assert.equal(s.enabled(), true);
  assert.deepEqual(s.identity(), inner.identity);
  assert.equal(s.devices()[0].scopes.browser, true);
  assert.equal(s.hosts()[0].address, '[::1]');
});

for (const [what, write] of [
  ['not JSON', () => fs.writeFileSync(file, '{oops')],
  ['another keychain', () => fs.writeFileSync(file, JSON.stringify({ v: 1, data: Buffer.from('xx').toString('base64') }))],
  ['a newer version', () => saved(validInner(), { v: 2 })],
  ['an inner version it does not know', () => saved({ ...validInner(), v: 3 })],
  ['no identity', () => saved({ ...validInner(), identity: null })],
  ['no on/off', () => saved({ ...validInner(), enabled: 'yes' })],
  ['no network switch', () => saved({ ...validInner(), lan: 1 })],
  ['devices not a list', () => saved({ ...validInner(), devices: {} })],
  ['a device without a key', () => saved({ ...validInner(), devices: [{ ...validInner().devices[0], key: 'x' }] })],
  ['a device with a bad id', () => saved({ ...validInner(), devices: [{ ...validInner().devices[0], id: 'Z' }] })],
  ['a device without a name', () => saved({ ...validInner(), devices: [{ ...validInner().devices[0], name: 1 }] })],
  ['a device without a pairing time', () => saved({ ...validInner(), devices: [{ ...validInner().devices[0], pairedAt: -1 }] })],
  ['a device with a bad last use', () => saved({ ...validInner(), devices: [{ ...validInner().devices[0], lastSeen: 'x' }] })],
  ['a device without scopes', () => saved({ ...validInner(), devices: [{ ...validInner().devices[0], scopes: null }] })],
  [
    'a device with scopes that are not an object',
    () => saved({ ...validInner(), devices: [{ ...validInner().devices[0], scopes: 'all' }] }),
  ],
  ['a null device', () => saved({ ...validInner(), devices: [null] })],
  ['computers not a list', () => saved({ ...validInner(), hosts: null })],
  ['a computer with a bad port', () => saved({ ...validInner(), hosts: [{ ...validInner().hosts[0], port: 0 }] })],
  ['a computer with a bad id', () => saved({ ...validInner(), hosts: [{ ...validInner().hosts[0], id: 'Q' }] })],
  ['a computer without a name', () => saved({ ...validInner(), hosts: [{ ...validInner().hosts[0], name: null }] })],
  ['a computer with a bad key', () => saved({ ...validInner(), hosts: [{ ...validInner().hosts[0], key: '' }] })],
  ['a computer with a bad address', () => saved({ ...validInner(), hosts: [{ ...validInner().hosts[0], address: 'a b' }] })],
  ['a computer without a pairing time', () => saved({ ...validInner(), hosts: [{ ...validInner().hosts[0], pairedAt: null }] })],
  ['a null computer', () => saved({ ...validInner(), hosts: [null] })],
  ['an empty store', () => saved(null)],
] as const) {
  test(`a saved store that is ${what} trusts no device, is never written over, and can be reset`, () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    write();
    const s = new AccessStore({ file, safeStorage: fakeSafe() });
    assert.match(s.problem(), /could not be read/);
    assert.equal(s.enabled(), false);
    assert.equal(s.lan(), false);
    assert.deepEqual(s.devices(), []);
    assert.deepEqual(s.hosts(), []);
    assert.equal(s.deviceByKey(validInner().devices[0].key), null);
    const before = fs.readFileSync(file, 'utf8');
    assert.throws(() => s.identity(), { code: 'unreadable' });
    assert.throws(() => s.setEnabled(true), /Reset computer access/);
    assert.throws(() => s.addDevice({ name: 'x', key: newKeyPair().x }), { code: 'unreadable' });
    assert.equal(s.revokeDevice('0123456789abcdef'), false);
    assert.equal(s.removeHost('fedcba9876543210'), false);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    const fresh = s.reset();
    assert.equal(fresh.enabled, false);
    assert.equal(s.problem(), null);
    assert.equal(fs.readFileSync(`${file}.unreadable`, 'utf8'), before);
    assert.equal(new AccessStore({ file, safeStorage: fakeSafe() }).problem(), null);
  });
}

test('a second reset keeps the first unreadable copy for support', () => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{first');
  new AccessStore({ file, safeStorage: fakeSafe() }).reset();
  fs.writeFileSync(file, '{second');
  const s = new AccessStore({ file, safeStorage: fakeSafe() });
  assert.ok(s.problem());
  s.reset();
  assert.equal(fs.readFileSync(`${file}.unreadable`, 'utf8'), '{first');
  assert.equal(s.problem(), null);
});

test('a store that is a folder is unreadable; reset keeps going when the unreadable file is already gone', () => {
  fs.mkdirSync(file, { recursive: true });
  const s = new AccessStore({ file, safeStorage: fakeSafe() });
  assert.match(s.problem(), /could not be read$/);
  fs.rmSync(file, { recursive: true });
  fs.writeFileSync(file, '{');
  const t = new AccessStore({ file, safeStorage: fakeSafe() });
  assert.ok(t.problem());
  fs.rmSync(file);
  t.reset();
  assert.equal(t.problem(), null);
  // a reset with nothing wrong just starts over
  const id = t.identity();
  t.reset();
  assert.notDeepEqual(t.identity(), id);
});
