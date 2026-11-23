// What Codex asks a person besides an approval (host/src/codexAsk.mjs, host/src/codexStream.mjs `ask`): its user-input questions and an MCP server's elicitation as a form card, a sign-in link as a card that shows it, and the reply each takes back. A: the cards and replies; B: what this Host cannot ask is declined, not left waiting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ELICITATION, LINK_OPTIONS, USER_INPUT, askOf, isAsk, replyOf, unanswered } from '../host/src/codexAsk.mjs';
import { createCodexStream } from '../host/src/codexStream.mjs';

const QUESTIONS = [
  { id: 'q1', header: 'Language', question: 'Which language?', options: [{ label: 'JS' }, { label: 'Rust' }] },
  { id: 'q2', question: 'Pick some', multiSelect: true, options: [{ label: 'a' }, { label: 'b' }] },
  { id: 'q3', header: 'Note', question: 'Anything else?' },
];
const plain = (o: any) => JSON.parse(JSON.stringify(o));

test('A: user-input questions are one form: a menu, a multi-menu and a line of text; the answers come back as the app-server reads them', () => {
  assert.equal(isAsk(USER_INPUT) && isAsk(ELICITATION), true);
  assert.equal(isAsk('item/commandExecution/requestApproval'), false);
  const ask = askOf(USER_INPUT, { questions: QUESTIONS })!;
  assert.deepEqual(
    ask.form!.fields.map((f: any) => [f.key, f.type, f.required]),
    [
      ['q1', 'string', true],
      ['q2', 'array', true],
      ['q3', 'string', true],
    ],
  );
  const card = { method: USER_INPUT, ask };
  const given = { action: 'accept', content: { q1: 'Rust', q2: ['a', 'b'], q3: 'no' } };
  assert.deepEqual(plain(replyOf(card, { form: given })), {
    answers: { q1: { answers: ['Rust'] }, q2: { answers: ['a', 'b'] }, q3: { answers: ['no'] } },
  });
  // a decline or a cancel skips them; values that do not fit skip them too
  assert.deepEqual(replyOf(card, { form: { action: 'decline' } }), { answers: {} });
  assert.deepEqual(replyOf(card, { form: { action: 'accept', content: { q1: 'Go' } } }), { answers: {} });
  assert.deepEqual(replyOf(card, {}), { answers: {} });
});

test('A: an MCP server’s form is a form card and its values come back as an accept; a sign-in link is a link card', () => {
  const schema = { type: 'object', properties: { who: { type: 'string', title: 'Who' } }, required: ['who'] };
  const ask = askOf(ELICITATION, { message: 'Hello?', serverName: 'srv', mode: 'form', requestedSchema: schema })!;
  assert.equal(ask.said, 'Hello?');
  const card = { method: ELICITATION, ask };
  assert.deepEqual(plain(replyOf(card, { form: { action: 'accept', content: { who: 'Ada' } } })), {
    action: 'accept',
    content: { who: 'Ada' },
    _meta: null,
  });
  assert.deepEqual(replyOf(card, { form: { action: 'cancel' } }), { action: 'cancel', content: null, _meta: null });
  assert.deepEqual(replyOf(card, { form: { action: 'accept', content: { who: 1 } } }), unanswered(ELICITATION));
  const link = askOf(ELICITATION, { serverName: 'srv', mode: 'url', url: 'https://x.test/login' })!;
  assert.deepEqual([link.said, link.link], ['srv needs input', 'https://x.test/login']);
  assert.equal(askOf(ELICITATION, { mode: 'url' })!.link, null);
  assert.equal(askOf(ELICITATION, { mode: 'url' })!.said, 'A tool needs input');
  assert.deepEqual(replyOf({ method: ELICITATION, ask: link }, { optionId: 'done' }), { action: 'accept', content: null, _meta: null });
  assert.deepEqual(replyOf({ method: ELICITATION, ask: link }, { optionId: 'cancel' }), { action: 'cancel', content: null, _meta: null });
  assert.deepEqual(
    LINK_OPTIONS.map((o) => o.optionId),
    ['done', 'cancel'],
  );
});

test('B: a request this Host cannot draw (no questions, a form with no fields, a computer-use approval) is none, and is told as declined', () => {
  assert.equal(askOf(USER_INPUT, { questions: [] }), null);
  assert.equal(askOf(USER_INPUT, {}), null);
  assert.equal(askOf(USER_INPUT, { questions: [null, { question: 'no id' }] }), null);
  assert.equal(askOf(ELICITATION, { mode: 'form', requestedSchema: { type: 'object', properties: {} } }), null);
  assert.deepEqual(unanswered(USER_INPUT), { answers: {} });
  assert.deepEqual(unanswered(ELICITATION), { action: 'decline', content: null, _meta: null });
});

