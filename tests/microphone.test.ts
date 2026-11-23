// Opening the microphone (src/session/microphone.ts) and the app's macOS grant (electron/platform/micAccess.cjs): each
// failure says what to do, a saved device that is gone falls back to the default, and a denied grant opens Settings.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const require = createRequire(import.meta.url);
const { createMicAccess, MIC_SETTINGS } = require('../electron/platform/micAccess.cjs');

const calls: any[][] = [];
let prefs: any = {};
let access: () => Promise<string>;
let gum: (c: any) => Promise<any>;
stubStore({ getState: () => ({ prefs }), toast: (...a: any[]) => calls.push(['toast', ...a]) });
installNativeStub({
  dictation: { micAsk: () => access(), micSettings: async () => void calls.push(['settings']) },
});
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { mediaDevices: { getUserMedia: (c: any) => (calls.push(['gum', c]), gum(c)) } },
});
const { classifyMicError, openMicrophone, reportMicError, MicError, MIC_TEXT } = await import('../src/session/microphone.ts');
const named = (name: string, message = name) => Object.assign(new Error(message), { name });

beforeEach(() => {
  calls.length = 0;
  prefs = {};
  access = async () => 'granted';
  gum = async () => 'stream';
});

test('getUserMedia rejections are classified by what the user can do', () => {
  for (const name of ['NotAllowedError', 'SecurityError']) assert.equal(classifyMicError(named(name)), 'permission');
  for (const name of ['NotFoundError', 'OverconstrainedError']) assert.equal(classifyMicError(named(name)), 'missing');
  for (const name of ['NotReadableError', 'AbortError']) assert.equal(classifyMicError(named(name)), 'busy');
  for (const error of [named('TypeError'), null, undefined, 'text']) assert.equal(classifyMicError(error), 'other');
});

test('the saved microphone is used, and a missing one falls back to the default with a notice', async () => {
  prefs.micDeviceId = 'usb';
  assert.equal(await openMicrophone({ echoCancellation: true }), 'stream');
  assert.deepEqual(calls, [['gum', { audio: { echoCancellation: true, deviceId: { exact: 'usb' } } }]]);
  calls.length = 0;
  gum = async (c) => {
    if (c.audio.deviceId) throw named('OverconstrainedError');
    return 'default';
  };
  assert.equal(await openMicrophone(), 'default');
  assert.deepEqual(calls.slice(1), [
    ['gum', { audio: {} }],
    ['toast', 'The microphone chosen in Settings was not found, so the system default is used.', 'info'],
  ]);
  gum = async () => {
    throw named('NotFoundError');
  };
  await assert.rejects(openMicrophone(), (e: any) => e instanceof MicError && e.failure === 'missing' && e.message === MIC_TEXT.missing);
  prefs = {};
  gum = async () => {
    throw named('NotReadableError');
  };
  await assert.rejects(openMicrophone(), (e: any) => e.failure === 'busy');
  gum = async () => {
    throw named('TypeError', 'bad constraint');
  };
  await assert.rejects(openMicrophone(), (e: any) => e.failure === 'other' && /bad constraint/.test(e.message));
  gum = async () => {
    throw new Error('');
  };
  await assert.rejects(openMicrophone(), /The microphone could not start/);
});

test('a denied macOS grant never opens the device; an unreadable grant is left to Chromium', async () => {
  for (const answer of ['denied', 'restricted']) {
    access = async () => answer;
    await assert.rejects(openMicrophone(), (e: any) => e.failure === 'permission');
  }
  assert.equal(calls.length, 0);
  access = async () => {
    throw new Error('old preload');
  };
  assert.equal(await openMicrophone(), 'stream');
});

test('a permission failure offers System Settings; other failures read as plain sentences', async () => {
  reportMicError(new MicError('permission', MIC_TEXT.permission));
  const [, text, kind, opts] = calls[0];
  assert.deepEqual([text, kind, opts.action.label], [MIC_TEXT.permission, 'error', 'Open System Settings']);
  opts.action.run();
  await new Promise(setImmediate);
  assert.deepEqual(calls.at(-1), ['settings']);
  reportMicError(new MicError('busy', MIC_TEXT.busy));
  reportMicError(new Error('boom'));
  assert.deepEqual(calls.slice(-2), [
    ['toast', MIC_TEXT.busy, 'error'],
    ['toast', 'Boom.', 'error'],
  ]);
});

test('the macOS grant: status, a prompt only when undecided, and the Privacy pane', async () => {
  const opened: string[] = [];
  let status = 'not-determined';
  let answer: any = true;
  const sp = {
    getMediaAccessStatus: (kind: string) => {
      assert.equal(kind, 'microphone');
      if (status === 'throw') throw new Error('no TCC');
      return status;
    },
    askForMediaAccess: async () => {
      if (answer === 'throw') throw new Error('prompt failed');
      return answer;
    },
  };
  const shell = { openExternal: async (url: string) => void opened.push(url) };
  const mac = createMicAccess({ systemPreferences: sp, shell, platform: 'darwin' });
  assert.equal(mac.status(), 'not-determined');
  assert.equal(await mac.ask(), 'granted');
  answer = false;
  assert.equal(await mac.ask(), 'denied');
  answer = 'throw';
  assert.equal(await mac.ask(), 'unknown');
  status = 'denied';
  assert.equal(await mac.ask(), 'denied', 'a decided grant is not asked again');
  status = 'throw';
  assert.equal(mac.status(), 'unknown');
  await mac.openSettings();
  assert.deepEqual(opened, [MIC_SETTINGS]);
  const other = createMicAccess({ systemPreferences: sp, shell, platform: 'linux' });
  assert.equal(other.status(), 'granted');
  assert.equal(await other.ask(), 'granted');
  await other.openSettings();
  assert.equal(opened.length, 1);
  assert.equal(createMicAccess({ systemPreferences: sp, shell }).status(), process.platform === 'darwin' ? 'unknown' : 'granted');
});
