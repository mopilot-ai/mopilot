// Child allocation survives rejected delivery: the same task stays owned once by its recipient, across every harness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { orchestration, SESSION_BACKGROUND as background } from './support/orchestration-harness.ts';
import { deferred } from './support/async-scenarios.ts';

const require = createRequire(import.meta.url);
const task = { title: 'Retained worker', prompt: 'The full original worker task', background, use_worktree: false };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixture(over: any = {}) {
  const h = orchestration(over);
  (h.controller as any).queueFirst = (id: string, item: any) => {
    const current = h.controller.state.get(id);
    h.states.set(id, { ...current, queue: [item, ...current.queue] });
  };
  h.userTurn();
  return h;
}

test('a rejected initial brief is retained in the same child; accepting a proposal twice never creates a second worker', async () => {
  for (const kind of ['codex', 'claude', 'acp:kimi']) {
    const h = fixture({
      send: async () => {
        throw new Error('outer send bookkeeping failed');
      },
    });
    h.refs.set('top', { kind, id: 'parent-native', key: 'top' });
    const proposal = await h.orch.start('top', { ...task, initiation: 'own_initiative' });
    const result = await h.orch.act(proposal.task_id, 'start');
    assert.equal(result.status, 'queued');
    assert.equal(h.journal.proposal(proposal.task_id).status, 'started');
    assert.equal(h.journal.proposal(proposal.task_id).chatId, result.chat_id);
    assert.equal(Object.keys(h.journal.data.children).length, 1);
    const queue = h.controller.state.get(result.chat_id).queue;
    assert.equal(queue.length, 1);
    assert.ok(queue[0].text.includes(task.prompt));
    assert.ok(queue[0].text.includes(background));
    assert.deepEqual(queue[0].sideSession, { id: queue[0].id });
    assert.equal(queue[0].opts.human, false);
    await assert.rejects(h.orch.act(proposal.task_id, 'start'), (error: any) => error.code === 'not_open');
    assert.equal(Object.keys(h.journal.data.children).length, 1);
  }
});

const { sendChild, sendingChild } = require('../electron/session/orchestration/childDelivery.cjs');
const item = (id = 'input-1') => ({
  id,
  text: 'complete input, including its context',
  attachments: [{ name: 'evidence.txt', path: '/scratch/evidence.txt' }],
  sideSession: { id },
  opts: { human: false, model: 'chosen-model', effort: 'high' },
  origin: 12,
});

function recipient(over: any = {}) {
  const h = fixture(over);
  h.records.set('child', { meta: {} });
  h.journal.change((data: any) => {
    data.children.child = {
      parentId: 'top',
      name: 'child',
      title: 'Child',
      createdAt: 1,
      driven: [],
      lastReport: null,
    };
  });
  return h;
}

test('public direct starts keep their cached allocated child after an unexpected sender rejection', async () => {
  const h = fixture({
    send: async () => {
      throw new Error('send refused');
    },
  });
  const first = await h.orch.start('top', task);
  const second = await h.orch.start('top', task);
  assert.deepEqual(second, first);
  assert.equal(first.status, 'queued');
  assert.equal(Object.keys(h.journal.data.children).length, 1);
  assert.equal(h.controller.state.get(first.chat_id).queue.length, 1);
});

test('concurrent duplicate attempts combine while a recipient-owned input is never sent twice', async () => {
  const pending = deferred<any>();
  let calls = 0;
  const h = recipient({
    send: () => {
      calls++;
      return pending.promise;
    },
  });
  const original = item();
  const first = sendChild(h.orch, 'child', original);
  const duplicate = sendChild(h.orch, 'child', original);
  assert.equal(first, duplicate);
  assert.equal(sendingChild(h.orch, 'child'), true);
  assert.equal(calls, 1);
  pending.resolve({ started: true });
  assert.deepEqual(await first, { started: true });
  assert.equal(sendingChild(h.orch, 'child'), false);
  h.rts.set('child', { inputToken: `pending-${original.id}` });
  h.states.set('child', { turn: 'running', activeTurn: { id: 'native-turn' } });
  assert.deepEqual(await sendChild(h.orch, 'child', original), { queued: true, acceptancePending: true });
  assert.equal(calls, 1);
  h.states.set('child', { queue: [original] });
  assert.deepEqual(await sendChild(h.orch, 'child', original), { queued: true });
  assert.equal(calls, 1);
});

