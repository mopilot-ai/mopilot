// Voice mode (src/session/voice.ts) and the dictation audio helper (src/lib/dictation.ts): routing a voice
// chat to Codex, the WebRTC session's lifecycle, live captions, and decoding a recording to WAV.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { speechMock } from './support/speechMock.ts';
import { defined } from './support/defined.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const calls: any[][] = [];
let state: any;
let requestImpl: (method: string, params: any) => Promise<any>;
let notify: ((method: string, p: any) => void) | null = null;
let recordings: () => Promise<any[]>;
let newThread: () => Promise<string>;
let created: string | null;
let readCaps: (...args: any[]) => Promise<any>;
let createChat: () => Promise<string | null>;
let sendContext: () => Promise<void>;
mock.module('../src/harness/adapters/codex.ts', {
  namedExports: {
    codexRequest: (method: string, params: any) => (calls.push(['request', method, params]), requestImpl(method, params)),
    onCodexNotification: (h: any) => ((notify = h), () => calls.push(['offNotif'])),
  },
});
stubStore({
  useStore: { getState: () => state },
  getState: () => state,
  codexUsable: (s: any) => s.codexOk,
  ensureResumed: async (id: string) => void calls.push(['resume', id]),
  pinLease: (id: string, on: boolean) => calls.push(['lease', id, on]),
  setPrefs: (p: any) => (calls.push(['prefs', p]), Object.assign(state.prefs, p)),
  // a chat nobody put on another harness is a Codex chat (voice checks it again before it starts)
  chatFamily: (id: string) => state.harnessOf[id] ?? 'codex',
  newChatHarness: () => state.newHarness,
  newChatFamily: () => state.newHarness,
  newChatKind: () => state.newHarness,
  createChatThread: async (title: string) => (calls.push(['create', title]), createChat()),
  startThread: async (o: any) => (calls.push(['startThread', o]), newThread()),
  sendOrDraft: async (id: string, text: string) => {
    calls.push(['send', id, text]);
    await sendContext();
  },
  navigate: (r: any) => calls.push(['navigate', r]),
  currentCwdForNewChat: () => '/home-cwd',
  toast: (t: string, kind?: string) => calls.push(['toast', t, kind]),
  chatHarnessLabel: () => 'Claude Code',
  nativeOf: (id: string) => id,
});
// Codex can run voice for every destination (voiceAccess.ts reads its capabilities first)
mock.module('../src/store/session/useCaps.ts', {
  namedExports: { capsOf: (...args: any[]) => readCaps(...args) },
});
installNativeStub({
  speech: {
    ...speechMock(),
    begin: async (id: string) => 'capture:' + id,
    end: (id: string) => (calls.push(['captureEnd', id]), requestImpl('thread/realtime/stop', {})),
    conversation: (_id: string, p: any) => (calls.push(['request', 'thread/realtime/start', p]), requestImpl('thread/realtime/start', p)),
    options: async () => ({ engine: state.prefs.dictationEngine ?? 'chatgpt' }),
  },
  recordings: { list: () => recordings() },
});

// --- browser media fakes ------------------------------------------------------------------------
class Track {
  enabled = true;
  stopped = false;
  stop() {
    this.stopped = true;
  }
}
class Stream {
  tracks = [new Track()];
  getAudioTracks() {
    return this.tracks;
  }
  getTracks() {
    return this.tracks;
  }
}
let pcs: FakePC[] = [];
let remoteFails = false;
class FakePC {
  connectionState = 'new';
  tracks: any[] = [];
  dc: any = {};
  closed = false;
  remote: any = null;
  onconnectionstatechange: any;
  ontrack: any;
  constructor() {
    pcs.push(this);
  }
  addTrack(t: any) {
    this.tracks.push(t);
  }
  createDataChannel() {
    return this.dc;
  }
  async createOffer() {
    return { type: 'offer', sdp: 'OFFER' };
  }
  async setLocalDescription() {}
  async setRemoteDescription(d: any) {
    if (remoteFails) throw new Error('bad sdp');
    this.remote = d;
  }
  close() {
    this.closed = true;
  }
}
let audios: any[] = [];
let playFails = false;
class FakeAudio {
  autoplay = false;
  srcObject: any = null;
  constructor() {
    audios.push(this);
  }
  play() {
    return playFails ? Promise.reject(new Error('blocked')) : Promise.resolve();
  }
}
let ctxCloseFails = false;
let rafCb: (() => void) | null = null;
class FakeAudioContext {
  closed = false;
  createAnalyser() {
    return {
      fftSize: 0,
      frequencyBinCount: 4,
      getByteTimeDomainData(d: Uint8Array) {
        d.set([128, 168, 88, 128]);
      },
    };
  }
  createMediaStreamSource() {
    return { connect() {} };
  }
  close() {
    this.closed = true;
    return ctxCloseFails ? Promise.reject(new Error('x')) : Promise.resolve();
  }
  async decodeAudioData(buf: ArrayBuffer) {
    return { duration: buf.byteLength / 1000, buf };
  }
}
let gum: (c: any) => Promise<any>;
const g = globalThis as any;
g.RTCPeerConnection = FakePC;
g.Audio = FakeAudio;
g.AudioContext = FakeAudioContext;
g.requestAnimationFrame = (cb: () => void) => ((rafCb = cb), 7);
g.cancelAnimationFrame = () => {};
Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: (c: any) => gum(c) } });

