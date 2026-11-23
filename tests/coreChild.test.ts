// electron/platform/coreChild.cjs against a fake core: how a child's events become its streams and what it says back,
// and what only a failing or a Windows core shows. The real children are tests/coreBindingSpawn.test.ts's.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { getSystemErrorMap } from 'node:util';
import { constants } from 'node:buffer';

const require = createRequire(import.meta.url);
const { spawnCore, errorName, specOf, CoreChild } = require('../electron/platform/coreChild.cjs');
const { spawnGroup, endGroup } = require('../electron/platform/winbin.cjs');
const { installProc, spawnOwned, proc } = require('../electron/platform/ports/proc.cjs');

const { MAX_STRING_LENGTH } = constants;
const PIPES = ['pipe', 'pipe', 'pipe'];
const NO_STDERR = ['pipe', 'pipe', 'ignore'];
const HEADER = (kind: number, id: number) => {
  const head = Buffer.alloc(8);
  head[0] = 1;
  head[1] = kind;
  head.writeUIntLE(id, 2, 6);
  return head;
};
const [STDOUT, STDERR, STDOUT_END, STDERR_END, EXIT, INPUT_FAILED, INPUT_DRAINED, CLOSED, LINES, ASK] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
/** Lines in the core's framed layout: eight bytes of length, then the line; `tooLong` ends them as a line past its limit. */
const framed = (lines: string[], tooLong = false) =>
  Buffer.concat([
    ...lines.flatMap((line) => {
      const length = Buffer.alloc(8);
      length.writeUInt32LE(Buffer.byteLength(line));
      return [length, Buffer.from(line)];
    }),
    tooLong ? Buffer.alloc(8, 0xff) : Buffer.alloc(0),
  ]);

/** The fake cores of this file: each child they start ends with the run. */
const cores: { closeAll: () => void }[] = [];
after(() => cores.forEach((core) => core.closeAll()));

/** A core that starts nothing: `reply` answers each route, and what it was told is in `said`. */
function fakeCore(reply: (route: string, payload: Buffer) => any = () => '') {
  const said: [string, string][] = [];
  let listener: (event: Buffer) => void = () => assert.fail('nobody subscribed');
  let next = 1;
  const core = {
    said,
    routes: () => [],
    dispatch: async () => Buffer.alloc(0),
    subscribe: (fn: (event: Buffer) => void) => void (listener = fn),
    dispatchSync(route: string, payload: Buffer) {
      said.push([route, String(payload)]);
      const answer = reply(route, payload);
      if (answer instanceof Error) throw answer;
      if (route === 'proc.spawn' && answer === '')
        return Buffer.from(JSON.stringify({ id: next++, pid: 4242, held: true, cost: 10, ack: 100 }));
      return Buffer.from(typeof answer === 'string' ? answer : JSON.stringify(answer));
    },
    tell: (id: number, kind: number, bytes: string | Buffer = '') => listener(Buffer.concat([HEADER(kind, id), Buffer.from(bytes)])),
    raw: (event: Buffer) => listener(event),
    closeAll() {
      for (let id = 1; id < next; id++) core.tell(id, CLOSED);
    },
  };
  cores.push(core);
  return core;
}

const ticks = () => new Promise((resolve) => setImmediate(resolve));

