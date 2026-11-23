// The utility-process host of @playwright/mcp: the parent port stands in for the CLI's stdio, and the
// CLI starts once, with the arguments main sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const HOST = require.resolve('../electron/capabilities/browser/playwrightHost.cjs');

function fakePort() {
  const port: any = new EventEmitter();
  port.posted = [];
  port.postMessage = (m: any) => port.posted.push(m);
  return port;
}

test('in a utility process it listens on the parent port as soon as it loads', () => {
  const port = fakePort();
  (process as any).parentPort = port;
  try {
    delete require.cache[HOST];
    require(HOST);
  } finally {
    delete (process as any).parentPort;
    delete require.cache[HOST];
  }
  assert.equal(port.listenerCount('message'), 1);
});

test('outside a utility process the module only defines host()', () => {
  const { host } = require(HOST);
  assert.equal(typeof host, 'function');
});

test('host: lines in go to the CLI stdin; its output goes to main as written, and waits for main acknowledgement', async () => {
  const { host } = require(HOST);
  const port = fakePort();
  const { stdin, stdout } = host({ port, proc: {}, load: () => {}, resolve: () => '/x/package.json' });
  let read = '';
  stdin.setEncoding('utf8');
  stdin.on('data', (d: string) => (read += d));
  port.emit('message', { data: { type: 'in', data: '{"id":1}\n' } });
  port.emit('message', { data: { type: 'in', data: 42 } }); // not a line: dropped
  port.emit('message', {}); // nothing
  await new Promise((r) => setImmediate(r));
  assert.equal(read, '{"id":1}\n');
  stdout.write('{"result":1}\n');
  assert.deepEqual(port.posted, [{ type: 'output', seq: 1, data: Buffer.from('{"result":1}\n') }]);
  port.emit('message', { data: { type: 'out-ack', seq: 1 } });
  const ended = new Promise((r) => stdin.on('end', r));
  port.emit('message', { data: { type: 'stop' } });
  await ended;
});

test('host: start loads the CLI next to the package with the given args, only once', () => {
  const { host } = require(HOST);
  const port = fakePort();
  const proc: any = { execPath: '/bin/electron' };
  const loaded: string[] = [];
  const { stdin, stdout } = host({ port, proc, load: (p: string) => loaded.push(p), resolve: (id: string) => `/mods/${id}` });
  port.emit('message', { data: { type: 'start', args: ['--extension', 3] } });
  const cli = path.join('/mods/@playwright/mcp', 'cli.js');
  assert.deepEqual(loaded, [cli]);
  assert.deepEqual(proc.argv, ['/bin/electron', cli, '--extension', '3']);
  assert.equal(proc.stdin, stdin);
  assert.equal(proc.stdout, stdout);
  port.emit('message', { data: { type: 'start', args: ['again'] } });
  assert.equal(loaded.length, 1);
  // a start without an args list runs the CLI with none
  const proc2: any = { execPath: 'e' };
  const p2 = fakePort();
  host({ port: p2, proc: proc2, load: () => {}, resolve: () => '/p/package.json' });
  p2.emit('message', { data: { type: 'start' } });
  assert.deepEqual(proc2.argv, ['e', path.join('/p', 'cli.js')]);
});

test('host: by default the real package is resolved', () => {
  const { host } = require(HOST);
  const port = fakePort();
  const proc: any = { execPath: 'e' };
  const loaded: string[] = [];
  host({ port, proc, load: (p: string) => loaded.push(p) });
  port.emit('message', { data: { type: 'start', args: [] } });
  assert.equal(loaded[0], path.join(path.dirname(require.resolve('@playwright/mcp/package.json')), 'cli.js'));
});

test('host: output goes one write at a time, each held until main acknowledges it, in order', async () => {
  const { host } = require(HOST);
  const port = fakePort();
  const { stdout } = host({ port });
  const wire = Buffer.from('{"text":"中😀"}\r\n{"id":2}\n');
  const split = wire.indexOf(Buffer.from('中')) + 1;
  stdout.write(wire.subarray(0, split));
  let written = false;
  const done = new Promise<void>((resolve) =>
    stdout.write(wire.subarray(split), () => {
      written = true;
      resolve();
    }),
  );
  assert.deepEqual(port.posted, [{ type: 'output', seq: 1, data: wire.subarray(0, split) }]);
  port.emit('message', { data: { type: 'out-ack', seq: 2 } });
  assert.equal(port.posted.length, 1, 'an acknowledgement of nothing sent lets nothing go');
  port.emit('message', { data: { type: 'out-ack', seq: 1 } });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(port.posted.at(-1), { type: 'output', seq: 2, data: wire.subarray(split) });
  assert.equal(written, false);
  port.emit('message', { data: { type: 'out-ack', seq: 2 } });
  await done;
  assert.equal(written, true);
  // An acknowledgement after the write completed, or a foreign message, has no effect.
  port.emit('message', { data: { type: 'out-ack', seq: 2 } });
  port.emit('message', { data: { type: 'foreign' } });
  assert.equal(port.posted.length, 2);
});

