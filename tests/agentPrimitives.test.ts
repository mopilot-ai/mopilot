// Agent labels and run model shared by every harness: lead-verb conjugation (src/lib/conjugate.ts, ported from
// Claude Desktop's agent labels), the harness-neutral AgentRun (src/lib/agentRun.ts) and the label dwell math (src/lib/minDwell.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { conjugateLead } = await import('../src/lib/conjugate.ts');
const { agentRunOf, agentStatus, agentVerb, agentRunningLabel, promptTitle, agentModelName, agentGroupSummary } = await import(
  '../src/lib/agentRun.ts'
);
const { dwellWait } = await import('../src/lib/minDwell.ts');

test('conjugateLead conjugates the description lead verb like Claude Desktop', () => {
  const cases: [string, string, string][] = [
    ['Track A: WebContentsView migration', 'Tracking A: WebContentsView migration', 'Tracked A: WebContentsView migration'],
    ['Run the tests', 'Running the tests', 'Ran the tests'],
    ['Fix the bug and verify', 'Fixing the bug and verifying', 'Fixed the bug and verified'],
    ['Write docs then commit', 'Writing docs then committing', 'Wrote docs then committed'],
    ['Compare outputs', 'Comparing outputs', 'Compared outputs'],
    ['Copy files', 'Copying files', 'Copied files'],
    ['Spawn agents', 'Spawning agents', 'Spawned agents'],
    ['Sync repos', 'Syncing repos', 'Synced repos'],
    ['Stop server', 'Stopping server', 'Stopped server'],
    ['Commit work', 'Committing work', 'Committed work'],
    ['  scan the tree', '  scanning the tree', '  scanned the tree'],
    ['Re-run checks', 'Re-running checks', 'Re-ran checks'],
    ['re-check config', 're-checking config', 're-checked config'],
    ['Submit form', 'Submitting form', 'Submitted form'],
  ];
  for (const [d, running, done] of cases) assert.deepEqual(conjugateLead(d), { running, done }, d);
});

test('conjugateLead leaves descriptions that do not lead with a known bare verb', () => {
  for (const d of [
    '',
    '   ',
    'Browser experience fixes',
    'Ran tests',
    'Tests',
    'API check',
    'Running things',
    'Fixed it',
    'x',
    'Glorp the thing',
    'Re-ran it',
    'Un-fooo it',
    'Re-ran',
  ])
    assert.equal(conjugateLead(d), undefined, d);
  // a re- prefix on a word that is a verb only once prefixed
  assert.deepEqual(conjugateLead('Re-load page'), { running: 'Re-loading page', done: 'Re-loaded page' });
  // a clause after "then" keeps its verb ("then tests pass")
  assert.deepEqual(conjugateLead('Fix it then check is green'), {
    running: 'Fixing it then check is green',
    done: 'Fixed it then check is green',
  });
  // nounish chained words are left
  assert.deepEqual(conjugateLead('Fix and output'), { running: 'Fixing and output', done: 'Fixed and output' });
  // "y" words without vowels and words ending in s/ss/eed
  assert.equal(conjugateLead('Trys it'), undefined);
  assert.deepEqual(conjugateLead('Try it'), { running: 'Trying it', done: 'Tried it' });
  assert.deepEqual(conjugateLead('Pass'), undefined);
});

