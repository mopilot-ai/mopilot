// Code Review: the pull request lists, a PR's overview/files/checks, and the local-changes review.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { fakeStore, popoverExports, render, click, byText, maybeText, type, press, flush } from './support/pages-kit.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const { createElement: h, Fragment, act } = await import('react');
const calls: any[] = [];
const store = fakeStore<any>({ home: '/home/ada', savedProjects: [], newChatProjectId: null, harness: 'claude' });
type Gh = { ok: boolean; stdout?: string; stderr?: string };
let gh: (args: string[]) => Gh | Promise<Gh> = () => ({ ok: true, stdout: '[]' });
let gitInfo: any = null;
let gitLog: any = '';
let cwd = '/repo/app';
let failChat: any = null;
let failReview: any = null;

stubStore({
  useStore: store.useStore,
  startReview: async (...a: any[]) => {
    calls.push(['startReview', ...a]);
    if (failReview) throw failReview;
  },
  toast: (...a: any[]) => calls.push(['toast', ...a]),
  currentCwdForNewChat: () => cwd,
  navigate: (r: any) => calls.push(['navigate', r]),
  startDefaultChat: async (dir: string, proj: string | null) => {
    calls.push(['startChat', dir, proj]);
    if (failChat) throw failChat;
    return 'chat-1';
  },
  newChatHarness: (s: any) => s.harness,
  sendOrDraft: async (id: string, text: string) => void calls.push(['send', id, text]),
  projectForThread: () => null,
});
installNativeStub({
  git: {
    gh: async (dir: string, args: string[]) => (calls.push(['gh', dir, args.slice(0, 3).join(' ')]), gh(args)),
    info: async (dir: string) => (calls.push(['gitInfo', dir]), typeof gitInfo === 'function' ? gitInfo() : gitInfo),
    run: async (dir: string, args: string[]) => (
      calls.push(['gitRun', dir, args[0]]), typeof gitLog === 'function' ? gitLog() : { stdout: gitLog }
    ),
  },
});
mock.module('../src/session/open.ts', { namedExports: { openLink: (u: string) => calls.push(['open', u]) } });
mock.module('../src/components/markdown/Markdown.tsx', { namedExports: { Markdown: (p: any) => h('div', { 'data-md': true }, p.text) } });
mock.module('../src/components/diff/DiffView.tsx', {
  namedExports: {
    parseUnifiedDiff: (d: string) => d.split(',').map((path) => ({ path })),
    InlineDiff: ({ file }: any) => h('div', { 'data-file': file.path }),
  },
});
mock.module('../src/components/ui/Popover.tsx', { namedExports: popoverExports });
mock.module('../src/lib/format.ts', { namedExports: { relativeTime: (t: number) => `t${t}` } });
const Review = await import('../src/components/pages/Review.tsx');
const { ReviewNav, Review: ReviewPage } = Review;

const pr = (n: number, over: any = {}) => ({
  number: n,
  title: `PR ${n}`,
  url: `https://github.com/o/app/pull/${n}`,
  repository: { nameWithOwner: 'o/app', name: 'App' },
  updatedAt: '1970-01-01T00:00:10Z',
  ...over,
});
const ok = (v: unknown) => ({ ok: true, stdout: typeof v === 'string' ? v : JSON.stringify(v) });
/** Clears the search box (its text lives in module state, shared by the tests). */
const clearQuery = async (host: HTMLElement) => type(host.querySelector('input[placeholder="Search or paste a PR link"]'), '');
const both = () => h(Fragment, null, h(ReviewNav), h(ReviewPage));
const section = (host: HTMLElement, title: string) =>
  [...host.querySelectorAll('.sidebar-section')].find((s) => s.querySelector('.side-label')!.textContent === title)!;
const rows = (host: HTMLElement, title: string) =>
  [...section(host, title).querySelectorAll('.review-pr-row')].map((r) => r.querySelector('.review-pr-title')!.textContent);

/** gh answers by the command it was asked to run. */
function ghBy(answers: Record<string, () => Gh | Promise<Gh>>) {
  return (args: string[]) => {
    const key = Object.keys(answers).find((k) => args.join(' ').includes(k));
    if (!key) throw new Error(`unexpected gh ${args.join(' ')}`);
    return answers[key]();
  };
}

