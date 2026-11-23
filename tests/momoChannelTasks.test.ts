// MoMo's Tasks lists the cards waiting in every open channel as well as Main's (A2, #4846; electron/momo/tasks.cjs, tasksPanel.cjs): each channel's row names its channel and the chat it waits in, card ids are each chat's own so the two never share a task id, channels are listed only while the flag is on, and a phone is not told a chat id.
import './support/tz-la.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ok, askSlow, momoRig } from './support/remote-momo-kit.ts';
import { parseTasks, TASKS_METHOD, channelOf } from '../mobile/src/momo/tasksContract';

const require = createRequire(import.meta.url);
const { deriveTasks, waitingCards } = require('../electron/momo/tasks.cjs');
const { deriveTaskPanel } = require('../electron/momo/tasksPanel.cjs');
const { reviewRoute } = await import('../src/components/momo/tasks/reviewRoute.ts');

const NOW = Date.UTC(2026, 10, 3, 12);
const card = (id: any, summary: string) => ({ id, params: { kind: 'momoAction', momo: { summary, source: 'Mail' } } });
const KITCHEN = { id: 'ch_0000000000000001', name: 'Kitchen' };
const TRIP = { id: 'ch_0000000000000002', name: 'Trip' };
const chatOf: Record<string, string> = { [KITCHEN.id]: 'chat-kitchen', [TRIP.id]: 'chat-trip' };

/** A controller holding approvals per chat, and the channels' registry as main wires it. */
function world(on = true) {
  const approvals: Record<string, any[]> = {
    'chat-main': [card(1, 'Send the invoice'), { id: 'x', params: { kind: 'other' } }],
    'chat-kitchen': [card(1, 'Order the oven')],
    'chat-trip': [card(9, 'Book the hotel')],
  };
  const controller = { state: { has: (id: string) => id in approvals, get: (id: string) => ({ approvals: approvals[id] }) } };
  const channels = {
    enabled: () => on,
    registry: {
      list: () => ({ channels: [KITCHEN, TRIP, { id: 'ch_nochat', name: 'New' }] }),
      chatIdOf: (id: string) => chatOf[id] ?? null,
    },
  };
  return { controller, channels, approvals, main: { mainChatId: () => 'chat-main' } };
}

test('waiting cards: main’s and every open channel’s, each naming its channel and chat; none of the channels’ while the flag is off or without a channels service', () => {
  const w = world();
  const rows = waitingCards(w.controller, w.main, w.channels).map((a: any) => [a.id, a.chatId, a.channel?.name ?? null]);
  assert.deepEqual(rows, [
    [1, 'chat-main', null],
    [1, 'chat-kitchen', 'Kitchen'],
    [9, 'chat-trip', 'Trip'],
  ]);
  const off = world(false);
  assert.deepEqual(
    waitingCards(off.controller, off.main, off.channels).map((a: any) => a.id),
    [1],
  );
  assert.deepEqual(
    waitingCards(w.controller, w.main).map((a: any) => a.chatId),
    ['chat-main'],
  );
});

test('the classic list and the four tabs list a channel’s card naming its channel; card 1 of two chats are two tasks', () => {
  const w = world();
  const cards = waitingCards(w.controller, w.main, w.channels);
  const list = deriveTasks({ runs: [], routineName: () => 'x', loops: [], cards, now: NOW });
  assert.deepEqual(
    list.map((t: any) => [t.id, t.title, t.ref, t.channel?.name ?? null, t.chatId]),
    [
      ['card:1', 'Send the invoice', '1', null, 'chat-main'],
      [`card:${KITCHEN.id}:1`, 'Order the oven', '1', 'Kitchen', 'chat-kitchen'],
      [`card:${TRIP.id}:9`, 'Book the hotel', '9', 'Trip', 'chat-trip'],
    ],
  );
  const panel = deriveTaskPanel({
    runs: [],
    routineName: () => 'x',
    routines: [],
    nextRun: () => null,
    loops: [],
    cards,
    marks: {},
    now: NOW,
  });
  assert.deepEqual(
    panel.map((t: any) => [t.id, t.tab, t.state, t.channel?.name ?? null, t.chatId]),
    [
      ['card:1', 'active', 'needs-you', null, 'chat-main'],
      [`card:${KITCHEN.id}:1`, 'active', 'needs-you', 'Kitchen', 'chat-kitchen'],
      [`card:${TRIP.id}:9`, 'active', 'needs-you', 'Trip', 'chat-trip'],
    ],
  );
  // a card from an older caller names no channel and no chat
  const [old] = deriveTasks({ runs: [], routineName: () => 'x', loops: [], cards: [card(5, 'Old')], now: NOW });
  assert.deepEqual([old.channel, old.chatId], [null, null]);
  const [oldRow] = deriveTaskPanel({
    runs: [],
    routineName: () => 'x',
    routines: [],
    nextRun: () => null,
    loops: [],
    cards: [card(5, 'Old')],
    marks: {},
    now: NOW,
  });
  assert.deepEqual([oldRow.channel, oldRow.chatId], [null, null]);
});

