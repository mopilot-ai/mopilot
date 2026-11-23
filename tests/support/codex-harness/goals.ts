// Codex harness goals unit cases with shared server and session fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { thread, setup } from './fixture';

export function registerGoalsCases() {
  test('pauseFirst resumes an unloaded thread when the app-server will not set its goal, and reports no goal as paused', async () => {
    const { a, server } = setup({
      'thread/goal/set': (_p: any, n: number) => {
        if (n === 1) throw new Error('thread not loaded');
        return {};
      },
    });
    const r = await a.pauseFirst('t1');
    assert.deepEqual(r, {});
    assert.deepEqual(
      server.methods().filter((m: string) => m.startsWith('thread/')),
      ['thread/goal/set', 'thread/resume', 'thread/goal/set'],
    );
    assert.equal(a.goals.get('t1'), 'paused');
  });

  test('pauseFirst on a held thread fails at once and restores what was recorded', async () => {
    const { a, server, store } = setup(
      {
        'thread/goal/set': () => {
          throw new Error('nope');
        },
      },
      { goals: {} },
    );
    a.hold('t2', null);
    await assert.rejects(a.pauseFirst('t2', 'quit'), /nope/);
    assert.equal(a.goals.get('t2'), 'active');
    assert.deepEqual(store.goals, { t2: { status: 'active', objective: null } });
    assert.ok(!server.methods().includes('thread/resume'));
  });

  test('noteGoal keeps an objective and a quit reason it already had, skips unchanged writes, survives a failing store', async () => {
    const { a, store, clock } = setup({}, { goals: null });
    a.noteGoal(null, { status: 'active' });
    assert.equal(store.writes, 0);
    a.noteGoal('t', { status: 'active', objective: 'ship' });
    assert.deepEqual(store.goals, { t: { status: 'active', objective: 'ship' } });
    a.noteGoal('t', { status: 'active' });
    assert.equal(store.writes, 1);
    a.noteGoal('u', { status: 'active' });
    assert.equal((store.goals as any).u.objective, null);
    a.noteGoal('t', { status: 'paused' }, 'quit');
    assert.deepEqual(store.goals.t, { status: 'paused', objective: 'ship', reason: 'quit', at: clock.t });
    const at = clock.t;
    clock.t += 5;
    a.noteGoal('t', { status: 'paused', objective: 'ship 2' });
    assert.deepEqual(store.goals.t, { status: 'paused', objective: 'ship 2', reason: 'quit', at });
    // paused for another reason than quit, with nothing recorded: not kept
    a.noteGoal('u', { status: 'paused' });
    assert.equal((store.goals as any).u, undefined);
    a.noteGoal('v', { status: 'paused' });
    assert.equal((store.goals as any).v, undefined);
    const failing = setup({}, { goals: {}, writeThrows: true });
    assert.doesNotThrow(() => failing.a.noteGoal('t', { status: 'active' }));
    assert.equal(failing.store.writes, 1);
  });

  test('recovering goals the last run left active: gone ones forgotten, unreadable ones paused, failures forgotten', async () => {
    const goals = { a: { status: 'active' }, b: { status: 'active' }, c: { status: 'active' }, d: { status: 'paused', reason: 'quit' } };
    const { a, store } = setup(
      {
        'thread/goal/get': (p: any) => {
          if (p.threadId === 'a') return {};
          if (p.threadId === 'b') throw new Error('unreadable');
          return { goal: { status: 'active' } };
        },
        'thread/goal/set': (p: any) => {
          if (p.threadId === 'c') throw new Error('gone');
          return { goal: { status: 'paused' } };
        },
        'thread/resume': (p: any) => {
          if (p.threadId === 'c') throw new Error('no rollout');
          return { thread: thread(p.threadId) };
        },
      },
      { goals },
    );
    await a.initialize();
    await a.recovering;
    assert.equal(store.goals.a, undefined);
    assert.equal(store.goals.b.reason, 'quit');
    assert.equal(store.goals.c, undefined);
    assert.equal(store.goals.d.reason, 'quit');
  });

  test('recovering goals keeps them when Codex goes away meanwhile', async () => {
    const goals = { a: { status: 'active' } };
    let s: any;
    const ctx = setup(
      {
        'thread/goal/get': () => ({ goal: { status: 'active' } }),
        'thread/goal/set': () => {
          s.emit({ kind: 'exit', code: 1 });
          return new Promise(() => {});
        },
      },
      { goals, backoff: [] },
    );
    s = ctx.server;
    await ctx.a.initialize();
    await ctx.a.recovering;
    assert.equal(ctx.store.goals.a.status, 'active');
    assert.equal(ctx.statuses.at(-1).kind, 'gaveUp');
  });

  test('recovering with no goal store does nothing', async () => {
    const { a, server } = setup();
    await a.initialize();
    await a.recovering;
    assert.ok(!server.methods().includes('thread/goal/get'));
  });

  test('annotateGoal marks only a Codex goal paused at quit', () => {
    const goal = { status: 'paused' };
    const { a } = setup(
      {},
      { goals: { t: { status: 'paused', reason: 'quit' }, u: { status: 'paused', reason: 'user' } }, segments: { gone: null } },
    );
    assert.equal(a.annotateGoal('t', null), null);
    assert.equal(a.annotateGoal('t', 'x'), 'x');
    const active = { status: 'active' };
    assert.equal(a.annotateGoal('t', active), active);
    const claude = { status: 'paused', claude: true };
    assert.equal(a.annotateGoal('t', claude), claude);
    assert.deepEqual(a.annotateGoal('t', goal), { status: 'paused', pausedAtQuit: true });
    assert.equal(a.annotateGoal('u', goal), goal);
    assert.equal(a.annotateGoal('gone', goal), goal);
    const noStore = setup();
    assert.equal(noStore.a.annotateGoal('t', goal), goal);
    const empty = setup({}, { goals: null });
    assert.equal(empty.a.annotateGoal('t', goal), goal);
  });
}
