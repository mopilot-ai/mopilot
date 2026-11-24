// The second independent review of MoMo's real home, one test for each thing it found (shared/momoHomeReal.mjs and what it is made of), on real in-process Hosts: a machine that does not take a grant or a look is not asked at every heartbeat,
// taking an older MoMo back is held to the same fitness and to the epoch the owner saw, only a message that was not sent can be tried again or deleted, a home that merely won a lease does not inherit another's held messages, what changes where
// MoMo lives runs one at a time, a choice is judged again after the look, and a grant that lapsed or a home that is away is waited on, not given up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain ESM without declarations
import { fixId } from '../shared/momoFixId.mjs';
import { A, B, world } from './support/momoHomeRealWorld.ts';
import { realMachines } from './support/momoRealMachines.ts';
import { STUDIO, hostSays, start, tmp } from './support/momoServiceKit.ts';
import { waitFor } from './support/waitFor.ts';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { getHomeApi, setHomeApi } = require('../electron/momo/homeSlot.cjs');

test('a machine that does not take the grant is not asked at every heartbeat: it waits 30 seconds, then longer, and a success clears it', async (t) => {
  setHomeApi(null);
  const dir = tmp(t);
  let now = 1_000_000;
  let fail = true;
  const grants: number[] = [];
  const r = realMachines(
    t,
    [{ id: 'studio', name: 'Studio', hostId: STUDIO }],
    hostSays(null, (_id, method) => {
      if (method !== 'host.momoGrant') return undefined;
      grants.push(now);
      if (fail) throw new Error('refused');
      return { ok: true };
    }),
  );
  await r.beat();
  const stop = start({ machines: r.m, dir, watch: () => () => undefined, now: () => now });
  await waitFor(() => getHomeApi(), 'the home');
  await waitFor(() => grants.length === 1, 'the first grant');
  for (let i = 0; i < 5; i++) await r.beat();
  assert.equal(grants.length, 1, 'heartbeats within the wait do not ask again');
  now += 31_000;
  await r.beat();
  await waitFor(() => grants.length === 2, 'asked again after 30 s');
  now += 31_000;
  await r.beat();
  assert.equal(grants.length, 2, 'the second failure waits 60 s');
  now += 31_000;
  fail = false;
  await r.beat();
  await waitFor(() => grants.length === 3, 'asked again after 60 s, and taken');
  stop();
  setHomeApi(null);
});

test('a Host that does not know the look is not asked at every heartbeat either, and is asked again when its wait is over', async (t) => {
  const w = await world(t);
  let asked = 0;
  w.overrides.set('studio', (method) => {
    if (method !== 'host.momoHomeLook') return undefined;
    asked++;
    throw Object.assign(new Error('Unknown request: host.momoHomeLook'), { code: 'unknown_request' });
  });
  await w.view();
  assert.equal(asked, 1);
  w.clock.at += 6_000;
  await w.view();
  assert.equal(asked, 1, 'within its wait');
  w.clock.at += 30_000;
  await w.view();
  assert.equal(asked, 2, 'after 30 s');
  w.clock.at += 40_000;
  await w.view();
  assert.equal(asked, 2, 'the second failure waits 60 s');
});

test('taking an older MoMo back is refused for a machine that is not fit, and for a MoMo that changed since the owner was asked', async (t) => {
  const w = await world(t, { second: true });
  await w.intent({ kind: 'choose-home', machineId: 'studio' });
  await w.b!.home.start({ name: B.name, floor: 1 });
  await w.real.refresh();
  await waitFor(() => w.a.home.look().holds === 'retired', 'the Studio to be retired');
  w.clock.at += 10_000;
  await w.real.refresh();
  // out of date: refused before it is asked
  w.machines[0] = { ...w.machines[0], current: false } as any;
  assert.match(
    (await w.intent({ kind: 'fix', id: fixId('use-older', 'studio') })).cause,
    /Studio needs an update before MoMo can live there/,
  );
  w.machines[0] = { ...w.machines[0], current: true } as any;
  // asked, then the copy is revived and retired again elsewhere (a higher epoch): the repeat does nothing and the card is looked at again
  const asked = await w.intent({ kind: 'fix', id: fixId('use-older', 'studio') });
  const seen = w.a.home.look();
  let starts = 0;
  w.overrides.set('studio', (method) => {
    if (method === 'host.momoHomeStart') starts++;
    if (method === 'host.momoHomeLook') return { ...seen, leaseEpoch: seen.leaseEpoch + 4 };
    return undefined;
  });
  w.clock.at += 10_000;
  await w.real.refresh();
  assert.match((await w.intent({ kind: 'fix', id: asked.fix.id })).cause, /changed since you were asked, so nothing was done/);
  assert.equal(starts, 0, 'nothing was started');
});

