// The intents of the lanes that live on the Host (gate, tasks, notice, google) run on the Host that is the home: `host.momoLaneIntent` runs one through a registry built from each lane service's `intents` map, for a paired owner device only, and the Mac forwards every such kind to it with one generic handler.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { momoHomeFor, createMomoHidden } from '../host/src/momoWiring.mjs';
// @ts-ignore
import methods from '../host/src/methods/momoLaneIntent.mjs';
// @ts-ignore
import wire from '../shared/host/methods/momoLaneIntent.mjs';
// @ts-ignore
import { HostRefusal } from '../host/src/hostFs.mjs';
import { createIntentRegistry, forwardedIntents, HOST_LANES, INTENT_TABLE, LANES } from '../shared/momoIntents.mjs';
import { IntentError } from '../shared/momoHomeApi.mjs';

async function host(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-lane-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const records = new Map<string, any>();
  const sessions: any = {
    chats: { records, patchMeta: (id: string, patch: object) => records.set(id, { meta: { ...records.get(id)?.meta, ...patch } }) },
    isolated: () => true,
    isolate: () => undefined,
  };
  const home: any = momoHomeFor({
    paths: { dataDir: path.join(dir, 'data'), configDir: path.join(dir, 'config') },
    report: () => undefined,
    sessions,
    epochs: { current: () => 1 } as any,
    hidden: createMomoHidden(),
    hostId: 'home-aaaa-1111',
    env: { ANTHROPIC_API_KEY: 'test-key', HOME: '/nonexistent-home', XDG_DATA_HOME: '/nonexistent-data' },
  });
  t.after(() => home.close());
  await home.grant({ account: 'a1', features: ['momo'] });
  await home.start({ name: 'Studio' });
  return home;
}
const who = (kind: string) => ({ fingerprint: kind, name: kind, kind });

test('a lane’s handler runs on the Host that is the home: its value comes back, a refusal comes back as words, anything else as a plain failure', async (t) => {
  const home = await host(t);
  const run = methods({ momo: home }).handlers['host.momoLaneIntent'];
  const tasks = home.service('tasks');
  assert.ok(tasks, 'the tasks service is loaded');
  const original = { ...tasks.intents };
  t.after(() => Object.assign(tasks.intents, original));
  tasks.intents['task.stop'] = async () => ({ stopped: true });
  assert.deepEqual(await run({ intent: { kind: 'task.stop', id: 't1' } }), { ok: true, value: { stopped: true } });
  tasks.intents['task.stop'] = async () => undefined;
  assert.deepEqual(await run({ intent: { kind: 'task.stop', id: 't1' } }), { ok: true, value: null });
  tasks.intents['task.stop'] = async () => {
    throw new IntentError('That task already ended.', { fix: { id: 'x' }, fixLabel: 'Start again' });
  };
  assert.deepEqual(await run({ intent: { kind: 'task.stop', id: 't1' } }), {
    ok: false,
    cause: 'That task already ended.',
    fix: { id: 'x' },
    fixLabel: 'Start again',
  });
  tasks.intents['task.stop'] = async () => {
    throw new HostRefusal('momo_unavailable', 'MoMo is not available on Studio right now.');
  };
  assert.deepEqual(await run({ intent: { kind: 'task.stop', id: 't1' } }), {
    ok: false,
    cause: 'MoMo is not available on Studio right now.',
  });
  tasks.intents['task.stop'] = async () => {
    throw new Error('ENOENT /secret/path');
  };
  assert.deepEqual(await run({ intent: { kind: 'task.stop', id: 't1' } }), { ok: false, cause: 'MoMo couldn’t do that.' });
  // arguments are the table's, checked by the registry before the handler
  assert.deepEqual(await run({ intent: { kind: 'task.stop' } }), { ok: false, cause: 'That is not something MoMo can do.' });
});

test('a kind whose lane has no handlers here is "can’t do that yet", and the Host registers host lanes only', async (t) => {
  const home = await host(t);
  const run = methods({ momo: home }).handlers['host.momoLaneIntent'];
  assert.deepEqual(await run({ intent: { kind: 'wake' } }), {
    ok: false,
    cause: 'MoMo can’t do that yet.',
  });
  const registry = home.intentRegistry();
  const lanes = new Set(registry.registered().map((k: string) => INTENT_TABLE[k]!.lane));
  for (const lane of lanes) assert.ok((HOST_LANES as readonly string[]).includes(lane as string), `${lane} is a Host lane`);
  assert.ok(registry.registered().includes('task.stop'));
  assert.ok(registry.pending().includes('wake'), 'the home lane’s kinds are the Mac’s, not registered on a Host');
});

test('a kind named like an Object.prototype member is no handler: it is the typed refusal, never a call', async (t) => {
  const home = await host(t);
  const run = methods({ momo: home }).handlers['host.momoLaneIntent'];
  for (const kind of ['constructor', 'toString', '__proto__', 'hasOwnProperty'])
    assert.deepEqual(await run({ intent: { kind } }), { ok: false, cause: 'MoMo can’t do that yet.' }, kind);
});

