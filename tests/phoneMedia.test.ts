// The native media adapter against controllable picker, recorder and file stand-ins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../tests/support/phone/register.ts';
const mediaModulePath = '../mobile/src/platform/media.ts';
const { nativeMedia } = await import(mediaModulePath);
const g = globalThis as any;
const asset = (extra = {}) => ({
  canceled: false,
  assets: [{ base64: 'QUJD', fileName: 'a.png', mimeType: 'image/png', uri: 'file:///a.png', ...extra }],
});

const MB = 1024 * 1024;
const photo = { base64: 'QUJD', fileName: 'a.png', mimeType: 'image/png', uri: 'file:///a.png', type: 'image' };
const video = (extra = {}) => ({
  base64: null,
  fileName: 'v.mp4',
  mimeType: 'video/mp4',
  uri: 'file:///v.mp4',
  type: 'video',
  fileSize: 5 * MB,
  ...extra,
});
const picked = (...assets: object[]) => ({ canceled: false, assets });

test('the camera returns the photo as base64 with its name and type, and opens the single-photo picker', async () => {
  g.__phoneMedia = { cameraResult: asset({ fileName: null, mimeType: null }) };
  assert.deepEqual(await nativeMedia.camera(), { name: 'photo.jpg', mime: 'image/jpeg', base64: 'QUJD', uri: 'file:///a.png' });
  assert.deepEqual(g.__phoneMedia.options, { base64: true, quality: 0.8, mediaTypes: ['images'] });
});

test('the library opens the system picker for several photos and videos, as many as there is room for, in the order they were picked', async () => {
  g.__phoneMedia = { libraryResult: picked(photo) };
  await nativeMedia.library(7);
  assert.deepEqual(g.__phoneMedia.options, {
    base64: true,
    quality: 0.8,
    mediaTypes: ['images', 'videos'],
    allowsMultipleSelection: true,
    selectionLimit: 7,
    orderedSelection: true,
    videoExportPreset: 6,
    shouldDownloadFromNetwork: true,
  });
  assert.equal('allowsEditing' in g.__phoneMedia.options, false, 'editing would force a single selection on iOS');
  await nativeMedia.library(0);
  assert.equal(g.__phoneMedia.options.selectionLimit, 1, '0 would mean no limit to the picker');
});

test('every chosen asset comes back: photos as base64, a video as a file read from its cache copy with no thumbnail', async () => {
  g.__phoneMedia = { libraryResult: picked(photo, video(), { ...photo, fileName: 'b.png', uri: 'file:///b.png' }) };
  assert.deepEqual(await nativeMedia.library(10), {
    picked: [
      { name: 'a.png', mime: 'image/png', base64: 'QUJD', uri: 'file:///a.png' },
      { name: 'v.mp4', mime: 'video/mp4', base64: 'bytes-of:file:///v.mp4' },
      { name: 'b.png', mime: 'image/png', base64: 'QUJD', uri: 'file:///b.png' },
    ],
    refused: [],
  });
  assert.deepEqual(g.__phoneMedia.reads, ['file:///v.mp4'], 'only the video is read from disk');
});

test('a video with no name or type is an mp4', async () => {
  g.__phoneMedia = { libraryResult: picked(video({ fileName: null, mimeType: null })) };
  assert.deepEqual((await nativeMedia.library(1)).picked, [{ name: 'video.mp4', mime: 'video/mp4', base64: 'bytes-of:file:///v.mp4' }]);
});

test('a video the picker gives no size for is measured on the file before it is read: one that fits is read, one that does not or has no size is refused unread', async () => {
  g.__phoneMedia = { libraryResult: picked(video({ fileSize: undefined })), sizes: { 'file:///v.mp4': 3 * MB } };
  assert.equal((await nativeMedia.library(1)).picked.length, 1);
  g.__phoneMedia = { libraryResult: picked(video({ fileSize: undefined })), sizes: { 'file:///v.mp4': 20 * MB + 1 } };
  assert.deepEqual(await nativeMedia.library(1), { picked: [], refused: ['That video is larger than 20 MB. Trim it and try again.'] });
  g.__phoneMedia = { libraryResult: picked(video({ fileSize: undefined })), sizes: {} };
  assert.deepEqual(await nativeMedia.library(1), { picked: [], refused: ['That video could not be read.'] });
  assert.equal(g.__phoneMedia.reads, undefined, 'neither refused video was read');
});

test('a copy the file system cannot open or measure is a plain "could not be read", never its own words', async () => {
  g.__phoneMedia = { libraryResult: picked(video(), photo), unopenable: ['file:///v.mp4'] };
  assert.deepEqual((await nativeMedia.library(2)).refused, ['That video could not be read.']);
  g.__phoneMedia = { libraryResult: picked(video({ fileSize: undefined })), sizeThrows: true };
  assert.deepEqual(await nativeMedia.library(1), { picked: [], refused: ['That video could not be read.'] });
});

