// The organization access service (#3361 Tier 2): the admin's settings, the encrypted sign-in, leases lent to machines, their renewal at 80% of life, and sign-out taking them back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { configOf, identityOf, HOUR, START, REFRESH, ISSUER, CONFIG, setup, id } from './support/orgAccessKit.ts';

test('configOf checks the settings and cleans them; identityOf is a stable 32-hex hash of issuer and subject', () => {
  assert.deepEqual(configOf(CONFIG), { ...CONFIG, scopes: 'openid email', access: configOf(CONFIG).access });
  assert.equal(configOf({ ...CONFIG, scopes: 'bad\nscope', leaseHours: 99 }).scopes, '');
  assert.equal(configOf({ ...CONFIG, scopes: 7, leaseHours: 99 }).leaseHours, 8);
  assert.throws(() => configOf({ ...CONFIG, issuer: 'http://idp.example.test' }), { code: 'invalid', message: /issuer/ });
  assert.throws(() => configOf({ ...CONFIG, clientId: 'has space' }), { code: 'invalid', message: /client id/ });
  assert.throws(() => configOf({ ...CONFIG, clientId: 5 }), { code: 'invalid' });
  assert.throws(() => configOf(undefined), { code: 'invalid' });
  assert.throws(() => configOf({ ...CONFIG, access: { gateways: {} } }), /gateway/);
  assert.match(identityOf(ISSUER, 'u'), /^[0-9a-f]{32}$/);
  assert.equal(identityOf(ISSUER, 'u'), identityOf(ISSUER, 'u'));
  assert.notEqual(identityOf(ISSUER, 'u'), identityOf(ISSUER, 'v'));
});

test('the view goes off, signedOut, signedIn, signinRequired; the person is named; a changed config forgets the sign-in', async (t) => {
  const s = setup(t);
  assert.deepEqual(s.svc.view(), { configured: false, config: null, state: 'off', who: null, managed: null });
  assert.equal(s.svc.identity(), null);
  await assert.rejects(s.svc.signIn(), { code: 'invalid' });
  assert.equal((await s.svc.configure(CONFIG)).state, 'signedOut');
  const v = await s.svc.signIn();
  assert.deepEqual([v.state, v.who, s.svc.identity()], ['signedIn', 'a@example.test', id()]);
  assert.equal(s.changes.count, 2);
  // the same settings again keep the sign-in; changed ones end it and tell the IdP
  await s.svc.configure(CONFIG);
  assert.equal(s.svc.view().state, 'signedIn');
  const after = await s.svc.configure({ ...CONFIG, clientId: 'client-2' });
  assert.deepEqual([after.state, after.who, s.o.revokes], ['signedOut', null, [REFRESH]]);
  assert.equal(s.svc.identity(), null);
  // a refresh the IdP refused shows as signinRequired
  s.o.refreshError = Object.assign(new Error('gone'), { code: 'signin_required' });
  await assert.rejects(s.svc.lend(s.host(), 'claude'), { code: 'org_signin_required' });
  assert.equal(s.svc.view().state, 'signinRequired');
});

test('signIn keeps the refresh token encrypted, joins a concurrent call, and refuses an IdP that gave none', async (t) => {
  const s = setup(t);
  await s.svc.configure(CONFIG);
  const [a, b] = [s.svc.signIn(), s.svc.signIn()];
  assert.equal(a, b);
  await a;
  assert.equal(s.o.signIns, 1);
  assert.equal(s.raw().includes(REFRESH), false);
  assert.equal(typeof s.rec().refresh, 'string');
  // after it ends a new sign-in is a new call
  await s.svc.signIn();
  assert.equal(s.o.signIns, 2);

  const none = setup(t);
  await none.svc.configure(CONFIG);
  none.o.refreshToken = null;
  await assert.rejects(none.svc.signIn(), { code: 'invalid', message: /refresh token/ });
  assert.equal(none.svc.view().state, 'signedOut');
});

