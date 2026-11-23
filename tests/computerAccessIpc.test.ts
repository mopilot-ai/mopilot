// Computer access's IPC (#1364, electron/app/ipc/computerAccess.cjs): every value a window sends is checked (ids are strings,
// switches booleans, scopes only the known ones), a call before main finished starting says so, and pairing with
// another computer answers the code at once and its outcome later. Plus the host's device settings and reset.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { world, until, ClientConnection, newKeyPair, parseOffer } from './support/computer-access-kit.ts';

const require = createRequire(import.meta.url);
const { register, scopesOf } = require('../electron/app/ipc/computerAccess.cjs');

function ipc(live: any) {
  const handlers = new Map<string, Function>();
  const broadcasts: any[] = [];
  register(
    { handle: (ch: string, fn: Function) => handlers.set(ch, fn) },
    { live, broadcastAll: (ch: string, p: any) => broadcasts.push([ch, p]) },
  );
  const call = (ch: string, ...args: any[]) => handlers.get(`computerAccess:${ch}`)!({}, ...args);
  return { call, broadcasts, handlers };
}

test('scopes from a window: only the known ones, each a boolean', () => {
  assert.deepEqual(scopesOf({ browser: true, apps: 'yes', root: true }), { browser: true, chrome: false, apps: false, files: false });
  assert.deepEqual(scopesOf(null), { browser: false, chrome: false, apps: false, files: false });
});

test('before main finished starting: state is empty and every action says it is still starting', async () => {
  const { call } = ipc({});
  assert.deepEqual(await call('state'), { host: null, computers: [] });
  for (const ch of [
    'setEnabled',
    'setLan',
    'startPairing',
    'cancelPairing',
    'answerPairing',
    'setDevice',
    'revoke',
    'stop',
    'log',
    'reset',
  ])
    assert.throws(() => call(ch), /still starting/, ch);
  await assert.rejects(call('pair', 'x'), /still starting/);
  assert.equal(await call('forget', 'h1'), false);
});

test('this Mac through IPC: switches, pairing with checked scopes, device settings, stop, log, reset', async () => {
  const w = await world({ enabled: false });
  try {
    const clientCalls: string[] = [];
    const client = {
      hosts: () => [{ id: 'h1' }],
      forget: (id: string) => id === 'h1',
      pair: null as any,
      close: () => clientCalls.push('close'),
      sync: () => clientCalls.push('sync'),
    };
    const { call } = ipc({ computerAccess: { host: w.host, client } });
    await call('setEnabled', 'yes');
    assert.equal(w.host.state().enabled, false);
    await call('setEnabled', true);
    assert.ok(w.host.listening);
    await call('setLan', 1);
    assert.equal(w.store.lan(), false);
    const offer = call('startPairing');
    assert.match(offer.text, /^mopilot-access:1:127\.0\.0\.1:/);
    call('cancelPairing');
    assert.equal(w.host.state().pairing, null);
    // a device waiting: Allow with scopes a window sent, only the known ones kept
    const o = parseOffer(call('startPairing').text);
    const dev = new ClientConnection({
      url: w.url(),
      identity: newKeyPair(),
      pair: { name: 'Pad', secret: o.secret, fingerprint: o.fingerprint },
    });
    await dev.connect();
    await until(() => w.host.request);
    const done = dev.paired();
    const allowed = call('answerPairing', true, { apps: true, root: true });
    await done;
    assert.equal(allowed.name, 'Pad');
    assert.deepEqual(w.store.devices()[0].scopes, { browser: false, chrome: false, apps: true, files: false });
    assert.equal(call('answerPairing', true), null);
    // device settings: scopes checked, approvals only as a boolean
    assert.equal(call('setDevice', allowed.id, { scopes: { browser: true }, hostOnlyApprovals: 'yes' }), true);
    assert.deepEqual(w.store.devices()[0].scopes, { browser: true, chrome: false, apps: false, files: false });
    assert.equal(w.store.devices()[0].hostOnlyApprovals, false);
    call('setDevice', allowed.id, { hostOnlyApprovals: true });
    assert.equal(w.store.devices()[0].hostOnlyApprovals, true);
    call('setDevice', allowed.id, null);
    assert.throws(() => call('setDevice', 42, {}), /not paired/);
    // a session of that device, stopped from Settings
    await dev.call({ chat: 'c', turn: 't', tool: 'browser_navigate', args: {} });
    const owner = w.host.state().active[0].id;
    const stopped = new Promise((r) => dev.once('stop', r));
    assert.equal(await call('stop', owner), true);
    await stopped;
    assert.equal(await call('stop', 'x'.repeat(300)), false);
    const lines = await call('log', 3);
    assert.equal(lines.length, 3);
    assert.ok((await call('log', 'all')).length > 3);
    assert.equal(call('revoke', allowed.id), true);
    assert.equal(call('revoke', null), false);
    assert.deepEqual((await call('state')).computers, [{ id: 'h1' }]);
    assert.equal(call('forget', 'h1'), true);
    await call('reset');
    // the computers this install used went with the store: their connections end and the tools follow
    assert.deepEqual(clientCalls, ['close', 'sync']);
    assert.equal(w.host.state().enabled, false);
    assert.equal(w.host.listening, null);
    assert.equal(w.store.devices().length, 0);
  } finally {
    await w.close();
  }
});

test('pairing with another computer: the code now, the outcome later on every window', async () => {
  let settle: any;
  const client = {
    hosts: () => [],
    pair: async (offer: string) => ({ code: `code for ${offer}`, done: new Promise((resolve, reject) => (settle = { resolve, reject })) }),
  };
  const { call, broadcasts } = ipc({ computerAccess: { host: null, client } });
  assert.deepEqual(await call('pair', 'offer-1'), { code: 'code for offer-1' });
  settle.resolve({ name: 'Studio' });
  await until(() => broadcasts.length === 1);
  assert.deepEqual(broadcasts[0], ['computerAccess:paired', { ok: true, name: 'Studio' }]);
  assert.deepEqual(await call('pair', undefined), { code: 'code for ' });
  settle.reject(new Error('The person on this Mac did not allow pairing'));
  await until(() => broadcasts.length === 2);
  assert.deepEqual(broadcasts[1], ['computerAccess:paired', { ok: false, error: 'The person on this Mac did not allow pairing.' }]);
  await call('pair', 'x');
  // the other computer's address and port never reach the toast (#1863)
  settle.reject(new Error('connect ECONNREFUSED 192.168.1.20:47321'));
  await until(() => broadcasts.length === 3);
  assert.equal(broadcasts[2][1].error, "Couldn't connect.");
});
