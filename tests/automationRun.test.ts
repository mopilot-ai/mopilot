// One run of a scheduled task in main (electron/platform/automationRun.cjs): the chat it makes on each
// harness, a worktree when asked, the marks on the run's chat, and what the first message goes with.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { AutomationRunner, setupScriptOf } = require('../electron/platform/automationRun.cjs');
const { SessionStore } = require('../electron/session/state.cjs');
const { canRememberChat } = require('../shared/scheduleTask.mjs');

function setup(o: { usable?: boolean; prefs?: any; worktree?: any; label?: (k: string) => string | undefined; noLabel?: boolean } = {}) {
  const sessions = new SessionStore();
  const sent: any[] = [];
  const saved: any[] = [];
  /** the store's tasks, as AutomationStore.get reads them */
  const tasks = new Map<string, any>();
  const started: any[] = [];
  const metas: any[] = [];
  const claude: any[] = [];
  const acp: any[] = [];
  const scripts: any[] = [];
  const worktrees: any[] = [];
  const runner = new AutomationRunner({
    prefs: () => o.prefs ?? { model: 'gpt-x', effort: 'high', serviceTier: null },
    usable: async () => o.usable !== false,
    sessions,
    send: (chatId: string, item: any, origin: any) => void sent.push({ chatId, item, origin }),
    codexThread: async ({ cwd }: { cwd: string }) => ({ id: `thread-${sent.length + 1}`, cwd }),
    claudeSession: (key: string, info: any) => void claude.push([key, info]),
    acpSession: (key: string, info: any) => void acp.push([key, info]),
    ...(o.noLabel ? {} : { label: o.label ?? ((k: string) => k) }),
    chats: { patchMeta: (id: string, p: any) => (metas.push([id, p]), true) },
    worktree: async (cwd: string, opts: any) => {
      worktrees.push([cwd, opts]);
      return o.worktree ?? { ok: true, path: '/wt/abcd/proj/sub', worktree: '/wt/abcd/proj', repo: cwd };
    },
    script: async (cwd: string, script: string) => (scripts.push([cwd, script]), { exitCode: 0, output: '' }),
    remember: async (a: any, chatId: string) => {
      const current = tasks.get(a.id);
      if (!canRememberChat(a, current)) return;
      const next = { ...current, target_thread_id: chatId, updated_at: Date.now() };
      saved.push(next);
      tasks.set(a.id, next);
    },
    started: (e: any) => void started.push(e),
    home: '/home/me',
  });
  return { runner, sessions, sent, saved, tasks, started, metas, claude, acp, scripts, worktrees };
}
const task = (o: any = {}) => ({ id: 't1', kind: 'cron', name: 'Check', prompt: 'summarize the repo', ...o });

test('a Codex run makes a chat in the task folder, marks it, and sends the prompt', async () => {
  const t = setup();
  const id = await t.runner.run(
    task({ cwds: ['/proj'], model: 'gpt-y', reasoning_effort: 'low', computer_control: true, on_approval: 'skip' }),
    { unattended: true },
  );
  assert.equal(id, 'thread-1');
  assert.deepEqual(t.sessions.get(id).scheduled, { unattended: true, computer: true, onApproval: 'skip' });
  assert.deepEqual(t.sent, [
    { chatId: id, item: { text: 'summarize the repo', attachments: [], opts: { model: 'gpt-y', effort: 'low' } }, origin: null },
  ]);
  // the chat starts from the defaults and keeps its own from here on
  assert.deepEqual(t.metas, [[id, { config: { model: 'gpt-x', effort: 'high', serviceTier: null } }]]);
  assert.deepEqual(t.started, [
    { harness: 'codex', chatId: id, cwd: '/proj', worktreeOf: null, config: { model: 'gpt-x', effort: 'high', serviceTier: null } },
  ]);
});

test('a Claude run makes a Claude session, with no Codex involved', async () => {
  const t = setup();
  const id = await t.runner.run(task({ harness: 'claude', cwds: ['/proj'] }), { unattended: false, origin: 4 });
  assert.match(id, /^claude:[0-9a-f-]{36}$/);
  assert.deepEqual(t.claude, [[id, { cwd: '/proj' }]]);
  assert.deepEqual(t.sessions.get(id).scheduled, { unattended: false, computer: false, onApproval: 'wait' });
  assert.equal(t.sent[0].origin, 4);
  assert.deepEqual(t.started[0], { harness: 'claude', chatId: id, cwd: '/proj', worktreeOf: null });
});

