// A scripted GitHub CLI for e2e: one open pull request (FAKE_GH_PR_URL) with a failing unit-tests check, as `gh pr view`, `gh search prs`, `gh pr diff|checks` and `gh api` return it (a head's commit statuses as FAKE_GH_GATE_STATUS), `pr view` after FAKE_GH_DELAY_MS when set; every argv is logged to FAKE_GH_LOG.
// Run through the `gh` that fixtures/fakeGh.ts fakeGhBin writes (which sets those variables).
import fs from 'node:fs';

const PR_URL = process.env.FAKE_GH_PR_URL;
const PR = {
  number: 7,
  url: PR_URL,
  title: 'Fix the parser',
  state: 'OPEN',
  isDraft: false,
  headRefOid: 'a1b2c3d4e5f6',
  headRefName: 'fix/parser',
  baseRefName: 'main',
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'BLOCKED',
  additions: 3,
  deletions: 1,
  body: 'Parser fix.',
  author: { login: 'octo' },
  repository: { name: 'demo', nameWithOwner: 'acme/demo' },
  updatedAt: '2026-10-19T10:00:00Z',
  statusCheckRollup: [
    {
      __typename: 'CheckRun',
      name: 'unit-tests',
      status: 'COMPLETED',
      conclusion: 'FAILURE',
      detailsUrl: 'https://github.com/acme/demo/actions/runs/1',
      completedAt: '2026-10-19T10:05:00Z',
    },
  ],
};

// A single test may supply a changing PR snapshot; the default fixture remains deterministic.
if (process.env.FAKE_GH_STATE_FILE) Object.assign(PR, JSON.parse(fs.readFileSync(process.env.FAKE_GH_STATE_FILE, 'utf8')));

/** What `gh <argv>` prints, or null for "not found" (exit 1). */
function answer(argv) {
  const [cmd, sub, target] = argv;
  if (cmd === 'auth') return 'Logged in to github.com account octo';
  if (cmd === 'api' && sub === 'user') return argv.includes('.login') ? 'octo' : JSON.stringify({ login: 'octo' });
  // a head's merge-gate status (src/session/pullRequestReader.ts gateStatus), when a test sets one
  if (cmd === 'api' && /\/commits\/[^/]+\/statuses$/.test(sub ?? '')) return process.env.FAKE_GH_GATE_STATUS ?? 'null';
  // review feedback pages (--paginate --slurp): none
  if (cmd === 'api') return '[[]]';
  if (cmd === 'search' && sub === 'prs') return JSON.stringify(argv.includes('--author=@me') ? [PR] : []);
  if (cmd === 'pr' && sub === 'diff')
    return 'diff --git a/parser.js b/parser.js\n--- a/parser.js\n+++ b/parser.js\n@@ -1 +1 @@\n-old\n+new\n';
  if (cmd === 'pr' && sub === 'checks')
    return JSON.stringify([{ name: 'unit-tests', state: 'FAILURE', link: PR.statusCheckRollup[0].detailsUrl }]);
  if (cmd === 'pr' && sub === 'view') {
    // the current branch has no pull request; a named one (URL or number) is acme/demo#7, named either right after
    // `view` (prGithub.cjs) or after `--` behind the flags (the sidebar's reader, src/session/pullRequestReader.ts)
    const named = argv.includes('--') ? argv[argv.indexOf('--') + 1] : target;
    if (!named || named.startsWith('-')) return null;
    return JSON.stringify(PR);
  }
  return '';
}

{
  const argv = process.argv.slice(2);
  if (process.env.FAKE_GH_LOG) fs.appendFileSync(process.env.FAKE_GH_LOG, `${JSON.stringify(argv)}\n`);
  // a slow GitHub, as on a poor connection: `pr view` answers after FAKE_GH_DELAY_MS
  const delay = Number(process.env.FAKE_GH_DELAY_MS) || 0;
  if (delay && argv[0] === 'pr' && argv[1] === 'view') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
  const out = answer(argv);
  if (out === null) {
    process.stderr.write('no pull requests found for branch "main"\n');
    process.exit(1);
  }
  process.stdout.write(`${out}\n`);
}
