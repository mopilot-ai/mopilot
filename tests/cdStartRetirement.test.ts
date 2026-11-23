// Queued, approved and prepared starts retain their invocation owner and safely release only their own unused allocations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { orchestration, SESSION_BACKGROUND as background } from './support/orchestration-harness.ts';
const require = createRequire(import.meta.url);
const { discardPrepared, requireCurrentChild } = require('../electron/session/orchestration/preparedChild.cjs');
const task = (title = 'Task') => ({ title, prompt: 'Complete the assigned task', background });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { resolve, reject, promise };
};
const cancelled = (e: any) => e.code === 'start_cancelled';

test('queued tool calls cannot borrow a newer user turn, native segment or restored record', async () => {
  for (const kind of ['start', 'handoff', 'new-offer', 'proposal']) {
    const h = orchestration({ prefs: () => ({ newTaskPrompt: 'new' }) });
    h.userTurn();
    const gate = deferred<void>();
    h.orch.serial.set('top', gate.promise);
    const p =
      kind === 'start'
        ? h.orch.start('top', task())
        : kind === 'handoff'
          ? h.orch.handOff('top', { title: 'Move', remaining_plan: 'Do it' })
          : kind === 'new-offer'
            ? h.orch.start('top', { title: 'Task', initiation: 'offer' })
            : h.orch.start('top', task());
    h.rts.set('top', { inputToken: 'pending-replacement' });
    h.userTurn();
    gate.resolve();
    await assert.rejects(p, cancelled);
    assert.equal(
      h.log.some((l: any) => l[0] === 'newWorktree'),
      false,
      kind,
    );
    assert.equal((await h.orch.start('top', task('Retry'))).status, 'started');
  }
});

test('retirement during excerpt success or rejection sends no task and archives its unused child', async () => {
  for (const result of ['success', 'error']) {
    const read = deferred<string>();
    const h = orchestration({ readExcerpt: () => read.promise });
    h.userTurn();
    h.refs.set('top', { kind: 'acp:kimi', id: 'native', key: 'acp:kimi:native' });
    const pending = h.orch.start('top', { ...task(), context: 'fork' });
    await new Promise<void>((r) => setImmediate(r));
    h.orch.stopped('top');
    if (result === 'success') read.resolve('Earlier conversation');
    else read.reject(new Error('history failed'));
    await assert.rejects(pending, cancelled);
    assert.equal(h.log.filter((l: any) => l[0] === 'send').length, 0);
    assert.equal(h.log.filter((l: any) => l[0] === 'archive').length, 1);
    assert.deepEqual(h.journal.data.children, {});
  }
});

test('pre-native worktrees clean up on settings or notes failure without replacing the error', async () => {
  for (const failure of ['settings', 'notes', 'cleanup']) {
    const h = orchestration();
    h.userTurn();
    const removed: string[] = [];
    h.starter.discardWorktree = async (path: string) => {
      removed.push(path);
      if (failure === 'cleanup') throw new Error('dirty folder');
    };
    if (failure === 'notes')
      h.orch.o.prepareNotes = async () => {
        throw new Error('creation failed');
      };
    else
      h.orch.o.childOptions = async () => {
        throw new Error('creation failed');
      };
    await assert.rejects(h.orch.start('top', task()), /creation failed/);
    assert.deepEqual(removed, ['/repo-wt']);
    assert.deepEqual(h.journal.data.children, {});
  }
});

test('retired approved allocations are preserved once a person claimed them or they were already reserved', async () => {
  for (const state of [{ turn: 'running' }, { turn: 'idle', queue: [{}] }, { turn: 'idle', approvals: [{}] }]) {
    const h = orchestration();
    const kept: string[] = [];
    h.starter.retainWorktree = (id: string) => kept.push(id);
    h.states.set('child', state);
    await discardPrepared(h.orch, { chatId: 'child', cwd: '/owned', worktreeOf: '/repo' });
    assert.deepEqual(kept, ['/owned']);
    assert.equal(h.log.length, 0);
  }
  const h = orchestration();
  await discardPrepared(h.orch, { chatId: 'child' }, true);
  assert.equal(h.log.length, 0);
  h.orch.o.archive = () => false;
  await discardPrepared(h.orch, { chatId: 'child', cwd: '/owned', worktreeOf: '/repo' });
  h.orch.o.archive = () => {
    throw new Error('disk full');
  };
  await discardPrepared(h.orch, { chatId: 'child' });
  await requireCurrentChild(h.orch, { chatId: 'child' }, {});
  await requireCurrentChild(h.orch, { chatId: 'child' }, { claim: { current: () => true } });
  await assert.rejects(
    requireCurrentChild(h.orch, { chatId: 'child' }, { claim: { current: () => false }, reservedChatId: 'child' }),
    cancelled,
  );
});

