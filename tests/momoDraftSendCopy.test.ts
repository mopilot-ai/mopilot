// The words around a draft's Send (src/components/momo/draftSendCopy.ts): the line above the card is built from only what the draft and the account give it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leadWords } from '../src/components/momo/draftSendCopy.ts';

test('the line above the card leaves out what is not there', () => {
  assert.equal(
    leadWords({ to: ['a@b.co', 'c@d.co'], subject: 'Hi' }, 'x@mail.test'),
    'Draft email to a@b.co, c@d.co with subject Hi, from x@mail.test.',
  );
  assert.equal(leadWords({ to: [], subject: '' }, ''), 'Draft email.');
  assert.equal(leadWords({ to: ['a@b.co'], subject: '' }, 'x@mail.test'), 'Draft email to a@b.co, from x@mail.test.');
});
