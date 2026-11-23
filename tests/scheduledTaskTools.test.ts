// Scheduled-task tools for chats (electron/capabilities/tools/scheduledTasks.cjs): one tool set on every harness;
// a new task defaults to the calling chat's current harness and folder, can't control apps and waits for
// approvals; schedules as RRULE or cron; only the chat that owns the call may use them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { registerScheduledTaskTools, ruleOf, summary } = require('../electron/capabilities/tools/scheduledTasks.cjs');
const { Registry } = require('../electron/capabilities/contract/registry.cjs');

/** A store that keeps tasks in memory, as AutomationStore.save and get answer. */
function memoryStore() {
  const tasks = new Map<string, any>();
  return {
    tasks,
    list: async () => ({ tasks: [...tasks.values()], errors: [] }),
    get: async (id: string) => tasks.get(id) ?? null,
    update: async (id: string, changes: any) => {
      const current = tasks.get(id);
      if (!current) return null;
      const next = { ...current, ...changes, id };
      tasks.set(id, next);
      return next;
    },
    remove: async (id: string) => void tasks.delete(id),
    save: async (a: any) => {
      const id = a.id || `task-${tasks.size + 1}`;
      const t = { ...a, id, runs_in: { apps: ['mopilot'] } };
      tasks.set(id, t);
      return t;
    },
  };
}

function setup(
  o: {
    harness?: Record<string, string | null>;
    cwd?: string | null;
    changed?: boolean;
    said?: (chatId: string) => string;
    modelOf?: (chatId: string) => string | null;
    runs?: (id: string, limit: number) => Promise<any[]>;
    confirm?: 'allow' | 'deny' | 'unanswered' | 'unavailable' | 'none';
  } = {},
) {
  const registry = new Registry();
  const store = memoryStore();
  const ran: any[] = [];
  const changes: any[] = [];
  const forgotten: string[] = [];
  const confirmed: any[] = [];
  const dispose = registerScheduledTaskTools(registry, {
    store,
    run: async (a: any) => (ran.push(a.id), `run-of-${a.id}`),
    // a chat owns segments named after it
    owner: (ctx: any) => (ctx.segmentId === `seg-${ctx.chatId}` ? ctx.chatId : null),
    harnessOf: (chatId: string) => (o.harness ?? { codexChat: 'codex', claudeChat: 'claude', acpChat: 'acp:opencode' })[chatId] ?? null,
    cwdOf: async () => (o.cwd === undefined ? '/proj' : o.cwd),
    nextRun: (rule: string) => (rule.includes('FREQ=') && !rule.includes('BAD') ? new Date(Date.UTC(2030, 0, 1, 9)) : null),
    describe: (rule: string) => `said ${rule}`,
    ...(o.runs ? { runs: o.runs } : {}),
    forget: async (id: string) => void forgotten.push(id),
    ...(o.confirm === 'none'
      ? {}
      : {
          confirmDelete: async (chatId: string, signal: any, task: any) => {
            assert.ok(signal instanceof AbortSignal);
            confirmed.push([chatId, task.id]);
            return o.confirm ?? 'allow';
          },
        }),
    ...(o.said ? { said: o.said } : {}),
    ...(o.modelOf ? { modelOf: o.modelOf } : {}),
    ...(o.changed === false ? {} : { changed: (e: any) => changes.push(e) }),
  });
  const call = async (chatId: string, tool: string, args: any) => {
    const r = await registry.invoke(chatId, `seg-${chatId}`, tool, args);
    if (!r.ok) return { error: r.error };
    return JSON.parse(r.content[0].text);
  };
  return { registry, store, ran, changes, call, dispose, forgotten, confirmed };
}

test('task default names and prompt summaries preserve Unicode for every calling harness', async () => {
  const s = setup();
  for (const id of ['codexChat', 'claudeChat', 'acpChat']) {
    const prompt = 'a'.repeat(59) + '🙂' + 'x'.repeat(1939) + '🙂tail';
    const created = await s.call(id, 'create_scheduled_task', { prompt, schedule: 'FREQ=HOURLY' });
    assert.equal(created.name, 'a'.repeat(59) + '🙂');
    assert.equal(created.prompt, prompt.slice(0, -4));
    assert.equal(s.store.tasks.get(created.id).prompt, prompt, 'the full original prompt is persisted');
  }
  s.dispose();
});

