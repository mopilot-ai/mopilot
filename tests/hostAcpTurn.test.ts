// An ACP turn inside the Host process (host/src/acp.mjs): over `bin serve` and its unix socket with the fake ACP agent (A5, smoke), a silent harness (B5), and the runtime's edges.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createAcpRuntime } from '../host/src/acp.mjs';
import { createPaths } from '../host/src/paths.mjs';
import { askHost, callHost } from '../host/src/server.mjs';
import { line } from './support/host-line.ts';
import { createRequire } from 'node:module';
import { keySafe } from './support/hostKeySafe.ts';

const { loadIdentity, pairWith, authenticate } = createRequire(import.meta.url)('../electron/host/pairingClient.cjs');

const ROOT = path.join(import.meta.dirname, '..');
const AGENT = path.join(ROOT, 'tests/fixtures/fake-acp-agent.mjs');
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-acp-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));

/** A data dir whose harnesses.json defines the `fake` harness: the fake ACP agent run by this node. */
function dataDir(extra: object = {}) {
  const dir = fs.mkdtempSync(path.join(base, 'd-'));
  fs.writeFileSync(
    path.join(dir, 'harnesses.json'),
    JSON.stringify({
      fake: { label: 'Fake', bin: process.execPath, args: [AGENT], env: { FAKE_ACP_STATE: path.join(dir, 'agent-state') }, ...extra },
    }),
  );
  return dir;
}
const until = async (fn: () => any, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 15));
  }
};
const paramsFor = (dir: string) => createPaths({ dataDir: dir, env: {} });

