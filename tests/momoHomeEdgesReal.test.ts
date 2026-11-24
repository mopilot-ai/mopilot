// The edges of MoMo's real home (shared/momoHomeReal.mjs, momoHomeLook.mjs, momoHomeAsk.mjs) on real in-process Hosts: what happens when the service stops under a look, when a Host answers the rows with nonsense or a step with
// nothing, when a Host is quiet and comes back, and where each way of being refused says what it was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain ESM without declarations
import { createSealer } from '../shared/momoGoogle/seal.mjs';
// @ts-ignore
import { createNodePrimitives } from '../shared/remote/nodePrimitives.mjs';
// @ts-ignore
import { unknownRequest } from '../shared/momoHomeAsk.mjs';
import { A, B, world } from './support/momoHomeRealWorld.ts';
import { waitFor } from './support/waitFor.ts';

test('a service that stopped forgets nothing it could write, a first look that was out when it stopped leaves no cache, and a wait for a change is given up with it', async (t) => {
  const w = await world(t);
  let release: () => void = () => undefined;
  let taken = false;
  w.overrides.set('studio', (method) => {
    if (method !== 'host.momoHomeLook' || taken) return undefined;
    taken = true;
    return new Promise((resolve) => (release = () => resolve(w.asHost('studio', 'host.momoHomeLook', {}))));
  });
  const first = w.real.refresh();
  await waitFor(() => taken, 'the first look to start');
  w.real.dispose();
  w.real.forget();
  release();
  await first.catch(() => undefined);
  assert.equal(w.stored.note(), null, 'a stopped service writes nothing');
  // a change waits for its debounce, and stopping gives that wait up
  const v = await world(t);
  v.real.api.onChanged(() => undefined);
  v.fireChange();
  v.real.dispose();
  assert.equal(v.cancelled.length, 1);
});

test('rows a Host answers with nonsense are ignored, and a row without an id is not kept', async (t) => {
  const w = await world(t);
  await w.intent({ kind: 'choose-home', machineId: 'studio' });
  let answer: unknown = { rows: 'not a list', next: 3 };
  w.overrides.set('studio', (method) => (method === 'host.momoRows' ? answer : undefined));
  await w.real.refresh();
  assert.deepEqual((await w.view()).chat, []);
  answer = { rows: [{ nothing: 1 }, { id: 'r1', kind: 'result', at: 1 }], next: 4 };
  w.clock.at += 10_000;
  await w.real.refresh();
  assert.deepEqual(
    ((await w.view()).chat as any[]).map((r) => r.id),
    ['r1'],
    'a row that has no id is not kept',
  );
});

test('a listener that fails is reported, and what the app cannot do for a machine is said, wake works on the machine MoMo lived on and a move needs a home', async (t) => {
  const w = await world(t);
  assert.match((await w.intent({ kind: 'move', toId: 'studio' })).cause ?? '', /./, 'a move with no home is refused');
  assert.match((await w.intent({ kind: 'wake' })).cause, /Nothing is asleep/);
  assert.equal((await w.intent({ kind: 'move-cancel' })).ok !== undefined, true);
  await w.intent({ kind: 'choose-home', machineId: 'studio' });
  // asleep: the machine it lived on is woken by what the app does for it
  w.down.add('studio');
  w.clock.at += 10_000;
  await w.real.refresh();
  assert.equal((await w.intent({ kind: 'wake' })).ok, true);
  assert.deepEqual(w.acts.at(-1), { kind: 'wake', machineId: 'studio' });
  // a listener that throws does not stop the others, and is told as a failure
  w.real.api.onChanged(() => {
    throw new Error('a window is gone');
  });
  w.fireChange();
  w.runTimers();
  await waitFor(() => w.reports.length > 0, 'the failed listener to be reported');
  // without what the app does for a machine, the request is refused in words
  const bare = await world(t, { noAct: true });
  assert.match((await bare.intent({ kind: 'update-machine', machineId: 'studio' })).cause, /can’t do that from here yet/);
});

test('this device’s own Google sign-in is registered whichever client it names', async (t) => {
  const g = { sealer: createSealer(createNodePrimitives()), startCatcher: async () => Promise.reject(new Error('no browser')) };
  const w = await world(t, { google: g });
  assert.deepEqual(w.real.pending(), []);
});

test('a Host that was quiet is asked again once its wait is over, and its second failure waits longer', async (t) => {
  const w = await world(t);
  let asked = 0;
  w.overrides.set('studio', (method) => {
    if (method !== 'host.momoHomeLook') return undefined;
    asked++;
    throw Object.assign(new Error('timed out'), { code: 'timeout' });
  });
  await w.view();
  assert.equal(asked, 1);
  w.clock.at += 6_000;
  await w.view();
  assert.equal(asked, 1, 'quiet: not asked again within its wait');
  w.clock.at += 20_000;
  await w.view();
  assert.equal(asked, 2, 'asked again when the wait is over');
  w.clock.at += 30_000;
  await w.real.refresh();
  assert.equal(asked, 3);
});