test('several cards pending in one channel are several rows, each its own task; answering one leaves the others', () => {
  // a chat's session keeps a list of approvals (parallel tool calls each ask), so Tasks lists every one, not one row per chat
  const w = world();
  w.approvals['chat-kitchen'] = [card(1, 'Order the oven'), card(2, 'Order the hood'), card(3, 'Order the fridge')];
  const rows = (cards: any[]) =>
    deriveTasks({ runs: [], routineName: () => 'x', loops: [], cards, now: NOW }).map((t: any) => [t.id, t.title]);
  const all = waitingCards(w.controller, w.main, w.channels);
  assert.deepEqual(
    rows(all).filter(([id]: string[]) => id.startsWith(`card:${KITCHEN.id}:`)),
    [
      [`card:${KITCHEN.id}:1`, 'Order the oven'],
      [`card:${KITCHEN.id}:2`, 'Order the hood'],
      [`card:${KITCHEN.id}:3`, 'Order the fridge'],
    ],
  );
  // the first is answered: it leaves, the other two stay, in the same order
  w.approvals['chat-kitchen'].shift();
  assert.deepEqual(
    rows(waitingCards(w.controller, w.main, w.channels)).filter(([id]: string[]) => id.startsWith(`card:${KITCHEN.id}:`)),
    [
      [`card:${KITCHEN.id}:2`, 'Order the hood'],
      [`card:${KITCHEN.id}:3`, 'Order the fridge'],
    ],
  );
});

test('Review on a card opens the chat it waits in: a channel’s own chat, Main’s page for main’s card', () => {
  assert.deepEqual(reviewRoute({ channel: KITCHEN, chatId: 'chat-kitchen' }), { name: 'momo', tab: 'chat', chatId: 'chat-kitchen' });
  assert.deepEqual(reviewRoute({ channel: null, chatId: 'chat-main' }), { name: 'momo', tab: 'chat' });
  assert.deepEqual(reviewRoute({}), { name: 'momo', tab: 'chat' });
  // a channel row whose chat is not known falls back to Main's page rather than a route to nowhere
  assert.deepEqual(reviewRoute({ channel: KITCHEN, chatId: null }), { name: 'momo', tab: 'chat' });
});

test('a phone is told the channel of a card and never the chat it waits in; its parser reads the channel', async () => {
  const m = momoRig();
  const p = m.r.phone('p1');
  const made = await m.channelsRegistry.create('Kitchen');
  await m.channelsRegistry.linkChat(made.id, 'chat-kitchen');
  m.controller.state.has = () => true;
  m.controller.state.get = () => ({ approvals: [card('a1', 'Order the oven')] }) as any;
  const res = ok(await askSlow(p, TASKS_METHOD));
  const rows = res.tasks.filter((t: any) => t.kind === 'card');
  // the same card id in Main's chat and the channel's chat: two tasks, the channel's naming it
  assert.deepEqual(
    rows.map((t: any) => [t.id, t.channel?.name ?? null]),
    [
      ['card:a1', null],
      [`card:${made.id}:a1`, 'Kitchen'],
    ],
  );
  assert.ok(!JSON.stringify(res).includes('chat-kitchen'), 'a phone is told no chat id');
  assert.deepEqual(
    parseTasks(res)
      .filter((t) => t.kind === 'card')
      .map((t) => t.channel?.name ?? null),
    [null, 'Kitchen'],
  );
  assert.deepEqual(channelOf({ id: 'x' }), null);
  assert.deepEqual(channelOf(null), null);
});

test('inside MoMo’s services Tasks lists a channel’s waiting card and its needs-you notice names the channel, while channels are on', async () => {
  const { world: appWorld } = await import('./support/momoAppWorld.ts');
  const w = appWorld({ allowed: true, prefs: { momo: { channels: true, tasksPanel: true } } });
  const made: any = await w.call('momoChannels:create', 'Kitchen');
  await w.m.channelsApi.registry.linkChat(made.channel.id, 'mc');
  w.chats.patchMeta('mc', { momo: `channel:${made.channel.id}` });
  w.sessionState.set('mc', { approvals: [card('a1', 'Order the oven')] });
  w.live.controller.state.has = (id: string) => id === 'mc';
  w.live.controller.state.get = () => ({ approvals: [card('a1', 'Order the oven')] });
  const list: any = await w.call('momoTasks:list');
  const row = list.tasks.find((t: any) => t.kind === 'card');
  assert.deepEqual([row.channel.name, row.chatId, row.id], ['Kitchen', 'mc', `card:${made.channel.id}:a1`]);
  // MoMo's chat of a channel says "needs you" naming the channel; the notifier hears the id it hands the push
  assert.equal(w.live.notifier.quiet('approval', 'mc', { cardId: 'a1' }), true);
  assert.equal(w.live.notifier.shown.at(-1)[2].channelId, made.channel.id);
  // a MoMo chat that is no channel's (Main's) says "needs you" naming none
  w.chats.patchMeta('mm', { momo: 'main' });
  assert.equal(w.live.notifier.quiet('approval', 'mm', { cardId: 'a2' }), true);
  assert.equal('channelId' in w.live.notifier.shown.at(-1)[2], false);
  // channels off: no card from the channel, and the notice names no channel
  w.prefs = { ...w.prefs, momo: { ...w.prefs.momo, channels: false } };
  assert.equal(((await w.call('momoTasks:list')) as any).tasks.filter((t: any) => t.kind === 'card').length, 0);
  w.live.notifier.quiet('approval', 'mc', { cardId: 'a1' });
  assert.equal('channelId' in w.live.notifier.shown.at(-1)[2], false);
  await w.m.close();
});