test('a task with no folder runs in the home folder', async () => {
  const t = setup();
  await t.runner.run(task({ harness: 'claude' }), { unattended: true });
  assert.equal(t.claude[0][1].cwd, '/home/me');
});

test('"Run on this computer" off: a fresh worktree, the project it came from remembered', async () => {
  const t = setup({ prefs: { branchPrefix: 'sage/', worktreeRoot: '/roots' } });
  const id = await t.runner.run(task({ harness: 'claude', cwds: ['/proj'], execution_environment: 'worktree' }), { unattended: true });
  assert.deepEqual(t.worktrees, [['/proj', { prefix: 'sage/', root: '/roots' }]]);
  assert.equal(t.claude[0][1].cwd, '/wt/abcd/proj/sub');
  assert.deepEqual(t.metas, [[id, { worktreeOf: '/proj', config: { model: null, effort: null } }]]);
  assert.equal(t.started[0].worktreeOf, '/proj');
});

test('a worktree that could not be made runs in the project itself', async () => {
  const t = setup({ worktree: { ok: false, error: 'Not a git repository' } });
  await t.runner.run(task({ harness: 'claude', cwds: ['/proj'], execution_environment: 'worktree' }), { unattended: true });
  assert.equal(t.claude[0][1].cwd, '/proj');
  // no worktree to remember: only the model and effort the chat keeps
  assert.deepEqual(
    t.metas.map((m: any) => m[1]),
    [{ config: { model: null, effort: null } }],
  );
});

test("the project's setup script runs in the new worktree before the harness starts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-env-'));
  assert.equal(setupScriptOf(dir), '');
  fs.mkdirSync(path.join(dir, '.codex', 'environments'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.codex', 'environments', 'environment.toml'),
    'name = "x"\n[setup]\nscript = "npm ci"\n[setup.win32]\nscript = "npm.cmd ci"\n',
  );
  assert.equal(setupScriptOf(dir, 'darwin'), 'npm ci');
  assert.equal(setupScriptOf(dir, 'win32'), 'npm.cmd ci');
});

test('a harness that is not usable stops the run before anything is made', async () => {
  const t = setup({ usable: false });
  await assert.rejects(t.runner.run(task({ harness: 'claude' }), { unattended: true }), /Claude Code isn’t available/);
  await assert.rejects(t.runner.run(task(), { unattended: true }), /Codex isn’t available/);
  assert.deepEqual(t.sent, []);
  assert.deepEqual(t.claude, []);
});

test('a heartbeat keeps its chat, and later runs go on in it', async () => {
  const t = setup();
  t.tasks.set('t1', task({ kind: 'heartbeat', harness: 'claude' }));
  const id = await t.runner.run(task({ kind: 'heartbeat', harness: 'claude' }), { unattended: true });
  assert.equal(t.saved.length, 1);
  assert.equal(t.saved[0].target_thread_id, id);
  // the saved task names it: the next run makes no chat
  const again = await t.runner.run(t.saved[0], { unattended: true });
  assert.equal(again, id);
  assert.equal(t.claude.length, 1);
  assert.equal(t.sent.length, 2);
});

test("a heartbeat's first run names its chat on the task as it is then: edits stay, a deleted task stays deleted", async () => {
  // paused and renamed while its chat was being made
  const t = setup();
  t.tasks.set('t1', task({ kind: 'heartbeat', harness: 'claude', status: 'PAUSED', name: 'Renamed' }));
  const id = await t.runner.run(task({ kind: 'heartbeat', harness: 'claude', status: 'ACTIVE' }), { unattended: false });
  assert.deepEqual(
    t.saved.map((a) => [a.status, a.name, a.target_thread_id]),
    [['PAUSED', 'Renamed', id]],
  );
  // deleted meanwhile: nothing is written back
  const gone = setup();
  await gone.runner.run(task({ kind: 'heartbeat', harness: 'claude' }), { unattended: true });
  assert.equal(gone.saved.length, 0);
  // another run named its chat first: that one stays
  const raced = setup();
  raced.tasks.set('t1', task({ kind: 'heartbeat', harness: 'claude', target_thread_id: 'claude:first' }));
  await raced.runner.run(task({ kind: 'heartbeat', harness: 'claude' }), { unattended: true });
  assert.equal(raced.saved.length, 0);
});

