// Pairing (host/src/pairing.mjs, electron/host/pairingClient.cjs, the server gate): a one-time code registers a client key, a wrong code is refused and retires the code, other clients are refused, and a corrupt pairing file fails closed (W3, B1, A6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createPairing, CODE_TTL_MS, MAX_WRONG, NONCE_TTL_MS, normalizeCode, PairingError } from '../host/src/pairing.mjs';
import { createPaths } from '../host/src/paths.mjs';
import { callHost, startServer } from '../host/src/server.mjs';
import { main } from '../host/src/cli.mjs';
import { line } from './support/host-line.ts';
import { waitFor } from './support/waitFor.ts';
import { keySafe } from './support/hostKeySafe.ts';
const require = createRequire(import.meta.url);
const { loadIdentity, pairWith, authenticate, normalizeCode: appNormalize } = require('../electron/host/pairingClient.cjs');

const tmp = (t: any) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pairing-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
const world = (t: any) => {
  const dir = tmp(t);
  let clock = 1_000_000;
  const host = createPairing({ configDir: path.join(dir, 'host'), now: () => clock });
  const identity = (name = 'app') => loadIdentity(path.join(dir, `${name}.json`), keySafe);
  /** A client reaching the Host in process, the way the server answers it. */
  const request =
    (h = host) =>
    async (method: string, params: any = {}) => {
      if (method === 'host.challenge') return { nonce: h.challenge(), hostId: h.hostId() };
      if (method === 'host.pair') return h.claim(params);
      if (method === 'host.auth') return h.verify(params);
      throw new Error('no such method');
    };
  return { dir, host, identity, request, advance: (ms: number) => (clock += ms) };
};
const code = (e: any) => e.code;

