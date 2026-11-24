// The last uncovered edges of the home's fix ids and machine actions: a fix id that is bare, or not well formed, is refused in words and never guessed at; a machine with no Host is set up by starting one; a wake of a home that is moving reaches its machine; a move that was cut short and whose machine has gone from the list is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { B, world } from './support/momoHomeRealWorld.ts';
import { realMachines } from './support/momoRealMachines.ts';
import { STUDIO, hostSays, start, tmp } from './support/momoServiceKit.ts';
import { waitFor } from './support/waitFor.ts';

const require = createRequire(import.meta.url);
const { getHomeApi, setHomeApi } = require('../electron/momo/homeSlot.cjs');

test('a fix id with a missing field or one that does not decode is refused in words, never taken for another', async (t) => {
  const w = await world(t, { second: true });
  await w.intent({ kind: 'choose-home', machineId: 'studio' });
  const cause = async (id: string) => (await w.intent({ kind: 'fix', id })).cause as string;
  // a fix about a machine with no machine named, or an id that does not decode
  assert.match(await cause('update-machine:%E0%A4%A'), /not offered here any more/);
  assert.match(await cause('x:%E0%A4%A'), /not offered here any more/);
  // a Start fresh confirmation with no token, where Start fresh is offered
  const lost = await world(t, { second: true });
  lost.down.add('studio');
  assert.match((await lost.intent({ kind: 'fix', id: 'start-fresh!' })).cause, /has to be asked first/);
  assert.match(await cause('retry-send'), /not waiting any more/);
  assert.match(await cause('delete-send'), /not waiting any more/);
  assert.match(await cause('use-older'), /not offered any more/);
});

test('a machine with no Host is set up by starting one, and a wake of a home that is moving reaches the machine it is on', async (t) => {
  setHomeApi(null);
  const dir = tmp(t);
  const started: string[] = [];
  const r = realMachines(t, [{ id: 'studio', name: 'Studio', hostId: STUDIO }], hostSays(null));
  await r.beat();
  const noHost = {
    ...r.m,
    row: (id: string) => ({ ...r.m.row(id), socketPath: '' }),
    startHost: async (id: string) => void started.push(id),
  };
  const stop = start({ machines: noHost, dir, watch: () => () => undefined });
  await waitFor(() => getHomeApi(), 'the home');
  const api = getHomeApi();
  await api.view();
  assert.equal(((await api.intent({ kind: 'set-up-machine', machineId: 'studio' })) as any).ok, true);
  assert.deepEqual(started, ['studio']);
  stop();
  setHomeApi(null);
  // a build whose service cannot start a Host says so
  const bare = start({ machines: { ...noHost, startHost: undefined }, dir, watch: () => () => undefined });
  await waitFor(() => getHomeApi(), 'the home again');
  await getHomeApi().view();
  assert.match(((await getHomeApi().intent({ kind: 'set-up-machine', machineId: 'studio' })) as any).cause, /can’t do that from here/);
  bare();
  setHomeApi(null);
});

test('a wake while the home is moving goes to the machine the home is on', async (t) => {
  const w = await world(t, { second: true });
  await w.intent({ kind: 'choose-home', machineId: 'studio' });
  const look = w.a.home.look();
  const status = await w.asHost('studio', 'host.momoStatus', {});
  w.overrides.set('studio', (method) => {
    if (method === 'host.momoHomeLook') return { ...look, state: 'moving' };
    if (method === 'host.momoStatus') return { home: { ...status.home, state: 'moving', moveId: 'move-0000001', moveExpired: false } };
    return undefined;
  });
  w.clock.at += 10_000;
  await w.real.refresh();
  assert.equal((await w.intent({ kind: 'wake' })).ok, true);
  assert.deepEqual(w.acts.at(-1), { kind: 'wake', machineId: 'studio' });
});

test('a move that was cut short, whose target has left the list, cannot be tried again', async (t) => {
  const w = await world(t, { second: true });
  await w.intent({ kind: 'choose-home', machineId: 'studio' });
  w.overrides.set('mini', (method, p) =>
    method === 'host.momoMove' && p.op === 'receive' ? Promise.reject(new Error(`${B.name} could not take it.`)) : undefined,
  );
  await w.intent({ kind: 'move', toId: 'mini' });
  w.machines.splice(1, 1);
  assert.equal((await w.intent({ kind: 'move-retry' })).ok, false);
});

test('the move runner is given no machine for an id that is not in the list, and a listed machine calls its Host’s move with the op', async () => {
  const { machineSides } = await import('../shared/momoHomeAsk.mjs');
  const calls: unknown[][] = [];
  const sides = machineSides({
    machines: () => [{ id: 'mini', hostId: 'h1', name: 'Mac mini' }] as any,
    call: async (...a: unknown[]) => (calls.push(a), 'ok'),
    callMs: 500,
  });
  assert.equal(sides('gone'), null);
  const side: any = sides('mini');
  assert.deepEqual([side.id, side.hostId, side.name], ['mini', 'h1', 'Mac mini']);
  assert.equal(await side.side.call('cancel'), 'ok');
  assert.deepEqual(calls[0], ['mini', 'host.momoMove', { op: 'cancel' }, 500]);
});
