// A harness child the core owns, through the built addon (core/crates/proc/src/spawn.rs, electron/platform/coreChild.cjs):
// real processes, and for what must stay as it was, the same spawn through node:child_process beside it. Needs a built
// addon, and is skipped without one unless MOPILOT_CORE_REQUIRED says the run must have it.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import diagnostics from 'node:diagnostics_channel';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { waitFor } from './support/waitFor.ts';

const require = createRequire(import.meta.url);
const { corePath, loadCore } = require('../electron/platform/core.cjs');
const { spawnCore } = require('../electron/platform/coreChild.cjs');
const { spawnGroup, killTree, endGroup } = require('../electron/platform/winbin.cjs');
const { JsonReader } = require('../electron/transport/jsonReader.cjs');

const addon = loadCore(corePath());
const required = process.env.MOPILOT_CORE_REQUIRED === '1';
const skip = !addon?.routes().includes('proc.spawn') && !required && `no Rust core with proc.spawn built at ${corePath()}`;
const posixOnly = skip || (process.platform === 'win32' && 'POSIX');

const PIPES = ['pipe', 'pipe', 'pipe'];
const started = new Set<any>();
afterEach(() => {
  for (const child of started) child.kill('SIGKILL');
  started.clear();
});

/** A node child running `script`, as a harness is started. */
function node(script: string, options: object = {}, spawn: any = spawnCore) {
  const child: any = spawnGroup(spawn, process.execPath, ['-e', script], { stdio: PIPES, env: process.env, ...options });
  started.add(child);
  return child;
}

const exited = (child: any) => new Promise<[number | null, string | null]>((resolve) => child.once('exit', (...why: any) => resolve(why)));
const closed = (child: any) => new Promise<[number | null, string | null]>((resolve) => child.once('close', (...why: any) => resolve(why)));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Everything `stream` says, and what happened in what order around it. */
function collect(stream: any) {
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  return { text: () => String(Buffer.concat(chunks)), bytes: () => Buffer.concat(chunks) };
}

test('output comes whole and in order, stdin keeps its order, and the exit comes behind the last byte', { skip }, async () => {
  const script = `
    let seen = '';
    process.stdin.setEncoding('utf8').on('data', (d) => (seen += d));
    process.stdin.on('end', () => {
      const lines = seen.split('\\n').filter(Boolean);
      process.stderr.write('lines ' + lines.length + '\\n');
      process.stdout.write(lines.join('\\n') + '\\n', () => process.exit(5));
    });`;
  const child = node(script);
  const order: string[] = [];
  const out = collect(child.stdout);
  let err = '';
  child.stderr.setEncoding('utf8').on('data', (text: string) => (err += text));
  child.stdout.on('end', () => order.push('stdout end'));
  child.on('exit', (code: number, signal: string) => order.push(`exit ${code} ${signal} after ${out.bytes().length}`));
  const expected = Array.from({ length: 5000 }, (_, i) => `line ${i}`);
  for (const line of expected) child.stdin.write(`${line}\n`);
  child.stdin.end();
  assert.deepEqual(await closed(child), [5, null]);
  assert.equal(out.text(), `${expected.join('\n')}\n`);
  assert.equal(err, 'lines 5000\n');
  assert.equal(order.at(-1), `exit 5 null after ${out.bytes().length}`);
  assert.equal(child.exitCode, 5);
  assert.equal(child.signalCode, null);
  assert.ok(child.pid > 1);
  assert.equal(child.group, true);
});

test('the reader Codex uses takes a record too long for one read, and the exit behind it', { skip }, async () => {
  const child = node(
    `process.stdout.write(JSON.stringify({ text: 'é'.repeat(1 << 19) }) + '\\n' + JSON.stringify({ last: true }) + '\\n')`,
    { lines: {} },
  );
  const values: any[] = [];
  const reader = new JsonReader({ stream: child.stdout, onValue: (value: any) => values.push(value), onError: assert.fail });
  child.stdout.on('data', (chunk: any) => reader.push(chunk));
  await new Promise<void>((resolve) => child.on('exit', () => reader.finishInput(resolve)));
  assert.equal(values.length, 2);
  assert.equal(values[0].text.length, 1 << 19);
  assert.deepEqual(values[1], { last: true });
});

