// The streaming benchmark's runner (scripts/perf-bench/run.mjs) over a fake driver: the release gate, each chat's history and each
// cell's messages, the gate the fakes wait at, failed cells and plans, and the files a run writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { warmSettings, writeSettings } from '../scripts/perf-bench/driver.mjs';
import { SETTLE_MS, cellTimeoutMs, main, parseArgs, refusal, runBench } from '../scripts/perf-bench/run.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'perf-bench-run-'));

test('the command line: scenarios, rates, chunks, repeats, history scale, folders and focus', () => {
  const o = parseArgs([
    '--scenarios',
    'S1,S7',
    '--rates=40',
    '--chunks',
    '4,32',
    '--repeats',
    '2',
    '--turns-scale',
    '0.1',
    '--out',
    'x',
    '--app=.',
    '--foreground',
  ]);
  assert.deepEqual(o.scenarios, ['S1', 'S7']);
  assert.deepEqual(o.rates, [40]);
  assert.deepEqual(o.chunks, [4, 32]);
  assert.equal(o.repeats, 2);
  assert.equal(o.turnsScale, 0.1);
  assert.equal(o.out, path.resolve('x'));
  assert.equal(o.app, path.resolve('.'));
  assert.equal(o.foreground, true);
  assert.equal(parseArgs(['--background']).foreground, false);
  assert.equal(parseArgs(['--repeats', 'x']).repeats, 1);
  assert.equal(parseArgs([]).scenarios.length, 7);
  assert.throws(() => parseArgs(['--rates', '0']), /--rates takes positive numbers: 0/);
  assert.throws(() => parseArgs(['--nope']), /Unknown option: --nope/);
  assert.throws(() => parseArgs(['--scenarios', 'S8']), /Unknown scenario: S8/);
});

test('the run is release-only and needs a built app', () => {
  const o = parseArgs(['--app', '/repo']);
  assert.match(refusal(o, { env: {}, inVm: () => false })!, /release-only/);
  assert.match(refusal(parseArgs([]), { env: { MOPILOT_RELEASE: '1' }, inVm: () => false })!, /--app is required/);
  assert.match(refusal(o, { env: {}, inVm: () => true, exists: () => false })!, /npm run build/);
  assert.equal(
    refusal(o, {
      env: { MOPILOT_RELEASE: '1' },
      inVm: () => false,
      exists: (p) => p === path.join('/repo', 'dist', 'index.html') || /core[\\/]target/.test(p),
    }),
    null,
  );
  assert.match(
    refusal(o, { env: { MOPILOT_RELEASE: '1' }, inVm: () => false, exists: (p) => p === path.join('/repo', 'dist', 'index.html') })!,
    /Build the Rust core first/,
  );
  assert.equal(cellTimeoutMs(4096, 40), 25_600 + 60_000);
});

/** A driver that records the calls the runner makes. */
function fakeDriver(o: { failCell?: (n: number) => boolean; failStart?: boolean } = {}) {
  const calls: string[] = [];
  let sends = 0;
  const d: any = {
    start: async (dir: string, opts: any) => {
      calls.push(`start ${path.basename(dir)} ${opts.foreground}`);
      const ctl = path.join(dir, 'control');
      fs.mkdirSync(ctl, { recursive: true });
      return { dir, ctl };
    },
    newChat: async (_s: any, family: string, text: string) => {
      if (o.failStart) throw 'no harness list';
      calls.push(`new ${family} ${text}`);
      return `id-${family}-${calls.length}`;
    },
    send: async (_s: any, text: string) => void calls.push(`send ${text}`),
    waitTurns: async (s: any, n: number) => {
      calls.push(`wait ${n}${fs.existsSync(path.join(s.ctl, 'go')) ? ' go' : ''}`);
      if (n > 1 || text(s).includes('"gate":true')) if (o.failCell?.(++sends)) throw sends % 2 ? new Error('timed out') : 'stuck';
    },
    switchHarness: async (_s: any, f: string) => void calls.push(`switch ${f}`),
    openChat: async (_s: any, id: string) => void calls.push(`open ${id}`),
    openWindow: async (_s: any, id: string) => void calls.push(`window ${id}`),
    focus: async () => void calls.push('focus'),
    stop: async (s: any) => (calls.push('stop'), [`${path.basename(s.dir)}/perf/run.jsonl`]),
  };
  const text = (s: any) => fs.readFileSync(path.join(s.ctl, 'replay.json'), 'utf8');
  return { d, calls };
}

