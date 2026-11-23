// Main's ACP text deltas reach the store once per frame (src/session/harness/acp.ts), in the order main sent them, with the same text.
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { fx, reset, called, tick } from './support/harness-logic-fakes.ts';
const acp = await import('../src/session/harness/acp.ts');
let event: (e: any) => void;
let items: (e: any) => void;

beforeEach(async () => {
  reset();
  (globalThis as any).window = new EventTarget();
  fx.native.acp = {
    onEvent: (f: any) => (event = f),
    onItems: (f: any) => (items = f),
    onHarnesses() {},
    onSignIns() {},
    signIns: async () => ({}),
    harnesses: async () => [],
    list: async () => [],
  };
  acp.startAcp();
  await tick();
});

const send = (key: string, method: string, params: any) => items({ chatId: key, key, method, params: { threadId: key, ...params } });
const chunk = (key: string, turnId: string, delta: string) => send(key, 'item/agentMessage/delta', { turnId, itemId: 'm', delta });
const methods = () => called('applyNotification').map(([method]) => method);

test('many chunks of a reply are one delta delivered with the next frame, ahead of the turn ending', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const key = 'acp:kimi:frame';
  const pieces = Array.from({ length: 300 }, (_, i) => `w${i} `);
  for (const p of pieces) chunk(key, 'T', p);
  assert.equal(called('applyNotification').filter(([m]) => m === 'item/agentMessage/delta').length, 0, 'held for the frame');
  t.mock.timers.tick(100);
  const deltas = called('applyNotification').filter(([m]) => m === 'item/agentMessage/delta');
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0][1].delta, pieces.join(''));
});

test('a notification that is not a delta delivers the held text first, so the order stays', () => {
  const key = 'acp:kimi:order';
  chunk(key, 'T', 'a');
  chunk(key, 'T', 'b');
  send(key, 'turn/completed', { turn: { id: 'T', status: 'completed' } });
  const order = methods();
  const delta = order.indexOf('item/agentMessage/delta');
  assert.ok(delta >= 0);
  assert.ok(delta < order.indexOf('turn/completed'));
  assert.equal(called('applyNotification')[delta][1].delta, 'ab');
});

test('a status note and a provider error also come after the text held before them', () => {
  const key = 'acp:kimi:notes';
  chunk(key, 'T', 'partial');
  event({ kind: 'providerError', key, turnId: 'T', error: { message: 'busy' } });
  const order = methods();
  assert.ok(order.indexOf('item/agentMessage/delta') < order.indexOf('error'));
});
