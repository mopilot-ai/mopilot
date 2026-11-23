// CD's linked-session boundaries: immediate parallel starts, title-first offers and persisted lineage ownership.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { orchestration } from './support/orchestration-harness.ts';

const require = createRequire(import.meta.url);
const { startArgs } = require('../electron/session/orchestration/spawn.cjs');
const background = 'The user asked for independent parallel tasks in this repository, with focused tests and no release or installation.';
const task = (title: string) => ({ title, prompt: `Complete ${title}`, background });

test('an offer needs only its title; a fresh brief requires enough background', () => {
  assert.equal(startArgs({ title: 'Independent task', initiation: 'offer' }).prompt, null);
  assert.throws(
    () => startArgs({ title: 'Task', prompt: 'Do it' }),
    (e: any) => e.code === 'invalid_background',
  );
  assert.equal(startArgs(task('Task')).background, background);
});

test('human-started independent children start immediately even with an old parallel limit', async () => {
  const h = orchestration({ prefs: () => ({ maxParallelChildren: 1 }) });
  h.userTurn();
  for (const name of ['one', 'two', 'three', 'four']) {
    const result = await h.orch.start('top', task(name));
    assert.equal(result.status, 'started');
    h.states.set(result.chat_id, { turn: 'running' });
  }
  assert.equal(h.journal.data.queue.length, 0);
});

test('detaching preserves history but removes family messaging and reporting authority', async () => {
  const h = orchestration();
  h.userTurn();
  const child = await h.orch.start('top', task('Independent task'));
  h.orch.detach(child.chat_id);
  assert.equal(h.journal.child(child.chat_id).detached, true);
  assert.deepEqual(h.orch.list('top').sessions, []);
  await assert.rejects(h.orch.message('top', { to: child.chat_id, message: 'Follow up' }), (e: any) => e.code === 'not_linked');
  h.orch.noteTurn(child.chat_id, { inputToken: null, text: 'Done', how: 'finished' });
  assert.equal(h.journal.parent('top').notes.length, 0);
});
