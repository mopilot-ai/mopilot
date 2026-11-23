// Starting a chat from a GitHub pull request in main: what a typed reference names (shared/pullRequestRef.mjs), finding it in the folder's origin repository and fetching its head (electron/platform/prSource.cjs), and the IPC that serves the window (electron/app/ipc/prSource.cjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pullRequestRef } from '../shared/pullRequestRef.mjs';

const require = createRequire(import.meta.url);
const { findPullRequest, fetchPullRequest } = require('../electron/platform/prSource.cjs');
const { registerPrSource, registeredBy } = require('../electron/app/ipc/prSource.cjs');

type Answer = { ok: boolean; stdout?: string; stderr?: string };
const pr = (over: object = {}) => ({
  number: 12,
  title: 'Fix the thing',
  url: 'https://github.com/acme/app/pull/12',
  state: 'OPEN',
  headRefName: 'fix-thing',
  baseRefName: 'main',
  isCrossRepository: false,
  ...over,
});
/** A fake command runner: origin's URL, gh's answer and git fetch's, with every call kept. */
function runner(
  { origin = 'git@github.com:Acme/app.git', gh = { ok: true, stdout: JSON.stringify(pr()) }, fetch = { ok: true } } = {} as {
    origin?: string | null;
    gh?: Answer;
    fetch?: Answer;
  },
) {
  const calls: [string, string[]][] = [];
  const run = async (cmd: string, args: string[]) => {
    calls.push([cmd, args]);
    const a: Answer =
      cmd === 'gh'
        ? gh
        : args[0] === 'fetch'
          ? fetch
          : origin === null
            ? { ok: false, stderr: 'No such remote' }
            : { ok: true, stdout: `${origin}\n` };
    return { stdout: '', stderr: '', ...a };
  };
  return { run, calls };
}

test('a reference is #12 or a pull request link (its tabs too); a bare number, a branch name or another link is none', () => {
  assert.deepEqual(pullRequestRef(' #12 '), { number: 12, repo: null });
  assert.deepEqual(pullRequestRef('https://github.com/Acme/App/pull/7'), { number: 7, repo: 'acme/app' });
  for (const tab of ['/files', '/files#diff-abc', '/changes', '/commits/abc123', '/', '?w=1', '#issuecomment-1'])
    assert.deepEqual(pullRequestRef(`https://github.com/acme/app/pull/7${tab}`), { number: 7, repo: 'acme/app' }, tab);
  for (const none of [
    '12',
    '#0',
    '#012',
    '#1234567890',
    'fix-12',
    'https://github.com/acme/app/issues/7',
    'http://github.com/acme/app/pull/7',
    'https://github.com/acme/app/pull/1234567890',
    42,
    null,
  ])
    assert.equal(pullRequestRef(none), null, String(none));
});

test('a pull request of origin’s own repository is found with its branch, base and state', async () => {
  const { run, calls } = runner();
  assert.deepEqual(await findPullRequest(run, '/w/app', 'https://github.com/acme/app/pull/12'), {
    ok: true,
    number: 12,
    title: 'Fix the thing',
    url: 'https://github.com/acme/app/pull/12',
    state: 'OPEN',
    base: 'main',
    head: 'fix-thing',
    fork: false,
    own: true,
    checkout: 'fix-thing',
  });
  // gh is pinned to origin's repository, never the one it would guess
  assert.deepEqual(calls[1], [
    'gh',
    ['pr', 'view', '12', '--repo', 'acme/app', '--json', 'number,title,url,state,headRefName,baseRefName,isCrossRepository'],
  ]);
});

test('a fork’s pull request, or one no longer open, is worked on as a copy, pr/<n>; a long title is cut', async () => {
  for (const [over, fork] of [
    [{ isCrossRepository: true }, true],
    [{ state: 'MERGED' }, false],
    [{ state: 'CLOSED' }, false],
  ] as const) {
    const { run } = runner({ gh: { ok: true, stdout: JSON.stringify(pr({ ...over, title: 'x'.repeat(300) })) } });
    const found = await findPullRequest(run, '/w/app', '#12');
    assert.deepEqual([found.fork, found.own, found.checkout, found.title.length], [fork, false, 'pr/12', 256]);
  }
});

