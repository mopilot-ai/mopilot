// Independent renderer deletion review; only in-memory native boundary calls.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, impl, bootImpls, listeners, callsOf, flush, resetAll } from './support/store-harness.ts';
mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const { store: S } = await loadStore();
const { acceptChatDeletion } = await import('../src/store/deletionReceipts.ts');
const { onNotification } = await import('../src/store/notifications.ts');
const { mergeChatSearch } = await import('../src/lib/chatSearch.ts');
const receipt = (id: string, aliases: string[] = []) => ({
  chatId: id,
  nativeKeys: [id, ...aliases],
  nativeDeleted: true,
  metadata: 'retained',
});
const row = (id: string) => ({ id, name: 'match', updatedAt: 1, turns: [] });
const st = S.useStore.getState;
const set = S.useStore.setState;

test('subscribe precedes snapshot; later empty snapshot cannot erase receipt, reset/notifications/remount cannot revive aliases', async () => {
  let resolve!: (r: any[]) => void;
  bootImpls({
    'chats.deletions': () =>
      new Promise((r) => {
        resolve = r;
      }),
  });
  const boot = S.boot({ quickChat: true });
  assert.equal(typeof listeners['chats.onDeleted'], 'function');
  listeners['chats.onDeleted'](receipt('boot-main', ['boot-alias']));
  resolve([]);
  await boot;
  await flush();
  for (const id of ['boot-main', 'boot-alias']) {
    listeners['chats.onChanged']({ id, chat: { kind: 'codex', meta: { pinned: true } } });
    listeners['chats.onReset']({ chats: { [id]: { kind: 'codex', meta: { pinned: true } } }, newer: [] });
    onNotification('thread/started', { thread: row(id) });
    set({ threads: { [id]: row(id) }, threadOrder: [id], archived: [row(id)] } as any);
    assert.equal(st().threads[id], undefined);
    assert.equal(st().pinned[id], undefined);
    assert.equal(st().archived.length, 0);
  }
  acceptChatDeletion(receipt('boot-main', ['boot-alias']));
  set({ threads: { 'boot-alias': row('boot-alias'), other: row('other') }, threadOrder: ['boot-alias', 'other'] } as any);
  assert.deepEqual(st().threadOrder, ['other']);
  bootImpls({ 'chats.deletions': async () => [] });
  await S.boot({ quickChat: true });
  onNotification('thread/started', { thread: row('boot-main') });
  assert.equal(st().threads['boot-main'], undefined);
  assert.equal(
    callsOf('chats.patchMeta').some(([id]) => id === 'boot-main' || id === 'boot-alias'),
    false,
  );
});

test('pending restore and fresh/pending Codex list cannot republish terminal rows', async () => {
  let resolve!: (r: any) => void;
  set({ archived: [row('restore-main')] } as any);
  impl['api.threadUnarchive'] = () =>
    new Promise((r) => {
      resolve = r;
    });
  const restore = S.unarchiveThread('restore-main');
  acceptChatDeletion(receipt('restore-main'));
  resolve({ thread: row('restore-main') });
  await restore;
  assert.equal(st().threads['restore-main'], undefined);
  impl['api.threadList'] = () =>
    new Promise((r) => {
      resolve = r;
    });
  const list = S.loadThreads();
  acceptChatDeletion(receipt('list-main'));
  resolve({ data: [row('list-main'), row('list-other')], nextCursor: null });
  await list;
  assert.equal(st().threads['list-main'], undefined);
  assert.ok(st().threads['list-other']);
  impl['api.threadList'] = async () => ({ data: [row('list-main'), row('list-other')], nextCursor: null });
  await S.loadThreads();
  assert.equal(st().threads['list-main'], undefined);
  assert.ok(st().threads['list-other']);
});

