// Dictate in the Chrome side panel, the panel's end (electron/chrome-extension/src/panelDictate.mjs, panelAudio.mjs, micPage.mjs and their use in sidePanel.mjs): the mic records and stops, the clip goes to MoPilot in the form its engine reads, the words go in the box; Chrome's ask on its own page; and what each failure says.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerPanelSpeechContexts } from './support/panel-speech-contexts.ts';
import { tick } from './support/extension-background/fixture.ts';
import { el, panelPage } from './support/side-panel-page.ts';

const { PanelDictate, MIC } = await import('../electron/chrome-extension/src/panelDictate.mjs');
const { recordingToWav, toBase64, SPEECH_RATE } = await import('../electron/chrome-extension/src/panelAudio.mjs');
const { startMicPage, MIC_LINES } = await import('../electron/chrome-extension/src/micPage.mjs');
const { startSidePanel } = await import('../electron/chrome-extension/src/sidePanel.mjs');

/** A page with a fake microphone, recorder and audio contexts. */
function page(o: { mic?: () => Promise<any> } = {}) {
  const stopped: string[] = [];
  const track = { stop: () => stopped.push('track') };
  const stream = { getTracks: () => [track] };
  const recorders: any[] = [];
  class FakeRecorder {
    static isTypeSupported = (m: string) => m === 'audio/webm;codecs=opus';
    ondataavailable: (e: any) => void = () => undefined;
    onstop: () => void = () => undefined;
    stream: any;
    opts: any;
    constructor(stream: any, opts: any) {
      this.stream = stream;
      this.opts = opts;
      recorders.push(this);
    }
    start() {}
    stop() {
      this.ondataavailable({ data: 'chunk' });
      this.onstop();
    }
  }
  class FakeBlob {
    parts: any[];
    opts: any;
    constructor(parts: any[], opts: any) {
      this.parts = parts;
      this.opts = opts;
    }
    async arrayBuffer() {
      return new TextEncoder().encode('webm-bytes').buffer;
    }
  }
  const closed: string[] = [];
  class FakeAudioContext {
    async decodeAudioData() {
      return { duration: 0.001 };
    }
    async close() {
      closed.push('ctx');
    }
  }
  class FakeOffline {
    frames: number;
    constructor(_channels: number, frames: number, _rate: number) {
      this.frames = frames;
    }
    destination = {};
    createBufferSource() {
      return { buffer: null, connect: () => undefined, start: () => undefined };
    }
    async startRendering() {
      return { getChannelData: () => new Float32Array(this.frames) };
    }
  }
  const events = new Map<string, () => void>();
  const g: any = {
    addEventListener: (name: string, fn: () => void) => events.set(name, fn),
    navigator: { mediaDevices: { getUserMedia: o.mic ?? (async () => stream) } },
    MediaRecorder: FakeRecorder,
    Blob: FakeBlob,
    AudioContext: FakeAudioContext,
    OfflineAudioContext: FakeOffline,
  };
  return { g, events, stopped, recorders, closed, FakeBlob };
}

function dictate(o: { engine?: string; answer?: any; mic?: () => Promise<any>; engineFails?: boolean; tabFails?: boolean } = {}) {
  const els: Record<string, any> = {};
  const document = { getElementById: (id: string) => (els[id] ??= el()) };
  const p = page({ mic: o.mic });
  const sent: any[] = [];
  const tabs: any[] = [];
  const texts: string[] = [];
  const errors: string[] = [];
  const chrome = {
    runtime: { getURL: (f: string) => `chrome-extension://ext/${f}` },
    tabs: {
      create: async (t: any) => {
        if (o.tabFails) throw new Error('no window');
        tabs.push(t);
      },
    },
  };
  const d = new PanelDictate({
    document,
    chrome,
    g: p.g,
    request: async (method: string, params: any) => {
      sent.push([method, params]);
      if (method === 'dictationEngine') {
        if (o.engineFails) throw new Error("MoPilot isn't connected.");
        return { engine: o.engine ?? 'chatgpt', capture: 'capture', ...('wav' in o ? { wav: o.wav } : {}) };
      }
      if (o.answer instanceof Error) throw o.answer;
      return 'answer' in o ? o.answer : { text: 'hello there' };
    },
    onText: (t: string) => texts.push(t),
    onError: (t: string) => errors.push(t),
  });
  return { d, els, p, sent, tabs, texts, errors };
}