test("a different person signing in takes the first identity's leases back; the same person does not", async (t) => {
  const s = setup(t);
  await s.svc.configure(CONFIG);
  await s.svc.signIn();
  const h = s.host();
  await s.svc.lend(h, 'claude');
  await s.svc.signIn();
  assert.equal(h.calls.length, 1);
  s.o.subject = 'user-2';
  await s.svc.signIn();
  assert.deepEqual(h.calls[1], { harness: 'claude', identity: id('user-1'), token: null });
  assert.equal(s.svc.identity(), id('user-2'));
  assert.equal(s.clock.pending, 0);
});

test('without encryption nothing is kept: signIn and setOrgKey refuse with unavailable', async (t) => {
  const s = setup(t, { available: false });
  await s.svc.configure(CONFIG);
  await assert.rejects(s.svc.signIn(), { code: 'unavailable' });
  assert.throws(() => s.svc.setOrgKey('org-key-dddddddddddddddd'), { code: 'unavailable' });
});

test('lend is false with no config, an unknown harness, or no gateway for that harness', async (t) => {
  const s = setup(t);
  const h = s.host();
  assert.equal(await s.svc.lend(h, 'claude'), false);
  await s.svc.configure({ ...CONFIG, access: { gateways: { anthropic: 'https://gw.example.test/a' } } });
  await s.svc.signIn();
  assert.equal(await s.svc.lend(h, 'nobody'), false);
  assert.equal(await s.svc.lend(h, 'codex'), false);
  assert.equal(h.calls.length, 0);
  assert.equal(s.clock.pending, 0);
});

test("lend mints a lease for the identity with the harness's gateways, capped at the lease hours", async (t) => {
  const s = setup(t);
  await s.svc.configure(CONFIG);
  s.o.lifeMs = 10 * HOUR;
  await s.svc.signIn();
  const h = s.host();
  for (const harness of ['claude', 'codex', 'acp']) assert.equal(await s.svc.lend(h, harness), true);
  const [c, x, a] = h.calls;
  assert.deepEqual(c.gateways, { anthropic: 'https://gw.example.test/a' });
  assert.deepEqual(x.gateways, { openai: 'https://gw.example.test/o' });
  assert.deepEqual(a.gateways, { anthropic: 'https://gw.example.test/a', openai: 'https://gw.example.test/o' });
  assert.deepEqual([c.identity, c.token, c.expiresAt], [id(), 'access-signin-1-aaaaaaaa', START + 8 * HOUR]);
  assert.equal(s.clock.pending, 1);
  s.svc.dispose();
  assert.equal(s.clock.pending, 0);
});

test('a token with under 20% of its life left is refreshed before lending; one with more is reused', async (t) => {
  const s = setup(t);
  await s.svc.configure(CONFIG);
  await s.svc.signIn();
  s.clock.advance(40 * 60_000);
  await s.svc.lend(s.host(), 'claude');
  assert.equal(s.o.refreshes.length, 0);
  s.svc.dispose();

  const stale = setup(t);
  await stale.svc.configure(CONFIG);
  await stale.svc.signIn();
  stale.clock.advance(50 * 60_000);
  stale.o.nextRefreshToken = 'refresh-rotated-0000-dummy';
  const h = stale.host();
  await stale.svc.lend(h, 'claude');
  assert.deepEqual(stale.o.refreshes, [{ refresh: REFRESH, now: START + 50 * 60_000 }]);
  assert.equal(h.calls[0].token, 'access-renewed-1-aaaa');
  assert.equal(stale.raw().includes('refresh-rotated'), false);
  // the rotated refresh token is the one used next; the same one back changes nothing
  stale.clock.advance(50 * 60_000);
  stale.o.nextRefreshToken = 'refresh-rotated-0000-dummy';
  await stale.svc.lend(h, 'claude');
  assert.equal(stale.o.refreshes[1].refresh, 'refresh-rotated-0000-dummy');
  stale.svc.dispose();
});

