// The phone's own enrollment with a Host (shared/remote/phoneDirectEnroll.mjs, phoneVault hosts): both ends derive the same root, each
// failure takes back what the steps before it made, and a person who gave up leaves nothing on the relay or the Host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNodePrimitives } from '../shared/remote/nodePrimitives.mjs';
import { createCrypto } from '../shared/remote/crypto.mjs';
import { createPhoneVault } from '../shared/remote/phoneVault.mjs';
import { fromBase64, toBase64, toHex, utf8 } from '../shared/remote/envelope.mjs';
import { enrollDirect, DirectEnrollError } from '../shared/remote/phoneDirectEnroll.mjs';

const prim = createNodePrimitives();
const c = createCrypto(prim);

function rig(o: { macFails?: any; saveFails?: boolean; current?: () => boolean } = {}) {
  const log: string[] = [];
  let registered: any = null;
  let hostRoot: Uint8Array | null = null;
  const edPair = prim.edKeypair();
  const lane = {
    register: async (h: any) => (log.push('register'), (registered = h)),
    revoke: async (host: string) => void log.push(`revoke:${host}`),
  };
  const enroll = async (p: any) => {
    log.push('enroll');
    if (o.macFails) throw o.macFails;
    // the Host's half, as host/src/relayLink.mjs makes it
    const sk = prim.randomBytes(32);
    const ephSk = prim.randomBytes(32);
    hostRoot = c.deriveRoot(sk, fromBase64(p.appPub), ephSk, fromBase64(p.appEphPub), 'app', p.relay.hostId, p.relay.pairId);
    return {
      hostPub: toBase64(prim.x25519Base(sk)),
      hostEphPub: toBase64(prim.x25519Base(ephSk)),
      hostKey: 'a'.repeat(32),
      name: 'build-box',
      features: ['clients'],
      seen: p,
    };
  };
  const saved: any[] = [];
  const run = () =>
    enrollDirect({
      prim,
      identity: { ed: { pk: edPair.pk } },
      machineId: 'ssh:box',
      name: 'Pocket iPhone',
      relayUrl: 'wss://relay.example/v1/ws',
      lane,
      enroll,
      forget: async () => void log.push('forget'),
      save: async (r: any) => {
        if (o.saveFails) throw new Error('disk full');
        saved.push(r);
      },
      current: o.current,
    });
  return { run, log, saved, registered: () => registered, hostRoot: () => hostRoot, edPair };
}

test('both ends derive the same root, the relay holds the secret only as a hash, and the record is kept', async () => {
  const r = rig();
  const record = await r.run();
  assert.deepEqual(fromBase64(record.root), r.hostRoot());
  assert.deepEqual(r.log, ['register', 'enroll']);
  assert.match(record.hostId, /^h_[A-Za-z0-9_-]{22}$/);
  assert.match(record.pairId, /^p_[A-Za-z0-9_-]{16}$/);
  assert.equal(r.registered().host, record.hostId);
  assert.equal(r.registered().hash.length, 64);
  assert.doesNotMatch(JSON.stringify(record), /secret/);
  assert.deepEqual(r.saved, [record]);
  assert.deepEqual(
    [record.machineId, record.hostKey, record.name, record.relayUrl],
    ['ssh:box', 'a'.repeat(32), 'build-box', 'wss://relay.example/v1/ws'],
  );
});

test('the hash the relay gets is the secret the Mac was handed', async () => {
  let handed: any = null;
  const r = rig();
  const edPair = r.edPair;
  let hash = '';
  await enrollDirect({
    prim,
    identity: { ed: { pk: edPair.pk } },
    machineId: 'm',
    name: 'p',
    relayUrl: 'wss://relay.example/v1/ws',
    lane: { register: async (h: any) => void (hash = h.hash), revoke: async () => undefined },
    enroll: async (p: any) => {
      handed = p;
      const sk = prim.randomBytes(32);
      return { hostPub: toBase64(prim.x25519Base(sk)), hostEphPub: toBase64(prim.x25519Base(sk)), hostKey: 'k', name: 'n', features: [] };
    },
    forget: async () => undefined,
    save: async () => undefined,
  });
  assert.equal(hash, toHex(prim.sha256(utf8(handed.relay.secret))));
  assert.deepEqual([...fromBase64(handed.edPub)], [...edPair.pk]);
});

