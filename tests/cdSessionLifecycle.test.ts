// Parent-family archive choices retain independent children and recheck changing activity after each await.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { orchestration, SESSION_BACKGROUND as background } from './support/orchestration-harness.ts';
const require = createRequire(import.meta.url);
const { archiveFamily, attention, detach } = require('../electron/session/orchestration/lifecycle.cjs');
const task = (title: string) => ({ title, use_worktree: false, prompt: 'Complete the assigned task', background });
async function family(over: any = {}) {
  const h = orchestration(over);
  h.userTurn();
  const a = await h.orch.start('top', task('Quiet'));
  const b = await h.orch.start('top', task('Attention'));
  h.states.set('top', { turn: 'idle' });
  return { ...h, a: a.chat_id, b: b.chat_id };
}

test('quiet descendants archive with the parent, including nested children', async () => {
  const h = await family();
  h.userTurn(h.a);
  const nested = await h.orch.start(h.a, task('Nested'));
  h.states.set(h.a, { turn: 'idle' });
  const result = await archiveFamily(h.orch, 'top');
  assert.deepEqual(new Set(result.archived), new Set(['top', h.a, h.b, nested.chat_id]));
  assert.equal(result.needsChoice, false);
  assert.deepEqual(result.remaining, []);
});

test('Archive this session preserves both quiet and attention children; all stops and archives the whole family', async () => {
  for (const mode of ['parent', 'all']) {
    const h = await family();
    h.states.set(h.b, { turn: 'running' });
    const before = await archiveFamily(h.orch, 'top');
    assert.equal(before.needsChoice, true);
    assert.equal(before.working, 1);
    assert.deepEqual(before.archived, []);
    const result = await archiveFamily(h.orch, 'top', mode);
    assert.equal(result.needsChoice, false);
    if (mode === 'parent') {
      assert.deepEqual(result.archived, ['top']);
      assert.deepEqual(new Set(result.remaining), new Set([h.a, h.b]));
      assert.equal(h.journal.child(h.a).detached, true);
      assert.equal(h.journal.child(h.b).detached, true);
      assert.equal(
        h.log.some((l: any) => l[0] === 'stopChat'),
        false,
      );
    } else {
      assert.deepEqual(result.remaining, []);
      assert.deepEqual(new Set(result.archived), new Set(['top', h.a, h.b]));
      assert.equal(
        h.log.some((l: any) => l[0] === 'stopChat' && l[1] === h.b),
        true,
      );
    }
  }
});

test('attention includes each real hold but not a completed goal or merged PR', async () => {
  const h = await family();
  for (const state of [
    { turn: 'running' },
    { turn: 'awaitingUser' },
    { queue: [{}] },
    { approvals: [{}] },
    { pendingSwitch: {} },
    { goal: { status: 'working' } },
  ]) {
    h.states.set(h.a, state);
    assert.equal(attention(h.orch, h.a), true, JSON.stringify(state));
  }
  h.states.set(h.a, { goal: { status: 'complete' } });
  assert.equal(attention(h.orch, h.a), false);
  h.states.set(h.a, { turn: 'idle' });
  for (const meta of [{ pinned: true }, { unread: true }]) {
    h.records.get(h.a).meta = meta;
    assert.equal(attention(h.orch, h.a), true);
  }
  h.records.get(h.a).meta = {};
  for (const facts of [{ uncommitted: 1 }, { pr: { state: 'OPEN' } }, { pr: { state: 'DRAFT' } }]) {
    h.journal.change((d: any) => (d.children[h.a].facts = facts));
    assert.equal(attention(h.orch, h.a), true);
  }
  h.journal.change((d: any) => (d.children[h.a].facts = { uncommitted: 0, pr: { state: 'MERGED' } }));
  assert.equal(attention(h.orch, h.a), false);
  h.journal.change((d: any) => (d.dependants[h.a] = { after: [h.b] }));
  assert.equal(attention(h.orch, h.a), true);
});

test('late activity and descendants survive an earlier stop await; failed archives remain errors', async () => {
  const h = await family();
  h.states.set(h.a, { turn: 'running' });
  h.controller.stopChat = async (id: string) => {
    h.records.delete(id);
    h.journal.change(
      (d: any) => (d.children.late = { parentId: 'top', name: 'late', title: 'Late', createdAt: 1, driven: [], lastReport: null }),
    );
    h.records.set('late', { meta: {} });
    return true;
  };
  const result = await archiveFamily(h.orch, 'top', 'all');
  assert.deepEqual(result.remaining, ['late']);
  assert.equal(h.journal.child('late').detached, true);
  assert.ok(!result.archived.includes(h.a));
  const failed = await family({ archive: () => false });
  await assert.rejects(archiveFamily(failed.orch, 'top', 'all'), (e: any) => e.code === 'archive_failed');
  await assert.rejects(archiveFamily(failed.orch, 'missing'), (e: any) => e.code === 'not_found');
  await assert.rejects(archiveFamily(failed.orch, 'top', 'bad'), (e: any) => e.code === 'invalid_action');
});

test('detach is idempotent, keeps history and removes pending parent notes', async () => {
  const h = await family();
  h.journal.change((d: any) => (d.parents.top.notes = [{ childId: h.a }, { childId: h.b }]));
  detach(h.orch, h.a);
  detach(h.orch, h.a);
  assert.deepEqual(h.journal.parent('top').notes, [{ childId: h.b }]);
  assert.ok(h.journal.child(h.a));
  assert.throws(
    () => detach(h.orch, 'missing'),
    (e: any) => e.code === 'not_linked',
  );
  h.journal.change((d: any) => delete d.parents.top);
  detach(h.orch, h.b);
});
