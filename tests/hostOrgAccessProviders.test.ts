// The organization access adapters (#3361 Tier 2): the gateway, static key and token exchange (wif) sources, and the admin's settings they are made from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { providerFor, accessOf, gatewaysOf } = require('../electron/host/orgAccess/providers.cjs');

const GW = { anthropic: 'https://gw.example.test/anthropic/' };
const SIGNED = { accessToken: 'access-token-aaaaaaaaaaaa', idToken: 'id-token-bbbbbbbbbbbbbbb', expiresAt: 9000 };

test('gatewaysOf keeps https (or loopback http) addresses, trims the slash, and wants at least one', () => {
  assert.deepEqual(gatewaysOf({ anthropic: GW.anthropic, openai: '' }), { anthropic: 'https://gw.example.test/anthropic' });
  assert.deepEqual(gatewaysOf({ openai: 'http://127.0.0.1:8080' }), { openai: 'http://127.0.0.1:8080' });
  assert.throws(() => gatewaysOf({ anthropic: 'http://gw.example.test' }), { code: 'invalid', message: /Anthropic gateway/ });
  assert.throws(() => gatewaysOf({ openai: 'http://gw.example.test' }), { code: 'invalid', message: /OpenAI gateway/ });
  assert.throws(() => gatewaysOf({}), { code: 'invalid', message: /at least one/ });
  assert.throws(() => gatewaysOf(undefined), { code: 'invalid' });
});

test('accessOf: gateway is the default, staticKey needs only gateways, wif needs an https exchange and an audience, anything else is refused', () => {
  assert.deepEqual(accessOf({ gateways: GW }), { kind: 'gateway', gateways: { anthropic: 'https://gw.example.test/anthropic' } });
  assert.equal(accessOf({ kind: 'gateway', gateways: GW }).kind, 'gateway');
  assert.equal(accessOf({ kind: 'staticKey', gateways: GW }).kind, 'staticKey');
  const wif = accessOf({ kind: 'wif', gateways: GW, exchangeUrl: 'https://sts.example.test/x', audience: 'aud-1' });
  assert.deepEqual(wif, {
    kind: 'wif',
    exchangeUrl: 'https://sts.example.test/x',
    audience: 'aud-1',
    gateways: { anthropic: 'https://gw.example.test/anthropic' },
  });
  assert.throws(() => accessOf({ kind: 'wif', gateways: GW, exchangeUrl: 'http://sts.example.test', audience: 'a' }), /exchange address/);
  assert.throws(() => accessOf({ kind: 'wif', gateways: GW, exchangeUrl: 'https://sts.example.test', audience: 'has space' }), /audience/);
  assert.throws(() => accessOf({ kind: 'wif', gateways: GW, exchangeUrl: 'https://sts.example.test' }), /audience/);
  assert.throws(() => accessOf({ kind: 'magic', gateways: GW }), { code: 'invalid', message: /not a kind/ });
  assert.throws(() => accessOf(undefined), { code: 'invalid' });
  assert.throws(() => accessOf({ gateways: {} }), /at least one/);
});

test('gateway: the IdP access token is the lease; without a sign-in it asks for one', async () => {
  const p = providerFor(accessOf({ gateways: GW }));
  assert.deepEqual([p.kind, p.needsSignIn], ['gateway', true]);
  assert.deepEqual(await p.mint(SIGNED, 0), { token: SIGNED.accessToken, gateways: accessOf({ gateways: GW }).gateways, expiresAt: 9000 });
  await assert.rejects(p.mint(null, 0), { code: 'signin_required' });
});

test('staticKey: the org key from the store, ending 24 h on; no key is invalid', async () => {
  const access = accessOf({ kind: 'staticKey', gateways: GW });
  const p = providerFor(access, { staticKey: () => 'org-key-cccccccccccccccc' });
  assert.equal(p.needsSignIn, false);
  assert.deepEqual(await p.mint(null, 100), { token: 'org-key-cccccccccccccccc', gateways: access.gateways, expiresAt: 100 + 86_400_000 });
  await assert.rejects(providerFor(access).mint(null, 0), { code: 'invalid', message: /organization key/ });
});

const WIF = accessOf({ kind: 'wif', gateways: GW, exchangeUrl: 'https://sts.example.test/x', audience: 'aud-1' });

test('wif: exchanges the id token (else the access token) for a short-lived one; expires_in, else the sign-in end', async () => {
  const sent: any[] = [];
  const answers: any[] = [{ access_token: 'vendor-token-1', expires_in: 120 }, { access_token: 'vendor-token-2' }];
  const fetch = async (url: string, init: any) => {
    sent.push({ url, init, form: Object.fromEntries(new URLSearchParams(init.body)) });
    return new Response(JSON.stringify(answers.shift()));
  };
  const p = providerFor(WIF, { fetch: fetch as any });
  assert.equal(p.needsSignIn, true);
  const a = await p.mint(SIGNED, 1000);
  assert.deepEqual([a.token, a.expiresAt], ['vendor-token-1', 1000 + 120_000]);
  assert.deepEqual(sent[0].form, {
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    subject_token: SIGNED.idToken,
    subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
    audience: 'aud-1',
  });
  assert.equal(sent[0].url, 'https://sts.example.test/x');
  const b = await p.mint({ accessToken: SIGNED.accessToken, idToken: 5, expiresAt: 7777 }, 1000);
  assert.deepEqual([b.token, b.expiresAt, sent[1].form.subject_token], ['vendor-token-2', 7777, SIGNED.accessToken]);
  await assert.rejects(p.mint(null, 0), { code: 'signin_required' });
});

test('wif failures: 401 or invalid_grant is signin_required, another refusal is invalid, a throw or bad JSON is unreachable', async () => {
  const run = (res: () => unknown) => providerFor(WIF, { fetch: (async () => res()) as any }).mint(SIGNED, 0);
  await assert.rejects(
    run(() => new Response('{}', { status: 401 })),
    { code: 'signin_required' },
  );
  await assert.rejects(
    run(() => new Response('{"error":"invalid_grant"}', { status: 400 })),
    { code: 'signin_required' },
  );
  await assert.rejects(
    run(() => new Response('{"error":"denied"}', { status: 403 })),
    { code: 'invalid', message: /denied/ },
  );
  await assert.rejects(
    run(() => new Response('{}', { status: 500 })),
    { code: 'invalid', message: /500/ },
  );
  await assert.rejects(
    run(() => new Response('{"access_token":7}')),
    { code: 'invalid' },
  );
  await assert.rejects(
    run(() => new Response('null', { status: 500 })),
    { code: 'invalid' },
  );
  await assert.rejects(
    run(() => new Response('nope')),
    { code: 'unreachable' },
  );
  await assert.rejects(
    run(() => Promise.reject(new Error('offline'))),
    { code: 'unreachable' },
  );
  // the default fetch is the global one
  assert.equal(typeof providerFor(WIF).mint, 'function');
});
