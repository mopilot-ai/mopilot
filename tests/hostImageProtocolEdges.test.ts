// Image capability contracts reject unauthenticated/retired sources, unsupported services and malformed cross-owner projections before native effects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createImageProtocol } from '../host/src/imageProtocol.mjs';
import { createChatEffects } from '../host/src/chatEffects.mjs';
import { imageParsers, imageRefs, hostImageLocator, hostImageUrl, scopedHostImageUrl, scopeHostPictures } from '../shared/host/images.mjs';
const imageId = 'a'.repeat(64);
const p = { chatId: 'chat', epoch: 1, imageId, images: [imageId] };
const epochs = { current: () => 1, admit: () => {} };

test('image operations negotiate availability and bind prepare/check to current identity, close and epoch', async () => {
  const protocol = createImageProtocol({ images: null, epochs } as any);
  const ordinary = protocol.connection(() => null);
  assert.equal(ordinary.prepare('chat.send', { text: 'legacy' }).text, 'legacy');
  assert.throws(() => ordinary.prepare('chat.image', p), { code: 'unknown_client' });
  const admitted = protocol.connection(() => 'owner');
  await assert.rejects(admitted.upload(admitted.prepare('chat.attach', p)), /cannot receive images/);
  await assert.rejects(admitted.read(admitted.prepare('chat.image', p)), /cannot read images/);
  const pending = admitted.prepare('chat.attach', p);
  admitted.close();
  assert.throws(pending.checkImages, { code: 'unknown_client' });
  assert.throws(() => admitted.prepare('chat.image', p), { code: 'unknown_client' });
  let identity = 'owner',
    epoch = 1;
  let gates = 0;
  const enabled = createImageProtocol({
    images: { upload: async () => ({}), read: async () => ({}) },
    epochs: { current: () => epoch, admit: () => {} },
    continueHost: {
      gate: () => {
        gates++;
      },
    },
  });
  const connection = enabled.connection(() => identity);
  const upload = connection.prepare('chat.attach', p);
  await connection.upload(upload);
  assert(gates > 0);
  const send = connection.prepare('chat.send', p);
  connection.close();
  send.checkImages();
  identity = 'another';
  assert.throws(send.checkImages, { code: 'unknown_client' });
  identity = 'owner';
  epoch = 2;
  assert.throws(send.checkImages, { code: 'stale_epoch' });
});

test('an image-bearing send cannot silently reach a runtime without image storage', async () => {
  let sends = 0;
  const effects = createChatEffects({
    check: () => {},
    faults: { clear: () => {} },
    runtime: {
      send: async () => {
        sends++;
      },
    },
    endedTurns: new Set(),
    approvals: { resume: () => null },
  } as any);
  await assert.rejects((effects as any)['chat.send']({ ...p, key: 'key', text: '' }), /cannot receive images/);
  assert.equal(sends, 0);
  const records: any[] = [];
  const complete = createChatEffects({
    check: () => {},
    faults: { clear: () => {} },
    runtime: { send: async () => ({ turnId: 'turn' }) },
    endedTurns: new Set(),
    approvals: { resume: () => null },
    finish: (_chat: string, item: any) => records.push(item),
  } as any);
  await complete['chat.send']({ chatId: 'chat', key: 'key', text: '' });
  assert.deepEqual(records[0].user.content, []);
});

test('cross-owner image projections keep slots, discard private sources and reject invalid locators', () => {
  const bad = (message: string) => new Error(message);
  assert.deepEqual(imageRefs([], bad), {});
  assert.deepEqual(imageRefs(null, bad), {});
  assert.equal(hostImageLocator('host-image:%bad'), null);
  assert.equal(hostImageLocator('host-image:' + encodeURIComponent(JSON.stringify(['', imageId]))), null);
  assert.equal(hostImageLocator('host-image:' + encodeURIComponent(JSON.stringify(['source', 'wrong']))), null);
  assert.equal(hostImageLocator('host-image:' + encodeURIComponent(JSON.stringify({ source: imageId }))), null);
  assert.deepEqual(hostImageLocator(scopedHostImageUrl('source', imageId)), { hostId: 'source', imageId });
  for (const user of [null, {}, { content: 'bad' }]) assert.equal(scopeHostPictures(user, 'source'), user);
  const projected = scopeHostPictures(
    {
      content: [
        null,
        { type: 'localImage', path: '/private/never' },
        { type: 'image', url: hostImageUrl(imageId) },
        { type: 'image', url: '/private/never' },
      ],
    },
    'source',
  );
  assert.equal(JSON.stringify(projected).includes('/private'), false);
  assert.equal(projected.content.length, 4);
  const parsers = imageParsers(
    (x: any) => x,
    (x: any) => x,
    bad,
  );
  for (const offset of [-1, MAX_SAFE_INTEGER]) assert.throws(() => parsers['chat.image']({ ...p, offset }));
});
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
