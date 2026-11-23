// Scratch-only runtime barriers preserve actual native replies and Git delegation while exposing release and timeout outcomes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const { holdNativeAllocationReply, removalTarget, replyNativeRequest } = require('./e2e/fixtures/prepared-native-gate.cjs');
const wrapper = path.resolve('tests/e2e/fixtures/prepared-git-wrapper.cjs');
const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();

function scratch(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prepared-gate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('native gate accepts only an explicit single-use allocation below its configured root', (t) => {
  const root = scratch(t);
  const log = path.join(root, 'protocol');
  const policy = `${log}.prepared-start.json`;
  const msg = { id: 17, method: 'thread/start', params: { cwd: path.join(root, 'child') } };
  const result = { thread: { id: 'native-child' }, extra: 'preserved' };
  const replies: any[] = [];
  assert.equal(
    holdNativeAllocationReply(msg, result, (r: any) => replies.push(r), null),
    false,
  );
  assert.equal(holdNativeAllocationReply({ ...msg, method: 'thread/read' }, result, assert.fail, log), false);
  assert.equal(holdNativeAllocationReply(msg, result, assert.fail, log), false);
  fs.writeFileSync(policy, '{');
  assert.throws(() => holdNativeAllocationReply(msg, result, assert.fail, log), SyntaxError);
  for (const malformed of [{ root: null }, { root: 4 }]) {
    fs.writeFileSync(policy, JSON.stringify(malformed));
    assert.throws(() => holdNativeAllocationReply(msg, result, assert.fail, log), /Invalid prepared-start/);
  }
  fs.writeFileSync(policy, JSON.stringify({ root }));
  assert.equal(
    holdNativeAllocationReply({ ...msg, params: { ...msg.params, ephemeral: true } }, result, assert.fail, log, {
      schedule: () => undefined,
    }),
    false,
  );
  assert.equal(fs.existsSync(policy), true, 'a hidden title helper must not consume the visible-child allocation gate');
  for (const params of [undefined, {}, { cwd: null }, { cwd: 4 }]) {
    assert.throws(() => holdNativeAllocationReply({ ...msg, params }, result, assert.fail, log), /Invalid prepared-start/);
  }
  for (const cwd of [root, path.dirname(root), `${root}-other/child`]) {
    assert.equal(holdNativeAllocationReply({ ...msg, params: { cwd } }, result, assert.fail, log), false);
    assert.equal(fs.existsSync(policy), true, 'a nonmatching native thread must not consume the gate');
  }
  fs.writeFileSync(`${log}.prepared-start.release`, 'release');
  assert.equal(
    holdNativeAllocationReply(msg, result, (r: any) => replies.push(r), log),
    true,
  );
  assert.deepEqual(replies, [{ id: 17, result }]);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${log}.prepared-start.entered`, 'utf8')), { id: 'native-child', cwd: msg.params.cwd });
  assert.equal(fs.existsSync(policy), false);
  assert.equal(holdNativeAllocationReply(msg, result, assert.fail, log), false);
});

test('native gate remains pending until release and times out with one truthful RPC error', (t) => {
  for (const outcome of ['release', 'timeout']) {
    const root = scratch(t);
    const log = path.join(root, outcome);
    fs.writeFileSync(`${log}.prepared-start.json`, JSON.stringify({ root }));
    const scheduled: (() => void)[] = [];
    const replies: any[] = [];
    let now = 0;
    const message = { id: 9, method: 'thread/start', params: { cwd: path.join(root, 'child') } };
    const result = { thread: { id: 'created' } };
    assert.equal(
      holdNativeAllocationReply(message, result, (r: any) => replies.push(r), log, {
        io: fs,
        now: () => now,
        schedule: (fn: () => void, ms: number) => {
          assert.equal(ms, 10);
          scheduled.push(fn);
        },
      }),
      true,
    );
    assert.deepEqual(replies, []);
    now = 19_999;
    scheduled.shift()!();
    assert.deepEqual(replies, []);
    if (outcome === 'release') fs.writeFileSync(`${log}.prepared-start.release`, 'release');
    else now = 20_000;
    scheduled.shift()!();
    assert.deepEqual(
      replies,
      outcome === 'release' ? [{ id: 9, result }] : [{ id: 9, error: { code: -32000, message: 'Prepared native start gate timed out' } }],
    );
    assert.equal(scheduled.length, 0);
  }
});

test('removal policy holds only the exact non-force scratch-owned command', () => {
  const root = path.join(os.tmpdir(), 'managed');
  const child = path.join(root, 'holder', 'repo');
  assert.equal(removalTarget(['worktree', 'remove', child], root), child);
  for (const args of [
    [],
    ['worktree', 'remove'],
    ['worktree', 'remove', '--force', child],
    ['worktree', 'list', child],
    ['branch', 'remove', child],
    ['worktree', 'remove', root],
    ['worktree', 'remove', path.dirname(root)],
    ['worktree', 'remove', `${root}-other/repo`],
  ]) {
    assert.equal(removalTarget(args, root), null);
  }
});

test('native reply boundary preserves exact result, save ordering and the existing error envelope', (t) => {
  const message = { id: 19, method: 'thread/read' };
  const events: any[] = [];
  const send = (reply: any) => events.push(['reply', reply]);
  const saveState = () => events.push(['save']);
  const result = { data: [], nextCursor: null };
  replyNativeRequest(
    message,
    () => {
      events.push(['run']);
      return result;
    },
    send,
    { saveState },
  );
  assert.deepEqual(events, [['run'], ['reply', { id: 19, result }], ['save']]);
  for (const [error, expected] of [
    [new Error('native failed'), { code: -32603, message: 'native failed' }],
    [
      { code: 0, message: 'native custom' },
      { code: 0, message: 'native custom' },
    ],
    ['plain failure', { code: -32603, message: 'plain failure' }],
  ]) {
    events.length = 0;
    replyNativeRequest(
      message,
      () => {
        throw error;
      },
      send,
      { saveState },
    );
    assert.deepEqual(events, [['reply', { id: 19, error: expected }]]);
  }
  events.length = 0;
  replyNativeRequest(message, () => result, send, {
    saveState: () => {
      throw new Error('save failed');
    },
  });
  assert.deepEqual(events, [
    ['reply', { id: 19, result }],
    ['reply', { id: 19, error: { code: -32603, message: 'save failed' } }],
  ]);
  const root = scratch(t);
  const log = path.join(root, 'protocol');
  fs.writeFileSync(`${log}.prepared-start.json`, JSON.stringify({ root }));
  fs.writeFileSync(`${log}.prepared-start.release`, 'release');
  events.length = 0;
  const allocation = { id: 21, method: 'thread/start', params: { cwd: path.join(root, 'child') } };
  const created = { thread: { id: 'actual-thread' } };
  replyNativeRequest(allocation, () => created, send, { logFile: log, saveState });
  assert.deepEqual(events, [['reply', { id: 21, result: created }], ['save']]);
  assert.equal(fs.existsSync(`${log}.prepared-start.entered`), true);
});

function gitFixture(t: any) {
  const root = scratch(t);
  const home = path.join(root, 'home');
  const repo = path.join(root, 'repo');
  const bin = path.join(root, 'bin');
  const target = path.join(home, '.mopilot', 'worktrees', 'holder', 'repo');
  const log = path.join(root, 'native');
  fs.mkdirSync(repo);
  fs.mkdirSync(bin);
  assert.notEqual(fs.statSync(wrapper).mode & 0o111, 0, 'the PATH Git fixture must be executable');
  fs.symlinkSync(wrapper, path.join(bin, 'git'));
  execFileSync(realGit, ['init', '-q', repo]);
  execFileSync(realGit, [
    '-C',
    repo,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '--allow-empty',
    '-qm',
    'fixture',
  ]);
  execFileSync(realGit, ['-C', repo, 'worktree', 'add', '--detach', '-q', target, 'HEAD']);
  const run = (args: string[], overrides: Record<string, string | undefined> = {}) => {
    const child = spawn('git', args, {
      cwd: repo,
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        HOME: home,
        FAKE_CODEX_LOG: log,
        MOPILOT_TEST_REAL_GIT: realGit,
        ...overrides,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.after(() => {
      if (child.exitCode === null) child.kill();
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (v) => {
      stdout += v;
    });
    child.stderr.on('data', (v) => {
      stderr += v;
    });
    const done = new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) =>
      child.once('close', (status) => resolve({ status, stdout, stderr })),
    );
    return { child, done };
  };
  return { root, home, repo, target, log, run };
}

async function entered(file: string) {
  const deadline = Date.now() + 5_000;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`Git barrier did not enter: ${file}`);
    await delay(5);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('actual Git removal waits for release, preserves its argv/cwd and then reports successful completion', async (t) => {
  const f = gitFixture(t);
  const args = ['worktree', 'remove', f.target];
  const run = f.run(args);
  assert.deepEqual(await entered(`${f.log}.prepared-git.entered`), { args, cwd: fs.realpathSync(f.repo), target: f.target });
  assert.equal(fs.existsSync(f.target), true);
  assert.equal(fs.existsSync(`${f.log}.prepared-git.done`), false);
  fs.writeFileSync(`${f.log}.prepared-git.release`, 'release');
  assert.equal((await run.done).status, 0);
  assert.equal(fs.existsSync(f.target), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${f.log}.prepared-git.done`, 'utf8')), { status: 0, error: null });
});

