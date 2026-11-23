// The dev host's stand-in for MoMo's channels (scripts/mobile-dev-host/fakeMomoChannels.mjs, scenariosMomoChannels.mjs, `momo-channels [on|off|seed]`): the fake Mac keeps the Mac's own registry and words its refusals as the Mac does, makes a channel's chat on first use and drops it on delete, answers off when the bench says so, and the scenario seeds a few channels or turns them off; the real phone methods run over it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createFakeApp } from '../scripts/mobile-dev-host/fakeApp.mjs';
import { createFakeMomo } from '../scripts/mobile-dev-host/fakeMomo.mjs';
import { createFakeChannels } from '../scripts/mobile-dev-host/fakeMomoChannels.mjs';
import { momoChannelsScenario, withMomoChannels } from '../scripts/mobile-dev-host/scenariosMomoChannels.mjs';

const require = createRequire(import.meta.url);
const methods = require('../electron/remote/methods/momoChannels.cjs');
const chatMethods = require('../electron/remote/methods/momo.cjs');
const NOW = new Date(2026, 10, 15, 12, 0).getTime();

function rig() {
  const app = createFakeApp({ repo: '/repo', now: () => NOW, sleep: async () => undefined, status: async () => '' });
  app.bind({ attached: true, onFeedEvent: () => undefined, onSessionPatch: () => undefined });
  const bench = { channels: true };
  const told: string[] = [];
  const fake = createFakeChannels({ app, enabled: () => bench.channels, changed: (a) => void told.push(a), now: () => NOW });
  const momo = createFakeMomo({ app, brainChangeAllowed: () => true, changed: () => undefined, now: () => NOW, channels: fake });
  const svc: any = { momo: () => momo, assertPaired: () => undefined };
  const call = (m: string, p: any = {}) => (methods as any)[m](svc, {}, p);
  return { app, bench, told, fake, momo, svc, call };
}
const refused = (p: Promise<unknown>, code: string, message?: RegExp) =>
  assert.rejects(p, (e: any) => e.code === code && (!message || message.test(e.message)));

test('the phone methods run over the fake: list, create by name, rename, move, archive, delete, groups; each tells the phones', async () => {
  const { call, told, momo } = rig();
  assert.deepEqual(await call('momo.channels.list'), { enabled: true, channels: [], groups: [], room: 12 });
  const group = (await call('momo.channels.group.create', { name: 'Home' })).group;
  const made = (await call('momo.channels.create', { name: 'Kitchen', group: group.id })).channel;
  assert.equal(made.group, group.id);
  assert.equal((await call('momo.channels.rename', { channelId: made.id, name: 'Galley' })).channel.name, 'Galley');
  assert.equal((await call('momo.channels.move', { channelId: made.id, group: null })).channel.group, null);
  assert.equal((await call('momo.channels.welcome', { channelId: made.id, answer: 'yes' })).channel.welcome, 'yes');
  assert.equal((await call('momo.channels.group.rename', { groupId: group.id, name: 'House' })).group.name, 'House');
  assert.equal((await call('momo.channels.group.delete', { groupId: group.id })).removed, true);
  const other = (await call('momo.channels.create', { name: 'Garden' })).channel;
  assert.deepEqual(await call('momo.channels.archive', { channelId: made.id }), { id: made.id });
  // a channel's chat is made on first use, hidden, and goes with the channel
  const chat = await momo.chatFor(other.id);
  assert.match(chat, /^dev-momo-channel-/);
  const fresh = (await call('momo.channels.create', { name: 'Fresh' })).channel;
  assert.equal(await momo.chatFor(fresh.id, false), null, 'reading makes no chat');
  assert.equal(await momo.chatFor(other.id, false), chat);
  assert.equal(await momo.chatFor(made.id, true).catch(() => 'gone'), 'gone');
  assert.deepEqual(await call('momo.channels.delete', { channelId: other.id }), { id: other.id });
  assert.equal(told.length, 11);
  assert.ok(told.every((a) => a === 'channels'));
});

