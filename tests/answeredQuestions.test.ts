// What a question card was answered with, kept in the transcript (src/lib/answeredQuestions.ts, src/store/answersNote.ts,
// the answers note in src/lib/chatMeta.ts) for every harness whose questions go through QuestionCard.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { answeredQuestions, answeredSummary, unanswered, NO_PREFERENCE, DISMISSED_ANSWER } from '../src/lib/answeredQuestions.ts';
import { withChatNotes, type ChatNote } from '../src/lib/chatMeta.ts';
import { loadStore, resetAll, impl, flush } from './support/store-harness.ts';

const { store, resetState } = await loadStore();
const answers = await import('../src/store/answersNote.ts');
const st = () => store.useStore.getState();
const set = store.useStore.setState;
beforeEach(() => {
  resetState();
  resetAll();
});

const QS = [
  { id: 'scope', question: 'Replace the look, or add a style?' },
  { id: 'rail', question: '  What happens to the rail?  ' },
  { id: 'empty', question: '   ' },
];

test('each asked question pairs with its answer in order; several choices read as a list, a blank one is skipped', () => {
  assert.deepEqual(
    answeredQuestions(QS, { answers: { scope: { answers: ['Replace entirely'] }, rail: { answers: ['Fold into sidebar', ' ', 'Keep'] } } }),
    [
      { question: 'Replace the look, or add a style?', answer: 'Replace entirely' },
      { question: 'What happens to the rail?', answer: 'Fold into sidebar, Keep' },
    ],
  );
  // a secret's text is never kept, only that it was given
  assert.deepEqual(
    answeredQuestions(
      [
        { id: 'c', question: 'Token?', isSecret: true },
        { id: 'd', question: 'Other secret?', isSecret: true },
      ],
      {
        answers: { c: { answers: ['s3cret'] }, d: { answers: [] } },
      },
    ),
    [
      { question: 'Token?', answer: 'Hidden' },
      { question: 'Other secret?', answer: null },
    ],
  );
  // dismissing the card answers nothing; an inherited name is not an answer
  assert.deepEqual(answeredQuestions([{ id: 'toString', question: 'Q?' }], { answers: {} }), [{ question: 'Q?', answer: null }]);
  assert.deepEqual(answeredQuestions([], { answers: {} }), []);
});

test("Claude Code's words for no answer read as skipped or dismissed, never as the answer, a secret's included", () => {
  assert.equal(unanswered(NO_PREFERENCE), 'skipped');
  assert.equal(unanswered('  '), 'skipped');
  assert.equal(unanswered(undefined), 'skipped');
  assert.equal(unanswered(` ${DISMISSED_ANSWER} `), 'dismissed');
  assert.equal(unanswered('Chat'), null);
  assert.deepEqual(
    answeredQuestions(
      [
        { id: 'a', question: 'A?' },
        { id: 'b', question: 'B?', isSecret: true },
        { id: 'c', question: 'C?' },
        { id: 'd', question: 'D?' },
      ],
      {
        answers: {
          a: { answers: [NO_PREFERENCE] },
          b: { answers: [NO_PREFERENCE] },
          c: { answers: [DISMISSED_ANSWER] },
          // a multiple choice that happens to hold the words is still the answer
          d: { answers: ['x', NO_PREFERENCE] },
        },
      },
    ),
    [
      { question: 'A?', answer: null },
      { question: 'B?', answer: null },
      { question: 'C?', answer: null, dismissed: true },
      { question: 'D?', answer: `x, ${NO_PREFERENCE}` },
    ],
  );
  assert.equal(answeredSummary([{ question: 'a', answer: null, dismissed: true }]), 'Dismissed a question');
  assert.equal(
    answeredSummary([
      { question: 'a', answer: null, dismissed: true },
      { question: 'b', answer: null, dismissed: true },
    ]),
    'Dismissed the questions',
  );
});

test('the summary counts what was answered', () => {
  assert.equal(answeredSummary([{ question: 'a', answer: 'x' }]), 'Answered a question');
  assert.equal(
    answeredSummary([
      { question: 'a', answer: 'x' },
      { question: 'b', answer: 'y' },
      { question: 'c', answer: null },
    ]),
    'Answered 2 questions',
  );
  assert.equal(answeredSummary([{ question: 'a', answer: null }]), 'Skipped a question');
  assert.equal(
    answeredSummary([
      { question: 'a', answer: null },
      { question: 'b', answer: null },
    ]),
    'Skipped the questions',
  );
});

