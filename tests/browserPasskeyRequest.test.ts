// macOS's passkey sheet in the built-in browser: which requests it serves (passkeyRequest.cjs: origin, RP ID, malformed
// input) and how its answer is checked and shaped for the page (passkeyResult.cjs: client data, RP ID hash, COSE keys).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { nativeRequest, relyingParty, timeoutOf, TIMEOUT } = require('../electron/capabilities/browser/passkeyRequest.cjs');
const { pageAnswer, cbor, coseToSpki, authenticatorData, NOT_ALLOWED } = require('../electron/capabilities/browser/passkeyResult.cjs');

const b = (s: string | Buffer) => ({ b64u: Buffer.from(s).toString('base64url') });
const caps = { platform: true, securityKey: true };
const ORIGIN = 'https://login.example.com';

test('relying party: the host or a registrable suffix of it, on a secure origin only', () => {
  assert.equal(relyingParty(ORIGIN, undefined), 'login.example.com');
  assert.equal(relyingParty(ORIGIN, 'example.com'), 'example.com');
  assert.equal(relyingParty(ORIGIN, 'login.example.com'), 'login.example.com');
  assert.equal(relyingParty('https://a.github.io', 'a.github.io'), 'a.github.io');
  // a domain is case-insensitive: the lowercased one is what the authenticator hashes
  assert.equal(relyingParty(ORIGIN, 'Example.com'), 'example.com');
  for (const [origin, rpId] of [
    // public suffixes, private ones (github.io) included
    [ORIGIN, 'com'],
    ['https://a.github.io', 'github.io'],
    ['https://x.co.uk', 'co.uk'],
    // another site, or a lookalike suffix
    [ORIGIN, 'other.com'],
    ['https://notexample.com', 'example.com'],
    // malformed: ports, paths, trailing dots, empty, not a string
    [ORIGIN, 'example.com:443'],
    [ORIGIN, 'example.com/x'],
    [ORIGIN, 'example.com.'],
    [ORIGIN, ''],
    [ORIGIN, 7],
    [ORIGIN, 'exa mple.com'],
    [ORIGIN, 'ex%61mple.com'],
    // insecure, opaque, IP and unparsable origins
    ['http://login.example.com', undefined],
    ['null', undefined],
    ['data:text/html,x', undefined],
    ['https://127.0.0.1', undefined],
    ['https://[::1]', undefined],
  ] as const)
    assert.equal(relyingParty(origin, rpId), null, `${origin} ${String(rpId)}`);
  // localhost is secure over http, and may only name itself
  assert.equal(relyingParty('http://localhost:3000', undefined), 'localhost');
  assert.equal(relyingParty('http://app.localhost', 'app.localhost'), 'app.localhost');
  assert.equal(relyingParty('http://app.localhost', 'localhost'), 'localhost');
  assert.equal(relyingParty('https://localhost.example.com', 'localhost'), null);
  // an IDN host is compared as the URL parser writes it (punycode)
  assert.equal(relyingParty('https://login.bücher.de', 'xn--bcher-kva.de'), 'xn--bcher-kva.de');
});

test('timeout: the page’s, clamped, or five minutes', () => {
  assert.equal(timeoutOf(undefined), TIMEOUT.fallback);
  assert.equal(timeoutOf(Number.NaN), TIMEOUT.fallback);
  assert.equal(timeoutOf(1), TIMEOUT.min);
  assert.equal(timeoutOf(1e9), TIMEOUT.max);
  assert.equal(timeoutOf(60_000), 60_000);
});

const create = (over: any = {}) => ({
  rp: { id: 'example.com', name: 'Example' },
  user: { id: b('user-1'), name: 'ada@example.com', displayName: 'Ada' },
  challenge: b('challenge-0123456789'),
  pubKeyCredParams: [
    { type: 'public-key', alg: -7 },
    { type: 'public-key', alg: -257 },
    { type: 'public-key', alg: -35 },
  ],
  ...over,
});