const voice = await import('../src/session/voice.ts');
const { recordingToWav } = await import('../src/lib/dictation.ts');
const {
  useVoice,
  startVoice,
  stopVoice,
  startVoiceChat,
  toggleMute,
  dismissVoiceError,
  currentDictationEngine,
  voiceEnv,
  VOICE_UNAVAILABLE,
} = voice;
const settle = () => new Promise((r) => setTimeout(r, 0));
const v = () => useVoice.getState();

beforeEach(async () => {
  // end any previous session quietly
  requestImpl = async () => ({});
  if (v().phase !== 'idle') await stopVoice(false);
  dismissVoiceError();
  calls.length = 0;
  pcs = [];
  audios = [];
  notify = null;
  remoteFails = playFails = ctxCloseFails = false;
  rafCb = null;
  delete (window as any).__voiceTestStream;
  gum = async () => new Stream();
  recordings = async () => [];
  newThread = async () => 'new-thread';
  created = 'created-chat';
  readCaps = async (id) => {
    const kind = id ? (state.harnessOf[id] ?? 'codex') : state.newHarness;
    return { kind, caps: { voiceChat: { state: kind === 'codex' && state.codexOk ? 'native' : 'absent' } } };
  };
  createChat = async () => created;
  sendContext = async () => {};
  state = { codexOk: true, prefs: {}, threads: {}, runtime: {}, harnessOf: {}, newHarness: 'codex' };
});

test('voice without a usable Codex shows the needs-Codex error on that chat', async () => {
  state.codexOk = false;
  await startVoiceChat('chat-1');
  assert.deepEqual(
    { ...v(), level: undefined },
    { threadId: 'chat-1', phase: 'error', error: VOICE_UNAVAILABLE, muted: false, caption: null, level: undefined },
  );
  dismissVoiceError();
  assert.deepEqual([v().phase, v().threadId, v().error], ['idle', null, null]);
});

test('a Codex chat starts voice in place with the chosen voice; a new chat is created first', async () => {
  state.harnessOf['chat-1'] = 'codex';
  state.prefs.voice = 'juniper';
  await startVoiceChat('chat-1');
  await settle();
  const start = defined(calls.find((c) => c[1] === 'thread/realtime/start'));
  assert.equal(start[2].threadId, 'chat-1');
  assert.equal(start[2].voice, 'juniper');
  assert.deepEqual(start[2].transport, { type: 'webrtc', sdp: 'OFFER' });
  await stopVoice();
  calls.length = 0;
  delete state.prefs.voice;
  await startVoiceChat(null);
  await settle();
  assert.deepEqual(calls[0], ['create', 'Voice chat']);
  assert.equal(defined(calls.find((c) => c[1] === 'thread/realtime/start'))[2].voice, 'cove');
  await stopVoice();
  calls.length = 0;
  created = null;
  await startVoiceChat(null);
  assert.deepEqual(calls, [['create', 'Voice chat']]);
});

