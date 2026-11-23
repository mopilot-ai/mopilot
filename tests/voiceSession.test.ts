import { speechMock } from './support/speechMock.ts';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mockSource, withStoreSlices } from './support/stubs.ts';
import { deferred } from './support/async-scenarios.ts';
import { installNativeStub } from './support/ports/native.ts';

const calls: any[] = [],
  pins: any[] = [],
  notices: any[] = [];
const fixture: any = { calls, pins, notices };
const f = fixture;
const stubs: Record<string, Record<string, unknown>> = {
  store: {
    useStore: { getState: () => f.state },
    getState: () => f.state,
    codexUsable: () => f.usable,
    ensureResumed: (id: string) => f.resume(id),
    pinLease: (...a: any[]) => f.pins.push(a),
    setPrefs: (p: any) => Object.assign(f.state.prefs, p),
    chatFamily: () => f.harness,
    nativeOf: () => f.nativeId,
    newChatHarness: () => f.newHarness,
    newChatFamily: () => f.newHarness,
    newChatKind: () => f.newHarness,
    createChatThread: () => f.createThread(),
    startThread: async (o: any) => {
      f.calls.push(['new', o]);
      if (f.createError) throw f.createError;
      return f.created;
    },
    sendOrDraft: async (...a: any[]) => (f.calls.push(['summary', ...a]), f.summarySent),
    navigate: (...a: any[]) => f.calls.push(['navigate', ...a]),
    currentCwdForNewChat: () => '/new-cwd',
    toast: (...a: any[]) => f.notices.push(a),
    chatHarnessLabel: () => f.label,
  },
  'harness/adapters/codex.ts': {
    codexRequest: (...a: any[]) => f.request(...a),
    onCodexNotification: (cb: any) => {
      f.notify = cb;
      return () => {
        f.off++;
      };
    },
  },
  'store/session/useCaps.ts': { capsOf: (...a: any[]) => f.caps(...a) },
  'lib/platform.ts': { isMac: true },
};
// the bridge the modules read, installed in the native port (src/lib/native.ts)
installNativeStub({
  speech: {
    ...speechMock(),
    begin: (id: string) => f.begin(id),
    current: () => f.captureCurrent(),
    options: () => f.options(),
    end: (id: string) => (f.calls.push(['captureEnd', id]), Promise.resolve().then(() => f.request('closeCapture', {}))),
    conversation: (_id: string, p: any) => f.request('thread/realtime/start', p),
  },
  recordings: { list: () => f.recordings() },
  dictation: { micAsk: async () => 'granted', micSettings: async () => undefined },
});
// voice.ts imports the slices that own these names: the same stand-ins there
for (const [rel, exports] of Object.entries(withStoreSlices(stubs))) mockSource(`src/${rel}`, exports);

