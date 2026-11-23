// Claude transcript replay and live translation (core/crates/translate/src/claude). Transcripts are made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { buildTurns, ClaudeTranslator, hookNote } = await import('./support/claude-translate.ts');

const { mergeClaudeTurns, claudeModelFor, promptUuidOf, editBlocked, claudePermissionFor, claudeAnswer } = await import(
  '../src/harness/claudeTranslate.ts'
);

const { bashOutcome } = await import('./support/claude-translate.ts');

let n = 0;
const at = (msAgo = 3_600_000) => new Date(Date.now() - msAgo).toISOString();
const user = (text: string, extra: object = {}) => ({
  type: 'user',
  uuid: `u${++n}`,
  timestamp: at(),
  message: { role: 'user', content: text },
  parent_tool_use_id: null,
  ...extra,
});
const said = (text: string) => ({
  type: 'assistant',
  uuid: `a${++n}`,
  timestamp: at(),
  message: { id: `m${n}`, content: [{ type: 'text', text }] },
  parent_tool_use_id: null,
});
const tool = (id: string, name: string, input: object, ts = at()) => ({
  type: 'assistant',
  uuid: `a${++n}`,
  timestamp: ts,
  message: { id: `m${n}`, content: [{ type: 'tool_use', id, name, input }] },
  parent_tool_use_id: null,
});
const result = (id: string, content: string, extra: object = {}, ts = at()) => ({
  type: 'user',
  uuid: `r${++n}`,
  timestamp: ts,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
  parent_tool_use_id: null,
  ...extra,
});
const kinds = (t: any) => t.items.map((i: any) => i.type + (i.kind ? `/${i.kind}` : ''));

test('a prompt and its reply make one completed turn', () => {
  const turns = buildTurns([user('List the files'), said('There are two files.')], 'claude:x', '/repo');
  assert.equal(turns.length, 1);
  assert.deepEqual(kinds(turns[0]), ['userMessage', 'agentMessage']);
  assert.equal(turns[0].status, 'completed');
});

test('Bash becomes a command step with its output', () => {
  const turns = buildTurns(
    [user('Run the tests'), tool('t1', 'Bash', { command: 'npm test' }), result('t1', '3 passing'), said('All green.')],
    'claude:x',
    '/repo',
  );
  const cmd: any = turns[0].items.find((i: any) => i.type === 'commandExecution');
  assert.equal(cmd.command, 'npm test');
  assert.equal(cmd.aggregatedOutput, '3 passing');
  assert.equal(cmd.status, 'completed');
});

// Shapes seen from the real CLI in conformance C19 (2.1.295).
test('a Bash result: exit 0 is plain, a failure says "Exit code N", anything else has no exit code (D-68)', () => {
  // exit 0: structured stdout (stderr already merged in), nothing about an exit code
  assert.deepEqual(
    bashOutcome('out\nerr', false, { stdout: 'out\nerr', stderr: '', interrupted: false, isImage: false, noOutputExpected: false }),
    { output: 'out\nerr', exitCode: 0 },
  );
  // a transcript replay has no structured result: not an error is still a clean exit
  assert.deepEqual(bashOutcome('3 passing', false, undefined), { output: '3 passing', exitCode: 0 });
  // a stopped command is not known to have exited
  assert.equal(bashOutcome('partial', false, { stdout: 'partial', stderr: '', interrupted: true }).exitCode, null);
  // non-zero: the code and the output without its header; tool_use_result is a string here
  assert.deepEqual(bashOutcome('Exit code 3\nbefore-fail', true, 'Error: Exit code 3\nbefore-fail'), {
    output: 'before-fail',
    exitCode: 3,
  });
  assert.deepEqual(bashOutcome('Exit code 127', true, undefined), { output: '', exitCode: 127 });
  // a failure that states no code (timeout, tool error) is unknown, never 1
  assert.deepEqual(bashOutcome('Command timed out after 120s', true, undefined), {
    output: 'Command timed out after 120s',
    exitCode: null,
  });
});

