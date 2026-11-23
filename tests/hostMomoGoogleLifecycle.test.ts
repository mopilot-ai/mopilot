// MoMo's Google grant across a disconnect and a Reset (host/src/momoGoogle.mjs): the grant is revoked at Google first; when Google cannot be asked the revoke is kept owed in the Host's own file and tried again; a Reset with a live grant revokes it; the send step and every changing step go through a real home with an audit line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createMomoGoogle } from '../host/src/momoGoogle.mjs';
import { OWED_NOTICE, googleIntents } from '../shared/momoGoogle/intents.mjs';
import { signInToGoogle } from '../shared/momoGoogle/signIn.mjs';
import { READ_SCOPES, SEND_SCOPE } from '../shared/momoGoogle/types.mjs';
import { idToken } from './support/fakeGoogle.ts';
import { fakeCatcher, homeWorld, sealer } from './support/momoGoogleHostKit.ts';

const who = (kind: string) => ({ principal: () => ({ kind, fingerprint: `fp-${kind}`, name: `A ${kind}` }) });
const owedPath = (w: { momoDir: string }) => path.join(w.momoDir, 'google-revoke-owed.json');
const hostOf = (w: { google: any }) => ({ call: (op: string, p: object = {}) => w.google[op]({ op, ...p }) });
const connect = (w: { google: any }, purpose: 'read' | 'send' = 'read') =>
  signInToGoogle({ host: hostOf(w), startCatcher: fakeCatcher(() => ({ code: 'c' })), sealer, purpose, client: 'desktop' });
let up = true;
const flaky = () => (up ? { body: {} } : { status: 503, body: { error: 'down' } });

test('remove with Google unreachable: the owner is told, the live token is kept owed in the Host’s own file, and a later try revokes it', async (t) => {
  up = false;
  const w = await homeWorld(t, { register: true, revoke: flaky });
  await w.google.configure({ desktopJson: w.json });
  assert.equal((await connect(w)).ok, true);
  const handlers = googleIntents({ call: async (_m, p: any) => w.google[p.op](p), sealer });
  const done = (await handlers.google({ intent: 'remove', client: 'desktop' })) as { notice?: string };
  assert.equal(done.notice, OWED_NOTICE);
  assert.match(OWED_NOTICE, /Google couldn’t be reached/);
  assert.equal(fs.existsSync(path.join(w.momoDir, 'google', 'google-account.sealed')), false, 'the account is gone here');
  // the owed token is sealed with the Host's own key, never in the clear
  const kept = fs.readFileSync(owedPath(w), 'utf8');
  assert.ok(!kept.includes('rt1'));
  assert.equal(JSON.parse(kept).enc, 'safe');

  // still down: it stays owed; up again: Google is asked with that token and the file goes
  await w.google.settleOwed();
  assert.equal(fs.existsSync(owedPath(w)), true);
  up = true;
  const before = w.fake.requests.filter((r) => r.path === '/revoke').length;
  await w.google.settleOwed();
  assert.equal(w.fake.requests.filter((r) => r.path === '/revoke').length, before + 1);
  assert.equal(w.fake.requests.findLast((r) => r.path === '/revoke')?.form.get('token'), 'rt1');
  assert.equal(fs.existsSync(owedPath(w)), false);

  // a removal that did reach Google says nothing more than it did before
  assert.equal((await connect(w)).ok, true);
  assert.deepEqual(await handlers.google({ intent: 'remove', client: 'desktop' }), {});
});

