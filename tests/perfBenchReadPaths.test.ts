// The read-path benchmark (scripts/perf-bench/readpaths.mjs) and its fixtures: the files parse through the app's own readers, every path gets a row, and each main-thread slice it times carries a stall label in the app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { TRANSCRIPT_SHAPES, acpTranscript, codexRollout, pathListing, shapedText } from '../scripts/perf-bench/history.mjs';
import { main, readPathRows, readPathTable } from '../scripts/perf-bench/readpaths.mjs';
import { parseRollout } from './support/rollout.ts';
import { buildAcpTurns } from '../electron/harness/items/acpTranslator.cjs';

const require = createRequire(import.meta.url);
const { ItemsLog } = require('../electron/platform/itemsLog.cjs');
const { rank } = require('../electron/platform/search.cjs');
const { createAudioOwnership } = require('../electron/platform/audioOwnership.cjs');
const stalls = require('../electron/perf/stalls.cjs');

test('each transcript shape reaches its size in the format ItemsLog and the turn builder read', () => {
  const log = new ItemsLog(os.tmpdir());
  for (const shape of TRANSCRIPT_SHAPES) {
    const text = acpTranscript('t', 20_000, shape);
    assert.ok(Buffer.byteLength(text) >= 20_000);
    const records = log.parse(text);
    assert.equal(records.length, text.trimEnd().split('\n').length, 'no line is torn');
    assert.equal(records[0].t, 'session');
    const turns = buildAcpTurns(records, 'chat', '/perf');
    assert.ok(turns.length > 1);
    assert.equal(turns[0].status, 'completed');
    assert.ok(turns[0].items.some((i: { type: string }) => i.type === 'agentMessage'));
  }
});

test('shapes cost a parser differently: code is escapes and CJK is multi-byte', () => {
  assert.equal(shapedText('code', 700).length, 700);
  assert.ok(JSON.stringify(shapedText('code', 700)).length > 770);
  assert.ok(Buffer.byteLength(shapedText('cjk', 700)) > 2000);
});

test("a rollout's turns read through the app's reader, and most of the file is the model's own records", () => {
  const text = codexRollout('t', 20_000);
  assert.ok(text.length >= 20_000);
  const { cwd, turns } = parseRollout(text);
  assert.equal(cwd, '/perf');
  assert.ok(turns.length > 1);
  assert.deepEqual(
    turns[0].items.map((i: { type: string }) => i.type),
    ['userMessage', 'agentMessage'],
  );
  assert.ok(text.split('\n').filter((l) => l.includes('"response_item"')).length > text.split('\n').length / 2);
});

test('a listing has distinct paths that a query finds', async () => {
  const files = pathListing(500);
  assert.equal(new Set(files).size, 500);
  assert.ok((await rank(files, 'cmp')).length > 0);
});

test('a small run has a row for every path, and the table names each', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'readpaths-'));
  try {
    const rows = await readPathRows({ dir, reps: 2, scale: 0.0005 });
    const named = (start: string) => rows.filter((r) => r.name.startsWith(start)).length;
    for (const step of ['acp read', 'acp parse', 'acp build turns', 'acp copy turns'])
      assert.equal(named(step), TRANSCRIPT_SHAPES.length * 2);
    for (const step of ['claude read', 'claude first page', 'claude all turns']) assert.equal(named(step), 2);
    assert.equal(named('acp list'), 1);
    assert.equal(named('acp search miss'), 1);
    assert.equal(named('rank'), 4);
    assert.equal(named('codex rollout parse'), 1);
    for (const r of rows) {
      assert.equal(r.reps, 2);
      assert.ok(r.min <= r.ms && r.ms <= r.max, r.name);
    }
    const table = readPathTable(rows);
    assert.equal(table.split('\n').length, rows.length + 2);
    assert.match(table, /\| acp list, 2 chats \|/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the command prints the table, writes JSON when asked, and leaves no files behind', async (t) => {
  const printed: string[] = [];
  t.mock.method(console, 'log', (line: string) => void printed.push(line));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'readpaths-out-'));
  // os.tmpdir() reads this, so the check sees only this run's files
  const scratch = path.join(dir, 'scratch');
  fs.mkdirSync(scratch);
  const tmpdir = process.env.TMPDIR;
  process.env.TMPDIR = scratch;
  try {
    const out = path.join(dir, 'rows.json');
    await main(['--reps', '1', '--scale', '0.0005', '--out', out]);
    await main(['--reps', '1', '--scale', '0.0005']);
    assert.equal(printed.length, 2);
    assert.match(printed[0], /\| acp parse, prose/);
    const report = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(report.node, process.version);
    assert.ok(report.rows.length > 0);
    assert.deepEqual(fs.readdirSync(scratch), []);
  } finally {
    process.env.TMPDIR = tmpdir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('run as a script, it prints the table and exits cleanly', () => {
  const run = spawnSync(process.execPath, ['scripts/perf-bench/readpaths.mjs', '--reps', '1', '--scale', '0.0005'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /\| acp parse, prose/);
});

test('the command refuses counts that would time nothing, rather than print rows of 0 ms', async () => {
  for (const reps of ['0', '-1', '1.5', 'x']) await assert.rejects(main([`--reps=${reps}`]), /--reps needs a whole number/);
  for (const scale of ['0', '-1', 'x', 'Infinity']) await assert.rejects(main([`--scale=${scale}`]), /--scale needs a number above 0/);
});

/** What a stall right after `run` is blamed on: `run` moves the logger's clock past the long-task bar from inside the labelled work. */
async function labelOf(run: (slow: () => void) => unknown) {
  let now = 1000;
  let tick = () => {};
  const warned: string[] = [];
  const logger = stalls.startStallLogger({
    dir: '/unused',
    electron: { BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null } },
    clock: () => now,
    setInterval: (cb: () => void) => ((tick = cb), {}),
    clearInterval: () => {},
    rss: () => 1,
    log: { append: () => {} },
    warn: (m: string) => warned.push(m),
  });
  await run(() => (now += 60));
  now += 900;
  tick();
  logger.stop();
  return warned.join('\n');
}

test('a transcript parse is labelled', async () => {
  const items = new ItemsLog(os.tmpdir());
  assert.match(await labelOf((slow) => items.parse({ split: () => (slow(), []) })), / in items\.parse \(60 ms\)/);
});

test('a turn build is labelled', async () => {
  const out = await labelOf((slow) => {
    assert.deepEqual(buildAcpTurns([{ toJSON: () => (slow(), { t: 'session' }) }] as never, 'chat', '/w'), []);
  });
  assert.match(out, / in acp\.buildTurns \(/);
});

test('the audio walk is labelled', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-label-'));
  try {
    const host = { audioDispatch: { list: () => [] }, items: { listAsync: async () => [], audioRefs: async () => [] } };
    const out = await labelOf(async (slow) => {
      const owner = createAudioOwnership(() => root, { collect: slow }, host, { all: () => [] });
      await owner.collect();
    });
    assert.match(out, / in audio\.collect \(60 ms\)/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