/** A process whose stdio is defined as a Windows utility process defines it: "Cannot redefine property: stdin" before. */
function keptStdio() {
  const proc: any = { execPath: 'e' };
  Object.defineProperty(proc, 'stdin', { value: new EventEmitter(), configurable: false });
  Object.defineProperty(proc, 'stdout', { value: { real: 'stdout' }, configurable: false });
  return proc;
}

test("host: where the process keeps its stdio (a Windows utility process), the SDK's real stdio transport reads and writes the host streams", async () => {
  const { host, sdkTransport } = require(HOST);
  const Transport = sdkTransport(require.resolve, require);
  const start = Transport.prototype.start;
  try {
    const port = fakePort();
    const proc = keptStdio();
    const realIn = proc.stdin;
    const { stdin, stdout } = host({ port, proc, load: () => {}, resolve: () => '/x/package.json', transport: () => Transport });
    port.emit('message', { data: { type: 'start', args: [] } });
    assert.equal(proc.stdin, realIn, 'the process keeps its own stdin');
    // the CLI's `new StdioServerTransport()` (no arguments: process.stdin and process.stdout)
    const t = new Transport();
    const got: unknown[] = [];
    t.onmessage = (m: unknown) => got.push(m);
    let closed = false;
    t.onclose = () => (closed = true);
    await t.start();
    // a framed line from main, split across two writes, comes out as one message
    port.emit('message', { data: { type: 'in', data: '{"jsonrpc":"2.0","id":1,' } });
    port.emit('message', { data: { type: 'in', data: '"method":"ping"}\n' } });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(got, [{ jsonrpc: '2.0', id: 1, method: 'ping' }]);
    // what the CLI sends goes to main through the host stdout
    const sent = t.send({ jsonrpc: '2.0', id: 1, result: {} });
    assert.deepEqual(port.posted, [{ type: 'output', seq: 1, data: Buffer.from('{"jsonrpc":"2.0","id":1,"result":{}}\n') }]);
    port.emit('message', { data: { type: 'out-ack', seq: 1 } });
    await sent;
    assert.equal(stdout.writableLength, 0);
    // a stop ends the host stdin: the transport closes, and the exit watchdog on the process's own stdin hears the close
    const heard: string[] = [];
    realIn.on('close', () => heard.push('close'));
    port.emit('message', { data: { type: 'stop' } });
    await new Promise((r) => stdin.once('close', r));
    await new Promise((r) => setImmediate(r));
    assert.equal(closed, true);
    assert.deepEqual(heard, ['close']);
  } finally {
    Transport.prototype.start = start;
  }
});

test('host: a stdin close reaches a process stdin that cannot hear it without failing', async () => {
  const { wireStdio } = require(HOST);
  class T {
    async start() {}
    async close() {}
  }
  for (const value of [undefined, { no: 'emit' }]) {
    const proc: any = {};
    Object.defineProperty(proc, 'stdin', { value, configurable: false });
    const stdin = new PassThrough();
    assert.equal(
      wireStdio(proc, stdin, new PassThrough(), () => T),
      'transport',
    );
    stdin.destroy();
    await new Promise((r) => stdin.once('close', r));
  }
});

test("host: a process with Node's own replaceable stdio keeps the old wiring, and only half replaceable counts as not", () => {
  const { wireStdio } = require(HOST);
  const proc: any = {};
  // process.stdin and process.stdout as Node defines them: configurable getters
  for (const k of ['stdin', 'stdout']) {
    const real = Object.getOwnPropertyDescriptor(process, k)!;
    assert.equal(real.configurable, true);
    assert.equal(typeof real.get, 'function');
    Object.defineProperty(proc, k, real);
  }
  const transport = () => assert.fail('no transport is patched');
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  assert.equal(wireStdio(proc, stdin, stdout, transport), 'process');
  assert.equal(proc.stdin, stdin);
  assert.equal(proc.stdout, stdout);
  const half: any = {};
  Object.defineProperty(half, 'stdout', { value: 'kept', configurable: false });
  class T {
    async start() {}
    async close() {}
  }
  assert.equal(
    wireStdio(half, new PassThrough(), 'out', () => T),
    'transport',
  );
  assert.equal(half.stdin, undefined);
  assert.equal(half.stdout, 'kept');
});

