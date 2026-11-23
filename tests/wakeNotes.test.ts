// What woke a Claude Code turn no one typed: a Monitor's event or a /loop check-in firing heads the turn as a wake note
// (core/crates/translate/src/claude), in a replayed transcript and live.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monitorWake, statusLine } from './support/claude-translate.ts';

const { buildTurns, ClaudeTranslator } = await import('./support/claude-translate.ts');

let n = 0;
const user = (content: string, extra: object = {}) => ({
  type: 'user',
  uuid: `u${++n}`,
  timestamp: new Date(Date.now() - 3_600_000).toISOString(),
  message: { role: 'user', content },
  parent_tool_use_id: null,
  ...extra,
});
const said = (text: string) => ({
  type: 'assistant',
  uuid: `a${++n}`,
  timestamp: new Date(Date.now() - 3_600_000).toISOString(),
  message: { id: `m${n}`, content: [{ type: 'text', text }] },
  parent_tool_use_id: null,
});
const event = (body: string, summary = 'Monitor event: "CI run 401"') =>
  user(`<task-notification>\n<task-id>mon1</task-id>\n<summary>${summary}</summary>\n<event>${body}</event>\n</task-notification>`, {
    origin: { kind: 'task-notification' },
  });

test('a monitor’s event names its monitor and what it reported, marked when that says something went wrong', () => {
  assert.deepEqual(
    monitorWake({ taskId: 'mon1', summary: 'Monitor event: "CI run 401"', event: 'unit (1): success\n\nunit (2): success' }),
    {
      kind: 'wake',
      text: 'Monitor event · CI run 401',
      wake: { by: 'monitor', key: 'mon1', label: 'CI run 401', detail: 'unit (1): success, unit (2): success', failed: false },
    },
  );
  for (const word of ['e2e: failure', 'build failed', 'tests failing', '2 errors', 'job cancelled', 'step timed out'])
    assert.equal(monitorWake({ taskId: 'm', event: word }).wake.failed, true, word);
  // a count that says nothing failed is no failure; one that says something did still is
  for (const word of ['unit: 120 passed, 0 failed', 'build ok, no errors', 'failures: 0', 'errors=0'])
    assert.equal(monitorWake({ taskId: 'm', event: word }).wake.failed, false, word);
  assert.equal(monitorWake({ taskId: 'm', event: '1 failed, 0 errors' }).wake.failed, true);
  // no summary to read the monitor from: its description, else just "Monitor"; no task id: its label is its key
  assert.deepEqual(monitorWake({ description: 'Deploy log', event: 'up' }).wake, {
    by: 'monitor',
    key: 'Deploy log',
    label: 'Deploy log',
    detail: 'up',
    failed: false,
  });
  assert.equal(monitorWake({ taskId: 'm', summary: 'other', event: 'up' }).wake.label, 'Monitor');
});

test('a /loop check-in firing is a wake note, never the prompt again as the user’s words', () => {
  const fired = (content: string, extra: object) => statusLine(user(content, { isMeta: true, ...extra }));
  assert.deepEqual(fired('Check PR #2140: unit-tests status, merge-gate result', { turnOrigin: 'scheduled' }), {
    kind: 'wake',
    text: 'Scheduled check-in',
    wake: { by: 'checkin', key: 'checkin', label: 'Check PR #2140: unit-tests status, merge-gate result', detail: null, failed: false },
  });
  // origin says so instead; a prompt that is only a reminder reads as the check-in itself
  assert.equal(fired('<system-reminder>x</system-reminder>', { origin: { kind: 'scheduled' } })!.wake.label, 'Scheduled check-in');
  // what the person typed, even with that origin, stays their message
  assert.equal(statusLine(user('Check PR', { turnOrigin: 'scheduled' })), null);
});

test('replayed, each event heads the turn it woke, and a check-in heads its own', () => {
  const turns = buildTurns(
    [
      user('Watch CI'),
      said('Watching.'),
      event('unit: success'),
      said('Unit passed.'),
      event('e2e: failure'),
      said('e2e failed.'),
      user('Check PR', { isMeta: true, turnOrigin: 'scheduled' }),
      said('Still open.'),
    ],
    'claude:x',
    '/repo',
  );
  assert.deepEqual(
    turns.map((t: any) => [t.items[0].type, t.items[0].kind ?? null, t.items[0].wake?.detail ?? null, t.items[0].wake?.failed ?? null]),
    [
      ['userMessage', null, null, null],
      ['statusNote', 'wake', 'unit: success', false],
      ['statusNote', 'wake', 'e2e: failure', true],
      ['statusNote', 'wake', null, false],
    ],
  );
});

test('live, an event that comes between turns heads the turn Claude Code starts for it', () => {
  const seen: any[] = [];
  const tr = new ClaudeTranslator('claude:x', '/repo', (m: string, p: any) => m === 'item/completed' && seen.push(p.item));
  tr.onMessage(event('static: success') as any);
  assert.equal(seen.length, 0, 'held until a turn opens');
  // Claude Code starts work on its own: its first message opens the turn
  tr.onMessage(said('Static passed.') as any);
  // the note first, as the head of the turn, then what Claude Code said
  assert.deepEqual(
    seen.map((i) => [i.type, i.kind ?? null, i.wake?.detail ?? i.text]),
    [
      ['statusNote', 'wake', 'static: success'],
      ['agentMessage', null, 'Static passed.'],
    ],
  );
});
