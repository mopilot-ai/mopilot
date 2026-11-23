// Projection fallbacks preserve exact queued identity, cap per-generation upload capabilities and never resolve live image ids from saved history.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createStartPairs } = require('../electron/host/turnStartPairs.cjs');
const { createSendProjection } = require('../electron/host/remoteSendProjection.cjs');
const { rememberAttachment, requireAttachments } = require('../electron/remote/attachmentOwners.cjs');
const { historyImageItem } = require('../electron/session/historyImageItem.cjs');
const { withAppChatIds } = require('../electron/host/chatIds.cjs');

test('legacy and full Host user records retain their exact positions in either stream order', () => {
  for (const source of [{ clientId: 'client' }, { user: { clientId: 'from-user', content: [{ type: 'image' }] } }, { key: 7, user: [] }]) {
    const pairs = createStartPairs();
    pairs.take({}, { kind: 'turnStart', turnId: 'turn' });
    const [start] = pairs.take({ t: 'user', turnId: 'turn', text: '', ...source }, null);
    if (source.clientId) assert.equal(start.user.messageKey, 'client');
    if (source.user && !Array.isArray(source.user)) assert.equal(start.user.clientId, 'from-user');
    const other = createStartPairs();
    other.take({}, { kind: 'turnStart', turnId: 'turn', user: [] });
    const [empty] = other.take({}, { kind: 'update', turnId: 'turn' });
    assert.deepEqual(empty.user.content, []);
  }
});

test('sent projection falls back only when no exact key exists and a missing chat never consumes another chat', () => {
  let state: any = { queue: [] };
  const acknowledged: any[] = [];
  const projection = createSendProjection({
    outbox: { pending: () => [], ack: (...args: any[]) => acknowledged.push(args) },
    state: () => ({
      get: () => state,
      patch: (_chat: string, next: any) => {
        state = { ...state, ...next };
      },
    }),
    ownerOf: () => ({ hostId: 'host' }),
    rowOf: () => ({ status: 'online' }),
    connected: () => true,
    signin: new Set(),
    refused: new Map(),
    moved: new Set(),
  });
  assert.equal(projection.sent.take('none', 'absent'), undefined);
  projection.sent.seen('none', 'text', 'absent');
  projection.remember('chat', 'one', 'first', {});
  projection.remember('chat', 'two', 'second', {});
  assert.equal(projection.sent.take('chat', 'absent'), 'first');
  projection.sent.seen('chat', 'second', 'absent');
  assert.deepEqual(acknowledged, [['chat', ['two']]]);
  assert.equal(projection.sent.take('chat', 'one'), 'first');
});

test('upload capability eviction is per service/client generation and live references never read saved native records', async () => {
  const client = { kind: 'phone' },
    service = { assertPaired: () => {} };
  for (let i = 0; i <= 1000; i++) rememberAttachment(service, client, { id: `upload-${i}` });
  assert.throws(() => requireAttachments(service, client, ['upload-0']), /Attach/);
  requireAttachments(service, client, ['upload-1000']);
  assert.throws(() => requireAttachments(service, { kind: 'phone' }, ['upload-1000']), /Attach/);
  let reads = 0;
  assert.equal(
    await historyImageItem(
      { segments: [] },
      async () => {
        reads++;
        return {};
      },
      '["live","turn","message"]',
      () => true,
    ),
    null,
  );
  assert.equal(reads, 0);
});

test('image RPCs translate app chat ids at the existing Host boundary without leaking the app id onto the wire', async () => {
  const calls: any[] = [];
  const host = {
    call: async (...args: any[]) => {
      calls.push(args);
      return { imageId: 'opaque' };
    },
  };
  const wrapped = withAppChatIds(host, () => true);
  await wrapped.call('chat.image', { chatId: 'acp:host-claude:session', imageId: 'opaque' });
  await wrapped.call('host.status', {});
  assert.equal(calls[0][1].chatId, 'claude:session');
  assert.deepEqual(calls[1], ['host.status', {}]);
});
