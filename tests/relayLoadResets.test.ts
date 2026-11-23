// The load harness's connection resets (scripts/relay-load/resets.mjs): a TCP RST at every phase of a connection's life against the real relay, the crash count of a child relay and the options that switch them on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import WebSocket, { WebSocketServer } from 'ws';
import { PHASES, Resets } from '../scripts/relay-load/resets.mjs';
import { childRelay, inProcessRelay } from '../scripts/relay-load/relayHost.mjs';
import { parseOptions, verdict } from '../scripts/relay-load/cli.mjs';
import { formatReport } from '../scripts/relay-load/stats.mjs';
import { runLoad } from '../scripts/relay-load/run.mjs';
import { migrate } from '../relay/src/schema.mjs';
import { migrateDurable } from '../relay/src/durableStore.mjs';
import { makeKeys, idle } from './support/relayKit.ts';
import { waitFor } from './support/waitFor.ts';

const hello = async (url: string, token: string) =>
  new Promise<boolean>((resolve) => {
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
    ws.on('message', (d) => (JSON.parse(String(d)).t === 'hello' ? (ws.close(), resolve(true)) : undefined));
    ws.on('error', () => resolve(false));
    ws.on('close', () => resolve(false));
  });

test('a reset in every phase of a connection leaves the relay serving; a relay that is down makes the resets count as not made', async () => {
  const keys = await makeKeys();
  const pool = new PGlite();
  const host = await inProcessRelay({ env: { AUTH_PUBLIC_KEY: keys.publicPem, DATABASE_URL: 'postgres://unused' }, pool });
  await host.start();
  const sign = (user: string, device: string, kind: 'desktop' | 'phone') => keys.sign(user, device, { kind });
  const resets = new Resets({ url: host.url, sign });
  for (let i = 0; i < 4; i++) await resets.round();
  await resets.idle();
  assert.deepEqual(Object.keys(resets.done), [...PHASES]);
  for (const phase of PHASES)
    assert.ok(resets.done[phase] >= 1, `${phase} was reset (${JSON.stringify(resets.done)}, skipped ${resets.skipped})`);
  assert.equal(resets.total + resets.skipped, 4 * PHASES.length);
  // the relay that took all of them still answers, and still lets an honest device in
  assert.equal((await fetch(`${host.http}/healthz`)).status, 200);
  assert.equal(await hello(host.url, await sign('honest', 'honest-1', 'desktop')), true);

  await host.kill();
  const down = new Resets({ url: host.url, sign });
  await down.round();
  assert.equal(down.total, 0);
  assert.equal(down.skipped, PHASES.length);
  await host.stop();
  await pool.close();
});

test('a reset that gets no answer counts as not made after its timeout, and idle waits for the ones under way', async () => {
  const silent = net.createServer(() => undefined).listen(0, '127.0.0.1');
  await new Promise((resolve) => silent.once('listening', resolve));
  const { port } = silent.address() as net.AddressInfo;
  const resets = new Resets({ url: `ws://127.0.0.1:${port}/v1/ws`, sign: async () => 'token', timeoutMs: 50 });
  const pending = resets.one('hello');
  assert.equal(resets.running.size, 1);
  await resets.idle();
  await pending;
  assert.equal(resets.running.size, 0);
  assert.equal(resets.skipped, 1);
  assert.equal(resets.total, 0);
  await resets.idle();
  silent.close();
});

test('a child relay that ends on its own is counted as a crash; the harness stopping or restarting it is not', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'relay-load-'));
  const quiet = path.join(dir, 'quiet.mjs');
  await writeFile(
    quiet,
    `console.log(JSON.stringify({event:'listening',port:1}));process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);`,
  );
  const dies = path.join(dir, 'dies.mjs');
  await writeFile(dies, `console.log(JSON.stringify({event:'listening',port:1}));setTimeout(()=>process.exit(3),50);`);

  const steady = await childRelay({ env: {}, bin: quiet });
  assert.equal(steady.crashes, 0);
  await steady.start();
  await steady.kill();
  await steady.start();
  await steady.stop();
  assert.equal(steady.crashes, 0);

  const fragile = await childRelay({ env: {}, bin: dies });
  await fragile.start();
  await idle(300);
  assert.equal(fragile.crashes, 1);
  await fragile.stop();
});