test('a video above the 20 MB the Mac takes is refused before its bytes are read, and the others still come', async () => {
  g.__phoneMedia = { libraryResult: picked(video({ fileSize: 20 * MB + 1 }), photo, video({ fileSize: 20 * MB, uri: 'file:///w.mp4' })) };
  const got = await nativeMedia.library(10);
  assert.deepEqual(got.refused, ['That video is larger than 20 MB. Trim it and try again.']);
  assert.deepEqual(
    got.picked.map((p: { name: string }) => p.name),
    ['a.png', 'v.mp4'],
  );
  assert.deepEqual(g.__phoneMedia.reads, ['file:///w.mp4'], 'the large one was never read');
});

test('a photo with no bytes and a video that cannot be read are refused one by one; cancelling gives nothing', async () => {
  g.__phoneMedia = { libraryResult: picked({ ...photo, base64: undefined }, video(), photo), unreadable: ['file:///v.mp4'] };
  const got = await nativeMedia.library(10);
  assert.deepEqual(got.refused, ['That photo could not be read.', 'That video could not be read.']);
  assert.equal(got.picked.length, 1);
  g.__phoneMedia = { libraryResult: { canceled: true, assets: null } };
  assert.deepEqual(await nativeMedia.library(10), { picked: [], refused: [] });
  g.__phoneMedia = { libraryResult: { canceled: false, assets: [] } };
  assert.deepEqual(await nativeMedia.library(10), { picked: [], refused: [] });
});

test('cancelling the camera returns null and an unreadable photo is an error', async () => {
  g.__phoneMedia = { cameraResult: { canceled: true, assets: null } };
  assert.equal(await nativeMedia.camera(), null);
  g.__phoneMedia = { cameraResult: { canceled: false, assets: [] } };
  assert.equal(await nativeMedia.camera(), null);
  g.__phoneMedia = { cameraResult: asset({ base64: undefined }) };
  await assert.rejects(nativeMedia.camera(), /could not be read/);
});

test('the photo library is opened through the system picker without asking for library access', async () => {
  g.__phoneMedia = { library: 'denied', libraryResult: picked(photo) };
  assert.deepEqual((await nativeMedia.library(10)).picked, [{ name: 'a.png', mime: 'image/png', base64: 'QUJD', uri: 'file:///a.png' }]);
  assert.equal(g.__phoneMedia.libraryPermissionAsked, undefined);
});

test('refused permissions say where to allow them', async () => {
  g.__phoneMedia = { camera: 'denied', mic: 'denied' };
  await assert.rejects(nativeMedia.camera(), /camera access/);
  await assert.rejects(nativeMedia.startRecording(), /microphone access/);
});

test('a recording is started as 16 kHz mono WAV and stopped into base64', async () => {
  g.__phoneMedia = { uri: 'file:///clip.wav' };
  await nativeMedia.startRecording();
  assert.equal(g.__phoneMedia.recording, true);
  assert.equal(g.__phoneMedia.recorder.options.sampleRate, 16000);
  assert.equal(g.__phoneMedia.recorder.options.numberOfChannels, 1);
  assert.deepEqual(await nativeMedia.stopRecording(), { base64: 'bytes-of:file:///clip.wav', mime: 'audio/wav' });
  assert.equal(g.__phoneMedia.recording, false);
  await assert.rejects(nativeMedia.stopRecording(), /No recording is in progress/);
});

test('a recording with no file fails, and cancelling stops an active recording and tolerates none', async () => {
  g.__phoneMedia = {};
  await nativeMedia.startRecording();
  await assert.rejects(nativeMedia.stopRecording(), /could not be saved/);
  await nativeMedia.startRecording();
  await nativeMedia.cancelRecording();
  assert.equal(g.__phoneMedia.recording, false);
  await nativeMedia.cancelRecording();
});

test('starting a recording stops one that is still active, even if stopping it fails', async () => {
  g.__phoneMedia = { stopFails: true };
  await nativeMedia.startRecording();
  const first = g.__phoneMedia.recorder;
  await nativeMedia.startRecording();
  assert.notEqual(g.__phoneMedia.recorder, first);
  assert.equal(g.__phoneMedia.stops, 1);
  assert.equal(g.__phoneMedia.recording, true);
  g.__phoneMedia.stopFails = false;
  await nativeMedia.cancelRecording();
});

test('recording is allowed in the audio session before the recorder is prepared, and the session goes back to playback when it ends', async () => {
  g.__phoneMedia = { uri: 'file:///clip.wav' };
  await nativeMedia.startRecording();
  assert.deepEqual(g.__phoneMedia.modes, [{ allowsRecording: true, playsInSilentMode: true }]);
  await nativeMedia.stopRecording();
  assert.deepEqual(g.__phoneMedia.modes.at(-1), { allowsRecording: false });
  await nativeMedia.startRecording();
  await nativeMedia.cancelRecording();
  assert.deepEqual(g.__phoneMedia.modes.at(-1), { allowsRecording: false });
});