test('the lists load once, show skeletons until then, and filter by title or number', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  gh = ghBy({
    '--author=@me': async () => (await gate, ok([pr(1, { isDraft: true }), pr(22, { title: 'Fix login' })])),
    '-- user-review-requested:@me': () => ok([]),
    '-- review-requested:@me -user-review-requested:@me': () => ({ ok: false, stderr: 'secondary rate limit' }),
  });
  calls.length = 0;
  const searched: string[][] = [];
  const answer = gh;
  gh = (args) => (searched.push(args), answer(args));
  const v = await render(both());
  assert.equal(section(v.host, 'Authored by me').querySelectorAll('.skeleton-row').length, 4);
  await act(async () => release());
  await flush();
  assert.deepEqual(rows(v.host, 'Authored by me'), ['PR 1', 'Fix login']);
  assert.equal(section(v.host, 'Authored by me').querySelector('.review-pr-meta')!.textContent, 'App #1 · t10 · Draft');
  assert.equal(section(v.host, 'Needs my review').querySelector('.empty-note')!.textContent, 'None');
  assert.equal(
    section(v.host, "Needs my team's review").querySelector('.empty-note')!.textContent,
    "Couldn't search: secondary rate limit",
    'a failed team search says so instead of reading as none',
  );
  // gh takes everything after `--` as the query: the flags come first, and the review lists split direct requests
  // from a team's (`team-review-requested` needs a team name; gh rejects @me there)
  const fields = ['--json', 'number,title,url,repository,updatedAt,isDraft,state,author', '--limit', '20'];
  assert.deepEqual(
    searched.map((a) => a.slice(3)),
    [
      [...fields, '--author=@me'],
      [...fields, '--', 'user-review-requested:@me'],
      [...fields, '--', 'review-requested:@me', '-user-review-requested:@me'],
    ],
  );
  const search = v.host.querySelector('input[placeholder="Search or paste a PR link"]')!;
  await type(search, 'LOGIN');
  assert.deepEqual(rows(v.host, 'Authored by me'), ['Fix login']);
  await type(search, '22');
  assert.deepEqual(rows(v.host, 'Authored by me'), ['Fix login']);
  await type(search, '');
  await v.unmount();
  calls.length = 0;
  const again = await render(h(ReviewNav));
  assert.deepEqual(calls, [], 'already loaded: no second search');
  await again.unmount();
});

for (const fails of [false, true])
  test(`an older load of the lists ${fails ? 'failing' : 'answering'} after a newer one started is dropped`, async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let loads = 0;
    gh = (args) => {
      const first = args.includes('--author=@me') && ++loads === 1;
      if (first) return gate.then(() => (fails ? { ok: false, stderr: 'old failure' } : ok([pr(90, { title: 'Old' })])));
      return ok(args.includes('--author=@me') ? [pr(91, { title: 'New' })] : []);
    };
    const v = await render(h(ReviewNav));
    await click(v.host.querySelector('[aria-label="Code review options"]'));
    await click(byText(v.host, 'Refresh'));
    await click(v.host.querySelector('[aria-label="Code review options"]'));
    await click(byText(v.host, 'Refresh'));
    await clearQuery(v.host);
    assert.deepEqual(rows(v.host, 'Authored by me'), ['New']);
    await act(async () => release());
    await flush();
    assert.deepEqual(rows(v.host, 'Authored by me'), ['New']);
    assert.equal(v.host.querySelector('.sidebar-scroll > .empty-note'), null);
    await v.unmount();
  });

test('a failed search shows its first line, and refresh from the menu searches again', async () => {
  gh = () => ({ ok: false, stderr: 'gh: not logged in\nrun gh auth login' });
  const v = await render(h(ReviewNav));
  await click(v.host.querySelector('[aria-label="Code review options"]'));
  await click(byText(v.host, 'Refresh'));
  assert.equal(v.host.querySelector('.sidebar-scroll > .empty-note')!.textContent, 'gh: not logged in');
  gh = () => ({ ok: false, stderr: '' });
  await click(v.host.querySelector('[aria-label="Code review options"]'));
  await click(byText(v.host, 'Refresh'));
  assert.equal(v.host.querySelector('.sidebar-scroll > .empty-note')!.textContent, 'gh failed');
  gh = () => {
    throw 'raw';
  };
  await click(v.host.querySelector('[aria-label="Code review options"]'));
  await click(byText(v.host, 'Refresh'));
  assert.equal(v.host.querySelector('.sidebar-scroll > .empty-note')!.textContent, 'raw');
  await v.unmount();
});

