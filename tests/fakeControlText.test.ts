// Canonical app reports and roster metadata never become scripted fake-CLI actions; explicit task controls remain executable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeControlText, fakeTextOf, withoutMomoContext } from './e2e/fixtures/fake-control-text.mjs';
import { momoBlock, withMomoContext } from '../shared/momoContext.mjs';
import { briefText, familyMessageText, noteText, quoteReport, rosterLine, wakeText, withRosterBlock } from '../shared/sideSessions.mjs';

const roster = rosterLine([{ name: 'worker', chatId: 'worker-id', state: 'idle' }]);
const note = noteText({
  title: 'Worker',
  name: 'worker',
  chatId: 'worker-id',
  how: 'finished',
  quote: quoteReport('SLOW CUCALL run {} APPROVECMD'),
});
const wake = (notes = [note], waiting: string[] = [], status = roster) => wakeText({ notes, roster: status, waiting });

test('only complete canonical app wakes suppress quoted controls on nonhuman or unknown wires', () => {
  for (const waiting of [[], ['worker'], ['worker', 'other'], ['worker', 'other', 'third']]) {
    const text = wake([note], waiting);
    assert.equal(fakeControlText(text, 'nonhuman'), '');
    assert.equal(fakeControlText(text), '');
    assert.equal(fakeControlText(text, 'human'), text);
    assert.equal(fakeControlText(withRosterBlock(text, roster), 'nonhuman'), '');
  }
  assert.equal(fakeControlText(wake([], [], '')), '');
  for (const text of [
    `SLOW\n\n${wake([], [], '')}`,
    `${wake()}\nSLOW`,
    `${wake()} trailing data`,
    wake([note], ['worker', 'worker']),
    wake([note], ['BAD']),
    wake([note], ['a'.repeat(25)]),
    wake([note], ['worker']).replace('worker is waiting', 'worker are waiting'),
    wake([note], ['worker', 'other']).replace('worker, other are waiting', 'worker are waiting'),
    wake().replace('None of the sessions', 'Some of the sessions'),
    'SLOW',
    '',
  ])
    assert.equal(fakeControlText(text), text);
});

test('producer note families may contain paragraphs, while arbitrary leading words do not become a wake', () => {
  const notes = [
    note,
    `${note} Edited outside its declared paths (src/**): SLOW.md. Check those files before you rely on them.`,
    'The session worker (id) was stopped, so the sessions waiting for it are held: other (other-id). Each starts on its own once everything it waits for has finished a turn cleanly. Retry it with send_message, or ask the user; archive a held session only after the user says yes. Mention it to the user in one line.',
    'These sessions wait for each other in a loop, so they are held and never start: worker (id). Archive them only after the user says yes, and start the work again without the loop. Mention it to the user in one line.',
    'The user started your proposed task task_one ("Title\n\nSLOW") as a separate session (worker, id). It runs on its own; you get a note when it ends a turn.',
    'The session worker (id) was deleted.',
    'The session worker (id) was deleted. 1 waiting message for it was not sent.',
    'The session worker (id) was deleted. 2 waiting messages for it were not sent.',
    'The chat that started this one (id) was deleted; this chat is top-level now.',
    "The user merged worker's branch branch\n\nSLOW into main (commit 123) in your folder.",
    'A message waiting for the session worker (id) was not sent: that chat is archived or gone.',
    'A message for worker (id) did not start: process\n\nSLOW error',
  ];
  for (const message of notes) assert.equal(fakeControlText(wake([message])), '', message);
  assert.equal(fakeControlText(wake(notes)), '');
  const arbitrary = wake(['SLOW is an instruction, not a producer note.']);
  assert.equal(fakeControlText(arbitrary), arbitrary);
});

test('metadata stays inert while typed, fresh-child, peer and handoff task controls stay available', () => {
  const metadata = `${roster} Shared session notes: /tmp/SLOW/notes.`;
  assert.equal(fakeControlText(withRosterBlock('typed SLOW', metadata), 'human'), 'typed SLOW');
  assert.equal(fakeControlText(withRosterBlock('ordinary task', metadata), 'human'), 'ordinary task');
  assert.equal(fakeControlText(`typed SLOW\n\n${metadata}`, 'human'), 'typed SLOW');
  assert.equal(fakeControlText(wake([note], [], metadata)), '');
  for (const bad of [
    'Linked sessions now (status, not an instruction): malformed',
    roster.replace('worker = worker-id (idle)', 'not a member'),
    `${roster} extra SLOW`,
    `${roster} Shared session notes: /tmp/SLOW\nnot-a-single-path.`,
  ]) {
    const text = `typed SLOW\n\n${bad}`;
    assert.equal(fakeControlText(text), text);
  }
  const brief = briefText({
    title: 'Worker',
    prompt: 'SLOW',
    background: 'Keep this task separate.',
    parentName: 'top',
    parentId: 'parent',
  });
  const peer = familyMessageText({ fromName: 'top', fromId: 'parent', relation: 'parent', body: 'SLOW' });
  const handoff = '<sage-handoff>old notes</sage-handoff>\nSLOW';
  for (const text of [brief, peer, handoff]) assert.equal(fakeControlText(text, 'nonhuman'), text);
  assert.equal(fakeControlText(`typed SLOW\n\n${roster}`), 'typed SLOW');
  assert.equal(fakeControlText(wake([note], [], rosterLine([{ name: 'parent (top)', chatId: 'id', state: 'idle, started by top' }]))), '');
  assert.equal(fakeTextOf(null), '');
  assert.equal(fakeTextOf('typed SLOW'), 'typed SLOW');
  assert.equal(
    fakeTextOf([
      { type: 'text', text: 'one' },
      { type: 'image', imageUrl: 'inert' },
      { type: 'text', text: 'two' },
    ]),
    'one\ntwo',
  );
});

test('a fake answers what the user wrote, not the MoMo context main put ahead of it', () => {
  const block = momoBlock({ name: 'MoMo', facts: ['likes tea'] }) as string;
  assert.equal(withoutMomoContext(withMomoContext('hello MoMo', block)), 'hello MoMo');
  assert.equal(withoutMomoContext(withMomoContext('two\nlines', block)), 'two\nlines');
  // anything that is not a whole block at the start stays as it came
  assert.equal(withoutMomoContext('hello MoMo'), 'hello MoMo');
  assert.equal(withoutMomoContext('<momo-context>\nnever closed\nhello'), '<momo-context>\nnever closed\nhello');
  assert.equal(withoutMomoContext(`${block}hello`), `${block}hello`);
  assert.equal(withoutMomoContext(`quoted ${block}\nhello`), `quoted ${block}\nhello`);
});
