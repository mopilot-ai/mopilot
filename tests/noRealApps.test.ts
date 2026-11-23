// tests/support/no-real-apps.ts: every unit test runs with the child_process launchers refusing a real app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { startsRealApp, shellStartsRealApp, guardLaunchers } from './support/no-real-apps.ts';

export const GUARDS = ['electron/capabilities/', 'package.json', 'tests/support/'];

test('a real app is a browser, a program in a .app bundle, or an opener: macOS open or xdg-open', () => {
  for (const [command, args] of [
    ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--user-data-dir=/tmp/x', 'http://127.0.0.1:1/login']],
    ['/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary', []],
    ['/Applications/Chromium.app/Contents/MacOS/Chromium', []],
    ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', []],
    ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', []],
    ['google-chrome', []],
    ['/usr/bin/google-chrome-stable', []],
    ['/usr/bin/chromium-browser', []],
    ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', []],
    ['msedge.exe', []],
    ['open', ['-a', 'Google Chrome', 'https://example.com']],
    ['/usr/bin/open', ['-na', '/Applications/Arc.app']],
    // the computer-use helper, as ComputerHelper launches it and as its own executable
    ['/usr/bin/open', ['-n', '-g', '-a', '/r/native/helper/build/MoPilot.app', '--args', '--launch', '/t/l.json']],
    ['/r/native/helper/build/MoPilot.app/Contents/MacOS/MoPilot Computer Use', []],
    ['/Applications/Notes.app/Contents/MacOS/Notes', []],
    // open always opens something: the default browser, an app, a file in its app, Finder
    ['/usr/bin/open', ['https://example.com']],
    ['open', ['-a', 'Notes']],
    ['open', ['-R', '/tmp/file.txt']],
    ['xdg-open', ['https://example.com']],
    ['/usr/bin/xdg-open', ['/tmp/file.txt']],
    ['gio', ['open', 'https://example.com']],
    ['sensible-browser', []],
    ['wslview', ['https://example.com']],
    ['explorer.exe', ['https://example.com']],
    // AppleScript can launch and raise any app
    ['/usr/bin/osascript', ['-e', 'tell application "Terminal" to activate']],
  ] as const) {
    assert.equal(startsRealApp(command), true, `${command} ${args.join(' ')}`);
  }
  for (const [command, args] of [
    ['/bin/ps', ['-axo', 'command=']],
    ['git', ['log', '--grep', 'Google Chrome']],
    ['node', ['scripts/chrome-compare/run.mjs']],
    ['chrome-launcher-helper', []],
    ['/usr/local/bin/opener', []],
    ['/tmp/x.app/Info.plist', []],
    [42, []],
  ] as const) {
    assert.equal(startsRealApp(command), false, `${String(command)} ${args.join(' ')}`);
  }
});

test('a shell command line starts a real app when any command in it does', () => {
  for (const line of [
    'open https://example.com',
    'cd /tmp && open .',
    'true; /usr/bin/xdg-open file.txt',
    'FOO=1 BAR=2 open -a Notes',
    'exec osascript -e "tell application \\"Finder\\" to activate"',
    'cmd /c start https://example.com',
    '"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --version',
    'git status | (open x)',
    "sh -c 'open https://example.com'",
    'bash -c "true; osascript -e x"',
    "bash -lc 'open .'",
  ])
    assert.equal(shellStartsRealApp(line), true, line);
  for (const line of [
    'git log --grep open',
    'echo open',
    'ls -la /Applications',
    'FOO=open node x.js',
    'exec',
    '',
    'sh',
    'bash script.sh open',
  ])
    assert.equal(shellStartsRealApp(line), false, line);
});

