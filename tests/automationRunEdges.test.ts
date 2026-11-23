// electron/platform/automationRun.cjs on its fallbacks: the shared setup script, the home folder,
// missing prefs and prompt, and a worktree that cannot be made (the run stays on this computer).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { AutomationRunner, setupScriptOf } = require('../electron/platform/automationRun.cjs');

function tmp(t: any) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'autorun-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}
function envToml(repo: string, text: string) {
  fs.mkdirSync(path.join(repo, '.codex', 'environments'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.codex', 'environments', 'environment.toml'), text);
}

test('setupScriptOf: the platform entry, else the shared one, else empty', (t) => {
  const d = tmp(t);
  envToml(d, '[setup]\nscript = " make "\n[setup.win32]\nscript = "ps"\n');
  assert.equal(setupScriptOf(d, 'darwin'), 'make');
  assert.equal(setupScriptOf(d, 'win32'), 'ps');
  envToml(d, 'name = "x"\n');
  assert.equal(setupScriptOf(d, 'darwin'), '');
  assert.equal(setupScriptOf(path.join(d, 'missing')), '');
});

function runner(over: any = {}) {
  const log: any[] = [];
  const r = new AutomationRunner({
    prefs: () => undefined,
    usable: async () => true,
    sessions: { patch: (...a: any[]) => log.push(['patch', ...a]) },
    send: (...a: any[]) => log.push(['send', ...a]),
    codexThread: async ({ cwd }: any) => (log.push(['thread', cwd]), { id: 'th1' }),
    claudeSession: (...a: any[]) => log.push(['claude', ...a]),
    chats: { patchMeta: (...a: any[]) => (log.push(['meta', ...a]), true) },
    worktree: async () => ({ ok: false, error: 'dirty' }),
    script: async (...a: any[]) => (log.push(['script', ...a]), { exitCode: 0, output: '' }),
    remember: async () => {},
    started: (e: any) => log.push(['started', e]),
    ...over,
  });
  return { r, log };
}

test('the home folder is used without cwds; no prefs means default config; no prompt is empty text', async (t) => {
  const { r, log } = runner();
  assert.equal(r.home, os.homedir());
  r.home = '/home/me';
  assert.equal(await r.run({ id: 'a' }, { unattended: true }), 'th1');
  assert.deepEqual(
    log.find((l) => l[0] === 'thread'),
    ['thread', '/home/me'],
  );
  assert.deepEqual(
    log.find((l) => l[0] === 'meta'),
    ['meta', 'th1', { config: { model: null, effort: null, serviceTier: null } }],
  );
  assert.equal(log.find((l) => l[0] === 'send')[2].text, '');
  assert.equal(log.find((l) => l[0] === 'send')[3], null);
});

test('a worktree that fails, or a folder that cannot hold one, leaves the run in the project folder', async () => {
  for (const worktree of [undefined, async () => ({ ok: false, unsupported: true, error: "This folder isn't a git repository" })]) {
    const { r, log } = runner({ home: '/h', ...(worktree ? { worktree } : {}) });
    await r.run({ id: 'a', cwds: ['/p'], execution_environment: 'worktree', harness: 'claude', prompt: 'go' }, { unattended: false });
    const claude = log.find((l) => l[0] === 'claude');
    assert.deepEqual(claude[2], { cwd: '/p' });
    // no worktree to remember: only the model and effort the chat keeps
    assert.deepEqual(
      log.filter((l) => l[0] === 'meta').map((l) => l[2]),
      [{ config: { model: null, effort: null } }],
    );
  }
});

test('newWorktree: default root under home, the setup script runs in the worktree, none when empty', async (t) => {
  const repo = tmp(t);
  envToml(repo, '[setup]\nscript = "npm ci"\n');
  const asked: any[] = [];
  const { r, log } = runner({
    home: '/h',
    prefs: () => ({ branchPrefix: 'me/' }),
    worktree: async (cwd: string, o: any) => (asked.push([cwd, o]), { ok: true, path: '/wt/app/sub', worktree: '/wt/app', repo }),
  });
  assert.deepEqual(await r.newWorktree('/src/app/sub'), { path: '/wt/app/sub' });
  assert.deepEqual(asked[0], ['/src/app/sub', { prefix: 'me/', root: '/h/.mopilot/worktrees' }]);
  assert.deepEqual(
    log.find((l) => l[0] === 'script'),
    ['script', '/wt/app', 'npm ci'],
  );
  const { r: r2, log: log2 } = runner({ worktree: async () => ({ ok: true, path: '/x', worktree: '/x', repo: path.join(repo, 'none') }) });
  await r2.newWorktree('/src');
  assert.equal(
    log2.some((l) => l[0] === 'script'),
    false,
  );
});

test('a Codex run in a fresh worktree records the project it came from', async () => {
  const { r, log } = runner({
    home: '/h',
    worktree: async () => ({ ok: true, path: '/wt/p', worktree: '/wt/p', repo: '/nonexistent-repo' }),
  });
  await r.run({ id: 'a', cwds: ['/p'], execution_environment: 'worktree' }, { unattended: true });
  assert.deepEqual(
    log.find((l) => l[0] === 'thread'),
    ['thread', '/wt/p'],
  );
  assert.equal(log.find((l) => l[0] === 'meta')[2].worktreeOf, '/p');
});

test('setup reads preserve non-Error failures instead of treating them as an absent file', (t) => {
  const reader = t.mock.method(fs, 'readFileSync', () => {
    throw undefined;
  });
  try {
    // the resolver reports what it couldn't read (environmentSource.cjs); the start still fails, saying what was thrown
    assert.throws(() => setupScriptOf('/project', 'darwin', () => {}), /^Error: undefined$/);
    const { resolveEnvironment } = require('../electron/platform/environmentSource.cjs');
    const resolved = resolveEnvironment('/project');
    assert.deepEqual([resolved.source, resolved.error, resolved.setup], ['environment', 'undefined', '']);
    // both settings files; conductor.json is not consulted once a settings file is there
    assert.equal(resolved.unreadable.length, 2);
    assert.match(resolved.copyError, /\.worktreeinclude couldn't be read \(undefined\)$/);
  } finally {
    reader.mock.restore();
  }
});
