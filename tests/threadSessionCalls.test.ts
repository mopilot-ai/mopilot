// A chat's linked-session tool calls (start_session, hand_off_to_session, dismiss_task) as the whole thread view shows
// them, whichever harness made them: a started session is its card in the turn (also when the work folds), the turn's
// proposals are one suggestion card after its reply, and every call's line says what it did, never "Called sage_…".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { autoMock } from './support/thread-kit.ts';

autoMock('src/components/thread/TaskProposalCard.tsx', 'sessionCards', {
  TaskProposalCard: (p: any) => h('div', { 'data-stub': 'TaskProposalCard', 'data-chat': p.threadId, 'data-session': p.call.chatId }),
  TurnSuggestions: (p: any) =>
    h('div', { 'data-stub': 'TurnSuggestions', 'data-chat': p.threadId, 'data-tasks': p.calls.map((c: any) => c.taskId).join(',') }),
});
const { render, flush, chat, turn, user, reply, view, text } = await import('./support/thread-view/fixture.ts');
const { isBlockItem } = await import('../src/components/thread/items/stepModel.ts');
const { sessionToolCall } = await import('../src/lib/sessionToolCall.ts');

const out = (o: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(o) }] });
const call = (id: string, tool: string, args: any, result: any, extra: any = {}) => ({
  id,
  type: 'mcpToolCall',
  server: 'sage_ab',
  tool,
  arguments: args,
  status: result ? 'completed' : 'inProgress',
  result: result ? out(result) : null,
  ...extra,
});
const started = call(
  's1',
  'start_session',
  { title: 'API schema', prompt: 'p', initiation: 'user_asked' },
  { status: 'started', chat_id: 'child-1', title: 'API schema', name: 'api-schema', worktree: true, context: 'fresh' },
);
const offered = call(
  's2',
  'start_session',
  { title: 'Docs', prompt: 'p', initiation: 'offer' },
  { status: 'proposed', task_id: 'task_a', kind: 'offer', title: 'Docs' },
);
const suggested = call(
  's3',
  'start_session',
  { title: 'Tests', prompt: 'p', initiation: 'own_initiative' },
  { status: 'proposed', task_id: 'task_b', kind: 'own_initiative', title: 'Tests' },
);

test("a started session is its card in the turn, in view while the finished turn's work is folded", async () => {
  chat([turn('t1', [user('u1', 'Do it in parallel'), started, reply('r1', 'Started it.')])]);
  const v = await render(view());
  await flush();
  const card = v.$('[data-stub="TaskProposalCard"]');
  assert.ok(card, 'the started session renders as its card');
  assert.equal(card!.dataset.session, 'child-1');
  assert.doesNotMatch(text(v.host), /Called sage_ab/);
  await v.unmount();
});

test('the started card stays in view while the rest of the folded work is hidden', async () => {
  const cmd = { id: 'c1', type: 'commandExecution', command: 'ls', status: 'completed', commandActions: [] };
  chat([turn('t1', [user('u1', 'Go'), cmd, started, reply('r1', 'Started it.')])]);
  const v = await render(view());
  await flush();
  assert.ok(v.$('[data-stub="TaskProposalCard"]'), 'the card is pinned');
  assert.doesNotMatch(text(v.host), /Ran ls|ls/);
  await v.unmount();
});

test("a turn's proposals are one suggestion card after its reply, and their lines say what they did", async () => {
  chat([turn('t1', [user('u1', 'Docs too'), offered, suggested, reply('r1', 'Pick one.')])]);
  const v = await render(view());
  await flush();
  const cards = v.$$('[data-stub="TurnSuggestions"]');
  assert.equal(cards.length, 1);
  assert.equal(cards[0].dataset.tasks, 'task_a,task_b');
  assert.equal(cards[0].dataset.chat, 'thr');
  // the proposals render once, in the suggestion card, not also as a card of their own
  assert.equal(v.$('[data-stub="TaskProposalCard"]'), null);
  await v.unmount();
});