test('a session connects, plays the remote audio, and tears everything down on stop', async () => {
  state.prefs.micDeviceId = 'mic-2';
  let constraint: any;
  const stream = new Stream();
  gum = async (c) => ((constraint = c), stream);
  await startVoice('t1', 'not-a-voice');
  assert.deepEqual(constraint, { audio: { echoCancellation: true, noiseSuppression: true, deviceId: { exact: 'mic-2' } } });
  assert.equal(v().phase, 'connecting');
  const start = defined(calls.find((c) => c[1] === 'thread/realtime/start'))[2];
  assert.equal(start.voice, 'cove');
  assert.deepEqual(
    calls.filter((c) => c[0] === 'resume' || c[0] === 'lease'),
    [['resume', 't1']],
  );
  const pc = pcs[0];
  assert.ok(pc.tracks[0] === stream.tracks[0]);
  // the input meter samples the microphone every frame
  assert.ok(v().level > 0 && v().level <= 1);
  rafCb!();
  pc.connectionState = 'connected';
  pc.onconnectionstatechange();
  assert.equal(v().phase, 'listening');
  pc.connectionState = 'checking';
  pc.onconnectionstatechange();
  assert.equal(v().phase, 'listening');
  pc.ontrack({ streams: ['remote-1'] });
  playFails = true;
  pc.ontrack({ streams: ['remote-2'] });
  await settle();
  assert.equal(audios.length, 1, 'one audio element is reused');
  assert.equal(audios[0].srcObject, 'remote-2');
  assert.equal(audios[0].autoplay, true);
  // mute toggles the microphone tracks
  toggleMute();
  assert.equal(v().muted, true);
  assert.equal(stream.tracks[0].enabled, false);
  toggleMute();
  assert.equal(stream.tracks[0].enabled, true);
  ctxCloseFails = true;
  requestImpl = async (m) => {
    if (m === 'thread/realtime/stop') throw new Error('gone');
    return {};
  };
  await stopVoice();
  assert.ok(calls.some((c) => c[0] === 'captureEnd'));
  assert.deepEqual(
    calls.filter((c) => c[0] === 'lease'),
    [],
  );
  assert.equal(pc.closed, true);
  assert.equal(stream.tracks[0].stopped, true);
  assert.equal(audios[0].srcObject, null);
  assert.deepEqual([v().phase, v().threadId, v().level], ['error', 't1', 0]);
  assert.equal(v().error, 'gone');
  // a late state change after teardown is ignored
  pc.connectionState = 'connected';
  pc.onconnectionstatechange();
  assert.equal(v().phase, 'error');
  dismissVoiceError();
  // stopping while idle touches nothing; muting with no microphone only flips the flag
  calls.length = 0;
  await stopVoice();
  toggleMute();
  assert.equal(v().muted, true);
  assert.deepEqual(calls, [] as any[][]);
});

test('a test stream is used instead of the microphone and is never stopped', async () => {
  const stream = new Stream();
  (window as any).__voiceTestStream = stream;
  gum = async () => assert.fail('microphone requested');
  await startVoice('t2');
  await startVoice('t3'); // a running session is stopped before the next starts
  assert.ok(calls.some((c) => c[0] === 'captureEnd' && c[1] === 'capture:t2'));
  await stopVoice(false);
  assert.equal(stream.tracks[0].stopped, false);
  assert.ok(
    calls.some((c) => c[0] === 'captureEnd' && c[1] === 'capture:t3'),
    'every local stop releases its original capture',
  );
});

test('server notifications for this thread drive the answer, captions, errors and close', async () => {
  await startVoice('t1');
  const pc = pcs[0];
  notify!('thread/realtime/sdp', { threadId: 'other', sdp: 'X' });
  notify!('thread/realtime/sdp', undefined);
  notify!('thread/realtime/sdp', { threadId: 't1', sdp: 'ANSWER' });
  await settle();
  assert.deepEqual(pc.remote, { type: 'answer', sdp: 'ANSWER' });
  notify!('thread/realtime/unknown', { threadId: 't1' });
  notify!('thread/realtime/transcript/delta', { threadId: 't1', role: 'user', delta: 'hel' });
  notify!('thread/realtime/transcript/delta', { threadId: 't1', role: 'user', delta: 'lo' });
  assert.deepEqual(v().caption, { role: 'user', text: 'hello' });
  assert.equal(v().phase, 'listening');
  notify!('thread/realtime/transcript/delta', { threadId: 't1', role: 'model', delta: 'Hi' });
  assert.deepEqual(v().caption, { role: 'assistant', text: 'Hi' });
  assert.equal(v().phase, 'speaking');
  notify!('thread/realtime/transcript/done', { threadId: 't1', role: 'model', text: 'Hi there' });
  assert.deepEqual(v().caption, { role: 'assistant', text: 'Hi there' });
  notify!('thread/realtime/closed', { threadId: 't1' });
  await settle();
  assert.equal(v().phase, 'idle');
  assert.ok(!calls.some((c) => c[1] === 'thread/realtime/stop'), 'a server close is not echoed back');
  // a late answer after close has no connection to apply to
  notify!('thread/realtime/sdp', { threadId: 't1', sdp: 'LATE' });
});

