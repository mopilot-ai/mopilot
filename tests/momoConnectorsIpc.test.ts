// The connector rows' IPC (electron/momo/connectors/ipc.cjs, #2999 C0) over the test connector's real hub and loopback sign-in: list (never a token; no OS key lists nothing and says so), connect through the browser, cancel, the level, every channel refused while MoMo is not allowed, disconnect included; failures typed by the hub's or the sign-in's code; a change broadcast only while MoMo is allowed; the remover takes every handler and the listener away.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { connectorWorld, tick } from './support/momoConnectorWorld.ts';

const require = createRequire(import.meta.url);
const { registerConnectorsIpc, CHANNELS, NOT_ALLOWED } = require('../electron/momo/connectors/ipc.cjs');

function wire(hub: any, allowed: () => boolean) {
  const handlers = new Map<string, (...a: any[]) => any>();
  const sent: string[] = [];
  const ipcMain = { handle: (c: string, fn: any) => void handlers.set(c, fn), removeHandler: (c: string) => void handlers.delete(c) };
  const off = registerConnectorsIpc(ipcMain, { hub, allowed, broadcast: (c: string) => void sent.push(c) });
  const call = (c: string, ...args: any[]) => handlers.get(c)!({}, ...args);
  return { handlers, sent, off, call };
}

test('list, connect, level, cancel and disconnect over IPC; never a token', async () => {
  const w = connectorWorld();
  const i = wire(w.hub, () => w.s.allowed);
  assert.deepEqual([...i.handlers.keys()], [...CHANNELS]);
  const first = await i.call('momoConnectors:list');
  assert.equal(first.ok, true);
  assert.equal(first.available, true);
  assert.deepEqual(
    first.connectors.map((c: any) => [c.id, c.connected]),
    [['test-account', false]],
  );
  const p = i.call('momoConnectors:connect', w.id);
  await w.approve();
  const r = await p;
  assert.equal(r.ok, true);
  assert.equal(r.connector.connected, true);
  assert.ok(!JSON.stringify(await i.call('momoConnectors:list')).includes(w.vault.get(w.id).accessToken));
  assert.deepEqual(await i.call('momoConnectors:setLevel', w.id, 'blocked'), { ok: true });
  assert.equal(w.hub.status(w.id).level, 'blocked');
  assert.deepEqual(await i.call('momoConnectors:cancel', w.id), { ok: true, cancelled: false });
  assert.ok(i.sent.length > 0 && i.sent.every((c) => c === 'momoConnectors:changed'));
  assert.deepEqual(await i.call('momoConnectors:disconnect', w.id), { ok: true });
  assert.equal(w.hub.status(w.id).connected, false);
});

test('failures carry the code: a cancelled or refused sign-in, an unknown connector, a bad level', async () => {
  const w = connectorWorld();
  const i = wire(w.hub, () => true);
  const p = i.call('momoConnectors:connect', w.id);
  while (!w.opened.length) await tick();
  await i.call('momoConnectors:cancel', w.id);
  assert.deepEqual(await p, { ok: false, error: 'The sign-in was cancelled', reason: 'closed' });
  w.opened.length = 0;
  const q = i.call('momoConnectors:connect', w.id);
  assert.equal(await w.approve((state) => `error=access_denied&state=${state}`), 200);
  assert.equal((await q).reason, 'denied');
  assert.equal((await i.call('momoConnectors:setLevel', w.id, 'ask')).reason, 'not_connected');
  assert.equal((await i.call('momoConnectors:disconnect', 'nope')).reason, 'unknown');
  await w.connect();
  const bad = await i.call('momoConnectors:setLevel', w.id, 'all');
  assert.equal(bad.ok, false);
  assert.equal('reason' in bad, false);
});

test('while MoMo is not allowed only disconnect answers, and nothing is broadcast; the remover takes everything away', async () => {
  const w = connectorWorld();
  const i = wire(w.hub, () => w.s.allowed);
  await w.connect();
  i.sent.length = 0;
  w.s.allowed = false;
  for (const c of CHANNELS) assert.deepEqual(await i.call(c, w.id, 'ask'), NOT_ALLOWED);
  assert.notEqual(w.vault.get(w.id), null, 'nothing was disconnected');
  assert.deepEqual(i.sent, []);
  w.s.allowed = true;
  i.off();
  assert.equal(i.handlers.size, 0);
  await w.hub.disconnect(w.id);
  assert.deepEqual(i.sent, []);
});

test('list: no OS key lists nothing and says so; another failure is a typed failure', async () => {
  const w = connectorWorld({ safeStorage: null });
  const i = wire(w.hub, () => true);
  assert.deepEqual(await i.call('momoConnectors:list'), { ok: true, connectors: [], available: false });
  const broken = Object.assign(new EventEmitter(), {
    list: () => {
      throw new Error('disk gone');
    },
  });
  const j = wire(broken, () => true);
  assert.deepEqual(await j.call('momoConnectors:list'), { ok: false, error: 'disk gone' });
});
