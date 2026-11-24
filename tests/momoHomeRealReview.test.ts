// MoMo's real home against real in-process Hosts, the cases a review found (shared/momoHomeReal.mjs, momoHomeLook.mjs, momoHomeMail.mjs): the app is closed and opened again with the home asleep, two Hosts hold the home, a Host answers below what was seen, reads finish out of order, a Host hangs, held messages wait and go in order and are never sent blind, a burst of heartbeats is one look, and a move left paused is settled from a new app. Each starts from what a real Host says, not from a status a real Host would never send.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain ESM without declarations
import { moveHome } from '../shared/momoMove.mjs';
import { A, B, world } from './support/momoHomeRealWorld.ts';
import { waitFor } from './support/waitFor.ts';

const settled = (w: any) => async () => {
  await w.real.refresh();
  const m = (await w.view()).home.move;
  return !!m && m.outcome !== 'running';
};
async function homeOnStudio(t: any, opts: any = {}) {
  const w = await world(t, { second: true, ...opts });
  assert.equal((await w.intent({ kind: 'choose-home', machineId: 'studio' })).ok, true);
  return w;
}

test('the app restarts with the home asleep: MoMo is asleep on its machine, never a first run, and no second home can be chosen beside it', async (t) => {
  const w = await homeOnStudio(t);
  w.restart();
  w.down.add('studio');
  w.clock.at += 10 * 60_000;
  const v = await w.view();
  assert.equal(v.home.state, 'asleep');
  assert.equal(v.home.machineName, 'Studio');
  assert.notEqual(v.setup.step, 'where');
  const r = await w.intent({ kind: 'choose-home', machineId: 'mini' });
  assert.equal(r.ok, false);
  assert.match(r.cause, /already has a home, Studio/);
  assert.equal(w.b!.home.status().home?.state ?? 'none', 'none', 'the other Host was not started');
  // every row offline before the first heartbeat: still asleep, not a first run
  w.restart();
  w.down.add('mini');
  assert.equal((await w.view()).setup.step === 'where', false);
});

test('a new app that has never heard from the machine MoMo lives on does not offer the first-run choice, and does not start a home beside it', async (t) => {
  const w = await world(t, { second: true });
  // the home was made from another device: this app never saw it
  await w.a.home.start(A);
  w.down.add('studio');
  const v = await w.view();
  assert.equal(v.home.state, 'asleep');
  assert.notEqual(v.setup.step, 'where');
  const r = await w.intent({ kind: 'choose-home', machineId: 'mini' });
  assert.equal(r.ok, false);
  assert.match(r.cause, /Studio did not answer, and MoMo may live there/);
  assert.equal(w.b!.home.status().home?.state ?? 'none', 'none');
});

test('MoMo moved and the new home sleeps: a new app remembers it asleep; one that never knew sees where MoMo went and starts nothing beside it', async (t) => {
  const w = await homeOnStudio(t);
  await w.intent({ kind: 'move', toId: 'mini' });
  await waitFor(settled(w), 'the move ends');
  await w.intent({ kind: 'move-ack' });
  // this app closes; the new home's machine goes to sleep
  w.restart();
  w.down.add('mini');
  const kept = await w.view();
  assert.equal(kept.home.state, 'asleep');
  assert.equal(kept.home.machineName, 'Mac mini', 'the tombstone of the old home does not override what is remembered');
  // a freshly installed app only has the old home's tombstone to go by
  w.wipe();
  w.restart();
  const fresh = await w.view();
  assert.equal(fresh.home.movedAway?.machine.name, 'Mac mini');
  const r = await w.intent({ kind: 'choose-home', machineId: 'studio' });
  assert.equal(r.ok, false);
  assert.match(r.cause, /MoMo moved to Mac mini/);
});

