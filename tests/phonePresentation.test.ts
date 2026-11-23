// Phone thread snapshots and events preserve the service's item and row shapes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { displayRows, keyedRows, progress, row, snapshot, update } from '../mobile/src/presentation/thread';

test('normalizes history rows and shared items produced by each harness', () => {
  assert.deepEqual(row({ role: 'assistant', text: 'History' }, 'rows'), { role: 'assistant', text: 'History' });
  assert.deepEqual(row({ type: 'userMessage', content: [{ type: 'text', text: 'Hello' }, { type: 'image' }] }, 'items'), {
    role: 'user',
    text: 'Hello',
  });
  assert.deepEqual(row({ type: 'agentMessage', text: 'Reply' }, 'items'), { role: 'assistant', text: 'Reply' });
  assert.deepEqual(row({ type: 'commandExecution', command: 'ls' }, 'items'), { role: 'step', text: 'ls', kind: 'run', ms: null });
});
test('applies item replacements, streamed text and versioned session patches', () => {
  let t = snapshot({
    rev: 1,
    session: { cards: [] },
    itemsShape: 'items',
    feedSeq: 0,
    items: [{ id: 'a', type: 'agentMessage', text: 'Hi' }],
  });
  t = update(t, { feedSeq: 1, ev: 'items.delta', itemId: 'a', field: 'text', text: ' there' });
  assert.equal(t.items[0].text, 'Hi there');
  t = update(t, { feedSeq: 2, ev: 'items.replace', items: [{ id: 'a', text: 'Complete' }] });
  assert.equal(t.items[0].text, 'Complete');
  t = update(t, { feedSeq: 3, ev: 'items.append', items: [{ id: 'b', text: 'Next' }] });
  assert.equal(t.items.length, 2);
  t = update(t, { ev: 'session.patch', rev: 2, patch: { cards: [{ id: 4 }] } });
  assert.equal((t.session.cards as { id: number }[])[0].id, 4);
  assert.equal(update(t, { ev: 'session.patch', rev: 1, patch: { cards: [] } }), t);
});
test('rejects invalid snapshots and handles unrelated or malformed events', () => {
  assert.throws(() => snapshot({ items: [] }));
  const t = snapshot({ rev: 0, session: {}, items: [{ id: 'a', summary: ['one'] }], itemsShape: 'items', feedSeq: 0 });
  assert.equal(update(t, { ev: 'other' }), t);
  assert.equal(update(t, { ev: 'session.patch' }), t);
  assert.equal(update(t, { feedSeq: 4, ev: 'turn.state', status: 'running' }).session.turnStatus, 'running');
  assert.deepEqual(update(t, { feedSeq: 5, ev: 'items.append' }).items, t.items);
  assert.deepEqual(update(t, { feedSeq: 6, ev: 'items.delta', itemId: 'a', field: 'summary', index: 0, text: ' two' }).items[0].summary, [
    'one two',
  ]);
  assert.equal(update(t, { feedSeq: 7, ev: 'items.delta', itemId: 'a', field: 'other', text: 'x' }).items[0], t.items[0]);
  assert.equal(update(t, { feedSeq: 8, ev: 'items.delta', itemId: 'b', field: 'text', text: 'x' }).items[0], t.items[0]);
});

test('handles optional content and bounds on streamed fields', () => {
  for (const value of [null, {}, { items: [], session: null }, { items: [], session: {}, rev: '1' }]) assert.throws(() => snapshot(value));
  const t = snapshot({ rev: 0, session: {}, items: [{ id: 'a' }], itemsShape: 'items', feedSeq: 0 });
  assert.equal(update(t, { feedSeq: 9, ev: 'items.delta', itemId: 'a', field: 'text', text: 'x' }).items[0].text, 'x');
  assert.equal(
    (update(t, { feedSeq: 10, ev: 'items.delta', itemId: 'a', field: 'summary', index: 1, text: 'x' }).items[0].summary as string[])[1],
    'x',
  );
  for (const index of [-1, 1000, 0.5])
    assert.equal(update(t, { feedSeq: 11, ev: 'items.delta', itemId: 'a', field: 'summary', index, text: 'x' }).items[0], t.items[0]);
  assert.equal(update(t, { feedSeq: 12, ev: 'items.delta', itemId: 'a', field: 'text', text: 4 }).items[0], t.items[0]);
  assert.deepEqual(row({}, 'rows'), { role: 'step', text: '', kind: 'other', ms: null });
  assert.equal(row({ type: 'userMessage' }, 'items').text, '');
  assert.equal(row({ type: 'agentMessage' }, 'items').text, '');
  assert.equal(row({ text: 'activity' }, 'items').text, 'activity');
  assert.equal(row({ summary: ['one', 'two'] }, 'items').text, 'one\ntwo');
  assert.equal(row({ description: 'activity' }, 'items').text, 'activity');
  assert.equal(row({ type: 'tool' }, 'items').text, 'tool');
  assert.equal(row({}, 'items').text, 'Activity');
  assert.equal(row({ command: ['ls'] }, 'items').text, '["ls"]');
});