test('the mic records; a second click stops; ChatGPT’s engine reads the recorder’s webm; the words go to the box', async () => {
  const t = dictate();
  assert.equal(t.els.mic.attrs['aria-label'], MIC.idle.label);
  t.els.mic.listeners.click();
  await tick();
  await tick();
  assert.equal(t.d.state, 'recording');
  assert.equal(t.els.mic.attrs['aria-pressed'], 'true');
  assert.equal(t.els.mic.className, 'icon mic recording');
  assert.equal(t.p.recorders[0].opts.mimeType, 'audio/webm;codecs=opus');
  t.els.mic.listeners.click();
  assert.equal(t.d.state, 'transcribing');
  assert.equal(t.els.mic.disabled, true);
  // a click while it transcribes does nothing
  await t.d.toggle();
  await tick();
  await tick();
  assert.deepEqual(t.p.stopped, ['track']);
  assert.deepEqual(
    t.sent.find((s) => s[0] === 'transcribe'),
    [
      'transcribe',
      { capture: 'capture', clientId: t.d.clientId, audio: toBase64(new TextEncoder().encode('webm-bytes')), mime: 'audio/webm' },
    ],
  );
  assert.deepEqual(t.texts, ['hello there']);
  assert.equal(t.d.state, 'idle');
  assert.equal(t.els.mic.disabled, false);
});

test('this Mac’s engine reads 16 kHz WAV; the recorder’s own clip goes beside it to be kept', async () => {
  const t = dictate({ engine: 'local', answer: { text: 'hi', saveError: 'Could not save recording: ENOSPC' } });
  await t.d.toggle();
  t.d.rec.stop();
  await tick();
  await tick();
  await tick();
  const [, params] = t.sent.find((s) => s[0] === 'transcribe');
  assert.equal(params.mime, 'audio/wav');
  assert.equal(params.clip, toBase64(new TextEncoder().encode('webm-bytes')));
  const wav = Buffer.from(params.audio, 'base64');
  assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
  assert.equal(wav.readUInt32LE(24), SPEECH_RATE);
  assert.deepEqual(t.p.closed, ['ctx']);
  assert.deepEqual(t.texts, ['hi']);
  assert.deepEqual(t.errors, ['Could not save recording: ENOSPC']);
});

test('MoPilot says when a service it may try reads WAV: the panel sends it beside the recording, whatever comes first', async () => {
  const send = async (o: any) => {
    const t = dictate(o);
    await t.d.toggle();
    t.d.rec.stop();
    for (let i = 0; i < 3; i++) await tick();
    return t.sent.find((s) => s[0] === 'transcribe')[1];
  };
  // a Claude account later in the chain reads WAV though ChatGPT's comes first
  const both = await send({ engine: 'chatgpt', wav: true });
  assert.equal(both.mime, 'audio/wav');
  assert.equal(both.clip, toBase64(new TextEncoder().encode('webm-bytes')));
  // no service in the chain reads it: the recording alone
  const webm = await send({ engine: 'local', wav: false });
  assert.equal(webm.mime, 'audio/webm');
  assert.equal(webm.clip, undefined);
});

