// The phone's item union (plan R1): every row, run, card and turn state the fold can produce becomes exactly one item, ids hold across re-folds, and a row nobody knows is kept as text.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cardLine } from '../shared/host/cardLine.mjs';
import { familyMessageText } from '../shared/sideSessions.mjs';
import { momoRows } from '../mobile/src/momo/chatRows';
import { displayRows, keyedRows, row, snapshot, update, withPendingRows, type Data } from '../mobile/src/presentation/thread';
import { fold, type KeyedRow } from '../mobile/src/presentation/toolRuns';
import { createCardStore, type HostCardWire } from '../mobile/src/remote/hostCards';
import {
  ITEM_KINDS,
  itemOfBlock,
  itemOfCard,
  itemOfHostCard,
  itemOfMomoRow,
  itemOfRow,
  itemsFromMomoRows,
  itemsFromBlocks,
  itemsFromHostCards,
  statusOf,
  type Item,
} from '../mobile/src/ui/items';

const saved: Data[] = [
  { role: 'user', text: 'Fix the test', clientId: 'c1', images: 2, id: 'm1' },
  { role: 'step', text: 'Read a.ts', kind: 'read', ms: 1200 },
  { role: 'step', text: 'Ran npm test', kind: 'run', ms: 3000, state: 'failed', detail: 'exit 1', surface: 'chrome', id: 5 },
  { role: 'assistant', text: 'Two tests fail.' },
];
const view = (rows: KeyedRow[], running = false) => fold(rows, { running, foldedTurn: null }).blocks;
const rowsOf = (items: Data[]) => keyedRows(displayRows(snapshot({ items, session: {}, rev: 1, itemsShape: 'rows' })));

test('a saved chat becomes messages, one run and nothing dropped', () => {
  const items = itemsFromBlocks(view(rowsOf(saved)));
  assert.deepEqual(
    items.map((i) => i.kind),
    ['message', 'tool-run', 'message'],
  );
  const [you, run, reply] = items as [Item & { kind: 'message' }, Item & { kind: 'tool-run' }, Item & { kind: 'message' }];
  assert.deepEqual([you.from, you.live, you.clientId, you.images], ['user', false, 'c1', { count: 2, messageId: 'm1' }]);
  assert.equal(you.send, undefined);
  assert.deepEqual([reply.from, reply.text], ['assistant', 'Two tests fail.']);
  assert.deepEqual([run.summary, run.running, run.steps.length], ['Read 1 file, ran 1 command', false, 2]);
  assert.deepEqual(run.steps[1], {
    kind: 'tool-call',
    id: run.steps[1].id,
    text: 'Ran npm test',
    tool: 'run',
    state: 'failed',
    durationMs: 3000,
    detail: 'exit 1',
    surface: 'chrome',
    callId: '5',
  });
  assert.equal(run.steps[0].durationMs, 1200);
  assert.ok(run.id.startsWith('run:'));
});

test('every item has an id and the ids are the same after the chat is folded again', () => {
  const again = () => itemsFromBlocks(view(rowsOf(saved))).map((i) => i.id);
  assert.deepEqual(again(), again());
  assert.equal(new Set(again()).size, again().length);
});

test('a single step stays a tool call; pictures held on the phone and an authored message are carried', () => {
  const one = itemOfBlock({
    type: 'row',
    row: { role: 'step', text: 'Read b.ts', key: 's', kind: 'read', thumbnail: 'data:image/png;base64,AA', callId: 'k' },
  });
  assert.deepEqual([one.kind, (one as any).thumbnail, (one as any).callId], ['tool-call', 'data:image/png;base64,AA', 'k']);
  const withPics = itemOfRow({ role: 'user', text: 'look', key: 'u', pictures: ['file:///a.jpg'] });
  assert.deepEqual((withPics as any).pictures, ['file:///a.jpg']);
  const authored = itemOfRow({ role: 'user', text: 'plain words', key: 'a' });
  assert.equal((authored as any).authored, undefined);
});

