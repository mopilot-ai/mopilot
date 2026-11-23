// src/session/harness/harnessRuns.ts: main's install runs as a window follows them, the harness looked for again once per
// ended run (per family), a Re-check per family, and a terminal view attached to a run main owns.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const calls: any[] = [];
let onState: ((runs: any[]) => void) | null = null;
let onData: ((e: any) => void) | null = null;
let listed: any = Promise.resolve([]);
let tools: any = Promise.resolve({ npm: true, brew: false, npmWritable: true });
let attached: any = null;
let failClaude: unknown = null;
installNativeStub({
  harnessRuns: {
    onState: (cb: any) => ((onState = cb), () => undefined),
    onData: (cb: any) => ((onData = cb), () => calls.push(['offData'])),
    list: () => listed,
    tools: () => tools,
    attach: (id: string) => (calls.push(['attach', id]), attached),
    write: (id: string, d: string) => calls.push(['write', id, d]),
    resize: (id: string, c: number, r: number) => calls.push(['resize', id, c, r]),
  },
});
// restartCodex: main restarts Codex's app-server, then the window connects; after a run main already restarted it
let conn: { conn: string; connError: string | null } = { conn: 'ready', connError: null };
stubStore({
  connect: async () => calls.push(['connect']),
  restartCodex: async () => (calls.push(['restart']), calls.push(['connect'])),
  getState: () => conn,
});
mock.module('../src/session/harness/claude.ts', {
  namedExports: {
    detectClaude: async (force: boolean) => {
      calls.push(['detectClaude', force]);
      if (failClaude) throw failClaude;
    },
    recheckClaude: async (_account?: string, say?: unknown) => calls.push(say ? ['recheckClaude', 'its say'] : ['recheckClaude']),
  },
});
mock.module('../src/session/harness/acp.ts', { namedExports: { recheckBasic: async (id: string) => calls.push(['recheckBasic', id]) } });
const { followHarnessRuns, recheckHarness, refreshInstallTools, runTransport, useHarnessRuns } = await import(
  '../src/session/harness/harnessRuns.ts'
);

const tick = () => new Promise((r) => setTimeout(r, 0));
const run = (over: any) => ({ id: 'r1', kind: 'acp:kimi', state: 'running', checked: false, ...over });

test('Re-check looks for a harness again per family', async () => {
  calls.length = 0;
  await recheckHarness('codex');
  await recheckHarness('claude');
  await recheckHarness('acp:gemini');
  assert.deepEqual(calls, [['restart'], ['connect'], ['detectClaude', true], ['recheckClaude'], ['recheckBasic', 'gemini']]);
});

test("Codex's re-check says why it couldn't start where it was asked; unasked, it stays quiet as before (#2034)", async () => {
  const said: unknown[][] = [];
  const say = (...a: unknown[]) => said.push(a);
  await recheckHarness('codex', say);
  assert.deepEqual(said, []);
  conn = { conn: 'error', connError: 'spawn codex ENOENT' };
  await recheckHarness('codex', say);
  await recheckHarness('codex');
  // in a sentence (shared/userError.mjs), not the raw spawn error
  assert.deepEqual(said, [['File or program not found.', 'error']]);
  conn = { conn: 'ready', connError: null };
  // Claude Code says its own words to it
  calls.length = 0;
  await recheckHarness('claude', say);
  assert.deepEqual(calls.at(-1), ['recheckClaude', 'its say']);
});

test('runs that ended before the window opened were detected with it; a run checked later is looked after once, per family', async () => {
  calls.length = 0;
  listed = Promise.resolve([run({ id: 'old', state: 'exited', checked: true }), run({ id: 'live' })]);
  followHarnessRuns();
  await tick();
  assert.deepEqual(useHarnessRuns.getState().settled, { old: true });
  assert.equal(useHarnessRuns.getState().runs.length, 2);
  assert.deepEqual(calls, []);
  // the window's own look-again: Codex reconnects (main restarted it), Claude Code is detected, a basic one was checked in main
  onState!([
    run({ id: 'old', state: 'exited', checked: true }),
    run({ id: 'c', kind: 'codex', state: 'exited', checked: true }),
    run({ id: 'cl', kind: 'claude', state: 'exited', checked: true }),
    run({ id: 'k', kind: 'acp:kimi', state: 'exited', checked: true }),
    run({ id: 'not-yet', state: 'exited', checked: false }),
  ]);
  await tick();
  assert.deepEqual(calls, [['connect'], ['detectClaude', true], ['recheckClaude']]);
  assert.deepEqual(Object.keys(useHarnessRuns.getState().settled).sort(), ['c', 'cl', 'k', 'old']);
  // the same list again looks after nothing twice
  calls.length = 0;
  onState!(useHarnessRuns.getState().runs);
  await tick();
  assert.deepEqual(calls, []);
  // results main dropped are forgotten here too
  onState!([run({ id: 'k', kind: 'acp:kimi', state: 'exited', checked: true })]);
  assert.deepEqual(useHarnessRuns.getState().settled, { k: true });
});

