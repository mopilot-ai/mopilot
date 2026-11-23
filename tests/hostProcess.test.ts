// The Host process package (host/): the ops commands, the data-dir-keyed paths, the 0600 secret file, and a real `serve` over its unix socket.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { main } from '../host/src/cli.mjs';
import { createPaths } from '../host/src/paths.mjs';
import { createFileSecretStore } from '../host/src/secretStore.mjs';
import { createImageDecoder, createOpenExternal, createPorts } from '../host/src/ports.mjs';
import { renderUnit } from '../host/src/install.mjs';
// @ts-ignore: plain ESM without declarations
import { launchdStop } from '../shared/host/launchd.mjs';
import { startServer, askHost } from '../host/src/server.mjs';
import { hostStatus } from '../host/src/status.mjs';
import { readJsonLines } from './support/jsonLineReader.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'host-test-'));
const io = (extra = {}) => {
  const out: string[] = [];
  const err: string[] = [];
  // what `uninstall` would have run to stop the service: never the machine's own launchctl or systemctl
  const stopped: { bin: string; args: string[] }[] = [];
  return {
    out,
    err,
    stopped,
    io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l), stopService: (c: any) => stopped.push(c), ...extra },
  };
};

test('W4: the socket and lock follow the data dir, so the Host and the app (or two Hosts) never share them', () => {
  const a = createPaths({ dataDir: '/tmp/a', env: {}, home: '/h' });
  const b = createPaths({ dataDir: '/tmp/b', env: {}, home: '/h' });
  assert.notEqual(a.socketPath, b.socketPath);
  assert.notEqual(a.lockPath, b.lockPath);
  assert.ok(a.socketPath.startsWith(a.dataDir) && a.lockPath.startsWith(a.dataDir));
  // a data dir too deep for sockaddr_un gets a short socket keyed on the dir, still unique per dir
  const deep = '/tmp/' + 'x'.repeat(120);
  const d1 = createPaths({ dataDir: deep + '1', env: {}, tmp: '/t' });
  const d2 = createPaths({ dataDir: deep + '2', env: {}, tmp: '/t' });
  assert.ok(d1.socketPath.length <= 100 && d1.socketPath !== d2.socketPath);
});

test('paths default per platform and honour MOPILOT_HOST_DATA, XDG_DATA_HOME and XDG_CONFIG_HOME', () => {
  assert.equal(createPaths({ env: {}, platform: 'darwin', home: '/h' }).dataDir, '/h/Library/Application Support/mopilot-host');
  assert.equal(createPaths({ env: {}, platform: 'linux', home: '/h' }).dataDir, '/h/.local/share/mopilot-host');
  const x = createPaths({ env: { XDG_DATA_HOME: '/d', XDG_CONFIG_HOME: '/c' }, platform: 'linux', home: '/h' });
  assert.deepEqual([x.dataDir, x.configDir], ['/d/mopilot-host', '/c/mopilot-host']);
  assert.equal(createPaths({ env: {}, platform: 'linux', home: '/h' }).configDir, '/h/.config/mopilot-host');
  const e = createPaths({ env: { MOPILOT_HOST_DATA: '/e' }, platform: 'linux', home: '/h' });
  assert.deepEqual([e.dataDir, e.configDir], ['/e', '/e/config']);
  assert.ok(createPaths({ env: {} }).dataDir.endsWith('mopilot-host'));
});

test('the secret store keeps values in a 0600 file and forgets deleted ones', () => {
  const dir = path.join(tmp(), 'cfg');
  const s = createFileSecretStore(dir);
  assert.equal(s.get('k'), null);
  s.set('k', 'v');
  s.set('j', 'w');
  assert.equal(s.get('k'), 'v');
  assert.equal(fs.statSync(path.join(dir, 'secrets.json')).mode & 0o777, 0o600);
  s.delete('k');
  assert.deepEqual([s.get('k'), s.get('j')], [null, 'w']);
  fs.writeFileSync(path.join(dir, 'secrets.json'), '{bad');
  assert.throws(() => s.get('k'));
});

