// A machine chat's goal on a real Host session (host/src/sessions.mjs, host/src/claudeFamily.mjs): Claude Code's own adapter runs the goal bar's action on a chat's goal and the Host answers with the goal it holds, an edit or a budget has no form there, and a message that sets a goal reaches the controller as one. It needs the Rust core (the session store), so it runs where that is built.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unsupportedGoalWords } from '../shared/codexGoals.mjs';
import { idle, keyOf, setup as claudeSetup, until } from './support/host/claudeKit.ts';

/** A Claude Code chat on a Host that has had its first turn, with the goal `status` held by its adapter, and the goal bar's action on it. */
async function claudeGoal(h: ReturnType<typeof claudeSetup>, status: string, p: any) {
  const key = keyOf();
  await h.sessions.chatRuntime.send({ key, text: 'first', cwd: h.dir });
  await idle(h, key);
  h.sessions.controller.claudeTurns.writeGoal(key, {
    objective: 'ship it',
    status,
    updatedAt: 1,
    claude: { iterations: 2, lastReason: null, limit: null },
  });
  const goal = await h.sessions.chatRuntime.goal({ chatId: key, ...p });
  await until(() => h.state(key).turn === 'idle');
  return goal as any;
}

test('W: Claude Code’s own adapter runs pause, resume, extend and clear on a chat’s goal, and the Host answers with the goal it holds', async () => {
  const h = claudeSetup();
  try {
    assert.equal((await claudeGoal(h, 'active', { action: 'pause' })).status, 'paused');
    assert.equal((await claudeGoal(h, 'paused', { action: 'resume' })).status, 'active');
    // "10 more rounds" on a goal that is not at its limit has nothing to add: the goal stays as it is
    assert.equal((await claudeGoal(h, 'active', { action: 'extend' })).status, 'active');
    assert.equal(await claudeGoal(h, 'active', { action: 'clear', human: true }), null);
  } finally {
    await h.close();
  }
});

test('B: Claude Code has no edit or budget for a goal, and a failed action is the person’s to read', async () => {
  const h = claudeSetup();
  try {
    const key = keyOf();
    await h.sessions.chatRuntime.send({ key, text: 'first', cwd: h.dir });
    await idle(h, key);
    const goal = (p: any) => h.sessions.chatRuntime.goal({ chatId: key, ...p }) as Promise<any>;
    for (const action of ['edit', 'budget'])
      await assert.rejects(
        goal({ action, objective: 'x', tokens: 1 }),
        (e: any) => e.code === 'unsupported' && e.message === unsupportedGoalWords('Claude Code', action),
      );
    h.family.claudeTurns.goalAction = async () => Promise.reject(new Error('The CLI is busy'));
    await assert.rejects(goal({ action: 'pause' }), (e: any) => e.code === 'unsupported' && e.message === 'The CLI is busy');
    h.family.claudeTurns.goalAction = async () => Promise.reject('plain');
    await assert.rejects(goal({ action: 'pause' }), (e: any) => e.message === 'plain');
  } finally {
    await h.close();
  }
});

test('W: a message that sets a goal reaches the controller as a goal of the chat’s own objective', async () => {
  const h = claudeSetup();
  try {
    const key = keyOf();
    const seen: any[] = [];
    const send = h.sessions.controller.send.bind(h.sessions.controller);
    h.sessions.controller.send = (chatId: string, item: any, ...rest: any[]) => (seen.push(item.opts), send(chatId, item, ...rest));
    await h.sessions.chatRuntime.send({ key, text: 'ship it', cwd: h.dir, goal: true });
    await idle(h, key);
    await h.sessions.chatRuntime.send({ key, text: 'hello' });
    assert.equal(seen[0].goal, 'ship it');
    assert.equal('goal' in seen[1], false);
  } finally {
    await h.close();
  }
});
