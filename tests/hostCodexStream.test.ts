// What a Codex turn says on the Host's stream (host/src/codexStream.mjs): turns open once however they are first heard, cards close with their turn, and the options of a card map to the answers the app-server takes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APPROVAL_OPTIONS, approvalAnswer, createCodexStream, isApproval } from '../host/src/codexStream.mjs';

function setup(chats: Record<string, string | null> = { th: 'chat' }) {
  const events: any[] = [];
  const stream = createCodexStream({ chatOf: (t: string) => chats[t] ?? null, emit: (e: any) => events.push(e) });
  return { stream, events };
}

test('approvals: which requests are asked, and the answer each option sends', () => {
  assert.equal(isApproval('item/commandExecution/requestApproval'), true);
  assert.equal(isApproval('applyPatchApproval'), true);
  assert.equal(isApproval('item/tool/requestUserInput'), false);
  assert.deepEqual(
    APPROVAL_OPTIONS.map((o) => o.kind),
    ['allow_once', 'allow_always', 'reject_once'],
  );
  const v2 = 'item/fileChange/requestApproval';
  assert.deepEqual(
    ['allow_once', 'allow_always', 'reject_once', undefined].map((o) => approvalAnswer(v2, o).decision),
    ['accept', 'acceptForSession', 'decline', 'cancel'],
  );
  const legacy = 'execCommandApproval';
  assert.deepEqual(
    ['allow_once', 'allow_always', 'reject_once', undefined].map((o) => approvalAnswer(legacy, o).decision),
    ['approved', 'approved_for_session', 'denied', 'abort'],
  );
});

test('a turn opens once, whether the notification or the adapter names it first, and ends with the app-server’s status', () => {
  const { stream, events } = setup();
  stream.started('chat', 't1');
  stream.notification({ method: 'turn/started', params: { threadId: 'th', turn: { id: 't1' } } });
  stream.notification({ method: 'item/agentMessage/delta', params: { threadId: 'th', turnId: 't1', itemId: 'i', delta: 'hi' } });
  assert.deepEqual(stream.openTurns(), new Map([['t1', 'chat']]));
  stream.notification({ method: 'turn/completed', params: { threadId: 'th', turn: { id: 't1', status: 'completed' } } });
  assert.deepEqual(
    events.map((e) => [e.kind, e.stopReason ?? e.update?.content.text]),
    [
      ['turnStart', undefined],
      ['update', 'hi'],
      ['turnEnd', 'end_turn'],
    ],
  );
  // a turn that was never opened, or already ended, ends nothing
  stream.notification({ method: 'turn/completed', params: { threadId: 'th', turn: { id: 't1', status: 'completed' } } });
  assert.equal(events.length, 3);
});

test('a delta that comes first opens its turn; failed and interrupted turns say how they ended', () => {
  const { stream, events } = setup();
  stream.notification({ method: 'item/agentMessage/delta', params: { threadId: 'th', turnId: 'a', delta: 'x' } });
  stream.notification({ method: 'turn/completed', params: { threadId: 'th', turn: { id: 'a', status: 'interrupted' } } });
  stream.started('chat', 'b');
  stream.notification({
    method: 'turn/completed',
    params: { threadId: 'th', turn: { id: 'b', status: 'failed', error: { message: 'boom' } } },
  });
  stream.started('chat', 'c');
  stream.notification({ method: 'turn/completed', params: { threadId: 'th', turn: { id: 'c', status: 'failed' } } });
  const ends = events.filter((e) => e.kind === 'turnEnd');
  assert.deepEqual(
    ends.map((e) => [e.stopReason, e.error?.message]),
    [
      ['cancelled', undefined],
      ['error', 'boom'],
      ['error', 'The turn failed.'],
    ],
  );
});

test('notifications of a thread no chat shows, or with nothing to say, are ignored', () => {
  const { stream, events } = setup({ th: 'chat', helper: null });
  stream.notification({ method: 'turn/started', params: { threadId: 'helper', turn: { id: 'h' } } });
  stream.notification({ method: 'turn/started', params: {} });
  stream.notification({ method: 'turn/started', params: { threadId: 'th' } });
  stream.notification({ method: 'item/agentMessage/delta', params: { threadId: 'th', turnId: 'x' } });
  stream.notification({ method: 'thread/name/updated', params: { threadId: 'th' } });
  stream.notification({ method: 'turn/completed' });
  assert.deepEqual(events, []);
});

