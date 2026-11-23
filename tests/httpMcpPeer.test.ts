// The http tool channel's peer check (electron/capabilities/httpMcp.cjs verifyTcpPeer) with the real lsof and ps:
// a child process's request goes through for that child as the harness and for its parent, and not for a stranger.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ToolHttp } = require('../electron/capabilities/httpMcp.cjs');
const { ToolSessions } = require('../electron/capabilities/contract/session.cjs');
const { Registry } = require('../electron/capabilities/contract/registry.cjs');

const skip = process.platform !== 'darwin' ? 'lsof -F output as macOS prints it' : false;

/** A child node process that pings `url` with `token` once it is told the harness pid, and prints the status. */
function pinger(url: string) {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `process.stdin.once('data', (t) => fetch(${JSON.stringify(url)}, { method: 'POST',
         headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + String(t).trim() },
         body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) }).then((r) => { console.log(r.status); process.exit(0); }))`,
    ],
    { stdio: ['pipe', 'pipe', 'inherit'] },
  );
  const status = new Promise<number>((resolve) => {
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('exit', () => resolve(Number(out.trim())));
  });
  return { pid: child.pid!, ping: (token: string) => (child.stdin.end(token + '\n'), status) };
}

test('verifyTcpPeer: the harness, a process it started, and a stranger', { skip, timeout: 30_000 }, async () => {
  const sessions = new ToolSessions();
  const h = new ToolHttp({ sessions, registry: new Registry() });
  after(() => h.close());
  const rejected: string[] = [];
  h.on('rejected', (e: any) => rejected.push(e.reason));
  const url = await h.listen();
  // the connecting process is the harness itself
  const self = pinger(url);
  assert.equal(await self.ping(sessions.open('self', { harnessPid: self.pid }).token), 200);
  // the harness started the connecting process
  const child = pinger(url);
  assert.equal(await child.ping(sessions.open('parent', { harnessPid: process.pid }).token), 200);
  // somebody else's token
  const stranger = spawn('/bin/sleep', ['30']);
  after(() => stranger.kill());
  const other = pinger(url);
  assert.equal(await other.ping(sessions.open('other', { harnessPid: stranger.pid }).token), 403);
  assert.deepEqual(rejected, [`process ${other.pid} is not the harness or one it started`]);
});
