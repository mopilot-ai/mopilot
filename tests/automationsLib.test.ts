// Scheduled tasks for the Scheduled page (src/lib/automations.ts): listing, saving and deleting go through main
// (which keeps each task where its harness runs it), and reading rules on the user's clock.
import './support/tz-la.ts';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { installNativeStub } from './support/ports/native.ts';

// rrule's Node entry is CommonJS without named exports; the app's bundler reads its ESM build
const { default: rrule } = await import('rrule');
mock.module('rrule', { namedExports: { RRule: (rrule as any).RRule } });

const calls: any[] = [];
let listed: { tasks: any[]; errors: string[] } = { tasks: [], errors: [] };
let removeError: unknown = null;
let updateError: unknown = null;
installNativeStub({
  automation: {
    list: async () => (calls.push(['list']), listed),
    save: async (a: any) => (calls.push(['save', a]), { ...a, id: a.id || 'made-by-main' }),
    update: async (id: string, changes: any) => {
      calls.push(['update', id, changes]);
      if (updateError) throw updateError;
      const current = listed.tasks.find((task) => task.id === id);
      if (!current) throw new Error('Scheduled task no longer exists');
      return { ...current, ...changes };
    },
    remove: async (id: string) => {
      calls.push(['remove', id]);
      if (removeError) throw removeError;
    },
  },
});
const {
  PRESETS,
  TASK_STATE_LABEL,
  taskState,
  deleteAutomation,
  describeRule,
  editedFields,
  listAutomations,
  nextRun,
  saveAutomation,
  saveEditedAutomation,
} = await import('../src/lib/automations.ts');

test('the list is main’s; files that did not load are reported one by one', async () => {
  listed = { tasks: [{ id: 'a' }, { id: 'b' }], errors: ['bad one', 'bad two'] };
  const errors: string[] = [];
  const list = await listAutomations((m) => errors.push(m));
  assert.deepEqual(
    list.map((a) => a.id),
    ['a', 'b'],
  );
  assert.deepEqual(errors, ['bad one', 'bad two']);
});

test('saving and deleting go to main; a new task gets its id there', async () => {
  const saved = await saveAutomation({ version: 1, id: '', kind: 'cron', name: 'N', prompt: 'p', status: 'ACTIVE', rrule: '' });
  assert.equal(saved.id, 'made-by-main');
  await deleteAutomation('x');
  assert.deepEqual(calls.slice(-2), [
    ['save', { version: 1, id: '', kind: 'cron', name: 'N', prompt: 'p', status: 'ACTIVE', rrule: '' }],
    ['remove', 'x'],
  ]);
});

test('a delete main refuses is reported, not taken as done', async () => {
  removeError = new Error('permission denied');
  await assert.rejects(deleteAutomation('x'), /permission denied/);
  removeError = null;
  await deleteAutomation('x');
});

test('implicit sub-daily schedules have a stable next occurrence as the clock advances', () => {
  for (const [rule, expected] of [
    ['FREQ=SECONDLY;INTERVAL=10', '2026-01-05T10:15:10.000Z'],
    ['FREQ=MINUTELY;INTERVAL=30', '2026-01-05T10:30:00.000Z'],
    ['FREQ=HOURLY;INTERVAL=1', '2026-01-05T11:00:00.000Z'],
  ]) {
    for (const after of ['2026-01-05T10:15:01Z', '2026-01-05T10:15:09Z']) {
      assert.equal(nextRun(rule, new Date(after))!.toISOString(), expected, `${rule} after ${after}`);
    }
  }
  // an interval that doesn't divide the hour keeps one phase however the clock moves
  const seven = ['2026-01-05T23:59:59Z', '2026-01-06T00:00:00Z'].map((a) => nextRun('FREQ=MINUTELY;INTERVAL=7', new Date(a))!.getTime());
  assert.equal(seven[0], seven[1]);
  // an explicit DTSTART remains authoritative, including its minute/second phase
  assert.equal(
    nextRun('FREQ=HOURLY;DTSTART=20260101T091523Z', new Date('2026-01-05T10:15:01Z'))!.toISOString(),
    '2026-01-05T10:15:23.000Z',
  );
});