test('only the home runs a lane’s intent: asleep it is refused with words, and a service whose map the table refuses is reported', async (t) => {
  const home = await host(t);
  const tasks = home.service('tasks');
  const original = { ...tasks.intents };
  t.after(() => {
    for (const k of Object.keys(tasks.intents)) delete tasks.intents[k];
    Object.assign(tasks.intents, original);
  });
  tasks.intents['task.stop'] = async () => 'stopped';
  await home.lifecycle('pause');
  const stamp = home.stamp;
  home.stamp = () => null;
  try {
    const answer = await methods({ momo: home }).handlers['host.momoLaneIntent']({ intent: { kind: 'task.stop', id: 't1' } });
    assert.deepEqual(answer, { ok: false, cause: 'MoMo isn’t running on this machine right now.' });
  } finally {
    home.stamp = stamp;
  }
  tasks.intents['no-such-kind'] = async () => 1;
  assert.ok(
    !home.intentRegistry().registered().includes('task.stop'),
    'a map with a kind the table does not give the lane registers none of its kinds',
  );
});

test('who may run a lane’s intent, and what the wire accepts', () => {
  const home: any = { granted: () => true };
  const { veils } = methods({ momo: home });
  for (const ok of ['desktop', 'phone']) assert.equal(veils['host.momoLaneIntent'](who(ok)), true, ok);
  for (const no of ['cli', 'home']) assert.equal(veils['host.momoLaneIntent'](who(no)), false, no);
  assert.equal(veils['host.momoLaneIntent'](null), false);
  assert.equal(methods({ momo: { granted: () => false } as any }).veils['host.momoLaneIntent'](who('desktop')), false);
  assert.equal(methods({}).veils['host.momoLaneIntent'](who('desktop')), false);
  const parse = wire({ bad: (m: string) => new Error(m) }).methods['host.momoLaneIntent'].parse;
  assert.deepEqual(parse({ intent: { kind: 'task.stop', id: 't' } }), { intent: { kind: 'task.stop', id: 't' } });
  for (const bad of [
    undefined,
    {},
    { intent: null },
    { intent: 'x' },
    { intent: [] },
    { intent: { kind: 3 } },
    { intent: { kind: 'wake' } },
    { intent: { kind: 'no-such' } },
    { intent: { kind: 'toString' } },
  ])
    assert.throws(() => parse(bad as any), /not something MoMo can do/, JSON.stringify(bad));
  assert.throws(() => parse({ intent: { kind: 'task.stop', pad: 'x'.repeat(17_000) } }), /too long/);
});

test('the Mac forwards every Host lane kind with one handler: the Host’s value, its words and fix, and a default when it says nothing', async () => {
  const calls: any[] = [];
  let answer: any = { ok: true, value: { done: 1 } };
  const forwarded = forwardedIntents(async (method: string, params: object) => (calls.push([method, params]), answer));
  assert.deepEqual(Object.keys(forwarded).sort(), [...HOST_LANES].sort());
  const registry = createIntentRegistry();
  for (const [lane, handlers] of Object.entries(forwarded)) registry.register(lane as any, handlers);
  registry.register('google', { google: () => 'g', 'source.reconnect': () => 'g', 'source.remove': () => 'g' });
  registry.register(
    'home',
    Object.fromEntries(
      Object.entries(INTENT_TABLE)
        .filter(([, e]) => e.lane === 'home')
        .map(([k]) => [k, () => 'home']),
    ),
  );
  assert.deepEqual(registry.pending(), [], 'with the home lane registered, every table kind has a handler on the Mac');
  const run = registry.intents() as Record<string, (i: any) => Promise<unknown>>;
  assert.deepEqual(await run['task.stop']!({ kind: 'task.stop', id: 't' }), { done: 1 });
  assert.deepEqual(calls[0], ['host.momoLaneIntent', { intent: { kind: 'task.stop', id: 't' } }]);
  answer = { ok: false, cause: 'That task already ended.', fix: { id: 'x' }, fixLabel: 'Start again' };
  await assert.rejects(
    run['task.stop']!({ kind: 'task.stop', id: 't' }),
    (e: any) => e instanceof IntentError && e.message === 'That task already ended.' && e.fixLabel === 'Start again',
  );
  answer = undefined;
  await assert.rejects(run['task.stop']!({ kind: 'task.stop', id: 't' }), /can’t do that yet/);
  assert.ok(LANES.includes('google'));
});

test('the device that did it comes from the connection, never from the intent: a client’s own `by` loses to the connection’s fingerprint', async (t) => {
  const home = await host(t);
  const tasks = home.service('tasks');
  const original = { ...tasks.intents };
  t.after(() => Object.assign(tasks.intents, original));
  const seen: any[] = [];
  tasks.intents['task.stop'] = async (i: any) => void seen.push(i);
  const run = methods({ momo: home }).handlers['host.momoLaneIntent'];
  const desktop = { principal: () => ({ fingerprint: 'real-fingerprint', name: 'Mac', kind: 'desktop' }) };
  await run(
    { intent: { kind: 'task.stop', id: 't1', by: { id: 'other:device', name: 'Someone else' }, device: 'other', principal: 'other' } },
    'desktop',
    desktop,
  );
  assert.match(seen[0].by.id, /^desktop:[0-9a-f]{12}$/, 'the device id is made from the connection’s own fingerprint');
  assert.notEqual(seen[0].by.id, 'other:device');
  assert.equal(seen[0].by.name, 'Mac');
  assert.equal(JSON.stringify(seen[0]).includes('real-fingerprint'), false, 'and the fingerprint itself is not passed on');
  // with no connection standing, the device is unknown, never what the client said
  await run({ intent: { kind: 'task.stop', id: 't1', by: { id: 'claimed' } } }, 'desktop');
  assert.equal(seen[1].by.id, 'unknown');
});
