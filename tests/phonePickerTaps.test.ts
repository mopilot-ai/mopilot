// Taps on Photo library, Camera and Record voice note while the first is still opening: one picker, one recording, the rest ignored.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click } from './support/phone/component-kit';
// module paths held in variables, as the other phone tests do, so the root type check does not follow into the React Native sources
const sheetPath = '../mobile/src/components/AddToSessionSheet';
const voicePath = '../mobile/src/components/VoiceNote';
const deniedPath = '../mobile/src/platform/accessDenied';
const { AddToSessionSheet } = await import(sheetPath);
const { VoiceNote } = await import(voicePath);
const { AccessDenied } = await import(deniedPath);

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
const held = () => {
  let release: (v: any) => void = () => {};
  const promise = new Promise<any>((resolve) => (release = resolve));
  return { promise, release };
};

const sheet = (media: any, files: any, onClose = () => {}) =>
  createElement(AddToSessionSheet, {
    open: true,
    onClose,
    media: { recent: async () => ({ access: 'denied', photos: [] }), ...media },
    files,
  });
const filesOf = (added: any[]) => ({ full: false, items: [], add: (f: any) => added.push(f) }) as any;

test('while a picker is opening, a second tap and the other button do nothing, and both work again afterwards', async () => {
  const gate = held();
  const calls: string[] = [];
  const added: any[] = [];
  const closed: string[] = [];
  const media: any = {
    library: () => (calls.push('library'), gate.promise),
    camera: () => (calls.push('camera'), gate.promise),
  };
  const unmount = await mount(sheet(media, filesOf(added), () => closed.push('close')));
  await click('Photos');
  assert.match(
    document.body.textContent ?? '',
    /Getting your selection…/,
    'one line, true while the picker is open and while the choice is exported: what the app is doing',
  );
  assert.doesNotMatch(document.body.textContent ?? '', /answer the prompt/);
  await click('Photos');
  await click('Camera');
  assert.deepEqual(calls, ['library']);
  assert.equal((document.querySelector('button[aria-label="Camera"]') as any)?.disabled, true);
  assert.equal((document.querySelector('button[aria-label="Photos"]') as any)?.disabled, true);
  await act(async () => gate.release({ picked: [{ name: 'a.png', mime: 'image/png', base64: 'QQ==' }], refused: [] }));
  await flush();
  assert.equal(added.length, 1);
  assert.deepEqual(closed, ['close']);
  await unmount();
});

test('a camera that is opening says to answer the prompt, and the line goes with the pick', async () => {
  const gate = held();
  const unmount = await mount(sheet({ camera: () => gate.promise }, filesOf([])));
  await click('Camera');
  assert.match(document.body.textContent ?? '', /Opening… answer the prompt if iOS asks\./);
  assert.doesNotMatch(document.body.textContent ?? '', /Getting your selection…/);
  await act(async () => gate.release(null));
  await flush();
  assert.doesNotMatch(document.body.textContent ?? '', /Opening…|Getting your selection…/);
  await unmount();
});

test('a failed pick shows its error and frees the buttons', async () => {
  const calls: string[] = [];
  const media: any = {
    library: async () => Promise.reject(new Error('Allow camera access in Settings to take a photo.')),
    camera: async () => (calls.push('camera'), null),
  };
  const unmount = await mount(sheet(media, filesOf([])));
  await click('Photos');
  assert.match(document.body.textContent ?? '', /Allow camera access/);
  await click('Camera');
  assert.deepEqual(calls, ['camera'], 'the other button works again');
  await unmount();
});

test('a refused camera says so and offers Open Settings, which opens the app page in Settings', async () => {
  const media: any = {
    camera: async () => Promise.reject(new AccessDenied('camera', 'Allow camera access in Settings to take a photo.')),
    library: async () => Promise.reject(new Error('plain failure')),
  };
  (globalThis as any).__phoneOpenedSettings = false;
  const unmount = await mount(sheet(media, filesOf([])));
  await click('Camera');
  assert.match(document.body.textContent ?? '', /Allow camera access/);
  await click('Open Settings');
  assert.equal((globalThis as any).__phoneOpenedSettings, true);
  // a plain failure offers no Settings, and the offer goes with the next try
  await click('Photos');
  assert.match(document.body.textContent ?? '', /plain failure/);
  assert.equal(document.querySelector('button[aria-label="Open Settings"]'), null);
  await unmount();
});

test('a second tap on Record voice note while the recorder opens starts one recording', async () => {
  const gate = held();
  let starts = 0;
  const media: any = {
    startRecording: () => (starts++, gate.promise),
    cancelRecording: async () => {},
    level: () => null,
  };
  const unmount = await mount(createElement(VoiceNote, { media, request: (async () => ({})) as any, caps: null, use() {} }));
  await click('Record voice note');
  await click('Record voice note');
  assert.equal(starts, 1);
  assert.match(document.body.textContent ?? '', /answer the microphone prompt/, 'a pending recorder says so in the app');
  await act(async () => gate.release(undefined));
  await flush();
  assert.match(document.body.textContent ?? '', /Stop and transcribe/);
  await unmount();
});
