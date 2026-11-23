// The dev host's account stand-in: the phone's PKCE sign-in and refresh over real HTTP, tokens the relay's own verifier accepts, a device cap, and a restart that keeps every signed-in phone.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SignJWT, importJWK } from 'jose';
import { createVerifier } from '../relay/src/auth.mjs';
import { createAccountService, ISSUER, MAX_PHONES, REDIRECT, USER } from '../scripts/mobile-dev-host/account.mjs';

const scratch = mkdtempSync(path.join(tmpdir(), 'dev-account-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
const servers: http.Server[] = [];
after(() => servers.forEach((s) => s.close()));

let clock = Date.now();
async function serve(name: string) {
  const dir = path.join(scratch, name);
  (await import('node:fs')).mkdirSync(dir, { recursive: true });
  const account = await createAccountService({ dir, now: () => clock });
  const server = http.createServer((req, res) => account.handle(req, res) || res.writeHead(404).end());
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  return { account, base, dir };
}
const challengeOf = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');
const authorizeUrl = (base: string, o: Record<string, string> = {}) =>
  `${base}/desktop/authorize?${new URLSearchParams({
    client_id: 'mopilot-phone',
    redirect_uri: REDIRECT,
    response_type: 'code',
    state: 's1'.repeat(8),
    code_challenge: challengeOf('v1'),
    code_challenge_method: 'S256',
    device_kind: 'phone',
    install_id: 'install-1',
    device_name: 'Phone',
    ...o,
  })}`;
const post = (base: string, body: unknown) =>
  fetch(`${base}/api/desktop/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
const relayToken = (base: string, token?: string) =>
  fetch(`${base}/api/desktop/relay-token`, { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {} });
async function signIn(base: string, o: Record<string, string> = {}, verifier = 'v1') {
  const res = await fetch(authorizeUrl(base, o), { redirect: 'manual' });
  assert.equal(res.status, 302);
  const target = new URL(res.headers.get('location')!);
  assert.equal(`${target.protocol}//${target.host}${target.pathname}`, REDIRECT);
  assert.equal(target.searchParams.get('state'), o.state ?? 's1'.repeat(8));
  return post(base, {
    grant_type: 'authorization_code',
    code: target.searchParams.get('code'),
    code_verifier: verifier,
    redirect_uri: REDIRECT,
  });
}

test('a phone signs in with PKCE, gets tokens the relay verifies, and refreshes them once each', async () => {
  const { account, base } = await serve('a');
  const res = await signIn(base);
  assert.equal(res.status, 200);
  const data: any = await res.json();
  assert.deepEqual(data.user, USER);
  assert.equal(data.device_kind, 'phone');
  assert.match(data.device_id, /^ph_[0-9a-f]{24}$/);
  assert.equal(data.expires_in, 900);

  const verifier = createVerifier({
    publicKeyPem: account.publicPem,
    jwksUrl: '',
    issuer: ISSUER,
    audience: 'relay',
    revokeAudience: 'relay-revoke',
  });
  // the access token is the account's: the relay refuses it, and the account service turns it into the relay's own token
  assert.equal(await verifier.verify(data.access_token), null);
  const exchanged: any = await (await relayToken(base, data.access_token)).json();
  assert.equal(exchanged.expires_in, 900);
  const who = await verifier.verify(exchanged.token);
  assert.equal(who?.kind, 'phone');
  assert.equal(who?.userId, USER.id);
  assert.equal(who?.deviceId, data.device_id);
  assert.equal((await verifier.verify(await account.sign('mac-1', false, 'relay')))?.kind, 'desktop');
  assert.equal(await verifier.verify(await account.sign('mac-1', false, 'relay').then((t: string) => `${t}x`)), null);

  const refreshed: any = await (await post(base, { grant_type: 'refresh_token', refresh_token: data.refresh_token })).json();
  assert.notEqual(refreshed.refresh_token, data.refresh_token);
  const again: any = await (await relayToken(base, refreshed.access_token)).json();
  assert.equal((await verifier.verify(again.token))?.deviceId, data.device_id);
  // the old refresh token is spent
  assert.equal((await post(base, { grant_type: 'refresh_token', refresh_token: data.refresh_token })).status, 400);
  assert.equal((await post(base, { grant_type: 'refresh_token', refresh_token: refreshed.refresh_token })).status, 200);
});

test('a sign-in with a wrong verifier, a reused or late code, or a wrong redirect is refused', async () => {
  const { base } = await serve('b');
  assert.equal((await signIn(base, {}, 'not-the-verifier')).status, 400);

  const res = await fetch(authorizeUrl(base), { redirect: 'manual' });
  const code = new URL(res.headers.get('location')!).searchParams.get('code');
  const exchange = (o: object = {}) =>
    post(base, { grant_type: 'authorization_code', code, code_verifier: 'v1', redirect_uri: REDIRECT, ...o });
  assert.equal((await exchange({ redirect_uri: 'mopilot://other' })).status, 400, 'a code is spent by any attempt');
  assert.equal((await exchange()).status, 400);

  const late = new URL((await fetch(authorizeUrl(base), { redirect: 'manual' })).headers.get('location')!).searchParams.get('code');
  clock += 61_000;
  assert.equal(
    (await post(base, { grant_type: 'authorization_code', code: late, code_verifier: 'v1', redirect_uri: REDIRECT })).status,
    400,
  );
  const fresh = new URL((await fetch(authorizeUrl(base), { redirect: 'manual' })).headers.get('location')!).searchParams.get('code');
  assert.equal((await post(base, { grant_type: 'authorization_code', code: fresh, code_verifier: 5, redirect_uri: REDIRECT })).status, 400);
  assert.equal((await post(base, { grant_type: 'password' })).status, 400);
  assert.equal((await post(base, { grant_type: 'refresh_token', refresh_token: 7 })).status, 400);
});

test('bad authorize requests and bad bodies are refused', async () => {
  const { base } = await serve('c');
  for (const bad of [
    { redirect_uri: 'https://evil.example' },
    { response_type: 'token' },
    { state: '' },
    { state: 'abcdefghij' },
    { code_challenge: '' },
    { code_challenge_method: 'plain' },
  ] as Record<string, string>[])
    assert.equal((await fetch(authorizeUrl(base, bad), { redirect: 'manual' })).status, 400, JSON.stringify(bad));
  for (const bad of [{ device_kind: 'desktop' }, { install_id: 'x' }, { install_id: 'has space here' }] as Record<string, string>[])
    assert.equal((await fetch(authorizeUrl(base, bad), { redirect: 'manual' })).status, 400, JSON.stringify(bad));
  assert.equal((await post(base, '{not json')).status, 400);
  assert.equal((await post(base, '')).status, 400, 'an empty body is no grant');
  const noInstall = new URL(authorizeUrl(base));
  noInstall.searchParams.delete('install_id');
  assert.equal((await fetch(noInstall, { redirect: 'manual' })).status, 400);
  assert.equal((await post(base, 'x'.repeat(20_000))).status, 400);
  assert.equal((await fetch(`${base}/elsewhere`)).status, 404);
  assert.equal((await fetch(`${base}/api/desktop/token`)).status, 404);
});

test('only a few phones can sign in; the same install may sign in again', async () => {
  const { base } = await serve('d');
  for (let i = 0; i < MAX_PHONES; i++) assert.equal((await signIn(base, { install_id: `install-${i}` })).status, 200);
  assert.equal((await fetch(authorizeUrl(base, { install_id: 'install-extra' }), { redirect: 'manual' })).status, 403);
  assert.equal((await signIn(base, { install_id: 'install-0' })).status, 200);
});

test('a restart keeps the key and every signed-in phone’s refresh token', async () => {
  const first = await serve('e');
  const data: any = await (await signIn(first.base)).json();
  const again = await createAccountService({ dir: first.dir, now: () => clock });
  assert.equal(again.publicPem, first.account.publicPem);
  const server = http.createServer((req, res) => again.handle(req, res) || res.writeHead(404).end());
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  assert.equal((await post(base, { grant_type: 'refresh_token', refresh_token: data.refresh_token })).status, 200);
});

test('a failing write answers 500 instead of crashing the host', async () => {
  const { base, dir } = await serve('f');
  rmSync(dir, { recursive: true, force: true });
  assert.equal((await fetch(authorizeUrl(base), { redirect: 'manual' })).status, 500);
  assert.equal((await post(base, { grant_type: 'refresh_token', refresh_token: 'rt_none' })).status, 400);
});

test('an unreadable account file stops the host instead of replacing the key', async () => {
  const dir = path.join(scratch, 'corrupt');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'account.json'), '{"key": ');
  await assert.rejects(createAccountService({ dir, now: () => clock }), SyntaxError);
  assert.equal(readFileSync(path.join(dir, 'account.json'), 'utf8'), '{"key": ', 'the file is left as it was');
});

