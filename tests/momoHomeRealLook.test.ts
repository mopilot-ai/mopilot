// How MoMo's real home asks a Host and acts on the shared rules (shared/momoHomeAsk.mjs, shared/host/momoHomeClient.mjs): `host.momoHomeLook` answers an owner device without a live grant, so a lapsed grant is "send the grant and look again" and never a veil that reads as "no home"; "holds none" is only an explicit answer; a Host that will not say is not heard; a Host without the look is read by its build; a tie is decided by the greater id and the loser is told to stand down once; a Host that refuses a step says why and is asked again on Check again. Against real in-process Hosts, with the look answered as the Host contract says.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { A, B, world } from './support/momoHomeRealWorld.ts';
import { waitFor } from './support/waitFor.ts';

const veil = (method: string) => Object.assign(new Error(`Unknown request: ${method}`), { code: 'unknown_request' });
/** What a Host with a lapsed grant answers: its status is veiled, its look is not. */
const lapsed = (look: object) => (method: string) => {
  if (method === 'host.momoHomeLook') return look;
  if (method.startsWith('host.momo')) throw veil(method);
  return undefined;
};

test('a Host whose grant lapsed says what it holds without a grant: holding none counts, the grant is sent again, and a home it holds is believed from the look', async (t) => {
  // the Studio's grant lapsed and it holds none; the Mini holds none: a first run, and the choice goes through
  const w = await world(t, { second: true });
  w.overrides.set('studio', lapsed({ holds: 'none', homeId: null, leaseEpoch: 0, name: '', state: 'none', grantLive: false }));
  w.overrides.set('mini', (method) => (method === 'host.momoHomeLook' ? { holds: 'none', leaseEpoch: 0, grantLive: true } : undefined));
  const v = await w.view();
  assert.equal(v.setup.step, 'where', 'both said they hold none');
  assert.deepEqual(w.granted, ['studio'], 'the Host with a lapsed grant is told again');
  w.overrides.delete('studio');
  // a Host that holds the home with its grant lapsed: the look is enough to know, and nothing else is started
  const x = await world(t, { second: true });
  x.overrides.set('studio', lapsed({ holds: 'home', homeId: A.homeId, leaseEpoch: 4, name: 'Studio', state: 'running', grantLive: false }));
  x.overrides.set('mini', (method) => (method === 'host.momoHomeLook' ? { holds: 'none', leaseEpoch: 0, grantLive: true } : undefined));
  const held = await x.view();
  assert.equal(held.home.leaseEpoch, 4);
  assert.equal(held.home.machineName, 'Studio');
  assert.match((await x.intent({ kind: 'choose-home', machineId: 'mini' })).cause, /already lives on Studio/);
});

test('a Host that will not say (unreadable, refuses, or times out) has not said it holds none, and a Host without the look is read by its build', async (t) => {
  const w = await world(t, { second: true });
  w.overrides.set('studio', (method) => (method === 'host.momoHomeLook' ? { holds: 'unreadable', grantLive: true } : undefined));
  w.overrides.set('mini', (method) => (method === 'host.momoHomeLook' ? { holds: 'none', leaseEpoch: 0, grantLive: true } : undefined));
  const v = await w.view();
  assert.notEqual(v.setup.step, 'where', 'a record that cannot be read is not "no home"');
  assert.match((await w.intent({ kind: 'choose-home', machineId: 'mini' })).cause, /Studio did not answer/);
  // refuses outright
  w.overrides.set('studio', (method) => {
    if (method.startsWith('host.momo')) throw Object.assign(new Error('MoMo is not allowed here.'), { code: 'not_allowed' });
    return undefined;
  });
  await w.real.refresh();
  assert.notEqual((await w.view()).setup.step, 'where');
  // a Host that does not know the look cannot say what it holds: asleep where MoMo lived, never read by its status
  const old = await world(t, { second: true });
  await old.intent({ kind: 'choose-home', machineId: 'studio' });
  old.overrides.set('studio', (method) => {
    if (method === 'host.momoHomeLook') throw veil(method);
    return undefined;
  });
  await old.real.refresh();
  assert.equal((await old.view()).home.state, 'asleep');
  assert.equal(
    old.calls.some((c) => c.id === 'studio' && c.method === 'host.momoStatus' && c.params.fromLook),
    false,
  );
  // one built before any home existed holds none for certain: MoMo is lost there, and the owner may start fresh
  old.machines[0] = { ...old.machines[0], hostAppVersion: '0.4.50', hostVersionAt: old.clock.at } as any;
  await old.real.refresh();
  assert.equal(((await old.view()).problems.find((p: any) => p.code === 'home_lost') as any).fix.id, 'start-fresh');
  // a version that is not a release, or was reported long ago, says nothing of the Host's age
  for (const over of [{ hostAppVersion: 'dev' }, { hostAppVersion: '0.4.50', hostVersionAt: old.clock.at - 11 * 60_000 }]) {
    old.machines[0] = { ...old.machines[0], hostVersionAt: old.clock.at, ...over } as any;
    await old.real.refresh();
    assert.equal(
      (await old.view()).problems.some((p: any) => p.code === 'home_lost'),
      false,
      JSON.stringify(over),
    );
  }
});

