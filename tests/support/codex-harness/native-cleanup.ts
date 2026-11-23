// Codex harness native-cleanup unit cases with shared server and session fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settle, thread, setup, type Handler } from './fixture';

export function registerNativeCleanupCases() {
  function nativeRig(handlers: Record<string, Handler> = {}) {
    const tools = { setUserServers() {}, observe() {}, exited() {}, outgoing: (m: any) => m, isNativeThread: (id: string) => id === 't' };
    const r = setup(handlers, { tools });
    const control = (turnId: string, status = 'completed', tool = 'click') => {
      r.server.notify('item/started', {
        threadId: 't',
        turnId,
        item: { type: 'mcpToolCall', server: 'cua_repl', tool, id: `${turnId}-call` },
      });
      r.server.notify('turn/completed', { threadId: 't', turn: { id: turnId, status } });
    };
    return { ...r, control };
  }

  test('a native thread waits for the plugin cleanup before an unload; a turn or an active goal only for its turn to end', async () => {
    const acks: (() => void)[] = [];
    const { a, server, control } = nativeRig({
      'mcpServer/tool/call': () => new Promise((resolve) => acks.push(() => resolve({ content: [] }))),
    });
    control('u1');
    await settle();
    assert.deepEqual(
      server.params('mcpServer/tool/call').map((p: any) => [p.tool, p.arguments.turn_id]),
      [['turn_ended', 'u1']],
    );
    // a paused goal, the next turn and an active goal (they wait only for the stopped turn, which has
    // ended) are not gated; an unsubscribe waits for the acknowledgement
    await a.request('thread/goal/set', { threadId: 't', status: 'paused' });
    const turn = a.request('turn/start', { threadId: 't', input: [] });
    const goal = a.request('thread/goal/set', { threadId: 't', status: 'active' });
    const unload = a.request('thread/unsubscribe', { threadId: 't' });
    await settle();
    assert.equal(server.params('turn/start').length, 1);
    assert.equal(server.params('thread/goal/set').length, 2);
    assert.equal(server.params('thread/unsubscribe').length, 0);
    acks.shift()!();
    await Promise.all([turn, goal, unload]);
    assert.deepEqual(
      server.params('thread/goal/set').map((p: any) => p.status),
      ['paused', 'active'],
    );
    assert.equal(server.params('thread/unsubscribe').length, 1);
    // once the cleanup is confirmed, an idle thread is let go as usual
    a.hold('t', thread('t'));
    await a.release('t');
    assert.equal(a.leases.has('t'), false);
    assert.equal(server.params('thread/unsubscribe').length, 2);
  });

  test('a failed native cleanup is reported; the next turn still starts, and the idle thread is unloaded (which ends its plugin session)', async () => {
    const { a, server, of, state, control } = nativeRig({
      'mcpServer/tool/call': () => {
        throw new Error('plugin gone');
      },
    });
    control('u1');
    await settle();
    assert.ok(of('toast').some((x) => x.e.text === 'Native control cleanup failed: Plugin gone.'));
    assert.equal(state.get('t').nativeCleanup.phase, 'failed');
    // the turn waits only for its stopped turn; native work on the failed release is what gets stopped
    assert.deepEqual(await a.startTurn('t', { kind: 'codex', id: 't' }, { text: 'next' }), { started: true, turnId: 'turn-1' });
    assert.equal(server.params('turn/start').length, 1);
    // a failed release no longer keeps the thread loaded until Codex restarts (CM-V03)
    a.running.delete('t');
    a.hold('t', thread('t'));
    await a.release('t');
    assert.equal(a.leases.has('t'), false);
    assert.equal(server.params('thread/unsubscribe').length, 1);
  });

  test('after an interrupted native JS call is reset, the next turn alone is told so', async () => {
    const { a, server, control } = nativeRig({ 'mcpServer/tool/call': () => ({ content: [] }) });
    control('u2', 'interrupted', 'js');
    await settle();
    assert.deepEqual(
      server.params('mcpServer/tool/call').map((p: any) => p.tool),
      ['turn_ended', 'js_reset'],
    );
    await a.request('turn/start', { threadId: 't', input: [] });
    await a.request('turn/start', { threadId: 't', input: [] });
    const [first, second] = server.params('turn/start');
    assert.equal(first.additionalContext['mopilot.native-runtime-state'].kind, 'application');
    assert.equal(second.additionalContext, undefined);
  });

  test('stopping a native turn returns at once; a failed cleanup is reported in the background', async () => {
    let control: any;
    const r = nativeRig({
      'turn/interrupt': () => {
        setImmediate(() => control('u3'));
        return {};
      },
      'mcpServer/tool/call': () => ({ isError: true, content: [] }),
    });
    control = r.control;
    r.state.patch('t', { activeTurn: { id: 'u3' } });
    assert.equal(await r.a.stopTurn('t'), true);
    await settle();
    assert.equal(r.of('toast').at(-1)?.e.text, 'Native control cleanup failed: The original runtime rejected turn cleanup.');
  });

  test('a peer steer the server acknowledges without a turn id reports the running turn', async () => {
    const { a, state } = setup({ 'turn/steer': () => ({}) });
    state.patch('t', { activeTurn: { id: 'turn-7' } });
    const peer = { text: 'more', peer: { messageId: 'peer-1', sourceChatId: 'src' } };
    assert.deepEqual(await a.steer('t', { kind: 'codex', id: 't' }, peer), { started: true, turnId: 'turn-7', itemId: 'peer-1' });
  });

  test('thread/started for a later segment thread is not announced as a chat of its own', async () => {
    const { server, of } = setup({}, { segments: { chat: 'later' } });
    server.notify('thread/started', { thread: thread('later') });
    server.notify('thread/started', { thread: thread('solo') });
    await settle();
    assert.deepEqual(
      of('notification')
        .filter((x) => x.e.method === 'thread/started')
        .map((x) => x.e.chatId),
      ['solo'],
    );
  });
}