test('the tools are on the registry as observe/act, and go away together', () => {
  const s = setup();
  assert.deepEqual(
    s.registry.list().map((t: any) => [t.name, t.policy]),
    [
      ['list_scheduled_tasks', 'observe'],
      ['create_scheduled_task', 'act'],
      ['update_scheduled_task', 'act'],
      ['run_scheduled_task', 'act'],
      ['list_task_runs', 'observe'],
      ['delete_scheduled_task', 'act'],
    ],
  );
  s.dispose();
  assert.deepEqual(s.registry.list(), []);
});

test('a new task runs with the calling chat’s harness and folder, on any harness, and stays safe', async () => {
  const s = setup();
  for (const [chat, harness] of [
    ['codexChat', 'codex'],
    ['claudeChat', 'claude'],
    ['acpChat', 'acp:opencode'],
  ]) {
    const r = await s.call(chat, 'create_scheduled_task', { prompt: 'Summarize new issues\nand more', schedule: '0 9 * * 1-5' });
    assert.equal(r.harness, harness, chat);
    assert.equal(r.cwd, '/proj');
    assert.equal(r.schedule, 'FREQ=WEEKLY;BYHOUR=9;BYMINUTE=0;BYDAY=MO,TU,WE,TH,FR');
    assert.equal(r.name, 'Summarize new issues');
    const saved = s.store.tasks.get(r.id);
    assert.equal(saved.computer_control, false);
    assert.equal(saved.on_approval, 'wait');
    assert.equal(saved.created_by_chat, chat);
    assert.equal(saved.status, 'ACTIVE');
    assert.equal(saved.execution_environment, 'local');
  }
  assert.deepEqual(
    s.changes.map((c) => [c.action, c.chatId]),
    [
      ['created', 'codexChat'],
      ['created', 'claudeChat'],
      ['created', 'acpChat'],
    ],
  );
});

test('a chat may name the harness, folder, worktree, model and effort the user named; an RRULE is taken as is', async () => {
  const s = setup({ said: () => 'every night on Claude, with Opus at high effort' });
  const r = await s.call('codexChat', 'create_scheduled_task', {
    name: 'Nightly',
    prompt: 'go',
    schedule: 'rrule:freq=daily;byhour=2;byminute=0',
    harness: 'claude',
    cwd: '/other',
    worktree: true,
    model: 'opus',
    effort: 'high',
  });
  assert.deepEqual(
    { ...r, nextRun: undefined },
    {
      id: r.id,
      name: 'Nightly',
      prompt: 'go',
      schedule: 'FREQ=DAILY;BYHOUR=2;BYMINUTE=0',
      when: 'said FREQ=DAILY;BYHOUR=2;BYMINUTE=0',
      status: 'ACTIVE',
      harness: 'claude',
      cwd: '/other',
      machine: null,
      worktree: true,
      nextRun: undefined,
      runsIn: ['mopilot'],
      computerControl: false,
      onApproval: 'wait',
    },
  );
  assert.equal(r.nextRun, '2030-01-01T09:00:00.000Z');
  const saved = s.store.tasks.get(r.id);
  assert.equal(saved.model, 'opus');
  assert.equal(saved.reasoning_effort, 'high');
});

test('a chat with no harness or folder gets Codex and no folder', async () => {
  const s = setup({ cwd: null });
  const r = await s.call('stray', 'create_scheduled_task', { prompt: 'x', schedule: 'FREQ=HOURLY' });
  assert.equal(r.harness, 'codex');
  assert.equal(r.cwd, null);
});

test('bad input is refused with a reason', async () => {
  const s = setup();
  assert.equal((await s.call('codexChat', 'create_scheduled_task', { prompt: '  ', schedule: 'FREQ=DAILY' })).error.code, 'bad_prompt');
  assert.equal((await s.call('codexChat', 'create_scheduled_task', { prompt: 'x', schedule: 'every day' })).error.code, 'bad_schedule');
  assert.equal((await s.call('codexChat', 'create_scheduled_task', { prompt: 'x', schedule: 'FREQ=BAD' })).error.code, 'bad_schedule');
  assert.equal(
    (await s.call('codexChat', 'create_scheduled_task', { prompt: 'x', schedule: 'FREQ=DAILY', harness: 'gpt' })).error.code,
    'bad_harness',
  );
  assert.equal((await s.call('codexChat', 'update_scheduled_task', { id: 'missing' })).error.code, 'not_found');
  assert.equal((await s.call('codexChat', 'run_scheduled_task', { id: 'missing' })).error.code, 'not_found');
  // a call from a segment the chat doesn't own
  const r = await s.registry.invoke('codexChat', 'someone-else', 'list_scheduled_tasks', {});
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'no_owner');
  assert.throws(() => ruleOf(undefined, () => true), /isn't a schedule/);
});