test('search rows do not revive terminal chat in remote component result pool', async () => {
  acceptChatDeletion(receipt('search-main'));
  impl['api.threadList'] = async () => ({ data: [row('search-main'), row('search-other')] });
  impl['api.threadSearch'] = async () => ({ data: [] });
  impl['claude.searchClaudeThreads'] = async () => [];
  impl['acp.searchAcpThreads'] = async () => [];
  const remote = await S.searchThreads('match');
  const visible = mergeChatSearch({
    local: [],
    ...remote,
    archived: st().claudeArchived,
    titleOf: S.threadTitle,
    term: 'match',
    limit: 20,
  });
  assert.deepEqual(
    visible.map((t) => t.id),
    ['search-other'],
  );
});

test('stale reset aliases stay visible until certified by main; older receipts cannot undo expansion', async () => {
  set({ threads: { 'late-alias': row('late-alias') }, threadOrder: ['late-alias'] } as any);
  acceptChatDeletion(receipt('late-owner'));
  listeners['chats.onReset']({
    chats: { 'late-owner': { kind: 'codex', meta: {}, segments: [{ nativeId: 'late-alias', harness: 'codex' }] } },
    newer: [],
  });
  assert.ok(st().threads['late-alias']);
  assert.ok(st().threadOrder.includes('late-alias'));
  const expanded = { ...receipt('late-owner'), retainedAliasKeys: ['late-alias'] };
  listeners['chats.onDeleted'](expanded);
  listeners['chats.onDeleted'](receipt('late-owner'));
  listeners['chats.onDeleted'](expanded);
  assert.equal(st().threads['late-alias'], undefined);
  assert.equal(st().threadOrder.includes('late-alias'), false);
});

for (const [id, reload] of [
  ['pending-worktree-codex', 'api.threadList'],
  ['claude:pending-worktree', 'claude.loadClaudeThreads'],
  ['acp:pending-worktree', 'acp.loadAcpThreads'],
]) {
  test(`${id}: deletion during mocked worktree restore prevents later publication and reload`, async () => {
    resetAll();
    const { noteOwner } = await import('../src/harness/ownership.ts');
    if (id.startsWith('claude:')) noteOwner(id, 'claude');
    set({ archived: [{ ...row(id), cwd: '/mock-only/restore' }], claudeArchived: { [id]: 1 } } as any);
    impl['api.threadUnarchive'] = async () => ({ thread: row(id) });
    let finish!: (value: any) => void;
    impl['git.worktreeRestore'] = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const restore = S.unarchiveThread(id);
    await flush();
    assert.equal(callsOf('git.worktreeRestore').length, 1);
    acceptChatDeletion(receipt(id));
    finish({ ok: true, restored: false });
    await restore;
    assert.equal(st().threads[id], undefined);
    assert.equal(
      st().archived.some((r) => r.id === id),
      false,
    );
    assert.equal(callsOf(reload).length, 0);
    assert.equal(callsOf('env.runScript').length, 0);
    await assert.rejects(S.unarchiveThread(id), /deleted/);
    assert.equal(callsOf('git.worktreeRestore').length, 1);
  });
}

test('receipt during failed-native archive lookup stops restore before worktree effects', async () => {
  resetAll();
  const id = 'pending-archive-lookup';
  set({ archived: [{ ...row(id), cwd: '/mock-only/archive-lookup' }], claudeArchived: { [id]: 1 } } as any);
  impl['api.threadUnarchive'] = async () => {
    throw new Error('native refused');
  };
  let finish!: (value: any) => void;
  impl['api.threadList'] = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const restore = S.unarchiveThread(id);
  await flush();
  assert.equal(callsOf('api.threadList').length, 1);
  assert.equal(callsOf('api.threadList')[0][0].archived, true);
  acceptChatDeletion(receipt(id));
  finish({ data: [], nextCursor: null });
  await restore;
  assert.equal(callsOf('git.worktreeRestore').length, 0);
  assert.equal(st().threads[id], undefined);
  assert.equal(
    st().archived.some((r) => r.id === id),
    false,
  );
  await assert.rejects(S.unarchiveThread(id), /deleted/);
  assert.equal(callsOf('api.threadUnarchive').length, 1);
});

