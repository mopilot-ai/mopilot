// A paired phone's MoMo channels (A2: electron/remote/methods/momoChannels.cjs and momo.cjs over remote/momoChannelOps.cjs over the momoChannels:* handlers): the new methods are listed only for an account MoMo is allowed for; channels are listed, made by name, renamed, moved, archived and deleted as a window does them (and told to phones as `channels`); the chat methods take an optional `channelId` validated against the list, default to main, and refuse an unknown or archived id; with the Mac's flag off the list says so and every change is refused; and a phone's id is only ever a channel, never a chat.
import './support/tz-la.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rig } from './support/remote-kit.ts';
import { ok, fail, UNINVITED, UNKNOWN_MOMO, askSlow, momoRig, MOMO_METHODS } from './support/remote-momo-kit.ts';
import { world } from './support/momoWorld.ts';

const require = createRequire(import.meta.url);
const { parseParams } = require('../shared/remote/schema.mjs');
const { CHANGED_AREA } = require('../electron/remote/momoOps.cjs');
const { createChannels, memoryStorage } = require('../electron/momo/channels.cjs');
const { createChannelChats } = require('../electron/momo/channelChats.cjs');
const { registerChannelsIpc } = require('../electron/momo/channelsIpc.cjs');

const NEW = [
  'momo.channels.list',
  'momo.channels.create',
  'momo.channels.rename',
  'momo.channels.archive',
  'momo.channels.delete',
  'momo.channels.move',
  'momo.channels.welcome',
  'momo.channels.group.create',
  'momo.channels.group.rename',
  'momo.channels.group.delete',
];
const GHOST = 'ch_ffffffffffffffff';

/** The phone rig of remote-momo-kit with channels over the real main chat service and chats store (tests/support/momoWorld.ts). */
function channelRig(o: { enabled?: boolean } = {}) {
  const m = momoRig();
  const w = world();
  let n = 0;
  const channels = createChannels({ storage: memoryStorage(), newId: () => (++n).toString(16).padStart(16, '0') });
  const state = { enabled: o.enabled ?? true };
  const chats = createChannelChats({
    channels,
    mainChat: w.svc,
    chats: w.chats,
    allowed: () => m.gate.allowed,
    enabled: () => state.enabled,
    stop: (id: string) => m.stopped.push(id),
    deleteChat: async () => undefined,
    changed: () => undefined,
  });
  registerChannelsIpc(m.wired.ipc, {
    channels,
    chats,
    everything: { list: () => ({ rows: [], filters: [], unavailable: false }) } as any,
    allowed: () => m.gate.allowed,
    enabled: () => state.enabled,
    broadcast: (ch: string) => m.wired.broadcast(ch),
  });
  (m.live as any).momo = { channelsApi: { chats, registry: channels, enabled: () => state.enabled } };
  m.remote = m.wired.attach({
    live: m.live,
    mainChat: m.mainChat,
    readState: () => ({ prefs: { momo: {} } }),
    runAttended: async () => undefined,
    allowed: () => m.gate.allowed,
    setPref: m.setPref,
  });
  m.r.service.momo = () => m.remote;
  return { m, w, channels, chats, state, p: m.r.phone('p1') };
}

test('the channel methods are listed only for an account MoMo is allowed for, and are refused before anything else for one it is not', async () => {
  const on = rig({ momo: true });
  on.service.momo = () => ({});
  const hello = ok(await on.phone('p1').ask('machine.hello'));
  for (const method of NEW) assert.ok(hello.capabilities.methods.includes(method), method);
  const off = rig({ momo: false });
  const touched: string[] = [];
  off.service.momo = () => new Proxy({}, { get: (_t, k) => (touched.push(String(k)), undefined) });
  const q = off.phone('p1');
  const none = ok(await q.ask('machine.hello'));
  assert.deepEqual(
    none.capabilities.methods.filter((m: string) => m.includes('channel')),
    [],
  );
  for (const method of NEW)
    fail(
      await q.ask(method, { name: 'x', channelId: GHOST, groupId: 'gr_0000000000000000', group: null, answer: 'yes' }),
      'invalid',
      UNKNOWN_MOMO,
    );
  for (const method of ['momo.chat.send', 'momo.chat.follow', 'momo.chat.stop'])
    fail(await q.ask(method, { id: 'a', text: 'x', channelId: GHOST }), 'invalid', UNKNOWN_MOMO);
  assert.deepEqual(touched, []);
  assert.ok(MOMO_METHODS.includes('momo.channels.list'));
});

