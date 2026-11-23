// A voice note for MoMo's chat on the classic phone (mobile/src/screens/MomoVoice.tsx, MomoChat.tsx, Momo.tsx over remote/useVoiceNote.ts): the microphone shows only where the phone can record and the Mac lists momo.chat.transcribe; the note goes to the Mac in parts and comes back as text in the composer, nothing is sent until Send, and every failure says why in a few words; the words are in the phone's catalog in both languages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, click, createElement, createRoot, flush, inputText } from './support/phone/component-kit';
import { chunkReply, fakeMedia } from './support/phone/m3';
import { momoRuntime, mountMomo, snapshotOf } from './support/phone/momo-kit';
import { deferred } from './support/async-scenarios.ts';

const enPath = '../mobile/src/ui/i18n/locales/en';
const zhPath = '../mobile/src/ui/i18n/locales/zh-Hans';
const en = (await import(enPath)).default;
const zh = (await import(zhPath)).default;
const voicePath = '../mobile/src/screens/MomoVoice';
const { MOMO_VOICE_METHOD, voiceShown, withTranscript } = await import(voicePath);
const chatPath = '../mobile/src/screens/MomoChat';
const { MomoComposer } = await import(chatPath);
const deniedPath = '../mobile/src/platform/accessDenied';
const { AccessDenied } = await import(deniedPath);

const BASE = ['momo.state.get', 'momo.prefs.get', 'momo.prefs.set'];
const COMPOSER = 'Ask MoMo anything';
const label = (name: string) => document.querySelector(`[aria-label="${name}"]`) as HTMLButtonElement | null;
const composer = () => document.querySelector(`input[placeholder="${COMPOSER}"]`) as HTMLInputElement | null;
const calls = (m: any, method: string) => m.calls.filter(([name]: [string]) => name === method).map(([, p]: any) => p);

function chat(extra: Record<string, any> = {}, methods = [...BASE, MOMO_VOICE_METHOD]) {
  return momoRuntime({
    'machine.hello': () => ({ v: 1, capabilities: { momo: true, momoBrainSet: false, methods, permissionCeiling: 'auto-review' } }),
    'momo.chat.follow': () => snapshotOf(),
    'momo.chat.unfollow': () => ({}),
    'momo.brain.get': () => ({ brain: null }),
    'momo.routines.list': () => ({ proposals: [], routines: [] }),
    'momo.sources.status': () => ({ calendar: true, reminders: true }),
    'momo.state.get': () => ({ name: 'Mo', status: 'online', needsYou: 0 }),
    'momo.prefs.get': () => ({ paused: false, proactivity: 'default', quietHours: null, levels: [{ id: 'default' }] }),
    'momo.prefs.set': () => ({ paused: false }),
    'chat.attach': chunkReply,
    [MOMO_VOICE_METHOD]: () => ({ text: 'call the bank on Friday' }),
    ...extra,
  });
}
const open = async (m: any, media: any = fakeMedia().media, first: Record<string, unknown> = {}) => {
  const view = await mountMomo(m, undefined, { media, ...first });
  await flush();
  return view;
};

test('a voice note is read on the Mac, lands in the composer for the person to read, and is sent only by Send', async () => {
  const m = chat();
  const { media, log } = fakeMedia();
  const view = await open(m, media);
  assert.ok(label('Record a voice note'));
  await click('Record a voice note');
  assert.deepEqual(log, ['start']);
  assert.ok(label('Stop and transcribe') && label('Cancel recording'));
  assert.equal(composer(), null, 'the pill shows the recording, not the field');
  await click('Stop and transcribe');
  // the clip went to the Mac in parts, then MoMo's own method read it: no chat is named, and MoMo's send was not touched
  const audio = calls(m, 'chat.attach')[0];
  assert.deepEqual([audio.purpose, audio.mime, audio.data], ['audio', 'audio/wav', 'UklGRg==']);
  assert.deepEqual(calls(m, MOMO_VOICE_METHOD), [{ stream: audio.stream, mime: 'audio/wav' }]);
  assert.equal(calls(m, 'chat.transcribe').length, 0);
  assert.equal(calls(m, 'momo.chat.send').length, 0);
  assert.equal(composer()!.value, 'call the bank on Friday');
  assert.equal(label('Send')!.disabled, false);
  assert.ok(label('Record a voice note'), 'the microphone is back');
  await click('Send');
  assert.deepEqual(
    calls(m, 'momo.chat.send').map((p: any) => p.text),
    ['call the bank on Friday'],
  );
  await view.unmount();
});

