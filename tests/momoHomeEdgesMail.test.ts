// The edges of the messages, the fixes and the confirmations of MoMo's real home (shared/momoHomeMail.mjs, momoHomeFix.mjs, momoHomeOlder.mjs, momoHomeTurns.mjs, momoHomeConfirm.mjs, momoOutbox.mjs), on real in-process Hosts: a
// Host that refuses with no words or no code, a service that stops under a send, a log that overflows, storage that fails under a retry, a turn the Host cannot say, a confirmation that ran out and the words of each choice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OUTBOX_MAX } from '../shared/momoHomeMail.mjs';
import { A, B, record, world } from './support/momoHomeRealWorld.ts';
import { waitFor } from './support/waitFor.ts';

async function homeOnStudio(t: any, opts: any = {}) {
  const w = await world(t, { second: true, ...opts });
  assert.equal((await w.intent({ kind: 'choose-home', machineId: 'studio' })).ok, true);
  return w;
}
const answers = (w: any, f: (method: string, p: any) => any) => w.overrides.set('studio', f);

test('a Host that refuses a message with no words or no code is told in the app’s words, and a long message is cut in the card that says it was not sent', async (t) => {
  const w = await homeOnStudio(t);
  answers(w, (method) => {
    if (method === 'chat.send') throw Object.assign(new Error(''), { code: 'momo_home_away' });
    return undefined;
  });
  assert.match((await w.intent({ kind: 'send', turnId: 'turn-00000001', text: 'Hi' })).cause, /MoMo could not take that message\./);
  answers(w, (method) => {
    if (method === 'chat.send') throw Object.assign(new Error('Nobody home.'), { code: 'chat_gone' });
    return undefined;
  });
  const long = 'A long message that goes on for much more than forty characters';
  assert.match((await w.intent({ kind: 'send', turnId: 'turn-00000002', text: long })).cause, /Nobody home\./);
  // held, not sent: its card cuts the text
  w.down.add('studio');
  w.clock.at += 10_000;
  await w.real.refresh();
  await w.intent({ kind: 'send', turnId: 'turn-00000003', text: long });
  w.outbox.refuse('turn-00000003', 'The Host said no.');
  const cards: any[] = (await w.view()).problems.filter((p: any) => p.code === 'send_refused');
  assert.match(cards[0].cause, /Not sent: “A long message that goes on for much mor…”/);
  const short = (await w.intent({ kind: 'send', turnId: 'turn-00000004', text: 'Short' })).ok;
  assert.equal(short, true);
  w.outbox.refuse('turn-00000004', 'No.');
  assert.ok(((await w.view()).problems as any[]).some((p) => /Not sent: “Short”/.test(p.cause)));
});

test('a service that stops or is reset under a send says MoMo is not here, and writes nothing', async (t) => {
  const w = await homeOnStudio(t);
  let release: (v: unknown) => void = () => undefined;
  let held = false;
  answers(w, (method) => {
    if (method !== 'chat.send' || held) return undefined;
    held = true;
    return new Promise((resolve, reject) => (release = () => reject(Object.assign(new Error('too late'), { code: 'momo_home_away' }))));
  });
  const sending = w.intent({ kind: 'send', turnId: 'turn-00000001', text: 'Hi' });
  await waitFor(() => held, 'the send to be out');
  w.real.forget();
  release(null);
  assert.match((await sending).cause, /MoMo is not here any more/);
  // stopped while the chat is being found
  const v = await homeOnStudio(t);
  v.real.dispose();
  assert.equal((await v.intent({ kind: 'send', turnId: 'turn-00000001', text: 'Hi' })).ok, false);
});