test('two Hosts hold a home at the same lease: the greater id keeps it, takes a new lease, and the other is told once to stand down', async (t) => {
  const w = await world(t, { second: true });
  // both were made from other devices, each at its first lease; this app starts with no memory of either
  await w.a.home.start(A);
  await w.b!.home.start(B);
  const told: any[] = [];
  w.overrides.set('studio', (method, p) => {
    if (method === 'host.momoStandDown') told.push(p);
    return undefined;
  });
  await w.real.refresh();
  await waitFor(() => told.length === 1, 'the loser to be told to stand down');
  assert.deepEqual(told[0], { homeId: B.homeId, leaseEpoch: 2, name: B.name });
  await waitFor(async () => (await w.view()).home.leaseEpoch === 2, 'the winner to take a new lease above the tie');
  assert.equal((await w.view()).home.machineName, 'Mac mini');
  assert.equal(w.a.home.look().holds, 'retired');
  await w.real.refresh();
  await w.real.refresh();
  assert.equal(told.length, 1, 'once for that Host and that lease');
});

test('a Host too old to know the stand-down is left as it is, and a refusal says why and is run again on Check again', async (t) => {
  const w = await world(t, { second: true });
  await w.a.home.start(A);
  await w.b!.home.start(B);
  const seen: string[] = [];
  w.overrides.set('studio', (method) => {
    if (method === 'host.momoStandDown') {
      seen.push(method);
      throw veil(method);
    }
    return undefined;
  });
  await w.real.refresh();
  await waitFor(() => seen.length === 1, 'the stand-down to be tried');
  assert.equal((await w.view()).home.machineName, 'Mac mini', 'and the view is as it was');
  await w.real.refresh();
  const tried = seen.length;
  await w.real.refresh();
  await w.real.refresh();
  assert.equal(seen.length, tried, 'not tried again with each look');
  // a Host that refuses a step: the reason, then the step is run again with Check again
  const r = await world(t, { second: true });
  await r.a.home.start(A);
  await r.b!.home.start(B);
  let refuse = true;
  const asked: string[] = [];
  r.overrides.set('studio', (method) => {
    if (method !== 'host.momoStandDown') return undefined;
    asked.push(method);
    if (refuse) throw Object.assign(new Error('unproven'), { code: 'epoch_unproven' });
    return undefined;
  });
  await r.real.refresh();
  await waitFor(async () => (await r.view()).problems.some((p: any) => p.code === 'lease_steps'), 'the refusal to be told');
  const problem = ((await r.view()).problems.find((p: any) => p.code === 'lease_steps') as any).cause;
  assert.match(problem, /would not retire its old copy/);
  refuse = false;
  assert.equal((await r.intent({ kind: 'fix', id: 'check-again' })).ok, true);
  await waitFor(() => asked.length >= 2, 'the step to be run again');
  await waitFor(async () => !(await r.view()).problems.some((p: any) => p.code === 'lease_steps'), 'the problem to go');
});

