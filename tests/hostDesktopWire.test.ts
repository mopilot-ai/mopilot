// The Host desktop on the wire (G8 #3903): parsers, the allowlist, the feature gate, the protocol's epoch check and the connection's lease, and the capability in status.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createDesktopHost } from '../host/src/desktopHost.mjs';
// @ts-ignore: plain ESM without declarations
import { createDesktopProtocol } from '../host/src/desktopProtocol.mjs';
// @ts-ignore: plain ESM without declarations
import { desktopParsers, desktopCallAllowed, DESKTOP_METHODS, DESKTOP_CALLS } from '../shared/host/desktop.mjs';
// @ts-ignore: plain ESM without declarations
import { hostStatus } from '../host/src/status.mjs';
// @ts-ignore: plain ESM without declarations
import { capabilitiesOf, parseParams, requireFeatures, helloParams } from '../shared/host/schema.mjs';
// @ts-ignore: plain ESM without declarations
import { createProtocol } from '../host/src/protocol.mjs';
// @ts-ignore: plain ESM without declarations
import { createEpochStore } from '../host/src/epochs.mjs';
// @ts-ignore: plain ESM without declarations
import { createLedger } from '../host/src/ledger.mjs';
// @ts-ignore: plain ESM without declarations
import { createGuard } from '../host/src/guard.mjs';
import { fakeHelper } from './support/host-desktop-kit.ts';
import { tick } from './support/async-scenarios.ts';

const bad = (message: string) => new Error(message);
const scoped = (p: any) => ({ chatId: p.chatId, epoch: p.epoch });
const parsers = desktopParsers(scoped, bad);

// the protocol and the service

test('protocol: every request is checked against the chat epoch first; the connection owns its lease and lets go when it closes', async () => {
  const f = fakeHelper();
  const current: Record<string, number> = { c: 2 };
  const probe = { ok: () => true, why: () => '', recheck: () => undefined };
  const host = createDesktopHost({ helper: f.helper, probe, epochOf: (c: string) => current[c] ?? 1, maxReply: 1000 });
  const epochs: any = {
    onAdvance: () => () => undefined,
    current: (c: string) => current[c],
    admit(chatId: string, epoch: number) {
      if (epoch !== current[chatId]) throw Object.assign(new Error('stale'), { code: 'stale_epoch' });
      return epoch;
    },
  };
  const protocol = createDesktopProtocol({ desktop: host, epochs });
  const one = protocol.connection();
  const two = protocol.connection();
  await assert.rejects(one.call('desktop.lease', { chatId: 'c', epoch: 1, apps: ['a.b'] }), (e: any) => e.code === 'stale_epoch');
  assert.deepEqual(await one.call('desktop.lease', { chatId: 'c', epoch: 2, apps: ['a.b'] }), { leased: true });
  assert.equal((await one.call('desktop.state', { chatId: 'c', epoch: 2 })).held, true);
  assert.equal((await two.call('desktop.state', { chatId: 'c', epoch: 2 })).held, false);
  f.helper.handler = async () => ({ ok: 1 });
  assert.deepEqual(await one.call('desktop.call', { chatId: 'c', epoch: 2, callId: 'call-0001', method: 'input.click', params: {} }), {
    ok: 1,
  });
  await assert.rejects(
    two.call('desktop.call', { chatId: 'c', epoch: 2, callId: 'call-0001', method: 'input.click', params: {} }),
    (e: any) => e.code === 'no_lease',
  );
  await assert.rejects(
    one.call('desktop.call', { chatId: 'c', epoch: 1, callId: 'call-0002', method: 'input.click', params: {} }),
    (e: any) => e.code === 'stale_epoch',
  );
  assert.deepEqual(await one.call('desktop.release', { chatId: 'c', epoch: 2 }), { released: true });
  await one.call('desktop.lease', { chatId: 'c', epoch: 2, apps: '*' });
  assert.deepEqual(
    await two.call('desktop.abort', { chatId: 'c', epoch: 2 }),
    { aborted: true },
    'the owner chat may stop it from any connection',
  );
  await one.call('desktop.lease', { chatId: 'c', epoch: 2, apps: ['a.b'] });
  one.close();
  await tick();
  assert.equal(host.state({}, 'c').busy, false, 'the closed connection let go');
});

// the wire contract

test('wire: the parsers take a lease with a bounded list of apps or any app, and a call with an allowed method and a call id', () => {
  const lease = parsers['desktop.lease'];
  assert.deepEqual(lease({ chatId: 'c', epoch: 1, apps: ['a.b', 'a.b', 'c.d'] }), { chatId: 'c', epoch: 1, apps: ['a.b', 'c.d'] });
  assert.deepEqual(lease({ chatId: 'c', epoch: 1, apps: '*' }), { chatId: 'c', epoch: 1, apps: '*' });
  assert.deepEqual(lease({ chatId: 'c', epoch: 1, apps: [] }), { chatId: 'c', epoch: 1, apps: [] }, 'no apps yet is a lease of its own');
  for (const apps of [undefined, 'a.b', ['bad id'], [''], [1], Array.from({ length: 65 }, (_, i) => `a.b${i}`)])
    assert.throws(() => lease({ chatId: 'c', epoch: 1, apps }), /Name the apps this chat may control, or none yet/);
  for (const m of ['desktop.release', 'desktop.abort', 'desktop.state'])
    assert.deepEqual(parsers[m]({ chatId: 'c', epoch: 1, extra: 1 }), { chatId: 'c', epoch: 1 });
  const call = parsers['desktop.call'];
  assert.deepEqual(call({ chatId: 'c', epoch: 1, callId: 'call-0001', method: 'input.click', params: { x: 1 } }), {
    chatId: 'c',
    epoch: 1,
    callId: 'call-0001',
    method: 'input.click',
    params: { x: 1 },
  });
  assert.deepEqual(call({ chatId: 'c', epoch: 1, callId: 'call-0001', method: 'screenshot' }).params, {});
  assert.throws(() => call({ chatId: 'c', epoch: 1, callId: 'call-0001', method: 'permissions.request' }), /not one a Host serves/);
  assert.throws(() => call({ chatId: 'c', epoch: 1, method: 'screenshot' }), /no valid call id/);
  assert.throws(() => call({ chatId: 'c', epoch: 1, callId: 'x', method: 'screenshot' }), /no valid call id/);
  for (const params of ['x', [1]])
    assert.throws(() => call({ chatId: 'c', epoch: 1, callId: 'call-0001', method: 'screenshot', params }), /parameters/);
});