test('a binary that is not there fails as Node says it: the same error, then a close and no exit', { skip }, async () => {
  const run = (spawn: any) =>
    new Promise<any>((resolve) => {
      const child = spawn('mopilot-no-such-binary', ['--flag'], { stdio: PIPES, env: { PATH: '/nowhere' } });
      assert.equal(child.pid, undefined);
      assert.ok(child.stdin && child.stdout && child.stderr, 'its streams are there to attach to');
      const events: string[] = [];
      let error: any;
      child.on('exit', () => events.push('exit'));
      child.on('error', (e: any) => {
        events.push('error');
        error = e;
      });
      child.on('close', (...why: any) => {
        events.push('close');
        resolve({
          events,
          why,
          message: error.message,
          code: error.code,
          syscall: error.syscall,
          path: error.path,
          spawnargs: error.spawnargs,
          destroyed: child.stdin.destroyed,
        });
      });
    });
  assert.deepEqual(await run(spawnCore), await run(childProcess.spawn));
});

test('what no process could run fails as Node says it, on POSIX', { skip: posixOnly }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-spawn-'));
  const text = path.join(dir, 'text');
  fs.writeFileSync(text, 'not a program', { mode: 0o644 });
  const script = path.join(dir, 'script');
  fs.writeFileSync(script, 'exit 7\n', { mode: 0o755 });
  const failure = (spawn: any, ...args: any[]) =>
    new Promise<any>((resolve) => {
      try {
        const child = spawn(...args);
        child.on('error', (e: any) => resolve([e.code, e.message, e.syscall, e.path]));
        // a script with no #! runs where a platform falls back to a shell for it, and is refused alike where it doesn't
        child.on('exit', (code: number) => resolve(['ran', code]));
      } catch (e: any) {
        resolve(['thrown', e.code, e.message, e.syscall]);
      }
    });
  const cases: any[][] = [
    [text, [], { stdio: PIPES, env: {} }],
    ['/bin/sh', [], { stdio: PIPES, env: {}, cwd: path.join(dir, 'gone') }],
    ['/bin/sh', [], { stdio: PIPES, env: {}, cwd: text }],
    ['/bin/sh', ['a\0b'], { stdio: PIPES, env: {} }],
    ['text', [], { stdio: PIPES, env: { PATH: `/nowhere:${dir}` } }],
    ['sh', [], { stdio: PIPES, env: { PATH: '/bin' }, cwd: path.join(dir, 'gone') }],
    [script, [], { stdio: PIPES, env: {} }],
  ];
  for (const args of cases)
    assert.deepEqual(await failure(spawnCore, ...args), await failure(childProcess.spawn, ...args), String(args[0]));
});

/** What a spawn that can't start says, through `spawn`: its error's code and syscall, or that it ran. */
const startFailure = (spawn: any, ...args: any[]) =>
  new Promise<any>((resolve) => {
    try {
      const child = spawn(...args);
      child.on('error', (e: any) => resolve([e.code, e.syscall]));
      child.on('exit', (code: number) => resolve(['ran', code]));
    } catch (e: any) {
      resolve(['thrown', e.code, e.syscall]);
    }
  });

test('a pinned path that is a folder or quoted fails as Node says it, on every platform', { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-spawn-'));
  // a folder (Windows: not found, as libuv's search skips one; POSIX: EACCES) and a quoted path (Explorer's Copy as path)
  for (const bin of [dir, `"${path.join(dir, 'codex.exe')}"`])
    assert.deepEqual(
      await startFailure(spawnCore, bin, [], { stdio: PIPES, env: {} }),
      await startFailure(childProcess.spawn, bin, [], { stdio: PIPES, env: {} }),
      bin,
    );
});

test('what no process could run fails as Node says it, on Windows', {
  skip: skip || (process.platform !== 'win32' && 'Windows'),
}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-spawn-'));
  // a file that is no program, under a name Node's search takes as it is (EFTYPE both ways)
  const empty = path.join(dir, 'empty.exe');
  fs.writeFileSync(empty, '');
  for (const bin of [path.join(dir, 'missing.exe'), empty])
    assert.deepEqual(
      await startFailure(spawnCore, bin, [], { stdio: PIPES, env: {} }),
      await startFailure(childProcess.spawn, bin, [], { stdio: PIPES, env: {} }),
      bin,
    );
  // a folder `codex` with codex.exe beside it runs codex.exe, both ways (the core's folder check leaves it to the spawn)
  fs.mkdirSync(path.join(dir, 'codex'));
  fs.copyFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'), path.join(dir, 'codex.exe'));
  const ran = await startFailure(spawnCore, path.join(dir, 'codex'), ['/d', '/c', 'exit 3'], { stdio: PIPES, env: {} });
  assert.deepEqual(ran, ['ran', 3]);
  assert.deepEqual(ran, await startFailure(childProcess.spawn, path.join(dir, 'codex'), ['/d', '/c', 'exit 3'], { stdio: PIPES, env: {} }));
});