test('the sent log keeps the newest hundred, a held message that is asked for again is allowed when the outbox is full, and a retry or a delete of what is not waiting is refused', async (t) => {
  const w = await homeOnStudio(t);
  answers(w, (method) => (method === 'chat.send' ? { sent: true } : undefined));
  for (let i = 0; i < 101; i++) await w.intent({ kind: 'send', turnId: `turn-sent-${String(i).padStart(4, '0')}`, text: `m${i}` });
  assert.equal(w.sentKept.length, 100);
  // retry and delete name a message that is not there
  assert.match((await w.intent({ kind: 'fix', id: 'retry-send:turn-nothing' })).cause, /not waiting any more/);
  assert.match((await w.intent({ kind: 'fix', id: 'delete-send:turn-nothing' })).cause, /not waiting any more/);
  // the outbox is full while MoMo sleeps; a message that is already held may be sent again
  const v = await homeOnStudio(t);
  v.down.add('studio');
  for (let i = 0; i < OUTBOX_MAX; i++) await v.intent({ kind: 'send', turnId: `turn-full-${String(i).padStart(4, '0')}`, text: `m${i}` });
  assert.equal((await v.intent({ kind: 'send', turnId: 'turn-full-0000', text: 'm0' })).ok, true);
});

test('a retry or a delete that the Mac cannot keep says why, and a retry with no home to name goes without one', async (t) => {
  const w = await homeOnStudio(t);
  w.down.add('studio');
  await w.intent({ kind: 'send', turnId: 'turn-00000001', text: 'Hi' });
  w.outbox.refuse('turn-00000001', 'No.');
  w.breakStorage('The system key is gone.');
  assert.match((await w.intent({ kind: 'fix', id: 'retry-send:turn-00000001' })).cause, /system key is gone/);
  assert.match((await w.intent({ kind: 'fix', id: 'delete-send:turn-00000001' })).cause, /system key is gone/);
  // a first run: nothing to name, and a message that was refused is renewed with no home
  const f = await world(t);
  f.outbox.save({ turnId: 'turn-00000002', chatId: '', text: 'Hi' });
  f.outbox.refuse('turn-00000002', 'No.');
  assert.equal((await f.intent({ kind: 'fix', id: 'retry-send:turn-00000002' })).ok, true);
  assert.equal(f.entries.find((e: any) => e.turnId === 'turn-00000002').homeId, undefined);
});

test('a held message that a plain failure stops is told, and the chat MoMo needs is refused in words when no agent is signed in or the Host makes none', async (t) => {
  const w = await homeOnStudio(t);
  w.down.add('studio');
  await w.intent({ kind: 'send', turnId: 'turn-00000001', text: 'Held' });
  w.down.delete('studio');
  w.clock.at += 10_000;
  answers(w, (method) => {
    if (method === 'host.momoChat') throw new Error('The chat could not start.');
    return undefined;
  });
  w.restart();
  await w.real.refresh();
  await waitFor(() => w.reports.some((e: any) => /could not start/.test(e.message)), 'the plain failure to be told');
  // a Host that answers no chat, and a machine with no agent signed in
  const v = await homeOnStudio(t);
  answers(v, (method) => (method === 'host.momoChat' ? {} : undefined));
  assert.match((await v.intent({ kind: 'send', turnId: 'turn-00000001', text: 'Hi' })).cause, /could not start MoMo’s chat/);
  const n = await world(t);
  n.machines.splice(
    0,
    1,
    record('studio', A.name, A.homeId, { agents: [{ id: 'claude', name: 'Claude Code', installed: true, signedIn: false }] }),
  );
  await n.a.home.start(A);
  n.clock.at += 10_000;
  await n.real.refresh();
  assert.match((await n.intent({ kind: 'send', turnId: 'turn-00000001', text: 'Hi' })).cause, /No agent is signed in/);
});

test('a turn the Host cannot name is unknown, and one the Host says nothing of leaves the ledger unknown', async (t) => {
  const w = await homeOnStudio(t);
  await w.intent({ kind: 'send', turnId: 'turn-00000005', text: 'Hi' });
  answers(w, (method) => (method === 'host.momoTurn' ? {} : undefined));
  assert.equal((await w.intent({ kind: 'check-turn', turnId: 'turn-00000005' })).turn, 'missing');
  answers(w, (method) => (method === 'host.momoTurn' ? { state: 'accepted' } : undefined));
  assert.equal((await w.intent({ kind: 'check-turn', turnId: 'turn-00000005' })).turn, 'has');
  // a turn the Host holds that this Mac never wrote: the Host has it, and nothing is said about a held copy
  assert.equal((await w.intent({ kind: 'check-turn', turnId: 'turn-00000099' })).turn, 'has');
});

