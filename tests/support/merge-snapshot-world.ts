// One pull request's state on GitHub, served both ways the sweep reads it: the REST answers the merge gate reads, and the
// GraphQL page scripts/merge-snapshot.mjs reads, so a test can hold the two paths to the same verdict.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { contexts, posted } from './ciStatuses.ts';

export type Status = { context: string; state: string; description?: string; target_url?: string | null; created_at: string };
export type World = {
  state: string;
  base: string;
  head: string;
  headRef: string;
  title: string;
  body: string;
  labels: string[];
  updatedAt: string;
  // every status the head has had, newest first
  statuses: Status[];
  main: string;
  // every status each main commit has had, newest first
  onMain: Record<string, Status[]>;
};

const gitEnv = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
};

/**
 * A clone whose origin's main has src/a.ts with its test, and whose pull request (refs/pull/1/head on origin) changes
 * it. `advance` adds a commit to main that reaches none of its tests.
 */
export function gitRepo(t: { after: (fn: () => void) => void }) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'merge-snapshot-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const origin = path.join(dir, 'origin.git');
  const work = path.join(dir, 'work');
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: fs.existsSync(work) ? work : dir, env: { ...process.env, ...gitEnv }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const commit = (files: Record<string, string>) => {
    for (const [file, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(work, file)), { recursive: true });
      fs.writeFileSync(path.join(work, file), text);
    }
    git('add', '-A');
    git('commit', '-qm', 'c');
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q', '--bare', '-b', 'main', origin);
  git('clone', '-q', origin, work);
  const base = commit({
    'src/a.ts': 'export const a = 1;\n',
    'tests/a.test.ts': "import { a } from '../src/a';\n",
    'package.json': '{}\n',
  });
  git('push', '-q', 'origin', 'HEAD:main');
  const head = commit({ 'src/a.ts': 'export const a = 2;\n' });
  git('push', '-q', 'origin', 'HEAD:refs/pull/1/head');
  git('checkout', '-q', base);
  let n = 0;
  const advance = () => {
    git('checkout', '-q', git('rev-parse', 'origin/main'));
    const sha = commit({ [`docs/${n++}.md`]: 'x\n' });
    git('push', '-q', 'origin', `${sha}:main`);
    git('fetch', '-q', 'origin');
    return sha;
  };
  return { work, base, head, advance };
}

/** The latest status per context, as the combined status and GraphQL's Status.contexts give it. */
const latest = (statuses: Status[]) => statuses.filter((s, i) => statuses.findIndex((x) => x.context === s.context) === i);

/** The REST answers the merge gate reads, from `world`; every call recorded in `calls`. */
export function restGh(world: () => World) {
  const calls: string[][] = [];
  const gh = (args: string[]) => {
    calls.push(args);
    const w = world();
    const route = args[1];
    if (route === 'repos/o/src/pulls/1')
      return JSON.stringify({
        state: w.state,
        title: w.title,
        body: w.body,
        labels: w.labels.map((name) => ({ name })),
        head: { sha: w.head, ref: w.headRef },
        base: { ref: w.base, repo: { default_branch: 'main' } },
      });
    if (route === 'repos/o/src/git/ref/heads/main') return JSON.stringify({ object: { sha: w.main } });
    // no open draft pull requests (scripts/draft-stack.mjs)
    if (route.startsWith('repos/o/src/pulls?state=open')) return '[]';
    if (route.startsWith('repos/o/src/compare/')) return JSON.stringify({ ahead_by: 2 });
    const history = /^repos\/o\/src\/commits\/(\w+)\/statuses\?per_page=100$/.exec(route)?.[1];
    if (history) return JSON.stringify(posted(history === w.head ? w.statuses : (w.onMain[history] ?? [])));
    const combined = /^repos\/o\/src\/commits\/(\w+)\/status$/.exec(route)?.[1];
    if (combined) return JSON.stringify({ statuses: posted(latest(combined === w.head ? w.statuses : (w.onMain[combined] ?? []))) });
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  return { gh, calls };
}

/** The GraphQL page scripts/merge-snapshot.mjs reads, from `world`: the pull request listed only while it is open. */
export function graphqlGh(world: () => World) {
  return (args: string[]) => {
    assert.deepEqual(args.slice(0, 2), ['api', 'graphql']);
    const w = world();
    const node = {
      number: 1,
      updatedAt: w.updatedAt,
      title: w.title,
      body: w.body,
      headRefName: w.headRef,
      headRefOid: w.head,
      baseRefName: w.base,
      baseRefOid: 'b'.repeat(40),
      labels: { nodes: w.labels.map((name) => ({ name })) },
      commits: {
        nodes: [
          {
            commit: {
              oid: w.head,
              // GraphQL gives a head with no status at all none, not an empty list (tests/fixtures/merge-snapshot-graphql.json)
              status: !w.statuses.length
                ? null
                : {
                    contexts: contexts(
                      latest(w.statuses).map((s) => ({
                        context: s.context,
                        state: s.state.toUpperCase(),
                        description: s.description ?? null,
                        createdAt: s.created_at,
                        targetUrl: s.target_url ?? null,
                      })),
                    ),
                  },
            },
          },
        ],
      },
    };
    return JSON.stringify({
      data: {
        repository: {
          defaultBranchRef: { name: 'main', target: { oid: w.main } },
          pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: w.state === 'open' ? [node] : [] },
        },
      },
    });
  };
}

/** A passing unit-tests status recording the main commit it was tested merged with. */
export const passed = (main: string, at = '2026-10-23T10:00:00Z'): Status => ({
  context: 'unit-tests',
  state: 'success',
  description: `Passed merged with main ${main}: lint ratchet, related unit tests, changed-line coverage`,
  target_url: 'https://ci/run/1',
  created_at: at,
});
