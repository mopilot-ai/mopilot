// The phone's side of a Host push: opening the sealed card blob into lock-screen text and routing the tap to the waiting card on that Host.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { createCardPush } from '../shared/remote/cardPush.mjs';
import { chatRef } from '../shared/remote/ref.mjs';
import { openHostPush } from '../mobile/src/push/hostCard';
import { locateTarget } from '../mobile/src/push/route';

const require = createRequire(import.meta.url);
const prim = require('../electron/platform/sodiumPrimitives.cjs').createSodiumPrimitives();
const cards = createCardPush(prim);
const key = cards.cardKey(new Uint8Array(32).fill(4));
const ref = chatRef('hp', 'c1');
const sealed = (state?: string) =>
  cards.seal({ key, ref, requestId: 'q1', rev: 1, detail: 'tool', state, card: { machine: 'build-box', tool: 'delete' } })!;

test('a Host push opens to text, the request id and its tool; anything else keeps the fixed title', () => {
  const p = { kind: 'needsYou' as const, ref, count: 1, sealedTitle: sealed() };
  assert.deepEqual(openHostPush(p, cards, [key]), {
    requestId: 'q1',
    rev: 1,
    title: 'build-box · delete files',
    body: '',
    state: undefined,
    tool: 'delete',
  });
  assert.equal(
    openHostPush({ ...p, kind: 'done' as const, sealedTitle: sealed('cleared') }, cards, [key])?.title,
    'A chat no longer needs you',
  );
  assert.equal(openHostPush({ ...p, sealedTitle: undefined }, cards, [key]), null);
  assert.equal(openHostPush({ ...p, kind: 'momoNeedsYou' as const }, cards, [key]), null);
  assert.equal(openHostPush(p, cards, [cards.cardKey(new Uint8Array(32).fill(5))]), null);
  assert.equal(openHostPush({ ...p, ref: 'other' }, cards, [key]), null);
});

const loc = (o: Record<string, unknown>) => ({ pairs: ['mac'], chatIds: async () => [], current: () => true, ...o }) as any;
const payload = { kind: 'needsYou' as const, ref, count: 1 };

test('a tap on a Host push opens the waiting card of that enrollment', async () => {
  const hostCards = async (pair: string) =>
    pair === 'hp'
      ? [
          { chatId: 'c1', requestId: 'q0' },
          { chatId: 'c1', requestId: 'q1' },
          { chatId: 'c2', requestId: 'z' },
        ]
      : [];
  const l = loc({ hostPairs: ['hx', 'hp'], hostCards });
  assert.deepEqual(await locateTarget(payload, l), { pairId: 'hp', chatId: 'c1', host: { requestId: 'q0' } });
  assert.deepEqual(await locateTarget({ ...payload, requestId: 'q1' }, l), { pairId: 'hp', chatId: 'c1', host: { requestId: 'q1' } });
  assert.deepEqual(await locateTarget({ ...payload, requestId: 'gone' }, l), { pairId: 'hp', chatId: 'c1', host: { requestId: 'q0' } });
});

test('an unreachable Host is skipped, a replaced tap stops, and a Mac chat is still found', async () => {
  const down = async () => {
    throw new Error('offline');
  };
  assert.equal(await locateTarget(payload, loc({ hostPairs: ['hp'], hostCards: down })), null);
  assert.equal(await locateTarget(payload, loc({ hostPairs: ['hp'], hostCards: async () => [], current: () => false })), null);
  assert.equal(await locateTarget(payload, loc({ hostPairs: ['hp'] })), null);
  const mac = loc({ hostPairs: ['hp'], hostCards: async () => [], chatIds: async () => ['c1'] });
  assert.deepEqual(await locateTarget({ ...payload, ref: chatRef('mac', 'c1') }, mac), { pairId: 'mac', chatId: 'c1' });
});