test('a read that finishes after a newer one does not bring the old home back, and an intent after a move goes to the new home', async (t) => {
  const w = await homeOnStudio(t);
  const old = await w.asHost('studio', 'host.momoStatus', {});
  let gate: (v: unknown) => void = () => undefined;
  let held = false;
  w.overrides.set('studio', (method) => {
    if (method !== 'host.momoStatus' || held) return undefined;
    held = true;
    return new Promise((resolve) => (gate = () => resolve(old)));
  });
  w.overrides.set('mini', (method) => (method === 'host.momoLaneIntent' ? { ok: true, value: null } : undefined));
  const slow = w.real.refresh();
  await waitFor(() => held, 'the slow read to start');
  // MoMo moves while that read is out: the Hosts are driven directly, as another device would
  const done = await moveHome({ moveId: 'move-0001', from: w.a.side, to: w.b!.side, target: B, fromName: A.name });
  assert.equal(done.ok, true, JSON.stringify(done));
  w.machines[1] = { ...w.machines[1], current: false } as any;
  assert.equal((await w.intent({ kind: 'update-machine', machineId: 'mini' })).ok, true);
  gate(old);
  await slow;
  const v = await w.view();
  assert.equal(v.home.machineName, 'Mac mini');
  assert.equal(v.home.leaseEpoch, 2);
  assert.equal((await w.intent({ kind: 'task.stop', id: 't1' })).ok, true);
  const lanes = w.calls.filter((c) => c.method === 'host.momoLaneIntent').map((c) => c.id);
  assert.deepEqual(lanes, ['mini'], 'the lane intent went to the new home only');
});

test('a Host that hangs is "no answer" within its time: the view comes back, asleep on the machine it lived on', async (t) => {
  const w = await homeOnStudio(t, { timeouts: { status: 300, call: 600 } });
  w.restart();
  w.hung.add('studio');
  const t0 = Date.now();
  const v = await w.view();
  assert.ok(Date.now() - t0 < 1500, 'the view did not wait on the hung machine');
  assert.equal(v.home.state, 'asleep');
  assert.equal(v.home.machineName, 'Studio');
  // a send to it that does not answer may have arrived: it is "not sure", never sent again blind
  w.hung.delete('studio');
  const probe = await w.view();
  assert.equal(probe.home.state, 'asleep', 'the machine that hung is asked again later, not at once');
});

test('a burst of heartbeats is one look and tells the windows only when the view changed, and nothing is looked at when nobody listens', async (t) => {
  const w = await homeOnStudio(t);
  w.real.api.methods['momo.home.view']({});
  const heard: unknown[] = [];
  // nobody listens yet: a heartbeat is not even looked at
  for (let i = 0; i < 5; i++) w.fireChange();
  assert.equal(w.runTimers(), 0, 'no listener, no timer');
  const stop = w.real.api.onChanged((p: unknown) => void heard.push(p));
  for (let i = 0; i < 5; i++) w.fireChange();
  assert.equal(w.runTimers(), 1, 'a burst waits for one timer');
  await waitFor(() => heard.length >= 1, 'the first look to be told');
  const first = heard.length;
  for (let i = 0; i < 5; i++) w.fireChange();
  w.runTimers();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(heard.length, first, 'a heartbeat that changed nothing tells no one');
  w.down.add('studio');
  w.clock.at += 10 * 60_000;
  w.fireChange();
  w.runTimers();
  await waitFor(() => heard.length > first, 'the change to be told');
  assert.equal(heard.length, first + 1);
  stop();
});

