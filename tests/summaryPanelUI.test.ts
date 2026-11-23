import { rendersOf, resetCommits } from './support/commitProbe.ts'; // first: React reads the hook as it loads
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { one, byText, settle, render } from './support/shell-panels-kit.ts';
import { deferred } from './support/async-scenarios.ts';

import { summaryPanelKit } from './support/summary-panel-kit.ts';

const kit = await summaryPanelKit();
const { store, calls, ok, impl, SummaryPanel, gitInfo, reset, mount, turn } = kit;
const { createElement, act } = await import('react');
const { GIT_POLL_MS: SUMMARY_POLL_MS, GIT_IDLE_POLL_MS: SUMMARY_IDLE_POLL_MS } = await import('../src/lib/gitPoll.ts');
const { useLocalSummaryRepo } = await import('../src/components/panels/useLocalSummaryRepo.ts');
const noPullRequest = async () => ({ ok: false, stderr: 'no pull requests found for branch "main"' });

test('a git repo with a remote shows change totals and the pull request row', async () => {
  reset({ t1: { cwd: '/work/app' } }, { t1: { turns: [turn()] } });
  const { host, unmount } = await mount();
  assert.equal(host.querySelector('.summary-project')!.textContent, 'app');
  // the one-line name keeps the full folder on hover
  assert.equal(host.querySelector('.summary-project')!.getAttribute('title'), '/work/app');
  assert.equal(one(host, '.summary-row', 'Branch changes').querySelector('.diff-stat')!.textContent, '+5 -1');
  await act(() => one(host, '.summary-row', 'Branch changes').click());
  assert.deepEqual(store.calls, [['openChanges', { scope: 'branch' }]]);
  // its states and actions: tests/summaryPullRequestUI.test.ts
  assert.ok(one(host, '.summary-row', 'Existing pull request'));
  assert.deepEqual(calls.slice(0, 3), [
    ['info', '/work/app'],
    ['status', '/work/app'],
    ['gh', '/work/app', 'pr', 'view', '--json', 'number,url,title,state'],
  ]);
  await unmount();
});

test('outside a git repo there are no stats, no PR row and no gh lookup', async () => {
  reset({ t1: { cwd: '/scratch' } }, {});
  impl.info = async () => null;
  const { host, unmount } = await mount();
  assert.equal(host.querySelector('.diff-stat'), null);
  assert.equal(byText(host, '.summary-row', 'ull request').length, 0);
  assert.deepEqual(calls, [['info', '/scratch']]);
  await unmount();
});

test('a thread without a folder never asks git', async () => {
  reset({}, {});
  const { host, unmount } = await mount('ghost');
  assert.equal(host.querySelector('.summary-project')!.textContent, 'No folder');
  assert.deepEqual(calls, []);
  await unmount();
});

test('an explicit refresh skips Git for an empty workspace or an unconfirmed local owner', async () => {
  reset({}, {});
  let refresh!: () => Promise<void>;
  function Probe({ location }: { location: Parameters<typeof useLocalSummaryRepo>[0] }) {
    refresh = useLocalSummaryRepo(location, 0, false).refresh;
    return null;
  }
  const r = await render(createElement(Probe, { location: { cwd: '', pending: false, machine: null } }));
  for (const location of [
    { cwd: '', pending: false, machine: null },
    { cwd: '/repo', pending: true, machine: null },
    { cwd: '/repo', pending: false, machine: { id: 'm', name: 'box', away: false } },
  ]) {
    await r.rerender(createElement(Probe, { location }));
    await act(() => refresh());
    assert.deepEqual(calls, []);
  }
  await r.unmount();
});