test('host: the CLI constructs its stdio transport from the utilsBundle the fallback patches', () => {
  const mcp = path.dirname(require.resolve('@playwright/mcp/package.json'));
  const core = fs.readFileSync(require.resolve('playwright-core/lib/coreBundle', { paths: [mcp] }), 'utf8');
  assert.match(core, /\(\{ StdioServerTransport \} = require\("\.\/utilsBundle"\)\)/);
  assert.match(core, /new StdioServerTransport\(\)/);
});

test("host: on kept stdio the real CLI answers through the host and a stop ends it by its exit watchdog, not main's kill", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-host-'));
  // a Node child stands in for the Windows utility process: kept stdio, and a timer for the parent port that keeps it alive
  const script = `
    const { Readable } = require('node:stream');
    const { EventEmitter } = require('node:events');
    Object.defineProperty(process, 'stdin', { value: new Readable({ read() {} }), configurable: false });
    Object.defineProperty(process, 'stdout', { value: process.stdout, configurable: false });
    setInterval(() => {}, 1000);
    const port = new EventEmitter();
    const say = (m) => process.send(m);
    port.postMessage = (m) => {
      say({ output: Buffer.from(m.data).toString('utf8') });
      setImmediate(() => port.emit('message', { data: { type: 'out-ack', seq: m.seq } }));
    };
    process.on('message', (m) => port.emit('message', { data: m }));
    require(process.argv[1]).host({ port });
    say({ ready: true });
  `;
  const child = spawn(process.execPath, ['-e', script, HOST], { cwd: dir, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let err = '';
  child.stderr!.on('data', (d) => (err += d));
  const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)));
  const kill = setTimeout(() => child.kill(), 20_000);
  try {
    const out: string[] = [];
    const answered = new Promise<void>((resolve) =>
      child.on('message', (m: any) => {
        if (m.ready) {
          child.send({ type: 'start', args: ['--extension', '--output-dir', dir, '--codegen', 'none', '--no-webmcp'] });
          const init = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } };
          child.send({ type: 'in', data: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: init })}\n` });
        }
        if (m.output) out.push(m.output);
        if (out.join('').includes('"id":1')) resolve();
      }),
    );
    await answered;
    assert.match(out.join(''), /"serverInfo"/);
    const stopped = Date.now();
    child.send({ type: 'stop' });
    assert.equal(await exited, 0, err);
    // main kills after STOP_MS (5 s); the watchdog exits as soon as it has closed what it opened
    assert.ok(Date.now() - stopped < 4_000, `stopped in ${Date.now() - stopped} ms`);
  } finally {
    clearTimeout(kill);
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('host: by default the transport is found in the playwright-core the CLI loads, beside @playwright/mcp', () => {
  const { host } = require(HOST);
  const port = fakePort();
  const proc: any = { execPath: 'e' };
  Object.defineProperty(proc, 'stdin', { value: 'kept', configurable: false });
  class T {
    async start() {}
    async close() {}
  }
  const asked: unknown[] = [];
  const resolve = (id: string, o?: { paths: string[] }) => {
    asked.push([id, o]);
    return id === '@playwright/mcp/package.json' ? '/m/mcp/package.json' : `/m/mcp/node_modules/${id}`;
  };
  const loaded: string[] = [];
  const load = (id: string) => {
    loaded.push(id);
    return id.endsWith('utilsBundle') ? { StdioServerTransport: T } : {};
  };
  host({ port, proc, load, resolve });
  port.emit('message', { data: { type: 'start', args: [] } });
  assert.deepEqual(asked.at(-1), ['@playwright/mcp/package.json', undefined]);
  assert.ok(asked.some((a) => JSON.stringify(a) === JSON.stringify(['playwright-core/lib/utilsBundle', { paths: ['/m/mcp'] }])));
  assert.ok(loaded.includes('/m/mcp/node_modules/playwright-core/lib/utilsBundle'));
  assert.equal(T.prototype.start.name, 'startOnHostStdio');
});
