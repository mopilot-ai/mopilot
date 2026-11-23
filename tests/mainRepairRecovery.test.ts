// Keeps repair ownership stable across external claims, moving main and explicit authority renewal without exhausting unstarted work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repairWorld } from './support/main-repair.ts';
import { repairEvidenceWorld, RED, FIX, HEAD } from './support/main-repair-evidence.ts';
import { useFakeClock } from './support/ports/clock.ts';
import { claim, retire } from '../shared/mainRedClaims.mjs';
import { inspectRepair } from '../shared/mainRepairObservations.mjs';
import { RESERVATION_MS } from '../shared/mainRepairClaim.mjs';
const NOW = Date.parse('2026-11-05T00:00:00Z');

test('waiting behind another owner survives more than three sweeps and resumes after release and restart', async (t) => {
  useFakeClock(t, NOW);
  const f = repairWorld();
  claim({ gh: f.hub.gh, repo: 'o/r', issue: 5, claimant: 'other', now: NOW });
  for (let i = 0; i < 5; i++) await f.service.tick();
  assert.equal(f.calls.filter((c) => c[0] === 'prepare').length, 0);
  assert.equal(f.held().claimant, 'other');
  retire({ gh: f.hub.gh, repo: 'o/r', issue: 5, from: f.held().sha, reason: 'owner finished', now: NOW });
  const restarted = f.restart();
  await restarted.tick();
  assert.equal(f.calls.filter((c) => c[0] === 'deliver').length, 1);
  assert.equal(restarted.status('o/r').jobs.length, 1);
  assert.equal(restarted.status('o/r').jobs[0].phase, 'running');
});

test('a newer failing commit on the same issue and suite keeps one active repair', async (t) => {
  useFakeClock(t, NOW);
  const f = repairWorld();
  await f.service.tick();
  const id = f.job().id;
  f.incident.failedSha = 'b'.repeat(40);
  for (let i = 0; i < 4; i++) await f.service.tick();
  assert.equal(Object.keys(f.store.data.jobs).length, 1);
  assert.equal(f.job().id, id);
  assert.equal(f.calls.filter((c) => c[0] === 'deliver').length, 1);
  assert.equal(f.calls.filter((c) => c[0] === 'stop').length, 0);
  f.state.recovered = true;
  f.options.observe = async () => [];
  await f.service.tick();
  assert.equal(f.job().phase, 'complete');
  assert.equal(f.held().state, 'unclaimed');
});

test('old unallocated claim refusals do not prevent recovery with the same stored policy', async (t) => {
  useFakeClock(t, NOW);
  const f = repairWorld();
  f.store.change((d: any) => {
    for (let i = 0; i < 3; i++) {
      const id = `legacy-${i}`;
      d.jobs[id] = {
        ...f.incident,
        id,
        repo: 'o/r',
        phase: 'lost',
        generation: d.policies['o/r'].generation,
        briefId: id,
        createdAt: NOW,
        updatedAt: NOW,
      };
    }
  });
  await f.service.tick();
  assert.equal(f.calls.filter((c) => c[0] === 'prepare').length, 1);
  assert.equal(f.job().phase, 'running');
});

test('an explicit new authority generation can retry exhausted setup without replaying the old generation', async (t) => {
  useFakeClock(t, NOW);
  const f = repairWorld({
    prepare: async () => {
      throw new Error('setup failed');
    },
  });
  for (let i = 0; i < 4; i++) await f.service.tick();
  assert.equal(Object.keys(f.store.data.jobs).length, 3);
  f.service.configure({ ...f.policy, enabled: true });
  f.options.prepare = async () => ({ chatId: 'replacement', cwd: '/new-repair', baseSha: RED });
  await f.service.tick();
  assert.equal(f.job().phase, 'running');
  assert.equal(f.calls.filter((c) => c[0] === 'deliver').length, 1);
});

test('updating the same suite issue to a newer failed SHA does not revoke an owned worker', () => {
  const f = repairEvidenceWorld();
  claim({ gh: f.gh, repo: f.repo, issue: 5, claimant: 'worker', now: NOW });
  f.state.issue.body = `<!-- main-red ${JSON.stringify({ context: 'main-e2e', sha: HEAD, files: ['tests/e2e/a.spec.ts'] })} -->`;
  f.state.statuses[HEAD] = [{ context: 'main-e2e', state: 'failure' }];
  assert.equal(inspectRepair({ ...f.job, gh: f.gh }).superseded, false);
  assert.equal(inspectRepair({ ...f.job, gh: f.gh }).recovered, false);
  f.state.issue.body = `<!-- main-red ${JSON.stringify({ context: 'main-unit-tests', sha: HEAD, files: ['tests/a.test.ts'] })} -->`;
  assert.equal(inspectRepair({ ...f.job, gh: f.gh }).superseded, true);
});

test('an external recovery retires an unmerged repair before allocating a worker', async (t) => {
  useFakeClock(t, NOW);
  const f = repairWorld();
  f.state.superseded = true;
  f.options.observe = async () => [];
  f.store.change((d: any) => {
    d.jobs.waiting = {
      ...f.incident,
      id: 'waiting',
      repo: 'o/r',
      phase: 'reserving',
      generation: d.policies['o/r'].generation,
      briefId: 'waiting',
      createdAt: NOW,
      updatedAt: NOW,
    };
  });
  await f.service.tick();
  assert.equal(f.calls.filter((c) => c[0] === 'prepare').length, 0);
  assert.equal(f.job().phase, 'lost');
  assert.equal(f.held().state, 'unclaimed');
  const evidence = repairEvidenceWorld();
  evidence.state.issue.state = 'closed';
  assert.equal(inspectRepair({ ...evidence.job, gh: evidence.gh }).superseded, true);
  evidence.state.issue.state = 'open';
  evidence.state.statuses[HEAD] = [{ context: 'main-e2e', state: 'success' }];
  assert.equal(inspectRepair({ ...evidence.job, gh: evidence.gh }).superseded, true);
});

