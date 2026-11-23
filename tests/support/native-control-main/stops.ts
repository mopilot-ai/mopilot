// Native-control stops unit cases with shared protocol and lifecycle fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NativeCodexLifecycle, tick, settle, lifecycle, item, done, hookOf, deferred } from './fixture';

export function registerStopsCases() {
  test('a stop sends the Interrupt hook and the JS reset at once; idle and released are timed, and turn/completed does not repeat them', async () => {
    const hook = deferred();
    const t = lifecycle({ respond: (_m: string, p: any) => (p.tool === 'turn_ended' ? hook.promise : { content: [] }) });
    t.lc.observe(item('item/started', 'u1', 'js', 'a'));
    t.lc.interrupt('th', 'u1');
    // before turn/completed: the hook and the reset are both on their way
    assert.deepEqual(t.calls.map(hookOf), [
      ['turn_ended', 'Interrupt', 'th', 'u1'],
      ['js_reset', null, null, null],
    ]);
    assert.deepEqual(t.states.at(-1), ['th', { phase: 'releasing', turnId: 'u1', error: null }]);
    t.advance(40);
    t.lc.acknowledged('th', 'u1');
    assert.deepEqual(t.timings, [{ threadId: 'th', turnId: 'u1', event: 'idle', ms: 40, ok: true }]);
    // the next turn waits only for the stopped turn to end, never for the release
    let started = false;
    const next = t.lc.turnEnded('th').then(() => (started = true));
    await settle();
    assert.equal(started, false);
    t.lc.observe(done('u1', 'interrupted'));
    await next;
    assert.equal(t.lc.stops.has('th'), false);
    assert.equal(t.lc.pending('th'), 'th', 'the release still holds native operations');
    // the completion did not send the hook again
    assert.equal(t.calls.length, 2);
    t.advance(460);
    hook.resolve({ content: [] });
    await t.lc.ready('th');
    assert.deepEqual(t.timings.at(-1), { threadId: 'th', turnId: 'u1', event: 'released', ms: 500, ok: true });
    assert.deepEqual(t.states.at(-1), ['th', null]);
    assert.equal(t.lc.pending('th'), null);
    assert.equal(t.lc.inflightJs.has('th'), false);
    // a duplicate completion changes nothing
    t.lc.observe(done('u1', 'interrupted'));
    await settle();
    assert.equal(t.calls.length, 2);
    await t.lc.turnEnded('th');
  });

  test('native work the stopping turn still starts is released again when the turn ends', async () => {
    const t = lifecycle();
    t.lc.observe(item('item/started', 'u1', 'click', 'c1'));
    t.lc.interrupt('th', 'u1');
    await settle();
    // a completion of a call that ran before the stop is not new work
    t.lc.observe(item('item/completed', 'u1', 'click', 'c1'));
    t.lc.observe(done('u1', 'interrupted'));
    await t.lc.ready('th');
    assert.deepEqual(t.calls.map(hookOf), [['turn_ended', 'Interrupt', 'th', 'u1']]);
    // a call that starts after the hook went out (the app-server had not stopped the turn yet)
    t.lc.observe(item('item/started', 'u2', 'click', 'c2'));
    t.lc.interrupt('th', 'u2');
    t.lc.observe(item('item/started', 'u2', 'js', 'late'));
    t.lc.observe(done('u2', 'interrupted'));
    await t.lc.ready('th');
    assert.deepEqual(t.calls.slice(1).map(hookOf), [
      ['turn_ended', 'Interrupt', 'th', 'u2'],
      ['turn_ended', 'Interrupt', 'th', 'u2'],
      ['js_reset', null, null, null],
    ]);
    assert.equal(t.lc.threads.get('th').has(JSON.stringify(['turn-end', 'u2'])), true);
    assert.deepEqual(
      t.timings.filter((x: any) => x.event === 'released').map((x: any) => x.turnId),
      ['u1', 'u2', 'u2'],
    );
  });

  test('a stop of a turn without native control, of another thread, twice, or after the turn ended sends no hook', async () => {
    const t = lifecycle();
    t.lc.interrupt('managed', 'u1');
    t.lc.interrupt('th', '');
    t.lc.interrupt('', 'u1');
    assert.equal(t.lc.stops.size, 0);
    // no native control in this turn: nothing to release, only the stop is recorded
    t.lc.interrupt('th', 'u1');
    assert.deepEqual(t.lc.stops.get('th'), { turnId: 'u1', at: 1_000 });
    t.advance(5);
    t.lc.interrupt('th', 'u1');
    assert.deepEqual(t.lc.stops.get('th'), { turnId: 'u1', at: 1_000 }, 'a second click keeps the first stop time');
    assert.deepEqual(t.calls, []);
    // an acknowledgement for another turn is not this stop's
    t.lc.acknowledged('th', 'u0');
    t.lc.acknowledged('other', 'u1');
    t.lc.acknowledged('other', undefined);
    assert.deepEqual(t.timings, []);
    t.lc.observe(done('u1', 'interrupted'));
    assert.equal(t.lc.stops.has('th'), false);
    // the turn already ended: no stop, no hook
    t.lc.interrupt('th', 'u1');
    assert.equal(t.lc.stops.has('th'), false);
    await settle();
    assert.deepEqual(t.calls, []);
  });

  test('a refused interrupt does not hold the next turn', async () => {
    const t = lifecycle();
    t.lc.interrupt('th', 'u1');
    t.lc.interruptFailed('th', 'u0');
    assert.equal(t.lc.stops.has('th'), true, 'a refusal for another turn keeps the stop');
    t.lc.interruptFailed('th', 'u1');
    assert.equal(t.lc.stops.has('th'), false);
    await t.lc.turnEnded('th');
  });

  test('the next turn gives up waiting for a stopped turn after the timeout, on a disconnect and when the thread closes', async () => {
    const slow = lifecycle({ endTimeoutMs: 20 });
    slow.lc.interrupt('th', 'u1');
    await assert.rejects(slow.lc.turnEnded('th'), { message: 'Codex has not confirmed that the stopped turn ended. Try again.' });
    assert.equal(slow.lc.waiters.size, 0);
    // the next try does not wait again for a completion that never came
    await slow.lc.turnEnded('th');
    const t = lifecycle({ native: ['th', 'th2'] });
    t.lc.interrupt('th', 'u1');
    const disconnected = t.lc.turnEnded('th');
    t.lc.clear();
    await assert.rejects(disconnected, { message: 'Codex disconnected before the stopped turn ended' });
    t.lc.interrupt('th', 'u2');
    t.lc.interrupt('th2', 'u2');
    const closed = t.lc.turnEnded('th');
    const other = t.lc.turnEnded('th2');
    t.lc.forget('th');
    await assert.rejects(closed, { message: 'The native thread closed before the stopped turn ended' });
    assert.equal(t.lc.waiters.size, 1, 'the other thread still waits');
    // another turn's completion does not end the wait
    t.lc.observe(done('u9', 'completed', 'th2'));
    await settle();
    assert.equal(t.lc.waiters.size, 1);
    t.lc.observe(done('u2', 'interrupted', 'th2'));
    await other;
  });

  test('native work after a failed release stops its turn once; work racing a pending release is stopped only if it fails', async () => {
    for (const outcome of ['fails', 'succeeds'] as const) {
      const hook = deferred();
      const t = lifecycle({ respond: () => hook.promise });
      t.lc.observe(item('item/started', 'u1', 'click'));
      t.lc.interrupt('th', 'u1');
      t.lc.observe(done('u1', 'interrupted'));
      // the next turn already runs and starts native work while the release is pending
      t.lc.observe(item('item/started', 'u2', 'click', 'n1'));
      t.lc.observe(item('item/completed', 'u2', 'click', 'n1'));
      assert.deepEqual(
        [...t.lc.racing.get('th').values()].map((r: any) => r.turnId),
        ['u2'],
        outcome,
      );
      assert.deepEqual(t.blocked, [], outcome);
      if (outcome === 'fails') hook.resolve({ isError: true });
      else hook.resolve({ content: [] });
      await settle();
      assert.equal(t.lc.racing.has('th'), false, outcome);
      if (outcome === 'succeeds') {
        assert.deepEqual(t.blocked, []);
        continue;
      }
      assert.deepEqual(
        t.blocked.map((b: any) => b.slice(0, 2)),
        [['th', 'u2']],
      );
      assert.match(t.blocked[0][2], /Native browser and computer control is blocked: .*rejected turn cleanup.*Restart Codex/);
      // the same turn is not reported twice; a later turn is
      t.lc.observe(item('item/started', 'u2', 'click', 'n2'));
      t.lc.observe(item('item/completed', 'u3', 'click', 'n3'));
      t.lc.observe(item('item/started', 'u3', 'click', 'n4'));
      assert.deepEqual(
        t.blocked.map((b: any) => b[1]),
        ['u2', 'u3'],
      );
      // closing another thread keeps these reports; closing this one drops them
      t.lc.forget('elsewhere');
      assert.equal(t.lc.blocked.size, 2);
      t.lc.forget('th');
      assert.equal(t.lc.blocked.size, 0);
    }
  });

  test('a release that settles while another is pending waits for both before deciding on racing work', async () => {
    const first = deferred();
    const second = deferred();
    const t = lifecycle({ respond: (_m: string, p: any) => (p.arguments.turn_id === 'u1' ? first.promise : second.promise) });
    t.lc.observe(item('item/started', 'u1', 'click'));
    t.lc.observe(done('u1'));
    t.lc.observe(item('item/started', 'u2', 'click'));
    t.lc.observe(done('u2'));
    t.lc.observe(item('item/started', 'u3', 'click'));
    first.resolve({ content: [] });
    await settle();
    assert.deepEqual(
      [...t.lc.racing.get('th').values()].map((r: any) => r.turnId),
      ['u3'],
      'still racing the second release',
    );
    second.resolve({ isError: true });
    await settle();
    assert.deepEqual(
      t.blocked.map((b: any) => b[1]),
      ['u3'],
    );
  });

  test('pending() names the thread whose release holds native operations, also for its subagents', async () => {
    const hook = deferred();
    const t = lifecycle({ respond: () => hook.promise });
    assert.equal(t.lc.pending('th'), null);
    t.lc.observe({ method: 'thread/started', params: { thread: { id: 'sub', parentThreadId: 'th' } } });
    t.lc.observe(item('item/started', 'u1', 'click'));
    t.lc.observe(done('u1'));
    assert.equal(t.lc.pending('th'), 'th');
    assert.equal(t.lc.pending('sub'), 'th');
    hook.resolve({ content: [] });
    await t.lc.ready('th');
    assert.equal(t.lc.pending('sub'), null);
  });
}