test('the launchers refuse a real app and pass everything else through, once even if guarded twice', () => {
  const calls: unknown[][] = [];
  const cp: Record<string, any> = {};
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync'])
    cp[name] = (...a: unknown[]) => (calls.push([name, ...a]), 'ran');
  guardLaunchers(cp);
  const first = cp.spawn;
  guardLaunchers(cp);
  assert.equal(cp.spawn, first);
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync']) {
    assert.throws(() => cp[name]('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', []), /never launch real apps/);
    assert.equal(cp[name]('git', ['status']), 'ran');
  }
  assert.deepEqual(
    calls.map((c) => c[0]),
    ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync'],
  );
  // a command line a shell reads: exec and execSync always, spawn and execFile with shell: true
  assert.throws(() => cp.exec('cd /tmp && open .', () => {}), /real app/);
  assert.throws(() => cp.execSync('open https://example.com', { encoding: 'utf8' }), /real app/);
  assert.throws(() => cp.spawn('open https://example.com', { shell: true }), /real app/);
  assert.throws(() => cp.spawn('sh', ['-c', 'open x'], { shell: true }), /real app/);
  assert.equal(
    cp.exec('git log --grep open', () => {}),
    'ran',
  );
  assert.equal(cp.spawn('echo open', { shell: true }), 'ran');
  assert.equal(cp.spawn('echo', ['open'], { stdio: 'ignore' }), 'ran', 'without a shell, an argument is only an argument');
  assert.equal(cp.spawn('git', ['status'], null), 'ran');
  // a script handed to a shell directly
  assert.throws(() => cp.spawn('/bin/sh', ['-c', 'cd /tmp && open .']), /real app/);
  assert.throws(() => cp.execFile('zsh', ['-c', 'xdg-open x']), /real app/);
  assert.throws(() => cp.execFileSync('bash', ['-lc', 'open .'], {}), /real app/);
  assert.equal(cp.execFileSync('bash', ['-lc', 'true'], {}), 'ran');
  assert.equal(cp.spawn('sh', ['-c', 'git status']), 'ran');
  assert.equal(cp.spawn('sh', ['script.sh', 'open']), 'ran', 'a script file is not read');
  assert.equal(cp.spawn(42 as any, []), 'ran', 'not a command: the real launcher reports it');
  // the real module is guarded for every unit test (tests/support/register.ts)
  assert.throws(() => childProcess.spawnSync('google-chrome', ['--version']), /real app/);
  assert.throws(() => childProcess.execFileSync('/usr/bin/open', ['-R', '/tmp']), /never launch real apps/);
  assert.throws(() => childProcess.execSync('open -R /tmp'), /never launch real apps/);
});

test('exec and execFile keep their promisified forms ({ stdout, stderr }), behind the same check', async () => {
  const cp: Record<string, any> = {};
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync']) cp[name] = () => 'ran';
  cp.execFile[promisify.custom] = async (command: string) => ({ stdout: `out of ${command}`, stderr: '' });
  cp.exec[promisify.custom] = async (command: string) => ({ stdout: `shell ran ${command}`, stderr: '' });
  guardLaunchers(cp);
  const run = promisify(cp.execFile);
  assert.deepEqual(await run('git', ['status']), { stdout: 'out of git', stderr: '' });
  await assert.rejects(run('google-chrome', []), /never launch real apps/);
  const shell = promisify(cp.exec);
  assert.deepEqual(await shell('git status'), { stdout: 'shell ran git status', stderr: '' });
  await assert.rejects(shell('cd /tmp; open .'), /never launch real apps/);
  // the real execFile still resolves both streams
  assert.deepEqual(await promisify(childProcess.execFile)(process.execPath, ['-e', 'process.stdout.write("ok")']), {
    stdout: 'ok',
    stderr: '',
  });
});

test('the computer-use helper is never launched from a unit test, even where it is built', async (t) => {
  // tests/controlMatrixSky.test.ts reached a ComputerHelper that `open`ed the built helper in the benchmark VM's
  // checkout: four helpers stayed connected and the test process never exited (#1321's control-matrix suite)
  const require = createRequire(import.meta.url);
  const { ComputerHelper } = require('../electron/capabilities/computer.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-real-apps-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const helper = new ComputerHelper({
    appPath: path.join(dir, 'MoPilot.app'),
    platform: 'darwin',
    exists: () => true,
    connectTimeoutMs: 100,
  });
  await assert.rejects(helper.start(), /never launch real apps/);
  assert.equal(helper.socket, null);
});
