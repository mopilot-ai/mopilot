// Shared send receipt validation: queued failures stay main-owned, and malformed answers never claim acceptance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendReceipt, acceptSendReceipt } from '../shared/sendReceipt.mjs';

test('native acceptance, held input and discarded commands have explicit receipts', () => {
  assert.deepEqual(sendReceipt({ started: true }, 'x', false), { action: 'started', id: 'x' });
  assert.deepEqual(sendReceipt({ started: true }, 'x', false, 'steered'), { action: 'steered', id: 'x' });
  assert.deepEqual(sendReceipt({ held: true }, 'x', false), { action: 'held', id: 'x' });
  assert.deepEqual(sendReceipt({ discarded: true }, 'x', false), { action: 'discarded', id: 'x' });
  for (const action of ['started', 'steered', 'held', 'discarded', 'queued']) assert.equal(acceptSendReceipt({ action, id: 'x' }), null);
});

test('failure distinguishes input retained by main from a rejected request', () => {
  for (const result of [null, undefined, {}, { started: false }]) {
    const receipt = sendReceipt(result, 'id', true);
    assert.equal(receipt.action, 'queued');
    assert.equal(acceptSendReceipt(receipt), 'The harness did not accept the message.');
  }
  const kept = sendReceipt({ error: 'list_turns is not supported yet' }, 'id', true);
  assert.equal(acceptSendReceipt(kept), 'list_turns is not supported yet');
  assert.throws(() => acceptSendReceipt(sendReceipt({ error: 'refused' }, 'id', false)), /refused/);
  assert.equal(acceptSendReceipt({ action: 'queued', id: 'id', error: 42 }), null);
});

test('malformed receipts reject instead of silently clearing the composer', () => {
  for (const value of [
    null,
    undefined,
    [],
    {},
    { id: 4, action: 'started' },
    { id: '', action: 'started' },
    { id: 'x' },
    { id: 'x', action: 'bogus' },
    { id: 'x', action: 'failed', error: '' },
  ])
    assert.throws(() => acceptSendReceipt(value), /The harness did not accept/);
  assert.throws(() => acceptSendReceipt({ id: 'x', action: 'failed', error: 'specific reason' }), /specific reason/);
});