test('a pasted PR link or number opens that PR; anything else does nothing; a lookup failure is toasted', async () => {
  gh = ghBy({
    'search prs': () => ok([pr(5)]),
    'pr view 7 --repo acme/web': () => ok({ number: 7, title: 'Linked', url: 'https://github.com/acme/web/pull/7', updatedAt: '' }),
    'pr view 9 --json': () => ok({ number: 9, title: 'By number', url: 'u9', updatedAt: '' }),
    'pr view 9 --repo': () => ok({ body: '' }),
    'pr view 404': () => ({ ok: false, stderr: 'not found' }),
    'pr view 405': () => {
      throw 'bridge gone';
    },
  });
  await (await render(h(ReviewNav))).unmount();
  const v = await render(both());
  await click(v.host.querySelector('[aria-label="Code review options"]'));
  await click(byText(v.host, 'Refresh'));
  const search = v.host.querySelector('input')!;
  calls.length = 0;
  await type(search, 'nothing here');
  await press(search, 'Enter');
  assert.deepEqual(
    calls.filter((c) => c[0] === 'gh'),
    [],
  );
  await type(search, '#404');
  await press(search, 'Enter');
  assert.deepEqual(calls.at(-1), ['toast', 'not found', 'error']);
  await type(search, '405');
  await press(search, 'Enter');
  assert.deepEqual(calls.at(-1), ['toast', 'bridge gone', 'error']);
  await type(search, ' 9 ');
  await press(search, 'x');
  await press(search, 'Enter');
  assert.equal(v.host.querySelector('.page-title')!.textContent, 'By number');
  await type(search, 'https://github.com/acme/web/pull/7');
  await press(search, 'Enter');
  assert.equal(v.host.querySelector('.page-title')!.textContent, 'Linked');
  assert.match(v.host.querySelector('.auto-meta')!.textContent!, /acme\/web/);
  await click(v.host.querySelector('[aria-label="Code review options"]'));
  await click(byText(v.host, 'Review local changes'));
  assert.ok(v.host.querySelector('.local-review'));
  await v.unmount();
});

test('a PR: overview with info and comments, files and checks tabs load once, and links open', async () => {
  gh = ghBy({
    'search prs': () => ok([pr(3), pr(4)]),
    'pr view 3': () =>
      ok({
        headRefName: 'feat',
        baseRefName: 'main',
        author: { login: 'ada' },
        additions: 5,
        deletions: 2,
        reviewDecision: 'CHANGES_REQUESTED',
        changedFiles: 2,
        body: 'Body text',
        comments: [{ author: { login: 'bob' }, body: 'nit' }, { body: 'anon' }],
      }),
    'pr view 4': () => ({ ok: false, stderr: 'boom' }),
    'pr diff 3': () => ok('a.ts,b.ts'),
    'pr checks 3': () =>
      ok([
        { name: 'unit', state: 'SUCCESS', link: 'https://ci/1' },
        { name: 'lint', state: 'FAILURE', link: '' },
        { name: 'e2e', state: 'PENDING' },
      ]),
  });
  store.setState({ savedProjects: [] });
  const v = await render(both());
  await click(v.host.querySelector('[aria-label="Code review options"]'));
  await click(byText(v.host, 'Refresh'));
  await clearQuery(v.host);
  await click(byText(v.host, 'PR 3', '.review-pr-row'));
  assert.ok(byText(v.host, 'PR 3', '.review-pr-row').className.includes('selected'));
  const meta = v.host.querySelector('.auto-meta')!.textContent!;
  assert.match(meta, /feat → main/);
  assert.match(meta, /@ada/);
  assert.match(meta, /\+5 -2/);
  assert.match(meta, /changes requested/);
  assert.deepEqual(
    [...v.host.querySelectorAll('[data-md]')].map((e) => e.textContent),
    ['Body text', 'nit', 'anon'],
  );
  assert.deepEqual(
    [...v.host.querySelectorAll('.pr-comment-author')].map((e) => e.textContent),
    ['@bob', '@'],
  );
  assert.deepEqual(
    [...v.host.querySelectorAll('.tabs-seg button')].map((b) => b.textContent),
    ['Overview', 'Files 2', 'Checks'],
  );

  await click(byText(v.host, 'Files 2'));
  assert.deepEqual(
    [...v.host.querySelectorAll('[data-file]')].map((e) => e.getAttribute('data-file')),
    ['a.ts', 'b.ts'],
  );
  await click(byText(v.host, 'Checks'));
  const checks = [...v.host.querySelectorAll('.settings-card .settings-row')];
  assert.deepEqual(
    checks.map((c) => c.querySelector('.settings-row-desc')!.textContent),
    ['success', 'failure', 'pending'],
  );
  calls.length = 0;
  for (const c of checks) await click(c);
  await click(byText(v.host, 'Open on GitHub'));
  assert.deepEqual(calls, [
    ['open', 'https://ci/1'],
    ['open', 'https://github.com/o/app/pull/3'],
  ]);
  calls.length = 0;
  await click(byText(v.host, 'Files 2'));
  await click(byText(v.host, 'Checks'));
  assert.deepEqual(
    calls.filter((c) => c[0] === 'gh'),
    [],
    'tabs load once per PR',
  );

  calls.length = 0;
  let views = 0;
  gh = ghBy({
    'pr view 4': () => (++views === 1 ? { ok: false, stderr: 'boom' } : ok({ body: 'Loaded', comments: [], changedFiles: 1 })),
  });
  await click(byText(v.host, 'PR 4', '.review-pr-row'));
  // a failed read says so with a way to try again, instead of a spinner that never stops
  assert.equal(v.host.querySelector('.pr-load-failed span')!.textContent, "Couldn't load the pull request: boom");
  assert.equal(v.host.querySelector('.center-pad'), null);
  assert.deepEqual(
    [...v.host.querySelectorAll('.tabs-seg button')].map((b) => b.textContent),
    ['Overview', 'Files', 'Checks'],
  );
  await click(byText(v.host, 'Retry'));
  assert.equal(v.host.querySelector('.pr-load-failed'), null);
  assert.equal(v.host.querySelector('[data-md]')!.textContent, 'Loaded');
  assert.equal(views, 2);
  await v.unmount();
});