test('what is not a pull request of this repository, or that gh cannot say, is refused with why', async () => {
  const cases: [Parameters<typeof runner>[0], string, string][] = [
    [{}, 'fix-thing', 'Type # and a pull request number, or paste its link.'],
    [{ origin: null }, '#12', 'This folder’s origin is not a GitHub repository.'],
    [{ origin: 'https://gitlab.com/acme/app.git' }, '#12', 'This folder’s origin is not a GitHub repository.'],
    [{}, 'https://github.com/other/app/pull/12', 'That pull request is in other/app, not in acme/app.'],
    [
      { gh: { ok: false, stderr: 'To get started with GitHub CLI, please run:  gh auth login' } },
      '#12',
      'GitHub CLI is not signed in. Run `gh auth login` in a terminal, then try again.',
    ],
    [
      { gh: { ok: false, stderr: 'GraphQL: Could not resolve to a PullRequest with the number of 12.' } },
      '#12',
      'acme/app has no pull request #12.',
    ],
    [{ gh: { ok: false } }, '#12', 'GitHub CLI did not answer: it timed out or is not installed.'],
    [{ gh: { ok: false, stderr: 'no pull requests found for branch "x"' } }, '#12', 'acme/app has no pull request #12.'],
    [
      { gh: { ok: false, stderr: "GraphQL: Could not resolve to a Repository with the name 'acme/app'." } },
      '#12',
      'GitHub CLI can’t see acme/app. Sign in with an account that can read it: run `gh auth login`.',
    ],
    [{ gh: { ok: true, stdout: 'not json' } }, '#12', 'GitHub returned incomplete pull request data. Try again.'],
    [{ gh: { ok: true, stdout: JSON.stringify(pr({ number: 13 })) } }, '#12', 'GitHub returned incomplete pull request data. Try again.'],
    [
      { gh: { ok: true, stdout: JSON.stringify(pr({ headRefName: '-x' })) } },
      '#12',
      'GitHub returned incomplete pull request data. Try again.',
    ],
    [
      { gh: { ok: true, stdout: JSON.stringify(pr({ baseRefName: 'a b' })) } },
      '#12',
      'GitHub returned incomplete pull request data. Try again.',
    ],
    [{ gh: { ok: true, stdout: JSON.stringify(pr({ title: null })) } }, '#12', 'GitHub returned incomplete pull request data. Try again.'],
    [{ gh: { ok: true, stdout: JSON.stringify(pr({ url: 3 })) } }, '#12', 'GitHub returned incomplete pull request data. Try again.'],
    [
      { gh: { ok: true, stdout: JSON.stringify(pr({ state: 'DRAFT' })) } },
      '#12',
      'GitHub returned incomplete pull request data. Try again.',
    ],
    [{ gh: { ok: true, stdout: 'null' } }, '#12', 'GitHub returned incomplete pull request data. Try again.'],
  ];
  for (const [o, text, error] of cases) {
    const { missing, ...refused } = await findPullRequest(runner(o).run, '/w/app', text);
    assert.deepEqual(refused, { ok: false, error }, text);
    // only a pull request origin doesn't have names the repository, so an issue of that number can be tried
    assert.equal(missing, error.includes('has no pull request') ? 'acme/app' : undefined, text);
  }
});

test('gh’s own words for another failure go to the log; the window is told to try again', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  assert.deepEqual(await findPullRequest(runner({ gh: { ok: false, stderr: 'HTTP 502: Bad Gateway' } }).run, '/w/app', '#12'), {
    ok: false,
    error: 'GitHub CLI couldn’t look up #12. Try again.',
  });
  assert.match(String(warn.mock.calls[0].arguments[0]), /HTTP 502: Bad Gateway/);
});

