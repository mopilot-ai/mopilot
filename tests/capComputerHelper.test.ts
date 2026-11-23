// The computer-use helper client over an in-process stand-in helper: the launch through a fake
// `open`, connect retries, the JSON-RPC framing, timeouts, errors, pauses and the thin wrappers.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { ComputerHelper, HelperError, lineDecoder } = require('../electron/capabilities/computer.cjs');
const { withFloor } = require('../electron/capabilities/computerContract.cjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-cu-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const appPath = path.join(dir, 'Helper.app');
fs.writeFileSync(appPath, '');

/** A helper stand-in on `socketPath`: answers hello, echoes calls, and follows a few test methods. */
function standIn(socketPath: string) {
  const calls: any[] = [];
  const conns: net.Socket[] = [];
  const server = net.createServer((s) => {
    conns.push(s);
    s.setEncoding('utf8');
    s.on(
      'data',
      lineDecoder((m: any) => {
        calls.push(m);
        const reply = (r: any) => s.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, ...r }) + '\n');
        if (m.method === 'hello') return reply({ result: { pid: 7, token: m.params.token } });
        if (m.method === 'boom') return reply({ error: { code: -1, message: 'bad', data: { reason: 'denied' } } });
        if (m.method === 'plainError') return reply({ error: { code: -2, message: 'plain' } });
        if (m.method === 'silent' || m.method === 'shutdown') return;
        if (m.method === 'input.idle') return reply({ result: { seconds: 12 } });
        if (m.method === 'pause') {
          s.write('\n' + JSON.stringify({ method: 'control.paused', params: { reason: 'escape' } }) + '\n');
          s.write(JSON.stringify({ method: 'control.paused' }) + '\n');
          s.write(JSON.stringify({ method: 'record.event', params: { t: 5, kind: 'key', text: 'a' } }) + '\n');
          s.write(JSON.stringify({ method: 'record.event' }) + '\n');
          s.write(JSON.stringify({ method: 'click.dispatched', params: { signal: 'sig-1' } }) + '\n');
          s.write(JSON.stringify({ method: 'click.dispatched' }) + '\n');
          s.write(JSON.stringify({ method: 'other' }) + '\n');
          s.write(JSON.stringify({ id: 999, result: 1 }) + '\n');
          return reply({ result: 'ok' });
        }
        reply({ result: { method: m.method, params: m.params } });
      }),
    );
  });
  const listening = new Promise<void>((r) => server.listen(socketPath, () => r()));
  return { server, calls, conns, listening, close: () => (conns.forEach((c) => c.destroy()), server.close()) };
}

/** A fake `open`: reads the launch config and starts the stand-in after `delayMs`, or fails. */
function fakeOpen(o: { code?: number; error?: boolean; delayMs?: number; noServer?: boolean } = {}) {
  const launched: any[] = [];
  const spawn = (cmd: string, args: string[]) => {
    const child: any = new EventEmitter();
    child.stderr = new EventEmitter();
    launched.push({ cmd, args });
    const config = JSON.parse(fs.readFileSync(args.at(-1)!, 'utf8'));
    setImmediate(() => {
      if (o.error) return child.emit('error', new Error('spawn ENOENT'));
      if (o.code) {
        child.stderr.emit('data', ' LSOpen failed \n');
        return child.emit('exit', o.code);
      }
      if (!o.noServer) setTimeout(() => launched.push(standIn(config.socket)), o.delayMs ?? 0);
      child.emit('exit', 0);
    });
    return child;
  };
  return { spawn, launched };
}

test('lineDecoder: bad lines go to the default no-op error handler', () => {
  const got: any[] = [];
  lineDecoder((m: any) => got.push(m))('nope\n{"a":1}\n');
  assert.deepEqual(got, [{ a: 1 }]);
});

test('HelperError carries the code and reason', () => {
  const e = new HelperError('m', -1, 'r');
  assert.deepEqual([e.message, e.code, e.reason], ['m', -1, 'r']);
});

test('start: not on macOS, or without the helper app, it refuses', async () => {
  await assert.rejects(new ComputerHelper({ appPath, platform: 'linux' }).start(), /needs macOS/);
  await assert.rejects(new ComputerHelper({ appPath: path.join(dir, 'missing.app'), platform: 'darwin' }).start(), /helper not found/);
});

