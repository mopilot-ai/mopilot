// electron/platform/git.cjs: no worktree is made or restored in the Codex app's own folder ($CODEX_HOME/worktrees),
// whose startup cleanup force-removes worktrees there under chats still using them.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const git = require('../electron/platform/git.cjs');

type Reply = { ok?: boolean; stdout?: string; stderr?: string };
let calls: { args: string[] }[] = [];
let respond: (args: string[]) => Reply = () => ({ ok: true });
mock.method(childProcess, 'execFile', (_cmd: string, args: string[], _opts: any, cb: any) => {
  calls.push({ args });
  const r = respond(args);
  setImmediate(() => cb(r.ok === false ? new Error('git failed') : null, r.stdout, r.stderr));
});
const has = (args: string[], ...want: string[]) => want.every((w, i) => args[i] === w);
function tmp(t: any) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gitcodex-')));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  calls = [];
  return d;
}
function ipc() {
  const h = new Map<string, (...a: any[]) => any>();
  git.register({ handle: (ch: string, f: any) => h.set(ch, f) });
  return (ch: string, ...a: any[]) => h.get(ch)!({}, ...a);
}

test("the Codex app's worktree folder is refused for new and restored worktrees: its cleanup deletes them", async (t) => {
  const d = tmp(t);
  const saved = process.env.CODEX_HOME;
  t.after(() => (saved === undefined ? delete process.env.CODEX_HOME : (process.env.CODEX_HOME = saved)));
  process.env.CODEX_HOME = path.join(d, '.codex');
  const codex = path.join(d, '.codex', 'worktrees');
  assert.equal(git.inCodexWorktrees(codex), true);
  assert.equal(git.inCodexWorktrees(path.join(codex, 'mine')), true);
  for (const other of [path.join(d, '.codex'), `${codex}-2`, path.join(d, '..wt'), path.join(d, 'wt'), '/'])
    assert.equal(git.inCodexWorktrees(other), false, other);
  respond = (args) => (has(args, 'rev-parse', '--show-toplevel') ? { stdout: '/src/app\n' } : { ok: true, stdout: '' });
  const refused = { ok: false, error: git.CODEX_OWNED };
  for (const root of [codex, `${codex}/`, path.join(codex, 'mine')])
    assert.deepEqual(await git.worktreeAdd('/src/app', { root }), refused, root);
  assert.equal(
    calls.some((c) => has(c.args, 'worktree', 'add')),
    false,
  );
  assert.equal(fs.existsSync(codex), false, 'nothing is made there');
  assert.equal(git.inCodexWorktrees(codex), true);
  // a chat whose worktree the Codex app deleted (ours: its holder keeps our marker) isn't brought back where it would
  // be deleted again
  fs.mkdirSync(path.join(codex, 'ab12'), { recursive: true });
  fs.writeFileSync(path.join(codex, 'ab12', git.MARKER), JSON.stringify({ repo: '/src/app', branch: 'mopilot/ab12' }));
  const call = ipc();
  assert.deepEqual(await call('git:worktreeRestore', path.join(codex, 'ab12', 'app'), codex, '/src/app'), refused);
  // with the default folder now, a chat whose worktree was there says why it isn't brought back, instead of nothing
  assert.deepEqual(await call('git:worktreeRestore', path.join(codex, 'ab12', 'app'), path.join(d, 'wt'), '/src/app'), {
    ok: false,
    error: git.CODEX_DELETED,
  });
  // the Codex app's own worktree there (no marker of ours) isn't ours to explain: as before, nothing is said
  assert.deepEqual(await call('git:worktreeRestore', path.join(codex, 'cd34', 'app'), path.join(d, 'wt'), '/src/app'), {
    ok: false,
    error: 'Not a MoPilot worktree',
  });
  // another spelling of the same folder: a symlink to it, or (macOS and Windows) another case
  fs.mkdirSync(codex, { recursive: true });
  fs.symlinkSync(codex, path.join(d, 'link'));
  assert.equal(git.inCodexWorktrees(path.join(d, 'link', 'new')), true);
  if (process.platform === 'darwin' || process.platform === 'win32')
    assert.equal(git.inCodexWorktrees(path.join(d, '.Codex', 'Worktrees')), true);
  // with CODEX_HOME elsewhere, the folder the Codex app uses when opened from the Dock is still refused
  assert.equal(git.inCodexWorktrees(path.join(os.homedir(), '.codex', 'worktrees', 'x')), true);
  // CODEX_HOME unset: the Codex app uses ~/.codex
  delete process.env.CODEX_HOME;
  assert.equal(git.inCodexWorktrees(path.join(os.homedir(), '.codex', 'worktrees')), true);
  assert.equal(git.inCodexWorktrees(path.join(os.homedir(), '.mopilot', 'worktrees')), false);
});

test('canonical: one case only on macOS and Windows, whose disks ignore it; a missing tail is kept as typed', (t) => {
  const d = tmp(t);
  fs.mkdirSync(path.join(d, 'Real'));
  fs.symlinkSync(path.join(d, 'Real'), path.join(d, 'Link'));
  const missing = path.join(d, 'Link', 'Not', 'Yet');
  assert.equal(git.canonical(missing, 'linux'), path.join(d, 'Real', 'Not', 'Yet'));
  for (const platform of ['darwin', 'win32'])
    assert.equal(git.canonical(missing, platform), path.join(d, 'Real', 'Not', 'Yet').toLowerCase());
});
