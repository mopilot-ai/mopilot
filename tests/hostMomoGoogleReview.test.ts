// The review's findings on the Host side of MoMo's Google source: endpoints pinned, no client change under a connected account, a wipe that revokes (unless the data is moving), old readers that die, nothing in clear on any disk after a move, and no token in a wire error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createMomoGoogle } from '../host/src/momoGoogle.mjs';
// @ts-ignore: plain ESM without declarations
import { helloParams } from '../shared/host/schema.mjs';
import { GOOGLE_OAUTH } from '../shared/momoGoogle/clientConfig.mjs';
import { moveHome } from '../shared/momoMove.mjs';
import { signInToGoogle } from '../shared/momoGoogle/signIn.mjs';
import { READ_SCOPES } from '../shared/momoGoogle/types.mjs';
import { idToken, startFake } from './support/fakeGoogle.ts';
import { servedHost } from './support/hostClientsWorld.ts';
import { A, B, host } from './support/host/momoMoveWorld.ts';
import { fakeCatcher, homeWorld, sealer } from './support/momoGoogleHostKit.ts';

const code = (c: string) => (e: unknown) => (e as { code?: string }).code === c;
const asHost = (g: any) => ({ call: (op: string, p: object = {}) => g[op]({ op, ...p }) });
const connect = (w: { google: unknown }) =>
  signInToGoogle({ host: asHost(w.google), startCatcher: fakeCatcher(() => ({ code: 'c' })), sealer, purpose: 'read', client: 'desktop' });

test("whatever the client file says, the Host talks to Google's own endpoints only", async (t) => {
  const w = await homeWorld(t);
  const urls: string[] = [];
  const spy = (async (url: string) => (
    urls.push(url), { ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) }
  )) as unknown as typeof fetch;
  const google = createMomoGoogle({ home: w.home, fetch: spy });
  const evil = JSON.stringify({
    installed: { client_id: 'id', client_secret: 'sec', auth_uri: 'https://evil.example/auth', token_uri: 'https://evil.example/token' },
  });
  await google.configure({ desktopJson: evil });
  const begun = await google.begin({ purpose: 'read', client: 'desktop', redirectUri: 'http://127.0.0.1:53682/callback' });
  assert.equal(new URL(begun.authUrl).origin + new URL(begun.authUrl).pathname, GOOGLE_OAUTH.authUri);
  await assert.rejects(
    signInToGoogle({
      host: asHost(google),
      startCatcher: fakeCatcher(() => ({ code: 'c' })),
      sealer,
      purpose: 'read',
      client: 'desktop',
    }).then((r) => {
      if (!r.ok) throw Object.assign(new Error(r.message), { code: r.code });
    }),
    code('google_exchange_failed'),
  );
  assert.deepEqual([...new Set(urls)], [GOOGLE_OAUTH.tokenUri]);
});

test('the client cannot be changed under a connected account', async (t) => {
  const w = await homeWorld(t);
  await w.google.configure({ desktopJson: w.json });
  await connect(w);
  await assert.rejects(w.google.configure({ desktopJson: w.json }), code('google_connected'));
  await w.google.disconnect();
  assert.equal((await w.google.configure({ desktopJson: w.json })).kind, 'not_connected');
});

test('a wipe revokes the grant at Google first, but not when the data is moving, and never waits long on the network', async (t) => {
  const w = await homeWorld(t);
  await w.google.configure({ desktopJson: w.json });
  await connect(w);
  await w.google.wipe();
  assert.equal(w.fake.requests.findLast((r) => r.path === '/revoke')?.form.get('token'), 'rt1');
  assert.equal(fs.existsSync(path.join(w.momoDir, 'google', 'google-account.sealed')), false);

  const moving = await homeWorld(t);
  await moving.google.configure({ desktopJson: moving.json });
  await connect(moving);
  const epoch = moving.home.record()?.leaseEpoch as number;
  await moving.home.swap(epoch, (h: { state: string; moveId: string | null }) => ((h.state = 'moving'), (h.moveId = 'move-0001'), false));
  await moving.google.wipe();
  assert.equal(
    moving.fake.requests.some((r) => r.path === '/revoke'),
    false,
    'a move carries the grant, so it is not revoked',
  );

  const slow = await homeWorld(t, { wipeRevokeMs: 20 });
  await slow.google.configure({ desktopJson: slow.json });
  await connect(slow);
  slow.fake.requests.length = 0;
  const hanging = createMomoGoogle({
    home: slow.home,
    fetch: (() => new Promise(() => undefined)) as unknown as typeof fetch,
    oauth: { authUri: 'a', tokenUri: 't', revokeUri: 'r' },
    wipeRevokeMs: 20,
  });
  await hanging.reader(); // builds the account over the hanging fetch
  const started = Date.now();
  await hanging.wipe();
  assert.ok(Date.now() - started < 1000, 'the wipe did not wait for a hanging revoke');
});

