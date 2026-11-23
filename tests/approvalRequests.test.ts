// The approval cards built from main's SessionState approvals (src/harness/approvalRequests.ts): the same
// cards in every window, whatever the harness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestsOf, toRequest } from '../src/harness/approvalRequests.ts';
import type { PendingRequest } from '../src/store/types.ts';

/** A card as these tests read it: the params of whichever shape the method maps to. */
type Card = { id: number | string; method: string; params: any; threadId: string | null; receivedAt: number };

test('a Claude Bash approval becomes the command card, carrying what its answer needs', () => {
  const r: Card = toRequest(
    'c1',
    {
      id: 'cperm-1',
      method: 'claude/permission',
      params: {
        toolName: 'Bash',
        input: { command: 'npm test' },
        toolUseID: 'tu1',
        suggestions: [{ type: 'addRules' }],
        description: 'Run tests',
      },
    },
    '/work',
    5,
  )!;
  assert.equal(r.method, 'item/commandExecution/requestApproval');
  assert.deepEqual([r.params.command, r.params.cwd, r.params.itemId, r.params.reason], ['npm test', '/work', 'tu1', 'Run tests']);
  assert.deepEqual(r.params._claude, { toolName: 'Bash', input: { command: 'npm test' }, suggestions: [{ type: 'addRules' }] });
  assert.deepEqual([r.threadId, r.receivedAt], ['c1', 5]);
});

test('file edits, questions and other Claude tools map to their cards', () => {
  const m = (toolName: string, input: any = {}, extra: any = {}): Card =>
    toRequest('c1', { id: 'cperm-2', method: 'claude/permission', params: { toolName, input, ...extra } }, null, 0)!;
  assert.equal(m('Write', {}, { blockedPath: '/x' }).method, 'item/fileChange/requestApproval');
  assert.equal(m('Write', {}, { blockedPath: '/x' }).params.grantRoot, '/x');
  const q = m('AskUserQuestion', { questions: [{ header: 'H', question: 'Q?', options: [{ label: 'a' }], multiSelect: true }] });
  assert.equal(q.method, 'item/tool/requestUserInput');
  assert.deepEqual(q.params.questions[0], {
    id: '0',
    header: 'H',
    question: 'Q?',
    options: [{ label: 'a' }],
    isOther: true,
    isSecret: false,
    multiSelect: true,
  });
  assert.equal(m('WebFetch').method, 'claude/toolApproval');
});

test('ACP, elicitation and Codex approvals; Sage cards are left to their own component', () => {
  const acp: Card = toRequest(
    'c1',
    { id: 'acpperm-1', method: 'acp/permission', params: { toolCall: { title: 't' }, options: [{ optionId: 'o' }] } },
    null,
    0,
  )!;
  assert.deepEqual([acp.method, acp.params.toolCall, acp.params.options], ['acp/permission', { title: 't' }, [{ optionId: 'o' }]]);
  const el: Card = toRequest(
    'c1',
    {
      id: 'cperm-3',
      method: 'mcpServer/elicitation/request',
      params: { serverName: 's', message: 'm', mode: 'url', url: 'https://x', requestedSchema: null, claude: true },
    },
    null,
    0,
  )!;
  assert.deepEqual([el.params.serverName, el.params.url, el.params._claude.toolName], ['s', 'https://x', '']);
  const codex = toRequest(
    'c1',
    { id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: 'th', command: 'ls' } },
    null,
    0,
  )!;
  assert.deepEqual([codex.id, codex.params], [7, { threadId: 'th', command: 'ls' }]);
  assert.equal(toRequest('c1', { id: 'sage-1', method: 'sage/computerAccess', params: {} }, null, 0), null);
});

test("requestsOf keeps the receive time of a card already shown, in main's order", () => {
  const known: PendingRequest[] = [
    {
      id: 'a',
      method: 'acp/permission',
      params: { threadId: 'c1', turnId: null, toolCall: null, options: [] },
      threadId: 'c1',
      receivedAt: 3,
    },
  ];
  const out = requestsOf(
    'c1',
    [
      { id: 'a', method: 'acp/permission', params: {} },
      { id: 'b', method: 'sage/browserOrigin', params: {} },
      { id: 'c', method: 'acp/permission', params: {} },
    ],
    null,
    known,
    9,
  );
  assert.deepEqual(
    out.map((r) => [r.id, r.receivedAt]),
    [
      ['a', 3],
      ['c', 9],
    ],
  );
});
