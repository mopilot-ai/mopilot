// The 12-Grid Bench's routine-rerun mode (#3571, G4; bench/lib/mgb/routineRerun.mjs and its flags in run.mjs): the
// routine's name and save message, pass A's window without the save message, the routine tools' use read from the
// operation log, each pair's share of steps, the run's median on each harness against the ≤0.5 target with no column's pass rate lower,
// the summary table, and clearing an instance's routines through its window's bridge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toy } from './support/mgb-toy-task.ts';

const R = await import('../bench/lib/mgb/routineRerun.mjs');
const { parseMgbArgs } = await import('../bench/lib/mgb/run.mjs');

const catalog = [toy()];

test('flags: --routine-rerun and --rerun-seed; MoPilot columns only, and a rerun seed needs the mode', () => {
  const off = parseMgbArgs([], catalog);
  assert.equal(off.routineRerun, false);
  assert.equal(off.rerunSeed, null);
  const on = parseMgbArgs(['--routine-rerun', '--rerun-seed', 'g4-new'], catalog);
  assert.equal(on.routineRerun, true);
  assert.equal(on.rerunSeed, 'g4-new');
  assert.throws(() => parseMgbArgs(['--routine-rerun', '--arm', 'desk-claude'], catalog), /MoPilot columns only/);
  assert.throws(() => parseMgbArgs(['--rerun-seed', 'x'], catalog), /needs --routine-rerun/);
});

test('names and messages: one routine per task, column and repeat; the save message names it', () => {
  assert.equal(R.routineName('f1-refund-requests', 'codex', 1), 'mgb-f1-refund-requests-codex-r2');
  assert.equal(R.savePrompt('mgb-x'), 'Save the browser and app steps you just did as a routine named "mgb-x".');
});

test("taskWindow: from the turn's start to the end of its last task message, else the turn's end", () => {
  const turn = { startedAt: 10, endedAt: 90, phases: [{ endedAt: 40 }, { endedAt: 80 }] };
  assert.deepEqual(R.taskWindow(turn, 1), { from: 10, to: 40 });
  assert.deepEqual(R.taskWindow({ ...turn, phases: [] }, 1), { from: 10, to: 90 });
  assert.deepEqual(R.taskWindow({}, 1), { from: 0, to: 0 });
});

test('routineCalls: a saved routine and the runs that went through, in the window only', () => {
  const lines = [
    { at: 5, tool: 'routine_save', outcome: 'ok' },
    { at: 15, tool: 'routine_save', outcome: 'exists' },
    { at: 20, tool: 'routine_run', outcome: 'ok' },
    { at: 21, tool: 'routine_run', outcome: 'aborted' },
    { at: 22, tool: 'browser_navigate', outcome: 'ok' },
    { tool: 'routine_run', outcome: 'ok' },
    null,
  ];
  assert.deepEqual(R.routineCalls(lines, { from: 10, to: 30 }), { saved: false, runs: 1 });
  assert.deepEqual(R.routineCalls(lines, { from: 0, to: 30 }), { saved: true, runs: 1 });
});

test('rerunRecord: the first messages share too; passBFiles keeps why B passed or failed and the state it was graded on', () => {
  const a = { verdict: 'PASS', steps: 20, readSteps: 10, tokens: 100, saved: true };
  const b = { verdict: 'PASS', steps: 8, readSteps: 3, tokens: 10, runs: 2, violations: 0 };
  assert.equal(R.rerunRecord({ task: 't', column: 'c', repeat: 1, seed: 's', a, b }).readRatio, 0.3);
  assert.equal(R.rerunRecord({ task: 't', column: 'c', repeat: 1, seed: 's', a: { ...a, readSteps: 0 }, b }).readRatio, null);
  assert.equal(R.rerunRecord({ task: 't', column: 'c', repeat: 1, seed: 's', a, b: { ...b, readSteps: null } }).readRatio, null);
  assert.equal(R.rerunRecord({ task: 't', column: 'c', repeat: 1, seed: 's', a, b: null }).readRatio, null);
  const grade = {
    verdict: 'FAIL',
    score: 0.5,
    why: ['no issue'],
    checkpoints: [{ id: 'x', met: false }],
    violations: [],
    control: null,
    extra: 1,
  };
  const [[recordName, record], [stateName, state]] = R.passBFiles('f1-x.r2', {
    grade,
    state: { mail: [] },
    usage: { requests: 4 },
    runs: 1,
  });
  assert.equal(recordName, 'f1-x.r2.b.json');
  assert.deepEqual(JSON.parse(record), {
    verdict: 'FAIL',
    score: 0.5,
    why: ['no issue'],
    checkpoints: [{ id: 'x', met: false }],
    violations: [],
    control: null,
    usage: { requests: 4 },
    runs: 1,
  });
  assert.equal(stateName, 'f1-x.r2.b.state.json');
  assert.deepEqual(JSON.parse(state), { mail: [] });
});