test('a refresh that is overtaken drops its stale results at every step', async () => {
  reset({ t1: { cwd: '/repo' } }, { t1: { turns: [] } });
  const info = deferred<any>();
  impl.info = () => info.promise;
  const { host, unmount } = await mount();
  // overtaken while asking for info
  await act(() => one(host, '.icon-btn').click());
  impl.info = async () => gitInfo;
  const status = deferred<any>();
  impl.status = () => status.promise;
  await act(async () => one(host, '[role="menuitem"]', 'Refresh').click());
  await act(async () => {
    info.resolve({ ...gitInfo, remote: '' });
  });
  await settle(act);
  // overtaken while asking for status
  impl.status = async () => ({ files: [] });
  const gh = deferred<any>();
  impl.gh = () => gh.promise;
  await act(() => one(host, '.icon-btn').click());
  await act(async () => one(host, '[role="menuitem"]', 'Refresh').click());
  await act(async () => {
    status.reject(new Error('retired diff read'));
  });
  await settle(act);
  // overtaken while asking gh
  impl.gh = async () => ok(JSON.stringify({ number: 2, url: 'https://github.com/o/r/pull/2', title: 'New', state: 'MERGED' }));
  await act(() => one(host, '.icon-btn').click());
  await act(async () => one(host, '[role="menuitem"]', 'Refresh').click());
  await act(async () => {
    gh.resolve(ok(JSON.stringify({ number: 1, url: 'https://github.com/o/r/pull/1', title: 'Old', state: 'OPEN' })));
  });
  await settle(act);
  assert.equal(one(host, '.summary-row', 'Branch changes').querySelector('.summary-hint')!.textContent, 'No changes');
  assert.equal(one(host, '.summary-row', '#').textContent, '#2 Newmerged');
  await unmount();
});

test('a slow branch diff never holds the branch’s pull request, and a newer branch retires an old lookup', async () => {
  reset({ t1: { cwd: '/repo' } }, { t1: { turns: [] } });
  const diff = deferred<{ files: unknown[] }>();
  impl.status = () => diff.promise;
  const r = await mount();
  assert.equal(one(r.host, '.summary-branch-changes .summary-hint').textContent, 'Reading…');
  assert.ok(one(r.host, '.summary-row', 'Existing pull request'));

  const pending = deferred<ReturnType<typeof ok>>();
  impl.gh = () => pending.promise;
  await act(() => window.dispatchEvent(new Event('focus')));
  impl.info = async () => ({ ...gitInfo, branch: 'replacement' });
  impl.gh = noPullRequest;
  await act(() => window.dispatchEvent(new Event('focus')));
  await act(() =>
    pending.resolve(ok(JSON.stringify({ number: 1, title: 'Wrong PR', state: 'OPEN', url: 'https://github.com/o/r/pull/1' }))),
  );
  await act(() => diff.resolve({ files: [] }));
  assert.equal(one(r.host, '.summary-branch').textContent, 'replacement');
  assert.equal(byText(r.host, '.summary-row', 'Existing pull request').length, 0);
  assert.match(one(r.host, '.summary-row', 'Pull request').textContent!, /Create/);
  await r.unmount();
});

test('a streamed delta, token usage or a title renders no panel; a new plan does', async () => {
  const plan = { steps: [{ step: 'Read', status: 'completed' }] };
  const planned = turn([], { plan });
  const live = (text: string) => ({ id: 'live', items: [{ id: 'r', type: 'agentMessage', text }], status: 'inProgress' });
  reset({ t1: { cwd: '/repo' } }, { t1: { turns: [planned, live('W')] } });
  const { host, unmount } = await mount();
  const reads = calls.filter(([c]) => c === 'info').length;
  const runtime = (turns: any[], extra: any = {}) => store.set({ runtime: { t1: { turns, ...extra } } });

  resetCommits();
  await act(async () => runtime([planned, live('Wo')]));
  await act(async () => runtime([planned, live('Wor')], { tokenUsage: { total: 3 } }));
  await act(async () => store.set({ threads: { t1: { cwd: '/repo', title: 'Renamed' } } }));
  assert.deepEqual(rendersOf('ChatSummary'), []);
  // nor does it read the repository again for them
  assert.equal(calls.filter(([c]) => c === 'info').length, reads);

  // the running turn's plan is the latest: the panel shows it
  await act(async () => runtime([planned, { ...live('Wor'), plan: { steps: [{ step: 'Write', status: 'inProgress' }] } }]));
  assert.deepEqual(rendersOf('ChatSummary'), []);
  assert.equal(one(host, '.summary-plan').textContent, 'Plan0 of 1');
  await unmount();
});