test('ports: openExternal prints http(s) links only, and the missing image decoder fails loudly', async () => {
  const lines: string[] = [];
  const open = createOpenExternal((l: string) => lines.push(l));
  await open('https://example.com/x');
  assert.match(lines[0], /https:\/\/example\.com\/x/);
  await assert.rejects(open('file:///etc/passwd'), /http/);
  await assert.rejects(createImageDecoder().decode(new Uint8Array()), (e: any) => e.code === 'unavailable');
  const ports = createPorts({ dataDir: tmp(), env: {} });
  assert.deepEqual(Object.keys(ports).sort(), ['imageDecoder', 'openExternal', 'paths', 'secrets']);
  const quiet = createPorts({ dataDir: tmp(), env: {}, print: () => {} });
  await quiet.openExternal('http://x.test');
});

test('status says honestly which isolation guarantees are delivered and which are blocked', () => {
  const s = hostStatus({ running: false, platform: 'linux' });
  assert.equal(s.running, false);
  assert.ok(s.isolation.delivered.length > 0 && s.isolation.blocked.length > 0);
  assert.equal(s.capabilities.iab, false);
});

test('install renders a launchd plist on macOS and a systemd user unit on Linux', () => {
  const base = { nodePath: '/usr/bin/node', binPath: '/opt/h/bin/mopilot-host.mjs', dataDir: '/d&d' };
  const mac = renderUnit({ ...base, platform: 'darwin', home: '/h' });
  assert.equal(mac.file, '/h/Library/LaunchAgents/ai.mopilot.host.plist');
  assert.match(mac.text, /<key>KeepAlive<\/key><true\/>/);
  assert.match(mac.text, /\/d&amp;d/);
  const lin = renderUnit({ ...base, platform: 'linux', home: '/h' });
  assert.match(lin.file, /systemd\/user\/mopilot-host\.service$/);
  assert.match(lin.text, /Restart=always/);
  assert.match(lin.text, /Environment=MOPILOT_HOST_SUPERVISED=1/);
  assert.match(mac.text, /MOPILOT_HOST_SUPERVISED<\/key><string>1/);
  assert.match(lin.text, /ExecStart="\/usr\/bin\/node" "\/opt\/h\/bin\/mopilot-host\.mjs" "serve" "--data-dir" "\/d&d"/);
  assert.equal(renderUnit({ ...base, platform: 'linux', home: '/h' }).text, lin.text);
});

test('a --data-dir without a value is a usage error, not the default dir', async () => {
  for (const argv of [
    ['serve', '--data-dir'],
    ['serve', '--data-dir', '--foo'],
  ]) {
    const r = io();
    assert.equal(await main(argv, r.io), 1);
    assert.match(r.err[0], /Usage/);
  }
});

test('L: a control character in a value of the unit is refused, not written as a new directive or key', () => {
  const base = { home: '/h', nodePath: '/n', binPath: '/b', dataDir: '/d' };
  for (const platform of ['linux', 'darwin'] as const) {
    assert.throws(() => renderUnit({ ...base, platform, dataDir: '/d\nExecStartPre=/bin/evil' }), /data folder has a control character/);
    assert.throws(() => renderUnit({ ...base, platform, nodePath: '/n\r' }), /path of node has a control character/);
    assert.throws(() => renderUnit({ ...base, platform, binPath: '/b\u0000' }), /path of the Host has a control character/);
    assert.throws(() => renderUnit({ ...base, platform, env: { PATH: '/bin\nEnvironment=X=1' } }), /PATH has a control character/);
    assert.doesNotThrow(() => renderUnit({ ...base, platform, env: {} }));
  }
});

test('systemd units double $ and %; the socket is owner-only; an oversized line hangs up', async () => {
  const unit = renderUnit({ platform: 'linux', home: '/h', nodePath: '/n', binPath: '/b', dataDir: '/d$x%y' }).text;
  assert.match(unit, /\/d\$\$x%%y/);
  const paths = createPaths({ dataDir: tmp(), env: {} });
  const server = await startServer({ paths });
  const closed = new Promise((resolve) => {
    const s = net.connect(paths.socketPath, () => s.write('x'.repeat((1 << 20) + 1)));
    s.on('error', () => {});
    s.on('close', resolve);
  });
  await closed;
  assert.equal(await askHost(paths.socketPath, 'ping'), 'pong');
  await server.close();
});

