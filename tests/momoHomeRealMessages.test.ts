// MoMo's real home against real in-process Hosts, the messages this device sends (shared/momoHomeMail.mjs): held while MoMo sleeps and sent in order under their own ids when it is back, one open turn per chat so the next waits, bounded, one held for another home not sent, a send that may have arrived not sent blindly again, a message refused for good or older than a day kept and shown with try again or delete, and the ones already sent still in the chat after a restart. Each on real Hosts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain ESM without declarations
import { OUTBOX_MAX } from '../shared/momoHomeMail.mjs';
import { FIXTURE_AT, FIXTURE_ROWS } from '../shared/momoRowsFixture.ts';
import { world } from './support/momoHomeRealWorld.ts';
import { waitFor } from './support/waitFor.ts';

async function homeOnStudio(t: any, opts: any = {}) {
  const w = await world(t, { second: true, ...opts });
  assert.equal((await w.intent({ kind: 'choose-home', machineId: 'studio' })).ok, true);
  return w;
}

test('held messages wait while MoMo sleeps, go in order under their own ids when it is back, are bounded, and one held for another home is not sent', async (t) => {
  const w = await homeOnStudio(t);
  w.down.add('studio');
  await w.intent({ kind: 'send', turnId: 'turn-00000001', text: 'First' });
  await w.intent({ kind: 'send', turnId: 'turn-00000002', text: 'Second' });
  w.outbox.save({ turnId: 'turn-00000003', chatId: '', text: 'For another home', homeId: 'home-zzzz-9999' });
  assert.deepEqual(
    (await w.view()).chat.filter((r: any) => r.kind === 'user').map((r: any) => [r.text, r.delivery]),
    [
      ['First', 'queued'],
      ['Second', 'queued'],
      ['For another home', 'failed'],
    ],
  );
  w.down.delete('studio');
  w.restart();
  await w.real.refresh();
  await waitFor(() => w.a.home.turn('turn-00000001').then((x: any) => x.state === 'accepted'), 'the first held message to go');
  // the Host takes one open turn per chat: the second waits, still held, until the first has ended
  await waitFor(() => w.entries.length === 2, 'the second to be refused as busy and kept');
  assert.equal((await w.a.home.turn('turn-00000002')).state, 'unknown');
  await w.a.home.stores().turns.settle('claude:c1', 'completed');
  // the Host said busy: the next try waits a little, then goes
  w.clock.at += 60_000;
  await w.real.refresh();
  await waitFor(() => w.a.home.turn('turn-00000002').then((x: any) => x.state === 'accepted'), 'the second to go once the first ended');
  await waitFor(() => w.entries.length === 1, 'the second to leave the outbox');
  assert.equal((await w.a.home.turn('turn-00000003')).state, 'unknown', 'the one held for another home is never sent');
  assert.deepEqual(
    w.entries.map((e: any) => e.turnId),
    ['turn-00000003'],
  );
  // the bound: the outbox takes no more than it says
  const v = await homeOnStudio(t);
  v.down.add('studio');
  for (let i = 0; i < OUTBOX_MAX; i++)
    assert.equal((await v.intent({ kind: 'send', turnId: `turn-bound-${i}`.padEnd(12, '0'), text: `m${i}` })).ok, true);
  const over = await v.intent({ kind: 'send', turnId: 'turn-bound-over', text: 'one too many' });
  assert.equal(over.ok, false);
  assert.match(over.cause, new RegExp(`${OUTBOX_MAX} messages are already waiting`));
});