test('errors keep the bar on the chat with a clean message', async () => {
  await startVoice('t1');
  notify!('thread/realtime/error', { threadId: 't1', message: JSON.stringify({ error: { message: 'Quota exceeded' } }) });
  await settle();
  assert.deepEqual([v().phase, v().error, v().threadId], ['error', 'Quota exceeded', 't1']);
  dismissVoiceError();
  await startVoice('t1');
  notify!('thread/realtime/error', { threadId: 't1', message: JSON.stringify({ other: 1 }) });
  await settle();
  assert.equal(v().error, '{"other":1}');
  dismissVoiceError();
  await startVoice('t1');
  notify!('thread/realtime/error', { threadId: 't1', message: 'null' });
  await settle();
  assert.equal(v().error, 'null');
  dismissVoiceError();
  await startVoice('t1');
  notify!('thread/realtime/error', { threadId: 't1', message: 'first line\nstack' });
  await settle();
  assert.equal(v().error, 'first line');
  dismissVoiceError();
  await startVoice('t1');
  remoteFails = true;
  notify!('thread/realtime/sdp', { threadId: 't1', sdp: 'BAD' });
  await settle();
  assert.equal(v().error, 'bad sdp');
  dismissVoiceError();
  await startVoice('t1');
  pcs.at(-1)!.connectionState = 'failed';
  pcs.at(-1)!.onconnectionstatechange();
  await settle();
  assert.equal(v().error, 'Voice connection failed');
});

test('start failures: denied microphone, request errors and odd throws', async () => {
  gum = () => Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
  await startVoice('t1');
  await settle();
  assert.equal(v().error, 'Microphone access is off for MoPilot.');
  dismissVoiceError();
  gum = async () => new Stream();
  requestImpl = async (m) => {
    if (m === 'thread/realtime/start') throw new Error('not allowed here\ntrace');
    return {};
  };
  await startVoice('t1');
  await settle();
  assert.equal(v().error, 'not allowed here');
  dismissVoiceError();
  requestImpl = async (m) => {
    if (m === 'thread/realtime/start') throw 'raw failure';
    return {};
  };
  await startVoice('t1');
  await settle();
  assert.equal(v().error, 'raw failure');
});

test('a session closed while starting skips the input meter', async () => {
  requestImpl = async (m) => {
    if (m === 'thread/realtime/start') notify!('thread/realtime/closed', { threadId: 't1' });
    return {};
  };
  await startVoice('t1');
  await settle();
  assert.equal(rafCb, null);
  assert.equal(v().phase, 'idle');
});

test('data-channel events update captions and phase; DEV builds record their types', async () => {
  await startVoice('t1');
  const send = (e: any) => pcs[0].dc.onmessage({ data: typeof e === 'string' ? e : JSON.stringify(e) });
  send('not json');
  send({ type: 'conversation.item.input_audio_transcription.delta', delta: 'wh' });
  send({ type: 'conversation.item.input_audio_transcription.delta' });
  assert.deepEqual(v().caption, { role: 'user', text: 'wh' });
  send({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'what time' });
  assert.deepEqual(v().caption, { role: 'user', text: 'what time' });
  send({ type: 'conversation.item.input_audio_transcription.completed' });
  assert.deepEqual(v().caption, { role: 'user', text: '' });
  send({ type: 'response.output_audio_transcript.delta', delta: 'It is' });
  send({ type: 'response.audio_transcript.delta' });
  assert.deepEqual(v().caption, { role: 'assistant', text: 'It is' });
  assert.equal(v().phase, 'speaking');
  send({ type: 'response.output_audio_transcript.done', transcript: 'It is noon' });
  assert.deepEqual(v().caption, { role: 'assistant', text: 'It is noon' });
  send({ type: 'response.audio_transcript.done' });
  assert.deepEqual(v().caption, { role: 'assistant', text: '' });
  send({ type: 'output_audio_buffer.stopped' });
  assert.equal(v().phase, 'listening');
  useVoice.setState({ phase: 'speaking' });
  send({ type: 'response.done' });
  assert.equal(v().phase, 'listening');
  send({ type: 'input_audio_buffer.speech_started' });
  assert.equal(v().caption, null);
  send({ type: 'session.updated' });
  assert.equal((window as any).__voiceEvents, undefined);
  voiceEnv.DEV = true;
  try {
    send({ type: 'session.updated' });
    send({ type: 'response.done' });
    assert.deepEqual((window as any).__voiceEvents, ['session.updated', 'response.done']);
  } finally {
    voiceEnv.DEV = false;
    delete (window as any).__voiceEvents;
  }
});

