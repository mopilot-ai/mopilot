// MoMo Google sealed box and hand-off (shared/momoGoogle/seal.mjs, handoff.mjs): round trip over the shared primitives, bound context, wrong key, tampering and malformed input.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNodePrimitives } from '../shared/remote/nodePrimitives.mjs';
import { parseCallback, sealHandoff } from '../shared/momoGoogle/handoff.mjs';
import { createSealer } from '../shared/momoGoogle/seal.mjs';

const sealer = createSealer(createNodePrimitives());

test('a sealed text opens with the matching key and context', () => {
  const k = sealer.generateKeyPair();
  const sealed = sealer.seal(k.publicKey, 'hello ✓', 'ctx');
  assert.equal(sealer.open(k.privateKey, sealed, 'ctx'), 'hello ✓');
  assert.notEqual(sealer.seal(k.publicKey, 'hello ✓', 'ctx'), sealed, 'a fresh ephemeral key each time');
  assert.ok(!sealed.includes('hello'));
});

test('another key, another context or a changed text never opens, with one generic error', () => {
  const k = sealer.generateKeyPair();
  const other = sealer.generateKeyPair();
  const sealed = sealer.seal(k.publicKey, 'secret', 'ctx');
  const parts = sealed.split('.');
  const flipped = [...parts.slice(0, 3), 'AAAA'].join('.');
  for (const bad of [
    () => sealer.open(other.privateKey, sealed, 'ctx'),
    () => sealer.open(k.privateKey, sealed, 'other'),
    () => sealer.open(k.privateKey, flipped, 'ctx'),
    () => sealer.open(k.privateKey, 'garbage', 'ctx'),
    () => sealer.open(k.privateKey, `${sealed}.extra`, 'ctx'),
    () => sealer.open(k.privateKey, `2.${parts.slice(1).join('.')}`, 'ctx'),
  ])
    assert.throws(bad, /Could not open the sealed text/);
});

test('a public key of the wrong size is refused', () => {
  assert.throws(() => sealer.seal('AAAA', 'x', 'ctx'), /Not a sealing key/);
});

test('a hand-off is sealed to one flow only, and parseCallback reads the loopback request of that flow and nothing else', () => {
  const redirect = 'http://127.0.0.1:53682/callback';
  const k = sealer.generateKeyPair();
  const sealed = sealHandoff(sealer, 'flow-1', k.publicKey, { state: 's', redirectUri: redirect, code: 'c' });
  assert.deepEqual(JSON.parse(sealer.open(k.privateKey, sealed, 'google-consent:flow-1')), {
    state: 's',
    redirectUri: redirect,
    code: 'c',
  });
  assert.throws(() => sealer.open(k.privateKey, sealed, 'google-consent:flow-2'));
  assert.deepEqual(parseCallback('/callback?state=s&code=c', redirect), { state: 's', redirectUri: redirect, code: 'c' });
  assert.deepEqual(parseCallback('/callback?state=s&error=access_denied', redirect), {
    state: 's',
    redirectUri: redirect,
    error: 'access_denied',
  });
  assert.equal(parseCallback('/other?state=s&code=c', redirect), null);
  assert.equal(parseCallback('/callback?code=c', redirect), null);
  assert.equal(parseCallback('/callback?state=s', redirect), null);
  const ios = 'com.googleusercontent.apps.123-abc:/oauth2redirect';
  assert.deepEqual(parseCallback(`${ios}?state=s&code=c`, ios), { state: 's', redirectUri: ios, code: 'c' });
});
