// What the performance log is told of each picked video and each pick (#5638): one line a video, with the sizes tried and how it ended, one line a pick; and the module's own answer is what says which size was kept.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import '../tests/support/phone/register.ts';
const prepPath = '../mobile/src/platform/videoPrep.ts';
const compressPath = '../mobile/src/platform/videoCompress.ts';
const mediaPath = '../mobile/src/platform/media.ts';
const kitPath = './support/phone/video-kit.ts';
const { prepareVideo, Stopped, NOT_PREPARED } = await import(prepPath);
const { nativeVideo } = await import(compressPath);
const { nativeMedia } = await import(mediaPath);
const { fakeNative, asset, hooks, MB } = await import(kitPath);
const g = globalThis as any;

const original = nativeVideo.load;
afterEach(() => {
  nativeVideo.load = original;
});

test('while the log records, each picked video leaves one line of numbers and words: its length, size and dimensions, each size tried, and how it ended', async () => {
  const { perf } = await import('../mobile/src/perfLog.ts');
  perf.start();
  try {
    g.__phoneMedia = {};
    // one that fits as it is
    await prepareVideo(asset({ fileSize: 5 * MB, width: 1920, height: 1080 }), hooks());
    // one made smaller: a size skipped on its estimate, one the limit cut short, the one that was kept
    const native = fakeNative({ size: 18 * MB, pause: true });
    const pending = prepareVideo(asset({ width: 3840, height: 2160 }), hooks());
    await new Promise((resolve) => setTimeout(resolve, 0));
    native.rung({ id: 'other', size: 'x', estimate: 1, bytes: 1, seconds: 1, outcome: 'kept' });
    native.rung({ id: 'v1', size: '720p', estimate: 40 * MB, bytes: 0, seconds: 0, outcome: 'skipped' });
    native.rung({ id: 'v1', size: '540p', estimate: 22 * MB, bytes: 20 * MB, seconds: 9.5, outcome: 'cut' });
    native.rung({ id: 'v1', size: '480p', estimate: 15 * MB, bytes: 18 * MB, seconds: 7.25, outcome: 'kept' });
    native.finish();
    await pending;
    assert.equal(native.rungListeners.size, 0, 'it stops listening');
    // refused, cancelled, in the background, a full disk, any other failure, and one that cannot be read
    fakeNative({ code: 'ERR_VIDEO_TOO_LONG' });
    await assert.rejects(prepareVideo(asset(), hooks()));
    fakeNative({ code: 'ERR_VIDEO_BACKGROUND' });
    await assert.rejects(prepareVideo(asset(), hooks()));
    fakeNative({ code: 'ERR_VIDEO_DISK' });
    await assert.rejects(prepareVideo(asset(), hooks()));
    fakeNative({ code: 'ERR_VIDEO_EXPORT' });
    await assert.rejects(prepareVideo(asset(), hooks()));
    fakeNative({ code: 'ERR_VIDEO_CANCELLED' });
    await assert.rejects(prepareVideo(asset(), hooks()), (e: unknown) => e instanceof Stopped);
    await assert.rejects(prepareVideo(asset(), { compressor: null, id: 'v' }));
    g.__phoneMedia = { sizes: {} };
    await assert.rejects(prepareVideo(asset({ fileSize: undefined }), hooks()));
    // a clip whose length and dimensions the picker did not say
    g.__phoneMedia = {};
    await prepareVideo(asset({ fileSize: 5 * MB, duration: null }), hooks());
    const lines = perf.report().videos;
    assert.deepEqual(
      lines.map((l: { result: string }) => l.result),
      ['fit', 'smaller', 'refused-long', 'background', 'disk', 'failed', 'cancelled', 'refused-large', 'unreadable', 'fit'],
    );
    assert.deepEqual(
      [lines[0].sourceBytes, lines[0].width, lines[0].height, lines[0].durationMs, lines[0].kept, lines[0].rungs],
      [5 * MB, 1920, 1080, 60_000, null, []],
    );
    assert.equal(lines[1].kept, '480p');
    assert.deepEqual(
      lines[1].rungs.map((r: { size: string; outcome: string }) => [r.size, r.outcome]),
      [
        ['720p', 'skipped'],
        ['540p', 'cut'],
        ['480p', 'kept'],
      ],
      'only this video’s sizes',
    );
    assert.equal(lines[1].sourceBytes, 80 * MB);
    assert.equal(lines[8].sourceBytes, null);
    assert.deepEqual([lines[9].durationMs, lines[9].width, lines[9].height], [null, null, null]);
    assert.ok(lines.every((l: { seconds: number }) => typeof l.seconds === 'number'));
    // numbers and words only: no name, no path, nothing that says which video it was
    assert.doesNotMatch(JSON.stringify(lines), /IMG_1|big\.mov|file:/);
  } finally {
    perf.end();
  }
  const after = perf.report().videos.length;
  g.__phoneMedia = {};
  await prepareVideo(asset({ fileSize: 5 * MB }), hooks());
  assert.equal(perf.report().videos.length, after, 'nothing is written while the log is off');
});

