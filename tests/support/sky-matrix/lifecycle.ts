// lifecycle Sky matrix cases using shared fake harness and desktop fixtures.
import {
  test,
  assert,
  NATIVE_CLEANUP_WAIT_MS,
  NativeCodexLifecycle,
  chatCleanupState,
  CodexThreadParents,
  cuaAssignments,
  settle,
  js,
  turn,
  NOTES,
  adapterRig,
} from './fixture.ts';

export function registerCleanup() {
  test('CM-V05: a sub-agent turn that used Codex Computer Use ends with SubagentStop on its root only, and the chat shows the release', async () => {
    const r = adapterRig({ hold: ['mcpServer/tool/call'] });
    r.notify('thread/started', { thread: { id: 'nat-sub', parentThreadId: 'nat' } });
    r.notify('turn/started', turn('nat-sub', 's1', 'inProgress'));
    r.notify('item/started', js('nat-sub', 's1', NOTES));
    r.notify('item/completed', js('nat-sub', 's1', NOTES, 's1-js', 'completed'));
    r.notify('turn/completed', turn('nat-sub', 's1'));
    await settle();
    // the vendor's hooks send only SubagentStop for an agent: no Stop or Interrupt on the sub-agent thread
    assert.deepEqual(r.server.hooks(), [['nat', 'turn_ended', 'SubagentStop', 'nat-sub']]);
    assert.equal(r.state.get('chat').nativeCleanup?.phase, 'releasing', "the strip shows in the parent's chat");
    assert.equal(r.state.has('nat-sub'), false, 'never under the sub-agent thread id');
    assert.equal(r.adapter.nativeLifecycle.pending('nat-sub'), 'nat', "a sub-agent's next approval waits for its root's release");
    r.server.release('mcpServer/tool/call');
    await settle();
    assert.equal(r.state.get('chat').nativeCleanup, null);
  });

  test('CM-V06: a failed native release does not hold archive or delete; compaction and unload wait for a slow one only briefly', async (t) => {
    const failing = adapterRig({
      handlers: {
        'mcpServer/tool/call': () => {
          throw new Error('plugin gone');
        },
      },
    });
    failing.notify('item/started', js('nat', 't1', NOTES));
    failing.notify('turn/completed', turn('nat', 't1'));
    await settle();
    assert.equal(failing.state.get('chat').nativeCleanup.phase, 'failed');
    await failing.adapter.request('thread/archive', { threadId: 'nat' });
    await failing.adapter.request('thread/delete', { threadId: 'nat' });
    await failing.adapter.request('thread/unsubscribe', { threadId: 'nat' });
    assert.deepEqual(
      // the chat's background-command read at its turn's end (codexBackgroundWork.cjs) is not a write
      failing.server.methods().filter((m) => m.startsWith('thread/') && m !== 'thread/backgroundTerminals/list'),
      ['thread/archive', 'thread/delete', 'thread/unsubscribe'],
    );
    // a release still running: compaction waits for it, but never more than NATIVE_CLEANUP_WAIT_MS
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const slow = adapterRig({ hold: ['mcpServer/tool/call'] });
    slow.notify('item/started', js('nat', 't1', NOTES));
    slow.notify('turn/completed', turn('nat', 't1'));
    await settle();
    const compact = slow.adapter.request('thread/compact/start', { threadId: 'nat' });
    await settle();
    assert.equal(slow.server.methods().includes('thread/compact/start'), false);
    t.mock.timers.tick(NATIVE_CLEANUP_WAIT_MS);
    await settle();
    await compact;
    assert.ok(slow.server.methods().includes('thread/compact/start'));
    // an idle release leaves a thread whose release still runs loaded until the next sweep
    slow.adapter.hold('nat', { id: 'nat', cwd: '/w' });
    await slow.adapter.release('nat');
    assert.ok(slow.adapter.leases.has('nat'));
  });
}