class Peer {
  connectionState = 'new';
  channel: any = {};
  ontrack: any;
  onconnectionstatechange: any;
  closed = false;
  descriptions: any[] = [];
  constructor() {
    fixture.peer = this;
  }
  addTrack() {}
  createDataChannel() {
    return this.channel;
  }
  createOffer() {
    return fixture.offer();
  }
  setLocalDescription(v: any) {
    this.descriptions.push(v);
    return fixture.local();
  }
  setRemoteDescription(v: any) {
    this.descriptions.push(v);
    return fixture.remote();
  }
  close() {
    this.closed = true;
  }
}
(globalThis as any).RTCPeerConnection = Peer;
(globalThis as any).window = {
  dispatchEvent(e: any) {
    fixture.confirmCalls++;
    e.detail.resolve(fixture.answer);
  },
};
(globalThis as any).CustomEvent = class {
  detail: any;
  constructor(_name: any, options: any) {
    this.detail = options.detail;
  }
};
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    mediaDevices: {
      getUserMedia: () => {
        fixture.micCalls++;
        return fixture.media();
      },
    },
  },
});
(globalThis as any).requestAnimationFrame = (cb: any) => {
  fixture.frame = cb;
  return 1;
};
(globalThis as any).cancelAnimationFrame = () => {};
(globalThis as any).Audio = class {
  autoplay = false;
  srcObject: any;
  constructor() {
    fixture.audio = this;
  }
  play() {
    return Promise.reject(new Error('no autoplay'));
  }
};
(globalThis as any).AudioContext = class {
  constructor() {
    fixture.context = this;
  }
  createAnalyser() {
    return {
      fftSize: 0,
      frequencyBinCount: 1,
      getByteTimeDomainData(a: Uint8Array) {
        a[0] = 128;
      },
    };
  }
  createMediaStreamSource() {
    return { connect() {} };
  }
  close() {
    fixture.contextClosed++;
    return Promise.resolve();
  }
};
const V = await import('../src/session/voice.ts');
const nativeCaps = () => ({ kind: 'codex', caps: { voiceChat: { state: 'native' } } });
const blockedCaps = () => ({
  kind: 'codex',
  caps: { voiceChat: { state: 'disabled', why: { layer: 'account', code: 'account.voiceChatRequiresChatGPT' } } },
});
const flush = async () => {
  // the microphone grant check (src/session/microphone.ts) runs before getUserMedia
  for (let i = 0; i < 16; i++) await Promise.resolve();
};
beforeEach(() => {
  calls.length = 0;
  pins.length = 0;
  notices.length = 0;
  fixture.state = {
    prefs: { voice: 'cove', voiceRouteConfirmed: false },
    threads: { chat: { cwd: '/source' } },
    runtime: { chat: { turns: [] } },
  };
  Object.assign(fixture, {
    usable: true,
    harness: 'codex',
    newHarness: 'codex',
    nativeId: 'native-thread',
    created: 'new-chat',
    label: 'Claude Code',
    createError: null,
    confirmCalls: 0,
    answer: { summary: false },
    summarySent: true,
    micCalls: 0,
    stopped: 0,
    off: 0,
    contextClosed: 0,
  });
  fixture.track = {
    enabled: true,
    stop() {
      fixture.stopped++;
    },
  };
  fixture.stream = { getAudioTracks: () => [fixture.track], getTracks: () => [fixture.track] };
  fixture.begin = async (id: string) => 'capture:' + id;
  fixture.captureCurrent = async () => true;
  fixture.options = async () => ({ engine: 'chatgpt' });
  fixture.createThread = async () => f.created;
  fixture.caps = async () => nativeCaps();
  fixture.resume = async () => {};
  fixture.media = async () => fixture.stream;
  fixture.offer = async () => ({ sdp: 'offer' });
  fixture.local = async () => {};
  fixture.remote = async () => {};
  fixture.request = async (...a: any[]) => {
    calls.push(a);
    return {};
  };
  fixture.recordings = async () => [];
  (globalThis as any).window.__voiceTestStream = undefined;
  V.dismissVoiceError();
});
afterEach(async () => {
  await V.stopVoice();
  V.dismissVoiceError();
});

test('voice uses and releases the original native segment after a harness switch', async () => {
  await V.startVoice('chat', 'invalid-voice');
  const start = calls.find((c) => c[0] === 'thread/realtime/start');
  assert.equal(start[1].threadId, 'native-thread');
  assert.equal(start[1].voice, 'cove');
  assert.deepEqual(pins, []);
  const peer = fixture.peer;
  peer.connectionState = 'connected';
  peer.onconnectionstatechange();
  assert.equal(V.useVoice.getState().phase, 'listening');
  fixture.nativeId = 'claude:new';
  fixture.harness = 'claude';
  await V.stopVoice();
  assert.deepEqual(pins, []);
  assert.ok(calls.some((c) => c[0] === 'captureEnd' && c[1] === 'capture:chat'));
  assert.equal(peer.closed, true);
  assert.equal(fixture.stopped, 1);
  assert.equal(fixture.contextClosed, 1);
  peer.onconnectionstatechange();
  peer.ontrack({ streams: [] });
  peer.channel.onmessage({ data: '{}' });
  assert.equal(V.useVoice.getState().phase, 'idle');
});

test('unavailable accounts are rejected before microphone access or new chat creation', async () => {
  fixture.begin = async (id: string) => 'capture:' + id;
  fixture.captureCurrent = async () => true;
  fixture.options = async () => ({ engine: 'chatgpt' });
  fixture.createThread = async () => f.created;
  fixture.caps = async () => blockedCaps();
  await V.startVoice('chat');
  assert.equal(fixture.micCalls, 0);
  assert.equal(calls.length, 0);
  assert.match(V.useVoice.getState().error!, /ChatGPT account/);
  await V.startVoiceChat('chat');
  assert.equal(fixture.micCalls, 0);
  fixture.usable = false;
  await V.startVoiceChat(null);
  assert.match(V.useVoice.getState().error!, /ChatGPT account/);
});

