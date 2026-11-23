// A phone's recording is read by the Mac's real speech lease logic (electron/app/chromePanelDictate.cjs) with no lease taken by the phone: a phone cannot call dictation.begin, so chat.transcribe must make its own (it failed with "no active speech owner" on a real Mac before).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rig } from './support/remote-kit.ts';

const require = createRequire(import.meta.url);
const { createPanelDictation } = require('../electron/app/chromePanelDictate.cjs');

const ok = (r: any) => (assert.equal(r.ok, true, JSON.stringify(r.error)), r.result);
const b64 = (s: string) => Buffer.from(s).toString('base64');
function mac() {
  const saved: string[] = [];
  const leases = { begun: 0, ended: 0 };
  const live = {
    speech: {
      options: async () => ({ engine: 'local', chain: ['local'], choices: [] }),
      begin: () => (leases.begun++, 'capture'),
      end: async () => void leases.ended++,
      current: () => true,
    },
    recordings: { save: (_clip: Buffer, text: string) => void saved.push(text) },
    dictation: { transcribe: async () => ({ text: 'spoken words' }) },
  };
  const dictation = createPanelDictation({ live, prefs: () => ({ dictationEngine: 'local', dictationLanguage: 'auto' }) });
  return { dictation, saved, leases, r: rig({ ops: { dictation } }) };
}

test('a phone cannot take a speech lease itself, and its recording is still read on the Mac’s real speech service', async () => {
  const m = mac();
  const p = m.r.phone('p1');
  const begin = await p.ask('dictation.begin', { capture: true, clientId: '00000000-0000-0000-0000-000000000000' });
  assert.deepEqual([begin.ok, begin.error.code], [false, 'forbidden']);
  assert.ok(!ok(await p.ask('machine.hello')).capabilities.methods.includes('dictation.begin'));
  ok(await p.ask('chat.attach', { stream: 'audio-0001', index: 0, total: 1, data: b64('RIFF'), purpose: 'audio', mime: 'audio/wav' }));
  assert.deepEqual(ok(await p.ask('chat.transcribe', { stream: 'audio-0001', mime: 'audio/wav' })), { text: 'spoken words' });
  // the lease the Mac made for the clip ended with it, and the clip was kept as the coding chat's always was
  assert.deepEqual([m.leases.begun, m.leases.ended, m.saved], [1, 1, ['spoken words']]);
});
