// The security re-review's findings on MoMo's Google connector, each a test that fails without its fix: a sign-in cannot save after a wipe or a move, reads are bound to the account they began under, revokes are bounded, and the small leaks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as io from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AccountError } from '../shared/momoGoogle/account.mjs';
import { htmlToText } from '../shared/momoGoogle/client.mjs';
import { GoogleConsent, type ConsentError } from '../shared/momoGoogle/consent.mjs';
import { sealHandoff } from '../shared/momoGoogle/handoff.mjs';
import { createSealer } from '../shared/momoGoogle/seal.mjs';
import { createVersionStore, type SafeStorage } from '../shared/momoGoogle/store.mjs';
import { READ_SCOPES } from '../shared/momoGoogle/types.mjs';
import { createNodePrimitives } from '../shared/remote/nodePrimitives.mjs';
import { idToken } from './support/fakeGoogle.ts';
import { makeAccount, memoryFile, NOW, record } from './support/googleAccountKit.ts';

const sealer = createSealer(createNodePrimitives());
const REDIRECT = 'http://127.0.0.1:53682/callback';
const code = (c: string) => (e: unknown) => (e as ConsentError).code === c;
const cfg = { clientId: 'c', clientSecret: 's', authUri: 'https://a', tokenUri: 'https://t', revokeUri: 'https://r' };
const ok = (body: unknown = {}) => ({ ok: true, status: 200, json: async () => body });
const grant = (email: string, refresh: string) => ({
  access_token: `at-${refresh}`,
  refresh_token: refresh,
  expires_in: 3600,
  scope: READ_SCOPES.join(' '),
  id_token: idToken(email),
});

/** A fetch whose token endpoint can be held, with every request recorded; the revoke endpoint answers at once unless `hangRevoke`. */
function world(o: { hangRevoke?: boolean; tokens?: Array<unknown> } = {}) {
  const calls: { url: string; init: any }[] = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let held = false;
  let started: () => void = () => undefined;
  const tokenStarted = new Promise<void>((resolve) => (started = resolve));
  let n = 0;
  const fetch = async (url: string, init: any) => {
    calls.push({ url, init });
    if (url === cfg.revokeUri) return o.hangRevoke ? new Promise(() => undefined) : ok();
    if (url === cfg.tokenUri) {
      if (held) {
        started();
        await gate;
      }
      return ok(o.tokens?.[n++] ?? grant('me@example.com', 'rt-new'));
    }
    return ok();
  };
  return { fetch: fetch as never, calls, hold: () => (held = true), release, tokenStarted };
}

function consentRig(w: ReturnType<typeof world>, file = memoryFile(), revokeMs?: number) {
  const kit = makeAccount({ config: cfg, fetch: w.fetch, file, revokeMs });
  const consent = new GoogleConsent({ account: kit.account, config: cfg, sealer, fetch: w.fetch, now: () => kit.clock.t });
  const begin = async (purpose: 'read' | 'send' = 'read') => {
    const s = await consent.begin({ purpose, redirectUri: REDIRECT, client: 'desktop' });
    const state = new URL(s.authUrl).searchParams.get('state') as string;
    return { flowId: s.flowId, hand: sealHandoff(sealer, s.flowId, s.sealTo, { state, redirectUri: REDIRECT, code: 'c' }) };
  };
  return { kit, consent, begin };
}

// blocker: a sign-in cannot write into a home that was wiped or moved while Google answered
test('a sign-in whose home is disposed while Google answers saves nothing and its grant is revoked', async () => {
  const w = world();
  const r = consentRig(w);
  const f = await r.begin();
  w.hold();
  const pending = r.consent.complete(f.flowId, f.hand);
  await w.tokenStarted;
  r.kit.account.dispose();
  w.release();
  await assert.rejects(pending, code('superseded'));
  assert.equal(r.kit.file.value, null, 'nothing was written into the old home');
  assert.equal(w.calls.find((c) => c.url === cfg.revokeUri)?.init.body, 'token=rt-new');
});

test('a sign-in that is overtaken by a disconnect or another sign-in is dropped and revoked too', async () => {
  const w = world();
  const r = consentRig(w, memoryFile(record()));
  const f = await r.begin();
  w.hold();
  const pending = r.consent.complete(f.flowId, f.hand);
  await w.tokenStarted;
  await r.kit.account.disconnect();
  w.release();
  await assert.rejects(pending, code('superseded'));
  assert.equal(r.kit.file.value, null);
  assert.ok(w.calls.some((c) => c.url === cfg.revokeUri && c.init.body === 'token=rt-new'));
});

test('a grant that lacks a read scope is revoked, not kept and not left behind', async () => {
  const w = world({ tokens: [{ ...grant('me@example.com', 'rt-thin'), scope: 'openid email' }] });
  const r = consentRig(w);
  const f = await r.begin();
  await assert.rejects(r.consent.complete(f.flowId, f.hand), code('scope_missing'));
  assert.equal(r.kit.file.value, null);
  assert.ok(w.calls.some((c) => c.url === cfg.revokeUri && c.init.body === 'token=rt-thin'));
});

// low: two flows for different accounts race; the check is part of the save
test('two sign-ins for different accounts at once: one connects, the other is refused and revoked', async () => {
  const w = world({ tokens: [grant('a@example.com', 'rt-a'), grant('b@example.com', 'rt-b')] });
  const r = consentRig(w);
  const [one, two] = [await r.begin(), await r.begin()];
  const results = await Promise.allSettled([r.consent.complete(one.flowId, one.hand), r.consent.complete(two.flowId, two.hand)]);
  assert.deepEqual(results.map((x) => x.status).sort(), ['fulfilled', 'rejected']);
  const refused = results.find((x) => x.status === 'rejected') as PromiseRejectedResult;
  // whichever was second is either seen as another account or as overtaken by the first sign-in; either way it is dropped and revoked
  assert.ok(['different_account', 'superseded'].includes((refused.reason as ConsentError).code));
  assert.equal(r.kit.file.value?.subject, results[0]?.status === 'fulfilled' ? 'sub-a@example.com' : 'sub-b@example.com');
  assert.equal(w.calls.filter((c) => c.url === cfg.revokeUri).length, 1);
});