test('smoke: `bin serve` runs one ACP turn over the unix socket; A5: it goes on with no client attached', async () => {
  const dir = dataDir();
  const bin = path.join(ROOT, 'host/bin/mopilot-host.mjs');
  const child = spawn(process.execPath, [bin, 'serve', '--data-dir', dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  let printed = '';
  child.stdout.on('data', (c) => (printed += c));
  await until(() => /Pairing code: \S+/.test(printed));
  const sock = paramsFor(dir).socketPath;
  // the Host serves a chat only to a client it paired: this one registers with the printed code, then its connection is gone
  const app = loadIdentity(path.join(base, `app-${path.basename(dir)}.json`), keySafe);
  const first = line(sock);
  await pairWith(first.request, app, /Pairing code: (\S+)/.exec(printed)![1]);
  // a turn the agent holds until it is cancelled: the client that started it hangs up
  const slow: any = await first.request('send', { key: 'acp:fake:slow', text: 'SLOW please', cwd: path.dirname(dir) });
  first.close();
  const second = line(sock);
  await authenticate(second.request, app);
  const askHost = (_sock: string, method: string, params?: object) => second.request(method, params);
  await until(async () => ((await askHost(sock, 'turn', { turnId: slow.turnId })) as any)?.text.includes('fake-acp'));
  assert.equal(
    ((await askHost(sock, 'turn', { turnId: slow.turnId })) as any).state,
    'running',
    'no client is connected and the turn still runs',
  );
  // another chat on the same Host completes a whole turn
  const sent: any = await askHost(sock, 'send', { key: 'acp:fake:a', text: 'hello there', cwd: path.dirname(dir) });
  const done: any = await until(async () => {
    const t: any = await askHost(sock, 'turn', { turnId: sent.turnId });
    return t?.state === 'ended' && t;
  });
  assert.deepEqual([done.stopReason, done.text, done.noProgress], ['end_turn', 'fake-acp: hello there', false]);
  assert.ok(fs.readdirSync(path.join(dir, 'threads')).length > 0, 'the transcript is kept under the Host data dir');
  second.close();
  child.kill('SIGTERM');
  assert.equal(await exited, 0);
});

test('B5: a harness that goes silent is reported as making no progress, and its turn exits', async () => {
  const dir = dataDir();
  const runtime = createAcpRuntime({
    paths: paramsFor(dir),
    env: {},
    progressMs: 60,
    hostOptions: { cancelRetryMs: 5, cancelForceMs: 5000 },
  });
  try {
    // PROVIDERFAIL: the agent says nothing and retries silently until it is cancelled
    const { turnId } = await runtime.send({ key: 'acp:fake:quiet', text: 'PROVIDERFAIL now', cwd: dir });
    const turn: any = await until(() => runtime.turn(turnId)?.state === 'ended' && runtime.turn(turnId));
    assert.equal(turn.noProgress, true);
    assert.notEqual(turn.stopReason, 'end_turn');
  } finally {
    runtime.close();
  }
});

test('B5/D6: a turn waiting on a card is not cancelled for silence; when the card closes the rule starts again', async () => {
  const dir = dataDir();
  const runtime = createAcpRuntime({ paths: paramsFor(dir), env: {}, progressMs: 60 });
  const cancels: string[] = [];
  runtime.host.cancel = ((key: string) => void cancels.push(key)) as any;
  const emit = (e: any) => runtime.host.emit('event', e);
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  try {
    emit({ kind: 'turnStart', key: 'acp:fake:wait', turnId: 'tw' });
    emit({ kind: 'permission', turnId: 'tw', requestId: 'r1', options: [] });
    await pause(250);
    assert.deepEqual(cancels, [], 'a waiting card suspends the no-progress rule');
    // the close of some other card does not start the rule again
    emit({ kind: 'permissionCancelled', turnId: 'tw', requestId: 'other' });
    await pause(150);
    assert.deepEqual(cancels, []);
    emit({ kind: 'permissionCancelled', turnId: 'tw', requestId: 'r1' });
    await until(() => cancels.length > 0);
    assert.deepEqual(cancels, ['acp:fake:wait']);
    emit({ kind: 'turnEnd', turnId: 'tw', stopReason: 'cancelled' });
  } finally {
    runtime.close();
  }
});

test('a send may set its own limit, and a bad key is an error reply, not a crash', async () => {
  const dir = dataDir();
  const runtime = createAcpRuntime({ paths: paramsFor(dir), env: {}, hostOptions: { cancelRetryMs: 5, cancelForceMs: 5000 } });
  try {
    const { turnId } = await runtime.send({ key: 'acp:fake:lim', text: 'PROVIDERFAIL', cwd: dir, progressMs: 50 });
    assert.equal((await until(() => runtime.turn(turnId)?.state === 'ended' && runtime.turn(turnId))).noProgress, true);
    // a second send on the same key does not take away the limit the first one asked for
    const key = 'acp:fake:two';
    const [a, b] = await Promise.allSettled([
      runtime.send({ key, text: 'PROVIDERFAIL', cwd: dir, progressMs: 50 }),
      runtime.send({ key, text: 'again', cwd: dir }),
    ]);
    assert.equal(a.status, 'fulfilled');
    assert.equal(b.status, 'rejected');
    assert.equal(
      (await until(() => runtime.turn((a as any).value.turnId)?.state === 'ended' && runtime.turn((a as any).value.turnId))).noProgress,
      true,
    );
    await assert.rejects(runtime.send({ key: 'not-acp', text: 'x' }), /Not an ACP chat/);
    assert.equal(runtime.turn('nope'), null);
  } finally {
    runtime.close();
  }
});

test('the socket answers send errors and unknown turns', async () => {
  const { startServer } = await import('../host/src/server.mjs');
  const dir = dataDir();
  const paths = paramsFor(dir);
  const runtime = createAcpRuntime({ paths, env: {} });
  const server = await startServer({ paths, runtime });
  try {
    const bad: any = await callHost(paths.socketPath, 'send', { key: 'not-acp', text: 'x' });
    assert.match(bad.error, /Not an ACP chat/);
    assert.equal(await askHost(paths.socketPath, 'turn', { turnId: 'missing' }), null);
    assert.match(((await callHost(paths.socketPath, 'send')) as any).error, /Not an ACP chat|key/i);
  } finally {
    runtime.close();
    await server.close();
  }
  // without a runtime the Host answers status and ping only
  const bare = paramsFor(fs.mkdtempSync(path.join(base, 'b-')));
  const s2 = await startServer({ paths: bare });
  assert.match(((await callHost(bare.socketPath, 'send', {})) as any).error, /Unknown method send/);
  await s2.close();
});

test('a turn waiting on a permission card shows it, and permit answers it over the socket', async () => {
  const { startServer } = await import('../host/src/server.mjs');
  const dir = dataDir();
  const paths = paramsFor(dir);
  const runtime = createAcpRuntime({ paths, env: {} });
  const server = await startServer({ paths, runtime });
  try {
    const sent: any = await askHost(paths.socketPath, 'send', { key: 'acp:fake:perm', text: 'PERMIT it', cwd: path.dirname(dir) });
    const card: any = await until(async () => ((await askHost(paths.socketPath, 'turn', { turnId: sent.turnId })) as any)?.permission);
    assert.ok(card.requestId && card.options.length);
    const allow = card.options.find((o: any) => o.kind === 'allow_once').optionId;
    assert.equal(await askHost(paths.socketPath, 'permit', { requestId: card.requestId, optionId: allow }), true);
    const done: any = await until(async () => {
      const t: any = await askHost(paths.socketPath, 'turn', { turnId: sent.turnId });
      return t?.state === 'ended' && t;
    });
    assert.equal(done.stopReason, 'end_turn');
    assert.equal(await askHost(paths.socketPath, 'permit', { requestId: card.requestId }), false);
    assert.equal(await askHost(paths.socketPath, 'permit'), false);
    // a card taken back clears it
    const emit = (e: any) => runtime.host.emit('event', e);
    emit({ kind: 'turnStart', key: 'acp:fake:perm', turnId: 'tp' });
    emit({ kind: 'permission', turnId: 'tp', requestId: 'r', options: [] });
    assert.equal(runtime.turn('tp')?.permission?.requestId, 'r');
    emit({ kind: 'permissionCancelled', turnId: 'tp', requestId: 'r' });
    assert.equal(runtime.turn('tp')?.permission, null);
  } finally {
    runtime.close();
    await server.close();
  }
});

test('harnesses.json is checked when the Host starts', () => {
  for (const [entry, message] of [
    [{ opencode: { label: 'X', bin: '/x' } }, /built-in/],
    [{ mine: { bin: '/x' } }, /needs a label/],
    [{ mine: { label: 'X', bin: '/x', args: 'no' } }, /needs a label/],
    [{ mine: null }, /needs a label/],
  ] as const) {
    const dir = fs.mkdtempSync(path.join(base, 'v-'));
    fs.writeFileSync(path.join(dir, 'harnesses.json'), JSON.stringify(entry));
    assert.throws(() => createAcpRuntime({ paths: paramsFor(dir), env: {} }), message);
  }
});

test('server edges: a thrown string or Error is an error reply, and a reply split across packets is read whole', async () => {
  const { startServer } = await import('../host/src/server.mjs');
  const paths = paramsFor(fs.mkdtempSync(path.join(base, 's-')));
  const server = await startServer({
    paths,
    runtime: {
      send: async (p: any) => {
        throw p.text === 'string' ? 'plain' : new Error('boom');
      },
      turn: () => null,
    } as any,
  });
  assert.equal(((await callHost(paths.socketPath, 'send', { text: 'string' })) as any).error, 'plain');
  assert.equal(((await callHost(paths.socketPath, 'send', { text: 'error' })) as any).error, 'boom');
  assert.equal(await askHost(paths.socketPath, 'turn'), null);
  await server.close();
  const split = path.join(base, 'split.sock');
  const raw = net.createServer((s) => {
    s.once('data', () => {
      s.write('{"id":1,');
      setTimeout(() => s.write('"result":5}\n'), 30);
    });
  });
  await new Promise((r) => raw.listen(split, () => r(undefined)));
  assert.deepEqual(await callHost(split, 'x'), { id: 1, result: 5 });
  // a reply that is not JSON is no answer
  const junk = path.join(base, 'junk.sock');
  const rawJunk = net.createServer((s) => s.once('data', () => s.write('<html>\n')));
  await new Promise((r) => rawJunk.listen(junk, () => r(undefined)));
  assert.equal(await callHost(junk, 'x'), null);
  rawJunk.close();
  raw.close();
});

test('runtime edges: harnesses.json, PATH lookup, terminals, event bookkeeping and kept turns', async () => {
  // no harnesses.json: only the built-in harnesses; a broken one is reported
  const empty = fs.mkdtempSync(path.join(base, 'e-'));
  fs.writeFileSync(path.join(empty, 'harnesses.json'), JSON.stringify({ bare: { label: 'Bare', bin: '/bin/bare' } }));
  const plain = createAcpRuntime({ paths: paramsFor(empty), env: {} });
  assert.deepEqual(plain.host.quirksOf('bare'), { id: 'bare', label: 'Bare', args: [], env: {} });
  assert.equal(plain.host.quirksOf('opencode').id, 'opencode');
  assert.equal(plain.host.resolveBin('bare'), '/bin/bare');
  assert.equal(plain.host.resolveBin('opencode'), null, 'with no PATH nothing is found');
  plain.close();
  const broken = fs.mkdtempSync(path.join(base, 'x-'));
  fs.writeFileSync(path.join(broken, 'harnesses.json'), '{nope');
  assert.throws(() => createAcpRuntime({ paths: paramsFor(broken), env: {} }));
  // a built-in harness is found on PATH by its bins, and only when executable
  const { quirks } = (await import('node:module')).createRequire(import.meta.url)('../electron/harness/quirks/index.cjs');
  const bin = quirks('opencode').bins[0];
  const bindir = fs.mkdtempSync(path.join(base, 'p-'));
  fs.writeFileSync(path.join(bindir, bin), '#!/bin/sh\n', { mode: 0o644 });
  fs.rmSync(path.join(empty, 'harnesses.json'));
  const rt = createAcpRuntime({ paths: paramsFor(empty), env: { PATH: `${path.join(base, 'nowhere')}:${bindir}` }, keepEnded: 1 });
  assert.equal(rt.host.resolveBin('opencode'), null);
  fs.chmodSync(path.join(bindir, bin), 0o755);
  assert.equal(rt.host.resolveBin('opencode'), path.join(bindir, bin));
  // an agent's terminal request is refused rather than run somewhere unseen
  const events: any[] = [];
  rt.host.terminals.pty.spawn('t1', {}, (e: any) => events.push(e));
  rt.host.terminals.pty.kill('t1');
  assert.deepEqual(events, [], 'the refusal arrives after the terminal is registered, not inside spawn');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(events, [{ type: 'exit', code: 1 }]);
  rt.host.terminals.pty.spawn('t2', {});
  // events for unknown turns are ignored; a late update on an ended turn arms nothing; only the newest ended turn is kept
  const emit = (e: any) => rt.host.emit('event', e);
  emit({ kind: 'update', turnId: 'ghost', update: {} });
  for (const id of ['t-a', 't-b']) {
    emit({ kind: 'turnStart', key: 'acp:fake:k', turnId: id });
    emit({ kind: 'update', turnId: id, update: { sessionUpdate: 'tool_call' } });
    emit({ kind: 'update', turnId: id, update: { sessionUpdate: 'agent_message_chunk', content: {} } });
    emit({ kind: 'turnEnd', turnId: id, stopReason: null, error: id === 't-a' ? new Error('boom') : 'plain' });
  }
  assert.equal(rt.turn('t-a'), null);
  assert.deepEqual([rt.turn('t-b')?.error, rt.turn('t-b')?.state, rt.turn('t-b')?.stopReason], ['plain', 'ended', null]);
  emit({ kind: 'update', turnId: 't-b', update: {} });
  emit({ kind: 'turnStart', key: 'acp:fake:k', turnId: 't-c' });
  emit({ kind: 'turnEnd', turnId: 't-c', stopReason: 'end_turn' });
  assert.equal(rt.turn('t-c')?.error, null);
  rt.close();
});

test('loading the ACP runtime pulls in no Electron and none of the app layers boundary.json forbids', () => {
  const forbidden = JSON.parse(fs.readFileSync(path.join(ROOT, 'host/boundary.json'), 'utf8')).forbidden as string[];
  const script = `
    const M = require('module'); const load = M._load;
    M._load = function (r, ...a) { if (r === 'electron') throw new Error('electron was required'); return load.call(this, r, ...a); };
    import(${JSON.stringify(path.join(ROOT, 'host/src/acp.mjs'))}).then(() => console.log(JSON.stringify(Object.keys(require.cache))));`;
  const out = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  const loaded = (JSON.parse(out.stdout) as string[]).map((f) => path.relative(ROOT, f));
  assert.ok(loaded.some((f) => f === 'electron/harness/acp.cjs'));
  assert.deepEqual(
    loaded.filter((f) => forbidden.some((p) => f.startsWith(p))),
    [],
  );
});