test('a changed harness while obtaining its writer lease prevents the voice request', async () => {
  fixture.resume = async () => {
    fixture.harness = 'claude';
  };
  await V.startVoice('chat');
  assert.ok(!calls.some((c) => c[0] === 'thread/realtime/start'));
  assert.match(V.useVoice.getState().error!, /changed harness/);
  assert.equal(fixture.stopped, 1);
  V.dismissVoiceError();
  fixture.harness = 'codex';
  fixture.resume = async () => {
    fixture.nativeId = 'other-thread';
  };
  await V.startVoice('chat');
  assert.ok(!calls.some((c) => c[0] === 'thread/realtime/start'));
});

test('cancelling pending microphone permission closes a late stream and sends no start request', async () => {
  const pending = deferred();
  fixture.media = () => pending.promise;
  const starting = V.startVoice('chat');
  await flush();
  await V.stopVoice();
  pending.resolve(fixture.stream);
  await starting;
  assert.equal(fixture.stopped, 1);
  assert.ok(!calls.some((c) => c[0] === 'thread/realtime/start'));
});

test('cancellation at capability, offer, local SDP and lease awaits does not resurrect voice', async () => {
  for (const phase of ['caps', 'offer', 'local', 'resume']) {
    const pending = deferred();
    const original = fixture[phase];
    fixture[phase] = () => pending.promise;
    const starting = V.startVoice('chat');
    await flush();
    await V.stopVoice();
    pending.resolve(phase === 'caps' ? nativeCaps() : phase === 'offer' ? { sdp: 'offer' } : undefined);
    await starting;
    fixture[phase] = original;
    assert.equal(V.useVoice.getState().phase, 'idle');
    assert.ok(!calls.some((c) => c[0] === 'thread/realtime/start'));
  }
});

test('a late failure from an ended start does not tear down a replacement voice session', async () => {
  const pending = deferred();
  fixture.request = async (...a: any[]) => {
    calls.push(a);
    if (a[0] === 'thread/realtime/start') return pending.promise;
    return {};
  };
  const old = V.startVoice('chat');
  await flush();
  await V.stopVoice();
  fixture.request = async (...a: any[]) => {
    calls.push(a);
    return {};
  };
  await V.startVoice('new-chat');
  pending.reject(new Error('old connection failed'));
  await old;
  assert.equal(V.useVoice.getState().threadId, 'new-chat');
  assert.equal(V.useVoice.getState().phase, 'connecting');
});

test('cancelled start success is ignored and stop releases resources without waiting on IPC', async () => {
  const pending = deferred();
  fixture.request = async (...a: any[]) => {
    calls.push(a);
    return pending.promise;
  };
  const starting = V.startVoice('chat');
  await flush();
  const stopping = V.stopVoice();
  assert.equal(fixture.stopped, 1);
  assert.equal(V.useVoice.getState().phase, 'idle');
  pending.resolve({});
  await starting;
  await stopping;
  assert.equal(V.useVoice.getState().phase, 'idle');
});

test('permission and connection errors clean up; stale notification and SDP failures are ignored', async () => {
  fixture.media = async () => {
    throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
  };
  await V.startVoice('chat');
  assert.equal(V.useVoice.getState().error, 'Microphone access is off for MoPilot.');
  fixture.media = async () => fixture.stream;
  await V.startVoice('chat');
  const notify = fixture.notify;
  const peer = fixture.peer;
  notify('thread/realtime/sdp', { threadId: 'elsewhere', sdp: 'ignored' });
  assert.equal(peer.descriptions.length, 1);
  const remote = deferred();
  fixture.remote = () => remote.promise;
  notify('thread/realtime/sdp', { threadId: 'chat', sdp: 'answer' });
  await V.stopVoice();
  remote.reject(new Error('stale SDP'));
  await flush();
  notify('thread/realtime/error', { threadId: 'chat', message: 'stale' });
  assert.equal(V.useVoice.getState().phase, 'idle');
  fixture.remote = async () => {
    throw new Error('bad SDP');
  };
  await V.startVoice('chat');
  fixture.notify('thread/realtime/sdp', { threadId: 'chat', sdp: 'bad' });
  await flush();
  assert.equal(V.useVoice.getState().error, 'bad SDP');
  await V.startVoice('chat');
  fixture.peer.connectionState = 'failed';
  fixture.peer.onconnectionstatechange();
  assert.equal(V.useVoice.getState().error, 'Voice connection failed');
});