test('a fetch finds the pull request again and fetches its head: origin’s open branch to its tracking ref, any other to a ref of our own', async () => {
  const same = runner();
  assert.equal((await fetchPullRequest(same.run, '/w/app', 12)).checkout, 'fix-thing');
  assert.deepEqual(same.calls.at(-1), ['git', ['fetch', '--no-tags', 'origin', '+refs/heads/fix-thing:refs/remotes/origin/fix-thing']]);
  const fork = runner({ gh: { ok: true, stdout: JSON.stringify(pr({ isCrossRepository: true })) } });
  assert.equal((await fetchPullRequest(fork.run, '/w/app', 12)).checkout, 'pr/12');
  assert.deepEqual(fork.calls.at(-1), ['git', ['fetch', '--no-tags', 'origin', '+refs/pull/12/head:refs/mopilot/pull/12']]);
  // a merged pull request's branch is usually deleted: GitHub keeps its head under refs/pull
  const merged = runner({ gh: { ok: true, stdout: JSON.stringify(pr({ state: 'MERGED' })) } });
  assert.equal((await fetchPullRequest(merged.run, '/w/app', 12)).checkout, 'pr/12');
  assert.deepEqual(merged.calls.at(-1), ['git', ['fetch', '--no-tags', 'origin', '+refs/pull/12/head:refs/mopilot/pull/12']]);
});

test('a fetch that fails, or a pull request no longer found, says why and fetches nothing more', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const failed = runner({ fetch: { ok: false, stderr: 'fatal: unable to access' } });
  assert.deepEqual(await fetchPullRequest(failed.run, '/w/app', 12), {
    ok: false,
    error: 'Couldn’t fetch pull request #12 from origin. Check the connection and that you can read the repository, then try again.',
  });
  // git's own words go to the log, not the window
  assert.match(String(warn.mock.calls[0].arguments[0]), /fatal: unable to access/);
  const gone = runner({ gh: { ok: false, stderr: 'Could not resolve to a PullRequest' } });
  assert.equal((await fetchPullRequest(gone.run, '/w/app', 12)).ok, false);
  assert.equal(gone.calls.filter(([, a]) => a[0] === 'fetch').length, 0);
  for (const bad of [0, -1, 1.5, '12', null])
    assert.deepEqual(await fetchPullRequest(runner().run, '/w/app', bad), { ok: false, error: 'Invalid pull request number.' });
});

test('the IPC answers only an app window, for a full folder path, with gh in the GitHub queue and git outside it', async () => {
  assert.equal(registeredBy, 'prMonitor');
  const handlers = new Map<string, (...a: any[]) => any>();
  const { run, calls } = runner();
  const queued: string[] = [];
  const windows: unknown[] = [];
  registerPrSource(
    { handle: (name: string, fn: (...a: any[]) => any) => handlers.set(name, fn) },
    {
      run,
      validWindow: (event: unknown) => windows.push(event),
      github: (work: () => Promise<unknown>) => (queued.push('gh'), work()),
    },
  );
  const event = { sender: 1 };
  assert.equal((await handlers.get('git:startSource')!(event, '/w/app', '#12')).ok, true);
  assert.equal((await handlers.get('git:fetchPullRequest')!(event, '/w/app', 12)).ok, true);
  assert.deepEqual(windows, [event, event]);
  // one gh call per request; origin's URL and the fetch were not queued
  assert.deepEqual(queued, ['gh', 'gh']);
  assert.equal(calls.length, 5);
  const refused = { ok: false, error: 'Choose a project folder first.' };
  assert.deepEqual(await handlers.get('git:startSource')!(event, 'w/app', '#12'), refused);
  assert.deepEqual(await handlers.get('git:fetchPullRequest')!(event, null, 12), refused);
  assert.equal(calls.length, 5);
});