test('a PR without description, comments or decision; spinners while loading; failed diff and checks say so and retry', async () => {
  let releaseDiff!: () => void;
  let releaseChecks!: () => void;
  const diffGate = new Promise<void>((r) => (releaseDiff = r));
  const checksGate = new Promise<void>((r) => (releaseChecks = r));
  let diffs = 0;
  let checkRuns = 0;
  gh = ghBy({
    'search prs': () => ok([pr(6)]),
    'pr view 6': () => ok({ author: null, body: '', comments: [], changedFiles: 0 }),
    'pr diff 6': async () => (++diffs === 1 ? (await diffGate, { ok: false, stderr: 'x' }) : ok('c.ts')),
    'pr checks 6': async () =>
      ++checkRuns === 1
        ? (await checksGate, { ok: false, stderr: 'HTTP 502: Bad Gateway\nretry later' })
        : ok([{ name: 'unit', state: 'SUCCESS' }]),
  });
  const v = await render(both());
  await click(v.host.querySelector('[aria-label="Code review options"]'));
  await click(byText(v.host, 'Refresh'));
  await clearQuery(v.host);
  await click(byText(v.host, 'PR 6', '.review-pr-row'));
  assert.equal(v.host.querySelector('[data-md]')!.textContent, '_No description provided._');
  assert.equal(v.host.querySelector('.task-section-label'), null);
  assert.equal(v.host.querySelector('.status-pill'), null);
  await click(byText(v.host, 'Files 0'));
  assert.ok(v.host.querySelector('.center-pad'));
  // switching away and back while it loads doesn't ask gh again
  await click(byText(v.host, 'Overview'));
  await click(byText(v.host, 'Files 0'));
  assert.equal(diffs, 1);
  await act(async () => releaseDiff());
  await flush();
  assert.equal(v.host.querySelector('.pr-load-failed span')!.textContent, "Couldn't load the changes: x");
  assert.equal(v.host.querySelector('.pr-files'), null, 'a failed diff is not an empty one');
  await click(byText(v.host, 'Retry'));
  assert.deepEqual(
    [...v.host.querySelectorAll('[data-file]')].map((e) => e.getAttribute('data-file')),
    ['c.ts'],
  );
  await click(byText(v.host, 'Checks'));
  assert.ok(v.host.querySelector('.center-pad'));
  await act(async () => releaseChecks());
  await flush();
  assert.equal(v.host.querySelector('.pr-load-failed span')!.textContent, "Couldn't load the checks: HTTP 502: Bad Gateway");
  assert.doesNotMatch(v.host.textContent!, /No checks/, 'a failed check read is not "No checks"');
  await click(byText(v.host, 'Retry'));
  assert.equal(v.host.querySelector('.pr-load-failed'), null);
  assert.deepEqual(
    [...v.host.querySelectorAll('.settings-card .settings-row-title')].map((e) => e.textContent),
    ['unit'],
  );
  await v.unmount();
});

