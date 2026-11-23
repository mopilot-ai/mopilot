// Archived chat reads must exhaust Codex pagination before deciding a chat is absent.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, callsOf, impl, resetAll, calls, bootImpls } from './support/store-harness.ts';

const { store: S, resetState } = await loadStore();
beforeEach(() => {
  resetState();
  resetAll();
  bootImpls();
  impl['git.worktreeRestore'] = async () => ({ ok: true, restored: false });
  impl['claude.loadArchivedClaudeInfo'] = async () => {};
  impl['claude.archivedClaudeThreads'] = () => [];
});

test('failed restore preserves a chat found on the second archived page', async () => {
  const original = { id: 'old-chat', cwd: '/worktree' };
  S.useStore.setState({ archived: [original] as any, claudeArchived: { 'old-chat': 7 } });
  impl['api.threadUnarchive'] = async () => {
    throw new Error('archive locked');
  };
  impl['api.threadList'] = async (p: any) =>
    p.archived
      ? p.cursor
        ? { data: [original], nextCursor: null }
        : { data: [{ id: 'recent-chat' }], nextCursor: 'page-2' }
      : { data: [], nextCursor: null };
  await assert.rejects(S.unarchiveThread('old-chat'), /archive locked/);
  assert.deepEqual(S.useStore.getState().claudeArchived, { 'old-chat': 7 });
  assert.deepEqual(S.useStore.getState().archived, [original]);
  assert.deepEqual(callsOf('git.worktreeRestore'), []);
});

test('archive list includes chats after its first page', async () => {
  S.useStore.setState({ conn: 'connected' } as any);
  impl['api.threadList'] = async (p: any) =>
    p.cursor
      ? { data: [{ id: 'old-chat', updatedAt: 1 }], nextCursor: null }
      : { data: [{ id: 'recent-chat', updatedAt: 2 }], nextCursor: 'page-2' };
  assert.deepEqual(await S.loadArchived(), []);
  assert.deepEqual(
    S.useStore.getState().archived.map((t) => t.id),
    ['recent-chat', 'old-chat'],
  );
});

test('complete absence permits local-only restore, with opaque cursor passed unchanged', async () => {
  S.useStore.setState({ claudeArchived: { target: 7 }, archived: [{ id: 'target' }] as any });
  impl['api.threadUnarchive'] = async () => {
    throw new Error('not in Codex');
  };
  impl['api.threadList'] = async (p: any) =>
    p.archived && !p.cursor ? { data: [{ id: 'other' }], nextCursor: 'opaque:"/\\?' } : { data: [], nextCursor: null };
  await S.unarchiveThread('target');
  assert.deepEqual(S.useStore.getState().claudeArchived, {});
  assert.deepEqual(callsOf('api.threadList')[1], [{ limit: 200, archived: true, sortKey: 'updated_at', cursor: 'opaque:"/\\?' }]);
});

test('malformed, incomplete, cyclic and rejected archive pages preserve restore failure and remain retryable', async () => {
  const badPages = [
    null,
    {},
    { data: {} },
    { data: [null] },
    { data: [{ id: 5 }] },
    { data: [{ id: '' }] },
    { data: [] },
    { data: [], nextCursor: 5 },
    { data: [], nextCursor: '' },
    { data: [], nextCursor: 'page-2' },
    new Error('transport'),
  ];
  for (const bad of badPages) {
    resetAll();
    const original = { id: 'target', cwd: '/worktree' };
    S.useStore.setState({ claudeArchived: { target: 7 }, archived: [original] as any });
    impl['api.threadUnarchive'] = async () => {
      throw new Error('original refusal');
    };
    impl['api.threadList'] = async (p: any) => {
      if (!p.cursor) return { data: [], nextCursor: 'page-2' };
      if (bad instanceof Error) throw bad;
      return bad;
    };
    await assert.rejects(S.unarchiveThread('target'), /original refusal/);
    assert.deepEqual(S.useStore.getState().claudeArchived, { target: 7 });
    assert.deepEqual(S.useStore.getState().archived, [original]);
    assert.deepEqual(callsOf('git.worktreeRestore'), []);
    assert.equal(callsOf('api.threadList').length, 2);
    impl['api.threadUnarchive'] = async () => ({ thread: original });
    impl['git.worktreeRestore'] = async () => ({ ok: true, restored: false });
    await S.unarchiveThread('target');
    assert.deepEqual(S.useStore.getState().claudeArchived, {});
  }
});

test('unbounded unique cursors fail closed and Settings reports incomplete enumeration', async () => {
  S.useStore.setState({ conn: 'ready', claudeArchived: { target: 7 }, archived: [{ id: 'target' }] as any });
  impl['api.threadUnarchive'] = async () => {
    throw new Error('original refusal');
  };
  let page = 0;
  impl['api.threadList'] = async () => ({ data: [], nextCursor: String(++page) });
  await assert.rejects(S.unarchiveThread('target'), /original refusal/);
  assert.equal(page, 200);
  assert.deepEqual(S.useStore.getState().claudeArchived, { target: 7 });
  page = 0;
  assert.deepEqual(await S.loadArchived(), [{ source: 'Codex', error: 'Codex archive pagination limit reached' }]);
  assert.equal(page, 200);
});

