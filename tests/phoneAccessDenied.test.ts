// A camera or microphone the person has refused is an error with a way forward: Open Settings, as the pairing screen offers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click } from './support/phone/component-kit';
import '../tests/support/phone/register.ts';
// module paths held in variables, as the other phone tests do, so the root type check does not follow into the React Native sources
const sheetPath = '../mobile/src/components/AddToSessionSheet';
const voicePath = '../mobile/src/components/VoiceNote';
const deniedPath = '../mobile/src/platform/accessDenied';
const mediaPath = '../mobile/src/platform/media.ts';
const { AddToSessionSheet } = await import(sheetPath);
const { VoiceNote } = await import(voicePath);
const { AccessDenied } = await import(deniedPath);
const { nativeMedia } = await import(mediaPath);
const g = globalThis as any;
/** The sheet over a library with no photos; Camera is its button. */
const sheet = (media: any) =>
  createElement(AddToSessionSheet, {
    open: true,
    onClose: () => {},
    media: { recent: async () => ({ access: 'denied', photos: [] }), ...media },
    files: { full: false, items: [], add: () => {} } as any,
  });

const mount = async (node: any) => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  await flush();
  return async () => {
    await act(async () => root.unmount());
    host.remove();
  };
};

test('the native adapter refuses with a typed error that names what was refused', async () => {
  g.__phoneMedia = { camera: 'denied', mic: 'denied' };
  await assert.rejects(
    nativeMedia.camera(),
    (e: any) => e instanceof AccessDenied && e.what === 'camera' && /camera access/.test(e.message),
  );
  await assert.rejects(nativeMedia.startRecording(), (e: any) => e instanceof AccessDenied && e.what === 'microphone');
});

test('a refused camera shows Open Settings, which opens the app settings; another failure does not', async () => {
  const media: any = {
    library: async () => null,
    camera: async () => {
      throw new AccessDenied('camera', 'Allow camera access in Settings to take a photo.');
    },
  };
  const unmount = await mount(sheet(media));
  assert.doesNotMatch(document.body.textContent ?? '', /Open Settings/);
  await click('Camera');
  assert.match(document.body.textContent ?? '', /Allow camera access in Settings/);
  g.__phoneOpenedSettings = false;
  await click('Open Settings');
  assert.equal(g.__phoneOpenedSettings, true);
  await unmount();
  media.camera = async () => {
    throw new Error('That photo could not be read.');
  };
  const again = await mount(sheet(media));
  await click('Camera');
  assert.match(document.body.textContent ?? '', /could not be read/);
  assert.doesNotMatch(document.body.textContent ?? '', /Open Settings/);
  await again();
});

test('a refused microphone shows Open Settings under the voice note, and trying again clears it', async () => {
  let refuse = true;
  const media: any = {
    startRecording: async () => {
      if (refuse) throw new AccessDenied('microphone', 'Allow microphone access in Settings to dictate.');
    },
    stopRecording: async () => ({ base64: 'QQ==', mime: 'audio/wav' }),
    cancelRecording: async () => {},
    level: () => null,
  };
  const unmount = await mount(createElement(VoiceNote, { media, request: (async () => ({})) as any, caps: null, use: () => {} }));
  await click('Record voice note');
  assert.match(document.body.textContent ?? '', /Allow microphone access in Settings/);
  g.__phoneOpenedSettings = false;
  await click('Open Settings');
  assert.equal(g.__phoneOpenedSettings, true);
  refuse = false;
  await click('Record voice note');
  assert.doesNotMatch(document.body.textContent ?? '', /Open Settings/);
  await unmount();
});

test('notifications turned off in the phone settings, and Live Activities off, each offer Open Settings', async () => {
  const cardPath = '../mobile/src/push/NotificationsCard';
  const settingsPath = '../mobile/src/push/NotificationSettings';
  const prefsPath = '../mobile/src/push/prefs';
  const { NotificationsCard } = await import(cardPath);
  const { NotificationSettings } = await import(settingsPath);
  const { DEFAULT_PREFS } = await import(prefsPath);
  const unmount = await mount(createElement(NotificationsCard, { push: {} as any, step: 'blocked', busy: false }));
  assert.match(document.body.textContent ?? '', /Notifications are off/);
  g.__phoneOpenedSettings = false;
  await click('Open Settings');
  assert.equal(g.__phoneOpenedSettings, true);
  await unmount();
  const explaining = await mount(createElement(NotificationsCard, { push: {} as any, step: 'explain', busy: false }));
  assert.doesNotMatch(document.body.textContent ?? '', /Open Settings/, 'the explanation still asks first');
  await explaining();
  const activity = {
    ui: () => ({ prefs: { enabled: true }, status: 'blocked', failed: false }),
    subscribe: () => () => {},
    setEnabled: async () => {},
  };
  const push: any = { liveActivity: activity, setPrefs: async () => {} };
  const settings = await mount(
    createElement(NotificationSettings, { push, prefs: DEFAULT_PREFS, token: null, liveActivityAvailable: true }),
  );
  assert.match(document.body.textContent ?? '', /Live Activities are off/);
  g.__phoneOpenedSettings = false;
  await click('Open Settings');
  assert.equal(g.__phoneOpenedSettings, true);
  await settings();
});