test('without spawns or plans those sections stay hidden and Sources offers the first link', async () => {
  reset({ t1: { cwd: '/repo' } }, { t1: { turns: [turn([{ type: 'agentMessage', text: 'no links' }])] } });
  const { host, unmount } = await mount();
  assert.equal(host.querySelector('.summary-activity'), null);
  assert.equal(one(host, '.summary-section').textContent, 'Sources');
  assert.ok(host.querySelector('[title="Add source"]'));
  await unmount();
});

test('sources collect links from searches, messages and commands, grouped by host', async () => {
  reset(
    { t1: { cwd: '/repo' } },
    {
      t1: {
        turns: [
          turn([
            {
              type: 'webSearch',
              action: { url: 'https://a.com/search' },
              results: [{ url: 'https://a.com/one' }, null, { title: 'no url' }],
            },
            { type: 'webSearch', action: {} },
            {
              type: 'userMessage',
              content: [
                { type: 'text', text: 'see https://b.org/x, and http://[bad' },
                { type: 'image', url: 'https://img' },
                { type: 'text', text: 'no link here' },
              ],
            },
            { type: 'userMessage' },
            { type: 'agentMessage', text: 'docs at https://c.dev/guide.' },
            { type: 'agentMessage' },
            { type: 'commandExecution', command: 'curl https://d.io/api https://a.com/one' },
            { type: 'commandExecution' },
            { type: 'reasoning', text: 'https://ignored.example' },
          ]),
        ],
      },
    },
  );
  const { host, unmount } = await mount();
  const labels = () => [...host.querySelectorAll('.summary-section .summary-label')].map((l) => l.textContent);
  assert.deepEqual(labels(), ['a.com', 'b.org', 'c.dev', 'Show all 5 links']);
  await act(() => one(host, '.summary-section .summary-row', 'b.org').click());
  assert.deepEqual(calls.slice(-1), [['external', 'https://b.org/x']]);
  await act(() => one(host, '.summary-row.muted').click());
  assert.deepEqual(labels(), ['a.com/search', 'a.com/one', 'b.org/x', 'c.dev/guide', 'd.io/api', 'Show less']);
  await act(() => one(host, '.summary-row.muted').click());
  assert.equal(labels().at(-1), 'Show all 5 links');
  const inserted: unknown[] = [];
  const onInsert = (e: any) => inserted.push(e.detail);
  window.addEventListener('composer-insert', onInsert);
  await act(() => one(host, '[title="Add source"]').click());
  window.removeEventListener('composer-insert', onInsert);
  assert.deepEqual(inserted, [], 'opening the URL form must leave the draft untouched');
  assert.ok(host.querySelector('input[aria-label="Source URL"]'));
  await unmount();
});

test('a single link can be expanded to its full address and collapsed back', async () => {
  reset({ t1: { cwd: '/repo' } }, { t1: { turns: [turn([{ type: 'agentMessage', text: 'https://one.dev/a' }])] } });
  const { host, unmount } = await mount();
  const labels = () => [...host.querySelectorAll('.summary-section .summary-label')].map((l) => l.textContent);
  assert.deepEqual(labels(), ['one.dev', 'Show full link']);
  await act(() => one(host, '.summary-row.muted').click());
  assert.deepEqual(labels(), ['one.dev/a', 'Show less']);
  await act(() => one(host, '.summary-row.muted').click());
  assert.deepEqual(labels(), ['one.dev', 'Show full link']);
  await unmount();
});

test('focus refreshes totals and failed reads clear them', async () => {
  reset({ t1: { cwd: '/repo' } }, { t1: { turns: [] } });
  const r = await mount();
  impl.status = async () => ({ files: [{ added: 12, removed: 4 }] });
  await act(async () => window.dispatchEvent(new Event('focus')));
  await settle(act);
  assert.equal(one(r.host, '.diff-stat').textContent, '+12 -4');
  impl.status = async () => null;
  impl.gh = async () => ({ ok: false, stderr: 'GitHub CLI is not logged in' });
  await act(async () => window.dispatchEvent(new Event('focus')));
  await settle(act);
  assert.equal(r.host.querySelector('.diff-stat'), null);
  assert.ok(one(r.host, '.summary-row', 'Existing pull request'));
  impl.gh = noPullRequest;
  await act(async () => window.dispatchEvent(new Event('focus')));
  assert.ok(one(r.host, '.summary-row', 'Create'));
  await r.unmount();
});