test('A: the stream shows a question on the chat’s running turn (a sub-agent’s too), a link as a card, and says no for what it cannot draw', () => {
  const events: any[] = [];
  const stream = createCodexStream({ chatOf: (t: string) => (t === 'th' ? 'chat' : null), emit: (e: any) => events.push(e) });
  stream.notification({ method: 'turn/started', params: { threadId: 'th', turn: { id: 't1' } } });
  assert.equal(stream.ask({ id: 1, method: USER_INPUT, params: { turnId: 't1', questions: QUESTIONS } }, 'chat'), true);
  const q = events.find((e) => e.kind === 'question');
  assert.deepEqual([q.key, q.turnId, q.question.id, q.question.message], ['chat', 't1', 'codex-0-1', 'A question for you']);
  assert.equal(stream.card('codex-0-1')!.ask!.questions!.length, 3);
  assert.equal(
    stream.ask(
      { id: 2, method: ELICITATION, params: { turnId: 'sub-turn', mode: 'url', serverName: 's', url: 'https://x.test' } },
      'chat',
      true,
    ),
    true,
  );
  const link = events.find((e) => e.kind === 'permission');
  assert.deepEqual([link.turnId, link.options, link.toolCall.title], ['t1', LINK_OPTIONS, 's needs input https://x.test']);
  assert.equal(stream.ask({ id: 3, method: USER_INPUT, params: {} }, 'chat'), false);
  assert.equal(stream.card('codex-0-3'), undefined);
  // the chat's turn ending closes both cards
  stream.notification({ method: 'turn/completed', params: { threadId: 'th', turn: { id: 't1', status: 'completed' } } });
  assert.deepEqual(
    events
      .filter((e) => e.kind === 'permissionCancelled')
      .map((e) => e.requestId)
      .sort(),
    ['codex-0-1', 'codex-0-2'],
  );
  // a link with no URL, and no turn open: the card names none
  assert.equal(stream.ask({ id: 4, method: ELICITATION, params: { mode: 'url' } }, 'chat'), true);
  assert.equal(events.at(-1).turnId, undefined);
});

test('B: a question with no params or no open turn is told with what it has', () => {
  const events: any[] = [];
  const stream = createCodexStream({ chatOf: () => 'chat', emit: (e: any) => events.push(e) });
  assert.equal(stream.ask({ id: 1, method: USER_INPUT }, 'chat'), false);
  assert.equal(stream.ask({ id: 2, method: USER_INPUT, params: { questions: [{ id: 'a', question: 'Sure?' }] } }, 'chat'), true);
  assert.equal(events.find((e) => e.kind === 'question').turnId, undefined);
});

test('B: a question This Mac’s card draws carries the questions as asked, and its answers (an Other, a skip) go to the agent as the card gave them', () => {
  const ask = askOf(USER_INPUT, { questions: QUESTIONS })!;
  assert.deepEqual(
    ask.asked!.map((q: any) => [q.id, q.isOther, q.multiSelect]),
    [
      ['q1', true, false],
      ['q2', true, true],
      ['q3', true, false],
    ],
  );
  const card = { method: USER_INPUT, ask };
  const own = {
    action: 'accept',
    content: { answers: { q1: { answers: ['Something else'] }, q2: { answers: ['[No preference]'] }, q3: { answers: ['typed'] } } },
  };
  assert.deepEqual(plain(replyOf(card, { form: own })), own.content);
  // an accept with no answers of the card's kind is checked against the form, as before
  assert.deepEqual(plain(replyOf(card, { form: { action: 'accept', content: { q1: 'Rust', q2: ['a'], q3: 'x' } } })), {
    answers: { q1: { answers: ['Rust'] }, q2: { answers: ['a'] }, q3: { answers: ['x'] } },
  });
  // a question the card cannot draw (no asked list) keeps the form's own check
  const bare = askOf(USER_INPUT, { questions: [{ id: 'q1', question: '', options: [{ label: 'a' }] }] });
  assert.deepEqual(bare!.asked, []);
  assert.deepEqual(replyOf({ method: USER_INPUT, ask: bare! }, { form: own }), { answers: {} });
});
