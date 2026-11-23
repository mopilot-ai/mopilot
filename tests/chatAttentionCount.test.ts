// The shared row decider counts only this chat's live requests and finished-turn question, independently of family PRs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatRowStatus, chatRowState, type ChatRowInputs } from '../src/session/chatRowState.ts';
import { EMPTY_SESSION } from '../src/store/session/sessionState.ts';

const inputs = (over: Partial<ChatRowInputs> = {}): ChatRowInputs => ({
  thread: { id: 'child', cwd: '/repo', status: { type: 'idle' } } as ChatRowInputs['thread'],
  session: EMPTY_SESSION,
  runtime: undefined,
  requests: [],
  adapterTasks: [],
  elsewhere: undefined,
  unread: false,
  ...over,
});
const live = (over: object = {}) => ({ ...EMPTY_SESSION, rev: 1, ...over });
const request = (threadId: string, method = 'item/tool/requestUserInput') => ({ id: 'same', threadId, method, params: {} }) as never;

test('native requests are scoped by chat before the snapshot and superseded by the current main-owned cards after it', () => {
  const pending = [request('parent'), request('child'), request('sibling'), request('child', 'item/commandExecution/requestApproval')];
  const before = chatRowStatus(inputs({ requests: pending }));
  assert.equal(before.state, 'approval');
  assert.equal(before.attentionCount, 2);
  const after = inputs({ requests: pending, session: live() });
  assert.equal(chatRowState(after), 'idle');
  assert.equal(chatRowStatus(after).attentionCount, 0, 'stale native flags and requests cannot resurrect answered cards');
  assert.equal(chatRowStatus({ ...after, session: undefined }).attentionCount, 2, 'a missing snapshot retains the own-chat fallback');
});

test('Codex, Claude Code, ACP and shared approval cards count once per card; terminal forms and foreign ids do not add counts', () => {
  const approvals = [
    { id: 'codex', method: 'item/tool/requestUserInput', params: {} },
    { id: 'claude', method: 'claude/permission', params: { toolName: 'AskUserQuestion', input: { questions: [{ question: 'Which?' }] } } },
    { id: 'elicitation', method: 'mcpServer/elicitation/request', params: {} },
    { id: 'acp', method: 'acp/permission', params: {} },
    { id: 'own', method: 'sage/approval', params: {} },
  ];
  const questions = ['pending', 'sending', 'written', 'failed', 'retired', 'denied', 'cancelled'].map((status) => ({ id: status, status }));
  const session = live({ approvals, questions, chromeApproval: true });
  assert.equal(chatRowStatus(inputs({ session })).attentionCount, 7);
  assert.equal(chatRowStatus(inputs({ session: live({ approvals: approvals.slice(0, 3) }) })).state, 'input');
  assert.equal(chatRowStatus(inputs({ session: live({ questions }) })).attentionCount, 1);
});

test('wait flags have a count before cards arrive and never double-count the exact cards or survive a main snapshot', () => {
  const thread = (activeFlags: string[]) =>
    ({ id: 'child', cwd: '/repo', status: { type: 'active', activeFlags } }) as ChatRowInputs['thread'];
  for (const flag of ['waitingOnUserInput', 'waitingOnApproval']) {
    assert.equal(chatRowStatus(inputs({ thread: thread([flag]) })).attentionCount, 1);
    assert.equal(chatRowStatus(inputs({ thread: thread([flag]), requests: [request('child')] })).attentionCount, 1);
    assert.equal(chatRowStatus(inputs({ thread: thread([flag]), session: live() })).attentionCount, 0);
  }
  assert.equal(chatRowStatus(inputs({ session: live({ turn: 'awaitingUser' }) })).attentionCount, 1);
});

test('an ended-turn question stays actionable beside background work and is retired while a replacement turn runs here or elsewhere', () => {
  const own = inputs({ asks: true, session: live() });
  assert.equal(chatRowStatus(own).attentionCount, 1);
  assert.equal(chatRowState(own), 'input', 'folding uses the same question state as the badge');
  assert.equal(chatRowStatus({ ...own, adapterTasks: [{ id: 'background', status: 'running' } as never] }).state, 'input');
  for (const changed of [
    { session: live({ turn: 'running' }) },
    { session: EMPTY_SESSION, runtime: { activeTurnId: 'new-turn' } as never },
    { elsewhere: { app: 'codex', running: true } as never },
    { session: live({ runningElsewhere: true }) },
    { asks: false },
  ])
    assert.equal(chatRowStatus({ ...own, ...changed }).attentionCount, 0);
  assert.equal(chatRowStatus(own).attentionCount, 1, 'a new question after the replacement remains usable');
});