test('a message of yours on its way is pending, one that did not go is failed, and the agent never is', () => {
  const pending = withPendingRows(rowsOf(saved), [{ text: 'and then?', base: 4, id: 'p1' }]);
  const items = itemsFromBlocks(view(pending), { failed: new Set(['sent:p1']) });
  const sent = items.find((i) => i.id === 'sent:p1') as Item & { kind: 'message' };
  assert.equal(sent.send, 'failed');
  const waiting = itemsFromBlocks(view(pending));
  assert.equal((waiting.find((i) => i.id === 'sent:p1') as any).send, 'pending');
  const reply = itemOfRow({ role: 'assistant', text: 'x', key: 'r', optimistic: true }, new Set(['r']));
  assert.equal((reply as any).send, undefined);
});

test('live rows: a reply still arriving and a message the Mac has not recorded are live', () => {
  const live = [
    { role: 'liveUser', text: 'hi', key: 'a' },
    { role: 'live', text: 'Running tests', key: 'b', kind: 'run', state: 'running' },
    { role: 'preview', text: 'Working on', key: 'c' },
  ] as KeyedRow[];
  const items = itemsFromBlocks(view(live, true));
  assert.deepEqual(
    items.map((i) => [i.kind, (i as any).live]),
    [
      ['message', true],
      ['tool-call', undefined],
      ['message', true],
    ],
  );
  assert.equal((items[1] as any).state, 'running');
});

test('a running run is marked running, and a row with a role nobody knows is kept as text', () => {
  const steps = [
    { role: 'live', text: 'a', key: '1', kind: 'read' },
    { role: 'live', text: 'b', key: '2', kind: 'read' },
  ] as KeyedRow[];
  assert.equal((itemsFromBlocks(view(steps, true))[0] as any).running, true);
  assert.deepEqual(itemOfRow({ role: 'activity', text: 'odd', key: 'k' }), { kind: 'unknown', id: 'k', text: 'odd' });
});

test('a live stream folded through the thread gives the same items as the saved rows it becomes', () => {
  let thread = snapshot({ items: [], session: {}, rev: 1, itemsShape: 'items', feedSeq: 0 });
  thread = update(thread, {
    ev: 'items.append',
    feedSeq: 1,
    items: [{ id: 'u', type: 'userMessage', content: [{ type: 'text', text: 'go' }] }],
  });
  thread = update(thread, { ev: 'items.append', feedSeq: 2, items: [{ id: 'a', type: 'agentMessage', text: 'ok' }] });
  const items = itemsFromBlocks(view(keyedRows(displayRows(thread))));
  assert.deepEqual(
    items.map((i) => [i.kind, (i as any).from, (i as any).text]),
    [
      ['message', 'user', 'go'],
      ['message', 'assistant', 'ok'],
    ],
  );
  assert.equal(row({ type: 'agentMessage', text: 'ok' }, 'items').role, 'assistant');
});

