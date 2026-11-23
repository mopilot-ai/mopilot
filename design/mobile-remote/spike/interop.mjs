// Interop check: both libsodium backends reproduce and open vectors.json, cross-seal, and reject replays and tampering.
import { readFileSync, writeFileSync } from 'node:fs';
import { x25519 } from '@noble/curves/ed25519';
import { nodeBackend, wasmBackend, Sender, Receiver, keysFor, buildVectors } from './crypto.mjs';

const vectors = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url), 'utf8'));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${detail}`); };
const throws = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };
const hex = (u) => Buffer.from(u).toString('hex');

for (const be of [nodeBackend, wasmBackend]) {
  await be.ready();
  const tag = be.name;
  const rebuilt = buildVectors(be);
  check(`${tag}: reproduces vectors.json byte for byte (keys, nonces, boxes)`, JSON.stringify(rebuilt) === JSON.stringify(vectors));
  for (const who of ['mac', 'phone']) {
    const keys = keysFor(be, who);
    check(`${tag}: ${who} derives the vector direction keys`, hex(keys.p2m) === vectors.dirKeys.p2m && hex(keys.m2p) === vectors.dirKeys.m2p);
  }
  // Each side opens the frames it receives: the Mac opens p2m, the phone opens m2p.
  for (const [who, dir] of [['mac', 'p2m'], ['phone', 'm2p']]) {
    const rx = new Receiver(be, vectors.pair, dir, keysFor(be, who)[dir]);
    const opened = vectors.frames.filter((f) => f.frame.dir === dir).map((f) => rx.open(f.frame));
    const want = vectors.frames.filter((f) => f.frame.dir === dir).map((f) => f.text);
    check(`${tag}: ${who} opens every ${dir} vector frame (incl. a counter gap)`, JSON.stringify(opened) === JSON.stringify(want));
  }
  const fresh = () => new Receiver(be, vectors.pair, 'p2m', keysFor(be, 'mac').p2m);
  const f = vectors.frames.filter((x) => x.frame.dir === 'p2m').map((x) => x.frame);
  const rx = fresh(); rx.open(f[0]); rx.open(f[1]);
  check(`${tag}: replayed frame rejected`, throws(() => rx.open(f[1])) === 'replay');
  check(`${tag}: rewound counter rejected`, throws(() => rx.open(f[0])) === 'replay');
  for (const [field, val] of [['ctr', 3], ['dir', 'm2p'], ['pair', 'p_other']]) {
    const e = throws(() => fresh().open({ ...f[0], [field]: val }));
    check(`${tag}: header field ${field} tampered -> rejected`, e !== null, `(${e})`);
  }
  const flipped = { ...f[0], box: Buffer.from(Buffer.from(f[0].box, 'base64').map((b, i) => (i === 0 ? b ^ 1 : b))).toString('base64') };
  check(`${tag}: ciphertext bit flip rejected`, throws(() => fresh().open(flipped)) === 'auth');
  const rx2 = fresh(); throws(() => rx2.open({ ...f[0], ctr: 2 }));
  check(`${tag}: a forged frame does not advance state`, rx2.open(f[0]) === vectors.frames[0].text);
  check(`${tag}: counter jump beyond the gap limit rejected`, throws(() => fresh().open({ ...f[0], ctr: 5000 })) === 'gap');
}

// react-native-libsodium 1.7.0 exports no crypto_scalarmult or crypto_kx, so the phone's X25519 may need a pure-JS fallback.
{
  const macSk = Uint8Array.from(Buffer.from(vectors.macSk, 'hex')), phoneSk = Uint8Array.from(Buffer.from(vectors.phoneSk, 'hex'));
  const pubOk = hex(x25519.getPublicKey(macSk)) === vectors.macPk && hex(x25519.getPublicKey(phoneSk)) === vectors.phonePk;
  const same = hex(x25519.getSharedSecret(phoneSk, Uint8Array.from(Buffer.from(vectors.macPk, 'hex')))) === hex(nodeBackend.dh(macSk, nodeBackend.pub(phoneSk)));
  check('@noble/curves x25519 matches sodium-native public keys and shared secret', pubOk && same);
}

// Cross-library: A seals random payloads, B opens, both directions of the pairing.
for (const [a, b] of [[nodeBackend, wasmBackend], [wasmBackend, nodeBackend]]) {
  const tx = new Sender(a, 'p_x', 'm2p', keysFor(a, 'mac').m2p);
  const rx = new Receiver(b, 'p_x', 'm2p', keysFor(b, 'phone').m2p);
  let ok = true;
  for (let i = 0; i < 200; i++) { const text = `msg ${i} ${Buffer.from(a.random(12)).toString('hex')}`; ok &&= rx.open(tx.seal(text)) === text; }
  check(`cross: ${a.name} seals 200 frames, ${b.name} opens them in order`, ok);
}
// Same-key frames must not be openable in the wrong direction.
{
  const tx = new Sender(nodeBackend, 'p_x', 'm2p', keysFor(nodeBackend, 'mac').m2p);
  const rx = new Receiver(wasmBackend, 'p_x', 'p2m', keysFor(wasmBackend, 'phone').p2m);
  check('a m2p frame is refused on a p2m receiver', throws(() => rx.open(tx.seal('x'))) === 'route');
}

const failed = results.filter((r) => !r.ok);
writeFileSync(new URL('./interop-result.json', import.meta.url), `${JSON.stringify({ passed: results.length - failed.length, failed: failed.length, results }, null, 2)}\n`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