test("a branch without checks reads as No checks: gh's answer for it is an error, but not a failure", async () => {
  gh = ghBy({
    'search prs': () => ok([pr(7)]),
    'pr view 7': () => ok({ body: 'b', comments: [] }),
    'pr checks 7': () => ({ ok: false, stderr: "no checks reported on the 'feat' branch" }),
  });
  const v = await render(both());
  await click(v.host.querySelector('[aria-label="Code review options"]'));
  await click(byText(v.host, 'Refresh'));
  await clearQuery(v.host);
  await click(byText(v.host, 'PR 7', '.review-pr-row'));
  await click(byText(v.host, 'Checks'));
  assert.equal(v.host.querySelector('.settings-card')!.textContent, 'No checks');
  assert.equal(v.host.querySelector('.pr-load-failed'), null);
  await v.unmount();
});

test('an answer for the pull request shown before is dropped', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  gh = ghBy({
    'search prs': () => ok([pr(10), pr(11)]),
    'pr view 10': () => ok({ body: 'ten', comments: [] }),
    'pr view 11': () => ok({ body: 'eleven', comments: [] }),
    'pr checks 10': async () => (await gate, ok([{ name: 'old', state: 'SUCCESS' }])),
    'pr checks 11': () => ok([{ name: 'new', state: 'SUCCESS' }]),
  });
  const v = await render(both());
  await click(v.host.querySelector('[aria-label="Code review options"]'));
  await click(byText(v.host, 'Refresh'));
  await clearQuery(v.host);
  await click(byText(v.host, 'PR 10', '.review-pr-row'));
  await click(byText(v.host, 'Checks'));
  await click(byText(v.host, 'PR 11', '.review-pr-row'));
  await click(byText(v.host, 'Checks'));
  await act(async () => release());
  await flush();
  assert.deepEqual(
    [...v.host.querySelectorAll('.settings-card .settings-row-title')].map((e) => e.textContent),
    ['new'],
  );
  await v.unmount();
});

