// Mobile Remote's sealed stores (electron/remote/sealedJson.cjs, identity.cjs, deviceList.cjs): the identity made once and only sealed, nothing written without encryption, a file that can't be opened never replaced, and the device list's ordered whole-file writes, rollback when a write fails, rename, remove, re-pair, and the 30-day rotation hook.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fakeSafe, fs, prim, tempDir } from './support/remoteKit.ts';
import { deferred, tick } from './support/async-scenarios.ts';

const require = createRequire(import.meta.url);
const { IdentityStore } = require('../electron/remote/identity.cjs');
const { DeviceList, ROTATE_AFTER_MS, MAX_NAME } = require('../electron/remote/deviceList.cjs');
const { readSealedJson } = require('../electron/remote/sealedJson.cjs');

const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e: any) {
    return e.code;
  }
  return null;
};

test('identity: made on first use, sealed on the disk, and the same one after a restart', async () => {
  const file = join(tempDir(), 'sub', 'identity.key');
  const safe = fakeSafe();
  const a = await new IdentityStore({ file, safe, fs, prim }).get();
  const raw = await fs.readFile(file, 'utf8');
  assert.ok(!raw.includes('"sk"') && raw.length > 0, 'sealed, not JSON');
  assert.equal(((await fs.stat(file)).mode & 0o777).toString(8), '600');
  const b = await new IdentityStore({ file, safe, fs, prim }).get();
  assert.equal(b.macId, a.macId);
  assert.match(a.macId, /^mac_[0-9a-f]{24}$/);
  assert.deepEqual(b.x.sk, a.x.sk);
  assert.deepEqual(b.ed.pk, a.ed.pk);
  assert.deepEqual(prim.x25519Base(a.x.sk), a.x.pk);
});

test('identity: two first uses at once make one identity', async () => {
  const file = join(tempDir(), 'identity.key');
  const store = new IdentityStore({ file, safe: fakeSafe(), fs, prim });
  const [a, b] = await Promise.all([store.get(), store.get()]);
  assert.equal(a, b);
});

test('identity: without encryption nothing is written, and it works once encryption is back', async () => {
  const dir = tempDir();
  const file = join(dir, 'identity.key');
  const safe = fakeSafe({ available: false });
  const store = new IdentityStore({ file, safe, fs, prim });
  assert.equal(await codeOf(store.get()), 'unavailable');
  assert.deepEqual(await fs.readdir(dir), []);
  safe.available = true;
  assert.match((await store.get()).macId, /^mac_/);
});

test('identity: a file that can not be opened is an error, never replaced; reset makes a new one', async () => {
  const file = join(tempDir(), 'identity.key');
  const safe = fakeSafe();
  const first = await new IdentityStore({ file, safe, fs, prim }).get();
  const store = new IdentityStore({ file, safe, fs, prim });
  safe.broken = true;
  assert.equal(await codeOf(store.get()), 'unreadable');
  safe.broken = false;
  const before = await fs.readFile(file, 'utf8');
  await fs.writeFile(file, 'not sealed at all');
  assert.equal(await codeOf(store.get()), 'unreadable');
  await fs.writeFile(file, before);
  assert.equal((await store.get()).macId, first.macId, 'a failure is not remembered');
  await store.reset();
  assert.notEqual((await store.get()).macId, first.macId);
});

test('identity: a sealed file of another shape is corrupt, not a new identity', async () => {
  const file = join(tempDir(), 'identity.key');
  const safe = fakeSafe();
  for (const body of ['{"v":2}', '{"v":1,"x":{"pk":"zz","sk":"00"},"ed":{}}', 'nope']) {
    await fs.writeFile(file, safe.encryptString(body).toString('base64'));
    assert.equal(await codeOf(new IdentityStore({ file, safe, fs, prim }).get()), 'corrupt');
  }
});

test('sealed file: an unreadable path is reported as unreadable', async () => {
  const dir = tempDir();
  assert.equal(await codeOf(readSealedJson({ file: dir, safe: fakeSafe(), fs })), 'unreadable');
});

