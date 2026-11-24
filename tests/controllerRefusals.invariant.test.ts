// What a `controller` (a Mac paired by a code, R2b of #5576) may ask the Host: every wire and line method is decided (allowed or denied), derived from the parsers and from server.mjs so a new method cannot be added without deciding it; anything not allowed is refused at run time, on a served Host too; a controller answers its chats' approvals as a desktop does (the owner's decision); it sees every chat but MoMo's and names only its own; it cannot add a client or replace the policy; the token does not upgrade a paired connection. This is a guard-rail and an audit trail, not a boundary (host/src/controllerRefusals.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
// @ts-ignore: plain ESM without declarations
import { PARSERS, helloParams } from '../shared/host/schema.mjs';
// @ts-ignore
import {
  CONTROLLER_ALLOWED,
  CONTROLLER_DENIED,
  UNKNOWN_ALLOWED,
  controllerAllows,
  kindAllows,
  refuseByKind,
} from '../host/src/controllerRefusals.mjs';
// @ts-ignore
import { chatScopeOf } from '../host/src/chatScope.mjs';
// @ts-ignore
import { isOwner } from '../host/src/momoOwner.mjs';
// @ts-ignore
import { createPolicy } from '../host/src/policy.mjs';
// @ts-ignore
import { ADDABLE_KINDS, CLIENT_KINDS, clientListOf, clientParsers } from '../shared/host/clients.mjs';
// @ts-ignore
import { ceilingFor } from '../shared/host/policy.mjs';
import { servedHost } from './support/hostClientsWorld.ts';

export const GUARDS = ['host/src/', 'shared/host/'];

/** The line protocol's methods, read from the server itself: every `req.method === '…'` and the paired-only set. */
function lineMethods() {
  const text = fs.readFileSync(new URL('../host/src/server.mjs', import.meta.url), 'utf8');
  const set = /const PAIRED_ONLY = new Set\(\[([\s\S]*?)\]\);/.exec(text)?.[1] ?? '';
  return [...text.matchAll(/req\.method === '([\w.]+)'/g), ...set.matchAll(/'([\w.]+)'/g)].map((m) => m[1]);
}

test('every wire and line method is decided for a controller: allowed on purpose or denied, none both', () => {
  const all = [...new Set([...Object.keys(PARSERS), ...lineMethods()])];
  assert.ok(all.length > 100 && all.includes('update') && all.includes('chat.permit'), 'the derivation finds the methods');
  // MoMo's `host.momo*` family is denied whole (it is veiled to anything but an owner's desktop or phone)
  const undecided = all.filter((m) => !CONTROLLER_ALLOWED.includes(m) && !CONTROLLER_DENIED.includes(m) && !m.startsWith('host.momo'));
  assert.deepEqual(undecided, [], 'decide these for a controller: add each to CONTROLLER_ALLOWED or CONTROLLER_DENIED');
  assert.deepEqual(
    CONTROLLER_ALLOWED.filter((m: string) => CONTROLLER_DENIED.includes(m)),
    [],
  );
  for (const m of [...CONTROLLER_ALLOWED, ...CONTROLLER_DENIED]) assert.ok(all.includes(m), `${m} is not a method`);
});

test('anything not allowed is refused: a denied method, a method nobody decided, and the MoMo and code-pair families', () => {
  for (const m of ['host.modelKey', 'host.momoFuture', 'host.codePair.offer', 'host.somethingNew', '']) {
    assert.throws(() => refuseByKind({ kind: 'controller' }, m), { code: 'forbidden' }, m);
  }
  assert.doesNotThrow(() => refuseByKind({ kind: 'controller' }, 'chat.send'));
  assert.doesNotThrow(() => refuseByKind({}, 'host.modelKey'), "a principal that names no kind is a desktop's, as the rule gate reads it");
  assert.throws(() => refuseByKind({ kind: 'unknown' }, 'host.modelKey'), { code: 'forbidden' });
  for (const kind of ['desktop', 'phone', 'cli', undefined])
    assert.doesNotThrow(() => refuseByKind(kind ? { kind } : null, 'host.modelKey'));
});

