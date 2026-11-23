// Independent review reproducer: older archive reads must not replace newer reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, impl, resetDeletionLifetime, resetAll } from './support/store-harness.ts';
import { deferred } from './support/async-scenarios.ts';
const { store: S, resetState } = await loadStore();
test('an older archive load cannot overwrite a newer successful load', async () => {
  resetDeletionLifetime();
  resetState();
  resetAll();
  S.useStore.setState({ conn: 'connected' } as any);
  impl['claude.loadArchivedClaudeInfo'] = async () => {};
  impl['claude.archivedClaudeThreads'] = () => [];
  let arrived!: () => void, release!: (x: any) => void;
  const reached = new Promise<void>((r) => (arrived = r));
  const blocked = new Promise<any>((r) => (release = r));
  let n = 0;
  impl['api.threadList'] = () => {
    if (++n === 1) {
      arrived();
      return blocked;
    }
    return Promise.resolve({ data: [{ id: 'newer', updatedAt: 2 }], nextCursor: null });
  };
  const old = S.loadArchived();
  await reached;
  await S.loadArchived();
  release({ data: [{ id: 'older', updatedAt: 1 }], nextCursor: null });
  await old;
  assert.deepEqual(
    S.useStore.getState().archived.map((t) => t.id),
    ['newer'],
  );
});

const init = () => {
  resetDeletionLifetime();
  resetState();
  resetAll();
  S.useStore.setState({ conn: 'ready' });
  impl['claude.loadArchivedClaudeInfo'] = async () => {};
  impl['claude.archivedClaudeThreads'] = () => [];
  impl['acp.archivedAcpThreads'] = async () => [];
};

test('archive, restore and delete completions invalidate older read snapshots across harnesses', async () => {
  for (const action of ['archiveThread', 'unarchiveThread', 'deleteThread'] as const)
    for (const id of ['codex-chat', 'claude:chat', 'acp:chat']) {
      init();
      const thread = { id, updatedAt: 1 };
      S.useStore.setState({
        threads: { [id]: thread },
        threadOrder: [id],
        archived: action === 'archiveThread' ? [] : [thread],
        claudeArchived: action === 'archiveThread' ? {} : { [id]: 1 },
      } as any);
      const page = deferred();
      impl['api.threadList'] = () => page.promise;
      const read = S.loadArchived();
      await new Promise((r) => setImmediate(r));
      impl['api.threadUnarchive'] = async () => ({ thread });
      impl['claude.loadClaudeThreads'] = async () => {};
      impl['acp.loadAcpThreads'] = async () => {};
      await S[action](id);
      page.resolve({ data: action === 'archiveThread' ? [] : [thread], nextCursor: null });
      await read;
      assert.deepEqual(
        S.useStore.getState().archived.map((t) => t.id),
        action === 'archiveThread' ? [id] : [],
        `${action}/${id}`,
      );
    }
});

test('a read started during a pending mutation cannot publish before or after that mutation ends', async () => {
  for (const readFirst of [false, true]) {
    init();
    const thread = { id: 'target', updatedAt: 1 };
    S.useStore.setState({ archived: [thread], claudeArchived: { target: 1 } } as any);
    const change = deferred(),
      page = deferred();
    impl['chats.delete'] = () =>
      change.promise.then(() => ({ chatId: 'target', nativeKeys: ['target'], nativeDeleted: true, metadata: 'retained' }));
    impl['api.threadList'] = () => page.promise;
    const mutation = S.deleteThread('target');
    const read = S.loadArchived();
    await new Promise((r) => setImmediate(r));
    if (readFirst) {
      page.resolve({ data: [], nextCursor: null });
      await read;
      assert.deepEqual(S.useStore.getState().archived, [thread]);
    }
    change.resolve(undefined);
    await mutation;
    if (!readFirst) {
      page.resolve({ data: [thread], nextCursor: null });
      await read;
    }
    assert.deepEqual(S.useStore.getState().archived, []);
  }
});

test('failed mutation retains data, invalidates overlapping reads, and releases reads for retry', async () => {
  init();
  const thread = { id: 'target', updatedAt: 1 };
  S.useStore.setState({ archived: [thread], claudeArchived: { target: 1 } } as any);
  const change = deferred(),
    page = deferred();
  impl['chats.delete'] = () =>
    change.promise.then(() => ({ chatId: 'target', nativeKeys: ['target'], nativeDeleted: true, metadata: 'retained' }));
  impl['api.threadList'] = () => page.promise;
  const mutation = S.deleteThread('target');
  const read = S.loadArchived();
  await new Promise((r) => setImmediate(r));
  change.reject(new Error('refused'));
  await assert.rejects(mutation, /refused/);
  page.resolve({ data: [], nextCursor: null });
  await read;
  assert.deepEqual(S.useStore.getState().archived, [thread]);
  impl['api.threadList'] = async () => ({ data: [], nextCursor: null });
  await S.loadArchived();
  assert.deepEqual(S.useStore.getState().archived, []);
});

test('independent mutations both finish; one completion cannot release reads while another mutation remains', async () => {
  init();
  const a = { id: 'a', updatedAt: 1 },
    b = { id: 'b', updatedAt: 1 };
  S.useStore.setState({ archived: [a, b], claudeArchived: { a: 1, b: 1 } } as any);
  const first = deferred(),
    second = deferred();
  impl['chats.delete'] = (id: string) =>
    (id === 'a' ? first.promise : second.promise).then(() => ({ chatId: id, nativeKeys: [id], nativeDeleted: true, metadata: 'retained' }));
  const A = S.deleteThread('a'),
    B = S.deleteThread('b');
  first.resolve(undefined);
  await A;
  impl['api.threadList'] = async () => ({ data: [], nextCursor: null });
  await S.loadArchived();
  assert.deepEqual(S.useStore.getState().archived, [b]);
  second.resolve(undefined);
  await B;
  assert.deepEqual(S.useStore.getState().archived, []);
  await S.loadArchived();
  assert.deepEqual(S.useStore.getState().archived, []);
});

test('an older rejected page cannot replace a newer successful archive or return its stale failure', async () => {
  init();
  const page = deferred();
  let calls = 0;
  impl['api.threadList'] = () =>
    ++calls === 1 ? page.promise : Promise.resolve({ data: [{ id: 'newer', updatedAt: 2 }], nextCursor: null });
  const older = S.loadArchived();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(await S.loadArchived(), []);
  page.reject(new Error('obsolete page failure'));
  assert.deepEqual(await older, []);
  assert.deepEqual(
    S.useStore.getState().archived.map((t) => t.id),
    ['newer'],
  );
});

test('Archived chats leaves MoMo’s out (#2139)', async () => {
  init();
  S.useStore.setState({ momoChats: { m: 'previous' } } as any);
  impl['claude.loadArchivedClaudeInfo'] = async () => {};
  impl['claude.archivedClaudeThreads'] = () => [];
  impl['api.threadList'] = async () => ({
    data: [
      { id: 'm', updatedAt: 3 },
      { id: 'a', updatedAt: 1 },
    ],
    nextCursor: null,
  });
  await S.loadArchived();
  assert.deepEqual(
    S.useStore.getState().archived.map((t) => t.id),
    ['a'],
  );
});