test('the schema takes a name only, bounds ids and answers, and leaves any chat id out', () => {
  assert.deepEqual(parseParams('momo.channels.create', { name: '  Trip ', chatId: 'x' }), { name: 'Trip', group: null });
  assert.deepEqual(parseParams('momo.channels.create', { name: 'Trip', group: 'gr_0123456789abcdef' }), {
    name: 'Trip',
    group: 'gr_0123456789abcdef',
  });
  assert.deepEqual(parseParams('momo.channels.move', { channelId: 'ch_0123456789abcdef', group: null }), {
    channelId: 'ch_0123456789abcdef',
    group: null,
  });
  assert.deepEqual(parseParams('momo.channels.welcome', { channelId: 'ch_0123456789abcdef', answer: 'later' }), {
    channelId: 'ch_0123456789abcdef',
    answer: 'later',
  });
  assert.deepEqual(parseParams('momo.channels.group.rename', { groupId: 'gr_0123456789abcdef', name: ' A ' }), {
    groupId: 'gr_0123456789abcdef',
    name: 'A',
  });
  for (const [method, params, message] of [
    ['momo.channels.create', { name: '' }, /Give it a name/],
    ['momo.channels.create', { name: 'x'.repeat(121) }, /Give it a name/],
    ['momo.channels.create', { name: 'x', group: 'nope' }, /group isn.t there/],
    ['momo.channels.rename', { channelId: 'main', name: 'x' }, /channel isn.t there/],
    ['momo.channels.archive', { channelId: 7 }, /channel isn.t there/],
    ['momo.channels.delete', {}, /channel isn.t there/],
    ['momo.channels.move', { channelId: 'ch_0123456789abcdef' }, /group isn.t there/],
    ['momo.channels.welcome', { channelId: 'ch_0123456789abcdef', answer: 'maybe' }, /Pick Yes/],
    ['momo.channels.group.delete', { groupId: 'ch_0123456789abcdef' }, /group isn.t there/],
  ] as const)
    assert.throws(() => parseParams(method, params), message, method);
  // the chat methods take an optional channel, and nothing else names a chat
  assert.deepEqual(parseParams('momo.chat.follow', { items: 5, channelId: 'ch_0123456789abcdef', chatId: 'x' }), {
    items: 5,
    channelId: 'ch_0123456789abcdef',
  });
  assert.deepEqual(parseParams('momo.chat.follow', {}), { items: 50 });
  assert.deepEqual(parseParams('momo.chat.unfollow', { channelId: 'ch_0123456789abcdef' }), { channelId: 'ch_0123456789abcdef' });
  assert.deepEqual(parseParams('momo.chat.unfollow', {}), {});
  assert.deepEqual(parseParams('momo.chat.stop', { channelId: 'ch_0123456789abcdef' }), { channelId: 'ch_0123456789abcdef' });
  assert.deepEqual(parseParams('momo.chat.stop', {}), {});
  assert.equal(parseParams('momo.chat.send', { id: 'a', text: 'hi', channelId: 'ch_0123456789abcdef' }).channelId, 'ch_0123456789abcdef');
  assert.equal('channelId' in parseParams('momo.chat.send', { id: 'a', text: 'hi' }), false);
  assert.equal(
    parseParams('momo.card.answer', { cardId: 'a', rev: 1, key: 'once', channelId: 'ch_0123456789abcdef' }).channelId,
    'ch_0123456789abcdef',
  );
  assert.equal(
    parseParams('momo.chat.transcribe', { stream: 'voice-0001', mime: 'audio/wav', channelId: 'ch_0123456789abcdef' }).channelId,
    'ch_0123456789abcdef',
  );
  assert.equal('channelId' in parseParams('momo.chat.transcribe', { stream: 'voice-0001', mime: 'audio/wav' }), false);
  for (const method of ['momo.chat.follow', 'momo.chat.send', 'momo.chat.stop', 'momo.chat.unfollow'])
    assert.throws(() => parseParams(method, { id: 'a', text: 'hi', channelId: 'not-a-channel' }), /channel isn.t there/, method);
});