test('start: open fails or errors, and the private folder is removed', async () => {
  const bad = new ComputerHelper({ appPath, platform: 'darwin', spawn: fakeOpen({ code: 1 }).spawn });
  await assert.rejects(bad.start(), /open failed \(1\): LSOpen failed/);
  assert.equal(bad.dir, null);
  const err = new ComputerHelper({ appPath, platform: 'darwin', spawn: fakeOpen({ error: true }).spawn });
  await assert.rejects(err.start(), /spawn ENOENT/);
});

test('start: a helper that never listens times out', async () => {
  const h = new ComputerHelper({ appPath, platform: 'darwin', spawn: fakeOpen({ noServer: true }).spawn, connectTimeoutMs: 50 });
  await assert.rejects(h.start(), /computer-use helper did not start/);
  assert.equal(h.running, false);
});

test('start: launches through open with the config, retries the connect, says hello with the token; once', async () => {
  const open = fakeOpen({ delayMs: 150 });
  const h = new ComputerHelper({ appPath, platform: 'darwin', spawn: open.spawn, mainPid: 42, denyBundleIds: ['x'] });
  const [a, b] = await Promise.all([h.start(), h.start()]);
  assert.equal(a, b);
  assert.equal(open.launched.length, 2); // one open, one stand-in
  const { cmd, args } = open.launched[0];
  assert.equal(cmd, '/usr/bin/open');
  assert.deepEqual(args.slice(0, 4), ['-n', '-g', '-a', appPath]);
  const cfg = JSON.parse(fs.readFileSync(args.at(-1), 'utf8'));
  // it holds the token: only this user can read it, and it is the only file in the private folder
  assert.equal(fs.statSync(args.at(-1)).mode & 0o777, 0o600);
  assert.deepEqual(
    fs.readdirSync(path.dirname(args.at(-1))).filter((f) => f !== 'h.sock'),
    ['launch.json'],
  );
  assert.equal(cfg.mainPid, 42);
  assert.deepEqual(cfg.denyBundleIds, withFloor(['x']), "the floor first, then the user's");
  assert.equal(a.token, cfg.token);
  assert.equal(await h.start(), a);
  assert.equal(h.running, true);
  const configDir = h.dir;
  h.stop();
  assert.equal(fs.existsSync(configDir), false);
  open.launched[1].close();
});

async function connected(callTimeoutMs?: number) {
  const sock = path.join(dir, `s${Math.random().toString(36).slice(2, 8)}.sock`);
  const stand = standIn(sock);
  await stand.listening;
  const h = new ComputerHelper({ connectTo: sock, callTimeoutMs });
  await h.start();
  return { h, stand };
}

test('calls: errors with and without a reason, a timeout, a pause, and after the helper went away', async () => {
  const { h, stand } = await connected(50);
  await assert.rejects(h.call('boom'), (e: any) => e instanceof HelperError && e.code === -1 && e.reason === 'denied');
  await assert.rejects(h.call('plainError'), (e: any) => e.reason === undefined && e.message === 'plain');
  await assert.rejects(h.call('silent'), /silent timed out/);
  const paused: any[] = [];
  h.on('paused', (p: any) => paused.push(p));
  const recorded: any[] = [];
  h.on('record', (e: any) => recorded.push(e));
  const clicked: any[] = [];
  h.on('clicked', (e: any) => clicked.push(e));
  assert.equal(await h.call('pause'), 'ok');
  // the helper's early "mouse-down went out" (click.dispatched) reaches main as 'clicked'
  assert.deepEqual(clicked, [{ signal: 'sig-1' }, {}]);
  // a person's click or key while recording (watch-and-record) reaches main as 'record'
  assert.deepEqual(recorded, [{ t: 5, kind: 'key', text: 'a' }, {}]);
  assert.deepEqual(paused, [{ reason: 'escape' }, {}]);
  const pending = h.call('silent', {}, { timeoutMs: 5000 });
  const exited = new Promise((r) => h.once('exit', r));
  stand.conns[0].destroy();
  // a request that may have acted is not replayed: the helper is relaunched and the call says so
  await assert.rejects(pending, (e: any) => e instanceof HelperError && e.reason === 'helper_restarted' && /was restarted/.test(e.message));
  await exited;
  assert.equal(h.running, true);
  // once stopped, a cleanup request does not launch a helper just to undo nothing
  h.stop();
  assert.equal(h.running, false);
  await assert.rejects(h.call('glow.stop'), (e: any) => e instanceof HelperError && e.reason === 'helper_not_running');
  stand.close();
});