test('cards the Mac sent: a permission request, a question, a plan, a Mac-only card', () => {
  const approval = itemOfCard({
    id: 7,
    rev: 2,
    title: 'Run this command?',
    detail: 'git push',
    to: 'github.com',
    choices: [
      { key: 'allow', label: 'Allow once' },
      { key: 'deny', label: 'Deny', deny: true },
    ],
  });
  assert.deepEqual(approval, {
    kind: 'approval',
    id: JSON.stringify(['mac', 7, 2]),
    origin: 'mac',
    title: 'Run this command?',
    detail: 'git push',
    macOnly: false,
    view: { state: 'waiting' },
    options: [
      { id: 'allow', label: 'Allow once', tone: 'allow' },
      { id: 'deny', label: 'Deny', tone: 'deny' },
    ],
    destination: 'github.com',
  });
  assert.equal(itemOfCard({ id: 1, rev: 1, title: 'Q', questions: [{ id: 'a' }, { id: 'b' }] }).kind, 'question');
  assert.deepEqual((itemOfCard({ id: 1, rev: 1, title: 'Q', questions: [{ id: 'a' }, { id: 'b' }] }) as any).prompts.length, 2);
  const form = itemOfCard({ id: 2, rev: 1, title: 'Form', schema: { properties: { a: {}, b: {}, c: {} } } }) as any;
  assert.deepEqual([form.kind, form.prompts.length, form.questions], ['question', 3, 3]);
  const plan = itemOfCard({
    id: 3,
    rev: 1,
    title: 'Plan',
    kind: 'plan',
    plan: { text: 'do it', clipped: true },
    choices: [{ key: 'ok', label: 'Approve' }],
  }) as any;
  assert.deepEqual([plan.kind, plan.text, plan.clipped, plan.options.length], ['plan', 'do it', true, 1]);
  const bare = itemOfCard({ id: 4, rev: 1, title: 'Plan', kind: 'plan' }) as any;
  assert.deepEqual([bare.text, bare.clipped, bare.options], ['', false, []]);
  const mac = itemOfCard({ id: 5, rev: 1, title: 'Pay', where: 'mac-only', waitingCopy: 'Finish on your Mac' }) as any;
  assert.deepEqual([mac.kind, mac.macOnly, mac.waitingCopy, mac.options], ['approval', true, 'Finish on your Mac', []]);
});

test('the working line has a catalog key for every stage of thinking and every activity, matching its English words', () => {
  const at = (tail: any, sinceMs: number) => statusOf({ turn: 'running', tail, sinceMs })!;
  for (const [sinceMs, key] of [
    [0, 'thinking'],
    [6000, 'thinkingMore'],
    [15000, 'thinkingSomeMore'],
    [40000, 'stillThinking'],
  ] as const)
    assert.equal(at({ type: 'you' }, sinceMs).wordKey, key);
  for (const [kind, key] of [
    ['read', 'reading'],
    ['search', 'searching'],
    ['edit', 'editing'],
    ['run', 'running'],
    ['web', 'searchingWeb'],
    ['other', 'working'],
  ] as const)
    assert.equal(at({ type: 'step', kind }, 0).wordKey, key);
  assert.equal(at({ type: 'reply' }, 0).wordKey, 'writing');
  assert.equal(at({ type: 'none' }, 0).wordKey, 'thinking');
});

test('the turn: thinking, working, writing, waiting, error, interrupted, and nothing when idle', () => {
  const at = (turn: unknown, tail: any, extra = {}) => statusOf({ turn, tail, sinceMs: 7000, ...extra });
  assert.deepEqual(at('running', { type: 'you' }), {
    kind: 'status',
    id: 'status',
    state: 'thinking',
    wordKey: 'thinkingMore',
    words: 'Thinking more…',
  });
  assert.equal(at('inProgress', { type: 'step', kind: 'read' })?.words, 'Reading files');
  assert.equal(at('inProgress', { type: 'step', kind: 'read' })?.state, 'working');
  assert.deepEqual([at('running', { type: 'reply' })?.state, at('running', { type: 'reply' })?.words], ['writing', '']);
  assert.deepEqual(at('awaitingUser', { type: 'none' }), {
    kind: 'status',
    id: 'status',
    state: 'waiting',
    wordKey: 'waiting',
    words: 'Waiting for you',
  });
  assert.equal(at('idle', { type: 'none' }), null);
  assert.equal(at('running', { type: 'none' }, { error: true })?.state, 'error');
  assert.equal(at('idle', { type: 'none' }, { interrupted: true })?.state, 'interrupted');
});

test('the whole list: earlier row first, blocks, cards, then the turn', () => {
  const items = itemsFromBlocks(view(rowsOf(saved.slice(0, 1))), {
    earlier: { loading: true },
    cards: [{ id: 1, rev: 1, title: 'Run?', choices: [{ key: 'a', label: 'Allow' }] }],
    turn: { turn: 'awaitingUser', tail: { type: 'you' }, sinceMs: 0 },
  });
  assert.deepEqual(
    items.map((i) => i.kind),
    ['earlier', 'message', 'approval', 'status'],
  );
  assert.deepEqual((items[0] as any).loading, true);
  assert.deepEqual(itemsFromBlocks([]), []);
});