test('rerunRecord: B over A; none without a pass B or with nothing to compare', () => {
  const a = { verdict: 'PASS', steps: 20, tokens: 100, saved: true };
  assert.equal(
    R.rerunRecord({ task: 't', column: 'c', repeat: 1, seed: 's', a, b: { verdict: 'PASS', steps: 4, tokens: 10, runs: 1 } }).ratio,
    0.2,
  );
  assert.equal(R.rerunRecord({ task: 't', column: 'c', repeat: 1, seed: 's', a, b: null }).ratio, null);
  assert.equal(
    R.rerunRecord({
      task: 't',
      column: 'c',
      repeat: 1,
      seed: 's',
      a: { ...a, steps: 0 },
      b: { verdict: 'PASS', steps: 1, tokens: 1, runs: 1 },
    }).ratio,
    null,
  );
  assert.equal(
    R.rerunRecord({ task: 't', column: 'c', repeat: 1, seed: 's', a, b: { verdict: 'PASS', steps: null, tokens: null, runs: 0 } }).ratio,
    null,
  );
});

test('rerunSummary and rerunTable: the median share over the pairs that saved, pass rates per column, the target', () => {
  const pair = (column: string, ratio: number | null, aPass = true, bPass = true, saved = true, violations = 0) => ({
    task: 't',
    column,
    repeat: 1,
    seed: 's',
    a: { verdict: aPass ? 'PASS' : 'FAIL', steps: 10, tokens: 1, saved },
    b: ratio === null ? null : { verdict: bPass ? 'PASS' : 'FAIL', steps: ratio * 10, tokens: 1, runs: 1, violations },
    ratio,
    // the first message's share is what the target reads; the whole task's stays beside it
    readRatio: ratio,
  });
  const met = R.rerunSummary([
    pair('claude', 0.2),
    pair('claude', 0.3),
    pair('codex', 0.1),
    pair('codex', null, false),
    pair('acp', 0.9, true, true, false),
  ]);
  assert.equal(met.pairs, 3, 'a failed A and one that did not save are left out of the median');
  assert.equal(met.ratio, 0.2);
  assert.equal(met.met, true);
  assert.deepEqual(met.columns.codex, { a: 1, b: 1, n: 2, pairs: 1, readRatio: 0.1, met: true });
  assert.match(
    R.rerunTable(met),
    /^Median model steps of the read-only first message, pass B \/ pass A, on each harness \(target ≤ 0\.5, chosen after seeing the data; was ≤ 0\.3\): all pairs 0\.20 over 3 pair\(s\)\. Forbidden actions in pass B: 0\. Target met\.\nWhole task, for reference: 0\.20\./,
  );
  assert.match(R.rerunTable(met), /\| claude \| 2 \| 100% \| 100% \| 0\.25 over 2 \| met \|/);
  assert.match(R.rerunTable(met), /\| acp \| 1 \| 100% \| 100% \| n\/a over 0 \| no pair \|/);
  // a column whose pass B passes less often misses the target, whatever the steps
  const worse = R.rerunSummary([pair('claude', 0.1), pair('claude', 0.1, true, false)]);
  assert.equal(worse.ratio, 0.1);
  assert.equal(worse.met, false);
  assert.match(R.rerunTable(worse), /Target not met/);
  // a forbidden action in pass B misses it, whatever the steps
  const wrong = R.rerunSummary([pair('claude', 0.1, true, true, true, 1)]);
  assert.equal(wrong.violations, 1);
  assert.equal(wrong.met, false);
  // the target reads the first message: a whole task over it still meets it, and a pair without one doesn't count
  assert.equal(R.rerunSummary([{ ...pair('claude', 0.9), readRatio: 0.2 }]).met, true);
  assert.equal(R.rerunSummary([{ ...pair('claude', 0.1), readRatio: null }]).met, false);
  // too many steps misses it too; none at all says n/a
  assert.equal(R.rerunSummary([pair('claude', 0.6)]).met, false);
  // the bar is 0.5 itself, not 0.3: 0.5 meets it and 0.55 doesn't
  assert.equal(R.rerunSummary([pair('claude', 0.5)]).met, true);
  assert.equal(R.rerunSummary([pair('claude', 0.55)]).met, false);
  const none = R.rerunSummary([]);
  assert.deepEqual(none, {
    pairs: 0,
    ratio: null,
    readRatio: null,
    heavy: { pairs: 0, readRatio: null },
    violations: 0,
    columns: {},
    met: false,
  });
  // each harness has to meet the bar itself: one that does can't carry one that doesn't (G4 today: Claude 0.41, Codex 0.55)
  const split = R.rerunSummary([pair('claude', 0.4), pair('claude', 0.45), pair('codex', 0.55), pair('codex', 0.6), pair('codex', 0.5)]);
  assert.equal(split.readRatio, 0.5, 'all pairs together would sit at the bar');
  assert.equal(split.columns.claude.met, true);
  assert.equal(split.columns.codex.met, false);
  assert.equal(split.columns.codex.readRatio, 0.55);
  assert.equal(split.met, false);
  assert.match(R.rerunTable(split), /\| codex \| 3 \| 100% \| 100% \| 0\.55 over 3 \| not met \|/);
  // a column with no pair to measure doesn't stop another from meeting it, and a lower B pass rate in any column does
  const alone = R.rerunSummary([pair('claude', 0.4), pair('codex', null, false)]);
  assert.equal(alone.met, true);
  assert.equal(R.rerunSummary([pair('claude', 0.4), pair('codex', 0.1, true, false)]).met, false);
  // read-heavy pairs are reported on their own, and don't change what the target reads
  const mixed = R.rerunSummary([
    { ...pair('claude', 0.5), a: { ...pair('claude', 0.5).a, readSteps: 7 }, readRatio: 0.5 },
    { ...pair('claude', 0.2), a: { ...pair('claude', 0.2).a, readSteps: 10 }, readRatio: 0.2 },
    { ...pair('claude', 0.1), a: { ...pair('claude', 0.1).a, readSteps: 19 }, readRatio: null },
  ]);
  assert.deepEqual(mixed.heavy, { pairs: 1, readRatio: 0.2 });
  assert.equal(mixed.readRatio, 0.35);
  // 0.35 is under the bar (0.5), as it wasn't under 0.3: the read-heavy subset doesn't change what the target reads
  assert.equal(mixed.met, true);
  assert.match(R.rerunTable(mixed), /first message took 10 steps or more: 0\.20 over 1 pair\(s\)/);
  assert.match(R.rerunTable(none), /first message took 10 steps or more: n\/a over 0 pair/);
  assert.match(R.rerunTable(none), /all pairs n\/a over 0 pair/);
  assert.match(
    R.rerunTable(R.rerunSummary([{ ...pair('acp', 0), a: { verdict: 'FAIL', steps: 0, tokens: 0, saved: false }, b: null, ratio: null }])),
    /\| acp \| 1 \| 0% \| 0% \|/,
  );
});

