// The principal of a connection (host/src/server.mjs, protocol.mjs, hostClients.mjs): fixed at pairing or auth, the CLI's own, recorded as `by` on the ledger line, the user's message and a card's answer, and the rules of who may add, remove and rename a client.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createJournalFaults } from '../host/src/journalFaults.mjs';
// @ts-ignore
import { createChatEffects } from '../host/src/chatEffects.mjs';
// @ts-ignore
import { createLedger } from '../host/src/ledger.mjs';
// @ts-ignore
import { helloParams } from '../shared/host/schema.mjs';
import { line } from './support/host-line.ts';
import { servedHost, tmpDir } from './support/hostClientsWorld.ts';

const send = (n: number, extra = {}) => ({
  chatId: 'claude:c1',
  epoch: 1,
  key: `key-${String(n).padStart(8, '0')}`,
  text: 'hi',
  ...extra,
});

test('the principal the server fixed rides on the ledger line, the user item on the stream and the connection that sent them', async (t) => {
  const w = await servedHost(t);
  const out: any[] = [];
  const by = {
    fingerprint: 'f'.repeat(64),
    name: 'Work MacBook Pro',
    kind: 'desktop' as const,
  };
  const conn = w.protocol.connection(
    (m: object) => out.push(m),
    () => null,
    { principal: () => by },
  );
  await conn.call('host.hello', helloParams());
  await conn.call('chat.subscribe', { chatId: 'claude:c1', epoch: 1 });
  await conn.call('chat.send', send(1));
  assert.ok(
    JSON.stringify(out).includes('"by":{"fingerprint":"' + by.fingerprint + '","name":"Work MacBook Pro","kind":"desktop"}'),
    'the user item names who sent it',
  );
  const entries = fs
    .readdirSync(w.ledgerDir)
    .flatMap((f) => fs.readFileSync(path.join(w.ledgerDir, f), 'utf8').trim().split('\n'))
    .map((l) => JSON.parse(l));
  assert.deepEqual(
    entries.map((e) => [e.state, e.by]),
    [
      ['started', by],
      ['completed', by],
    ],
  );
  // a connection with no principal (an embedder with no pairing) is served as it was
  const plain = w.protocol.connection(() => undefined);
  await plain.call('host.hello', helloParams());
  await plain.call('chat.send', send(2, { chatId: 'claude:c2' }));
  await assert.rejects(plain.call('host.clients', {}), (e: any) => e.code === 'unsupported');
});