test('a move left paused is settled from a new app: the view shows it from the Host’s status and Reclaim runs MoMo on the old machine again', async (t) => {
  const w = await homeOnStudio(t);
  let lost = true;
  w.overrides.set('mini', (method, p) =>
    lost && method === 'host.momoMove' && p.op !== 'offer' ? Promise.reject(new Error('Mac mini stopped answering.')) : undefined,
  );
  w.overrides.set('studio', (method, p) =>
    lost && method === 'host.momoMove' && p.op === 'cancel' ? Promise.reject(new Error('The link dropped.')) : undefined,
  );
  await w.intent({ kind: 'move', toId: 'mini' });
  await waitFor(settled(w), 'the move fails');
  assert.equal(w.a.home.status().home.state, 'moving');
  // the app is closed and opened again, after the move's time has run out
  w.restart();
  w.a.clock.at += 24 * 3_600_000;
  lost = false;
  w.overrides.clear();
  await w.real.refresh();
  const v = await w.view();
  assert.equal(v.home.state, 'moving');
  assert.equal(v.home.move.outcome, 'failed');
  assert.ok(v.home.move.reclaim, 'the Host says it is paused past its time: the owner may reclaim it');
  assert.match(v.home.move.failure.cause, /paused on Studio/);
  const r = await w.intent({ kind: 'reclaim', moveId: v.home.move.moveId, toId: '' });
  assert.equal(r.ok, true, JSON.stringify(r));
  await w.real.refresh();
  const after = await w.view();
  assert.equal(after.home.state, 'running');
  assert.equal(after.home.machineName, 'Studio');
});

test('a machine row that does not know its Host’s id is still the home when that Host says it is, not asleep forever', async (t) => {
  const w = await world(t);
  (w.machines[0] as any).hostId = undefined;
  assert.equal((await w.intent({ kind: 'choose-home', machineId: 'studio' })).ok, true);
  await w.real.refresh();
  const v = await w.view();
  assert.equal(v.home.state, 'running');
  assert.deepEqual(
    v.home.machines.map((m: any) => [m.machineId, m.isHome]),
    [['studio', true]],
  );
});

test('a read that was out when the service stopped or MoMo was reset writes nothing when it comes back', async (t) => {
  const w = await homeOnStudio(t);
  assert.equal(w.stored.note().homeId, A.homeId);
  const hold = () => {
    let release: () => void = () => undefined;
    let taken = false;
    w.overrides.set('studio', (method) => {
      if (method !== 'host.momoHomeLook' || taken) return undefined;
      taken = true;
      return new Promise((resolve) => (release = () => resolve(w.asHost('studio', 'host.momoHomeLook', {}))));
    });
    return { release: () => release(), taken: () => taken };
  };
  // the service is stopped (another account signed in, the flag went off) while a look is out
  let gate = hold();
  const slow = w.real.refresh();
  await waitFor(() => gate.taken(), 'the look to start');
  w.real.dispose();
  w.wipe();
  gate.release();
  await slow.catch(() => undefined);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(w.stored.note(), null, 'the old account’s home is not written into the new one');
  assert.equal(w.stored.seen(), 0);
  // MoMo is reset while a look is out
  const v = await homeOnStudio(t);
  gate = (() => {
    let release: () => void = () => undefined;
    let taken = false;
    v.overrides.set('studio', (method) => {
      if (method !== 'host.momoHomeLook' || taken) return undefined;
      taken = true;
      return new Promise((resolve) => (release = () => resolve(v.asHost('studio', 'host.momoHomeLook', {}))));
    });
    return { release: () => release(), taken: () => taken };
  })();
  const slow2 = v.real.refresh();
  await waitFor(() => gate.taken(), 'the second look to start');
  v.real.forget();
  gate.release();
  await slow2.catch(() => undefined);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(v.stored.note(), null, 'what the Reset erased is not written again');
  assert.equal(v.stored.seen(), 0);
  // a stopped service does not answer for a Host, send, or tell a window
  w.real.dispose();
  w.fireChange();
  assert.equal(w.runTimers(), 0);
});

test('a window or phone that attaches later is told the view once, and each is told only what it has not got', async (t) => {
  const w = await homeOnStudio(t);
  const one: unknown[] = [];
  const two: unknown[] = [];
  const stopOne = w.real.api.onChanged((p: unknown) => void one.push(p));
  await w.real.refresh();
  await w.real.refresh();
  assert.equal(one.length, 1, 'the same view is not sent twice');
  const stopTwo = w.real.api.onChanged((p: unknown) => void two.push(p));
  // the second one composed the view itself first, as a window does when it opens: it still hears the next
  await w.view();
  await w.real.refresh();
  assert.deepEqual([one.length, two.length], [1, 1], 'the one that was told has not been told again; the new one was told once');
  w.down.add('studio');
  w.clock.at += 10 * 60_000;
  await w.real.refresh();
  assert.deepEqual([one.length, two.length], [2, 2]);
  stopOne();
  stopTwo();
});

