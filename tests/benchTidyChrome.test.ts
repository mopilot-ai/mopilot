// Chrome preflight refuses foreign profiles before GUI mutation; skip-Chrome preserves their windows and sheets.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tidy-chrome-'));
const oldHome = process.env.HOME;
process.env.HOME = home;
const scripts: string[] = [];
const commands: string[] = [];
const killed: number[] = [];
mock.method(process, 'kill', (pid: number) => {
  killed.push(pid);
  return true;
});
mock.module('node:child_process', {
  exports: {
    execFileSync(cmd: string, args: string[] = [], opts: { input?: string } = {}) {
      commands.push(cmd);
      if (cmd === 'pgrep') throw new Error('not running');
      if (cmd === 'ps')
        return '99001 Google Chrome /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/other/profile\n';
      if (opts.input) scripts.push(opts.input);
      return '';
    },
  },
});
const { tidyDesktop } = await import('../bench/drivers/gui.mjs');
test('other-profile Chrome refuses cleanup before any GUI action; skip leaves it untouched', () => {
  try {
    assert.throws(() => tidyDesktop('/bench/profile'), /environment: Chrome pid 99001/);
    assert.equal(scripts.length, 0);
    assert.equal(killed.length, 0);
    commands.length = 0;
    tidyDesktop();
    assert.equal(commands.includes('ps'), false);
    const mutations = scripts.filter((s) => !s.includes('const keep=') && /Google Chrome/.test(s));
    assert.deepEqual(mutations, []);
    assert.ok(scripts.some((s) => s.includes('const keep=') && s.includes('Google Chrome')));
    assert.ok(scripts.some((s) => s.includes('TextEdit') && s.includes('.quit()')));
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
