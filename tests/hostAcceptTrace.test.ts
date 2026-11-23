// `host-accept --trace` and `--cell` (scripts/host-accept/trace.mjs, matrix/index.mjs, the tap of wire.mjs): the file a failing step leaves, and the one-cell run that produces it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main, parseArgs, runSteps } from '../scripts/host-accept.mjs';
import { MATRIX_CELLS, matrixSteps } from '../scripts/host-accept/matrix/index.mjs';
import { createTrace, traceSummary } from '../scripts/host-accept/trace.mjs';
import { connect } from '../scripts/host-accept/steps.mjs';
import { lineClient } from '../scripts/host-accept/wire.mjs';

/** A directory the test removes. */
const tmp = (t: any) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('A: the wire tap hears each request sent and each message received, and a client with no tap works as before', async () => {
  const heard: [string, any][] = [];
  let push: (s: string) => void = () => undefined;
  const stream = {
    write: (line: string) =>
      setImmediate(() => push(`${JSON.stringify({ id: JSON.parse(line).id, result: 'ok' })}\n{"event":"frame","chatId":"c1"}\nnot json\n`)),
    onData: (fn: (c: string) => void) => (push = fn),
    kill: () => undefined,
    closed: new Promise<void>(() => undefined),
  };
  const c = lineClient(stream, { tap: (dir, msg) => heard.push([dir, msg]) });
  assert.equal(await c.request('status', { a: 1 }), 'ok');
  await c.waitFor((e: any) => e.event === 'frame');
  assert.deepEqual(
    heard.map(([d, m]) => [d, m.method ?? m.event ?? m.result]),
    [
      ['out', 'status'],
      ['in', 'ok'],
      ['in', 'frame'],
    ],
  );
  const plain = lineClient(stream);
  assert.equal(await plain.request('status'), 'ok');
});