test('a later different failure cannot hide matching recovery of the assigned failure behind main', () => {
  const f = repairEvidenceWorld();
  claim({ gh: f.gh, repo: f.repo, issue: 5, claimant: 'worker', pr: 7, now: NOW });
  f.state.pull.merged_at = new Date(NOW).toISOString();
  f.state.issue.body = `<!-- main-red ${JSON.stringify({ context: 'main-e2e', sha: HEAD, files: ['tests/e2e/next.spec.ts'] })} -->`;
  f.state.statuses[HEAD] = [
    { context: 'main-e2e', state: 'failure' },
    { context: 'main-e2e-reverify', state: 'success', description: `Re-ran tests of ${FIX.slice(0, 12)}` },
  ];
  f.state.statuses[FIX] = [
    { context: 'main-e2e-reverify', state: 'success', description: 'Re-ran tests of ffffffffffff' },
    { context: 'main-e2e-reverify', state: 'success', description: `Re-ran tests of ${RED.slice(0, 12)}` },
  ];
  assert.equal(inspectRepair({ ...f.job, gh: f.gh }).recovered, true);
  f.state.statuses[HEAD].unshift({
    context: 'main-e2e-reverify',
    state: 'failure',
    description: `Re-ran tests of ${RED.slice(0, 12)}`,
  });
  assert.equal(inspectRepair({ ...f.job, gh: f.gh }).recovered, false);
});

test('unknown or replaced claims during preallocation never allocate and a readable retry remains usable', async (t) => {
  useFakeClock(t, NOW);
  const f = repairWorld({ inspect: async () => ({ claim: { state: 'unknown' } }) });
  await f.service.tick();
  assert.equal(f.job().phase, 'reserved');
  assert.equal(f.calls.filter((c) => c[0] === 'prepare').length, 0);
  f.options.inspect = async () => ({ claim: f.held() });
  await f.service.tick();
  assert.equal(f.job().phase, 'running');
  const replaced = repairWorld();
  replaced.options.inspect = async () => {
    retire({ gh: replaced.hub.gh, repo: 'o/r', issue: 5, from: replaced.held().sha, reason: 'replaced', now: NOW });
    claim({ gh: replaced.hub.gh, repo: 'o/r', issue: 5, claimant: 'replacement', now: NOW });
    return { claim: replaced.held() };
  };
  await replaced.service.tick();
  assert.equal(replaced.calls.filter((c) => c[0] === 'prepare').length, 0);
  assert.equal(replaced.held().claimant, 'replacement');
});

test('reservation expiry or replacement during either preallocation read fences setup', async (t) => {
  const clock = useFakeClock(t, NOW);
  for (const boundary of ['inspect', 'findPrepared']) {
    const f = repairWorld();
    f.options[boundary] = async () => {
      clock.advance(RESERVATION_MS);
      return boundary === 'inspect' ? { ...f.state, claim: f.held() } : null;
    };
    await f.service.tick();
    assert.equal(f.calls.filter((c) => c[0] === 'prepare').length, 0);
    assert.equal(f.job().phase, 'lost');
  }
  const f = repairWorld();
  f.options.findPrepared = async () => {
    retire({ gh: f.hub.gh, repo: 'o/r', issue: 5, from: f.held().sha, reason: 'replaced', now: clock.now() });
    claim({ gh: f.hub.gh, repo: 'o/r', issue: 5, claimant: 'replacement', now: clock.now() });
    return null;
  };
  await f.service.tick();
  assert.equal(f.calls.filter((c) => c[0] === 'prepare').length, 0);
  assert.equal(f.held().claimant, 'replacement');
});

test('a full green predating the fix cannot mask newer matching verification containing that fix', () => {
  const f = repairEvidenceWorld();
  f.state.pull.merged_at = new Date(NOW).toISOString();
  f.state.statuses[RED] = [{ context: 'main-e2e', state: 'success' }];
  f.state.statuses[HEAD] = [{ context: 'main-e2e-reverify', state: 'success', description: `Re-ran tests of ${RED.slice(0, 12)}` }];
  assert.equal(inspectRepair({ ...f.job, gh: f.gh, pr: 7 }).recovered, true);
  f.state.parents[HEAD] = [RED];
  assert.equal(inspectRepair({ ...f.job, gh: f.gh, pr: 7 }).recovered, false);
});

test('failed setup is durable before release cleanup and retries only cleanup across restart', async (t) => {
  useFakeClock(t, NOW);
  let attempts = 0;
  const f = repairWorld({
    prepare: async () => {
      attempts++;
      throw new Error('setup failed');
    },
  });
  const remote = f.options.remote;
  f.options.remote = async (op: string, args: any) => {
    if (op === 'release') throw new Error('release transport failed');
    return remote(op, args);
  };
  await f.service.tick();
  assert.equal(f.job().phase, 'failed');
  assert.equal(f.job().releasePending, true);
  const restarted = f.restart();
  for (let i = 0; i < 5; i++) await restarted.tick();
  assert.equal(attempts, 1);
  assert.equal(Object.keys(f.store.data.jobs).length, 1);
  // A fresh process with the same durable snapshot can finish cleanup and exhaust only real setup attempts.
  f.options.remote = remote;
  const recovered = f.restart();
  for (let i = 0; i < 4; i++) await recovered.tick();
  assert.equal(attempts, 3);
  assert.equal(recovered.status('o/r').jobs.length, 3);
  assert.equal(f.held().state, 'unclaimed');
});
