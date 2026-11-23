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

test('library and camera return the picked photo as base64 with its name and type', async () => {
  g.__phoneMedia = { libraryResult: asset(), cameraResult: asset({ fileName: null, mimeType: null }) };
  assert.deepEqual(await nativeMedia.library(), { name: 'a.png', mime: 'image/png', base64: 'QUJD', uri: 'file:///a.png' });
  assert.deepEqual(g.__phoneMedia.options, { base64: true, quality: 0.8, mediaTypes: ['images'] });
  assert.deepEqual(await nativeMedia.camera(), { name: 'photo.jpg', mime: 'image/jpeg', base64: 'QUJD', uri: 'file:///a.png' });
});

test('cancelling a picker returns null and an unreadable photo is an error', async () => {
  g.__phoneMedia = { libraryResult: { canceled: true, assets: null }, cameraResult: { canceled: false, assets: [] } };
  assert.equal(await nativeMedia.library(), null);
  assert.equal(await nativeMedia.camera(), null);
  g.__phoneMedia.libraryResult = asset({ base64: undefined });
  await assert.rejects(nativeMedia.library(), /could not be read/);
});

test('the photo library is opened through the system picker without asking for library access', async () => {
  g.__phoneMedia = { library: 'denied', libraryResult: asset() };
  assert.deepEqual(await nativeMedia.library(), { name: 'a.png', mime: 'image/png', base64: 'QUJD', uri: 'file:///a.png' });
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
  g.__phoneMedia = { hold: true, cameraResult: asset(), libraryResult: asset() };
  const first = nativeMedia.camera();
  await new Promise((r) => setTimeout(r, 0));
  // double tap, then the other source: iOS cannot show two, and a queued one would pop up after the first closes
  assert.equal(await nativeMedia.camera(), null);
  assert.equal(await nativeMedia.library(), null);
  g.__phoneMedia.release();
  assert.deepEqual(await first, { name: 'a.png', mime: 'image/png', base64: 'QUJD', uri: 'file:///a.png' });
  assert.deepEqual(g.__phoneMedia.presented, ['camera']);
  g.__phoneMedia.hold = false;
  assert.ok(await nativeMedia.library(), 'the next tap works once the picker is closed');
  assert.deepEqual(g.__phoneMedia.presented, ['camera', 'library']);
});

test('a picker that fails frees the guard so the next tap works', async () => {
  g.__phoneMedia = { camera: 'denied', libraryResult: asset() };
  await assert.rejects(nativeMedia.camera(), /camera access/);
  assert.ok(await nativeMedia.library());
});
