// What tests/e2e/app-crypto-electron.spec.ts runs in Electron's own runtime (ELECTRON_RUN_AS_NODE=1: Electron's Node and its BoringSSL, not the Node that runs the tests): the node:crypto primitives the app uses, a whole pairing by code on the app's crypto, and bytes through the app's relay tunnel (electron/host/relayPaths.cjs with its default primitives) to a Host's relay link on plain Node and back. It prints one JSON line: each check's name, whether it held, and why not (#5734).
//   <Electron> tests/e2e/fixtures/appCryptoProbe.mjs <work dir> <JSON line from relayHostSide.mjs>
import nodeCrypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const [dir, sideJson] = process.argv.slice(2);
const side = JSON.parse(sideJson);
/** @type {{ name: string, ok: boolean, why?: string }[]} */
const checks = [];
/** What main reports as ignored while the tunnel runs (a failure it survives, such as a seal that throws). @type {string[]} */
const ignored = [];
const log = console.log;
console.log = (...a) => (String(a[0]).startsWith('[ignored]') ? ignored.push(a.join(' ')) : log(...a));
// electron/ignored.cjs writes its lines with console.debug
console.debug = (...a) => void ignored.push(a.join(' '));

/** @param {string} name @param {() => unknown | Promise<unknown>} fn */
async function check(name, fn) {
  try {
    const held = await fn();
    checks.push(held === false ? { name, ok: false, why: 'it did not hold' } : { name, ok: true });
  } catch (error) {
    const e = /** @type {any} */ (error);
    checks.push({ name, ok: false, why: `${e?.code ? `${e.code} ` : ''}${String(e?.message ?? e).slice(0, 300)}` });
  }
}
const same = (/** @type {Uint8Array} */ a, /** @type {Uint8Array} */ b) => Buffer.from(a).equals(Buffer.from(b));

// the node:crypto primitives the app uses beside sealing: each must work in Electron's BoringSSL
await check('aes-256-gcm encrypt and decrypt', () => {
  const key = nodeCrypto.randomBytes(32);
  const iv = nodeCrypto.randomBytes(12);
  const c = nodeCrypto.createCipheriv('aes-256-gcm', key, iv);
  const box = Buffer.concat([c.update('hello'), c.final()]);
  const tag = c.getAuthTag();
  const d = nodeCrypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(box), d.final()]).toString() === 'hello';
});
await check('x25519 generateKeyPairSync and diffieHellman', () => {
  const a = nodeCrypto.generateKeyPairSync('x25519');
  const b = nodeCrypto.generateKeyPairSync('x25519');
  return nodeCrypto
    .diffieHellman({ privateKey: a.privateKey, publicKey: b.publicKey })
    .equals(nodeCrypto.diffieHellman({ privateKey: b.privateKey, publicKey: a.publicKey }));
});
await check(
  'hkdfSync sha256',
  () => Buffer.from(nodeCrypto.hkdfSync('sha256', Buffer.alloc(32, 1), Buffer.alloc(16), 'info', 32)).length === 32,
);
await check('ed25519 sign and verify', () => {
  const { privateKey, publicKey } = nodeCrypto.generateKeyPairSync('ed25519');
  const sig = nodeCrypto.sign(null, Buffer.from('m'), privateKey);
  return nodeCrypto.verify(null, Buffer.from('m'), publicKey, sig);
});
await check('createHmac sha256', () => nodeCrypto.createHmac('sha256', 'k').update('m').digest().length === 32);

