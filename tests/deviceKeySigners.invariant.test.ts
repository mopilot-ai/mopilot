// What the device and client keys sign (#5576): the Mac's Ed25519 client key signs the Host's pairing and authentication challenges, update manifests, and (the code pairing's proof of holding a key) a run's transcript hash. Each signs a message with a prefix no other signer uses, so a signature made for one purpose is never valid for another. This test lists every place in the repository that signs with an Ed25519 key and pins the prefix of each; a new signer must be added here, with its prefix, by someone who has checked it against the others.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// @ts-ignore: plain ESM without declarations
import { lvCat } from '../shared/host/cpace.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Every non-test file that signs with an Ed25519 key, and what it signs. */
const SIGNERS: Record<string, string> = {
  'electron/host/pairingClient.cjs':
    "the Host's challenges: `<label>\\n<hostId>\\n<nonce>`, label 'pair' or 'auth', and update manifests through updateSignature",
  'shared/remote/phoneHost.mjs': "a phone's login to its Mac: `auth\\n<hostId>\\n<nonce>`",
  'shared/host/updateSignature.mjs': 'an update manifest: `mopilot-host-update\\nv2|v3\\n...`',
  'shared/host/codePair.mjs':
    "the code pairing's proof of holding a device key: lv(`mopilot-code-pair-v1|device-proof`, role, transcript hash)",
  // The same format as a paired client's challenge proof, `auth\n<hostId>\n<nonce>` (through `authenticate`, which passes 'auth'), on purpose: it answers the Host's same challenge. That is acceptable only because the two never verify against one another's key: a Host checks a proof against the public key registered under that fingerprint, a home key is registered only by an owner's device as kind `home` (host.clientAdd) and a paired client's key never is, and a `home` principal reaches nothing but the gate's allow-list. A signature a client made is worthless as a home's (another key), and the home's is worthless as a client's (not registered as one). The proof also names the Host's id, so it is worth nothing at another Host.
  'host/src/momoTasks/homeKey.mjs':
    "MoMo's home key (kind `home` on the Hosts that allowed it): the challenge proof `<purpose>\\n<hostId>\\n<nonce>`, purpose 'auth' through `authenticate`, same format as a paired client's but a different key under a different kind",
  'shared/host/momoEntitlement.mjs':
    'the issuer signs a MoMo entitlement with its own key and label: `mopilot-momo-entitlement\\nv1\\n` + the canonical claims',
  'host/src/momoBundle.mjs': "a MoMo move's receipt, signed by the move's own key (not a device or client key): `receiptText(...)`",
  'shared/remote/crypto.mjs': 'the type of the primitive set: the declaration of edSign, no signature is made here',
  'shared/remote/phonePrimitives.mjs': 'the primitive set of the phone: the definition of edSign',
  'electron/remote/sodiumPrimitives.cjs': 'the primitive set of the app: the definition of edSign',
  'shared/remote/nodePrimitives.mjs': 'the primitive set of the Host: the definition of edSign',
};
/** Every way the code of this repository (or a library it may take up) signs with an Ed25519 key: the primitive sets' `edSign`, Node's `sign(null, ...)` (also over several lines, or with `undefined`), noble's `ed25519.sign(`, WebCrypto's `subtle.sign` (any algorithm but the named HMAC, RSA and ECDSA ones), libsodium's `crypto_sign*`, tweetnacl's `nacl.sign`, and a device's own `sign(` of the code pairing. */
export const SIGN =
  /\bedSign\b|\bsign\(\s*(?:null|undefined)\s*,|\bed25519\w*\.sign\(|\bsubtle\.sign\((?!\s*['"`](?:HMAC|RSASSA-PKCS1-v1_5|RSA-PSS|ECDSA)['"`])|\bcrypto_sign\w*|\bnacl\.sign\b|\bdevice\.sign\(/;
/** The files that are looked at: every spelling of JavaScript and TypeScript, and the templates of them. */
export const SOURCE = /\.(?:m?[jt]sx?|c[jt]s|mjs\.in|cjs\.in)$/;
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('the only places that sign with an Ed25519 key are the ones listed here, so a new signer cannot slip in beside them unchecked', () => {
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
    .split('\0')
    .filter(Boolean);
  const found = tracked
    .filter(
      (rel) =>
        SOURCE.test(rel) &&
        !rel.startsWith('tests/') &&
        !rel.startsWith('node_modules/') &&
        !rel.includes('/node_modules/') &&
        fs.existsSync(path.join(ROOT, rel)),
    )
    .filter((rel) => SIGN.test(read(rel)))
    .sort();
  assert.deepEqual(
    found,
    Object.keys(SIGNERS).sort(),
    'a file that signs is added to SIGNERS with the prefix of what it signs, after checking it against the others',
  );
});

test('the prefixes of what is signed are pinned and none is the start of another', () => {
  // the literals are where they are said to be
  assert.match(read('electron/host/pairingClient.cjs'), /identity\.sign\('pair'/);
  assert.match(read('electron/host/pairingClient.cjs'), /identity\.sign\('auth'/);
  assert.match(read('host/src/momoTasks/homeKey.mjs'), /`\$\{purpose\}\\n\$\{hostId\}\\n\$\{nonce\}`/);
  assert.match(read('shared/remote/phoneHost.mjs'), /`auth\\n\$\{c\.hostId\}\\n\$\{c\.nonce\}`/);
  assert.match(read('shared/host/updateSignature.mjs'), /'mopilot-host-update'/);
  assert.match(read('shared/host/codePair.mjs'), /`\$\{LABEL\}\|device-proof`/);
  assert.match(read('shared/host/codePair.mjs'), /export const LABEL = 'mopilot-code-pair-v1'/);
  const text = (s: string) => new TextEncoder().encode(s);
  const proof = lvCat(text('mopilot-code-pair-v1|device-proof'), text('initiator'), new Uint8Array(64));
  const others = ['pair\n', 'auth\n', 'mopilot-host-update\nv2\n', 'mopilot-host-update\nv3\n'].map(text);
  const startsWith = (a: Uint8Array, b: Uint8Array) => b.length <= a.length && b.every((byte, i) => a[i] === byte);
  for (const other of others) {
    assert.equal(startsWith(proof, other), false, `${new TextDecoder().decode(other)} starts the proof message`);
    assert.equal(startsWith(other, proof.slice(0, 1)), false, `the proof message starts like ${new TextDecoder().decode(other)}`);
  }
  // the others do not start each other either
  for (const [i, a] of others.entries()) for (const [j, b] of others.entries()) if (i !== j) assert.equal(startsWith(a, b), false);
  assert.equal(proof[0], 0x21, 'the proof message starts with the length of its label, a byte none of the others starts with');
});

test('the guard’s own patterns catch every way of signing with an Ed25519 key and every spelling of a source file', () => {
  for (const code of [
    'sign(null, bytes, key)',
    'crypto.sign(\n  null,\n  bytes,\n  key)',
    'sign(undefined, bytes, key)',
    'ed25519.sign(message, seed)',
    'ed25519ph.sign(message, seed)',
    "await crypto.subtle.sign('Ed25519', key, data)",
    'await crypto.subtle.sign({ name: algorithm }, key, data)',
    'sodium.crypto_sign_detached(sig, msg, sk)',
    'crypto_sign_seed_keypair(pk, sk, seed)',
    'nacl.sign.detached(msg, sk)',
    'prim.edSign(sk, msg)',
    'device.sign(message)',
  ])
    assert.match(code, SIGN, code);
  for (const code of [
    "await crypto.subtle.sign('HMAC', key, data)",
    "subtle.sign('ECDSA', k, d)",
    'const designed = 1',
    'sign = 5',
    'signal(null, 1)',
    'verify(null, bytes)',
    'x.ed25519Key = 1',
  ])
    assert.doesNotMatch(code, SIGN, code);
  for (const name of ['a.mjs', 'a.cjs', 'a.js', 'a.jsx', 'a.ts', 'a.tsx', 'a.mts', 'a.cts', 'a.mjs.in', 'a.cjs.in', 'x/y/z.test.mts'])
    assert.match(name, SOURCE, name);
  for (const name of ['a.json', 'a.md', 'a.mjs.map', 'a.d.ts.bak', 'a.sh']) assert.doesNotMatch(name, SOURCE, name);
});