test('a transcript goes after what is already typed, and the person can edit it before sending', async () => {
  const m = chat();
  const view = await open(m);
  await inputText(COMPOSER, 'Remind me');
  await click('Record a voice note');
  await click('Stop and transcribe');
  assert.equal(composer()!.value, 'Remind me call the bank on Friday');
  await inputText(COMPOSER, 'Remind me to call the bank on Friday');
  assert.equal(calls(m, 'momo.chat.send').length, 0);
  assert.equal(withTranscript('  ', 'hello'), 'hello');
  assert.equal(withTranscript(' a ', 'b'), 'a b');
  await view.unmount();
});

test('no microphone where the phone cannot record, or the Mac does not list the method, or the Mac is away', async () => {
  const noMedia = await mountMomo(chat());
  assert.equal(label('Record a voice note'), null);
  await noMedia.unmount();
  const older = await open(chat({}, BASE));
  assert.equal(label('Record a voice note'), null, 'an older Mac, or an account MoMo is not allowed for, lists no method');
  assert.ok(composer(), 'the composer is the same');
  await older.unmount();
  const away = chat();
  const view = await open(away);
  assert.ok(label('Record a voice note'));
  away.set({ phase: 'offline' });
  await flush();
  assert.equal(label('Record a voice note'), null, 'nothing can be read while the Mac is away');
  assert.match(view.text(), /Your Mac is asleep or offline\. Your message stays here until you can send it\./);
  await view.unmount();
});

test('a refused microphone says so and offers Settings; trying again clears it', async () => {
  let refuse = true;
  const { media } = fakeMedia();
  media.startRecording = async () => {
    if (refuse) throw new AccessDenied('microphone', 'Allow microphone access in Settings to dictate.');
  };
  const view = await open(chat(), media);
  await click('Record a voice note');
  assert.match(view.text(), /Allow microphone access in Settings to dictate\./);
  assert.ok(label('Open Settings') || [...document.querySelectorAll('button')].some((b) => b.textContent === 'Open Settings'));
  refuse = false;
  await click('Record a voice note');
  assert.doesNotMatch(view.text(), /Allow microphone access/);
  assert.ok(label('Stop and transcribe'));
  await view.unmount();
});

test('while the microphone prompt is open the person is told, and a second tap starts nothing', async () => {
  const gate = deferred<void>();
  const { media, log } = fakeMedia();
  media.startRecording = async () => (log.push('start'), gate.promise);
  const view = await open(chat(), media);
  await click('Record a voice note');
  assert.match(view.text(), /Starting… answer the microphone prompt if iOS asks\./);
  assert.equal(label('Record a voice note')!.disabled, true);
  await click('Record a voice note');
  assert.deepEqual(log, ['start']);
  gate.resolve();
  await act(async () => gate.promise);
  await flush();
  assert.ok(label('Stop and transcribe'));
  await view.unmount();
});

test('the Mac failing to read the note, hearing nothing, or going away each say so, and leave the draft alone', async () => {
  for (const [reply, shown] of [
    [() => Promise.reject(new Error('Speech services did not respond. Dictate again.')), /Speech services did not respond/],
    [() => ({ text: '  ' }), /No speech was heard\./],
    [() => Promise.reject(new Error('Computer is offline')), /offline|asleep|away/i],
  ] as const) {
    const m = chat({ [MOMO_VOICE_METHOD]: reply });
    const view = await open(m);
    await inputText(COMPOSER, 'keep me');
    await click('Record a voice note');
    await click('Stop and transcribe');
    assert.match(view.text(), shown);
    assert.equal(composer()!.value, 'keep me');
    assert.ok(label('Record a voice note'), 'the microphone is back for another try');
    await view.unmount();
  }
});