test('a look-again that fails still settles the run: its result shows what detection says', async () => {
  calls.length = 0;
  failClaude = new Error('detect failed');
  onState!([run({ id: 'cl2', kind: 'claude', state: 'exited', checked: true })]);
  await tick();
  failClaude = null;
  assert.equal(useHarnessRuns.getState().settled.cl2, true);
});

test('a list that fails to load leaves the runs main pushes', async () => {
  listed = Promise.reject(new Error('no main'));
  followHarnessRuns();
  await tick();
  assert.equal(useHarnessRuns.getState().runs.length, 1);
});

test('what the install lines need is asked of main; a failed ask keeps the last answer', async () => {
  refreshInstallTools();
  await tick();
  assert.deepEqual(useHarnessRuns.getState().tools, { npm: true, brew: false, npmWritable: true });
  tools = Promise.reject(new Error('gone'));
  refreshInstallTools();
  await tick();
  assert.deepEqual(useHarnessRuns.getState().tools, { npm: true, brew: false, npmWritable: true });
});

test('an attached view gets the kept output, then each later byte once, and leaves the run going when it closes', async () => {
  calls.length = 0;
  const got: string[] = [];
  const errors: string[] = [];
  let resolve!: (a: any) => void;
  attached = new Promise((r) => (resolve = r));
  const io = runTransport('r1')(
    { id: 'r1', cwd: '', title: '' },
    { cols: 90, rows: 12 },
    {
      data: (d: string) => got.push(d),
      exit: () => assert.fail('a run ends through its run list'),
      error: (m: string) => errors.push(m),
    },
  );
  // output that arrives before the kept output is read waits for it
  onData!({ id: 'r1', data: 'cd', end: 4 });
  onData!({ id: 'other', data: 'zz', end: 2 });
  resolve({ run: run({}), output: 'abc', end: 3 });
  await tick();
  // 'cd' overlapped the kept 'abc' by one character
  assert.deepEqual(got, ['abc', 'd']);
  onData!({ id: 'r1', data: 'd', end: 4 });
  onData!({ id: 'r1', data: 'ef', end: 6 });
  assert.deepEqual(got, ['abc', 'd', 'ef']);
  io.write('y');
  io.resize(100, 30);
  io.close();
  assert.deepEqual(calls, [['attach', 'r1'], ['resize', 'r1', 90, 12], ['write', 'r1', 'y'], ['resize', 'r1', 100, 30], ['offData']]);
  assert.deepEqual(errors, []);
});

test("a view onto a run that's gone, or that fails to attach, says so; one closed first says nothing", async () => {
  const errors: string[] = [];
  const on = { data: () => undefined, exit: () => undefined, error: (m: string) => errors.push(m) };
  attached = Promise.resolve(null);
  runTransport('gone')({ id: 'gone', cwd: '', title: '' }, { cols: 1, rows: 1 }, on);
  await tick();
  attached = Promise.reject(new Error('IPC down'));
  runTransport('x')({ id: 'x', cwd: '', title: '' }, { cols: 1, rows: 1 }, on);
  await tick();
  assert.deepEqual(errors, ['This run has ended', 'IPC down']);
  attached = Promise.resolve({ run: run({}), output: 'late', end: 4 });
  runTransport('y')({ id: 'y', cwd: '', title: '' }, { cols: 1, rows: 1 }, on).close();
  attached = Promise.reject(new Error('late failure'));
  runTransport('z')({ id: 'z', cwd: '', title: '' }, { cols: 1, rows: 1 }, on).close();
  await tick();
  assert.deepEqual(errors, ['This run has ended', 'IPC down']);
});

test('anything but a list from main is no answer: the window keeps what it has', async () => {
  const before = useHarnessRuns.getState().runs;
  onState!(undefined as any);
  listed = Promise.resolve({});
  followHarnessRuns();
  await tick();
  assert.equal(useHarnessRuns.getState().runs, before);
});
