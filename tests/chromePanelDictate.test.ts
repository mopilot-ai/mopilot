// Dictate in the Chrome side panel, main's end (electron/app/chromePanelDictate.cjs and its requests in capabilities/browser/chromePanel.cjs): the chat's chain settled as the window settles it, a clip tried on each service in the language picked and kept with the window's recordings, and what is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { deferred } from './support/async-scenarios.ts';

const require = createRequire(import.meta.url);
const { createPanelDictation } = require('../electron/app/chromePanelDictate.cjs');
const { ChromePanel } = require('../electron/capabilities/browser/chromePanel.cjs');
const { encodeWav: appWav } = await import('../src/lib/dictation.ts');
const { encodeWav: panelWav } = await import('../electron/chrome-extension/src/panelAudio.mjs');

/** main's options as speech.cjs answers: a chain, its first the engine */
const chained = (chain: string[]): { engine: string | null; chain: string[]; choices: unknown[] } => ({
  engine: chain[0] ?? null,
  chain,
  choices: [],
});

function world(
  o: {
    prefs?: any;
    list?: () => any[];
    answer?: any;
    answers?: Record<string, any>;
    save?: () => void;
    platform?: string;
    engine?: string | null;
    chain?: string[];
  } = {},
) {
  const calls: any[] = [];
  const asked: any[] = [];
  const first = 'engine' in o ? o.engine : (o.prefs?.dictationEngine ?? 'local');
  const live = {
    speech: {
      options: async (...args: any[]) => (asked.push(args), chained(o.chain ?? (first ? [first] : []))),
      owner: () => JSON.stringify(o.prefs),
      begin: () => 'capture',
      end: async () => {},
      current: () => true,
    },
    recordings: {
      list: o.list ?? (() => []),
      save: (clip: Buffer, text: string) => {
        calls.push(['save', clip.toString(), text]);
        o.save?.();
      },
    },
    dictation: {
      transcribe: async (p: any) =>
        (
          // every request can be stopped (its signal, checked by the test that stops one)
          assert.ok(p.signal instanceof AbortSignal),
          calls.push([
            'transcribe',
            { ...Object.fromEntries(Object.entries(p).filter(([k]) => k !== 'current' && k !== 'signal')), bytes: p.bytes.toString() },
          ]),
          o.answers && p.engine in o.answers ? o.answers[p.engine] : 'answer' in o ? o.answer : { text: ' hello there ' }
        ),
    },
    patchPrefs: (set: any) => calls.push(['patchPrefs', set]),
  };
  const d = createPanelDictation({ live, prefs: () => o.prefs ?? {}, platform: o.platform ?? 'darwin' });
  return {
    raw: d,
    live,
    d: {
      ...d,
      transcribe: async (p: any) => {
        const held = await d.begin('00000000-0000-0000-0000-000000000000', {});
        return d.transcribe({ ...p, ...held, clientId: '00000000-0000-0000-0000-000000000000' });
      },
    },
    calls,
    asked,
  };
}

test('every surface reads the main speech choice; an unavailable engine has no implicit cloud fallback', async () => {
  assert.equal(await world({ prefs: { dictationEngine: 'credits' } }).d.engine(), 'credits');
  const fresh = world();
  assert.equal(await fresh.d.engine(), 'local');
  assert.deepEqual(fresh.calls, []);
  await assert.rejects(world({ engine: null }).d.engine(), /No dictation service is available/);
});

test('a clip transcribed in the language picked (this Mac’s takes "auto", the others none), kept with its text', async () => {
  const local = world({ prefs: { dictationEngine: 'local', dictationLanguage: 'auto' } });
  assert.deepEqual(await local.d.transcribe({ audio: Buffer.from('wav'), mime: 'audio/wav', clip: Buffer.from('webm') }), {
    text: 'hello there',
  });
  assert.deepEqual(local.calls, [
    ['transcribe', { engine: 'local', bytes: 'wav', mime: 'audio/wav', language: 'auto', chatId: null }],
    ['save', 'webm', 'hello there'],
  ]);
  const gpt = world({ prefs: { dictationEngine: 'chatgpt', dictationLanguage: 'auto' } });
  await gpt.d.transcribe({ audio: Buffer.from('webm'), mime: 'audio/webm', clip: Buffer.from('webm') });
  assert.equal(gpt.calls[0][1].language, undefined);
  const ja = world({ prefs: { dictationEngine: 'credits', dictationLanguage: 'ja' } });
  await ja.d.transcribe({ audio: Buffer.from('webm'), mime: 'audio/webm', clip: Buffer.from('webm') });
  assert.equal(ja.calls[0][1].language, 'ja');
});