test('a basic-harness run makes a session on that harness, in a worktree when asked', async () => {
  const t = setup();
  const id = await t.runner.run(task({ harness: 'acp:opencode', cwds: ['/proj'], model: 'ignored-by-acp' }), { unattended: true });
  assert.match(id, /^acp:opencode:[0-9a-f-]{36}$/);
  assert.deepEqual(t.acp, [[id, { cwd: '/proj' }]]);
  assert.deepEqual(t.started[0], { harness: 'acp', chatId: id, cwd: '/proj', worktreeOf: null });
  assert.deepEqual(t.sessions.get(id).scheduled, { unattended: true, computer: false, onApproval: 'wait' });
  assert.equal(t.sent[0].chatId, id);
  const w = await t.runner.run(task({ harness: 'acp:kimi', cwds: ['/proj'], execution_environment: 'worktree' }), { unattended: true });
  assert.deepEqual(t.metas.at(-1), [w, { worktreeOf: '/proj' }]);
  assert.equal(t.started.at(-1).worktreeOf, '/proj');
  assert.deepEqual(t.claude, []);
});

test('a basic harness that is not usable says its name', async () => {
  const t = setup({ usable: false, label: (k: string) => (k === 'acp:kimi' ? 'Kimi Code' : undefined) });
  await assert.rejects(t.runner.run(task({ harness: 'acp:kimi' }), { unattended: true }), /Kimi Code isn’t available/);
  await assert.rejects(t.runner.run(task({ harness: 'acp:other' }), { unattended: true }), /acp:other isn’t available/);
  const n = setup({ usable: false, noLabel: true });
  await assert.rejects(n.runner.run(task({ harness: 'acp:x' }), { unattended: true }), /acp:x isn’t available/);
});

test('attended runs record the receiving chat on every harness; unattended runs use the scheduler ledger', async () => {
  for (const harness of ['codex', 'claude', 'acp:gemini']) {
    const h = setup();
    const recorded: any[] = [];
    h.runner.o.record = async (...args: any[]) => void recorded.push(args);
    const a = task({ harness });
    const chatId = await h.runner.run(a, { unattended: false });
    assert.deepEqual(recorded, [[a, chatId, harness]]);
    await h.runner.run(a, { unattended: true });
    assert.equal(recorded.length, 1);
  }
});

test('a history write failure is reported to the caller', async () => {
  const h = setup();
  h.runner.o.record = async () => {
    throw new Error('history unavailable');
  };
  await assert.rejects(h.runner.run(task(), { unattended: false }), /history unavailable/);
});

for (const harness of ['codex', 'claude', 'acp:opencode']) {
  for (const failure of ['exit', 'throw']) {
    test(`${harness} setup ${failure} stops the scheduled run before a chat or fallback`, async (t) => {
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-scheduled-setup-'));
      t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
      fs.mkdirSync(path.join(repo, '.codex', 'environments'), { recursive: true });
      fs.writeFileSync(path.join(repo, '.codex', 'environments', 'environment.toml'), '[setup]\nscript = "prepare"\n');
      const h = setup({ worktree: { ok: true, repo, path: '/new/worktree', worktree: '/new/worktree' } });
      h.runner.o.script = async () => {
        if (failure === 'throw') throw new Error('setup spawn failed');
        return { exitCode: 1, output: 'dependency installation failed' };
      };
      await assert.rejects(
        h.runner.run(task({ harness, cwds: [repo], execution_environment: 'worktree' }), { unattended: true }),
        failure === 'throw' ? /setup spawn failed/ : /Setup script failed.*1.*dependency installation failed/s,
      );
      assert.deepEqual(h.started, []);
      assert.deepEqual(h.sent, []);
      assert.deepEqual(h.claude, []);
      assert.deepEqual(h.acp, []);
    });
  }
}

