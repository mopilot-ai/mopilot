// A Stop that comes while a Codex turn is starting (turn/start already sent, the turn still a `pending-` token) is carried out once the turn has its id, whether turn/start's answer or the turn/started notification names it first (ChatController.stopIfAsked, #4607 matrix run: chat.stop on a Host's Codex turn ran to its normal end).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, tick } from './support/controller/fixture';

/** A controller whose Codex adapter starts turns when the test says and records what each stopTurn was asked to interrupt. */
function chat() {
  const fx = setup({ auto: false });
  const stopped: (string | undefined)[] = [];
  fx.c.codex.stopTurn = async (chatId: string) => {
    stopped.push(fx.s(chatId).activeTurn?.id);
    return true;
  };
  return { ...fx, stopped };
}

test('Stop while the turn is a token: turn/start’s answer names it, and the Stop is carried out with that id', async () => {
  const { c, s, execs, stopped } = chat();
  c.send('cx1', { id: 'm1', text: 'count' }, 1);
  await tick();
  // turn/start is out; the stop finds only the token
  assert.equal(await c.stopChat('cx1'), true);
  assert.deepEqual(stopped, ['pending-m1']);
  execs[0].done({ started: true, turnId: 'native-1' });
  await tick();
  assert.deepEqual(stopped, ['pending-m1', 'native-1']);
  assert.equal(s('cx1').activeTurn?.id, 'native-1');
});

test('Stop while the turn is a token and turn/started names it later: the Stop is carried out then, once', async () => {
  const { c, s, execs, stopped } = chat();
  c.send('cx1', { id: 'm1', text: 'count' }, 1);
  await tick();
  await c.stopChat('cx1');
  execs[0].done({ started: true });
  await tick();
  assert.deepEqual(stopped, ['pending-m1']);
  c.onCodexMessage?.({ method: 'turn/started', params: { threadId: 'cx1', turn: { id: 'native-2' } } });
  await tick();
  assert.deepEqual(stopped, ['pending-m1', 'native-2']);
  // the same Stop is not carried out twice
  c.onCodexMessage?.({ method: 'turn/started', params: { threadId: 'cx1', turn: { id: 'native-2' } } });
  await tick();
  assert.equal(stopped.length, 2);
  assert.equal(s('cx1').activeTurn?.id, 'native-2');
});

test('no Stop since the turn began: nothing is interrupted when it is named', async () => {
  const { c, execs, stopped } = chat();
  c.send('cx1', { id: 'm1', text: 'count' }, 1);
  await tick();
  execs[0].done({ started: true, turnId: 'native-3' });
  await tick();
  assert.deepEqual(stopped, []);
});

test('a Stop that fails to reach Codex is noted and does not break the turn’s start', async () => {
  const { c, s, execs } = chat();
  c.codex.stopTurn = async () => {
    throw new Error('app-server gone');
  };
  c.send('cx1', { id: 'm1', text: 'count' }, 1);
  await tick();
  await c.stopChat('cx1').catch(() => undefined);
  execs[0].done({ started: true, turnId: 'native-4' });
  await tick();
  assert.equal(s('cx1').activeTurn?.id, 'native-4');
});

test('a turn that began with no count taken is nobody’s Stop to carry out', async () => {
  const { c, stopped } = chat();
  c.noteStop('cx9');
  c.stopIfAsked('cx9');
  assert.deepEqual(stopped, []);
});