test('busy queue receipts are truthful and native rejection retains full input with options, attachments and origin', async () => {
  const h = recipient({ send: async () => ({ action: 'queued', id: 'input-1' }) });
  assert.deepEqual(await sendChild(h.orch, 'child', item()), { action: 'queued', id: 'input-1', queued: true });
  h.orch.o.send = async () => ({ started: false, error: 'native refused' });
  assert.deepEqual(await sendChild(h.orch, 'child', item()), { queued: true, error: 'native refused' });
  const kept = h.controller.state.get('child').queue[0];
  assert.deepEqual({ ...kept, queuedAt: 0 }, { ...item(), queuedAt: 0 });
  assert.equal(h.journal.data.queue.length, 0);
  assert.deepEqual(await sendChild(h.orch, 'child', item()), { queued: true });
});

test('sender sync throws, missing responses and held/cancelled results do not escape the allocation transaction', async () => {
  const h = recipient({
    send: () => {
      throw 'synchronous failure';
    },
  });
  assert.deepEqual(await sendChild(h.orch, 'child', item()), { queued: true, error: 'synchronous failure' });
  h.states.set('child', { queue: [] });
  h.orch.o.send = () => undefined;
  assert.deepEqual(await sendChild(h.orch, 'child', item()), { queued: true, error: 'The harness did not accept the message.' });
  h.states.set('child', { queue: [] });
  h.orch.o.send = () => ({ held: true });
  assert.deepEqual(await sendChild(h.orch, 'child', item()), { held: true });
  h.orch.o.send = () => ({ discarded: true });
  assert.deepEqual(await sendChild(h.orch, 'child', item()), {
    discarded: true,
    started: false,
    error: 'This message was cancelled before delivery.',
  });
  assert.equal(h.controller.state.get('child').queue.length, 0);
});

test('a sender that already kept or still owns the input cannot cause a second queue owner after rejecting', async () => {
  for (const pending of [false, true]) {
    const h = recipient();
    h.orch.o.send = () => {
      if (pending) {
        h.rts.set('child', { inputToken: 'pending-input-1' });
        h.states.set('child', { turn: 'awaitingUser', activeTurn: { id: 'native-turn' } });
      } else h.states.set('child', { queue: [item()] });
      throw new Error('receipt bookkeeping failed');
    };
    const result = await sendChild(h.orch, 'child', item());
    assert.equal(result.queued, true);
    assert.equal(h.controller.state.get('child').queue.length, pending ? 0 : 1);
    assert.equal(h.journal.data.queue.length, 0);
  }
});

test('queue-keeper failures retain original full input in the durable journal, once, with explicit double-failure reporting', async () => {
  for (const keeper of ['throws', 'no-op', 'throws-after-publish']) {
    const h = recipient({ send: async () => ({ started: false, error: 'native refused' }) });
    (h.controller as any).queueFirst = (id: string, q: any) => {
      if (keeper === 'throws-after-publish') h.states.set(id, { queue: [q] });
      if (keeper !== 'no-op') throw new Error('queue could not publish');
    };
    const outcome = await sendChild(h.orch, 'child', item());
    assert.equal(outcome.queued, true);
    if (keeper === 'throws-after-publish') assert.equal(h.journal.data.queue.length, 0);
    else {
      assert.deepEqual(h.journal.data.queue[0].item, item());
      await sendChild(h.orch, 'child', item());
      assert.equal(h.journal.data.queue.length, 1);
    }
  }
  const h = recipient({ send: async () => ({ started: false }) });
  (h.controller as any).queueFirst = () => {
    throw new Error('queue unavailable');
  };
  h.journal.change = () => {
    throw new Error('disk unavailable');
  };
  const failed = await sendChild(h.orch, 'child', item());
  assert.equal(failed.started, false);
  assert.match(failed.error, /message could not be kept: disk unavailable/);
});