test('every item BlockItem draws as a dedicated card is a block, so the thread reaches it', () => {
  // the class this guards: a card BlockItem dispatches to, for an item buildBlocks folds into a step group instead
  assert.equal(isBlockItem(started as any), true);
  assert.ok(sessionToolCall(started));
  for (const p of [offered, suggested]) assert.equal(isBlockItem(p as any), false, 'a proposal is a step; its card ends the turn');
});

test('each session call reads as what it does, running, done or failed, and never as the tool it called', async () => {
  const { sessionCallLine, turnProposals } = await import('../src/lib/sessionToolCall.ts');
  const line = (tool: string, args: any, extra: any = {}) =>
    sessionCallLine({ type: 'mcpToolCall', server: 'sage_ab', tool, arguments: args, status: 'completed', ...extra })?.text;
  assert.equal(line('start_session', { initiation: 'user_asked' }, { status: 'inProgress' }), 'Starting session');
  assert.equal(line('start_session', {}), 'Started session');
  assert.equal(line('start_session', { initiation: 'offer' }), 'Offered a new session');
  assert.equal(line('start_session', { initiation: 'offer' }, { status: 'inProgress' }), 'Offering a new session');
  assert.equal(line('start_session', { initiation: 'own_initiative' }), 'Suggested task');
  assert.equal(line('start_session', { proposal_id: 'task_a' }), 'Started session');
  assert.equal(line('hand_off_to_session', {}), 'Handed off to a new session');
  assert.equal(line('dismiss_task', { task_id: 'task_a' }, { status: 'inProgress' }), 'Withdrawing suggestion');
  assert.equal(line('start_session', {}, { status: 'failed' }), 'Couldn’t start a session');
  assert.equal(line('start_session', { initiation: 'offer' }, { error: { message: 'x' } }), 'Couldn’t offer a new session');
  assert.equal(line('dismiss_task', {}, { result: { isError: true } }), 'Couldn’t withdraw a suggestion');
  // only an answered call is done: another harness's pending state is still running, and no status at all is settled
  assert.equal(line('start_session', {}, { status: 'pending' }), 'Starting session');
  assert.equal(line('start_session', {}, { status: undefined }), 'Started session');
  // a Claude-named call (mcp__<server>__<tool>) and a call with no arguments read the same
  assert.equal(
    sessionCallLine({ type: 'dynamicToolCall', tool: 'mcp__sage_x__start_session', status: 'completed' })?.text,
    'Started session',
  );
  // another server's tool of the same name, or another tool, is not ours
  assert.equal(line('start_session', {}, { server: 'other' }), undefined);
  assert.equal(line('list_sessions', {}), undefined);
  assert.equal(sessionCallLine({ type: 'commandExecution' }), null);
  assert.equal(sessionCallLine(null), null);
  // a dismiss is a line, never a card; a repeated proposal (same task) is listed once
  assert.equal(
    sessionToolCall({ type: 'mcpToolCall', server: 'sage_ab', tool: 'dismiss_task', status: 'completed', result: out({}) }),
    null,
  );
  assert.deepEqual(
    turnProposals([offered, started, offered, suggested]).map((p) => p.taskId),
    ['task_a', 'task_b'],
  );
});