export function registerReleaseState() {
  test("CM-V11: the release strip is the chat's across its threads: one thread's clean release does not hide another's failure", async () => {
    let fail = true;
    const r = adapterRig({
      handlers: {
        'mcpServer/tool/call': () => {
          if (fail) throw new Error('plugin gone');
          return { content: [] };
        },
      },
    });
    r.notify('item/started', js('old', 't1', NOTES));
    r.notify('turn/completed', turn('old', 't1'));
    await settle();
    assert.equal(r.state.get('chat').nativeCleanup.phase, 'failed');
    fail = false;
    r.notify('item/started', js('new', 't2', NOTES));
    r.notify('turn/completed', turn('new', 't2'));
    await settle();
    assert.equal(r.state.get('chat').nativeCleanup.phase, 'failed', "the new thread's release does not clear the old thread's failure");
    r.notify('thread/closed', { threadId: 'old' });
    await settle();
    assert.equal(r.state.get('chat').nativeCleanup, null);
    // a failure leads, then a release still running
    const states = new Map<string, any>([
      ['x', { phase: 'releasing', turnId: 'a', error: null }],
      ['y', { phase: 'failed', turnId: 'b', error: 'e' }],
    ]);
    assert.equal(chatCleanupState(states, () => true).phase, 'failed');
    assert.equal(chatCleanupState(states, (id: string) => id === 'x').phase, 'releasing');
    assert.equal(
      chatCleanupState(states, () => false),
      null,
    );
  });
}

export function registerRetry() {
  test('CM-V13: after a stopped turn did not confirm its end in time, the retry checks the turn and never starts while it still runs', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let listed: any[] = [{ id: 't1', status: 'inProgress' }];
    const r = adapterRig({ handlers: { 'thread/turns/list': () => ({ data: listed }), 'turn/start': () => ({ turn: { id: 't2' } }) } });
    r.notify('turn/started', turn('nat', 't1', 'inProgress'));
    r.notify('item/started', js('nat', 't1', NOTES));
    await r.adapter.request('turn/interrupt', { threadId: 'nat', turnId: 't1' });
    const first = r.adapter.request('turn/start', { threadId: 'nat', input: [] });
    await settle();
    t.mock.timers.tick(15_000);
    await assert.rejects(first, /has not confirmed that the stopped turn ended/);
    // the retry: Codex says the stopped turn still runs, so it waits for it to end
    const retry = r.adapter.request('turn/start', { threadId: 'nat', input: [] });
    await settle();
    assert.equal(r.server.methods().filter((m) => m === 'turn/start').length, 0, 'never steered into the running turn');
    assert.equal(r.server.methods().filter((m) => m === 'thread/turns/list').length, 1);
    // asked newest first explicitly, and read by its status alone
    assert.deepEqual(r.server.sent.find((m) => m.method === 'thread/turns/list').params, {
      threadId: 'nat',
      limit: 10,
      sortDirection: 'desc',
    });
    r.notify('turn/completed', turn('nat', 't1', 'interrupted'));
    await retry;
    assert.equal(r.server.methods().filter((m) => m === 'turn/start').length, 1);
    // another time Codex says the turn is over (or can't say): the retry goes ahead
    for (const answer of ['done', 'error'] as const) {
      r.notify('turn/started', turn('nat', `t5-${answer}`, 'inProgress'));
      r.notify('item/started', js('nat', `t5-${answer}`, NOTES, `j-${answer}`));
      await r.adapter.request('turn/interrupt', { threadId: 'nat', turnId: `t5-${answer}` });
      const late = r.adapter.request('turn/start', { threadId: 'nat', input: [] });
      await settle();
      t.mock.timers.tick(15_000);
      await assert.rejects(late);
      // interrupted is over, whether or not Codex filled in completedAt
      listed = [{ id: `t5-${answer}`, status: 'interrupted' }];
      if (answer === 'error')
        r.adapter.nativeLifecycle.turnRunning = async () => {
          throw new Error('offline');
        };
      await r.adapter.request('turn/start', { threadId: 'nat', input: [] });
      r.notify('turn/completed', turn('nat', `t5-${answer}`, 'interrupted'));
    }
    assert.equal(r.server.methods().filter((m) => m === 'turn/start').length, 3);
    // Codex keeps saying the stopped turn runs and never ends it: after a few tries the next turn goes ahead, with a warning
    const stuck = adapterRig({ handlers: { 'thread/turns/list': () => ({ data: [{ id: 's1', status: 'inProgress' }] }) } });
    stuck.notify('turn/started', turn('nat', 's1', 'inProgress'));
    stuck.notify('item/started', js('nat', 's1', NOTES));
    await stuck.adapter.request('turn/interrupt', { threadId: 'nat', turnId: 's1' });
    for (let i = 0; i < 3; i++) {
      const waiting = stuck.adapter.request('turn/start', { threadId: 'nat', input: [] });
      await settle();
      t.mock.timers.tick(15_000);
      await assert.rejects(waiting, /has not confirmed/);
    }
    assert.equal(stuck.server.methods().filter((m) => m === 'turn/start').length, 0);
    await stuck.adapter.request('turn/start', { threadId: 'nat', input: [] });
    assert.equal(stuck.server.methods().filter((m) => m === 'turn/start').length, 1, 'bounded: never blocked until Codex restarts');
    assert.ok(stuck.toasts().some((text) => text.startsWith('Codex never confirmed the stopped turn ended')));
  });
}