test('create: a well-formed registration becomes the native request and what its answer must match', () => {
  const built = nativeRequest({ kind: 'create', options: create({ timeout: 120_000 }), origin: ORIGIN, caps });
  assert.deepEqual(built.expect, {
    type: 'webauthn.create',
    challenge: Buffer.from('challenge-0123456789').toString('base64url'),
    origin: ORIGIN,
    rpId: 'example.com',
  });
  assert.equal(built.timeout, 120_000);
  assert.deepEqual(built.native, {
    kind: 'create',
    rpId: 'example.com',
    origin: ORIGIN,
    topOrigin: null,
    crossOrigin: false,
    challenge: Buffer.from('challenge-0123456789').toString('base64'),
    userVerification: 'preferred',
    userId: Buffer.from('user-1').toString('base64'),
    name: 'ada@example.com',
    displayName: 'Ada',
    exclude: [],
    // algorithms macOS can't make are left out
    algorithms: [-7, -257],
    attestation: 'none',
    residentKey: 'discouraged',
    platform: true,
    hybrid: true,
    securityKey: true,
  });
});

test('create: attachment, resident key, defaults and capabilities decide the authenticators', () => {
  const run = (over: any, c = caps) => nativeRequest({ kind: 'create', options: create(over), origin: ORIGIN, caps: c })?.native;
  // an empty list means ES256 and RS256; a missing display name is the name
  const defaults = run({ pubKeyCredParams: [], user: { id: b('u'), name: 'n' } });
  assert.deepEqual(defaults.algorithms, [-7, -257]);
  assert.equal(defaults.displayName, 'n');
  // a platform passkey only on this Mac (or a phone through the sheet)
  const platform = run({
    authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'required', userVerification: 'required' },
  });
  assert.deepEqual([platform.platform, platform.hybrid, platform.securityKey], [true, true, false]);
  assert.equal(platform.residentKey, 'required');
  assert.equal(platform.userVerification, 'required');
  const roaming = run({ authenticatorSelection: { authenticatorAttachment: 'cross-platform', requireResidentKey: true } });
  assert.deepEqual([roaming.platform, roaming.securityKey, roaming.residentKey], [false, true, 'required']);
  // a passkey is ES256 only: without it, only a security key
  const rsa = run({ pubKeyCredParams: [{ type: 'public-key', alg: -257 }] });
  assert.deepEqual([rsa.platform, rsa.securityKey], [false, true]);
  assert.equal(run({ pubKeyCredParams: [{ type: 'public-key', alg: -257 }] }, { platform: true, securityKey: false }), undefined);
  assert.equal(run({ pubKeyCredParams: [{ type: 'public-key', alg: -35 }] }), undefined, 'nothing macOS makes');
  assert.equal(run({ attestation: 'direct' }).attestation, 'direct');
  assert.deepEqual(run({ excludeCredentials: [{ type: 'public-key', id: b('old'), transports: ['usb', 'warp'] }] }).exclude, [
    { id: Buffer.from('old').toString('base64'), transports: ['usb'] },
  ]);
  assert.deepEqual(run({ excludeCredentials: [{ type: 'public-key', id: b('old') }] }).exclude, [
    { id: Buffer.from('old').toString('base64'), transports: [] },
  ]);
});

test('create: malformed input is never served (Electron’s own path answers it)', () => {
  const bad = [
    { user: { id: b('x'.repeat(65)), name: 'n' } },
    { user: { id: b('u'), name: 'n'.repeat(1025) } },
    { user: { id: b('u'), name: 'n', displayName: 5 } },
    { user: { id: 'not bytes', name: 'n' } },
    { user: null },
    { challenge: b('') },
    { challenge: { b64u: '+/=' } },
    { challenge: b('x'.repeat(1025)) },
    { pubKeyCredParams: 'all' },
    { pubKeyCredParams: [{ type: 'password', alg: -7 }] },
    { pubKeyCredParams: [{ type: 'public-key', alg: 1.5 }] },
    { pubKeyCredParams: Array.from({ length: 33 }, () => ({ type: 'public-key', alg: -7 })) },
    { excludeCredentials: 'x' },
    { excludeCredentials: Array.from({ length: 65 }, () => ({ type: 'public-key', id: b('c') })) },
    { excludeCredentials: [{ type: 'public-key', id: b('c'), transports: 'usb' }] },
    { excludeCredentials: [{ type: 'public-key', id: b('c'), transports: Array(9).fill('usb') }] },
    { excludeCredentials: [{ type: 'other', id: b('c') }] },
    { excludeCredentials: [null] },
    { attestation: 'everything' },
    { authenticatorSelection: { residentKey: 'always' } },
    { authenticatorSelection: { userVerification: 'sometimes' } },
    { authenticatorSelection: 'platform' },
    { rp: { id: 'other.com' } },
  ];
  for (const over of bad)
    assert.equal(nativeRequest({ kind: 'create', options: create(over), origin: ORIGIN, caps }), null, JSON.stringify(over));
  assert.equal(nativeRequest({ kind: 'delete', options: create(), origin: ORIGIN, caps }), null);
  assert.equal(nativeRequest({ kind: 'create', options: null, origin: ORIGIN, caps }), null);
  assert.equal(nativeRequest({ kind: 'create', options: create(), origin: 'http://example.com', caps }), null);
});