test('a program looked up by name is found on the PATH the child is given, not this process’s', { skip: posixOnly }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-spawn-'));
  fs.writeFileSync(path.join(dir, 'mopilot-only-here'), '#!/bin/sh\necho "$0 $1"\n', { mode: 0o755 });
  const child = spawnCore('mopilot-only-here', ['arg'], { stdio: PIPES, env: { PATH: dir } });
  const out = collect(child.stdout);
  await closed(child);
  assert.equal(out.text(), `${path.join(dir, 'mopilot-only-here')} arg\n`);
});

test('its environment is the one it is given, undefined is unset, and it runs where it is told', { skip }, async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-spawn-')));
  const env = { PATH: process.env.PATH, Path: process.env.Path, SystemRoot: process.env.SystemRoot, ONE: '1', NOT_THERE: undefined };
  const child = node(
    `console.log(JSON.stringify({ one: process.env.ONE, not: 'NOT_THERE' in process.env, here: process.cwd(), home: process.env.HOME ?? null }))`,
    { env, cwd: dir },
  );
  const out = collect(child.stdout);
  await closed(child);
  assert.deepEqual(JSON.parse(out.text()), { one: '1', not: false, here: dir, home: null });
});

test('a child leads a group of its own, and a signal Node ignores for itself ends it', { skip: posixOnly }, async () => {
  const script = `console.log(require('child_process').execSync('ps -o pgid= -p ' + process.pid).toString().trim())`;
  const child = node(script);
  const out = collect(child.stdout);
  await closed(child);
  assert.equal(Number(out.text()), child.pid);
  // a shell can't undo a signal ignored when it started, so this only ends it if the child started with the default
  const shell = spawnCore('sh', ['-c', 'kill -XFSZ $$; echo survived'], { stdio: PIPES, env: process.env, detached: true });
  const said = collect(shell.stdout);
  const [, signal] = await closed(shell);
  assert.equal(signal, 'SIGXFSZ', said.text());
});

test('its stdio is what libuv gives a child: sockets, on POSIX', { skip: posixOnly }, async () => {
  const script = `const fs = require('fs'); console.log([0, 1, 2].map((fd) => fs.fstatSync(fd).isSocket()).join())`;
  const child = node(script);
  const out = collect(child.stdout);
  await closed(child);
  assert.equal(out.text(), 'true,true,true\n');
});

test('a child announces itself to the performance probe, and says it started', { skip }, async () => {
  const seen: any[] = [];
  const heard = (message: any) => seen.push(message.process);
  diagnostics.subscribe('child_process', heard);
  const child = node('');
  await new Promise((resolve) => child.once('spawn', resolve));
  diagnostics.unsubscribe('child_process', heard);
  assert.deepEqual(seen, [child]);
  assert.equal(child.spawnfile, process.execPath);
  assert.deepEqual(child.spawnargs, [process.execPath, '-e', '']);
  await closed(child);
});

test('killTree ends the child and what it runs in other groups, and marks it stopped', { skip: posixOnly }, async () => {
  const script = `
    const c = require('child_process').spawn('sleep', ['30'], { stdio: 'ignore', detached: true });
    console.log(c.pid);
    setInterval(() => {}, 1000);`;
  const child = node(script);
  const command = await new Promise<number>((resolve) => child.stdout.once('data', (d: Buffer) => resolve(Number(String(d)))));
  killTree(child);
  assert.equal(child.stopped, true);
  assert.deepEqual(await exited(child), [null, 'SIGTERM']);
  await waitFor(() => !alive(command));
  assert.equal(child.killed, false, 'its group went by signals of killTree’s own');
  assert.equal(child.kill(), false, 'and it is signalled no more');
});

test('endGroup ends what a child that exited left running in its group', { skip: posixOnly }, async () => {
  const script = `
    const c = require('child_process').spawn('sleep', ['30'], { stdio: 'ignore' });
    console.log(c.pid);
    setTimeout(() => process.exit(0), 100);`;
  const child = node(script);
  const command = await new Promise<number>((resolve) => child.stdout.once('data', (d: Buffer) => resolve(Number(String(d)))));
  child.on('exit', () => endGroup(child));
  await exited(child);
  await waitFor(() => !alive(command));
});

