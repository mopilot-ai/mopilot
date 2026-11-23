// A reserved brief keeps its original folder scope; filling it rechecks other writers before any initial delivery.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orchestration, SESSION_BACKGROUND as background } from './support/orchestration-harness.ts';
const task = (title: string, paths?: string[]) => ({
  title,
  prompt: 'Complete this task',
  background,
  use_worktree: false,
  ...(paths ? { paths } : {}),
});
const reserve = async (h: any, paths?: string[]) => {
  const waiting = h.orch.start('top', { title: 'Reserved', initiation: 'offer', use_worktree: false, ...(paths ? { paths } : {}) });
  const id = Object.keys(h.journal.data.proposals)[0];
  const accepted = await h.orch.act(id, 'start', { useWorktree: false });
  await waiting;
  return { id, child: accepted.chat_id };
};
test('an awaiting brief occupies shared-folder scope before it starts running', async () => {
  const h = orchestration();
  h.userTurn();
  await reserve(h);
  await assert.rejects(h.orch.start('top', task('Another')), { code: 'paths_required' });
  assert.equal(h.log.filter((l: any) => l[0] === 'startCodex').length, 1);
});
test('reserved fill rejects a writer that became live meanwhile, then retries the same child; distinct paths can coexist', async () => {
  for (const overlap of [true, false]) {
    const h = orchestration();
    h.userTurn();
    const p = await reserve(h, ['a/**']);
    h.records.set('other', { meta: {} });
    h.journal.change(
      (d: any) =>
        (d.children.other = {
          parentId: 'top',
          name: 'other',
          title: 'Other',
          cwd: '/repo',
          paths: [overlap ? 'a/**' : 'b/**'],
          useWorktree: false,
          createdAt: 0,
          driven: [],
          lastReport: null,
        }),
    );
    h.states.set('other', { turn: 'running' });
    const fill = () => h.orch.start('top', { proposal_id: p.id, prompt: 'Do reserved work', background });
    if (overlap) {
      await assert.rejects(fill(), { code: 'paths_overlap' });
      assert.equal(h.journal.proposal(p.id).status, 'briefing');
      assert.equal(h.log.filter((l: any) => l[0] === 'send').length, 0);
      h.states.set('other', { turn: 'idle' });
    }
    assert.equal((await fill()).chat_id, p.child);
    assert.equal(h.log.filter((l: any) => l[0] === 'startCodex').length, 1);
  }
});