test('agentRunOf reads an adapter-set run, else derives one from a Codex spawn', () => {
  const run = { key: 'k', description: 'd' };
  assert.equal(agentRunOf({ type: 'collabAgentToolCall', agent: run }), run);
  assert.equal(agentRunOf(null), null);
  assert.equal(agentRunOf('x'), null);
  assert.equal(agentRunOf({ type: 'commandExecution' }), null);
  assert.equal(agentRunOf({ type: 'collabAgentToolCall', tool: 'wait' }), null);
  const spawn = {
    type: 'collabAgentToolCall',
    id: 'c1',
    tool: 'spawnAgent',
    status: 'completed',
    prompt: 'Investigate the flaky test\nmore',
    model: 'gpt-5',
    receiverThreadIds: ['t1'],
    agentsStates: { t1: { status: 'running' } },
  };
  assert.deepEqual(agentRunOf(spawn), {
    key: 't1',
    description: 'Investigate the flaky test',
    prompt: 'Investigate the flaky test\nmore',
    model: 'gpt-5',
    background: false,
    status: 'running',
    toolUses: 0,
    latestTool: null,
    tokens: null,
    startedAt: null,
    completedAt: null,
    report: null,
    transcript: 'full',
  });
  const bare = agentRunOf({ type: 'collabAgentToolCall', id: 'c2', tool: 'spawnAgent', status: 'inProgress', prompt: null, model: 7 })!;
  assert.equal(bare.key, 'c2');
  assert.equal(bare.description, 'Agent');
  assert.equal(bare.model, null);
  assert.equal(bare.status, 'running');
  assert.equal(bare.transcript, 'summary');
  assert.equal(agentRunOf({ type: 'collabAgentToolCall', id: 'c3', tool: 'spawnAgent', status: 'failed' })!.status, 'failed');
});

test('agent status, verbs and labels', () => {
  assert.equal(agentStatus('completed'), 'completed');
  for (const s of ['failed', 'errored', 'notFound', 'declined']) assert.equal(agentStatus(s), 'failed');
  for (const s of ['interrupted', 'shutdown', 'stopped', 'killed']) assert.equal(agentStatus(s), 'stopped');
  for (const s of ['running', 'pendingInit', 'inProgress', undefined]) assert.equal(agentStatus(s), 'running');
  assert.equal(agentVerb('running'), 'Running agent');
  assert.equal(agentVerb('completed'), 'Ran agent');
  assert.equal(agentVerb('stopped'), 'Ran agent');
  assert.equal(agentVerb('failed'), 'Failed to run agent');
  assert.equal(agentRunningLabel({ description: 'Track A: x' }), 'Tracking A: x');
  assert.equal(agentRunningLabel({ description: 'Browser fixes' }), 'Running agent Browser fixes');
  assert.equal(promptTitle(null), '');
  assert.equal(promptTitle('a'.repeat(100)), 'a'.repeat(79) + '…');
});

test('dwellWait holds a label for its minimum and a return to rest for the fall hold', () => {
  const base = { minMs: 650, fallHoldMs: 650, restSince: null };
  assert.equal(dwellWait({ ...base, now: 1000, shownSince: 800, toRest: false }), 450);
  assert.equal(dwellWait({ ...base, now: 2000, shownSince: 800, toRest: false }), 0);
  // going back to rest waits the fall hold from when the target went to rest
  assert.equal(dwellWait({ ...base, now: 2000, shownSince: 800, toRest: true, restSince: 1800 }), 450);
  assert.equal(dwellWait({ ...base, now: 2000, shownSince: 800, toRest: true }), 650);
});

test('agentModelName names Claude models the way Claude Desktop does', () => {
  assert.equal(agentModelName('claude-haiku-5-5'), 'Haiku 5.5');
  assert.equal(agentModelName('claude-opus-5-5[1m]'), 'Opus 5.5');
  assert.equal(agentModelName('claude-sonnet-4-20250514'), 'Sonnet 4');
  assert.equal(agentModelName('claude-fable-5-1'), 'Fable 5.1');
  assert.equal(agentModelName('gpt-6.1-sol'), 'gpt-6.1-sol');
});

test('an agent group is summed up as Claude Desktop words it', () => {
  const run = (status: string) => ({ status }) as any;
  assert.equal(agentGroupSummary([run('completed')], ''), 'Ran an agent');
  assert.equal(agentGroupSummary([run('completed'), run('stopped')], ''), 'Ran 2 agents');
  assert.equal(agentGroupSummary([run('completed'), run('failed'), run('failed')], ''), 'Ran 3 agents (2 failed)');
  assert.equal(agentGroupSummary([run('completed')], 'Edited a file, ran commands'), 'Ran an agent, edited a file, ran commands');
});
