// The data budget of a followed turn: events pass freely until a share of the budget is spent, then a tool item's long strings are cut with a note; the person's own reading (assistant, user, reasoning, plan) is never cut, and each phone, chat and turn counts apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rig } from './support/remote-kit.ts';

const require = createRequire(import.meta.url);
const { createEventBudget, SOFT_BYTES, TAIL_CHARS } = require('../electron/remote/eventBudget.cjs');
const { NOTE } = require('../electron/remote/fitFrame.cjs');
const chatMethods = require('../electron/remote/methods/chat.cjs');

const tool = (chars: number) => ({ type: 'commandExecution', id: 'x', command: 'npm test', aggregatedOutput: 'o'.repeat(chars) });
const append = (...items: any[]) => ({ ev: 'items.append', chatId: 'c1', items });

test('within the budget an event passes as it is', () => {
  const b = createEventBudget({ soft: 1000, cap: 50 });
  const e = append(tool(400));
  assert.equal(b.fit('p1', 'c1', e), e, 'the same object, nothing copied');
});

test('once the budget is spent a tool item’s long strings are cut with a note, and nothing the person reads is', () => {
  const b = createEventBudget({ soft: 1000, cap: 50 });
  b.fit('p1', 'c1', append(tool(1200)));
  const prose = [
    { type: 'agentMessage', id: 'm', text: 'a'.repeat(5000) },
    { type: 'userMessage', id: 'u', content: [{ type: 'text', text: 'u'.repeat(5000) }] },
    { type: 'reasoning', id: 'r', summary: ['s'.repeat(5000)] },
    { type: 'plan', id: 'pl', text: 'p'.repeat(5000) },
  ];
  const out: any = b.fit('p1', 'c1', append(tool(9000), ...prose, null));
  assert.equal(out.items[0].aggregatedOutput, `${'o'.repeat(50)}${NOTE}`);
  assert.equal(out.items[0].command, 'npm test', 'short strings stay');
  assert.deepEqual(out.items.slice(1, 5), prose, 'the messages are whole');
  assert.equal(out.items[5], null, 'an item that is not an object passes through');
});

test('events with no items (a delta, the turn state) are never touched, whatever has been spent', () => {
  const b = createEventBudget({ soft: 10, cap: 5 });
  b.fit('p1', 'c1', append(tool(500)));
  const delta = { ev: 'items.delta', chatId: 'c1', itemId: 'm', field: 'text', text: 'word '.repeat(100) };
  assert.equal(b.fit('p1', 'c1', delta), delta);
});

test('a turn starting or ending starts the count again, and a phone or chat counts apart', () => {
  const b = createEventBudget({ soft: 1000, cap: 50 });
  b.fit('p1', 'c1', append(tool(1200)));
  assert.notEqual((b.fit('p1', 'c1', append(tool(300))) as any).items[0].aggregatedOutput.length, 300, 'spent: cut');
  assert.equal((b.fit('p2', 'c1', append(tool(300))) as any).items[0].aggregatedOutput.length, 300, 'another phone has its own');
  assert.equal((b.fit('p1', 'c2', append(tool(300))) as any).items[0].aggregatedOutput.length, 300, 'another chat has its own');
  b.fit('p1', 'c1', { ev: 'turn.state', chatId: 'c1', started: true });
  assert.equal((b.fit('p1', 'c1', append(tool(300))) as any).items[0].aggregatedOutput.length, 300, 'a new turn: whole again');
});

test('the longer readable item types are never cut either', () => {
  const b = createEventBudget({ soft: 10, cap: 5 });
  b.fit('p1', 'c1', append(tool(500)));
  const notes = [
    { type: 'statusNote', text: 'n'.repeat(500) },
    { type: 'contextCompaction', summary: 's'.repeat(500) },
    { type: 'exitedReviewMode', review: 'r'.repeat(500) },
  ];
  assert.deepEqual((b.fit('p1', 'c1', append(...notes)) as any).items, notes);
});

test('a phone that starts or stops following a chat starts its count again', () => {
  const b = createEventBudget({ soft: 1000, cap: 50 });
  b.fit('p1', 'c1', append(tool(1200)));
  assert.notEqual((b.fit('p1', 'c1', append(tool(300))) as any).items[0].aggregatedOutput.length, 300, 'spent: cut');
  b.forget('p1', 'c1');
  assert.equal((b.fit('p1', 'c1', append(tool(300))) as any).items[0].aggregatedOutput.length, 300, 'forgotten: whole again');
  b.forget('p9', 'c9');
});

test('at most KEEP phones and chats are remembered; the oldest is forgotten and counts from zero', () => {
  const b = createEventBudget({ soft: 100, cap: 10 });
  b.fit('p0', 'c', append(tool(500)));
  for (let i = 1; i <= 500; i++) b.fit(`p${i}`, 'c', append(tool(5)));
  assert.equal((b.fit('p0', 'c', append(tool(300))) as any).items[0].aggregatedOutput.length, 300, 'forgotten: not cut');
});

test('the defaults leave room under 2 MB once the wire adds its share', () => {
  assert.ok(SOFT_BYTES * 1.5 + 2 * 1024 < 2 * 1024 * 1024 * 0.7, 'the soft share, sealed and framed, is well under the budget');
  assert.ok(TAIL_CHARS < 5000);
  const b = createEventBudget();
  const e = append(tool(100));
  assert.equal(b.fit('p', 'c', e), e);
});

test('chat.follow and chat.unfollow start the phone’s count for that chat again', async () => {
  const forgotten: string[][] = [];
  const r = rig();
  const svc = r.service;
  svc.budget.forget = (...key: string[]) => forgotten.push(key);
  const client = svc.phones.get('p1').client;
  await chatMethods['chat.follow'](svc, client, { chatId: 'c1', items: 5 });
  assert.deepEqual(forgotten, [['p1', 'c1']]);
  chatMethods['chat.unfollow'](svc, client, { chatId: 'c1' });
  assert.deepEqual(forgotten, [
    ['p1', 'c1'],
    ['p1', 'c1'],
  ]);
  svc.detach();
});