test('events become its streams, in order, and an event of another domain or child is nobody’s', async () => {
  const core = fakeCore();
  const child = spawnCore('/bin/x', ['a'], { stdio: PIPES }, core);
  const other = spawnCore('/bin/y', [], { stdio: PIPES }, core);
  assert.equal(child.pid, 4242);
  assert.equal(await child.held, true);
  assert.equal(child.id, 1);
  assert.equal(other.id, 2);
  const out: string[] = [];
  child.stdout.on('data', (d: Buffer) => out.push(String(d)));
  child.stderr.setEncoding('utf8').on('data', (d: string) => out.push(`err ${d}`));
  core.tell(1, STDOUT, 'one');
  core.tell(1, STDERR, 'two');
  core.raw(Buffer.from('{"transcript":1}'));
  core.tell(99, STDOUT, 'nobody');
  await ticks();
  assert.deepEqual(out, ['one', 'err two']);
  const order: any[] = [];
  child.on('exit', (...why: any[]) => order.push(['exit', ...why]));
  child.on('close', (...why: any[]) => order.push(['close', ...why]));
  core.tell(1, STDOUT_END);
  core.tell(1, STDERR_END);
  core.tell(1, EXIT, '[null,15]');
  core.tell(1, CLOSED);
  await ticks();
  assert.deepEqual(order, [
    ['exit', null, 'SIGTERM'],
    ['close', null, 'SIGTERM'],
  ]);
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, 'SIGTERM');
  assert.equal(child.stdin.destroyed, true);
  assert.equal(child.stdout.readableEnded, true);
  // the child's handle went with its last event: another event for its id reaches nothing
  core.tell(1, STDOUT, 'late');
  await ticks();
  assert.equal(out.length, 2);
});

test('an exit with no signal names none', async () => {
  const core = fakeCore();
  const child = spawnCore('/bin/x', [], { stdio: NO_STDERR }, core);
  assert.equal(child.stderr, null);
  child.stdout.resume();
  const exit = new Promise((resolve) => child.on('exit', (...why: any[]) => resolve(why)));
  core.tell(child.id, EXIT, '[3,null]');
  assert.deepEqual(await exit, [3, null]);
  core.tell(child.id, STDOUT_END);
  await new Promise((resolve) => child.on('close', resolve));
});

test('what it takes is told to the core in steps, and what the stream won’t hold is told once it is read', async () => {
  const core = fakeCore();
  const child = spawnCore('/bin/x', [], { stdio: PIPES }, core);
  const acks = () => core.said.filter(([route]) => route === 'proc.ack').map(([, payload]) => payload);
  child.stdout.on('data', () => undefined);
  core.tell(1, STDOUT, Buffer.alloc(30));
  await ticks();
  assert.deepEqual(acks(), [], 'not yet worth a call');
  core.tell(1, STDOUT, Buffer.alloc(70));
  assert.deepEqual(acks(), ['1 0 120'], 'the bytes and what each chunk costs');
  child.stdout.pause();
  const page = Buffer.alloc(1 << 20);
  core.tell(1, STDOUT, page);
  core.tell(1, STDOUT, page);
  await ticks();
  assert.equal(acks().length, 1, 'nothing past what the stream holds');
  child.stdout.resume();
  await ticks();
  assert.deepEqual(acks().at(-1), `1 0 ${2 * ((1 << 20) + 10)}`);
  child.stderr.on('data', () => undefined);
  core.tell(1, STDERR, Buffer.alloc(200));
  assert.deepEqual(acks().at(-1), '1 1 210');
  // a stream with room asks for more with nothing held: nothing to tell
  const before = acks().length;
  child.stdout._read();
  assert.equal(acks().length, before);
});

test('stdin goes to the core a write at a time, waits while it is full, and ends once written', async () => {
  const replies = ['0', '1', '0'];
  const core = fakeCore((route) => (route === 'proc.write' ? (replies.shift() as string) : route === 'proc.endInput' ? 'true' : ''));
  const child = spawnCore('/bin/x', [], { stdio: PIPES }, core);
  const written = () => core.said.filter(([route]) => route === 'proc.write').map(([, payload]) => payload);
  child.stdin.write('one\n');
  child.stdin.write(Buffer.from('two\n'));
  child.stdin.write('three\n');
  await ticks();
  assert.deepEqual(written(), ['1\none\n', '1\ntwo\n'], 'the third waits in the stream for the core to have room');
  core.tell(1, INPUT_DRAINED);
  await ticks();
  assert.deepEqual(written().at(-1), '1\nthree\n');
  child.stdin.end();
  await ticks();
  assert.deepEqual(core.said.at(-1), ['proc.endInput', '1']);
  core.tell(1, INPUT_DRAINED);
  // a stream gone: what is told of it changes nothing
  core.tell(1, CLOSED);
});