test('a wipe that cannot read its own account says so and still completes', async (t) => {
  const w = await homeWorld(t);
  const reports: string[] = [];
  const google = createMomoGoogle({
    home: w.home,
    fetch: w.fake.fetch as unknown as typeof fetch,
    oauth: { authUri: 'a', tokenUri: 't', revokeUri: 'r' },
    report: (m) => reports.push(m),
  });
  await google.configure({ desktopJson: w.json });
  await google.status();
  fs.mkdirSync(path.join(w.momoDir, 'google', 'google-account.sealed'), { recursive: true });
  await google.wipe();
  assert.match(reports[0] ?? '', /Google account could not be read to revoke it: EISDIR/);
});

test('an old reader dies when the lease changes or MoMo pauses: it refreshes and saves nothing', async (t) => {
  const w = await homeWorld(t);
  await w.google.configure({ desktopJson: w.json });
  await connect(w);
  const { client } = await w.google.reader();
  await w.google.pause();
  await assert.rejects(client.getMail('t1'), code('google_not_connected'));
  const second = await w.google.reader();
  assert.ok(second.client);
  const epoch = w.home.record()?.leaseEpoch as number;
  await w.home.tombstone({ name: 'Mini', homeId: 'home-bbbb-2222', leaseEpoch: epoch + 1 });
  await assert.rejects(w.google.reader(), code('momo_home_away'));
  await assert.rejects(second.client.getMail('t1'), code('google_not_connected'));
});

test('a wire error from the reader says status and reason and nothing that could be a token', async (t) => {
  const w = await homeWorld(t, {
    instantRetries: true,
    gmail: () => ({ status: 500, body: { error: { code: 500, message: 'x', errors: [{ reason: 'backendError' }] } } }),
  });
  await w.google.configure({ desktopJson: w.json });
  await connect(w);
  const { client } = await w.google.reader();
  const e = (await client.getMail('t1').catch((x: unknown) => x)) as Error & { code: string };
  assert.equal(e.code, 'google_api');
  assert.match(e.message, /500 \(backendError\)/);
  const seen = JSON.stringify([e.message, e.stack, Object.getOwnPropertyNames(e).map((k) => String((e as never)[k]))]);
  for (const secret of ['at1', 'rt1', 'Bearer', 'desk-secret', w.fake.url]) assert.ok(!seen.includes(secret), `the error says ${secret}`);
});

