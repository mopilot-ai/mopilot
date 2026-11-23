// electron/harness/harnessRuns.cjs with a fake pty: one run per harness (a second start joins it), one per package
// manager across harnesses, output kept for a late window, and the harness looked for again before windows hear the end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { HarnessRuns, OUTPUT_MAX } = require('../electron/harness/harnessRuns.cjs');
const { installLines } = await import('../shared/harnessInstall.mjs');

type Pty = { id: string; opts: any; h: any };
function setup(o: any = {}) {
  const ptys: Pty[] = [];
  const io: any[] = [];
  const sent: any[] = [];
  const deferred: (() => void)[] = [];
  let after: { kind: string; done: (e?: unknown) => void }[] = [];
  let t = 1000;
  const runs = new HarnessRuns({
    pty: {
      spawn: (id: string, opts: any, h: any) => {
        if (o.spawnThrows) throw o.spawnThrows;
        ptys.push({ id, opts, h });
      },
      write: (id: string, d: string) => io.push(['write', id, d]),
      resize: (id: string, c: number, r: number) => io.push(['resize', id, c, r]),
      kill: (id: string) => io.push(['kill', id]),
    },
    home: () => '/home/ada',
    platform: o.platform ?? 'darwin',
    broadcast: (ch: string, p: any) => sent.push([ch, structuredClone(p)]),
    afterExit: (kind: string) => new Promise<void>((resolve, reject) => after.push({ kind, done: (e) => (e ? reject(e) : resolve()) })),
    now: () => (t += 1),
    defer: (fn: () => void) => deferred.push(fn),
  });
  const flushData = () => deferred.splice(0).forEach((f) => f());
  const settleAfter = async (e?: unknown) => {
    const list = after;
    after = [];
    for (const a of list) a.done(e);
    await new Promise((r) => setImmediate(r));
  };
  return { runs, ptys, io, sent, flushData, settleAfter, afters: () => after.map((a) => a.kind) };
}
const lineOf = (kind: string, via: string, os = 'darwin') => installLines(kind, os, null).find((l) => l.via === via)!.index;
const states = (sent: any[]) => sent.filter((s) => s[0] === 'harnessRuns:state').map((s) => s[1]);

test('a run starts the table command in a login-shell pty at home, and every window hears it', () => {
  const { runs, ptys, sent } = setup();
  const r = runs.start('acp:gemini', lineOf('acp:gemini', 'npm'), { cols: 100, rows: 30 });
  assert.equal(r.ok, true);
  assert.equal(r.joined, false);
  assert.equal(ptys.length, 1);
  assert.deepEqual(ptys[0].opts, {
    command: ['/bin/sh', '-c', 'npm install -g @google/gemini-cli'],
    cwd: '/home/ada',
    env: undefined,
    cols: 100,
    rows: 30,
    // its read-only view answers no terminal queries (electron/platform/pty.cjs)
    selfAnswer: true,
  });
  assert.equal(ptys[0].id, r.run.id);
  assert.match(r.run.id, /^harness-run:/);
  assert.deepEqual(
    { ...r.run, id: '', startedAt: 0 },
    {
      id: '',
      kind: 'acp:gemini',
      purpose: 'install',
      via: 'npm',
      command: 'npm install -g @google/gemini-cli',
      group: 'npm',
      quiet: false,
      state: 'running',
      code: null,
      stopped: false,
      checked: false,
      startedAt: 0,
      endedAt: null,
    },
  );
  assert.deepEqual(states(sent), [[r.run]]);
  assert.deepEqual(runs.list(), [r.run]);
});

test('a line that is not in the table for this platform is refused, and nothing runs', () => {
  const { runs, ptys } = setup({ platform: 'linux' });
  // the Codex cask is macOS-only
  assert.deepEqual(runs.start('codex', lineOf('codex', 'brew'), {}), { ok: false, error: 'unknown' });
  assert.deepEqual(runs.start('acp:nope', 0), { ok: false, error: 'unknown' });
  assert.deepEqual(runs.start('codex', '0'), { ok: false, error: 'unknown' });
  assert.equal(ptys.length, 0);
  assert.deepEqual(runs.list(), []);
});

test('two windows starting the same harness share one run; another harness on the same package manager waits', () => {
  const { runs, ptys } = setup();
  const a = runs.start('acp:gemini', lineOf('acp:gemini', 'npm'));
  const again = runs.start('acp:gemini', lineOf('acp:gemini', 'npm'));
  assert.deepEqual(again, { ok: true, run: a.run, joined: true });
  // any line of a harness already running joins it
  assert.equal(runs.start('acp:gemini', 0).joined, true);
  assert.deepEqual(runs.start('acp:dsh', lineOf('acp:dsh', 'npm')), { ok: false, error: 'busy', by: 'acp:gemini' });
  // a script doesn't wait for npm
  assert.equal(runs.start('acp:kimi', lineOf('acp:kimi', 'script')).ok, true);
  // nor does Homebrew
  assert.equal(runs.start('acp:qwen', lineOf('acp:qwen', 'brew')).ok, true);
  assert.deepEqual(runs.start('acp:goose', lineOf('acp:goose', 'brew')), { ok: false, error: 'busy', by: 'acp:qwen' });
  assert.equal(ptys.length, 3);
});