test('a failed request is on the ledger with who sent it', async (t) => {
  const dir = tmpDir(t);
  const ledger = createLedger(dir, { report: () => undefined });
  const by = { fingerprint: 'f', name: 'n', kind: 'phone' };
  await assert.rejects(
    ledger.once({ chatId: 'c', key: 'k', method: 'm', by }, () => Promise.reject(new Error('no'))),
    /no/,
  );
  const lines = fs
    .readFileSync(path.join(dir, fs.readdirSync(dir)[0]), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.deepEqual(
    lines.map((l) => [l.state, l.by.name]),
    [
      ['started', 'n'],
      ['failed', 'n'],
    ],
  );
  // a request without a principal (a scheduled run) is recorded as it always was
  await ledger.once({ chatId: 'c', key: 'k2', method: 'm' }, () => 1);
  assert.equal(
    JSON.parse(
      fs
        .readFileSync(path.join(dir, fs.readdirSync(dir)[0]), 'utf8')
        .trim()
        .split('\n')
        .pop()!,
    ).by,
    undefined,
  );
});

test('the user item and a card answer carry `by`; without a principal they are as they were', async () => {
  const items: any[] = [];
  const records: any[] = [];
  const runtime: any = {
    send: async () => ({ turnId: 't1' }),
    permit: () => true,
    host: { cancel: async () => undefined },
  };
  const faults = createJournalFaults({
    hub: { fail() {}, clear() {} } as any,
    cancel: () => undefined,
    report: () => undefined,
  });
  const effects = createChatEffects({
    runtime,
    finish: (_: string, item: any) => items.push(item),
    record: (_: string, e: any) => records.push(e),
    endedTurns: new Set(),
    check: () => undefined,
    faults,
    approvals: {
      resume: () => null,
      stopped: () => undefined,
      claim: (p: any) => ({ by: p.by }),
      answeredEvent: (_: unknown, e: any) => e,
      answered: () => undefined,
      unclaim: () => undefined,
    },
    handoffs: undefined,
    images: undefined,
    tools: undefined,
  } as any);
  const by = { fingerprint: 'f', name: 'Pocket iPhone', kind: 'phone' };
  await effects['chat.send']({ ...send(1), by });
  await effects['chat.send'](send(2));
  assert.deepEqual(
    items.map((i) => i.by),
    [by, undefined],
  );
  await effects['chat.answer']({
    chatId: 'claude:c1',
    requestId: 'r1',
    optionId: 'o',
    by,
  });
  await effects['chat.answer']({
    chatId: 'claude:c1',
    requestId: 'r2',
    optionId: 'o',
  });
  assert.deepEqual(
    records.map((r) => [r.requestId, r.by?.name]),
    [
      ['r1', 'Pocket iPhone'],
      ['r2', undefined],
    ],
  );
});

test('the CLI acts as `local-cli`; a phone manages only itself; a desktop manages any client', async (t) => {
  const w = await servedHost(t);
  const token = fs.readFileSync(`${w.paths.socketPath}.token`, 'utf8');
  const cli = line(w.paths.socketPath, token);
  t.after(cli.close);
  await cli.request('host.hello', helloParams());
  const phoneKey = w.identity('phone');
  const desk = await w.paired('mac', 'Mac');
  const { fingerprint } = await cli.request('host.clientAdd', {
    publicKey: phoneKey.publicKey,
    kind: 'phone',
    name: 'Pocket iPhone',
  });
  const listed = (await cli.request('host.clients')).clients;
  const phoneRow = listed.find((c: any) => c.fingerprint === fingerprint);
  assert.deepEqual([phoneRow.name, phoneRow.kind, phoneRow.addedBy, phoneRow.connected], ['Pocket iPhone', 'phone', 'local-cli', false]);
  assert.deepEqual(await cli.request('host.clientRename', { name: 'x' }), { renamed: false }, 'the CLI has no record to rename');
  // the phone: connects, renames itself, may not add or remove another
  const phone = await w.reconnect(phoneKey);
  assert.equal((await phone.request('host.clients')).clients.find((c: any) => c.fingerprint === fingerprint).connected, true);
  assert.deepEqual(await phone.request('host.clientRename', { name: 'Pocket' }), { renamed: true });
  await assert.rejects(
    phone.request('host.clientAdd', {
      publicKey: w.identity('x').publicKey,
      kind: 'phone',
    }),
    (e: any) => e.code === 'forbidden',
  );
  const macFp = listed.find((c: any) => c.name === 'Mac').fingerprint;
  await assert.rejects(phone.request('host.clientRemove', { fingerprint: macFp }), (e: any) => e.code === 'forbidden');
  // a desktop adds a client, which is recorded as added by it
  const added = await desk.conn.request('host.clientAdd', {
    publicKey: w.identity('y').publicKey,
    kind: 'phone',
    name: 'Other',
  });
  const row = (await desk.conn.request('host.clients')).clients.find((c: any) => c.fingerprint === added.fingerprint);
  assert.equal(row.addedBy, listed.find((c: any) => c.name === 'Mac').fingerprint);
  // the phone removes itself and is cut off after it hears the answer
  assert.deepEqual(await phone.request('host.clientRemove', { fingerprint }), {
    removed: true,
  });
  await phone.closed;
  // a stranger is refused the table
  const stranger = w.line();
  t.after(stranger.close);
  assert.equal((await stranger.call('host.clients')).code, 'unknown_client');
});

test('a client-table request that reaches the handler table, with no connection standing, is refused', async () => {
  // @ts-ignore: plain ESM without declarations
  const { default: made } = await import('../host/src/methods/clients.mjs');
  const { handlers } = made();
  assert.deepEqual(Object.keys(handlers).sort(), ['host.clientAdd', 'host.clientRemove', 'host.clientRename', 'host.clients']);
  for (const run of Object.values<any>(handlers))
    assert.throws(
      () => run({}),
      (e: any) => e.code === 'unsupported',
    );
});
