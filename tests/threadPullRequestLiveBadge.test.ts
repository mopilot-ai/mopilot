// The real PR reader and badge update together across harnesses, with only native I/O mocked.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

// what the reader asks `gh pr view` for (src/session/pullRequestReader.ts)
const FIELDS =
  'url,state,isDraft,title,mergeable,mergeStateStatus,statusCheckRollup,additions,deletions,labels,autoMergeRequest,mergedAt,mergeCommit,headRefOid,reviewRequests';

let state = 'OPEN';
let head = 'topic';
let available = true;
let history: any[] = [];
let runtime: any = {};
let metadata: Record<string, unknown> = {};
let exactUrl: string | null = null;
/** while set, GitHub reads wait on it */
let gate: Promise<void> | null = null;
const historyIds: string[] = [];
const calls: unknown[][] = [];
const opened: string[] = [];
installNativeStub({
  peer: {
    referenceHistory: async ([id]: string[], assistantOnly: boolean) => (
      assert.equal(assistantOnly, true), historyIds.push(id), { [id]: { turns: history } }
    ),
  },
  fs: { configRoots: async () => ({ codexHome: '/codex' }), readText: async () => '{}' },
  pullRequests: { savedReplies: async () => null, saveReplies: async () => true },
  git: {
    run: async () => ({ ok: true, stdout: `${head}\n` }),
    gh: async (cwd: string, args: string[]) => {
      calls.push([cwd, args]);
      await gate;
      return {
        ok: available && (exactUrl === null || args.at(-1) === exactUrl),
        stdout: JSON.stringify({ url: 'https://github.com/org/repo/pull/42', state, isDraft: false, ...metadata }),
      };
    },
  },
});
mock.module('../src/session/open.ts', { namedExports: { openLink: (url: string) => opened.push(url) } });
mock.module('../src/harness/adapters/codexApi.ts', {
  namedExports: { codexApi: { threadAttachments: async () => ({ data: [], nextCursor: null }) } },
});
stubStore({
  nativeOf: (id: string) => id,
  useStore: Object.assign((fn: any) => fn({ conn: 'ready', runtime }), { getState: () => ({ home: '/home', runtime }) }),
});
const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { noteOwner } = await import('../src/harness/ownership.ts');
const { ThreadPullRequestBadge } = await import('../src/components/sidebar/ThreadPullRequestBadge.tsx');
noteOwner('claude-chat', 'claude');
noteOwner('claude-checks', 'claude');

for (const id of ['codex-chat', 'claude-chat', 'acp:gemini:chat']) {
  test(`${id}: a PR without attachments updates its actual icon and accessible label after merge`, async () => {
    mock.timers.enable({ apis: ['setInterval'] });
    state = 'OPEN';
    head = id === 'codex-chat' ? '123' : 'topic';
    calls.length = 0;
    const host = document.createElement('div');
    const root = createRoot(host as any);
    try {
      await act(async () => root.render(createElement(ThreadPullRequestBadge, { threadId: id, cwd: `/repo/${id}`, updatedAt: 1 })));
      const initial = host.querySelector('button')!;
      assert.equal(initial.getAttribute('aria-label'), 'PR #42 · open');
      const openIcon = initial.querySelector('svg')!.innerHTML;
      state = 'MERGED';
      await act(async () => window.dispatchEvent(new window.Event('focus')));
      const merged = host.querySelector('button')!;
      assert.equal(merged.getAttribute('aria-label'), 'PR #42 · merged');
      assert.equal(merged.className, 'thread-pr-badge merged');
      assert.notEqual(merged.querySelector('svg')!.innerHTML, openIcon);
      state = 'CLOSED';
      await act(async () => mock.timers.tick(60_000));
      assert.equal(host.querySelector('button')!.getAttribute('aria-label'), 'PR #42 · closed');
      // one PR read per change; the signed-in login (for review requests) is asked once for the whole app
      assert.deepEqual(
        calls.filter(([, args]) => (args as string[])[0] === 'pr'),
        Array.from({ length: 3 }, () => [`/repo/${id}`, ['pr', 'view', '--json', FIELDS]]),
      );
      assert.ok(calls.filter(([, args]) => (args as string[])[1] === 'user').length <= 1);
    } finally {
      await act(async () => root.unmount());
      mock.timers.reset();
    }
  });
}