test('stop: a socket that cannot be written is still closed; an old socket closing later is ignored', async () => {
  const { h, stand } = await connected();
  const s = h.socket;
  s.write = () => {
    throw new Error('EPIPE');
  };
  h.stop();
  assert.equal(h.running, false);
  h.stop(); // nothing left to close
  stand.close();
});

test('wrappers: each sends its method and parameters', async () => {
  const { h, stand } = await connected();
  const r = (p: Promise<any>) => p.then((v: any) => [v.method, v.params]);
  assert.deepEqual(await r(h.permissionStatus()), ['permissions.status', {}]);
  assert.deepEqual(await r(h.requestPermission('accessibility')), ['permissions.request', { kind: 'accessibility' }]);
  assert.deepEqual(await r(h.openSettings('screenRecording')), ['permissions.openSettings', { kind: 'screenRecording' }]);
  assert.deepEqual(await r(h.speechStatus('en')), ['speech.status', { language: 'en' }]);
  assert.deepEqual(await r(h.speechRequest('zh')), ['speech.request', { language: 'zh' }]);
  assert.deepEqual(await r(h.speechTranscribe('AAA', 'auto')), ['speech.transcribe', { audio: 'AAA', language: 'auto' }]);
  assert.deepEqual(await r(h.setDeny(['a'])), ['deny.set', { bundleIds: withFloor(['a']) }]);
  assert.deepEqual(await r(h.screenshot()), ['screenshot', {}]);
  assert.deepEqual(await r(h.targetInfo()), ['target.info', {}]);
  assert.deepEqual(await r(h.targetInfo({ x: 1, y: 2 })), ['target.info', { x: 1, y: 2 }]);
  assert.deepEqual(await r(h.axSnapshot()), ['ax.snapshot', {}]);
  assert.deepEqual(await r(h.ocrElements()), ['ocr.elements', {}]);
  assert.equal(await h.idleSeconds(), 12);
  assert.deepEqual(await r(h.acquireControl('chat')), ['control.acquire', { holder: 'chat' }]);
  assert.deepEqual(await r(h.releaseControl()), ['control.release', {}]);
  assert.deepEqual(await r(h.glowStart(5)), ['glow.start', { pid: 5 }]);
  assert.deepEqual(await r(h.glowStop()), ['glow.stop', {}]);
  assert.deepEqual(await r(h.resumeControl()), ['control.resume', {}]);
  assert.deepEqual(await r(h.click(1, 2)), ['input.click', { x: 1, y: 2 }]);
  assert.deepEqual(await r(h.type('hi')), ['input.type', { text: 'hi' }]);
  assert.deepEqual(await r(h.key('Return')), ['input.key', { key: 'Return' }]);
  assert.deepEqual(await r(h.scroll(1, 2, 0, -3)), ['input.scroll', { x: 1, y: 2, dx: 0, dy: -3 }]);
  h.stop();
  stand.close();
});

test('computer-helper contracts retain facade identities and development and packaged launch paths', () => {
  const entry = require('../electron/capabilities/computer.cjs');
  const contract = require('../electron/capabilities/computerContract.cjs');
  for (const [name, value] of Object.entries(contract)) assert.equal(entry[name], value, name);
  assert.equal(contract.helperAppPath(), path.join(import.meta.dirname, '..', 'native/helper/build', `${contract.HELPER_NAME}.app`));
  assert.equal(contract.helperAppPath({ repoRoot: '/repo' }), path.join('/repo', 'native/helper/build', `${contract.HELPER_NAME}.app`));
  assert.equal(
    contract.helperAppPath({ packaged: true, resourcesPath: '/App/Contents/Resources' }),
    path.join('/App/Contents/Helpers', `${contract.HELPER_NAME}.app`),
  );
  assert.deepEqual(contract.launchArgs('/Helper.app', '/launch.json'), [
    '-n',
    '-g',
    '-a',
    '/Helper.app',
    '--args',
    '--launch',
    '/launch.json',
  ]);
});
