// The send-id learner reads a computer's hello once per connection and ignores replies from a retired one.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSendIdLearner } from '../mobile/src/remote/sendIdLearner.ts';

function make(request: () => Promise<unknown>) {
  const state = { generation: 1, calls: 0 };
  const sendIds = new Map<string, boolean>();
  const lastSendIds = new Map<string, boolean>();
  const learn = createSendIdLearner({
    request: () => (state.calls++, request()),
    generation: () => state.generation,
    sendIds,
    lastSendIds,
  });
  return { state, sendIds, lastSendIds, learn };
}

test('records the capability once per connection', async () => {
  const t = make(async () => ({ capabilities: { sendId: true } }));
  assert.equal(await t.learn('p1'), true);
  assert.equal(await t.learn('p1'), true);
  assert.equal(t.state.calls, 1);
  assert.equal(t.sendIds.get('p1'), true);
  assert.equal(t.lastSendIds.get('p1'), true);
});

test('a hello without the capability is recorded as unsupported', async () => {
  const t = make(async () => ({}));
  assert.equal(await t.learn('p1'), true);
  assert.equal(t.sendIds.get('p1'), false);
  const nullHello = make(async () => null);
  assert.equal(await nullHello.learn('p1'), true);
  assert.equal(nullHello.lastSendIds.get('p1'), false);
});

test('a failing hello reaches the caller, unless the connection changed meanwhile', async () => {
  const failing = make(() => Promise.reject(new Error('offline')));
  await assert.rejects(failing.learn('p1'), /offline/);
  assert.equal(failing.sendIds.has('p1'), false);
  const retired = make(async () => {
    retired.state.generation++;
    throw new Error('closed');
  });
  assert.equal(await retired.learn('p1'), false);
  assert.equal(retired.sendIds.has('p1'), false);
  const late = make(async () => {
    late.state.generation++;
    return { capabilities: { sendId: true } };
  });
  assert.equal(await late.learn('p1'), false);
  assert.equal(late.lastSendIds.has('p1'), false);
});
