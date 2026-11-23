// Trusted Host client ids and ownership guards survive the production queue/copy boundary without marking human input automatic or serializing capabilities.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  identifyInput,
  clientIdOf,
  guardSend,
  carryInputGuard,
  assertInputCurrent,
  inputIsGuarded,
} = require('../electron/session/contract/inputGuard.cjs');
const { SessionStore } = require('../electron/session/state.cjs');
const { queueItem } = require('../electron/session/queueItem.cjs');

test('trusted Host identity and revocation reach a queued input and adapter copy; raw caller fields cannot supply it', () => {
  const item = { id: 'request-key', text: 'look', attachments: [], opts: { human: true } };
  identifyInput(item, 'request-key');
  let valid = true;
  guardSend(item, () => {
    if (!valid) throw new Error('retired');
  });
  const queued = queueItem(item, null);
  const adapter = carryInputGuard(queued, { ...queued });
  assert.equal(clientIdOf(adapter), 'request-key');
  assert.equal(inputIsGuarded(adapter), false, 'a human input stays ordinary');
  assertInputCurrent(adapter);
  valid = false;
  assert.throws(() => assertInputCurrent(adapter), /retired/);
  assert.equal(JSON.stringify(adapter).includes('retired'), false);
  assert.equal(clientIdOf(JSON.parse(JSON.stringify(adapter))) === 'request-key', false, 'serialized data carries no trusted identity');
  assert.notEqual(clientIdOf({ clientId: 'request-key', id: 'request-key' }), 'request-key');
  assert.equal(queueItem(undefined, null).text, '');
});

test('SessionStore cloning and drain retain trusted identity and revocation only in the authoritative main mirror', () => {
  const state = new SessionStore();
  let valid = true;
  const items = ['first', 'second'].map((id) => {
    const item = { id, text: id, attachments: [], opts: {} };
    identifyInput(item, id);
    guardSend(item, () => {
      if (!valid) throw new Error('retired');
    });
    return queueItem(item, null);
  });
  state.patch('chat', { queue: items });
  const plain = state.snapshot('chat').queue;
  assert.notEqual(clientIdOf(plain[0]), 'first');
  assert.equal(clientIdOf(state.get('chat').queue[0]), 'first');
  const next = state.takeNext('chat', () => false);
  assert.equal(clientIdOf(next), 'first');
  assert.equal(clientIdOf(state.get('chat').queue[0]), 'second');
  valid = false;
  assert.throws(() => assertInputCurrent(next), /retired/);
  assert.throws(() => assertInputCurrent(state.takeNext('chat', () => false)), /retired/);
  assert.doesNotThrow(() => assertInputCurrent(plain[0]));
});
