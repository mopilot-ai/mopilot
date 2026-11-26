// Submit chords ask for the Follow-up setting, the alternate chord for the other, and the hint advertises the same keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composerSendHint, composerSendIntent, composerSendShortcuts } from '../src/lib/composerSendKeys.ts';
import { setup, tick } from './support/controller/fixture.ts';
import { mainCapsFor } from './support/steer-caps.ts';

const enter = { key: 'Enter', shiftKey: false, altKey: false, metaKey: false, ctrlKey: false };
const other = { queue: 'steer', steer: 'queue' } as const;

test('IME confirmation never becomes a send or queue intent through either submit preference', () => {
  for (const sendWith of ['enter', 'cmdEnter'] as const) {
    for (const modifiers of [{}, { metaKey: true }, { ctrlKey: true, shiftKey: true }]) {
      for (const composition of [{ isComposing: true }, { keyCode: 229 }, { nativeEvent: { isComposing: true } }])
        assert.equal(composerSendIntent({ ...enter, ...modifiers, ...composition }, sendWith, 'queue'), null);
    }
  }
});

for (const followUp of ['queue', 'steer'] as const) {
  test(`${followUp} setting: Enter asks for it and modified Enter for the other, with newline and non-submit keys left to the editor`, () => {
    assert.equal(composerSendIntent(enter, 'enter', followUp), followUp);
    for (const modifier of ['metaKey', 'ctrlKey']) {
      assert.equal(composerSendIntent({ ...enter, [modifier]: true }, 'enter', followUp), other[followUp]);
      assert.equal(composerSendIntent({ ...enter, [modifier]: true, shiftKey: true }, 'enter', followUp), null);
    }
    for (const event of [{ key: 'Escape' }, { shiftKey: true }, { altKey: true }])
      assert.equal(composerSendIntent({ ...enter, ...event }, 'enter', followUp), null);
  });

  test(`${followUp} setting with the modified-Enter preference: its primary chord asks for it and Shift added for the other`, () => {
    assert.equal(composerSendIntent(enter, 'cmdEnter', followUp), null);
    for (const modifier of ['metaKey', 'ctrlKey']) {
      assert.equal(composerSendIntent({ ...enter, [modifier]: true }, 'cmdEnter', followUp), followUp);
      assert.equal(composerSendIntent({ ...enter, [modifier]: true, shiftKey: true }, 'cmdEnter', followUp), other[followUp]);
      assert.equal(composerSendIntent({ ...enter, [modifier]: true, altKey: true }, 'cmdEnter', followUp), null);
    }
  });
}

test('submit and alternate labels describe both preferences on macOS and Ctrl platforms', () => {
  assert.deepEqual(composerSendShortcuts('enter', true), { submit: '⏎', alternate: '⌘⏎' });
  assert.deepEqual(composerSendShortcuts('cmdEnter', true), { submit: '⌘⏎', alternate: '⇧⌘⏎' });
  assert.deepEqual(composerSendShortcuts('enter', false), { submit: '⏎', alternate: 'Ctrl+⏎' });
  assert.deepEqual(composerSendShortcuts('cmdEnter', false), { submit: 'Ctrl+⏎', alternate: 'Ctrl+Shift+⏎' });
  assert.ok(composerSendShortcuts('enter').submit);
});

test("the hint names the submit chord with the Follow-up setting first, and only queuing where the chat's agent can't steer", () => {
  assert.equal(composerSendHint('enter', 'queue', true, true), '⏎ to queue for later, ⌘⏎ to send now');
  assert.equal(composerSendHint('enter', 'steer', true, true), '⏎ to send now, ⌘⏎ to queue for later');
  assert.equal(composerSendHint('cmdEnter', 'queue', true, false), 'Ctrl+⏎ to queue for later, Ctrl+Shift+⏎ to send now');
  assert.equal(composerSendHint('cmdEnter', 'steer', true, true), '⌘⏎ to send now, ⇧⌘⏎ to queue for later');
  for (const followUp of ['queue', 'steer'] as const)
    assert.equal(composerSendHint('enter', followUp, false, true), '⏎ to queue for later');
  assert.ok(composerSendHint('enter', 'queue', true).includes('to send now'));
});

// a machine's Claude Code or Codex chat is basic-tier here (`acp:host-claude:…`) and steers on its Host; a local ACP chat can't
for (const [chat, kind, place, steers] of [
  ['Codex', 'codex', {}, true],
  ['Claude Code', 'claude', {}, true],
  ['local ACP', 'acp:opencode', {}, false],
  ['host-claude', 'acp:host-claude', { onMachine: true }, true],
  ['host-codex', 'acp:host-codex', { onMachine: true }, true],
  ['host-claude switched to Codex', 'acp:host-claude', { onMachine: true, hostAgent: 'codex' }, true],
  ['host-codex switched to a basic agent', 'acp:host-codex', { onMachine: true, hostAgent: 'acp:kimi' }, false],
] as const) {
  test(`${chat}: the running-turn hint offers ${steers ? 'both keys' : 'only queuing'} under either Follow-up setting, as main's caps say`, async () => {
    assert.equal((await mainCapsFor(kind, place)).caps.steer.state === 'native', steers);
    const hints = (['queue', 'steer'] as const).map((followUp) => composerSendHint('enter', followUp, steers, true));
    assert.deepEqual(
      hints,
      steers
        ? ['⏎ to queue for later, ⌘⏎ to send now', '⏎ to send now, ⌘⏎ to queue for later']
        : ['⏎ to queue for later', '⏎ to queue for later'],
    );
  });
}

for (const [family, chat, turnKind, steerKind] of [
  ['Codex', 't1', 'turn', 'steer'],
  ['Claude Code', 'claude:s1', 'claude-turn', 'claude-steer'],
  ['ACP', 'acp:opencode:s1', 'acp-turn', null],
] as const) {
  test(`${family}: with the default Queue setting, Enter waits for turn completion and Cmd+Enter's steer request ${steerKind ? 'goes into the turn' : 'waits too, as main decides'}`, async () => {
    const { c, execs, s } = setup();
    const steers = steerKind !== null;
    c.send(chat, { text: 'working' }, 1);
    await tick();
    const queueIntent = composerSendIntent(enter, 'enter', 'queue');
    assert.equal(c.send(chat, { text: 'later', followUp: queueIntent }, 1).action, 'queued');
    assert.equal(execs.length, 1, 'queuing does not reach any harness while its turn runs');
    // the composer names no harness: an agent that can't steer gets the same request, and main queues it
    const sendIntent = composerSendIntent({ ...enter, metaKey: true }, 'enter', 'queue');
    assert.equal(sendIntent, 'steer');
    const receipt = c.send(chat, { text: 'now', followUp: sendIntent }, 1);
    assert.equal(receipt.action, steers ? 'steered' : 'queued');
    await tick();
    assert.deepEqual(
      execs.map((e) => e.kind),
      steers ? [turnKind, steerKind] : [turnKind],
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
