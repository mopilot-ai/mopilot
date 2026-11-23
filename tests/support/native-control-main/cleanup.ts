// Native-control cleanup unit cases with shared protocol and lifecycle fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settle, lifecycle, item, done, deferred } from './fixture';

export function registerCleanupCases() {
  test('a finished cua_repl call that reports a Codex Computer Use problem is passed on, once, with its own message', () => {
    const { lc, sky } = lifecycle();
    const mismatch = 'Sky Computer Use API version mismatch: client=CodexComputerUseIPC-5 server=CodexComputerUseIPC-6';
    // a call still running reports nothing yet
    lc.observe(item('item/started', 'u1', 'js', 'i1', 'th', { status: 'inProgress' }));
    lc.observe(item('item/completed', 'u1', 'js', 'i1', 'th', { status: 'failed', error: { message: mismatch } }));
    lc.observe(
      item('item/completed', 'u1', 'js', 'i2', 'th', { status: 'failed', error: { message: 'Computer Use permissions are not granted' } }),
    );
    // a call that worked, or failed for a reason that isn't Sky's, reports nothing
    lc.observe(
      item('item/completed', 'u1', 'js', 'i3', 'th', { status: 'completed', result: { content: [{ type: 'text', text: 'ok' }] } }),
    );
    lc.observe(item('item/completed', 'u1', 'js', 'i4', 'th', { status: 'failed', error: { message: 'TypeError: x is not a function' } }));
    // nor a thread that isn't native
    lc.observe(item('item/completed', 'u1', 'js', 'i5', 'other', { status: 'failed', error: { message: mismatch } }));
    assert.deepEqual(sky, [
      ['th', 'versionMismatch', mismatch],
      ['th', 'permissions', 'Computer Use permissions are not granted'],
    ]);
    // without a listener a problem is dropped quietly here (the step still shows it in the chat)
    const quiet = lifecycle({ defaults: true });
    quiet.lc.observe(item('item/completed', 'u1', 'js', 'i1', 'th', { status: 'failed', error: { message: mismatch } }));
    assert.deepEqual(quiet.sky, []);
  });

  test("a turn that used native control ends with the plugin's Stop hook, and the strip shows the release", async () => {
    const { lc, calls, states, timings } = lifecycle();
    lc.observe(item('item/started', 'u1', 'click'));
    lc.observe(done('u1'));
    assert.deepEqual(states, [['th', { phase: 'releasing', turnId: 'u1', error: null }]]);
    assert.equal(lc.has('th'), true);
    // dispatched at once, before anything else can go out on the connection
    assert.equal(calls.length, 1);
    await lc.ready('th');
    assert.deepEqual(calls, [
      {
        method: 'mcpServer/tool/call',
        threadId: 'th',
        server: 'cua_repl',
        tool: 'turn_ended',
        args: { hook_event_name: 'Stop', session_id: 'th', turn_id: 'u1' },
        timeout: 60_000,
      },
    ]);
    assert.deepEqual(states.at(-1), ['th', null]);
    assert.equal(lc.resetContext('th'), null, 'no reset without an interrupted JS call');
    assert.deepEqual(timings, [], 'no stop, no stop timings');
    // the same notification again does not repeat the cleanup
    lc.observe(done('u1'));
    await settle();
    assert.equal(calls.length, 1);
  });

  test('a turn that never used native control needs no cleanup', async () => {
    const { lc, calls, states } = lifecycle();
    lc.observe(done('u1'));
    await lc.ready('th');
    assert.deepEqual(calls, []);
    assert.deepEqual(states, [['th', null]]);
    // a thread with no turns is ready at once
    await lc.ready('other');
    assert.equal(lc.has('other'), false);
  });

  test('an interrupted turn with a running JS call sends the Interrupt hook and the JS reset together, and the next turn is told', async () => {
    // the plugin model: turn_ended waits in the plugin's queue behind the running js call until js_reset frees it
    let resetSeen = false;
    const queue = deferred();
    const t = lifecycle({
      respond: (_m: string, p: any) => {
        if (p.tool === 'js_reset') {
          resetSeen = true;
          queue.resolve(undefined);
          return { content: [] };
        }
        return queue.promise.then(() => ({ content: [] }));
      },
    });
    t.lc.observe(item('item/started', 'u1', 'js', 'a'));
    t.lc.observe(item('item/started', 'u1', 'js', 'b'));
    t.lc.observe(item('item/completed', 'u1', 'js', 'a'));
    t.lc.observe(done('u1', 'interrupted'));
    // both went out before either answered: the hook first, the reset right behind it
    assert.deepEqual(
      t.calls.map((c) => [c.tool, c.args, c.timeout]),
      [
        ['turn_ended', { hook_event_name: 'Interrupt', session_id: 'th', turn_id: 'u1' }, 60_000],
        ['js_reset', {}, 15_000],
      ],
    );
    // the next turn is told of the reset at once (it does not wait for the release)
    const ctx = t.lc.resetContext('th');
    assert.equal(ctx.turnId, 'u1');
    assert.equal(ctx.context.kind, 'application');
    assert.match(ctx.context.value, /reset the original cua_repl JS kernel/);
    await t.lc.ready('th');
    assert.equal(resetSeen, true);
    // a forward for another turn leaves a newer reset in place
    t.lc.contextForwarded('th', 'u0');
    assert.equal(t.lc.resetContext('th')?.turnId, 'u1');
    t.lc.contextForwarded('th', 'u1');
    assert.equal(t.lc.resetContext('th'), null);
    assert.equal(t.lc.inflightJs.has('th'), false);
  });

  test('a JS call that completed before the interrupt, or a late completion, never resets the kernel', async () => {
    const { lc, calls } = lifecycle();
    lc.observe(item('item/started', 'u1', 'js', 'a'));
    lc.observe(item('item/completed', 'u1', 'js', 'a'));
    assert.equal(lc.inflightJs.has('th'), false);
    lc.observe(done('u1', 'interrupted'));
    await lc.ready('th');
    assert.deepEqual(
      calls.map((c) => c.tool),
      ['turn_ended'],
    );
    // items of a turn that already completed are neither tracked nor cleaned up again
    lc.observe(item('item/started', 'u1', 'js', 'late'));
    lc.observe(item('item/completed', 'u1', 'js', 'late'));
    lc.observe(item('item/completed', 'u9', 'js', 'never-started'));
    await settle();
    assert.equal(lc.inflightJs.has('th'), false);
    // the late items' turn is done; a call seen first by its completion still marks its own turn
    assert.deepEqual([...lc.controlTurns.get('th')], ['u9']);
    assert.equal(calls.length, 1);
    // a completion for another of several running turns keeps the rest
    lc.observe(item('item/started', 'u2', 'js', 'x'));
    lc.observe(item('item/started', 'u3', 'js', 'y'));
    lc.observe(item('item/completed', 'u2', 'js', 'x'));
    assert.deepEqual([...lc.inflightJs.get('th').keys()], ['u3']);
    // a JS item without an id is not tracked
    lc.observe(item('item/started', 'u4', 'js', ''));
    assert.deepEqual([...lc.inflightJs.get('th').keys()], ['u3']);
  });

  test('only cua_repl tool items of a native thread count as native control', async () => {
    const { lc, calls } = lifecycle();
    const ignored = [
      undefined,
      { method: 'item/started' },
      { method: 'item/started', params: { turnId: 'u1' } },
      item('item/started', 'u1', 'click', 'i', 'managed-thread'),
      {
        method: 'item/updated',
        params: { threadId: 'th', turnId: 'u1', item: { type: 'mcpToolCall', server: 'cua_repl', tool: 'click' } },
      },
      { method: 'item/started', params: { threadId: 'th', item: { type: 'mcpToolCall', server: 'cua_repl', tool: 'click' } } },
      { method: 'item/started', params: { threadId: 'th', turnId: 'u1' } },
      { method: 'item/started', params: { threadId: 'th', turnId: 'u1', item: { type: 'commandExecution' } } },
      { method: 'item/started', params: { threadId: 'th', turnId: 'u1', item: { type: 'mcpToolCall', server: 'other', tool: 'click' } } },
      { method: 'turn/completed', params: { threadId: 'th' } },
      { method: 'turn/completed', params: { threadId: 'th', turn: {} } },
    ];
    for (const m of ignored) lc.observe(m as any);
    assert.equal(lc.controlTurns.size, 0);
    lc.observe(done('u1'));
    await lc.ready('th');
    assert.deepEqual(calls, []);
  });

  for (const [name, respond, message] of [
    ['rejects the cleanup', () => ({ isError: true, content: [] }), 'The original runtime rejected turn cleanup'],
    ['does not acknowledge it', () => ({}), 'The original runtime did not acknowledge turn cleanup'],
    ['answers nothing', () => null, 'The original runtime did not acknowledge turn cleanup'],
    ['fails with a non-error', () => Promise.reject('socket closed'), 'socket closed'],
  ] as const) {
    test(`when the plugin ${name}, the strip says so and unloading is refused`, async () => {
      const { lc, states, errors } = lifecycle({ respond });
      lc.observe(item('item/completed', 'u1', 'click'));
      lc.observe(done('u1'));
      await assert.rejects(lc.ready('th'), { message: `Native control cleanup failed. Restart Codex before continuing: ${message}` });
      assert.deepEqual(errors, [['th', message]]);
      assert.deepEqual(states.at(-1), ['th', { phase: 'failed', turnId: 'u1', error: message }]);
      assert.equal(lc.pending('th'), 'th', 'a failed release still holds native operations');
    });
  }

  test('a JS reset the plugin does not acknowledge fails the cleanup', async () => {
    for (const reply of [{ isError: true, content: [] }, {}, undefined]) {
      const { lc, errors } = lifecycle({ respond: (_m: string, p: any) => (p.tool === 'js_reset' ? reply : { content: [] }) });
      lc.observe(item('item/started', 'u1'));
      lc.observe(done('u1', 'interrupted'));
      await assert.rejects(lc.ready('th'), /did not acknowledge JS reset/);
      assert.deepEqual(errors, [['th', 'The original runtime did not acknowledge JS reset']]);
      assert.equal(lc.resetContext('th'), null);
    }
  });

  test('cleanup is abandoned, not reported, when the connection or the thread goes away first', async () => {
    for (const how of ['clear', 'forget'] as const) {
      const { lc, calls, errors, states } = lifecycle();
      lc.observe(item('item/started', 'u1', 'click'));
      lc.observe(done('u1'));
      lc[how]('th');
      await settle();
      assert.equal(calls.length, 1, how);
      assert.deepEqual(errors, [], how);
      assert.equal(lc.has('th'), false, how);
      assert.deepEqual(states.at(-1), ['th', null], how);
    }
    // the thread stopped being native: reported, since the cleanup is still owed
    {
      const { lc, native, errors } = lifecycle();
      lc.observe(item('item/started', 'u1', 'click'));
      lc.observe(done('u1'));
      native.delete('th');
      await assert.rejects(lc.ready('th'), /closed before cleanup/);
      assert.deepEqual(errors, [['th', 'The original native connection closed before cleanup']]);
    }
  });

  test('a disconnect or close while the hook or the reset is sent abandons the cleanup', async () => {
    for (const when of ['turn_ended', 'js_reset'] as const) {
      for (const how of ['clear', 'forget'] as const) {
        const t = lifecycle();
        t.setRespond((_m, p) => {
          if (p.tool === when) t.lc[how](how === 'forget' ? 'th' : undefined);
          return { content: [] };
        });
        // the hook goes out while the turn's release is recorded, so the entry is caught as it is made
        const made: any[] = [];
        const release = t.lc.release.bind(t.lc);
        t.lc.release = (...args: any[]) => (made.push(release(...args)), made.at(-1));
        t.lc.observe(item('item/started', 'u1'));
        t.lc.observe(done('u1', 'interrupted'));
        const entry = made[0];
        await settle();
        assert.equal(entry.done, true, `${when} ${how}`);
        assert.match(entry.error.message, /closed before cleanup/, `${when} ${how}`);
        assert.deepEqual(t.errors, [], `${when} ${how}`);
        assert.equal(t.lc.resetContext('th'), null, `${when} ${how}`);
        // a connection that closed while the hook was sent gets no reset
        assert.deepEqual(
          t.calls.map((c) => c.tool),
          when === 'turn_ended' ? ['turn_ended'] : ['turn_ended', 'js_reset'],
          `${when} ${how}`,
        );
      }
    }
  });

  test('the thread losing its native path during the reset fails the cleanup', async () => {
    const t = lifecycle();
    t.setRespond((_m, p) => {
      if (p.tool === 'js_reset') t.native.delete('th');
      return { content: [] };
    });
    t.lc.observe(item('item/started', 'u1'));
    t.lc.observe(done('u1', 'interrupted'));
    await assert.rejects(t.lc.ready('th'), /closed before cleanup/);
    // the reset itself was acknowledged on the live connection
    assert.equal(t.lc.resetContext('th')?.turnId, 'u1');
  });

  test('ready() fails when Codex disconnects while it waits', async () => {
    let release!: () => void;
    const { lc } = lifecycle({ respond: () => new Promise((r) => (release = () => r({ content: [] }))) });
    lc.observe(item('item/started', 'u1', 'click'));
    lc.observe(done('u1'));
    await settle();
    const waiting = lc.ready('th');
    lc.clear();
    release();
    await assert.rejects(waiting, { message: 'Codex disconnected before native cleanup was confirmed' });
  });
}