test('a recording decodes to 16 kHz mono WAV and the audio context is always closed', async () => {
  const offline: any[] = [];
  g.OfflineAudioContext = class {
    destination = 'dest';
    constructor(...args: any[]) {
      offline.push(args);
    }
    createBufferSource() {
      return { buffer: null, connect() {}, start() {} };
    }
    async startRendering() {
      return { getChannelData: () => new Float32Array([0.5, -0.5]) };
    }
  };
  const contexts: FakeAudioContext[] = [];
  g.AudioContext = class extends FakeAudioContext {
    constructor() {
      super();
      contexts.push(this);
    }
  };
  try {
    const wav = await recordingToWav(new Blob([new Uint8Array(100)]));
    assert.deepEqual(offline[0], [1, 1600, 16000]);
    assert.equal(wav.length, 44 + 4);
    assert.equal(new DataView(wav.buffer).getUint32(24, true), 16000);
    // an empty recording still renders one frame; a failed close is ignored
    ctxCloseFails = true;
    await recordingToWav(new Blob([]));
    assert.deepEqual(offline[1], [1, 1, 16000]);
    assert.ok(contexts.every((c) => c.closed));
  } finally {
    g.AudioContext = FakeAudioContext;
  }
});

test('a delayed stop acknowledgement cannot resume an older voice start after cancellation or replacement', async () => {
  for (const start of [startVoice, startVoiceChat])
    for (const change of ['none', 'cancel', 'replace']) {
      requestImpl = async () => ({});
      await startVoice('old');
      let release!: (result: object) => void;
      const stopped = new Promise<object>((resolve) => {
        release = resolve;
      });
      requestImpl = async (method) => (method === 'thread/realtime/stop' ? stopped : {});
      const pending = start('queued');
      await settle();
      assert.equal(v().phase, 'idle');
      if (change === 'cancel') await stopVoice(false);
      if (change === 'replace') await startVoice('newer');
      release({});
      await pending;
      assert.equal(v().threadId, change === 'none' ? 'queued' : change === 'replace' ? 'newer' : null);
      assert.equal(
        calls.some((call) => call[0] === 'request' && call[1] === 'thread/realtime/start' && call[2].threadId === 'queued'),
        change === 'none',
      );
      await stopVoice(false);
      calls.length = 0;
    }
});

test('a failed new voice chat reports its error without an unhandled rejection', async () => {
  for (const failure of [new Error('create failed'), 'plain failure', null]) {
    calls.length = 0;
    createChat = async () => {
      throw failure;
    };
    await startVoiceChat(null);
    const message = failure instanceof Error ? failure.message : String(failure);
    assert.deepEqual(
      calls.filter((call) => call[0] === 'toast'),
      [['toast', `Couldn't start voice: ${message}`, 'error']],
    );
    assert.equal(v().phase, 'idle');
  }
});

test('an aborted voice start cannot affect a replacement session', async () => {
  for (const route of ['direct', 'chat']) {
    await stopVoice(false);
    let release!: (value: any) => void;
    const pendingCaps = new Promise((resolve) => {
      release = resolve;
    });
    const available = { kind: 'codex', caps: { voiceChat: { state: 'native' } } };
    let reads = 0;
    readCaps = () => (++reads === 1 ? pendingCaps : Promise.resolve(available));
    const abort = new AbortController();
    const pending = route === 'direct' ? startVoice('old', 'cove', abort.signal) : startVoiceChat('old', abort.signal);
    await settle();
    await startVoice('replacement');
    abort.abort();
    release(available);
    await pending;
    assert.equal(v().threadId, 'replacement');
    await stopVoice(false);
  }
});

