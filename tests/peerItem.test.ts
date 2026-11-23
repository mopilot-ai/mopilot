import { test } from 'node:test';
import assert from 'node:assert/strict';
import { peerForItem } from '../src/lib/peerItem.ts';
import type { PeerMessage } from '../shared/peerMessages.ts';
const message = {
  id: 'journal-id',
  sourceChatId: 'A',
  targetChatId: 'B',
  targetItemId: 'native-id',
  delivery: 'delivered',
  body: 'Request',
} as PeerMessage;

test('peer presentation matches the native receipt on its recipient, regardless of harness', () => {
  assert.equal(peerForItem([message], 'B', { clientId: 'journal-id' }), message);
  assert.equal(peerForItem([message], 'B', { id: 'native-id' }), message);
  assert.equal(peerForItem([message], 'B', { id: 'journal-id' }), message);
  assert.equal(peerForItem([message], 'A', { id: 'native-id' }), undefined);
});
test('prompt content cannot forge peer identity, and undelivered requests do not label native items', () => {
  assert.equal(peerForItem([message], 'B', { id: 'ordinary-user' }), undefined);
  for (const delivery of ['queued', 'blocked', 'failed', 'cancelled'] as const)
    assert.equal(peerForItem([{ ...message, delivery }], 'B', { id: 'native-id' }), undefined);
});
