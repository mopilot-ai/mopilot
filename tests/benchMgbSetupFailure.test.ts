// The real MGB entrypoint records setup failures as UNGRADABLE, skips the model and retries the next planned task.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const run = async (
  t: any,
  failure: 'chrome-preflight' | 'start' | 'mark' | 'tidy' | 'shortfall' | 'dirty' | 'sources' | 'none',
  arm = 'mopilot',
  skip = false,
  na = false,
) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgb-setup-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const before = { argv: process.argv, token: process.env.MGB_TOKEN };
  process.argv = [
    process.execPath,
    'bench/mgb-run.mjs',
    '--tasks',
    'test-browser',
    '--columns',
    'codex',
    '--repeats',
    '2',
    '--results',
    dir,
    '--run',
    'case',
    '--arm',
    arm,
    ...(skip ? ['--skip-chrome'] : []),
  ];
  process.env.MGB_TOKEN = 'unit-test-token-123456';
  t.after(() => {
    process.argv = before.argv;
    if (before.token === undefined) delete process.env.MGB_TOKEN;
    else process.env.MGB_TOKEN = before.token;
  });
  const seen: string[] = [];
  let failed = false;
  const step = (name: string) => {
    seen.push(name);
    if (failure === name && !failed) {
      failed = true;
      throw new Error(`setup ${name} failure`);
    }
  };
  const task = {
    id: 'test-browser',
    family: na ? 'F8' : 'F3',
    tier: 'smoke',
    surfaces: skip ? ['iab'] : ['bu'],
    apps: ['account'],
    columns: ['codex'],
    data: () => ({}),
    fixtures: () => ({}),
    prompt: () => ['unit fixture'],
    checkpoints: [{ id: 'done', weight: 1, required: true, check: () => true }],
    forbidden: [],
    cards: { min: 0, max: 0 },
  };
  const turn = () => {
    step('turn');
    return { answer: 'unit fixture', approvals: 0, setup: { permission: arm === 'desk-claude' ? 'auto' : 'never/danger-full-access' } };
  };
  t.mock.module('../bench/lib/guard.mjs', { namedExports: { requireVm() {} } });
  t.mock.module('../bench/lib/mgb/tasks/index.mjs', { namedExports: { CATALOG: [task] } });
  t.mock.module('../bench/drivers/mgb.mjs', {
    namedExports: {
      CHROME_PROFILE: '/unit/bench-profile',
      expand: (p: string) => p,
      fixtureServer: () => ({ state: async () => ({}) }),
      limitProxy: () => ({}),
      markChrome: async () => {
        step('mark');
        if (failure === 'shortfall' && !failed) {
          failed = true;
          return [];
        }
        return ['account'];
      },
      startBenchChrome: () => step('start'),
      setupSources: async () => step('sources'),
      collectSources: async () => ({}),
      readLedger: () => {
        throw new Error('no model turn has ledger times');
      },
      mgbTurn: async () => ({ state: {}, turn: turn() }),
    },
  });
  t.mock.module('../bench/drivers/gui.mjs', {
    namedExports: {
      assertBenchChrome: () => step('chrome-preflight'),
      tidyDesktop: (...args: unknown[]) => {
        assert.deepEqual(args, [skip ? '' : '/unit/bench-profile']);
        step('tidy');
        if (failure === 'dirty' && !failed) {
          failed = true;
          return ['leftover window'];
        }
        return [];
      },
    },
  });
  t.mock.module('../bench/drivers/mgbDesktop.mjs', { namedExports: { vendorTurn: turn, archiveChat: () => true } });
  t.mock.module('../bench/drivers/record.mjs', {
    namedExports: {
      startRecording: () => {
        step('record');
        return {
          stop: async () => {
            step('stop');
            return {};
          },
        };
      },
    },
  });
  t.mock.module('../bench/lib/mgb/apps/index.mjs', { namedExports: { APPS: [{ name: 'account' }] } });
  await import(`../bench/mgb-run.mjs?setup=${failure}-${arm}-${skip}-${na}`);
  const column = arm === 'mopilot' ? 'codex' : arm;
  const read = (suffix: string) => JSON.parse(fs.readFileSync(path.join(dir, 'case', column, `test-browser${suffix}.json`), 'utf8'));
  return { seen, dir, read };
};

for (const failure of ['chrome-preflight', 'start', 'mark', 'tidy'] as const) {
  test(`${failure} failure is UNGRADABLE with no model or recording, and the next task retries`, async (t) => {
    const r = await run(t, failure);
    const first = r.read('');
    assert.equal(first.verdict, 'UNGRADABLE');
    assert.match(first.turn.error, new RegExp(`setup ${failure} failure`));
    if (failure === 'chrome-preflight') assert.deepEqual(r.seen.slice(0, r.seen.indexOf('chrome-preflight', 1)), ['chrome-preflight']);
    assert.equal(first.usage, null);
    assert.equal(first.efficiency.tokens, null);
    assert.equal(r.read('.r2').verdict, 'PASS');
    assert.equal(r.seen.filter((s) => s === 'turn').length, 1);
    assert.equal(r.seen.filter((s) => s === 'record').length, 1);
    assert.equal(r.seen.filter((s) => s === 'stop').length, 1);
    assert.equal(fs.existsSync(path.join(r.dir, 'case', 'summary.md')), true);
  });
}

test('--skip-chrome runs remaining non-browser tasks without Chrome setup', async (t) => {
  const r = await run(t, 'none', 'mopilot', true);
  assert.equal(r.seen.includes('chrome-preflight'), false);
  assert.equal(r.seen.includes('mark'), false);
  assert.equal(r.seen.includes('start'), false);
  assert.equal(r.seen.filter((s) => s === 'turn').length, 2);
});

for (const arm of ['desk-claude', 'desk-chatgpt']) {
  test(`${arm} records Chrome setup failures before the vendor turn and retries`, async (t) => {
    const r = await run(t, 'start', arm);
    assert.equal(r.read('').verdict, 'UNGRADABLE');
    assert.equal(r.read('.r2').verdict, 'PASS');
    assert.equal(r.seen.filter((s) => s === 'turn').length, 1);
  });
  test(`${arm} preserves unsupported tasks as N/A without Chrome setup`, async (t) => {
    const r = await run(t, 'none', arm, false, true);
    assert.equal(r.read('').verdict, 'N/A');
    assert.equal(r.read('.r2').verdict, 'N/A');
    assert.deepEqual(r.seen, []);
  });
}

for (const [failure, why] of [
  ['shortfall', /carries no bench mark on account/],
  ['dirty', /leftover window still running/],
] as const) {
  test(`${failure} fails setup without a model turn, then retries`, async (t) => {
    const r = await run(t, failure);
    assert.equal(r.read('').verdict, 'UNGRADABLE');
    assert.match(r.read('').turn.error, why);
    assert.equal(r.read('.r2').verdict, 'PASS');
    assert.equal(r.seen.filter((s) => s === 'turn').length, 1);
    assert.equal(r.seen.filter((s) => s === 'record').length, 1);
  });
}

test('a vendor source sign-in failure is UNGRADABLE before its model turn', async (t) => {
  const r = await run(t, 'sources', 'desk-claude');
  assert.equal(r.read('').verdict, 'UNGRADABLE');
  assert.match(r.read('').turn.error, /setup sources failure/);
  assert.equal(r.read('.r2').verdict, 'PASS');
  assert.equal(r.seen.filter((s) => s === 'turn').length, 1);
});