test('nonempty startup receipt snapshot filters retained metadata and later native rows', async () => {
  resetAll();
  const id = 'snapshot-deleted',
    alias = 'snapshot-deleted-alias',
    other = 'snapshot-independent';
  bootImpls({
    'chats.deletions': async () => [receipt(id, [alias])],
    'chats.snapshot': async () => ({
      chats: {
        [id]: { kind: 'codex', meta: { pinned: true } },
        [alias]: { kind: 'codex', meta: { pinned: true } },
        [other]: { kind: 'codex', meta: { pinned: true } },
      },
      newer: [],
    }),
  });
  await S.boot({ quickChat: true });
  await flush();
  assert.equal(st().pinned[id], undefined);
  assert.equal(st().pinned[alias], undefined);
  assert.equal(st().pinned[other], true);
  set({ threads: { [id]: row(id), [alias]: row(alias), [other]: row(other) }, threadOrder: [id, alias, other] } as any);
  assert.deepEqual(st().threadOrder, [other]);
});

test('explicit canonical and alias restore/archive refuse after ordinary fixture cleanup retains receipt', async () => {
  resetAll();
  const id = 'explicit-deleted',
    alias = 'explicit-deleted-alias';
  acceptChatDeletion(receipt(id, [alias]));
  resetAll();
  for (const terminal of [id, alias]) {
    await assert.rejects(S.unarchiveThread(terminal), /deleted/);
    await assert.rejects(S.archiveThread(terminal), /deleted/);
  }
  assert.equal(callsOf('api.threadUnarchive').length, 0);
  assert.equal(callsOf('api.threadArchive').length, 0);
  assert.equal(callsOf('git.worktreeRestore').length, 0);
  assert.equal(callsOf('computer.forget').length, 0);
  impl['api.threadUnarchive'] = async (other: string) => ({ thread: row(other) });
  await S.unarchiveThread('explicit-independent');
  assert.equal(st().threads['explicit-independent']?.id, 'explicit-independent');
  assert.deepEqual(callsOf('api.threadUnarchive'), [['explicit-independent']]);
});

const { deletionVisibility } = await import('../src/store/deletionVisibility.ts');
test('stale startup segments cannot terminalize an alias omitted from authoritative receipt', async () => {
  let finish!: (v: any) => void;
  bootImpls({
    'chats.deletions': async () => [],
    'chats.snapshot': async () => ({
      chats: {
        'old-owner': {
          kind: 'codex',
          meta: {},
          segments: [
            { nativeId: 'old-owner', harness: 'codex' },
            { nativeId: 'moved-live-alias', harness: 'codex' },
          ],
        },
      },
      newer: [],
    }),
    'app.info': () =>
      new Promise((r) => {
        finish = r;
      }),
  });
  const boot = S.boot({ quickChat: true });
  await flush();
  // Main has meanwhile moved the alias to another live owner, then deleted only old-owner.
  // The main receipt is the authority; boot still holds an older metadata snapshot across app.info.
  listeners['chats.onDeleted']({ chatId: 'old-owner', nativeKeys: ['old-owner'], nativeDeleted: true, metadata: 'retained' });
  finish({ home: '/mock-only', dark: false, codexHome: '/mock-only' });
  await boot;
  await flush();
  assert.equal(deletionVisibility.has('old-owner'), true);
  assert.equal(deletionVisibility.has('moved-live-alias'), false);
  onNotification('thread/started', { thread: { id: 'moved-live-alias', name: 'Live unrelated chat', turns: [] } });
  assert.equal(S.useStore.getState().threads['moved-live-alias']?.name, 'Live unrelated chat');
});

test('a remote pending deletion removes the chat locally and tells the person it will finish after reconnect', async () => {
  resetAll();
  const id = 'pending-remote-delete';
  set({ threads: { [id]: row(id) }, threadOrder: [id] } as any);
  impl['chats.delete'] = async () => ({ ...receipt(id), remoteDeletionPending: true });
  await S.deleteThread(id);
  assert.equal(st().threads[id], undefined);
  assert.ok(st().toasts.some((t: any) => /Deleted here\. The machine deletes it when it is back\./.test(t.text)));
});