test('the fake words its refusals as the Mac does and answers off when the bench says so', async () => {
  const { call, bench, momo, app } = rig();
  await call('momo.channels.create', { name: 'Kitchen' });
  await refused(call('momo.channels.create', { name: 'kitchen' }), 'invalid', /already have one with that name/);
  await refused(call('momo.channels.rename', { channelId: 'ch_ffffffffffffffff', name: 'x' }), 'gone');
  await refused(momo.chatFor('ch_ffffffffffffffff'), 'gone');
  assert.equal(momo.channels!.isChannelChat('dev-momo-channel-nothing'), false);
  assert.throws(() => momo.channels!.assertChannel('ch_ffffffffffffffff'), /isn’t there any more/);
  const kitchen = (await call('momo.channels.list')).channels[0];
  assert.doesNotThrow(() => momo.channels!.assertChannel(kitchen.id));
  const chat = await momo.chatFor(kitchen.id);
  assert.equal(momo.channels!.isChannelChat(chat), true);
  assert.equal(app.chats.has(chat), true);
  for (let i = 0; i < 11; i++) await call('momo.channels.create', { name: `c${i}` });
  await refused(call('momo.channels.create', { name: 'one more' }), 'invalid', /12 channels/);
  bench.channels = false;
  assert.deepEqual(await call('momo.channels.list'), { enabled: false, channels: [], groups: [], room: 0 });
  await refused(call('momo.channels.create', { name: 'x' }), 'forbidden', /Channels are off/);
  await refused(momo.chatFor(kitchen.id), 'forbidden');
  assert.throws(() => momo.channels!.assertChannel(kitchen.id), /Channels are off/);
  assert.equal(momo.channels!.isChannelChat(chat), false);
});

test('the chat methods take a channel from the fake, and Main is the default; one fake made without channels is an older Mac', async () => {
  const { svc, call, momo } = rig();
  const made = (await call('momo.channels.create', { name: 'Trip' })).channel;
  const main = await momo.chatFor(undefined);
  const chan = await momo.chatFor(made.id);
  assert.notEqual(main, chan);
  svc.paired = () => false;
  svc.followers = () => [];
  svc.ledger = { forget: () => undefined };
  svc.cardUpdates = { follow: () => ({ owner: 1, request: 1 }) };
  svc.snapshot = async (id: string) => ({ chatId: id });
  const client: any = { follows: { owners: new Map(), requests: new Map(), delete: () => undefined, has: () => false } };
  assert.equal((await (chatMethods as any)['momo.chat.follow'](svc, client, { items: 5, channelId: made.id })).chatId, chan);
  assert.equal((await (chatMethods as any)['momo.chat.follow'](svc, client, { items: 5 })).chatId, main);
  const older = createFakeMomo({
    app: createFakeApp({ repo: '/repo', now: () => NOW, sleep: async () => undefined, status: async () => '' }),
    brainChangeAllowed: () => true,
    changed: () => undefined,
  });
  assert.equal(older.channels, null);
  assert.equal(await older.chatFor('ch_0123456789abcdef'), await older.mainChatId());
});

test('seed gives the bench two groups and three channels; on and off flip it and tell the phones; any other word is refused', async () => {
  const { fake, bench, told } = rig();
  const bare: { channels?: boolean } = {};
  const s = momoChannelsScenario(bare, fake, (a) => void told.push(a));
  assert.equal(s.usage, 'momo-channels [on|off|seed|push [channel]]');
  assert.match(await s.run([]), /channels are on: the open MoMo page reads it at once/);
  assert.equal(bare.channels, true);
  assert.match(await s.run(['OFF']), /channels are off/);
  assert.equal(bare.channels, false);
  assert.match(await s.run(['seed']), /on with 3 channels in 2 groups/);
  assert.equal(bare.channels, true);
  assert.deepEqual(
    (await fake.list()).channels.map((c: any) => c.name),
    ['Trip', 'Kitchen', 'Garden'],
  );
  assert.deepEqual(
    (await fake.list()).groups.map((g: any) => g.name),
    ['Home', 'Work'],
  );
  await assert.rejects(s.run(['maybe']), /Usage: momo-channels \[on\|off\|seed\|push \[channel\]\]/);
  assert.ok(told.includes('channels'));
  void bench;
});

