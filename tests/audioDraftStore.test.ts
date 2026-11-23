// Audio draft persistence and boot recovery surface storage failures while retaining editable input.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, impl, resetAll, flush, bootImpls, callsOf } from './support/store-harness.ts';
mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const { store: S, resetState } = await loadStore();
beforeEach(() => {
  resetState();
  resetAll();
  bootImpls();
});
const audio: any = { kind: 'audio', path: '/keep.wav', name: 'Audio' };

test('audio draft persistence reports a failed write and clearing the final audio reference also persists', async () => {
  impl['speech.draft'] = async () => {
    throw new Error('disk full');
  };
  assert.deepEqual(S.buildInput('', [audio]), [{ type: 'localAudio', path: '/keep.wav' }]);
  S.setDraft('chat', { text: 'Keep', attachments: [audio] });
  await flush();
  assert.equal(S.useStore.getState().drafts.chat.text, 'Keep');
  assert.match(S.useStore.getState().toasts.at(-1)!.text, /Could not save audio draft/);
  impl['speech.draft'] = async () => undefined;
  S.setDraft('chat', { text: '', attachments: [] });
  await flush();
  assert.equal(callsOf('speech.draft').length, 2);
});

test('failed boot recovery is visible; a successful recovery restores audio alongside initial preferences', async () => {
  impl['speech.drafts'] = async () => {
    throw new Error('unreadable');
  };
  await S.boot();
  await flush();
  assert.match(
    S.useStore
      .getState()
      .toasts.map((t) => t.text)
      .join('\n'),
    /Could not restore audio drafts/,
  );
  resetState();
  resetAll();
  bootImpls();
  impl['speech.drafts'] = async () => ({ home: { text: 'Recovered', attachments: [audio] } });
  await S.boot();
  assert.equal(S.useStore.getState().drafts.home.text, 'Recovered');
  assert.equal(S.useStore.getState().drafts.home.attachments[0].kind, 'audio');
});