test('after a move, no disk of either Host holds a token, the client secret or the account in clear, and the bundle that travelled holds none either', async (t) => {
  const fake = await startFake((r) =>
    r.path === '/token'
      ? {
          body: {
            access_token: 'at-PLAIN-1',
            refresh_token: 'rt-PLAIN-1',
            expires_in: 3600,
            scope: READ_SCOPES.join(' '),
            id_token: idToken('plain-owner@example.com'),
          },
        }
      : undefined,
  );
  t.after(() => void fake.close());
  const a = await host(t, A);
  const b = await host(t, B);
  await a.home.start(A);
  const oauth = { authUri: `${fake.url}/auth`, tokenUri: `${fake.url}/token`, revokeUri: `${fake.url}/revoke` };
  const googleA = createMomoGoogle({
    home: a.home,
    fetch: fake.fetch as unknown as typeof fetch,
    now: a.clock.now,
    oauth,
    endpoints: { gmail: `${fake.url}/`, calendar: `${fake.url}/` },
  });
  const googleB = createMomoGoogle({
    home: b.home,
    fetch: fake.fetch as unknown as typeof fetch,
    now: b.clock.now,
    oauth,
    endpoints: { gmail: `${fake.url}/`, calendar: `${fake.url}/` },
  });
  await googleA.configure({
    desktopJson: JSON.stringify({ installed: { client_id: 'desk-id', client_secret: 'desk-SECRET-1', auth_uri: 'x', token_uri: 'y' } }),
  });
  await signInToGoogle({
    host: asHost(googleA),
    startCatcher: fakeCatcher(() => ({ code: 'c' })),
    sealer,
    purpose: 'read',
    client: 'desktop',
  });
  await (await googleA.reader()).versions.set('gmail:t1', 'v1');
  a.home.use('google', { start: () => undefined, pause: () => googleA.pause(), wipe: () => googleA.wipe() });

  const travelled: string[] = [];
  const spy = {
    ...a.side,
    call: async (op: string, p?: object) => {
      const out = await a.side.call(op, p);
      if (op === 'seal') travelled.push(String((out as { sealed: string }).sealed));
      return out;
    },
  };
  const moved = await moveHome({ moveId: 'move-0001', from: spy, to: b.side, target: B, fromName: A.name });
  assert.equal(moved.ok, true);
  assert.equal(travelled.length, 1);
  const plain = ['at-PLAIN-1', 'rt-PLAIN-1', 'desk-SECRET-1', 'plain-owner@example.com'];
  for (const secret of plain) {
    assert.ok(!travelled[0]?.includes(secret), `the bundle holds ${secret}`);
    assert.ok(
      !Buffer.from(travelled[0] as string, 'base64')
        .toString('latin1')
        .includes(secret),
      `the bundle bytes hold ${secret}`,
    );
  }
  const walk = (dir: string): string[] =>
    fs.existsSync(dir)
      ? fs
          .readdirSync(dir, { withFileTypes: true })
          .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]))
      : [];
  for (const side of [a, b]) {
    for (const file of walk(side.dir)) {
      const bytes = fs.readFileSync(file).toString('latin1');
      for (const secret of plain) assert.ok(!bytes.includes(secret), `${path.relative(side.dir, file)} holds ${secret}`);
    }
  }
  assert.equal((await googleB.status()).kind, 'connected_read_only');
});

test('the Host words an API failure and a cursor write that failed', async (t) => {
  const reports: string[] = [];
  const w = await homeWorld(t, { instantRetries: true, gmail: () => ({ status: 500, body: {} }) });
  await w.google.configure({ desktopJson: w.json });
  await connect(w);
  const e = (await (await w.google.reader()).client.getMail('t1').catch((x: unknown) => x)) as Error & { code: string };
  assert.deepEqual([e.code, e.message], ['google_api', 'Google answered 500.']);

  const second = await homeWorld(t, { instantRetries: true });
  const google = createMomoGoogle({
    home: second.home,
    fetch: second.fake.fetch as unknown as typeof fetch,
    oauth: { authUri: `${second.fake.url}/auth`, tokenUri: `${second.fake.url}/token`, revokeUri: `${second.fake.url}/revoke` },
    report: (m) => reports.push(m),
  });
  await google.configure({ desktopJson: second.json });
  const { versions } = await google.reader();
  await versions.get('loaded'); // the cursors are read first, then their file is made unwritable
  fs.mkdirSync(path.join(second.momoDir, 'google', 'google-versions.sealed'), { recursive: true });
  await versions.set('k', 'v');
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.match(reports[0] ?? '', /cursors could not be saved/);
});

test('with no one to report to, a failed cursor write is dropped quietly and the cursors stay in memory', async (t) => {
  const w = await homeWorld(t);
  const quiet = createMomoGoogle({
    home: w.home,
    fetch: w.fake.fetch as unknown as typeof fetch,
    oauth: { authUri: `${w.fake.url}/auth`, tokenUri: `${w.fake.url}/token`, revokeUri: `${w.fake.url}/revoke` },
  });
  await quiet.configure({ desktopJson: w.json });
  const { versions } = await quiet.reader();
  await versions.get('loaded');
  fs.mkdirSync(path.join(w.momoDir, 'google', 'google-versions.sealed'), { recursive: true });
  await versions.set('k', 'v');
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(await versions.get('k'), 'v');
});

