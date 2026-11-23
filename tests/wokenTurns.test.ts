// Turns no one typed: what woke each (a monitor's event, a scheduled check-in, a background task, linked sessions), and
// runs of quiet ones folded into one row of the thread on every harness (src/lib/wokenTurns.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entrySlots, foldWokenTurns, MAX_QUIET_CHARS, quietTurn, turnWake, wokenSummary } from '../src/lib/wokenTurns.ts';

const monitorNote = (id: string, extra: any = {}) => ({
  type: 'statusNote',
  id,
  kind: 'wake',
  text: 'Monitor event · CI run',
  wake: { by: 'monitor', key: 'mon1', label: 'CI run', detail: 'unit: success', failed: false, ...extra },
});
const checkin = (id: string) => ({
  type: 'statusNote',
  id,
  kind: 'wake',
  text: 'Scheduled check-in',
  wake: { by: 'checkin', key: 'checkin', label: 'Check PR', detail: null, failed: false },
});
const taskNote = (id: string, status = 'completed') => ({
  type: 'statusNote',
  id,
  kind: 'task',
  text: 'Background command completed',
  task: { taskId: id, kind: 'shell', title: 'npm test', status, durationMs: 1 },
});
const reply = (id: string, text = 'Still waiting.') => ({ type: 'agentMessage', id, text });
const user = (id: string, text = 'Go', clientId: string | null = null) => ({
  type: 'userMessage',
  id,
  clientId,
  content: [{ type: 'text', text }],
});
const turn = (id: string, items: any[], extra: any = {}) =>
  ({ id, status: 'completed', items, startedAt: 100, completedAt: 160, durationMs: 60_000, error: null, itemTimes: {}, ...extra }) as any;
const woken = (id: string, extra: any = {}, head: any = monitorNote(`n-${id}`)) => turn(id, [head, reply(`r-${id}`)], extra);
const none = () => null;
const shape = (entries: any[]) => entries.map((e) => (e.kind === 'turn' ? e.turn.id : `fold(${e.turns.map((t: any) => t.id).join(',')})`));

test('what woke a turn: a wake note, a background task card, or a wake-up main delivered; never a person or a peer', () => {
  assert.deepEqual(turnWake(woken('a'), none), { key: 'monitor:mon1', label: 'Monitor · CI run', failed: false });
  assert.deepEqual(turnWake(turn('b', [checkin('c'), reply('r')]), none), {
    key: 'checkin:checkin',
    label: 'Scheduled check-ins',
    failed: false,
  });
  assert.deepEqual(turnWake(turn('c', [taskNote('t', 'failed'), reply('r')]), none), {
    key: 'tasks',
    label: 'Background tasks',
    failed: true,
  });
  // the first head names it; a later note in the same turn does not
  assert.equal(turnWake(turn('d', [monitorNote('m'), taskNote('t')]), none)!.key, 'monitor:mon1');
  // linked sessions reporting (any harness): a wake-up main delivered
  const deliveries: any = { w1: { kind: 'wake', chatId: 'x', at: 1, notes: [] }, b1: { kind: 'brief' } };
  const deliveryOf = (item: any) => deliveries[item.clientId] ?? null;
  assert.deepEqual(turnWake(turn('e', [user('u', 'wake', 'w1'), reply('r')]), deliveryOf), {
    key: 'sessions',
    label: 'Linked sessions',
    failed: false,
  });
  // a person's words, a brief, another session's message, or nothing at all: not a wake
  assert.equal(turnWake(turn('f', [user('u'), monitorNote('m')]), deliveryOf), null);
  assert.equal(turnWake(turn('g', [user('u', 'brief', 'b1')]), deliveryOf), null);
  assert.equal(turnWake(turn('h', [{ type: 'statusNote', id: 'p', kind: 'peer', text: 'Message' }, reply('r')]), none), null);
  assert.equal(turnWake(turn('i', [reply('r')]), none), null);
  // a note that carries no wake or task is not one either
  assert.equal(
    turnWake(
      turn('j', [
        { type: 'statusNote', id: 'k', kind: 'wake', text: 'x' },
        { type: 'statusNote', id: 'l', kind: 'task', text: 'y' },
      ]),
      none,
    ),
    null,
  );
});