test('the microphone refused: the extension’s page opens to ask; none found, or another failure, says so', async () => {
  const denied = Object.assign(new Error('Permission dismissed'), { name: 'NotAllowedError' });
  const t = dictate({ mic: async () => Promise.reject(denied) });
  await t.d.toggle();
  assert.deepEqual(t.tabs, [{ url: 'chrome-extension://ext/mic.html' }]);
  assert.deepEqual(t.errors, ['Allow the microphone in the tab that opened, then dictate again.']);
  assert.equal(t.d.state, 'idle');
  // a tab that can't open: the line still says what to do
  const noTab = dictate({ mic: async () => Promise.reject(denied), tabFails: true });
  await noTab.d.toggle();
  assert.deepEqual(noTab.errors, ['Allow the microphone in the tab that opened, then dictate again.']);
  const none = dictate({ mic: async () => Promise.reject(Object.assign(new Error('x'), { name: 'NotFoundError' })) });
  await none.d.toggle();
  assert.deepEqual(none.errors, ['No microphone found.']);
  const busy = dictate({
    mic: async () => Promise.reject(Object.assign(new Error('Could not start audio source'), { name: 'NotReadableError' })),
  });
  await busy.d.toggle();
  assert.deepEqual(busy.errors, ['Could not start audio source']);
  const odd = dictate({ mic: async () => Promise.reject('gone') });
  await odd.d.toggle();
  assert.deepEqual(odd.errors, ['gone']);
});

test('MoPilot not answering, the engine refusing, or a failure with nothing to say: the error line, and the mic ready again', async () => {
  const off = dictate({ engineFails: true });
  await off.d.toggle();
  assert.deepEqual(off.errors, ["MoPilot isn't connected."]);
  assert.equal(off.p.recorders.length, 0);
  const refused = dictate({ answer: new Error('Sign in with ChatGPT to use dictation') });
  await refused.d.toggle();
  refused.d.rec.stop();
  await tick();
  await tick();
  assert.deepEqual(refused.errors, ['Sign in with ChatGPT to use dictation']);
  assert.equal(refused.d.state, 'idle');
  const blank = dictate({ answer: new Error('') });
  await blank.d.toggle();
  blank.d.rec.stop();
  await tick();
  await tick();
  assert.deepEqual(blank.errors, ["Couldn't transcribe the recording"]);
  // nothing said: no text, no error
  const quiet = dictate({ answer: null });
  await quiet.d.toggle();
  quiet.d.rec.stop();
  await tick();
  await tick();
  assert.deepEqual([quiet.texts, quiet.errors], [[], []]);
});

test('the WAV helpers: a context that won’t close leaves the WAV; a long clip goes to base64 a chunk at a time', async () => {
  const p = page();
  p.g.AudioContext = class {
    async decodeAudioData() {
      return { duration: 0 };
    }
    close() {
      return Promise.reject(new Error('closed already'));
    }
  };
  const wav = await recordingToWav(new p.FakeBlob([], {}) as any, p.g);
  // at least one frame, even for an empty clip
  assert.equal(wav.length, 44 + 2);
  await tick();
  const big = new Uint8Array(0x8000 * 2 + 5).fill(65);
  assert.equal(toBase64(big), Buffer.from(big).toString('base64'));
});

