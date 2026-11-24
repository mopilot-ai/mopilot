// The ways out of "MoMo may live somewhere I cannot hear", and the held and refused rounds of the shared rules, on real in-process Hosts (shared/momoHomeReal.mjs): after a confirmed Start fresh the owner PICKS the machine in the view; a move in progress blocks a new lease; a step a Host did not know is said and tried again; a kept older MoMo is told again when it is retired again; a delete that finds the copy changed deletes nothing; a machine with a retired copy is not a move target.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { A, B, world } from './support/momoHomeRealWorld.ts';
import { waitFor } from './support/waitFor.ts';

test('after the owner confirms Start fresh the view asks where MoMo should live, for an unheard machine and for a tombstone, and the pick goes through', async (t) => {
  const w = await world(t, { second: true });
  w.down.add('studio');
  const before = await w.view();
  assert.ok(before.problems.some((p: any) => p.code === 'home_unheard'));
  assert.notEqual(before.setup.step, 'where');
  const asked = await w.intent({ kind: 'fix', id: 'start-fresh' });
  assert.match(asked.cause, /Messages you sent to the old MoMo are no longer shown here\./);
  assert.equal((await w.intent({ kind: 'fix', id: asked.fix.id })).ok, true);
  const after = await w.view();
  assert.equal(after.setup.step, 'where', 'the owner can pick a machine');
  assert.equal(
    after.problems.some((p: any) => p.code === 'home_unheard'),
    false,
    'and the card does not come back',
  );
  assert.equal((await w.intent({ kind: 'choose-home', machineId: 'mini' })).ok, true);
  assert.equal((await w.view()).home.machineName, 'Mac mini');
  // a tombstone that names a home nobody holds: the same way out
  const m = await world(t, { second: true });
  m.overrides.set('studio', (method) =>
    method === 'host.momoHomeLook'
      ? { holds: 'moved', leaseEpoch: 2, movedTo: { name: B.name, homeId: B.homeId, at: 1 }, grantLive: true }
      : undefined,
  );
  m.overrides.set('mini', (method) => (method === 'host.momoHomeLook' ? { holds: 'none', leaseEpoch: 0, grantLive: true } : undefined));
  const ask = await m.intent({ kind: 'fix', id: 'start-fresh' });
  await m.intent({ kind: 'fix', id: ask.fix.id });
  assert.equal((await m.view()).setup.step, 'where');
});

test('a winner that is moving is never given a new lease under its move: nothing runs, and the view says so', async (t) => {
  const w = await world(t, { second: true });
  await w.a.home.start(A);
  await w.b!.home.start(B);
  const real = w.b!.home.look();
  w.overrides.set('mini', (method) => (method === 'host.momoHomeLook' ? { ...real, state: 'moving' } : undefined));
  await w.real.refresh();
  const v = await w.view();
  assert.match(
    (v.problems.find((p: any) => p.code === 'move_in_progress') as any).cause,
    /MoMo is being moved; nothing was changed until it ends\./,
  );
  assert.equal(
    w.calls.some((c) => c.method === 'host.momoStandDown' || c.method === 'host.momoHomeStart'),
    false,
  );
});

test('a Host that does not know a step is said, and the step is tried again after a while', async (t) => {
  const w = await world(t, { second: true });
  await w.a.home.start(A);
  await w.b!.home.start({ name: B.name, floor: 1 });
  let tries = 0;
  w.overrides.set('studio', (method) => {
    if (method !== 'host.momoStandDown') return undefined;
    tries++;
    if (tries === 1) throw Object.assign(new Error('Unknown request: host.momoStandDown'), { code: 'unknown_request' });
    return undefined;
  });
  await w.real.refresh();
  await waitFor(async () => (await w.view()).problems.some((p: any) => /did not take the next step/.test(p.cause)), 'the card');
  await w.real.refresh();
  assert.equal(tries, 1, 'not again at once');
  w.clock.at += 61_000;
  await w.real.refresh();
  await waitFor(() => tries >= 2, 'the step to be tried again');
});

test('an older MoMo the owner kept is told again when its machine is retired again, a delete that finds it changed deletes nothing, and a machine that has one is not a move target', async (t) => {
  const w = await world(t, { second: true });
  await w.intent({ kind: 'choose-home', machineId: 'studio' });
  await w.b!.home.start({ name: B.name, floor: 1 });
  await w.real.refresh();
  await waitFor(() => w.a.home.look().holds === 'retired', 'the Studio to be retired');
  await w.real.refresh();
  assert.equal((await w.intent({ kind: 'fix', id: 'keep-older:studio' })).ok, true);
  assert.equal(
    ((await w.view()).problems as any[]).some((p) => p.code === 'older_home'),
    false,
  );
  // retired again later: another time on the same machine, told again
  const real = w.a.home.look();
  w.overrides.set('studio', (method) =>
    method === 'host.momoHomeLook' ? { ...real, movedTo: { ...real.movedTo, at: real.movedTo.at + 5 } } : undefined,
  );
  await w.real.refresh();
  assert.equal(
    ((await w.view()).problems as any[]).some((p) => p.code === 'older_home'),
    true,
  );
  // a delete says what it deletes, only when still retired at the epoch seen, and nothing is deleted when it changed
  w.overrides.set('studio', (method, p) => {
    if (method === 'host.momoHomeLook') return { ...real, movedTo: { ...real.movedTo, at: real.movedTo.at + 5 } };
    if (method === 'host.momoReset') {
      assert.deepEqual(p, { ifRetired: true, expectEpoch: real.leaseEpoch });
      throw Object.assign(new Error('changed'), { code: 'retired_changed' });
    }
    return undefined;
  });
  const asked = await w.intent({ kind: 'fix', id: 'delete-older:studio' });
  const done = await w.intent({ kind: 'fix', id: asked.fix.id });
  assert.match(done.cause, /was taken back or changed, so nothing was deleted/);
  assert.equal(w.a.home.look().holds, 'retired');
  // another failure of the delete passes in the Host's words
  w.overrides.set('studio', (method) => {
    if (method === 'host.momoHomeLook') return { ...real, movedTo: { ...real.movedTo, at: real.movedTo.at + 5 } };
    if (method === 'host.momoReset') throw Object.assign(new Error('Disk full.'), { code: 'disk_full' });
    return undefined;
  });
  const again = await w.intent({ kind: 'fix', id: 'delete-older:studio' });
  assert.match((await w.intent({ kind: 'fix', id: again.fix.id })).cause, /Disk full/);
  // a move to the machine that keeps one is refused in words
  assert.match((await w.intent({ kind: 'move', toId: 'studio' })).cause, /Studio still has an older MoMo\. Use it or delete it first\./);
});