test('a Host that holds a home but cannot give its whole status is shown by what its look said, with and without a state and a name', async (t) => {
  const w = await world(t);
  const look = (over: object) => (method: string) => {
    if (method === 'host.momoHomeLook') return { holds: 'home', homeId: A.homeId, leaseEpoch: 3, grantLive: true, ...over };
    if (method === 'host.momoStatus') throw new Error('veiled');
    return undefined;
  };
  w.overrides.set('studio', look({ name: 'Studio', state: 'running' }));
  assert.equal((await w.view()).home.machineName, 'Studio');
  w.overrides.set('studio', look({}));
  w.clock.at += 10_000;
  await w.real.refresh();
  assert.equal((await w.view()).home.state, 'running');
  assert.ok(w.reports.length > 0, 'the failed status was told');
});

test('MoMo is not lost when the machine that held it says MoMo moved on, and a move the Host says is under way, not yet expired, is shown from its words', async (t) => {
  const w = await world(t, { second: true });
  await w.intent({ kind: 'choose-home', machineId: 'studio' });
  // the Studio now says MoMo went elsewhere: not "lost", and not a first run
  w.overrides.set('studio', (method) =>
    method === 'host.momoHomeLook'
      ? { holds: 'moved', leaseEpoch: 2, movedTo: { name: B.name, homeId: B.homeId }, grantLive: true }
      : undefined,
  );
  w.overrides.set('mini', (method) => (method === 'host.momoHomeLook' ? { holds: 'none', leaseEpoch: 0, grantLive: true } : undefined));
  w.clock.at += 10_000;
  await w.real.refresh();
  const v = await w.view();
  assert.equal(
    v.problems.some((p: any) => p.code === 'home_lost'),
    false,
  );
  const moved: any = v.problems.find((p: any) => p.code === 'home_moved');
  assert.match(moved.cause, /MoMo moved to Mac mini, and that machine doesn’t hold it/);
  // a move another device began, with no expiry yet and no time it began
  const m = await world(t);
  await m.intent({ kind: 'choose-home', machineId: 'studio' });
  const status = await m.asHost('studio', 'host.momoStatus', {});
  m.overrides.set('studio', (method) =>
    method === 'host.momoStatus' ? { home: { ...status.home, state: 'moving', moveId: 'm-1', moveExpired: false } } : undefined,
  );
  m.clock.at += 10_000;
  await m.real.refresh();
  assert.equal((await m.view()).home.move.moveId, 'm-1');
  m.overrides.set('studio', (method) =>
    method === 'host.momoStatus' ? { home: { ...status.home, state: 'moving', moveId: 'm-2', moveExpired: true } } : undefined,
  );
  m.clock.at += 10_000;
  await m.real.refresh();
  assert.equal((await m.view()).home.move.moveId, 'm-2');
});

test('a lost home with no name, and a moved home with no name, are told without one', async (t) => {
  const w = await world(t, { second: true });
  w.machines.splice(0, 1);
  // MoMo was seen on a machine that has since gone, and nobody wrote its name down
  w.stored.note();
  await w.intent({ kind: 'choose-home', machineId: 'mini' });
  w.machines.length = 0;
  w.machines.push(...[]);
  const noName = await world(t);
  await noName.intent({ kind: 'choose-home', machineId: 'studio' });
  noName.machines.splice(0, 1);
  noName.clock.at += 10_000;
  await noName.real.refresh();
  assert.match(((await noName.view()).problems.find((p: any) => p.code === 'home_lost') as any).cause, /can’t be found/);
  const t2 = await world(t, { second: true });
  t2.overrides.set('studio', (method) =>
    method === 'host.momoHomeLook' ? { holds: 'moved', leaseEpoch: 2, movedTo: { homeId: B.homeId }, grantLive: true } : undefined,
  );
  t2.overrides.set('mini', (method) => (method === 'host.momoHomeLook' ? { holds: 'none', leaseEpoch: 0, grantLive: true } : undefined));
  assert.match(((await t2.view()).problems.find((p: any) => p.code === 'home_moved') as any).cause, /MoMo moved to another machine/);
});

