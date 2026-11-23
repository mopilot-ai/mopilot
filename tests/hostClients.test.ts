// The Host's client table (host/src/pairing.mjs, hostClients.mjs, server.mjs, shared/host/clients.mjs): names and kinds in `pairing.json`, both file forms read, `host.clients*`, and a removed client cut off at once (A3, W1, W3, B3, I1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
// @ts-ignore: plain ESM without declarations
import { createPairing } from '../host/src/pairing.mjs';
// @ts-ignore
import { checkedPairing, clientOf } from '../host/src/trustState.mjs';
// @ts-ignore
import { parseParams, requireFeatures, negotiate, helloParams } from '../shared/host/schema.mjs';
// @ts-ignore
import { clientListOf, clientNameOf } from '../shared/host/clients.mjs';
import { servedHost, tmpDir } from './support/hostClientsWorld.ts';
import { keySafe } from './support/hostKeySafe.ts';
const require = createRequire(import.meta.url);
const { loadIdentity } = require('../electron/host/pairingClient.cjs');

const fileOf = (dir: string) => path.join(dir, 'config', 'pairing.json');

test('a client record keeps its name and kind; the old string form is read as a desktop with no name', () => {
  assert.deepEqual(clientOf('KEY'), {
    key: 'KEY',
    name: '',
    kind: 'desktop',
    addedAt: 0,
    addedBy: 'code',
  });
  // a kind this Host does not know is never promoted to an update key
  assert.equal(clientOf({ key: 'K', kind: 'robot' }).kind, 'phone');
  assert.deepEqual(clientOf({ key: 'K', name: 'a', kind: 'cli', addedAt: 5, addedBy: 'f' }), {
    key: 'K',
    name: 'a',
    kind: 'cli',
    addedAt: 5,
    addedBy: 'f',
  });
  assert.equal(clientOf({ key: 'K', addedAt: 'x', addedBy: 3 }).addedAt, 0);
  for (const bad of [null, 7, [], {}, { key: 3 }]) assert.throws(() => clientOf(bad), /shape/);
  const mixed = checkedPairing({
    clients: { a: 'KEYA', b: { key: 'KEYB', name: 'B', kind: 'phone' } },
  });
  assert.equal(mixed.clients.a.kind, 'desktop');
  assert.equal(mixed.clients.b.name, 'B');
});

test('I1: names with delimiters and control bytes are stored structurally and cleaned', (t) => {
  const dir = tmpDir(t);
  const pairing = createPairing({ configDir: path.join(dir, 'config') });
  const id = loadIdentity(path.join(dir, 'a.json'), keySafe);
  const nasty = 'Mac"}, "kind": "desktop\n\u0000‮\t' + 'x'.repeat(200);
  const fp = pairing.add(id.publicKey, { name: nasty, kind: 'phone' });
  const raw = JSON.parse(fs.readFileSync(fileOf(dir), 'utf8'));
  assert.equal(raw.clients[fp].kind, 'phone', 'a name cannot change the kind');
  assert.ok(raw.clients[fp].name.length <= 80);
  assert.doesNotMatch(raw.clients[fp].name, /[\u0000-\u001f]/);
  assert.equal(clientNameOf(7), '');
  assert.equal(pairing.list()[0].name, raw.clients[fp].name);
});