export function registerStopSimulationCases() {
  /**
   * The plugin as observed: turn_ended waits in the plugin's queue behind a running js call; js_reset
   * ends that call at once. Latencies are the simulation's inputs, on fake time.
   */
  async function simulateStop(
    Lifecycle: any,
    { jsLeftMs = 28_000, hookMs = 200, resetMs = 300, interruptAckMs = 40, completedMs = 100 } = {},
  ) {
    let clock = 0;
    const timers: { at: number; fn: () => void }[] = [];
    const later = (ms: number, fn: () => void) => timers.push({ at: clock + ms, fn });
    let jsDone = deferred();
    later(jsLeftMs, () => jsDone.resolve(undefined));
    const timings: any[] = [];
    const lc = new Lifecycle({
      call: (_m: string, p: any) =>
        new Promise((resolve) => {
          if (p.tool === 'js_reset') return later(resetMs, () => (jsDone.resolve(undefined), resolve({ content: [] })));
          jsDone.promise.then(() => later(hookMs, () => resolve({ content: [] })));
        }),
      isNativeThread: () => true,
      onTiming: (x: any) => timings.push(x),
      now: () => clock,
    });
    const run = async () => {
      for (;;) {
        for (let i = 0; i < 5; i++) await tick();
        timers.sort((a, b) => a.at - b.at);
        const next = timers.shift();
        if (!next) return;
        clock = next.at;
        next.fn();
      }
    };
    lc.observe(item('item/started', 'u1', 'js', 'running'));
    // Stop: turn/interrupt goes out; the host stop hook path (new) or nothing (old) runs now
    lc.interrupt?.('th', 'u1');
    let idleAt = -1;
    let releasedAt = -1;
    later(interruptAckMs, () => lc.acknowledged?.('th', 'u1'));
    later(completedMs, () => {
      lc.observe(done('u1', 'interrupted'));
      // the old lifecycle's idle point: the next turn could start once ready() resolved
      if (!lc.interrupt) idleAt = clock;
      lc.ready('th').then(() => (releasedAt = clock));
    });
    await run();
    const idle = timings.find((x) => x.event === 'idle')?.ms ?? idleAt;
    const released = timings.find((x) => x.event === 'released')?.ms ?? releasedAt;
    return { stopToIdleMs: idle, stopToReleasedMs: released, nextTurnBlockedMs: lc.interrupt ? 0 : releasedAt };
  }

  test('simulation: Stop is idle at the interrupt answer and released once the reset frees the hook', async () => {
    const fast = await simulateStop(NativeCodexLifecycle);
    // idle at the app-server's interrupt answer; released = js_reset (300) + the hook behind it (200)
    assert.deepEqual(fast, { stopToIdleMs: 40, stopToReleasedMs: 500, nextTurnBlockedMs: 0 });
    const quick = await simulateStop(NativeCodexLifecycle, { jsLeftMs: 0 });
    assert.equal(quick.stopToIdleMs, 40);
    assert.ok(quick.stopToReleasedMs <= 300, `${quick.stopToReleasedMs}`);
  });
}