test('refresh failures: signin_required ends the kept token; others are org_unavailable; never signed in asks for a sign-in', async (t) => {
  const s = setup(t);
  await s.svc.configure(CONFIG);
  await assert.rejects(s.svc.lend(s.host(), 'claude'), { code: 'org_signin_required' });
  assert.equal(s.svc.view().state, 'signinRequired');
  await s.svc.signIn();
  assert.equal(s.svc.view().state, 'signedIn');
  s.clock.advance(55 * 60_000);
  const before = s.changes.count;
  s.o.refreshError = Object.assign(new Error('Sign in again'), { code: 'signin_required' });
  await assert.rejects(s.svc.lend(s.host(), 'claude'), { code: 'org_signin_required' });
  assert.equal(s.rec().refresh, undefined);
  assert.deepEqual([s.svc.view().state, s.changes.count], ['signinRequired', before + 1]);

  for (const [thrown, message] of [
    [new Error('boom'), 'boom'],
    ['plain', 'plain'],
    [null, 'null'],
  ] as const) {
    const u = setup(t);
    await u.svc.configure(CONFIG);
    await u.svc.signIn();
    u.clock.advance(55 * 60_000);
    u.o.refreshError = thrown;
    await assert.rejects(u.svc.lend(u.host(), 'claude'), { code: 'org_unavailable', message });
    assert.equal(u.svc.view().state, 'signedIn');
  }
});

test('a Host that refuses the lease (an older Host) throws to the caller and nothing is lent or scheduled', async (t) => {
  const s = setup(t);
  await s.svc.configure(CONFIG);
  await s.svc.signIn();
  const h = s.host();
  h.fail = Object.assign(new Error('no'), { code: 'feature_missing' });
  await assert.rejects(s.svc.lend(h, 'claude'), { code: 'feature_missing' });
  assert.equal(s.clock.pending, 0);
  await s.svc.signOut();
  assert.equal(h.calls.length, 1);
});

test("signOut tells every lent host the identity's lease is gone, revokes at the IdP and forgets the sign-in; nothing set up is a no-op", async (t) => {
  const idle = setup(t);
  await idle.svc.signOut();
  assert.equal(idle.changes.count, 0);

  const s = setup(t);
  await s.svc.configure(CONFIG);
  await s.svc.signIn();
  const [a, b] = [s.host(), s.host()];
  await s.svc.lend(a, 'claude');
  await s.svc.lend(b, 'codex');
  b.fail = new Error('unreachable');
  const before = s.changes.count;
  const v = await s.svc.signOut();
  assert.deepEqual(a.calls.at(-1), { harness: 'claude', identity: id(), token: null });
  assert.deepEqual(b.calls.at(-1), { harness: 'codex', identity: id(), token: null });
  assert.deepEqual([v.state, v.who, s.o.revokes, s.changes.count], ['signedOut', null, [REFRESH], before + 1]);
  const r = s.rec();
  assert.deepEqual([r.refresh, r.who, r.identity, !!r.config], [undefined, undefined, undefined, true]);
  assert.equal(s.clock.pending, 0);

  // a kept sign-in without settings, or leases without settings, are still ended
  const orphan = setup(t);
  await orphan.svc.configure(CONFIG);
  await orphan.svc.signIn();
  const oh = orphan.host();
  await orphan.svc.lend(oh, 'claude');
  orphan.patch((r) => delete r.config);
  await orphan.svc.signOut();
  assert.equal(oh.calls.at(-1).token, null);
  assert.deepEqual(orphan.o.revokes, []);
  orphan.patch((r) => ((r.refresh = Buffer.from([...REFRESH].reverse().join('')).toString('base64')), (r.who = 'x')));
  const before2 = orphan.changes.count;
  await orphan.svc.signOut();
  assert.equal(orphan.changes.count, before2 + 1);
  const leased = setup(t);
  await leased.svc.configure(CONFIG);
  await leased.svc.signIn();
  const lh = leased.host();
  await leased.svc.lend(lh, 'claude');
  leased.patch((r) => (delete r.config, delete r.refresh));
  await leased.svc.signOut();
  assert.equal(lh.calls.length, 2);
});