test('a failing Bash call keeps its real exit code on the command step', () => {
  const failed = {
    ...result('t1', ''),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Exit code 2\n1 failing', is_error: true }] },
  };
  const turns = buildTurns(
    [user('Run the tests'), tool('t1', 'Bash', { command: 'npm test' }), failed, said('Fix it.')],
    'claude:x',
    '/repo',
  );
  const cmd: any = turns[0].items.find((i: any) => i.type === 'commandExecution');
  assert.equal(cmd.status, 'failed');
  assert.equal(cmd.exitCode, 2);
  assert.equal(cmd.aggregatedOutput, '1 failing');
});

test('an Edit result carries its structured patch as a unified diff', () => {
  const t = new ClaudeTranslator('claude:x', '/repo', () => {});
  const seen: any[] = [];
  const tr = new ClaudeTranslator('claude:x', '/repo', (m: string, p: any) => m === 'item/completed' && seen.push(p.item));
  tr.beginTurn('t');
  tr.onMessage(tool('e1', 'Edit', { file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' }));
  tr.onMessage({
    ...result('e1', 'ok'),
    tool_use_result: {
      filePath: '/repo/a.ts',
      structuredPatch: [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, lines: ['-a', '+b'] }],
    },
  });
  const fc = seen.find((i) => i.type === 'fileChange');
  assert.equal(fc.changes[0].diff, '@@ -3,1 +3,1 @@\n-a\n+b');
  assert.ok(t);
});

test('file tools that name their file with `path` keep it on the file change and read step', () => {
  const turns = buildTurns(
    [
      user('Write and read'),
      tool('w1', 'Write', { path: '/repo/bench.py', content: 'print(1)\n' }),
      result('w1', 'File created successfully'),
      tool('e1', 'Edit', { path: '/repo/a.ts', old_string: 'a', new_string: 'b' }),
      result('e1', 'ok'),
      tool('r1', 'Read', { path: '/repo/b.ts' }),
      result('r1', 'x'),
      tool('n1', 'NotebookEdit', { notebook_path: '/repo/n.ipynb', new_source: 'y' }),
      result('n1', 'ok'),
      tool('n2', 'NotebookEdit', { path: '/repo/m.ipynb', new_source: 'z' }),
      result('n2', 'ok'),
      tool('m1', 'MultiEdit', {}),
      result('m1', 'ok'),
    ],
    'claude:x',
    '/repo',
  );
  const items: any[] = turns[0].items;
  assert.deepEqual(
    items.filter((i) => i.type === 'fileChange').map((i) => i.changes[0].path),
    ['/repo/bench.py', '/repo/a.ts', '/repo/n.ipynb', '/repo/m.ipynb', ''],
  );
  const read = items.find((i) => i.type === 'commandExecution');
  assert.deepEqual([read.command, read.commandActions[0].path, read.commandActions[0].name], ['Read /repo/b.ts', '/repo/b.ts', 'b.ts']);
});

test('a message sent while Claude was working stays in the same turn', () => {
  const turns = buildTurns(
    [
      user('Fix the bug'),
      tool('t1', 'Bash', { command: 'ls' }),
      result('t1', 'a.ts'),
      user('also check b.ts'),
      tool('t2', 'Read', { file_path: '/repo/b.ts' }),
      result('t2', 'x'),
      said('Done.'),
      user('Thanks, next task'),
    ],
    'claude:x',
    '/repo',
  );
  assert.equal(turns.length, 2);
  assert.deepEqual(kinds(turns[0]).filter((k: string) => k === 'userMessage').length, 2);
  assert.equal(kinds(turns[1])[0], 'userMessage');
});

test("a Monitor's tick is progress, not a status: no task event and no bubble, but a wake note heading the turn it starts", () => {
  const tick = (n: number) =>
    user(
      `<task-notification>\n<task-id>mon1</task-id>\n<summary>Monitor event: "Ticks"</summary>\n<event>tick ${n}</event>\n</task-notification>`,
      { origin: { kind: 'task-notification' } },
    );
  const turns = buildTurns(
    [
      user('Watch it'),
      tool('t1', 'Monitor', { command: 'x' }),
      result('t1', 'monitoring'),
      said('Watching.'),
      tick(1),
      said('tick 1'),
      tick(2),
      said('tick 2'),
    ],
    'claude:x',
    '/repo',
  );
  const all = turns.flatMap((t: any) => t.items);
  assert.equal(all.filter((i: any) => i.type === 'statusNote' && i.kind === 'task').length, 0);
  assert.equal(all.filter((i: any) => i.type === 'userMessage' && JSON.stringify(i).includes('tick')).length, 0);
  assert.deepEqual(
    all.filter((i: any) => i.type === 'agentMessage').map((i: any) => i.text),
    ['Watching.', 'tick 1', 'tick 2'],
  );
});

test('background-task notifications are task events, never bubbles; work Claude starts after one is a turn of its own', () => {
  let id = 0;
  const note = (summary: string) =>
    user(
      `<task-notification>\n<task-id>${++id}</task-id>\n<status>completed</status>\n<summary>${summary}</summary>\n</task-notification>`,
      {
        origin: { kind: 'task-notification' },
      },
    );
  const msgs = [
    user('Start the build'),
    tool('t1', 'Bash', { command: 'make' }),
    result('t1', 'started'),
    note('Build finished'),
    said('Built.'),
    note('Tests finished'),
    said('Tests pass.'),
    note('Lint finished'),
  ];
  const turns = buildTurns(msgs, 'claude:x', '/repo');
  assert.equal(turns.length, 3);
  assert.ok(!turns.some((t) => t.items.some((i: any) => i.type === 'userMessage' && JSON.stringify(i).includes('finished'))));
  assert.deepEqual(kinds(turns[0]), ['userMessage', 'commandExecution', 'statusNote/task', 'agentMessage']);
  assert.deepEqual(kinds(turns[1]), ['statusNote/task', 'agentMessage']);
  // one Claude hasn't answered yet heads the turn its answer will have
  assert.deepEqual(kinds(turns[2]), ['statusNote/task']);
  const task = { taskId: '2', kind: 'task', title: 'Tests finished', status: 'completed', durationMs: null, toolUseId: null };
  assert.deepEqual((turns[1].items[0] as any).task, task);
  // the same transcript read again gives the same turn ids
  assert.equal(buildTurns(msgs, 'claude:x', '/repo')[1].id, turns[1].id);
});

test('an interruption ends the turn and is not shown as a message', () => {
  const turns = buildTurns(
    [
      user('Long job'),
      tool('t1', 'Bash', { command: 'sleep 100' }),
      result('t1', 'killed'),
      user('[Request interrupted by user for tool use]'),
      user('Try something else'),
    ],
    'claude:x',
    '/repo',
  );
  assert.equal(turns.length, 2);
  assert.equal(turns[0].status, 'interrupted');
  assert.ok(!JSON.stringify(turns).includes('Request interrupted'));
});

test("another app's session that is still working keeps its last turn open", () => {
  const recent = at(2_000);
  const working = buildTurns(
    [user('Go'), tool('t1', 'Bash', { command: 'make' }, recent), result('t1', '…', {}, recent)],
    'claude:x',
    '/repo',
    { liveTail: true },
  );
  assert.equal(working.at(-1)?.status, 'inProgress');
  const quiet = buildTurns([user('Go'), tool('t1', 'Bash', { command: 'make' }), result('t1', '…')], 'claude:x', '/repo', {
    liveTail: true,
  });
  assert.equal(quiet.at(-1)?.status, 'completed');
});

test('a steer is one turn even though the CLI reports two results', () => {
  const events: string[] = [];
  const tr = new ClaudeTranslator('claude:x', '/repo', (m: string) => events.push(m));
  tr.beginTurn('t1');
  tr.addSteer();
  tr.onMessage({ type: 'result', subtype: 'success', usage: {} });
  assert.ok(tr.turnId, 'still running after the first result');
  tr.onMessage({ type: 'result', subtype: 'success', usage: {} });
  assert.equal(tr.turnId, null);
  assert.equal(events.filter((e) => e === 'turn/completed').length, 1);
});

test('a prompt read back from the transcript and the same prompt streaming here are one turn, the live one', () => {
  const uuid = '0f8fad5b-d9cb-469f-a165-70867728950e';
  const read = [
    { id: 'h-older', status: 'completed', items: [] },
    { id: `h-${uuid}`, status: 'inProgress', items: [{ id: 'x' }] },
  ] as any[];
  const live = { id: `ct-${uuid}`, status: 'inProgress', items: [{ id: 'x' }, { id: 'y' }] } as any;
  assert.deepEqual(
    mergeClaudeTurns(read, [live]).map((t: any) => t.id),
    ['h-older', `ct-${uuid}`],
  );
  const pending = { ...live, id: `pending-${uuid}` };
  assert.deepEqual(
    mergeClaudeTurns(read, [pending]).map((t: any) => t.id),
    ['h-older', `pending-${uuid}`],
  );
  // a turn read back again replaces its earlier copy; one only here comes after
  const other = { id: 'ct-11111111-2222-4333-8444-555555555555', status: 'inProgress', items: [] } as any;
  const merged = mergeClaudeTurns(read, [{ ...read[0], items: [{ id: 'stale' }] }, other]);
  assert.deepEqual(
    merged.map((t: any) => t.id),
    ['h-older', `h-${uuid}`, other.id],
  );
  assert.equal(merged[0], read[0]);
});

test('an authentication failure ends the turn with its text as the error, not as a reply', () => {
  const events: [string, any][] = [];
  const tr = new ClaudeTranslator('claude:x', '/repo', (m: string, p: any) => events.push([m, p]));
  tr.beginTurn('t1');
  const msg = 'Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.';
  tr.onMessage({ ...said(msg), error: 'authentication_failed' });
  tr.onMessage({ type: 'result', subtype: 'success', is_error: true, usage: {} });
  assert.ok(!events.some(([m, p]) => m === 'item/completed' && p.item.type === 'agentMessage'));
  const done = events.find(([m]) => m === 'turn/completed')![1];
  assert.equal(done.turn.status, 'failed');
  assert.equal(done.turn.error.message, msg);
});

test("a chat's wire model id maps back to the picker's alias", () => {
  const m = (id: string, resolved: string, more = false) => ({ id, label: id, efforts: [], defaultEffort: null, resolved, more }) as any;
  const models = [m('opus', 'claude-opus-5-5'), m('sonnet', 'claude-sonnet-5-5'), m('claude-opus-5-1', 'claude-opus-5-1', true)];
  assert.equal(claudeModelFor('claude-opus-5-5', models), 'opus');
  assert.equal(claudeModelFor('claude-opus-5-1', models), 'claude-opus-5-1');
  assert.equal(claudeModelFor('claude-sonnet-4-9', models), 'sonnet');
});

test('ExitPlanMode is one plan card with its file, filled from the result when the input had no plan', () => {
  const replay = buildTurns(
    [
      user('Plan it'),
      tool('p1', 'ExitPlanMode', { plan: '1. Write hello.txt', planFilePath: '/home/u/.claude/plans/x.md' }),
      result('p1', 'User has approved your plan.'),
    ],
    'claude:x',
    '/repo',
  );
  // Sage's plan items carry planFilePath on top of the protocol's plan item
  const plans: any[] = replay[0].items.filter((i: any) => i.type === 'plan');
  assert.equal(plans.length, 1);
  assert.equal(plans[0].text, '1. Write hello.txt');
  assert.equal(plans[0].planFilePath, '/home/u/.claude/plans/x.md');

  const items: any[] = [];
  const tr = new ClaudeTranslator('claude:y', '/repo', (method: string, p: any) => method.startsWith('item/') && items.push(p.item));
  tr.beginTurn('t1');
  tr.onMessage(tool('p2', 'ExitPlanMode', {}));
  tr.onMessage(result('p2', 'approved', { tool_use_result: { plan: '1. From the file', isAgent: false, filePath: '/plans/y.md' } }));
  const done = items.filter((i) => i.type === 'plan').at(-1);
  assert.equal(done.text, '1. From the file');
  assert.equal(done.planFilePath, '/plans/y.md');
});

test("a sub-agent's steps and its progress summary show on its Agent card", () => {
  const items: any[] = [];
  const tr = new ClaudeTranslator('claude:z', '/repo', (method: string, p: any) => method.startsWith('item/') && items.push(p.item));
  tr.beginTurn('t1');
  tr.onMessage(tool('ag1', 'Agent', { description: 'Explore the repo', prompt: 'look around' }));
  const sub = (content: any[]) => ({ type: 'assistant', uuid: `s${++n}`, message: { id: `sm${n}`, content }, parent_tool_use_id: 'ag1' });
  tr.onMessage(sub([{ type: 'text', text: 'Looking at the layout first.\nMore detail.' }]));
  tr.onMessage(sub([{ type: 'tool_use', id: 'x1', name: 'Read', input: { file_path: '/repo/src/a.ts' } }]));
  tr.onMessage(sub([{ type: 'tool_use', id: 'x2', name: 'Bash', input: { command: 'npm test' } }]));
  tr.onMessage({
    type: 'system',
    subtype: 'task_progress',
    task_id: 'k1',
    tool_use_id: 'ag1',
    description: 'Explore the repo',
    usage: {},
    summary: 'Reading the tests',
  });
  const card = items.filter((i) => i.id === 'ag1').at(-1);
  assert.deepEqual(card.activity, ['Looking at the layout first.', 'Read /repo/src/a.ts', 'Bash npm test']);
  assert.equal(card.summary, 'Reading the tests');
  assert.equal(card.taskId, 'k1');
  // sub-agent messages never become the main thread's replies
  assert.equal(items.filter((i) => i.type === 'agentMessage').length, 0);
});

test('edit is greyed for messages without a checkpoint and for the first message', () => {
  const id = '0b5d2c1e-1111-4222-8333-444455556666';
  assert.equal(promptUuidOf(`ct-${id}`), id);
  assert.equal(promptUuidOf(`h-${id}`), id);
  assert.equal(promptUuidOf('auto-x'), null);
  assert.equal(editBlocked(`h-${id}`, undefined), null);
  assert.equal(editBlocked(`h-${id}`, {}), 'Created before checkpoints · Fork from here instead');
  assert.match(editBlocked(`h-${id}`, { [id]: null })!, /first message/);
  assert.equal(editBlocked(`ct-${id}`, { [id]: 'a1' }), null);
});

test('Approve for me falls back to asking on a model without auto mode', () => {
  const m = (autoMode?: boolean) => ({ id: 'x', label: 'x', efforts: [], defaultEffort: null, fast: false, autoMode }) as any;
  assert.equal(claudePermissionFor('auto-review', m(false)), 'default');
  assert.equal(claudePermissionFor('auto-review', m(true)), 'auto-review');
  assert.equal(claudePermissionFor('auto-review', undefined), 'auto-review');
  assert.equal(claudePermissionFor('full-access', m(false)), 'full-access');
});

test('answers: multiSelect takes every pick, a denial carries the note, elicitations answer as the SDK wants', () => {
  const input = { questions: [{ question: 'Which files?', multiSelect: true, options: [{ label: 'a' }, { label: 'b' }] }] };
  assert.deepEqual(
    claudeAnswer('item/tool/requestUserInput', input, { answers: { '0': { answers: ['a', 'b'] } } })?.updatedInput?.answers,
    {
      'Which files?': 'a, b',
    },
  );
  assert.equal(claudeAnswer('item/tool/requestUserInput', input, { answers: {} }).behavior, 'deny');
  assert.deepEqual(claudeAnswer('claude/toolApproval', {}, { decision: 'decline', reason: 'use the staging db' }), {
    behavior: 'deny',
    message: 'The user declined this action: use the staging db',
  });
  assert.deepEqual(claudeAnswer('claude/toolApproval', {}, { decision: 'decline' }), {
    behavior: 'deny',
    message: 'The user declined this action.',
  });
  assert.equal(claudeAnswer('claude/toolApproval', {}, { decision: 'cancel', reason: 'stop' }).interrupt, true);
  assert.deepEqual(
    claudeAnswer('claude/toolApproval', { x: 1 }, { decision: 'acceptForSession' }, [{ type: 'addRules' }]).updatedPermissions,
    [{ type: 'addRules' }],
  );
  assert.deepEqual(claudeAnswer('mcpServer/elicitation/request', null, { action: 'accept', content: { name: 'x' } }), {
    action: 'accept',
    content: { name: 'x' },
  });
  assert.deepEqual(claudeAnswer('mcpServer/elicitation/request', null, { action: 'decline', content: null }), { action: 'decline' });
  // the answer's _meta (a grant's scope) goes back as given, with or without content
  assert.deepEqual(
    claudeAnswer('mcpServer/elicitation/request', null, { action: 'accept', content: { ok: true }, _meta: { scope: 'session' } }),
    { action: 'accept', content: { ok: true }, _meta: { scope: 'session' } },
  );
  assert.deepEqual(claudeAnswer('mcpServer/elicitation/request', null, { action: 'decline', _meta: { scope: 'once' } }), {
    action: 'decline',
    _meta: { scope: 'once' },
  });
});

test('hook telemetry stays hidden while native notices show their original message', () => {
  assert.equal(hookNote({ subtype: 'hook_response', hook_event: 'PostToolUse', hook_name: 'fmt', outcome: 'success', output: '' }), null);
  assert.equal(
    hookNote({
      subtype: 'hook_response',
      hook_event: 'PostToolUse',
      hook_name: 'fmt',
      outcome: 'success',
      output: 'formatted 2 files\nmore',
    }),
    null,
  );
  assert.equal(
    hookNote({ subtype: 'hook_response', hook_event: 'Stop', hook_name: 'lint', outcome: 'error', exit_code: 2, stderr: 'lint failed' }),
    null,
  );
  const items: any[] = [];
  const tr = new ClaudeTranslator('claude:h', '/repo', (method: string, p: any) => method.startsWith('item/') && items.push(p.item));
  tr.beginTurn('t1');
  tr.onMessage({
    type: 'system',
    subtype: 'hook_response',
    hook_id: 'h1',
    hook_event: 'Stop',
    hook_name: 'lint',
    outcome: 'error',
    exit_code: 1,
    output: '',
    stderr: 'x',
    uuid: 'hk1',
  });
  assert.deepEqual(items, []);
  tr.onMessage({ type: 'system', subtype: 'informational', level: 'warning', content: 'lint failed', uuid: 'notice' });
  assert.deepEqual(items, [{ type: 'hookPrompt', id: 'notice', fragments: [{ text: 'lint failed' }] }]);
});

test('/code-review: its forked task opens the review and its findings fill the review card', () => {
  const items: any[] = [];
  const tr = new ClaudeTranslator('claude:r', '/repo', (method: string, p: any) => method.startsWith('item/') && items.push(p.item));
  tr.beginTurn('t1', { id: 'u1', clientId: null, content: [{ type: 'text', text: '/code-review low', text_elements: [] }] });
  tr.onMessage({
    type: 'system',
    subtype: 'task_started',
    task_id: 'k1',
    description: '/code-review',
    task_type: 'local_agent',
    is_backgrounded: false,
  });
  tr.onMessage({
    type: 'assistant',
    uuid: 'f1',
    parent_tool_use_id: 'forked-command-code-review',
    message: { id: 'x', content: [{ type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'show the changes' } }] },
  });
  tr.onMessage({
    type: 'assistant',
    uuid: 's1',
    parent_tool_use_id: null,
    message: { id: 's1', model: '<synthetic>', content: [{ type: 'text', text: '- calc.js:1 — div multiplies' }] },
  });
  assert.deepEqual(
    items.map((i) => i.type),
    ['userMessage', 'enteredReviewMode', 'exitedReviewMode'],
  );
  assert.equal(items[2].review, '- calc.js:1 — div multiplies');
  // a synthetic message in an ordinary turn is not a review
  const other: any[] = [];
  const t2 = new ClaudeTranslator('claude:r2', '/repo', (method: string, p: any) => method.startsWith('item/') && other.push(p.item));
  t2.beginTurn('t2', { id: 'u2', clientId: null, content: [{ type: 'text', text: 'hello', text_elements: [] }] });
  t2.onMessage({
    type: 'assistant',
    uuid: 's2',
    message: { id: 's2', model: '<synthetic>', content: [{ type: 'text', text: 'API Error' }] },
  });
  assert.deepEqual(
    other.map((i) => i.type),
    ['userMessage', 'agentMessage'],
  );
});

test('/code-review with ReportFindings: the typed findings are the review card, live and in a replayed transcript', () => {
  // the stream of a real `/code-review low` (Claude Code 2.1.295, CLAUDE_CODE_REPORT_FINDINGS=1), trimmed
  const input = {
    level: 'low',
    findings: [
      {
        file: 'calc.js',
        line: 2,
        summary: 'div now multiplies instead of dividing.',
        short_summary: 'div uses * instead of /',
        failure_scenario: 'div(6, 3) returns 18 instead of 2.',
        category: 'correctness',
      },
      { file: '', summary: 'dropped: no file' },
    ],
  };
  const transcript = [
    user('/code-review low'),
    tool('g', 'Bash', { command: 'git diff HEAD' }),
    result('g', 'diff --git a/calc.js b/calc.js'),
    tool('rf', 'ReportFindings', input),
    result('rf', '1 finding reported.'),
    said('I found one bug in `calc.js`.'),
  ];
  const card = {
    type: 'exitedReviewMode',
    id: 'rf',
    review: '- `calc.js:2` (correctness): div now multiplies instead of dividing.\n  div(6, 3) returns 18 instead of 2.',
    level: 'low',
    findings: [
      {
        file: 'calc.js',
        line: 2,
        summary: 'div now multiplies instead of dividing.',
        shortSummary: 'div uses * instead of /',
        failureScenario: 'div(6, 3) returns 18 instead of 2.',
        category: 'correctness',
      },
    ],
  };
  const items: any[] = [];
  const tr = new ClaudeTranslator('claude:rf', '/repo', (method: string, p: any) => method === 'item/completed' && items.push(p.item));
  tr.beginTurn('t1', { id: 'u1', clientId: null, content: [{ type: 'text', text: '/code-review low', text_elements: [] }] });
  for (const m of transcript.slice(1)) tr.onMessage(m);
  // the call is the card, not a tool row, and its result adds nothing
  assert.deepEqual(
    items.map((i) => i.type),
    ['userMessage', 'commandExecution', 'exitedReviewMode', 'agentMessage'],
  );
  assert.deepEqual(items[2], card);
  const replayed = buildTurns(transcript as any, 'claude:rf', '/repo');
  assert.deepEqual(
    replayed[0].items.find((i: any) => i.type === 'exitedReviewMode'),
    card,
  );
});

test('a ReportFindings call the CLI rejects shows no card; its retry does, and a call left without a result none', () => {
  const finding = { file: 'calc.js', line: 2, summary: 'div multiplies.', failure_scenario: '-' };
  const rejected = {
    type: 'user',
    uuid: 'rj',
    timestamp: at(),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'bad', content: 'InputValidationError', is_error: true }] },
    parent_tool_use_id: null,
  };
  const turns = buildTurns(
    [
      user('/code-review'),
      tool('bad', 'ReportFindings', { findings: [finding, finding] }),
      rejected,
      tool('ok', 'ReportFindings', { findings: [finding] }),
      result('ok', '1 finding reported.'),
      tool('late', 'ReportFindings', { findings: [finding] }),
    ] as any,
    'claude:rj',
    '/repo',
  );
  assert.deepEqual(
    turns[0].items.filter((i: any) => i.type === 'exitedReviewMode').map((i: any) => i.id),
    ['ok'],
  );
  // no tool row for the calls either
  assert.equal(turns[0].items.filter((i: any) => i.type !== 'userMessage' && i.type !== 'exitedReviewMode').length, 0);
});