test('a repository read error is visible and a later retry restores the branch and PR status', async () => {
  reset({ t1: { cwd: '/repo' } }, { t1: { turns: [] } });
  impl.info = async () => {
    throw new Error('Git unavailable');
  };
  const r = await mount();
  assert.equal(one(r.host, '.summary-row', 'Branch changes').textContent, 'Branch changesUnavailable');
  assert.equal(r.host.querySelector('.summary-branch'), null);
  impl.info = async () => gitInfo;
  impl.gh = async () => ok('{');
  await act(() => window.dispatchEvent(new Event('focus')));
  assert.equal(one(r.host, '.summary-branch').textContent, 'main');
  assert.equal(byText(r.host, '.summary-row', 'Create').length, 0);
  impl.gh = noPullRequest;
  await act(() => window.dispatchEvent(new Event('focus')));
  assert.ok(one(r.host, '.summary-row', 'Create'));
  await r.unmount();
});

test('periodic refresh reads every 5 s while a turn runs and every 30 s while none does, without repeatedly querying GitHub', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  reset({ t1: { cwd: '/repo' } }, { t1: { turns: [] } });
  const r = await mount();
  try {
    const gh = () => calls.filter((c) => c[0] === 'gh').length;
    let before = gh();
    // idle: an edit made outside the app shows within the slower interval, not the turn's
    impl.status = async () => ({ files: [{ added: 7, removed: 1 }] });
    await act(async () => mock.timers.tick(SUMMARY_POLL_MS));
    await settle(act);
    assert.notEqual(r.host.querySelector('.diff-stat')?.textContent, '+7 -1');
    await act(async () => mock.timers.tick(SUMMARY_IDLE_POLL_MS - SUMMARY_POLL_MS));
    await settle(act);
    assert.equal(one(r.host, '.diff-stat').textContent, '+7 -1');
    assert.equal(gh(), before, 'the timer never asks GitHub');
    // a running turn: its start reads in full at once, then the timer reads every 5 s
    await act(async () => store.set({ runtime: { t1: { turns: [], activeTurnId: 'T1' } } }));
    await settle(act);
    before = gh();
    impl.status = async () => ({ files: [{ added: 9, removed: 2 }] });
    await act(async () => mock.timers.tick(SUMMARY_POLL_MS));
    await settle(act);
    assert.equal(one(r.host, '.diff-stat').textContent, '+9 -2');
    assert.equal(gh(), before, 'the timer never asks GitHub');
  } finally {
    await r.unmount();
    mock.timers.reset();
  }
});

test("another folder shows none of the last folder's totals or pull request while its own load", async () => {
  reset({ t1: { cwd: '/work/app' }, t2: { cwd: '/work/lib' } }, { t1: { turns: [] }, t2: { turns: [] } });
  const r = await render(createElement(SummaryPanel, { threadId: 't1' }));
  await settle(act);
  assert.equal(one(r.host, '.diff-stat').textContent, '+5 -1');
  assert.ok(one(r.host, '.summary-row', 'Existing pull request'));
  const info = deferred<any>();
  impl.info = () => info.promise;
  await r.rerender(createElement(SummaryPanel, { threadId: 't2' }));
  // the first frame for the new folder already has no totals and no pull request row
  assert.equal(r.host.querySelector('.summary-project')!.textContent, 'lib');
  assert.equal(r.host.querySelector('.diff-stat'), null);
  assert.equal(byText(r.host, '.summary-row', 'ull request').length, 0);
  impl.status = async () => ({ files: [{ added: 1, removed: 0 }] });
  await act(async () => info.resolve(gitInfo));
  await settle(act);
  assert.equal(one(r.host, '.diff-stat').textContent, '+1 -0');
  await r.unmount();
});