test('writes run one after another: parallel sign-ins leave a complete file with every phone', async () => {
  const { base, dir } = await serve('g');
  const installs = ['install-a', 'install-b', 'install-c'];
  await Promise.all(installs.map((install_id) => fetch(authorizeUrl(base, { install_id }), { redirect: 'manual' })));
  const file = JSON.parse(readFileSync(path.join(dir, 'account.json'), 'utf8'));
  assert.equal(file.phones.length, 3);
  assert.ok(!existsSync(path.join(dir, 'account.json.tmp')));
});

test('a refresh whose write fails keeps the old token usable', async () => {
  const { base, dir } = await serve('h');
  const data: any = await (await signIn(base)).json();
  const saved = readFileSync(path.join(dir, 'account.json'));
  rmSync(dir, { recursive: true, force: true });
  assert.equal((await post(base, { grant_type: 'refresh_token', refresh_token: data.refresh_token })).status, 500);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'account.json'), saved);
  assert.equal(
    (await post(base, { grant_type: 'refresh_token', refresh_token: data.refresh_token })).status,
    200,
    'the token was not lost',
  );
});

test('codes nobody redeemed are dropped at the next sign-in', async () => {
  const { base } = await serve('i');
  const first = new URL((await fetch(authorizeUrl(base), { redirect: 'manual' })).headers.get('location')!).searchParams.get('code');
  clock += 61_000;
  await fetch(authorizeUrl(base), { redirect: 'manual' });
  assert.equal(
    (await post(base, { grant_type: 'authorization_code', code: first, code_verifier: 'v1', redirect_uri: REDIRECT })).status,
    400,
  );
});

