// The real PR reader and badge with a chat bound by its PR monitor: no read waits for the window to be ready, and once
// it is, the binding is the chat's PR on any harness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';
import { mock } from 'node:test';

const BOUND = 'https://github.com/org/repo/pull/3041';
const snapshots: string[] = [];
installNativeStub({
  peer: { referenceHistory: async ([id]: string[]) => ({ [id]: { turns: [] } }) },
  fs: { configRoots: async () => ({ codexHome: '/codex' }), readText: async () => '{}' },
  pullRequests: { savedReplies: async () => null, saveReplies: async () => {} },
  // a worktree whose branch has no PR: only the binding names it
  git: {
    run: async () => ({ ok: true, stdout: 'mopilot/0c9b\n' }),
    gh: async (_cwd: string, args: string[]) =>
      args.includes('--')
        ? { ok: true, stdout: JSON.stringify({ url: args.at(-1), state: 'MERGED', isDraft: false, title: 'Ratings' }) }
        : { ok: false, stdout: '' },
  },
  prMonitor: {
    snapshot: async (id: string) => (snapshots.push(id), id === 'claude-bound' ? { chatId: id, url: BOUND } : null),
  },
});
mock.module('../src/session/open.ts', { namedExports: { openLink: () => {} } });
mock.module('../src/harness/adapters/codexApi.ts', {
  namedExports: { codexApi: { threadAttachments: async () => ({ data: [], nextCursor: null }) } },
});
stubStore({
  nativeOf: (id: string) => id,
  useStore: Object.assign((fn: any) => fn({ conn: 'ready', runtime: {} }), { getState: () => ({ home: '/home', runtime: {} }) }),
});
const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { noteOwner } = await import('../src/harness/ownership.ts');
const { markWindowReady, resetWindowReady, windowIsReady } = await import('../src/lib/windowReady.ts');
const { ThreadPullRequestBadge } = await import('../src/components/sidebar/ThreadPullRequestBadge.tsx');
noteOwner('claude-bound', 'claude');
noteOwner('claude-other', 'claude');

test("a bound Claude chat's badge shows its monitored PR once the window is ready, and nothing waits before", async () => {
  resetWindowReady();
  assert.equal(windowIsReady(), false);
  const host = document.createElement('div');
  const root = createRoot(host as any);
  try {
    await act(async () => root.render(createElement(ThreadPullRequestBadge, { threadId: 'claude-bound', cwd: '/repo/wt', updatedAt: 1 })));
    // the read settled without the binding (main would refuse the window), and asked main nothing
    assert.equal(host.querySelector('button'), null);
    assert.deepEqual(snapshots, []);
    // becoming ready reads again at once, without waiting for the minute's poll or a focus
    await act(async () => markWindowReady());
    assert.equal(windowIsReady(), true);
    const badge = host.querySelector('button')!;
    assert.equal(badge.getAttribute('aria-label'), 'PR #3041 · merged · Ratings');
    assert.deepEqual(snapshots, ['claude-bound']);
  } finally {
    await act(async () => root.unmount());
    resetWindowReady();
  }
});

test('a badge drawn once the window is ready reads once, with the binding', async () => {
  markWindowReady();
  snapshots.length = 0;
  const host = document.createElement('div');
  const root = createRoot(host as any);
  try {
    await act(async () => root.render(createElement(ThreadPullRequestBadge, { threadId: 'claude-bound', cwd: '/repo/wt2', updatedAt: 2 })));
    assert.equal(host.querySelector('button')!.getAttribute('aria-label'), 'PR #3041 · merged · Ratings');
    assert.deepEqual(snapshots, ['claude-bound']);
    // a chat with no binding asks main and, with nothing else naming a PR, has no badge
    await act(async () => root.render(createElement(ThreadPullRequestBadge, { threadId: 'claude-other', cwd: '/repo/wt3', updatedAt: 3 })));
    assert.equal(host.querySelector('button'), null);
    assert.deepEqual(snapshots, ['claude-bound', 'claude-other']);
  } finally {
    await act(async () => root.unmount());
    resetWindowReady();
  }
});