test('a process that outlives the child holds stdout open, and not the exit; finishInput waits for the end', {
  skip: posixOnly,
}, async () => {
  const script = `
    require('child_process').spawn('sh', ['-c', 'sleep 1; echo late'], { stdio: ['ignore', 'inherit', 'ignore'], detached: true });
    process.stdout.write('{"first":1}\\n', () => process.exit(0));`;
  const child = node(script, { lines: {} });
  const values: any[] = [];
  const reader = new JsonReader({
    stream: child.stdout,
    onValue: (value: any) => values.push(value),
    onError: assert.fail,
    onInvalid: () => values.push('invalid'),
  });
  child.stdout.on('data', (chunk: any) => reader.push(chunk));
  const started = Date.now();
  await exited(child);
  assert.ok(Date.now() - started < 900, 'the exit did not wait for it');
  assert.equal(child.stdout.readableEnded, false);
  await new Promise<void>((resolve) => reader.finishInput(resolve));
  assert.deepEqual(values, [{ first: 1 }, 'invalid']);
});

test('a write to a child that closed its stdin errors the stream, and neither blocks nor throws', { skip: posixOnly }, async () => {
  const child = node(`require('fs').closeSync(0); console.log('closed'); setInterval(() => {}, 1000)`);
  await new Promise((resolve) => child.stdout.once('data', resolve));
  const failed = new Promise<any>((resolve) => child.stdin.once('error', resolve));
  child.stdin.write('hello');
  const error = await failed;
  assert.equal(error.code, 'EPIPE');
  assert.equal(error.message, 'write EPIPE');
  assert.equal(child.stdin.destroyed, true);
});

test('a write to a child that exited goes nowhere, quietly', { skip }, async () => {
  const child = node('');
  const done = closed(child);
  await exited(child);
  const late = await new Promise<any>((resolve) => child.stdin.write('late', resolve));
  assert.equal(late.code, 'ERR_STREAM_DESTROYED');
  await done;
});

test('a child that does not read stalls nothing here: main goes on, and its stream reports the backlog', { skip }, async () => {
  const child = node(`setInterval(() => {}, 1000)`);
  // what is still queued fails as the child dies, as every harness's stdin allows for: as EPIPE, however the socket said it
  const failures: string[] = [];
  child.stdin.on('error', (error: any) => failures.push(error.code));
  const stdinClosed = new Promise((resolve) => child.stdin.once('close', resolve));
  const page = Buffer.alloc(1 << 20, 'x');
  const start = performance.now();
  let took = 0;
  for (let i = 0; i < 16; i++) {
    took = child.stdin.write(page) ? took : i;
  }
  assert.ok(performance.now() - start < 1000, 'queued, not written');
  assert.ok(took > 0, 'write said to wait');
  assert.ok(child.stdin.writableLength > 0, 'and what the core would not take stays in the stream');
  child.kill('SIGKILL');
  await exited(child);
  await stdinClosed;
  assert.ok(
    failures.every((code) => code === 'EPIPE'),
    failures.join(),
  );
});

test('long output with nothing reading stops at a bound, and all of it comes once read', { skip }, async () => {
  const size = 48 << 20;
  const script = `
    const block = Buffer.alloc(1 << 20, 'ab');
    let left = ${size >> 20};
    const go = () => { while (left > 0) { left--; if (!process.stdout.write(block)) return process.stdout.once('drain', go); } };
    go();`;
  const child = node(script);
  child.stderr.resume();
  await new Promise((resolve) => setTimeout(resolve, 600));
  const rss = process.memoryUsage().rss;
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(process.memoryUsage().rss - rss < 16 << 20, 'nothing piles up here while nobody reads');
  assert.ok(child.stdout.readableLength <= 2 << 20, `${child.stdout.readableLength} bytes waited`);
  const hash = createHash('sha256');
  let got = 0;
  child.stdout.on('data', (chunk: Buffer) => {
    hash.update(chunk);
    got += chunk.length;
  });
  await closed(child);
  assert.equal(got, size);
  assert.equal(hash.digest('hex'), createHash('sha256').update(Buffer.alloc(size, 'ab')).digest('hex'));
});

test('a paused stream holds the child back, and its exit is told all the same; what is unread is flushed', { skip }, async () => {
  const child = node(`process.stdout.write(Buffer.alloc(8 << 20, 'x'))`);
  child.stderr.resume();
  let got = 0;
  child.stdout.on('data', (chunk: Buffer) => (got += chunk.length));
  child.stdout.pause();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(child.exitCode, null, 'it can’t finish a write nobody takes');
  const done = closed(child);
  child.kill('SIGKILL');
  await exited(child);
  assert.equal(child.stdout.isPaused(), false, 'a stream nobody reads by hand is resumed at the exit, as Node does');
  await done;
  assert.ok(got > 0 && got < 8 << 20, `${got}`);
});