test('a phone lists, creates by name, renames, moves, answers the first row and deletes a channel, and hears `channels`; main is unchanged', async () => {
  const { m, p } = channelRig();
  const empty = ok(await p.ask('momo.channels.list'));
  assert.deepEqual([empty.enabled, empty.channels, empty.groups, empty.room], [true, [], [], 12]);
  const group = ok(await p.ask('momo.channels.group.create', { name: 'Home' })).group;
  const made = ok(await p.ask('momo.channels.create', { name: 'Kitchen', group: group.id })).channel;
  assert.deepEqual([made.name, made.group], ['Kitchen', group.id]);
  assert.equal(ok(await p.ask('momo.channels.rename', { channelId: made.id, name: 'Kitchen 2' })).channel.name, 'Kitchen 2');
  assert.equal(ok(await p.ask('momo.channels.move', { channelId: made.id, group: null })).channel.group, null);
  assert.equal(ok(await p.ask('momo.channels.welcome', { channelId: made.id, answer: 'no' })).channel.welcome, 'no');
  assert.equal(ok(await p.ask('momo.channels.group.rename', { groupId: group.id, name: 'House' })).group.name, 'House');
  assert.equal(ok(await p.ask('momo.channels.list')).channels.length, 1);
  assert.equal(ok(await p.ask('momo.channels.group.delete', { groupId: group.id })).removed, true);
  assert.deepEqual(ok(await p.ask('momo.channels.archive', { channelId: made.id })), { id: made.id });
  const other = ok(await p.ask('momo.channels.create', { name: 'Other' })).channel;
  assert.deepEqual(ok(await p.ask('momo.channels.delete', { channelId: other.id })), { id: other.id });
  assert.deepEqual(ok(await p.ask('momo.channels.list')).channels, []);
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(p.events('momo.changed').length >= 9 && p.events('momo.changed').every((e: any) => e.area === 'channels'));
  assert.equal(CHANGED_AREA['momoChannels:changed'], 'channels');
  assert.deepEqual(m.sent, []);
});

test('a refusal reaches the phone in the Mac’s own words: a taken name and the cap are invalid, a gone channel is gone', async () => {
  const { p } = channelRig();
  ok(await p.ask('momo.channels.create', { name: 'Kitchen' }));
  fail(await p.ask('momo.channels.create', { name: 'kitchen' }), 'invalid', /already have one with that name/);
  fail(await p.ask('momo.channels.rename', { channelId: GHOST, name: 'x' }), 'gone', /isn’t there any more/);
  fail(await p.ask('momo.channels.archive', { channelId: GHOST }), 'gone');
  fail(await p.ask('momo.channels.move', { channelId: GHOST, group: null }), 'gone');
  fail(await p.ask('momo.channels.group.delete', { groupId: 'gr_0000000000000000' }), 'gone');
  for (let i = 0; i < 11; i++) ok(await p.ask('momo.channels.create', { name: `c${i}` }));
  fail(await p.ask('momo.channels.create', { name: 'one more' }), 'invalid', /12 channels/);
});

