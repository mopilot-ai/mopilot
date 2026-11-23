// src/store/notifications.ts with src/store/core.ts patchStreamedItem: one delivered delta is one store commit,
// the first delta of an item (which adds it) included, and the items it builds are what they were.
import { test, mock, beforeEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, resetAll, flush, listeners, bootImpls, impl } from './support/store-harness.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const { store, resetState } = await loadStore();
const { flushStreamNotifications } = await import('../src/store/notifications.ts');
const S = store;
const st = () => S.useStore.getState();
const note = (method: string, params: any) => listeners['codex.onItem']({ kind: 'notification', chatId: params.threadId, method, params });
const T = { threadId: 'c', turnId: 'T' };

before(async () => {
  bootImpls();
  await S.boot();
  await flush();
});
beforeEach(() => {
  resetState();
  resetAll();
  impl['session.snapshot'] = async () => null;
});

/** How many store commits `fn` makes. */
function commits(fn: () => void) {
  let n = 0;
  const stop = S.useStore.subscribe(() => n++);
  fn();
  flushStreamNotifications();
  stop();
  return n;
}

test('each delta is one commit, the first one of an item too', () => {
  const cases: [string, any][] = [
    ['item/agentMessage/delta', { itemId: 'm', delta: 'Hi' }],
    ['item/plan/delta', { itemId: 'p', delta: 'step' }],
    ['item/reasoning/summaryPartAdded', { itemId: 'r', summaryIndex: 1 }],
    ['item/reasoning/summaryTextDelta', { itemId: 'r2', summaryIndex: 0, delta: 'think' }],
    ['item/reasoning/textDelta', { itemId: 'r3', delta: 'raw' }],
    ['item/commandExecution/outputDelta', { itemId: 'm', delta: 'x' }],
  ];
  for (const [method, p] of cases) {
    assert.equal(
      commits(() => note(method, { ...T, ...p })),
      1,
      `${method}, first`,
    );
    assert.equal(
      commits(() => note(method, { ...T, ...p })),
      1,
      `${method}, again`,
    );
  }
  const items = st().runtime.c.turns[0].items as any[];
  assert.deepEqual(
    items.map((i) => [i.id, i.type]),
    [
      ['m', 'agentMessage'],
      ['p', 'plan'],
      ['r', 'reasoning'],
      ['r2', 'reasoning'],
      ['r3', 'reasoning'],
    ],
  );
  assert.equal(items[0].text, 'HiHi');
  assert.equal(items[0].aggregatedOutput, 'xx', 'output joins an item that is there');
  assert.equal(items[1].text, 'stepstep');
  assert.deepEqual(items[2].summary, ['', '']);
  assert.deepEqual(items[3].summary, ['thinkthink']);
  assert.deepEqual(items[4].content, ['rawraw']);
  assert.deepEqual(Object.keys(st().runtime.c.turns[0].itemTimes).sort(), ['m', 'p', 'r', 'r2', 'r3']);
  // two new reasoning items never share their parts
  assert.notEqual(items[3].content, items[4].content);
});

test('output for an item that is not there adds nothing', () => {
  assert.equal(
    commits(() => note('item/commandExecution/outputDelta', { ...T, itemId: 'none', delta: 'x' })),
    1,
  );
  assert.deepEqual(st().runtime.c.turns[0].items, []);
});
