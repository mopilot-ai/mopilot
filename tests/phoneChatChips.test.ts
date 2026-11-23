// The chat list's chips: the state a chat is in for the user, and the agent's name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatChips, harnessChip } from '../mobile/src/presentation/chatChips';
import { answeredElsewhere, CARD_ANSWERED } from '../shared/remote/cardAnswered.mjs';

test('the state chip: running, needs you, done only when unopened, else idle', () => {
  assert.deepEqual(chatChips({ state: 'running', harness: 'codex' }), { state: 'running', stateLabel: 'Running', harness: 'Codex' });
  // a chat waiting for the user outranks everything else about it
  assert.equal(chatChips({ state: 'waiting', unread: true }).stateLabel, 'Needs you');
  assert.equal(chatChips({ state: 'running', unread: true }).stateLabel, 'Running');
  assert.equal(chatChips({ state: 'idle', unread: true }).stateLabel, 'Done');
  assert.equal(chatChips({ state: 'idle', unread: false }).stateLabel, 'Idle');
  // an older Mac sends no state and no unread flag
  assert.deepEqual(chatChips({}), { state: 'idle', stateLabel: 'Idle', harness: null });
  assert.equal(chatChips({ state: 'something new' }).state, 'idle');
});

test('the harness chip names the built-in agents and an added one by its id', () => {
  assert.equal(harnessChip('claude'), 'Claude Code');
  assert.equal(harnessChip('acp:gemini-cli'), 'Gemini cli');
  assert.equal(harnessChip('acp:'), null);
  assert.equal(harnessChip(''), null);
  assert.equal(harnessChip(undefined), null);
  assert.equal(harnessChip(5), null);
});

test('an answered-elsewhere refusal is told apart from every other failure', () => {
  assert.equal(answeredElsewhere(new Error(CARD_ANSWERED)), true);
  assert.equal(answeredElsewhere(new Error('Finish this on your Mac.')), false);
  assert.equal(answeredElsewhere(CARD_ANSWERED), false);
});
