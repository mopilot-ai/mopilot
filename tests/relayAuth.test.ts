// relay/src/auth.mjs: the ES256 desktop JWT is accepted from a PEM or a JWKS URL, and only with the right issuer, audience, algorithm and claims.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { exportJWK, SignJWT, generateKeyPair } from 'jose';
import { createVerifier } from '../relay/src/auth.mjs';
import { AUTH, ISSUER, makeKeys } from './support/relayKit.ts';

const keys = await makeKeys();
const verifier = createVerifier({ ...AUTH, publicKeyPem: keys.publicPem });

test('a desktop token yields user, device and expiry; a phone token says so', async () => {
  const desktop = await verifier.verify(await keys.sign('u1', 'd1'));
  assert.equal(desktop?.userId, 'u1');
  assert.equal(desktop?.deviceId, 'd1');
  assert.equal(desktop?.kind, 'desktop');
  assert.ok(desktop!.expMs > Date.now());
  assert.equal((await verifier.verify(await keys.sign('u1', 'd2', { kind: 'phone' })))?.kind, 'phone');
});

test('wrong issuer, audience, expiry, key or algorithm is refused', async () => {
  assert.equal(await verifier.verify(await keys.sign('u', 'd', { iss: 'https://evil' })), null);
  assert.equal(await verifier.verify(await keys.sign('u', 'd', { aud: 'other' })), null);
  assert.equal(await verifier.verify(await keys.sign('u', 'd', { ttlS: -60 })), null);
  const other = await makeKeys();
  assert.equal(await verifier.verify(await other.sign('u', 'd')), null);
  const hs = await new SignJWT({ did: 'd' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(ISSUER)
    .setAudience('relay')
    .setSubject('u')
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode('x'.repeat(32)));
  assert.equal(await verifier.verify(hs), null);
  assert.equal(await verifier.verify('not a jwt'), null);
  assert.equal(await verifier.verify(''), null);
});

test('a token without a device or subject is refused', async () => {
  const sign = (claims: Record<string, unknown>, sub?: string) => {
    const j = new SignJWT(claims).setProtectedHeader({ alg: 'ES256' }).setIssuer(ISSUER).setAudience('relay').setExpirationTime('5m');
    return (sub ? j.setSubject(sub) : j).sign(keys.privateKey);
  };
  assert.equal(await verifier.verify(await sign({}, 'u')), null);
  assert.equal(await verifier.verify(await sign({ did: 'd' })), null);
});

test('a revocation token has its own audience: an access token cannot revoke, a revocation token cannot connect', async () => {
  const rev = await keys.sign('u1', 'd1', { aud: 'relay-revoke', ttlS: 120 });
  assert.deepEqual(await verifier.verifyRevocation(rev), { userId: 'u1', deviceId: 'd1' });
  assert.equal(await verifier.verifyRevocation(await keys.sign('u1', 'd1')), null);
  assert.equal(await verifier.verifyRevocation('junk'), null);
  assert.equal(await verifier.verify(rev), null);
});

test('keys come from a JWKS URL when no PEM is set', async () => {
  const jwk = { ...(await exportJWK(keys.publicKey)), alg: 'ES256', use: 'sig', kid: 'k1' };
  const server = http.createServer((_req, res) =>
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ keys: [jwk] })),
  );
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  after(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as any).port}/jwks`;
  const remote = createVerifier({ ...AUTH, jwksUrl: url });
  const { privateKey } = keys;
  const token = await new SignJWT({ did: 'd9' })
    .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
    .setIssuer(ISSUER)
    .setAudience('relay')
    .setSubject('u9')
    .setExpirationTime('5m')
    .sign(privateKey);
  assert.equal((await remote.verify(token))?.deviceId, 'd9');
  const stranger = await generateKeyPair('ES256');
  const forged = await new SignJWT({ did: 'd9' })
    .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
    .setIssuer(ISSUER)
    .setAudience('relay')
    .setSubject('u9')
    .setExpirationTime('5m')
    .sign(stranger.privateKey);
  assert.equal(await remote.verify(forged), null);
});

test('a key resolver can be injected and the clock tolerance changed', async () => {
  const v = createVerifier(AUTH, { keyResolver: keys.publicKey as any, clockTolerance: 0 });
  assert.equal((await v.verify(await keys.sign('u', 'd')))?.userId, 'u');
});

test('the clock tolerance decides how far past its expiry or before its start a token is still taken', async () => {
  const strict = createVerifier({ ...AUTH, publicKeyPem: keys.publicPem, clockToleranceS: 5 });
  const loose = createVerifier({ ...AUTH, publicKeyPem: keys.publicPem, clockToleranceS: 60 });
  const expired20sAgo = await keys.sign('u', 'd', { ttlS: -20 });
  assert.equal(await strict.verify(expired20sAgo), null);
  assert.equal((await loose.verify(expired20sAgo))?.userId, 'u');
  assert.equal(await loose.verify(await keys.sign('u', 'd', { ttlS: -120 })), null);
  const notYet = new SignJWT({ did: 'd' })
    .setProtectedHeader({ alg: 'ES256' })
    .setIssuer(ISSUER)
    .setAudience('relay')
    .setSubject('u')
    .setNotBefore(Math.floor(Date.now() / 1000) + 30)
    .setExpirationTime('5m');
  const token = await notYet.sign(keys.privateKey);
  assert.equal(await strict.verify(token), null, 'not valid yet');
  assert.equal((await loose.verify(token))?.userId, 'u');
  // a token with no expiry would never end the socket it opened
  const forever = await new SignJWT({ did: 'd' })
    .setProtectedHeader({ alg: 'ES256' })
    .setIssuer(ISSUER)
    .setAudience('relay')
    .setSubject('u')
    .sign(keys.privateKey);
  assert.equal(await loose.verify(forever), null);
  // a revocation token is short-lived: the tolerance given to access tokens does not stretch it
  const old = await keys.sign('u', 'd', { aud: 'relay-revoke', ttlS: -20 });
  assert.equal(await loose.verifyRevocation(old), null);
  assert.deepEqual(await loose.verifyRevocation(await keys.sign('u', 'd', { aud: 'relay-revoke', ttlS: -2 })), {
    userId: 'u',
    deviceId: 'd',
  });
});

test('the account’s access token (audience desktop) is refused by the relay, so a relay never holds a token the account service accepts', async () => {
  const access = await keys.sign('u1', 'd1', { aud: 'desktop' });
  assert.equal(await verifier.verify(access), null);
  assert.equal(await verifier.verify(await keys.sign('u1', 'p1', { aud: 'desktop', kind: 'phone' })), null);
  assert.equal((await verifier.verify(await keys.sign('u1', 'd1', { aud: 'relay' })))?.deviceId, 'd1');
});
