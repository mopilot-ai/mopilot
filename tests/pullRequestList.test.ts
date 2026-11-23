// src/components/markdown/PullRequestList.tsx: the sidebar badge's hover card of a chat's PRs (#1581), laid out as Claude Code lists a
// session's: each row's title over its state, repository and number, and lines added and removed; a click opens that PR.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
// a DOM for React to render into
import './support/dom.ts';

const opened: string[] = [];
mock.module('../src/session/open.ts', { namedExports: { openLink: (u: string) => opened.push(u) } });
const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { PullRequestList, pullRequestLabel, pullRequestRepository } = await import('../src/components/markdown/PullRequestList.tsx');
const url = (n: number) => `https://github.com/org/repo/pull/${n}`;

test('one row per PR: title over state, repository #number and line counts; a click opens it', async () => {
  const entries: any[] = [
    { url: url(45), number: 45, state: 'open', title: 'Third', additions: 120, deletions: 4 },
    { url: url(44), number: 44, state: 'merged', title: 'Second', additions: 3, deletions: 0 },
    { url: url(43), number: 43, state: 'merged', source: 'response' },
    { url: url(42), number: 42, state: 'closed', additions: 1 },
    { url: url(41), number: 41, state: 'draft', title: 'Draft' },
    {
      url: 'https://example.com/pr/40',
      number: 40,
      state: 'open',
      title: 'Elsewhere',
      details: { checks: 'failing', mergeable: 'MERGEABLE', mergeState: 'CLEAN' },
    },
  ];
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host as any);
  try {
    let bubbled = 0;
    // the sidebar row under the badge
    await act(async () => root.render(createElement('div', { onClick: () => bubbled++ }, createElement(PullRequestList, { entries }))));
    const rows = [...host.querySelectorAll('.thread-pr-list-item')];
    const part = (r: Element, name: string) => r.querySelector(`.thread-pr-list-${name}`)?.textContent ?? null;
    assert.deepEqual(
      rows.map((r) => [part(r, 'title'), part(r, 'state'), part(r, 'number'), part(r, 'stats')]),
      [
        ['Third', 'Open', ' · org/repo #45', '+120 −4'],
        ['Second', 'Merged', ' · org/repo #44', '+3 −0'],
        // no title: the number stands in; a PR only a reply reported says so
        ['PR #43', 'Reported merged', ' · org/repo #43', null],
        // one line count without the other shows neither
        ['PR #42', 'Closed', ' · org/repo #42', null],
        ['Draft', 'Draft', ' · org/repo #41', null],
        // check health shows in the state; a URL with no repository shows just the number
        ['Elsewhere', 'Open · checks failing', ' · #40', null],
      ],
    );
    // the state icon sits in the state, which takes the state's color
    assert.ok(rows[1].querySelector('.thread-pr-list-state svg'));
    // an open PR with failing checks is marked failing, not just open
    assert.deepEqual(
      rows.map((r) => r.querySelector('.thread-pr-list-state')!.getAttribute('data-indicator')),
      ['open', 'merged', 'merged', 'closed', 'draft', 'failing'],
    );
    assert.deepEqual(
      rows.map((r) => r.className),
      [
        'thread-pr-list-item open',
        'thread-pr-list-item merged',
        'thread-pr-list-item merged',
        'thread-pr-list-item closed',
        'thread-pr-list-item draft',
        'thread-pr-list-item open',
      ],
    );
    assert.equal(rows[2].getAttribute('aria-label'), 'PR #43 · reported merged');
    assert.equal(host.querySelector('ul')!.getAttribute('aria-label'), 'Pull requests');
    await act(async () => (rows[1] as HTMLElement).click());
    assert.deepEqual(opened, [url(44)]);
    // the row's click stays out of the sidebar row under the badge
    assert.equal(bubbled, 0);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
  assert.equal(pullRequestLabel({ url: url(9), number: 9, state: 'unknown' }), 'PR #9 · status unavailable');
});

test('the repository comes from the PR URL as GitHub names it', () => {
  assert.equal(pullRequestRepository('https://github.com/mopilot-ai/mopilot-internal/pull/1583'), 'mopilot-ai/mopilot-internal');
  assert.equal(pullRequestRepository('https://github.com/Org/Repo/pull/1/files'), 'Org/Repo');
  assert.equal(pullRequestRepository('https://github.com/org/repo/issues/1'), null);
  assert.equal(pullRequestRepository('https://gitlab.com/org/repo/pull/1'), null);
});