test('non-Error start failures produce a readable error and release the microphone', async () => {
  fixture.request = async () => {
    throw 'start refused';
  };
  await V.startVoice('chat');
  assert.equal(V.useVoice.getState().error, 'start refused');
  assert.equal(fixture.stopped, 1);
});

test('notification closure, audio and captions retain normal voice behavior', async () => {
  await V.startVoice('chat', 'maple');
  const peer = fixture.peer;
  peer.ontrack({ streams: ['audio'] });
  peer.ontrack({ streams: ['replacement'] });
  await flush();
  assert.equal(fixture.audio.srcObject, 'replacement');
  peer.connectionState = 'connecting';
  peer.onconnectionstatechange();
  fixture.notify('thread/realtime/sdp', { threadId: 'chat', sdp: 'answer' });
  await flush();
  fixture.notify('thread/realtime/transcript/delta', { threadId: 'chat', role: 'user', delta: 'Hello' });
  fixture.notify('thread/realtime/transcript/done', { threadId: 'chat', role: 'assistant', text: 'Hi' });
  assert.equal(V.useVoice.getState().caption!.text, 'Hi');
  peer.channel.onmessage({ data: 'invalid-json' });
  fixture.frame();
  V.toggleMute();
  assert.equal(fixture.track.enabled, false);
  V.toggleMute();
  assert.equal(fixture.track.enabled, true);
  fixture.notify('thread/realtime/closed', { threadId: 'chat' });
  await flush();
  assert.ok(calls.some((c) => c[0] === 'captureEnd'));
  await V.startVoice('chat');
  fixture.notify('thread/realtime/error', { threadId: 'chat', message: '{"error":{"message":"failed"}}' });
  assert.equal(V.useVoice.getState().error, 'failed');
});

test('the synthetic-stream boundary is preserved when a voice session ends', async () => {
  (globalThis as any).window.__voiceTestStream = fixture.stream;
  await V.startVoice('chat');
  assert.equal(fixture.micCalls, 0);
  await V.stopVoice();
  assert.equal(fixture.stopped, 0);
});

test('only a current native voice capability may start or create a voice chat', async () => {
  for (const kind of ['claude', 'acp:kimi']) {
    fixture.harness = kind;
    fixture.newHarness = kind;
    fixture.begin = async (id: string) => 'capture:' + id;
    fixture.captureCurrent = async () => true;
    fixture.options = async () => ({ engine: 'chatgpt' });
    fixture.createThread = async () => f.created;
    fixture.caps = async () => ({ kind, caps: { voiceChat: { state: 'absent' } } });
    await V.startVoiceChat('chat');
    assert.equal(fixture.micCalls, 0);
    assert.equal(V.useVoice.getState().threadId, 'chat');
    assert.ok(!calls.some((c) => c[0] === 'new'));
    V.dismissVoiceError();
  }
});

test('speech service timeout and missing choices never guess a provider', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  f.options = () => new Promise(() => {});
  const pending = V.currentDictationEngine();
  const rejected = assert.rejects(pending, /did not respond/);
  await flush();
  t.mock.timers.tick(10_000);
  await rejected;
  f.options = async () => ({ engine: null });
  await assert.rejects(V.currentDictationEngine(), /No dictation service is available/);
  f.options = async () => ({ engine: 'credits' });
  assert.equal(await V.currentDictationEngine(), 'credits');
});

test('late native capture and new-chat creation cannot restart a cancelled conversation', async () => {
  const capture = deferred<string>();
  f.begin = () => capture.promise;
  const starting = V.startVoice('chat');
  await flush();
  await V.stopVoice();
  capture.resolve('late-capture');
  await starting;
  assert.ok(calls.some((c) => c[0] === 'captureEnd' && c[1] === 'late-capture'));
  assert.equal(f.micCalls, 0);
  const created = deferred<string>();
  f.createThread = () => created.promise;
  const opening = V.startVoiceChat(null);
  await flush();
  await V.stopVoice();
  created.resolve('late-chat');
  await opening;
  assert.equal(f.micCalls, 0);
});

test('a changed capture or cancellation during its final check cannot dispatch native Start', async () => {
  for (const cancel of [false, true]) {
    f.captureCurrent = async () => {
      if (cancel) await V.stopVoice();
      return cancel;
    };
    await V.startVoice('chat');
    assert.equal(
      calls.some((c) => c[0] === 'thread/realtime/start'),
      false,
    );
    await V.stopVoice();
    V.dismissVoiceError();
  }
});