test('the host adds the scenario to the others: listed, run by name, every other name still goes to the others', async () => {
  const { fake } = rig();
  const ran: string[][] = [];
  const base = {
    list: () => [{ usage: 'momo', about: 'MoMo allowed or not' }],
    run: (name: string, args: string[] = []) => (ran.push([name, ...args]), `ran ${name}`),
  };
  const bench: { channels?: boolean } = {};
  const all = withMomoChannels(base, bench, fake, () => undefined);
  assert.deepEqual(
    all.list().map((s) => s.usage),
    ['momo', 'momo-channels [on|off|seed|push [channel]]'],
  );
  assert.equal(all.run('momo', ['on']), 'ran momo');
  assert.deepEqual(ran, [['momo', 'on']]);
  assert.match(String(await all.run('momo-channels', ['off'])), /channels are off/);
  assert.equal(bench.channels, false);
  assert.equal(all.run('momo'), 'ran momo');
});

test('a card raised in a channel is answered and settled in that channel, and main shows nothing of it', async () => {
  const { call, momo, app } = rig();
  const trip = (await call('momo.channels.create', { name: 'Trip' })).channel;
  const chatId = await momo.chatFor(trip.id);
  const main = await momo.mainChatId();
  const { momoActionCard } = require('../electron/remote/momoCard.cjs');
  const card = momoActionCard({
    action: 'change',
    source: 'Mail',
    account: 'work',
    summary: 'Send the plan',
    hosts: [],
    unknown: false,
    denyAlways: true,
    scopes: ['once', 'chat'],
    recipients: [],
    recipientCount: 0,
    blocked: '',
  });
  void app.enqueue(app.chats.get(chatId), async (t: any) => {
    await t.ask({ title: card.title, detail: card.detail, choices: card.choices });
    await t.say('Sent the plan.');
  });
  await until(async () => (await app.ops.cardsOf(chatId)).length === 1);
  const [raised] = await app.ops.cardsOf(chatId);
  // it waits in the channel's chat, not in main's
  assert.equal((await app.ops.cardsOf(main)).length, 0);
  const approval = momo.cardOf(chatId, raised.id);
  assert.ok(approval);
  assert.equal(momo.cardOf(main, raised.id), null);
  assert.equal(momo.answerCard(approval, card.choices[0].key), true);
  // a card nobody holds settles nothing
  assert.equal(momo.answerCard({ id: 'nobody-holds-this' }, 'x'), false);
  await until(async () => (await app.ops.cardsOf(chatId)).length === 0);
  await until(() => app.chats.get(chatId).rows.some((r: any) => String(r.text).includes('Sent the plan.')));
  const mainRows = app.chats.get(main).rows.map((r: any) => String(r.text));
  assert.ok(!mainRows.some((t: string) => /Sent the plan|answered|Send the plan/.test(t)), JSON.stringify(mainRows));
});

const until = async (check: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('timed out');
};