test('answersNote puts the card after the last turn and keeps it in the chat notes, for any harness', () => {
  const result = { answers: { scope: { answers: ['Replace entirely'] } } };
  assert.equal(answers.answersNote('none', QS, result), false, 'no chat');
  set({
    runtime: {
      codex: { turns: [{ id: 'pending-1', items: [] }] },
      claude: { turns: [{ id: 't9', items: [] }] },
    } as any,
  });
  assert.equal(answers.answersNote('claude', [QS[2]], result), false, 'nothing asked');
  for (const chat of ['codex', 'claude']) assert.equal(answers.answersNote(chat, QS, result), true);
  const note = st().chatNotes.claude[0];
  assert.equal(note.kind, 'answers');
  assert.equal(note.turnId, 't9');
  assert.equal(st().chatNotes.codex[0].turnId, null, 'a pending turn is found again by its place');
  assert.equal(note.text, 'Answered a question');
  assert.deepEqual(note.answers, [
    { question: 'Replace the look, or add a style?', answer: 'Replace entirely' },
    { question: 'What happens to the rail?', answer: null },
  ]);
  const [item] = st().runtime.claude.turns[0].items as any[];
  assert.deepEqual([item.type, item.kind, item.id, item.answers], ['statusNote', 'answers', note.id, note.answers]);
});

test('a reloaded chat gets its answers card back after the turn it followed', () => {
  const note: ChatNote = {
    id: 'answers-1',
    kind: 'answers',
    text: 'Answered a question',
    answers: [{ question: 'Q?', answer: 'A' }],
    turnId: 'ct-u2',
    turn: 0,
    at: 1,
  };
  const turns = [
    { id: 'h-u1', items: [] },
    { id: 'h-u2', items: [] },
  ];
  const shown = withChatNotes(turns, [note]);
  assert.deepEqual(shown[1].items, [
    { type: 'statusNote', id: 'answers-1', kind: 'answers', text: 'Answered a question', answers: note.answers },
  ]);
  // an account note carries no answers
  const account = withChatNotes(turns, [{ ...note, id: 'n2', kind: 'account', answers: undefined }]);
  assert.equal('answers' in (account[1].items[0] as object), false);
});

test('a question answer, once delivered, is kept as the card; one that failed to send, or any other answer, is not', async () => {
  set({ runtime: { c: { turns: [{ id: 't1', items: [] }] } } as any });
  const ask = (id: string | number, threadId: string | null = 'c', method = 'item/tool/requestUserInput') =>
    ({ id, method, threadId, params: { questions: QS.slice(0, 1) } }) as any;
  const answer = { answers: { scope: { answers: ['Replace entirely'] } } };
  // Codex's request_user_input and Claude Code's AskUserQuestion (a cperm- card) alike
  impl['codex.respondToCodex'] = async () => true;
  impl['claude.resolveClaudeRequest'] = async () => true;
  set({ pending: [ask(1), ask('cperm-2'), ask(3, 'c', 'item/commandExecution/requestApproval'), ask(4, null)] });
  for (const id of [1, 'cperm-2', 3, 4]) store.resolveRequest(id, answer);
  await flush();
  assert.deepEqual(
    st().chatNotes.c.map((n) => [n.kind, n.answers]),
    [
      ['answers', [{ question: 'Replace the look, or add a style?', answer: 'Replace entirely' }]],
      ['answers', [{ question: 'Replace the look, or add a style?', answer: 'Replace entirely' }]],
    ],
  );
  // the send failed: the card comes back to be answered again, and nothing is kept
  impl['codex.respondToCodex'] = async () => {
    throw new Error('main is gone');
  };
  set({ pending: [ask(5)] });
  store.resolveRequest(5, answer);
  await flush();
  assert.equal(st().chatNotes.c.length, 2);
  // a card that asked nothing keeps nothing
  impl['codex.respondToCodex'] = async () => true;
  set({ pending: [{ id: 6, method: 'item/tool/requestUserInput', threadId: 'c', params: {} }] as any });
  store.resolveRequest(6, { answers: {} });
  await flush();
  assert.equal(st().chatNotes.c.length, 2);
});