test('get: an assertion request, with its allowed credentials, and what can serve it', () => {
  const options = {
    challenge: b('challenge-0123456789'),
    rpId: 'example.com',
    allowCredentials: [{ type: 'public-key', id: b('cred'), transports: ['internal', 'hybrid'] }],
    userVerification: 'discouraged',
    // the appid extension (and every other) is dropped
    extensions: { appid: 'https://evil.test' },
  };
  const built = nativeRequest({ kind: 'get', options, origin: ORIGIN, topOrigin: ORIGIN, caps });
  assert.deepEqual(built.native, {
    kind: 'get',
    rpId: 'example.com',
    origin: ORIGIN,
    topOrigin: ORIGIN,
    crossOrigin: false,
    challenge: Buffer.from('challenge-0123456789').toString('base64'),
    userVerification: 'discouraged',
    allow: [{ id: Buffer.from('cred').toString('base64'), transports: ['internal', 'hybrid'] }],
    platform: true,
    hybrid: true,
    securityKey: true,
  });
  assert.equal(built.expect.type, 'webauthn.get');
  assert.equal(built.timeout, TIMEOUT.fallback);
  // no allow list: any discoverable passkey
  assert.deepEqual(nativeRequest({ kind: 'get', options: { challenge: b('c') }, origin: ORIGIN, caps }).native.allow, []);
  // security keys only on an older macOS
  const keys = nativeRequest({ kind: 'get', options: { challenge: b('c') }, origin: ORIGIN, caps: { platform: false, securityKey: true } });
  assert.deepEqual([keys.native.platform, keys.native.securityKey], [false, true]);
  assert.equal(
    nativeRequest({ kind: 'get', options: { challenge: b('c') }, origin: ORIGIN, caps: { platform: false, securityKey: false } }),
    null,
  );
  assert.equal(nativeRequest({ kind: 'get', options: { challenge: b('c'), allowCredentials: {} }, origin: ORIGIN, caps }), null);
  assert.equal(nativeRequest({ kind: 'get', options: { challenge: b('c'), rpId: 'evil.com' }, origin: ORIGIN, caps }), null);
});

/** A minimal CBOR encoder for the answers macOS gives. */
function enc(v: any): Buffer {
  const head = (major: number, n: number) =>
    n < 24
      ? Buffer.from([(major << 5) | n])
      : n < 256
        ? Buffer.from([(major << 5) | 24, n])
        : n < 65536
          ? Buffer.concat([Buffer.from([(major << 5) | 25]), Buffer.from([n >> 8, n & 255])])
          : (() => {
              const x = Buffer.alloc(5);
              x[0] = (major << 5) | 26;
              x.writeUInt32BE(n, 1);
              return x;
            })();
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === 'string') return Buffer.concat([head(3, Buffer.byteLength(v)), Buffer.from(v)]);
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(enc)]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [enc(k), enc(x)])]);
  if (v === true) return Buffer.from([0xf5]);
  if (v === false) return Buffer.from([0xf4]);
  return Buffer.from([0xf6]);
}

