// Queued compaction follows main's turn, retry, removal and harness-switch ownership without a renderer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, tick, selectSegment, codex } from './support/controller/fixture';
import { deferred } from './support/async-scenarios';
import { createRequire } from 'node:module';

const { assertInputCurrent } = createRequire(import.meta.url)('../electron/session/contract/inputGuard.cjs');
const compact = (id = 'compact', args = '') => ({
  id,
  text: `/compact${args ? ` ${args}` : ''}`,
  attachments: [],
  opts: { human: true, retainInMain: true, compact: { args } },
  followUp: 'steer',
});
const normal = (id: string) => ({ id, text: id, opts: { human: true } });

function rig() {
  const r = setup();
  const requests: any[] = [];
  Object.assign(r.c.codex, {
    compacting: new Set(),
    touch: () => {},
    request: async (method: string, params: any) => {
      assertInputCurrent(params);
      requests.push([method, params.threadId]);
      return {};
    },
  });
  return { ...r, requests };
}

test('busy compaction queues once across windows, keeps message order and cannot be steered', async () => {
  const { c, s, execs, requests } = rig();
  c.send('chat', normal('first'), 1);
  await tick();
  c.send('chat', normal('before'), 2);
  const receipt = await c.send('chat', compact(), 1, true);
  assert.deepEqual(receipt, { action: 'queued', id: 'compact' });
  assert.deepEqual(await c.send('chat', compact('other-window'), 2, true), receipt);
  assert.deepEqual(c.send('chat', compact('third-window'), 3), receipt);
  c.send('chat', normal('after'), 2);
  assert.equal(c.sendNow('chat', 'compact', 1), true);
  assert.deepEqual(c.sendNow('chat', 'compact', 1, true), {
    status: 'queued',
    error: 'Compaction will run after the current turn.',
  });
  assert.deepEqual(
    s('chat').queue.map((q: any) => q.id),
    ['before', 'compact', 'after'],
  );
  assert.equal(requests.length, 0);
  c.end('chat');
  await tick();
  assert.equal(execs.at(-1)!.item.id, 'before');
  c.end('chat');
  await tick();
  assert.deepEqual(requests, [['thread/compact/start', 'chat']]);
  assert.deepEqual(
    s('chat').queue.map((q: any) => q.id),
    ['after'],
  );
  assert.equal(execs.length, 2, 'compaction is a native operation, never a model prompt');
  c.end('chat');
  await tick();
  assert.equal(execs.at(-1)!.item.id, 'after');
});

test('distinct compaction instructions serialize and removal cancels only the selected request', async () => {
  const { c, s, execs } = rig();
  c.send('claude:s', normal('first'));
  c.send('claude:s', compact('a', 'Keep decisions'));
  c.send('claude:s', compact('b', 'Keep tests'));
  assert.deepEqual(
    s('claude:s').queue.map((q: any) => q.id),
    ['a', 'b'],
  );
  assert.equal(c.removeQueued('claude:s', 'a').opts.compact.args, 'Keep decisions');
  c.end('claude:s');
  await tick();
  assert.equal(execs.at(-1)?.item.text, '/compact Keep tests');
  assert.equal(s('claude:s').queue.length, 0);
});

for (const chat of ['chat', 'claude:s']) {
  test(`a compact requested during native compaction waits for the whole turn: ${chat}`, async () => {
    const { c, s, execs, requests } = rig();
    c.send(chat, normal('first'));
    await tick();
    const signal = (phase: 'started' | 'completed') => {
      if (chat === 'chat')
        c.onCodexMessage(
          codex(`item/${phase}`, {
            threadId: chat,
            turnId: s(chat).activeTurn.id,
            item: { type: 'contextCompaction', id: 'auto' },
          }),
        );
      else
        c.onClaudeEvent({
          key: chat,
          kind: 'message',
          msg: {
            type: 'system',
            subtype: 'status',
            session_id: 's',
            status: phase === 'started' ? 'compacting' : null,
            ...(phase === 'completed' ? { compact_result: 'success' } : {}),
          },
        });
    };
    signal('started');
    assert.equal(s(chat).compaction, 'active');
    assert.equal((await c.send(chat, compact(), 1, true)).action, 'queued');
    signal('completed');
    await tick();
    assert.equal(execs.length, 1);
    assert.equal(requests.length, 0);
    assert.equal(s(chat).queue[0].id, 'compact');
    c.end(chat);
    await tick();
    assert.equal(chat === 'chat' ? requests.length : execs.length - 1, 1);
  });
}