test('the microphone page: asks at once and on the button, says what Chrome answered', async () => {
  const run = async (mic: () => Promise<any>) => {
    const els: Record<string, any> = {};
    const g = { document: { getElementById: (id: string) => (els[id] ??= el()) }, navigator: { mediaDevices: { getUserMedia: mic } } };
    await startMicPage(g);
    return els;
  };
  const stops: string[] = [];
  const allowed = await run(async () => ({ getTracks: () => [{ stop: () => stops.push('t') }] }));
  assert.equal(allowed.line.textContent, MIC_LINES.allowed);
  assert.equal(allowed.allow.hidden, true);
  assert.deepEqual(stops, ['t']);
  const blocked = await run(async () => Promise.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' })));
  assert.equal(blocked.line.textContent, MIC_LINES.blocked);
  const missing = await run(async () => Promise.reject(Object.assign(new Error('x'), { name: 'NotFoundError' })));
  assert.equal(missing.line.textContent, MIC_LINES.missing);
  const other = await run(async () => Promise.reject(new Error('Device in use')));
  assert.equal(other.line.textContent, 'Device in use');
  const thrown = await run(async () => Promise.reject('gone'));
  assert.equal(thrown.line.textContent, 'gone');
  // the button asks again
  thrown.allow.listeners.click();
  await tick();
  assert.equal(thrown.line.textContent, 'gone');
});

test('the page: dictated words are added after what is typed, as the app’s Dictate adds them', async () => {
  const p = panelPage({
    reply: (m: any) => {
      if (m.type !== 'panel') return { status: 'connected' };
      if (m.method === 'harnesses') return { status: 'connected', result: { harnesses: [{ id: 'claude', label: 'Claude Code' }] } };
      if (m.method === 'dictationEngine') return { status: 'connected', result: { engine: 'chatgpt', capture: 'capture' } };
      if (m.method === 'transcribe') return { status: 'connected', result: { text: 'find me a ryokan' } };
      return { status: 'connected', result: {} };
    },
  });
  Object.assign(p.g, page().g);
  await startSidePanel(p.g).ready;
  await tick();
  p.els.text.value = 'Please';
  p.els.mic.listeners.click();
  await tick();
  await tick();
  await tick();
  p.els.mic.listeners.click();
  for (let i = 0; i < 6; i++) await tick();
  assert.equal(p.els.text.value, 'Please find me a ryokan');
  assert.equal(p.els.send.disabled, false);
  // an empty box takes the words alone
  p.els.text.value = '';
  p.els.mic.listeners.click();
  for (let i = 0; i < 3; i++) await tick();
  p.els.mic.listeners.click();
  for (let i = 0; i < 6; i++) await tick();
  assert.equal(p.els.text.value, 'find me a ryokan');
});

test('a recorder without opus records plain webm', async () => {
  const t = dictate();
  t.p.g.MediaRecorder.isTypeSupported = () => false;
  await t.d.toggle();
  assert.equal(t.p.recorders[0].opts.mimeType, 'audio/webm');
});

test('the microphone page entry starts the page in its window', async () => {
  const els: Record<string, any> = {};
  const g = globalThis as any;
  const saved = { document: g.document, navigator: Object.getOwnPropertyDescriptor(g, 'navigator') };
  Object.defineProperty(g, 'navigator', {
    value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } },
    configurable: true,
  });
  g.document = { getElementById: (id: string) => (els[id] ??= el()) };
  try {
    await import('../electron/chrome-extension/mic.mjs');
    await tick();
    assert.equal(els.line.textContent, MIC_LINES.allowed);
  } finally {
    g.document = saved.document;
    if (saved.navigator) Object.defineProperty(g, 'navigator', saved.navigator);
  }
});

test('a second click while the mic starts does nothing: one recorder, one stream', async () => {
  let release: (s: any) => void = () => undefined;
  const stream = { getTracks: () => [] };
  const t = dictate({ mic: () => new Promise((r) => (release = r)) });
  const first = t.d.toggle();
  await tick();
  assert.equal(t.d.state, 'starting');
  assert.equal(t.els.mic.disabled, true);
  t.els.mic.listeners.click();
  release(stream);
  await first;
  await tick();
  assert.equal(t.p.recorders.length, 1);
  assert.equal(t.d.state, 'recording');
  // a failure while starting leaves the mic ready
  const off = dictate({ engineFails: true });
  await off.d.toggle();
  assert.equal(off.d.state, 'idle');
  assert.equal(off.els.mic.disabled, false);
});

test('dictation that completes while an initial send waits is a new draft and survives its refusal', async () => {
  let refuse: any;
  const p = panelPage({
    reply: (m: any) => {
      if (m.method === 'harnesses') return { status: 'connected', result: { harnesses: [{ id: 'claude', label: 'Claude Code' }] } };
      if (m.method === 'start')
        return new Promise((resolve) => {
          refuse = resolve;
        });
      if (m.method === 'dictationEngine') return { status: 'connected', result: { engine: 'chatgpt', capture: 'capture' } };
      if (m.method === 'transcribe') return { status: 'connected', result: { text: 'New dictated words' } };
      return { status: 'connected', result: {} };
    },
  });
  Object.assign(p.g, page().g);
  await startSidePanel(p.g).ready;
  await tick();
  p.els.text.value = 'Submitted text';
  p.els.text.listeners.input();
  p.els.composer.listeners.submit({ preventDefault() {} });
  await tick();
  p.els.mic.listeners.click();
  for (let i = 0; i < 3; i++) await tick();
  p.els.mic.listeners.click();
  for (let i = 0; i < 6; i++) await tick();
  assert.equal(p.els.text.value, 'Submitted text New dictated words');
  refuse({ status: 'connected', error: 'Native send refused' });
  await tick();
  await tick();
  assert.equal(p.els.text.value, 'Submitted text New dictated words');
});