test('a run builds each chat’s history, then sends every cell’s messages, background chats first, and opens the gate', async () => {
  const { d, calls } = fakeDriver();
  const out = tmp();
  const slept: number[] = [];
  const o = parseArgs(['--scenarios', 'S4', '--rates', '40', '--chunks', '4', '--repeats', '1', '--turns-scale', '0.07']);
  let t = 100;
  const cells = await runBench(o, {
    driver: d,
    out,
    foreground: false,
    writeSettings,
    warmSettings,
    now: () => (t += 10),
    sleep: async (ms) => void slept.push(ms),
  });
  assert.deepEqual(calls, [
    'start S4-switched false',
    'new acp [bench] warm 1',
    'send [bench] warm 2',
    'wait 1',
    'new codex [bench] warm 1',
    'send [bench] warm 2',
    'wait 1',
    'switch claude',
    'open id-acp-2',
    'send [bench] 40/4 #0',
    'open id-codex-5',
    'send [bench] 40/4 #0',
    'focus',
    'wait 2 go',
    'stop',
  ]);
  assert.deepEqual(slept, [SETTLE_MS]);
  assert.equal(cells.length, 1);
  assert.deepEqual(
    { ...cells[0], from: 0, to: 0 },
    {
      scenario: 'S4',
      variant: 'switched',
      rate: 40,
      chunk: 4,
      rep: 0,
      chats: 2,
      probe: 'S4-switched/perf/run.jsonl',
      from: 0,
      to: 0,
    },
  );
  assert.ok(cells[0].to > cells[0].from);
  const replay = JSON.parse(fs.readFileSync(path.join(out, 'S4-switched', 'control', 'replay.json'), 'utf8'));
  assert.deepEqual(replay, { mode: 'replay', bytes: 4096, rate: 40, chunk: 4, toolEveryMs: 0, gate: true });
});

test('a second window is opened on its chat; a failed cell is recorded and the rest run; a plan that cannot start fails its cells', async () => {
  const { d, calls } = fakeDriver({ failCell: (n) => n === 1 });
  const logs: string[] = [];
  const o = parseArgs(['--scenarios', 'S6', '--rates', '40', '--chunks', '4', '--repeats', '2', '--turns-scale', '0.01']);
  const cells = await runBench(o, {
    driver: d,
    out: tmp(),
    foreground: true,
    writeSettings,
    warmSettings,
    sleep: async () => undefined,
    log: (s) => logs.push(s),
  });
  assert.ok(calls.includes('window id-codex-3'));
  assert.equal(cells.length, 6);
  assert.deepEqual(
    cells.map((c) => c.error ?? 'ok'),
    ['timed out', 'ok', 'ok', 'ok', 'ok', 'ok'],
  );
  assert.ok(logs.some((l) => l.includes('40 tok/s × 4: timed out')));
  const broken = fakeDriver({ failStart: true });
  const failed = await runBench(parseArgs(['--scenarios', 'S1', '--rates', '40', '--chunks', '4', '--repeats', '1']), {
    driver: broken.d,
    out: tmp(),
    foreground: false,
    writeSettings,
    warmSettings,
  });
  assert.deepEqual(
    failed.map((c) => [c.variant, c.error, c.probe]),
    [
      ['codex', 'no harness list', 'S1-codex/perf/run.jsonl'],
      ['claude', 'no harness list', 'S1-claude/perf/run.jsonl'],
      ['acp', 'no harness list', 'S1-acp/perf/run.jsonl'],
    ],
  );
  const none = fakeDriver();
  none.d.stop = async () => [];
  const noProbe = await runBench(
    parseArgs(['--scenarios', 'S7', '--rates', '40', '--chunks', '4', '--repeats', '1', '--turns-scale', '0.01']),
    {
      driver: none.d,
      out: tmp(),
      foreground: false,
      writeSettings,
      warmSettings,
      sleep: async () => undefined,
    },
  );
  assert.equal(noProbe[0].probe, '');
  assert.equal(noProbe[0].error, undefined);
});