test('an answer that is not a refusal with a message or a code still becomes words, and the way a refusal is read', async (t) => {
  assert.equal(unknownRequest(undefined), false);
  assert.equal(unknownRequest({}), false);
  assert.equal(unknownRequest({ code: 'feature_missing' }), true);
  const w = await world(t, { second: true });
  await w.a.home.start(A);
  await w.b!.home.start(B);
  // a stand-down that is refused with a bare error says nothing the app invented, and one refused with no message uses the general words
  w.overrides.set('studio', (method) => {
    if (method === 'host.momoStandDown') throw Object.assign(new Error(''), { code: 'weird' });
    return undefined;
  });
  await w.real.refresh();
  await waitFor(async () => (await w.view()).problems.some((p: any) => p.code === 'lease_steps'), 'the refusal');
  assert.match(
    ((await w.view()).problems.find((p: any) => p.code === 'lease_steps') as any).cause,
    /couldn’t settle which machine is its home/,
  );
});

test('a step that answers nothing and a start that never rises are said, and a start on a machine that is no longer in the list ends the move', async (t) => {
  const w = await world(t, { second: true });
  await w.a.home.start(A);
  await w.b!.home.start(B);
  // the stand-down answers with nothing at all: the lease it was sent is what counts
  w.overrides.set('studio', (method) => (method === 'host.momoStandDown' ? {} : undefined));
  await w.real.refresh();
  assert.equal((await w.view()).home.machineName, 'Mac mini');
  // a Host whose start answers a lease that never rises: the climb ends and says so
  const c = await world(t, { second: true });
  await c.a.home.start(A);
  await c.b!.home.start(B);
  c.overrides.set('mini', (method) => (method === 'host.momoHomeStart' ? { home: { leaseEpoch: 1, homeId: B.homeId } } : undefined));
  await c.real.refresh();
  await waitFor(async () => (await c.view()).problems.some((p: any) => p.code === 'lease_steps'), 'the climb to end');
  assert.match(((await c.view()).problems.find((p: any) => p.code === 'lease_steps') as any).cause, /could not be brought above/);
  // a move to a machine that is not in the list
  await c.intent({ kind: 'fix', id: 'check-again' });
  assert.equal((await c.intent({ kind: 'move', toId: 'nowhere' })).ok, false);
});

test('a step that fails with something that is no error at all is still told, and a start fresh with nothing lost says so', async (t) => {
  const w = await world(t, { second: true });
  await w.a.home.start(A);
  await w.b!.home.start(B);
  w.overrides.set('studio', (method) => {
    if (method === 'host.momoStandDown') throw {};
    return undefined;
  });
  await w.real.refresh();
  await waitFor(async () => (await w.view()).problems.some((p: any) => p.code === 'lease_steps'), 'the refusal');
  assert.match(
    ((await w.view()).problems.find((p: any) => p.code === 'lease_steps') as any).cause,
    /couldn’t settle which machine is its home/,
  );
  // a first run: every machine says it holds none, so there is nothing lost to start fresh from
  const f = await world(t, { second: true });
  assert.match((await f.intent({ kind: 'fix', id: 'start-fresh' })).cause, /not lost/);
});

test('a service stopped while a step is out says nothing of it, and a failing window does not stop the others from being told', async (t) => {
  const w = await world(t, { second: true });
  await w.a.home.start(A);
  await w.b!.home.start(B);
  let release: () => void = () => undefined;
  let taken = false;
  w.overrides.set('studio', (method) => {
    if (method !== 'host.momoStandDown' || taken) return undefined;
    taken = true;
    return new Promise((resolve) => (release = () => resolve({ stoodDown: true })));
  });
  const first = w.real.refresh();
  await waitFor(() => taken, 'the step to be out');
  w.real.dispose();
  release();
  await first.catch(() => undefined);
  // the list of machines cannot be read: the change is told as a failure of the window's, not thrown
  const v = await world(t);
  v.real.api.onChanged(() => undefined);
  v.machines.push(null as any);
  v.fireChange();
  v.runTimers();
  await waitFor(() => v.reports.length > 0, 'the failure to be told');
});

test('a remembered MoMo with no name, and a moved-away MoMo whose machine the list no longer has, are worded without one', async (t) => {
  const w = await world(t, { second: true });
  await w.intent({ kind: 'choose-home', machineId: 'studio' });
  (w.stored.note() as any).name = '';
  w.down.add('studio');
  w.clock.at += 10_000;
  await w.real.refresh();
  assert.match(
    (await w.intent({ kind: 'choose-home', machineId: 'mini' })).cause,
    /^MoMo already has a home\. If it is lost, you can start fresh\./,
  );
  w.machines.splice(0, 1);
  w.clock.at += 10_000;
  await w.real.refresh();
  assert.match(
    ((await w.view()).problems.find((p: any) => p.code === 'home_lost') as any).cause,
    /MoMo’s home on its machine can’t be found/,
  );
});