test('a Mac that goes away while a note is read still says so, and the microphone waits for it', async () => {
  const gate = deferred<unknown>();
  const m = chat({ [MOMO_VOICE_METHOD]: () => gate.promise });
  const view = await open(m);
  await click('Record a voice note');
  await click('Stop and transcribe');
  assert.match(view.text(), /Your Mac is transcribing…/);
  m.set({ phase: 'offline' });
  await flush();
  assert.ok(label('Cancel transcription'), 'the note in flight stays on screen');
  gate.reject(new Error('Computer is offline'));
  await act(async () => gate.promise.catch(() => undefined));
  await flush();
  assert.equal(label('Record a voice note')!.disabled, true);
  assert.match(view.text(), /offline|asleep|away/i);
  await view.unmount();
});

test('Cancel stops a recording without reading it, and cancelling the reading drops the note quietly', async () => {
  const { media, log } = fakeMedia();
  const gate = deferred<unknown>();
  const m = chat({ [MOMO_VOICE_METHOD]: () => gate.promise });
  const view = await open(m, media);
  await click('Record a voice note');
  await click('Cancel recording');
  assert.deepEqual(log, ['start', 'cancel']);
  assert.equal(calls(m, 'chat.attach').length, 0);
  assert.ok(label('Record a voice note'));
  await click('Record a voice note');
  await click('Stop and transcribe');
  await click('Cancel transcription');
  gate.resolve({ text: 'too late' });
  await act(async () => gate.promise);
  await flush();
  assert.equal(composer()!.value, '', 'a cancelled note adds nothing');
  assert.doesNotMatch(view.text(), /cancelled/i);
  await view.unmount();
});

test('the microphone is held while the Mac is away or the composer is busy; the stub sends nothing', async () => {
  const voice = (phase: string) => ({
    phase,
    error: null,
    denied: false,
    waiting: false,
    meter: { ms: 0, levels: [] },
    start: () => undefined,
    stop: () => undefined,
    discard: () => undefined,
    cancelTranscribing: () => undefined,
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const draw = async (props: Record<string, unknown>) => {
    await act(async () =>
      root.render(
        createElement(MomoComposer, {
          draft: '',
          setDraft: () => undefined,
          send: () => undefined,
          stop: () => undefined,
          working: false,
          disabled: false,
          ...props,
        }),
      ),
    );
    await flush();
  };
  await draw({ voice: voice('idle') });
  assert.equal(label('Record a voice note')!.disabled, false);
  await draw({ voice: voice('idle'), micOff: true });
  assert.equal(label('Record a voice note')!.disabled, true);
  await draw({ voice: voice('idle'), disabled: true });
  assert.equal(label('Record a voice note')!.disabled, true);
  await draw({ voice: null });
  assert.equal(label('Record a voice note'), null);
  await draw({ voice: voice('transcribing') });
  assert.ok(label('Cancel transcription'));
  await act(async () => root.unmount());
  host.remove();
});

test('the voice note shows only while the Mac lists it, or while one is under way or has failed', () => {
  const v = (phase = 'idle', error: string | null = null) => ({ phase, error }) as any;
  assert.equal(voiceShown(true, null), null);
  assert.equal(voiceShown(false, null), null);
  assert.equal(voiceShown(false, v()), null, 'an older Mac or an uninvited account: no trace');
  const idle = v();
  assert.equal(voiceShown(true, idle), idle);
  const recording = v('recording');
  assert.equal(voiceShown(false, recording), recording);
  const failed = v('idle', 'No speech was heard.');
  assert.equal(voiceShown(false, failed), failed);
});

test('the words are in the catalog in both languages, name no harness, and the method is MoMo’s own', () => {
  assert.deepEqual(Object.keys(zh.momoVoice).sort(), Object.keys(en.momoVoice).sort());
  assert.equal(Object.keys(en.momoVoice).length, 6);
  for (const text of [...Object.values(en.momoVoice), ...Object.values(zh.momoVoice)])
    assert.doesNotMatch(String(text), /claude|codex|chatgpt|openai|anthropic/i);
  assert.equal(MOMO_VOICE_METHOD, 'momo.chat.transcribe');
});
