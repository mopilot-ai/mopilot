// A picked video made ready to send (#5638): read as it is when it fits, made smaller by the native module when it does not, refused by name (at once where the answer is certain), with progress, cancel and no temporary file left behind.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import '../tests/support/phone/register.ts';
const prepPath = '../mobile/src/platform/videoPrep.ts';
const compressPath = '../mobile/src/platform/videoCompress.ts';
const mediaPath = '../mobile/src/platform/media.ts';
const { prepareVideo, Stopped, COMPRESS_LIMIT, MIN_BITRATE, TOO_LARGE, TOO_LONG, UNREADABLE, NOT_PREPARED, BACKGROUND, DISK } =
  await import(prepPath);
const { nativeVideo, videoCompressor } = await import(compressPath);
const { nativeMedia } = await import(mediaPath);
const kitPath = './support/phone/video-kit.ts';
const { fakeNative, asset, hooks, MB, CAP } = await import(kitPath);
const g = globalThis as any;

const original = nativeVideo.load;
afterEach(() => {
  nativeVideo.load = original;
});

test('a video that fits is read as it is: no export, its own name and type, and the picker’s copy is cleared', async () => {
  g.__phoneMedia = {};
  const native = fakeNative();
  const got = await prepareVideo(asset({ fileSize: 5 * MB }), hooks());
  assert.deepEqual(got, { name: 'IMG_1.MOV', mime: 'video/quicktime', base64: 'bytes-of:file:///big.mov' });
  assert.equal(native.asked.length, 0);
  assert.deepEqual(g.__phoneMedia.deleted, ['file:///big.mov']);
});

test('a video with no name or type is an mp4', async () => {
  g.__phoneMedia = {};
  const got = await prepareVideo(asset({ fileSize: 5 * MB, fileName: null, mimeType: null }), { compressor: null, id: 'v' });
  assert.deepEqual([got.name, got.mime], ['video.mp4', 'video/mp4']);
});

test('a video above the cap with no module in this build is refused by name, and its copy is cleared', async () => {
  g.__phoneMedia = {};
  await assert.rejects(prepareVideo(asset(), { compressor: null, id: 'v' }), { message: TOO_LARGE });
  assert.deepEqual(g.__phoneMedia.deleted, ['file:///big.mov']);
  assert.equal(g.__phoneMedia.reads, undefined, 'and it was not read');
});

test('a video too long to fit at any size is refused at once, before any export', async () => {
  g.__phoneMedia = {};
  const native = fakeNative();
  // one second longer than the cap holds at the least bit rate the smallest size makes
  const seconds = CAP / (MIN_BITRATE / 8) + 1;
  await assert.rejects(prepareVideo(asset({ duration: seconds * 1000 }), hooks()), { message: TOO_LONG });
  assert.equal(native.asked.length, 0, 'no export was started');
  // one that is not certain goes to the module
  await prepareVideo(asset({ duration: (seconds - 5) * 1000 }), hooks());
  assert.equal(native.asked.length, 1);
});