test('update changes what it names, pauses and resumes, and never what a run may do', async () => {
  const s = setup({ said: (chatId) => (chatId === 'acpChat' ? 'move it to kimi on model m, low effort' : '') });
  const { id } = await s.call('codexChat', 'create_scheduled_task', { prompt: 'x', schedule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0' });
  // the user turned computer control on in the Scheduled page
  s.store.tasks.set(id, { ...s.store.tasks.get(id), computer_control: true, on_approval: 'skip' });
  const r = await s.call('acpChat', 'update_scheduled_task', {
    id,
    name: 'Renamed',
    prompt: 'y',
    schedule: '30 7 * * *',
    harness: 'acp:kimi',
    cwd: '/x',
    worktree: false,
    model: 'm',
    effort: 'low',
    status: 'PAUSED',
  });
  assert.equal(r.name, 'Renamed');
  assert.equal(r.status, 'PAUSED');
  assert.equal(r.nextRun, null);
  assert.equal(r.schedule, 'FREQ=DAILY;BYHOUR=7;BYMINUTE=30');
  assert.equal(r.harness, 'acp:kimi');
  const saved = s.store.tasks.get(id);
  assert.equal(saved.computer_control, true, 'left as the user set it');
  assert.equal(saved.on_approval, 'skip');
  assert.equal(saved.model, 'm');
  assert.equal((await s.call('acpChat', 'update_scheduled_task', { id, status: 'ACTIVE', worktree: true })).status, 'ACTIVE');
  assert.equal(s.store.tasks.get(id).execution_environment, 'worktree');
  assert.equal((await s.call('acpChat', 'update_scheduled_task', { id })).name, 'Renamed', 'nothing named: nothing changes');
  assert.deepEqual(s.changes.at(-1), { id, action: 'updated', chatId: 'acpChat' });
});

test('moving a task to another harness drops a model and effort the user did not name for it', async () => {
  const s = setup({ said: () => 'move it to opencode' });
  const { id } = await s.call('claudeChat', 'create_scheduled_task', { prompt: 'x', schedule: 'FREQ=DAILY' });
  s.store.tasks.set(id, { ...s.store.tasks.get(id), model: 'claude-sonnet-5-5', reasoning_effort: 'medium' });
  // the same harness keeps them
  await s.call('claudeChat', 'update_scheduled_task', { id, harness: 'claude' });
  assert.equal(s.store.tasks.get(id).model, 'claude-sonnet-5-5');
  await s.call('claudeChat', 'update_scheduled_task', { id, harness: 'acp:opencode' });
  const moved = s.store.tasks.get(id);
  assert.equal(moved.harness, 'acp:opencode');
  assert.equal(moved.model, undefined, "opencode would refuse Claude's model on every run");
  assert.equal(moved.reasoning_effort, undefined);
  // a task that isn't there is not found, whatever harness the call names
  assert.equal((await s.call('claudeChat', 'update_scheduled_task', { id: 'gone', harness: 'acp:opencode' })).error.code, 'not_found');
  // a model and effort named with the move go with it
  const t = setup({ said: () => 'move it to opencode on model opencode/glm-5.3-flash-free, high effort' });
  const made = await t.call('claudeChat', 'create_scheduled_task', { prompt: 'x', schedule: 'FREQ=DAILY' });
  await t.call('claudeChat', 'update_scheduled_task', {
    id: made.id,
    harness: 'acp:opencode',
    model: 'opencode/glm-5.3-flash-free',
    effort: 'high',
  });
  assert.equal(t.store.tasks.get(made.id).model, 'opencode/glm-5.3-flash-free');
  assert.equal(t.store.tasks.get(made.id).reasoning_effort, 'high');
});

test('list filters by name; run starts it now', async () => {
  const s = setup();
  await s.call('codexChat', 'create_scheduled_task', { name: 'Morning news', prompt: 'x', schedule: 'FREQ=DAILY' });
  await s.call('codexChat', 'create_scheduled_task', { name: 'Evening', prompt: 'y', schedule: 'FREQ=DAILY' });
  assert.deepEqual(
    (await s.call('claudeChat', 'list_scheduled_tasks', { query: 'MORNING' })).tasks.map((t: any) => t.name),
    ['Morning news'],
  );
  assert.equal((await s.call('claudeChat', 'list_scheduled_tasks', {})).tasks.length, 2);
  assert.equal((await s.call('claudeChat', 'list_scheduled_tasks', undefined)).tasks.length, 2);
  assert.deepEqual(await s.call('claudeChat', 'run_scheduled_task', { id: 'task-1' }), { chatId: 'run-of-task-1' });
  assert.deepEqual(s.ran, ['task-1']);
  assert.deepEqual(s.changes.at(-1), { id: 'task-1', action: 'ran', chatId: 'claudeChat' });
});

test('list says which machine a task runs on', async () => {
  const s = setup();
  await s.call('codexChat', 'create_scheduled_task', { name: 'On box', prompt: 'x', schedule: 'FREQ=DAILY' });
  s.store.tasks.get('task-1').host_id = 'box';
  assert.deepEqual(
    (await s.call('claudeChat', 'list_scheduled_tasks', {})).tasks.map((t: any) => t.machine),
    ['box'],
  );
});

test('with nobody to tell, changes still save; a summary trims long prompts and fills defaults', async () => {
  const s = setup({ changed: false });
  assert.equal((await s.call('codexChat', 'create_scheduled_task', { prompt: 'x', schedule: 'FREQ=DAILY' })).status, 'ACTIVE');
  const sum = summary({ id: 7, name: 'n', prompt: 'p'.repeat(3000), rrule: 'FREQ=DAILY', status: 'PAUSED' }, () => null);
  assert.equal(sum.id, '7');
  assert.equal(sum.prompt.length, 2000);
  assert.equal(sum.cwd, null);
  assert.deepEqual(sum.runsIn, ['mopilot']);
  assert.equal(summary({ id: 'a', rrule: 'X', status: 'ACTIVE' }, () => null).nextRun, null);
  assert.equal(summary({ id: 'a', rrule: 'X', status: 'ACTIVE' }, () => null).prompt, '');
  // with no describer the rule is its own sentence; what a run may do as the task says
  const s2 = summary({ id: 'a', rrule: 'X', status: 'ACTIVE', computer_control: true, on_approval: 'skip' }, () => null);
  assert.deepEqual([s2.when, s2.computerControl, s2.onApproval], ['X', true, 'skip']);
});

for (const chat of ['codexChat', 'claudeChat', 'acpChat']) {
  test(`${chat} cannot replace a scheduled prompt with empty input`, async () => {
    const s = setup();
    const created = await s.call(chat, 'create_scheduled_task', { prompt: 'Keep this prompt', schedule: 'FREQ=DAILY' });
    const before = { ...s.store.tasks.get(created.id) };
    const changes = s.changes.length;
    for (const prompt of ['', ' ', '\n\t\r', '\u2003\u00a0']) {
      const result = await s.call(chat, 'update_scheduled_task', { id: created.id, prompt, name: 'Must not be saved', status: 'PAUSED' });
      assert.equal(result.error?.code, 'bad_prompt');
      assert.deepEqual(s.store.tasks.get(created.id), before);
      assert.equal(s.changes.length, changes, 'a refused update announces no change');
    }
    const prompt = '  Preserve indentation\n  and trailing whitespace  ';
    const updated = await s.call(chat, 'update_scheduled_task', { id: created.id, prompt });
    assert.equal(updated.prompt, prompt);
    assert.equal(s.store.tasks.get(created.id).prompt, prompt);
    assert.equal((await s.call(chat, 'update_scheduled_task', { id: created.id, name: 'Renamed' })).prompt, prompt);
  });
}

test('a harness, model or effort the user did not name is set aside, on create and on update, from every harness (#2084)', async () => {
  const s = setup({ said: () => 'make that a daily task' });
  for (const [chat, own, other] of [
    ['codexChat', 'codex', 'claude'],
    ['claudeChat', 'claude', 'codex'],
    ['acpChat', 'acp:opencode', 'codex'],
  ]) {
    const r = await s.call(chat, 'create_scheduled_task', {
      prompt: 'x',
      schedule: 'FREQ=DAILY',
      harness: other,
      model: 'gpt-5.5',
      effort: 'xhigh',
    });
    assert.equal(r.harness, own, chat);
    assert.deepEqual(r.ignored, [
      `harness "${other}" was set aside: the user didn't name it this turn, so it runs on this chat's harness`,
      `model "gpt-5.5" was set aside: the user didn't name it this turn, so it runs on the harness's default model`,
      `effort "xhigh" was set aside: the user didn't name it this turn, so it runs on the harness's default effort`,
    ]);
    const saved = s.store.tasks.get(r.id);
    assert.equal(saved.model, undefined);
    assert.equal(saved.reasoning_effort, undefined);
    const u = await s.call(chat, 'update_scheduled_task', { id: r.id, harness: other, model: 'gpt-5.5', effort: 'xhigh', name: 'N' });
    assert.equal(u.harness, own);
    assert.equal(u.name, 'N');
    assert.equal(u.ignored.length, 3);
    assert.match(u.ignored[0], /the task keeps its harness/);
    assert.equal(s.store.tasks.get(r.id).model, undefined);
  }
  // the chat's own harness needs no words, and a call that sets nothing aside says nothing about it
  const own = await s.call('claudeChat', 'create_scheduled_task', { prompt: 'x', schedule: 'FREQ=DAILY', harness: 'claude' });
  assert.equal(own.harness, 'claude');
  assert.equal(own.ignored, undefined);
});

test('a chat with no user words for it (no turn recorded) keeps its own harness', async () => {
  const s = setup();
  const r = await s.call('claudeChat', 'create_scheduled_task', {
    prompt: 'x',
    schedule: 'FREQ=DAILY',
    harness: 'codex',
    model: '',
    effort: '',
  });
  assert.equal(r.harness, 'claude');
  assert.equal(r.ignored.length, 1);
});

test('a model of the chat’s Claude family or a cheaper one, and a cheap effort, need no words; a pricier one does', async () => {
  const s = setup({ said: () => 'a nightly lint pass', modelOf: (chatId) => (chatId === 'claudeChat' ? 'sonnet' : null) });
  const cheap = await s.call('claudeChat', 'create_scheduled_task', {
    prompt: 'x',
    schedule: 'FREQ=DAILY',
    model: 'claude-haiku-5-5',
    effort: 'low',
  });
  assert.equal(cheap.ignored, undefined);
  assert.equal(s.store.tasks.get(cheap.id).model, 'claude-haiku-5-5');
  assert.equal(s.store.tasks.get(cheap.id).reasoning_effort, 'low');
  const same = await s.call('claudeChat', 'create_scheduled_task', { prompt: 'x', schedule: 'FREQ=DAILY', model: 'sonnet' });
  assert.equal(same.ignored, undefined);
  const pricier = await s.call('claudeChat', 'create_scheduled_task', {
    prompt: 'x',
    schedule: 'FREQ=DAILY',
    model: 'opus',
    effort: 'high',
  });
  assert.equal(pricier.ignored.length, 2);
  assert.equal(s.store.tasks.get(pricier.id).model, undefined);
  // with no harness known for the chat, the task falls back to Codex and says so
  const stray = await s.call('stray', 'create_scheduled_task', { prompt: 'x', schedule: 'FREQ=DAILY', harness: 'claude' });
  assert.equal(stray.harness, 'codex');
  assert.match(stray.ignored[0], /so it runs on codex$/);
});

test('list_task_runs: a task’s runs newest first from the ledger, bounded, with what each did', async () => {
  const seen: any[] = [];
  const s = setup({
    runs: async (id, limit) => (
      seen.push([id, limit]),
      [
        { scheduledFor: Date.UTC(2030, 0, 2), status: 'started', chatId: 'chat-2', harness: 'claude', manual: true },
        { scheduledFor: Date.UTC(2030, 0, 1), status: 'failed', reason: 'r'.repeat(400), by: 'codex-app' },
        { scheduledFor: 0 },
        { scheduledFor: 'x', status: 'skipped', reason: 'previous-running' },
      ]
    ),
  });
  await s.call('codexChat', 'create_scheduled_task', { name: 'Daily', prompt: 'x', schedule: 'FREQ=DAILY' });
  const out = await s.call('claudeChat', 'list_task_runs', { id: 'task-1' });
  assert.deepEqual(seen, [['task-1', 10]]);
  assert.deepEqual(out.runs[0], {
    startedAt: '2030-01-02T00:00:00.000Z',
    status: 'started',
    manual: true,
    chatId: 'chat-2',
    harness: 'claude',
  });
  assert.equal(out.runs[1].reason.length, 300);
  assert.equal(out.runs[1].by, 'codex-app');
  assert.deepEqual(out.runs[2], { startedAt: '1970-01-01T00:00:00.000Z', status: 'starting' });
  assert.deepEqual(out.runs[3], { startedAt: '1970-01-01T00:00:00.000Z', status: 'skipped', reason: 'previous-running' });
  assert.deepEqual([out.id, out.name], ['task-1', 'Daily']);
  for (const [limit, want] of [
    [3, 3],
    [0, 1],
    [999, 50],
    [2.9, 2],
  ] as const) {
    seen.length = 0;
    await s.call('acpChat', 'list_task_runs', { id: 'task-1', limit });
    assert.equal(seen[0][1], want, String(limit));
  }
  assert.equal((await s.call('acpChat', 'list_task_runs', { id: 'task-1', limit: 2 })).runs.length, 2, 'never more than asked for');
  assert.equal((await s.call('acpChat', 'list_task_runs', { id: 'nope' })).error.code, 'not_found');
  // a build with no run history to read
  const bare = setup();
  await bare.call('codexChat', 'create_scheduled_task', { prompt: 'x', schedule: 'FREQ=DAILY' });
  assert.deepEqual((await bare.call('codexChat', 'list_task_runs', { id: 'task-1' })).runs, []);
});

test('delete_scheduled_task asks the user every time; a refusal or no way to ask deletes nothing', async () => {
  const s = setup();
  await s.call('codexChat', 'create_scheduled_task', { name: 'Gone soon', prompt: 'x', schedule: 'FREQ=DAILY' });
  assert.deepEqual(await s.call('claudeChat', 'delete_scheduled_task', { id: 'task-1' }), { deleted: 'task-1', name: 'Gone soon' });
  assert.deepEqual(s.confirmed, [['claudeChat', 'task-1']]);
  assert.equal(s.store.tasks.has('task-1'), false);
  assert.deepEqual(s.forgotten, ['task-1']);
  assert.deepEqual(s.changes.at(-1), { id: 'task-1', action: 'deleted', chatId: 'claudeChat' });
  assert.equal((await s.call('claudeChat', 'delete_scheduled_task', { id: 'task-1' })).error.code, 'not_found');
  for (const [confirm, code, said] of [
    ['deny', 'denied', /did not allow/],
    ['unanswered', 'unanswered', /went away unanswered, so nothing was deleted/],
    ['unavailable', 'unavailable', /No approval card could be shown, so nothing was deleted/],
    ['none', 'unavailable', /No approval card could be shown/],
  ] as const) {
    const d = setup({ confirm });
    await d.call('codexChat', 'create_scheduled_task', { prompt: 'x', schedule: 'FREQ=DAILY' });
    const res = await d.call('codexChat', 'delete_scheduled_task', { id: 'task-1' });
    assert.equal(res.error.code, code, confirm);
    assert.match(res.error.message, said);
    assert.equal(d.store.tasks.has('task-1'), true);
    assert.deepEqual(d.forgotten, []);
  }
  // a segment the caller doesn't own
  assert.match(
    String((await s.registry.invoke('codexChat', 'other', 'delete_scheduled_task', { id: 'x' })).error?.message),
    /does not own/,
  );
  // with no one to tell and no history to drop, it still deletes
  const bare = setup({ changed: false });
  await bare.call('codexChat', 'create_scheduled_task', { prompt: 'x', schedule: 'FREQ=DAILY' });
  assert.equal((await bare.call('codexChat', 'delete_scheduled_task', { id: 'task-1' })).deleted, 'task-1');
});
