// The harnesses as children of the core: Codex's app-server, its account helper and an ACP agent, each a real process through
// the built addon, and on a Host in the ledger of what it started. Skipped without a built addon, unless
// MOPILOT_CORE_REQUIRED says the run must have it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { waitFor } from './support/waitFor.ts';
import { createRecovery } from '../host/src/recovery.mjs';

const require = createRequire(import.meta.url);
const { corePath, loadCore } = require('../electron/platform/core.cjs');
const { CoreChild } = require('../electron/platform/coreChild.cjs');
const { AppServer } = require('../electron/harness/codexProcess.cjs');
const { AcpAgent } = require('../electron/harness/acp/agent.cjs');
const { Sidecar } = require('../electron/identity/accounts/sidecar.cjs');

const addon = loadCore(corePath());
const required = process.env.MOPILOT_CORE_REQUIRED === '1';
const skip = !addon?.routes().includes('proc.spawn') && !required && `no Rust core with proc.spawn built at ${corePath()}`;
const posixOnly = skip || (process.platform === 'win32' && 'POSIX');

const exited = (child: any) => new Promise<[number | null, string | null]>((resolve) => child.once('exit', (...why: any) => resolve(why)));

/** An executable that answers each JSON-RPC request on stdin with `result`, and exits with `exit` when stdin ends: a harness. */
function fakeHarness(result: object, exit = 0) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-harness-')), 'harness');
  const body = `
    let held = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (text) => {
      held += text;
      const lines = held.split('\\n');
      held = lines.pop();
      for (const line of lines) {
        const { id, method } = JSON.parse(line);
        if (id !== undefined) console.log(JSON.stringify({ id, method, jsonrpc: '2.0', result: ${JSON.stringify(result)} }));
      }
    });
    process.stdin.on('end', () => process.exit(${exit}));`;
  fs.writeFileSync(file, `#!${process.execPath}\n${body}`, { mode: 0o755 });
  return file;
}

test('Codex’s app-server runs as a child of the core: a request answered, a stop that ends it', { skip: posixOnly }, async () => {
  const server = new AppServer({ findBin: () => fakeHarness({ ok: true }), env: () => process.env });
  const events: any[] = [];
  server.listeners.add((event: any) => events.push(event));
  server.send({ id: 1, method: 'initialize' });
  await waitFor(() => events.some((event) => event.kind === 'message'));
  assert.deepEqual(events[0].msg.result, { ok: true });
  assert.ok(server.proc.pid > 1);
  const { proc } = server;
  server.stop();
  await exited(proc);
  assert.deepEqual(events.at(-1), { kind: 'stopped' });
});

test('an app-server that crashes is reported with its exit, behind all it said', { skip: posixOnly }, async () => {
  const crashes: any[] = [];
  const bin = fakeHarness({ ok: true }, 9);
  const server = new AppServer({ findBin: () => bin, env: () => process.env, onCrashReport: (code: number) => crashes.push(code) });
  const events: any[] = [];
  server.listeners.add((event: any) => events.push(event.kind));
  server.send({ id: 1, method: 'initialize' });
  await waitFor(() => events.includes('message'));
  server.proc.stdin.end();
  await waitFor(() => events.includes('exit'));
  assert.deepEqual(events, ['message', 'exit']);
  assert.deepEqual(crashes, [9]);
  assert.equal(server.proc, null);
});

test('a Codex binary that is not there is told as before, and the next start tries again', { skip }, async () => {
  const server = new AppServer({ findBin: () => '/mopilot/no/such/codex', env: () => process.env });
  const events: any[] = [];
  server.listeners.add((event: any) => events.push(event));
  server.start();
  await waitFor(() => events.length > 0);
  assert.deepEqual(events[0], { kind: 'error', error: 'spawn /mopilot/no/such/codex ENOENT' });
  assert.equal(server.proc, null);
  assert.equal(server.status, 'exited');
});

test('an ACP agent runs as a child of the core: initialize, then a kill that ends it', { skip: posixOnly }, async () => {
  const agent = new AcpAgent({
    harness: 'fake',
    command: fakeHarness({ protocolVersion: 1, agentCapabilities: {} }),
    env: process.env,
    cwd: os.tmpdir(),
    onRequest: async () => null,
  });
  agent.start();
  await agent.initialize();
  assert.equal(agent.caps.protocolVersion, 1);
  const gone = new Promise<any>((resolve) => agent.once('exit', resolve));
  agent.kill();
  assert.equal((await gone).code, 0, 'it ended on the end of its input');
});

test('an ACP agent that can’t be started says so as before', { skip }, async () => {
  const agent = new AcpAgent({
    harness: 'fake',
    command: '/mopilot/no/such/agent',
    env: process.env,
    cwd: os.tmpdir(),
    onRequest: async () => null,
  });
  const gone = new Promise<any>((resolve) => agent.once('exit', resolve));
  agent.start();
  assert.equal((await gone).error, 'spawn /mopilot/no/such/agent ENOENT');
});

test('a Codex account helper runs as a child of the core, with its stderr nowhere', { skip: posixOnly }, async () => {
  let ended = 0;
  const helper = new Sidecar(fakeHarness({ account: { email: 'a@b.c' } }), os.tmpdir(), () => ended++, { name: 'x' });
  assert.equal(helper.proc.stderr, null);
  assert.deepEqual(await helper.call('account/read', {}), { account: { email: 'a@b.c' } });
  await helper.close();
  assert.equal(ended, 1);
});

test('on a Host every harness process is the core’s, and is in its ledger until it exits', { skip: posixOnly }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-host-'));
  const recovery = createRecovery({ dataDir });
  await recovery.run({ interrupted: () => undefined });
  const restore = recovery.install();
  try {
    const server = new AppServer({ findBin: () => fakeHarness({ ok: true }), env: () => process.env });
    const events: any[] = [];
    server.listeners.add((event: any) => events.push(event.kind));
    server.send({ id: 1, method: 'initialize' });
    await waitFor(() => events.includes('message'));
    assert.ok(server.proc instanceof CoreChild);
    assert.deepEqual(recovery.children.list(), [server.proc.pid]);
    const ledger = JSON.parse(fs.readFileSync(path.join(dataDir, 'children.json'), 'utf8'));
    assert.match(JSON.stringify(ledger), new RegExp(`${server.proc.pid}`));
    const { proc } = server;
    server.stop();
    await exited(proc);
    assert.deepEqual(recovery.children.list(), []);
  } finally {
    restore();
  }
});