test('a request line that is not a URL is answered 400, not thrown', async () => {
  const { account } = await serve('j');
  const server = http.createServer((req, res) => account.handle(req, res) || res.writeHead(404).end());
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const reply = await new Promise<string>((resolve) => {
    const socket = net.connect((server.address() as any).port, '127.0.0.1', () =>
      socket.write('GET //% HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'),
    );
    let text = '';
    socket.on('data', (d) => (text += d));
    socket.on('close', () => resolve(text));
  });
  assert.match(reply, /^HTTP\/1\.1 400/);
});

test('the relay token is made only from an access token of this account: none, garbage, a relay token, another key or no device are refused', async () => {
  const { account, base, dir } = await serve('relay');
  assert.equal((await relayToken(base)).status, 401);
  assert.equal((await relayToken(base, 'not-a-jwt')).status, 401);
  assert.equal((await relayToken(base, await account.sign('ph_x', true, 'relay'))).status, 401, 'a relay token cannot make another');
  const other = await serve('relay-other');
  assert.equal((await relayToken(base, await other.account.sign('ph_x', true))).status, 401, 'another account key');
  const key = await importJWK(JSON.parse(readFileSync(path.join(dir, 'account.json'), 'utf8')).key.private, 'ES256');
  const noDevice = await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256' })
    .setIssuer(ISSUER)
    .setAudience('desktop')
    .setSubject('dev-user')
    .setExpirationTime('5m')
    .sign(key);
  assert.equal((await relayToken(base, noDevice)).status, 401, 'a token without a device');
  assert.equal((await relayToken(base, await account.sign('mac-1', false))).status, 200, 'a Mac token of this account works too');
});

