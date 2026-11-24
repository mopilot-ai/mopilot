// MoMo's Google source on a Host (host/src/momoGoogle.mjs): configure, the sign-in that finishes on the home through the shared client flow, the reader, disconnect, the send capability only the gate takes, and what lives where on the disk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { disconnectGoogle, configureGoogle, signInToGoogle } from '../shared/momoGoogle/signIn.mjs';
import { messageDigest } from '../shared/momoGoogle/send.mjs';
import { READ_SCOPES } from '../shared/momoGoogle/types.mjs';
import { idToken } from './support/fakeGoogle.ts';
import { fakeCatcher, homeWorld, sealer } from './support/momoGoogleHostKit.ts';

const host = (g: any) => ({ call: (op: string, params: object = {}) => g[op]({ op, ...params }) });
const code = (c: string) => (e: unknown) => (e as { code?: string }).code === c;
const IOS = 'ios-client-123456.apps.googleusercontent.com';

test('without a running home there is no Google source; without clients a sign-in cannot start', async (t) => {
  const away = await homeWorld(t, { start: false });
  await assert.rejects(away.google.status(), code('momo_home_away'));
  const w = await homeWorld(t);
  assert.deepEqual(await w.google.status(), { kind: 'not_connected', canStart: false, iosRedirectUri: null });
  await assert.rejects(
    w.google.begin({ purpose: 'read', client: 'desktop', redirectUri: 'http://127.0.0.1:53682/callback' }),
    code('google_not_configured'),
  );
  await assert.rejects(w.google.complete({ flowId: 'x'.repeat(16), sealed: 's' }), code('google_not_configured'));
  await assert.rejects(w.google.disconnect(), code('google_not_configured'));
  await assert.rejects(w.google.reader(), code('google_not_configured'));
});

test("configure seals the clients under MoMo's folder, refuses a bad file, and reports the iOS redirect", async (t) => {
  const w = await homeWorld(t);
  await assert.rejects(w.google.configure({ desktopJson: 'nope' }), code('google_bad_client'));
  await assert.rejects(w.google.configure({ desktopJson: w.json, iosClientId: 'a b' }), code('google_bad_client'));
  assert.deepEqual(await w.google.configure({ desktopJson: w.json }), { kind: 'not_connected', canStart: true, iosRedirectUri: null });
  assert.deepEqual(await w.google.configure({ desktopJson: w.json, iosClientId: IOS }), {
    kind: 'not_connected',
    canStart: true,
    iosRedirectUri: 'com.googleusercontent.apps.ios-client-123456:/oauth2redirect',
  });
  const file = path.join(w.momoDir, 'google', 'google-clients.sealed');
  assert.ok(fs.existsSync(file), "the clients live in MoMo's folder, so a move carries them");
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /desk-secret|desk-id/);
});

test('a full sign-in through the shared client flow: connecting, connected read-only, a refusal in words, and one in-flight flow counted', async (t) => {
  const w = await homeWorld(t);
  assert.deepEqual(await configureGoogle(host(w.google), { desktopJson: w.json }), {
    ok: true,
    state: { kind: 'not_connected', canStart: true, iosRedirectUri: null },
  });
  const h = host(w.google);
  const begun = await h.call('begin', { purpose: 'read', client: 'desktop', redirectUri: 'http://127.0.0.1:53682/callback' });
  assert.deepEqual(await w.google.status(), { kind: 'connecting' });
  await assert.rejects(h.call('complete', { flowId: begun.flowId, sealed: 'garbage' }), code('google_invalid'));

  const denied = await signInToGoogle({
    host: h,
    startCatcher: fakeCatcher(() => ({ error: 'access_denied' })),
    sealer,
    purpose: 'read',
    client: 'desktop',
  });
  assert.deepEqual(denied, { ok: false, code: 'google_denied', message: 'Google was not allowed.' });
  const closed = await signInToGoogle({ host: h, startCatcher: fakeCatcher(() => null), sealer, purpose: 'read', client: 'desktop' });
  assert.deepEqual(closed, { ok: false, code: 'cancelled', message: 'The sign-in was not finished.' });

  const ok = await signInToGoogle({
    host: h,
    startCatcher: fakeCatcher(() => ({ code: 'the-code' })),
    sealer,
    purpose: 'read',
    client: 'desktop',
  });
  assert.deepEqual(ok, { ok: true, state: { kind: 'connected_read_only', email: 'me@example.com', connectedAt: w.clock.at } });
  assert.equal(w.fake.requests.filter((r) => r.path === '/token').length, 1);
  // the tokens exist on the home's disk, sealed, and nowhere else
  const sealedAccount = fs.readFileSync(path.join(w.momoDir, 'google', 'google-account.sealed'), 'utf8');
  // quote-bounded: a quote is never in base64, so ciphertext cannot contain these by chance (a bare `rt1` does, now and then)
  assert.equal(JSON.parse(sealedAccount).enc, 'safe');
  assert.doesNotMatch(sealedAccount, /"(rt1|at1)"|refreshToken|accessToken/);
  assert.ok(!JSON.stringify(ok).includes('rt1'));
});