test('worktree creation exceptions retain the project fallback', async () => {
  const h = setup();
  h.runner.o.prefs = () => null;
  h.runner.o.worktree = async () => {
    throw new Error('git unavailable');
  };
  await h.runner.run(task({ harness: 'claude', cwds: ['/project'], execution_environment: 'worktree' }), { unattended: true });
  assert.deepEqual(h.claude[0][1], { cwd: '/project' });
});

test('successful setup completes before a task starts; a signaled script is a failure even without output', async (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-scheduled-setup-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  fs.mkdirSync(path.join(repo, '.codex', 'environments'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.codex', 'environments', 'environment.toml'), '[setup]\nscript = "prepare"\n');
  const h = setup({ worktree: { ok: true, repo, path: '/new/worktree/sub', worktree: '/new/worktree' } });
  h.runner.o.script = async (cwd: string, script: string) => {
    assert.equal(cwd, '/new/worktree');
    assert.equal(script, 'prepare');
    assert.deepEqual(h.started, []);
    return { exitCode: 0, output: '' };
  };
  await h.runner.run(task({ harness: 'claude', cwds: [repo], execution_environment: 'worktree' }), { unattended: true });
  assert.deepEqual(h.claude[0][1], { cwd: '/new/worktree/sub' });
  h.runner.o.script = async () => ({ exitCode: null });
  await assert.rejects(h.runner.newWorktree(repo), /Setup script failed \(exit null\)/);
});

for (const harness of ['codex', 'claude', 'acp:opencode']) {
  test(`${harness} new-chat runs ignore a heartbeat's remembered chat`, async () => {
    const h = setup();
    const a = task({ harness, kind: 'cron', target_thread_id: 'old-heartbeat-chat' });
    const first = await h.runner.run(a, { unattended: true });
    const second = await h.runner.run(a, { unattended: false });
    assert.notEqual(first, 'old-heartbeat-chat');
    assert.notEqual(second, first);
    assert.equal(h.started.length, 2);
    assert.deepEqual(h.saved, []);
    assert.deepEqual(
      h.sent.map((x) => x.chatId),
      [first, second],
    );
  });
  for (const change of ['mode', 'harness']) {
    test(`${harness} heartbeat startup cannot remember a chat after its ${change} changes`, async () => {
      const h = setup();
      const a = task({ harness, kind: 'heartbeat' });
      h.tasks.set(a.id, a);
      const start = h.runner.startChat.bind(h.runner);
      h.runner.startChat = async (...args: any[]) => {
        const id = await start(...args);
        h.tasks.set(a.id, change === 'mode' ? { ...a, kind: 'cron' } : { ...a, harness: harness === 'claude' ? 'codex' : 'claude' });
        return id;
      };
      await h.runner.run(a, { unattended: true });
      assert.deepEqual(h.saved, []);
      assert.equal(h.tasks.get(a.id).target_thread_id, undefined);
    });
  }
}

for (const harness of ['codex', 'claude', 'acp:opencode']) {
  for (const failure of ['malformed', 'unreadable']) {
    test(`${harness} cannot start after its setup file is ${failure}`, async (t) => {
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-invalid-setup-'));
      t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
      const dir = path.join(repo, '.codex', 'environments');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'environment.toml');
      if (failure === 'malformed') fs.writeFileSync(file, '[setup\nscript = "prepare"');
      else fs.mkdirSync(file);
      const h = setup({ worktree: { ok: true, repo, path: '/new/worktree', worktree: '/new/worktree' } });
      await assert.rejects(h.runner.run(task({ harness, cwds: [repo], execution_environment: 'worktree' }), { unattended: true }));
      assert.deepEqual(h.started, []);
      assert.deepEqual(h.sent, []);
      assert.deepEqual(h.scripts, []);
    });
  }
}

test('manual and scheduled runs refuse unfinished harness transfers before any startup', async () => {
  const runner = new AutomationRunner({
    usable: async () => {
      throw new Error('must not reach startup');
    },
  });
  for (const unattended of [false, true])
    await assert.rejects(runner.run({ id: 'pending', transfer_from: 'codex' }, { unattended }), /waiting to finish switching apps/);
});
