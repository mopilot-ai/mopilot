// The older MoMo a newer home replaced (shared/momoHomeOlder.mjs), on real in-process Hosts: the stand-down retires it with its data kept, the owner is told once with three ways on, and nothing that discards or hides a home with history runs without being asked first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { A, B, world } from './support/momoHomeRealWorld.ts';
import { waitFor } from './support/waitFor.ts';

/** MoMo on the Studio, started again on the Mini from another device: the Studio is retired and the Mini is the home. */
async function replaced(t: any) {
  const w = await world(t, { second: true });
  await w.intent({ kind: 'choose-home', machineId: 'studio' });
  await w.b!.home.start({ name: B.name, floor: 1 });
  await w.real.refresh();
  await waitFor(() => w.a.home.look().holds === 'retired', 'the Studio to be retired');
  await w.real.refresh();
  return w;
}
const older = async (w: any) => ((await w.view()).problems as any[]).find((p) => p.code === 'older_home');

test('the older MoMo is told once with three ways on, keeping the one in use is remembered, and it is not told again', async (t) => {
  const w = await replaced(t);
  const card = await older(w);
  assert.match(
    card.cause,
    /There are two MoMos: the one on Studio \(last active .*\) and the one on Mac mini \(last active .*\)\. You’re using the one on Mac mini\. The one on Studio is retired, with everything it knew kept\./,
  );
  assert.deepEqual(card.fix, { id: 'use-older:studio', label: 'Use the one on Studio' });
  assert.deepEqual(
    card.also.map((f: any) => f.label),
    ['Keep this one', 'Delete the old MoMo'],
  );
  assert.equal(w.a.home.look().holds, 'retired', 'its data is kept, not deleted');
  assert.equal((await w.intent({ kind: 'fix', id: 'keep-older:studio' })).ok, true);
  assert.equal(await older(w), undefined);
  assert.equal(w.stored.kept().length, 1);
  // a new run does not tell it again
  const again = w.restart();
  assert.equal(
    ((await again.api.view()) as any).view.problems.some((p: any) => p.code === 'older_home'),
    false,
  );
  // something that is not offered is refused
  assert.equal((await w.intent({ kind: 'fix', id: 'keep-older:mini' })).ok, false);
});

test('using the older MoMo is asked first, then it starts again above the live home, which stands down with its data kept', async (t) => {
  const w = await replaced(t);
  const asked = await w.intent({ kind: 'fix', id: 'use-older:studio' });
  assert.equal(asked.ok, false);
  assert.match(asked.cause, /Use the older MoMo on Studio\? .*The one on Mac mini is kept, not deleted\./);
  assert.match((await w.intent({ kind: 'fix', id: 'use-older!:guessed:studio' })).cause, /has to be asked first/);
  assert.equal(w.a.home.look().holds, 'retired', 'asking changed nothing');
  assert.equal((await w.intent({ kind: 'fix', id: asked.fix.id })).ok, true);
  assert.equal(w.a.home.look().holds, 'home');
  await waitFor(() => w.b!.home.look().holds === 'retired', 'the Mini to stand down');
  await waitFor(async () => (await w.view()).home.machineName === 'Studio', 'the view to follow');
  assert.match(((await older(w)) as any).cause, /the one on Mac mini \(last active .*\) and the one on Studio/);
});

test('deleting the old MoMo is asked first, says it cannot be undone, and resets that machine only', async (t) => {
  const w = await replaced(t);
  const asked = await w.intent({ kind: 'fix', id: 'delete-older:studio' });
  assert.match(
    asked.cause,
    /This deletes only the older MoMo on Studio \(last active .*\), everything it knew, and can’t be undone\. The MoMo on Mac mini is not affected\./,
  );
  assert.equal(w.a.home.look().holds, 'retired');
  assert.equal((await w.intent({ kind: 'fix', id: asked.fix.id })).ok, true);
  assert.equal(w.a.home.look().holds, 'none');
  assert.equal(await older(w), undefined);
  assert.equal((await w.view()).home.machineName, 'Mac mini');
});

