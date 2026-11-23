// Exercises authoritative failure selection, scoped successes, assigned recovery and live CI on moving main history.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observeRepairs, inspectRepair } from '../shared/mainRepairObservations.mjs';
import { mainRepairHistory } from '../shared/mainRepairHistory.mjs';
import { liveRepairWait } from '../shared/mainRepairWait.mjs';
import { claim, readClaim, attach } from '../shared/mainRedClaims.mjs';
import { reserveRepair, bindRepair, heartbeatRepair } from '../shared/mainRepairClaims.mjs';
import { WORKER_LEASE_MS } from '../shared/mainRepairClaim.mjs';
import { repairEvidenceWorld, RED, FIX, HEAD, PRHEAD, NOW } from './support/main-repair-evidence.ts';
import { issueMarker } from '../shared/mainFailure.mjs';

test('only trusted current failures can allocate repairs; a scoped pass cannot hide an older assigned failure', () => {
  const f = repairEvidenceWorld();
  assert.deepEqual(observeRepairs(f), [
    {
      issue: 5,
      context: 'main-e2e',
      failedSha: RED,
      url: `https://github.com/${f.repo}/issues/5`,
      runUrl: `https://github.com/${f.releaseRepo}/actions/runs/8`,
    },
  ]);
  f.state.statuses[RED][0].state = 'error';
  assert.equal(observeRepairs(f).length, 1);
  f.state.statuses[RED][0].state = 'failure';
  f.state.statuses[HEAD] = [{ context: 'main-e2e', state: 'success', description: 'Passed (scoped: 1 file)' }];
  assert.equal(observeRepairs(f).length, 1);
  f.state.statuses[HEAD] = [{ context: 'main-e2e-reverify', state: 'success', description: `Re-ran tests of ${RED.slice(0, 12)}` }];
  assert.deepEqual(observeRepairs(f), []);
  f.state.statuses[HEAD] = [{ context: 'main-e2e', state: 'failure' }];
  assert.deepEqual(observeRepairs(f), []);
  f.state.statuses[HEAD] = [{ context: 'main-e2e', state: 'success' }];
  assert.deepEqual(observeRepairs(f), []);
  f.state.statuses[HEAD] = [];
  f.state.statuses[RED][0].creator = { login: 'stranger' };
  assert.deepEqual(observeRepairs(f), []);
  f.state.open = [
    { ...f.state.issue, labels: [] },
    { ...f.state.issue, number: 0 },
    { ...f.state.issue, title: 'Unrelated issue' },
  ];
  assert.deepEqual(observeRepairs(f), []);
  f.state.open = null;
  f.state.statuses[RED] = [];
  assert.deepEqual(observeRepairs(f), []);
});

test('merge alone and scoped checks cannot complete a worker; matching assigned evidence must contain its fix', () => {
  const f = repairEvidenceWorld();
  claim({ gh: f.gh, repo: f.repo, issue: 5, claimant: 'worker', pr: 7 });
  assert.equal(inspectRepair({ ...f.job, gh: f.gh }).recovered, false);
  f.state.pull.merged_at = new Date(NOW - 1000).toISOString();
  f.state.pull.state = 'closed';
  assert.equal(inspectRepair({ ...f.job, gh: f.gh }).recovered, false);
  f.state.statuses[HEAD] = [{ context: 'main-e2e', state: 'success', description: '(scoped: 1)' }];
  assert.equal(inspectRepair({ ...f.job, gh: f.gh }).recovered, false);
  f.state.statuses[HEAD] = [{ context: 'main-e2e-reverify', state: 'success', description: `Re-ran tests of ${RED.slice(0, 12)}` }];
  assert.equal(inspectRepair({ ...f.job, gh: f.gh }).recovered, true);
  f.state.statuses[HEAD] = [{ context: 'main-e2e-reverify', state: 'success', description: 'of ffffffffffff' }];
  assert.equal(inspectRepair({ ...f.job, gh: f.gh }).recovered, false);
  f.state.statuses[HEAD] = [{ context: 'main-e2e', state: 'success' }];
  assert.equal(inspectRepair({ ...f.job, gh: f.gh }).recovered, true);
  f.state.parents[HEAD] = [RED];
  assert.equal(inspectRepair({ ...f.job, gh: f.gh }).recovered, false);
  f.state.issue.body = '';
  assert.equal(inspectRepair({ ...f.job, gh: f.gh }).superseded, true);
  assert.equal(inspectRepair({ ...f.job, gh: f.gh, context: 'other' }).recovered, false);
});