test('only a message that was not sent can be tried again or deleted, and not while a send is in flight', async (t) => {
  const w = await world(t, { second: true });
  await w.intent({ kind: 'choose-home', machineId: 'studio' });
  // a message that waits for MoMo to wake is waiting, not "not sent": it is not tried again by hand, and not deleted by a stale button
  w.down.add('studio');
  w.clock.at += 10_000;
  await w.real.refresh();
  await w.intent({ kind: 'send', turnId: 'turn-00000001', text: 'Waits' });
  assert.match((await w.intent({ kind: 'fix', id: fixId('retry-send', 'turn-00000001') })).cause, /not waiting any more/);
  assert.match((await w.intent({ kind: 'fix', id: fixId('delete-send', 'turn-00000001') })).cause, /not waiting any more/);
  assert.equal(w.entries.length, 1, 'still held');
  // one that is on its way is not touched either
  w.outbox.save({ turnId: 'turn-00000002', chatId: '', text: 'On its way' });
  w.outbox.sending('turn-00000002');
  assert.match((await w.intent({ kind: 'fix', id: fixId('delete-send', 'turn-00000002') })).cause, /not waiting any more/);
  // another surface presses Try again while this one is sending: held off
  w.down.delete('studio');
  w.outbox.settle('turn-00000002');
  w.outbox.save({ turnId: 'turn-00000003', chatId: '', text: 'Refused once' });
  w.outbox.refuse('turn-00000003', 'No.');
  const releases: (() => void)[] = [];
  let out = false;
  w.overrides.set('studio', (method) => {
    if (method !== 'chat.send') return undefined;
    out = true;
    return new Promise((resolve) => releases.push(() => resolve({ sent: true })));
  });
  const sending = w.intent({ kind: 'send', turnId: 'turn-00000004', text: 'Sending' });
  await waitFor(() => out, 'the send to be out');
  void sending;
  assert.match(
    (await w.intent({ kind: 'fix', id: fixId('retry-send', 'turn-00000003') })).cause,
    /not waiting any more|sending messages right now/,
  );
  while (releases.length) releases.shift()?.();
  await sending;
});

test('a home that merely won a lease does not inherit what was held for the one it beat, which waits for the owner’s word', async (t) => {
  const w = await world(t, { second: true });
  await w.intent({ kind: 'choose-home', machineId: 'studio' });
  w.down.add('studio');
  w.clock.at += 10_000;
  await w.real.refresh();
  await w.intent({ kind: 'send', turnId: 'turn-00000001', text: 'For the first MoMo' });
  // another device started MoMo on the Mini on its own, and the Studio never said it moved
  await w.b!.home.start(B);
  w.clock.at += 10_000;
  await w.real.refresh();
  const v = await w.view();
  assert.equal(v.home.machineName, 'Mac mini');
  assert.equal(
    w.calls.some((c) => c.id === 'mini' && c.method === 'chat.send'),
    false,
    'nothing was sent to a MoMo the message was not written for',
  );
  const card: any = (v.problems as any[]).find((p) => p.code === 'send_refused' && /written for the old one/.test(p.cause));
  assert.ok(card, 'the message says it is for the previous MoMo');
  assert.equal(card.fix.label, 'Send to this MoMo');
});

test('a choice and a move that are made at the same time run one after the other: two homes are never started', async (t) => {
  const w = await world(t, { second: true });
  const [one, two] = await Promise.all([
    w.intent({ kind: 'choose-home', machineId: 'studio' }),
    w.intent({ kind: 'choose-home', machineId: 'mini' }),
  ]);
  assert.deepEqual([one.ok, two.ok].sort(), [false, true], 'exactly one is taken');
  const running = [w.a.home.status().home?.state, w.b!.home.status().home?.state].filter((s) => s === 'running');
  assert.equal(running.length, 1, 'one home runs');
  assert.match(((one.ok ? two : one).cause as string) ?? '', /already lives on/);
});

