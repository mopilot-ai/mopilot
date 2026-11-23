// The real MGB entrypoint in routine-rerun mode (#3571, G4): routines are cleared before pass A, pass A's messages end
// with the save message, pass B runs after each graded pass A (not after a turn the driver could not run), a pair that
// fails is logged and the run goes on, and the run writes routine-summary.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('routine-rerun: clear, pass A with the save message, pass B, a failed pair logged, the summary written', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgb-rerun-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const before = { argv: process.argv, token: process.env.MGB_TOKEN };
  process.argv = [
    process.execPath,
    'bench/mgb-run.mjs',
    '--tasks',
    'f1-toy',
    '--columns',
    'codex',
    '--repeats',
    '3',
    '--results',
    dir,
    '--run',
    'g4',
    '--skip-chrome',
    '--routine-rerun',
  ];
  process.env.MGB_TOKEN = 'unit-test-token-123456';
  t.after(() => {
    process.argv = before.argv;
    if (before.token === undefined) delete process.env.MGB_TOKEN;
    else process.env.MGB_TOKEN = before.token;
  });
  const events: any[] = [];
  let turns = 0;
  const task = {
    id: 'f1-toy',
    family: 'F1',
    tier: 'smoke',
    surfaces: ['iab'],
    apps: ['shop'],
    columns: ['codex'],
    data: () => ({}),
    fixtures: () => ({}),
    prompt: () => ['do the task'],
    checkpoints: [{ id: 'done', weight: 1, required: true, check: () => true }],
    forbidden: [],
    cards: { min: 0, max: 0 },
  };
  t.mock.module('../bench/lib/guard.mjs', { namedExports: { requireVm() {} } });
  t.mock.module('../bench/lib/mgb/tasks/index.mjs', { namedExports: { CATALOG: [task] } });
  t.mock.module('../bench/drivers/mgb.mjs', {
    namedExports: {
      CHROME_PROFILE: '/unit/bench-profile',
      expand: (p: string) => p,
      fixtureServer: () => ({ state: async () => ({}) }),
      limitProxy: () => ({}),
      markChrome: async () => [],
      startBenchChrome: () => {},
      setupSources: async () => {},
      collectSources: async () => ({}),
      readLedger: () => [],
      mgbTurn: async (o: any) => {
        events.push(['turn', o.prompts]);
        // the third repeat's turn could not be driven: no pass B for it
        return ++turns === 3
          ? { state: {}, turn: { driverError: true, error: 'no app window' } }
          : { state: {}, turn: { answer: 'ok', approvals: 0 } };
      },
    },
  });
  t.mock.module('../bench/drivers/gui.mjs', { namedExports: { assertBenchChrome: () => [], tidyDesktop: () => [] } });
  t.mock.module('../bench/drivers/mgbDesktop.mjs', { namedExports: { vendorTurn: () => ({}), archiveChat: () => true } });
  t.mock.module('../bench/drivers/record.mjs', { namedExports: { startRecording: () => ({ stop: async () => ({}) }) } });
  t.mock.module('../bench/lib/mgb/apps/index.mjs', { namedExports: { APPS: [{ name: 'shop' }] } });
  t.mock.module('../bench/drivers/mgbRerun.mjs', {
    namedExports: {
      clearInstanceRoutines: async (port: string) => void events.push(['clear', port]),
      routinePassB: async (o: any) => {
        events.push(['passB', o.repeat, o.a.verdict, o.a.prompts]);
        if (o.repeat === 1) throw new Error('pass B lost its window');
        return {
          task: o.task.id,
          column: o.column,
          repeat: o.repeat,
          seed: 's',
          a: { verdict: 'PASS', steps: 10, tokens: 1, saved: true },
          b: { verdict: 'PASS', steps: 2, tokens: 1, runs: 1 },
          ratio: 0.2,
          readRatio: 0.2,
        };
      },
    },
  });
  const logs: string[] = [];
  t.mock.method(console, 'log', (s: string) => void logs.push(s));
  // a template with a query, as benchMgbSetupFailure.test.ts imports it: a fresh module instance, and nothing for typecheck to resolve
  const mode = 'routine-rerun';
  await import(`../bench/mgb-run.mjs?mode=${mode}`);
  assert.deepEqual(
    events.filter((e) => e[0] === 'turn').map((e) => e[1]),
    [1, 2, 3].map((r) => ['do the task', `Save the browser and app steps you just did as a routine named "mgb-f1-toy-codex-r${r}".`]),
  );
  assert.equal(events.filter((e) => e[0] === 'clear').length, 3, 'cleared before every pass A');
  assert.deepEqual(
    events.filter((e) => e[0] === 'passB'),
    [
      ['passB', 0, 'PASS', 1],
      ['passB', 1, 'PASS', 1],
    ],
  );
  assert.ok(logs.some((l) => /"routine":"f1-toy".*"ratio":0.2/.test(l)));
  assert.ok(logs.some((l) => /"routine":"f1-toy".*"error":"pass B lost its window"/.test(l)));
  assert.match(
    fs.readFileSync(path.join(dir, 'g4', 'routine-summary.md'), 'utf8'),
    /^Median model steps of the read-only first message, pass B \/ pass A, on each harness \(target ≤ 0\.5, chosen after seeing the data; was ≤ 0\.3\): all pairs 0\.20 over 1 pair/,
  );
});