test('snapshot watermark rejects duplicated buffered updates while session revisions stay independent', () => {
  const t = snapshot({ rev: 2, feedSeq: 5, session: {}, itemsShape: 'items', items: [{ id: 'a', text: 'already here' }] });
  assert.equal(update(t, { ev: 'items.delta', feedSeq: 5, itemId: 'a', field: 'text', text: 'already here' }), t);
  assert.equal(update(t, { ev: 'items.delta', feedSeq: 4, itemId: 'a', field: 'text', text: 'old' }), t);
  assert.equal(update(t, { ev: 'items.delta', feedSeq: 6, itemId: 'a', field: 'text', text: '!' }).items[0].text, 'already here!');
  assert.equal(update(t, { ev: 'session.patch', rev: 3, patch: { cards: [] } }).rev, 3);
  assert.throws(() => update(t, { ev: 'items.delta', itemId: 'a', text: 'x' }), /newer MoPilot/);
  const old = snapshot({ rev: 0, session: {}, items: [] });
  assert.throws(() => update(old, { ev: 'items.append', feedSeq: 1, items: [] }), /newer MoPilot/);
});

test('history remains visible with live items and reconciles replies at the snapshot watermark', () => {
  const history = Array.from({ length: 100 }, (_, i) => ({ role: 'user', text: `Old ${i}` }));
  history.push({ role: 'assistant', text: 'A streaming reply' });
  let t = snapshot({
    rev: 1,
    feedSeq: 3,
    session: {},
    itemsShape: 'items',
    history,
    items: [{ id: 'a', type: 'agentMessage', text: 'A streaming reply continues' }],
  });
  t = update(t, { ev: 'items.delta', feedSeq: 3, itemId: 'a', field: 'text', text: 'duplicate' });
  const rows = displayRows(t);
  assert.equal(rows[0].text, 'Old 0');
  assert.equal(rows[99].text, 'Old 99');
  assert.equal(rows.at(-1)?.text, 'continues');
  assert.equal(rows.at(-1)?.role, 'preview');
  const fallback = snapshot({ rev: 1, feedSeq: 0, session: {}, itemsShape: 'rows', items: history });
  assert.equal(displayRows(fallback).length, 101);
  const next = update(fallback, { ev: 'items.append', feedSeq: 1, items: [{ id: 'b', type: 'agentMessage', text: 'new reply' }] });
  assert.equal(displayRows(next)[0].text, 'Old 0');
  assert.equal(displayRows(next).at(-1)?.text, 'new reply');
});

test('live activity with a matching stable id is omitted and unknown identities remain visible', () => {
  const t = snapshot({
    rev: 0,
    feedSeq: 0,
    session: {},
    itemsShape: 'items',
    history: [
      { id: 'known', role: 'step', text: 'Ran test' },
      { role: 'step', text: 'Same' },
    ],
    items: [
      { id: 'known', type: 'commandExecution', command: 'Ran test' },
      { id: 'unknown', type: 'commandExecution', command: 'Same' },
    ],
  });
  const rows = displayRows(t);
  assert.equal(rows.length, 3);
  // a live step carries the call it stands for, so its picture can be read from the Mac
  assert.deepEqual(rows.at(-1), { role: 'live', text: 'Same', kind: 'run', ms: null, callId: 'unknown' });
  const empty = snapshot({
    rev: 0,
    feedSeq: 0,
    session: {},
    itemsShape: 'items',
    history: [],
    items: [{ id: 'x', type: 'commandExecution' }],
  });
  assert.equal(displayRows(empty)[0].text, 'commandExecution');
});

