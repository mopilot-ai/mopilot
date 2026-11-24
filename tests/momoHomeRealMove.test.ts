// MoMo's real home over two real in-process Hosts, the rest of its intents (shared/momoHomeReal.mjs): a move from one Host to the other at the next epoch, one that fails and is tried again or put away, a stuck move the owner reclaims, the machine actions the app does itself, the lanes that run on the home's Host, and the rows it holds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { A, world } from './support/momoHomeRealWorld.ts';
import { waitFor } from './support/waitFor.ts';
import { FIXTURE_AT, FIXTURE_ROWS } from '../shared/momoRowsFixture.ts';

const until = (what: string, ok: () => Promise<boolean>) => waitFor(ok, what, { timeoutMs: 5_000 });
const settled = (w: any) => async () => {
  await w.real.refresh();
  const m = (await w.view()).home.move;
  return !!m && m.outcome !== 'running';
};

async function homeOnStudio(t: any) {
  const w = await world(t, { second: true });
  assert.equal((await w.intent({ kind: 'choose-home', machineId: 'studio' })).ok, true);
  return w;
}

test('a move goes to the other Host at the next epoch: the new home runs, the old one keeps only its tombstone, and "Got it" clears the move', async (t) => {
  const w = await homeOnStudio(t);
  assert.equal((await w.intent({ kind: 'move', toId: 'mini' })).ok, true);
  await until('the move ends', settled(w));
  const v = await w.view();
  assert.equal(v.home.move.outcome, 'moved');
  assert.equal(v.home.machineName, 'Mac mini');
  assert.equal(v.home.leaseEpoch, 2);
  assert.equal(v.home.state, 'running');
  assert.equal(w.b!.home.status().home.state, 'running');
  assert.equal(w.a.home.status().home?.state ?? 'none', 'none', 'the old home keeps no data');
  const ack = await w.intent({ kind: 'move-ack' });
  assert.equal(ack.view.home.move, null);
  assert.equal((await w.intent({ kind: 'move', toId: 'mini' })).ok, false, 'MoMo already lives there');
  // the stale claim of the old home is never believed again
  w.overrides.set('studio', (method) =>
    method === 'host.momoStatus'
      ? { home: { homeId: A.homeId, leaseEpoch: 1, state: 'running', stateSince: 1, lastSeenAt: 1, name: A.name } }
      : undefined,
  );
  await w.real.refresh();
  assert.equal((await w.view()).home.machineName, 'Mac mini');
});

test('a move that fails before the switch leaves the old home running and says why; Try again goes on, Stay puts it away', async (t) => {
  const w = await homeOnStudio(t);
  let broken = true;
  w.overrides.set('mini', (method, p) => {
    if (broken && method === 'host.momoMove' && p.op === 'offer') throw new Error('Mac mini stopped answering.');
    return undefined;
  });
  await w.intent({ kind: 'move', toId: 'mini' });
  await until('the move fails', settled(w));
  let v = await w.view();
  assert.equal(v.home.move.outcome, 'failed');
  assert.match(v.home.move.failure.cause, /stopped answering/);
  assert.equal(v.home.move.reclaim, null, 'the old home was put back, so there is nothing to reclaim');
  assert.equal(v.home.machineName, 'Studio');
  assert.equal(w.a.home.status().home.state, 'running');
  broken = false;
  assert.equal((await w.intent({ kind: 'move-retry' })).ok, true);
  await until('the second try ends', settled(w));
  v = await w.view();
  assert.equal(v.home.move.outcome, 'moved');
  assert.equal(v.home.machineName, 'Mac mini');
  // a failed move put away with Stay
  const x = await homeOnStudio(t);
  x.overrides.set('mini', (method, p) => {
    if (method === 'host.momoMove' && p.op === 'offer') throw new Error('Nope.');
    return undefined;
  });
  await x.intent({ kind: 'move', toId: 'mini' });
  await until('it fails', settled(x));
  assert.equal((await x.intent({ kind: 'move-stay' })).view.home.move, null);
  assert.equal((await x.intent({ kind: 'move-stay' })).ok, false, 'nothing is left to put away');
});