test('a live child holds its process open, as a ChildProcess does', { skip: !addon }, () => {
  const script = `
    const { spawnCore } = require(${JSON.stringify(require.resolve('../electron/platform/coreChild.cjs'))});
    const child = spawnCore(process.execPath, ['-e', 'setTimeout(() => {}, 200)'], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.on('exit', (code) => console.log('exit', code));`;
  const run = childProcess.spawnSync(process.execPath, ['--no-warnings', '-e', script], {
    encoding: 'utf8',
    timeout: 20_000,
    env: { ...process.env, MOPILOT_CORE: corePath() },
  });
  assert.equal(run.stdout, 'exit 0\n', run.stderr);
});

test('an environment that ends with its child running closes its stdin, and the child is reaped', { skip }, async () => {
  const code = `
    const { parentPort, workerData } = require('node:worker_threads');
    const { spawnCore } = require(workerData.module);
    const child = spawnCore(workerData.node, ['-e', 'process.stdin.resume().on("end", () => process.exit(0))'], { stdio: ['pipe', 'pipe', 'pipe'] });
    parentPort.postMessage(child.pid);`;
  const worker = new Worker(code, {
    eval: true,
    workerData: { module: require.resolve('../electron/platform/coreChild.cjs'), node: process.execPath },
  });
  const pid = await new Promise<number>((resolve) => worker.once('message', resolve));
  assert.ok(alive(pid));
  await worker.terminate();
  await waitFor(() => !alive(pid));
});

test('stdin ended with much queued still reaches the child whole', { skip }, async () => {
  const child = node(`let n = 0; process.stdin.on('data', (d) => (n += d.length)).on('end', () => console.log(n))`);
  child.stdin.on('error', assert.fail);
  const out = collect(child.stdout);
  const page = Buffer.alloc(1 << 20, 'x');
  for (let i = 0; i < 32; i++) child.stdin.write(page);
  child.stdin.end();
  await closed(child);
  assert.equal(out.text(), `${32 << 20}\n`);
});

test('stdin destroyed ends the child’s read now, with what is queued dropped', { skip }, async () => {
  const child = node(`process.stdin.resume().on('end', () => console.log('eof'))`);
  const out = collect(child.stdout);
  child.stdin.destroy();
  assert.deepEqual(await closed(child), [0, null]);
  assert.equal(out.text(), 'eof\n');
});

test('a write stuck behind a child that never reads is told when the child goes', { skip }, async () => {
  const child = node(`setInterval(() => {}, 1000)`);
  child.stdin.on('error', () => undefined);
  const page = Buffer.alloc(4 << 20, 'x');
  const told = new Promise<any>((resolve) => child.stdin.write(page, () => child.stdin.write(page, resolve)));
  const ended = new Promise<any>((resolve) => child.stdin.end(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  child.kill('SIGKILL');
  assert.ok(await told, 'the write’s callback came, with an error');
  assert.ok(await ended);
});

test('stdout destroyed leaves nothing stuck: the child runs to its end, and its close comes', { skip }, async () => {
  const child = node(`process.stdout.write(Buffer.alloc(8 << 20, 'x'), () => process.exit(4))`);
  child.stderr.resume();
  const done = closed(child);
  child.stdout.destroy();
  assert.deepEqual(await done, [4, null]);
});

test('an exception in a child’s exit listener reaches uncaughtException, and its close still comes', { skip: !addon }, () => {
  const script = `
    const { spawnCore } = require(${JSON.stringify(require.resolve('../electron/platform/coreChild.cjs'))});
    process.on('uncaughtException', (error) => console.log('uncaught', error.message));
    const child = spawnCore(process.execPath, ['-e', ''], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.on('end', () => console.log('stdout end'));
    child.on('exit', () => { throw new Error('a listener bug'); });
    child.on('close', (code) => console.log('close', code));`;
  const run = childProcess.spawnSync(process.execPath, ['--no-warnings', '-e', script], {
    encoding: 'utf8',
    timeout: 20_000,
    env: { ...process.env, MOPILOT_CORE: corePath() },
  });
  assert.deepEqual(run.stdout.trim().split('\n').sort(), ['close 0', 'stdout end', 'uncaught a listener bug'], run.stderr);
});

test('cwd null means no directory, as from Node', { skip }, async () => {
  const child = node(`console.log(process.cwd())`, { cwd: null });
  const out = collect(child.stdout);
  await closed(child);
  assert.equal(out.text().trim(), fs.realpathSync(process.cwd()));
});