test('a merged repair keeps a bounded live check after unrelated commits move main and can renew its exact expired lease', () => {
  const f = repairEvidenceWorld(),
    reservation = 'r';
  reserveRepair({ gh: f.gh, repo: f.repo, issue: 5, reservation, coordinator: 'c', now: NOW });
  let current = readClaim({ gh: f.gh, repo: f.repo, issue: 5 }) as any;
  bindRepair({ gh: f.gh, repo: f.repo, issue: 5, reservation, from: current.sha, chatId: 'worker', cwd: '/wt', baseSha: RED, now: NOW });
  attach({ gh: f.gh, repo: f.repo, issue: 5, claimant: 'repair-worker:worker', pr: 7 });
  f.state.pull.merged_at = new Date(NOW).toISOString();
  f.state.statuses[FIX] = [
    { context: 'main-e2e-reverify', state: 'pending', target_url: `https://github.com/${f.releaseRepo}/actions/runs/9` },
  ];
  current = readClaim({ gh: f.gh, repo: f.repo, issue: 5 }) as any;
  assert.equal(liveRepairWait({ gh: f.gh, repo: f.repo, claim: current, context: 'main-e2e', now: NOW }), true);
  assert.equal(
    heartbeatRepair({
      gh: f.gh,
      repo: f.repo,
      issue: 5,
      reservation,
      from: current.sha,
      chatId: 'worker',
      phase: 'verifying',
      context: 'main-e2e',
      now: NOW + WORKER_LEASE_MS,
    }).ok,
    true,
  );
  f.state.run.status = 'completed';
  f.state.run.conclusion = 'failure';
  assert.equal(liveRepairWait({ gh: f.gh, repo: f.repo, claim: current, context: 'main-e2e', now: NOW }), false);
  f.state.pull.merged_at = null;
  f.state.statuses[PRHEAD] = [
    { context: 'unit-tests', state: 'pending', target_url: `https://github.com/${f.releaseRepo}/actions/runs/9` },
  ];
  f.state.run = {
    ...f.state.run,
    status: 'in_progress',
    conclusion: null,
    path: '.github/workflows/pr-unit-tests.yml',
    display_title: 'Unit tests for pull request 7',
  };
  assert.equal(liveRepairWait({ gh: f.gh, repo: f.repo, claim: current, context: 'main-e2e', now: NOW }), true);
});

test('sweep failures require two official failed runs and recovery requires a subsequent successful sweep containing the fix', () => {
  const f = repairEvidenceWorld();
  f.state.issue.title = 'Main is red: sweep';
  f.state.issue.body = '';
  f.state.sweeps = [
    { id: 10, path: '.github/workflows/sweep.yml', conclusion: 'failure', head_sha: RED },
    { id: 9, path: '.github/workflows/sweep.yml', conclusion: 'failure' },
  ];
  assert.equal(observeRepairs(f)[0].context, 'sweep');
  f.state.sweeps[1].conclusion = 'success';
  assert.deepEqual(observeRepairs(f), []);
  claim({ gh: f.gh, repo: f.repo, issue: 5, claimant: 'worker', pr: 7 });
  f.state.pull.merged_at = new Date(NOW).toISOString();
  f.state.sweeps[0] = { ...f.state.sweeps[0], conclusion: 'success', created_at: new Date(NOW + 1000).toISOString() };
  assert.equal(inspectRepair({ ...f.job, gh: f.gh, context: 'sweep' }).recovered, true);
  f.state.sweeps[0].created_at = new Date(NOW - 1000).toISOString();
  assert.equal(inspectRepair({ ...f.job, gh: f.gh, context: 'sweep' }).recovered, false);
  f.state.sweeps = [];
  assert.deepEqual(observeRepairs(f), []);
});

test('unknown, truncated or changing main evidence never grants work or claims recovery', () => {
  const f = repairEvidenceWorld();
  f.state.open = {};
  assert.throws(() => observeRepairs(f), /incomplete/);
  f.state.open = Array(100).fill(f.state.issue);
  assert.throws(() => observeRepairs(f), /incomplete/);
  f.state.open = [f.state.issue];
  f.state.head = 'bad';
  assert.throws(() => observeRepairs(f), /Unreadable main head/);
  f.state.head = HEAD;
  f.state.statuses[HEAD] = Array.from({ length: 100 }, () => ({ context: 'other', state: 'pending' }));
  assert.throws(() => observeRepairs(f), /Incomplete main status/);
  f.state.statuses[HEAD] = [];
  const history = mainRepairHistory(f.gh, f.repo);
  assert.equal(history.latest('main-e2e')?.sha, RED);
  f.state.head = FIX;
  assert.throws(() => history.assertCurrent(), /Main changed/);
  f.state.head = HEAD;
  f.state.parents[HEAD] = ['bad'];
  assert.throws(() => observeRepairs(f), /Unreadable main parent/);
});