test('actual non-force Git refusal keeps dirty work and the wrapper preserves its failure status', async (t) => {
  const f = gitFixture(t);
  fs.writeFileSync(path.join(f.target, 'human-file'), 'keep');
  fs.writeFileSync(`${f.log}.prepared-git.release`, 'release');
  const result = await f.run(['worktree', 'remove', f.target]).done;
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /untracked files/);
  assert.equal(fs.readFileSync(path.join(f.target, 'human-file'), 'utf8'), 'keep');
  assert.deepEqual(JSON.parse(fs.readFileSync(`${f.log}.prepared-git.done`, 'utf8')), { status: result.status, error: null });
});

test('Git gate timeout never runs removal and a released transport failure is reported truthfully', async (t) => {
  for (const outcome of ['timeout', 'spawn-error']) {
    const f = gitFixture(t);
    if (outcome === 'spawn-error') fs.writeFileSync(`${f.log}.prepared-git.release`, 'release');
    const result = await f.run(
      ['worktree', 'remove', f.target],
      outcome === 'timeout' ? { MOPILOT_TEST_GIT_GATE_TIMEOUT: '0' } : { MOPILOT_TEST_REAL_GIT: path.join(f.root, 'missing-git') },
    ).done;
    assert.equal(result.status, outcome === 'timeout' ? 2 : 1);
    const done = JSON.parse(fs.readFileSync(`${f.log}.prepared-git.done`, 'utf8'));
    if (outcome === 'timeout') assert.deepEqual(done, { timedOut: true });
    else {
      assert.equal(done.status, null);
      assert.match(done.error, /ENOENT/);
    }
    assert.equal(fs.existsSync(f.target), true);
  }
});

test('other actual Git commands, force form and absent logging delegate unchanged without a gate', async (t) => {
  for (const mode of ['version', 'error', 'force', 'no-log', 'no-git']) {
    const f = gitFixture(t);
    const args =
      mode === 'force'
        ? ['worktree', 'remove', '--force', f.target]
        : mode === 'no-log'
          ? ['worktree', 'remove', f.target]
          : mode === 'error'
            ? ['not-a-git-command']
            : ['--version'];
    const overrides = mode === 'no-log' ? { FAKE_CODEX_LOG: undefined } : mode === 'no-git' ? { MOPILOT_TEST_REAL_GIT: undefined } : {};
    const result = await f.run(args, overrides).done;
    assert.equal(result.status, mode === 'error' || mode === 'no-git' ? 1 : 0);
    if (mode === 'version') assert.match(result.stdout, /^git version /);
    if (mode === 'no-git') assert.match(result.stderr, /requires a captured real Git/);
    assert.equal(fs.existsSync(`${f.log}.prepared-git.entered`), false);
    assert.equal(fs.existsSync(`${f.log}.prepared-git.done`), false);
  }
});