test('a Host that refuses the new lease says to look again, and a floor is carried from what was seen', async (t) => {
  const w = await world(t);
  // a lease above everything the app ever saw is refused by the Host, which is a reason to look again
  w.overrides.set('studio', (method) => {
    if (method === 'host.momoHomeStart') throw Object.assign(new Error('too far'), { code: 'floor_too_high' });
    return undefined;
  });
  assert.match((await w.intent({ kind: 'choose-home', machineId: 'studio' })).cause, /too far ahead/);
  w.overrides.delete('studio');
  assert.equal((await w.intent({ kind: 'choose-home', machineId: 'studio' })).ok, true);
  // an error that is not about the lease passes on in the Host's words
  const x = await world(t);
  x.overrides.set('studio', (method) => {
    if (method === 'host.momoHomeStart') throw Object.assign(new Error('Disk full.'), { code: 'disk_full' });
    return undefined;
  });
  assert.match((await x.intent({ kind: 'choose-home', machineId: 'studio' })).cause, /Disk full/);
  // what the app saw is the floor of a fresh start
  const y = await world(t, { second: true });
  y.saw({ homeId: 'gone', leaseEpoch: 7 });
  await y.real.refresh();
  assert.equal(y.stored.seen(), 7);
});

test('a step the tunnel dropped is run again with the next look, and a refusal with no code the app knows says the Host’s words', async (t) => {
  const w = await world(t, { second: true });
  await w.a.home.start(A);
  await w.b!.home.start(B);
  let calls = 0;
  w.overrides.set('studio', (method) => {
    if (method !== 'host.momoStandDown') return undefined;
    calls++;
    if (calls === 1) throw Object.assign(new Error('dropped'), { code: 'connection_closed' });
    if (calls === 2) throw Object.assign(new Error('odd'), { code: 'something_else' });
    return undefined;
  });
  await w.real.refresh();
  await waitFor(() => calls === 1, 'the first try');
  await w.real.refresh();
  await waitFor(() => calls === 2, 'the second try, because the first never reached the Host');
  await waitFor(async () => (await w.view()).problems.some((p: any) => p.code === 'lease_steps'), 'the refusal to be told');
  const cause = ((await w.view()).problems.find((p: any) => p.code === 'lease_steps') as any).cause;
  assert.match(cause, /odd/, 'the Host’s own words when it has no code the app knows');
});

test('MoMo moved to a machine that holds nothing: the view says so, nothing is started beside it, and Start fresh is the way out', async (t) => {
  const w = await world(t, { second: true });
  w.overrides.set('studio', (method) =>
    method === 'host.momoHomeLook'
      ? { holds: 'moved', leaseEpoch: 2, movedTo: { name: B.name, homeId: B.homeId, at: 1 }, grantLive: true }
      : undefined,
  );
  w.overrides.set('mini', (method) => (method === 'host.momoHomeLook' ? { holds: 'none', leaseEpoch: 0, grantLive: true } : undefined));
  const v = await w.view();
  const problem: any = v.problems.find((p: any) => p.code === 'home_moved');
  assert.match(problem.cause, /MoMo moved to Mac mini, and that machine doesn’t hold it/);
  assert.equal(problem.fix.id, 'start-fresh');
  assert.match((await w.intent({ kind: 'choose-home', machineId: 'mini' })).cause, /MoMo moved to Mac mini/);
  const asked = await w.intent({ kind: 'fix', id: 'start-fresh' });
  assert.equal((await w.intent({ kind: 'fix', id: asked.fix.id })).ok, true);
  assert.equal((await w.intent({ kind: 'choose-home', machineId: 'mini' })).ok, true);
  assert.equal(w.calls.filter((c) => c.method === 'host.momoHomeStart').at(-1)?.params.floor, 2, 'above the lease the tombstone kept');
});
