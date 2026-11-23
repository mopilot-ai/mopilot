// The side panel's line under the rows (electron/chrome-extension/src/panelThread.mjs): a turn that stopped on the account's usage limit is not "Done" (#3046).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { thread } from './support/panel-thread.ts';

const { PROGRESS } = await import('../electron/chrome-extension/src/panelThread.mjs');

test('a turn that stopped on the account’s usage limit reads "Limit reached", not "Done", until the next turn runs', async () => {
  const { t, els, reads } = thread();
  const read = async (r: any) => {
    const again = t.read();
    reads.at(-1)!.answer({ rows: [], ...r });
    await again;
  };
  const opened = t.open('c1', {});
  reads[0].answer({ rows: [{ role: 'assistant', text: 'Done.' }], state: 'idle' });
  await opened;
  assert.equal(els['progress-text'].textContent, PROGRESS.idle.text);
  // the limit note is the last row of an idle chat
  const limit = { role: 'note', text: "You've hit your monthly spend limit", limit: true };
  await read({ rows: [{ role: 'user', text: 'Pay the fee' }, limit], state: 'idle' });
  assert.equal(els['progress-text'].textContent, 'Limit reached');
  assert.equal(els['progress-dot'].className, 'dot error');
  // an update that only says the turn is idle again doesn't bring "Done" back
  t.turn('idle');
  assert.equal(els['progress-text'].textContent, 'Limit reached');
  // a limit note with rows after it (the user switched account and went on) is not the end
  await read({ rows: [limit, { role: 'assistant', text: 'Back.' }], state: 'idle' });
  assert.equal(els['progress-text'].textContent, PROGRESS.idle.text);
  assert.equal(els['progress-dot'].className, 'dot ok');
  // a running turn is running, even with the note last
  await read({ rows: [limit], state: 'running' });
  assert.equal(els['progress-text'].textContent, PROGRESS.running.text);
});

test('opening another chat does not carry the last one’s "Limit reached" over', async () => {
  const { t, els, reads } = thread();
  const first = t.open('c1', {});
  reads[0].answer({ rows: [{ role: 'note', text: 'Limit', limit: true }], state: 'idle' });
  await first;
  assert.equal(els['progress-text'].textContent, 'Limit reached');
  // the next chat reads Done at once, before its own first read answers
  const second = t.open('c2', { state: 'idle' });
  assert.equal(els['progress-text'].textContent, PROGRESS.idle.text);
  reads[1].answer({ rows: [], state: 'idle' });
  await second;
  assert.equal(els['progress-text'].textContent, PROGRESS.idle.text);
});