test('a home that was mid-move when it was replaced says its move was replaced', async (t) => {
  const w = await world(t, { second: true });
  await w.intent({ kind: 'choose-home', machineId: 'studio' });
  const real = w.a.home.look();
  w.overrides.set('studio', (method) => (method === 'host.momoHomeLook' ? { ...real, state: 'moving' } : undefined));
  await w.b!.home.start({ name: B.name, floor: 1 });
  await w.real.refresh();
  await waitFor(() => w.a.home.look().holds === 'retired', 'the Studio to be retired');
  w.overrides.delete('studio');
  await w.real.refresh();
  await waitFor(async () => !!(await older(w)), 'the older MoMo to be told');
  assert.match(
    ((await older(w)) as any).cause,
    /^The move was replaced: MoMo was started again on Mac mini\. There are two MoMos: the one on Studio/,
  );
});

test('with no home in use an older MoMo offers no "keep", and Start fresh is the way when it is not wanted', async (t) => {
  const w = await replaced(t);
  w.down.add('mini');
  w.machines.splice(1, 1);
  await w.real.refresh();
  const card = await older(w);
  assert.deepEqual(
    card.also.map((f: any) => f.label),
    ['Delete the old MoMo'],
  );
  assert.doesNotMatch(card.cause, /You’re using/);
  assert.equal(A.name, 'Studio');
});

test('a delete is judged against the epoch the owner saw when it was asked, not a look made since, and a machine that has an older MoMo cannot be picked as the home', async (t) => {
  const w = await replaced(t);
  const asked = await w.intent({ kind: 'fix', id: 'delete-older:studio' });
  const seen = w.a.home.look();
  const sent: unknown[] = [];
  // the copy changed after the question was asked: it was started again and retired again at a higher epoch
  w.overrides.set('studio', (method, p) => {
    if (method === 'host.momoHomeLook') return { ...seen, leaseEpoch: seen.leaseEpoch + 3 };
    if (method === 'host.momoReset') {
      sent.push(p);
      throw Object.assign(new Error('changed'), { code: 'retired_changed' });
    }
    return undefined;
  });
  await w.real.refresh();
  const done = await w.intent({ kind: 'fix', id: asked.fix.id });
  assert.deepEqual(sent, [{ ifRetired: true, expectEpoch: seen.leaseEpoch }]);
  assert.match(done.cause, /taken back or changed/);
  // no home is in use and the machine with the older MoMo is picked as the place for a new one: told why, nothing is started
  w.overrides.delete('studio');
  w.down.add('mini');
  w.machines.splice(1, 1);
  await w.real.refresh();
  assert.match(
    (await w.intent({ kind: 'choose-home', machineId: 'studio' })).cause,
    /Studio still has an older MoMo\. Use it or delete it first\./,
  );
});

test('the older MoMo is worded without a home in use, without times the Host did not say, and a revive the Host refuses says why', async (t) => {
  const w = await replaced(t);
  // the retirement carries no time and the older MoMo no last-active time; the home in use cannot give its status, so no time of its own
  const real = w.a.home.look();
  w.overrides.set('studio', (method) =>
    method === 'host.momoHomeLook'
      ? { ...real, lastActive: undefined, movedTo: { name: real.movedTo.name, homeId: real.movedTo.homeId } }
      : undefined,
  );
  w.overrides.set('mini', (method) => {
    if (method === 'host.momoStatus') throw new Error('veiled');
    return undefined;
  });
  w.clock.at += 10_000;
  await w.real.refresh();
  const card = await older(w);
  assert.match(card.cause, /There are two MoMos: the one on Studio and the one on Mac mini\. You’re using the one on Mac mini\./);
  assert.equal((await w.intent({ kind: 'fix', id: 'keep-older:studio' })).ok, true);
  assert.equal(w.stored.kept()[0].endsWith(':0'), true, 'a retirement with no time is kept by its home and a zero');
  // the home in use goes away: there is no "keep", and each question is worded without it
  w.down.add('mini');
  w.machines.splice(1, 1);
  w.overrides.delete('mini');
  w.overrides.set('studio', (method) =>
    method === 'host.momoHomeStart' ? Promise.reject(Object.assign(new Error('The lease is refused.'), { code: 'nope' })) : undefined,
  );
  await w.intent({ kind: 'fix', id: 'check-again' });
  const use = await w.intent({ kind: 'fix', id: 'use-older:studio' });
  assert.doesNotMatch(use.cause, /is kept, not deleted/);
  assert.match((await w.intent({ kind: 'fix', id: use.fix.id })).cause, /The lease is refused\./);
  const del = await w.intent({ kind: 'fix', id: 'delete-older:studio' });
  assert.doesNotMatch(del.cause, /is not affected/);
});