test('a phone follows, sends to, stops and unfollows a channel by id; main stays the default and is untouched', async () => {
  const { m, w, p, channels } = channelRig();
  const trip = (ok(await p.ask('momo.channels.create', { name: 'Trip' })) as any).channel;
  const snap = ok(await p.ask('momo.chat.follow', { items: 3, channelId: trip.id }));
  const chatId = channels.chatIdOf(trip.id);
  assert.ok(chatId && chatId !== 'momo-main');
  assert.equal(snap.chatId, chatId);
  assert.equal(m.r.service.followers(chatId).length, 1);
  assert.equal(w.chats.records.get(chatId).meta.momo, `channel:${trip.id}`);
  assert.deepEqual(ok(await p.ask('momo.chat.send', { id: 'c1', text: 'plan the trip', channelId: trip.id })), { sent: true });
  assert.deepEqual(m.sent, [
    [chatId, { id: 'c1', text: 'plan the trip', attachments: [], opts: { human: true }, followUp: 'queue' }, null, true],
  ]);
  assert.deepEqual(ok(await p.ask('momo.chat.stop', { channelId: trip.id })), { stopped: true });
  assert.deepEqual(m.stopped, [chatId]);
  // no channelId: MoMo's main chat, as before
  assert.equal(ok(await p.ask('momo.chat.follow', { items: 3 })).chatId, 'momo-main');
  assert.deepEqual(ok(await p.ask('momo.chat.send', { id: 'm1', text: 'hi main' })), { sent: true });
  assert.equal(m.sent.at(-1)![0], 'momo-main');
  assert.deepEqual(ok(await p.ask('momo.chat.unfollow', { channelId: trip.id })), { unfollowed: true });
  assert.equal(m.r.service.followers(chatId).length, 0);
  assert.equal(m.r.service.followers('momo-main').length, 1);
  // an expected chat that is not the channel's is stale
  fail(await p.ask('momo.chat.send', { id: 'c2', text: 'x', channelId: trip.id, expectedChatId: 'momo-main' }), 'stale');
  assert.deepEqual(ok(await p.ask('momo.chat.send', { id: 'c3', text: 'x', channelId: trip.id, expectedChatId: chatId })), { sent: true });
});

test('an unknown or archived channel is refused by every chat method, and nothing is made, sent or stopped for it', async () => {
  const { m, p, channels, w } = channelRig();
  const gone = (await channels.create('Gone')) as any;
  ok(await p.ask('momo.chat.follow', { channelId: gone.id }));
  const before = w.log.length;
  ok(await p.ask('momo.channels.archive', { channelId: gone.id }));
  for (const channelId of [GHOST, gone.id]) {
    fail(await p.ask('momo.chat.follow', { channelId }), 'gone', /isn’t there any more/);
    fail(await p.ask('momo.chat.send', { id: `s-${channelId}`, text: 'x', channelId }), 'gone');
    fail(await p.ask('momo.chat.stop', { channelId }), 'gone');
    fail(await p.ask('momo.chat.unfollow', { channelId }), 'gone');
    fail(await p.ask('momo.card.answer', { cardId: 'a', rev: 1, key: 'once', channelId }), 'gone');
    fail(await p.ask('momo.chat.transcribe', { stream: 'voice-0001', mime: 'audio/wav', channelId }), 'gone');
  }
  assert.equal(w.log.length, before);
  assert.deepEqual(m.sent, []);
});

test('a channel with no chat yet has nothing to stop, to unfollow or to answer, and reading makes none', async () => {
  const { m, p, channels, w } = channelRig();
  const fresh = (await channels.create('Fresh')) as any;
  assert.deepEqual(ok(await p.ask('momo.chat.stop', { channelId: fresh.id })), { stopped: true });
  assert.deepEqual(ok(await p.ask('momo.chat.unfollow', { channelId: fresh.id })), { unfollowed: true });
  fail(await p.ask('momo.card.answer', { cardId: 'a', rev: 1, key: 'once', channelId: fresh.id }), 'forbidden', /Follow this chat/);
  assert.deepEqual(m.stopped, []);
  assert.equal(channels.chatIdOf(fresh.id), null);
  assert.equal(w.log.length, 0);
});