test('new turn retires its prior preview while preserving the completed conversation', () => {
  let t = snapshot({
    rev: 1,
    feedSeq: 1,
    session: {},
    itemsShape: 'items',
    history: [{ role: 'user', text: 'First question' }],
    liveTurn: { id: 'one', status: 'inProgress' },
    items: [{ id: 'a', type: 'agentMessage', text: 'First reply' }],
  });
  t = update(t, { ev: 'turn.state', feedSeq: 2, turnId: 'one', status: 'inProgress' });
  assert.equal(t.items.length, 1);
  t = update(t, { ev: 'turn.state', feedSeq: 3, turnId: 'two', status: 'inProgress' });
  assert.equal(t.items.length, 0);
  assert.equal(t.history.at(-1)?.text, 'First reply');
  t = update(t, {
    ev: 'items.append',
    feedSeq: 4,
    items: [
      { id: 'u', type: 'userMessage', content: [{ type: 'text', text: 'Second question' }] },
      { id: 'b', type: 'agentMessage', text: 'Second reply' },
    ],
  });
  assert.deepEqual(
    displayRows(t).map((r) => [r.role, r.text]),
    [
      ['user', 'First question'],
      ['assistant', 'First reply'],
      ['liveUser', 'Second question'],
      ['preview', 'Second reply'],
    ],
  );
});

test('working state recognizes native inProgress and waiting states', () => {
  assert.equal(progress('inProgress'), 'Working…');
  assert.equal(progress('running'), 'Working…');
  assert.equal(progress('awaitingUser'), 'Waiting for you');
  assert.equal(progress('completed'), '');
});

test('turn rotation retains unsaved live user and activity as history', () => {
  const t = snapshot({
    rev: 0,
    feedSeq: 0,
    session: {},
    itemsShape: 'items',
    history: [],
    items: [
      { id: 'u', type: 'userMessage', content: [{ type: 'text', text: 'question' }] },
      { id: 's', type: 'commandExecution', command: 'test' },
    ],
  });
  const next = update(t, { ev: 'turn.state', feedSeq: 1, turnId: 'new', status: 'running' });
  assert.deepEqual(
    next.history.map((r) => r.role),
    ['user', 'step'],
  );
});

test('snapshot and later session patches show the authoritative turn status', () => {
  let t = snapshot({ rev: 1, feedSeq: 0, session: { turn: 'running' }, itemsShape: 'rows', items: [] });
  assert.equal(progress(t.session.turnStatus), 'Working…');
  t = update(t, { ev: 'session.patch', rev: 2, patch: { turn: 'awaitingUser' } });
  assert.equal(progress(t.session.turnStatus), 'Waiting for you');
  t = update(t, { ev: 'session.patch', rev: 3, patch: { turn: 'idle' } });
  assert.equal(progress(t.session.turnStatus), '');
});

test('reused turn id after completion rotates but duplicate starts retain current items', () => {
  let t = snapshot({
    rev: 0,
    feedSeq: 0,
    session: {},
    itemsShape: 'items',
    history: [],
    liveTurn: { id: 'x', status: 'inProgress' },
    items: [{ id: 'a', type: 'agentMessage', text: 'first' }],
  });
  t = update(t, { ev: 'turn.state', feedSeq: 1, turnId: 'x', status: 'inProgress', started: true });
  assert.equal(t.items.length, 1);
  t = update(t, { ev: 'turn.state', feedSeq: 2, turnId: 'x', status: 'completed', started: false });
  t = update(t, { ev: 'turn.state', feedSeq: 3, turnId: 'x', status: 'inProgress', started: true });
  assert.equal(t.items.length, 0);
  assert.equal(t.history[0].text, 'first');
});

test('noncurrent event advances watermark and requests a history refresh without mutating the live turn', () => {
  const t = snapshot({
    rev: 0,
    feedSeq: 5,
    session: {},
    itemsShape: 'items',
    history: [],
    items: [{ id: 'a', type: 'agentMessage', text: 'current' }],
    liveTurn: { id: 'new', status: 'inProgress' },
  });
  const updated = update(t, { ev: 'items.delta', feedSeq: 6, live: false, turnId: 'old', itemId: 'a', field: 'text', text: 'stale' });
  assert.equal(updated.feedSeq, 6);
  assert.equal(updated.historyStale, true);
  assert.equal(updated.items[0].text, 'current');
  assert.equal(update(updated, { ev: 'items.delta', feedSeq: 6, live: false }), updated);
});

test('snapshot reports history changed during the read', () => {
  const value = snapshot({ rev: 0, feedSeq: 1, session: {}, itemsShape: 'rows', items: [], historyStale: true });
  assert.equal(value.historyStale, true);
});

test('turn events with absent status retain a neutral state', () => {
  const t = snapshot({ rev: 0, feedSeq: 0, session: {}, itemsShape: 'rows', items: [] });
  assert.equal(update(t, { ev: 'turn.state', feedSeq: 1 }).liveTurnStatus, null);
});