test('start ownership survives harmless metadata writes but retires native, deletion and archive ABA generations', async () => {
  for (const reserved of [false, true])
    for (const mutation of ['metadata', 'native', 'segments', 'epoch', 'deleted', 'archiving', 'stopping', 'aborted']) {
      const h = orchestration();
      h.userTurn();
      const segments = [{ harness: 'codex', nativeId: 'top' }];
      h.records.set('top', { id: 'top', segments, meta: {} });
      let epoch = 0;
      h.orch.o.chats.archiveEpoch = () => epoch;
      const { authorizeStart } = require('../electron/session/orchestration/startPolicy.cjs');
      const abort = new AbortController();
      const claim = await authorizeStart(h.orch, 'top', { reserved, signal: abort.signal });
      if (mutation === 'metadata') h.records.set('top', { ...h.records.get('top'), meta: { title: 'Current title' } });
      if (mutation === 'native') h.refs.set('top', { kind: 'codex', id: 'replacement', key: 'replacement' });
      if (mutation === 'segments') h.records.set('top', { ...h.records.get('top'), segments: [...segments] });
      if (mutation === 'epoch') epoch++;
      if (mutation === 'deleted') h.deleted.add('top');
      if (mutation === 'archiving') h.orch.archiving.add('top');
      if (mutation === 'stopping') h.orch.stopping.add('top');
      if (mutation === 'aborted') abort.abort();
      assert.equal(!!claim.current(), mutation === 'metadata', `${reserved}/${mutation}`);
    }
});

test('a queued accepted proposal retains its invocation token before serialization', async () => {
  const h = orchestration();
  h.userTurn();
  const proposed = await h.orch.start('top', { ...task(), initiation: 'own_initiative' });
  const gate = deferred<void>();
  h.orch.serial.set('top', gate.promise);
  const pending = h.orch.start('top', { proposal_id: proposed.task_id });
  h.rts.set('top', { inputToken: 'pending-later-user' });
  h.userTurn();
  gate.resolve();
  await assert.rejects(pending, cancelled);
  assert.equal(
    h.log.some((l: any) => l[0] === 'newWorktree'),
    false,
  );
});

test('prefixed and peer input cannot reset the real human start budget or supersede its offer', async () => {
  for (const item of [
    { id: 'peer', opts: { human: true }, peer: { from: 'other' } },
    { id: 'prefix', opts: { human: true, prefix: 'From another task' } },
  ]) {
    const h = orchestration();
    h.userTurn();
    h.journal.change((d: any) => (d.parents.top = { wakes: 1, held: false, cutShort: false, notes: [], starts: 10, continuable: true }));
    h.orch.dispatching({ chatId: 'top', kind: 'steer', item });
    assert.equal(h.journal.parent('top').starts, 10);
    assert.equal(h.journal.parent('top').continuable, false);
  }
});

test('a card clicked before serialization cannot acquire a restored parent generation', async () => {
  const h = orchestration();
  h.userTurn();
  let epoch = 0;
  h.orch.o.chats.archiveEpoch = () => epoch;
  const p = await h.orch.start('top', { ...task(), initiation: 'own_initiative' });
  const gate = deferred<void>();
  h.orch.serial.set('top', gate.promise);
  const clicked = h.orch.act(p.task_id, 'start');
  epoch++;
  gate.resolve();
  await assert.rejects(clicked, cancelled);
  assert.equal(
    h.log.some((l: any) => l[0] === 'startCodex'),
    false,
  );
  assert.equal((await h.orch.act(p.task_id, 'start')).status, 'started');
});