export function registerLifecycleEdges() {
  test('the native lifecycle edges: a stop replaced while Codex is asked, a sub-agent Sky problem, settling a thread with nothing to wait for', async () => {
    const sky: any[] = [];
    const parents = new CodexThreadParents();
    let lc: any;
    lc = new NativeCodexLifecycle({
      call: async () => ({ content: [] }),
      isNativeThread: (id: string) => parents.rootOf(id) === 'root',
      isLoadedThread: (id: string) => id === 'root',
      parents,
      onSkyProblem: (thread: string, p: any) => sky.push([thread, p.kind]),
      // the stopped turn ends while the app-server is being asked
      turnRunning: async (threadId: string, turnId: string) => (lc.turnEndedFor(threadId, turnId), true),
    });
    lc.observe({ method: 'item/started', params: js('root', 't1', NOTES) });
    lc.interrupt('root', 't1');
    lc.stops.get('root').expired = true;
    await lc.turnEnded('root');
    assert.equal(lc.stops.has('root'), false, 'the turn ended meanwhile: nothing to wait for');
    // a sub-agent's failed Sky call reaches the settings status under its native root
    lc.observe({ method: 'thread/started', params: { thread: { id: 'sub', parentThreadId: 'root' } } });
    lc.observe({
      method: 'item/completed',
      params: js('sub', 's1', NOTES, 'x', 'failed', { error: { message: 'Sky Computer Use API version mismatch: client=a server=b' } }),
    });
    assert.deepEqual(sky, [['root', 'versionMismatch']]);
    await lc.settled('unknown', 0);
    // a lifecycle without a warning listener still lets the next turn go ahead after its last try
    const quiet = new NativeCodexLifecycle({ call: async () => ({ content: [] }), isNativeThread: () => true, maxEndChecks: 1 });
    quiet.interrupt('q', 'u1');
    quiet.stops.get('q').expired = true;
    await quiet.turnEnded('q');
    assert.equal(quiet.stops.has('q'), false);
    // assignments the shared reader cannot name an app for
    assert.deepEqual(cuaAssignments(5), []);
    assert.deepEqual(
      cuaAssignments("a = cua.getApp(''); b = cua.getApp('No' + suffix); c = cua.listApps()").map((x) => [x.name, x.kind, x.app ?? null]),
      [
        ['a', 'app', null],
        ['b', 'app', null],
        ['c', 'other', null],
      ],
    );
  });

  test('the adapter edges: a held request resolved before its failed release, a completion without an item, a turn list Codex cannot read', async () => {
    const r = adapterRig({
      handlers: {
        'mcpServer/tool/call': () => {
          throw new Error('plugin gone');
        },
        'thread/turns/list': () => ({}),
      },
    });
    r.notify('item/started', js('nat', 't1', NOTES));
    r.notify('turn/completed', turn('nat', 't1'));
    r.server.ask('e1', 'mcpServer/elicitation/request', {
      threadId: 'nat',
      turnId: 't2',
      serverName: 'cua_repl',
      mode: 'form',
      message: 'x',
    });
    r.notify('serverRequest/resolved', { threadId: 'nat', requestId: 'e1' });
    await settle();
    assert.equal(
      r.server.answers().some((a) => a.id === 'e1'),
      false,
      'resolved meanwhile: nothing to decline',
    );
    r.adapter.hostDeclined.set(JSON.stringify(['nat', 't2']), { threadId: 'nat', reason: 'cleanupBlocked' });
    r.notify('item/completed', { threadId: 'nat', turnId: 't2' });
    assert.equal(r.adapter.hostDeclined.has(JSON.stringify(['nat', 't2'])), true);
    assert.equal(await r.adapter.nativeLifecycle.turnRunning('nat', 't2'), false);
  });
}
