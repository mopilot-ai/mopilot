// MoMo's home (kind `home`) at the Host's per-kind entry (host/src/controllerRefusals.mjs, R2b of #5576 and the host link): it reaches the home gate with exactly the methods the gate's allow-list handles and is refused every other at the entry, in the gate's own words; `host.homeLinkRepair` is classified for every kind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain ESM without declarations
import { HOME_METHODS } from '../host/src/homeGate.mjs';
// @ts-ignore
import { CONTROLLER_ALLOWED, CONTROLLER_DENIED, kindAllows, refuseByKind } from '../host/src/controllerRefusals.mjs';
// @ts-ignore
import { PARSERS } from '../shared/host/schema.mjs';
import { servedHost } from './support/hostClientsWorld.ts';

test("a home's entry is the home gate's allow-list and nothing else; the line protocol and every other method are refused at the entry", () => {
  for (const m of HOME_METHODS) assert.equal(kindAllows('home', m), true, m);
  const others = [...Object.keys(PARSERS), 'send', 'update', 'login', 'status'].filter((m) => !HOME_METHODS.includes(m));
  assert.ok(others.length > 100);
  for (const m of others) assert.equal(kindAllows('home', m), false, m);
  for (const m of ['host.clients', 'host.clientAdd', 'host.homeLinkRepair', 'host.modelKey', 'host.policy', 'fs.read', 'chat.permit'])
    assert.throws(() => refuseByKind({ kind: 'home' }, m), { code: 'home_not_allowed' }, m);
  assert.doesNotThrow(() => refuseByKind({ kind: 'home' }, 'chat.start'));
});

test("host.homeLinkRepair is classified for every kind: the owner's desktop, phone and the CLI reach it, a controller, a home and any other kind are refused", () => {
  for (const kind of ['desktop', 'phone', 'cli']) assert.equal(kindAllows(kind, 'host.homeLinkRepair'), true, kind);
  for (const kind of ['controller', 'home', 'unknown', 'guest']) assert.equal(kindAllows(kind, 'host.homeLinkRepair'), false, kind);
  assert.ok(CONTROLLER_DENIED.includes('host.homeLinkRepair') && !CONTROLLER_ALLOWED.includes('host.homeLinkRepair'));
});

test('on a served Host a home reaches the gate with its hello, status and start, and the client table, the repair and the Host settings stop at the entry', async (t) => {
  const reached: string[] = [];
  const homeGate = {
    admit: async (_who: unknown, method: string, raw: unknown) => (reached.push(method), raw),
    sweep: async () => undefined,
    landing: () => async () => undefined,
  };
  const w = await servedHost(t, { homeGate: () => homeGate });
  const id = w.identity('home');
  w.pairing.add(id.publicKey, { name: 'MoMo', kind: 'home' });
  const conn = await w.reconnect(id);
  await conn.call('host.status', {});
  const started: any = await conn.call('chat.start', {
    chatId: '019e0000-0000-7000-8000-0000000000aa',
    epoch: 1,
    key: 'key-00000001',
    harness: 'codex',
    text: 'go',
  });
  // the gate admitted it; what this stub world then says of the harness is the protocol's own
  assert.notEqual(started.code, 'home_not_allowed');
  assert.ok(reached.includes('host.hello') && reached.includes('host.status') && reached.includes('chat.start'), reached.join(','));
  const before = reached.length;
  for (const method of [
    'host.clients',
    'host.clientAdd',
    'host.homeLinkRepair',
    'host.modelKey',
    'host.policy',
    'host.chats',
    'chat.permit',
  ]) {
    assert.equal((await conn.call(method, {})).code, 'home_not_allowed', method);
  }
  assert.equal(reached.length, before, 'none of them reached the gate');
});
