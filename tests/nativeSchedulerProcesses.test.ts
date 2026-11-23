// Whether a native app that runs scheduled tasks is open (electron/platform/nativeSchedulers.cjs): the process list from the core, or Get-Process on Windows, and which of its lines are an app's main executable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { codexApp, claudeDesktop, processList, APP_PROCESS } = createRequire(import.meta.url)('../electron/platform/nativeSchedulers.cjs');

test('the process list is the files the core names on POSIX and Get-Process on Windows; a failure reads as empty', async () => {
  const calls: any[] = [];
  const exec = (cmd: string, args: string[], _o: any, cb: any) => (calls.push([cmd, args[0]]), cb(null, 'out'));
  const call = async (route: string) => (
    calls.push([route]),
    [
      [1, 0, '(launchd)', ''],
      [2, 1, 'sh -c a', '/bin/sh'],
      [3, 1, 'x', '/a\r\n/Applications/Claude.app/Contents/MacOS/Claude'],
    ]
  );
  assert.equal(await processList('darwin', { exec, call }), '/bin/sh\n/a /Applications/Claude.app/Contents/MacOS/Claude');
  assert.equal(await processList('win32', { exec, call }), 'out');
  assert.deepEqual(calls, [['proc.commands'], ['powershell.exe', '-NoProfile']]);
  const failing = async () => {
    throw new Error('read the process table: EPERM');
  };
  assert.equal(await processList('linux', { exec, call: failing }), '', 'a failed read');
  assert.equal(await processList('linux', { exec, call: async () => [[2, 1, '/sbin/init', '']] }), '', 'Linux names no file');
  assert.equal(await processList('win32', { exec: (_c: string, _a: string[], _o: any, cb: any) => cb(new Error('no powershell')) }), '');
  assert.equal(typeof (await processList()), 'string', 'the real list');
  if (process.platform === 'darwin')
    assert.ok((await processList()).split('\n').includes(process.execPath), 'the real core names this file');
});

test('an app counts as open only for its main executable, not its helpers or the CLI it bundles', async () => {
  const running = (list: string) => codexApp({ codexHome: () => '/none', processes: async () => list }).running();
  assert.equal(await running('/Applications/ChatGPT.app/Contents/MacOS/ChatGPT\n'), true);
  assert.equal(await running('/Applications/Codex.app/Contents/MacOS/Codex'), true);
  assert.equal(await running('/Applications/ChatGPT.app/Contents/Resources/codex-cli/codex\n/usr/bin/zsh'), false);
  assert.equal(await running('C:\\Program Files\\WindowsApps\\OpenAI.Codex_1\\app\\Codex.exe\r\n'), true);
  const desktop = (list: string) => claudeDesktop({ appData: () => '/none', processes: async () => list }).running();
  assert.equal(await desktop('/Applications/Claude.app/Contents/MacOS/Claude'), true);
  assert.equal(await desktop('/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper'), false);
  assert.equal(await desktop('/Users/me/.local/bin/claude'), false);
  assert.equal(await desktop('C:\\Users\\me\\AppData\\Local\\AnthropicClaude\\app-1.2\\claude.exe'), true);
  assert.equal(APP_PROCESS['codex-app'].length, 2);
});

test('an app is open by the file a process runs, never by what its arguments name', async () => {
  const CLAUDE = '/Applications/Claude.app/Contents/MacOS/Claude';
  const open = (command: string, executable: string) =>
    claudeDesktop({
      appData: () => '/none',
      processes: () => processList('darwin', { call: async () => [[7, 1, command, executable]] }),
    }).running();
  assert.equal(await open(`${CLAUDE} --enable-logging`, CLAUDE), true);
  // what a text match on the command line took for the app
  assert.equal(await open('/usr/bin/lldb ./Claude.app/Contents/MacOS/Claude', '/usr/bin/lldb'), false);
  assert.equal(await open(`/usr/bin/curl https://example.com${CLAUDE}`, '/usr/bin/curl'), false);
  assert.equal(await open(`/usr/bin/env bar=${CLAUDE}`, '/usr/bin/env'), false);
  assert.equal(await open(`/bin/cat foo${CLAUDE}`, '/bin/cat'), false);
  // and what it missed: a folder that reads like an argument, or that ends in a space
  for (const folder of ['/Users/me/Apps -x', '/Users/me/Old Apps ', '/Users/me/My /Apps']) {
    const app = `${folder}/Claude.app/Contents/MacOS/Claude`;
    assert.equal(await open(app, app), true, folder);
  }
  // the kernel gives another user's process its name alone
  assert.equal(await open('(Claude)', ''), false);
  const running = (executable: string) =>
    codexApp({
      codexHome: () => '/none',
      processes: () => processList('darwin', { call: async () => [[7, 1, 'x', executable]] }),
    }).running();
  assert.equal(await running('/Applications/ChatGPT.app/Contents/MacOS/ChatGPT'), true);
  assert.equal(await running('/Applications/Codex.app/Contents/Resources/codex'), false);
});