// medium (b): a read that began under an older account marks nothing of the new one
test('a late 401 from before a disconnect and a new sign-in does not mark the new account', async () => {
  const kit = makeAccount({ config: cfg, fetch: world().fetch });
  const before = (await kit.account.access()).generation;
  await kit.account.disconnect();
  await kit.account.connect({
    email: 'me@example.com',
    subject: 'sub-me@example.com',
    tokens: { accessToken: 'new', refreshToken: 'new-rt', expiresAt: NOW + 3_600_000, scopes: [...READ_SCOPES] },
    client: 'desktop',
    rule: 'read',
    generation: kit.account.generation(),
  });
  await kit.account.markNeedsSignIn('revoked', before);
  await kit.account.invalidate(before);
  assert.equal((await kit.account.status()).state, 'connected');
  assert.equal(kit.file.value?.tokens.expiresAt, NOW + 3_600_000, 'the new access token was not invalidated');
  await kit.account.markNeedsSignIn('revoked', kit.account.generation());
  assert.equal((await kit.account.status()).state, 'needs_sign_in', 'the current generation still marks');
});

// medium (c): revokes are bounded
test('a disconnect waits for a revoke that hangs only as long as the revoke is bounded: the account is then gone and the live token is handed back as owed', async () => {
  const w = world({ hangRevoke: true });
  const kit = makeAccount({ config: cfg, fetch: w.fetch, revokeMs: 20 });
  const started = Date.now();
  assert.deepEqual(await kit.account.disconnect(), { revoked: false, owedToken: 'rt' });
  assert.ok(Date.now() - started < 1000);
  assert.equal(kit.file.value, null);
});

test('a different-account refusal does not wait on a revoke that hangs', async () => {
  const w = world({ hangRevoke: true, tokens: [grant('other@example.com', 'rt-other')] });
  const r = consentRig(w, memoryFile(record()), 20);
  const f = await r.begin();
  const started = Date.now();
  await assert.rejects(r.consent.complete(f.flowId, f.hand), code('different_account'));
  assert.ok(Date.now() - started < 1000);
  assert.equal(r.kit.file.value?.subject, 'sub-me@example.com');
});

// low: a refresh in flight is not shared with the account that came after it
test('a read after a reconnect does not ride on a refresh that began for the account before', async () => {
  const slow = (() => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let started: () => void = () => undefined;
    return { release, gate, started: new Promise<void>((r) => (started = r)), fire: () => started() };
  })();
  const fetch = (async (url: string) => {
    if (url !== cfg.tokenUri) return ok();
    slow.fire();
    await slow.gate;
    return ok({ access_token: 'late', expires_in: 3600, scope: READ_SCOPES.join(' ') });
  }) as never;
  const kit = makeAccount({ config: cfg, fetch, file: memoryFile(record({ tokens: { ...record().tokens, expiresAt: 0 } })) });
  const old = kit.account.accessToken();
  await slow.started;
  await kit.account.connect({
    email: 'me@example.com',
    subject: 'sub-me@example.com',
    tokens: { accessToken: 'new-at', refreshToken: 'new-rt', expiresAt: NOW + 3_600_000, scopes: [...READ_SCOPES] },
    client: 'desktop',
    rule: 'read',
    generation: kit.account.generation(),
  });
  assert.equal(await kit.account.accessToken(), 'new-at', 'the new account is read at once, not after the old refresh');
  slow.release();
  await assert.rejects(old, (e: AccountError) => e.code === 'not_connected');
});

// low: old readers cannot write cursors into a folder that is gone
test('cursors set through a store that was discarded are dropped', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'momo-cursors-'));
  const xor = (b: Buffer) => Buffer.from(b.map((x) => x ^ 0x5a));
  const safe: SafeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (t) => xor(Buffer.from(t)),
    decryptString: (b) => xor(b).toString('utf8'),
  };
  const store = createVersionStore(dir, safe, io, { delayMs: 5 });
  await store.set('kept', '1');
  await store.flush();
  store.discard();
  await store.set('late', '2');
  await store.flush();
  await new Promise((resolve) => setTimeout(resolve, 40));
  const fresh = createVersionStore(dir, safe, io);
  assert.deepEqual([await fresh.get('kept'), await fresh.get('late')], ['1', undefined]);
});

// low: token requests refuse redirects
test('the refresh, the exchange and the revoke are sent with redirects refused', async () => {
  const w = world();
  const r = consentRig(w, memoryFile(record({ tokens: { ...record().tokens, expiresAt: 0 } })));
  await r.kit.account.accessToken().catch(() => undefined);
  await r.kit.account.revokeToken('x');
  const f = await r.begin();
  await r.consent.complete(f.flowId, f.hand);
  const kinds = new Set(w.calls.map((c) => c.url));
  assert.deepEqual([...kinds].sort(), [cfg.revokeUri, cfg.tokenUri].sort());
  for (const c of w.calls) assert.equal(c.init.redirect, 'error', c.url);
});

// low: the HTML scan indexes the text it scans
test('HTML after a character whose lower-case form is longer is read at the right place', () => {
  assert.equal(htmlToText('İİİ<STYLE>hidden</STYLE>shown'), 'İİİ shown');
});