test('a video above the cap is made smaller under a limit a little below it, read from the smaller copy as an mp4, and both temporary files are cleared', async () => {
  g.__phoneMedia = {};
  const native = fakeNative({ size: 18 * MB, pause: true });
  const seen: number[] = [];
  const pending = prepareVideo(asset(), hooks({ progress: (f: number) => seen.push(f) }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  native.emit({ id: 'v1', progress: 0.25 });
  native.emit({ id: 'other', progress: 0.9 });
  native.emit({ id: 'v1', progress: 0.5 });
  native.finish();
  const got = await pending;
  assert.deepEqual(got, { name: 'IMG_1.mp4', mime: 'video/mp4', base64: 'bytes-of:file:///small-v1.mp4' });
  assert.deepEqual(native.asked, [{ uri: 'file:///big.mov', id: 'v1', limit: COMPRESS_LIMIT }]);
  assert.ok(COMPRESS_LIMIT < CAP && COMPRESS_LIMIT > 0.9 * CAP, 'a little below the cap');
  assert.deepEqual(seen, [0.25, 0.5], 'only this video’s progress');
  assert.equal(native.listeners.size, 0, 'and it stops listening');
  assert.deepEqual(g.__phoneMedia.deleted, ['file:///small-v1.mp4', 'file:///big.mov']);
});

test('a module that cannot hold the whole video says so; any other failure says it could not be made smaller; the copy is cleared either way', async () => {
  g.__phoneMedia = {};
  fakeNative({ code: 'ERR_VIDEO_TOO_LONG' });
  await assert.rejects(prepareVideo(asset(), hooks()), { message: TOO_LONG });
  fakeNative({ code: 'ERR_VIDEO_EXPORT' });
  await assert.rejects(prepareVideo(asset(), hooks()), { message: NOT_PREPARED });
  fakeNative({});
  nativeVideo.load = () => ({
    compress: () => Promise.reject(null),
    cancel: () => {},
    track: () => {},
    untrack: () => {},
    addListener: () => ({ remove: () => {} }),
  });
  await assert.rejects(prepareVideo(asset(), hooks()), { message: NOT_PREPARED });
  assert.deepEqual(g.__phoneMedia.deleted, ['file:///big.mov', 'file:///big.mov', 'file:///big.mov']);
});

test('a result above the cap is not sent, and is cleared', async () => {
  g.__phoneMedia = {};
  fakeNative({ size: CAP + 1 });
  await assert.rejects(prepareVideo(asset(), hooks()), { message: TOO_LONG });
  assert.deepEqual(g.__phoneMedia.deleted, ['file:///small-v1.mp4', 'file:///big.mov']);
});

test('cancelling stops the export, ends the wait with Stopped and clears the copy; a signal already raised starts nothing', async () => {
  g.__phoneMedia = {};
  const native = fakeNative({ hold: true });
  const control = new AbortController();
  const pending = prepareVideo(asset(), hooks({ signal: control.signal }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  control.abort();
  await assert.rejects(pending, (e: unknown) => e instanceof Stopped);
  assert.deepEqual(native.cancelled, ['v1']);
  assert.deepEqual(g.__phoneMedia.deleted, ['file:///big.mov']);
  const again = fakeNative();
  await assert.rejects(prepareVideo(asset(), hooks({ signal: control.signal })), (e: unknown) => e instanceof Stopped);
  assert.equal(again.asked.length, 0);
});

test('a copy that cannot be opened, measured or read is a plain "could not be read", and a file already gone is no problem', async () => {
  g.__phoneMedia = { unopenable: ['file:///big.mov'] };
  await assert.rejects(prepareVideo(asset({ fileSize: undefined }), hooks()), { message: UNREADABLE });
  g.__phoneMedia = { sizes: {} };
  await assert.rejects(prepareVideo(asset({ fileSize: undefined }), hooks()), { message: UNREADABLE });
  g.__phoneMedia = { unreadable: ['file:///big.mov'], deleteThrows: true };
  await assert.rejects(prepareVideo(asset({ fileSize: 5 * MB }), hooks()), { message: UNREADABLE });
  assert.deepEqual(g.__phoneMedia.deleted, ['file:///big.mov'], 'cleared, though the file said it was already gone');
});

test('a build without the module, or one that cannot say, has none', () => {
  nativeVideo.load = () => null;
  assert.equal(videoCompressor(), null);
  nativeVideo.load = () => {
    throw new Error('no such module');
  };
  assert.equal(videoCompressor(), null);
});

test('the library asks the picker for the original when the module is there, with an iCloud download, and for a 720p export when it is not', async () => {
  g.__phoneMedia = { libraryResult: { canceled: true, assets: null } };
  fakeNative();
  await nativeMedia.library(10);
  assert.equal(g.__phoneMedia.options.videoExportPreset, 0, 'Passthrough');
  assert.equal(g.__phoneMedia.options.preferredAssetRepresentationMode, 'current', 'the original as it is, not a converted one');
  assert.equal(g.__phoneMedia.options.shouldDownloadFromNetwork, true);
  nativeVideo.load = () => null;
  await nativeMedia.library(10);
  assert.equal(g.__phoneMedia.options.videoExportPreset, 6, '720p, as before');
  assert.equal('preferredAssetRepresentationMode' in g.__phoneMedia.options, false, 'and the picker’s own default representation');
});

test('the library reports each video’s turn and progress, and a cancel returns what was ready and ends the rest', async () => {
  const photo = { type: 'image', base64: 'QUJD', fileName: 'a.png', mimeType: 'image/png', uri: 'file:///a.png' };
  const vid = (n: number) => ({ ...asset({ uri: `file:///v${n}.mov`, fileName: `V${n}.MOV` }), type: 'video', base64: null });
  g.__phoneMedia = { libraryResult: { canceled: false, assets: [photo, vid(1), vid(2), vid(3)] } };
  const native = fakeNative({ size: 5 * MB });
  const turns: { index: number; count: number; fraction: number }[] = [];
  const done = await nativeMedia.library(10, {
    progress: (p: { index: number; count: number; fraction: number }) => turns.push(p),
  });
  assert.equal(done.picked.length, 4);
  assert.deepEqual(
    native.asked.map((a) => a.id.split('-')[1]),
    ['1', '2', '3'],
    'the videos one after another',
  );
  assert.equal(new Set(native.asked.map((a) => a.id)).size, 3, 'each under its own id');

  // the person cancels during the second video: the photo and the first are ready, the third is never asked
  const second = fakeNative({ size: 5 * MB });
  const control = new AbortController();
  let n = 0;
  const original = nativeVideo.load();
  nativeVideo.load = () => ({
    ...original,
    compress: (uri: string, id: string, limit: number) => {
      if (++n === 2) {
        control.abort();
        return Promise.reject(Object.assign(new Error('cancelled'), { code: 'ERR_VIDEO_CANCELLED' }));
      }
      return original.compress(uri, id, limit);
    },
  });
  g.__phoneMedia = { libraryResult: { canceled: false, assets: [photo, vid(1), vid(2), vid(3)] } };
  const stopped = await nativeMedia.library(10, { signal: control.signal });
  assert.equal(stopped.cancelled, true);
  assert.equal(stopped.picked.length, 2, 'the photo and the first video');
  assert.deepEqual(stopped.refused, []);
  assert.equal(second.asked.length, 1, 'only the first video reached the module');
  assert.equal(n, 2, 'the third video was never asked for');
  // a signal raised between two items ends the rest as well
  g.__phoneMedia = { libraryResult: { canceled: false, assets: [photo, photo] } };
  const raised = new AbortController();
  raised.abort();
  assert.deepEqual(await nativeMedia.library(10, { signal: raised.signal }), { picked: [], refused: [], cancelled: true });
});

test('the module’s own functions are what the wrapper calls, and its listener is removed with the export', async () => {
  const native = fakeNative({ size: 5 * MB });
  const c = videoCompressor();
  assert.ok(c);
  const stop = c.onProgress('x', () => {});
  assert.equal(native.listeners.size, 1);
  stop();
  assert.equal(native.listeners.size, 0);
  c.cancel('x');
  assert.deepEqual(native.cancelled, ['x']);
  assert.deepEqual(await c.compress('file:///a.mov', 'x', 1), { uri: 'file:///small-x.mp4', size: 5 * MB });
});

test('the library tells which video is being made smaller of how many, and how far', async () => {
  const vid = (n: number) => ({ ...asset({ uri: `file:///v${n}.mov`, fileName: `V${n}.MOV` }), type: 'video', base64: null });
  g.__phoneMedia = { libraryResult: { canceled: false, assets: [vid(1), vid(2)] } };
  const native = fakeNative({ size: 5 * MB, pause: true });
  const turns: { index: number; count: number; fraction: number }[] = [];
  const pending = nativeMedia.library(10, { progress: (p: { index: number; count: number; fraction: number }) => turns.push(p) });
  for (const index of [1, 2]) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    native.emit({ id: native.asked[index - 1].id, progress: 0.4 });
    native.finish();
  }
  const got = await pending;
  assert.equal(got.picked.length, 2);
  assert.deepEqual(turns, [
    { index: 1, count: 2, fraction: 0.4, retry: false },
    { index: 2, count: 2, fraction: 0.4, retry: false },
  ]);
});

test('a smaller copy of a video whose name is only an extension is called video.mp4', async () => {
  g.__phoneMedia = {};
  fakeNative({ size: 5 * MB });
  const got = await prepareVideo(asset({ fileName: '.MOV' }), hooks());
  assert.equal(got.name, 'video.mp4');
});

test('the module’s reasons are said as they are: iOS taking the app’s background time, a full disk, and anything else', async () => {
  g.__phoneMedia = {};
  fakeNative({ code: 'ERR_VIDEO_BACKGROUND' });
  await assert.rejects(prepareVideo(asset(), hooks()), { message: BACKGROUND });
  fakeNative({ code: 'ERR_VIDEO_DISK' });
  await assert.rejects(prepareVideo(asset(), hooks()), { message: DISK });
  assert.match(BACKGROUND, /stay open/);
  assert.match(DISK, /space/);
});

test('what was left unread when the person cancels is cleared, not left on the phone: every copy not yet made ready, wherever the cancel came', async () => {
  const vid = (n: number) => ({ ...asset({ uri: `file:///v${n}.mov`, fileName: `V${n}.MOV` }), type: 'video', base64: null });
  // a cancel during the second of four: the third and fourth copies go with it (the second clears itself)
  g.__phoneMedia = { libraryResult: { canceled: false, assets: [vid(1), vid(2), vid(3), vid(4)] } };
  const first = fakeNative({ size: 5 * MB });
  const real = nativeVideo.load();
  let n = 0;
  nativeVideo.load = () => ({
    ...real,
    compress: (uri: string, id: string, limit: number) =>
      ++n === 2 ? Promise.reject(Object.assign(new Error('c'), { code: 'ERR_VIDEO_CANCELLED' })) : real.compress(uri, id, limit),
  });
  const got = await nativeMedia.library(10, {});
  assert.equal(got.cancelled, true);
  assert.deepEqual(
    [...g.__phoneMedia.deleted].sort(),
    ['file:///small-' + first.asked[0].id + '.mp4', 'file:///v1.mov', 'file:///v2.mov', 'file:///v3.mov', 'file:///v4.mov'].sort(),
    'the first one’s copies after it was read, the second’s own, and the two never started',
  );
  // a signal raised before the first is read (the sheet closed during the picker): all of them go
  g.__phoneMedia = {
    libraryResult: { canceled: false, assets: [vid(1), vid(2), { type: 'image', base64: 'QUJD', uri: 'file:///p.png' }] },
  };
  const closed = new AbortController();
  closed.abort();
  assert.deepEqual(await nativeMedia.library(10, { signal: closed.signal }), { picked: [], refused: [], cancelled: true });
  assert.deepEqual([...g.__phoneMedia.deleted].sort(), ['file:///p.png', 'file:///v1.mov', 'file:///v2.mov']);
});

test('the module is told which picked videos are the picker’s copies (and only those), and told when each is gone, so a killed app’s leftovers can be swept without touching a camera photo’s file', async () => {
  const photo = { type: 'image', base64: 'QUJD', fileName: 'a.png', mimeType: 'image/png', uri: 'file:///a.png' };
  const vid = (n: number) => ({ ...asset({ uri: `file:///v${n}.mov`, fileName: `V${n}.MOV` }), type: 'video', base64: null });
  g.__phoneMedia = { libraryResult: { canceled: false, assets: [vid(1), photo, vid(2)] } };
  const native = fakeNative({ size: 5 * MB });
  await nativeMedia.library(10);
  assert.deepEqual(native.tracked, ['file:///v1.mov', 'file:///v2.mov'], 'the videos only: never the photo’s file');
  assert.deepEqual([...native.untracked].sort(), ['file:///v1.mov', 'file:///v2.mov'], 'each is untracked once it was read and removed');
  assert.ok(!g.__phoneMedia.deleted.includes('file:///a.png'), 'the photo’s file, which a thumbnail may show, is not removed');
  // a cancel drops the rest and untracks them
  g.__phoneMedia = { libraryResult: { canceled: false, assets: [vid(3), vid(4)] } };
  const closed = new AbortController();
  closed.abort();
  const stopped = fakeNative();
  await nativeMedia.library(10, { signal: closed.signal });
  assert.deepEqual([...stopped.untracked].sort(), ['file:///v3.mov', 'file:///v4.mov']);
  // a build without the module tracks nothing and has nothing to tell
  nativeVideo.load = () => null;
  g.__phoneMedia = { libraryResult: { canceled: false, assets: [photo] } };
  assert.equal((await nativeMedia.library(10)).picked.length, 1);
});

test('progress says whether a smaller size is being tried after another gave up', async () => {
  g.__phoneMedia = {};
  const native = fakeNative({ size: 5 * MB, pause: true });
  const seen: [number, boolean][] = [];
  const pending = prepareVideo(asset(), hooks({ progress: (f: number, retry: boolean) => seen.push([f, retry]) }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  native.emit({ id: 'v1', progress: 0.9 });
  native.emit({ id: 'v1', progress: 0.1, retry: true });
  native.emit({ id: 'v1', progress: 1, retry: true });
  native.finish();
  await pending;
  assert.deepEqual(seen, [
    [0.9, false],
    [0.1, true],
    [1, true],
  ]);
});

test('a native build older than this JS, whose module has no track or untrack, still picks, makes smaller and cancels: nothing throws for the missing functions', async () => {
  const vid = (n: number) => ({ ...asset({ uri: `file:///v${n}.mov`, fileName: `V${n}.MOV` }), type: 'video', base64: null });
  g.__phoneMedia = { libraryResult: { canceled: false, assets: [vid(1), vid(2)] } };
  nativeVideo.load = () => ({
    compress: (_uri: string, id: string) => Promise.resolve({ uri: `file:///small-${id}.mp4`, size: 5 * MB }),
    cancel: () => {},
    addListener: () => ({ remove: () => {} }),
  });
  const got = await nativeMedia.library(10);
  assert.equal(got.picked.length, 2);
  assert.deepEqual(got.refused, []);
  // and a cancel before the first drops the copies without a word to a module that cannot untrack them
  g.__phoneMedia = { libraryResult: { canceled: false, assets: [vid(3)] } };
  const closed = new AbortController();
  closed.abort();
  assert.equal((await nativeMedia.library(10, { signal: closed.signal })).cancelled, true);
});