test('a service pinned, switched off or unresponsive while recording sends the clip nowhere', async (t) => {
  const client = '00000000-0000-0000-0000-000000000000';
  const clip = { audio: Buffer.from('webm'), mime: 'audio/webm', clip: Buffer.from('webm'), clientId: client };
  const f = world({ prefs: { dictationEngine: 'chatgpt' } });
  let held = await f.raw.begin(client, {});
  // the ChatGPT account turned off while recording: the chain read again, the clip goes only where it still may
  f.live.speech.options = async () => chained(['credits']);
  assert.deepEqual(await f.raw.transcribe({ ...clip, ...held }), { text: 'hello there' });
  assert.deepEqual(
    f.calls.map((c) => c[1]?.engine ?? c[0]),
    ['credits', 'save'],
  );
  f.calls.length = 0;
  held = await f.raw.begin(client, {});
  f.live.speech.options = async () => ({ engine: null, chain: [], choices: [] });
  await assert.rejects(f.raw.transcribe({ ...clip, ...held }), /No dictation service is available/);
  assert.deepEqual(f.calls, []);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  f.live.speech.options = async () => chained(['local']);
  held = await f.raw.begin(client, {});
  f.live.speech.options = () => new Promise(() => {});
  const late = assert.rejects(f.raw.transcribe({ ...clip, ...held }), /did not respond/);
  await new Promise(setImmediate);
  t.mock.timers.tick(10_000);
  await late;
  assert.deepEqual(f.calls, []);
});

test('a clip a phone sent whole gets a lease of its own on this Mac’s chain, is kept unless it asks not to be, and the lease ends with it', async () => {
  const f = world({ prefs: { dictationEngine: 'local', dictationLanguage: 'auto' } });
  const ended: any[] = [];
  f.live.speech.end = async (...args: any[]) => void ended.push(args);
  assert.deepEqual(await f.raw.transcribeClip({ audio: Buffer.from('wav'), mime: 'audio/wav' }), { text: 'hello there' });
  assert.deepEqual(f.calls, [
    ['transcribe', { engine: 'local', bytes: 'wav', mime: 'audio/wav', language: 'auto', chatId: null }],
    ['save', 'wav', 'hello there'],
  ]);
  assert.equal(ended.length, 1);
  // a voice note for MoMo is not kept with the recordings: its text comes back and nothing is saved
  f.calls.length = 0;
  assert.deepEqual(await f.raw.transcribeClip({ audio: Buffer.from('wav'), mime: 'audio/wav', keep: false }), { text: 'hello there' });
  assert.deepEqual(
    f.calls.map((c) => c[0]),
    ['transcribe'],
  );
  assert.equal(ended.length, 2);
  // nothing heard keeps nothing; a failure leaves no lease behind
  const silent = world({ prefs: { dictationEngine: 'local' }, answer: {} });
  assert.deepEqual(await silent.raw.transcribeClip({ audio: Buffer.from('wav'), mime: 'audio/wav', keep: false }), { text: '' });
  const failing = world({ prefs: { dictationEngine: 'local' }, answer: { error: 'offline' } });
  const left: any[] = [];
  failing.live.speech.end = async (...args: any[]) => void left.push(args);
  await assert.rejects(failing.raw.transcribeClip({ audio: Buffer.from('wav'), mime: 'audio/wav', keep: false }), /offline/);
  assert.equal(left.length, 1);
});

test('the engine’s refusal is the error; nothing said keeps nothing; a clip that can’t be kept still gives its text', async () => {
  const signedOut = world({ prefs: { dictationEngine: 'chatgpt' }, answer: { error: 'Sign in with ChatGPT to use dictation' } });
  await assert.rejects(
    signedOut.d.transcribe({ audio: Buffer.from('x'), mime: 'audio/webm', clip: Buffer.from('x') }),
    /Sign in with ChatGPT to use dictation/,
  );
  const silent = world({ prefs: { dictationEngine: 'chatgpt' }, answer: {} });
  assert.deepEqual(await silent.d.transcribe({ audio: Buffer.from('x'), mime: 'audio/webm', clip: Buffer.from('x') }), { text: '' });
  assert.equal(silent.calls.length, 1);
  const full = world({
    prefs: { dictationEngine: 'chatgpt' },
    save: () => {
      throw new Error('ENOSPC');
    },
  });
  assert.deepEqual(await full.d.transcribe({ audio: Buffer.from('x'), mime: 'audio/webm', clip: Buffer.from('x') }), {
    text: 'hello there',
    saveError: 'Could not save recording: The disk is full.',
  });
  const odd = world({
    prefs: { dictationEngine: 'chatgpt' },
    save: () => {
      throw 'disk';
    },
  });
  assert.equal(
    (await odd.d.transcribe({ audio: Buffer.from('x'), mime: 'audio/webm', clip: Buffer.from('x') })).saveError,
    'Could not save recording: Disk.',
  );
  const nothing = world({ prefs: { dictationEngine: 'chatgpt' }, answer: null });
  assert.deepEqual(await nothing.d.transcribe({ audio: Buffer.from('x'), mime: 'audio/webm', clip: Buffer.from('x') }), { text: '' });
});

