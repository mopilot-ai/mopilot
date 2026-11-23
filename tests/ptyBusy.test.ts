// A terminal counts as busy while its foreground process is not the shell it started (electron/platform/pty.cjs busy()).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const procs: any[] = [];
const fakePty = {
  spawn(file: string) {
    const p: any = {
      pid: 1,
      file,
      process: undefined,
      kill: () => p.exit?.({ exitCode: 0 }),
      onData: () => {},
      onExit: (f: any) => (p.exit = f),
    };
    procs.push(p);
    return p;
  },
};
mock.module('node-pty', { defaultExport: fakePty, namedExports: fakePty });
const require = createRequire(import.meta.url);
const pty = require('../electron/platform/pty.cjs');

test('an idle shell is not busy; a command in it is; a login shell named -<shell> is the shell', () => {
  assert.equal(pty.busy(), false, 'no terminal');
  // the shell is the user's login shell (zsh here, bash on a CI runner)
  const shell = path.basename(pty.spawn('t1', { cwd: '/' }).file);
  const p = procs.at(-1);
  assert.equal(pty.busy(), false, 'no foreground process reported');
  for (const [fg, busy] of [
    [shell, false],
    [`/bin/${shell}`, false],
    [`-${shell}`, false],
    ['', false],
    ['node', true],
    ['/usr/bin/sleep', true],
  ] as const) {
    p.process = fg;
    assert.equal(pty.busy(), busy, `${fg} under ${shell}`);
  }
  pty.kill('t1');
  assert.equal(pty.busy(), false, 'gone with the terminal');
});