test('remove clears the settings, the org key and the leases', async (t) => {
  const s = setup(t);
  await s.svc.configure(CONFIG);
  await s.svc.signIn();
  s.svc.setOrgKey('org-key-eeeeeeeeeeeeeeee');
  assert.equal(s.raw().includes('org-key-eeee'), false);
  assert.equal(typeof s.rec().orgKey, 'string');
  const h = s.host();
  await s.svc.lend(h, 'claude');
  const v = await s.svc.remove();
  assert.equal(v.state, 'off');
  // only the identity a machine may still hold a lease for is kept
  assert.deepEqual(Object.keys(s.rec()), ['former']);
  assert.equal(h.calls.at(-1).token, null);
  assert.deepEqual(s.o.revokes, [REFRESH]);
  assert.equal(s.clock.pending, 0);
  // removing again with nothing set up is harmless
  assert.equal((await s.svc.remove()).state, 'off');
  s.svc.setOrgKey(null);
});

test('a static key needs no sign-in: covered, signedIn, held under the issuer alone, ending at the lease hours', async (t) => {
  const s = setup(t);
  const cfg = { ...CONFIG, access: { kind: 'staticKey', gateways: CONFIG.access.gateways } };
  await s.svc.configure(cfg);
  assert.deepEqual([s.svc.view().state, s.svc.covers('claude')], ['signedIn', true]);
  const h = s.host();
  await assert.rejects(s.svc.lend(h, 'claude'), { code: 'org_unavailable', message: /organization key/ });
  s.svc.setOrgKey('org-key-ffffffffffffffff');
  assert.equal(await s.svc.lend(h, 'claude'), true);
  assert.deepEqual(
    [h.calls[0].identity, h.calls[0].token, h.calls[0].expiresAt],
    [identityOf(ISSUER, ''), 'org-key-ffffffffffffffff', START + 8 * HOUR],
  );
  assert.equal(s.o.refreshes.length, 0);
  s.svc.dispose();
});

test('covers needs settings, a known harness with a gateway, and a sign-in (when the source wants one)', async (t) => {
  const s = setup(t);
  assert.equal(s.svc.covers('claude'), false);
  await s.svc.configure({ ...CONFIG, access: { gateways: { anthropic: 'https://gw.example.test/a' } } });
  assert.equal(s.svc.covers('claude'), false);
  await s.svc.signIn();
  assert.deepEqual(
    [s.svc.covers('claude'), s.svc.covers('codex'), s.svc.covers('nobody'), s.svc.covers('acp')],
    [true, false, false, true],
  );
});

test('an unreadable file, a non-object file, a bad config and an undecryptable secret read as empty', async (t) => {
  const s = setup(t);
  await s.svc.configure(CONFIG);
  await s.svc.signIn();
  s.storage.broken = true;
  // a kept secret counts as signed in without being decrypted; lend finds out when it needs it
  const decrypts = s.storage.decrypts;
  assert.deepEqual([s.svc.view().state, s.svc.covers('claude')], ['signedIn', true]);
  assert.equal(s.storage.decrypts, decrypts);
  s.clock.advance(55 * 60_000);
  await assert.rejects(s.svc.lend(s.host(), 'claude'), { code: 'org_signin_required' });
  s.storage.broken = false;
  s.patch((r) => (r.config.clientId = 'bad id'));
  assert.equal(s.svc.view().state, 'off');
  fs.writeFileSync(s.file, '[1]');
  assert.equal(s.svc.view().state, 'off');
  fs.writeFileSync(s.file, '{not json');
  assert.deepEqual([s.svc.view().state, s.svc.identity()], ['off', null]);
  fs.rmSync(s.file);
  assert.equal(s.svc.view().state, 'off');
});

test('onChange returns a way to stop listening', async (t) => {
  const s = setup(t);
  let seen = 0;
  const stop = s.svc.onChange(() => seen++);
  await s.svc.configure(CONFIG);
  stop();
  await s.svc.configure({ ...CONFIG, clientId: 'client-3' });
  assert.equal(seen, 1);
});