test('the unit carries the installing shell’s PATH, so harnesses in a user’s own folders are found', () => {
  const base = { nodePath: '/n', binPath: '/b', dataDir: '/d', home: '/h' };
  const lin = renderUnit({ ...base, platform: 'linux', env: { PATH: '/home/u/.local/bin:/usr/bin' } });
  assert.match(lin.text, /^Environment="PATH=\/home\/u\/\.local\/bin:\/usr\/bin"$/m);
  assert.match(renderUnit({ ...base, platform: 'linux', env: { PATH: '/a%b:/c$d' } }).text, /Environment="PATH=\/a%%b:\/c\$\$d"/);
  const mac = renderUnit({ ...base, platform: 'darwin', env: { PATH: '/opt/x&y:/usr/bin' } });
  assert.match(mac.text, /<key>PATH<\/key><string>\/opt\/x&amp;y:\/usr\/bin<\/string>/);
  // no PATH to carry: the unit says nothing about it
  assert.doesNotMatch(renderUnit({ ...base, platform: 'linux', env: {} }).text, /PATH/);
  assert.doesNotMatch(renderUnit({ ...base, platform: 'darwin', env: {} }).text, /<key>PATH/);
});

test('ops commands: usage, not-yet commands, offline status, and install into a home dir', async () => {
  const dir = tmp();
  let r = io();
  assert.equal(await main([], r.io), 1);
  assert.match(r.err[0], /Usage/);
  r = io();
  assert.equal(await main(['update'], r.io), 1);
  assert.match(r.err[0], /Usage/);
  r = io();
  assert.equal(await main(['status', '--data-dir', dir], { ...r.io, env: {} }), 0);
  assert.equal(JSON.parse(r.out[0]).running, false);
  const home = tmp();
  for (const [platform, unit] of [
    ['linux', '.config/systemd/user/mopilot-host.service'],
    ['darwin', 'Library/LaunchAgents/ai.mopilot.host.plist'],
  ] as const) {
    r = io({ home, platform, env: { XDG_CONFIG_HOME: path.join(home, '.config') } });
    assert.equal(await main(['install', '--data-dir', dir], r.io), 0);
    assert.ok(fs.existsSync(path.join(home, unit)));
    assert.match(r.out[0], platform === 'darwin' ? /launchctl/ : /systemctl/);
  }
  // the XDG dir comes from the env the command was given, not the process's
  r = io({ home, platform: 'linux', env: { XDG_CONFIG_HOME: path.join(home, 'xdg') } });
  assert.equal(await main(['install', '--data-dir', dir], r.io), 0);
  assert.ok(fs.existsSync(path.join(home, 'xdg/systemd/user/mopilot-host.service')));
  // without XDG_CONFIG_HOME the unit goes under ~/.config
  r = io({ home: tmp(), platform: 'linux', env: {} });
  assert.equal(await main(['install', '--data-dir', dir], r.io), 0);
  assert.match(r.out[0], /\.config\/systemd\/user\/mopilot-host\.service/);
  // uninstall removes the unit and says so; a second one finds nothing and still succeeds (idempotent)
  r = io({ home, platform: 'linux', env: { XDG_CONFIG_HOME: path.join(home, 'xdg') } });
  assert.equal(await main(['uninstall', '--data-dir', dir], r.io), 0);
  assert.match(r.out[0], /^Removed .*mopilot-host\.service/);
  // the service is stopped with the system's tool, so the Host does not outlive its uninstall
  assert.deepEqual(r.stopped, [{ bin: 'systemctl', args: ['--user', 'disable', '--now', 'mopilot-host'] }]);
  assert.ok(!fs.existsSync(path.join(home, 'xdg/systemd/user/mopilot-host.service')));
  r = io({ home, platform: 'linux', env: { XDG_CONFIG_HOME: path.join(home, 'xdg') } });
  assert.equal(await main(['uninstall', '--data-dir', dir], r.io), 0);
  assert.match(r.out[0], /^No unit at /);
  assert.equal(r.stopped.length, 1, 'a unit that is gone may still have a service running');
  // on a Mac launchd unloads by the plist, which is written with a log file in the data folder
  r = io({ home, platform: 'darwin', env: {} });
  assert.equal(await main(['install', '--data-dir', dir], r.io), 0);
  const plist = path.join(home, 'Library/LaunchAgents/ai.mopilot.host.plist');
  assert.match(fs.readFileSync(plist, 'utf8'), new RegExp(`<key>StandardErrorPath</key><string>${path.join(dir, 'host.log')}</string>`));
  assert.equal(await main(['uninstall', '--data-dir', dir], r.io), 0);
  assert.deepEqual(r.stopped, [{ bin: '/bin/sh', args: ['-c', launchdStop()] }]);
  // with no platform given, the one this process runs on decides
  r = io({ home, env: { XDG_CONFIG_HOME: path.join(home, '.config') } });
  assert.equal(await main(['install', '--data-dir', dir], r.io), 0);
});

