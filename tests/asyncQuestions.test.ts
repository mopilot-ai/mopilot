import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  asyncAnswersReady,
  hasAsyncQuestions,
  sendAsyncAnswers,
  splitTurn,
  splitWorkChunks,
  submittedAsyncAnswers,
} from '../src/lib/asyncQuestions.ts';
import { turnCard } from '../src/harness/codexTranslate.ts';

const questions = [
  { title: 'Which view?', options: ['Chat', 'Window'] },
  { title: 'Which harness?', options: null },
];
const question = { type: 'agentMessage', id: 'q', text: '', phase: null, delivery: 'async', questions } as any;
const command = { type: 'commandExecution', id: 'cmd', status: 'inProgress' } as any;
const answer = { type: 'agentMessage', id: 'final', text: 'Done', phase: 'final_answer', questions: null } as any;

test('async questions with no fallback text survive completion and stay outside collapsed tool work', () => {
  for (const running of [true, false]) {
    const turn = splitTurn([command, question, answer], running);
    assert.equal(turn.final, answer);
    const chunks = splitWorkChunks(turn.work);
    assert.deepEqual(chunks, [
      { kind: 'work', items: [command] },
      { kind: 'head', item: question },
    ]);
  }
});

test('questions never become final replies when they are the last message or carry a final phase', () => {
  for (const phase of [null, 'commentary', 'final_answer']) {
    const q = { ...question, text: 'Pick one', phase };
    for (const running of [true, false]) {
      assert.equal(splitTurn([command, q], running).final, null);
      assert.deepEqual(splitWorkChunks(splitTurn([command, q], running).work).at(-1), { kind: 'head', item: q });
    }
  }
});

test('questions preserve transcript order with tool work, user follow-ups, and status notes', () => {
  const user = { type: 'userMessage', id: 'u', content: [] } as any;
  const note = { type: 'statusNote', id: 'note' } as any;
  const second = { ...command, id: 'cmd2' };
  assert.deepEqual(splitWorkChunks([command, question, user, second, note]), [
    { kind: 'work', items: [command] },
    { kind: 'head', item: question },
    { kind: 'head', item: user },
    { kind: 'work', items: [second] },
    { kind: 'head', item: note },
  ]);
});

test('a named item (a plan approved mid-turn) stays outside the work, in transcript order', () => {
  const plan = { type: 'plan', id: 'p', text: '1. do it' } as any;
  const second = { ...command, id: 'cmd2' };
  assert.deepEqual(splitWorkChunks([command, plan, second], 'p'), [
    { kind: 'work', items: [command] },
    { kind: 'head', item: plan },
    { kind: 'work', items: [second] },
  ]);
  assert.deepEqual(splitWorkChunks([command, plan, second]), [{ kind: 'work', items: [command, plan, second] }]);
});

test('ordinary replies and legacy messages without question metadata keep their presentation', () => {
  const legacy = { type: 'agentMessage', id: 'legacy', text: 'Reply' } as any;
  const empty = { ...legacy, id: 'empty', text: '', questions: [] };
  assert.equal(hasAsyncQuestions(legacy), false);
  assert.equal(hasAsyncQuestions(empty), false);
  assert.equal(splitTurn([command, legacy], false).final, legacy);
  assert.deepEqual(splitTurn([empty], false).work, []);
});

test('plan mode cannot turn an async question into an implementation plan', () => {
  assert.equal(turnCard([question], true, false), null);
  const plan = { type: 'agentMessage', id: 'plan', text: '1. Fix it' };
  assert.equal(turnCard([plan, question], true, false)?.item.id, 'plan');
});

test('answers require an explicit choice or text for every question; nothing is preselected', async () => {
  let sends = 0;
  for (const answers of [{}, { 0: 'Chat' }, { 0: 'Chat', 1: '  ' }] as Record<number, string>[]) {
    assert.equal(asyncAnswersReady(questions, answers), false);
    await assert.rejects(
      sendAsyncAnswers(questions, answers, async () => {
        sends++;
      }),
      /Answer every question/,
    );
  }
  assert.equal(asyncAnswersReady([], {}), false);
  assert.equal(sends, 0);
});