test('malformed issue, ancestry and sweep evidence fails closed without inventing a failure', () => {
  const f = repairEvidenceWorld();
  assert.equal(issueMarker(null), null);
  assert.equal(issueMarker('<!-- main-red {bad} -->'), null);
  assert.equal(issueMarker(`<!-- main-red ${JSON.stringify({ context: 'main-e2e', sha: RED, files: null })} -->`)?.files, null);
  f.state.issue.labels = null;
  assert.deepEqual(observeRepairs(f), []);
  f.state.issue.labels = [{ name: 'other' }];
  assert.deepEqual(observeRepairs(f), []);
  f.state.issue.labels = [{ name: 'main-red' }];
  const broken = (args: string[]) =>
    args.includes(`repos/${f.repo}/git/commits/${HEAD}`) ? JSON.stringify({ parents: null }) : f.gh(args);
  assert.throws(() => observeRepairs({ ...f, gh: broken }), /Unreadable main ancestry/);
  f.state.issue.title = 'Main is red: sweep';
  const noRuns = (args: string[]) => (args.some((a) => a.includes('/actions/workflows/sweep.yml/')) ? '{}' : f.gh(args));
  assert.throws(() => observeRepairs({ ...f, gh: noRuns }), /Unreadable sweep/);
  f.state.sweeps = [
    { id: 10, path: '.github/workflows/sweep.yml', conclusion: 'failure', head_sha: 'bad' },
    { path: '.github/workflows/sweep.yml', conclusion: 'failure' },
  ];
  assert.deepEqual(observeRepairs(f), []);
  f.state.sweeps[0].head_sha = RED;
  f.state.sweeps[0].id = '10';
  assert.deepEqual(observeRepairs(f), []);
  f.state.pull.merged_at = new Date(NOW).toISOString();
  f.state.pull.merge_commit_sha = null;
  assert.equal(inspectRepair({ ...f.job, pr: 7, gh: f.gh }).merged, false);
  assert.equal(inspectRepair({ ...f.job, gh: f.gh }).pr, null);
  claim({ gh: f.gh, repo: f.repo, issue: 5, claimant: 'worker' });
  assert.equal(inspectRepair({ ...f.job, pr: 7, gh: f.gh }).pr, 7);
  f.state.issue.title = 'Other';
  assert.equal(inspectRepair({ ...f.job, context: 'sweep', pr: 7, gh: f.gh }).superseded, true);
});

test('live verification is bounded and rejects incomplete or diverged main history', () => {
  const f = repairEvidenceWorld(),
    options = { ...f.job, claim: { pr: 7 }, gh: f.gh };
  assert.equal(liveRepairWait({ ...options, claim: { pr: null } }), false);
  f.state.pull.merged_at = new Date(NOW).toISOString();
  f.state.pull.merge_commit_sha = null;
  assert.equal(liveRepairWait(options), false);
  f.state.pull.merge_commit_sha = FIX;
  f.state.head = 'bad';
  assert.throws(() => liveRepairWait(options), /Unreadable main verification head/);
  f.state.head = HEAD;
  const withHistory = (parents: any) => (args: string[]) => {
    if (args.some((a) => a.includes('/compare/'))) return 'ahead';
    if (args.some((a) => a.includes('/git/commits/'))) return JSON.stringify({ parents });
    return f.gh(args);
  };
  assert.throws(() => liveRepairWait({ ...options, gh: withHistory(null) }), /Unreadable main verification ancestry/);
  assert.throws(() => liveRepairWait({ ...options, gh: withHistory([{ sha: 'bad' }]) }), /Unreadable main verification parent/);
  assert.equal(liveRepairWait({ ...options, gh: withHistory([]) }), false);
  assert.equal(liveRepairWait({ ...options, gh: withHistory([{ sha: HEAD }]) }), false);
  f.state.parents[HEAD] = [RED];
  assert.equal(liveRepairWait(options), false);
});
