// Motion capture over CDP, the run side (scripts/motion-cdp/run.mjs): arguments, a turn, an approval and the steps moment captured through a fake driver, page and CDP session, and the command line.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  APPROVAL_TRIGGERS,
  FAMILIES,
  foldSteps,
  STEP_TRIGGERS,
  captureTurn,
  loadModule,
  main,
  parseArgs,
  PRESS_MS,
  scratchDir,
  UNTHROTTLED,
} from '../scripts/motion-cdp/run.mjs';

import { fakes, stepsPage } from './support/motionCdpFakes.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-cdp-run-test-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('parseArgs', () => {
  const d = parseArgs([]);
  assert.deepEqual(d.families, [...FAMILIES]);
  assert.equal(d.reduced, false);
  const o = parseArgs([
    '--app',
    'x',
    '--out',
    'y',
    '--families',
    'acp,claude',
    '--rate',
    '30',
    '--chunk',
    '6',
    '--bytes',
    '900',
    '--tool-every',
    '1000',
    '--quality',
    '500',
    '--reduced-motion',
  ]);
  assert.deepEqual(
    [o.app, o.out, o.families, o.rate, o.chunk, o.bytes, o.toolEveryMs, o.quality, o.reduced],
    [path.resolve('x'), path.resolve('y'), ['acp', 'claude'], 30, 6, 900, 1000, 100, true],
  );
  assert.throws(() => parseArgs(['--families', 'gemini']), /unknown family gemini/);
  assert.throws(() => parseArgs(['--families', ',']), /at least one family/);
  assert.throws(() => parseArgs(['--rate', '0']), /positive number: 0/);
  assert.throws(() => parseArgs(['--rate']), /positive number: undefined/);
  assert.throws(() => parseArgs(['--what']), /unknown option --what/);
  assert.equal(parseArgs([]).moment, 'turn-start');
  assert.equal(parseArgs(['--moment', 'approval']).moment, 'approval');
  assert.throws(() => parseArgs(['--moment', 'scroll']), /unknown moment scroll; known: turn-start, approval, steps/);
});

test('captureTurn: new chat on the family, the turn followed through CDP, every file the metrics read', async () => {
  const { calls, driver } = fakes(dir);
  const settings: any[] = [];
  const out = path.join(dir, 'turn');
  let t = 1_700_000_005_500;
  const summary = await captureTurn({
    driver,
    s: { page: (driver as any).start && (await driver.start(path.join(out, 'profile'), { args: UNTHROTTLED })).page, ctl: 'ctl' },
    family: 'codex',
    dir: out,
    o: { ...parseArgs([]), reduced: true },
    writeSettings: (ctl, s) => settings.push([ctl, s]),
    now: () => t++,
    sleep: async () => undefined,
  });
  assert.equal(summary, 'codex: 2 animations in 2 groups, 2 frames');
  assert.deepEqual(settings, [['ctl', { mode: 'replay', bytes: 1600, rate: 50, chunk: 12, toolEveryMs: 2500, gate: false }]]);
  assert.ok(calls.includes('Emulation.setEmulatedMedia {"features":[{"name":"prefers-reduced-motion","value":"reduce"}]}'));
  assert.deepEqual(
    calls.filter((c) => /^(click|pick|send|wait|Animation|Page\.start|Page\.stop|detach)/.test(c)),
    [
      'click /^New chat/',
      'pick codex',
      'Animation.enable',
      'Page.startScreencast {"format":"jpeg","quality":80,"everyNthFrame":1}',
      'send true',
      'wait',
      'Page.stopScreencast',
      'detach',
    ],
  );
  const anims = JSON.parse(fs.readFileSync(path.join(out, 'animations.json'), 'utf8'));
  assert.equal(anims.reducedMotion, true);
  assert.deepEqual(
    anims.records.map((r: any) => [r.id, r.startMs, r.label, r.canceled]),
    [
      ['a', 600, 'div.step-row', false],
      ['b', 700, 'removed', true],
    ],
  );
  assert.match(fs.readFileSync(path.join(out, 'summary.md'), 'utf8'), /^# MoPilot codex: animations during a turn \(reduced motion\)/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'frames', 'frames.json'), 'utf8')), [
    { file: '000000.jpg', t: 0 },
    { file: '000001.jpg', t: 0.05 },
  ]);
  assert.equal(fs.readFileSync(path.join(out, 'frames', '000001.jpg'), 'utf8'), 'jpeg');
  const rec = JSON.parse(fs.readFileSync(path.join(out, 'recording.json'), 'utf8'));
  assert.deepEqual(rec.screencastAckFailures, ['closed'], 'the second frame’s ack failed');
  assert.deepEqual(
    [rec.kind, rec.arm, rec.moment, rec.media, rec.window, rec.regions, rec.sync, rec.marks.send, rec.animationOriginWallMs],
    [
      'screencast',
      'mp-codex',
      'turn-start',
      'frames',
      [0, 0, 1200, 800],
      { transcript: [10, 40, 800, 600] },
      { clock: 'wall', originMs: 1_700_000_005_600 },
      1_700_000_005_500,
      1_700_000_000_000,
    ],
  );
});