test('output is kept for a window that attaches later, sent once per tick with its total length', () => {
  const { runs, ptys, sent, flushData } = setup();
  const { run } = runs.start('acp:kimi', lineOf('acp:kimi', 'script'));
  ptys[0].h.onData('ab');
  ptys[0].h.onData('cd');
  assert.deepEqual(runs.attach(run.id), { run, output: 'abcd', end: 4 });
  assert.equal(runs.outputOf(run.id), 'abcd');
  assert.equal(runs.outputOf('harness-run:gone'), '');
  assert.equal(sent.filter((s) => s[0] === 'harnessRuns:data').length, 0, 'batched until the tick');
  flushData();
  assert.deepEqual(
    sent.filter((s) => s[0] === 'harnessRuns:data').map((s) => s[1]),
    [{ id: run.id, data: 'abcd', end: 4 }],
  );
  flushData();
  assert.equal(sent.filter((s) => s[0] === 'harnessRuns:data').length, 1, 'nothing new, nothing sent');
  // a long run keeps its newest output; its length still counts all of it
  ptys[0].h.onData('x'.repeat(OUTPUT_MAX));
  const a = runs.attach(run.id);
  assert.equal(a.output.length, OUTPUT_MAX);
  assert.equal(a.end, OUTPUT_MAX + 4);
  assert.equal(runs.attach('harness-run:gone'), null);
});

test('typing and size go to a running pty only', async () => {
  const { runs, ptys, io, settleAfter } = setup();
  const { run } = runs.start('acp:kimi', lineOf('acp:kimi', 'script'));
  runs.write(run.id, 'y\r');
  runs.resize(run.id, 90, 20);
  runs.write('harness-run:other', 'n');
  ptys[0].h.onExit({ exitCode: 0 });
  await settleAfter();
  runs.write(run.id, 'late');
  runs.resize(run.id, 1, 1);
  assert.deepEqual(io, [
    ['write', run.id, 'y\r'],
    ['resize', run.id, 90, 20],
  ]);
});

test('an exit is shown at once; windows hear it was checked only after the harness was looked for again', async () => {
  const { runs, ptys, sent, settleAfter, afters, flushData } = setup();
  const { run } = runs.start('acp:kimi', lineOf('acp:kimi', 'script'));
  ptys[0].h.onData('done');
  ptys[0].h.onExit({ exitCode: 0 });
  // the last output goes out before the exit
  assert.deepEqual(sent.at(-2), ['harnessRuns:data', { id: run.id, data: 'done', end: 4 }]);
  flushData();
  const ended = states(sent).at(-1)[0];
  assert.equal(ended.state, 'exited');
  assert.equal(ended.code, 0);
  assert.equal(ended.checked, false);
  assert.ok(ended.endedAt > ended.startedAt);
  assert.deepEqual(afters(), ['acp:kimi']);
  await settleAfter();
  assert.equal(states(sent).at(-1)[0].checked, true);
  // ended: a new run of that harness may start, and replaces this result
  const next = runs.start('acp:kimi', lineOf('acp:kimi', 'script'));
  assert.equal(next.joined, false);
  assert.deepEqual(
    runs.list().map((r: any) => r.id),
    [next.run.id],
  );
});

test("a failed look-again still settles the run, and doesn't hold up the next one", async () => {
  const { runs, ptys, sent, settleAfter } = setup();
  runs.start('acp:kimi', lineOf('acp:kimi', 'script'));
  ptys[0].h.onExit({ exitCode: 3 });
  await settleAfter(new Error('admission failed'));
  const last = states(sent).at(-1)[0];
  assert.deepEqual([last.state, last.code, last.checked], ['exited', 3, true]);
});

test('Stop retains the manager lock until the pty exits; repeated requests retain the same run', async () => {
  const { runs, ptys, io, sent, settleAfter, afters } = setup();
  const { run } = runs.start('acp:gemini', lineOf('acp:gemini', 'npm'));
  assert.equal(runs.stop(run.id), true);
  assert.deepEqual(io, [['kill', run.id]]);
  const stopped = states(sent).at(-1)[0];
  assert.deepEqual([stopped.state, stopped.code, stopped.stopped], ['running', null, true]);
  assert.equal(runs.start('acp:dsh', lineOf('acp:dsh', 'npm')).error, 'busy');
  assert.equal(runs.stop(run.id), false);
  assert.deepEqual(
    io,
    [
      ['kill', run.id],
      ['kill', run.id],
    ],
    'the terminal owner coalesces repeated retirement requests',
  );
  ptys[0].h.onExit({ exitCode: 143 });
  assert.equal(runs.start('acp:dsh', lineOf('acp:dsh', 'npm')).ok, true);
  const before = sent.length;
  ptys[0].h.onExit({ exitCode: 0 });
  assert.equal(sent.length, before, 'a repeated terminal notification cannot finish the old run again');
  assert.deepEqual(afters(), ['acp:gemini']);
  await settleAfter();
  assert.equal(runs.stop(run.id), false, 'already ended');
  assert.equal(runs.stop('harness-run:gone'), false);
});