test('review with the harness: prefers a local checkout of the repo, and toasts a failure', async () => {
  gh = ghBy({ 'search prs': () => ok([pr(8)]), 'pr view 8': () => ok({ body: 'b' }) });
  store.setState({
    harness: 'codex',
    savedProjects: [
      { id: 'p1', roots: [{ path: '/src/other' }] },
      { id: 'p2', roots: [{ path: '/src/APP' }, { path: '/src/x' }] },
    ],
  });
  const v = await render(both());
  await click(v.host.querySelector('[aria-label="Code review options"]'));
  await click(byText(v.host, 'Refresh'));
  await clearQuery(v.host);
  await click(byText(v.host, 'PR 8', '.review-pr-row'));
  assert.doesNotMatch(v.host.querySelector('.pr-actions')!.textContent!, /Codex|Claude/);
  calls.length = 0;
  await click(byText(v.host, 'Review in a new chat'));
  assert.deepEqual(calls.slice(0, 2), [
    ['startChat', '/src/APP', 'p2'],
    ['navigate', { name: 'thread', id: 'chat-1' }],
  ]);
  assert.equal(calls[2][0], 'send');
  assert.match(
    calls[2][2],
    /^Review pull request https:\/\/github\.com\/o\/app\/pull\/8 \(#8 in o\/app\)\. Use `gh pr view 8 --repo o\/app`/,
  );
  await act(async () => store.setState({ savedProjects: [], harness: 'claude' }));
  failChat = new Error('no harness');
  calls.length = 0;
  await click(byText(v.host, 'Review in a new chat'));
  assert.deepEqual(calls, [
    ['startChat', '/repo/app', null],
    ['toast', 'no harness', 'error'],
  ]);
  failChat = 'plain';
  calls.length = 0;
  await click(byText(v.host, 'Review in a new chat'));
  assert.deepEqual(calls.at(-1), ['toast', 'plain', 'error']);
  failChat = null;
  await click(v.host.querySelector('[aria-label="Code review options"]'));
  await click(byText(v.host, 'Review local changes'));
  await v.unmount();
});

test('local review: defaults to main or master, lists recent commits, and starts each kind of review', async () => {
  gh = () => ok([]);
  gitInfo = { branches: ['dev', 'master'] };
  gitLog = 'abc1234567\tFirst\tpart\n\ndef7654321\tSecond\n';
  cwd = '/repo/app';
  const v = await render(h(ReviewPage));
  await flush();
  assert.equal(v.host.querySelector('.sched-empty-sub')!.textContent, 'Pick a pull request on the left, or review local changes in app.');
  const start = byText(v.host, 'Start review') as HTMLButtonElement;
  calls.length = 0;
  await click(start);
  assert.deepEqual(calls, [['startReview', null, { type: 'uncommittedChanges' }]]);

  await click(byText(v.host, 'Against a base branch'));
  const branch = v.host.querySelector('select')!;
  assert.deepEqual(
    [...branch.options].map((o) => o.textContent),
    ['dev', 'master'],
  );
  assert.equal(branch.value, 'master');
  await type(branch, 'dev');
  calls.length = 0;
  await click(start);
  assert.deepEqual(calls, [['startReview', null, { type: 'baseBranch', branch: 'dev' }]]);

  await click(byText(v.host, 'A commit'));
  const commit = v.host.querySelector('select')!;
  assert.deepEqual(
    [...commit.options].map((o) => o.textContent),
    ['abc1234 First\tpart', 'def7654 Second'],
  );
  await type(commit, 'def7654321');
  calls.length = 0;
  await click(start);
  assert.deepEqual(calls, [['startReview', null, { type: 'commit', sha: 'def7654321', title: 'Second' }]]);
  await type(commit, 'gone');
  calls.length = 0;

  await click(byText(v.host, 'Custom instructions'));
  assert.ok(start.disabled);
  await type(v.host.querySelector('textarea'), 'look at auth');
  failReview = new Error('busy');
  calls.length = 0;
  await click(start);
  assert.deepEqual(calls, [
    ['startReview', null, { type: 'custom', instructions: 'look at auth' }],
    ['toast', 'busy', 'error'],
  ]);
  assert.ok(!start.disabled);
  failReview = 'plain';
  await click(start);
  assert.deepEqual(calls.at(-1), ['toast', 'plain', 'error']);
  failReview = null;
  await v.unmount();
});

test('local review: main wins, no git info leaves no branches, and a commit not in the list has no title', async () => {
  gitInfo = { branches: ['main', 'master'] };
  gitLog = '';
  let v = await render(h(ReviewPage));
  await flush();
  await click(byText(v.host, 'Against a base branch'));
  assert.equal(v.host.querySelector('select')!.value, 'main');
  await click(byText(v.host, 'A commit'));
  assert.equal(v.host.querySelector('select')!.options.length, 0);
  calls.length = 0;
  await click(byText(v.host, 'Start review'));
  assert.deepEqual(calls, [['startReview', null, { type: 'commit', sha: '', title: null }]]);
  await v.unmount();

  gitInfo = { branches: ['trunk'] };
  v = await render(h(ReviewPage));
  await flush();
  await click(byText(v.host, 'Against a base branch'));
  assert.equal(v.host.querySelector('select')!.value, 'trunk', 'the select shows the first branch; the state stays main');
  await v.unmount();

  gitInfo = null;
  v = await render(h(ReviewPage));
  await flush();
  await click(byText(v.host, 'Against a base branch'));
  assert.equal(v.host.querySelector('select')!.options.length, 0);
  assert.equal(maybeText(v.host, 'Uncommitted'), v.host.querySelector('.review-option'));
  await v.unmount();
});

test("local review: git answers for a page that's gone are dropped, and a failed read leaves the lists empty", async () => {
  let answerInfo!: (v: unknown) => void;
  let answerLog!: (v: unknown) => void;
  gitInfo = () => new Promise((r) => (answerInfo = r));
  gitLog = () => new Promise((r) => (answerLog = r));
  let v = await render(h(ReviewPage));
  await v.unmount();
  answerInfo({ branches: ['main'] });
  answerLog({ stdout: 'abc\tLate\n' });
  await flush();
  gitInfo = () => Promise.reject(new Error('not a repository'));
  gitLog = () => Promise.reject(new Error('not a repository'));
  v = await render(h(ReviewPage));
  await flush();
  await click(byText(v.host, 'A commit'));
  assert.equal(v.host.querySelector('select')!.options.length, 0);
  await v.unmount();
  gitInfo = null;
  gitLog = '';
});

test('re-exports used elsewhere stay available', () => {
  assert.equal(Review.projectForThread({} as any, {} as any), null);
  assert.equal(typeof Review.MenuSeparator, 'function');
  assert.equal(typeof Review.Tooltip, 'function');
});