test('selected options and free text are sent once with their question context', async () => {
  const sent: string[] = [];
  await sendAsyncAnswers(questions, { 0: 'Chat', 1: ' Codex ' }, async (text) => {
    sent.push(text);
  });
  assert.deepEqual(sent, ['Which view?\nChat\n\nWhich harness?\nCodex']);
});

test('send failures propagate so the form can offer a retry without losing answers', async () => {
  const answers = { 0: 'Window', 1: 'Codex' };
  await assert.rejects(
    sendAsyncAnswers(questions, answers, async () => {
      throw new Error('IPC disconnected');
    }),
    /IPC disconnected/,
  );
  assert.deepEqual(answers, { 0: 'Window', 1: 'Codex' });
});

const userReply = (text: string) => ({ type: 'userMessage', id: 'u', content: [{ type: 'text', text }] }) as any;

test('submissions round-trip through history in the same or a later turn, including multiline answers', async () => {
  const answers = { 0: 'Window', 1: 'Codex\nKeep it in front' };
  let text = '';
  await sendAsyncAnswers(questions, answers, async (value) => {
    text = value;
  });
  for (const turns of [{ items: [question, userReply(text)] }, null]) {
    const history = turns ? [turns] : [{ items: [question, answer] }, { items: [userReply(text)] }];
    assert.deepEqual(submittedAsyncAnswers(history).get('q'), answers);
    // Loading the same persisted history again restores the same answer, without UI state.
    assert.deepEqual(submittedAsyncAnswers(JSON.parse(JSON.stringify(history))).get('q'), answers);
  }
});

test('plain replies, earlier messages, mismatched titles, and partial answers do not mark cards submitted', () => {
  for (const text of [
    'Codex',
    'Which view?\nChat',
    'Which view?\nChat\n\nWhich harness?\n ',
    'Different view?\nChat\n\nWhich harness?\nCodex',
  ]) {
    assert.equal(submittedAsyncAnswers([{ items: [question, userReply(text)] }]).size, 0);
  }
  assert.equal(submittedAsyncAnswers([{ items: [userReply('Which view?\nChat\n\nWhich harness?\nCodex'), question] }]).size, 0);
});

test('repeated question titles use the latest preceding unanswered card, without reusing one reply', () => {
  const second = { ...question, id: 'q2' };
  const result = submittedAsyncAnswers([{ items: [question, second, userReply('Which view?\nChat\n\nWhich harness?\nCodex')] }]);
  assert.equal(result.size, 1);
  assert.equal(result.has('q'), false);
  assert.deepEqual(result.get('q2'), { 0: 'Chat', 1: 'Codex' });
});

test('distinct submissions retain their own answers when the same question is asked again', () => {
  const result = submittedAsyncAnswers([
    { items: [question, userReply('Which view?\nChat\n\nWhich harness?\nCodex')] },
    { items: [{ ...question, id: 'q2' }, userReply('Which view?\nWindow\n\nWhich harness?\nClaude')] },
  ]);
  assert.deepEqual(result.get('q'), { 0: 'Chat', 1: 'Codex' });
  assert.deepEqual(result.get('q2'), { 0: 'Window', 1: 'Claude' });
});

test('explicit skipped async answers restore the submitted card after reload', async () => {
  let text = '';
  await sendAsyncAnswers(questions, { 0: 'Skipped', 1: 'Skipped' }, async (sent) => {
    text = sent;
  });
  const history = JSON.parse(JSON.stringify([{ items: [question, userReply(text)] }]));
  assert.deepEqual(submittedAsyncAnswers(history).get('q'), { 0: 'Skipped', 1: 'Skipped' });
});

test('attachment-only user messages and empty agent replies cannot submit a question card', () => {
  const attachment = { type: 'userMessage', id: 'image', content: [{ type: 'image', url: 'data:image/png;base64,AA==' }] } as any;
  assert.equal(submittedAsyncAnswers([{ items: [question, attachment] }]).size, 0);
  assert.equal(submittedAsyncAnswers([{ items: [{ type: 'agentMessage', id: 'empty', questions: [], text: '' }] as any }]).size, 0);
});