test('serve answers over its unix socket, refuses a second Host on the same dir and cleans up on close', async () => {
  const paths = createPaths({ dataDir: tmp(), env: {} });
  const server = await startServer({ paths });
  assert.equal(fs.statSync(paths.socketPath).mode & 0o777, 0o600);
  assert.equal(((await askHost(paths.socketPath, 'status')) as any).running, true);
  assert.equal(await askHost(paths.socketPath, 'ping'), 'pong');
  await assert.rejects(startServer({ paths }), /already uses/);
  // junk and unknown methods get an error reply, not a crash
  const s = net.connect(paths.socketPath, () => s.write('nope\n{"id":7,"method":"x"}\nnull\n'));
  const replies = await readJsonLines(s).wait(3);
  s.end();
  assert.equal(replies[0].error, 'Not JSON.');
  assert.deepEqual([replies[1].id, replies[1].error], [7, 'Unknown method x.']);
  assert.equal(replies[2].id, null);
  await server.close();
  assert.equal(fs.existsSync(paths.socketPath), false);
  assert.equal(fs.existsSync(paths.lockPath), false);
  assert.equal(await askHost(paths.socketPath, 'ping'), null);
});

test('askHost gets null for a Host that hangs up without answering or does not know the method', async () => {
  const dir = tmp();
  const paths = createPaths({ dataDir: dir, env: {} });
  const mute = net.createServer((s) => s.end());
  await new Promise((r) => mute.listen(paths.socketPath, () => r(undefined)));
  assert.equal(await askHost(paths.socketPath, 'status'), null);
  mute.close();
  const server = await startServer({ paths: createPaths({ dataDir: tmp(), env: {} }) });
  await server.close();
  const live = createPaths({ dataDir: tmp(), env: {} });
  const real = await startServer({ paths: live });
  assert.equal(await askHost(live.socketPath, 'nothing'), null);
  await real.close();
});

test('the default output goes to the process streams', async () => {
  const err = mock.method(process.stderr, 'write', () => true);
  assert.equal(await main([]), 1);
  const ports = createPorts({ dataDir: tmp(), env: {} });
  await ports.openExternal('https://a.test');
  const written = err.mock.calls.map((c: any) => String(c.arguments[0]));
  assert.ok(written.some((l: string) => l.includes('Usage')) && written.some((l: string) => l.includes('https://a.test')));
  err.mock.restore();
  const out = mock.method(process.stdout, 'write', () => true);
  assert.equal(await main(['status', '--data-dir', tmp()]), 0);
  out.mock.restore();
  assert.ok(out.mock.calls.some((c: any) => String(c.arguments[0]).includes('"running":false')));
});

test('a lock left by a dead process is replaced, and an unreadable lock dir is reported', async () => {
  const paths = createPaths({ dataDir: tmp(), env: {} });
  fs.writeFileSync(paths.lockPath, '999999999');
  const server = await startServer({ paths });
  assert.equal(fs.readFileSync(paths.lockPath, 'utf8'), String(process.pid));
  await server.close();
  // a live holder (this process, or pid 1 which we may not signal) keeps the lock
  for (const pid of [process.pid, 1]) {
    fs.writeFileSync(paths.lockPath, String(pid));
    await assert.rejects(startServer({ paths }), /already uses/);
  }
  // a second starter that loses the rename race finds the lock gone and takes it only if still free
  fs.writeFileSync(paths.lockPath, '999999999');
  const lost = mock.method(fs, 'renameSync', () => {
    fs.rmSync(paths.lockPath);
    throw Object.assign(new Error('gone'), { code: 'ENOENT' });
  });
  await (await startServer({ paths })).close();
  lost.mock.restore();
  fs.writeFileSync(paths.lockPath, 'not a pid');
  await (await startServer({ paths })).close();
  await assert.rejects(startServer({ paths: { ...paths, lockPath: path.join(paths.dataDir, 'missing', 'host.lock') } }), /ENOENT/);
  const bad = createPaths({ dataDir: tmp(), env: {} });
  fs.mkdirSync(bad.lockPath);
  await assert.rejects(startServer({ paths: bad }));
  // a socket path that cannot be bound releases the lock again
  const noBind = { ...createPaths({ dataDir: tmp(), env: {} }), socketPath: '/nonexistent-dir/x.sock' };
  await assert.rejects(startServer({ paths: noBind }));
  assert.equal(fs.existsSync(noBind.lockPath), false);
});