test('rules read as sentences, with or without the RRULE prefix', () => {
  assert.equal(describeRule('FREQ=HOURLY;INTERVAL=1'), 'Every hour');
  assert.equal(describeRule('RRULE:FREQ=DAILY'), 'Every day');
  assert.equal(describeRule('nonsense'), 'nonsense');
  assert.equal(PRESETS.length, 5);
});

test('the next run is on the user’s clock, as main runs it', () => {
  const after = new Date(2026, 0, 5, 10, 15);
  assert.equal(nextRun('FREQ=DAILY;BYHOUR=9;BYMINUTE=0', after)!.getTime(), new Date(2026, 0, 6, 9).getTime());
  for (const rule of ['FREQ=SECONDLY;INTERVAL=10', 'FREQ=MINUTELY', 'RRULE:FREQ=HOURLY;INTERVAL=2']) {
    assert.ok(nextRun(rule, after)!.getTime() > after.getTime(), rule);
  }
  assert.ok(nextRun('FREQ=DAILY') instanceof Date);
  assert.equal(nextRun('nonsense'), null);
});

test('an edit sends only changed fields to main without an unlocked list or full-record save', async () => {
  const opened: any = { version: 1, id: 't', kind: 'heartbeat', name: 'N', prompt: 'old', status: 'ACTIVE', rrule: 'R', model: 'm' };
  const now: any = { ...opened, target_thread_id: 'chat-1', status: 'PAUSED' };
  const edited: any = { ...opened, prompt: 'new', model: undefined };
  assert.deepEqual(editedFields(opened, edited), { prompt: 'new', model: undefined });
  listed = { tasks: [now], errors: [] };
  calls.length = 0;
  assert.deepEqual(await saveEditedAutomation(opened, edited), { ...now, prompt: 'new', model: undefined });
  assert.deepEqual(calls, [['update', 't', { prompt: 'new', model: undefined }]]);
  listed = { tasks: [], errors: [] };
  await assert.rejects(saveEditedAutomation(opened, edited), /no longer exists/);
  assert.equal(calls.at(-1)?.[0], 'update', 'a deleted task is never recreated');
  updateError = new Error('Unreadable task');
  await assert.rejects(saveEditedAutomation(opened, edited), /Unreadable task/);
  updateError = null;
  assert.equal(edited.prompt, 'new', 'failure retains input for retry');
  listed = { tasks: [now], errors: [] };
  assert.equal((await saveEditedAutomation(opened, edited)).prompt, 'new');
  calls.length = 0;
  await saveEditedAutomation({ ...opened, id: '' }, { ...edited, id: '' });
  assert.deepEqual(calls, [['save', { ...edited, id: '' }]]);
});

test('taskState: one state per task, so an active task with no next time never reads as paused (#1862)', () => {
  const now = new Date(2026, 9, 21, 8, 0);
  assert.deepEqual(taskState({ status: 'PAUSED', rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0' }, now), { kind: 'paused' });
  assert.deepEqual(taskState({ status: 'ACTIVE', rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0' }, now), {
    kind: 'scheduled',
    next: new Date(2026, 9, 21, 9, 0),
  });
  // an exhausted rule: its times are long past
  assert.deepEqual(taskState({ status: 'ACTIVE', rrule: 'RRULE:FREQ=DAILY;UNTIL=20210101T000000Z' }, now), { kind: 'ended' });
  // a cron-only Claude Desktop task, a rule with no FREQ, and one that doesn't parse at all
  assert.deepEqual(taskState({ status: 'ACTIVE', rrule: '' }, now), { kind: 'unscheduled' });
  assert.deepEqual(taskState({ status: 'ACTIVE', rrule: 'BYHOUR=9' }, now), { kind: 'unscheduled' });
  assert.deepEqual(taskState({ status: 'ACTIVE', rrule: 'FREQ=NOPE' }, now), { kind: 'unscheduled' });
  assert.deepEqual(taskState({ status: 'ACTIVE', rrule: 'garbage' }, now), { kind: 'unscheduled' });
  assert.notEqual(TASK_STATE_LABEL.ended, TASK_STATE_LABEL.paused);
  assert.notEqual(TASK_STATE_LABEL.unscheduled, TASK_STATE_LABEL.paused);
});