test('add is one record per key; rename and remove report whether a client was there', (t) => {
  const dir = tmpDir(t);
  let clock = 10;
  const pairing = createPairing({
    configDir: path.join(dir, 'config'),
    now: () => clock,
  });
  const id = loadIdentity(path.join(dir, 'a.json'), keySafe);
  const fp = pairing.add(id.publicKey, {
    name: 'First',
    kind: 'phone',
    addedBy: 'x',
  });
  clock = 20;
  assert.equal(pairing.add(id.publicKey, { name: 'Second', kind: 'desktop' }), fp);
  assert.deepEqual(pairing.list(), [
    {
      fingerprint: fp,
      name: 'First',
      kind: 'phone',
      addedAt: 10,
      addedBy: 'x',
    },
  ]);
  assert.deepEqual(pairing.principal(fp), {
    fingerprint: fp,
    name: 'First',
    kind: 'phone',
  });
  assert.equal(pairing.principal('nope'), null);
  assert.equal(pairing.rename(fp, 'Renamed'), true);
  assert.equal(pairing.rename('nope', 'x'), false);
  assert.equal(pairing.stillKnows(fp), true);
  assert.equal(pairing.remove(fp), true);
  assert.equal(pairing.remove(fp), false);
  assert.equal(pairing.stillKnows(fp), false);
  // the default record is a desktop added by the code
  assert.deepEqual(
    [pairing.add(id.publicKey, {})].map(() => pairing.list()[0]).map(({ kind, addedBy, name }) => ({ kind, addedBy, name })),
    [{ kind: 'desktop', addedBy: 'code', name: '' }],
  );
});

test('W1: two writers adding clients at once both survive (the trust lock serializes them)', (t) => {
  const dir = tmpDir(t);
  const cfg = path.join(dir, 'config');
  const a = createPairing({ configDir: cfg });
  const b = createPairing({ configDir: cfg });
  const one = a.add(loadIdentity(path.join(dir, '1.json'), keySafe).publicKey, {
    name: 'one',
  });
  const two = b.add(loadIdentity(path.join(dir, '2.json'), keySafe).publicKey, {
    name: 'two',
  });
  assert.deepEqual(
    a
      .list()
      .map((c: any) => c.fingerprint)
      .sort(),
    [one, two].sort(),
  );
});

test('W3: a corrupt trust file is an error, never an empty table, and the last good copy is kept', (t) => {
  const dir = tmpDir(t);
  const pairing = createPairing({ configDir: path.join(dir, 'config') });
  pairing.add(loadIdentity(path.join(dir, '1.json'), keySafe).publicKey, {
    name: 'one',
  });
  const good = fs.readFileSync(fileOf(dir), 'utf8');
  fs.writeFileSync(fileOf(dir), '{"clients":{"x":42}}');
  assert.throws(() => pairing.list(), /cannot be read/);
  assert.throws(() => pairing.remove('x'), /cannot be read/);
  assert.equal(pairing.stillKnows('x'), false, 'a file that cannot be read trusts no one');
  fs.writeFileSync(fileOf(dir), good);
  assert.equal(pairing.list().length, 1);
});

test('B3: an older Host reads the new file and still authenticates a known key', (t) => {
  const dir = tmpDir(t);
  const pairing = createPairing({ configDir: path.join(dir, 'config') });
  const fp = pairing.add(loadIdentity(path.join(dir, '1.json'), keySafe).publicKey, {
    name: 'one',
    kind: 'phone',
  });
  // what the Host before this change did: only whether the fingerprint is present
  const old = JSON.parse(fs.readFileSync(fileOf(dir), 'utf8'));
  assert.equal(Object.hasOwn(old.clients, fp), true);
  assert.equal(typeof old.clients[fp], 'object');
});

