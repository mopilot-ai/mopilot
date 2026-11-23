// A scheduled run on a remote machine (electron/platform/automationRun.cjs runOnMachine): its chat starts there through the Host's starter, its message goes through the outbox, a machine that is away still takes it later, and one that can't run it fails the run with the reason.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AutomationRunner } = require('../electron/platform/automationRun.cjs');
const { SessionStore } = require('../electron/session/state.cjs');

function setup(o: { machine?: any; send?: any; readiness?: any; start?: any; noMachine?: boolean; noRecord?: boolean } = {}) {
  const sessions = new SessionStore();
  const calls: any = { started: [], starts: [], sends: [], remembered: [], recorded: [], usable: 0, local: [] };
  const machine = o.noMachine
    ? undefined
    : {
        newChatId: (h: string) => `acp:${h === 'claude' ? 'host-claude' : h === 'codex' ? 'host-codex' : h}:n${calls.starts.length + 1}`,
        readiness: o.readiness ?? (() => ({ ok: true, by: 'machine' })),
        start: o.start ?? (async (q: any) => (calls.starts.push(q), { chatId: q.chatId, by: 'machine' })),
        send: o.send ?? (async (chatId: string, item: any) => (calls.sends.push([chatId, item]), { action: 'started', id: 'k' })),
      };
  const runner = new AutomationRunner({
    prefs: () => ({}),
    usable: async () => (calls.usable++, true),
    sessions,
    send: (...a: any[]) => void calls.local.push(a),
    codexThread: async () => assert.fail('no Codex thread on this Mac'),
    claudeSession: () => assert.fail('no Claude session on this Mac'),
    acpSession: () => assert.fail('no basic session on this Mac'),
    chats: { patchMeta: () => true },
    worktree: async () => assert.fail('no worktree'),
    script: async () => ({ exitCode: 0, output: '' }),
    remember: async (a: any, chatId: string) => void calls.remembered.push([a.id, chatId]),
    ...(o.noRecord ? {} : { record: async (a: any, chatId: string, h: string) => void calls.recorded.push([a.id, chatId, h]) }),
    started: (e: any) => void calls.started.push(e),
    machine: () => machine,
    home: '/home/me',
  });
  return { runner, sessions, calls };
}
const task = (o: any = {}) => ({
  id: 't1',
  kind: 'cron',
  name: 'Nightly',
  prompt: 'run the tests',
  host_id: 'box',
  cwds: ['/srv/app'],
  ...o,
});

test('a run on a machine starts its chat there, is listed under its project, and sends the prompt with its model through the outbox', async () => {
  const t = setup();
  const id = await t.runner.run(task({ harness: 'claude', model: 'opus', reasoning_effort: 'high', project_id: 'p1' }), {
    unattended: true,
  });
  assert.equal(id, 'acp:host-claude:n1');
  assert.deepEqual(t.calls.starts, [{ chatId: id, hostId: 'box', folder: '/srv/app', harness: 'claude', projectId: 'p1' }]);
  assert.deepEqual(t.calls.started, [{ harness: 'acp', chatId: id, cwd: '/srv/app', worktreeOf: null, hostId: 'box', projectId: 'p1' }]);
  assert.deepEqual(t.calls.sends, [[id, { text: 'run the tests', attachments: [], opts: { model: 'opus', effort: 'high' } }]]);
  assert.deepEqual(t.sessions.get(id).scheduled, { unattended: true, computer: false, onApproval: 'wait' });
  // this Mac's harness is not asked: the machine runs it; and an unattended run is the scheduler's to record
  assert.equal(t.calls.usable, 0);
  assert.deepEqual(t.calls.local, []);
  assert.deepEqual(t.calls.recorded, []);
});

test('every harness runs on a machine under its Host agent: Codex as codex, a basic one by its id', async () => {
  const t = setup();
  assert.equal(await t.runner.run(task(), { unattended: true }), 'acp:host-codex:n1');
  assert.equal(await t.runner.run(task({ harness: 'acp:kimi', project_id: '' }), { unattended: false }), 'acp:kimi:n2');
  assert.deepEqual(
    t.calls.starts.map((s: any) => [s.harness, s.projectId]),
    [
      ['codex', null],
      ['kimi', null],
    ],
  );
  // a run someone started goes in the history with the task's harness
  assert.deepEqual(t.calls.recorded, [['t1', 'acp:kimi:n2', 'acp:kimi']]);
});

