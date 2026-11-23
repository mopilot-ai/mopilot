// electron/session/controllerSends.cjs: a message that waits in a chat's queue behind its running turn reaches onQueued
// (the orchestrator reads the user's own as their word to that turn, as one steered in is); a message that starts a
// turn or steers into it does not, and a harness that can't steer queues even one meant to steer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, tick } from './support/controller/fixture';

test('a message queued behind a running turn reaches onQueued; one that starts a turn or steers does not', async () => {
  const { c, execs, s } = setup({ auto: false });
  const queued: any[] = [];
  c.onQueued = (chatId: string, item: any) => queued.push([chatId, item.text, item.opts.human === true]);
  c.send('t1', { text: 'first', opts: { human: true } }, 1);
  execs[0].done({ started: true, turnId: 'turn-1' });
  await tick();
  assert.equal(s('t1').turn, 'running');
  assert.deepEqual(queued, [], 'a message that starts a turn waits for nothing');
  // one meant to steer goes into the running turn, which sees it
  assert.equal(c.send('t1', { text: 'also this', opts: { human: true }, followUp: 'steer' }, 1).action, 'steered');
  assert.deepEqual(queued, []);
  // a follow-up the user queued waits behind the turn
  assert.equal(c.send('t1', { text: 'after that', opts: { human: true } }, 1).action, 'queued');
  assert.deepEqual(queued, [['t1', 'after that', true]]);
  // one sent waiting for its receipt is told it waits, and reaches the hook the same way
  assert.equal((await c.send('t1', { text: 'and this', opts: { human: true } }, 1, true)).action, 'queued');
  assert.deepEqual(queued.at(-1), ['t1', 'and this', true]);
  // an ACP harness can't steer: even a message meant to steer waits behind its turn
  c.send('acp:kimi:g1', { text: 'start', opts: { human: true } }, 1);
  execs.at(-1)!.done({ started: true, turnId: 'acp-turn-1' });
  await tick();
  assert.equal(c.send('acp:kimi:g1', { text: 'wait, do X first', opts: { human: true }, followUp: 'steer' }, 1).action, 'queued');
  assert.deepEqual(queued.at(-1), ['acp:kimi:g1', 'wait, do X first', true]);
});
