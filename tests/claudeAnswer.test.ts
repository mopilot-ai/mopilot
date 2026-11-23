// shared/claudeAnswer.mjs: a card's answer as the Claude Agent SDK's, the same for the window and Chrome's side panel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeAnswer } from '../shared/claudeAnswer.mjs';

test('an MCP request: accept carries its content, anything else declines; its _meta goes back as given', () => {
  const m = 'mcpServer/elicitation/request';
  assert.deepEqual(claudeAnswer(m, {}, { action: 'accept', content: { a: 1 }, _meta: { scope: 'chat' } }), {
    action: 'accept',
    content: { a: 1 },
    _meta: { scope: 'chat' },
  });
  assert.deepEqual(claudeAnswer(m, {}, { action: 'accept' }), { action: 'accept' });
  assert.deepEqual(claudeAnswer(m, {}, { action: 'decline', content: { a: 1 } }), { action: 'decline' });
  assert.deepEqual(claudeAnswer(m, {}, null), { action: 'decline' });
});

test('a question: the answers picked go back as the tool’s input; none is a skip', () => {
  const q = 'item/tool/requestUserInput';
  // a question tool that asks nothing is allowed with no answers, as Claude Code's own card answers it
  assert.deepEqual(claudeAnswer(q, null, {}), { behavior: 'allow', updatedInput: { answers: {} } });
  assert.deepEqual(claudeAnswer(q, { questions: [] }, { answers: {} }), {
    behavior: 'allow',
    updatedInput: { questions: [], answers: {} },
  });
  // Claude Code's words for a skipped or dismissed question are answers too, sent as given
  const dismissed = '[User dismissed — do not proceed, wait for next instruction]';
  assert.deepEqual(
    claudeAnswer(
      q,
      { questions: [{ question: 'Which?' }, { question: 'Why?' }] },
      { answers: { 0: { answers: ['[No preference]'] }, 1: { answers: [dismissed] } } },
    ),
    {
      behavior: 'allow',
      updatedInput: {
        questions: [{ question: 'Which?' }, { question: 'Why?' }],
        answers: { 'Which?': '[No preference]', 'Why?': dismissed },
      },
    },
  );
  assert.deepEqual(claudeAnswer(q, { questions: [{ question: 'Which?' }] }, null), {
    behavior: 'deny',
    message: 'The user skipped the question.',
  });
});

test('a tool: allow, allow for the session (with the rules the CLI proposed), cancel or decline, each with the user’s note', () => {
  const t = 'claude/toolApproval';
  const input = { command: 'ls' };
  for (const decision of ['accept', 'approved'])
    assert.deepEqual(claudeAnswer(t, input, { decision }), { behavior: 'allow', updatedInput: input }, decision);
  for (const decision of [
    'acceptForSession',
    'approved_for_session',
    { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['ls'] } },
  ]) {
    assert.deepEqual(claudeAnswer(t, input, { decision }, [{ rule: 1 }]).updatedPermissions, [{ rule: 1 }]);
    assert.equal(claudeAnswer(t, input, { decision }, null).updatedPermissions, undefined);
  }
  assert.deepEqual(claudeAnswer(t, input, { decision: 'cancel' }), {
    behavior: 'deny',
    message: 'The user cancelled this action.',
    interrupt: true,
  });
  assert.deepEqual(
    claudeAnswer(t, input, { decision: 'cancel', reason: '  wrong db ' }).message,
    'The user cancelled this action: wrong db',
  );
  assert.deepEqual(claudeAnswer(t, input, { decision: 'decline', reason: '   ' }), {
    behavior: 'deny',
    message: 'The user declined this action.',
  });
  assert.deepEqual(claudeAnswer(t, input, { decision: {} }).behavior, 'deny');
  assert.deepEqual(claudeAnswer(t, input, undefined).behavior, 'deny');
});