test('--reset-rate turns the resets on; a run with them reports them, and a relay that ended on its own fails the run', async () => {
  assert.equal(parseOptions([]).options.resetRate, 0);
  assert.equal(parseOptions(['--reset-rate', '2.5']).options.resetRate, 2.5);
  assert.throws(() => parseOptions(['--reset-rate', '-1']), /--reset-rate/);

  const report: any = await runLoad(
    { pairs: 3, seconds: 2, macRate: 4, phoneRate: 2, restarts: 0, killRate: 0, burst: null, resetRate: 4, drainSeconds: 30 },
    {},
  );
  assert.ok(
    Object.values(report.chaos.resets as Record<string, number>).every((n) => n >= 1),
    JSON.stringify(report.chaos),
  );
  assert.equal(report.chaos.relayCrashes, 0);
  assert.equal(report.ledger.lost, 0);
  assert.equal(report.mailboxLeft, 0);
  assert.equal(verdict(report), 0);
  assert.match(formatReport(report), /resets +\{"upgrade-partial":\d+/);
  assert.equal(verdict({ ...report, chaos: { ...report.chaos, relayCrashes: 1 } }), 1);
  const quiet = await runLoad({ pairs: 2, seconds: 1, macRate: 4, restarts: 0, killRate: 0, burst: null, drainSeconds: 30 }, {});
  assert.doesNotMatch(formatReport(quiet), /resets/);
});

test('every phase ends in a TCP reset the other side sees (an ECONNRESET or EPIPE error, which a clean close never causes), and the receipt phase only counts once the phone had its frame', async () => {
  const codes: string[] = [];
  const abrupt = () => codes.filter((c) => c === 'ECONNRESET' || c === 'EPIPE');
  const clients = new Set<WebSocket>();
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  server.on('connection', (socket) => socket.on('error', (e: any) => codes.push(e.code)));
  server.on('upgrade', (req, socket, head) =>
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.add(ws);
      ws.send(JSON.stringify({ t: 'hello' }));
      ws.on('message', (d) => {
        // lines that are not messages are skipped by the receipt phase (sent once the phone is listening)
        if (JSON.parse(String(d)).t === 'pair.join') {
          ws.send('not json');
          ws.send('null');
        }
        if (JSON.parse(String(d)).t === 'frame') for (const other of clients) if (other !== ws) other.send(String(d));
      });
      ws.on('error', () => undefined);
      ws.on('close', () => clients.delete(ws));
    }),
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const { port } = server.address() as net.AddressInfo;
  const resets = new Resets({ url: `ws://127.0.0.1:${port}/v1/ws`, sign: async () => 'token' });
  for (const phase of PHASES) {
    const before = abrupt().length;
    await resets.one(phase);
    await waitFor(() => abrupt().length > before, `${phase} to reach the server as a reset`);
    assert.equal(resets.done[phase], 1, `${phase} was made`);
    assert.ok(abrupt().length > before, `${phase} reached the server as a reset, not a clean close (${codes})`);
  }
  // a relay that never forwards the frame: the receipt phase is not made, and is not counted as made
  clients.clear();
  const silent = new Resets({ url: `ws://127.0.0.1:${port}/v1/ws`, sign: async () => 'token' });
  server.removeAllListeners('upgrade');
  server.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => ws.on('error', () => undefined)));
  await silent.one('ack');
  assert.equal(silent.done.ack, 0);
  assert.equal(silent.skipped, 1);
  // past the limit of resets under way, a reset is not made
  const crowd = new Resets({ url: `ws://127.0.0.1:${port}/v1/ws`, sign: async () => 'token', timeoutMs: 200 });
  await Promise.all(Array.from({ length: 40 }, () => crowd.one('hello')));
  assert.equal(crowd.done.hello + crowd.skipped, 40);
  assert.ok(crowd.skipped >= 1, 'some were not made');
  for (const ws of clients) ws.terminate();
  await new Promise((resolve) => server.close(resolve));
});

test('a relay child that ends on its own during a run is reported as a crash and fails the run', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'relay-load-'));
  const bin = path.join(dir, 'dies.mjs');
  const main = new URL('../relay/src/main.mjs', import.meta.url).href;
  const pg = new URL('../node_modules/@electric-sql/pglite/dist/index.js', import.meta.url).href;
  await writeFile(
    bin,
    `import { run } from '${main}'; import { PGlite } from '${pg}'; await run(process.env, { pool: new PGlite() }); setTimeout(() => process.exit(9), 1200);`,
  );
  const migrated = new PGlite();
  await migrate(migrated as any);
  await migrateDurable(migrated);
  const report: any = await runLoad(
    { pairs: 2, seconds: 3, database: 'postgres://127.0.0.1/x', restarts: 0, killRate: 0, burst: null, drainSeconds: 2 },
    { makePool: (async () => migrated) as any, bin },
  );
  assert.equal(report.chaos.relayCrashes, 1);
  assert.equal(verdict(report), 1);
  assert.match(formatReport({ ...report, chaos: { ...report.chaos, resets: { hello: 1 } } }), /relay process ended on its own 1 time/);
});

test('a socket opened after its reset gave up is destroyed at once, not left open', async () => {
  const seen: net.Socket[] = [];
  const silent = net.createServer((socket) => void seen.push(socket)).listen(0, '127.0.0.1');
  await new Promise((resolve) => silent.once('listening', resolve));
  const { port } = silent.address() as net.AddressInfo;
  // the token takes longer than the reset may: the job has already given up when the socket is opened
  const slow = new Resets({
    url: `ws://127.0.0.1:${port}/v1/ws`,
    sign: () => new Promise((resolve) => setTimeout(() => resolve('token'), 150)),
    timeoutMs: 30,
  });
  await slow.one('hello');
  assert.equal(slow.skipped, 1);
  await waitFor(() => seen[0]?.destroyed || seen.length === 0, 'the first connection to close');
  await idle(300);
  assert.ok(
    seen.every((s) => s.destroyed || s.readableEnded),
    'no connection is left open',
  );
  silent.close();
});
