// Where a branch's PR may be besides origin's repository (src/lib/pullRequestSources.ts): the first repository with one wins, and a local branch's pushed repository is read from its git config.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkoutPullRequest, firstPullRequest, pushedSource } from '../src/lib/pullRequestSources.ts';

const PR = { url: 'https://github.com/o/internal/pull/7', state: 'MERGED', isCrossRepository: false };
const ok = (stdout: string) => ({ ok: true, stdout });
const failed = { ok: false, stdout: '', stderr: "GraphQL: Could not resolve to a Repository with the name 'o/deleted'." };
const ORIGIN = { repo: 'github.com/o/deleted', branch: 'feat' };
const PUSHED = { repo: 'github.com/o/internal', branch: 'feat' };

test('a repository that cannot be read, or has no PR for the branch, passes to the next, and the first PR found is the answer', async () => {
  const asked: string[] = [];
  const answers: Record<string, ReturnType<typeof ok> | typeof failed> = { [ORIGIN.repo]: failed, [PUSHED.repo]: ok(JSON.stringify([PR])) };
  const list = async (s: typeof ORIGIN) => (asked.push(s.repo), answers[s.repo]);
  assert.deepEqual(await firstPullRequest([ORIGIN, PUSHED], list), ok(JSON.stringify(PR)));
  answers[ORIGIN.repo] = ok('[]');
  assert.deepEqual(await firstPullRequest([ORIGIN, PUSHED], list), ok(JSON.stringify(PR)));
  // the first repository's PR ends the search
  asked.length = 0;
  answers[ORIGIN.repo] = ok(JSON.stringify([{ ...PR, url: 'https://github.com/o/deleted/pull/1' }]));
  assert.equal(JSON.parse((await firstPullRequest([ORIGIN, PUSHED], list)).stdout).url, 'https://github.com/o/deleted/pull/1');
  assert.deepEqual(asked, [ORIGIN.repo]);
});

test('no PR anywhere is null, unless no repository could answer, which is the first failure', async () => {
  assert.deepEqual(await firstPullRequest([], async () => failed), ok('null'));
  assert.deepEqual(await firstPullRequest([ORIGIN, PUSHED], async (s) => (s === ORIGIN ? failed : ok(''))), ok('null'));
  assert.deepEqual(await firstPullRequest([ORIGIN, PUSHED], async (s) => (s === ORIGIN ? ok('[]') : failed)), ok('null'));
  const second = { ...failed, stderr: 'second' };
  assert.deepEqual(await firstPullRequest([ORIGIN, PUSHED], async (s) => (s === ORIGIN ? failed : second)), failed);
});

const urls =
  'remote.origin.url https://github.com/o/deleted.git\nremote.my.fork.url git@github.com:me/internal.git\nremote.mirror.url /srv/mirror.git\n';
const git =
  (tracked: { ok: boolean; stdout: string }, config = ok(urls)) =>
  async (args: string[]) =>
    args[0] === 'for-each-ref' ? tracked : config;

test('a local branch pushed to another remote names that repository and its branch there', async () => {
  const asked: string[][] = [];
  const run = git(ok('my.fork\0refs/heads/feat-up\n'));
  assert.deepEqual(await pushedSource('feat', async (args) => (asked.push(args), run(args))), {
    repo: 'github.com/me/internal',
    branch: 'feat-up',
    own: true,
  });
  assert.deepEqual(asked[0], ['for-each-ref', '--format=%(upstream:remotename)%00%(upstream:remoteref)', 'refs/heads/feat']);
});

test("a branch pushed to origin's repository, a local branch, an untracked branch, an address naming no repository, or a git that cannot say adds nowhere", async () => {
  for (const [tracked, config] of [
    [ok('origin\0refs/heads/feat\n'), ok(urls)],
    [ok('.\0refs/heads/main\n'), ok(urls)],
    [ok('\n'), ok(urls)],
    [ok('mirror\0refs/heads/feat\n'), ok(urls)],
    [ok('gone\0refs/heads/feat\n'), ok(urls)],
    [{ ok: false, stdout: '' }, ok(urls)],
    [ok('my.fork\0refs/heads/feat\n'), { ok: false, stdout: '' }],
  ] as const)
    assert.equal(await pushedSource('feat', git(tracked, config)), null, tracked.stdout);
});

