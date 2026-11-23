// What the Claude Code family does with the goal bar's action (host/src/claudeFamily.mjs `goal`, `chat.goal`): the app's own adapter runs pause, resume, extend and clear and the Host answers with the goal its store holds now; a Codex goal's edit and budget have no form here; a failed action is the person's to read. The family stands over a stand-in store, so no Rust core is needed (the real adapter on a real session is hostChatGoal.test.ts).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createClaudeFamily } from '../host/src/claudeFamily.mjs';
import { installElectronPorts } from '../host/src/electronPorts.mjs';
import { unsupportedGoalWords } from '../shared/codexGoals.mjs';

// the app's own adapter reads its paths from the ports an Electron app has: this process has none of its own
const restore = installElectronPorts({ paths: { dataDir: '/data', configDir: '/data/config' }, openExternal: async () => undefined });
after(restore);

/** The family over stand-ins: `held` is the chat's goal in the store, `asked` what the adapter was told to do. */
function family(held: any = null) {
  const store: any = { goal: held };
  const ctx: any = {
    paths: { dataDir: '/data' },
    env: {},
    state: { publish: () => undefined, get: () => store, patch: () => true, has: () => true, all: () => [] },
    chats: { records: new Map(), get: () => null, patchMeta: () => undefined },
    controller: () => ({ ref: () => ({ kind: 'claude' }), chatOf: (k: string) => k }),
    emit: () => undefined,
    log: () => undefined,
  };
  const made = createClaudeFamily({ sdk: async () => ({}) })(ctx);
  const asked: any[][] = [];
  made.claudeTurns.goalAction = async (...a: any[]) => void asked.push(a);
  return { made, asked, store };
}

test('W: each action of the goal bar is the adapter’s goal button, and the answer is the goal the store holds after it', async () => {
  const s = family({ objective: 'ship it', status: 'paused' });
  for (const action of ['pause', 'resume', 'extend']) assert.deepEqual(await s.made.goal({ chatId: 'claude:c', action }), s.store.goal);
  // the person typed the clear: the adapter is told, so its own /goal clear keeps the person as the author
  s.store.goal = null;
  assert.equal(await s.made.goal({ chatId: 'claude:c', action: 'clear', human: true }), null);
  await s.made.goal({ chatId: 'claude:c', action: 'clear' });
  assert.deepEqual(s.asked, [
    ['claude:c', 'pause', false],
    ['claude:c', 'resume', false],
    ['claude:c', 'extend', false],
    ['claude:c', 'clear', true],
    ['claude:c', 'clear', false],
  ]);
});

test('B: Claude Code has no edit or budget for a goal, and says so before the adapter is asked anything', async () => {
  const s = family({ objective: 'ship it', status: 'active' });
  for (const action of ['edit', 'budget'])
    await assert.rejects(
      s.made.goal({ chatId: 'claude:c', action }),
      (e: any) => e.code === 'unsupported' && e.message === unsupportedGoalWords('Claude Code', action),
    );
  assert.deepEqual(s.asked, []);
});

test('B: an action the adapter fails is refused with its own words, whether it throws an error or something else', async () => {
  const s = family({ objective: 'ship it', status: 'active' });
  s.made.claudeTurns.goalAction = async () => Promise.reject(new Error('The CLI is busy'));
  await assert.rejects(
    s.made.goal({ chatId: 'claude:c', action: 'pause' }),
    (e: any) => e.code === 'unsupported' && e.message === 'The CLI is busy',
  );
  s.made.claudeTurns.goalAction = async () => Promise.reject('plain');
  await assert.rejects(s.made.goal({ chatId: 'claude:c', action: 'pause' }), (e: any) => e.message === 'plain');
  // a chat with no goal in the store answers with none
  s.store.goal = undefined;
  s.made.claudeTurns.goalAction = async () => undefined;
  assert.equal(await s.made.goal({ chatId: 'claude:c', action: 'resume' }), null);
});