test('captureTurn with no screencast frame places the marks from the send', async () => {
  const { driver, page } = fakes(dir, { failDescribe: true });
  const quiet = { ...driver, send: async () => undefined };
  const out = path.join(dir, 'quiet');
  await captureTurn({
    driver: quiet,
    s: { page, ctl: 'c' },
    family: 'acp',
    dir: out,
    o: parseArgs([]),
    writeSettings: () => undefined,
    now: () => 42,
    sleep: async () => undefined,
  });
  const rec = JSON.parse(fs.readFileSync(path.join(out, 'recording.json'), 'utf8'));
  assert.deepEqual(rec.sync, { clock: 'wall', originMs: 42 });
  assert.equal(rec.reducedMotion, false);
  assert.match(fs.readFileSync(path.join(out, 'summary.md'), 'utf8'), /^# MoPilot acp: animations during a turn\n/);
});

test('main: argument and build checks, one instance per family, failures counted', async () => {
  const app = path.join(dir, 'app');
  fs.mkdirSync(path.join(app, 'dist'), { recursive: true });
  const logs: string[] = [];
  const errors: string[] = [];
  const io = { log: (s: string) => logs.push(s), error: (s: string) => errors.push(s) };
  assert.equal(await main(['--bogus'], io), 2);
  assert.equal(await main(['--app', app], io), 2);
  assert.match(errors.at(-1) ?? '', /Build the app first/);
  fs.writeFileSync(path.join(app, 'dist', 'index.html'), '');
  const { calls, driver } = fakes(dir);
  const broken = {
    ...driver,
    pickHarness: async (_s: any, f: string) => {
      if (f === 'acp') throw new Error('no fake');
      calls.push(`pick ${f}`);
    },
  };
  const load = async (p: string) =>
    p.endsWith('driver.mjs') ? { createDriver: () => broken, writeSettings: () => undefined } : { _electron: {} };
  const out = path.join(dir, 'main');
  assert.equal(await main(['--app', app, '--out', out, '--families', 'claude,acp'], { ...io, load }), 1);
  assert.deepEqual(errors.at(-1), 'acp: no fake');
  assert.ok(logs.includes(`Written to ${out}`));
  assert.deepEqual(
    calls.filter((c) => c.startsWith('start') || c === 'stop'),
    ['start claude true', 'stop', 'start acp true', 'stop'],
  );
  const noStart = { ...driver, start: async () => Promise.reject(new Error('bind() failed')) };
  const load2 = async (p: string) =>
    p.endsWith('driver.mjs') ? { createDriver: () => noStart, writeSettings: () => undefined } : { _electron: {} };
  assert.equal(await main(['--app', app, '--out', out, '--families', 'codex'], { ...io, load: load2 }), 1);
  assert.equal(errors.at(-1), 'codex: the instance did not start: bind() failed');
  const tmp = path.join(dir, 'tmp-out');
  assert.equal(await main(['--app', app, '--families', 'claude'], { ...io, load, tmp: () => tmp }), 0);
  assert.ok(fs.existsSync(path.join(tmp, 'claude', 'recording.json')));
});

test('the command line entry refuses a bad option; the default loader and output folder', async () => {
  let status = 0;
  try {
    execFileSync(process.execPath, ['scripts/motion-cdp/run.mjs', '--bogus'], { stdio: 'pipe' });
  } catch (e: any) {
    status = e.status;
  }
  assert.equal(status, 2);
  assert.equal((await loadModule('node:path')).sep, path.sep);
  const made = scratchDir();
  assert.ok(fs.statSync(made).isDirectory());
  fs.rmSync(made, { recursive: true });
});

test('the approval moment sends the family’s trigger, waits for the card, then holds Allow and lets go', async () => {
  const { calls, driver, page } = fakes(dir);
  const sent: string[] = [];
  const asking = { ...driver, send: async (_s: any, text: string) => void sent.push(text) };
  const out = path.join(dir, 'approval');
  let t = 1000;
  await captureTurn({
    driver: asking,
    s: { page, ctl: 'c' },
    family: 'claude',
    dir: out,
    o: { ...parseArgs([]), moment: 'approval' },
    writeSettings: () => undefined,
    now: () => (t += 100),
    sleep: async () => undefined,
  });
  assert.match(sent[0], new RegExp(`^\\[bench\\] ${APPROVAL_TRIGGERS.claude} `));
  assert.deepEqual(
    calls.filter((c) => c.startsWith('waitFor') || c.startsWith('press')),
    ['waitFor .approval-card', `press .approval-card .ap-btn.allow ${PRESS_MS}`],
  );
  const rec = JSON.parse(fs.readFileSync(path.join(out, 'recording.json'), 'utf8'));
  assert.equal(rec.moment, 'approval');
  assert.deepEqual(Object.keys(rec.marks), ['send', 'card', 'allow']);
  assert.ok(rec.marks.send < rec.marks.card && rec.marks.card < rec.marks.allow);
  assert.match(fs.readFileSync(path.join(out, 'summary.md'), 'utf8'), /^# MoPilot claude: animations during an approval\n/);
});

test('foldSteps unfolds the work, then opens and closes the first row; skips what the layout lacks', async () => {
  const calls: string[] = [];
  const marks: Record<string, number> = {};
  let t = 0;
  const clock = { now: () => (t += 10), sleep: async () => undefined };
  await foldSteps(stepsPage({ '.worked-for:not(.running)': 1, '.step-row.expandable .step-row-hit': 2 }, calls), marks, clock);
  assert.deepEqual(calls, [
    'click .worked-for:not(.running)',
    'click .step-row.expandable .step-row-hit',
    'click .step-row.expandable .step-row-hit',
  ]);
  assert.deepEqual(Object.keys(marks), ['unfold', 'expand', 'collapse']);
  const none: string[] = [];
  const noMarks: Record<string, number> = {};
  await foldSteps(stepsPage({}, none), noMarks, clock);
  assert.deepEqual([none, noMarks], [[], {}], 'an inline layout with nothing to open');
});

test('the steps moment sends the family’s command trigger and allows the card when one comes', async () => {
  const { driver, page } = fakes(dir);
  for (const [family, shows] of [
    ['codex', true],
    ['acp', false],
  ] as const) {
    const calls: string[] = [];
    const sent: string[] = [];
    const p = { ...page, ...stepsPage({ '.worked-for:not(.running)': 1 }, calls, shows) };
    await captureTurn({
      driver: { ...driver, send: async (_s: any, text: string) => void sent.push(text) },
      s: { page: p, ctl: 'c' },
      family,
      dir: path.join(dir, `steps-${family}`),
      o: { ...parseArgs([]), moment: 'steps' },
      writeSettings: () => undefined,
      sleep: async () => undefined,
    });
    assert.match(sent[0], new RegExp(` ${STEP_TRIGGERS[family]} `));
    assert.equal(calls.includes('click .approval-card .ap-btn.allow'), shows, `${family}: allowed only when asked`);
    assert.ok(calls.includes('click .worked-for:not(.running)'));
    assert.match(fs.readFileSync(path.join(dir, `steps-${family}`, 'summary.md'), 'utf8'), /during unfolding the work/);
  }
});
