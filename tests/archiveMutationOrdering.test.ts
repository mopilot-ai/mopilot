// Same-chat archive effects stay in user-intent order; independent chats remain concurrent.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, impl, resetDeletionLifetime, resetAll, callsOf, flush } from './support/store-harness.ts';
import { deferred } from './support/async-scenarios.ts';
import { noteOwner } from '../src/harness/ownership.ts';
const { store: S, resetState } = await loadStore();

const thread = (id = 'target') => ({ id, updatedAt: 1, preview: 'Saved input' });
const seed = (...ids: string[]) =>
  S.useStore.setState({
    archived: ids.map(thread) as any,
    claudeArchived: Object.fromEntries(ids.map((id) => [id, 1])),
  });
beforeEach(() => {
  resetDeletionLifetime();
  resetState();
  resetAll();
  noteOwner('claude:target', 'claude');
});

test('a pending restore finishes before a newer delete, preventing resurrection', async () => {
  seed('target');
  const reply = deferred();
  impl['api.threadUnarchive'] = () => reply.promise;
  const restore = S.unarchiveThread('target');
  const deletion = S.deleteThread('target');
  await flush();
  const deletionStartedEarly = callsOf('chats.delete').length;
  reply.resolve({ thread: thread() });
  await Promise.all([restore, deletion]);
  assert.equal(deletionStartedEarly, 0);
  assert.equal(S.useStore.getState().threads.target, undefined);
  assert.deepEqual(S.useStore.getState().threadOrder, []);
  assert.deepEqual(S.useStore.getState().archived, []);
});

test('restore worktree acknowledgment remains within the mutation owner', async () => {
  seed('target');
  S.useStore.setState({ archived: [{ ...thread(), cwd: '/mock-only' }] as any });
  const worktree = deferred();
  impl['api.threadUnarchive'] = async () => ({ thread: thread() });
  impl['git.worktreeRestore'] = () => worktree.promise;
  const restore = S.unarchiveThread('target');
  await flush();
  const deletion = S.deleteThread('target');
  await flush();
  const deletionStartedEarly = callsOf('chats.delete').length;
  worktree.resolve({ ok: true, restored: false });
  await Promise.all([restore, deletion]);
  assert.equal(deletionStartedEarly, 0);
  assert.equal(S.useStore.getState().threads.target, undefined);
});

test('failed delete releases a later restore, and restore clicks coalesce only until the next intent', async () => {
  seed('target');
  const deletionReply = deferred();
  impl['chats.delete'] = (id: string) =>
    deletionReply.promise.then(() => ({ chatId: id, nativeKeys: [id], nativeDeleted: true, metadata: 'retained' }));
  impl['api.threadUnarchive'] = async () => ({ thread: thread() });
  const deletion = S.deleteThread('target');
  const rejected = assert.rejects(deletion, /refused/);
  const restore = S.unarchiveThread('target');
  assert.equal(S.unarchiveThread('target'), restore);
  await flush();
  const restoresStartedEarly = callsOf('api.threadUnarchive').length;
  deletionReply.reject(new Error('refused'));
  await Promise.all([rejected, restore]);
  assert.equal(restoresStartedEarly, 0);
  assert.equal(S.useStore.getState().threads.target?.preview, 'Saved input');
});

test('restore-delete-restore preserves coalescing but the terminal receipt fences the third intent', async () => {
  seed('target');
  const first = deferred(),
    second = deferred(),
    deletionReply = deferred();
  let restores = 0;
  impl['api.threadUnarchive'] = () => (++restores === 1 ? first.promise : second.promise);
  impl['chats.delete'] = (id: string) =>
    deletionReply.promise.then(() => ({ chatId: id, nativeKeys: [id], nativeDeleted: true, metadata: 'retained' }));
  const older = S.unarchiveThread('target');
  const deletion = S.deleteThread('target');
  const newer = S.unarchiveThread('target');
  const terminalRejection = assert.rejects(newer, /deleted/);
  const distinct = older !== newer;
  first.resolve({ thread: thread() });
  await older;
  await flush();
  const coalesced = S.unarchiveThread('target') === newer;
  deletionReply.resolve(undefined);
  await deletion;
  second.resolve({ thread: thread() });
  await terminalRejection;
  assert.equal(distinct, true);
  assert.equal(coalesced, true);
  assert.equal(restores, 1);
  assert.equal(S.useStore.getState().threads.target, undefined);
});

test('archive completion cannot recreate an archived row after a newer delete', async () => {
  const t = thread();
  S.useStore.setState({ threads: { target: t }, threadOrder: ['target'] } as any);
  const archiveReply = deferred();
  impl['api.threadArchive'] = () => archiveReply.promise;
  const archive = S.archiveThread('target');
  const deletion = S.deleteThread('target');
  await flush();
  const deletionStartedEarly = callsOf('chats.delete').length;
  archiveReply.resolve(undefined);
  await Promise.all([archive, deletion]);
  assert.equal(deletionStartedEarly, 0);
  assert.deepEqual(S.useStore.getState().archived, []);
  assert.deepEqual(S.useStore.getState().claudeArchived, {});
});

