// Submit chords choose an explicit delivery intent and advertise the same platform-specific keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composerSendIntent, composerSendShortcuts } from '../src/lib/composerSendKeys.ts';
import { setup, tick } from './support/controller/fixture.ts';

const enter = { key: 'Enter', shiftKey: false, altKey: false, metaKey: false, ctrlKey: false };

test('IME confirmation never becomes a send or queue intent through either submit preference', () => {
  for (const sendWith of ['enter', 'cmdEnter'] as const) {
    for (const modifiers of [{}, { metaKey: true }, { ctrlKey: true, shiftKey: true }]) {
      for (const composition of [{ isComposing: true }, { keyCode: 229 }, { nativeEvent: { isComposing: true } }])
        assert.equal(composerSendIntent({ ...enter, ...modifiers, ...composition }, sendWith), null);
    }
  }
});

test('Enter sends and modified Enter queues, with newline and non-submit keys left to the editor', () => {
  assert.equal(composerSendIntent(enter, 'enter'), 'steer');
  for (const modifier of ['metaKey', 'ctrlKey']) {
    assert.equal(composerSendIntent({ ...enter, [modifier]: true }, 'enter'), 'queue');
    assert.equal(composerSendIntent({ ...enter, [modifier]: true, shiftKey: true }, 'enter'), null);
  }
  for (const event of [{ key: 'Escape' }, { shiftKey: true }, { altKey: true }])
    assert.equal(composerSendIntent({ ...enter, ...event }, 'enter'), null);
});

test('the modified-Enter preference sends with its primary chord and queues with Shift added', () => {
  assert.equal(composerSendIntent(enter, 'cmdEnter'), null);
  for (const modifier of ['metaKey', 'ctrlKey']) {
    assert.equal(composerSendIntent({ ...enter, [modifier]: true }, 'cmdEnter'), 'steer');
    assert.equal(composerSendIntent({ ...enter, [modifier]: true, shiftKey: true }, 'cmdEnter'), 'queue');
    assert.equal(composerSendIntent({ ...enter, [modifier]: true, altKey: true }, 'cmdEnter'), null);
  }
});

test('send and queue labels describe both preferences on macOS and Ctrl platforms', () => {
  assert.deepEqual(composerSendShortcuts('enter', true), { send: '↵', queue: '⌘↵' });
  assert.deepEqual(composerSendShortcuts('cmdEnter', true), { send: '⌘↵', queue: '⇧⌘↵' });
  assert.deepEqual(composerSendShortcuts('enter', false), { send: '↵', queue: 'Ctrl+↵' });
  assert.deepEqual(composerSendShortcuts('cmdEnter', false), { send: 'Ctrl+↵', queue: 'Ctrl+Shift+↵' });
  assert.ok(composerSendShortcuts('enter').send);
});

for (const [family, chat, turnKind, steerKind] of [
  ['Codex', 't1', 'turn', 'steer'],
  ['Claude Code', 'claude:s1', 'claude-turn', 'claude-steer'],
  ['ACP', 'acp:opencode:s1', 'acp-turn', null],
] as const) {
  test(`${family}: explicit queue waits for turn completion and immediate delivery uses the supported path`, async () => {
    const { c, execs, s } = setup();
    c.send(chat, { text: 'working' }, 1);
    await tick();
    const queueIntent = composerSendIntent({ ...enter, metaKey: true }, 'enter');
    assert.equal(c.send(chat, { text: 'later', followUp: queueIntent }, 1).action, 'queued');
    assert.equal(execs.length, 1, 'queuing does not reach any harness while its turn runs');
    const sendIntent = composerSendIntent(enter, 'enter');
    const receipt = c.send(chat, { text: 'now', followUp: sendIntent }, 1);
    assert.equal(receipt.action, steerKind ? 'steered' : 'queued');
    await tick();
    assert.deepEqual(
      execs.map((e) => e.kind),
      steerKind ? [turnKind, steerKind] : [turnKind],
    );
    c.end(chat);
    await tick();
    assert.equal(execs.at(-1)?.item.text, 'later');
    assert.equal(execs.at(-1)?.kind, turnKind);
    c.end(chat);
    await tick();
    assert.deepEqual(s(chat).queue, []);
    assert.equal(execs.filter((e) => e.item.text === 'now').length, 1, 'each message is delivered exactly once');
  });
}
