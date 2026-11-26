// The steps of the shared rules stop once the home that runs them was stopped, but only BEFORE a group begins: once a start was sent, the stand-down that goes with it always goes (or two homes stay live until someone looks again).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSteps } from '../shared/momoHomeAsk.mjs';

const start = { call: 'host.momoHomeStart', host: 'mini', params: { name: 'Mac mini', floor: 3, climbTo: 4 } };
const standDown = (host: string, leaseEpoch: number | null = null) => ({
  call: 'host.momoStandDown',
  host,
  params: { homeId: 'home-aaaa-1111', leaseEpoch, name: 'Mac mini', own: 1 },
});

const rig = (aliveAfter: (sent: string[]) => boolean) => {
  const sent: string[] = [];
  const told = new Set<string>();
  const run = createSteps({
    call: async (id: string, method: string) => {
      sent.push(`${id}:${method}`);
      return method === 'host.momoHomeStart' ? { home: { leaseEpoch: 9, homeId: 'home-bbbb-2222' } } : { leaseEpoch: 9 };
    },
    told,
    report: () => undefined,
    alive: () => aliveAfter(sent),
  } as any);
  return { run: (steps: object[]) => run(steps as any), sent, told };
};

test('a home stopped before a start sends nothing, and the list is not told as done', async () => {
  const r = rig(() => false);
  assert.deepEqual(await r.run([start, standDown('studio')]), { ran: false, failure: null });
  assert.deepEqual(r.sent, []);
  assert.equal(r.told.size, 0);
});

test('a home stopped right after a start still sends the stand-down that goes with it', async () => {
  const r = rig((sent) => sent.length === 0);
  const done = await r.run([start, standDown('studio')]);
  assert.deepEqual(r.sent, ['mini:host.momoHomeStart', 'studio:host.momoStandDown']);
  assert.equal(done.ran, true);
});

test('a home stopped after the first rung of a start’s climb still takes the next rungs and sends the stand-down', async () => {
  const sent: string[] = [];
  let rung = 0;
  const run = createSteps({
    call: async (id: string, method: string) => {
      sent.push(`${id}:${method}`);
      // the first answer is not above what the winner must beat, so the start is repeated
      return method === 'host.momoHomeStart' ? { home: { leaseEpoch: ++rung === 1 ? 3 : 9, homeId: 'home-bbbb-2222' } } : { leaseEpoch: 9 };
    },
    told: new Set<string>(),
    report: () => undefined,
    alive: () => sent.length === 0,
  } as any);
  const done = await run([start, standDown('studio')] as any);
  assert.deepEqual(
    sent,
    ['mini:host.momoHomeStart', 'mini:host.momoHomeStart', 'studio:host.momoStandDown'],
    'two rungs, then the stand-down: never two live homes',
  );
  assert.equal(done.ran, true);
});

test('stand-downs on their own, once begun, all go: a Host that was told to retire is not left half way', async () => {
  const r = rig((sent) => sent.length === 0);
  const done = await r.run([standDown('studio', 9), standDown('office', 9)]);
  assert.deepEqual(r.sent, ['studio:host.momoStandDown', 'office:host.momoStandDown']);
  assert.equal(done.ran, true);
});

test('a home that was never stopped runs its whole list', async () => {
  const r = rig(() => true);
  assert.deepEqual(await r.run([start, standDown('studio')]), { ran: true, failure: null });
  assert.deepEqual(r.sent, ['mini:host.momoHomeStart', 'studio:host.momoStandDown']);
});

test('a runner built without a way to ask whether its home lives runs its list', async () => {
  const sent: string[] = [];
  const run = createSteps({
    call: async (_id: string, method: string) => (sent.push(method), { home: { leaseEpoch: 9, homeId: 'home-bbbb-2222' } }),
    told: new Set<string>(),
    report: () => undefined,
  } as any);
  assert.deepEqual(await run([start] as any), { ran: true, failure: null });
  assert.deepEqual(sent, ['host.momoHomeStart']);
});