test('a later page failure is surfaced by Settings rather than reporting a partial list as complete', async () => {
  S.useStore.setState({ conn: 'ready' });
  impl['api.threadList'] = async (p: any) => {
    if (p.cursor) throw new Error('page unavailable');
    return { data: [{ id: 'partial' }], nextCursor: 'page-2' };
  };
  assert.deepEqual(await S.loadArchived(), [{ source: 'Codex', error: 'page unavailable' }]);
  assert.deepEqual(S.useStore.getState().archived, []);
});

test('the 200th terminal page and empty intermediate pages are valid', async () => {
  S.useStore.setState({ conn: 'ready' });
  let page = 0;
  impl['api.threadList'] = async () =>
    ++page === 200 ? { data: [{ id: 'last', updatedAt: 1 }], nextCursor: null, extra: true } : { data: [], nextCursor: String(page) };
  assert.deepEqual(await S.loadArchived(), []);
  assert.equal(page, 200);
  assert.deepEqual(
    S.useStore.getState().archived.map((t) => t.id),
    ['last'],
  );
});

test('a multi-cursor cycle ends with failure, and idle archives do not start Codex', async () => {
  S.useStore.setState({ conn: 'ready' });
  const cursors = ['A', 'B', 'A'];
  let page = 0;
  impl['api.threadList'] = async () => ({ data: [], nextCursor: cursors[page++] });
  assert.deepEqual(await S.loadArchived(), [{ source: 'Codex', error: 'Invalid Codex archive cursor' }]);
  assert.equal(page, 3);
  S.useStore.setState({ conn: 'idle' });
  impl['claude.archivedCodexMissing'] = () => false;
  assert.deepEqual(await S.loadArchived(), []);
  assert.equal(page, 3);
});

const st = () => S.useStore.getState();
const set = S.useStore.setState;

test('loadArchived merges Codex archive with Sage archived chats, newest first', async () => {
  impl['claude.loadArchivedClaudeInfo'] = () => Promise.reject(new Error('x'));
  impl['claude.archivedClaudeThreads'] = () => [
    { id: 'cl', updatedAt: 5 },
    { id: 'dup', updatedAt: 1 },
  ];
  impl['api.threadList'] = async () => ({
    data: [
      { id: 'cx', updatedAt: 9 },
      { id: 'dup', updatedAt: 2 },
    ],
    nextCursor: null,
  });
  await S.loadArchived();
  assert.deepEqual(
    st().archived.map((t) => t.id),
    ['cx', 'cl', 'dup'],
  );
  impl['api.threadList'] = () => Promise.reject(new Error('x'));
  // what could be read still shows, and the list that couldn't is named rather than passed off as empty
  assert.deepEqual(await S.loadArchived(), [{ source: 'Codex', error: 'x' }]);
  assert.deepEqual(
    st().archived.map((t) => t.id),
    ['cl', 'dup'],
  );
});

test('loadArchived lists archived basic-tier chats from main and names a harness whose list failed; idle Codex is not woken', async () => {
  set({ conn: 'idle', claudeArchived: { 'acp:kimi:k': 1, 'acp:qwen:q': 2, cl: 3 } });
  impl['claude.loadArchivedClaudeInfo'] = async () => {};
  impl['claude.archivedClaudeThreads'] = () => [{ id: 'cl', updatedAt: 5 }];
  impl['acp.archivedAcpThreads'] = async () => [{ id: 'acp:kimi:k', updatedAt: 7 }];
  assert.deepEqual(await S.loadArchived(), []);
  assert.equal(callsOf('api.threadList').length, 0, 'Codex left for first use is not started for the archive');
  assert.deepEqual(
    st().archived.map((t) => t.id),
    ['acp:kimi:k', 'cl'],
  );
  impl['acp.archivedAcpThreads'] = () => Promise.reject(new Error('main gone'));
  assert.deepEqual(await S.loadArchived(), [{ source: 'Kimi Code, Qwen Code', error: 'main gone' }]);
  assert.deepEqual(
    st().archived.map((t) => t.id),
    ['cl'],
  );
  // a Codex chat archived in an earlier run can't be shown without Codex: listing the archive starts it
  set({ claudeArchived: { cl: 3, cx: 4 } });
  impl['claude.archivedCodexMissing'] = () => true;
  impl['api.threadList'] = async (p: any) => (p?.archived ? { data: [{ id: 'cx', updatedAt: 9 }], nextCursor: null } : { data: [] });
  calls.length = 0;
  assert.deepEqual(await S.loadArchived(), []);
  assert.equal(callsOf('codex.start').length, 1);
  assert.equal(st().conn, 'ready');
  assert.deepEqual(
    st().archived.map((t) => t.id),
    ['cx', 'cl'],
  );
  set({ conn: 'idle' });
  impl['claude.archivedCodexMissing'] = () => false;
  // no basic-tier chat archived: main's list isn't read
  set({ claudeArchived: { cl: 3 } });
  calls.length = 0;
  assert.deepEqual(await S.loadArchived(), []);
  assert.equal(callsOf('acp.archivedAcpThreads').length, 0);
});
