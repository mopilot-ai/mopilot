// The audio stand-in in the phone media tests refuses what the native recorder refuses: recording before the session allows it, without the microphone, or without preparing.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AudioModule, setAudioModeAsync } from './support/phone/expo-media.ts';

const g = globalThis as any;
const fresh = () => (g.__phoneMedia = {});
const recorder = () => new AudioModule.AudioRecorder({});

test('a recorder that was never prepared (or already stopped) records nothing, and one whose session does not allow recording throws', async () => {
  fresh();
  await setAudioModeAsync({ allowsRecording: true });
  const never = recorder();
  never.record();
  assert.equal(g.__phoneMedia.recording, undefined, 'record() before a prepare does nothing');
  const ready = recorder();
  await ready.prepareToRecordAsync();
  await setAudioModeAsync({ allowsRecording: false });
  assert.throws(() => ready.record(), /Recording not allowed on iOS/);
  assert.throws(() => never.record(), /Recording not allowed on iOS/, 'the session is checked before the prepare, as on iOS');
  await setAudioModeAsync({ allowsRecording: true });
  ready.record();
  assert.equal(g.__phoneMedia.recording, true);
  await ready.stop();
  ready.record();
  assert.equal(g.__phoneMedia.recording, false, 'a stopped recorder records nothing more');
  await ready.prepareToRecordAsync();
  ready.record();
  assert.equal(g.__phoneMedia.recording, true, 'until it is prepared again');
});

test('record() needs the microphone, and leaving recording mode stops a running recording', async () => {
  fresh();
  await setAudioModeAsync({ allowsRecording: true });
  const r = recorder();
  await r.prepareToRecordAsync();
  g.__phoneMedia.mic = 'denied';
  assert.throws(() => r.record(), /microphone permission/);
  g.__phoneMedia.mic = 'granted';
  r.record();
  assert.equal(g.__phoneMedia.recording, true);
  await setAudioModeAsync({ allowsRecording: false });
  assert.equal(g.__phoneMedia.recording, false);
  assert.equal(g.__phoneMedia.modeStoppedRecording, 1);
  await setAudioModeAsync({ allowsRecording: false });
  assert.equal(g.__phoneMedia.modeStoppedRecording, 1, 'nothing was running the second time');
});