test('a send whose answer may have been lost is "not sure": asked about, settled by what the Host says, and sent again only when it never arrived', async (t) => {
  const w = await homeOnStudio(t);
  // the Host takes the message and the answer is lost
  let lose = true;
  w.overrides.set('studio', (method, p) => {
    if (method !== 'chat.send' || !lose) return undefined;
    return (async () => {
      const stamp = w.a.home.stamp();
      await w.a.home.stores().turns.accept({ turnId: p.key, chatId: p.chatId, deviceId: 'mac', leaseEpoch: stamp.leaseEpoch });
      throw Object.assign(new Error('The tunnel dropped.'), { code: 'host_unreachable' });
    })();
  });
  const lost = await w.intent({ kind: 'send', turnId: 'turn-00000010', text: 'Did it arrive' });
  assert.equal(lost.ok, false);
  assert.match(lost.cause, /Not sure MoMo got that message/);
  assert.deepEqual(
    (await w.view()).chat.filter((r: any) => r.kind === 'user').map((r: any) => r.delivery),
    ['not-sure'],
  );
  assert.equal((await w.intent({ kind: 'check-turn', turnId: 'turn-00000010' })).turn, 'has');
  // the Host takes one open turn per chat: this one ends before the next goes
  await w.a.home.stores().turns.settle('claude:c1', 'completed');
  assert.deepEqual(
    (await w.view()).chat.filter((r: any) => r.kind === 'user').map((r: any) => r.delivery),
    ['accepted'],
  );
  assert.deepEqual(w.entries, []);
  // the Host never saw the next one: it says so, and a second send goes under the same id
  w.overrides.set('studio', (method) => {
    if (method === 'chat.send' && lose) throw Object.assign(new Error('timeout'), { code: 'timeout' });
    return undefined;
  });
  const never = await w.intent({ kind: 'send', turnId: 'turn-00000011', text: 'Lost on the way' });
  assert.match(never.cause, /Not sure/);
  assert.equal((await w.intent({ kind: 'check-turn', turnId: 'turn-00000011' })).turn, 'missing');
  assert.deepEqual(
    (await w.view()).chat.filter((r: any) => r.id === 'turn-00000011').map((r: any) => r.delivery),
    ['never-got-it'],
  );
  lose = false;
  assert.equal((await w.intent({ kind: 'send', turnId: 'turn-00000011', text: 'Lost on the way' })).ok, true);
  assert.equal((await w.a.home.turn('turn-00000011')).state, 'accepted');
  assert.equal(
    w.calls.filter((c) => c.method === 'chat.send' && c.params.key === 'turn-00000011').length,
    2,
    'asked again once, by the person',
  );
  // a Host that cannot be asked leaves it unknown, and nothing is sent blind
  const unknown = await homeOnStudio(t);
  unknown.overrides.set('studio', (method) => {
    if (method === 'chat.send') throw Object.assign(new Error('timeout'), { code: 'timeout' });
    return undefined;
  });
  await unknown.intent({ kind: 'send', turnId: 'turn-00000012', text: 'Unsure' });
  unknown.overrides.set('studio', (method) => {
    if (method === 'host.momoTurn') throw new Error('Could not reach the machine.');
    return undefined;
  });
  assert.equal((await unknown.intent({ kind: 'check-turn', turnId: 'turn-00000012' })).turn, 'unknown');
  assert.deepEqual(
    (await unknown.view()).chat.filter((r: any) => r.id === 'turn-00000012').map((r: any) => r.delivery),
    ['not-sure'],
  );
});