test('archived, deleted, native-replaced and restored recipients never receive a stale rejected input', async () => {
  for (const invalidation of ['archived', 'deleted', 'native', 'epoch', 'missing-ref']) {
    const pending = deferred<any>();
    const h = recipient({ send: () => pending.promise });
    let epoch = 0;
    h.orch.o.chats.archiveEpoch = () => epoch;
    const sending = sendChild(h.orch, 'child', item());
    if (invalidation === 'archived') h.records.get('child').meta.archived = 1;
    if (invalidation === 'deleted') h.deleted.add('child');
    if (invalidation === 'native') h.refs.set('child', { kind: 'claude', key: 'replacement' });
    if (invalidation === 'epoch') epoch += 2;
    if (invalidation === 'missing-ref')
      h.controller.ref = () => {
        throw new Error('no native session');
      };
    pending.reject(new Error('rejected after replacement'));
    const result = await sending;
    assert.equal(result.started, false, invalidation);
    assert.match(result.error, /session changed/);
    assert.equal(h.controller.state.get('child').queue.length, 0);
    assert.equal(h.journal.data.queue.length, 0);
  }
  const gone = recipient();
  gone.deleted.add('child');
  assert.match((await sendChild(gone.orch, 'child', item())).error, /archived or gone/);
  const noRef = recipient();
  noRef.controller.ref = () => {
    throw new Error('missing native');
  };
  assert.deepEqual(await sendChild(noRef.orch, 'child', item()), { started: false, error: 'missing native' });
});

test('overlapping native generations keep the recipient busy until both delivery attempts settle', async () => {
  const first = deferred<any>(),
    second = deferred<any>();
  let calls = 0;
  const h = recipient({ send: () => (++calls === 1 ? first.promise : second.promise) });
  const before = sendChild(h.orch, 'child', item());
  h.refs.set('child', { key: 'replacement', kind: 'claude' });
  const after = sendChild(h.orch, 'child', item('new-input'));
  first.reject(new Error('old owner retired'));
  await before;
  assert.equal(sendingChild(h.orch, 'child'), true);
  second.resolve({ started: true });
  await after;
  assert.equal(sendingChild(h.orch, 'child'), false);
});

test('legacy pump dispatch keeps full queued input and records explicit refusal without dispatching it twice', async () => {
  const pending = deferred<any>();
  let calls = 0;
  const h = recipient({
    send: () => {
      calls++;
      return pending.promise;
    },
  });
  h.states.set('child', { turn: 'running' });
  await h.orch.deliver('child', item());
  await h.orch.deliver('child', item('input-2'));
  h.states.set('child', { turn: 'idle' });
  h.orch.pump();
  h.orch.pump();
  assert.equal(calls, 1, 'recipient acceptance pending holds the next journal input');
  assert.equal(h.journal.data.queue.length, 1);
  pending.reject(new Error('legacy refusal'));
  await tick();
  assert.equal(h.controller.state.get('child').queue.length, 1);
  assert.deepEqual(h.controller.state.get('child').queue[0].attachments, item().attachments);
  assert.equal(h.controller.state.get('child').queue[0].opts.model, 'chosen-model');
  assert.match(h.journal.parent('top').notes[0].body, /legacy refusal/);
  h.orch.pump();
  assert.equal(calls, 1, 'a retained controller input stays ahead of the next legacy item');
});