test('a move that was replaced is said to the owner even when the machine in use has since gone', async (t) => {
  const w = await world(t, { second: true });
  await w.intent({ kind: 'choose-home', machineId: 'studio' });
  const real = w.a.home.look();
  w.overrides.set('studio', (method) => (method === 'host.momoHomeLook' ? { ...real, state: 'moving' } : undefined));
  await w.b!.home.start({ name: B.name, floor: 1 });
  await w.real.refresh();
  await waitFor(() => w.a.home.look().holds === 'retired', 'the Studio to be retired');
  w.overrides.delete('studio');
  w.down.add('mini');
  w.machines.splice(1, 1);
  w.clock.at += 10_000;
  await w.real.refresh();
  const card = await older(w);
  assert.doesNotMatch(card.cause, /The move was replaced/, 'with no home in use there is no one it was replaced by');
});

test('another machine cannot be picked while one keeps an older MoMo', async (t) => {
  const w = await replaced(t);
  w.down.add('mini');
  w.machines[1] = { ...w.machines[1], id: 'third', name: 'Third' } as any;
  // a newly installed app has no note of where MoMo lived
  w.wipe();
  w.restart();
  w.clock.at += 10_000;
  await w.real.refresh();
  assert.match(
    (await w.intent({ kind: 'choose-home', machineId: 'third' })).cause,
    /Studio still has an older MoMo\. Use it or delete it first\./,
  );
});

test('a delete or a revive that was never asked is refused whatever its token, and a repeat after the copy was revived elsewhere deletes nothing', async (t) => {
  const w = await replaced(t);
  for (const id of ['delete-older!:never-asked:studio', 'use-older!:never-asked:studio'])
    assert.match((await w.intent({ kind: 'fix', id })).cause, /has to be asked first/);
  assert.equal(w.a.home.look().holds, 'retired', 'nothing was done');
  // asked, then the older MoMo is taken back and retired again elsewhere: the repeat is judged at the epoch the owner saw
  const asked = await w.intent({ kind: 'fix', id: 'delete-older:studio' });
  const seen = w.a.home.look();
  w.overrides.set('studio', (method) => (method === 'host.momoHomeLook' ? { ...seen, leaseEpoch: seen.leaseEpoch + 2 } : undefined));
  const sent: unknown[] = [];
  w.overrides.set('studio', (method, p) => {
    if (method === 'host.momoHomeLook') return { ...seen, leaseEpoch: seen.leaseEpoch + 2 };
    if (method === 'host.momoReset') {
      sent.push(p);
      throw Object.assign(new Error('changed'), { code: 'retired_changed' });
    }
    return undefined;
  });
  assert.match((await w.intent({ kind: 'fix', id: asked.fix.id })).cause, /taken back or changed, so nothing was deleted/);
  assert.deepEqual(sent, [{ ifRetired: true, expectEpoch: seen.leaseEpoch }]);
  assert.equal(w.a.home.look().holds, 'retired');
});