test('a same-target New composer retires dictation still awaiting its transcript', async () => {
  let complete!: (value: any) => void;
  const p = panelPage({
    reply: (m: any) => {
      if (m.method === 'harnesses') return { status: 'connected', result: { harnesses: [{ id: 'claude', label: 'Claude Code' }] } };
      if (m.method === 'dictationEngine') return { status: 'connected', result: { engine: 'chatgpt', capture: 'capture' } };
      if (m.method === 'transcribe')
        return new Promise((resolve) => {
          complete = resolve;
        });
      return { status: 'connected', result: {} };
    },
  });
  Object.assign(p.g, page().g);
  await startSidePanel(p.g).ready;
  await tick();
  p.els.mic.listeners.click();
  for (let i = 0; i < 3; i++) await tick();
  p.els.mic.listeners.click();
  await tick();
  assert.equal(typeof complete, 'function');
  p.els.new.listeners.click();
  p.els.text.value = 'Replacement draft';
  p.els.text.listeners.input();
  complete({ status: 'connected', result: { text: 'Earlier recording' } });
  for (let i = 0; i < 6; i++) await tick();
  assert.equal(p.els.text.value, 'Replacement draft');
});

test('panel disposal retires pending microphone success and failure, and stops an already recording stream', async () => {
  for (const failure of [false, true]) {
    let resolve!: (s: any) => void, reject!: (e: any) => void;
    const t = dictate({
      mic: () =>
        new Promise((yes, no) => {
          resolve = yes;
          reject = no;
        }),
    });
    const pending = t.d.toggle();
    await tick();
    t.p.events.get('pagehide')!();
    if (failure) reject(new Error('late denial'));
    else resolve({ getTracks: () => [{ stop: () => t.p.stopped.push('late') }] });
    await pending;
    assert.equal(t.p.recorders.length, 0);
    assert.deepEqual(t.errors, []);
    assert.ok(t.sent.some(([method]) => method === 'dictationEnd'));
  }
  const t = dictate();
  await t.d.toggle();
  t.p.events.get('pagehide')!();
  await tick();
  assert.equal(t.p.recorders[0].onstop, null);
  assert.deepEqual(t.p.stopped, ['track']);
});

test('recorder construction and startup failure release tracks and main ownership; stale clips cannot transcribe', async () => {
  for (const stage of ['constructor', 'start']) {
    const t = dictate();
    t.p.g.MediaRecorder = class {
      static isTypeSupported = () => true;
      constructor() {
        if (stage === 'constructor') throw new Error('recorder unavailable');
      }
      start() {
        throw new Error('recorder unavailable');
      }
    };
    await t.d.toggle();
    await tick();
    assert.deepEqual(t.p.stopped, ['track']);
    assert.equal(t.d.state, 'idle');
    assert.match(t.errors[0], /recorder unavailable/);
    assert.ok(t.sent.some(([method]) => method === 'dictationEnd'));
  }
  const t = dictate();
  await t.d.finish({ getTracks: () => [] }, new t.p.FakeBlob([], {}) as unknown as Blob, false, -1);
  assert.match(t.errors[0], /earlier composer/);
  assert.equal(t.sent.filter(([method]) => method === 'transcribe').length, 0);
  const missing = dictate();
  missing.d.o.request = async () => ({ engine: 'chatgpt' });
  await missing.d.toggle();
  assert.match(missing.errors[0], /owner changed/);
});

test('a direct recording finish resolves its current target when no owner snapshot was supplied', async () => {
  const t = dictate();
  t.d.o.target = () => ({ chatId: 'chat' });
  await t.d.finish({ getTracks: () => [] }, new t.p.FakeBlob([], {}) as unknown as Blob, false);
  assert.deepEqual(t.texts, ['hello there']);
});

registerPanelSpeechContexts(page, startSidePanel);
