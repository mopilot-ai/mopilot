// Google on MoMo's real home (shared/momoHomeReal.mjs): the view's Sources and the Google line of setup come from the home's Host, this device's own sign-in kinds are registered only where a device gave its catcher, a remove goes to the Host, and the phone's relay reaches only the home's Host through `hostCall`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain ESM without declarations
import { createSealer } from '../shared/momoGoogle/seal.mjs';
// @ts-ignore
import { createNodePrimitives } from '../shared/remote/nodePrimitives.mjs';
import { world } from './support/momoHomeRealWorld.ts';

const google = () => ({
  sealer: createSealer(createNodePrimitives()),
  startCatcher: async () => Promise.reject(new Error('no browser here')),
  client: 'desktop',
});
const GOOGLE_KINDS = ['google', 'source.reconnect', 'source.remove'];

test('the Google kinds are pending until a device gives its sign-in, and only those', async (t) => {
  const without = await world(t);
  assert.deepEqual(without.real.pending(), GOOGLE_KINDS);
  const withIt = await world(t, { google: google() });
  assert.deepEqual(withIt.real.pending(), []);
});

test('the Sources rows and the Google line of setup come from the home’s Host; a Host that cannot say shows nothing connected', async (t) => {
  const w = await world(t);
  await w.intent({ kind: 'choose-home', machineId: 'studio' });
  w.overrides.set('studio', (method, p) =>
    method === 'host.momoGoogle' && p.op === 'status'
      ? { kind: 'connected_read_only', email: 'me@example.com', connectedAt: 5 }
      : undefined,
  );
  await w.real.refresh();
  let v = await w.view();
  assert.deepEqual(
    v.home.sources.map((s: any) => [s.id, s.account, s.access, s.status]),
    [
      ['gmail', 'me@example.com', 'read-only', 'ok'],
      ['calendar', 'me@example.com', 'read-only', 'ok'],
    ],
  );
  assert.equal(v.setup.google, 'connected');
  w.overrides.set('studio', (method) => {
    if (method === 'host.momoGoogle') throw new Error('Unknown request: host.momoGoogle');
    return undefined;
  });
  await w.real.refresh();
  v = await w.view();
  assert.deepEqual(v.home.sources, []);
  assert.equal(v.setup.google, 'idle');
});

test('a Google remove goes to the home’s Host; a sign-in that cannot open a browser is refused in words; one without a home is refused', async (t) => {
  const w = await world(t, { google: google() });
  assert.equal((await w.intent({ kind: 'google', intent: 'remove', client: 'desktop' })).ok, false, 'no home to ask');
  await w.intent({ kind: 'choose-home', machineId: 'studio' });
  w.overrides.set('studio', (method, p) =>
    method === 'host.momoGoogle' && p.op === 'disconnect' ? { kind: 'not_connected', canStart: true, iosRedirectUri: null } : undefined,
  );
  const removed = await w.intent({ kind: 'source.remove', id: 'gmail' });
  assert.equal(removed.ok, true, JSON.stringify(removed));
  assert.ok(w.calls.some((c) => c.method === 'host.momoGoogle' && c.params.op === 'disconnect'));
  const signIn = await w.intent({ kind: 'google', intent: 'connect', client: 'desktop' });
  assert.equal(signIn.ok, false);
  assert.equal(
    w.calls.some((c) => c.method === 'chat.send'),
    false,
  );
});

test('hostCall is one call to the home’s Host, and refuses when MoMo runs nowhere', async (t) => {
  const none = await world(t);
  await assert.rejects(none.real.api.hostCall('host.momoGoogle', { op: 'status' }), /isn’t running anywhere/);
  const w = await world(t);
  await w.intent({ kind: 'choose-home', machineId: 'studio' });
  w.overrides.set('studio', (method) => (method === 'host.momoGoogle' ? { kind: 'connecting' } : undefined));
  assert.deepEqual(await w.real.api.hostCall('host.momoGoogle', { op: 'status' }), { kind: 'connecting' });
});