test('compaction preserves a pending harness switch and its handoff for the next actual message', async () => {
  const { c, s, state, execs, requests } = rig();
  c.send('chat', normal('first'));
  await tick();
  c.send('chat', compact());
  c.send('chat', normal('next-message'));
  state.patch('chat', { pendingSwitch: { harness: 'claude', model: 'next-model' } });
  c.end('chat');
  await tick();
  assert.deepEqual(requests, [['thread/compact/start', 'chat']]);
  assert.equal(execs.filter((e: any) => e.kind === 'handoff').length, 0);
  assert.equal(s('chat').pendingSwitch.harness, 'claude');
  c.end('chat');
  await tick();
  const sent = execs.at(-1)!;
  assert.equal(execs.filter((e: any) => e.kind === 'handoff').length, 1);
  assert.equal(sent.item.text, 'next-message');
  assert.equal(sent.item.opts.prefix, '<handoff>');
});

test('compaction leaves a resumed host handoff pending until actual input arrives', async () => {
  const { c, execs, requests } = rig();
  c.switcher.pendingContinue = () => ({ harness: 'codex', continue: { id: 'handoff' } });
  assert.equal((await c.send('chat', compact(), 1, true)).action, 'started');
  assert.deepEqual(requests, [['thread/compact/start', 'chat']]);
  assert.equal(execs.length, 0);
  c.end('chat');
  await c.send('chat', normal('continue'), 1, true);
  assert.equal(execs[0].kind, 'handoff');
  assert.equal(execs[1].item.text, 'continue');
  assert.equal(execs[1].item.opts.prefix, '<handoff>');
});

for (const [kind, nativeId, commands, expected] of [
  ['claude', 's', null, '/compact Keep decisions'],
  ['acp:kimi', 's', [{ name: 'compress' }], '/compress Keep decisions'],
  ['acp:qwen', 's', ['/compress', '/compact'], '/compact Keep decisions'],
] as const) {
  test(`a queued compaction uses the receiving ${kind} adapter's command after a switch`, async () => {
    const { c, chats, state, execs, requests } = rig();
    c.send('chat', normal('first'));
    await tick();
    c.send('chat', compact('q', 'Keep decisions'));
    selectSegment(c, chats, 'chat', [
      ['codex', 'old'],
      [kind, nativeId],
    ]);
    if (commands) state.patch('chat', { acp: { commands } });
    c.end('chat');
    await tick();
    assert.equal(execs.at(-1)!.item.text, expected);
    assert.equal(execs.at(-1)!.ref.kind, kind);
    assert.equal(execs.at(-1)!.item.opts.prefix, undefined);
    assert.equal(requests.length, 0);
  });
}