test('every kind of the union is named once', () => {
  assert.equal(new Set(ITEM_KINDS).size, ITEM_KINDS.length);
});

test('a step with no facts reads as a finished other step; pictures without an id carry only their count; its own words from MoPilot become a card', () => {
  const bare = itemOfRow({ role: 'step', text: 'Did a thing', key: 'z' }) as any;
  assert.deepEqual([bare.tool, bare.state, bare.durationMs, bare.detail], ['other', 'done', null, undefined]);
  const counted = itemOfRow({ role: 'user', text: 'see', key: 'i', images: 1 }) as any;
  assert.deepEqual(counted.images, { count: 1 });
  const text = familyMessageText({ fromName: 'p', fromId: 'x', relation: 'parent', body: 'Done.', roster: '' });
  const authored = itemOfRow({ role: 'user', text, key: 'a' }) as any;
  assert.deepEqual(authored.authored, { title: 'Received message from p', body: 'Done.', kind: 'family' });
});

test('a question carries its prompts, options and whether free text is allowed', () => {
  const q = itemOfCard({
    id: 1,
    rev: 1,
    title: 'Q',
    questions: [
      { id: 'a', question: 'Which branch?', header: 'Branch', options: [{ label: 'main' }, { label: 'dev' }], multiSelect: true },
      { id: 'b', header: 'Why', options: [{ label: 'x' }], isOther: true },
      { id: 'c' },
    ],
    schema: {
      properties: {
        name: { title: 'Name', description: 'Your name' },
        size: { title: 'Size', enumLabels: ['Small', 'Large'] },
        n: { enum: [1, 2] },
        bare: {},
      },
    },
  }) as any;
  assert.deepEqual(q.prompts, [
    { id: 'a', header: 'Branch', text: 'Which branch?', options: [{ label: 'main' }, { label: 'dev' }], multi: true, other: false },
    { id: 'b', header: 'Why', text: 'Why', options: [{ label: 'x' }], multi: false, other: true },
    { id: 'c', text: '', options: [], multi: false, other: true },
    { id: 'name', header: 'Name', text: 'Your name', options: [], multi: false, other: true },
    { id: 'size', header: 'Size', text: 'Size', options: [{ label: 'Small' }, { label: 'Large' }], multi: false, other: false },
    { id: 'n', text: 'n', options: [{ label: '1' }, { label: '2' }], multi: false, other: false },
    { id: 'bare', text: 'bare', options: [], multi: false, other: true },
  ]);
});

test('a waiting Mac card carries its timings when the Mac sends them and none when it does not', () => {
  const none = itemOfCard({ id: 1, rev: 1, title: 'Run?' });
  assert.deepEqual(none.view, { state: 'waiting' });
  const timed = itemOfCard({ id: 1, rev: 1, title: 'Run?', since: 100, remindMs: 5, pauseMs: 9 });
  assert.deepEqual(timed.view, { state: 'waiting', since: 100, remindMs: 5, pauseMs: 9 });
});

const wire = (over: Partial<HostCardWire> = {}): HostCardWire => ({
  chatId: 'c',
  epoch: 1,
  requestId: 'r1',
  cardKind: 'permission',
  summary: { tool: 'Run a command', line: 'git push' },
  options: [
    { optionId: 'a', name: 'Allow', kind: 'allow' },
    { optionId: 'd', name: 'Deny', kind: 'deny' },
  ],
  at: 1,
  ...over,
});