test('the four methods are parsed, and gated on the `clients` feature', () => {
  assert.deepEqual(parseParams('host.clients', {}), {});
  assert.deepEqual(parseParams('host.clientAdd', { publicKey: 'K', kind: 'phone', name: 'P' }), {
    publicKey: 'K',
    kind: 'phone',
    name: 'P',
  });
  assert.throws(() => parseParams('host.clientAdd', { publicKey: '', kind: 'phone' }), /publicKey/);
  assert.throws(() => parseParams('host.clientAdd', { publicKey: 'K', kind: 'robot' }), /kind/);
  assert.deepEqual(parseParams('host.clientRemove', { fingerprint: 'a'.repeat(64) }), { fingerprint: 'a'.repeat(64) });
  assert.throws(() => parseParams('host.clientRemove', { fingerprint: 'zz' }), /fingerprint/);
  assert.deepEqual(parseParams('host.clientRename', { name: ' Me\n' }), {
    name: 'Me',
  });
  assert.throws(() => parseParams('host.clientRename', { name: 3 }), /not text/);
  assert.deepEqual(
    parseParams('host.pair', {
      publicKey: 'K',
      nonce: 'n',
      signature: 's',
      code: 'c',
      name: 'Mac',
    }).name,
    'Mac',
  );
  assert.equal(
    'name' in
      parseParams('host.pair', {
        publicKey: 'K',
        nonce: 'n',
        signature: 's',
        code: 'c',
      }),
    false,
  );
  assert.throws(
    () =>
      parseParams('host.pair', {
        publicKey: 'K',
        nonce: 'n',
        signature: 's',
        code: 'c',
        name: 3,
      }),
    /not text/,
  );
  const without = negotiate(helloParams(), {
    protocol: helloParams().protocol,
    features: ['epoch'],
  });
  assert.throws(
    () => requireFeatures('host.clients', without),
    (e: any) => e.missing.includes('clients'),
  );
  assert.deepEqual(
    clientListOf({
      clients: [
        {
          fingerprint: 'a'.repeat(64),
          kind: 'phone',
          name: 'P',
          addedAt: 1,
          addedBy: 'code',
          connected: true,
        },
        { kind: 'x' },
        null,
      ],
    }),
    [
      {
        fingerprint: 'a'.repeat(64),
        name: 'P',
        kind: 'phone',
        addedAt: 1,
        addedBy: 'code',
        connected: true,
      },
    ],
  );
  assert.deepEqual(clientListOf({ clients: [{ fingerprint: 'b'.repeat(64), kind: 'cli' }] }), [
    {
      fingerprint: 'b'.repeat(64),
      name: '',
      kind: 'cli',
      addedAt: 0,
      addedBy: '',
      connected: false,
    },
  ]);
  assert.deepEqual(clientListOf(null), []);
});

test('Done when: host.clients lists the Mac by its name; a second client removed from the first can no longer send', async (t) => {
  const w = await servedHost(t);
  const first = await w.paired('mac', 'Work MacBook Pro');
  const second = await w.paired('mac2', 'Second Mac');
  const list = (await first.conn.request('host.clients')).clients;
  assert.deepEqual(
    list.map((c: any) => [c.name, c.kind, c.addedBy, c.connected]),
    [
      ['Work MacBook Pro', 'desktop', 'code', true],
      ['Second Mac', 'desktop', 'code', true],
    ],
  );
  const secondFp = list[1].fingerprint;
  const send = (conn: any, n: number) =>
    conn.request('chat.send', {
      chatId: 'claude:c1',
      epoch: 1,
      key: `key-${String(n).padStart(8, '0')}`,
      text: 'hi',
    });
  await send(second.conn, 1);
  assert.deepEqual(await first.conn.request('host.clientRemove', { fingerprint: secondFp }), { removed: true });
  await second.conn.closed;
  // it cannot come back with the key it had
  await assert.rejects(w.reconnect(second.id), (e: any) => e.code === 'unknown_client');
  assert.equal((await first.conn.request('host.clients')).clients.length, 1);
  assert.deepEqual(await first.conn.request('host.clientRemove', { fingerprint: secondFp }), { removed: false });
  assert.equal(w.sends.length, 1);
});

test('A3: a client removed by another path (the CLI, a signed update) is cut off on its next request, unanswered', async (t) => {
  const w = await servedHost(t);
  const keep = await w.paired('mac', 'Mac');
  const gone = await w.paired('mac2', 'Other');
  const fp = (await keep.conn.request('host.clients')).clients[1].fingerprint;
  assert.equal(w.pairing.remove(fp), true);
  const reply = gone.conn.call('chat.send', {
    chatId: 'claude:c1',
    epoch: 1,
    key: 'key-00000001',
    text: 'late',
  });
  await gone.conn.closed;
  void reply;
  assert.equal(w.sends.length, 0, 'nothing a removed client sent after its removal ran');
  // the Mac that stayed is served
  assert.equal((await keep.conn.request('host.clients')).clients.length, 1);
});