test('the code the Host printed registers the app once, and it is spent (the happy path)', async (t) => {
  const w = world(t);
  const printed = w.host.issueCode();
  assert.match(printed, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(w.host.paired(), 0);
  const app = w.identity();
  const { fingerprint } = await pairWith(w.request(), app, printed.toLowerCase().replace(/-/g, ' '));
  assert.equal(w.host.paired(), 1);
  assert.ok(w.host.knows(fingerprint));
  assert.deepEqual(w.host.fingerprints(), [fingerprint]);
  assert.deepEqual(await authenticate(w.request(), app), {
    fingerprint,
    name: (await w.host.principal(fingerprint))?.name,
    kind: 'desktop',
  });
  // the code does not work a second time, for this app or another
  await assert.rejects(pairWith(w.request(), w.identity('other'), printed), (e: any) => code(e) === 'no_code');
  assert.equal(JSON.parse(fs.readFileSync(path.join(w.dir, 'host/pairing.json'), 'utf8')).codeHash, null);
  assert.equal(fs.statSync(path.join(w.dir, 'host/pairing.json')).mode & 0o777, 0o600);
});

test('a wrong code is refused, five wrong ones retire the code, and a new code starts again', async (t) => {
  const w = world(t);
  const printed = w.host.issueCode();
  for (let i = 1; i < MAX_WRONG; i++) {
    await assert.rejects(
      pairWith(w.request(), w.identity(), 'AAAA-AAAA-AAAA'),
      (e: any) => code(e) === 'wrong_code' && /not the pairing code/.test(e.message),
    );
  }
  await assert.rejects(
    pairWith(w.request(), w.identity(), 'AAAA-AAAA-AAAA'),
    (e: any) => code(e) === 'wrong_code' && /Too many/.test(e.message),
  );
  assert.equal(w.host.paired(), 0);
  // the right code no longer works: it was retired
  await assert.rejects(pairWith(w.request(), w.identity(), printed), (e: any) => code(e) === 'no_code');
  const fresh = w.host.issueCode();
  await pairWith(w.request(), w.identity(), fresh);
  assert.equal(w.host.paired(), 1);
});

test('a code expires after 24 hours, at the second (A6)', async (t) => {
  const w = world(t);
  const printed = w.host.issueCode();
  w.advance(CODE_TTL_MS - 1);
  await pairWith(w.request(), w.identity(), printed);
  const late = world(t);
  const old = late.host.issueCode();
  late.advance(CODE_TTL_MS);
  await assert.rejects(pairWith(late.request(), late.identity(), old), (e: any) => code(e) === 'code_expired');
});

test('a client the Host has not paired is refused, even with a good signature (unknown client)', async (t) => {
  const w = world(t);
  await pairWith(w.request(), w.identity(), w.host.issueCode());
  await assert.rejects(authenticate(w.request(), w.identity('stranger')), (e: any) => code(e) === 'unknown_client');
});

test('a challenge answers once and goes stale after 60 s; a signature for another purpose or key is refused (B1)', async (t) => {
  const w = world(t);
  const app = w.identity();
  await pairWith(w.request(), app, w.host.issueCode());
  const nonce = w.host.challenge();
  const good = { publicKey: app.publicKey, nonce, signature: app.sign('auth', w.host.hostId(), nonce) };
  w.host.verify(good);
  assert.throws(
    () => w.host.verify(good),
    (e: any) => code(e) === 'stale_challenge',
  );
  const old = w.host.challenge();
  w.advance(NONCE_TTL_MS);
  assert.throws(
    () => w.host.verify({ publicKey: app.publicKey, nonce: old, signature: app.sign('auth', w.host.hostId(), old) }),
    (e: any) => code(e) === 'stale_challenge',
  );
  const n2 = w.host.challenge();
  assert.throws(
    () => w.host.verify({ publicKey: app.publicKey, nonce: n2, signature: app.sign('pair', w.host.hostId(), n2) }),
    (e: any) => code(e) === 'bad_proof',
  );
  const n3 = w.host.challenge();
  assert.throws(
    () => w.host.verify({ publicKey: app.publicKey, nonce: n3, signature: w.identity('x').sign('auth', w.host.hostId(), n3) }),
    (e: any) => code(e) === 'bad_proof',
  );
  const n4 = w.host.challenge();
  assert.throws(
    () => w.host.verify({ publicKey: app.publicKey, nonce: n4, signature: 5 }),
    (e: any) => code(e) === 'bad_proof',
  );
  for (const bad of [undefined, 5, 'x', 'A'.repeat(300), Buffer.from('nope').toString('base64')]) {
    const n = w.host.challenge();
    assert.throws(
      () => w.host.claim({ code: 'x', publicKey: bad, nonce: n, signature: 'x' }),
      (e: any) => code(e) === 'bad_proof',
    );
  }
  // a key of another type is no client key
  const { publicKey } = (await import('node:crypto')).generateKeyPairSync('x25519');
  const n5 = w.host.challenge();
  assert.throws(
    () =>
      w.host.claim({
        code: 'x',
        publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
        nonce: n5,
        signature: 'x',
      }),
    PairingError,
  );
  assert.throws(
    () => w.host.claim({ code: 'x', publicKey: app.publicKey, nonce: 5, signature: 'x' }),
    (e: any) => code(e) === 'stale_challenge',
  );
});

test('an expired challenge is dropped when the next one is issued', (t) => {
  const w = world(t);
  const app = w.identity();
  const old = w.host.challenge();
  w.advance(NONCE_TTL_MS);
  w.host.challenge();
  assert.throws(
    () => w.host.verify({ publicKey: app.publicKey, nonce: old, signature: app.sign('auth', w.host.hostId(), old) }),
    (e: any) => code(e) === 'stale_challenge',
  );
});

test('a hundred challenges leave at most 64 open, the oldest first', (t) => {
  const w = world(t);
  const first = w.host.challenge();
  for (let i = 0; i < 100; i++) w.host.challenge();
  const app = w.identity();
  assert.throws(
    () => w.host.verify({ publicKey: app.publicKey, nonce: first, signature: app.sign('auth', w.host.hostId(), first) }),
    (e: any) => code(e) === 'stale_challenge',
  );
});

test('a pairing file that cannot be read fails closed instead of becoming an unpaired Host (W3)', (t) => {
  const w = world(t);
  w.host.issueCode();
  const file = path.join(w.dir, 'host/pairing.json');
  for (const junk of ['{nope', '[]', 'null', '{"clients":null}']) {
    fs.writeFileSync(file, junk);
    assert.throws(() => w.host.paired(), /cannot be read/);
    assert.throws(() => w.host.issueCode(), /cannot be read/);
  }
  fs.writeFileSync(file, JSON.stringify({ clients: {}, codeHash: 3, expires: 'x', wrong: 'y' }));
  assert.equal(w.host.paired(), 0);
});

test('the code is normalized the same way by the app and the Host', () => {
  assert.equal(normalizeCode(' ab-cd ef '), 'ABCDEF');
  assert.equal(appNormalize(' ab-cd ef '), 'ABCDEF');
  assert.equal(normalizeCode(7), '');
  assert.equal(appNormalize(null), '');
});

test('the app asks for a code before it contacts the Host, and its identity survives a restart (B1, W3)', async (t) => {
  const w = world(t);
  const calls: string[] = [];
  const app = w.identity();
  await assert.rejects(
    pairWith(async (m) => void calls.push(m), app, '  - '),
    /Enter the pairing code/,
  );
  assert.deepEqual(calls, []);
  assert.equal(w.identity().publicKey, app.publicKey, 'the same key is read back');
  const file = path.join(w.dir, 'app.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.writeFileSync(file, '{bad');
  assert.throws(() => loadIdentity(file, keySafe), /cannot be read.*copy was kept/);
  assert.equal(fs.readFileSync(`${file}.unreadable`, 'utf8'), '{bad');
  fs.rmSync(file);
  fs.writeFileSync(file, JSON.stringify({ publicKey: 1 }));
  assert.throws(() => loadIdentity(file, keySafe), /cannot be read/);
});

test('a served Host refuses chat methods until the connection pairs or authenticates, and reports the refusal code', async (t) => {
  const dir = tmp(t);
  const paths = createPaths({ dataDir: dir, env: {} });
  const pairing = createPairing({ configDir: paths.configDir });
  const runtime: any = { send: async (p: any) => ({ sent: p }), permit: (p: any) => p, turn: (id: any) => ({ turn: id }), close() {} };
  const server = await startServer({ paths, runtime, pairing });
  t.after(() => server.close());
  const app = loadIdentity(path.join(dir, 'app.json'), keySafe);
  const first = line(paths.socketPath);
  t.after(first.close);
  for (const m of ['send', 'permit', 'turn', 'fs.list', 'git.clone', 'git.worktree']) {
    const r = await first.call(m, {});
    assert.deepEqual([r.error, r.code], ['This client is not paired with the Host.', 'unknown_client']);
  }
  // a request that names nothing is refused as malformed, not by a crash
  assert.equal((await first.call('host.pair')).code, 'invalid');
  assert.equal((await first.call('host.auth')).code, 'invalid');
  assert.equal((await first.call('ping')).result, 'pong', 'ping and status stay open');
  assert.equal((await first.call('status')).result.running, true);
  // a wrong code is refused with its code; the right one pairs this connection
  await assert.rejects(pairWith(first.request, app, 'AAAA-AAAA-AAAA'), (e: any) => code(e) === 'no_code');
  const printed = pairing.issueCode();
  await assert.rejects(pairWith(first.request, app, 'AAAA-AAAA-AAAA'), (e: any) => code(e) === 'wrong_code');
  assert.equal((await first.call('send', {})).error, 'This client is not paired with the Host.');
  await pairWith(first.request, app, printed);
  assert.deepEqual((await first.call('send', { a: 1 })).result, { sent: { a: 1 } });
  assert.deepEqual((await first.call('permit', { b: 1 })).result, { b: 1 });
  assert.deepEqual((await first.call('turn', { turnId: 't' })).result, { turn: 't' });
  // a new connection starts unpaired; the paired app authenticates, a stranger cannot
  const second = line(paths.socketPath);
  t.after(second.close);
  assert.equal((await second.call('send', {})).code, 'unknown_client');
  await authenticate(second.request, app);
  assert.deepEqual((await second.call('send', { c: 1 })).result, { sent: { c: 1 } });
  const third = line(paths.socketPath);
  t.after(third.close);
  await assert.rejects(
    authenticate(third.request, loadIdentity(path.join(dir, 'stranger.json'), keySafe)),
    (e: any) => code(e) === 'unknown_client',
  );
  assert.equal((await third.call('send', {})).code, 'unknown_client');
  // a Host without pairing serves as before (no gate)
  const plain = createPaths({ dataDir: tmp(t), env: {} });
  const open = await startServer({ paths: plain, runtime });
  t.after(() => open.close());
  const c = line(plain.socketPath);
  t.after(c.close);
  assert.deepEqual((await c.call('send', { z: 1 })).result, { sent: { z: 1 } });
  assert.match((await c.call('host.challenge')).error, /Unknown method/);
});

test('serve prints a pairing code while no client is paired, and `pair` prints a fresh one', async (t) => {
  const dir = tmp(t);
  const out: string[] = [];
  const signals: any = new (await import('node:events')).EventEmitter();
  const io = { out: (l: string) => out.push(l), err: () => {}, env: {}, signals, pollMs: 1 };
  const served = main(['serve', '--data-dir', dir], io as any);
  await waitFor(() => out.some((l) => l.startsWith('Pairing code')), 'the pairing code');
  signals.emit('SIGTERM');
  assert.equal(await served, 0);
  assert.match(out.join('\n'), /Host serving on[\s\S]*Pairing code: [A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}/);
  // once a client is paired, a restart prints none
  const paths = createPaths({ dataDir: dir, env: {} });
  const pairing = createPairing({ configDir: paths.configDir });
  const printed = out.join('\n').match(/Pairing code: (\S+)/)![1];
  await pairWith(
    async (m, p) => (m === 'host.challenge' ? { nonce: pairing.challenge(), hostId: pairing.hostId() } : pairing.claim(p as any)),
    loadIdentity(path.join(dir, 'app.json'), keySafe),
    printed,
  );
  out.length = 0;
  const again = main(['serve', '--data-dir', dir], io as any);
  await waitFor(() => out.some((l) => l.startsWith('Host serving')), 'the serving line');
  signals.emit('SIGTERM');
  await again;
  assert.ok(!out.some((l) => l.startsWith('Pairing code')));
  // `pair` works whether or not a Host is paired, and each run replaces the last code
  const a: string[] = [];
  const b: string[] = [];
  assert.equal(await main(['pair', '--data-dir', dir], { ...io, out: (l: string) => a.push(l) } as any), 0);
  assert.equal(await main(['pair', '--data-dir', dir], { ...io, out: (l: string) => b.push(l) } as any), 0);
  assert.match(a[0], /^Pairing code: /);
  assert.notEqual(a[0], b[0]);
});

test('with the versioned protocol on, pairing is answered before its session, chat.* is refused until the connection pairs, and a protocol error keeps its code (A5)', async (t) => {
  const dir = tmp(t);
  const paths = createPaths({ dataDir: dir, env: {} });
  const pairing = createPairing({ configDir: paths.configDir });
  const seen: string[] = [];
  const protocol: any = {
    connection: () => ({
      call: async (method: string) => (seen.push(method), { via: 'session' }),
      close: () => undefined,
    }),
  };
  const server = await startServer({ paths, protocol, pairing });
  t.after(() => server.close());
  const app = loadIdentity(path.join(dir, 'app.json'), keySafe);
  const conn = line(paths.socketPath);
  t.after(conn.close);
  // hello is not gated; a chat request is, until pairing
  assert.deepEqual((await conn.call('host.hello', {})).result, { via: 'session' });
  for (const method of ['chat.send', 'chat.remove', 'chat.future-method']) {
    const refused = await conn.call(method, {});
    assert.deepEqual([refused.error, refused.code], ['This client is not paired with the Host.', 'unknown_client'], method);
  }
  assert.deepEqual(seen, ['host.hello'], 'a refused chat request never reached the session');
  // a wrong code is refused with its code through the protocol's error shape, and counts
  const printed = pairing.issueCode();
  await assert.rejects(pairWith(conn.request, app, 'AAAA-AAAA-AAAA'), (e: any) => code(e) === 'wrong_code');
  await pairWith(conn.request, app, printed);
  assert.deepEqual((await conn.call('chat.send', {})).result, { via: 'session' });
  assert.deepEqual(seen, ['host.hello', 'chat.send']);
  // a new connection proves its key with host.auth
  const again = line(paths.socketPath);
  t.after(again.close);
  assert.equal((await again.call('chat.send', {})).code, 'unknown_client');
  await authenticate(again.request, app);
  assert.deepEqual((await again.call('chat.send', {})).result, { via: 'session' });
});

test('L: a Host has a name of its own, kept; a proof made for another Host’s name is refused, so a Host cannot pass another one’s challenge through the app', async (t) => {
  const w = world(t);
  const other = world(t);
  const app = w.identity();
  const a = w.host.hostId();
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.equal(w.host.hostId(), a, 'the same every time');
  assert.equal(createPairing({ configDir: path.join(w.dir, 'host') }).hostId(), a, 'and after a restart');
  assert.equal(fs.statSync(path.join(w.dir, 'host', 'host-id')).mode & 0o777, 0o600);
  assert.notEqual(other.host.hostId(), a);
  // the app answers Host A's challenge as A, and B's as B: a proof for A's name does not open B
  const nonceB = other.host.challenge();
  assert.throws(
    () => other.host.verify({ publicKey: app.publicKey, nonce: nonceB, signature: app.sign('auth', a, nonceB) }),
    (e: any) => code(e) === 'bad_proof' || code(e) === 'unknown_client',
  );
  // a name that is not 32 hex digits is made again; a name that cannot be read is an error, not a new name
  fs.writeFileSync(path.join(w.dir, 'host', 'host-id'), 'nonsense');
  const again = createPairing({ configDir: path.join(w.dir, 'host') }).hostId();
  assert.match(again, /^[0-9a-f]{32}$/);
  assert.notEqual(again, a);
  const broken = path.join(w.dir, 'broken');
  fs.mkdirSync(path.join(broken, 'host-id'), { recursive: true });
  assert.throws(() => createPairing({ configDir: broken }).hostId(), { code: 'EISDIR' });
});

test('L: the app answers a challenge only from the Host it paired with, keeps the name it gave at pairing, and refuses a Host that names none', async (t) => {
  const w = world(t);
  const app = w.identity();
  const printed = w.host.issueCode();
  const request = w.request();
  // pairing hands back the Host's name, for the app to keep
  const paired = await pairWith(request, app, printed);
  assert.equal(paired.hostId, w.host.hostId());
  const kept: string[] = [];
  // the Host it paired with
  await authenticate(request, { ...app, pin: { expected: paired.hostId, keep: (k: string) => kept.push(k) } });
  assert.equal(kept.length, 0, 'nothing new to keep');
  // another Host answering for it, though it holds a name and a nonce of its own: nothing is signed
  const imposter = world(t);
  await assert.rejects(
    authenticate(imposter.request(), { ...app, pin: { expected: paired.hostId } }),
    (e: any) => e.code === 'invalid' && /not the machine this app paired with/.test(e.message),
  );
  // no name kept yet (paired before names existed): the Host's is kept
  await authenticate(request, { ...app, pin: { keep: (k: string) => kept.push(k) } });
  assert.deepEqual(kept, [paired.hostId]);
  await authenticate(request, app);
  // an older Host names none, and a proof for it could be passed to any other Host: it is not answered
  for (const c of [{ nonce: 'n' }, { nonce: 'n', hostId: 'short' }, { hostId: 'ab'.repeat(16) }, null]) {
    await assert.rejects(
      pairWith(async () => c, app, printed),
      { code: 'invalid' },
    );
    await assert.rejects(
      authenticate(async () => c, app),
      { code: 'invalid' },
    );
  }
});

test('L: the CLI’s token opens what the line protocol keeps for a paired client, and nothing else does', async (t) => {
  const dir = tmp(t);
  const paths = createPaths({ dataDir: dir, env: {} });
  const pairing = createPairing({ configDir: paths.configDir });
  const updater: any = { request: () => 'requested', restarting: false, isIdle: () => true };
  const login: any = {
    start: () => ({ started: true }),
    status: () => ({ s: 1 }),
    input: () => true,
    cancel: () => true,
  };
  const dirs: any = {
    hostFs: {},
    hostRead: { status: async () => ({ isRepo: false }), diff: async () => ({ isRepo: false }) },
    hostFiles: { tree: async () => ({ entries: [] }), read: async () => ({ kind: 'text' }) },
    hostGit: {
      inspect: async () => ({ isRepo: false }),
      carryPlan: async () => ({ plan: 1 }),
      carryPush: async () => ({ push: 1 }),
      carryApply: async () => ({ apply: 1 }),
      carryDrop: async () => ({ drop: 1 }),
    },
  };
  const server = await startServer({ paths, pairing, updater, login, dirs });
  t.after(() => server.close());
  assert.equal(fs.statSync(`${paths.socketPath}.token`).mode & 0o777, 0o600);
  const stranger = line(paths.socketPath);
  t.after(stranger.close);
  const open = [
    'update',
    'login',
    'loginStatus',
    'loginInput',
    'loginCancel',
    'git.inspect',
    'git.status',
    'git.diff',
    'fs.tree',
    'fs.read',
    'fs.search',
    'git.carryPlan',
    'git.carryPush',
    'git.carryApply',
    'git.carryDrop',
  ];
  const params: any = {
    path: '/p',
    harness: 'h',
    text: 't',
    key: 'key-12345678',
    branch: 'mopilot/carry/abcdefgh',
    commit: 'a'.repeat(40),
    parent: 'a'.repeat(40),
  };
  for (const m of open) assert.equal((await stranger.call(m, params)).code, 'unknown_client', m);
  assert.equal((await stranger.call('ping')).result, 'pong');
  // the token beside the socket: the CLI's calls are answered
  assert.equal((await callHost(paths.socketPath, 'update'))?.result, 'requested');
  // whether a turn runs is not a secret of the pairing: the app asks before it updates or removes the machine
  assert.deepEqual((await stranger.call('idle')).result, { idle: true });
  assert.equal(
    (await callHost(paths.socketPath, 'update', undefined, { anonymous: true }))?.error,
    'This client is not paired with the Host.',
  );
  assert.deepEqual((await callHost(paths.socketPath, 'login', { harness: 'h' }))?.result, { started: true });
  assert.deepEqual((await callHost(paths.socketPath, 'git.inspect', { path: '/p' }))?.error, undefined);
  // a wrong token opens nothing, and neither does one of another length
  for (const token of ['wrong', 'x'.repeat(64), 7]) {
    const r = await new Promise<any>((resolve) => {
      const s = net.connect(paths.socketPath, () => s.write(`${JSON.stringify({ id: 1, method: 'update', token })}\n`));
      s.setEncoding('utf8').on('data', (d) => (s.end(), resolve(JSON.parse(String(d)))));
    });
    assert.equal(r.code, 'unknown_client');
  }
  // a Host that is gone takes its token with it
  await server.close();
  assert.equal(fs.existsSync(`${paths.socketPath}.token`), false);
  assert.equal(await callHost(paths.socketPath, 'update'), null);
});