test('aborting pending voice capability preparation returns the session to idle', async () => {
  for (const route of ['direct', 'chat']) {
    let release!: (value: any) => void;
    readCaps = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const abort = new AbortController();
    const pending = route === 'direct' ? startVoice('pending', 'cove', abort.signal) : startVoiceChat('pending', abort.signal);
    await settle();
    abort.abort();
    release({ kind: 'codex', caps: { voiceChat: { state: 'native' } } });
    await pending;
    assert.equal(v().phase, 'idle');
    assert.equal(v().threadId, null);
  }
});

test('already-aborted startup leaves an existing voice session alone', async () => {
  await startVoice('existing');
  const count = calls.length;
  const abort = new AbortController();
  abort.abort();
  await startVoice('never', 'cove', abort.signal);
  await startVoiceChat('never', abort.signal);
  assert.equal(v().threadId, 'existing');
  assert.equal(calls.length, count);
});

test('startup cancellation while waiting for stop acknowledgement prevents a restart', async () => {
  for (const route of ['direct', 'chat'])
    for (const cancelled of [false, true]) {
      requestImpl = async () => ({});
      await startVoice('existing');
      let release!: (value: object) => void;
      const stopped = new Promise<object>((resolve) => {
        release = resolve;
      });
      requestImpl = async (method) => (method === 'thread/realtime/stop' ? stopped : {});
      const abort = new AbortController();
      const pending = route === 'direct' ? startVoice('queued', 'cove', abort.signal) : startVoiceChat('queued', abort.signal);
      await settle();
      if (cancelled) abort.abort();
      release({});
      await pending;
      assert.equal(v().threadId, cancelled ? null : 'queued');
      await stopVoice(false);
    }
});

test('aborting a completed startup does not stop the active session', async () => {
  const abort = new AbortController();
  await startVoiceChat('active', abort.signal);
  abort.abort();
  assert.equal(v().threadId, 'active');
  assert.equal(v().phase, 'connecting');
});

test('cancelling realtime startup also sends a stop for its native session', async () => {
  let release!: (value: object) => void;
  const started = new Promise<object>((resolve) => {
    release = resolve;
  });
  requestImpl = async (method) => (method === 'thread/realtime/start' ? started : {});
  const abort = new AbortController();
  const pending = startVoice('pending-native', 'cove', abort.signal);
  await settle();
  abort.abort();
  assert.ok(calls.some((call) => call[0] === 'captureEnd'));
  release({});
  await pending;
  assert.equal(v().phase, 'idle');
});

test('voice says when it is about to open the chat it will run in, and only then', async () => {
  const opening = () => calls.push(['opening']);
  const signal = new AbortController().signal;
  // an existing Codex chat: voice starts in place, no chat is opened
  await startVoiceChat('chat-1', signal, opening);
  assert.ok(!calls.some((c) => c[0] === 'opening'));
  await stopVoice(false);
  // a new chat: just before it is created (creating it switches to it)
  calls.length = 0;
  await startVoiceChat(null, signal, opening);
  assert.deepEqual(calls.slice(0, 2), [['opening'], ['create', 'Voice chat']]);
  await stopVoice(false);
  // Another harness never opens a destination chat or acquires a microphone.
  calls.length = 0;
  state.harnessOf['claude-chat'] = 'claude';
  await startVoiceChat('claude-chat', signal, opening);
  assert.equal(v().threadId, 'claude-chat');
  assert.equal(v().phase, 'error');
  assert.deepEqual(calls, []);
});

test('Claude and ACP voice never create a Codex chat, including new chats without Codex', async () => {
  for (const kind of ['claude', 'acp:gemini']) {
    state.harnessOf.source = kind;
    state.newHarness = kind;
    state.codexOk = false;
    for (const id of ['source', null]) {
      await startVoiceChat(id);
      assert.equal(v().phase, 'error');
      assert.equal(v().threadId, id);
      assert.deepEqual(calls, []);
      dismissVoiceError();
    }
  }
});

test('dictation reads main service selection without changing preferences', async () => {
  state.prefs.dictationEngine = 'credits';
  assert.equal(await currentDictationEngine(), 'credits');
  assert.deepEqual(calls, []);
});