test('a write held for room is let go when stdin goes, and the core hears stdin end', async () => {
  const core = fakeCore((route) => (route === 'proc.write' ? '1' : ''));
  const child = spawnCore('/bin/x', [], { stdio: PIPES }, core);
  const wrote = new Promise<any>((resolve) => child.stdin.write('held', resolve));
  const ended = new Promise<any>((resolve) => child.stdin.end(resolve));
  await ticks();
  child.stdin.destroy();
  assert.equal((await wrote).code, 'ERR_STREAM_DESTROYED');
  assert.ok(await ended, 'and an end waiting behind it is told too');
  assert.deepEqual(core.said.at(-1), ['proc.closeInput', '1']);
  // gone with an error, the held write takes that error, and nothing goes unhandled but the stream's own
  const second = spawnCore('/bin/x', [], { stdio: PIPES }, core);
  const failed = new Promise<any>((resolve) => second.stdin.once('error', resolve));
  const held = new Promise<any>((resolve) => second.stdin.write('held', resolve));
  await ticks();
  second.stdin.destroy(new Error('stopped'));
  assert.equal((await held).message, 'stopped');
  assert.equal((await failed).message, 'stopped');
  // at an exit too
  const third = spawnCore('/bin/x', [], { stdio: PIPES }, core);
  const last = new Promise<any>((resolve) => third.stdin.write('held', resolve));
  await ticks();
  core.tell(third.id, EXIT, '[1,null]');
  assert.equal((await last).code, 'ERR_STREAM_DESTROYED');
});

test('a destroyed output tells the core what it held, and goes on taking what comes', async () => {
  const core = fakeCore();
  const child = spawnCore('/bin/x', [], { stdio: PIPES }, core);
  const acks = () => core.said.filter(([route]) => route === 'proc.ack').map(([, payload]) => payload);
  core.tell(1, STDOUT, Buffer.alloc(1 << 20));
  await ticks();
  assert.deepEqual(acks(), [], 'held: nothing reads this stream');
  child.stdout.destroy();
  assert.deepEqual(acks(), [`1 0 ${(1 << 20) + 10}`]);
  core.tell(1, STDOUT, Buffer.alloc(5));
  assert.deepEqual(acks().at(-1), '1 0 15', 'at once, whatever the step');
  const closed = new Promise((resolve) => child.on('close', resolve));
  core.tell(1, STDOUT_END);
  core.tell(1, STDERR_END);
  core.tell(1, EXIT, '[0,null]');
  assert.equal(await closed, 0, 'and its close still counts toward the child’s');
});

test('a write the core says has nowhere to go errors the stream, as a closed pipe does', async () => {
  const core = fakeCore((route) => (route === 'proc.write' ? '2' : ''));
  const child = spawnCore('/bin/x', [], { stdio: PIPES }, core);
  const failed = new Promise<any>((resolve) => child.stdin.once('error', resolve));
  child.stdin.write('x');
  const error = await failed;
  assert.equal(error.code, 'EPIPE');
  assert.equal(error.syscall, 'write');
  const [number] = [...getSystemErrorMap()].find(([, [name]]) => name === 'EPIPE') as [number, unknown];
  assert.equal(error.errno, number, "libuv's number, as Node gives it on every platform");
});

test('a write that failed in the core errors stdin with what the system said, or the core’s own words', async () => {
  const core = fakeCore();
  const child = spawnCore('/bin/x', [], { stdio: PIPES }, core);
  const failed = new Promise<any>((resolve) => child.stdin.once('error', resolve));
  core.tell(1, INPUT_FAILED, '[32,"Broken pipe"]');
  const error = await failed;
  assert.equal(error.code, process.platform === 'win32' ? 'UNKNOWN' : 'EPIPE');
  const second = spawnCore('/bin/x', [], { stdio: PIPES }, core);
  const said = new Promise<any>((resolve) => second.stdin.once('error', resolve));
  core.tell(2, INPUT_FAILED, '[null,"no such thing"]');
  assert.equal((await said).message, 'no such thing');
});