test('public delivery coalesces pending input and never adds a second controller or journal copy', async () => {
  const pending = deferred<any>();
  let calls = 0;
  const h = recipient({
    send: () => {
      calls++;
      return pending.promise;
    },
  });
  const first = h.orch.deliver('child', item());
  const second = h.orch.deliver('child', item());
  pending.resolve({ started: true });
  assert.deepEqual(await second, await first);
  assert.equal(calls, 1);
  assert.equal(h.journal.data.queue.length, 0);
  h.states.set('child', { queue: [item()] });
  assert.deepEqual(await h.orch.deliver('child', item()), { queued: true });
  assert.equal(h.journal.data.queue.length, 0);
  h.states.set('child', { queue: [] });
  h.rts.set('child', { inputToken: 'pending-input-1' });
  h.states.set('child', { turn: 'running', activeTurn: { id: 'pending-input-1' } });
  assert.deepEqual(await h.orch.deliver('child', item()), { queued: true });
  h.rts.set('child', { inputToken: null });
  h.states.set('child', { turn: 'running' });
  assert.deepEqual(await h.orch.deliver('child', item()), { queued: true, position: 1 });
  assert.deepEqual(await h.orch.deliver('child', item()), { queued: true, position: 1 });
  assert.equal(h.journal.data.queue.length, 1);
});

test('current adapter settings win over historical child settings on direct and legacy queued sends', async () => {
  const received: any[] = [];
  const h = recipient({
    send: async (_id: string, value: any) => {
      received.push(value);
      return { started: true };
    },
  });
  h.journal.change((data: any) => {
    data.children.child.settings = {
      model: 'retired-model',
      effort: 'low',
      permission: 'bypassPermissions',
      additionalDirectories: ['/retired-notes'],
    };
  });
  const original = item();
  await h.orch.deliver('child', original);
  assert.deepEqual(received[0].opts, original.opts);
  h.states.set('child', { turn: 'running' });
  await h.orch.deliver('child', item('legacy-options'));
  h.states.set('child', { turn: 'idle' });
  h.orch.pump();
  await tick();
  assert.deepEqual(received[1].opts, original.opts);
});

test('legacy records without attachments still deliver, and a removed lineage receives no misleading failure note', async () => {
  const pending = deferred<any>();
  let received: any;
  const h = recipient({
    send: (_id: string, value: any) => {
      received = value;
      return pending.promise;
    },
  });
  h.journal.change((data: any) => {
    data.queue.push({ id: 'legacy', chatId: 'child', item: { id: 'legacy', text: 'old brief' }, at: 1 });
  });
  h.orch.pump();
  assert.deepEqual(received.attachments, []);
  assert.deepEqual(received.opts, { human: false });
  h.journal.change((data: any) => {
    delete data.children.child;
  });
  pending.reject(new Error('delivery refused'));
  await tick();
  assert.equal(h.journal.parent('top'), null);
  assert.equal(h.controller.state.get('child').queue.length, 1);
});

test('a failure while reading the retry queue still returns not-started for its existing child', async () => {
  const h = recipient();
  h.orch.o.send = () => {
    h.controller.state.get = () => {
      throw new Error('retry owner unavailable');
    };
    return Promise.reject(new Error('outer bookkeeping rejected'));
  };
  const result = await sendChild(h.orch, 'child', item());
  assert.equal(result.started, false);
  assert.match(result.error, /message could not be kept: retry owner unavailable/);
});

test('a stale input token after a failed idle send does not masquerade as pending native acceptance', async () => {
  for (const state of [{ turn: 'idle' }, { turn: 'running', activeTurn: null }]) {
    const h = recipient({
      send: async () => {
        throw new Error('failed native send');
      },
    });
    h.rts.set('child', { inputToken: 'pending-input-1' });
    h.states.set('child', state);
    const result = await sendChild(h.orch, 'child', item());
    assert.deepEqual(result, { queued: true, error: 'failed native send' });
    assert.equal(h.controller.state.get('child').queue.length, 1);
  }
});