test('a machine that is away takes the message later: queued is a started run', async () => {
  const t = setup({ send: async () => ({ action: 'queued', id: 'k' }) });
  assert.equal(await t.runner.run(task(), { unattended: true }), 'acp:host-codex:n1');
});

test('a message that could not even be kept, or Host turning off, fails the run with its chat', async () => {
  const kept = setup({ send: async () => ({ action: 'failed', error: 'disk full' }) });
  await assert.rejects(kept.runner.run(task(), { unattended: true }), (e: any) => {
    assert.equal(e.message, 'The task’s message didn’t start: disk full');
    assert.equal(e.chatId, 'acp:host-codex:n1');
    return true;
  });
  const off = setup({ send: () => null });
  await assert.rejects(off.runner.run(task(), { unattended: true }), /didn’t start: Host is off/);
});

test('a machine that refuses the chat (signed out, agent missing) fails the run with its reason and makes no chat', async () => {
  const t = setup({
    start: async () => {
      throw Object.assign(new Error('Sign in to Claude Code on box.'), { code: 'harness_not_configured' });
    },
  });
  await assert.rejects(t.runner.run(task({ harness: 'claude' }), { unattended: true }), /Sign in to Claude Code on box\./);
  assert.deepEqual(t.calls.started, []);
  assert.deepEqual(t.calls.sends, []);
});

test('with Host not wired, or no folder picked on the machine, the run fails with what to do', async () => {
  await assert.rejects(setup({ noMachine: true }).runner.run(task(), { unattended: true }), /Host isn’t available/);
  await assert.rejects(setup().runner.run(task({ cwds: [] }), { unattended: true }), /Pick a folder on the machine/);
  await assert.rejects(setup().runner.run(task({ cwds: undefined }), { unattended: true }), /Pick a folder on the machine/);
});

test('a heartbeat on a machine remembers its first chat and goes on in it, checking the machine can still run it', async () => {
  const t = setup();
  const id = await t.runner.run(task({ kind: 'heartbeat' }), { unattended: true });
  assert.deepEqual(t.calls.remembered, [['t1', id]]);
  const again = await t.runner.run(task({ kind: 'heartbeat', target_thread_id: id }), { unattended: true });
  assert.equal(again, id);
  assert.equal(t.calls.starts.length, 1);
  assert.equal(t.calls.sends.length, 2);
  const out = setup({ readiness: () => ({ ok: false, error: new Error('Sign in to Codex on box.') }) });
  await assert.rejects(
    out.runner.run(task({ kind: 'heartbeat', target_thread_id: 'acp:host-codex:x' }), { unattended: true }),
    /Sign in to Codex/,
  );
  assert.deepEqual(out.calls.sends, []);
});

test('a task waiting to switch apps still waits, on a machine too', async () => {
  await assert.rejects(setup().runner.run(task({ transfer_from: 'codex' }), { unattended: true }), /waiting to finish switching apps/);
});

test('a heartbeat whose first message could not be kept does not remember the chat: the next run starts a new one', async () => {
  const t = setup({ send: async () => ({ action: 'failed', error: 'disk full' }) });
  await assert.rejects(t.runner.run(task({ kind: 'heartbeat' }), { unattended: true }), /disk full/);
  assert.deepEqual(t.calls.remembered, []);
  // queued for a machine that is away: it is remembered
  const away = setup({ send: async () => ({ action: 'queued', id: 'k' }) });
  const id = await away.runner.run(task({ kind: 'heartbeat' }), { unattended: true });
  assert.deepEqual(away.calls.remembered, [['t1', id]]);
});

test('a runner with no history to record still runs an attended task on a machine', async () => {
  const t = setup({ noRecord: true });
  assert.equal(await t.runner.run(task({ prompt: undefined }), { unattended: false }), 'acp:host-codex:n1');
  // a task with no prompt sends an empty message
  assert.equal(t.calls.sends[0][1].text, '');
});
