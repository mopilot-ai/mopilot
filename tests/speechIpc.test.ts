// Shared speech IPC binds checked services, renderer capture lifetime and validated local audio to main.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { encodeWav } from '../src/lib/dictation.ts';
import { setup, selectSegment } from './support/controller/fixture.ts';
const require = createRequire(import.meta.url);
let localEnabled = true;
let dictationEnabled = true;
const isFlagEnabled = (key: string) =>
  key === 'shared.dictation.local' ? localEnabled : key === 'shared.dictation.enabled' ? dictationEnabled : true;
const { register } = require('../electron/app/ipc/speech.cjs');

test('speech IPC owns captures across windows, validates the original chat, and stops native resources on renderer loss', async (t) => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  t.after(() => Object.defineProperty(process, 'platform', originalPlatform));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-ipc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const w = setup();
  selectSegment(w.c, w.chats, 'chat', [['codex', 'native']]);
  selectSegment(w.c, w.chats, 'other', [['codex', 'other-native']]);
  const prefs = { defaultHarness: 'codex', dictationLanguage: 'en', dictationEngine: 'chatgpt' };
  const handlers = new Map<string, (...args: any[]) => any>();
  const calls: any[] = [];
  let localError = false;
  w.c.codex.pin = (...a: any[]) => calls.push(['pin', ...a]);
  w.c.codex.request = async (...a: any[]) => {
    calls.push(a);
    if (a[0] === 'thread/realtime/stop')
      require('../electron/session/voice.cjs').observeVoice(w.c.codex, {
        kind: 'message',
        msg: { method: 'thread/realtime/closed', params: { threadId: a[1].threadId } },
      });
    return {};
  };
  const live: any = {
    controller: w.c,
    chats: w.chats,
    codex: w.c.codex,
    acpTurns: {},
    acpHost: { chats: new Map(), items: { listAsync: async () => [], readAsync: async () => [] } },
    accounts: { view: () => ({ active: 'account', chatAccounts: {} }), loginEpoch: 0, chatgptHeaders: async () => ({}) },
    identity: { instances: () => [{ id: 'instance', account: 'account', active: true, status: 'ready' }] },
    mopilot: { gatewayKey: () => 'credits' },
    computerUse: {
      helper: Object.assign(new EventEmitter(), {
        start: async () => {
          if (localError) throw new Error('helper gone');
        },
        speechStatus: async () => ({ available: true, onDevice: true, authorization: 'authorized' }),
        // this Mac's streaming dictation (electron/platform/speechStream.cjs)
        call: async (method: string, params: any) => {
          calls.push(['helper', method, params]);
          return method === 'speech.stream.finish' ? { text: 'streamed' } : {};
        },
      }),
    },
    capsService: { get: async () => ({ kind: 'codex', caps: { voiceChat: { state: 'native' } } }) },
    recordings: { list: async () => [] },
    dictation: {
      transcribe: async (p: any) => {
        p.current();
        calls.push(['transcribe', p.engine]);
        return { text: 'draft' };
      },
    },
  };
  let ipc = Object.assign(new EventEmitter(), { handle: (name: string, fn: any) => handlers.set(name, fn) });
  register(ipc, { live, app: { getPath: () => dir }, readState: () => ({ prefs }), isFlagEnabled });
  const makePage = (id: number) => {
    const sender = Object.assign(new EventEmitter(), { id, mainFrame: { detached: false }, isDestroyed: () => false });
    const event: any = { sender, senderFrame: sender.mainFrame };
    ipc.emit('speech:document', event);
    const invoke = (method: string, ...args: any[]) => handlers.get(`speech:${method}`)!(event, event.returnValue, ...args);
    return { sender, invoke, owner: event.returnValue };
  };
  const { sender, invoke } = makePage(1);
  const second = makePage(2);
  const options = await invoke('options', 'chat', {});
  assert.equal(options.engine, 'chatgpt');
  assert.equal(options.choices[0].state, 'ready', 'the Darwin helper boundary is exercised on every CI platform');
  assert.equal(options.choices.find((c: any) => c.id === 'credits').state, 'ready');
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  try {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    assert.deepEqual((await invoke('options', 'chat', {})).choices[0], {
      id: 'local',
      label: 'This Mac',
      state: 'blocked',
      reason: 'On-device recognition needs macOS',
    });
  } finally {
    Object.defineProperty(process, 'platform', platform);
  }
  localEnabled = false;
  assert.equal((await invoke('options', 'chat', {})).choices[0].state, 'blocked');
  localEnabled = true;
  localError = true;
  assert.equal((await invoke('options', 'chat', {})).choices[0].state, 'unknown');
  assert.equal((await invoke('options', null, {})).conversation, false);
  assert.equal((await invoke('options', null, { kind: 'claude' })).conversation, false);
  const retained = { text: 'Keep before submitting', attachments: [{ kind: 'audio', path: '/keep.wav' }] };
  const held = invoke('hold', 'chat', retained);
  invoke('finishTransfer', held, false);
  assert.equal(live.controller.audioPending.list()[0].phase, 'released');
  const mismatch = invoke('hold', 'home', retained, null, { kind: 'claude' });
  assert.throws(
    () =>
      live.controller.audioPending.admit('chat', {
        id: 'wrong',
        text: '',
        attachments: retained.attachments,
        opts: { audioTransfer: mismatch },
      }),
    /recipient changed/,
  );
  invoke('finishTransfer', mismatch, true);
  const accepted = invoke('hold', 'home', retained, null, { kind: 'codex' });
  live.controller.audioPending.admit('chat', {
    id: 'accepted',
    text: '',
    attachments: retained.attachments,
    opts: { audioTransfer: accepted },
  });
  const existing = invoke('hold', 'chat', retained, 'chat');
  live.controller.audioPending.admit('chat', {
    id: 'existing',
    text: '',
    attachments: retained.attachments,
    opts: { audioTransfer: existing },
  });
  const id = invoke('begin', 'chat', {});
  // streaming on this Mac: only the capture's own page, only while it is current, with the switches on
  const streamed: any[] = [];
  let destroyed = false;
  const helperWas = localError;
  localError = false;
  Object.assign(sender, { send: (channel: string, msg: any) => streamed.push([channel, msg]), isDestroyed: () => destroyed });
  const pinned = prefs.dictationEngine;
  prefs.dictationEngine = 'local';
  await invoke('streamStart', id, 'en');
  const session = calls.findLast((c) => c[1] === 'speech.stream.start')[2].session;
  invoke('streamAudio', id, new Uint8Array([1, 0]));
  live.computerUse.helper.emit('speech', 'speech.stream.result', { session, text: 'hi' });
  destroyed = true;
  live.computerUse.helper.emit('speech', 'speech.stream.result', { session, text: 'gone' });
  destroyed = false;
  assert.deepEqual(streamed, [['speech:stream', { id, text: 'hi' }]]);
  assert.deepEqual(await invoke('streamFinish', id), { text: 'streamed' });
  // a service pinned elsewhere, or the stream switched off, while recording: the next frame ends the stream instead
  for (const change of ['pin', 'switch']) {
    await invoke('streamStart', id, 'en');
    if (change === 'pin') prefs.dictationEngine = 'credits';
    else localEnabled = false;
    invoke('streamAudio', id, new Uint8Array([1, 0]));
    assert.deepEqual(await invoke('streamFinish', id), { error: 'This dictation stream has ended' }, change);
    prefs.dictationEngine = 'local';
    localEnabled = true;
  }
  for (const unavailable of ['credits', 'claude']) await assert.rejects(invoke('streamStart', id, 'en', unavailable), /has no stream/);
  // the ChatGPT stream asks main for the login's headers; signed out, it refuses before connecting
  const headers = live.accounts.chatgptHeaders;
  live.accounts.chatgptHeaders = async () => null;
  await assert.rejects(invoke('streamStart', id, 'en', 'chatgpt'), /Sign in with ChatGPT/);
  live.accounts.chatgptHeaders = headers;
  prefs.dictationEngine = pinned;
  await assert.rejects(invoke('streamStart', 'not-current', 'en'), /cancelled/);
  assert.throws(() => invoke('streamFinish', 'not-current'), /cancelled/);
  invoke('streamAudio', 'not-current', new Uint8Array([1, 0]));
  localEnabled = false;
  await assert.rejects(invoke('streamStart', id, 'en'), /turned off/);
  localEnabled = true;
  await invoke('streamStart', id, 'en');
  // another page's end for a capture it doesn't hold leaves this stream alone
  const cancels = calls.filter((c) => c[1] === 'speech.stream.cancel').length;
  await second.invoke('end', id);
  assert.equal(calls.filter((c) => c[1] === 'speech.stream.cancel').length, cancels);
  invoke('streamCancel', id);
  localError = helperWas;
  assert.throws(() => second.invoke('begin', 'other', {}), /already active/);
  assert.equal(invoke('current', id), true);
  const bytes = encodeWav(new Float32Array(32), 16000);
  const attachment = invoke('save', id, bytes);
  assert.match(await invoke('read', attachment.path), /^data:audio\/wav;base64,/);
  assert.equal((await live.acpTurns.readAudio(attachment.path)).type, 'audio');
  assert.deepEqual(await invoke('transcribe', id, bytes, 'audio/wav', 'en', 'chatgpt'), { text: 'draft' });
  localEnabled = false;
  assert.throws(() => invoke('transcribe', id, bytes, 'audio/wav', 'en', 'local'), /turned off/);
  localEnabled = true;
  for (const unavailable of ['guessed', 'claude'])
    assert.throws(() => invoke('transcribe', id, bytes, 'audio/wav', 'en', unavailable), /explicit dictation/);
  prefs.dictationLanguage = 'fr';
  // an audio message is bound to what it was recorded for; a dictation still transcribes into its draft
  assert.throws(() => invoke('save', id, bytes), /earlier chat/);
  assert.deepEqual(await invoke('transcribe', id, bytes, 'audio/wav', 'en', 'chatgpt'), { text: 'draft' });
  prefs.dictationLanguage = 'en';
  dictationEnabled = false;
  assert.equal((await invoke('options', 'chat', {})).engine, null);
  assert.equal(await invoke('available', 'chat', {}), false);
  dictationEnabled = true;
  assert.equal(await invoke('available', 'chat', {}), true);
  live.chatDeletion = { isDeleted: () => true };
  assert.throws(() => invoke('draft', 'chat', { text: 'late', attachments: [attachment] }), /deleted/);
  live.chatDeletion.isDeleted = () => false;
  await invoke('draft', 'chat', { text: 'Unsent', attachments: [attachment] });
  assert.equal(invoke('drafts').chat.text, 'Unsent');
  await assert.rejects(invoke('conversation', id, { threadId: 'other-native' }), /original chat/);
  prefs.dictationLanguage = 'fr';
  await assert.rejects(invoke('conversation', id, { threadId: 'native' }), /chat or account changed/);
  prefs.dictationLanguage = 'en';
  await invoke('conversation', id, { threadId: 'native' });
  sender.emit('destroyed');
  await new Promise(setImmediate);
  assert.ok(calls.some((c) => c[0] === 'thread/realtime/stop'));
  assert.throws(() => invoke('current', id), /earlier page/);
  assert.throws(() => invoke('save', id, bytes), /earlier page/);
  assert.throws(() => invoke('transcribe', id, bytes, 'audio/wav', 'en', 'chatgpt'), /earlier page/);
  assert.throws(() => invoke('begin', 'chat', {}), /earlier page/);
  const next = second.invoke('begin', 'chat', {});
  const transcribe = live.dictation.transcribe;
  // the window's wait (its last argument) ends the request in main too: it is stopped once the window gave up
  live.dictation.transcribe = (p: any) =>
    new Promise((resolve) => p.signal.addEventListener('abort', () => resolve({ error: 'stopped' }), { once: true }));
  assert.deepEqual(await second.invoke('transcribe', next, bytes, 'audio/wav', 'en', 'chatgpt', 1), { error: 'stopped' });
  // an older window says no wait, and a nonsense one is ignored: the longest wait applies, and an answer ends it
  live.dictation.transcribe = async (p: any) => ({ text: String(p.signal.aborted) });
  for (const wait of [undefined, 0, 'soon'])
    assert.deepEqual(await second.invoke('transcribe', next, bytes, 'audio/wav', 'en', 'chatgpt', wait), { text: 'false' });
  // a transcription whose capture ends while it waits sends nothing for the cancelled recording
  live.dictation.transcribe = async (p: any) => {
    await second.invoke('end', next);
    p.current();
  };
  await assert.rejects(second.invoke('transcribe', next, bytes, 'audio/wav', 'en', 'chatgpt'), /was cancelled/);
  live.dictation.transcribe = transcribe;
  await second.invoke('end', next);
  const ordinary = second.invoke('begin', 'chat', {});
  second.sender.emit('render-process-gone');
  assert.equal(live.speech.current(second.owner, ordinary), false, 'crash releases ordinary capture without React cleanup');
  const replacement = makePage(3);
  const closing = replacement.invoke('begin', 'chat', {});
  live.speech.attach(replacement.owner, closing, async () => {
    throw new Error('stop failed');
  });
  const pendingClose = t.mock.method(live.controller.audioPending, 'close', () => {
    throw new Error('disk full');
  });
  replacement.sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  await new Promise(setImmediate);
  assert.equal(live.speech.current(replacement.owner, closing), false);
  pendingClose.mock.restore();
  delete (prefs as any).dictationEngine;
  await makePage(5).invoke('options', 'chat', {});
  fs.writeFileSync(path.join(dir, 'audio-pending.json'), 'unreadable pending input');
  ipc = Object.assign(new EventEmitter(), { handle: (name: string, fn: any) => handlers.set(name, fn) });
  register(ipc, { live, app: { getPath: () => dir }, readState: () => ({}), isFlagEnabled });
  const restarted = makePage(4);
  // no saved engine and the helper unreachable: Automatic uses the signed-in ChatGPT account
  assert.equal((await restarted.invoke('options', null, {})).engine, 'chatgpt');
  assert.throws(() => restarted.invoke('hold', 'home', retained));
  assert.equal(fs.readFileSync(path.join(dir, 'audio-pending.json'), 'utf8'), 'unreadable pending input');
});
