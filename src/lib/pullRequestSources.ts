// Where a branch's PR may be besides `origin`'s repository, and the lookups that try each place in turn: the repository the branch is pushed to (a deleted or renamed `origin`, a second remote) still has the PR.
import { repoOfRemote, type PullRequestSource } from './machinePullRequest';

/** One gh run's answer. */
export type GhAnswer = { ok: boolean; stdout: string; stderr?: string };
/** One git run's answer. */
type GitAnswer = { ok: boolean; stdout: string };
/** The runs a checkout's lookup makes in its folder; gh says why it failed. */
export type CheckoutRuns = {
  gh(cwd: string, args: string[]): Promise<GhAnswer & { stderr: string }>;
  git(cwd: string, args: string[]): Promise<GitAnswer>;
};

/** The PRs of a source's own branch `listArgs` reads, newest first: enough that forks' PRs of the same name don't hide it. */
const OWN_LIMIT = 10;

/** `gh pr list`'s arguments for the newest PRs of one repository whose head is the source's branch (one, unless only its own counts). */
export const listArgs = ({ repo, branch, own }: PullRequestSource, fields: string) => [
  'pr',
  'list',
  `--repo=${repo}`,
  `--head=${branch}`,
  '--state=all',
  `--limit=${own ? OWN_LIMIT : 1}`,
  '--json',
  own ? `${fields},isCrossRepository` : fields,
];

/**
 * The first PR `list` (a `gh pr list --json` run) finds in `sources`, tried in order, as gh's stdout of one PR: `null`
 * when every repository that answered has none (or there is none to ask), the first failure when none could answer.
 */
export async function firstPullRequest(
  sources: readonly PullRequestSource[],
  list: (source: PullRequestSource) => Promise<GhAnswer>,
): Promise<GhAnswer> {
  let failure: GhAnswer | null = null;
  let answered = false;
  for (const source of sources) {
    const answer = await list(source);
    if (!answer.ok) {
      failure ??= answer;
      continue;
    }
    const first = (JSON.parse(answer.stdout || '[]') as { isCrossRepository?: unknown }[]).find(
      (pr) => !source.own || pr?.isCrossRepository === false,
    );
    if (first) return { ok: true, stdout: JSON.stringify(first) };
    answered = true;
  }
  return answered || !failure ? { ok: true, stdout: 'null' } : failure;
}

/**
 * The repository a checkout's branch `head` is pushed to and its name there (`branch.<head>.remote` and `.merge`), when
 * that is not `origin`'s repository, which gh already looks in. Null for a branch that tracks nothing or a local branch,
 * for a remote with no GitHub address, and when git cannot say.
 */
export async function pushedSource(head: string, git: (args: string[]) => Promise<GitAnswer>): Promise<PullRequestSource | null> {
  const [tracked, urls] = await Promise.all([
    git(['for-each-ref', '--format=%(upstream:remotename)%00%(upstream:remoteref)', `refs/heads/${head}`]),
    git(['config', '--get-regexp', String.raw`^remote\..*\.url$`]),
  ]);
  if (!tracked.ok || !urls.ok) return null;
  const [name = '', merge = ''] = tracked.stdout.trim().split('\0');
  if (!merge.startsWith('refs/heads/')) return null;
  const remotes = new Map<string, string>();
  for (const line of urls.stdout.split('\n')) {
    const m = /^remote\.(.+)\.url (.+)$/.exec(line.trim());
    if (m) remotes.set(m[1], m[2]);
  }
  const repo = repoOfRemote(remotes.get(name));
  return repo && repo !== repoOfRemote(remotes.get('origin')) ? { repo, branch: merge.slice('refs/heads/'.length), own: true } : null;
}

/**
 * `gh pr view --json <fields>` of the branch checked out in `cwd`: gh's own answer from the folder's remotes, else the
 * newest PR of the repository the branch is pushed to when that is not `origin`'s (a deleted `origin`, a PR in a second
 * remote). gh's own failure stands when there is no such repository or it has no PR for the branch either.
 */
export async function checkoutPullRequest(cwd: string, fields: string, runs: CheckoutRuns): Promise<GhAnswer & { stderr: string }> {
  const own = await runs.gh(cwd, ['pr', 'view', '--json', fields]);
  if (own.ok) return own;
  const git = (args: string[]) => runs.git(cwd, args);
  const head = await git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const pushed = head.ok && head.stdout.trim() ? await pushedSource(head.stdout.trim(), git) : null;
  if (!pushed) return own;
  const found = await firstPullRequest([pushed], (s) => runs.gh(cwd, listArgs(s, fields)));
  return found.ok && found.stdout !== 'null' ? { ...found, stderr: '' } : own;
}