test('clearRoutines: every routine removed through the window bridge; an answer that is not one throws', async () => {
  const seen: string[] = [];
  assert.equal(await R.clearRoutines(async (js: string) => (seen.push(js), { removed: 3 })), 3);
  assert.match(seen[0], /window\.native\.routines\.list\(\)/);
  assert.match(seen[0], /window\.native\.routines\.remove\(x\.id\)/);
  await assert.rejects(
    R.clearRoutines(async () => ({ error: "Routines aren't ready yet" })),
    /couldn't clear the routines: Routines aren't ready yet/,
  );
  await assert.rejects(
    R.clearRoutines(async () => undefined),
    /no answer/,
  );
});

test('rerunSummary: a pair with no first-message share, or no step count for it, is left out of the target and the read-heavy subset', () => {
  const base = {
    task: 't',
    column: 'claude',
    repeat: 1,
    seed: 's',
    a: { verdict: 'PASS', steps: 10, tokens: 1, saved: true },
    b: { verdict: 'PASS', steps: 4, tokens: 1, runs: 1, violations: 0 },
    ratio: 0.4,
  };
  // no share for the first message: it doesn't count, so the column has no pair and the run has nothing to meet
  const unread = R.rerunSummary([{ ...base, readRatio: null }]);
  assert.equal(unread.columns.claude.pairs, 0);
  assert.equal(unread.columns.claude.readRatio, null);
  assert.equal(unread.met, false);
  assert.match(R.rerunTable(unread), /\| claude \| 1 \| 100% \| 100% \| n\/a over 0 \| no pair \|/);
  // a share but no step count for pass A's first message: it counts for the target, not as read-heavy
  const uncounted = R.rerunSummary([
    { ...base, readRatio: 0.4 },
    { ...base, a: { ...base.a, readSteps: 12 }, readRatio: 0.2 },
  ]);
  assert.equal(uncounted.columns.claude.pairs, 2);
  assert.deepEqual(uncounted.heavy, { pairs: 1, readRatio: 0.2 });
  assert.equal(uncounted.met, true);
  // and a harness that has a pair meets the bar by that pair alone
  assert.match(R.rerunTable(uncounted), /\| claude \| 2 \| 100% \| 100% \| 0\.30 over 2 \| met \|/);
});