const phone = (id: string, extra: object = {}) => ({
  id,
  name: ` ${id} `,
  pairId: `p_${id}`,
  pub: 'AA==',
  edPub: 'AA==',
  tx: { ctr: 0, chain: '00' },
  rx: { ctr: 0, chain: '00' },
  ...extra,
});

function list(o: { now?: () => number; safe?: any; hook?: (d: any) => unknown } = {}) {
  const file = join(tempDir(), 'devices.key');
  const safe = o.safe ?? fakeSafe();
  const make = () => new DeviceList({ file, safe, fs, now: o.now, onRotationDue: o.hook });
  return { file, safe, make, devices: make() };
}

test('device list: add, rename, remove survive a restart and are sealed', async () => {
  const { file, make, devices } = list();
  assert.equal(await devices.add(phone('a')), true);
  await devices.add(phone('b'));
  assert.equal(await devices.rename('a', '  Du’s iPhone '), true);
  assert.equal(await devices.rename('zzz', 'x'), false);
  assert.equal(await devices.remove('b'), true);
  assert.equal(await devices.remove('b'), false);
  assert.ok(!(await fs.readFile(file, 'utf8')).includes('iPhone'));
  const again = make();
  await again.load();
  assert.deepEqual(
    again.list().map((d: any) => [d.id, d.name]),
    [['a', 'Du’s iPhone']],
  );
  assert.equal(again.get('a').pairId, 'p_a');
  assert.equal(again.byPair('p_a').id, 'a');
  assert.equal(again.byPair('p_x'), null);
  assert.equal(again.get('x'), null);
});

test('device list: names are trimmed, bounded and never empty', async () => {
  const { devices } = list();
  await devices.add(phone('a', { name: 'x'.repeat(200) }));
  assert.equal(devices.get('a').name.length, MAX_NAME);
  await devices.rename('a', '   ');
  assert.equal(devices.get('a').name, 'Phone');
  await devices.rename('a', 5 as any);
  assert.equal(devices.get('a').name, 'Phone');
});

test('device list: a re-pair replaces the phone with the same id and starts its counters again', async () => {
  let t = 1000;
  const { devices } = list({ now: () => t });
  await devices.add(phone('a', { tx: { ctr: 50, chain: 'aa' } }));
  t = 5000;
  await devices.add(phone('a', { pairId: 'p_new' }));
  const d = devices.get('a');
  assert.deepEqual([d.pairId, d.tx.ctr, d.createdAt, d.rotatedAt, d.lastSeenAt], ['p_new', 0, 5000, 5000, null]);
  assert.equal(devices.list().length, 1);
});

test('device list: update merges ratchet state and last seen; an unknown phone is false', async () => {
  const { devices } = list();
  await devices.add(phone('a'));
  assert.equal(await devices.update('a', { rx: { ctr: 3, chain: 'bb' }, lastSeenAt: 9 }), true);
  assert.equal(await devices.update('q', { lastSeenAt: 1 }), false);
  assert.deepEqual([devices.get('a').rx.ctr, devices.get('a').lastSeenAt], [3, 9]);
});

test('device list: an update that names a pair other than the phone’s current one is refused', async () => {
  const { devices } = list();
  await devices.add(phone('a'));
  assert.equal(await devices.update('a', { lastSeenAt: 1 }, 'p_other'), false);
  assert.equal(devices.get('a').lastSeenAt, null);
  assert.equal(await devices.update('a', { lastSeenAt: 2 }, 'p_a'), true);
  assert.equal(devices.get('a').lastSeenAt, 2);
});

test('device list: copies out, so a caller can not change the list', async () => {
  const { devices } = list();
  await devices.add(phone('a'));
  devices.get('a').name = 'hacked';
  devices.list()[0].tx.ctr = 99;
  assert.equal(devices.get('a').name, 'a');
  assert.equal(devices.get('a').tx.ctr, 0);
});