test('the command checks its arguments and the gate, then runs, writes cells.json and the report, and fails when a cell did', async () => {
  const out = { logs: [] as string[], errors: [] as string[] };
  const sink = { log: (s: string) => out.logs.push(s), error: (s: string) => out.errors.push(s) };
  assert.equal(await main(['--nope'], { out: sink }), 2);
  assert.equal(await main(['--app', '/repo'], { env: {}, inVm: () => false, out: sink }), 2);
  assert.match(out.errors[1], /release-only/);
  const dir = tmp();
  const created: any[] = [];
  const run = (fail: boolean) =>
    main(
      ['--app', '/repo', '--out', dir, '--scenarios', 'S1', '--rates', '40', '--chunks', '4', '--repeats', '1', '--turns-scale', '0.01'],
      {
        env: {},
        inVm: () => true,
        exists: () => true,
        out: sink,
        load: async (p: string) => {
          if (p === './driver.mjs')
            return {
              createDriver: (o: any) => {
                created.push(o);
                o.log('driver says hi');
                const f = fakeDriver({ failCell: () => fail });
                f.d.waitTurns = async () => {
                  if (fail) throw 'stuck';
                };
                return f.d;
              },
              writeSettings,
              warmSettings,
            };
          if (p === './aggregate.mjs') return { aggregateRun: (d: string) => `table of ${path.basename(d)}` };
          return { _electron: 'playwright' };
        },
      },
    );
  assert.equal(await run(false), 0);
  assert.equal(created[0].electron, 'playwright');
  assert.equal(created[0].root, '/repo');
  assert.ok(out.logs.includes('driver says hi'));
  assert.ok(out.logs.includes(`table of ${path.basename(dir)}`));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'cells.json'), 'utf8')).length, 3);
  assert.equal(await run(true), 1);
  // with no --out, a fresh folder
  const logs: string[] = [];
  await main(
    ['--app', '/repo', '--scenarios', 'S7', '--rates', '40', '--chunks', '4', '--repeats', '1', '--turns-scale', '0.01', '--background'],
    {
      env: { MOPILOT_RELEASE: '1' },
      inVm: () => false,
      exists: () => true,
      out: { log: (s) => logs.push(s), error: () => undefined },
      load: async (p: string) =>
        p === './driver.mjs'
          ? { createDriver: () => fakeDriver().d, writeSettings, warmSettings }
          : p === './aggregate.mjs'
            ? { aggregateRun: () => '' }
            : { _electron: null },
    },
  );
  assert.match(logs.at(-1)!, /^Written to .*perf-bench-/);
});

test('the run and report commands start from the command line: a bad option exits 2 before anything launches', async () => {
  const { spawnSync } = await import('node:child_process');
  const dir = path.join(import.meta.dirname, '..', 'scripts', 'perf-bench');
  const run = spawnSync(process.execPath, [path.join(dir, 'run.mjs'), '--nope'], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /Unknown option: --nope/);
  const report = spawnSync(process.execPath, [path.join(dir, 'aggregate.mjs')], { encoding: 'utf8' });
  assert.equal(report.status, 2);
  assert.match(report.stderr, /^usage: /);
  const { importModule } = await import('../scripts/perf-bench/run.mjs');
  assert.deepEqual((await importModule('./scenarios.mjs')).REPEATS, 3);
});

test('building history logs its progress, and a turn that fails says how much history the window held', async () => {
  const { d } = fakeDriver();
  const logs: string[] = [];
  const o = parseArgs(['--scenarios', 'S5', '--rates', '40', '--chunks', '4', '--repeats', '1', '--turns-scale', '0.2']);
  const opts = {
    driver: d,
    out: tmp(),
    foreground: false,
    writeSettings,
    warmSettings,
    sleep: async () => undefined,
    log: (s: string) => logs.push(s),
  };
  await runBench({ ...o, scenarios: ['S5'] }, opts);
  assert.ok(logs.includes('  history: 50 of 60 turns'));
  d.send = async (_s: unknown, text: string) => {
    if (text.endsWith('warm 3')) throw new Error('click timed out');
  };
  const failed = await runBench(o, opts);
  assert.equal(failed[0].error, 'history turn 3 of 60: click timed out');
});

test('a plan whose chat started on another harness runs again once on a fresh instance, and fails after that', async () => {
  const wrong = () => Object.assign(new Error('chat x started on claude, not codex'), { wrongHarness: true });
  const run = async (failures: number) => {
    const { d, calls } = fakeDriver();
    const newChat = d.newChat;
    let left = failures;
    d.newChat = async (...a: any[]) => {
      if (left-- > 0) throw wrong();
      return newChat(...a);
    };
    const logs: string[] = [];
    const cells = await runBench(
      parseArgs(['--scenarios', 'S1', '--rates', '40', '--chunks', '4', '--repeats', '1', '--turns-scale', '0.01']),
      {
        driver: d,
        out: tmp(),
        foreground: false,
        writeSettings,
        warmSettings,
        sleep: async () => undefined,
        log: (s) => logs.push(s),
      },
    );
    return { cells, calls, logs };
  };
  const once = await run(1);
  assert.deepEqual(
    once.calls.filter((c) => c.startsWith('start')),
    ['start S1-codex false', 'start S1-codex-2 false', 'start S1-claude false', 'start S1-acp false'],
  );
  assert.ok(once.logs.some((l) => l.endsWith('; running the plan again on a fresh instance')));
  assert.deepEqual(
    once.cells.map((c) => [c.variant, c.error ?? 'ok', c.probe]),
    [
      ['codex', 'ok', 'S1-codex-2/perf/run.jsonl'],
      ['claude', 'ok', 'S1-claude/perf/run.jsonl'],
      ['acp', 'ok', 'S1-acp/perf/run.jsonl'],
    ],
  );
  const twice = await run(2);
  assert.equal(twice.calls.filter((c) => c.startsWith('start S1-codex')).length, 2);
  assert.equal(twice.cells[0].error, 'chat x started on claude, not codex');
  assert.equal(twice.cells.length, 3);
});