test("a turn's session calls are counted as sessions in its summary and named in the running line", async () => {
  const { itemSteps, summarizeSteps } = await import('../src/components/thread/items/stepModel.ts');
  const { activeStepLabel } = await import('../src/components/thread/items/presentation.tsx');
  const dismiss = call('d1', 'dismiss_task', { task_id: 'task_a' }, { task_id: 'task_a', status: 'dismissed' });
  const handoff = call('h1', 'hand_off_to_session', { title: 'x' }, { status: 'started', chat_id: 'c2' });
  const other = call('o1', 'list_sessions', {}, { sessions: [] });
  const steps = [started, handoff, offered, suggested, dismiss, dismiss, other].flatMap((i) => itemSteps(i as any));
  assert.equal(summarizeSteps(steps).text, 'Started 2 sessions, suggested 2 tasks, withdrew 2 suggestions, called a tool');
  assert.equal(summarizeSteps(itemSteps(offered as any)).text, 'Suggested a task');
  assert.equal(summarizeSteps(itemSteps(started as any)).text, 'Started a session');
  assert.equal(summarizeSteps(itemSteps(dismiss as any)).text, 'Withdrew a suggestion');
  // a refused start started nothing: it is a tool call, not a session
  const refused = call('f1', 'start_session', { initiation: 'user_asked' }, null, {
    status: 'failed',
    error: { message: 'not_user_turn' },
  });
  assert.equal(summarizeSteps(itemSteps(refused as any)).text, 'Called a tool');
  const running = call('r1', 'start_session', { initiation: 'offer' }, null);
  assert.equal(activeStepLabel(itemSteps(running as any)[0]), 'Offering a new session');
  assert.equal(activeStepLabel(itemSteps(call('r2', 'other_tool', {}, null) as any)[0]), 'Calling other_tool');
});

test('a session call row reads as its line with a fork icon; a running one stays a step until it answers', async () => {
  const { StepRow } = await import('../src/components/thread/items/StepRow.tsx');
  const { itemSteps } = await import('../src/components/thread/items/stepModel.ts');
  const v = await render(h(StepRow, { step: itemSteps(offered as any)[0], cwd: '/r' }));
  assert.match(text(v.host), /Offered a new session/);
  assert.doesNotMatch(text(v.host), /Called/);
  assert.ok(v.$('svg'), 'the row has its icon');
  await v.unmount();
  assert.equal(isBlockItem(call('r', 'start_session', {}, null) as any), false);
});

test("an offer reads as the user's answer, and one still waiting is its turn's card by its title", async () => {
  const { sessionCallLine, turnProposals } = await import('../src/lib/sessionToolCall.ts');
  const { itemSteps, summarizeSteps } = await import('../src/components/thread/items/stepModel.ts');
  const answered = (id: string, result: any) => call(id, 'start_session', { title: 'Docs', initiation: 'offer' }, result);
  const here = answered('k1', { status: 'declined', task_id: 'task_k', answer: 'here', title: 'Docs' });
  const kept = sessionCallLine(here)!;
  assert.deepEqual([kept.kind, kept.text], ['kept', 'Kept in this session']);
  // one its countdown started, the user not having answered, says so
  const unanswered = sessionCallLine(
    answered('k6', { status: 'briefing', task_id: 'task_k', answer: 'new_session', auto: true, title: 'Docs' }),
  )!;
  assert.deepEqual([unanswered.kind, unanswered.text], ['start', 'Started session (no answer)']);
  // and one a countdown kept here, in a transcript from before it chose "New session", still reads as it did
  const keptBefore = sessionCallLine(answered('k7', { status: 'declined', task_id: 'task_k', answer: 'here', auto: true, title: 'Docs' }))!;
  assert.deepEqual([keptBefore.kind, keptBefore.text], ['kept', 'Kept in this session (no answer)']);
  const started2 = answered('k2', { status: 'started', chat_id: 'c9', answer: 'new_session', title: 'Docs' });
  assert.deepEqual([sessionCallLine(started2)!.kind, sessionCallLine(started2)!.text], ['start', 'Started session']);
  // an answer the window can't read leaves the offer's own line
  assert.equal(sessionCallLine(answered('k3', null as any))?.text, 'Offering a new session');
  assert.equal(
    sessionCallLine({ ...answered('k4', {}), status: 'completed', result: { content: [{ type: 'text', text: 'oops' }] } })?.text,
    'Offered a new session',
  );
  assert.equal(sessionCallLine(answered('k5', { status: 'proposed', answer: 7 }))?.text, 'Offered a new session');
  assert.equal(summarizeSteps(itemSteps(here as any)).text, 'Kept a task here');
  assert.equal(summarizeSteps([...itemSteps(here as any), ...itemSteps(here as any)]).text, 'Kept 2 tasks here');
  // a kept offer is no card; a running one is, by its title, once
  const running = call('w1', 'start_session', { title: 'Docs', initiation: 'offer' }, null);
  assert.deepEqual(turnProposals([here, running, running]), [{ kind: 'proposed', taskId: null, title: 'Docs', offer: true }]);
  // not a waiting offer: a running suggestion, a running offer with no title, a failed offer
  assert.deepEqual(
    turnProposals([
      call('w2', 'start_session', { title: 'X', initiation: 'own_initiative' }, null),
      call('w3', 'start_session', { initiation: 'offer' }, null),
      call('w4', 'start_session', { title: 'Y', initiation: 'offer' }, null, { status: 'failed' }),
      { id: 'n', type: 'agentMessage', text: 'hi' },
    ]),
    [],
  );
});

