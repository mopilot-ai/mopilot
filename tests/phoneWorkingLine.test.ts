// The chat's working line words, the "Worked" line, the last turn's copy and retry text.
import assert from 'node:assert/strict';
import { test } from 'node:test';
const lineMod = '../mobile/src/presentation/workingLine';
const { workingWords, shortDuration, workedWords, tailOf, lastTurn } = await import(lineMod);

test('the working line names the running step, says nothing while the reply is written, and thinks longer and longer', () => {
  assert.equal(workingWords({ type: 'step', kind: 'read' }, 0), 'Reading files');
  assert.equal(workingWords({ type: 'step', kind: 'search' }, 0), 'Searching');
  assert.equal(workingWords({ type: 'step', kind: 'edit' }, 0), 'Editing');
  assert.equal(workingWords({ type: 'step', kind: 'run' }, 0), 'Running');
  assert.equal(workingWords({ type: 'step', kind: 'web' }, 0), 'Searching the web');
  assert.equal(workingWords({ type: 'step', kind: 'other' }, 99_000), 'Working');
  assert.equal(workingWords({ type: 'reply' }, 0), '');
  assert.equal(workingWords({ type: 'you' }, 0), 'Thinking…');
  assert.equal(workingWords({ type: 'none' }, 5_999), 'Thinking…');
  assert.equal(workingWords({ type: 'you' }, 6_000), 'Thinking more…');
  assert.equal(workingWords({ type: 'you' }, 15_000), 'Thinking some more…');
  assert.equal(workingWords({ type: 'you' }, 40_000), 'Still thinking…');
});

test('the Worked line gives a compact time only when the phone measured one', () => {
  assert.equal(shortDuration(999), null);
  assert.equal(shortDuration(6_400), '6s');
  assert.equal(shortDuration(80_000), '1m 20s');
  assert.equal(shortDuration(3_720_000), '1h 2m');
  assert.equal(workedWords(80_000), 'Worked 1m 20s');
  assert.equal(workedWords(500), 'Worked');
  assert.equal(workedWords(null), 'Worked');
  assert.equal(workedWords(undefined), 'Worked');
});

test('the tail is what ends the transcript', () => {
  assert.deepEqual(tailOf([]), { type: 'none' });
  assert.deepEqual(tailOf([{ role: 'user', text: 'a' }]), { type: 'you' });
  assert.deepEqual(tailOf([{ role: 'liveUser', text: 'a' }]), { type: 'you' });
  assert.deepEqual(tailOf([{ role: 'assistant', text: 'a' }]), { type: 'reply' });
  assert.deepEqual(tailOf([{ role: 'preview', text: 'a' }]), { type: 'reply' });
  assert.deepEqual(tailOf([{ role: 'live', text: 'a', kind: 'run' }]), { type: 'step', kind: 'run' });
  assert.deepEqual(tailOf([{ role: 'step', text: 'a' }]), { type: 'step', kind: 'other' });
  assert.deepEqual(tailOf([{ role: 'something', text: 'a' }]), { type: 'none' });
});

test('the last turn is your last message and every reply after it', () => {
  const rows = [
    { role: 'user', text: 'old' },
    { role: 'assistant', text: 'old reply' },
    { role: 'user', text: 'Fix it' },
    { role: 'step', text: 'Ran ls' },
    { role: 'assistant', text: 'First.' },
    { role: 'assistant', text: '  ' },
    { role: 'preview', text: 'Second.' },
  ];
  assert.deepEqual(lastTurn(rows), { you: 'Fix it', reply: 'First.\n\nSecond.' });
  assert.deepEqual(lastTurn([{ role: 'assistant', text: 'Hi' }]), { you: null, reply: 'Hi' });
  assert.deepEqual(lastTurn([{ role: 'user', text: ' ' }]), { you: null, reply: null });
});