test('a card is shown with its request, closed when it is answered elsewhere, and goes with its turn', () => {
  const { stream, events } = setup();
  stream.started('chat', 't1');
  const a = stream.request(
    { id: 0, method: 'item/commandExecution/requestApproval', params: { turnId: 't1', itemId: 'cmd-9', command: 'ls -l' } },
    'chat',
  );
  const b = stream.request({ id: 1, method: 'applyPatchApproval', params: { command: ['git', 'status'] } }, 'chat');
  const c = stream.request({ id: 2, method: 'item/fileChange/requestApproval', params: { turnId: 't1', reason: 'edit a file' } }, 'chat');
  const d = stream.request({ id: 3, method: 'item/fileChange/requestApproval', params: {} }, 'chat');
  stream.request({ id: 4, method: 'item/fileChange/requestApproval' }, 'chat');
  const cards = events.filter((e) => e.kind === 'permission');
  assert.deepEqual(cards.map((e) => e.toolCall).slice(0, 4), [
    { title: 'ls -l', kind: 'execute', toolCallId: 'cmd-9' },
    { title: 'git status', kind: 'execute' },
    { title: 'edit a file', kind: 'edit' },
    { title: 'Change files', kind: 'edit' },
  ]);
  assert.equal(stream.card(a)?.method, 'item/commandExecution/requestApproval');
  // the app-server withdrew one; answering it again finds nothing
  stream.notification({ method: 'serverRequest/resolved', params: { threadId: 'th', requestId: 1 } });
  assert.equal(stream.card(b), undefined);
  assert.equal(stream.settle(b), false);
  // one is taken to be answered: no event, and it is gone
  assert.equal(stream.take(d)?.id, 3);
  assert.equal(stream.take(d), undefined);
  // the turn ends with a card open: the card closes first
  stream.notification({ method: 'turn/completed', params: { threadId: 'th', turn: { id: 't1', status: 'completed' } } });
  const closed = events.filter((e) => e.kind === 'permissionCancelled').map((e) => e.requestId);
  assert.deepEqual(closed.slice(0, 3), [b, a, c]);
  assert.ok(events.indexOf(events.find((e) => e.kind === 'turnEnd')) > events.findLastIndex((e) => e.kind === 'permissionCancelled'));
});

test('the app-server going away ends every open turn and card, and the next process’s requests get new ids', () => {
  const { stream, events } = setup();
  stream.started('chat', 't1');
  const first = stream.request({ id: 0, method: 'item/commandExecution/requestApproval', params: { turnId: 'other' } }, 'chat');
  stream.exited('Codex quit while working.');
  assert.deepEqual(
    events.slice(-2).map((e) => e.kind),
    ['turnEnd', 'permissionCancelled'],
  );
  assert.equal(stream.openTurns().size, 0);
  const second = stream.request({ id: 0, method: 'item/commandExecution/requestApproval', params: {} }, 'chat');
  assert.notEqual(first, second);
});

const startOf = (events: any[], turnId: string) => events.filter((e) => e.kind === 'turnStart' && e.turnId === turnId);
const userText = (e: any) => e.user?.content?.[0]?.text;

test('#3599: a turn started for a message carries its text, whether the notification or the adapter names it first', () => {
  const { stream, events } = setup();
  // the notification first: the start waits for the adapter, which names the message
  stream.notification({ method: 'turn/started', params: { threadId: 'th', turn: { id: 't1' } } });
  assert.deepEqual(startOf(events, 't1'), []);
  stream.started('chat', 't1', 'run the nightly check');
  assert.deepEqual(startOf(events, 't1'), [
    {
      kind: 'turnStart',
      key: 'chat',
      turnId: 't1',
      user: { id: 'u-t1', clientId: 't1', content: [{ type: 'text', text: 'run the nightly check' }] },
    },
  ]);
  // the adapter first: the start carries the text at once, and the notification after it changes nothing
  stream.started('chat', 't2', 'second');
  stream.notification({ method: 'turn/started', params: { threadId: 'th', turn: { id: 't2' } } });
  assert.deepEqual(startOf(events, 't2').map(userText), ['second']);
});

