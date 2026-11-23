// What woke a turn draws as its head (a monitor's event, a check-in), a watch armed in a turn draws as its step, and a
// run of quiet woken turns draws as one row of the thread that opens to them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { h, render, settle, text, user, reply, turn, chat, view } from './support/thread-view/fixture.ts';

const { BlockItem } = await import('../src/components/thread/Items.tsx');
const { StepRow } = await import('../src/components/thread/items/StepRow.tsx');
const { WokenTurns } = await import('../src/components/thread/view/WokenTurns.tsx');

const wake = (id: string, extra: any = {}, by = 'monitor'): any => ({
  type: 'statusNote',
  id,
  kind: 'wake',
  text: by === 'monitor' ? 'Monitor event · CI run' : 'Scheduled check-in',
  wake: { by, key: by === 'monitor' ? 'mon1' : 'checkin', label: 'CI run', detail: 'unit: success', failed: false, ...extra },
});
const call = (id: string, tool: string, args: any) => ({
  id,
  type: 'mcpToolCall',
  server: '',
  tool,
  arguments: args,
  status: 'completed',
  result: { content: [{ type: 'text', text: 'ok' }] },
  error: null,
});

test('a wake note says what woke the turn: the monitor and what it reported, or the check-in', async (t) => {
  const v = await render(h(BlockItem, { item: wake('w'), cwd: '/r' }));
  t.after(() => v.unmount());
  assert.equal(text(v.$('.status-note.wake .step-text')), 'Monitor event · CI run: unit: success');
  assert.ok(v.$('.status-note.wake .step-em'));
  await v.rerender(h(BlockItem, { item: wake('w', { detail: 'e2e: failure', failed: true }), cwd: '/r' }));
  assert.equal(text(v.$('.status-note.wake .step-exit')), ': e2e: failure');
  await v.rerender(h(BlockItem, { item: wake('c', { detail: null }, 'checkin'), cwd: '/r' }));
  assert.equal(text(v.$('.status-note.wake .step-text')), 'Scheduled check-in');
  assert.ok(v.$('.status-note.wake .step-icon svg'));
});

test('a watch armed in a turn is its own row, opening to the call; a wait on a task says so', async (t) => {
  const row = (step: any) => h(StepRow, { step, cwd: '/r' });
  const monitor = call('m', 'Monitor', { description: 'CI run' });
  const v = await render(row({ kind: 'watch', item: monitor, what: 'monitor', label: 'CI run', ms: 1_800_000, stop: false }));
  t.after(() => v.unmount());
  assert.equal(text(v.$('.step-text')), 'Started a monitor · CI run');
  await settle(() => v.$('.step-row-hit')!.click());
  assert.ok(v.$('.step-body'), 'its input and output');
  await v.rerender(row({ kind: 'watch', item: monitor, what: 'monitor', label: null, ms: null, stop: false }));
  assert.equal(text(v.$('.step-text')), 'Started a monitor');
  const wakeup = call('w', 'ScheduleWakeup', { delaySeconds: 960 });
  await v.rerender(row({ kind: 'watch', item: wakeup, what: 'checkin', label: null, ms: 960_000, stop: false }));
  assert.equal(text(v.$('.step-text')), 'Scheduled a check-in in 16m');
  await v.rerender(row({ kind: 'watch', item: wakeup, what: 'checkin', label: null, ms: null, stop: false }));
  assert.equal(text(v.$('.step-text')), 'Scheduled a check-in');
  await v.rerender(row({ kind: 'watch', item: wakeup, what: 'checkin', label: null, ms: null, stop: true }));
  assert.equal(text(v.$('.step-text')), 'Stopped the check-ins');
  const read = call('o', 'TaskOutput', {});
  await v.rerender(row({ kind: 'wait', item: read, ms: 90_000, on: 'a background task' }));
  assert.equal(text(v.$('.step-text')), 'Waited 1m 30s for a background task');
});

const woken = (id: string, n: number, extra: any = {}) =>
  turn(id, [wake(`w-${id}`, { detail: `check ${n}` }), reply(`r-${id}`, `Still running (${n}).`)], {
    startedAt: 1000 + n * 60,
    completedAt: 1000 + n * 60 + 5,
    durationMs: 5000,
    ...extra,
  });

test('quiet woken turns fold into one row of the thread that opens to them; the latest stays open', async (t) => {
  chat([
    turn('t0', [user('u0', 'Watch CI'), reply('r0', 'Watching.')], { durationMs: 1000 }),
    woken('a', 1),
    woken('b', 2),
    woken('c', 3),
    woken('d', 4),
  ]);
  const v = await render(view());
  t.after(() => v.unmount());
  const row = v.$('.woken-turns > .step-row.summary')!;
  assert.equal(text(row.querySelector('.step-text')), 'Monitor · CI run · Woke 3 times over 2m 5s');
  assert.equal(row.getAttribute('aria-expanded'), 'false');
  // the latest woken turn is a turn of its own, after the row
  const replies = () => v.$$('.turn .assistant-message [data-stub="Markdown"]').map((m: any) => m.dataset.text);
  assert.deepEqual(replies(), ['Watching.', 'Still running (4).']);
  await settle(() => row.click());
  assert.equal(row.getAttribute('aria-expanded'), 'true');
  assert.deepEqual(replies(), ['Watching.', 'Still running (1).', 'Still running (2).', 'Still running (3).', 'Still running (4).']);
  await settle(() => row.click());
  assert.equal(row.getAttribute('aria-expanded'), 'false');
});

test('a jump to a turn inside the row opens it, and a failed wake is counted on the row', async (t) => {
  const entry: any = {
    kind: 'woken',
    turns: [woken('a', 1), woken('b', 2)],
    wakes: [
      { key: 'monitor:mon1', label: 'Monitor · CI run', failed: false },
      { key: 'monitor:mon1', label: 'Monitor · CI run', failed: true },
    ],
  };
  const renderTurn = (turn: any) => h('div', { className: 'turn-stub' }, turn.id);
  const v = await render(h(WokenTurns, { entry, renderTurn, target: null }));
  t.after(() => v.unmount());
  assert.equal(text(v.$('.woken-turns .step-exit')), ' · 1 failed');
  assert.equal(v.$$('.turn-stub').length, 0);
  await v.rerender(h(WokenTurns, { entry, renderTurn, target: 'b' }));
  assert.deepEqual(v.$$('.turn-stub').map(text), ['a', 'b']);
  // the reader can fold it again while the jump's target is still set, and open it once more
  await settle(() => v.$('.woken-turns > .step-row')!.click());
  assert.equal(v.$$('.turn-stub').length, 0);
  await settle(() => v.$('.woken-turns > .step-row')!.click());
  assert.equal(v.$$('.turn-stub').length, 2);
});
