// Codex harness failures unit cases with shared server and session fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recentIgnored, clearIgnored, settle, thread, setup } from './fixture';

export function registerFailuresCases() {
  const fails = (message: string) => () => {
    throw new Error(message);
  };

  test('after a restart, a goal that cannot be paused again is left as it is', async () => {
    const { a, server } = setup({ 'thread/goal/set': fails('not loaded'), 'thread/resume': fails('gone') });
    await a.initialize();
    a.pauseOnReconnect.add('t1');
    a.pauseGoals();
    await settle();
    assert.equal(a.pauseOnReconnect.size, 0);
    assert.deepEqual(server.params('thread/resume'), [{ threadId: 't1', excludeTurns: true }]);
  });

  test('pausing every goal at quit still reports a chat whose turn had already ended', async () => {
    const { a, server } = setup({ 'thread/goal/set': () => ({ goal: { status: 'paused' } }), 'turn/interrupt': fails('no turn') });
    await a.initialize();
    a.goals.set('t1', 'active');
    a.turnOf.set('t1', 'turn-1');
    assert.deepEqual(await a.pauseAllActiveGoals(), ['t1']);
    assert.deepEqual(server.params('turn/interrupt'), [{ threadId: 't1', turnId: 'turn-1' }]);
  });

  test('a release lets go of the lease even when the thread is already unloaded', async () => {
    const { a, server } = setup({ 'thread/unsubscribe': fails('not loaded') });
    a.hold('t1', thread('t1'));
    await a.release('t1');
    await settle();
    assert.deepEqual(a.leaseList(), []);
    assert.deepEqual(server.params('thread/unsubscribe'), [{ threadId: 't1' }]);
  });

  test('stopTurn interrupts even when pausing the goal fails, and says the goal may go on', async () => {
    const { a, state, server, of } = setup({ 'thread/goal/set': fails('goals off') });
    state.patch('t', { goal: { status: 'active' }, activeTurn: { id: 'turn-7' } });
    assert.equal(await a.stopTurn('t'), true);
    assert.equal(server.params('turn/interrupt')[0].turnId, 'turn-7');
    assert.deepEqual(
      of('toast').map((x) => [x.e.level, x.e.text]),
      [['error', "Couldn't pause the goal, so it may go on: goals off"]],
    );
  });

  test('stopTurn: a goal that ended before its pause failed needs no warning', async () => {
    clearIgnored();
    let st: any;
    const { a, state, of } = setup({
      'thread/goal/set': () => {
        st.patch('t', { goal: { status: 'complete' } });
        throw new Error('no active goal');
      },
    });
    st = state;
    state.patch('t', { goal: { status: 'active' }, activeTurn: { id: 'turn-7' } });
    assert.equal(await a.stopTurn('t'), true);
    assert.deepEqual(of('toast'), []);
    assert.ok(recentIgnored().some((e: any) => e.context === 'pause a Codex goal that already ended'));
  });

  test('stopTurn: an interrupt that fails because the turn ended meanwhile is recorded, not shown', async () => {
    clearIgnored();
    let st: any;
    const { a, state, of } = setup({
      'turn/interrupt': () => {
        st.patch('t', { activeTurn: null });
        throw new Error('no active turn');
      },
    });
    st = state;
    state.patch('t', { activeTurn: { id: 'turn-7' } });
    assert.equal(await a.stopTurn('t'), true);
    assert.deepEqual(of('toast'), []);
    assert.deepEqual(
      recentIgnored().map((e: any) => [e.context, e.message]),
      [['stop a Codex turn that already ended', 'no active turn']],
    );
  });

  test('startTurn starts the turn when recording the modality fails', async () => {
    const { a, state, of } = setup({ 'model/list': () => ({ data: [{ model: 'm', inputModalities: ['text'], isDefault: true }] }) });
    const patch = state.patch.bind(state);
    state.patch = (id: string, p: any) => {
      if ('modality' in p) throw new Error('state closed');
      return patch(id, p);
    };
    const r = await a.startTurn('t', { kind: 'codex', id: 't' }, { text: 'hi' });
    await settle();
    assert.equal(r.started, true);
    assert.equal(of('turnStarted').length, 1);
  });

  test('autoTitle: a provisional title that cannot be set, and a helper thread that cannot be let go, are left', async () => {
    const { a, server } = setup({
      'thread/start': () => ({ thread: thread('helper', { ephemeral: true }) }),
      'turn/start': fails('no turn'),
      'thread/name/set': fails('read only'),
      'thread/unsubscribe': fails('gone'),
    });
    await a.autoTitle('t', 'fix the login bug');
    await settle();
    assert.equal(server.params('thread/name/set').length, 1);
    assert.deepEqual(server.params('thread/unsubscribe'), [{ threadId: 'helper' }]);
    assert.equal(a.titling.has('t'), false);
  });

  test('summarize: a failed note still lets the fork go, and a fork that cannot be let go is left', async () => {
    const { a, server } = setup({
      'thread/fork': () => ({ thread: thread('fork1', { ephemeral: true }) }),
      'turn/start': fails('no turn'),
      'thread/unsubscribe': fails('gone'),
    });
    await assert.rejects(a.summarize('t', 'Summarize'), /no turn/);
    await settle();
    assert.deepEqual(server.params('thread/unsubscribe'), [{ threadId: 'fork1' }]);
  });
}