test('a message a Host refuses for good is kept and shown as not sent with its words, tried again or deleted by the person, and not sent again on every look', async (t) => {
  const w = await homeOnStudio(t);
  w.down.add('studio');
  await w.intent({ kind: 'send', turnId: 'turn-00000020', text: 'Please book the room' });
  await w.intent({ kind: 'send', turnId: 'turn-00000021', text: 'And the car' });
  w.down.delete('studio');
  let refuse = true;
  w.overrides.set('studio', (method) => {
    if (method === 'chat.send' && refuse)
      throw Object.assign(new Error('MoMo does not take that kind of message.'), { code: 'momo_refused' });
    return undefined;
  });
  w.restart();
  for (let i = 0; i < 3; i++) await w.real.refresh();
  await waitFor(() => w.calls.filter((c) => c.method === 'chat.send').length >= 1, 'the first try');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(w.calls.filter((c) => c.method === 'chat.send').length, 2, 'each held message was tried once, not on every look');
  const v = await w.view();
  assert.deepEqual(
    v.chat.filter((r: any) => r.kind === 'user').map((r: any) => [r.text, r.delivery]),
    [
      ['Please book the room', 'failed'],
      ['And the car', 'failed'],
    ],
  );
  const mine: any[] = v.problems.filter((p: any) => p.code === 'send_refused');
  assert.equal(mine.length, 4);
  assert.match(mine[0].cause, /Not sent: “Please book the room”\. MoMo does not take that kind of message\./);
  assert.deepEqual(
    mine.map((p: any) => p.fix.label),
    ['Try again', 'Delete message', 'Try again', 'Delete message'],
  );
  assert.equal(w.entries.length, 2, 'nothing was dropped');
  // delete one, try the other again once the Host takes it
  assert.equal((await w.intent({ kind: 'fix', id: 'delete-send:turn-00000021' })).ok, true);
  assert.deepEqual(
    w.entries.map((e: any) => e.turnId),
    ['turn-00000020'],
  );
  assert.equal((await w.intent({ kind: 'fix', id: 'delete-send:turn-00000021' })).ok, false, 'it is gone');
  refuse = false;
  assert.equal((await w.intent({ kind: 'fix', id: 'retry-send:turn-00000020' })).ok, true);
  await waitFor(
    () => w.a.home.turn('turn-00000020').then((x: any) => x.state === 'accepted'),
    'the message to go once the person asked again',
  );
});

test('a message that waited more than a day is not sent late and not dropped: it stays as not sent until the person decides', async (t) => {
  const w = await homeOnStudio(t);
  w.down.add('studio');
  await w.intent({ kind: 'send', turnId: 'turn-00000030', text: 'Old news' });
  w.clock.at += 25 * 3_600_000;
  w.down.delete('studio');
  w.restart();
  await w.real.refresh();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal((await w.a.home.turn('turn-00000030')).state, 'unknown', 'not sent late');
  assert.equal(w.entries.length, 1, 'not dropped');
  const v = await w.view();
  assert.deepEqual(
    v.chat.filter((r: any) => r.kind === 'user').map((r: any) => r.delivery),
    ['failed'],
  );
  assert.match((v.problems.find((p: any) => p.code === 'send_refused') as any).cause, /waited more than a day/);
  // the person's word makes it new
  assert.equal((await w.intent({ kind: 'fix', id: 'retry-send:turn-00000030' })).ok, true);
  await waitFor(() => w.a.home.turn('turn-00000030').then((x: any) => x.state === 'accepted'), 'it to go when the person asked');
});

test('after the Host says its chat has a turn open the next held message waits, then goes; it is not sent again every look', async (t) => {
  const w = await homeOnStudio(t);
  w.down.add('studio');
  await w.intent({ kind: 'send', turnId: 'turn-00000040', text: 'First' });
  await w.intent({ kind: 'send', turnId: 'turn-00000041', text: 'Second' });
  w.down.delete('studio');
  w.restart();
  await w.real.refresh();
  await waitFor(() => w.a.home.turn('turn-00000040').then((x: any) => x.state === 'accepted'), 'the first to go');
  await waitFor(() => w.calls.filter((c) => c.params?.key === 'turn-00000041').length === 1, 'the second to be refused as busy');
  await waitFor(() => w.entries.length === 1 && w.entries[0].delivery === 'not-sent', 'the busy refusal to be settled');
  for (let i = 0; i < 5; i++) await w.real.refresh();
  assert.equal(w.calls.filter((c) => c.params?.key === 'turn-00000041').length, 1, 'no more tries while it waits');
  w.clock.at += 60_000;
  await w.a.home.stores().turns.settle('claude:c1', 'completed');
  await w.real.refresh();
  await waitFor(() => w.a.home.turn('turn-00000041').then((x: any) => x.state === 'accepted'), 'the second to go once the first ended');
});