test('push raises a card in a channel and sends a needs-you push for its chat; the card waits there, and a missing channel is said', async () => {
  const { fake, app, momo } = rig();
  const sent: string[][] = [];
  const s = momoChannelsScenario(
    { channels: true },
    fake,
    () => undefined,
    (name: string, args: string[]) => (sent.push([name, ...args]), 'push sent'),
  );
  await assert.rejects(s.run(['push']), /No channel yet: run momo-channels seed/);
  await fake.seed();
  assert.equal(await s.run(['push', 'Kitchen']), 'a card waits in #Kitchen; push sent');
  const kitchen = (await fake.list()).channels.find((c: any) => c.name === 'Kitchen');
  const chatId = await momo.chatFor(kitchen?.id, false);
  const [raisedCard] = await app.ops.cardsOf(chatId);
  // a MoMo needs-you push naming the channel and the card, as the Mac's push does (ref and card are handles of those ids)
  assert.deepEqual(sent, [['push', 'momoNeedsYou', chatId, `channel=${kitchen?.id}`, `card=${raisedCard.id}`]]);
  await until(async () => (await app.ops.cardsOf(chatId)).length === 1);
  // asking again raises no second card; the first open channel is the default
  await s.run(['push', 'kitchen']);
  assert.equal((await app.ops.cardsOf(chatId)).length, 1);
  assert.match(await s.run(['push']), /^a card waits in #Trip; push sent$/);
  await assert.rejects(s.run(['push', 'Nowhere']), /No channel Nowhere\./);
  // the card is the channel's: Main has none
  assert.equal((await app.ops.cardsOf(await momo.mainChatId())).length, 0);
  // denied, the turn says so in the channel (a missing run hook sends nothing)
  const [raised] = await app.ops.cardsOf(chatId);
  assert.equal(momo.answerCard(momo.cardOf(chatId, raised.id), 'deny'), true);
  await until(() => app.chats.get(chatId).rows.some((r: any) => String(r.text).includes('Understood, I did not run it.')));
  // allowed, the turn goes on
  const tripId = await momo.chatFor((await fake.list()).channels.find((c: any) => c.name === 'Trip')?.id, false);
  await until(async () => (await app.ops.cardsOf(tripId)).length === 1);
  const [tripCard] = await app.ops.cardsOf(tripId);
  assert.equal(momo.answerCard(momo.cardOf(tripId, tripCard.id), 'once'), true);
  await until(() => app.chats.get(tripId).rows.some((r: any) => String(r.text).includes('Ran git status --short')));
  const quiet = momoChannelsScenario({ channels: true }, fake, () => undefined);
  assert.match(await quiet.run(['push', 'Trip']), /^a card waits in #Trip; undefined$/);
});

for (const panel of [false, true]) {
  test(`the stand-in’s Tasks list (${panel ? 'four tabs' : 'classic'}) lists a channel’s waiting card naming its channel, only while channels are on, and tells no chat id`, async () => {
    const app = createFakeApp({ repo: '/repo', now: () => NOW, sleep: async () => undefined, status: async () => '' });
    app.bind({ attached: true, onFeedEvent: () => undefined, onSessionPatch: () => undefined });
    const bench = { channels: true };
    const fake = createFakeChannels({ app, enabled: () => bench.channels, changed: () => undefined, now: () => NOW });
    const momo = createFakeMomo({
      app,
      brainChangeAllowed: () => true,
      changed: () => undefined,
      now: () => NOW,
      channels: fake,
      tasksPanel: () => panel,
    });
    await fake.seed();
    const card = await fake.raiseCard('Kitchen');
    // Main's own card beside it names no channel
    assert.equal(await momo.tasks.raiseCard(), true);
    const list: any = await momo.tasks.list();
    const mainRow = list.tasks.find((t: any) => t.kind === 'card' && !t.channel);
    assert.ok(mainRow, 'Main’s card is listed with no channel');
    const row = list.tasks.find((t: any) => t.kind === 'card' && t.channel);
    assert.deepEqual([row.title, row.channel?.name, row.ref], ['Run this command?', 'Kitchen', card.cardId]);
    assert.equal(row.id, `card:${card.id}:${card.cardId}`);
    assert.ok(!JSON.stringify(list).includes(card.chatId), 'the phone is told no chat id');
    // channels off: the channel's card is not listed
    bench.channels = false;
    const off: any = await momo.tasks.list();
    assert.deepEqual(
      off.tasks.filter((t: any) => t.kind === 'card').map((t: any) => t.channel),
      [null],
    );
    assert.equal((await app.ops.cardsOf(card.chatId)).length, 1);
  });
}
