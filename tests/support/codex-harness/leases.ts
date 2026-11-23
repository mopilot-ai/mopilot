// Codex harness leases unit cases with shared server and session fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settle, NO_REPLY, thread, setup } from './fixture';

export function registerLeasesCases() {
  test('codexThread: no ref, or a Claude one, is not a Codex thread', () => {
    const { a } = setup({}, { nativeOf: (c: string) => (c === 'none' ? null : { kind: 'claude', id: 'x' }) });
    assert.equal(a.codexThread('none'), null);
    assert.equal(a.codexThread('cl'), null);
  });

  test('leases: hold keeps a pin and clears a stale running-elsewhere flag; pin and touch skip unknown threads', () => {
    const { a, state, events } = setup();
    state.patch('t', { runningElsewhere: true });
    a.hold('t', null);
    assert.equal(state.get('t').runningElsewhere, false);
    a.pin('t', true);
    a.hold('t', thread('t'));
    assert.equal(a.leases.get('t').pinned, true);
    assert.equal(events.filter((x) => x.e.kind === 'lease').length, 1);
    a.pin('nope', true);
    a.touch('nope');
    assert.equal(a.leases.has('nope'), false);
    assert.deepEqual(a.leaseList(), ['t']);
    a.drop('nope', 'x');
    assert.equal(events.filter((x) => x.e.kind === 'lease').length, 1);
  });

  test('ensureResumed shares one resume; a resume with no thread still holds it; other failures pass through', async () => {
    const { a, server } = setup({
      'thread/resume': (p: any) => {
        if (p.threadId === 'bad') throw new Error('no rollout');
        return {};
      },
    });
    await Promise.all([a.ensureResumed('t'), a.ensureResumed('t')]);
    assert.equal(server.params('thread/resume').length, 1);
    assert.ok(a.leases.has('t'));
    assert.equal(a.meta.has('t'), false);
    await assert.rejects(a.ensureResumed('bad'), /no rollout/);
    await assert.rejects(a.leased('bad', 'thread/compact/start'), /no rollout/);
  });

  test('the lease event that clears "open in another Codex app" goes out before ensureResumed resolves', async () => {
    const { a, events, state } = setup();
    state.patch('t', { runningElsewhere: true });
    const order: string[] = [];
    const p = a
      .ensureResumed('t')
      .then(() => order.push(`resolved after ${events.filter((x) => x.e.kind === 'lease').length} lease event(s)`));
    await p;
    assert.deepEqual(order, ['resolved after 1 lease event(s)']);
    assert.deepEqual(events.find((x) => x.e.kind === 'lease')!.e.held, true);
    assert.equal(state.get('t').runningElsewhere, false);
  });

  test('releaseIdle passes over threads that are busy, unknown, pinned, ephemeral or recent', async () => {
    const { a, state, server, clock } = setup({
      'thread/backgroundTerminals/list': () => ({}),
      'thread/queue/list': () => ({}),
      'thread/goal/get': () => ({}),
    });
    const held = (id: string, extra: any = {}) => {
      a.hold(id, thread(id, extra));
      a.leases.get(id).at = clock.t - 10_000;
    };
    held('idle');
    held('eph', { ephemeral: true });
    held('pinned');
    a.pin('pinned', true);
    held('running');
    a.running.add('running');
    held('hiddenT');
    a.hidden.set('hiddenT', { on() {} });
    held('releasing');
    a.releasing.add('releasing');
    a.hold('nometa', null);
    held('queued');
    state.patch('queued', { queue: [{ text: 'x' }] });
    held('approvals');
    state.patch('approvals', { approvals: [{ id: 1 }] });
    held('awaiting');
    state.patch('awaiting', { turn: 'awaitingUser' });
    held('stateIdle');
    state.patch('stateIdle', { turn: 'idle' });
    held('recent');
    a.leases.get('recent').at = clock.t;
    a.releaseIdle();
    await settle();
    assert.deepEqual(
      server
        .params('thread/unsubscribe')
        .map((p: any) => p.threadId)
        .sort(),
      ['idle', 'stateIdle'],
    );
    assert.equal(a.releasing.size, 1);
  });

  test('release keeps a lease for terminals, queued messages or an active goal, and lets go only of a quiet thread', async () => {
    for (const [method, result] of [
      ['thread/backgroundTerminals/list', { terminals: [1] }],
      ['thread/queue/list', { items: [1] }],
      ['thread/goal/get', { goal: { status: 'active' } }],
      ['thread/queue/list', { data: [1] }],
    ] as const) {
      const { a, server, clock } = setup({
        'thread/backgroundTerminals/list': () => ({}),
        'thread/queue/list': () => ({}),
        'thread/goal/get': () => ({}),
        [method]: () => result,
      });
      a.hold('t', thread('t'));
      await a.release('t');
      assert.equal(a.leases.get('t').at, clock.t + 25_000);
      assert.equal(server.params('thread/unsubscribe').length, 0);
    }
    const failing = setup({
      'thread/backgroundTerminals/list': () => {
        throw new Error('x');
      },
      'thread/queue/list': () => {
        throw new Error('x');
      },
      'thread/goal/get': () => {
        throw new Error('x');
      },
    });
    failing.a.hold('t', thread('t'));
    failing.a.running.add('t');
    await failing.a.release('t');
    // a turn started meanwhile: kept
    assert.ok(failing.a.leases.has('t'));
    failing.a.drop('t', 'x');
    await failing.a.release('t');
    assert.equal(failing.server.params('thread/unsubscribe').length, 0);
  });

  test('a turn that starts while an idle release asks Codex keeps the thread loaded', async () => {
    let answer: () => void = () => undefined;
    const { a, server, clock, state } = setup({
      'thread/queue/list': () => new Promise<object>((r) => (answer = () => r({}))),
    });
    a.hold('t', thread('t'));
    const released = a.release('t');
    await settle();
    clock.t += 1_000;
    const started = await a.startTurn('t', { kind: 'codex', id: 't' }, { text: 'hi' });
    assert.equal(started.started, true);
    answer();
    await released;
    assert.ok(a.leases.has('t'));
    assert.equal(server.params('thread/unsubscribe').length, 0);
    // a chat that turned busy meanwhile keeps it too, without a touch
    const busy = a.release('t');
    await settle();
    state.patch('t', { turn: 'running' });
    answer();
    await busy;
    assert.ok(a.leases.has('t'));
    assert.equal(server.params('thread/unsubscribe').length, 0);
  });

  test('runningElsewhere is false for threads Sage holds, runs, or whose chat is mid-turn', async () => {
    const { a, state } = setup({ 'thread/turns/list': () => ({}) });
    a.hold('held', null);
    assert.equal(await a.runningElsewhere('held'), false);
    a.running.add('run');
    assert.equal(await a.runningElsewhere('run'), false);
    state.patch('busy', { turn: 'running' });
    assert.equal(await a.runningElsewhere('busy'), false);
    state.patch('asks', { turn: 'awaitingUser' });
    assert.equal(await a.runningElsewhere('asks'), false);
    state.patch('quiet', { turn: 'idle' });
    assert.equal(await a.runningElsewhere('quiet'), false);
    assert.equal(await a.runningElsewhere('nostate'), false);
  });

  test('cwdOf and chatName read what the app-server last said of a thread', () => {
    const { a } = setup();
    assert.equal(a.cwdOf('t'), null);
    assert.equal(a.chatName('t'), null);
    a.meta.set('t', thread('t', { cwd: '/p', preview: '  fix   the\nbug ' }));
    assert.equal(a.cwdOf('t'), '/p');
    assert.equal(a.chatName('t'), 'fix the bug');
    a.meta.get('t').name = 'x'.repeat(61);
    assert.equal(a.chatName('t'), `${'x'.repeat(59)}…`);
    a.meta.get('t').name = 'y'.repeat(60);
    assert.equal(a.chatName('t'), 'y'.repeat(60));
  });

  test('leased: no Codex thread, a locked one, a failed compaction, goal set and clear', async () => {
    const { a, server } = setup(
      {
        'thread/resume': (p: any) => {
          if (p.threadId === 'locked') throw new Error('thread has an active writer');
          return { thread: thread(p.threadId) };
        },
        'thread/compact/start': () => {
          throw new Error('too short');
        },
        'thread/goal/set': (p: any) => ({ goal: { status: p.status, objective: 'o' } }),
        'thread/goal/clear': () => ({}),
      },
      { segments: { none: null } },
    );
    await assert.rejects(a.leased('none', 'thread/goal/get'), /isn't running on Codex/);
    assert.deepEqual(await a.leased('locked', 'thread/goal/get'), { locked: true });
    await assert.rejects(a.leased('t', 'thread/compact/start'), /too short/);
    assert.equal(a.compacting.size, 0);
    await a.leased('t', 'thread/goal/set', { status: 'active' });
    assert.equal(a.goals.get('t'), 'active');
    await a.leased('t', 'thread/goal/clear');
    // cleared: recorded as null, not forgotten (#2759)
    assert.equal(a.goals.get('t'), null);
    assert.ok(server.params('thread/goal/clear')[0].threadId === 't');
  });

  test('stopTurn pauses an active goal before interrupting, and leaves a pending turn alone', async () => {
    const { a, state, server, of } = setup(
      {
        'thread/goal/set': () => ({ goal: { status: 'paused' } }),
        'turn/interrupt': () => {
          throw new Error('gone');
        },
      },
      { segments: { none: null } },
    );
    assert.equal(await a.stopTurn('none'), false);
    state.patch('t', { goal: { status: 'active' }, activeTurn: { id: 'turn-7' } });
    // the turn is still running, so the refused stop is pending (it is repeated, and said if it is given up: codexInterruptUntilEnded.test.ts), not done
    assert.equal(await a.stopTurn('t'), 'pending');
    assert.deepEqual(
      server.methods().filter((m: string) => m.startsWith('t')),
      ['thread/resume', 'thread/goal/set', 'turn/interrupt'],
    );
    assert.deepEqual(
      of('toast').map((x) => [x.e.level, x.e.text]),
      [],
    );
    state.patch('p', { activeTurn: { id: 'pending-1' } });
    assert.equal(await a.stopTurn('p'), true);
    assert.equal(server.params('turn/interrupt').length, 1);
    assert.equal(await a.stopTurn('nostate'), true);
  });

  test('a goal pause that hangs does not hold up the interrupt', async () => {
    const { a, state, server } = setup({ 'thread/goal/set': NO_REPLY });
    state.patch('t', { goal: { status: 'active' }, activeTurn: { id: 'turn-7' } });
    assert.equal(await a.stopTurn('t'), true);
    assert.equal(server.params('turn/interrupt')[0].turnId, 'turn-7');
  });
}