test('ReportFindings again with outcomes after a fix is a card of its own in the fix turn', () => {
  const finding = { file: 'calc.js', line: 2, summary: 'div multiplies.', failure_scenario: 'div(6, 3) is 18.' };
  const transcript = [
    user('/code-review'),
    tool('r1', 'ReportFindings', { level: 'high', findings: [finding] }),
    result('r1', '1 finding reported.'),
    said('One bug.'),
    user('Apply this code-review finding with the minimal edit.'),
    tool('r2', 'ReportFindings', { findings: [{ ...finding, outcome: 'fixed' }] }),
    result('r2', '1 finding reported.'),
  ];
  const turns = buildTurns(transcript as any, 'claude:rf2', '/repo');
  const cards = turns.map((t: any) =>
    t.items.filter((i: any) => i.type === 'exitedReviewMode').map((i: any) => [i.id, i.findings[0].outcome ?? null]),
  );
  // the review keeps its findings as reported; its card reads the outcomes from the later one
  assert.deepEqual(cards, [[['r1', null]], [['r2', 'fixed']]]);
});

test('a Bash command sent to the background is marked so its row can follow the task', () => {
  const sent = 'Command running in background with ID: b1. Output is being written to: /tmp/tasks/b1.output';
  const turns = buildTurns(
    [
      user('Watch the build'),
      tool('t1', 'Bash', { command: 'sleep 90; echo bg', run_in_background: true }),
      result('t1', sent, { toolUseResult: { stdout: '', stderr: '', backgroundTaskId: 'b1' } }),
      tool('t2', 'Bash', { command: 'ls' }),
      result('t2', 'a\nb'),
      tool('t3', 'Bash', { command: 'sleep 90' }),
      {
        ...result('t3', ''),
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't3', content: sent, is_error: true }] },
      },
    ],
    'claude:x',
    '/repo',
  );
  const cmds: any[] = turns[0].items.filter((i: any) => i.type === 'commandExecution');
  assert.deepEqual(
    cmds.map((c) => c.background === true),
    [true, false, false],
  );
  // an ordinary command carries no flag at all, so stored turns keep their shape
  assert.ok(!('background' in cmds[1]));
});

test('history keeps valid prompt and reply blocks beside malformed entries', () => {
  const turns = buildTurns(
    [
      user('', { message: { content: [null, { type: 'text', text: 42 }, { type: 'text', text: 'Keep this prompt' }] } }),
      { ...said(''), message: { content: [null, { type: 'text', text: {} }, { type: 'text', text: 'Keep this reply' }] } },
    ],
    'claude:x',
    '/repo',
  );
  assert.deepEqual(kinds(turns[0]), ['userMessage', 'agentMessage']);
  assert.deepEqual(turns[0].items[0], {
    type: 'userMessage',
    id: turns[0].items[0].id,
    clientId: null,
    content: [{ type: 'text', text: 'Keep this prompt', text_elements: [] }],
  });
  assert.equal((turns[0].items[1] as { text: string }).text, 'Keep this reply');
});
