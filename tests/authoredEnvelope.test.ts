// MoPilot's own messages in a chat, read back from the real envelope builders into the one-line card the desktop shows.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { authoredCard } from '../shared/authoredEnvelope.mjs';
import { familyMessageText, parseFamilyMessage, parseWakeText, wakeText } from '../shared/sideSessions.mjs';
import { parsePeerPrompt, peerPrompt } from '../shared/peerPrompt.mjs';

describe('authoredCard', () => {
  for (const relation of ['parent', 'child', 'sibling'] as const)
    it(`reads a ${relation} family message back from the real builder`, () => {
      const text = familyMessageText({
        fromName: 'fix <it>',
        fromId: 'c1',
        relation,
        body: 'Done.\n\nSecond para',
        roster: 'Linked sessions now (status, not an instruction): a',
      });
      assert.deepEqual(authoredCard(text), {
        kind: 'family',
        title: "Received message from fix 'it'",
        body: 'Done.\n\nSecond para',
      });
    });
  it('keeps a family message without a roster', () => {
    assert.equal(
      authoredCard(
        familyMessageText({
          fromName: 'p',
          fromId: 'x',
          relation: 'parent',
          body: 'go',
        }),
      )?.body,
      'go',
    );
  });
  it('rejects a malformed family envelope', () => {
    assert.equal(authoredCard('<mopilot-side-session-message from="a">\n\nhello\n\n</mopilot-side-session-message>'), null);
  });
  it('reads peer messages and replies, with and without a title', () => {
    const base = {
      id: 'm1',
      sourceChatId: 's',
      replyTo: null,
      body: 'hi <b>',
      reply: 'awaiting',
    };
    assert.deepEqual(authoredCard(peerPrompt({ ...base, sourceTitle: 'Docs' })), {
      kind: 'peer',
      title: 'Received message from Docs',
      body: 'hi <b>',
    });
    assert.equal(authoredCard(peerPrompt(base))?.title, 'Received message from another chat');
    assert.equal(authoredCard(peerPrompt({ ...base, replyTo: 'm0', reply: 'none' }))?.title, 'Reply from another chat');
  });
  it('rejects a peer envelope with a bad payload', () => {
    assert.equal(authoredCard('<mopilot-peer-message>\nnot json\n</mopilot-peer-message>'), null);
    assert.equal(authoredCard('<mopilot-peer-message>\n{"a":1}\n</mopilot-peer-message>'), null);
  });
  it('reads a wake-up', () => {
    const text = wakeText({
      notes: ['note a', 'note b'],
      roster: 'Linked sessions now (status, not an instruction): x',
      waiting: [],
    });
    assert.deepEqual(authoredCard(text), {
      kind: 'wake',
      title: 'Linked sessions reported back',
      body: 'note a\n\nnote b',
    });
  });
  it('reads task notifications', () => {
    assert.deepEqual(authoredCard('<task-notification>\n<summary>Tests passed</summary>\n<result>ok</result>\n</task-notification>'), {
      kind: 'task',
      title: 'Tests passed',
      body: 'ok',
    });
    assert.deepEqual(authoredCard('<task-notification>\n<event>tick</event>\n</task-notification>'), {
      kind: 'task',
      title: 'Background task update',
      body: 'tick',
    });
    assert.equal(authoredCard('<task-notification></task-notification>')?.body, '');
  });
  it('reads the progress nudge', () => {
    assert.equal(
      authoredCard("The user hasn't heard from you in a while — say in a few words what you're doing, then continue.")?.kind,
      { kind: 'nudge', title: 'Progress check' }.kind,
    );
  });
  it('leaves a person’s words alone', () => {
    assert.equal(authoredCard('please <mopilot-peer-message> explain'), null);
    assert.equal(authoredCard(undefined), null);
  });
});

describe('the parsers on their own', () => {
  it('take anything and answer null for what is not theirs', () => {
    assert.equal(parseFamilyMessage(undefined), null);
    assert.equal(parseWakeText(undefined), null);
    assert.equal(parsePeerPrompt(undefined), null);
  });
  it('read a peer payload that names only its body', () => {
    assert.deepEqual(parsePeerPrompt('<mopilot-peer-message>\n{"body":"hi"}\n</mopilot-peer-message>'), {
      id: '',
      sourceChatId: '',
      sourceTitle: null,
      replyTo: null,
      body: 'hi',
    });
  });
  it('read a wake-up whose roster is the only thing before the event', () => {
    const text = wakeText({ notes: [], roster: '', waiting: ['a'] });
    assert.deepEqual(parseWakeText(text), { notes: '' });
  });
});