test('wire: the allowlist leaves out permission prompts, the deny list, shutdown, scripts, the pasteboard and recording', () => {
  for (const m of [
    'permissions.request',
    'permissions.openSettings',
    'deny.set',
    'shutdown',
    'app.script',
    'shortcuts.run',
    'pasteboard.save',
    'record.start',
    'apps.hideOthers',
    'control.acquire',
  ])
    assert.equal(desktopCallAllowed(m), false, m);
  assert.equal(desktopCallAllowed(42), false);
  assert.equal(desktopCallAllowed('input.click'), true);
  assert.ok(DESKTOP_CALLS.length > 30);
  assert.deepEqual(DESKTOP_METHODS, ['desktop.lease', 'desktop.call', 'desktop.release', 'desktop.abort', 'desktop.state']);
});

test('wire: schema parses the desktop methods, gates them on the desktop feature, and the capability is its own key', () => {
  assert.deepEqual(parseParams('desktop.lease', { chatId: 'c', epoch: 1, apps: ['a.b'] }), { chatId: 'c', epoch: 1, apps: ['a.b'] });
  assert.throws(
    () => requireFeatures('desktop.call', { features: ['epoch'] }),
    (e: any) => e.code === 'feature_missing' && e.missing.includes('desktop'),
  );
  assert.doesNotThrow(() => requireFeatures('desktop.call', { features: ['epoch', 'desktop'] }));
  assert.deepEqual(capabilitiesOf({ iab: true, desktop: true, cu: 'yes' }), {
    iab: true,
    cu: false,
    desktop: true,
    bu: false,
    shell: false,
  });
});

test('status: capabilities.desktop follows the reading; cu stays false so an app that does not know desktop never runs a Host chat on its own screen', () => {
  assert.deepEqual(hostStatus({ running: true, platform: 'darwin', desktop: true }).capabilities, {
    iab: false,
    cu: false,
    desktop: true,
    bu: false,
    shell: false,
  });
  assert.equal(hostStatus({ running: true, platform: 'darwin' }).capabilities.desktop, false);
});

test('the protocol serves desktop.* after hello, ends the lease with the connection, and says so when the Host has no desktop', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-wire-'));
  const quiet = { report: () => undefined };
  const epochs = createEpochStore(path.join(dir, 'e.json'), quiet);
  const guard = createGuard({ epochs, ledger: createLedger(path.join(dir, 'l'), quiet) });
  const runtime: any = { host: Object.assign(new EventEmitter(), { cancel: () => undefined }), send: async () => ({ turnId: 't1' }) };
  const f = fakeHelper();
  const probe = { ok: () => true, why: () => '', recheck: () => undefined };
  const desktop = createDesktopHost({ helper: f.helper, probe, epochOf: (c: string) => epochs.current(c), maxReply: 1000 });
  const make = (withDesktop: boolean) =>
    createProtocol({
      runtime,
      epochs,
      guard,
      status: () => ({ running: true }),
      ...(withDesktop ? { desktop: createDesktopProtocol({ desktop, epochs }) } : {}),
    });
  const scope = { chatId: 'claude:c1', epoch: 1 };
  try {
    const conn = make(true).connection(() => undefined);
    await assert.rejects(conn.call('desktop.state', scope), (e: any) => e.code === 'hello_required');
    await conn.call('host.hello', helloParams());
    assert.deepEqual(await conn.call('desktop.lease', { ...scope, apps: ['a.b'] }), { leased: true });
    assert.deepEqual(await conn.call('desktop.call', { ...scope, callId: 'call-0001', method: 'input.click', params: { x: 1 } }), {
      ok: true,
    });
    assert.equal((await conn.call('desktop.state', scope)).held, true);
    // a second connection of the same Host sees the desktop taken
    const other = make(true).connection(() => undefined);
    await other.call('host.hello', helloParams());
    await assert.rejects(other.call('desktop.lease', { chatId: 'claude:c2', epoch: 1, apps: ['a.b'] }), (e: any) => e.code === 'busy');
    // the first connection going away lets go
    conn.close();
    await tick();
    assert.equal(desktop.state({}, 'claude:c1').busy, false);
    // a Host without a desktop says so
    const bare = make(false).connection(() => undefined);
    await bare.call('host.hello', helloParams());
    await assert.rejects(bare.call('desktop.state', scope), (e: any) => e.code === 'unsupported' && /no desktop/.test(e.message));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
