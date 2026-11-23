// The order a clip is tried on (shared/speech.mjs speechChain), each harness's own speech service (nativeDictation),
// and sending one clip along that order (src/components/ui/dictationSend.ts).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { speechChain, speechEngine, SPEECH_WAIT_MS } from '../shared/speech.mjs';
import { installNativeStub } from './support/ports/native.ts';

const require = createRequire(import.meta.url);
const { computeCaps } = require('../electron/session/caps.cjs');
const { createSpeech } = require('../electron/platform/speech.cjs');

const choice = (id: string, state: string) => ({ id, label: id, state, reason: state === 'ready' ? null : 'no' }) as any;
const all = (local: string, chatgpt: string, credits: string) => [
  choice('local', local),
  choice('chatgpt', chatgpt),
  choice('credits', credits),
];

test('Automatic puts the chat’s own service first, then this Mac, then the others; a pin is the only one', () => {
  const ready = all('ready', 'ready', 'ready');
  assert.deepEqual(speechChain(null, ready), ['local', 'chatgpt', 'credits']);
  assert.deepEqual(speechChain(null, ready, 'chatgpt'), ['chatgpt', 'local', 'credits']);
  assert.deepEqual(speechChain(null, all('permission', 'blocked', 'ready'), 'chatgpt'), ['local', 'credits']);
  assert.deepEqual(speechChain(null, ready, 'claude'), ['local', 'chatgpt', 'credits'], 'a service this app lacks is skipped');
  assert.deepEqual(speechChain('credits', ready, 'chatgpt'), ['credits']);
  assert.deepEqual(speechChain('local', all('blocked', 'ready', 'ready')), [], 'a pin never falls back');
  assert.deepEqual(speechChain('other', ready), []);
  assert.equal(speechEngine(null, ready, 'chatgpt'), 'chatgpt');
  assert.equal(speechEngine(null, all('blocked', 'blocked', 'unknown')), null);
});

test('a Codex chat on a ChatGPT login dictates with that login first; other harnesses and logins say why not', () => {
  const bare = { negotiated: null, provider: null, model: null, flags: {}, session: null };
  const codex = computeCaps({ kind: 'codex', ...bare, account: { fast: true, nativeDictation: true } });
  assert.deepEqual([codex.nativeDictation.state, codex.nativeDictation.engine], ['native', 'chatgpt']);
  const apiKey = computeCaps({ kind: 'codex', ...bare, account: { fast: true, nativeDictation: false, dictationAccount: 'chatgpt' } });
  assert.deepEqual(apiKey.nativeDictation.why, { layer: 'account', code: 'account.dictationNeeds.chatgpt' });
  const unnamed = computeCaps({ kind: 'codex', ...bare, account: { fast: true, nativeDictation: false } });
  assert.equal(unnamed.nativeDictation.why.code, 'account.dictationNeeds.login');
  const claude = computeCaps({ kind: 'claude', ...bare, account: { fast: true } });
  assert.deepEqual([claude.nativeDictation.state, claude.nativeDictation.why.code], ['absent', 'harness.noNativeDictation']);
  assert.equal(computeCaps({ kind: 'acp:kimi', ...bare, account: null }).nativeDictation.why.code, 'harness.noNativeDictation');
  // the chat's harness switched off: dictation needs no harness running
  const killed = computeCaps({ kind: 'codex', ...bare, account: null, flags: { 'sage.harness': false } });
  assert.equal(killed.nativeDictation.state, 'native');
});

test('main orders the services by the chat’s own one', async () => {
  let caps: any = { kind: 'codex', caps: { nativeDictation: { state: 'native', via: 'config', engine: 'chatgpt' } } };
  const speech = createSpeech({
    prefs: () => ({ dictationLanguage: 'en' }),
    ref: () => null,
    identity: () => 'a',
    localStatus: async () => ({ authorization: 'authorized', available: true, onDevice: true }),
    accounts: async () => ({ chatgpt: true, credits: false }),
    caps: async () => caps,
  });
  assert.deepEqual((await speech.options('chat', {})).chain, ['chatgpt', 'local']);
  caps = { kind: 'claude', caps: { nativeDictation: { state: 'absent', via: 'none' } } };
  const o = await speech.options('chat', {});
  assert.deepEqual([o.engine, o.chain], ['local', ['local', 'chatgpt']]);
});

const sent: any[] = [];
/** how long the window says it waits, so main stops the request after it */
const waits: number[] = [];
let answers: Record<string, () => Promise<any>> = {};
let localStatus: any = { authorization: 'authorized', available: true, onDevice: true };
let localAnswer: any = null;
installNativeStub({
  speech: {
    transcribe: (_owner: string, _bytes: any, mime: string, lang: any, engine: string, waitMs: number) => (
      sent.push([engine, mime, lang]), waits.push(waitMs), answers[engine]()
    ),
  },
  dictation: {
    localStatus: async () => localStatus,
    localRequest: async () => ((localStatus = localAnswer), localAnswer),
  },
});
mock.module('../src/lib/dictation.ts', { namedExports: { recordingToWav: async () => new Uint8Array([1]) } });
const { sendAlong, settles, engineLabel, SPEECH_NEXT_MS } = await import('../src/components/ui/dictationSend.ts');

function along(chain: string[], live = () => true, lang = 'auto') {
  const progress: any[] = [];
  const run = sendAlong(chain as any, {
    blob: new Blob([new Uint8Array([1, 2])]),
    lang,
    owner: 'capture',
    live,
    progress: { asking: (on) => progress.push(['asking', on]), trying: (e) => progress.push(['trying', e]) },
  });
  return { run, progress };
}