test('a Host that starts tries the owed revoke at once, then on a timer, and gives up for this run after a bounded number of tries', async (t) => {
  up = false;
  const w = await homeWorld(t, { register: true, revoke: flaky, owedEveryMs: 2 });
  await w.google.configure({ desktopJson: w.json });
  await connect(w);
  assert.equal((await w.google.disconnect()).owed, true);
  const asked = () => w.fake.requests.filter((r) => r.path === '/revoke').length;
  const start = asked();
  w.google.start();
  await new Promise((resolve) => setTimeout(resolve, 600));
  const tries = asked() - start;
  assert.ok(tries >= 10 && tries <= 25, `a bounded number of tries: ${tries}`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(asked() - start, tries, 'and no more after that');
  assert.equal(fs.existsSync(owedPath(w)), true, 'still owed: the next start tries again');
  up = true;
  await w.google.settleOwed();
  assert.equal(fs.existsSync(owedPath(w)), false);
});

test('Reset MoMo with a live grant revokes it at Google, whatever pause did before the wipe', async (t) => {
  up = true;
  const w = await homeWorld(t, { register: true, revoke: flaky });
  await w.google.configure({ desktopJson: w.json });
  assert.equal((await connect(w)).ok, true);
  await w.home.reset();
  assert.equal(w.fake.requests.findLast((r) => r.path === '/revoke')?.form.get('token'), 'rt1', 'the grant was revoked');
  assert.equal(fs.existsSync(path.join(w.momoDir, 'google', 'google-account.sealed')), false);
});

test('Reset MoMo while Google is down keeps the revoke owed past the Reset, and it is revoked when Google is back', async (t) => {
  up = false;
  const w = await homeWorld(t, { register: true, revoke: flaky });
  await w.google.configure({ desktopJson: w.json });
  assert.equal((await connect(w)).ok, true);
  await w.home.reset();
  assert.equal(fs.existsSync(path.join(w.momoDir, 'google', 'google-account.sealed')), false);
  assert.equal(fs.existsSync(owedPath(w)), true, 'a Reset keeps what the Host owes Google');
  up = true;
  await w.google.settleOwed();
  assert.equal(w.fake.requests.findLast((r) => r.path === '/revoke')?.form.get('token'), 'rt1');
  assert.equal(fs.existsSync(owedPath(w)), false);
});

test('a wipe while the data is moving does not revoke: the grant goes on at the new home and nothing is owed', async (t) => {
  up = false;
  const w = await homeWorld(t, { register: true, revoke: flaky });
  await w.google.configure({ desktopJson: w.json });
  await connect(w);
  const before = w.fake.requests.filter((r) => r.path === '/revoke').length;
  (w.home as any).record = () => ({ state: 'moving' });
  await w.google.wipe();
  assert.equal(w.fake.requests.filter((r) => r.path === '/revoke').length, before);
  assert.equal(fs.existsSync(owedPath(w)), false);
  assert.equal(fs.existsSync(path.join(w.momoDir, 'google', 'google-account.sealed')), true, 'the account stays for the move to carry');
});

test('the send step through a real home: a second grant adds the send scope, the account stays the same, and asking for it is audited with the device', async (t) => {
  up = true;
  let grants = 0;
  const w = await homeWorld(t, {
    register: true,
    token: () => ({
      body: {
        access_token: `at${++grants}`,
        refresh_token: `rt${grants}`,
        expires_in: 3600,
        scope: (grants === 1 ? READ_SCOPES : [...READ_SCOPES, SEND_SCOPE]).join(' '),
        id_token: idToken('me@example.com'),
      },
    }),
  });
  await w.google.configure({ desktopJson: w.json });
  assert.equal((await connect(w, 'read')).ok, true);
  assert.equal((await w.google.status()).kind, 'connected_read_only');
  // asking for the send grant is a step of the audit log, with the device that asked
  const lane = (await import('../host/src/methods/momoGoogle.mjs')).default({ momo: w.home as never });
  const asked = await (lane.handlers['host.momoGoogle'] as any)(
    { op: 'begin', purpose: 'send', client: 'desktop', redirectUri: 'http://127.0.0.1:53682/callback' },
    'read',
    who('phone'),
  );
  assert.ok(asked.flowId);
  assert.deepEqual([w.audited.at(-1)?.event, w.audited.at(-1)?.reason], ['google.changed', 'begin:send']);
  assert.match(w.audited.at(-1)?.by ?? '', /^phone:/);
  assert.equal((await connect(w, 'send')).ok, true);
  const state = await w.google.status();
  assert.equal(state.kind, 'send_granted');
  assert.equal((state as { email: string }).email, 'me@example.com');
  assert.equal(await (w.google.takeSendForGate() as { canSend: () => Promise<boolean> }).canSend(), true);
});

test('every step that changes Google writes an audit line with the asking device first, and without an audit log it does not run', async (t) => {
  const w = await homeWorld(t, { register: true });
  const lane = (await import('../host/src/methods/momoGoogle.mjs')).default({ momo: w.home as never });
  const call = (p: object, kind = 'desktop') => (lane.handlers['host.momoGoogle'] as any)(p, 'read', who(kind));
  await call({ op: 'configure', desktopJson: w.json });
  const begun = await call({ op: 'begin', purpose: 'read', client: 'desktop', redirectUri: 'http://127.0.0.1:53682/callback' });
  assert.ok(begun.flowId);
  await call({ op: 'status' });
  await call({ op: 'iosRedirect' });
  await call({ op: 'disconnect' });
  assert.deepEqual(
    w.audited.map((e) => [e.event, e.reason]),
    [
      ['google.changed', 'configure'],
      ['google.changed', 'begin:read'],
      ['google.changed', 'disconnect'],
    ],
    'status and iosRedirect change nothing and write nothing',
  );
  for (const e of w.audited) assert.match(e.by ?? '', /^desktop:[0-9a-f]{12}$/, 'the device that asked, never its key');

  // the audit log cannot be written: the step does not run
  (w.home as any).service = (
    (was) => (id: string) =>
      id === 'gate' ? { audit: async () => false } : was(id)
  )(w.home.service.bind(w.home));
  await assert.rejects(call({ op: 'configure', desktopJson: w.json }), (e: any) => e.code === 'google_audit_unavailable');
  await assert.rejects(
    call({ op: 'begin', purpose: 'read', client: 'desktop', redirectUri: 'http://127.0.0.1:53682/callback' }),
    (e: any) => e.code === 'google_audit_unavailable',
  );
  assert.equal(w.audited.length, 3, 'nothing more was written');
});

test('only the owner’s own devices may call Google: a home, the CLI, a stranger and no one are veiled', async (t) => {
  const w = await homeWorld(t, { register: true });
  const lane = (await import('../host/src/methods/momoGoogle.mjs')).default({ momo: w.home as never });
  const veil = lane.veils['host.momoGoogle'] as (principal: unknown) => boolean;
  for (const kind of ['desktop', 'phone']) assert.equal(veil({ kind }), true, kind);
  for (const kind of ['home', 'cli', 'browser', '']) assert.equal(veil({ kind }), false, kind);
  assert.equal(veil(null), false);
  assert.equal(veil(undefined), false);
});

test('a revoke that cannot be kept owed is reported without the token, and the removal still says Google was not asked', async (t) => {
  up = false;
  const w = await homeWorld(t, { revoke: flaky });
  const reports: string[] = [];
  const google = createMomoGoogle({
    home: w.home,
    fetch: ((url: string, init: any) => w.fake.fetch(url, init)) as typeof fetch,
    now: w.clock.now,
    report: (m) => reports.push(m),
    oauth: { authUri: `${w.fake.url}/auth`, tokenUri: `${w.fake.url}/token`, revokeUri: `${w.fake.url}/revoke` },
    endpoints: { gmail: `${w.fake.url}/`, calendar: `${w.fake.url}/` },
  });
  await google.configure({ desktopJson: w.json });
  assert.equal((await connect({ google })).ok, true);
  // the Host's own file cannot be written (a folder is in its place)
  fs.mkdirSync(owedPath(w), { recursive: true });
  const out = await google.disconnect();
  assert.equal(out.owed, true);
  assert.match(reports.join('\n'), /could not keep a Google revoke to try again: /);
  assert.ok(!reports.join('\n').includes('rt1'), 'the report never carries the token');
  // and settling with the same unreadable file reports it too, and returns
  await google.settleOwed();
  assert.match(reports.join('\n'), /could not settle a Google revoke: /);
});

test('the iOS redirect is null until the home holds an iOS client, and before it holds any client at all', async (t) => {
  const w = await homeWorld(t);
  assert.deepEqual(await w.google.iosRedirect(), { uri: null });
  await w.google.configure({ desktopJson: w.json });
  assert.deepEqual(await w.google.iosRedirect(), { uri: null });
  await w.google.disconnect();
  await w.google.configure({ desktopJson: w.json, iosClientId: 'ios-client-123456.apps.googleusercontent.com' });
  assert.match((await w.google.iosRedirect()).uri ?? '', /^com\.googleusercontent\.apps\.ios-client-123456:\/oauth2redirect$/);
});
