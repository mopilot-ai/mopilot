// Codex harness helpers unit cases with shared server and session fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ThreadLocked, settle, thread, setup } from './fixture';
import { codex } from './fixture';

export function registerHelpersCases() {
  test('helperTurn: a completed agent message replaces the deltas; a timeout resolves what came; a failed start rejects', async () => {
    const { a, server } = setup({
      'turn/start': (p: any) => {
        if (p.threadId === 'bad') throw new Error('no thread');
        return {};
      },
    });
    const p1 = a.helperTurn('h1', { input: [] }, 1000);
    await settle();
    server.notify('item/agentMessage/delta', { threadId: 'h1' });
    server.notify('item/agentMessage/delta', { threadId: 'h1', delta: 'draft' });
    server.notify('item/completed', { threadId: 'h1', item: { type: 'agentMessage' } });
    assert.equal(a.hidden.has('h1'), true);
    server.notify('item/completed', { threadId: 'h1', item: { type: 'agentMessage', text: 'Final' } });
    server.notify('item/completed', { threadId: 'h1', item: { type: 'reasoning', text: 'no' } });
    server.notify('turn/completed', { threadId: 'h1' });
    assert.equal(await p1, 'Final');
    assert.equal(await a.helperTurn('h2', { input: [] }, 5), '');
    await assert.rejects(a.helperTurn('bad', { input: [] }, 1000), /no thread/);
    assert.equal(a.hidden.size, 0);
  });

  test('autoTitle: once per thread, never for a blank prompt; a rename meanwhile wins', async () => {
    let a: any;
    const ctx = setup({
      'thread/start': () => ({ thread: thread('helper', { ephemeral: true }) }),
      'turn/start': (p: any) => {
        setImmediate(() => {
          ctx.server.notify('item/completed', { threadId: p.threadId, item: { type: 'agentMessage', text: 'Generated title' } });
          // the user renamed it meanwhile
          a.meta.get('t').name = 'User name';
          ctx.server.notify('turn/completed', { threadId: p.threadId });
        });
        return {};
      },
    });
    a = ctx.a;
    a.meta.set('t', thread('t'));
    await a.autoTitle('t', '   ');
    assert.equal(ctx.events.length, 0);
    const p = a.autoTitle('t', 'fix the login bug');
    await a.autoTitle('t', 'again');
    await p;
    assert.deepEqual(ctx.server.params('thread/name/set'), []);
    assert.deepEqual(ctx.server.params('thread/unsubscribe'), [{ threadId: 'helper' }]);
    assert.equal(a.titling.size, 0);
  });

  test('autoTitle: a title cancelled by a rename is not set; a failed helper falls back to the provisional title unless renamed', async () => {
    const ctx = setup({
      'thread/start': () => {
        throw new Error('no helper');
      },
    });
    const { a, server } = ctx;
    await a.autoTitle('t', 'fix the login bug');
    assert.equal(server.params('thread/name/set').length, 1);
    assert.deepEqual(server.params('thread/unsubscribe'), []);
    a.meta.set('u', thread('u', { name: 'Renamed' }));
    await a.autoTitle('u', 'fix the login bug');
    assert.equal(server.params('thread/name/set').length, 1);
    // renamed through the API during the helper turn: titling is cancelled
    const c2 = setup({
      'thread/start': () => ({ thread: thread('helper', { ephemeral: true }) }),
      'turn/start': (p: any) => {
        setImmediate(() => {
          c2.a.threadRename('v', 'Mine');
          c2.server.notify('turn/completed', { threadId: p.threadId });
        });
        return {};
      },
    });
    await c2.a.autoTitle('v', 'x');
    assert.deepEqual(c2.server.params('thread/name/set'), [{ threadId: 'v', name: 'Mine' }]);
    // cancelled while failing: no provisional title either
    const c3 = setup({
      'thread/start': () => ({ thread: thread('helper', { ephemeral: true }) }),
      'turn/start': () => {
        c3.a.titling.delete('w');
        throw new Error('x');
      },
    });
    await c3.a.autoTitle('w', 'x');
    assert.deepEqual(c3.server.params('thread/name/set'), []);
    // a meta already named with the provisional title still gets it set
    const c4 = setup({
      'thread/start': () => {
        throw new Error('no helper');
      },
    });
    const provisional = codex.provisionalTitle('fix the login bug');
    c4.a.meta.set('z', thread('z', { name: provisional }));
    await c4.a.autoTitle('z', 'fix the login bug');
    assert.deepEqual(c4.server.params('thread/name/set'), [{ threadId: 'z', name: provisional }]);
  });

  test('summarize writes a handoff note in an ephemeral fork and lets the fork go', async () => {
    const ctx = setup({
      'thread/fork': () => ({ thread: thread('fork1', { ephemeral: true }) }),
      'turn/start': (p: any) => {
        setImmediate(() => {
          ctx.server.notify('item/completed', { threadId: p.threadId, item: { type: 'agentMessage', text: '  the note  ' } });
          ctx.server.notify('turn/completed', { threadId: p.threadId });
        });
        return {};
      },
    });
    assert.equal(await ctx.a.summarize('t', 'Summarize'), 'the note');
    const fork = ctx.server.params('thread/fork')[0];
    assert.deepEqual(fork, { threadId: 't', ephemeral: true, excludeTurns: true });
    const start = ctx.server.params('turn/start')[0];
    assert.equal(start.sandbox, 'read-only');
    assert.equal(start.effort, 'low');
    await settle();
    assert.deepEqual(ctx.server.params('thread/unsubscribe'), [{ threadId: 'fork1' }]);
  });

  test('api rejects calls a window may not make', async () => {
    const { a } = setup();
    await assert.rejects(a.api('respond', []), /Unknown Codex call respond/);
    assert.ok(ThreadLocked);
  });
}