for (const id of ['codex-checks', 'claude-checks', 'acp:gemini:checks']) {
  test(`${id}: GitHub health transitions update the actual status dot, label and PR link together`, async () => {
    const host = document.createElement('div');
    const root = createRoot(host as any);
    available = true;
    state = 'OPEN';
    history = [];
    runtime = {};
    metadata = {
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'BLOCKED',
      statusCheckRollup: [{ __typename: 'CheckRun', status: 'QUEUED', conclusion: null }],
    };
    const badge = () => host.querySelector('button')!;
    const assertStatus = (indicator: string, dot: string | null, label: string) => {
      assert.equal(badge().getAttribute('data-indicator'), indicator);
      assert.equal(badge().getAttribute('aria-label'), `PR #42 · ${label}`);
      assert.equal(badge().querySelector('.thread-pr-dot')?.className ?? null, dot ? `thread-pr-dot ${dot}` : null);
    };
    const refresh = () => act(async () => window.dispatchEvent(new window.Event('focus')));
    try {
      await act(async () => root.render(createElement(ThreadPullRequestBadge, { threadId: id, cwd: `/repo/${id}`, updatedAt: 1 })));
      assertStatus('in_progress', 'pending', 'open · checks pending');
      metadata.statusCheckRollup = [{ __typename: 'StatusContext', state: 'FAILURE' }];
      await refresh();
      assertStatus('failing', 'failing', 'open · checks failing');
      metadata.statusCheckRollup = [{ __typename: 'StatusContext', state: 'SUCCESS' }];
      await refresh();
      assertStatus('successful', 'passing', 'open · checks passed');
      metadata.mergeStateStatus = 'CLEAN';
      await refresh();
      assertStatus('ready', 'ready', 'open · ready to merge');
      metadata.mergeable = 'CONFLICTING';
      await refresh();
      assertStatus('failing', 'conflict', 'open · merge conflicts');
      metadata.isDraft = true;
      await refresh();
      // a draft keeps its health: still conflicting, now as a draft
      assertStatus('failing', 'conflict', 'draft · merge conflicts');
      state = 'MERGED';
      await refresh();
      assertStatus('merged', null, 'merged');
      assert.equal(badge().className, 'thread-pr-badge merged');
      state = 'CLOSED';
      await refresh();
      assertStatus('closed', null, 'closed');
      state = 'OPEN';
      metadata = { statusCheckRollup: [{ __typename: 'Unknown' }] };
      await refresh();
      assertStatus('open', 'unknown', 'open · checks unavailable');
      available = false;
      await refresh();
      assertStatus('unknown', null, 'status unavailable');
      available = true;
      metadata = { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: [] };
      await refresh();
      assertStatus('ready', 'ready', 'open · ready to merge');
    } finally {
      await act(async () => root.unmount());
      metadata = {};
      state = 'OPEN';
      available = true;
    }
  });
}

for (const id of ['codex-chat', 'claude-chat', 'acp:gemini:chat']) {
  test(`${id}: stored response text supplies a badge without a worktree and a later live response refreshes it`, async () => {
    const url = 'https://github.com/org/repo/pull/42';
    const turn = (text: string) => ({ id: text, status: 'completed', items: [{ type: 'agentMessage', text }] });
    available = false;
    history = [turn(`Opened [PR #42](${url}). The PR is labeled merge-on-green, not merged yet.`)];
    runtime = {};
    historyIds.length = 0;
    const host = document.createElement('div');
    const root = createRoot(host as any);
    // the chat was updated since the tests above showed it (updatedAt 1): its saved replies are read again
    const show = (updatedAt: number) => act(async () => root.render(createElement(ThreadPullRequestBadge, { threadId: id, updatedAt })));
    try {
      await show(2);
      assert.equal(host.querySelector('button')!.getAttribute('aria-label'), 'PR #42 · reported open');
      assert.deepEqual(historyIds, [id], 'history uses the stable chat id on every harness');
      const merged = [...history, turn(`Merged [org/repo#42](${url}) and verified commit \`abc123\` is on remote \`main\`.`)];
      runtime = { [id]: { loaded: true, turns: merged } };
      await show(2);
      assert.equal(host.querySelector('button')!.getAttribute('aria-label'), 'PR #42 · reported merged');
      assert.equal(host.querySelector('button')!.className, 'thread-pr-badge merged');
      assert.deepEqual(historyIds, [id], 'loaded completed responses avoid rereading persisted history');
      history = merged;
      runtime = {};
      await show(3);
      assert.equal(host.querySelector('button')!.getAttribute('aria-label'), 'PR #42 · reported merged');
      assert.deepEqual(historyIds, [id, id], 'the new history version recovers the merge with no loaded transcript');
      available = true;
      state = 'CLOSED';
      await act(async () => window.dispatchEvent(new window.Event('focus')));
      assert.equal(host.querySelector('button')!.getAttribute('aria-label'), 'PR #42 · closed');
    } finally {
      await act(async () => root.unmount());
      available = true;
      history = [];
      runtime = {};
    }
  });
}