const ecKey = () => {
  const { publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const cose = new Map<number, any>([
    [1, 2],
    [3, -7],
    [-1, 1],
    [-2, Buffer.from(jwk.x!, 'base64url')],
    [-3, Buffer.from(jwk.y!, 'base64url')],
  ]);
  return { cose, spki: publicKey.export({ type: 'spki', format: 'der' }) };
};

const authData = (rpId: string, flags: number, extra = Buffer.alloc(0)) =>
  Buffer.concat([crypto.createHash('sha256').update(rpId).digest(), Buffer.from([flags]), Buffer.from([0, 0, 0, 1]), extra]);

const attested = (rpId: string, cose: Map<number, any>, credId = Buffer.from('cred-id')) =>
  authData(rpId, 0x45, Buffer.concat([Buffer.alloc(16), Buffer.from([0, credId.length]), credId, enc(cose)]));

test('CBOR: the subset WebAuthn uses, and what it refuses', () => {
  const value = new Map<any, any>([
    ['fmt', 'none'],
    [1, [true, false, null, 300, 70000, -5]],
    ['bytes', Buffer.from('ab')],
  ]);
  const [out, end] = cbor(enc(value));
  assert.deepEqual(out, value);
  assert.equal(end, enc(value).length);
  for (const bad of [
    Buffer.from([]),
    Buffer.from([0x1b, 0, 0, 0, 0, 0, 0, 0, 1]),
    Buffer.from([0x42, 1]),
    Buffer.from([0xc0]),
    Buffer.from([0xf9, 0, 0]),
    Buffer.from(Array(20).fill(0x81)),
  ])
    assert.throws(() => cbor(bad));
});

test('COSE keys: EC2, RSA and OKP become SPKI; anything else is refused', () => {
  const ec = ecKey();
  assert.deepEqual(coseToSpki(ec.cose), { publicKey: ec.spki.toString('base64url'), publicKeyAlgorithm: -7 });
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey;
  const rj = rsa.export({ format: 'jwk' });
  const rsaCose = new Map<number, any>([
    [1, 3],
    [3, -257],
    [-1, Buffer.from(rj.n!, 'base64url')],
    [-2, Buffer.from(rj.e!, 'base64url')],
  ]);
  assert.equal(coseToSpki(rsaCose).publicKey, rsa.export({ type: 'spki', format: 'der' }).toString('base64url'));
  const ed = crypto.generateKeyPairSync('ed25519').publicKey;
  const edCose = new Map<number, any>([
    [1, 1],
    [3, -8],
    [-1, 6],
    [-2, Buffer.from(ed.export({ format: 'jwk' }).x!, 'base64url')],
  ]);
  assert.equal(coseToSpki(edCose).publicKeyAlgorithm, -8);
  assert.throws(() => coseToSpki(new Map([[1, 4]])), /unsupported COSE key/);
});

test('authenticator data: the RP ID hash, and a new credential’s key', () => {
  const ec = ecKey();
  const parsed = authenticatorData(attested('example.com', ec.cose));
  assert.deepEqual(parsed.rpIdHash, crypto.createHash('sha256').update('example.com').digest());
  assert.equal(parsed.key.publicKey, ec.spki.toString('base64url'));
  assert.equal(authenticatorData(authData('example.com', 0x05)).key, null);
  assert.throws(() => authenticatorData(Buffer.alloc(10)), /short/);
  // a key Node can't read (an unknown curve): the credential is still delivered, without getPublicKey
  const odd = new Map<number, any>([...ec.cose, [-1, 8]]);
  assert.deepEqual(authenticatorData(attested('example.com', odd)).key, { publicKey: null, publicKeyAlgorithm: -7 });
  const noAlg = new Map<number, any>([[1, 9]]);
  assert.deepEqual(authenticatorData(attested('example.com', noAlg)).key, { publicKey: null, publicKeyAlgorithm: null });
  assert.throws(
    () => authenticatorData(authData('example.com', 0x45, Buffer.concat([Buffer.alloc(16), Buffer.from([0, 1, 9]), enc([1])]))),
    /bad credential key/,
  );
});

const expectCreate = { type: 'webauthn.create', challenge: 'Y2hhbGxlbmdl', origin: ORIGIN, rpId: 'example.com' };
const expectGet = { ...expectCreate, type: 'webauthn.get' };
const clientData = (o: any) => Buffer.from(JSON.stringify(o)).toString('base64');

test('answer: a registration is checked against the request and shaped for the page', () => {
  const ec = ecKey();
  const attestationObject = enc(
    new Map<string, any>([
      ['fmt', 'none'],
      ['attStmt', new Map()],
      ['authData', attested('example.com', ec.cose)],
    ]),
  );
  const answer = {
    ok: true,
    kind: 'create',
    attachment: 'platform',
    credentialId: Buffer.from('cred-id').toString('base64'),
    clientDataJSON: clientData({ type: 'webauthn.create', challenge: 'Y2hhbGxlbmdl', origin: ORIGIN }),
    attestationObject: attestationObject.toString('base64'),
    transports: ['usb', 7],
  };
  const { credential } = pageAnswer(answer, expectCreate);
  assert.equal(credential.id, Buffer.from('cred-id').toString('base64url'));
  assert.equal(credential.type, 'public-key');
  assert.equal(credential.authenticatorAttachment, 'platform');
  assert.equal(credential.response.publicKey, ec.spki.toString('base64url'));
  assert.equal(credential.response.publicKeyAlgorithm, -7);
  assert.deepEqual(credential.response.transports, ['usb']);
  assert.equal(credential.response.attestationObject, attestationObject.toString('base64url'));
  assert.equal(
    pageAnswer({ ...answer, transports: undefined, attachment: 'cross-platform' }, expectCreate).credential.authenticatorAttachment,
    'cross-platform',
  );
  assert.deepEqual(pageAnswer({ ...answer, transports: undefined }, expectCreate).credential.response.transports, []);

  // anything that doesn't match the request is never delivered
  const wrong = [
    { ...answer, kind: 'get' },
    { ...answer, clientDataJSON: clientData({ type: 'webauthn.create', challenge: 'other', origin: ORIGIN }) },
    { ...answer, clientDataJSON: clientData({ type: 'webauthn.get', challenge: 'Y2hhbGxlbmdl', origin: ORIGIN }) },
    { ...answer, clientDataJSON: clientData({ type: 'webauthn.create', challenge: 'Y2hhbGxlbmdl', origin: 'https://evil.test' }) },
    { ...answer, clientDataJSON: Buffer.from('not json').toString('base64') },
    { ...answer, credentialId: '' },
    { ...answer, attestationObject: undefined },
    { ...answer, attestationObject: enc(new Map([['fmt', 'none']])).toString('base64') },
    { ...answer, attestationObject: enc(new Map<string, any>([['authData', attested('evil.test', ec.cose)]])).toString('base64') },
    { ...answer, attestationObject: enc(new Map<string, any>([['authData', authData('example.com', 0x05)]])).toString('base64') },
    { ...answer, attestationObject: enc([1]).toString('base64') },
  ];
  for (const a of wrong) assert.deepEqual(pageAnswer(a, expectCreate), { error: NOT_ALLOWED });
});

test('answer: an assertion is checked against the request and shaped for the page', () => {
  const answer = {
    ok: true,
    kind: 'get',
    attachment: 'cross-platform',
    credentialId: Buffer.from('cred-id').toString('base64'),
    clientDataJSON: clientData({ type: 'webauthn.get', challenge: 'Y2hhbGxlbmdl', origin: ORIGIN }),
    authenticatorData: authData('example.com', 0x05).toString('base64'),
    signature: Buffer.from('sig').toString('base64'),
    userHandle: Buffer.from('user-1').toString('base64'),
  };
  const { credential } = pageAnswer(answer, expectGet);
  assert.equal(credential.authenticatorAttachment, 'cross-platform');
  assert.equal(credential.response.signature, Buffer.from('sig').toString('base64url'));
  assert.equal(credential.response.userHandle, Buffer.from('user-1').toString('base64url'));
  assert.equal(credential.response.authenticatorData, authData('example.com', 0x05).toString('base64url'));
  assert.equal(pageAnswer({ ...answer, userHandle: '' }, expectGet).credential.response.userHandle, null);
  for (const a of [
    { ...answer, kind: 'create' },
    { ...answer, authenticatorData: authData('evil.test', 0x05).toString('base64') },
    { ...answer, signature: null },
  ])
    assert.deepEqual(pageAnswer(a, expectGet), { error: NOT_ALLOWED });
});

test('answer: macOS errors become the DOMException Chromium gives', () => {
  assert.deepEqual(pageAnswer({ ok: false, code: 1001 }, expectGet), { error: NOT_ALLOWED });
  assert.deepEqual(pageAnswer(null, expectGet), { error: NOT_ALLOWED });
  assert.equal(pageAnswer({ ok: false, code: 1006 }, expectCreate).error.name, 'InvalidStateError');
});