test('A5 and smoke: `bin serve` runs with no client attached, answers `status`, and stops on SIGTERM', async () => {
  const dir = tmp();
  const bin = path.join(import.meta.dirname, '..', 'host', 'bin', 'mopilot-host.mjs');
  const child = spawn(process.execPath, [bin, 'serve', '--data-dir', dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  await new Promise((resolve) => child.stdout.once('data', resolve));
  // no client has connected; the process stays up
  const sock = createPaths({ dataDir: dir, env: {} }).socketPath;
  assert.equal(((await askHost(sock, 'status')) as any).running, true);
  assert.equal(child.exitCode, null);
  child.kill('SIGTERM');
  assert.equal(await exited, 0);
  assert.equal(fs.existsSync(sock), false);
});

test('the Host imports nothing from the app layers or Electron', () => {
  const boundary = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'host', 'boundary.json'), 'utf8'));
  const forbidden = boundary.forbidden as string[];
  const root = path.join(import.meta.dirname, '..', 'host');
  const files = (d: string): string[] =>
    fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of files(root).filter((x) => /\.[cm]?js$/.test(x))) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/(?:from|import\(|require\()\s*['"]([^'"]+)['"]/g)) {
      const spec = m[1];
      assert.ok(!boundary.modules.some((x: string) => spec === x || spec.startsWith(`${x}/`)), `${path.relative(root, f)} imports ${spec}`);
      const target = spec.startsWith('.') ? path.relative(path.join(root, '..'), path.resolve(path.dirname(f), spec)) : spec;
      assert.ok(!forbidden.some((p) => target === p || target.startsWith(p)), `${path.relative(root, f)} imports ${spec}`);
    }
  }
});

test('serve on a data dir another Host holds fails with that reason, ends nothing the other Host started and leaves its record alone', async () => {
  const dir = tmp();
  const paths = createPaths({ dataDir: dir, env: {} });
  const holder = await startServer({ paths });
  fs.writeFileSync(
    path.join(dir, 'children.json'),
    JSON.stringify({ hostPid: process.pid, children: [{ pid: process.pid, label: 'x', startedAt: 1 }] }),
  );
  fs.writeFileSync(path.join(dir, 'running.json'), JSON.stringify({ t1: 'chat-a' }));
  const { io: quiet } = io();
  await assert.rejects(main(['serve', '--data-dir', dir], quiet as any), /already uses/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'children.json'), 'utf8')).children[0].pid, process.pid);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'running.json'), 'utf8')), { t1: 'chat-a' });
  await holder.close();
});

test('uninstall stops the service with the system’s own tool, found on the PATH, and a tool that is missing is not an error', async () => {
  const home = tmp();
  const bin = tmp();
  const log = path.join(bin, 'ran');
  fs.writeFileSync(path.join(bin, 'systemctl'), `#!/bin/sh\necho "$@" > "${log}"\n`, { mode: 0o755 });
  const saved = process.env.PATH;
  try {
    process.env.PATH = bin;
    const r = io({ home, platform: 'linux', env: {}, stopService: undefined });
    delete (r.io as any).stopService;
    assert.equal(await main(['uninstall', '--data-dir', tmp()], r.io), 0);
    assert.equal(fs.readFileSync(log, 'utf8').trim(), '--user disable --now mopilot-host');
    fs.rmSync(path.join(bin, 'systemctl'));
    // no platform given: this machine's own tool, which the empty PATH does not have
    const missing = io({ home, env: {} });
    delete (missing.io as any).stopService;
    assert.equal(await main(['uninstall', '--data-dir', tmp()], missing.io), 0);
  } finally {
    process.env.PATH = saved;
  }
});

test('serve stops at once without the Rust core, and says why', async () => {
  const r = io();
  assert.equal(await main(['serve', '--data-dir', tmp()], { ...r.io, coreProblemHere: () => 'The Rust core is missing.' }), 1);
  assert.deepEqual(r.err, ['The Rust core is missing.']);
});