test('Host cards are the same items as the Mac path, with the state the Host reports', () => {
  const store = createCardStore();
  store.setPending('h1', [wire(), wire({ requestId: 'r2', cardKind: 'question', summary: { tool: 'Question', line: '' }, options: [] })]);
  const shown = store.list();
  const items = itemsFromHostCards(shown);
  assert.deepEqual(
    items.map((i) => [i.kind, i.origin, i.view.state]),
    [
      ['approval', 'host', 'waiting'],
      ['question', 'host', 'waiting'],
    ],
  );
  const first = items[0] as any;
  assert.deepEqual(
    [first.title, first.detail, first.options[0]],
    ['Run a command', 'git push', { id: 'a', label: 'Allow', tone: 'allow' }],
  );
  assert.equal((items[1] as any).detail, undefined);
  const base = shown[0];
  assert.deepEqual(itemOfHostCard({ ...base, state: { kind: 'sending', optionId: 'a' } }).view, { state: 'sending', optionId: 'a' });
  const withState = (state: any, name?: string) => itemOfHostCard({ ...base, state }, name).view as any;
  assert.deepEqual(withState({ kind: 'unreachable', optionId: 'a' }, 'build-box'), {
    state: 'unreachable',
    optionId: 'a',
    machineName: 'build-box',
    line: cardLine({ state: 'unreachable' }, { now: 0, machineName: 'build-box' }).text,
  });
  assert.equal(withState({ kind: 'unreachable', optionId: 'a' }).machineName, 'this machine');
  assert.deepEqual(withState({ kind: 'closed', line: 'Answered on iPhone' }), { state: 'closed', line: 'Answered on iPhone' });
  const restarted = cardLine({ state: 'restarted' }, { now: 0 }).text as string;
  assert.deepEqual(withState({ kind: 'closed', line: restarted }, 'build-box'), {
    state: 'restarted',
    machineName: 'build-box',
    line: restarted,
  });
  assert.deepEqual(itemOfHostCard({ ...base, card: { ...base.card, remindMs: 10, pauseMs: 20 } }).view, {
    state: 'waiting',
    since: 1,
    remindMs: 10,
    pauseMs: 20,
  });
  assert.deepEqual(items[0].view, { state: 'waiting', since: 1 });
  const asked = itemOfHostCard({
    ...shown[1],
    card: { ...shown[1].card, form: { a: 1 }, options: [{ optionId: 'x', name: 'Yes', kind: 'other' }] },
  }) as any;
  assert.deepEqual(asked.prompts, [{ id: 'r2', text: 'Question', options: [{ label: 'Yes' }], multi: false, other: true }]);
  assert.deepEqual((items[1] as any).prompts, [{ id: 'r2', text: 'Question', options: [], multi: false, other: false }]);
});

test('MoMo: messages, reminders and day lines become items in the same union, and a row nobody knows is kept', () => {
  const thread = snapshot({
    items: [
      { role: 'user', text: 'remind me to pay rent', at: Date.parse('2026-11-12T12:00:00Z') },
      {
        role: 'note',
        text: '',
        at: Date.parse('2026-11-14T11:00:00Z'),
        nudge: { loopId: 'l1', title: 'Pay rent', quote: 'pay rent on the 1st', why: 'due soon' },
      },
      { role: 'assistant', text: 'Noted.' },
    ],
    session: {},
    rev: 1,
    itemsShape: 'rows',
  });
  const items = itemsFromMomoRows(momoRows(thread, Date.parse('2026-11-14T12:00:00Z')));
  assert.deepEqual(
    items.map((i) => i.kind),
    ['day', 'message', 'day', 'nudge', 'message'],
  );
  assert.deepEqual(items[3], {
    kind: 'nudge',
    id: 'nudge:l1',
    loopId: 'l1',
    title: 'Pay rent',
    quote: 'pay rent on the 1st',
    why: 'due soon',
  });
  assert.equal((items[2] as any).label, 'Today');
  assert.deepEqual(itemOfMomoRow({ kind: 'mystery', key: 'k' } as any), { kind: 'unknown', id: 'k', text: '' });
  assert.deepEqual(itemOfMomoRow({ kind: 'mystery' } as any), { kind: 'unknown', id: 'unknown', text: '' });
});