test('unsupported ACP compaction keeps the request for retry and sends no prompt', async () => {
  const { c, chats, s, state, execs } = rig();
  selectSegment(c, chats, 'chat', [['acp:kimi', 's']]);
  const result = await c.send('chat', compact(), null, true);
  assert.equal(result.action, 'queued');
  assert.equal(execs.length, 0);
  assert.equal(s('chat').queue[0].id, 'compact');
  assert.match(s('chat').crashed, /can't compact/);
  state.patch('chat', { acp: { commands: ['compress'] } });
  assert.deepEqual(await c.sendNow('chat', 'compact', null, true), { status: 'sent' });
  assert.equal(execs[0].item.text, '/compress');
});

for (const commands of [[], ['compact'], null]) {
  test(`an ACP command change during preflight retains compaction for retry: ${JSON.stringify(commands)}`, async () => {
    const { c, chats, state, s } = rig();
    selectSegment(c, chats, 'chat', [['acp:kimi', 's']]);
    state.patch('chat', { acp: { commands: ['compress'] } });
    const preflight = deferred<void>();
    const sent: string[] = [];
    c.acpTurns.startTurn = async (_chat: string, _ref: any, item: any) => {
      await preflight.promise;
      assertInputCurrent(item);
      sent.push(item.text);
      return { started: true };
    };
    const receipt = c.send('chat', compact(), 1, true);
    state.patch('chat', { acp: commands === null ? null : { commands } });
    preflight.resolve();
    assert.equal((await receipt).action, 'queued');
    assert.deepEqual(sent, []);
    assert.equal(s('chat').queue[0].id, 'compact');
    assert.match(s('chat').crashed, /command changed/);
  });
}

test('Claude and ACP compaction preserve literal replacement tokens in custom instructions', async () => {
  for (const kind of ['claude', 'acp:kimi']) {
    const { c, chats, state, execs } = rig();
    selectSegment(c, chats, 'chat', [[kind, 's']]);
    state.patch('chat', { acp: { commands: ['compress'] } });
    assert.equal((await c.send('chat', compact('q', 'Keep $$ and $& literally'), 1, true)).action, 'started');
    assert.equal(execs[0].item.text, `${kind === 'claude' ? '/compact' : '/compress'} Keep $$ and $& literally`);
  }
});

test('native rejection retains one retryable request and clears manual-compaction attribution', async () => {
  const { c, s, requests } = rig();
  const request = c.codex.request;
  c.codex.request = async () => {
    throw new Error('Compaction unavailable');
  };
  const receipt = await c.send('chat', compact(), null, true);
  assert.equal(receipt.action, 'queued');
  assert.equal(s('chat').queue.length, 1);
  assert.match(s('chat').crashed, /Compaction unavailable/);
  assert.equal(c.codex.compacting.size, 0);
  c.codex.request = request;
  assert.deepEqual(await c.sendNow('chat', 'compact', null, true), { status: 'sent' });
  assert.equal(requests.length, 1);
  assert.equal(s('chat').queue.length, 0);
});

test('Stop while native resume waits retires dispatch and retains the compact action', async () => {
  const { c, s, requests } = rig();
  const resume = deferred<void>();
  c.codex.ensureResumed = () => resume.promise;
  const receipt = c.send('chat', compact(), null, true);
  c.noteStop('chat');
  c.end('chat', { drain: false });
  resume.resolve();
  assert.equal((await receipt).action, 'queued');
  assert.equal(requests.length, 0);
  assert.equal(s('chat').queue[0].id, 'compact');
});

for (const retire of ['switch', 'end']) {
  test(`a ${retire} during native resume cannot compact the retired owner`, async () => {
    const { c, chats, requests, s } = rig();
    const resume = deferred<void>();
    c.codex.ensureResumed = () => resume.promise;
    const receipt = c.send('chat', compact(), null, true);
    if (retire === 'switch')
      selectSegment(c, chats, 'chat', [
        ['codex', 'old'],
        ['claude', 'new'],
      ]);
    else c.end('chat', { drain: false });
    resume.resolve();
    assert.equal((await receipt).action, 'queued');
    assert.equal(requests.length, 0);
    assert.equal(s('chat').queue[0].id, 'compact');
  });
}

test('resume rejection retains the request without adding manual-compaction attribution', async () => {
  const { c, s } = rig();
  c.codex.ensureResumed = async () => {
    throw new Error('Another app holds the chat');
  };
  assert.equal((await c.send('chat', compact(), null, true)).action, 'queued');
  assert.equal(c.codex.compacting.size, 0);
  assert.equal(s('chat').queue.length, 1);
  assert.match(s('chat').crashed, /Another app holds/);
});

test('a native compaction remains pending until transport accepts it and a second click queues', async () => {
  const { c, s } = rig();
  const request = deferred();
  c.codex.request = () => request.promise;
  const first = c.send('chat', compact('first'), 1, true);
  await tick();
  let settled = false;
  void first.then(() => {
    settled = true;
  });
  const next = await c.send('chat', compact('next'), 2, true);
  assert.deepEqual(next, { action: 'queued', id: 'next' });
  assert.equal(settled, false);
  request.resolve({});
  assert.equal((await first).action, 'started');
  assert.equal(s('chat').queue[0].id, 'next');
});

test('malformed compact options cannot coalesce with or consume an ordinary queued message', async () => {
  const { c, s, requests } = rig();
  c.send('chat', normal('first'));
  c.send('chat', normal('keep'));
  c.send('chat', { ...compact(), opts: { compact: {} } });
  assert.deepEqual(
    s('chat').queue.map((q: any) => q.id),
    ['keep', 'compact'],
  );
  c.end('chat');
  await tick();
  c.end('chat');
  await tick();
  assert.equal(requests.length, 0);
  assert.match(s('chat').crashed, /Invalid compaction request/);
  assert.equal(s('chat').queue[0].id, 'compact');
});