test('a Mac that refuses takes the relay credential back; an older Host reads as Update <machine>', async () => {
  const refused = rig({ macFails: Object.assign(new Error('Update build-box.'), { code: 'update_host' }) });
  await assert.rejects(refused.run(), (e: any) => e instanceof DirectEnrollError && e.code === 'update');
  assert.deepEqual(
    refused.log.map((l) => l.split(':')[0]),
    ['register', 'enroll', 'revoke'],
  );
  const failed = rig({ macFails: 'x' });
  await assert.rejects(failed.run(), (e: any) => e.code === 'failed' && e.message === 'The Mac could not introduce this phone.');
});

test('a person who gave up, or a phone that cannot keep the record, leaves nothing on the relay or the Host', async () => {
  const gone = rig({ current: () => false });
  await assert.rejects(gone.run(), (e: any) => e.code === 'cancelled');
  assert.deepEqual(
    gone.log.map((l) => l.split(':')[0]),
    ['register', 'enroll', 'revoke', 'forget'],
  );
  assert.equal(gone.saved.length, 0);
  const full = rig({ saveFails: true });
  await assert.rejects(full.run(), (e: any) => e.code === 'failed' && e.message === 'disk full');
  assert.deepEqual(
    full.log.map((l) => l.split(':')[0]),
    ['register', 'enroll', 'revoke', 'forget'],
  );
});

test('what could not be taken back is said on the error', async () => {
  const r = rig({ current: () => false });
  await assert.rejects(
    enrollDirect({
      prim,
      identity: { ed: { pk: r.edPair.pk } },
      machineId: 'm',
      name: 'p',
      relayUrl: 'wss://r/v1/ws',
      lane: {
        register: async () => undefined,
        revoke: async () => {
          throw new Error('relay down');
        },
      },
      enroll: async () => {
        const sk = prim.randomBytes(32);
        return { hostPub: toBase64(prim.x25519Base(sk)), hostEphPub: toBase64(prim.x25519Base(sk)), hostKey: 'k', name: 'n', features: [] };
      },
      forget: async () => {
        throw new Error('mac away');
      },
      save: async () => undefined,
      current: () => false,
    }),
    (e: any) => e.code === 'cancelled' && e.undone.relay === false && e.undone.mac === false,
  );
});

test('a save that fails with no message still ends cleanly', async () => {
  const r = rig();
  await assert.rejects(
    enrollDirect({
      prim,
      identity: { ed: { pk: r.edPair.pk } },
      machineId: 'm',
      name: 'p',
      relayUrl: 'wss://r/v1/ws',
      lane: { register: async () => undefined, revoke: async () => undefined },
      enroll: async () => {
        const sk = prim.randomBytes(32);
        return { hostPub: toBase64(prim.x25519Base(sk)), hostEphPub: toBase64(prim.x25519Base(sk)), hostKey: 'k', name: 'n', features: [] };
      },
      forget: async () => undefined,
      save: async () => {
        throw 'nope';
      },
    }),
    (e: any) => e.code === 'failed' && e.message === 'The phone could not keep direct access.',
  );
});

test('the vault keeps enrollments by machine, removes them, and drops them with the account', async () => {
  let row: string | null = null;
  let key: string | null = null;
  const vault = createPhoneVault({
    prim,
    transaction: async (fn: any) => fn({ read: async () => row, write: async (v: string) => void (row = v) }),
    key: { get: async () => key, set: async (v: string) => void (key = v) },
  });
  assert.deepEqual(await vault.getHosts(), {});
  assert.equal(await vault.removeHost('m'), false);
  await vault.putHost('m', { hostId: 'h_1' });
  await vault.putHost('n', { hostId: 'h_2' });
  assert.deepEqual(Object.keys(await vault.getHosts()), ['m', 'n']);
  assert.equal(await vault.removeHost('m'), true);
  assert.equal(await vault.removeHost('m'), false);
  await vault.setAccount({ user: { id: 'u1' }, deviceId: 'd1' });
  await vault.putHost('m', { hostId: 'h_3' });
  await vault.setAccount({ user: { id: 'u2' }, deviceId: 'd2' });
  assert.deepEqual(await vault.getHosts(), {}, 'another account holds none of them');
});
