// The pictures the dev host's fake app keeps with its messages: remembered only when sent as an image, read again by place, and a big one read as a small one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPictures, MOST_PICTURE, TINY_JPEG } from '../scripts/mobile-dev-host/fakePictures.mjs';

test('only an image data URL is remembered, and a message keeps its pictures by place', () => {
  const pictures = createPictures();
  pictures.remember('a', 'data:image/png;base64,QUJD');
  pictures.remember('b', 'data:text/plain;base64,QUJD');
  pictures.remember('c', undefined);
  assert.deepEqual(pictures.of(['a', 'b', 'c', 'missing']), ['QUJD']);
  assert.deepEqual(pictures.of(undefined), []);
  pictures.keep('chat', 'row-1', pictures.of(['a']));
  pictures.keep('chat', 'row-2', []);
  assert.deepEqual(pictures.held('chat', 'row-1'), ['QUJD']);
  assert.deepEqual(pictures.held('chat', 'row-2'), [], 'a message with none keeps none');
  assert.deepEqual(pictures.read('chat', 'row-1', 0), { data: 'QUJD', width: 1, height: 1 });
  assert.equal(pictures.read('chat', 'row-1', 1), null);
  assert.equal(pictures.read('chat', 'row-2', 0), null);
});

test('a picture over what a phone reads is read as the tiny one', () => {
  const pictures = createPictures();
  const huge = 'A'.repeat(MOST_PICTURE + 4);
  pictures.remember('big', `data:image/jpeg;base64,${huge}`);
  pictures.keep('chat', 'row', pictures.of(['big']));
  assert.equal(pictures.read('chat', 'row', 0)?.data, TINY_JPEG);
  pictures.remember('edge', `data:image/jpeg;base64,${'A'.repeat(MOST_PICTURE)}`);
  pictures.keep('chat', 'edge-row', pictures.of(['edge']));
  assert.equal(pictures.read('chat', 'edge-row', 0)?.data.length, MOST_PICTURE, 'the limit itself is still sent as it is');
});

test('a message is read by the id the item feed gave it (live, or its row of the turn), a saved one by its row id', () => {
  const pictures = createPictures();
  pictures.keep('chat', 'u7', ['QUJD']);
  assert.equal(pictures.read('chat', JSON.stringify(['live', 'turn', 'u7']), 0)?.data, 'QUJD');
  assert.equal(pictures.read('chat', JSON.stringify(['chat', 't', 'userMessage', 'u7']), 0)?.data, 'QUJD');
  assert.equal(pictures.read('chat', 'u7', 0)?.data, 'QUJD');
  assert.equal(pictures.read('chat', JSON.stringify(['live', 'turn', 'u8']), 0), null);
  assert.equal(pictures.read('chat', JSON.stringify({ not: 'live' }), 0), null, 'JSON that is not a live id is just an id');
});