test('Dismiss forgets an ended result, never a running one', async () => {
  const { runs, ptys, settleAfter } = setup();
  const { run } = runs.start('acp:kimi', lineOf('acp:kimi', 'script'));
  assert.equal(runs.dismiss(run.id), false);
  ptys[0].h.onExit({ exitCode: 1 });
  await settleAfter();
  assert.equal(runs.dismiss(run.id), true);
  assert.deepEqual(runs.list(), []);
  assert.equal(runs.dismiss(run.id), false);
});

test("a pty that can't start is reported, records nothing and holds no lock; Windows preserves manual execution", () => {
  const failing = setup({ spawnThrows: new Error('posix_spawnp failed') });
  assert.deepEqual(failing.runs.start('acp:gemini', lineOf('acp:gemini', 'npm')), {
    ok: false,
    error: 'spawn',
    message: 'posix_spawnp failed',
  });
  assert.deepEqual(failing.runs.list(), []);
  assert.equal(setup({ spawnThrows: 'boom' }).runs.start('acp:kimi', 0).message, 'boom');
  const win = setup({ platform: 'win32' });
  assert.match(win.runs.start('claude', lineOf('claude', 'powershell', 'win32')).message, /Run this command in your terminal/);
  assert.deepEqual(win.ptys, []);
});

test('defaults: the real clock, platform and setImmediate', async () => {
  const sent: any[] = [];
  const ptys: any[] = [];
  const runs = new HarnessRuns({
    pty: { spawn: (_id: string, _o: any, h: any) => ptys.push(h), write() {}, resize() {}, kill() {} },
    home: () => '/h',
    broadcast: (ch: string, p: any) => sent.push([ch, p]),
    afterExit: async () => undefined,
  });
  const kind = process.platform === 'win32' ? 'claude' : 'acp:kimi';
  const r = runs.start(kind, installLines(kind, process.platform, null)[0].index);
  assert.ok(r.ok && r.run.startedAt > 0);
  ptys[0].onData('x');
  await new Promise((res) => setImmediate(res));
  assert.deepEqual(sent.at(-1), ['harnessRuns:data', { id: r.run.id, data: 'x', end: 1 }]);
});

test('an update runs quietly when asked (no typing, no size; Stop kills it); listeners hear each end, one that throws is only noted', async () => {
  const quiet: any[] = [];
  const heard: any[] = [];
  const runs = new HarnessRuns({
    pty: { spawn() {}, write: () => assert.fail('no pty'), resize: () => assert.fail('no pty'), kill: () => assert.fail('no pty') },
    spawnQuiet: (argv: string[], o: any, h: any) => (quiet.push({ argv, o, h }), { kill: () => quiet.push('killed') }),
    home: () => '/h',
    broadcast: () => undefined,
    afterExit: async () => undefined,
  });
  runs.onEnd(() => {
    throw new Error('listener broke');
  });
  const off = runs.onEnd((r: any) => heard.push([r.kind, r.purpose, r.quiet, r.code]));
  const r = runs.launch({
    kind: 'acp:kimi',
    purpose: 'update',
    via: 'npm',
    command: 'npm i',
    argv: ['/n', 'i'],
    env: { PATH: '/n' },
    quiet: true,
    timeoutMs: 5,
  });
  assert.deepEqual(quiet[0].argv, ['/n', 'i']);
  assert.deepEqual(quiet[0].o, { cwd: '/h', env: { PATH: '/n' }, timeoutMs: 5 });
  runs.write(r.run.id, 'y');
  runs.resize(r.run.id, 1, 1);
  quiet[0].h.onExit({ exitCode: 0 });
  await new Promise((res) => setImmediate(res));
  assert.deepEqual(heard, [['acp:kimi', 'update', true, 0]]);
  const again = runs.launch({ kind: 'acp:kimi', purpose: 'update', via: 'npm', command: 'npm i', argv: ['/n', 'i'], quiet: true });
  assert.equal(runs.stop(again.run.id), true);
  assert.equal(quiet.at(-1), 'killed');
  off();
  quiet[1].h.onExit({ exitCode: 143 });
  await new Promise((res) => setImmediate(res));
  assert.equal(heard.length, 1, 'unsubscribed');
  // no quiet spawner set up: the launch says so
  const bare = new HarnessRuns({ pty: {}, home: () => '/h', broadcast: () => undefined, afterExit: async () => undefined });
  assert.deepEqual(bare.launch({ kind: 'x', purpose: 'update', via: 'npm', command: 'c', argv: ['c'], quiet: true }), {
    ok: false,
    error: 'spawn',
    message: 'quiet runs are not set up here',
  });
});