test('while the log records, a library pick leaves one line: how long the picker took to hand it over, how many items and videos, and how long they took to be made ready', async () => {
  const { perf } = await import('../mobile/src/perfLog.ts');
  const photo = { type: 'image', base64: 'QUJD', fileName: 'a.png', mimeType: 'image/png', uri: 'file:///a.png' };
  const vid = { ...asset({ uri: 'file:///v1.mov', fileSize: 5 * MB }), type: 'video', base64: null };
  perf.start();
  try {
    nativeVideo.load = () => null;
    g.__phoneMedia = { libraryResult: { canceled: false, assets: [photo, vid] } };
    await nativeMedia.library(10);
    g.__phoneMedia = { libraryResult: { canceled: true, assets: null } };
    await nativeMedia.library(10);
    const picks = perf.report().picks;
    assert.equal(picks.length, 1, 'a cancelled picker leaves none');
    assert.deepEqual([picks[0].count, picks[0].videos], [2, 1]);
    assert.ok(picks[0].seconds >= 0 && picks[0].readSeconds >= 0);
  } finally {
    perf.end();
  }
});

test('the size kept is the module’s own answer: a size event that arrives after it is not waited for, and the log still says smaller and which', async () => {
  const { perf } = await import('../mobile/src/perfLog.ts');
  perf.start();
  try {
    g.__phoneMedia = {};
    const native = fakeNative({ size: 18 * MB, pause: true, kept: '480p' });
    const pending = prepareVideo(asset(), hooks());
    await new Promise((resolve) => setTimeout(resolve, 0));
    native.rung({ id: 'v1', size: '720p', estimate: 40 * MB, bytes: 0, seconds: 0, outcome: 'skipped' });
    native.finish();
    await pending;
    // the module's last size event arrives after its answer: nobody is listening any more
    native.rung({ id: 'v1', size: '480p', estimate: 15 * MB, bytes: 18 * MB, seconds: 7.25, outcome: 'kept' });
    const [line] = perf.report().videos.slice(-1);
    assert.equal(line.result, 'smaller');
    assert.equal(line.kept, '480p');
    assert.deepEqual(
      line.rungs.map((r: { size: string; outcome: string }) => [r.size, r.outcome]),
      [
        ['720p', 'skipped'],
        ['480p', 'kept'],
      ],
      'the kept size comes from the answer when its event did not come first',
    );
    assert.deepEqual([line.rungs[1].estimate, line.rungs[1].bytes, line.rungs[1].seconds], [15 * MB, 18 * MB, 7.25]);
    // an answer that names no size, and no event either: it was made smaller, which size is not known
    const bare = fakeNative({ size: 5 * MB });
    await prepareVideo(asset(), hooks());
    const last = perf.report().videos.at(-1)!;
    assert.deepEqual([last.result, last.kept, last.rungs[0].estimate, last.rungs[0].seconds], ['smaller', 'unknown', 0, 0]);
    assert.equal(bare.asked.length, 1);
  } finally {
    perf.end();
  }
});

test('a subscription that fails to start leaves none of the others behind', async () => {
  g.__phoneMedia = {};
  const native = fakeNative({ failRung: true });
  const control = new AbortController();
  await assert.rejects(prepareVideo(asset(), hooks({ signal: control.signal })), { message: NOT_PREPARED });
  assert.equal(native.listeners.size, 0, 'the progress listener was ended');
  // and the abort listener: aborting now asks the module for nothing
  control.abort();
  assert.deepEqual(native.cancelled, []);
});

test('a progress subscription that fails to start leaves the abort listener behind no more than the size one does', async () => {
  g.__phoneMedia = {};
  const native = fakeNative({ failProgress: true });
  const control = new AbortController();
  await assert.rejects(prepareVideo(asset(), hooks({ signal: control.signal })), { message: NOT_PREPARED });
  control.abort();
  assert.deepEqual(native.cancelled, []);
});

test('the library tells its caller, as soon as the picker has handed over, how many of the items are videos', async () => {
  const photo = { type: 'image', base64: 'QUJD', fileName: 'a.png', mimeType: 'image/png', uri: 'file:///a.png' };
  const vid = { ...asset({ uri: 'file:///v1.mov', fileSize: 5 * MB }), type: 'video', base64: null };
  nativeVideo.load = () => null;
  const told: number[] = [];
  g.__phoneMedia = { libraryResult: { canceled: false, assets: [photo, vid, vid] } };
  await nativeMedia.library(10, { handed: ({ videos }: { videos: number }) => told.push(videos) });
  g.__phoneMedia = { libraryResult: { canceled: true, assets: null } };
  await nativeMedia.library(10, { handed: ({ videos }: { videos: number }) => told.push(videos) });
  assert.deepEqual(told, [2, 0], 'a cancelled picker hands over nothing');
});