test('the messages already sent are still in the chat after a restart', async (t) => {
  const w = await homeOnStudio(t);
  assert.equal((await w.intent({ kind: 'send', turnId: 'turn-00000050', text: 'Sent before' })).ok, true);
  w.restart();
  w.down.add('studio');
  const v = await w.view();
  assert.deepEqual(
    v.chat.filter((r: any) => r.kind === 'user').map((r: any) => [r.text, r.delivery]),
    [['Sent before', 'accepted']],
  );
});

/** MoMo's Studio is gone for good and the owner starts fresh on the Mini; the Host that honors the floor starts it at the next lease. */
async function startedFreshOnMini(w: Awaited<ReturnType<typeof homeOnStudio>>) {
  w.machines.splice(0, 1);
  await w.real.refresh();
  const asked = await w.intent({ kind: 'fix', id: 'start-fresh' });
  assert.equal((await w.intent({ kind: 'fix', id: asked.fix.id })).ok, true);
  assert.equal((await w.intent({ kind: 'choose-home', machineId: 'mini' })).ok, true);
  const real = await w.asHost('mini', 'host.momoStatus', {});
  w.overrides.set('mini', (method) => (method === 'host.momoStatus' ? { ...real, home: { ...real.home, leaseEpoch: 2 } } : undefined));
  await w.real.refresh();
}

test('messages written for a home that no longer exists are shown as not sent, and go to this MoMo only when the person says so; the old home’s sent ones are not shown in the new chat', async (t) => {
  const w = await homeOnStudio(t);
  assert.equal((await w.intent({ kind: 'send', turnId: 'turn-00000060', text: 'Sent to the old MoMo' })).ok, true);
  assert.equal(w.sentKept[0].homeId, 'home-aaaa-1111', 'the sent log says which home each went to');
  await w.a.home.stores().turns.settle('claude:c1', 'completed');
  w.down.add('studio');
  await w.intent({ kind: 'send', turnId: 'turn-00000061', text: 'Held for the old MoMo' });
  await startedFreshOnMini(w);
  const v = await w.view();
  assert.equal(v.home.machineName, 'Mac mini');
  assert.deepEqual(
    v.chat.filter((r: any) => r.kind === 'user').map((r: any) => [r.text, r.delivery]),
    [['Held for the old MoMo', 'failed']],
    'the old chat’s sent message is not shown in a chat the new home never had',
  );
  assert.deepEqual(w.sentKept, []);
  const problems: any[] = v.problems.filter((p: any) => p.code === 'send_refused');
  assert.match(problems[0].cause, /Not sent: “Held for the old MoMo”\. MoMo was started again, and this was written for the old one\./);
  assert.deepEqual(
    problems.map((p) => p.fix.label),
    ['Send to this MoMo', 'Delete message'],
  );
  assert.equal((await w.b!.home.turn('turn-00000061')).state, 'unknown', 'it was not sent on its own');
  assert.equal(w.entries.length, 1, 'and it was not dropped');
  assert.equal((await w.intent({ kind: 'fix', id: 'retry-send:turn-00000061' })).ok, true);
  await waitFor(() => w.b!.home.turn('turn-00000061').then((x: any) => x.state === 'accepted'), 'it to go to this MoMo');
});