test('a confirmation that ran out is refused, and asked for again', async (t) => {
  const w = await world(t, { second: true });
  w.down.add('studio');
  const asked = await w.intent({ kind: 'fix', id: 'start-fresh' });
  w.clock.at += 6 * 60_000;
  assert.match((await w.intent({ kind: 'fix', id: asked.fix.id })).cause, /has to be asked first/);
  const again = await w.intent({ kind: 'fix', id: 'start-fresh' });
  assert.equal((await w.intent({ kind: 'fix', id: again.fix.id })).ok, true);
});

test('Start fresh says nothing is lost when a MoMo is found, and a choice made at a machine says why it is refused for each cause', async (t) => {
  const w = await homeOnStudio(t);
  assert.match((await w.intent({ kind: 'fix', id: 'start-fresh' })).cause, /nothing is lost|can still be found/);
  // MoMo is remembered and the way back is not offered: the machine it lived on has no name written down
  const r = await world(t, { second: true });
  await r.intent({ kind: 'choose-home', machineId: 'studio' });
  r.down.add('studio');
  r.clock.at += 10_000;
  await r.real.refresh();
  assert.match((await r.intent({ kind: 'choose-home', machineId: 'mini' })).cause, /already has a home, Studio/);
  // a moved MoMo with no name on its tombstone, and a machine that did not answer with no name to say
  const m = await world(t, { second: true });
  m.overrides.set('studio', (method) =>
    method === 'host.momoHomeLook' ? { holds: 'moved', leaseEpoch: 2, movedTo: { homeId: B.homeId }, grantLive: true } : undefined,
  );
  assert.match((await m.intent({ kind: 'choose-home', machineId: 'mini' })).cause, /MoMo moved to another machine\./);
});

test('a reclaim that no machine can answer says the last refusal, and a move that is asked about with no id begins from the status', async (t) => {
  const w = await homeOnStudio(t);
  const refused = await w.intent({ kind: 'reclaim', toId: 'mini' });
  assert.equal(refused.ok, false);
  const none = await w.intent({ kind: 'reclaim' });
  assert.equal(none.ok, false);
});

test('a reclaim with no other machine to ask says so, and a held message sent again while MoMo sleeps is renewed for the home it was remembered on', async (t) => {
  const one = await world(t);
  await one.intent({ kind: 'choose-home', machineId: 'studio' });
  assert.match((await one.intent({ kind: 'reclaim' })).cause, /no other machine to ask about the move/);
  const w = await homeOnStudio(t);
  w.down.add('studio');
  w.clock.at += 10_000;
  await w.real.refresh();
  await w.intent({ kind: 'send', turnId: 'turn-00000001', text: 'Hi' });
  w.outbox.refuse('turn-00000001', 'No.');
  assert.equal((await w.intent({ kind: 'fix', id: 'retry-send:turn-00000001' })).ok, true);
  assert.equal(w.entries.find((e: any) => e.turnId === 'turn-00000001').homeId, A.homeId);
});

test('every chat request carries the chat’s epoch as the Host gave it, and a Host that gives no epoch does not get a message', async (t) => {
  const w = await homeOnStudio(t);
  const sent: any[] = [];
  answers(w, (method, p) => {
    if (method === 'host.momoChat') return { chatId: 'claude:c1', epoch: 7 };
    if (method === 'chat.send') return sent.push(p), { sent: true };
    return undefined;
  });
  assert.equal((await w.intent({ kind: 'send', turnId: 'turn-00000001', text: 'Hi' })).ok, true);
  assert.equal(sent[0].epoch, 7, 'the epoch the chat is at now, asked for with each message');
  answers(w, (method) => (method === 'host.momoChat' ? { chatId: 'claude:c1' } : undefined));
  assert.match((await w.intent({ kind: 'send', turnId: 'turn-00000002', text: 'Hi' })).cause, /could not start MoMo’s chat/);
});