test('a clip moves on until a service answers, says which it tries, and settles on text or a refusal of the clip', async () => {
  sent.length = 0;
  waits.length = 0;
  answers = {
    local: async () => ({ error: 'On-device recognition is unavailable' }),
    chatgpt: async () => ({ error: 'offline' }),
    credits: async () => ({ text: 'hello' }),
  };
  const ok = along(['local', 'chatgpt', 'credits']);
  assert.deepEqual(await ok.run, { text: 'hello', engine: 'credits' });
  assert.deepEqual(sent, [
    ['local', 'audio/wav', 'auto'],
    ['chatgpt', 'audio/webm', undefined],
    ['credits', 'audio/webm', undefined],
  ]);
  assert.deepEqual(ok.progress, [
    ['trying', 'chatgpt'],
    ['trying', 'credits'],
  ]);
  // each service is told its share of the wait (the last gets all of it), and main stops it after that
  assert.deepEqual(waits, [SPEECH_NEXT_MS, SPEECH_NEXT_MS, SPEECH_WAIT_MS]);
  // nothing said is an answer: no other service is asked
  answers.local = async () => ({ text: '' });
  assert.deepEqual(await along(['local', 'credits']).run, { text: '', engine: 'local' });
  answers.chatgpt = async () => ({ error: 'Audio too short' });
  assert.deepEqual(await along(['chatgpt', 'credits']).run, { error: 'Audio too short', engine: 'chatgpt' });
  assert.equal(settles({ error: 'offline' }), false);
});

test('every service failing names each reason; one alone keeps its words; a given-up clip says nothing', async () => {
  answers = {
    chatgpt: async () => ({ error: 'Sign in with ChatGPT to use dictation' }),
    credits: async () => ({ error: 'Credits balance too low' }),
  };
  assert.deepEqual(await along(['chatgpt', 'credits']).run, {
    error: `${engineLabel('chatgpt')}: Sign in with ChatGPT to use dictation · MoPilot credits: Credits balance too low`,
  });
  assert.deepEqual(await along(['chatgpt']).run, { error: 'Sign in with ChatGPT to use dictation' });
  assert.deepEqual(await along([]).run, { error: "Couldn't transcribe the recording" });
  let live = true;
  answers.chatgpt = async () => {
    live = false;
    return { error: 'late' };
  };
  assert.equal(await along(['chatgpt', 'credits'], () => live).run, null);
  assert.equal(engineLabel('other' as any), 'other');
});

test('the user declining the macOS prompt, main refusing the clip or the switch turned off ends the clip there', async () => {
  sent.length = 0;
  answers = { chatgpt: async () => ({ text: 'uploaded' }) };
  localStatus = { authorization: 'notDetermined', available: true, onDevice: true };
  localAnswer = { authorization: 'denied', available: true, onDevice: true };
  const declined = along(['local', 'chatgpt']);
  assert.deepEqual(await declined.run, { error: 'Turn on Speech Recognition in System Settings to dictate', engine: 'local' });
  assert.deepEqual(declined.progress, [
    ['asking', true],
    ['asking', false],
  ]);
  assert.deepEqual(sent, [], 'nothing is uploaded after the user said no');
  // a denial made earlier in System Settings is this Mac being unavailable: Automatic moves on
  localStatus = { authorization: 'denied', available: true, onDevice: true };
  assert.deepEqual(await along(['local', 'chatgpt']).run, { text: 'uploaded', engine: 'chatgpt' });
  answers.chatgpt = async () => {
    throw new Error('This voice input was cancelled');
  };
  answers.credits = async () => ({ text: 'never' });
  assert.deepEqual(await along(['chatgpt', 'credits']).run, { error: 'This voice input was cancelled', engine: 'chatgpt' });
  answers.chatgpt = async () => {
    throw new Error('');
  };
  assert.deepEqual(await along(['chatgpt', 'credits']).run, { error: "Couldn't transcribe the recording", engine: 'chatgpt' });
  answers.chatgpt = async () => ({ error: 'Dictation is turned off in this app' });
  assert.deepEqual(await along(['chatgpt', 'credits']).run, { error: 'Dictation is turned off in this app', engine: 'chatgpt' });
});

test('a service that could pass the clip on waits less than the last one', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  answers = { chatgpt: () => new Promise(() => {}), credits: () => new Promise(() => {}) };
  const { run, progress } = along(['chatgpt', 'credits']);
  for (let i = 0; i < 5; i++) await new Promise(setImmediate);
  t.mock.timers.tick(SPEECH_NEXT_MS);
  for (let i = 0; i < 5; i++) await new Promise(setImmediate);
  assert.deepEqual(progress, [['trying', 'credits']]);
  t.mock.timers.tick(180_000);
  assert.deepEqual(await run, { error: 'ChatGPT account: Dictation timed out · MoPilot credits: Dictation timed out' });
});

test('a clip given up while it is being prepared for a service sends nothing', async () => {
  sent.length = 0;
  localStatus = { authorization: 'authorized', available: true, onDevice: true };
  answers = { local: async () => ({ text: 'x' }), chatgpt: async () => ({ text: 'x' }) };
  // live until the step before sending: this Mac's WAV, the others' webm
  for (const [engine, checks] of [
    ['local', 1],
    ['chatgpt', 0],
  ] as const) {
    let left = checks;
    assert.equal(await along([engine], () => left-- > 0).run, null, engine);
  }
  assert.deepEqual(sent, []);
});
