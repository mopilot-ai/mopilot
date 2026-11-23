// Codex adapter ownership cases using the shared scripted app-server and session fixtures.
import { test, assert, NO_REPLY, thread, setup, settle } from './fixture.ts';

export function registerRouting() {
  test('notifications reach the windows once, under the chat that owns the thread', () => {
    const { a, server, events, observed } = setup({}, { segments: { chat1: 'seg2' } });
    server.notify('item/agentMessage/delta', { threadId: 'seg2', turnId: 't', itemId: 'i', delta: 'hi' });
    assert.deepEqual(events[0].e, {
      kind: 'notification',
      chatId: 'chat1',
      method: 'item/agentMessage/delta',
      params: { threadId: 'chat1', turnId: 't', itemId: 'i', delta: 'hi' },
    });
    assert.equal(events[0].target, undefined);
    // the controller sees the raw message
    assert.equal(observed[0].params.threadId, 'seg2');
    // a later segment's own name never becomes the chat's
    server.notify('thread/name/updated', { threadId: 'seg2', threadName: 'x' });
    assert.equal(events.filter((x) => x.e.method === 'thread/name/updated').length, 0);
    // notifications with no thread pass through
    server.notify('account/updated', {});
    assert.equal(events.at(-1)!.e.chatId, null);
    assert.ok(a);
  });

  test('server requests become cards for the chat; a hidden helper thread is declined, never shown', async () => {
    const { a, server, events, observed } = setup({ 'thread/start': () => ({ thread: thread('helper', { ephemeral: true }) }) });
    server.ask('r1', 'item/commandExecution/requestApproval', { threadId: 't1', turnId: 'x' });
    assert.deepEqual(events.at(-1)!.e, {
      kind: 'request',
      chatId: 't1',
      request: { id: 'r1', method: 'item/commandExecution/requestApproval', params: { threadId: 't1', turnId: 'x' } },
    });
    assert.equal(observed.at(-1).id, 'r1');
    // a helper turn in flight
    const r = await a.request('thread/start', {});
    const done = a.helperTurn(r.thread.id, { input: [] }, 1000);
    await settle();
    const before = events.length;
    server.ask('r2', 'item/fileChange/requestApproval', { threadId: 'helper' });
    server.notify('item/agentMessage/delta', { threadId: 'helper', delta: { toString: 'not callable' } });
    server.notify('item/agentMessage/delta', { threadId: 'helper', delta: 'Fake ' });
    server.notify('item/agentMessage/delta', { threadId: 'helper', delta: 'title' });
    server.notify('turn/completed', { threadId: 'helper', turn: { id: 'h' } });
    assert.equal(await done, 'Fake title');
    assert.deepEqual(
      server.sent.find((m) => m.id === 'r2'),
      { id: 'r2', result: { decision: 'decline' } },
    );
    assert.equal(events.slice(before).filter((x) => x.e.kind !== 'lease').length, 0);
    // a legacy approval names its thread conversationId: it reaches its chat, and a helper's gets a ReviewDecision denial
    server.ask('r3', 'execCommandApproval', { conversationId: 't1', callId: 'c', command: ['ls'] });
    assert.equal(events.at(-1)!.e.chatId, 't1');
    assert.equal(events.at(-1)!.e.request.method, 'execCommandApproval');
    const r4 = await a.request('thread/start', {});
    const done4 = a.helperTurn(r4.thread.id, { input: [] }, 1000);
    await settle();
    server.ask('r4', 'applyPatchApproval', { conversationId: 'helper', callId: 'c', fileChanges: {} });
    server.notify('turn/completed', { threadId: 'helper', turn: { id: 'h2' } });
    await done4;
    assert.deepEqual(
      server.sent.find((m) => m.id === 'r4'),
      { id: 'r4', result: { decision: { denied: { rejection: 'Declined: a background thread does not ask the user.' } } } },
    );
  });
}