test('a move that left the old home paused offers Reclaim, and the owner’s confirmation asks the target first and runs MoMo on the old machine again', async (t) => {
  const w = await homeOnStudio(t);
  let lost = true;
  w.overrides.set('mini', (method, p) => {
    // it takes the offer, then stops answering: the sealed copy cannot be received and the move cannot be given up
    if (lost && method === 'host.momoMove' && p.op !== 'offer') throw new Error('Mac mini stopped answering.');
    return undefined;
  });
  // the old home's Cancel is lost too, so it is left paused
  w.overrides.set('studio', (method, p) => {
    if (lost && method === 'host.momoMove' && p.op === 'cancel') throw new Error('The link dropped.');
    return undefined;
  });
  await w.intent({ kind: 'move', toId: 'mini' });
  await until('the move fails', settled(w));
  const v = await w.view();
  assert.equal(v.home.move.outcome, 'failed');
  assert.equal(v.home.state, 'moving', 'the old home is still paused');
  assert.ok(v.home.move.reclaim, 'the home offers the way back with its own words');
  lost = false;
  const r = await w.intent({ kind: 'reclaim', moveId: v.home.move.moveId, toId: 'mini' });
  assert.equal(r.ok, true, JSON.stringify(r));
  await w.real.refresh();
  const after = await w.view();
  assert.equal(after.home.state, 'running');
  assert.equal(after.home.machineName, 'Studio');
  assert.equal(w.a.home.status().home.state, 'running');
});

test('the machine actions are what the app does itself: the home machine wakes, a machine updates, and a build that cannot says so in words', async (t) => {
  const w = await homeOnStudio(t);
  // asleep: the machine MoMo lives on is woken
  w.down.add('studio');
  w.clock.at += 10_000;
  await w.real.refresh();
  assert.equal((await w.intent({ kind: 'wake' })).ok, true);
  w.down.delete('studio');
  // each action only where the screen offers it: an update for a Host out of date, an install for an agent that is not there, a sign-in for one that is not signed in, a set-up for a machine not set up
  const agents = [
    { id: 'claude', name: 'Claude Code', installed: true, signedIn: false },
    { id: 'codex', name: 'Codex', installed: false, signedIn: false },
  ];
  w.machines[1] = { ...w.machines[1], current: false, agents } as any;
  assert.equal((await w.intent({ kind: 'update-machine', machineId: 'mini' })).ok, true);
  assert.equal((await w.intent({ kind: 'install-agent', machineId: 'mini', agent: 'codex' })).ok, true);
  assert.equal((await w.intent({ kind: 'sign-in-agent', machineId: 'mini', agent: 'claude' })).ok, true);
  w.machines[1] = { ...w.machines[1], setUp: false } as any;
  assert.equal((await w.intent({ kind: 'set-up-machine', machineId: 'mini' })).ok, true);
  assert.deepEqual(
    w.acts.map((a) => [a.kind, a.machineId, a.agent]),
    [
      ['wake', 'studio', undefined],
      ['update-machine', 'mini', undefined],
      ['install-agent', 'mini', 'codex'],
      ['sign-in-agent', 'mini', 'claude'],
      ['set-up-machine', 'mini', undefined],
    ],
  );
  w.failActs('Mac mini could not be updated.');
  w.machines[1] = { ...w.machines[1], setUp: true } as any;
  assert.deepEqual(await w.intent({ kind: 'update-machine', machineId: 'mini' }), { ok: false, cause: 'Mac mini could not be updated.' });
  assert.deepEqual(await w.intent({ kind: 'fix', id: 'something-old' }), { ok: false, cause: 'That fix is not offered here any more.' });
  const none = await world(t);
  assert.deepEqual(await none.intent({ kind: 'wake' }), { ok: false, cause: 'Nothing is asleep.' });
});