test('two readers asked for at once share one build: one account, one cursor store', async (t) => {
  const w = await homeWorld(t);
  await w.google.configure({ desktopJson: w.json });
  await connect(w);
  w.google.pause(); // forget what was built, so the next two calls both have to build
  const [a, b, status] = await Promise.all([w.google.reader(), w.google.reader(), w.google.status()]);
  assert.equal(a.versions, b.versions, 'the second call used the first one’s build');
  assert.equal(status.kind, 'connected_read_only');
});

test('a disconnect clears the cursors first and does not wait on a revoke that hangs', async (t) => {
  const w = await homeWorld(t);
  const hanging = createMomoGoogle({
    home: w.home,
    fetch: ((url: string, init: any) =>
      String(url).endsWith('/revoke') ? new Promise(() => undefined) : w.fake.fetch(url, init)) as unknown as typeof fetch,
    oauth: { authUri: `${w.fake.url}/auth`, tokenUri: `${w.fake.url}/token`, revokeUri: `${w.fake.url}/revoke` },
    revokeMs: 20,
  });
  await hanging.configure({ desktopJson: w.json });
  await signInToGoogle({
    host: asHost(hanging),
    startCatcher: fakeCatcher(() => ({ code: 'c' })),
    sealer,
    purpose: 'read',
    client: 'desktop',
  });
  await (await hanging.reader()).versions.set('k', 'v');
  const started = Date.now();
  const out = await hanging.disconnect();
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual([out.revoked, out.state.kind], [false, 'not_connected']);
  assert.equal(await (await hanging.reader().catch(() => ({ versions: { get: async () => undefined } }))).versions.get('k'), undefined);
});

test('an error that is not Google’s (a file the Host cannot read) reaches a client as one worded refusal, with no path or text of its own', async (t) => {
  const w = await homeWorld(t);
  await w.google.configure({ desktopJson: w.json });
  await w.google.status();
  fs.rmSync(path.join(w.momoDir, 'google', 'google-account.sealed'), { force: true });
  fs.mkdirSync(path.join(w.momoDir, 'google', 'google-account.sealed'), { recursive: true });
  const e = (await w.google.status().catch((x: unknown) => x)) as Error & { code: string };
  assert.deepEqual([e.code, e.message], ['google_failed', 'Google could not be used on this machine right now.']);
  assert.ok(!e.message.includes(w.dir) && !String(e.stack).includes('EISDIR\u0000'));
});

test('the wire layer never logs or stores the client secret a configure carries, and never echoes it in an answer', async (t) => {
  const SECRET = 'desk-SECRET-9';
  const reports: string[] = [];
  const a = await host(t, A);
  await a.home.start(A);
  const google = createMomoGoogle({
    home: a.home,
    fetch: (async () => {
      throw new Error('no network');
    }) as unknown as typeof fetch,
    report: (m) => reports.push(m),
  });
  a.home.provide('google', google);
  a.home.provide('gate', { audit: async () => true });
  const served = await servedHost(t, { momo: a.home, report: (m: string) => reports.push(m) });
  const client = (await served.paired('mac', 'Mac')).conn;
  await client.request('host.momoGrant', { account: 'a1', features: ['momo'] });
  await client.call('host.hello', helloParams());
  const asked = JSON.stringify({ installed: { client_id: 'id', client_secret: SECRET, auth_uri: 'x', token_uri: 'y' } });
  const answer = await client.request('host.momoGoogle', { op: 'configure', desktopJson: asked });
  const refused = await client.request('host.momoGoogle', { op: 'configure', desktopJson: `not json ${SECRET}` }).catch((x: any) => x);
  assert.ok(!JSON.stringify(answer).includes(SECRET));
  assert.ok(!String(refused?.message).includes(SECRET) && !JSON.stringify(refused).includes(SECRET));
  assert.ok(!reports.join('\n').includes(SECRET), 'nothing was reported with it');
  const walk = (dir: string): string[] =>
    fs.existsSync(dir)
      ? fs
          .readdirSync(dir, { withFileTypes: true })
          .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.isFile() ? [path.join(dir, e.name)] : []))
      : [];
  for (const dirOf of [a.dir, served.dir as string])
    for (const file of walk(dirOf))
      assert.ok(!fs.readFileSync(file).toString('latin1').includes(SECRET), `${file} holds the secret in clear`);
});