test('the requests: the engine, and a clip in a form an engine reads, the recording kept beside a WAV', async () => {
  const calls: any[] = [];
  const panel = new ChromePanel({
    dictation: {
      engine: () => 'local',
      transcribe: async (p: any) => (calls.push({ audio: p.audio.toString(), mime: p.mime, clip: p.clip.toString() }), { text: 'hi' }),
    },
  });
  const ask = async (method: string, params: any) => {
    let out: any;
    await panel.handle({ id: 1, method, params }, (m: any) => (out = m));
    return out.error ?? out.result;
  };
  const b64 = (s: string) => Buffer.from(s).toString('base64');
  assert.match(await ask('dictationEngine', {}), /Update the MoPilot extension/);
  assert.deepEqual(await ask('transcribe', { audio: b64('wav'), mime: 'audio/wav', clip: b64('webm') }), { text: 'hi' });
  assert.deepEqual(await ask('transcribe', { audio: b64('webm'), mime: 'audio/webm' }), { text: 'hi' });
  assert.deepEqual(calls, [
    { audio: 'wav', mime: 'audio/wav', clip: 'webm' },
    { audio: 'webm', mime: 'audio/webm', clip: 'webm' },
  ]);
  for (const bad of [
    { audio: b64('x'), mime: 'audio/mp3' },
    { audio: b64('x') },
    { audio: '', mime: 'audio/webm' },
    { audio: 'not base64!', mime: 'audio/webm' },
    { audio: 7, mime: 'audio/webm' },
    { audio: b64('x'), mime: 'audio/wav', clip: '%%%' },
  ])
    assert.equal(await ask('transcribe', bad), "That recording couldn't be read.");
  assert.equal(
    await ask('transcribe', { audio: 'A'.repeat(36 * 1024 * 1024), mime: 'audio/webm' }),
    'That recording is too long. Dictate in shorter parts.',
  );
  assert.equal(calls.length, 2);
});

test('the panel’s WAV is the app’s, byte for byte', () => {
  const samples = new Float32Array([0, 0.5, -0.5, 1.5, -1.5, 0.25]);
  assert.deepEqual(panelWav(samples, 16000), appWav(samples, 16000));
});

test('cancelled or timed-out Chrome readiness cannot reserve a late capture or retire a replacement generation', async () => {
  const f = world();
  const begin: any[] = [];
  f.live.speech.begin = (...args: any[]) => {
    begin.push(args);
    return 'capture';
  };
  const pending = deferred<any>();
  f.live.speech.options = () => pending.promise;
  const client = '00000000-0000-0000-0000-000000000000';
  const starting = f.raw.begin(client, { harness: 'claude' }, 1);
  await assert.rejects(f.raw.begin(client, {}, 1), /already preparing/);
  await f.raw.end(null, client, 1);
  pending.resolve(chained(['chatgpt']));
  await assert.rejects(starting, /cancelled/);
  assert.equal(begin.length, 0);
  const late = deferred<any>();
  f.live.speech.options = () => late.promise;
  const bounded = createPanelDictation({ live: f.live, prefs: () => ({}), readinessMs: 5 });
  await assert.rejects(bounded.begin(client, {}, 2), /did not respond/);
  late.resolve(chained(['chatgpt']));
  await new Promise(setImmediate);
  assert.equal(begin.length, 0);
  f.live.speech.options = async () => chained(['chatgpt']);
  await bounded.end(null, client, 2);
  const current = await bounded.begin(client, { chatId: 'chat' }, 3);
  assert.equal(begin.length, 1);
  await bounded.end(current.capture, 'wrong-client', 3);
  await bounded.end(current.capture, client, 3);
  await bounded.end('missing', client, 3);
  await assert.rejects(bounded.begin('invalid', {}, 1), /Reopen/);
  await assert.rejects(bounded.begin(client, {}, -1), /Reopen/);
  await assert.rejects(bounded.transcribe({ audio: Buffer.from('x'), mime: 'audio/webm', clip: Buffer.from('x') }), /active speech owner/);
});

