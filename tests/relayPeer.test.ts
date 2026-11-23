// The model relay takes a connection only from the app-server or a process it started (electron/identity/accounts/relay.cjs admits,
// #2144): Codex logs the URLs it calls, so the random path alone does not keep other local programs out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Socket } from 'node:net';
import { createRequire } from 'node:module';
import { waitFor } from './support/waitFor.ts';

const require = createRequire(import.meta.url);
const { Relay } = require('../electron/identity/accounts/relay.cjs');
const { recentIgnored, clearIgnored } = require('../electron/ignored.cjs');
const { PEER_NOT_FOUND } = require('../electron/capabilities/httpMcp.cjs');
const { loopbackDirect } = require('../electron/platform/loopbackHttp.cjs');

function relayWith(answer: (o: any) => Promise<string | null>, { pid = 4242, platform = 'darwin' } = {}) {
  const calls: any[] = [];
  const accounts = { server: { proc: pid ? { pid } : null }, apiBase: () => 'https://api.example.test/v1', keyRoute: () => null };
  const relay = new Relay(accounts, { verifyPeer: (o: any) => (calls.push(o), answer(o)), platform });
  return { relay, calls };
}
function response() {
  const res: any = { headersSent: false };
  res.writeHead = (status: number) => ((res.status = status), (res.headersSent = true));
  res.end = (body: string) => (res.body = body);
  return res;
}

test('a connection from the app-server is taken once per connection; another process is refused and recorded', async () => {
  const ok = relayWith(async () => null);
  const socket = new Socket();
  assert.equal(await ok.relay.admits(socket), true);
  assert.equal(await ok.relay.admits(socket), true);
  assert.equal(ok.calls.length, 1, 'checked once per connection');
  assert.equal(ok.calls[0].socket, socket);
  assert.equal(ok.calls[0].harnessPid, 4242);

  const no = relayWith(async () => 'process 99 is not the harness or one it started');
  clearIgnored();
  const res = response();
  await no.relay.onRequest({ url: `/${no.relay.secret}/responses`, socket: new Socket(), headers: {} }, res);
  assert.equal(res.status, 403);
  assert.deepEqual(
    recentIgnored().map((e: any) => [e.context, e.message]),
    [['take a model relay connection', 'process 99 is not the harness or one it started']],
  );
  // a WebSocket upgrade from it is closed before anything is read
  const ws = new Socket();
  let destroyed = false;
  ws.destroy = (() => ((destroyed = true), ws)) as any;
  await no.relay.onUpgrade({ url: `/${no.relay.secret}/responses`, headers: { 'chatgpt-account-id': 'a' } }, ws, Buffer.from(''));
  assert.equal(destroyed, true);
});

test('a check that can not tell (lsof saw nothing, or failed) is a retryable 503, asked again; no app-server refuses', async () => {
  let answer: () => Promise<string | null> = async () => PEER_NOT_FOUND;
  const unsure = relayWith(() => answer());
  const socket = new Socket();
  clearIgnored();
  const res = response();
  await unsure.relay.onRequest({ url: `/${unsure.relay.secret}/responses`, socket, headers: {} }, res);
  assert.equal(res.status, 503, 'Codex retries a 5xx');
  answer = async () => {
    throw new Error('lsof timed out');
  };
  assert.equal(await unsure.relay.admits(socket), null);
  answer = async () => null;
  assert.equal(await unsure.relay.admits(socket), true, 'asked again on the next request');
  assert.equal(unsure.calls.length, 3);
  assert.deepEqual(
    recentIgnored().map((e: any) => e.context),
    ['take a model relay connection', 'check who connected to the model relay'],
  );
  const down = relayWith(async (o) => (Number.isInteger(o.harnessPid) ? null : 'the session has no harness process'), { pid: 0 });
  assert.equal(await down.relay.admits(new Socket()), false);
  assert.equal(down.calls[0].harnessPid, undefined);
  const win = relayWith(async () => 'never asked', { platform: 'win32' });
  assert.equal(await win.relay.admits(new Socket()), true);
  assert.equal(win.calls.length, 0);
});

test('a request on any other path is answered 404 without checking who sent it', async () => {
  const { relay, calls } = relayWith(async () => null);
  const res = response();
  await relay.onRequest({ url: '/guess/responses', socket: new Socket(), headers: {} }, res);
  assert.equal(res.status, 404);
  assert.equal(calls.length, 0, 'no lsof for a connection that does not know the path');
});

