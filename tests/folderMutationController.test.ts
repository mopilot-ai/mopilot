// A linked-session merge holds its parent chat's folder: new input queues, direct starts wait, and both resume after release.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setup } from './support/controller-coverage/setup.ts';
import { tick } from './support/async-scenarios.ts';

const require = createRequire(import.meta.url);
const { acquireFolderMutation } = require('../electron/session/folderMutation.cjs');
const { queueItem } = require('../electron/session/controller.cjs');

test('a folder merge holds new input and drains it after release on every harness', async () => {
  const { c, state, log } = setup({ ids: ['cx1', 'cl1', 'acp1'] });
  for (const id of ['cx1', 'cl1', 'acp1']) {
    const release = acquireFolderMutation(c, id, () => c.drain(id));
    assert.ok(release);
    assert.equal(acquireFolderMutation(c, id), null);
    assert.equal(c.send(id, { id: `q-${id}`, text: 'hello' }).action, 'queued');
    assert.equal(c.sendNow(id, `q-${id}`), true);
    assert.deepEqual(c.sendNow(id, `q-${id}`, null, true), { status: 'queued' });
    assert.equal(c.sendNow(id, 'missing'), false);
    assert.deepEqual(c.sendNow(id, 'missing', null, true), { status: 'missing' });
    assert.equal(state.get(id).queue.length, 1);
    assert.equal(log.length, 0);
    release();
    await tick();
    assert.equal(state.get(id).queue.length, 0);
    assert.equal(log.length, 1);
    log.length = 0;
  }
  assert.equal(acquireFolderMutation(c, 'cx1'), null);
});

test('a direct start waits for a merge and respects stop while waiting', async () => {
  const { c, log } = setup();
  const release = acquireFolderMutation(c, 'cx1', () => c.drain('cx1'));
  const start = c.start('cx1', queueItem({ text: 'later' }));
  c.noteStop('cx1');
  release();
  assert.equal((await start).started, false);
  assert.equal(log.length, 0);
});

test('direct starts resume after the merge and yield to a turn that started meanwhile', async () => {
  const first = setup();
  const release = acquireFolderMutation(first.c, 'cx1');
  const start = first.c.start('cx1', queueItem({ text: 'later' }));
  release();
  assert.equal((await start).started, true);
  const second = setup();
  const release2 = acquireFolderMutation(second.c, 'cx1');
  const other = second.c.start('cx1', queueItem({ text: 'later' }));
  second.state.patch('cx1', { turn: 'running' });
  release2();
  assert.equal((await other).started, false);
});

test('steering input is queued while a folder merge holds the chat', async () => {
  const { c, state } = setup();
  const release = acquireFolderMutation(c, 'cx1');
  const result = c.send('cx1', { id: 'steer', text: 'hello', followUp: 'steer' });
  assert.equal(result.action, 'queued');
  assert.equal(state.get('cx1').queue[0].id, 'steer');
  assert.equal((await c.send('cx1', { id: 'second', text: 'next' }, null, true)).action, 'queued');
  release();
});
