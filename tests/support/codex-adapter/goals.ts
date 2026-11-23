// Codex adapter goals cases using the shared scripted app-server and session fixtures.
import { test, assert, defined, NO_REPLY, thread, setup, settle, wait, crash, goalSet } from './fixture.ts';

export function registerGoalStart() {
  test('startGoal: thread/goal/set on the native thread; an active goal counts as a started turn', async () => {
    const { a, server, kinds } = setup(
      { 'thread/goal/set': (p) => ({ goal: { threadId: p.threadId, objective: p.objective, status: 'active' } }) },
      { segments: { chat1: 'seg2' } },
    );
    const res = await a.startGoal('chat1', { kind: 'codex', id: 'seg2' }, { text: '', attachments: [], opts: { goal: 'ship' } }, 1);
    assert.deepEqual(res, { started: true });
    assert.deepEqual(server.sent.find((m) => m.method === 'thread/goal/set').params, {
      threadId: 'seg2',
      objective: 'ship',
      status: 'active',
    });
    assert.deepEqual(
      kinds().filter((k) => k !== 'lease'),
      ['goalStarting', 'goal'],
    );
  });
}

export function registerGoalRecovery() {
  test('a goal that was running when Codex quit is set paused once Codex is back', async () => {
    const { a, server } = setup(
      { 'thread/goal/set': (p) => ({ goal: { threadId: p.threadId, status: p.status } }) },
      { backoff: [5], paused: ['t1'] },
    );
    await a.connect();
    crash(server);
    await wait(30);
    await settle();
    const set = server.sent.filter((m) => m.method === 'thread/goal/set');
    assert.deepEqual(
      set.map((m) => m.params),
      [{ threadId: 't1', status: 'paused' }],
    );
    // set before the thread is loaded again: resuming it with the goal active would carry it on
    assert.ok(!server.sent.some((m) => m.method === 'thread/resume'));
  });

  test('a restart on purpose ends the chats as an exit does, and their paused goals are paused in Codex when it is connected again', async () => {
    const { a, server, exits, statuses } = setup(
      { 'thread/goal/set': (p) => ({ goal: { threadId: p.threadId, status: p.status } }) },
      { backoff: [5], paused: ['t1'] },
    );
    await a.connect();
    // Settings → Restart Codex server: stopped, not crashed; nothing restarts it by itself
    server.emit({ kind: 'stopped' });
    assert.deepEqual(exits, ['Codex restarted']);
    await wait(20);
    assert.deepEqual(statuses, []);
    assert.equal(server.sent.filter((m) => m.method === 'thread/goal/set').length, 0);
    // whoever stopped it connects again: the goal it paused is paused in Codex first, once
    await a.connect();
    await settle();
    await a.connect();
    await settle();
    assert.deepEqual(
      server.sent.filter((m) => m.method === 'thread/goal/set').map((m) => m.params),
      [{ threadId: 't1', status: 'paused' }],
    );
  });

  test('pauseAllActiveGoals: every active goal is set paused, its turn stopped, and recorded as paused at quit', async () => {
    const { a, server, goals } = setup(
      { 'thread/goal/set': goalSet, 'turn/interrupt': () => ({}) },
      { goals: {}, segments: { chat1: 't1' } },
    );
    await a.connect();
    // nothing active: nothing to do
    assert.equal(a.hasActiveGoals(), false);
    assert.deepEqual(await a.pauseAllActiveGoals(), []);
    server.notify('thread/goal/updated', { threadId: 't1', goal: { threadId: 't1', objective: 'ship it', status: 'active' } });
    server.notify('turn/started', { threadId: 't1', turn: { id: 'turn-9' } });
    server.notify('thread/goal/updated', { threadId: 't2', goal: { threadId: 't2', objective: 'done', status: 'complete' } });
    assert.equal(a.hasActiveGoals(), true);
    assert.deepEqual(goals(), { t1: { status: 'active', objective: 'ship it' } });

    assert.deepEqual(await a.pauseAllActiveGoals(), ['chat1']);
    const sent = server.sent.filter((m) => m.method === 'thread/goal/set' || m.method === 'turn/interrupt');
    assert.deepEqual(
      sent.map((m) => [m.method, m.params]),
      [
        ['thread/goal/set', { threadId: 't1', status: 'paused' }],
        ['turn/interrupt', { threadId: 't1', turnId: 'turn-9' }],
      ],
    );
    assert.equal(defined(goals()).t1.reason, 'quit');
    assert.equal(defined(goals()).t1.status, 'paused');
    // the window's paused goal says why; a goal paused by hand doesn't
    assert.equal(a.annotateGoal('chat1', { objective: 'ship it', status: 'paused' }).pausedAtQuit, true);
    assert.equal(a.annotateGoal('chat2', { objective: 'x', status: 'paused' }).pausedAtQuit, undefined);
    // resumed later: no longer a quit note
    server.notify('thread/goal/updated', { threadId: 't1', goal: { threadId: 't1', objective: 'ship it', status: 'active' } });
    assert.deepEqual(defined(goals()).t1, { status: 'active', objective: 'ship it' });
  });

  test('pauseAllActiveGoals gives up after its timeout, with what it paused so far', async () => {
    const { a, server } = setup({ 'thread/goal/set': NO_REPLY }, { goals: {} });
    await a.connect();
    server.notify('thread/goal/updated', { threadId: 't1', goal: { threadId: 't1', objective: 'x', status: 'active' } });
    const t = Date.now();
    assert.deepEqual(await a.pauseAllActiveGoals({ timeoutMs: 30 }), []);
    assert.ok(Date.now() - t < 1000);
  });

  test('a goal the last run left active is set paused at the first start, before any thread is resumed', async () => {
    const order: string[] = [];
    const store = { t1: { status: 'active', objective: 'ship it' }, t2: { status: 'active', objective: 'old' } };
    const { a, goals } = setup(
      {
        'thread/goal/get': (p) => (
          order.push(`get ${p.threadId}`), { goal: p.threadId === 't1' ? { threadId: 't1', objective: 'ship it', status: 'active' } : null }
        ),
        'thread/goal/set': (p) => (order.push(`set ${p.threadId} ${p.status}`), goalSet(p)),
        'thread/resume': (p) => (order.push(`resume ${p.threadId}`), { thread: thread(p.threadId) }),
      },
      { goals: store },
    );
    await a.connect();
    // a window opens the chat to write while the pause is still on its way
    await a.ensureResumed('t1');
    assert.deepEqual(order, ['get t1', 'set t1 paused', 'get t2', 'resume t1']);
    // t2's goal is gone; t1's is paused at quit
    assert.deepEqual(Object.keys(defined(goals())), ['t1']);
    assert.equal(defined(goals()).t1.reason, 'quit');
    // only once per run: a later reconnect doesn't do it again
    order.length = 0;
    a.down = true;
    await a.connect();
    assert.deepEqual(order, []);
  });

  test('an app-server that sets goals only on loaded threads gets the thread resumed first', async () => {
    let loaded = false;
    const { a, server } = setup(
      {
        'thread/goal/get': (p) => ({ goal: { threadId: p.threadId, objective: 'ship it', status: 'active' } }),
        'thread/goal/set': (p) => {
          if (!loaded) throw new Error('thread not loaded');
          return goalSet(p);
        },
        'thread/resume': (p) => ((loaded = true), { thread: thread(p.threadId) }),
      },
      { goals: { t1: { status: 'active', objective: 'ship it' } } },
    );
    await a.connect();
    await settle();
    await settle();
    assert.deepEqual(
      server.methods().filter((m) => m.startsWith('thread/')),
      ['thread/goal/get', 'thread/goal/set', 'thread/resume', 'thread/goal/set'],
    );
  });
}