test("a controller answers its chats' approval cards and sets their permission mode as a desktop does (the owner's decision)", () => {
  for (const m of ['chat.answer', 'chat.permit', 'permit']) {
    assert.equal(controllerAllows(m), true, m);
    assert.doesNotThrow(() => refuseByKind({ kind: 'controller' }, m));
  }
});

test('a controller sees every chat the veil leaves, names only its own devices, and is no owner of MoMo', () => {
  const veil = () => (id: string) => id !== 'momo:1';
  const scope = chatScopeOf(veil)({ principal: () => ({ kind: 'controller', fingerprint: 'fp' }) });
  assert.equal(scope.sees('claude:a', { byFp: 'other' }), true);
  assert.equal(scope.sees('momo:1', { byFp: 'fp' }), false, 'MoMo stays veiled');
  assert.equal(scope.names({ byFp: 'other' }), false);
  assert.equal(scope.names({ byFp: 'fp' }), true);
  assert.equal(isOwner({ kind: 'controller' }), false);
});

test('a controller cannot be added by a request, is listed when a Host holds one, and cannot replace the policy', () => {
  assert.ok(CLIENT_KINDS.includes('controller'));
  assert.ok(!ADDABLE_KINDS.includes('controller'));
  assert.throws(() => clientParsers()['host.clientAdd']({ publicKey: 'K', kind: 'controller' }), /kind/);
  const fp = 'a'.repeat(64);
  assert.equal(clientListOf({ clients: [{ fingerprint: fp, name: 'Mac', kind: 'controller' }] })[0].kind, 'controller');
  const policy = createPolicy({ dir: '/nonexistent', audit: { note: () => undefined, governed: () => undefined } } as any);
  for (const kind of ['controller', 'phone']) assert.throws(() => policy.replace({ doc: {} }, kind), { code: 'policy_refused' });
});

test("the permission ceiling is whole for a desktop, the CLI and a controller, by name; a phone and any kind added later get the phone's lower one", () => {
  for (const kind of ['desktop', 'cli', 'controller']) assert.equal(ceilingFor('full-access', kind), 'full-access', kind);
  for (const kind of ['phone', 'someday', '', undefined])
    assert.equal(ceilingFor('full-access', kind as string), 'auto-review', String(kind));
  assert.equal(ceilingFor('default', 'controller'), 'default', "a lower ceiling (the owner's policy) stays lower");
});

test('a served Host refuses a controller the Host settings on both protocols, and serves its chat requests and its own record', async (t) => {
  const w = await servedHost(t);
  const id = w.identity('ctl');
  w.pairing.add(id.publicKey, { name: 'Other Mac', kind: 'controller' });
  const conn = await w.reconnect(id);
  for (const [method, params] of [
    ['host.clients', {}],
    ['host.modelKey', {}],
    ['host.policy', {}],
    ['host.momoStatus', {}],
    ['host.somethingNew', {}],
    ['update', {}],
    ['login', {}],
  ] as const) {
    assert.equal((await conn.call(method, params)).code, 'forbidden', method);
  }
  assert.equal((await conn.call('host.clientRename', { name: 'Renamed' })).result.renamed, true);
  assert.equal((await conn.call('chat.send', { chatId: 'claude:c1', epoch: 1, key: 'key-00000001', text: 'hi' })).error, undefined);
  assert.equal(w.sends.length, 1);
});