export function registerLeases() {
  test('leased writes go to nativeOf(chat) under its lease, and say when another app holds it', async () => {
    const { a, server } = setup({ 'thread/compact/start': () => ({ ok: 1 }) }, { segments: { chat1: 'seg2' } });
    assert.deepEqual(await a.leased('chat1', 'thread/compact/start', { threadId: 'ignored' }), { result: { ok: 1 } });
    assert.equal(server.sent.find((m) => m.method === 'thread/compact/start').params.threadId, 'seg2');
    const b = setup({
      'thread/resume': () => {
        throw new Error('active writer');
      },
    });
    assert.deepEqual(await b.a.leased('t1', 'thread/compact/start', {}), { locked: true });
  });

  test('idle leases are let go of; a busy chat, a running turn or a pinned lease keeps it', async () => {
    let now = 1_000;
    const { a, server, state, events } = setup({}, { now: () => now });
    await a.ensureResumed('t1');
    await a.ensureResumed('t2');
    await a.ensureResumed('t3');
    state.patch('t1', { turn: 'running' });
    server.notify('turn/started', { threadId: 't3', turn: { id: 'x' } });
    a.pin('t2', true);
    now += 10_000;
    a.releaseIdle();
    await settle();
    assert.equal(server.methods().includes('thread/unsubscribe'), false);
    state.patch('t1', { turn: 'idle' });
    a.pin('t2', false);
    now += 10_000;
    a.releaseIdle();
    await settle();
    const unsub = server.sent.filter((m) => m.method === 'thread/unsubscribe').map((m) => m.params.threadId);
    assert.deepEqual(unsub.sort(), ['t1', 't2']);
    assert.deepEqual(a.leaseList(), ['t3']);
    assert.ok(events.some((x) => x.e.kind === 'lease' && x.e.threadId === 't1' && !x.e.held && x.e.reason === 'released'));
  });

  test('the app-server exiting fails what was in flight and drops every lease', async () => {
    const { a, server, exits, events } = setup({ 'thread/read': NO_REPLY });
    await a.ensureResumed('t1');
    const p = a.request('thread/read', {});
    await settle();
    server.emit({ kind: 'exit', code: 1, signal: null, stderr: '' });
    await assert.rejects(p, /exited/);
    assert.deepEqual(a.leaseList(), []);
    assert.deepEqual(exits, ['Codex stopped']);
    assert.ok(events.some((x) => x.e.kind === 'lease' && x.e.reason === 'exit'));
  });
}

export function registerRoutingEdges() {
  test('native cleanup keeps configured roots separate while tracking inherited children', () => {
    for (const tools of [
      undefined,
      { isNativeThread: () => true },
      { isNativeThread: () => true, isLoadedThread: (id: string) => id === 'other' },
    ]) {
      const { a } = setup({}, { tools });
      a.nativeLifecycle.adopt('child', 'root');
      assert.equal(a.nativeLifecycle.subagents.has('child'), tools !== undefined);
      a.nativeLifecycle.adopt('other', 'root');
      assert.equal(a.nativeLifecycle.subagents.has('other'), tools !== undefined && !('isLoadedThread' in tools));
    }
  });

  test('stream validation leaves responses, null input and server requests on their own paths', () => {
    const { a, server, events } = setup();
    assert.doesNotThrow(() => a.onMessage(null));
    server.ask('rpc', 'item/agentMessage/delta', { threadId: 't1', delta: {} });
    assert.equal(events.at(-1)?.e.kind, 'request');
    assert.equal(events.at(-1)?.e.request.id, 'rpc');
  });

  test('Codex dispatch rejects invalid reasoning indices before event delivery', () => {
    const { server, events } = setup();
    const before = events.length;
    for (const method of ['item/reasoning/summaryPartAdded', 'item/reasoning/summaryTextDelta']) {
      server.notify(method, { threadId: 't1', turnId: 'T', itemId: 'r', summaryIndex: -1, delta: 'bad' });
    }
    server.notify('item/reasoning/textDelta', { threadId: 't1', turnId: 'T', itemId: 'r', contentIndex: 4294967295, delta: 'bad' });
    assert.equal(events.length, before);
    server.notify('item/reasoning/summaryTextDelta', { threadId: 't1', turnId: 'T', itemId: 'r', summaryIndex: 0, delta: 'Kept' });
    assert.equal(events.at(-1)?.e.params.delta, 'Kept');
  });
}