test('every other lane’s intent runs on the home’s Host: its answer is passed on, its refusal reaches the screen with its words and fix, and none runs without a home', async (t) => {
  const none = await world(t);
  assert.deepEqual(await none.intent({ kind: 'task.stop', id: 't1' }), {
    ok: false,
    cause: 'MoMo isn’t running anywhere right now.',
  });
  const w = await homeOnStudio(t);
  const seen: any[] = [];
  w.overrides.set('studio', (method, p) => {
    if (method !== 'host.momoLaneIntent') return undefined;
    seen.push(p.intent);
    if (p.intent.kind === 'task.stop') return { ok: true, value: null };
    return { ok: false, cause: 'That card is already answered.', fix: { kind: 'refresh' }, fixLabel: 'Refresh' };
  });
  assert.equal((await w.intent({ kind: 'task.stop', id: 't1' })).ok, true);
  assert.deepEqual(await w.intent({ kind: 'approval.send', id: 'c1' }), {
    ok: false,
    cause: 'That card is already answered.',
    fix: { kind: 'refresh' },
    fixLabel: 'Refresh',
  });
  assert.deepEqual(
    seen.map((i) => i.kind),
    ['task.stop', 'approval.send'],
  );
  assert.deepEqual(
    await w.intent({ kind: 'approval.send' }),
    { ok: false, cause: 'That is not something MoMo can do.' },
    'arguments are checked before any Host is asked',
  );
});

test('the Host’s rows join the chat in order, a row with an id held replaces it, and a Host without rows leaves the chat as it was', async (t) => {
  const w = await homeOnStudio(t);
  const asked: any[] = [];
  let answer: any = { rows: FIXTURE_ROWS.slice(0, 3), next: FIXTURE_AT + 3 };
  w.overrides.set('studio', (method, p) => {
    if (method !== 'host.momoRows') return undefined;
    asked.push(p);
    return answer;
  });
  await w.real.refresh();
  let chat = (await w.view()).chat;
  assert.deepEqual(
    chat.map((r: any) => r.id),
    FIXTURE_ROWS.slice(0, 3).map((r) => r.id),
  );
  const first: any = FIXTURE_ROWS[0];
  answer = { rows: [{ ...first, approval: { ...first.approval, status: 'completed' } }, FIXTURE_ROWS[10]], next: FIXTURE_AT + 11 };
  await w.real.refresh();
  chat = (await w.view()).chat;
  assert.equal(chat.length, 4);
  assert.equal((chat as any[])[0].approval.status, 'completed', 'the same id replaced the row');
  assert.deepEqual(asked, [{}, { after: FIXTURE_AT + 3 }]);
  // this device's own message sits beside them until the Host holds it
  await w.intent({ kind: 'send', turnId: 'turn-00000010', text: 'Hello' });
  w.down.add('mini');
  assert.deepEqual(
    ((await w.view()).chat as any[]).filter((r) => r.kind === 'user').map((r) => [r.text, r.delivery]),
    [['Hello', 'accepted']],
    'a sent message stays in the chat with how far it got',
  );
  // an older Host that cannot read rows
  w.overrides.set('studio', (method) => {
    if (method === 'host.momoRows') throw new Error('Unknown request: host.momoRows');
    return undefined;
  });
  await w.real.refresh();
  assert.equal(((await w.view()).chat as any[]).filter((r) => r.kind !== 'user').length, 4, 'the rows already held stay');
});

test('Stop asks the home’s chat to stop the turn, and refuses when MoMo runs nowhere', async (t) => {
  const none = await world(t);
  assert.equal((await none.intent({ kind: 'stop-turn' })).ok, false);
  const w = await homeOnStudio(t);
  w.overrides.set('studio', (method) => (method === 'chat.stop' ? { stopped: true } : undefined));
  assert.equal((await w.intent({ kind: 'stop-turn', turnId: 'turn-00000011' })).ok, true);
  assert.equal((await w.intent({ kind: 'stop-turn' })).ok, true);
  const stops = w.calls.filter((c) => c.method === 'chat.stop').map((c) => c.params);
  assert.deepEqual(stops, [
    { chatId: 'claude:c1', epoch: 1, key: stops[0]?.key, turnId: 'turn-00000011' },
    { chatId: 'claude:c1', epoch: 1, key: stops[1]?.key },
  ]);
  assert.match(stops[0].key, /^stop-id-\d+$/);
  assert.notEqual(stops[0].key, stops[1].key, 'each stop is its own request');
});