test('#3599: a turn nobody asked (the agent’s own) starts with no user message before the first thing it says, its card or its end', () => {
  const said = setup();
  said.stream.notification({ method: 'turn/started', params: { threadId: 'th', turn: { id: 'g1' } } });
  said.stream.notification({ method: 'item/agentMessage/delta', params: { threadId: 'th', turnId: 'g1', itemId: 'i', delta: 'hi' } });
  assert.deepEqual(
    said.events.map((e) => e.kind),
    ['turnStart', 'update'],
  );
  assert.equal(said.events[0].user, undefined);
  // the adapter naming it afterwards adds nothing
  said.stream.started('chat', 'g1', 'late');
  assert.equal(startOf(said.events, 'g1').length, 1);

  const carded = setup();
  carded.stream.notification({ method: 'turn/started', params: { threadId: 'th', turn: { id: 'g2' } } });
  carded.stream.request({ id: 3, method: 'item/commandExecution/requestApproval', params: { turnId: 'g2', command: 'ls' } }, 'chat');
  assert.deepEqual(
    carded.events.map((e) => e.kind),
    ['turnStart', 'permission'],
  );

  const ended = setup();
  ended.stream.notification({ method: 'turn/started', params: { threadId: 'th', turn: { id: 'g3' } } });
  ended.stream.notification({ method: 'turn/completed', params: { threadId: 'th', turn: { id: 'g3', status: 'completed' } } });
  assert.deepEqual(
    ended.events.map((e) => e.kind),
    ['turnStart', 'turnEnd'],
  );

  // the app-server quits with a turn still unnamed: it starts, then ends with the reason
  const quit = setup();
  quit.stream.notification({ method: 'turn/started', params: { threadId: 'th', turn: { id: 'g4' } } });
  quit.stream.exited('Codex quit while working.');
  assert.deepEqual(
    quit.events.map((e) => [e.kind, e.error?.message]),
    [
      ['turnStart', undefined],
      ['turnEnd', 'Codex quit while working.'],
    ],
  );
  // a card that names no turn starts the chat's waiting turns first, never another chat's
  const loose = setup({ th: 'chat', th2: 'other' });
  loose.stream.notification({ method: 'turn/started', params: { threadId: 'th', turn: { id: 'g5' } } });
  loose.stream.notification({ method: 'turn/started', params: { threadId: 'th2', turn: { id: 'o1' } } });
  loose.stream.request({ id: 4, method: 'item/commandExecution/requestApproval', params: { command: 'ls' } }, 'chat');
  assert.deepEqual(
    loose.events.map((e) => [e.kind, e.turnId]),
    [
      ['turnStart', 'g5'],
      ['permission', undefined],
    ],
  );
});

test('#4000: a sub-agent’s request names a turn the stream never opened: its card goes with the chat’s running turn, or none when no turn runs', () => {
  const { stream, events } = setup();
  stream.notification({ method: 'turn/started', params: { threadId: 'th', turn: { id: 't1' } } });
  stream.request({ id: 5, method: 'item/commandExecution/requestApproval', params: { turnId: 'sub-turn', command: 'ls' } }, 'chat', true);
  assert.equal(events.find((e) => e.kind === 'permission').turnId, 't1');
  stream.notification({ method: 'turn/completed', params: { threadId: 'th', turn: { id: 't1', status: 'completed' } } });
  assert.deepEqual(
    events.filter((e) => e.kind === 'permissionCancelled').map((e) => e.requestId),
    ['codex-0-5'],
  );
  // with no turn open the card names none (and is closed by the app-server's resolution or its exit)
  stream.request({ id: 6, method: 'item/commandExecution/requestApproval', params: { turnId: 'sub-turn' } }, 'chat', true);
  assert.equal(events.at(-1).turnId, undefined);
});

test('#4000: the app-server settling a sub-agent’s request closes its card, though no chat shows the sub-agent’s thread', () => {
  const { stream, events } = setup();
  stream.notification({ method: 'turn/started', params: { threadId: 'th', turn: { id: 't1' } } });
  stream.request({ id: 8, method: 'item/fileChange/requestApproval', params: { turnId: 'sub-turn' } }, 'chat', true);
  stream.notification({ method: 'serverRequest/resolved', params: { threadId: 'sub-th', requestId: 8 } });
  assert.deepEqual(
    events.filter((e) => e.kind === 'permissionCancelled').map((e) => e.requestId),
    ['codex-0-8'],
  );
});

test('a stopped turn stays ended: a tool result or start heard after its end opens nothing, and the next turn’s words are its own', () => {
  const { stream, events } = setup();
  stream.started('chat', 'old', 'sleep then say done');
  stream.notification({
    method: 'item/started',
    params: { threadId: 'th', turnId: 'old', item: { type: 'commandExecution', id: 'c1', command: 'sleep 90' } },
  });
  stream.notification({ method: 'turn/completed', params: { threadId: 'th', turn: { id: 'old', status: 'interrupted' } } });
  stream.started('chat', 'next', 'say again');
  // the app-server's late word about the stopped turn, then the new turn's own reply and a report that names no turn
  stream.notification({ method: 'turn/started', params: { threadId: 'th', turn: { id: 'old' } } });
  stream.notification({
    method: 'item/completed',
    params: {
      threadId: 'th',
      turnId: 'old',
      item: { type: 'commandExecution', id: 'c1', command: 'sleep 90', aggregatedOutput: '', status: 'declined' },
    },
  });
  stream.notification({ method: 'item/agentMessage/delta', params: { threadId: 'th', turnId: 'next', itemId: 'm', delta: 'again' } });
  assert.deepEqual(stream.openTurns(), new Map([['next', 'chat']]), 'only the new turn is open');
  assert.deepEqual(
    events.filter((e) => e.kind === 'turnStart').map((e) => e.turnId),
    ['old', 'next'],
    'the stopped turn is not started a second time',
  );
  assert.deepEqual(
    events.filter((e) => e.update?.sessionUpdate === 'agent_message_chunk').map((e) => [e.turnId, e.update.content.text]),
    [['next', 'again']],
  );
});