test('when MoMo’s home is lost the way out is in the view, asked first and then confirmed, and only then may a new home be chosen', async (t) => {
  const w = await homeOnStudio(t);
  // the Studio is gone from the list for good; the Mini is up and holds none
  w.machines.splice(0, 1);
  await w.real.refresh();
  const v = await w.view();
  const problem: any = v.problems.find((p: any) => p.code === 'home_lost');
  assert.match(problem.cause, /MoMo’s home on Studio can’t be found/);
  assert.deepEqual(problem.fix, { id: 'start-fresh', label: 'Start fresh' });
  assert.match((await w.intent({ kind: 'choose-home', machineId: 'mini' })).cause, /already has a home, Studio/);
  // a confirmation nobody asked for is refused; the ask says what it does
  const unasked = await w.intent({ kind: 'fix', id: 'start-fresh!:made-up-token' });
  assert.match(unasked.cause, /has to be asked first/);
  const asked = await w.intent({ kind: 'fix', id: 'start-fresh' });
  assert.equal(asked.ok, false);
  assert.match(asked.cause, /MoMo starts over with no memory of what it knew on Studio/);
  assert.match(asked.fix.id, /^start-fresh!:[^:]+$/);
  assert.equal(asked.fixLabel, 'Start fresh');
  assert.match(asked.cause, /The old MoMo may still exist on .*; it will be retired when it comes back\./);
  assert.equal(w.b!.home.status().home?.state ?? 'none', 'none', 'asking changed nothing');
  assert.equal((await w.intent({ kind: 'fix', id: asked.fix.id })).ok, true);
  const made = await w.intent({ kind: 'choose-home', machineId: 'mini' });
  assert.equal(made.ok, true, JSON.stringify(made));
  // the new home is asked to start above every lease this account has seen, so the old one cannot win when it comes back
  assert.deepEqual(w.calls.filter((c) => c.method === 'host.momoHomeStart').at(-1)?.params, { name: 'Mac mini', floor: 1 });
  assert.equal(w.b!.home.status().home.state, 'running');
  // the Host that honors the floor starts at the next lease (the Host's half of this contract)
  const real = await w.asHost('mini', 'host.momoStatus', {});
  w.overrides.set('mini', (method) => (method === 'host.momoStatus' ? { ...real, home: { ...real.home, leaseEpoch: 2 } } : undefined));
  await w.real.refresh();
  assert.equal((await w.view()).home.machineName, 'Mac mini');
  assert.equal((await w.view()).home.leaseEpoch, 2);
  // a fresh start lets exactly one home be made: the permission is used up
  assert.equal(w.stored.note().homeId, B.homeId);
});