test('A4: a client removed by another path stops receiving what the Host pushes, though it never asks for anything again', async (t) => {
  const w = await servedHost(t);
  const keep = await w.paired('mac', 'Mac');
  const gone = await w.paired('mac2', 'Other');
  const fp = (await keep.conn.request('host.clients')).clients[1].fingerprint;
  await gone.conn.request('chat.subscribe', { chatId: 'claude:c1', epoch: 1 });
  let n = 0;
  // another client's message is pushed to every subscriber of the chat
  const push = () =>
    keep.conn.request('chat.send', { chatId: 'claude:c1', epoch: 1, key: `push-key-${String(++n).padStart(8, '0')}`, text: 'hi' });
  await push();
  assert.equal(w.pairing.remove(fp), true);
  // inside the second the trust it was just seen to have is believed; after it, the next push closes the connection
  await push();
  await new Promise((r) => setTimeout(r, 1100));
  await push();
  await gone.conn.closed;
  assert.equal((await keep.conn.request('host.clients')).clients.length, 1, 'the client that stayed is served');
});

test('the app tells a Host this Mac’s name once per run, only when the Host keeps a client table, and never fails a session over it', async () => {
  const { introduce, deviceName, pairWith } = require('../electron/host/pairingClient.cjs');
  const calls: [string, any][] = [];
  const session = (features: string[], fail = false) => ({
    call: async (method: string, params?: any) => {
      calls.push([method, params]);
      if (fail) throw new Error('boom');
      return method === 'host.hello' ? { ...helloParams(), features, agreed: { minor: 1, features } } : {};
    },
  });
  const modern = session(helloParams().features);
  assert.equal(await introduce('m1', modern), modern);
  assert.deepEqual(
    calls.map((c) => c[0]),
    ['host.hello', 'host.clientRename'],
  );
  assert.deepEqual(calls[1][1], { name: deviceName() });
  assert.ok(deviceName().length > 0 && !deviceName().endsWith('.local'));
  // once per run
  await introduce('m1', modern);
  assert.equal(calls.length, 2);
  // an older Host (no `clients` feature) and a refusing one are left alone
  const older = session(['epoch']);
  assert.equal(await introduce('m2', older), older);
  assert.equal(calls.filter((c) => c[0] === 'host.clientRename').length, 1);
  const refusing = session([], true);
  assert.equal(await introduce('m3', refusing), refusing);
  // the name goes with the pairing proof, and a caller may choose it
  const sent: any[] = [];
  const identity = { publicKey: 'K', sign: () => 'S' };
  const request = async (method: string, params?: any) => {
    sent.push([method, params]);
    return method === 'host.challenge' ? { nonce: 'n', hostId: 'a'.repeat(32) } : { fingerprint: 'f' };
  };
  await pairWith(request, identity, 'AAAA-BBBB-CCCC', 'Work MacBook Pro');
  await pairWith(request, identity, 'AAAA-BBBB-CCCC', '');
  const pairs = sent.filter((c) => c[0] === 'host.pair').map((c) => c[1].name);
  assert.deepEqual(pairs, ['Work MacBook Pro', undefined]);
});

test('pairing again with a key the Host already has keeps its kind and keeps or replaces its name', async (t) => {
  const w = await servedHost(t);
  const id = w.identity('phone');
  w.pairing.add(id.publicKey, { name: 'Pocket', kind: 'phone' });
  const conn = w.line();
  t.after(conn.close);
  const { pairWith } = require('../electron/host/pairingClient.cjs');
  const kept = await pairWith(conn.request, id, w.pairing.issueCode(), '');
  assert.deepEqual([kept.kind, kept.name], ['phone', 'Pocket']);
  const renamed = await pairWith(w.line().request, id, w.pairing.issueCode(), 'New name');
  assert.deepEqual([renamed.kind, renamed.name], ['phone', 'New name']);
  // a new client that gives no name is listed with none
  const nameless = await pairWith(w.line().request, w.identity('nameless'), w.pairing.issueCode(), '');
  assert.deepEqual([nameless.kind, nameless.name], ['desktop', '']);
});