test('I: a failing step leaves its frames, each chat’s journal read afresh and the Host log lines for the chats; the trace says where', async (t) => {
  const dir = tmp(t);
  let time = 1000;
  const trace = createTrace({ dir, now: () => (time += 10), settleMs: 0 });
  const ran: string[] = [];
  const journalClient = (chatId: string) => ({
    events: [{ chatId, frame: { item: { t: 'event' } } }, { chatId: 'other' }],
    request: async (method: string) => void ran.push(method),
    close: () => void ran.push('close'),
  });
  const ctx: any = {
    state: { dataDir: '/d' },
    m: {
      run: async () => ({
        stdout: 'x line\nthread for c1 ended\n2026-11-15T01:02:03.000Z [codex-stop] chat=zz thread=th turn=T interrupt sent\nlast line\n',
      }),
    },
  };
  trace.begin('codex/J5');
  const tap = trace.tapFor();
  tap('out', { id: 1, method: 'chat.start', params: { chatId: 'c1' } });
  tap('in', { id: 1, result: {} });
  tap('in', { event: 'frame', chatId: 'c2' });
  tap('in', { event: 'noise' });
  const note = await trace.finish(ctx, 'The stopped turn ended with end_turn.', {
    session: async () => (ctx.fail === 'c2' ? Promise.reject(new Error('no session')) : journalClient('c1')),
  });
  assert.match(note, /^ \[trace: .*codex_J5\.jsonl\]$/);
  const lines = fs
    .readFileSync(path.join(dir, 'codex_J5.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.deepEqual(lines[0].chats, ['c1', 'c2']);
  assert.equal(lines[0].message, 'The stopped turn ended with end_turn.');
  const frames = lines.filter((l) => l.kind === 'frame');
  assert.deepEqual(
    frames.map((f) => [f.client, f.dir, f.t]),
    [
      [1, 'out', 10],
      [1, 'in', 20],
      [1, 'in', 30],
      [1, 'in', 40],
    ],
  );
  assert.deepEqual(
    lines.filter((l) => l.kind === 'journal').map((l) => [l.chatId, l.items.length]),
    [
      ['c1', 1],
      ['c2', 0],
    ],
  );
  const log = lines.find((l) => l.kind === 'hostLog');
  assert.deepEqual(log.forChats, ['thread for c1 ended']);
  assert.deepEqual(log.stop, ['2026-11-15T01:02:03.000Z [codex-stop] chat=zz thread=th turn=T interrupt sent']);
  assert.equal(log.tail.length, 4);
  assert.deepEqual(trace.files(), [path.join(dir, 'codex_J5.jsonl')]);
  assert.match(traceSummary({ trace }), /\*\*Traces:\*\*\n- .*codex_J5\.jsonl/);
  assert.equal(traceSummary({}), '');
  // a new step starts with nothing of the last
  trace.begin('next/J1');
  const empty = await trace.finish({ state: {}, m: {} }, 'm', { session: async () => journalClient('x') });
  assert.match(empty, /next_J1\.jsonl/);
  assert.equal(fs.readFileSync(path.join(dir, 'next_J1.jsonl'), 'utf8').trim().split('\n').length, 1);
});

test('W: a trace that cannot be written or a journal that cannot be read says so and never breaks the run', async (t) => {
  const dir = tmp(t);
  const blocked = path.join(dir, 'file');
  fs.writeFileSync(blocked, 'x');
  const trace = createTrace({ dir: path.join(blocked, 'under'), settleMs: 0 });
  trace.begin('a/J1');
  trace.tapFor()('in', { chatId: 'c1' });
  const note = await trace.finish({ state: {} }, 'boom', { session: async () => Promise.reject(new Error('no session')) });
  assert.match(note, /^ \[trace not written: /);
  assert.deepEqual(trace.files(), []);
  const good = createTrace({ dir, settleMs: 0 });
  good.begin('b/J1');
  good.tapFor()('in', { chatId: 'c1' });
  await good.finish({ state: {} }, 'boom', { session: async () => Promise.reject(new Error('no session')) });
  assert.match(fs.readFileSync(path.join(dir, 'b_J1.jsonl'), 'utf8'), /"kind":"journalError","chatId":"c1","error":"no session"/);
});

test('I: runSteps starts the trace for each step and adds the file to a failing row only', async (t) => {
  const dir = tmp(t);
  const trace = createTrace({ dir, settleMs: 0 });
  const ctx: any = { trace, state: {}, m: {} };
  const rows = await runSteps({
    steps: [
      { id: 'ok', title: 'ok', run: async () => 'fine' },
      {
        id: 'bad',
        title: 'bad',
        run: async () => {
          throw new Error('it broke');
        },
      },
    ] as any,
    ctx,
  });
  assert.equal(rows[0].detail, 'fine');
  assert.match(rows[1].detail, /^it broke \[trace: .*bad\.jsonl\]$/);
});

test('B: --cell picks cells of a matrix run, --trace names a folder; both are checked', () => {
  const base = ['--vm', 'mopilot-work'];
  assert.deepEqual([parseArgs(base).cell, parseArgs(base).trace], [[], '']);
  const o = parseArgs([...base, '--matrix', '--cell', 'codex/J5,timings', '--trace', 'out']);
  assert.deepEqual([o.cell, o.trace], [['codex/J5', 'timings'], 'out']);
  assert.throws(() => parseArgs([...base, '--cell', 'codex/J5']), /--cell belongs to --matrix/);
  assert.throws(() => parseArgs([...base, '--matrix', '--cell', 'codex/J12']), /--cell takes .*codex\/J5.*\(got codex\/J12\)/);
  assert.ok(MATRIX_CELLS.includes('multi/six') && MATRIX_CELLS.includes('timings') && MATRIX_CELLS.includes('claude/J6'));
  assert.deepEqual(
    matrixSteps(['codex/J5']).map((s) => s.id),
    ['A1', 'A2', 'A3', 'A5', 'A6', 'codex/J5'],
  );
  assert.equal(matrixSteps().length, 5 + MATRIX_CELLS.length);
});

test('I: main with --trace writes the failing step’s file and ends the report with where it is', async (t) => {
  const dir = tmp(t);
  const out: string[] = [];
  const m = {
    run: async () => ({ code: 1, stdout: '', stderr: 'no node' }),
    open: () => ({ write() {}, onData() {}, kill() {}, closed: new Promise(() => undefined) }),
  };
  const code = await main(['--vm', 'mopilot-work', '--matrix', '--cell', 'fake/J1', '--trace', dir], {
    out: (x) => out.push(x),
    deps: (() => ({})) as any,
    channelFor: () => m as any,
  });
  assert.equal(code, 1);
  assert.match(out[0], /\| A1 .*\| FAIL \|.*\[trace: .*A1\.jsonl\]/);
  assert.match(out[0], /\*\*Traces:\*\*\n- .*A1\.jsonl/);
  assert.ok(fs.existsSync(path.join(dir, 'A1.jsonl')));
});

test('I: a connection opened while tracing reports to the trace under its own client number', async (t) => {
  const dir = tmp(t);
  const trace = createTrace({ dir, settleMs: 0 });
  trace.begin('x/J1');
  let push: (s: string) => void = () => undefined;
  const stream = {
    write: (line: string) => setImmediate(() => push(`${JSON.stringify({ id: JSON.parse(line).id, result: 'ok' })}\n`)),
    onData: (fn: (c: string) => void) => (push = fn),
    kill: () => undefined,
    closed: new Promise<void>(() => undefined),
  };
  const ctx: any = { trace, m: { open: () => stream }, state: { socket: '/s' } };
  await connect(ctx).request('status');
  await connect(ctx).request('status');
  await trace.finish({ state: {} }, 'm', { session: async () => ({}) });
  const frames = fs
    .readFileSync(path.join(dir, 'x_J1.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
    .filter((l) => l.kind === 'frame');
  assert.deepEqual(
    frames.map((f) => [f.client, f.dir]),
    [
      [1, 'out'],
      [1, 'in'],
      [2, 'out'],
      [2, 'in'],
    ],
  );
});

test('B: --stop-delay is a number of milliseconds for a matrix run', () => {
  const base = ['--vm', 'mopilot-work'];
  assert.equal(parseArgs(base).stopDelayMs, 0);
  assert.equal(parseArgs([...base, '--matrix', '--stop-delay', '5000']).stopDelayMs, 5000);
  assert.throws(() => parseArgs([...base, '--matrix', '--stop-delay', 'soon']), /--stop-delay takes a number of milliseconds/);
  assert.throws(() => parseArgs([...base, '--matrix', '--stop-delay', '-1']), /--stop-delay takes a number of milliseconds/);
  assert.throws(() => parseArgs([...base, '--stop-delay', '10']), /--stop-delay belongs to --matrix/);
});