test('the current extension owns Begin/End and checked transcription; an ended capture cannot be transcribed', async () => {
  const calls: any[] = [];
  const panel = new ChromePanel({
    dictation: {
      begin: async (...args: any[]) => (calls.push(['begin', ...args]), { capture: 'held', engine: 'chatgpt' }),
      end: async (...args: any[]) => {
        calls.push(['end', ...args]);
      },
      transcribe: async (p: any) => (calls.push(['transcribe', p.capture, p.clientId]), { text: 'draft' }),
    },
  });
  const ask = async (method: string, params: any) => {
    let out: any;
    await panel.handle({ id: 1, method, params }, (r: any) => (out = r));
    return out;
  };
  assert.equal((await ask('dictationEngine', { capture: true, clientId: 'client', generation: 1, chatId: 'chat' })).result.capture, 'held');
  await ask('transcribe', { capture: 'held', clientId: 'client', audio: 'eA==', mime: 'audio/webm' });
  assert.deepEqual(calls.at(-1), ['transcribe', 'held', 'client']);
  assert.deepEqual((await ask('dictationEnd', { capture: 'held', clientId: 'client', generation: 1 })).result, { released: true });
  delete panel.o.dictation.end;
  assert.deepEqual((await ask('dictationEnd', {})).result, { released: true });
  const f = world();
  const client = '00000000-0000-0000-0000-000000000000';
  const held = await f.raw.begin(client, {}, 1);
  f.live.speech.current = () => false;
  await assert.rejects(
    f.raw.transcribe({ ...held, clientId: client, audio: Buffer.from('x'), clip: Buffer.from('x'), mime: 'audio/webm' }),
    /was cancelled/,
  );
});

const CLIENT = '00000000-0000-0000-0000-000000000000';
const forms = { audio: Buffer.from('wav'), mime: 'audio/wav', clip: Buffer.from('webm') };

test('the panel’s chat’s own chain: each service in turn, sent the form it reads, until one answers', async () => {
  const f = world({
    chain: ['local', 'chatgpt', 'credits'],
    prefs: { dictationLanguage: 'auto' },
    answers: { chatgpt: { error: 'Sign in again' }, local: { error: 'On-device recognition is unavailable for this language' } },
  });
  const held = await f.raw.begin(CLIENT, { chatId: 'chat', harness: 'claude' });
  // the chain is the chat's own (its harness's account first), and WAV is asked for since some service reads it
  assert.deepEqual(held, { engine: 'local', chain: ['local', 'chatgpt', 'credits'], wav: true, capture: 'capture' });
  assert.deepEqual(f.asked[0], ['chat', { kind: 'claude' }]);
  assert.deepEqual(await f.raw.transcribe({ ...forms, ...held, clientId: CLIENT }), { text: 'hello there' });
  assert.deepEqual(f.asked.at(-1), ['chat', { kind: 'claude' }], 'the chain is read again for the same chat');
  assert.deepEqual(f.calls, [
    ['transcribe', { engine: 'local', bytes: 'wav', mime: 'audio/wav', language: 'auto', chatId: 'chat' }],
    ['transcribe', { engine: 'chatgpt', bytes: 'webm', mime: 'audio/webm', language: undefined, chatId: 'chat' }],
    ['transcribe', { engine: 'credits', bytes: 'webm', mime: 'audio/webm', language: undefined, chatId: 'chat' }],
    ['save', 'webm', 'hello there'],
  ]);
  // no service in the chain reads WAV: the panel need not make it
  assert.equal((await world({ chain: ['chatgpt', 'credits'] }).raw.begin(CLIENT, {})).wav, false);
});

test('every service failing says each one’s reason; an answer no other service would change ends the chain', async () => {
  const all = world({
    chain: ['chatgpt', 'credits'],
    answers: { chatgpt: { error: 'Rate limited' }, credits: { error: 'Out of credits' } },
  });
  await assert.rejects(all.d.transcribe(forms), /^Error: ChatGPT account: Rate limited · MoPilot credits: Out of credits$/);
  // macOS asking for on-device recognition ends the clip too: it is not sent elsewhere while the user decides (#2286)
  for (const error of ['Recording is too short', 'Dictation is turned off in this app', 'Allow Speech Recognition, then dictate again']) {
    const f = world({ chain: ['chatgpt', 'credits'], answers: { chatgpt: { error } } });
    await assert.rejects(f.d.transcribe(forms), new RegExp(error));
    assert.equal(f.calls.length, 1, 'the next service is not asked');
  }
});