test('transcript keys distinguish repeated rows and remain stable when unrelated rows are inserted', () => {
  const one = [
    { role: 'user', text: 'same' },
    { role: 'assistant', text: 'reply' },
    { role: 'user', text: 'same' },
  ];
  const keys = keyedRows(one).map((row) => row.key);
  assert.equal(new Set(keys).size, 3);
  assert.deepEqual(
    keyedRows([{ role: 'step', text: 'extra' }, ...one])
      .slice(1)
      .map((row) => row.key),
    keys,
  );
});

test('two replies in one live turn are two rows around their step, not one joined line (#3663, order per #4201)', () => {
  const live = snapshot({
    rev: 1,
    feedSeq: 0,
    session: { turn: 'running' },
    itemsShape: 'items',
    history: [{ role: 'user', text: 'Check the tests still pass' }],
    items: [
      { id: 'r1', type: 'agentMessage', text: 'I will check the repository first.' },
      { id: 's1', type: 'commandExecution', command: 'git status --short' },
      { id: 'r2', type: 'agentMessage', text: 'git status lists 3 changed entries.' },
    ],
  });
  // #4201: the joined trailing preview put the first reply after its step; each reply is its own row, in order
  assert.deepEqual(
    displayRows(live).map((r) => [r.role, r.text]),
    [
      ['user', 'Check the tests still pass'],
      ['preview', 'I will check the repository first.'],
      ['live', 'git status --short'],
      ['preview', 'git status lists 3 changed entries.'],
    ],
  );
  // the history holding the first reply leaves only the second, as before
  const saved = snapshot({
    ...{ rev: 1, feedSeq: 0, session: { turn: 'running' }, itemsShape: 'items' },
    history: [
      { role: 'user', text: 'Check the tests still pass' },
      { role: 'assistant', text: 'I will check the repository first.' },
    ],
    items: [
      { id: 'r1', type: 'agentMessage', text: 'I will check the repository first.' },
      { id: 'r2', type: 'agentMessage', text: 'git status lists 3 changed entries.' },
    ],
  });
  assert.equal(displayRows(saved).at(-1)!.text, 'git status lists 3 changed entries.');
  // an empty reply item adds no blank paragraph
  const empty = snapshot({
    ...{ rev: 1, feedSeq: 0, session: { turn: 'running' }, itemsShape: 'items', history: [] },
    items: [
      { id: 'r1', type: 'agentMessage', text: 'One.' },
      { id: 'r2', type: 'agentMessage', text: '' },
    ],
  });
  assert.equal(displayRows(empty).at(-1)!.text, 'One.');
  // a reply that starts with an indented code block keeps its indentation
  const code = snapshot({
    ...{ rev: 1, feedSeq: 0, session: { turn: 'running' }, itemsShape: 'items', history: [] },
    items: [
      { id: 'r1', type: 'agentMessage', text: 'Run this:' },
      { id: 'r2', type: 'agentMessage', text: '    npm test' },
    ],
  });
  assert.equal(displayRows(code).at(-1)!.text, '    npm test');
  assert.equal(displayRows(code).at(-2)!.text, 'Run this:');
});

test('a turn that starts keeps what the saved rows carry beyond their words: a reminder, when it was said, its id', () => {
  const saved = [
    { id: 'r1', role: 'assistant', text: 'Hi', at: 1000 },
    { id: 'r2', role: 'note', text: 'Send the notes', at: 2000, nudge: { loopId: 'L1', title: 'Send the notes', quote: null, why: null } },
  ];
  let t = snapshot({ rev: 1, session: { cards: [] }, itemsShape: 'rows', feedSeq: 0, items: saved });
  t = update(t, { ev: 'turn.state', feedSeq: 1, turnId: 'x', status: 'inProgress', started: true });
  assert.deepEqual(t.history, saved, 'saved rows come through whole');
  // a live row that is not saved yet follows them, as drawn
  t = update(t, { ev: 'items.append', feedSeq: 2, items: [{ id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'Hello' }] }] });
  t = update(t, { ev: 'turn.state', feedSeq: 3, turnId: 'y', status: 'inProgress', started: true });
  assert.deepEqual(t.history.slice(0, 2), saved);
  assert.deepEqual(t.history[2], { role: 'user', text: 'Hello' });
});