test('unrelated chats are concurrent and an older completion cannot clear a newer same-chat queue', async () => {
  seed('a', 'b');
  const a = deferred(),
    deletionReply = deferred();
  impl['api.threadUnarchive'] = (id: string) => (id === 'a' ? a.promise : Promise.resolve({ thread: thread(id) }));
  impl['chats.delete'] = (id: string) =>
    deletionReply.promise.then(() => ({ chatId: id, nativeKeys: [id], nativeDeleted: true, metadata: 'retained' }));
  const restoreA = S.unarchiveThread('a');
  const deletion = S.deleteThread('a');
  await S.unarchiveThread('b');
  assert.equal(S.useStore.getState().threads.b?.id, 'b');
  a.resolve({ thread: thread('a') });
  await restoreA;
  const later = assert.rejects(S.archiveThread('a'), /deleted/);
  await flush();
  const archiveStartedEarly = callsOf('api.threadArchive').length;
  deletionReply.resolve(undefined);
  await Promise.all([deletion, later]);
  assert.equal(archiveStartedEarly, 0);
});

for (const [id, reload] of [
  ['target', 'api.threadList'],
  ['claude:target', 'claude.loadClaudeThreads'],
  ['acp:target', 'acp.loadAcpThreads'],
]) {
  test(`${id}: restore reload must finish before a newer delete`, async () => {
    seed(id);
    const response = deferred();
    impl['api.threadUnarchive'] = async () => ({});
    impl[reload] = () => response.promise;
    const restore = S.unarchiveThread(id);
    await flush();
    const deletion = S.deleteThread(id);
    await flush();
    const boundary = 'chats.delete';
    const deletionStartedEarly = callsOf(boundary).length;
    response.resolve({ data: [thread(id)], nextCursor: null });
    await Promise.all([restore, deletion]);
    assert.equal(deletionStartedEarly, 0);
    assert.equal(S.useStore.getState().threads[id], undefined);
  });
}

test('restore A cannot republish B deleted during its full-list fallback; independent rows survive', async () => {
  seed('a', 'b');
  const page = deferred();
  impl['api.threadUnarchive'] = async () => ({});
  impl['api.threadList'] = () => page.promise;
  const restore = S.unarchiveThread('a');
  await flush();
  await S.deleteThread('b');
  page.resolve({ data: [thread('a'), thread('b'), thread('independent')], nextCursor: null });
  await restore;
  assert.equal(S.useStore.getState().threads.b, undefined);
  assert.deepEqual(S.useStore.getState().threadOrder, ['a', 'independent']);
  impl['api.threadList'] = async () => ({ data: [thread('b')], nextCursor: null });
  await S.loadThreads();
  assert.equal(S.useStore.getState().threads.b, undefined, 'fresh reads cannot undo the terminal receipt in this process');
});

test('a rejected delete does not invalidate an in-flight list', async () => {
  const page = deferred();
  impl['api.threadList'] = () => page.promise;
  const read = S.loadThreads();
  impl['chats.delete'] = async () => {
    throw new Error('refused');
  };
  await assert.rejects(S.deleteThread('b'), /refused/);
  page.resolve({ data: [thread('b')], nextCursor: null });
  await read;
  assert.equal(S.useStore.getState().threads.b?.id, 'b');
});

test('duplicate successful deletions exclude only that id from pending lists', async () => {
  const page = deferred();
  impl['api.threadList'] = () => page.promise;
  const read = S.loadThreads();
  await S.deleteThread('opaque:with/quotes"');
  await S.deleteThread('opaque:with/quotes"');
  page.resolve({ data: [thread('opaque:with/quotes"'), thread('other')], nextCursor: null });
  await read;
  assert.deepEqual(S.useStore.getState().threadOrder, ['other']);
});

test('rejected restore releases a queued delete whose receipt fences later restore', async () => {
  seed('target');
  const reply = deferred();
  impl['api.threadUnarchive'] = () => reply.promise;
  impl['api.threadList'] = async () => ({ data: [thread()], nextCursor: null });
  const restore = S.unarchiveThread('target');
  const rejected = assert.rejects(restore, /restore refused/);
  const deletion = S.deleteThread('target');
  reply.reject(new Error('restore refused'));
  await Promise.all([rejected, deletion]);
  impl['api.threadUnarchive'] = async () => ({ thread: thread() });
  await assert.rejects(S.unarchiveThread('target'), /deleted/);
  assert.equal(callsOf('api.threadUnarchive').length, 1);
  impl['api.threadUnarchive'] = async (id: string) => ({ thread: thread(id) });
  await S.unarchiveThread('independent');
  assert.equal(S.useStore.getState().threads.independent?.id, 'independent');
  assert.equal(S.useStore.getState().threads.target, undefined);
});

test('failed list releases its owner while successful deletion still fences later reads', async () => {
  const error = console.error;
  console.error = () => {};
  try {
    impl['api.threadList'] = async () => {
      throw new Error('unavailable');
    };
    await S.loadThreads();
    await S.loadThreads(true);
    await S.deleteThread('target');
    impl['api.threadList'] = async () => ({ data: [thread(), thread('independent')], nextCursor: null });
    await S.loadThreads();
    assert.equal(S.useStore.getState().threads.target, undefined);
    assert.deepEqual(S.useStore.getState().threadOrder, ['independent']);
    assert.equal(S.useStore.getState().threads.independent?.id, 'independent');
  } finally {
    console.error = error;
  }
});
