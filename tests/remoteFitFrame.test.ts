// An event kept within one sealed frame: long strings are cut and noted, nothing else changes, and what cannot fit is reported.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rig, settle } from './support/remote-kit.ts';

const require = createRequire(import.meta.url);
const { fitEvent, NOTE } = require('../electron/remote/fitFrame.cjs');
const size = (v: unknown) => Buffer.byteLength(JSON.stringify(v));

test('an event that fits is returned as it is', () => {
  const event = { ev: 'items.append', items: [{ id: 'a', text: 'short' }] };
  assert.equal(fitEvent(event, 1000), event);
});

test('long strings are cut with a note, short ones, numbers and nulls stay, and the result fits', () => {
  const event = {
    ev: 'items.replace',
    n: 3,
    none: null,
    items: [{ id: 'x', aggregatedOutput: 'y'.repeat(400_000), command: 'npm test' }, 'z'.repeat(10)],
  };
  const fitted = fitEvent(event, 200_000)!;
  assert.ok(size(fitted) <= 200_000);
  assert.equal(fitted.items[0].command, 'npm test');
  assert.equal(fitted.items[1], 'zzzzzzzzzz');
  assert.deepEqual([fitted.n, fitted.none, fitted.items[0].id], [3, null, 'x']);
  const first = fitted.items[0] as { aggregatedOutput: string };
  assert.ok(first.aggregatedOutput.startsWith('yyyy') && first.aggregatedOutput.endsWith(NOTE));
  assert.equal((event.items[0] as { aggregatedOutput: string }).aggregatedOutput.length, 400_000, 'the original is untouched');
});

test('several large strings are cut further until the event fits, and one that cannot fit gives null', () => {
  const event = { parts: Array.from({ length: 8 }, () => 'p'.repeat(90_000)) };
  const fitted = fitEvent(event, 200_000)!;
  assert.ok(size(fitted) <= 200_000);
  assert.ok(fitted.parts.every((p: string) => p.length < 90_000));
  const many = { parts: Array.from({ length: 2000 }, () => 'q'.repeat(300)) };
  assert.equal(fitEvent(many, 200_000), null);
});

test('a cut never splits a surrogate pair', () => {
  const event = { text: `${'a'.repeat(99_999)}😀${'b'.repeat(200_000)}` };
  const fitted = fitEvent(event, 150_000)!;
  assert.ok(!/[\ud800-\udbff]$/.test(fitted.text.slice(0, -NOTE.length)), 'no lone high surrogate before the note');
});

test('the service sends a followed chat a shortened event instead of dropping it, and an event that cannot fit is still attempted', async () => {
  const r = rig();
  const p = r.phone('p1');
  await p.ask('chat.follow', { chatId: 'c1' });
  r.service.onFeedEvent({ ev: 'items.replace', chatId: 'c1', items: [{ id: 'x', aggregatedOutput: 'o'.repeat(400_000) }] });
  await settle();
  const [event] = p.events('items.replace');
  assert.ok(size(event) <= 200_100);
  assert.ok(event.items[0].aggregatedOutput.endsWith(NOTE));
  r.service.onFeedEvent({
    ev: 'items.replace',
    chatId: 'c1',
    items: Array.from({ length: 2000 }, (_, i) => ({ id: `${i}`, text: 'q'.repeat(300) })),
  });
  await settle();
  assert.equal(p.events('items.replace').length, 2, 'handed to the transport as it is; the memory link carries it');
});

test('a followed chat keeps its other items when one of them is huge: the huge one is shortened, not everything before it dropped', async () => {
  const items = Array.from({ length: 12 }, (_, i) => ({ id: `i${i}`, role: i === 0 ? 'user' : 'step', text: `row ${i}` }));
  items[6] = { id: 'big', role: 'step', text: 'o'.repeat(600_000) };
  const r = rig({ ops: { items: async (_id: string, n: number) => ({ itemsShape: 'rows', items: items.slice(-n) }) } });
  const snap = (await r.phone('p1').ask('chat.follow', { chatId: 'c1', items: 50 })).result;
  assert.ok(size(snap) <= 200_100);
  assert.equal(snap.items.length, 12, 'no item is left out');
  assert.equal(snap.items[0].text, 'row 0');
  assert.ok(snap.items[6].text.endsWith(NOTE) && snap.items[6].text.length < 600_000);
  assert.equal(snap.items[11].text, 'row 11');
});

test('many ordinary items that together exceed one frame still lose the oldest ones whole rather than being cut', async () => {
  const items = Array.from({ length: 40 }, (_, i) => ({ id: `i${i}`, role: 'assistant', text: `${i}:${'t'.repeat(9_000)}` }));
  const r = rig({ ops: { items: async (_id: string, n: number) => ({ itemsShape: 'rows', items: items.slice(-n) }) } });
  const snap = (await r.phone('p1').ask('chat.follow', { chatId: 'c1', items: 40 })).result;
  assert.ok(size(snap) <= 200_100);
  assert.ok(snap.items.length < 40 && snap.items.length > 5);
  assert.ok(
    snap.items.every((item: any) => !item.text.endsWith(NOTE)),
    'what is kept is whole',
  );
  assert.equal(snap.items.at(-1).id, 'i39');
});

test('a long message that is not huge is never cut to keep older items: the oldest go whole instead', async () => {
  const items = Array.from({ length: 12 }, (_, i) => ({ id: `i${i}`, role: 'assistant', text: `${i}:${'t'.repeat(30_000)}` }));
  const r = rig({ ops: { items: async (_id: string, n: number) => ({ itemsShape: 'rows', items: items.slice(-n) }) } });
  const snap = (await r.phone('p1').ask('chat.follow', { chatId: 'c1', items: 12 })).result;
  assert.ok(size(snap) <= 200_100);
  assert.ok(snap.items.length < 12);
  assert.ok(snap.items.every((item: any) => item.text.length === 30_002 || item.text.length === 30_003));
});

test('when cutting the huge strings is not enough the older items go whole, and the newest item is kept', async () => {
  const items = Array.from({ length: 8 }, (_, i) => ({ id: `i${i}`, role: 'step', text: `${i}:${'o'.repeat(400_000)}` }));
  const r = rig({ ops: { items: async (_id: string, n: number) => ({ itemsShape: 'rows', items: items.slice(-n) }) } });
  const snap = (await r.phone('p1').ask('chat.follow', { chatId: 'c1', items: 8 })).result;
  assert.ok(size(snap) <= 200_100);
  assert.ok(snap.items.length >= 1 && snap.items.length < 8);
  assert.equal(snap.items.at(-1).id, 'i7');
});