test('a quiet turn ended well and only said where things stand', () => {
  assert.equal(quietTurn(woken('a')), true);
  assert.equal(
    quietTurn(turn('b', [monitorNote('m'), { type: 'commandExecution', id: 'c', command: 'gh run view', status: 'completed' }])),
    true,
  );
  // not quiet: still running, failed, stopped, an error, a long or fenced reply, an edit, a plan, a compaction, a question
  for (const t of [
    woken('c', { status: 'inProgress' }),
    woken('d', { status: 'failed' }),
    woken('e', { status: 'interrupted' }),
    woken('f', { error: { message: 'boom' } }),
    turn('g', [monitorNote('m'), reply('r', 'x'.repeat(MAX_QUIET_CHARS + 1))]),
    turn('h', [monitorNote('m'), reply('r', 'Log:\n```\nfail\n```')]),
    turn('i', [monitorNote('m'), { type: 'fileChange', id: 'f', changes: [], status: 'completed' }]),
    turn('j', [monitorNote('m'), { type: 'plan', id: 'p', text: 'plan' }]),
    turn('k', [monitorNote('m'), { type: 'contextCompaction', id: 'cc' }]),
    turn('l', [monitorNote('m'), { ...reply('q', 'Which one?'), questions: [{ title: 'Which?' }] }]),
  ])
    assert.equal(quietTurn(t), false, t.id);
  // a reply with no text yet is quiet; a session proposed or a page published is not
  assert.equal(quietTurn(turn('m', [monitorNote('m'), { type: 'agentMessage', id: 'r' }])), true);
  const proposal = {
    id: 's2',
    type: 'mcpToolCall',
    server: 'sage_ab',
    tool: 'start_session',
    arguments: { title: 'Docs', prompt: 'p', initiation: 'offer' },
    status: 'completed',
    result: { content: [{ type: 'text', text: JSON.stringify({ status: 'proposed', task_id: 'task_a', kind: 'offer', title: 'Docs' }) }] },
  };
  assert.equal(quietTurn(turn('n', [monitorNote('m'), proposal])), false);
  const page = {
    id: 'a1',
    type: 'mcpToolCall',
    server: '',
    tool: 'Artifact',
    arguments: { file_path: '/w/landing.html', title: 'Landing page' },
    status: 'completed',
    result: {
      content: [
        {
          type: 'text',
          text: 'Created a new Artifact at https://claude.ai/code/artifact/0a21f3e3-1b2c-4d5e-8f90-123456789abc (version 1) from Design.',
        },
      ],
    },
    error: null,
  };
  assert.equal(quietTurn(turn('o', [monitorNote('m'), page])), false);
});

test('a run of quiet woken turns folds; its last stays open as the latest word, unless a woken turn follows it', () => {
  const o = { liveId: null, deliveryOf: none };
  const human = turn('h', [user('u'), reply('r', 'Watching CI.')]);
  // ends the thread: the last of the run is the latest word
  assert.deepEqual(shape(foldWokenTurns([human, woken('a'), woken('b'), woken('c')], o)), ['h', 'fold(a,b)', 'c']);
  // a woken turn that says more (a failure it reads into) follows: it is the latest word, and the whole run folds
  const loud = turn('d', [monitorNote('n-d', { failed: true }), reply('r-d', 'x'.repeat(MAX_QUIET_CHARS + 1))]);
  assert.deepEqual(shape(foldWokenTurns([human, woken('a'), woken('b'), loud], o)), ['h', 'fold(a,b)', 'd']);
  // the person speaks again: the run before it keeps its last turn
  assert.deepEqual(shape(foldWokenTurns([woken('a'), woken('b'), woken('c'), human], o)), ['fold(a,b)', 'c', 'h']);
  // too short to fold: one turn to fold saves nothing
  assert.deepEqual(shape(foldWokenTurns([human, woken('a'), woken('b')], o)), ['h', 'a', 'b']);
  assert.deepEqual(shape(foldWokenTurns([woken('a'), loud], o)), ['a', 'd']);
  // the running turn never folds, and stands as the latest word
  assert.deepEqual(shape(foldWokenTurns([woken('a'), woken('b'), woken('c', { status: 'inProgress' })], { ...o, liveId: 'c' })), [
    'fold(a,b)',
    'c',
  ]);
  assert.deepEqual(shape(foldWokenTurns([], o)), []);
});

test('each turn shows in its own slot or its run’s first; the row names the watch, how often it woke, over how long', () => {
  const entries = foldWokenTurns([woken('a', { startedAt: 100 }), woken('b'), woken('c', { completedAt: 820 }), woken('d')], {
    liveId: null,
    deliveryOf: none,
  });
  assert.deepEqual(
    [...entrySlots(entries)],
    [
      ['a', 'a'],
      ['b', 'a'],
      ['c', 'a'],
      ['d', 'd'],
    ],
  );
  assert.deepEqual(wokenSummary(entries[0] as any), { label: 'Monitor · CI run', text: 'Woke 3 times over 12m', failed: 0 });
  // mixed watches, failures counted, no times known
  const mixed: any = {
    kind: 'woken',
    turns: [woken('a', { startedAt: null }), woken('b', { completedAt: null, startedAt: null })],
    wakes: [
      { key: 'monitor:m', label: 'Monitor · CI', failed: true },
      { key: 'tasks', label: 'Background tasks', failed: false },
    ],
  };
  assert.deepEqual(wokenSummary(mixed), { label: 'Background events', text: 'Woke 2 times', failed: 1 });
  // a run whose last turn has no end yet reads its start
  const open: any = { ...mixed, turns: [woken('a', { startedAt: 0 }), woken('b', { completedAt: null, startedAt: 90 })] };
  assert.equal(wokenSummary(open).text, 'Woke 2 times over 1m 30s');
});

test('a note of its own (a harness switch, a usage limit) keeps a woken turn from folding; another wake or task card does not', () => {
  const note = (kind: string) => ({ type: 'statusNote', id: `n-${kind}`, kind, text: kind });
  assert.equal(quietTurn(turn('a', [monitorNote('m'), note('limit'), reply('r')])), false);
  assert.equal(quietTurn(turn('b', [monitorNote('m'), note('switch')])), false);
  const quiet = turn('c', [monitorNote('m'), taskNote('t'), monitorNote('m2'), reply('r')]);
  assert.equal(quietTurn(quiet), true);
  // asked again for the same turn: the same answer
  assert.equal(quietTurn(quiet), true);
});
