// The media adapter's photo library, Select more and file picker paths behind the Add to session sheet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../tests/support/phone/register.ts';
const mediaModulePath = '../mobile/src/platform/media.ts';
const { nativeMedia } = await import(mediaModulePath);
const g = globalThis as any;
const shot = (id: string) => ({ id, uri: `ph://${id}` });

test('recent photos: asks for photo access once, reads the newest first, and tells full from limited access', async () => {
  g.__phoneMedia = { access: 'all', assets: [shot('a'), shot('b')] };
  assert.deepEqual(await nativeMedia.recent(), {
    access: 'full',
    photos: [
      { id: 'a', uri: 'ph://a' },
      { id: 'b', uri: 'ph://b' },
    ],
  });
  assert.deepEqual(g.__phoneMedia.libraryAsked, { writeOnly: false, granular: ['photo'] });
  assert.deepEqual(g.__phoneMedia.assetsOptions, { first: 30, mediaType: 'photo', sortBy: [['creationTime', false]] });
  assert.equal(g.__phoneMedia.libraryPrompted, undefined, 'granted access is not asked for again');
  g.__phoneMedia = { access: 'limited', assets: [shot('c')] };
  assert.equal((await nativeMedia.recent()).access, 'limited');

  g.__phoneMedia = { access: 'undetermined', askResult: 'all', assets: [shot('d')] };
  assert.deepEqual((await nativeMedia.recent()).photos, [{ id: 'd', uri: 'ph://d' }]);
  assert.equal(g.__phoneMedia.libraryPrompted, true);
});

test('refused, restricted or broken photo access gives Camera and Photos only, and Android never asks', async () => {
  g.__phoneMedia = { access: 'undetermined', askResult: 'none', assets: [shot('a')] };
  assert.deepEqual(await nativeMedia.recent(), { access: 'denied', photos: [] });
  g.__phoneMedia = { access: 'none', assets: [shot('a')] };
  assert.deepEqual(await nativeMedia.recent(), { access: 'denied', photos: [] });
  assert.equal(g.__phoneMedia.libraryPrompted, undefined, 'a refusal in Settings is not asked again');
  g.__phoneMedia = { access: 'all', assetsFail: true };
  assert.deepEqual(await nativeMedia.recent(), { access: 'denied', photos: [] });
  g.__phoneMedia = { access: 'all', assets: [shot('a')] };
  g.__phonePlatform = 'android';
  try {
    assert.deepEqual(await nativeMedia.recent(), { access: 'denied', photos: [] });
    assert.equal(g.__phoneMedia.libraryAsked, undefined);
  } finally {
    g.__phonePlatform = undefined;
  }
});

test('Select more opens the system picker for the photos shared with the app', async () => {
  g.__phoneMedia = { access: 'limited' };
  await nativeMedia.manageLimited();
  assert.deepEqual(g.__phoneMedia.manageOpened, ['photo']);
});

test('library photos are re-encoded as JPEG, with the long side capped, and named after the original', async () => {
  g.__phoneMedia = {
    infos: {
      wide: { id: 'wide', uri: 'ph://wide', localUri: 'file:///wide.heic', filename: 'IMG_1.HEIC', width: 8000, height: 6000 },
      tall: { id: 'tall', uri: 'ph://tall', localUri: 'file:///tall.heic', filename: 'IMG_2.HEIC', width: 3000, height: 4000 },
      small: { id: 'small', uri: 'ph://small', localUri: null, filename: '.png', width: 800, height: 600 },
    },
  };
  assert.deepEqual(await nativeMedia.photos(['wide', 'tall', 'small']), [
    { name: 'IMG_1.jpg', mime: 'image/jpeg', base64: 'SlBFRw==', uri: 'file:///wide.heic.jpg' },
    { name: 'IMG_2.jpg', mime: 'image/jpeg', base64: 'SlBFRw==', uri: 'file:///tall.heic.jpg' },
    { name: 'photo.jpg', mime: 'image/jpeg', base64: 'SlBFRw==', uri: 'ph://small.jpg' },
  ]);
  const [wide, tall, small] = g.__phoneMedia.manipulated;
  assert.deepEqual(wide.actions, [{ resize: { width: 2048 } }]);
  assert.deepEqual(tall.actions, [{ resize: { height: 2048 } }]);
  assert.deepEqual(small.actions, [], 'a photo under the cap is only re-encoded');
  assert.deepEqual(wide.options, { format: 'jpeg', compress: 0.8, base64: true });
  assert.equal(small.uri, 'ph://small', 'an asset with no local copy is read from its library address');
});

test('a library photo that cannot be found or encoded is an error', async () => {
  g.__phoneMedia = {
    infos: { x: { id: 'x', uri: 'ph://x', localUri: 'file:///x', filename: 'x.jpg', width: 1, height: 1 } },
    manipulateResult: { uri: 'u' },
  };
  await assert.rejects(nativeMedia.photos(['x']), /could not be read/);
  await assert.rejects(nativeMedia.photos(['missing']), /missing asset/);
});

test('files from the document picker keep their name and type; a cancel gives none; only images get a thumbnail address', async () => {
  g.__phoneMedia = {
    documentResult: {
      canceled: false,
      assets: [
        { uri: 'file:///a.pdf', name: 'a.pdf', mimeType: 'application/pdf' },
        { uri: 'file:///b.png', name: 'b.png', mimeType: 'image/png' },
        { uri: 'file:///c', name: 'c' },
      ],
    },
  };
  assert.deepEqual(await nativeMedia.files(), [
    { name: 'a.pdf', mime: 'application/pdf', base64: 'bytes-of:file:///a.pdf' },
    { name: 'b.png', mime: 'image/png', base64: 'bytes-of:file:///b.png', uri: 'file:///b.png' },
    { name: 'c', mime: 'application/octet-stream', base64: 'bytes-of:file:///c' },
  ]);
  assert.deepEqual(g.__phoneMedia.documentOptions, { multiple: true, copyToCacheDirectory: true });
  g.__phoneMedia = { documentResult: { canceled: true, assets: null } };
  assert.deepEqual(await nativeMedia.files(), []);
});
