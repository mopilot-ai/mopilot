// The shared harness install table (shared/harnessInstall.mjs): every supported harness has a command or a vendor
// page on every OS, the registry carries the same table, and the lines a machine shows follow its tools.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const install = await import('../shared/harnessInstall.mjs');
const { HARNESS_INSTALL, INSTALL_VIA_LABEL, installArgv, installGroup, installLines, installMethod, installOs } = install;
const { REGISTRY } = await import('../src/harness/registry.ts');

const ALL = { npm: true, brew: true, npmWritable: true };

test('every supported harness has, on every OS, a command to run or its vendor page; the registry carries the same entry', () => {
  assert.deepEqual(Object.keys(HARNESS_INSTALL).sort(), Object.keys(REGISTRY).sort());
  for (const [kind, info] of Object.entries(REGISTRY)) {
    assert.equal(info.install, HARNESS_INSTALL[kind], `${kind}: one table, not a copy`);
    assert.match(info.install.docs, /^https:\/\//, kind);
    for (const os of ['darwin', 'linux', 'win32']) {
      const lines = installLines(kind, os, ALL);
      assert.ok(lines.length > 0 || info.install.docs, `${kind} on ${os}`);
      for (const l of lines) assert.equal(l.label, INSTALL_VIA_LABEL[l.via], `${kind}: ${l.via} has a label`);
    }
    for (const m of info.install.methods) {
      assert.ok(m.os.length > 0, `${kind}: ${m.command} names its OS`);
      // the package an npm line installs and the formula a brew line installs are what it runs
      if (m.via === 'npm') assert.match(m.command, new RegExp(`^npm install -g ${m.npm!.replace(/[/@.]/g, '\\$&')}`));
      if (m.via === 'brew') assert.equal(m.command, `brew install ${m.brew!.cask ? '--cask ' : ''}${m.brew!.name}`);
    }
  }
  // each first-class harness has a no-Node.js script first, as its vendor recommends
  assert.equal(installLines('claude', 'darwin', ALL)[0].command, 'curl -fsSL https://claude.ai/install.sh | bash');
  assert.equal(installLines('codex', 'linux', ALL)[0].command, 'curl -fsSL https://chatgpt.com/codex/install.sh | sh');
  // a harness with no one-line Windows command shows only its vendor page there
  assert.deepEqual(installLines('acp:goose', 'win32', ALL), []);
});

test('lines follow the OS: macOS-only casks stay off Linux, Windows gets its own commands', () => {
  const via = (kind: string, os: string) => installLines(kind, os, ALL).map((l) => l.via);
  assert.deepEqual(via('codex', 'darwin'), ['script', 'brew', 'npm']);
  assert.deepEqual(via('codex', 'linux'), ['script', 'npm']);
  assert.deepEqual(via('codex', 'win32'), ['npm', 'powershell']);
  assert.deepEqual(via('claude', 'win32'), ['powershell', 'winget']);
  assert.deepEqual(via('acp:copilot', 'win32'), ['npm', 'winget']);
  // a platform the table doesn't name takes Linux's lines
  assert.equal(installOs('freebsd'), 'linux');
  assert.deepEqual(via('codex', 'freebsd'), ['script', 'npm']);
  assert.deepEqual(installLines('acp:unknown', 'darwin', ALL), []);
});

test("a line this machine can't run says why and stays; npm without Node.js goes last; unknown tools block nothing", () => {
  const lines = (tools: any) => installLines('acp:qwen', 'darwin', tools).map((l) => [l.via, l.blocked]);
  assert.deepEqual(lines(ALL), [
    ['script', null],
    ['brew', null],
    ['npm', null],
  ]);
  assert.deepEqual(lines({ npm: false, brew: false, npmWritable: null }), [
    ['script', null],
    ['brew', 'Needs Homebrew'],
    ['npm', 'Needs Node.js'],
  ]);
  // Node.js missing moves its line last, past one that is usable
  assert.deepEqual(
    installLines('acp:kimi', 'darwin', { npm: false, brew: true, npmWritable: null }).map((l) => [l.via, l.blocked]),
    [
      ['script', null],
      ['npm', 'Needs Node.js'],
    ],
  );
  assert.deepEqual(lines({ npm: true, brew: true, npmWritable: false }).at(-1), ['npm', 'Needs admin rights']);
  assert.deepEqual(lines(null), lines(ALL));
  // the note a vendor attaches comes with its line
  assert.equal(installLines('acp:kimi', 'win32', ALL).find((l) => l.via === 'powershell')!.note, 'Needs Git for Windows');
  assert.equal(installLines('acp:kimi', 'darwin', ALL)[0].note, null);
});

test('main resolves a run by kind and line, only for this platform; a shell runs it as the vendor typed it', () => {
  const lines = installLines('codex', 'darwin', ALL);
  assert.equal(installMethod('codex', lines[1].index, 'darwin')!.command, 'brew install --cask codex');
  assert.equal(installMethod('codex', lines[1].index, 'linux'), null, 'a macOS-only cask is no line on Linux');
  for (const bad of [-1, 99, 1.5, '1', null, undefined]) assert.equal(installMethod('codex', bad, 'darwin'), null, `index ${String(bad)}`);
  assert.equal(installMethod('acp:nope', 0, 'darwin'), null);
  assert.equal(installMethod('__proto__', 0, 'darwin'), null, 'an inherited name is no harness');
  assert.deepEqual(installArgv('a | b', 'darwin'), ['/bin/sh', '-c', 'a | b']);
  assert.deepEqual(installArgv('irm x | iex', 'win32'), ['powershell.exe', '-NoProfile', '-Command', 'irm x | iex']);
  assert.equal(installGroup('npm'), 'npm');
  assert.equal(installGroup('brew'), 'brew');
  assert.equal(installGroup('script'), null);
  assert.deepEqual(
    lines.map((l) => l.group),
    [null, 'brew', 'npm'],
  );
});

test('one line is recommended: the first this machine can run, which is the vendor script for Codex and Claude Code', () => {
  const recommended = (kind: string, os: string, tools: any) => installLines(kind, os, tools).filter((l) => l.recommended);
  for (const kind of Object.keys(HARNESS_INSTALL))
    for (const os of ['darwin', 'linux', 'win32']) assert.ok(recommended(kind, os, ALL).length <= 1, `${kind} on ${os}: one at most`);
  // no Node.js needed
  assert.deepEqual(
    recommended('codex', 'darwin', { npm: false, brew: false, npmWritable: null }).map((l) => l.via),
    ['script'],
  );
  assert.deepEqual(
    recommended('claude', 'linux', ALL).map((l) => l.via),
    ['script'],
  );
  // Windows commands remain available to copy, with no automatic install offered.
  assert.deepEqual(
    recommended('codex', 'win32', { npm: false, brew: false, npmWritable: null }).map((l) => l.via),
    [],
  );
  // every line blocked: none is offered
  assert.deepEqual(recommended('acp:gemini', 'darwin', { npm: false, brew: false, npmWritable: null }), []);
});