test('a machine is judged again after the look: one that went away meanwhile, and one with no Host, are refused', async (t) => {
  const w = await world(t, { second: true });
  w.overrides.set('mini', (method) => {
    if (method === 'host.momoHomeLook') {
      w.down.add('mini');
      return { holds: 'none', leaseEpoch: 0, grantLive: true };
    }
    return undefined;
  });
  assert.match((await w.intent({ kind: 'choose-home', machineId: 'mini' })).cause, /Mac mini is not answering/);
  assert.equal(w.b!.home.status().home?.state ?? 'none', 'none');
  w.machines[0] = { ...w.machines[0], hasHost: false } as any;
  assert.match((await w.intent({ kind: 'choose-home', machineId: 'studio' })).cause, /Studio isn’t set up for MoMo yet/);
});

test('a grant that lapsed and a home that is away are waited on, not given up: the message stays held and is not asked again at once', async (t) => {
  const w = await world(t);
  await w.intent({ kind: 'choose-home', machineId: 'studio' });
  let sends = 0;
  let code = 'momo_grant_lapsed';
  w.overrides.set('studio', (method) => {
    if (method !== 'chat.send') return undefined;
    sends++;
    if (code) throw Object.assign(new Error('refused'), { code });
    return { sent: true };
  });
  const refused = await w.intent({ kind: 'send', turnId: 'turn-00000001', text: 'Hi' });
  assert.equal(refused.ok, false);
  assert.equal(w.entries.find((e: any) => e.turnId === 'turn-00000001')?.refusal, undefined, 'not refused for good');
  const first = sends;
  await w.real.refresh();
  assert.equal(sends, first, 'not tried again at once');
  code = '';
  w.clock.at += 60_000;
  w.restart();
  await w.real.refresh();
  await waitFor(() => w.entries.length === 0, 'the message to go once the wait is over');
  // a home that is away waits the same way
  code = 'momo_home_away';
  await w.intent({ kind: 'send', turnId: 'turn-00000002', text: 'Again' });
  const before = sends;
  await w.real.refresh();
  assert.equal(sends, before, 'not tried again at once');
});

test('a home that was stood down by a newer lease names its winner, but that is not the owner’s move: what was held for it does not go to the winner', async (t) => {
  const w = await world(t, { second: true });
  await w.intent({ kind: 'choose-home', machineId: 'studio' });
  // a message was written for the first MoMo and waits
  w.outbox.save({ turnId: 'turn-00000001', chatId: '', text: 'For the first MoMo', homeId: A.homeId });
  // meanwhile another device started MoMo on the Mini above it, and the Studio was told to stand down (retired, naming the Mini): this app saw none of it
  await w.b!.home.start({ name: B.name, floor: 1 });
  await w.a.home.standDown({ homeId: B.homeId, leaseEpoch: 2, name: B.name });
  assert.equal(w.a.home.look().holds, 'retired');
  w.restart();
  w.clock.at += 10_000;
  await w.real.refresh();
  const v = await w.view();
  assert.equal(v.home.machineName, 'Mac mini');
  assert.equal(
    w.calls.some((c) => c.id === 'mini' && c.method === 'chat.send'),
    false,
    'the message was not written for this MoMo',
  );
  const card = (v.problems as any[]).find((p) => p.code === 'send_refused');
  assert.match(card.cause, /written for the old one/);
  assert.ok(
    w.entries.some((e: any) => e.turnId === 'turn-00000001'),
    'and it is still there for the owner to send or delete',
  );
});

test('a MoMo that was moved says so with a tombstone, and the held messages go with it', async (t) => {
  const w = await world(t, { second: true });
  await w.intent({ kind: 'choose-home', machineId: 'studio' });
  w.outbox.save({ turnId: 'turn-00000001', chatId: '', text: 'Before the move', homeId: A.homeId });
  // the old Host's look after a move: it holds none and names where MoMo went
  w.overrides.set('studio', (method) =>
    method === 'host.momoHomeLook'
      ? { holds: 'moved', leaseEpoch: 2, movedTo: { name: B.name, homeId: B.homeId, at: 1 }, grantLive: true }
      : undefined,
  );
  await w.b!.home.start({ name: B.name, floor: 1 });
  w.restart();
  w.clock.at += 10_000;
  await w.real.refresh();
  await waitFor(() => w.entries.length === 0, 'the held message to go to the MoMo that MoMo moved to');
  assert.ok(w.calls.some((c) => c.id === 'mini' && c.method === 'chat.send'));
});