test("a connection that proved a paired client's key is not upgraded to the CLI by the token, and a new connection with the token is the CLI", async (t) => {
  const w = await servedHost(t);
  const token = fs.readFileSync(`${w.paths.socketPath}.token`, 'utf8');
  for (const kind of ['controller', 'phone'] as const) {
    const id = w.identity(kind);
    w.pairing.add(id.publicKey, { name: kind, kind });
    const conn = await w.reconnect(id);
    assert.equal((await conn.call('host.clients', {}, token)).code, 'forbidden', kind);
  }
  const cli = w.line();
  await cli.call('host.hello', helloParams(), token);
  assert.equal(Array.isArray((await cli.call('host.clients', {}, token)).result?.clients), true);
  cli.close();
});

test('every session of a controller and every method refused to it is a line in the audit record, and a failed governed write ends the session', async (t) => {
  const lines: any[] = [];
  let failing = false;
  const audit = {
    note: (e: any) => void lines.push(e),
    governed: (e: any) => {
      if (failing) throw new Error('audit_unavailable');
      lines.push(e);
      return true;
    },
  };
  const w = await servedHost(t, {}, (r) => r, { audit });
  const id = w.identity('ctl');
  const fp = w.pairing.add(id.publicKey, { name: 'Other Mac', kind: 'controller' });
  const conn = await w.reconnect(id);
  await conn.call('host.modelKey', {});
  await conn.call('host.policy', {});
  assert.deepEqual(
    lines.filter((l) => l.kind === 'controller.connected' || l.kind === 'client.refused').map((l) => [l.kind, l.by.kind, l.what?.tool]),
    [
      ['controller.connected', 'controller', undefined],
      ['client.refused', 'controller', 'host.modelKey'],
      ['client.refused', 'controller', 'host.policy'],
    ],
  );
  assert.equal(lines.find((l) => l.kind === 'controller.connected').by.fingerprint, fp);
  // a desktop leaves no such line
  const d = w.identity('desk');
  w.pairing.add(d.publicKey, { name: 'Desk', kind: 'desktop' });
  await w.reconnect(d);
  assert.equal(lines.filter((l) => l.kind === 'controller.connected' || l.kind === 'client.refused').length, 3);
  // with audit.required a line that cannot be written means the connection is not made
  failing = true;
  const again = w.line();
  const { authenticate } = (await import('node:module')).createRequire(import.meta.url)('../electron/host/pairingClient.cjs');
  await assert.rejects(authenticate(again.request, id), /could not|audit/i);
});

test("every kind is classified at the entry: the owner's own computer, the CLI and the phone as they were, a controller by its list, any other kind only to pair or prove a key", async (t) => {
  assert.deepEqual([...UNKNOWN_ALLOWED].sort(), ['host.auth', 'host.challenge', 'host.hello', 'host.pair']);
  for (const kind of ['desktop', 'cli', 'phone'])
    for (const m of ['host.clients', 'host.modelKey', 'host.policy', 'update', 'chat.send'])
      assert.equal(kindAllows(kind, m), true, `${kind} ${m}`);
  for (const kind of ['unknown', 'guest', '', undefined, 'someday']) {
    for (const m of UNKNOWN_ALLOWED) assert.equal(kindAllows(kind, m), true, `${kind} ${m}`);
    for (const m of [
      'host.clients',
      'host.modelKey',
      'host.orgLease',
      'host.login',
      'host.install',
      'host.relayEnroll',
      'host.scheduleSync',
      'host.chats',
      'chat.send',
      'host.status',
      'fs.read',
      'update',
    ])
      assert.equal(kindAllows(kind, m), false, `${kind} ${m}`);
  }
  // on a served Host: a record of a kind this Host does not know pairs, says hello, and can do nothing else
  const w = await servedHost(t);
  const id = w.identity('guest');
  w.pairing.add(id.publicKey, { name: 'Guest', kind: 'guest' as any });
  const conn = await w.reconnect(id);
  for (const method of [
    'host.clients',
    'host.modelKey',
    'host.orgLease',
    'host.login',
    'host.install',
    'host.relayEnroll',
    'host.scheduleSync',
    'host.chats',
    'host.status',
    'update',
  ])
    assert.equal((await conn.call(method, {})).code, 'forbidden', method);
});