const VIEW_FAILED = { ok: false, stdout: '', stderr: "GraphQL: Could not resolve to a Repository with the name 'o/deleted'." };
const checkoutRuns = (gh: (args: string[]) => typeof VIEW_FAILED, git: (args: string[]) => { ok: boolean; stdout: string }) => {
  const asked: string[][] = [];
  return {
    asked,
    runs: {
      gh: async (_cwd: string, args: string[]) => (asked.push(['gh', ...args]), gh(args)),
      git: async (_cwd: string, args: string[]) => (asked.push(['git', ...args]), git(args)),
    },
  };
};
const pushedGit = (head: { ok: boolean; stdout: string }) => (args: string[]) =>
  args[0] === 'symbolic-ref' ? head : args[0] === 'for-each-ref' ? ok('my.fork\0refs/heads/feat\n') : ok(urls);

test("a checkout's own gh answer stands without reading git; one gh cannot give is looked for where the branch is pushed", async () => {
  const own = checkoutRuns(
    () => ({ ok: true, stdout: JSON.stringify(PR), stderr: '' }),
    () => ok(''),
  );
  assert.deepEqual(await checkoutPullRequest('/w', 'url,state', own.runs), { ok: true, stdout: JSON.stringify(PR), stderr: '' });
  assert.deepEqual(own.asked, [['gh', 'pr', 'view', '--json', 'url,state']]);
  const pushed = checkoutRuns(
    (args) => (args[1] === 'view' ? VIEW_FAILED : { ok: true, stdout: JSON.stringify([PR]), stderr: '' }),
    pushedGit(ok('feat\n')),
  );
  assert.deepEqual(await checkoutPullRequest('/w', 'url,state', pushed.runs), { ok: true, stdout: JSON.stringify(PR), stderr: '' });
  assert.deepEqual(pushed.asked.at(-1), [
    'gh',
    'pr',
    'list',
    '--repo=github.com/me/internal',
    '--head=feat',
    '--state=all',
    '--limit=10',
    '--json',
    'url,state,isCrossRepository',
  ]);
});

test("where the branch was pushed, only a PR of that repository's own branch counts: a fork's PR of the same name is someone else's", async () => {
  const FORK = { url: 'https://github.com/o/internal/pull/8', state: 'OPEN', isCrossRepository: true };
  const own = { ...PUSHED, own: true as const };
  const list = (prs: unknown[]) => async () => ok(JSON.stringify(prs));
  // a fork's PR of `main` in a public repository is no PR of this checkout's main
  assert.deepEqual(await firstPullRequest([own], list([FORK])), ok('null'));
  assert.deepEqual(await firstPullRequest([own], list([FORK, { url: 'x' }, PR])), ok(JSON.stringify(PR)));
  // origin's repository keeps gh's newest answer, as before
  assert.deepEqual(await firstPullRequest([ORIGIN], list([FORK])), ok(JSON.stringify(FORK)));
  const { runs } = checkoutRuns(
    (args) => (args[1] === 'view' ? VIEW_FAILED : { ok: true, stdout: JSON.stringify([FORK]), stderr: '' }),
    pushedGit(ok('main\n')),
  );
  assert.deepEqual(await checkoutPullRequest('/w', 'url,state', runs), VIEW_FAILED);
});

test("gh's own failure stands for a detached checkout, a branch pushed nowhere else, and a pushed repository with no PR or no answer", async () => {
  for (const [head, list] of [
    [{ ok: false, stdout: '' }, ok('[]')],
    [ok('\n'), ok('[]')],
    [ok('feat\n'), ok('[]')],
    [ok('feat\n'), VIEW_FAILED],
  ] as const) {
    const { runs } = checkoutRuns((args) => (args[1] === 'view' ? VIEW_FAILED : { stderr: '', ...list }), pushedGit(head));
    assert.deepEqual(await checkoutPullRequest('/w', 'url,state', runs), VIEW_FAILED, JSON.stringify([head, list]));
  }
  const { runs } = checkoutRuns(
    () => VIEW_FAILED,
    (args) => (args[0] === 'symbolic-ref' ? ok('feat\n') : ok('origin\0refs/heads/feat\n')),
  );
  assert.deepEqual(await checkoutPullRequest('/w', 'url,state', runs), VIEW_FAILED);
});