test('a Host that refuses to answer (its grant lapsed, the Host is older) has not said it holds no home: nothing is chosen, and Start fresh is offered, asked first, used once, and lapses', async (t) => {
  const w = await world(t, { second: true });
  // MoMo lives on the Studio (made from another device); its grant for this Mac lapsed, so it veils MoMo; the Mini is granted and holds none
  await w.a.home.start(A);
  w.overrides.set('studio', (method) => {
    if (method.startsWith('host.momo')) throw Object.assign(new Error(`Unknown request: ${method}`), { code: 'unknown_request' });
    return undefined;
  });
  const v = await w.view();
  assert.notEqual(v.setup.step, 'where', 'a refusal is not "no home"');
  assert.equal(v.home.state, 'asleep');
  const refused = await w.intent({ kind: 'choose-home', machineId: 'mini' });
  assert.match(refused.cause, /Studio did not answer, and MoMo may live there/);
  const problem: any = v.problems.find((p: any) => p.code === 'home_unheard');
  assert.match(problem.cause, /Couldn’t reach Studio\. If MoMo already lives there, starting here makes a second one\./);
  assert.deepEqual(problem.fix, { id: 'start-fresh', label: 'Start fresh' });
  assert.equal(w.b!.home.status().home?.state ?? 'none', 'none', 'nothing was started');
  // asked first, with what it risks; a confirmation nobody asked for is refused
  assert.match((await w.intent({ kind: 'fix', id: 'start-fresh!:guess' })).cause, /has to be asked first/);
  const asked = await w.intent({ kind: 'fix', id: 'start-fresh' });
  assert.equal(asked.ok, false);
  assert.match(asked.cause, /The old MoMo may still exist on Studio; it will be retired when it comes back\./);
  assert.equal((await w.intent({ kind: 'fix', id: asked.fix.id })).ok, true);
  const made = await w.intent({ kind: 'choose-home', machineId: 'mini' });
  assert.equal(made.ok, true, JSON.stringify(made));
  assert.equal(w.b!.home.status().home.state, 'running');
  assert.equal((await w.intent({ kind: 'fix', id: 'start-fresh' })).ok, false, 'MoMo has a home now');
  // the permission lapses: confirmed and then left for too long
  const late = await world(t, { second: true });
  await late.a.home.start(A);
  late.down.add('studio');
  const ask = await late.intent({ kind: 'fix', id: 'start-fresh' });
  assert.equal((await late.intent({ kind: 'fix', id: ask.fix.id })).ok, true);
  late.clock.at += 11 * 60_000;
  assert.match((await late.intent({ kind: 'choose-home', machineId: 'mini' })).cause, /did not answer, and MoMo may live there/);
});

test('a machine with no Host installed is a definite "no home": a first choice goes through when the others say none', async (t) => {
  const w = await world(t, { second: true });
  (w.machines[0] as any).hasHost = false;
  const v = await w.view();
  assert.equal(v.setup.step, 'where');
  assert.equal(v.problems.length, 0);
  assert.equal((await w.intent({ kind: 'choose-home', machineId: 'mini' })).ok, true);
  assert.equal(
    w.calls.some((c) => c.id === 'studio'),
    false,
    'nothing was asked of a machine that has no Host',
  );
});

test('start fresh asks the Host for a home above every lease seen, the permission is used up by it, and it is checked again by the service, not only offered by the view', async (t) => {
  const w = await homeOnStudio(t);
  // nothing is lost: the Studio answers, so the service refuses the fresh start whatever the view offered
  assert.match((await w.intent({ kind: 'fix', id: 'start-fresh' })).cause, /MoMo has a home that answers; nothing is lost\./);
  w.machines.splice(0, 1);
  await w.real.refresh();
  const asked = await w.intent({ kind: 'fix', id: 'start-fresh' });
  assert.match(asked.cause, /MoMo starts over with no memory of what it knew on Studio/);
  assert.equal((await w.intent({ kind: 'fix', id: asked.fix.id })).ok, true);
  assert.equal((await w.intent({ kind: 'choose-home', machineId: 'mini' })).ok, true);
  assert.equal(w.calls.filter((c) => c.method === 'host.momoHomeStart').at(-1)?.params.floor, 1);
  // used up: the owner cannot start another from the same permission
  const second = await world(t, { second: true });
  await second.intent({ kind: 'choose-home', machineId: 'studio' });
  second.machines.splice(0, 1);
  await second.real.refresh();
  const ask2 = await second.intent({ kind: 'fix', id: 'start-fresh' });
  await second.intent({ kind: 'fix', id: ask2.fix.id });
  await second.intent({ kind: 'choose-home', machineId: 'mini' });
  second.real.forget();
  assert.match(
    (await second.intent({ kind: 'choose-home', machineId: 'mini' })).cause,
    /already lives on|did not answer|already has a home/,
  );
});
