// Claude's agent page and tasks pane, main side (electron/harness/claude/index.cjs): a sub-agent's stored transcript, a task's
// output tail, and a CLI's background tasks settling when its process ends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fakes, load, fakeBin, until, tmp, lastQuery } from './support/electron-claude.ts';

const bin = fakeBin('agents/claude');
const AID = 'a0123456789abcdef';

test("a sub-agent's transcript: the chat's folder first, then every project; a malformed id reads nothing", async () => {
  const t = load();
  const asked: any[] = [];
  fakes.sdk.getSubagentMessages = async (...a: any[]) => {
    asked.push(a);
    return a[2]?.dir === '/found' ? [{ type: 'assistant' }] : a[2] ? [] : [{ type: 'user' }];
  };
  const read = (agentId: string, dir: string | null) =>
    t.call('claude:subagentItems', 's1', agentId, { chatId: 'chat', cwd: '/w', settled: true, dir });
  assert.deepEqual(JSON.parse(String(await read(AID, '/found'))), { items: [], model: null, unread: 0 });
  assert.notEqual(await read(AID, '/moved'), null);
  assert.notEqual(await read(AID, null), null);
  assert.equal(await read('../etc', null), null);
  assert.deepEqual(asked, [
    ['s1', AID, { dir: '/found' }],
    ['s1', AID, { dir: '/moved' }],
    ['s1', AID],
    ['s1', AID],
  ]);
});

test("a task's output tail is read only from its own output file", async () => {
  const t = load();
  const dir = path.join(fs.mkdtempSync(path.join(tmp, 'out-')), 'tasks');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'b1.output'), 'line 1\nline 2\n');
  assert.equal(await t.call('claude:taskOutput', 'b1', path.join(dir, 'b1.output')), 'line 1\nline 2\n');
  await assert.rejects(t.call('claude:taskOutput', 'b2', path.join(dir, 'b1.output')), /Not a task output file/);
});

test('when the CLI ends, the tasks it still ran are reported stopped; stop-all stops only running ones', async () => {
  const t = load();
  const key = 'claude:bg-end';
  fakes.onQuery = (q: any) => {
    q.reply = () => [
      {
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [{ task_id: 'r1', task_type: 'local_bash', description: 'dev' }, { task_id: 'd1' }],
      },
      { type: 'system', subtype: 'task_notification', task_id: 'd1', status: 'completed', summary: 'done' },
      { type: 'result', subtype: 'success' },
    ];
  };
  await t.claude.send(key, { bin, sessionId: 'bg-end', ephemeral: true }, { role: 'user', content: 'go' });
  const q = lastQuery();
  const lists = () => t.events.filter((e: any) => e.key === key && e.kind === 'tasks').map((e: any) => e.tasks);
  await until('the tasks', () => lists().some((l: any[]) => l.length === 2 && l[1].status === 'completed'));
  await t.call('claude:control', key, 'stopAllTasks');
  assert.deepEqual(
    q.calls.filter((c: any[]) => c[0] === 'stopTask'),
    [['stopTask', 'r1']],
  );
  q.end();
  await until('the settled tasks', () => lists().at(-1)?.[0]?.status === 'stopped');
  assert.deepEqual(
    lists()
      .at(-1)
      .map((x: any) => [x.id, x.status, x.summary]),
    [
      ['r1', 'stopped', 'Ended when the Claude Code process exited'],
      ['d1', 'completed', 'done'],
    ],
  );
  // a process with nothing running reports nothing more when it ends
  const quiet = 'claude:bg-quiet';
  fakes.onQuery = () => {};
  await t.claude.send(quiet, { bin, sessionId: 'bg-quiet', ephemeral: true }, { role: 'user', content: 'go' });
  const n = t.events.filter((e: any) => e.key === quiet && e.kind === 'tasks').length;
  lastQuery().end();
  await until('the end', () => t.events.some((e: any) => e.key === quiet && e.kind === 'closed'));
  assert.equal(t.events.filter((e: any) => e.key === quiet && e.kind === 'tasks').length, n);
});