test('with no core, or one that refuses, a child fails as one that could not be spawned, saying why', async () => {
  const failure = (child: any) => new Promise<any>((resolve) => child.once('error', resolve));
  const off = spawnCore('/bin/x', [], { stdio: PIPES }, null);
  assert.equal(off.pid, undefined);
  assert.match((await failure(off)).message, /Rust core/);
  const refused = spawnCore(
    '/bin/x',
    [],
    { stdio: NO_STDERR },
    fakeCore((route) => (route === 'proc.spawn' ? new Error('too many child handles open (1024)') : '')),
  );
  assert.match((await failure(refused)).message, /too many child handles/);
  assert.equal(refused.kill(), false, 'nothing to signal');
  const noThreads = spawnCore(
    '/bin/x',
    [],
    { stdio: PIPES },
    fakeCore(() => ({ errno: null, message: 'no more threads' })),
  );
  assert.equal((await failure(noThreads)).message, 'no more threads');
  const stale = spawnCore(
    '/bin/x',
    [],
    { stdio: PIPES },
    fakeCore(() => new Error('no core route proc.spawn')),
  );
  stale.stdout.on('readable', () => stale.stdout.read());
  const closed = new Promise((resolve) => stale.on('close', resolve));
  stale.on('error', () => undefined);
  assert.equal(await closed, -1, 'and closes, with no exit');
});

test('a spawn error Node throws, this throws: with the same words', () => {
  const eisdir = process.platform === 'win32' ? 267 : 21;
  const core = fakeCore(() => ({ errno: eisdir, message: 'a directory' }));
  if (process.platform !== 'win32')
    assert.throws(() => spawnCore('/bin/x', [], { stdio: PIPES }, core), { message: 'spawn EISDIR', code: 'EISDIR', syscall: 'spawn' });
});

test('a signal is its number to the core, once only when it went, and an unknown one throws', () => {
  const answers = ['true', 'false'];
  const core = fakeCore((route) => (route === 'proc.signal' ? (answers.shift() as string) : ''));
  const child = spawnCore('/bin/x', [], { stdio: PIPES }, core);
  assert.equal(child.killed, false);
  assert.equal(child.kill(), true);
  assert.equal(child.killed, true);
  assert.deepEqual(core.said.at(-1), ['proc.signal', '1 15']);
  assert.equal(child.kill(9), false);
  assert.equal(child.killed, true);
  assert.deepEqual(core.said.at(-1), ['proc.signal', '1 9']);
  assert.throws(() => child.kill('SIGNOPE' as any), { code: 'ERR_UNKNOWN_SIGNAL' });
});

test('a framed stdout is the lines the core cut, one chunk a read, charged as the core charged them', async () => {
  const core = fakeCore();
  const child = spawnCore('/bin/x', [], { stdio: PIPES, lines: { maxUnits: 64 } }, core);
  assert.deepEqual(JSON.parse(core.said[0][1]).lines, { limit: 64 });
  const acks = () => core.said.filter(([route]) => route === 'proc.ack').map(([, payload]) => payload);
  const chunks: any[] = [];
  child.stdout.on('data', (chunk: any) => chunks.push(chunk));
  // flowing from the next tick: a read that came before waits in the stream, unacknowledged
  await ticks();
  const bytes = framed(['{"a":1}\r', '', 'x'.repeat(80)]);
  core.tell(1, LINES, bytes);
  core.tell(1, LINES, framed(['last'], true));
  await ticks();
  assert.deepEqual(
    chunks.map((chunk) => ({ lines: chunk.lines.map(String), tooLong: chunk.tooLong })),
    [
      { lines: ['{"a":1}\r', '', 'x'.repeat(80)], tooLong: false },
      { lines: ['last'], tooLong: true },
    ],
  );
  assert.deepEqual(acks(), [`1 0 ${bytes.length + 10}`], 'the event as it came, and what each costs');
  // a paused framed stream holds one read, and acknowledges nothing past it
  child.stdout.pause();
  core.tell(1, LINES, framed(['one']));
  core.tell(1, LINES, framed(['two']));
  await ticks();
  assert.equal(acks().length, 1);
  assert.equal(child.stdout.readableLength, 2);
  child.stdout.resume();
  await ticks();
  assert.equal(acks().length, 2);
  // without `lines` stdout is bytes, and a limit that is not finite is none
  const plain = spawnCore('/bin/y', [], { stdio: PIPES }, core);
  assert.equal(plain.stdout.readableObjectMode, false);
  assert.equal(JSON.parse(core.said.filter(([route]) => route === 'proc.spawn').at(-1)![1]).lines, null);
  spawnCore('/bin/z', [], { stdio: PIPES, lines: {} }, core);
  assert.deepEqual(JSON.parse(core.said.filter(([route]) => route === 'proc.spawn').at(-1)![1]).lines, { limit: MAX_STRING_LENGTH });
});

