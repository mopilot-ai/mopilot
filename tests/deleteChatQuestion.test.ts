// The question before a chat is deleted for good (src/lib/deleteChatQuestion.ts): a chat of this Mac as always; a chat on a machine says it goes there too, by the agent it runs on now, and what that agent keeps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deleteChatQuestion, deleteMachineName } from '../src/lib/deleteChatQuestion.ts';

const ASKED = 'Permanently delete this chat here and on Studio? This cannot be undone.';

test('a chat of this Mac asks the old question; Claude Code on a machine asks only for both ends; Codex and another agent say what stays, in one short sentence', () => {
  assert.equal(deleteChatQuestion(null, 'kimi'), 'Permanently delete this chat? This cannot be undone.');
  assert.equal(deleteChatQuestion('Studio', 'claude'), ASKED);
  assert.equal(deleteChatQuestion('Studio', 'codex'), `${ASKED} Codex may keep a copy.`);
  assert.equal(deleteChatQuestion('Studio', 'kimi'), `${ASKED} The agent keeps its own history.`);
  // an agent id that is also a name on Object's prototype is just another agent
  assert.equal(deleteChatQuestion('Studio', 'constructor'), `${ASKED} The agent keeps its own history.`);
});

test('the machine is named as its row writes it; one not listed, one not read yet, and a machine chat id with no owner yet are still a machine; only a chat of this Mac is none', () => {
  const chat = 'acp:kimi:1';
  assert.equal(deleteMachineName(chat, { name: 'Studio', row: {} }, false), 'Studio');
  assert.equal(deleteMachineName(chat, { name: 'ssh:me@studio' }, false), 'its machine');
  assert.equal(deleteMachineName(chat, null, true), 'its machine');
  assert.equal(deleteMachineName('acp:host-claude:u1', null, false), 'its machine');
  assert.equal(deleteMachineName('acp:host-codex:u1', null, false), 'its machine');
  assert.equal(deleteMachineName(chat, null, false), null);
});