// the app's crypto as its pairing wiring builds it (electron/platform/sodiumPrimitives.cjs under shared/remote/crypto.mjs): a seal and open, and a whole pairing by code, both sides on it
const { createSodiumPrimitives } = require('../../../electron/platform/sodiumPrimitives.cjs');
const { createCrypto } = await import('../../../shared/remote/crypto.mjs');
const cp = await import('../../../shared/host/codePair.mjs');
const prim = createSodiumPrimitives();
const c = createCrypto(prim);
await check('the app’s primitives seal and open', () => {
  const key = prim.randomBytes(32);
  const nonce = prim.randomBytes(24);
  const aad = new TextEncoder().encode('aad');
  return same(
    prim.aeadOpen(key, nonce, prim.aeadSeal(key, nonce, new TextEncoder().encode('hi'), aad), aad),
    new TextEncoder().encode('hi'),
  );
});
await check('a whole pairing by code on the app’s crypto (initiator and responder)', () => {
  const device = (/** @type {string} */ name) => {
    const k = prim.edKeypair();
    return { pub: k.pk, name, sign: (/** @type {Uint8Array} */ m) => prim.edSign(k.sk, m) };
  };
  const secret = cp.newSecret((/** @type {number} */ n) => prim.randomBytes(n));
  const run = { crypto: c, secret, hint: 'ABC', rendezvousId: `r_${'A'.repeat(22)}`, claims: 1 };
  const a = cp.createInitiator({ ...run, device: device('A'), budget: cp.createRunBudget() });
  const b = cp.createResponder({ ...run, device: device('B'), budget: cp.createRunBudget() });
  const m2 = b.receive(a.first());
  a.verify(m2);
  const got = b.receive3(a.seal({ relay: 'carry' }));
  const half = { hostPub: 'x', hostEphPub: 'y' };
  const done = a.finish(b.answer(true, half).message);
  return got.safety === done.safety && !done.denied && done.peerName === 'B' && done.carry?.hostPub === 'x' && got.carry?.relay === 'carry';
});

// the app's relay path to a machine, with the primitives relayPaths and relayTunnel take by default: enroll the Host over the relay, then bytes through the tunnel and back
const { createRelayPaths } = require('../../../electron/host/relayPaths.cjs');
const safe = {
  isEncryptionAvailable: () => true,
  encryptString: (/** @type {string} */ s) => Buffer.from(`x${s}`),
  decryptString: (/** @type {Buffer} */ b) => b.toString().slice(1),
};
const paths = createRelayPaths({
  dir: path.join(dir, 'app'),
  url: () => side.relayUrl,
  getToken: async () => side.token,
  safeStorage: safe,
});
const call = async (/** @type {string} */ method, /** @type {object} */ params) => {
  const r = await fetch(side.host, { method: 'POST', body: JSON.stringify({ method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
};
const noSsh = {
  get: () => {
    const t = {
      localSocket: path.join(dir, 'ssh.sock'),
      state: 'offline',
      reason: 'no SSH path',
      onState: () => () => undefined,
      acquire: () => ({ socketPath: t.localSocket, ready: new Promise(() => undefined), release: () => undefined }),
      fail: () => undefined,
      close: () => undefined,
    };
    return t;
  },
  closeAll: () => undefined,
};
await check(
  'bytes through the app’s relay tunnel (relayPaths and relayTunnel with their default primitives) to the Host and back',
  async () => {
    await paths.enroll('far', call);
    const pool = paths.pool(noSsh, path.join(dir, 'app'));
    const tunnel = pool.get({ destination: 'far', remoteSocket: '/x', sshArgs: [] });
    // why the tunnel is not up, as it says it (a seal that throws ends its session with the error's message)
    const reasons = new Set();
    tunnel.onState((_state, why) => why && reasons.add(why));
    const lease = tunnel.acquire();
    let timer;
    const up = await Promise.race([lease.ready, new Promise((r) => (timer = setTimeout(() => r(false), 15_000)))]);
    clearTimeout(timer);
    if (!up)
      throw new Error(
        `the tunnel never came up: ${[...reasons].join(' | ') || tunnel.reason || 'no reason'}; ignored: ${ignored.join(' | ').slice(0, 400) || 'nothing'}`,
      );
    const socket = net.connect(lease.socketPath);
    const got = [];
    socket.on('data', (d) => got.push(d));
    socket.write('through the relay');
    const end = Date.now() + 15_000;
    while (Buffer.concat(got).toString() !== 'through the relay' && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    socket.destroy();
    lease.release();
    pool.closeAll();
    if (Buffer.concat(got).toString() !== 'through the relay')
      throw new Error(`the echo did not come back; ignored: ${ignored.join(' | ').slice(0, 400) || 'nothing'}`);
    return true;
  },
);
paths.dispose();

log(JSON.stringify({ runtime: process.versions.electron ? `electron ${process.versions.electron}` : `node ${process.version}`, checks }));
fs.rmSync(path.join(dir, 'app'), { recursive: true, force: true });
process.exit(0);
