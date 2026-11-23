// The voice note's state machine shared by the coding composer and MoMo's (mobile/src/remote/useVoiceNote.ts): one start at a time, a cancel that fails says why, and leaving the screen stops a recording and a reading without a word.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush } from './support/phone/component-kit';
import { chunkReply, fakeMedia } from './support/phone/m3';
import { deferred } from './support/async-scenarios.ts';

const hookPath = '../mobile/src/remote/useVoiceNote';
const { useVoiceNote } = await import(hookPath);

async function mount(media: any, request: any) {
  const seen: { voice: any; texts: string[] } = { voice: null, texts: [] };
  function Harness() {
    seen.voice = useVoiceNote({ media, request, caps: null, onText: (t: string) => seen.texts.push(t) });
    return null;
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(Harness)));
  await flush();
  return {
    seen,
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}
const ask =
  (reply: (method: string) => unknown = () => ({ text: 'heard' })) =>
  async (method: string, params: any) =>
    method === 'chat.attach' ? chunkReply(params) : reply(method);

test('a second start while the first is still opening the recorder starts nothing', async () => {
  const gate = deferred<void>();
  const { media, log } = fakeMedia();
  media.startRecording = async () => (log.push('start'), gate.promise);
  const m = await mount(media, ask());
  await act(async () => void m.seen.voice.start());
  await act(async () => void m.seen.voice.start());
  assert.deepEqual(log, ['start']);
  gate.resolve();
  await act(async () => gate.promise);
  assert.equal(m.seen.voice.phase, 'recording');
  await m.unmount();
});

test('a cancel the recorder cannot do says why, and the note is over', async () => {
  const { media } = fakeMedia({ cancelError: true });
  const m = await mount(media, ask());
  await act(async () => m.seen.voice.start());
  assert.equal(m.seen.voice.phase, 'recording');
  await act(async () => m.seen.voice.discard());
  assert.equal(m.seen.voice.phase, 'idle');
  assert.equal(m.seen.voice.error, 'x');
  // leaving the screen cancels once more, and that refusal is not shown anywhere
  await m.unmount();
});

test('leaving the screen while a note is read drops it: nothing is added and nothing is said', async () => {
  const gate = deferred<unknown>();
  const { media, log } = fakeMedia();
  const m = await mount(
    media,
    ask(() => gate.promise),
  );
  await act(async () => m.seen.voice.start());
  await act(async () => void m.seen.voice.stop());
  assert.equal(m.seen.voice.phase, 'transcribing');
  await m.unmount();
  assert.ok(log.includes('cancel'));
  gate.resolve({ text: 'too late' });
  await flush();
  assert.deepEqual(m.seen.texts, []);
});