test('operation receipts survive restart; failed atomic writes retain retryability, and replay revokes only its device', async () => {
  const { base, dir } = await serve('operation-recovery');
  const signed = await (await signIn(base)).json();
  const other = await (await signIn(base, { install_id: 'other-install' })).json();
  const rotate = (token: string, operation?: string) =>
    post(base, { grant_type: 'refresh_token', refresh_token: token, ...(operation ? { refresh_operation: operation } : {}) });
  const op = 'a'.repeat(32);
  const blockedWrite = path.join(dir, 'account.json.tmp');
  mkdirSync(blockedWrite);
  assert.equal((await rotate(signed.refresh_token, op)).status, 500, 'failed rotation write must roll back the receipt and token');
  rmSync(blockedWrite, { recursive: true });
  const first = await (await rotate(signed.refresh_token, op)).json();
  const disk = JSON.parse(readFileSync(path.join(dir, 'account.json'), 'utf8'));
  const receiptKey = createHash('sha256').update(signed.refresh_token).digest('hex');
  assert.equal(disk.rotations[receiptKey].nextHash, createHash('sha256').update(first.refresh_token).digest('hex'));
  assert.equal(disk.rotations[signed.refresh_token], undefined, 'receipts do not retain plaintext predecessors');
  const restarted = await serve('operation-recovery');
  const retried = await (
    await post(restarted.base, { grant_type: 'refresh_token', refresh_token: signed.refresh_token, refresh_operation: op })
  ).json();
  assert.equal(retried.refresh_token, first.refresh_token);
  mkdirSync(blockedWrite);
  assert.equal((await rotate(signed.refresh_token, 'b'.repeat(32))).status, 500, 'failed revocation write must roll back');
  rmSync(blockedWrite, { recursive: true });
  assert.equal((await rotate(signed.refresh_token, op)).status, 200);
  assert.equal((await rotate(signed.refresh_token)).status, 400, 'missing operation is still a replay');
  assert.equal((await rotate(first.refresh_token, 'b'.repeat(32))).status, 400);
  assert.equal((await rotate(signed.refresh_token, op)).status, 400);
  assert.equal((await rotate(other.refresh_token, 'c'.repeat(32))).status, 200, 'another device survives');
});

test('refresh-only gates use the pathname even when the URL carries a query', async () => {
  const { base } = await serve('refresh-route-query');
  const signed = await (await signIn(base)).json();
  const target = base + '/api/desktop/refresh?probe=1';
  const postRefresh = (body: unknown) =>
    fetch(target, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  for (const invalid of [null, false, 'wrong']) assert.equal((await postRefresh(invalid)).status, 400);
  assert.equal((await postRefresh({ grant_type: 'authorization_code' })).status, 400);
  assert.equal((await postRefresh({ grant_type: 'refresh_token', refresh_token: signed.refresh_token })).status, 400);
  const accepted = await postRefresh({
    grant_type: 'refresh_token',
    refresh_token: signed.refresh_token,
    refresh_operation: 'a'.repeat(32),
  });
  assert.equal(accepted.status, 200, 'refused requests did not consume the held credential');
  const wrong = await postRefresh({ grant_type: 'refresh_token', refresh_token: signed.refresh_token, refresh_operation: 'b'.repeat(32) });
  assert.equal(wrong.status, 401, 'query parameters do not select legacy status/replay semantics');
});