test('a failure that is not a sign-in refusal passes through unchanged', async (t) => {
  const w = await homeWorld(t);
  const broken = {
    call: async () => {
      throw new Error('boom');
    },
  };
  assert.deepEqual(
    await signInToGoogle({ host: broken, startCatcher: fakeCatcher(() => ({ code: 'c' })), sealer, purpose: 'read', client: 'desktop' }),
    { ok: false, code: 'failed', message: 'boom' },
  );
  assert.deepEqual(await disconnectGoogle(broken), { ok: false, code: 'failed', message: 'boom' });
  assert.deepEqual(await configureGoogle(broken, { desktopJson: 'x' }), { ok: false, code: 'failed', message: 'boom' });
  await assert.rejects(
    w.google.begin({ purpose: 'read', client: 'desktop', redirectUri: 'http://127.0.0.1:1/callback' }),
    code('google_not_configured'),
  );
});

test('a sign-in that fails before a catcher exists, or with a thrown value that is no error, still ends in a typed failure', async () => {
  const h = {
    call: async () => {
      throw 'plain text';
    },
  };
  assert.deepEqual(
    await signInToGoogle({ host: h, startCatcher: fakeCatcher(() => ({ code: 'c' })), sealer, purpose: 'read', client: 'desktop' }),
    { ok: false, code: 'failed', message: 'It did not finish.' },
  );
  const noListener = async () => {
    throw Object.assign(new Error('EADDRINUSE'), { code: 'EADDRINUSE' });
  };
  assert.deepEqual(await signInToGoogle({ host: h, startCatcher: noListener, sealer, purpose: 'read', client: 'desktop' }), {
    ok: false,
    code: 'EADDRINUSE',
    message: 'EADDRINUSE',
  });
});

test('the reader reads Gmail with the durable cursors, and a revoked grant becomes the disconnected state with its cause', async (t) => {
  let status = 200;
  const w = await homeWorld(t, {
    timeZone: 'Asia/Tokyo',
    gmail: (r) =>
      r.path.includes('/threads') && !r.path.endsWith('/t1')
        ? { status, body: status === 200 ? { threads: [{ id: 't1' }] } : {} }
        : {
            status,
            body: {
              id: 't1',
              messages: [{ id: 'm1', internalDate: '1', payload: { headers: [{ name: 'Subject', value: 'Hi' }] }, labelIds: ['INBOX'] }],
            },
          },
  });
  await w.google.configure({ desktopJson: w.json });
  await signInToGoogle({
    host: host(w.google),
    startCatcher: fakeCatcher(() => ({ code: 'c' })),
    sealer,
    purpose: 'read',
    client: 'desktop',
  });
  const { client, versions } = await w.google.reader();
  assert.deepEqual((await client.listThreads({ afterMs: w.clock.at - 86_400_000, beforeMs: w.clock.at, maxResults: 5 })).threadIds, ['t1']);
  assert.equal((await client.getMail('t1'))?.subject, 'Hi');
  assert.equal((await client.getThreadMeta('t1'))?.id, 't1');
  assert.equal(await client.calendarEtag().catch(() => 'no etag'), 'no etag');
  assert.deepEqual(
    await client.listEvents({
      showDeleted: true,
      timeMin: new Date(w.clock.at - 3 * 86_400_000).toISOString(),
      timeMax: new Date(w.clock.at + 86_400_000).toISOString(),
      maxResults: 5,
    }),
    { events: [] },
  );
  // the home's own zone decides the connect day: 2023-11-14 22:13Z is 07:13 on the 15th in Tokyo, which began at 15:00Z
  assert.equal(w.fake.requests.findLast((r) => r.query.has('timeMin'))?.query.get('timeMin'), '2023-11-14T15:00:00.000Z');
  await versions.set('gmail:t1', 'v1');
  assert.equal(await (await w.google.reader()).versions.get('gmail:t1'), 'v1');
  await versions.flush();
  assert.ok(fs.existsSync(path.join(w.momoDir, 'google', 'google-versions.sealed')));

  status = 401;
  await assert.rejects(client.getMail('t1'), code('google_needs_sign_in'));
  assert.deepEqual(await w.google.status(), { kind: 'disconnected', email: 'me@example.com', cause: 'revoked', since: w.clock.at });
});

