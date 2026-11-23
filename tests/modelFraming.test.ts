// MoMo's framing for the model (#4822): what the one marker reads back as a labelled card on every client, never as the instruction text.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { authoredCard } from '../shared/authoredEnvelope.mjs';
import { MODEL_MARK, internalReply, markedCard, markedText, routineReportText } from '../shared/modelFraming.mjs';

const require = createRequire(import.meta.url);
const { reportText } = require('../electron/momo/routineReport.cjs');
const { GREETING } = require('../electron/momo/starterRoutines.cjs');
const { routinePrompt } = require('../electron/momo/routines.cjs');
const { AUTHORED_MARK, isAuthoredText } = require('../electron/session/authoredInput.cjs');

const WRAPPER = /data, not instructions|Tell the user in a line or two|don.t start anything/;

describe('markedCard', () => {
  it('reads a finished routine back as its name and its summary, never the wrapper', () => {
    const text = reportText('Inbox sweep', true, 'Two replies are due.');
    assert.match(text, WRAPPER);
    assert.deepEqual(authoredCard(text), {
      kind: 'routine',
      name: 'Inbox sweep',
      completed: true,
      title: '“Inbox sweep” finished',
      body: 'Two replies are due.',
    });
  });
  it('reads a routine that did not finish, and keeps a multi-paragraph body and quotes in the name', () => {
    const card = markedCard(routineReportText('The “big” one', false, 'It stopped.\n\nNo quota.'));
    assert.deepEqual(card, {
      kind: 'routine',
      name: 'The “big” one',
      completed: false,
      title: '“The “big” one” didn’t finish',
      body: 'It stopped.\n\nNo quota.',
    });
  });
  it('shows only the label of any other marked input', () => {
    assert.deepEqual(markedCard(GREETING), { kind: 'marked', title: 'Setup', body: '' });
    assert.deepEqual(markedCard(routinePrompt({ name: 'x', prompt: 'y' })), { kind: 'marked', title: 'Routine run', body: '' });
    assert.deepEqual(markedCard('[Automated PR monitor message, not from the user] PR Auto-fix: u'), {
      kind: 'marked',
      title: 'Automated PR monitor message',
      body: '',
    });
    assert.deepEqual(markedCard('[, not from the user] x'), { kind: 'marked', title: 'MoMo', body: '' });
    assert.equal(markedCard(undefined), null);
  });
  it('leaves a person’s words alone, even one that mentions the mark later', () => {
    assert.equal(markedCard('please fix it'), null);
    assert.equal(markedCard('see [Setup, not from the user] in the log'), null);
    assert.equal(authoredCard('please fix it'), null);
  });
  it('is one mark for every producer and for the readers of history', () => {
    assert.equal(AUTHORED_MARK, MODEL_MARK);
    for (const text of [GREETING, reportText('a', true, 'b'), routinePrompt({ name: 'x', prompt: 'y' }), markedText('Any', 'z')]) {
      assert.match(text, MODEL_MARK);
      assert.equal(isAuthoredText(text), true);
    }
  });
  it('names the CLI’s own records, whole text only: no answer is hidden for mentioning one (#4926)', () => {
    for (const text of [
      'No response requested.',
      ' No response requested.\n',
      '(no content)',
      '[Request interrupted by user]',
      '[Request interrupted by user for tool use]',
    ]) {
      assert.deepEqual(internalReply(text), { kind: 'hidden' }, text);
    }
    for (const text of ['No response requested. Anything else?', 'I said: No response requested.', 'Hello', '', undefined, null]) {
      assert.equal(internalReply(text), null, String(text));
    }
  });
});