test('a send that was out when MoMo was reset writes nothing when it returns, and neither does a read of the rows', async (t) => {
  const w = await homeOnStudio(t);
  let release: () => void = () => undefined;
  w.overrides.set('studio', (method) =>
    method === 'chat.send' ? new Promise((resolve) => (release = () => resolve({ sent: true }))) : undefined,
  );
  const pending = w.intent({ kind: 'send', turnId: 'turn-00000062', text: 'In flight' });
  await waitFor(() => w.calls.some((c) => c.method === 'chat.send'), 'the send to start');
  // MoMo is reset on this Mac meanwhile: what it kept is erased
  w.real.forget();
  w.entries.length = 0;
  w.sentKept.length = 0;
  release();
  await pending;
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual([w.entries, w.sentKept], [[], []], 'a Reset is not undone by a send that finished after it');
  // the rows of the home are read again after a Reset only for the home that is there afterwards
  let hold: () => void = () => undefined;
  let taken = false;
  w.overrides.set('studio', (method) => {
    if (method !== 'host.momoRows' || taken) return undefined;
    taken = true;
    return new Promise((resolve) => (hold = () => resolve({ rows: FIXTURE_ROWS.slice(0, 2), next: FIXTURE_AT + 1 })));
  });
  const look = w.real.refresh();
  await waitFor(() => taken, 'the rows to be asked for');
  w.real.forget();
  hold();
  await look;
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(
    (await w.view()).chat.filter((r: any) => r.kind === 'approval'),
    [],
    'the rows read before the Reset do not come back',
  );
});

test('a storage problem on this Mac never turns a message the Host took into one that failed, and a message that cannot be held says why', async (t) => {
  const w = await homeOnStudio(t);
  w.breakStorage('MoPilot can’t encrypt MoMo’s messages right now (the system keychain is unavailable).');
  // a home that runs takes it: the Host has it, and the Mac says the storage is the problem
  const sent = await w.intent({ kind: 'send', turnId: 'turn-00000063', text: 'Goes anyway' });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  assert.equal((await w.a.home.turn('turn-00000063')).state, 'accepted');
  const v = await w.view();
  assert.deepEqual(
    v.chat.filter((r: any) => r.kind === 'user').map((r: any) => [r.text, r.delivery]),
    [['Goes anyway', 'accepted']],
  );
  assert.match(
    (v.problems.find((p: any) => p.code === 'storage') as any).cause,
    /keychain is unavailable\)\. Messages can’t be kept until that is fixed\./,
  );
  // a home that sleeps cannot be written to: the message cannot wait, and the person is told why and keeps the text
  w.down.add('studio');
  w.clock.at += 10 * 60_000;
  const held = await w.intent({ kind: 'send', turnId: 'turn-00000064', text: 'Cannot wait' });
  assert.equal(held.ok, false);
  assert.match(held.cause, /keychain is unavailable\)\. A message can’t wait for MoMo until that is fixed\./);
  // fixed: the problem goes with the next write that works
  w.breakStorage('');
  assert.equal((await w.intent({ kind: 'send', turnId: 'turn-00000064', text: 'Can wait now' })).ok, true);
  assert.equal(
    (await w.view()).problems.some((p: any) => p.code === 'storage'),
    false,
  );
});

test('a message sent again keeps its place in the chat, and a refusal is still there after a restart', async (t) => {
  const w = await homeOnStudio(t);
  w.down.add('studio');
  await w.intent({ kind: 'send', turnId: 'turn-00000070', text: 'First' });
  await w.intent({ kind: 'send', turnId: 'turn-00000071', text: 'Second' });
  w.down.delete('studio');
  w.overrides.set('studio', (method) => {
    if (method === 'chat.send') throw Object.assign(new Error('MoMo does not take that.'), { code: 'momo_refused' });
    return undefined;
  });
  w.restart();
  await w.real.refresh();
  await waitFor(() => w.entries.every((e: any) => e.refusal), 'both to be refused');
  // the refusal is the entry's own: a new app still says why
  w.restart();
  const again = await w.view();
  assert.match((again.problems.find((p: any) => p.code === 'send_refused') as any).cause, /MoMo does not take that\./);
  w.overrides.clear();
  // the second is sent again first: it does not jump the first
  assert.equal((await w.intent({ kind: 'fix', id: 'retry-send:turn-00000071' })).ok, true);
  assert.deepEqual(
    (await w.view()).chat.filter((r: any) => r.kind === 'user').map((r: any) => r.text),
    ['First', 'Second'],
  );
});