test('a framed line that fills the window is wanted, by its ask, once stdout is read; a destroyed one is dropped', async () => {
  const core = fakeCore();
  const said = (name: string) => core.said.filter(([route]) => route === name).map(([, payload]) => payload);
  const ask = (n: number) => {
    const bytes = Buffer.alloc(8);
    bytes.writeBigUInt64LE(BigInt(n));
    core.tell(1, ASK, bytes);
  };
  // nobody reads it: the core is told nothing, so the line costs it a window
  const child = spawnCore('/bin/x', [], { stdio: PIPES, lines: {} }, core);
  ask(1);
  await ticks();
  assert.deepEqual(said('proc.want'), []);
  // read now: the line it asked about is wanted, once, by its ask
  const chunks: any[] = [];
  child.stdout.on('data', (chunk: any) => chunks.push(chunk));
  await ticks();
  assert.deepEqual(said('proc.want'), ['1 1']);
  // a stream that is being read wants the next long line at once
  ask(2);
  assert.deepEqual(said('proc.want'), ['1 1', '1 2']);
  // a chunk satisfies what it asked for: paused with one read waiting, the next long line waits too
  child.stdout.pause();
  core.tell(1, LINES, framed(['one']));
  ask(3);
  await ticks();
  assert.deepEqual(said('proc.want'), ['1 1', '1 2']);
  // what came after an ask overtakes it: a later read wants nothing nobody asks for now
  core.tell(1, LINES, framed(['two']));
  child.stdout.resume();
  await ticks();
  assert.deepEqual(said('proc.want'), ['1 1', '1 2']);
  // a destroyed stream tells the core to drop it all, and wants nothing
  child.stdout.destroy();
  ask(4);
  assert.deepEqual(said('proc.want'), ['1 1', '1 2']);
  assert.deepEqual(said('proc.drop'), ['1']);
  // a child that never started has nothing to drop
  const none = spawnCore('/bin/x', [], { stdio: PIPES, lines: {} }, null);
  none.on('error', () => undefined);
  none.stdout.destroy();
  await ticks();
  assert.deepEqual(said('proc.drop'), ['1']);
});

test('a spawn is what spawnArgs asked for: strings, unset variables gone, and nothing a process cannot be given', () => {
  const spec = specOf('/bin/x', ['a'], {
    stdio: PIPES,
    env: { A: '1', B: undefined, C: 2 },
    cwd: '/w',
    detached: true,
    windowsHide: true,
    windowsVerbatimArguments: true,
  });
  assert.deepEqual(spec, {
    command: '/bin/x',
    args: ['a'],
    cwd: '/w',
    env: [
      ['A', '1'],
      ['C', '2'],
    ],
    stderr: true,
    group: true,
    hide: true,
    verbatim: true,
    lines: null,
  });
  assert.equal(specOf('x', [], { stdio: PIPES, env: {}, cwd: null }).cwd, null, 'no directory, as undefined is');
  assert.equal(specOf('x', [], { stdio: PIPES, env: {}, cwd: '' }).cwd, null, 'nor is an empty one a directory, as in Node');
  const quiet = specOf('x', [], { stdio: NO_STDERR, env: {} });
  assert.deepEqual([quiet.cwd, quiet.stderr, quiet.group, quiet.hide, quiet.verbatim], [null, false, false, false, false]);
  assert.ok(
    specOf('x', [], { stdio: PIPES }).env.some(([name]: string[]) => name === 'PATH' || name === 'Path'),
    'no env is this process’s',
  );
  assert.deepEqual(specOf('x', ['\ud83d'], { stdio: PIPES, env: {} }).args, ['�'], 'a lone surrogate, as Node would pass it');
  for (const stdio of [undefined, ['ignore', 'pipe', 'pipe'], ['pipe', 'ignore', 'pipe'], ['pipe', 'pipe', 'inherit']])
    assert.throws(() => specOf('x', [], { stdio, env: {} }), TypeError);
  assert.throws(() => specOf('a\0b', [], { stdio: PIPES, env: {} }), { code: 'ERR_INVALID_ARG_VALUE' });
  assert.throws(() => specOf('x', ['a\0b'], { stdio: PIPES, env: {} }), /args\[0\]/);
  assert.throws(() => specOf('x', [], { stdio: PIPES, env: { A: 'a\0b' } }), /options\.env\['A'\]/);
});

