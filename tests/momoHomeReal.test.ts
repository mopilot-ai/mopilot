// MoMo's home API over real Hosts (shared/momoHomeReal.mjs): two real in-process Hosts (their own data folders and keys, the Host's own `host.momo*` handlers) behind the ports the Mac's main process fills from its paired machines. The home is found by the lease it holds, a Host that cannot be asked is shown asleep and not as a first run, a message sent while MoMo sleeps is kept and a refusal reaches the screen in the Host's own words.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { waitFor } from './support/waitFor.ts';
import { A, B, world } from './support/momoHomeRealWorld.ts';

test('before a home exists the view is the first-run choice; choosing a machine makes it the home and the view says so', async (t) => {
  const w = await world(t);
  let v = await w.view();
  assert.equal(v.home.homeMachineId, null, 'no home yet');
  assert.equal(v.setup.step, 'where');
  assert.deepEqual(
    v.home.machines.map((m: any) => [m.machineId, m.isHome]),
    [['studio', false]],
  );
  const r = await w.intent({ kind: 'choose-home', machineId: 'studio' });
  assert.equal(r.ok, true);
  v = r.view;
  assert.equal(v.home.state, 'running');
  assert.equal(v.home.machineName, 'Studio');
  assert.equal(v.home.leaseEpoch, 1);
  assert.equal(v.home.homeMachineId, A.homeId);
  assert.equal(v.home.machines[0].isHome, true);
  assert.equal(w.a.home.status().home.state, 'running', 'the real Host holds the home');
});

test('a message goes to the home under its own id: the Host accepts that turn once and the outbox is empty', async (t) => {
  const w = await world(t);
  await w.intent({ kind: 'choose-home', machineId: 'studio' });
  const r = await w.intent({ kind: 'send', turnId: 'turn-00000001', text: 'Call Dana' });
  assert.equal(r.ok, true);
  assert.equal((await w.a.home.turn('turn-00000001')).state, 'accepted');
  assert.deepEqual(w.entries, []);
  assert.deepEqual(
    r.view.chat.map((x: any) => [x.kind, x.text, x.delivery]),
    [['user', 'Call Dana', 'accepted']],
    'the message stays in the chat, as accepted',
  );
  const send = w.calls.find((c) => c.method === 'chat.send');
  assert.deepEqual(send?.params, { chatId: 'claude:c1', epoch: 1, text: 'Call Dana', key: 'turn-00000001' });
  assert.equal(w.calls.filter((c) => c.method === 'host.momoChat').length, 1);
  await w.intent({ kind: 'send', turnId: 'turn-00000002', text: 'And Lee' });
  assert.equal(w.calls.filter((c) => c.method === 'host.momoChat').length, 2, 'the chat and its epoch are asked for with each message');
});

test('the Host cannot be asked: MoMo is shown asleep on the machine it lived on, not as a first run, and a message waits as queued', async (t) => {
  const w = await world(t);
  await w.intent({ kind: 'choose-home', machineId: 'studio' });
  w.down.add('studio');
  w.clock.at += 10 * 60_000;
  const v = await w.view();
  assert.equal(v.home.state, 'asleep');
  assert.equal(v.home.machineName, 'Studio');
  assert.notEqual(v.setup.step, 'where');
  const r = await w.intent({ kind: 'send', turnId: 'turn-00000003', text: 'While you sleep' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(
    r.view.chat.map((x: any) => [x.kind, x.text ?? null, x.delivery ?? null]),
    [
      ['user', 'While you sleep', 'queued'],
      ['waiting', null, null],
    ],
  );
  assert.equal(
    w.calls.some((c) => c.method === 'chat.send'),
    false,
    'nothing was sent to a home that cannot be reached',
  );
});

test('two Hosts hold a home: the newer lease is the home, the older one is told to stand down and keeps its data, and the new home going quiet leaves MoMo asleep there', async (t) => {
  const w = await world(t, { second: true });
  await w.intent({ kind: 'choose-home', machineId: 'studio' });
  // MoMo was started again on the Mini from another device, above the Studio's lease
  await w.b!.home.start({ name: B.name, floor: 1 });
  await w.real.refresh();
  const v = await w.view();
  assert.equal(v.home.machineName, 'Mac mini');
  assert.equal(v.home.leaseEpoch, 2);
  assert.equal(v.home.state, 'running');
  await waitFor(() => w.a.home.look().holds === 'retired', 'the old home to stand down');
  assert.equal(w.a.home.look().movedTo.name, 'Mac mini');
  // and when the new home goes quiet it is asleep there, not back on the machine that stood down
  w.down.add('mini');
  await w.real.refresh();
  const later = await w.view();
  assert.equal(later.home.state, 'asleep');
  assert.equal(later.home.machineName, 'Mac mini');
});

test('a Host that refuses a message just written passes its own words to the screen and keeps nothing: the composer has the text', async (t) => {
  const w = await world(t);
  await w.intent({ kind: 'choose-home', machineId: 'studio' });
  w.overrides.set('studio', (method) => {
    if (method === 'chat.send') throw Object.assign(new Error('MoMo’s home is moving.'), { code: 'momo_home_away' });
    return undefined;
  });
  const r = await w.intent({ kind: 'send', turnId: 'turn-00000004', text: 'Hi' });
  assert.deepEqual(r, { ok: false, cause: 'MoMo’s home is moving.' });
  assert.deepEqual(w.entries, [], 'the person still has the text, so it is not also kept here');
});

test('check-turn asks the home: has for a turn it kept, missing for one it never saw, unknown when it cannot be asked', async (t) => {
  const w = await world(t);
  await w.intent({ kind: 'choose-home', machineId: 'studio' });
  await w.intent({ kind: 'send', turnId: 'turn-00000005', text: 'Hi' });
  assert.equal((await w.intent({ kind: 'check-turn', turnId: 'turn-00000005' })).turn, 'has');
  assert.equal((await w.intent({ kind: 'check-turn', turnId: 'turn-0000none' })).turn, 'missing');
  w.down.add('studio');
  assert.equal((await w.intent({ kind: 'check-turn', turnId: 'turn-00000005' })).turn, 'unknown');
});

test('choosing a machine that does not answer or is not in the list is refused with the reason', async (t) => {
  const w = await world(t);
  assert.deepEqual(await w.intent({ kind: 'choose-home', machineId: 'nope' }), { ok: false, cause: 'That machine is not available.' });
  w.down.add('studio');
  assert.deepEqual(await w.intent({ kind: 'choose-home', machineId: 'studio' }), { ok: false, cause: 'Studio is not answering.' });
});