test('turn headers accept user messages and autonomous status notes, including header-only turns', () => {
  const user = userReply('Please help');
  const note = { type: 'statusNote', id: 'auto' } as any;
  assert.deepEqual(splitTurn([user, note], false), { users: [user, note], work: [], final: null });
  const empty = { type: 'agentMessage', id: 'stream', questions: null } as any;
  assert.deepEqual(splitTurn([empty], false), { users: [], work: [], final: null });
  assert.deepEqual(splitTurn([empty], true), { users: [], work: [empty], final: null });
  const commentary = { ...answer, phase: 'commentary' };
  assert.equal(splitTurn([commentary], true).final, null);
  assert.equal(splitTurn([{ ...answer, phase: null }], true).final?.id, 'final');
});

test("a note put back after a finished turn's reply (a reload) leaves that reply the turn's answer", () => {
  // a chat's saved notes (an account switch, the answers to a question card) return after the turn they followed,
  // behind its reply (withChatNotes); the reply must not fall into the folded work
  const reply = { type: 'agentMessage', id: 'r', text: 'Here it is', phase: null } as any;
  const notes = [
    { type: 'statusNote', id: 'n1', kind: 'answers', text: 'Answered a question' },
    { type: 'statusNote', id: 'n2', kind: 'account', text: 'Moved to work@x.dev' },
  ] as any[];
  const done = splitTurn([command, reply, ...notes], false);
  assert.equal(done.final, reply);
  assert.deepEqual(done.work, [command, ...notes]);
  // while it runs, a reply followed only by notes is still shown where it will stay
  assert.equal(splitTurn([command, reply, notes[0]], true).final, reply);
  // a note that came before the reply changes nothing; with no reply there is no answer
  assert.equal(splitTurn([command, notes[0], reply], false).final, reply);
  assert.equal(splitTurn([command, ...notes], false).final, null);
});

test("a hook that failed after the reply (a Stop hook) leaves that reply the turn's answer, on every harness", () => {
  // Claude's hook_response and Codex's hook/completed both put the run's line after the reply that ended the turn
  const reply = { type: 'agentMessage', id: 'r', text: 'ok', phase: null } as any;
  const hook = { type: 'hookPrompt', id: 'hook-1', fragments: [{ text: 'Stop (failed, exit 1): lint found 3 problems' }] } as any;
  const note = { type: 'statusNote', id: 'n', kind: 'account', text: 'Moved' } as any;
  const done = splitTurn([command, reply, hook], false);
  assert.equal(done.final, reply);
  assert.deepEqual(done.work, [command, hook]);
  assert.equal(splitTurn([command, reply, hook, note], false).final, reply);
  assert.equal(splitTurn([command, reply, hook], true).final, reply);
  // a hook line with no reply before it is no answer
  assert.equal(splitTurn([command, hook], false).final, null);
});

test("the latest turn's unanswered questions dock in the composer's place until answered or written past", async () => {
  const { dockedAsyncQuestions } = await import('../src/lib/asyncQuestions.ts');
  const user = (text: string) => ({ type: 'userMessage', id: `u-${text}`, content: [{ type: 'text', text }] }) as any;
  const later = { ...question, id: 'q2' };
  const none = new Map<string, Record<number, string>>();
  // the turn keeps working after asking: the question still waits
  assert.equal(dockedAsyncQuestions([{ items: [user('go'), question, command] }], none), question);
  // the last questions of the latest turn win; an older turn's never dock
  assert.equal(dockedAsyncQuestions([{ items: [question, later] }], none), later);
  assert.equal(dockedAsyncQuestions([{ items: [question] }, { items: [user('next'), command] }], none), null);
  // answered, or the user wrote to the agent after them: they stay in the transcript
  assert.equal(dockedAsyncQuestions([{ items: [question] }], new Map([['q', { 0: 'Chat', 1: 'x' }]])), null);
  assert.equal(dockedAsyncQuestions([{ items: [question, user('never mind')] }], none), null);
  assert.equal(dockedAsyncQuestions([], none), null);
  assert.equal(dockedAsyncQuestions([{ items: [command, answer] }], none), null);
});