test('a panel that sends one form: a service that reads the other is passed over, saying to update the extension', async () => {
  const webmOnly = { audio: Buffer.from('webm'), mime: 'audio/webm', clip: Buffer.from('webm') };
  const f = world({ chain: ['local', 'chatgpt'] });
  assert.deepEqual(await f.d.transcribe(webmOnly), { text: 'hello there' });
  assert.deepEqual(
    f.calls.map((c) => c[1]?.engine ?? c[0]),
    ['chatgpt', 'save'],
  );
  await assert.rejects(world({ chain: ['local'] }).d.transcribe(webmOnly), /^Error: Update the MoPilot extension/);
  // WAV with no recording of its own beside it: nothing for a service that reads the recorder's webm
  const wav = Buffer.from('wav');
  await assert.rejects(world({ chain: ['credits'] }).d.transcribe({ audio: wav, mime: 'audio/wav', clip: wav }), /Update the MoPilot/);
});

test('a service that never answers is left after its share of the wait, and stopped; the chain stops at its limit', async () => {
  const live = world({ chain: ['chatgpt', 'credits'] }).live;
  const silent = { ...live.dictation };
  const signals: Record<string, AbortSignal> = {};
  live.dictation.transcribe = (p: any) => {
    signals[p.engine] = p.signal;
    return p.engine === 'chatgpt' ? new Promise(() => {}) : silent.transcribe(p);
  };
  const d = createPanelDictation({ live, prefs: () => ({}), nextMs: 5 });
  const held = await d.begin(CLIENT, {});
  assert.deepEqual(await d.transcribe({ ...forms, ...held, clientId: CLIENT }), { text: 'hello there' });
  // the service left is stopped, so it uploads (and bills) nothing more; the one that answered is not
  assert.deepEqual([signals.chatgpt.aborted, signals.credits.aborted], [true, false]);
  // the last service gets what is left of the chain's limit
  live.dictation.transcribe = () => new Promise(() => {});
  live.speech.options = async () => chained(['chatgpt']);
  const last = createPanelDictation({ live, prefs: () => ({}), chainMs: 5, minMs: 0 });
  const one = await last.begin(CLIENT, {});
  await assert.rejects(last.transcribe({ ...forms, ...one, clientId: CLIENT }), /^Error: The dictation service took too long$/);
  // a chain with no time left asks nobody
  const spent = createPanelDictation({ live, prefs: () => ({}), chainMs: 0, minMs: 0 });
  const none = await spent.begin(CLIENT, {});
  await assert.rejects(spent.transcribe({ ...forms, ...none, clientId: CLIENT }), /^Error: The dictation service took too long$/);
});

test('the limit counts from the clip’s arrival, reading the chain again included; services it leaves too little time are named', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const flush = () => new Promise(setImmediate);
  const f = world({ chain: ['chatgpt', 'credits'] });
  f.live.dictation.transcribe = (p: any) => (f.calls.push(p.engine), new Promise(() => {}));
  const d = createPanelDictation({ live: f.live, prefs: () => ({}), readinessMs: 100_000, chainMs: 60_000, minMs: 20_000 });
  const held = await d.begin(CLIENT, {});
  // ChatGPT gets its 45 s; the 15 s then left is too little for credits, which is never sent the clip
  const slow = assert.rejects(
    d.transcribe({ ...forms, ...held, clientId: CLIENT }),
    /^Error: ChatGPT account: The dictation service took too long · MoPilot credits: The dictation service took too long$/,
  );
  await flush();
  t.mock.timers.tick(45_000);
  await slow;
  assert.deepEqual(f.calls, ['chatgpt']);
  // a slow readiness read spends the same limit: no service is asked once too little is left
  f.calls.length = 0;
  const again = await d.begin(CLIENT, {});
  f.live.speech.options = () => new Promise((r) => setTimeout(() => r(chained(['chatgpt'])), 50_000));
  const late = assert.rejects(d.transcribe({ ...forms, ...again, clientId: CLIENT }), /^Error: The dictation service took too long$/);
  await flush();
  t.mock.timers.tick(50_000);
  await late;
  assert.deepEqual(f.calls, []);
});