test('a session that cannot be switched back after recording does not lose the clip', async () => {
  g.__phoneMedia = { uri: 'file:///clip.wav' };
  await nativeMedia.startRecording();
  g.__phoneMedia.modeFails = true;
  assert.deepEqual(await nativeMedia.stopRecording(), { base64: 'bytes-of:file:///clip.wav', mime: 'audio/wav' });
  await nativeMedia.startRecording().catch(() => undefined);
  await nativeMedia.cancelRecording();
});

test('a recorder that cannot start leaves no recording behind and the session back on playback', async () => {
  g.__phoneMedia = { prepareFails: true };
  await assert.rejects(nativeMedia.startRecording(), /microphone busy/);
  assert.deepEqual(g.__phoneMedia.modes, [{ allowsRecording: true, playsInSilentMode: true }, { allowsRecording: false }]);
  await assert.rejects(nativeMedia.stopRecording(), /No recording is in progress/);
  g.__phoneMedia = { modeFails: true };
  await assert.rejects(nativeMedia.startRecording(), /audio session unavailable/);
  assert.equal(g.__phoneMedia.recorder, undefined, 'no recorder is made when recording cannot be allowed');
});

test('two quick starts run one after the other: the first recorder is stopped, never leaked', async () => {
  g.__phoneMedia = { slowPrepare: true };
  await Promise.all([nativeMedia.startRecording(), nativeMedia.startRecording()]);
  assert.equal(g.__phoneMedia.prepared.length, 2);
  assert.equal(g.__phoneMedia.stops, 1, 'the second start stopped the first recorder');
  assert.equal(g.__phoneMedia.recorder, g.__phoneMedia.prepared[1]);
  await nativeMedia.cancelRecording();
  assert.equal(g.__phoneMedia.recording, false);
});

test('a recorder that fails to stop still puts the session back on playback, and cancelling with nothing recorded changes nothing', async () => {
  g.__phoneMedia = { uri: 'file:///clip.wav' };
  await nativeMedia.startRecording();
  g.__phoneMedia.stopThrowsOnce = true;
  await assert.rejects(nativeMedia.stopRecording(), /stop failed/);
  assert.deepEqual(g.__phoneMedia.modes.at(-1), { allowsRecording: false });
  await nativeMedia.startRecording();
  g.__phoneMedia.stopThrowsOnce = true;
  await assert.rejects(nativeMedia.cancelRecording(), /stop failed/);
  assert.deepEqual(g.__phoneMedia.modes.at(-1), { allowsRecording: false });
  const before = g.__phoneMedia.modes.length;
  await nativeMedia.cancelRecording();
  assert.equal(g.__phoneMedia.modes.length, before, 'no recording, no session change');
});

test('the recording level is the microphone meter from silence to full, and nothing when nothing records or the device says nothing', async () => {
  g.__phoneMedia = { uri: 'file:///clip.wav', metering: -30 };
  assert.equal(nativeMedia.level(), null, 'nothing is recording');
  await nativeMedia.startRecording();
  assert.equal(g.__phoneMedia.recorder.options.isMeteringEnabled, true);
  assert.equal(nativeMedia.level(), 0.5);
  for (const [db, level] of [
    [-60, 0],
    [-160, 0],
    [0, 1],
    [6, 1],
  ] as const) {
    g.__phoneMedia.metering = db;
    assert.equal(nativeMedia.level(), level, `${db} dB`);
  }
  g.__phoneMedia.metering = undefined;
  assert.equal(nativeMedia.level(), null, 'the device does not say');
  g.__phoneMedia.metering = Number.NEGATIVE_INFINITY;
  assert.equal(nativeMedia.level(), null);
  g.__phoneMedia.metering = -30;
  g.__phoneMedia.meteringFails = true;
  assert.equal(nativeMedia.level(), null, 'a recorder that cannot say draws a flat meter');
  g.__phoneMedia.meteringFails = false;
  await nativeMedia.stopRecording();
  assert.equal(nativeMedia.level(), null);
});

test('taps while a picker is already on screen neither queue nor present another one', async () => {
  g.__phoneMedia = { hold: true, cameraResult: asset(), libraryResult: picked(photo) };
  const first = nativeMedia.camera();
  await new Promise((r) => setTimeout(r, 0));
  // double tap, then the other source: iOS cannot show two, and a queued one would pop up after the first closes
  assert.equal(await nativeMedia.camera(), null);
  assert.deepEqual(await nativeMedia.library(10), { picked: [], refused: [] });
  g.__phoneMedia.release();
  assert.deepEqual(await first, { name: 'a.png', mime: 'image/png', base64: 'QUJD', uri: 'file:///a.png' });
  assert.deepEqual(g.__phoneMedia.presented, ['camera']);
  g.__phoneMedia.hold = false;
  assert.equal((await nativeMedia.library(10)).picked.length, 1, 'the next tap works once the picker is closed');
  assert.deepEqual(g.__phoneMedia.presented, ['camera', 'library']);
});

test('a picker that fails frees the guard so the next tap works', async () => {
  g.__phoneMedia = { camera: 'denied', libraryResult: picked(photo) };
  await assert.rejects(nativeMedia.camera(), /camera access/);
  assert.equal((await nativeMedia.library(10)).picked.length, 1);
});