test('on Windows a variable’s name has no case: the first of each in sorted order goes, as Node passes them', () => {
  const env = { Path: 'second', PATH: 'first', Other: 'x', path: 'third' };
  assert.deepEqual(specOf('x', [], { stdio: PIPES, env }, 'win32').env, [
    ['Other', 'x'],
    ['PATH', 'first'],
  ]);
  assert.equal(specOf('x', [], { stdio: PIPES, env }, 'linux').env.length, 4);
});

test('an error’s name is Node’s, on either platform', () => {
  assert.equal(errorName(2, 'win32'), 'ENOENT');
  assert.equal(errorName(267, 'win32'), 'ENOENT');
  assert.equal(errorName(5, 'win32'), 'EPERM');
  // a file that is no program (ERROR_BAD_EXE_FORMAT): Node's spawn says EFTYPE, as libuv names it
  assert.equal(errorName(193, 'win32'), 'EFTYPE');
  assert.equal(errorName(1234, 'win32'), 'UNKNOWN');
  if (process.platform !== 'win32') assert.equal(errorName(2), 'ENOENT');
});

test('spawnGroup treats a child of the core as a real one, and on Windows takes the hold its spawn made', async () => {
  const real = process.platform;
  const core = fakeCore();
  const spawn = (command: string, args: string[], options: object) => spawnCore(command, args, options, core);
  const child = spawnGroup(spawn, '/bin/x', [], { stdio: PIPES, env: {} }, (b: string, a: string[], o: object) => [b, a, o]);
  assert.ok(child instanceof CoreChild);
  assert.equal(child.group, true);
  assert.ok(child.watch);
  try {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const held = spawnGroup(spawn, '/bin/x', [], { stdio: PIPES, env: {} }, (b: string, a: string[], o: object) => [b, a, o]);
    assert.equal(await held.job, true);
    assert.equal(typeof (endGroup(held) as Promise<boolean>).then, 'function');
  } finally {
    Object.defineProperty(process, 'platform', { value: real, configurable: true });
  }
  child.watch.stop();
  const failed = spawnGroup(
    (command: string, args: string[], options: object) => spawnCore(command, args, options, null),
    '/bin/x',
    [],
    { stdio: PIPES, env: {} },
    (b: string, a: string[], o: object) => [b, a, o],
  );
  failed.on('error', () => undefined);
  assert.equal(failed.group, undefined);
  await ticks();
});

test('a harness process comes from the core, unless the port behind it says otherwise', () => {
  const previous = installProc({ spawn: () => 'the fake' });
  try {
    assert.equal(spawnOwned('/bin/x', [], {}), 'the fake');
    installProc({ spawn: () => 'node', spawnOwned: () => 'its own' });
    assert.equal(spawnOwned('/bin/x', [], {}), 'its own');
    assert.equal(proc.spawn(), 'node');
    installProc(null);
    assert.equal(proc.spawn, require('node:child_process').spawn, 'the real port is node:child_process underneath');
    assert.throws(() => spawnOwned('/bin/x', [], {}), TypeError, 'the core’s spawn asks for pipes');
  } finally {
    installProc(previous);
  }
});
