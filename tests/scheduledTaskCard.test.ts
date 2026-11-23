// A chat's scheduled-task tool call that worked (src/lib/scheduledTaskCall.ts, src/components/thread/ScheduledTaskCard.tsx):
// read from the call item on every harness's shape, and the card: what the task is, where it runs, and Open, Pause, Run now.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { fakeStore, render, click, byText, flush } from './support/pages-kit.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const { createElement: h } = await import('react');
const calls: any[] = [];
const store = fakeStore<any>({ basicHarnesses: [{ id: 'opencode', label: 'opencode', state: 'admitted' }] });
let listed: any[] = [];
let saveFail: unknown = null;
let runResult: any = 'run-chat';
stubStore({
  useStore: store.useStore,
  navigate: (r: any) => calls.push(['navigate', r]),
  toast: (...a: any[]) => calls.push(['toast', ...a]),
});
mock.module('../src/session/scheduledFocus.ts', { namedExports: { showScheduledTask: (id: string) => calls.push(['show', id]) } });
installNativeStub({
  automation: {
    list: async () => ({ tasks: listed, errors: [] }),
    update: async (id: string, patch: any) => {
      const a = listed.find((task) => task.id === id);
      if (!a) throw new Error('This scheduled task was deleted');
      calls.push(['update', id, patch.status]);
      if (saveFail) throw saveFail;
      return { ...a, ...patch };
    },
    run: async (a: any) => {
      calls.push(['run', a.id]);
      if (typeof runResult !== 'string') throw runResult;
      return runResult;
    },
  },
});
const { scheduledTaskCall } = await import('../src/lib/scheduledTaskCall.ts');
const { ScheduledTaskCard } = await import('../src/components/thread/ScheduledTaskCard.tsx');

const summary = (o: any = {}) => ({
  id: 'digest',
  name: 'New issues digest',
  schedule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0',
  when: 'Every weekday at 9 AM',
  status: 'ACTIVE',
  harness: 'claude',
  cwd: '/w/InterviewIndex',
  worktree: false,
  nextRun: new Date(Date.now() + 86_400_000).toISOString(),
  runsIn: ['mopilot', 'claude-desktop'],
  computerControl: false,
  onApproval: 'wait',
  ...o,
});
const result = (v: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(v) }] });
const codexItem = (o: any = {}) => ({
  type: 'mcpToolCall',
  id: 'i1',
  server: 'sage_ab12',
  tool: 'create_scheduled_task',
  status: 'completed',
  arguments: {},
  result: result(summary()),
  error: null,
  ...o,
});

test('a call is read on every harness’s shape: Codex’s server and tool, Claude’s mcp__ name, a basic harness’s title', () => {
  assert.equal(scheduledTaskCall(codexItem())?.action, 'created');
  assert.equal(scheduledTaskCall(codexItem({ server: undefined, tool: 'mcp__sage_x__update_scheduled_task' }))?.action, 'updated');
  assert.equal(scheduledTaskCall(codexItem({ server: undefined, tool: 'sage_x/create_scheduled_task' }))?.action, 'created');
  assert.equal(
    scheduledTaskCall(codexItem({ server: undefined, tool: 'create_scheduled_task', type: 'dynamicToolCall' }))?.action,
    'created',
  );
  assert.deepEqual(
    scheduledTaskCall(codexItem({ tool: 'run_scheduled_task', arguments: { id: 'digest' }, result: result({ chatId: 'c9' }) })),
    { action: 'ran', taskId: 'digest', chatId: 'c9' },
  );
  const task = scheduledTaskCall(codexItem());
  assert.equal(task?.action === 'created' && task.task.name, 'New issues digest');
});

test('anything else is not a card: other servers and tools, unfinished or failed calls, answers of another shape', () => {
  for (const it of [
    null,
    { type: 'agentMessage' },
    codexItem({ server: 'github' }),
    codexItem({ server: undefined, tool: 'mcp__other__create_scheduled_task' }),
    codexItem({ tool: 'list_scheduled_tasks' }),
    codexItem({ tool: 7 }),
    codexItem({ tool: '' }),
    codexItem({ status: 'inProgress' }),
    codexItem({ status: 'failed' }),
    codexItem({ error: { message: 'no' } }),
    codexItem({ result: { ...result(summary()), isError: true } }),
    codexItem({ result: { content: [{ type: 'text', text: 'not json' }] } }),
    codexItem({ result: result({ id: 'x' }) }),
    codexItem({ result: result(null) }),
    codexItem({ tool: 'run_scheduled_task', arguments: { id: 'x' }, result: result({ chatId: 3 }) }),
    codexItem({ tool: 'run_scheduled_task', arguments: null, result: result({ chatId: 'c' }) }),
  ])
    assert.equal(scheduledTaskCall(it), null, JSON.stringify(it));
});

const card = (item: any) => render(h(ScheduledTaskCard, { call: scheduledTaskCall(item)! }));
const facts = (host: HTMLElement) => [...host.querySelectorAll('.sched-call-facts dd')].map((e) => e.textContent);

