// Negotiated Host image upload/read contracts preserve opaque references and reject malformed, oversized or unnegotiated requests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseParams, requireFeatures } from '../shared/host/schema.mjs';
const id = 'a'.repeat(64);
const scope = { chatId: 'c', epoch: 2, key: 'request-key' };

test('Host image messages retain opaque references and require negotiated support before sending', () => {
  const p = parseParams('chat.send', { ...scope, text: 'look', images: [id] });
  assert.deepEqual(p.images, [id]);
  assert.throws(() => requireFeatures('chat.send', { features: ['epoch', 'dedupe'] }, p), /Update/);
  requireFeatures('chat.send', { features: ['epoch', 'dedupe', 'chatImages'] }, p);
  assert.equal(parseParams('chat.start', { ...scope, harness: 'codex', text: '', images: [id] }).text, '');
});

test('Host image chunks and reads are chat/epoch scoped and bounded', () => {
  assert.deepEqual(parseParams('chat.attach', { ...scope, imageId: id, offset: 0, size: 3, mime: 'image/png', data: 'YWJj' }), {
    ...scope,
    imageId: id,
    offset: 0,
    size: 3,
    mime: 'image/png',
    data: 'YWJj',
  });
  assert.deepEqual(parseParams('chat.image', { chatId: 'c', epoch: 2, imageId: id, offset: 0 }), {
    chatId: 'c',
    epoch: 2,
    imageId: id,
    offset: 0,
    limit: 96 * 1024,
  });
  for (const patch of [
    { offset: -1 },
    { offset: 0.5 },
    { imageId: '../private' },
    { data: 'bad!' },
    { mime: 'text/plain' },
    { size: 26 * 1024 * 1024 },
    { size: 0 },
    { data: 'A'.repeat(140_000) },
  ]) {
    assert.throws(() =>
      parseParams('chat.attach', { ...scope, imageId: id, offset: 0, size: 3, mime: 'image/png', data: 'YWJj', ...patch }),
    );
  }
  for (const images of [id, [null], Array(17).fill(id), ['../path']])
    assert.throws(() => parseParams('chat.send', { ...scope, text: 'look', images }));
  assert.throws(() => parseParams('chat.image', { chatId: 'c', epoch: 2, imageId: id, offset: 0, limit: 200_000 }));
  assert.throws(() => parseParams('chat.image', { chatId: 'c', imageId: id, offset: 0 }));
});