test('only the newest ended turns are remembered', () => {
  const { stream, events } = setup();
  for (let i = 0; i < 201; i++) {
    stream.started('chat', `t${i}`);
    stream.notification({ method: 'turn/completed', params: { threadId: 'th', turn: { id: `t${i}`, status: 'completed' } } });
  }
  events.length = 0;
  stream.notification({ method: 'item/agentMessage/delta', params: { threadId: 'th', turnId: 't200', itemId: 'm', delta: 'x' } });
  assert.equal(events.length, 0, 'a recent turn stays ended');
  stream.notification({ method: 'item/agentMessage/delta', params: { threadId: 'th', turnId: 't0', itemId: 'm', delta: 'x' } });
  assert.equal(events.filter((e) => e.kind === 'turnStart').length, 1, 'the oldest was let go');
});

test('a permissions request is a card like a command’s: allow grants what was asked for the turn or the session, a refusal or a dismissed card grants nothing', () => {
  const m = 'item/permissions/requestApproval';
  const asked = { network: { enabled: true } };
  assert.equal(isApproval(m), true);
  assert.deepEqual(approvalAnswer(m, 'allow_once', asked), { permissions: asked, scope: 'turn' });
  assert.deepEqual(approvalAnswer(m, 'allow_always', asked), { permissions: asked, scope: 'session' });
  assert.deepEqual(approvalAnswer(m, 'reject_once', asked), { permissions: {}, scope: 'turn' });
  assert.deepEqual(approvalAnswer(m, undefined), { permissions: {}, scope: 'turn' });
  const { stream, events } = setup();
  const a = stream.request({ id: 7, method: m, params: { turnId: 't', itemId: 'p1', reason: 'fetch a page', permissions: asked } }, 'chat');
  const b = stream.request({ id: 8, method: m, params: { turnId: 't', permissions: undefined } }, 'chat');
  assert.deepEqual(stream.card(a)?.permissions, asked);
  assert.deepEqual(stream.card(b)?.permissions, {});
  assert.deepEqual(
    events.filter((e) => e.kind === 'permission').map((e) => e.toolCall),
    [
      { title: 'fetch a page', kind: 'other', toolCallId: 'p1' },
      { title: 'Additional permissions', kind: 'other' },
    ],
  );
});

test('a new app-server process may reuse a turn id: what the old one ended does not silence it', () => {
  const { stream, events } = setup();
  stream.started('chat', 'turn-1');
  stream.exited('quit');
  stream.started('chat', 'turn-1');
  stream.notification({ method: 'item/agentMessage/delta', params: { threadId: 'th', turnId: 'turn-1', itemId: 'm', delta: 'hi' } });
  assert.deepEqual(
    events.filter((e) => e.update).map((e) => e.update.content.text),
    ['hi'],
  );
});

test('J8: the adapter naming a turn that already ended (its reply to turn/start came after the turn finished) opens nothing, so the chat is not left running', () => {
  const { stream, events } = setup();
  stream.notification({ method: 'turn/started', params: { threadId: 'th', turn: { id: 't1' } } });
  stream.notification({ method: 'item/agentMessage/delta', params: { threadId: 'th', turnId: 't1', itemId: 'i', delta: 'done' } });
  stream.notification({ method: 'turn/completed', params: { threadId: 'th', turn: { id: 't1', status: 'completed' } } });
  stream.started('chat', 't1', 'what was asked');
  assert.deepEqual(
    events.map((e) => e.kind),
    ['turnStart', 'update', 'turnEnd'],
    'one start, one end: no start after the end',
  );
  assert.deepEqual(stream.openTurns(), new Map());
  // a turn the adapter names first is still told with what was asked
  stream.started('chat', 't2', 'next question');
  assert.deepEqual(events.at(-1).user.content, [{ type: 'text', text: 'next question' }]);
});

test('J8: the end of a turn nothing had opened is remembered, so the adapter naming that turn afterwards opens nothing', () => {
  const { stream, events } = setup({ th: 'chat' });
  stream.notification({ method: 'turn/completed', params: { threadId: 'th', turn: { id: 't9', status: 'completed' } } });
  stream.started('chat', 't9', 'late');
  assert.equal(events.length, 0, 'a turn told neither started nor ended, never half of it');
  assert.deepEqual(stream.openTurns(), new Map());
  // the next turn of the chat is unaffected
  stream.started('chat', 't10', 'next');
  assert.deepEqual(
    events.map((e) => [e.kind, e.turnId]),
    [['turnStart', 't10']],
  );
});