test('an accepted title offer and its brief fill count one session, while independent starts remain separate', async () => {
  const { itemSteps, summarizeSteps } = await import('../src/components/thread/items/stepModel.ts');
  const accepted = call(
    'accept',
    'start_session',
    { title: 'Docs', initiation: 'offer' },
    { status: 'briefing', task_id: 'task_docs', chat_id: 'docs', title: 'Docs', answer: 'new_session' },
  );
  const filled = call(
    'fill',
    'start_session',
    { proposal_id: 'task_docs', prompt: 'Write docs', background: 'Context' },
    { status: 'started', task_id: 'task_docs', chat_id: 'docs', title: 'Docs' },
  );
  assert.equal(summarizeSteps([...itemSteps(accepted as any), ...itemSteps(filled as any)]).text, 'Started a session');
  assert.equal(
    summarizeSteps([...itemSteps(accepted as any), ...itemSteps(filled as any), ...itemSteps(started as any)]).text,
    'Started 2 sessions',
  );
  assert.equal(summarizeSteps([...itemSteps(started as any), ...itemSteps(started as any)]).text, 'Started a session');
  const pending = call('pending', 'start_session', { initiation: 'user_asked' }, null);
  const handoff = call('handoff', 'hand_off_to_session', {}, { status: 'started', chat_id: 'handed', title: 'Elsewhere' });
  assert.equal(summarizeSteps([...itemSteps(pending as any), ...itemSteps(handoff as any)]).text, 'Started 2 sessions');
});

test('sessions started back to back are one stack in the turn, in view while its work folds, and the thinking row follows it', async () => {
  const second = {
    ...started,
    id: 's4',
    result: out({ status: 'started', chat_id: 'child-2', title: 'UI', name: 'ui', worktree: true, context: 'fresh' }),
  };
  chat([turn('t1', [user('u1', 'Split it'), started, second, reply('r1', 'Started both.')])]);
  const v = await render(view());
  await flush();
  const stack = v.$('.session-stack');
  assert.ok(stack, 'the two cards share one stack');
  assert.deepEqual(
    [...stack!.querySelectorAll('[data-stub="TaskProposalCard"]')].map((c: any) => c.dataset.session),
    ['child-1', 'child-2'],
  );
  assert.equal(v.$$('[data-stub="TaskProposalCard"]').length, 2, 'each card once, inside the stack');
  // while the turn runs, a stack as its last block is followed by the thinking row, as a card is
  chat([turn('t1', [user('u1', 'Split it'), started, second], { status: 'inProgress' })], { activeTurnId: 't1' });
  await flush();
  assert.ok(v.$('.session-stack'));
  assert.equal(v.$('.turn-status-slot .claude-activity .working-mark')?.getAttribute('data-activity'), 'think');
  await v.unmount();
});