test('with `momo.channels` off the list says so and shows nothing, every change and every chat call with an id is refused, and main is unaffected', async () => {
  const { m, p, channels, state } = channelRig();
  await channels.create('Kitchen');
  state.enabled = false;
  assert.deepEqual(ok(await p.ask('momo.channels.list')), { enabled: false, channels: [], groups: [], room: 0 });
  fail(await p.ask('momo.channels.create', { name: 'x' }), 'forbidden', /Channels are off/);
  fail(await p.ask('momo.channels.group.create', { name: 'x' }), 'forbidden', /Channels are off/);
  fail(await p.ask('momo.chat.follow', { channelId: GHOST }), 'forbidden', /Channels are off/);
  fail(await p.ask('momo.chat.send', { id: 'o1', text: 'x', channelId: GHOST }), 'forbidden', /Channels are off/);
  fail(await p.ask('momo.chat.transcribe', { stream: 'voice-0001', mime: 'audio/wav', channelId: GHOST }), 'forbidden', /Channels are off/);
  assert.equal(ok(await p.ask('momo.chat.follow', {})).chatId, 'momo-main');
  assert.deepEqual(ok(await p.ask('momo.chat.send', { id: 'o2', text: 'hi' })), { sent: true });
  assert.equal(m.sent.length, 1);
});

test('a Mac whose channel chats service was not made refuses a channel’s chat; MoMo not allowed refuses first; a send to a chat that is neither main nor a channel is stale', async () => {
  const bare = momoRig();
  const p = bare.r.phone('p1');
  assert.equal(ok(await p.ask('momo.channels.list')).enabled, true);
  fail(await p.ask('momo.chat.follow', { channelId: GHOST }), 'forbidden', /Channels are off/);
  // the operations' own check: a chat main does not know and no channel owns is not one a phone reaches
  await assert.rejects(bare.remote.send('other-chat', { id: 'x', text: 'x', followUp: 'queue' }), /main chat changed/);
  const wired = channelRig();
  wired.m.gate.allowed = false;
  fail(await wired.p.ask('momo.channels.list'), 'forbidden', UNINVITED);
  const slow = await askSlow(wired.p, 'momo.channels.create', { name: 'x' });
  fail(slow, 'forbidden', UNINVITED);
});

test('MoMo not ready fails a channel call, and a refusal without words or a known code still says something', async () => {
  const { m, p } = channelRig();
  m.r.service.momo = () => null;
  fail(await p.ask('momo.channels.list'), 'failed', /not ready/);
  const { refusal } = require('../electron/remote/momoChannelOps.cjs');
  assert.deepEqual([refusal({}).code, refusal({}).message], ['failed', 'MoMo could not do that.']);
  assert.equal(refusal({ reason: 'weird', error: 'x' }).code, 'failed');
  assert.equal(refusal({ reason: 'unavailable', error: 'x' }).code, 'forbidden');
});

test('a name that is not text is refused by the schema', () => {
  assert.throws(() => parseParams('momo.channels.create', { name: 7 }), /Give it a name/);
});

test('how many cards wait for the user counts the channels’ chats too, and only while channels are on', async () => {
  const { m, p, channels, state } = channelRig();
  const trip = (await channels.create('Trip')) as any;
  const chatId = ok(await p.ask('momo.chat.follow', { items: 3, channelId: trip.id })).chatId;
  const card = { params: { kind: 'momoAction' } };
  const held: Record<string, any[]> = { 'momo-main': [card], [chatId]: [card, card, { params: { kind: 'other' } }] };
  m.controller.state.get = ((id: string) => ({ approvals: held[id] ?? [] })) as any;
  assert.equal(ok(await p.ask('momo.state.get')).needsYou, 3);
  held['momo-main'] = [];
  assert.equal(ok(await p.ask('momo.state.get')).needsYou, 2);
  state.enabled = false;
  assert.equal(ok(await p.ask('momo.state.get')).needsYou, 0);
});