test('disconnect revokes at Google, erases the tokens and cursors and keeps the clients', async (t) => {
  const w = await homeWorld(t);
  await w.google.configure({ desktopJson: w.json });
  await signInToGoogle({
    host: host(w.google),
    startCatcher: fakeCatcher(() => ({ code: 'c' })),
    sealer,
    purpose: 'read',
    client: 'desktop',
  });
  await (await w.google.reader()).versions.set('k', 'v');
  const out = await disconnectGoogle(host(w.google));
  assert.deepEqual(out, { ok: true, revoked: true, owed: false, state: { kind: 'not_connected', canStart: true, iosRedirectUri: null } });
  assert.equal(w.fake.requests.at(-1)?.form.get('token'), 'rt1');
  assert.equal(fs.existsSync(path.join(w.momoDir, 'google', 'google-account.sealed')), false);
  assert.equal(await (await w.google.reader()).versions.get('k'), undefined);
  assert.ok(fs.existsSync(path.join(w.momoDir, 'google', 'google-clients.sealed')));
});

test('the send capability is handed out once, to the gate: not granted until the send-only step, then one grant sends one mail', async (t) => {
  const sendScope = 'https://www.googleapis.com/auth/gmail.send';
  let tokenScope = READ_SCOPES.join(' ');
  const w = await homeWorld(t, {
    gmail: (r) => (r.path.endsWith('/messages/send') ? { body: { id: 'sent-1' } } : undefined),
    token: () => ({
      body: { access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: tokenScope, id_token: idToken('me@example.com') },
    }),
  });
  const gate = w.google.takeSendForGate();
  assert.throws(() => w.google.takeSendForGate(), code('google_send_taken'));
  const msg = { to: ['a@x.com'], subject: 'Hi', body: 'Hello' };
  assert.equal(await gate.canSend(), false);
  assert.deepEqual(await gate.send(msg, gate.mint(gate.digest(msg))), { ok: false, reason: 'not_granted' });
  await w.google.configure({ desktopJson: w.json });
  assert.equal(await gate.canSend(), false);
  await signInToGoogle({
    host: host(w.google),
    startCatcher: fakeCatcher(() => ({ code: 'c' })),
    sealer,
    purpose: 'read',
    client: 'desktop',
  });
  assert.equal(await gate.canSend(), false);
  assert.deepEqual(await gate.send(msg, gate.mint(gate.digest(msg))), { ok: false, reason: 'not_granted' });

  tokenScope = sendScope;
  const sent = await signInToGoogle({
    host: host(w.google),
    startCatcher: fakeCatcher(() => ({ code: 'c' })),
    sealer,
    purpose: 'send',
    client: 'desktop',
  });
  assert.equal(sent.ok && sent.state.kind, 'send_granted');
  assert.equal(await gate.canSend(), true);
  assert.deepEqual(await gate.send(msg, undefined), { ok: false, reason: 'no_permission' });
  const grant = gate.mint(gate.digest(msg));
  assert.deepEqual(await gate.send(msg, grant), { ok: true, id: 'sent-1' });
  assert.deepEqual(await gate.send(msg, grant), { ok: false, reason: 'no_permission' });
  assert.equal(gate.digest(msg), messageDigest(msg));
});

test('a new lease rebuilds what the home holds: a tombstoned home refuses', async (t) => {
  const w = await homeWorld(t);
  await w.google.configure({ desktopJson: w.json });
  const epoch = w.home.record()?.leaseEpoch as number;
  await w.home.tombstone({ name: 'Mini', homeId: 'home-bbbb-2222', leaseEpoch: epoch + 1 });
  await assert.rejects(w.google.status(), code('momo_home_away'));
});