for (const id of ['codex-remount', 'claude-remount', 'acp:gemini:remount']) {
  test(`${id}: a remounted row shows its settled PR at once and asks GitHub nothing within the minute`, async () => {
    state = 'OPEN';
    head = 'topic';
    history = [];
    runtime = {};
    const host = document.createElement('div');
    const show = (root: ReturnType<typeof createRoot>, updatedAt = 1) =>
      act(async () => root.render(createElement(ThreadPullRequestBadge, { threadId: id, cwd: `/repo/${id}`, updatedAt })));
    const first = createRoot(host as any);
    await show(first);
    assert.equal(host.querySelector('button')!.getAttribute('aria-label'), 'PR #42 · open');
    await act(async () => first.unmount());
    let release!: () => void;
    gate = new Promise<void>((resolve) => (release = resolve));
    const second = createRoot(host as any);
    try {
      state = 'MERGED';
      await show(second);
      assert.equal(host.querySelector('button')!.getAttribute('aria-label'), 'PR #42 · open', 'no blank badge');
      release();
      await act(async () => gate);
      // nothing was read for the remount (#2963): GitHub's newer answer waits for the minute poll
      assert.equal(host.querySelector('button')!.getAttribute('aria-label'), 'PR #42 · open');
      // a newer history version has no settled read yet, so nothing stale shows for it
      await act(async () => second.unmount());
      gate = new Promise<void>((resolve) => (release = resolve));
      const third = createRoot(host as any);
      await show(third, 5);
      assert.equal(host.querySelector('button'), null);
      release();
      await act(async () => gate);
      assert.equal(host.querySelector('button')!.getAttribute('aria-label'), 'PR #42 · merged');
      await act(async () => third.unmount());
    } finally {
      release();
      gate = null;
      state = 'OPEN';
    }
  });
}

for (const id of ['codex-renamed', 'claude-renamed', 'acp:gemini:renamed']) {
  test(`${id}: a saved open report for a moved PR renders a live merged badge that opens the new URL`, async () => {
    noteOwner('claude-renamed', 'claude');
    const old = 'https://github.com/mopilot-ai/mopilot/pull/5390';
    const url = 'https://github.com/mopilot-ai/mopilot-internal/pull/5390';
    const host = document.createElement('div');
    const root = createRoot(host as any);
    exactUrl = url;
    available = true;
    state = 'MERGED';
    metadata = { url };
    runtime = {};
    history = [
      {
        id: 'historical',
        status: 'completed',
        completedAt: Date.parse('2026-11-21T08:22:00Z') / 1_000,
        items: [{ type: 'agentMessage', text: `Opened [PR #5390](${old}).` }],
      },
    ];
    try {
      await act(async () => root.render(createElement(ThreadPullRequestBadge, { threadId: id, updatedAt: Date.parse('2026-11-22') })));
      const badge = host.querySelector('button')!;
      assert.equal(badge.getAttribute('aria-label'), 'PR #5390 · merged');
      badge.click();
      assert.equal(opened.at(-1), url);
    } finally {
      await act(async () => root.unmount());
      exactUrl = null;
      metadata = {};
      state = 'OPEN';
      history = [];
    }
  });
}

for (const id of ['codex-citation', 'claude-citation', 'acp:gemini:citation']) {
  test(`${id}: the real badge ignores historical citations and still appears for work opened by this chat`, async () => {
    noteOwner('claude-citation', 'claude');
    const cited = 'https://github.com/mopilot-ai/mopilot-internal/pull/2961';
    const owned = 'https://github.com/org/repo/pull/42';
    const turn = (text: string) => ({ id: text, status: 'completed', items: [{ type: 'agentMessage', text }] });
    history = [turn(`[PR #2961](${cited}) says CI retests led to combining slices into one large PR.`)];
    runtime = {};
    calls.length = 0;
    state = 'OPEN';
    available = true;
    const host = document.createElement('div');
    const root = createRoot(host as any);
    const show = (updatedAt: number) => act(async () => root.render(createElement(ThreadPullRequestBadge, { threadId: id, updatedAt })));
    try {
      await show(1);
      assert.equal(host.querySelector('button'), null, 'a historical citation has no sidebar badge');
      assert.deepEqual(calls, [], 'the historical PR was never read as a chat-owned PR');
      runtime = { [id]: { loaded: true, turns: [...history, turn(`Opened [PR #42](${owned}).`)] } };
      await show(2);
      assert.match(host.querySelector('button')!.getAttribute('aria-label')!, /PR #42 · open/);
      runtime[id].turns.push(history[0]);
      await show(3);
      assert.equal(host.querySelector('.thread-pr-count'), null, 'a new citation cannot inflate the owned PR count');
      assert.match(host.querySelector('button')!.getAttribute('aria-label')!, /PR #42 · open/);
    } finally {
      await act(async () => root.unmount());
      history = [];
      runtime = {};
    }
  });
}
