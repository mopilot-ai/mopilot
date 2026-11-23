// Switched ACP audio history remains explicit context, including summary/truncated handoffs, without replaying audio tasks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { audioInputLines, audioHandoffText } from '../shared/audioHandoff.mjs';
import { composeHandoff, renderConversation } from '../shared/handoff.mjs';
import { transcriptHost } from './support/acp-transcript.ts';
const { SwitchRunner } = createRequire(import.meta.url)('../electron/session/switch.cjs');
const user = (content: any[]) => ({ type: 'userMessage', id: 'u', content });
const audio = { type: 'localAudio', path: '/recordings/task.wav' };

test('the real ACP history-to-switch path preserves audio-only and mixed user requests as explicit untranscribed references', async () => {
  for (const text of ['', 'Use this recording']) {
    const records = [
      { t: 'user', turnId: 'at-audio', user: { id: 'u', content: [...(text ? [{ type: 'text', text }] : []), audio] }, at: 1 },
      { t: 'end', turnId: 'at-audio', stopReason: 'end_turn', at: 2 },
    ];
    const runner = new SwitchRunner({
      home: '/project',
      prefs: () => ({}),
      acpHost: transcriptHost(() => records),
      git: { info: async () => null, status: async () => null },
    });
    const turns = await runner.acpTurns({ kind: 'acp:kimi', nativeId: 'native' }, '/project', []);
    const handoff = await runner.handoff({
      chatId: 'stable',
      mode: 'auto',
      since: 0,
      from: 'acp:kimi',
      ref: {},
      target: { harness: 'claude', model: 'test' },
      cwd: '/project',
      turns,
      holds: false,
    });
    assert.match(handoff, /task.wav/);
    assert.match(handoff, /not transcribed/);
    assert.match(handoff, /Dictate/);
    if (text) assert.match(handoff, /Use this recording/);
  }
});

test('summary handoff keeps audio references outside generated text; workspace-only deliberately omits conversation', () => {
  const turns: any[] = [{ items: [user([audio])] }];
  const base: any = {
    from: 'codex',
    mode: 'summary',
    turns,
    since: 0,
    targetModel: 'test',
    workspace: '## Workspace',
    note: 'Summary without attachment details',
  };
  assert.match(composeHandoff(base), /task.wav/);
  assert.doesNotMatch(composeHandoff({ ...base, mode: 'workspace' }), /task.wav/);
  assert.match(renderConversation(turns, 1000).text, /task.wav/);
});

test('handoff references tolerate unavailable media, deduplicate repeated paths and bound retained context explicitly', () => {
  assert.deepEqual(audioInputLines(null), []);
  assert.deepEqual(audioInputLines([null, { type: 'text', text: 'hello' }]), []);
  for (const path of [null, '', 7]) assert.match(audioInputLines([{ type: 'localAudio', path }])[0], /recording unavailable/);
  assert.equal(audioHandoffText([{}, { items: [{ type: 'reasoning' }] }]), '');
  const turns = Array.from({ length: 25 }, (_, i) => ({ items: [user([{ type: 'localAudio', path: `/audio/recording-${i}.wav` }])] }));
  turns.push(turns[24]);
  const handoff = audioHandoffText(turns);
  assert.match(handoff, /5 older audio references/);
  assert.doesNotMatch(handoff, /recording-0.wav/);
  assert.match(handoff, /recording-24.wav/);
  assert.equal(handoff.split('recording-24.wav').length, 2);
});