test('the app-server reaches loopback directly, whatever proxy the shell sets', () => {
  assert.deepEqual(loopbackDirect({ PATH: '/bin' }), { PATH: '/bin', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' });
  const env = loopbackDirect({ http_proxy: 'http://127.0.0.1:7890', no_proxy: 'corp.example, localhost' });
  assert.equal(env.http_proxy, 'http://127.0.0.1:7890');
  assert.equal(env.no_proxy, 'corp.example,localhost,127.0.0.1');
  assert.equal(env.NO_PROXY, 'corp.example,localhost,127.0.0.1');
});

/** A fake execFile: lsof names `peer` for the connection; ps answers from `procs` (pid -> [ppid, comm]). */
function fakeExec(peer: number | null, procs: Record<number, [number, string]>) {
  const calls: string[] = [];
  const exec = (cmd: string, args: string[], _o: any, cb: (e: any, out: string) => void) => {
    calls.push(cmd);
    if (cmd.endsWith('lsof')) return cb(null, peer == null ? '' : `p${peer}\nf12\nn127.0.0.1:50001->127.0.0.1:7000\n`);
    const pid = Number(args.at(-1));
    const p = procs[pid];
    cb(null, p ? `${p[0]} ${p[1]}\n` : '');
  };
  return { exec, calls };
}
const tcp = { remotePort: 50001, localPort: 7000 } as any;

test('only the app-server process itself is served: its children (MCP servers, model commands) are refused (#2144)', async () => {
  const { appServerPeer } = require('../electron/identity/accounts/relayPeers.cjs');
  const procs: Record<number, [number, string]> = {
    100: [1, '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'],
    200: [100, '/usr/local/bin/node'],
    300: [100, '/opt/homebrew/bin/codex'],
  };
  assert.equal(await appServerPeer({ socket: tcp, harnessPid: 100, execFile: fakeExec(100, procs).exec }), null);
  assert.equal(
    await appServerPeer({ socket: tcp, harnessPid: 100, execFile: fakeExec(200, procs).exec }),
    'process 200 is not the Codex app-server',
  );
  // a `codex` the native app-server started (a model running `codex exec`) is not the app-server either
  assert.equal(
    await appServerPeer({ socket: tcp, harnessPid: 100, execFile: fakeExec(300, procs).exec }),
    'process 300 is not the Codex app-server',
  );
  assert.equal(await appServerPeer({ socket: tcp, harnessPid: 100, execFile: fakeExec(null, procs).exec }), PEER_NOT_FOUND);
  assert.equal(await appServerPeer({ socket: tcp, harnessPid: undefined, execFile: fakeExec(100, procs).exec }), 'Codex is not running');
  assert.equal(await appServerPeer({ socket: {} as any, harnessPid: 100, execFile: fakeExec(100, procs).exec }), 'no socket');
  const noPid = (_c: string, _a: string[], _o: any, cb: (e: any, out: string) => void) =>
    cb(null, 'f12\nn127.0.0.1:50001->127.0.0.1:7000\n');
  assert.equal(await appServerPeer({ socket: tcp, harnessPid: 100, execFile: noPid }), 'the connecting process has no pid');
});

test('an npm install’s launcher (node running codex.js): the native codex it starts is the app-server; its children are not', async () => {
  const { appServerPeer } = require('../electron/identity/accounts/relayPeers.cjs');
  const procs: Record<number, [number, string]> = {
    100: [1, '/usr/local/bin/node'],
    101: [100, '/usr/local/lib/node_modules/@openai/codex/vendor/aarch64-apple-darwin/codex/codex'],
    102: [101, '/bin/zsh'],
    103: [100, '/usr/bin/curl'],
  };
  assert.equal(await appServerPeer({ socket: tcp, harnessPid: 100, execFile: fakeExec(101, procs).exec }), null);
  assert.equal(
    await appServerPeer({ socket: tcp, harnessPid: 100, execFile: fakeExec(102, procs).exec }),
    'process 102 is not the Codex app-server',
  );
  assert.equal(
    await appServerPeer({ socket: tcp, harnessPid: 100, execFile: fakeExec(103, procs).exec }),
    'process 103 is not the Codex app-server',
  );
  // a process that is gone by the time ps asks is not the app-server
  assert.equal(
    await appServerPeer({ socket: tcp, harnessPid: 100, execFile: fakeExec(999, procs).exec }),
    'process 999 is not the Codex app-server',
  );
  // the launcher gone by the time ps asks: its pid can't be told to be a launcher, so its child is not served
  const orphan = { 101: procs[101] };
  assert.equal(
    await appServerPeer({ socket: tcp, harnessPid: 100, execFile: fakeExec(101, orphan).exec }),
    'process 101 is not the Codex app-server',
  );
});

test('at most MAX_CHECKS peer checks run at once; the rest wait their turn', async () => {
  const { MAX_CHECKS } = require('../electron/identity/accounts/relayPeers.cjs');
  let running = 0;
  let most = 0;
  const releases: (() => void)[] = [];
  const { relay } = relayWith(async () => {
    running++;
    most = Math.max(most, running);
    await new Promise<void>((r) => releases.push(r));
    running--;
    return null;
  });
  const all = Array.from({ length: MAX_CHECKS + 3 }, () => relay.admits(new Socket()));
  await waitFor(() => !(releases.length < MAX_CHECKS), 'the admission checks to start');
  assert.equal(releases.length, MAX_CHECKS);
  while (releases.length) {
    releases.shift()!();
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  }
  assert.deepEqual(await Promise.all(all), Array(MAX_CHECKS + 3).fill(true));
  assert.equal(most, MAX_CHECKS);
});

test('#2308: MoMo’s app-server beside the main one may use the relay; with none running nothing is taken', async () => {
  const two = (pids: number[], answer: (o: any) => Promise<string | null>) => {
    const calls: any[] = [];
    const accounts = { server: { proc: null, pids: () => pids }, apiBase: () => 'https://api.example.test/v1', keyRoute: () => null };
    return { relay: new Relay(accounts, { verifyPeer: (o: any) => (calls.push(o.harnessPid), answer(o)), platform: 'darwin' }), calls };
  };
  // a connection from the second one: the main one is asked first, then it
  const momo = two([10, 20], async (o) => (o.harnessPid === 20 ? null : 'process 7 is not the Codex app-server'));
  assert.equal(await momo.relay.admits(new Socket()), true);
  assert.deepEqual(momo.calls, [10, 20]);
  // from neither: refused
  const neither = two([10, 20], async (o) => `not ${o.harnessPid}`);
  assert.equal(await neither.relay.admits(new Socket()), false);
  assert.deepEqual(neither.calls, [10, 20]);
  // none running: asked as before with no process, never taken
  const none = two([], async (o) => (o.harnessPid === undefined ? 'Codex is not running' : null));
  assert.equal(await none.relay.admits(new Socket()), false);
  assert.deepEqual(none.calls, [undefined]);
});