test('the card says what the task is, where it runs and what a run may do', async () => {
  const v = await card(codexItem());
  assert.equal(v.host.querySelector('.sched-call-title')!.textContent, 'Scheduled task created');
  assert.equal(v.host.querySelector('.sched-call-sub')!.textContent, 'New issues digest');
  assert.equal(v.host.querySelector('.sched-run-status')!.textContent, 'Active');
  const f = facts(v.host);
  assert.match(f[0]!, /^Every weekday at 9 AM · next /);
  assert.equal(f[1], 'Claude Code in InterviewIndex');
  assert.equal(f[2], 'Runs from MoPilot or Claude Desktop, once per time');
  assert.equal(f[3], 'Not control apps · waits for your approval. Change this in Scheduled');
  await v.unmount();
  // a basic harness in a worktree, no folder, paused, a past next time, the rule as is, a run that may do more
  const w = await card(
    codexItem({
      tool: 'update_scheduled_task',
      result: result(
        summary({
          harness: 'acp:opencode',
          cwd: null,
          worktree: true,
          status: 'PAUSED',
          when: undefined,
          nextRun: null,
          runsIn: ['mopilot'],
          computerControl: true,
          onApproval: 'skip',
        }),
      ),
    }),
  );
  assert.equal(w.host.querySelector('.sched-call-title')!.textContent, 'Scheduled task updated');
  assert.equal(w.host.querySelector('.sched-run-status')!.textContent, 'Paused');
  assert.deepEqual(facts(w.host), [
    'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0',
    'opencode, in a fresh worktree',
    'Runs while MoPilot is open',
    'Control apps · skips a run that needs approval. Change this in Scheduled',
  ]);
  await w.unmount();
  const past = await card(codexItem({ result: result(summary({ nextRun: '2020-01-01T00:00:00Z' })) }));
  assert.equal(facts(past.host)[0], 'Every weekday at 9 AM');
  await past.unmount();
});

test('Open, Pause and Resume, and Run now act on the task as main has it; failures are toasted', async () => {
  listed = [{ ...summary(), id: 'digest', prompt: 'p', rrule: 'R' }];
  const v = await card(codexItem());
  calls.length = 0;
  await click(byText(v.host, 'Open in Scheduled'));
  assert.deepEqual(calls, [['show', 'digest']]);
  await click(byText(v.host, 'Pause'));
  await flush();
  assert.deepEqual(calls.at(-1), ['update', 'digest', 'PAUSED']);
  assert.equal(v.host.querySelector('.sched-run-status')!.textContent, 'Paused');
  await click(byText(v.host, 'Resume'));
  await flush();
  assert.deepEqual(calls.at(-1), ['update', 'digest', 'ACTIVE']);
  calls.length = 0;
  await click(byText(v.host, 'Run now'));
  await flush();
  assert.deepEqual(calls, [
    ['run', 'digest'],
    ['navigate', { name: 'thread', id: 'run-chat' }],
  ]);
  saveFail = new Error('read-only');
  calls.length = 0;
  await click(byText(v.host, 'Pause'));
  await flush();
  assert.deepEqual(calls.at(-1), ['toast', 'read-only', 'error']);
  saveFail = null;
  runResult = 'plain';
  runResult = { toString: () => 'busy' };
  await click(byText(v.host, 'Run now'));
  await flush();
  assert.deepEqual(calls.at(-1), ['toast', 'busy', 'error']);
  runResult = 'run-chat';
  // deleted since: says so
  listed = [];
  await click(byText(v.host, 'Run now'));
  await flush();
  assert.deepEqual(calls.at(-1), ['toast', 'This scheduled task was deleted', 'error']);
  await v.unmount();
});

test('a run a chat started opens that run, or the task', async () => {
  const v = await card(codexItem({ tool: 'run_scheduled_task', arguments: { id: 'digest' }, result: result({ chatId: 'c9' }) }));
  assert.equal(v.host.querySelector('.sched-call-title')!.textContent, 'Started a run of a scheduled task');
  calls.length = 0;
  await click(byText(v.host, 'Open the run'));
  await click(byText(v.host, 'Open in Scheduled'));
  assert.deepEqual(calls, [
    ['navigate', { name: 'thread', id: 'c9' }],
    ['show', 'digest'],
  ]);
  await v.unmount();
});

test('reserved tool names are not scheduled-task actions', () => {
  for (const tool of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) assert.equal(scheduledTaskCall(codexItem({ tool })), null);
});

test('Run now refuses both orders of ambiguous canonical rows, then retries the unique current row', async () => {
  const first = { ...summary(), harness: 'codex', prompt: 'first' };
  const second = { ...summary(), harness: 'claude', prompt: 'second' };
  const view = await card(codexItem());
  try {
    for (const rows of [
      [first, second],
      [second, first],
    ]) {
      listed = rows;
      calls.length = 0;
      await click(byText(view.host, 'Run now'));
      await flush();
      assert.equal(
        calls.some((call) => call[0] === 'run' || call[0] === 'navigate'),
        false,
      );
      assert.deepEqual(calls, [['toast', 'Scheduled task id "digest" is ambiguous', 'error']]);
    }
    listed = [second];
    calls.length = 0;
    await click(byText(view.host, 'Run now'));
    await flush();
    assert.deepEqual(calls, [
      ['run', 'digest'],
      ['navigate', { name: 'thread', id: 'run-chat' }],
    ]);
  } finally {
    await view.unmount();
    listed = [];
  }
});