// #4201: a live turn with steers: replies sit between their steps and the messages sent, each once, by identity.
const FLOW = [
  { id: 'a', rowId: 'r-a', type: 'userMessage', content: [{ type: 'text', text: 'A' }] },
  { id: 't1', rowId: 'r-t1', type: 'agentMessage', text: 'T1' },
  { id: 's1', rowId: 'r-s1', type: 'commandExecution', command: 'step one' },
  { id: 't2', rowId: 'r-t2', type: 'agentMessage', text: 'T2' },
  { id: 's2', rowId: 'r-s2', type: 'commandExecution', command: 'step two' },
  { id: 'b', rowId: 'r-b', type: 'userMessage', content: [{ type: 'text', text: 'B' }] },
  { id: 't3', rowId: 'r-t3', type: 'agentMessage', text: 'T3' },
  { id: 's3', rowId: 'r-s3', type: 'commandExecution', command: 'step three' },
  { id: 'c', rowId: 'r-c', type: 'userMessage', content: [{ type: 'text', text: 'C' }] },
  { id: 't4', rowId: 'r-t4', type: 'agentMessage', text: 'T4' },
];
const EXPECTED = ['A', 'T1', 'step one', 'T2', 'step two', 'B', 'T3', 'step three', 'C', 'T4'];

test('a live turn with steers renders in order with each text once, fully live', () => {
  const t = snapshot({ rev: 1, feedSeq: 1, session: {}, itemsShape: 'items', history: [{ role: 'user', text: 'Earlier' }], items: FLOW });
  assert.deepEqual(
    displayRows(t).map((r) => r.text),
    ['Earlier', ...EXPECTED],
  );
  assert.deepEqual(
    displayRows(t)
      .slice(1)
      .map((r) => r.role),
    ['liveUser', 'preview', 'live', 'preview', 'live', 'liveUser', 'preview', 'live', 'liveUser', 'preview'],
  );
});

test('with part of the turn already in saved history, nothing repeats and the order holds', () => {
  const history = [
    { role: 'user', text: 'A', id: 'r-a' },
    { role: 'assistant', text: 'T1', id: 'r-t1' },
    { role: 'step', text: 'step one', id: 'r-s1' },
    { role: 'assistant', text: 'T2', id: 'r-t2' },
  ];
  const t = snapshot({ rev: 1, feedSeq: 1, session: {}, itemsShape: 'items', history, items: FLOW });
  assert.deepEqual(
    displayRows(t).map((r) => r.text),
    EXPECTED,
  );
});

test('a streaming reply keeps its key as it grows and replies of a turn keep apart', () => {
  let t = snapshot({ rev: 1, feedSeq: 1, session: {}, itemsShape: 'items', history: [], items: FLOW.slice(0, 2) });
  const before = keyedRows(displayRows(t)).at(-1)!.key;
  t = update(t, { ev: 'items.delta', feedSeq: 2, itemId: 't1', field: 'text', text: ' more' });
  const rows = keyedRows(displayRows(t));
  assert.equal(rows.at(-1)!.text, 'T1 more');
  assert.equal(rows.at(-1)!.key, before);
  const same = snapshot({
    rev: 1,
    feedSeq: 1,
    session: {},
    itemsShape: 'items',
    history: [],
    items: [
      { id: 'x', type: 'agentMessage', text: 'Same' },
      { id: 'y', type: 'agentMessage', text: 'Same' },
    ],
  });
  assert.equal(new Set(keyedRows(displayRows(same)).map((r) => r.key)).size, 2);
});

test('the next turn keeps saved rows as they are and adds the live ones by identity', () => {
  const history = [{ role: 'user', text: 'A', id: 'r-a', at: 5 }];
  let t = snapshot({ rev: 1, feedSeq: 1, session: {}, itemsShape: 'items', history, items: FLOW.slice(0, 4) });
  t = update(t, { ev: 'turn.state', feedSeq: 2, turnId: 'next', status: 'inProgress' });
  assert.deepEqual(t.history[0], history[0]);
  assert.deepEqual(
    t.history.map((r) => [r.role, r.text]),
    [
      ['user', 'A'],
      ['assistant', 'T1'],
      ['step', 'step one'],
      ['assistant', 'T2'],
    ],
  );
  // the saved copy of a retired live row arrives later: it is not shown twice
  const later = { ...t, items: FLOW.slice(1, 4) };
  assert.equal(displayRows(later).filter((r) => r.text === 'T1').length, 1);
});

test('a live item without an id still shows (it has nothing to match a saved row by)', () => {
  const t = snapshot({
    rev: 1,
    feedSeq: 1,
    session: {},
    itemsShape: 'items',
    history: [],
    items: [{ type: 'commandExecution', command: 'ls' }],
  });
  assert.deepEqual(
    displayRows(t).map((r) => [r.role, r.text]),
    [['live', 'ls']],
  );
});