test('device list: changes are written one at a time in the order they were made', async () => {
  const { devices } = list();
  const order: string[] = [];
  const realFs = devices.o.fs;
  const gate = deferred<void>();
  let first = true;
  devices.o.fs = {
    ...realFs,
    mkdir: realFs.mkdir,
    open: async (...a: any[]) => {
      if (first) {
        first = false;
        await gate.promise;
      }
      return realFs.open(...a);
    },
    rename: async (...a: any[]) => {
      order.push(String(a[1]).includes('devices') ? 'rename' : '?');
      return realFs.rename(...a);
    },
    rm: realFs.rm,
  };
  const one = devices.add(phone('a'));
  const two = devices.add(phone('b'));
  const three = devices.rename('a', 'late');
  await tick();
  assert.deepEqual(devices.list(), [], 'nothing counts before it is written');
  gate.resolve();
  await Promise.all([one, two, three]);
  assert.deepEqual(
    devices.list().map((d: any) => d.name),
    ['late', 'b'],
  );
  assert.equal(order.length, 3);
});

test('device list: a failed write leaves the list as it was and the next change still works', async () => {
  const { devices, safe } = list();
  await devices.add(phone('a'));
  safe.available = false;
  assert.equal(await codeOf(devices.add(phone('b'))), 'unavailable');
  assert.equal(await codeOf(devices.remove('a')), 'unavailable');
  assert.deepEqual(
    devices.list().map((d: any) => d.id),
    ['a'],
  );
  safe.available = true;
  await devices.add(phone('c'));
  assert.deepEqual(
    devices.list().map((d: any) => d.id),
    ['a', 'c'],
  );
});

test('device list: a file that can not be opened or understood is never overwritten', async () => {
  const { file, make, devices, safe } = list();
  await devices.add(phone('a'));
  const before = await fs.readFile(file, 'utf8');
  safe.broken = true;
  const locked = make();
  assert.equal(await codeOf(locked.add(phone('b'))), 'unreadable');
  safe.broken = false;
  assert.equal(await fs.readFile(file, 'utf8'), before);
  await fs.writeFile(file, safe.encryptString('{"v":9}').toString('base64'));
  assert.equal(await codeOf(make().load()), 'corrupt');
  assert.equal(
    await make()
      .add(phone('z'))
      .catch((e: any) => e.code),
    'corrupt',
  );
  await fs.writeFile(file, before);
  const ok = make();
  await ok.load();
  assert.equal(ok.list().length, 1, 'a failed load is retried');
});

test('device list: records without an id in the file are dropped', async () => {
  const { file, make, safe } = list();
  await fs.writeFile(file, safe.encryptString(JSON.stringify({ v: 1, devices: [{ name: 'x' }, phone('k')] })).toString('base64'));
  const d = make();
  await d.load();
  assert.deepEqual(
    d.list().map((x: any) => x.id),
    ['k'],
  );
});

test('device list: listeners hear each change; one that throws does not stop the rest or the write', async () => {
  const { devices } = list();
  const heard: number[] = [];
  const off = devices.onChange(() => {
    throw new Error('boom');
  });
  devices.onChange((l: any[]) => heard.push(l.length));
  await devices.add(phone('a'));
  off();
  await devices.add(phone('b'));
  assert.deepEqual(heard, [1, 2]);
});

test('device list: a pair key older than 30 days goes to the rotation hook, and a failing hook does not stop the others', async () => {
  let t = 0;
  const seen: string[] = [];
  const { devices } = list({
    now: () => t,
    hook: (d: any) => {
      seen.push(d.id);
      if (d.id === 'a') throw new Error('rotation failed');
    },
  });
  await devices.add(phone('a'));
  t = ROTATE_AFTER_MS - 1;
  await devices.add(phone('b'));
  await devices.checkRotation();
  assert.deepEqual(seen, []);
  t = ROTATE_AFTER_MS;
  assert.deepEqual(
    devices.dueForRotation().map((d: any) => d.id),
    ['a'],
  );
  t = ROTATE_AFTER_MS * 2;
  await devices.checkRotation();
  assert.deepEqual(seen, ['a', 'b']);
  await devices.update('a', { rotatedAt: t });
  assert.deepEqual(
    devices.dueForRotation().map((d: any) => d.id),
    ['b'],
  );
});

test('device list: with no rotation hook the check does nothing', async () => {
  const { devices } = list({ now: () => 0 });
  await devices.add(phone('a'));
  await devices.checkRotation();
});