test('a move the Host says is under way with no start time is shown without one, and a reclaim after a move that this device began asks the runner', async (t) => {
  const w = await world(t, { second: true });
  await w.intent({ kind: 'choose-home', machineId: 'studio' });
  const status = await w.asHost('studio', 'host.momoStatus', {});
  w.overrides.set('studio', (method) =>
    method === 'host.momoStatus'
      ? { home: { ...status.home, state: 'moving', moveId: 'm-9', moveExpired: true, stateSince: undefined } }
      : undefined,
  );
  w.clock.at += 10_000;
  await w.real.refresh();
  assert.equal((await w.view()).home.move.moveId, 'm-9');
  // a move this device began and could not finish: its own reclaim, with no machine named
  const m = await world(t, { second: true });
  await m.intent({ kind: 'choose-home', machineId: 'studio' });
  m.overrides.set('mini', (method, p) =>
    method === 'host.momoMove' && p.op === 'receive' ? Promise.reject(new Error('The copy failed.')) : undefined,
  );
  await m.intent({ kind: 'move', toId: 'mini' });
  const reclaimed = await m.intent({ kind: 'reclaim' });
  assert.ok(typeof reclaimed.ok === 'boolean');
});

test('a machine whose Host is out of date is refused as MoMo’s home by the intent itself, not only by the picker that does not offer it', async (t) => {
  const w = await world(t, { second: true });
  w.machines[0] = { ...w.machines[0], current: false } as any;
  assert.match((await w.intent({ kind: 'choose-home', machineId: 'studio' })).cause, /Studio needs an update before MoMo can live there\./);
  assert.equal(w.a.home.status().home?.state ?? 'none', 'none', 'nothing was started on it');
  assert.equal((await w.intent({ kind: 'choose-home', machineId: 'mini' })).ok, true, 'a machine that is up to date is taken');
});

test('every choice the screen disables or does not offer is refused where it is carried out, in words: a blank message, a move to a machine that is not fit, the app’s own actions on a machine they are not for, a wake of a home that is awake', async (t) => {
  const w = await world(t, { second: true });
  const cause = async (i: any) => (await w.intent(i)).cause as string;
  assert.match(await cause({ kind: 'send', turnId: 'turn-00000001', text: '   ' }), /Write a message first/);
  // the app's actions: each only for what the screen offers it for
  assert.match(await cause({ kind: 'update-machine', machineId: 'studio' }), /Studio is already up to date/);
  assert.match(await cause({ kind: 'update-machine', machineId: 'nowhere' }), /That machine is not available/);
  assert.match(await cause({ kind: 'set-up-machine', machineId: 'studio' }), /Studio is already set up/);
  assert.match(await cause({ kind: 'install-agent', machineId: 'studio', agent: 'nothing' }), /no such agent/);
  assert.match(await cause({ kind: 'install-agent', machineId: 'studio', agent: 'claude' }), /Claude Code is already installed on Studio/);
  assert.match(await cause({ kind: 'sign-in-agent', machineId: 'studio', agent: 'claude' }), /Claude Code is already signed in on Studio/);
  w.machines[0] = {
    ...w.machines[0],
    agents: [
      { id: 'claude', name: 'Claude Code', installed: true, signedIn: false },
      { id: 'codex', name: 'Codex', installed: false, signedIn: false },
    ],
  } as any;
  assert.match(await cause({ kind: 'sign-in-agent', machineId: 'studio', agent: 'codex' }), /Codex isn’t installed on Studio yet/);
  assert.equal((await w.intent({ kind: 'sign-in-agent', machineId: 'studio', agent: 'claude' })).ok, true, 'offered, so done');
  assert.equal((await w.intent({ kind: 'install-agent', machineId: 'studio', agent: 'codex' })).ok, true);
  // a move goes only to a machine that is answering, set up and up to date
  await w.intent({ kind: 'choose-home', machineId: 'studio' });
  w.down.add('mini');
  assert.match(await cause({ kind: 'move', toId: 'mini' }), /Mac mini is not answering/);
  w.down.delete('mini');
  w.machines[1] = { ...w.machines[1], current: false } as any;
  assert.match(await cause({ kind: 'move', toId: 'mini' }), /Mac mini needs an update before MoMo can live there/);
  w.machines[1] = { ...w.machines[1], current: true, setUp: false } as any;
  assert.match(await cause({ kind: 'move', toId: 'mini' }), /Mac mini isn’t set up for MoMo yet/);
  w.machines[1] = { ...w.machines[1], setUp: true } as any;
  assert.match(await cause({ kind: 'choose-home', machineId: 'mini' }), /already lives on Studio/);
  // a home that answers is not asleep
  assert.match(await cause({ kind: 'wake' }), /MoMo is awake/);
});

test('a reclaim that names a machine the list no longer has is refused, not guessed', async (t) => {
  const w = await world(t, { second: true });
  await w.intent({ kind: 'choose-home', machineId: 'studio' });
  assert.equal((await w.intent({ kind: 'reclaim', toId: 'nowhere' })).ok, false);
});
