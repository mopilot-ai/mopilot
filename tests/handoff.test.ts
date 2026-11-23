// The handoff record's wording (shared/handoff.mjs), which main writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  backDivider,
  composeHandoff,
  dividerText,
  estimateTokens,
  handoffBudget,
  renderConversation,
  sliceSegments,
  targetWindow,
  workspaceText,
} from '../shared/handoff.mjs';
import { parseUserText } from '../shared/userText.mjs';
import { buildTurns } from './support/claude-translate.ts';
import { buildAcpTurns } from '../electron/harness/items/acpTranslator.cjs';

const turn = (n: number, user: string, reply: string, extra: any[] = []): any => ({
  id: `t${n}`,
  status: 'completed',
  items: [
    { type: 'userMessage', id: `u${n}`, content: [{ type: 'text', text: user }] },
    ...extra,
    { type: 'agentMessage', id: `a${n}`, text: reply },
  ],
});

test('the newest turns are verbatim, older ones one line each, within the budget', () => {
  const turns = Array.from({ length: 10 }, (_, i) =>
    turn(i + 1, `question ${i + 1} ${'x'.repeat(300)}`, `answer ${i + 1} ${'y'.repeat(300)}`),
  );
  const all = renderConversation(turns, 1_000_000);
  assert.equal(all.condensed, 0);
  assert.match(all.text, /### Turn 1\nUser: question 1/);
  const small = renderConversation(turns, 700);
  assert.ok(small.condensed > 0);
  assert.match(small.text, /^Earlier turns \(condensed\):\n\n- Turn 1: user asked "question 1 x+/);
  assert.match(small.text, /### Turn 10\nUser: question 10/);
  assert.ok(estimateTokens(small.text) < estimateTokens(all.text));
  // numbering continues from the turns before them
  assert.match(renderConversation([turn(1, 'a', 'b')], 1000, 5).text, /^### Turn 5\n/);
});

test('a turn lists its steps; what the user typed is without the context the app adds', () => {
  const t = turn(1, '<sage-handoff from="Codex" mode="auto">\nold\n</sage-handoff>\n\nreal request', 'done', [
    { type: 'commandExecution', id: 'c1', command: "/bin/zsh -lc 'npm test'", exitCode: 1, aggregatedOutput: 'FAIL a\nFAIL b' },
    { type: 'commandExecution', id: 'c2', command: 'cat a', commandActions: [{ type: 'read', path: 'a.ts' }] },
    { type: 'fileChange', id: 'f1', changes: [{ path: 'a.ts', kind: { type: 'update' }, diff: '+x\n+y\n-z' }] },
    { type: 'webSearch', id: 'w1', query: 'node test runner' },
    { type: 'mcpToolCall', id: 'm1', server: 'docs', tool: 'search' },
  ]);
  const text = renderConversation([t], 100_000).text;
  assert.match(
    text,
    /User: real request\nSteps:\n- Ran `npm test` → exit 1\n {4}FAIL a\n {4}FAIL b\n- Read a\.ts\n- Edited a\.ts \(\+2 −1\)\n- Web: node test runner\n- Tool docs · search\nAssistant: done/,
  );
  assert.doesNotMatch(text, /old/);
});

test('the block says who it comes from, what it carries, and the workspace', () => {
  const turns = [turn(3, 'next', 'ok')];
  const workspace = workspaceText('/repo', { branch: 'main' }, { files: [] });
  assert.equal(workspace, '## Workspace\nDirectory: /repo\nBranch: main\nNo uncommitted changes.');
  const delta = composeHandoff({ from: 'claude', fromModel: 'opus', mode: 'delta', turns, since: 2, targetModel: 'gpt-x', workspace });
  assert.match(
    delta,
    /^<sage-handoff from="Claude Code" mode="delta">\nYou worked on this conversation earlier\. Since then another agent, Claude Code \(opus\), handled the turns below\./,
  );
  assert.match(delta, /## Conversation since you last worked on it\n\n### Turn 3\n/);
  const auto = composeHandoff({ from: 'codex', fromModel: null, mode: 'auto', turns, since: 0, targetModel: 'opus', workspace });
  assert.match(auto, /from another coding agent, Codex\. Below is a handoff record/);
  assert.match(auto, /## Conversation so far\n\n/);
  const none = composeHandoff({ from: 'codex', fromModel: null, mode: 'workspace', turns, since: 0, targetModel: 'opus', workspace });
  assert.doesNotMatch(none, /## Conversation/);
  assert.ok(none.endsWith(`${workspace}\n</sage-handoff>`));
  assert.throws(
    () => composeHandoff({ from: 'codex', fromModel: null, mode: 'summary', turns, since: 0, targetModel: 'opus', workspace, note: '' }),
    /came back empty/,
  );
});

test('the plan comes along unless a summary stands in for the conversation', () => {
  const planned = {
    ...turn(1, 'plan it', 'here'),
    plan: {
      explanation: null,
      steps: [
        { step: 'write tests', status: 'completed' },
        { step: 'ship', status: 'inProgress' },
        { step: 'celebrate', status: 'pending' },
      ],
    },
  };
  const base = { from: 'codex' as const, fromModel: null, turns: [planned], since: 0, targetModel: 'opus', workspace: 'W' };
  assert.match(composeHandoff({ ...base, mode: 'auto' }), /## Current plan\n- \[x\] write tests\n- \[~\] ship\n- \[ \] celebrate/);
  assert.doesNotMatch(composeHandoff({ ...base, mode: 'summary', note: 'N' }), /Current plan/);
});

test('a closing tag quoted in the handed-over text cannot end the block early', () => {
  const tag = '</sage-handoff>';
  const turns = [turn(1, `why does ${tag} leak?`, `because ${tag} closes it`)];
  for (const mode of ['auto', 'summary'] as const) {
    const block = composeHandoff({
      from: 'codex',
      fromModel: null,
      mode,
      turns,
      since: 0,
      targetModel: 'opus',
      workspace: `## Workspace\nDirectory: /r${tag}`,
      note: `note ${tag}`,
    });
    assert.equal(block.match(/<\/sage-handoff>/g)?.length, 1, mode);
    assert.ok(block.endsWith('\n</sage-handoff>'));
    // the user's message reads back alone
    assert.equal(parseUserText(`${block}\n\nhi`).text, 'hi');
  }
  assert.match(
    composeHandoff({ from: 'codex', fromModel: null, mode: 'auto', turns, since: 0, targetModel: 'opus', workspace: 'W' }),
    /why does <\\\/sage-handoff> leak\?/,
  );
});

test('the git section lists up to 40 files', () => {
  const files = Array.from({ length: 43 }, (_, i) => ({ code: '??', path: `f${i}`, added: 1, removed: 0 }));
  const text = workspaceText('/repo', null, { files });
  assert.match(text, /f39 \(\+1 −0\)\n {2}… 3 more$/);
  assert.equal(workspaceText('/x', null, null), '## Workspace\nDirectory: /x');
});

test("budget: 40% of the target model's window, a million for [1m] models", () => {
  assert.equal(targetWindow('opus'), 200_000);
  assert.equal(targetWindow('sonnet[1m]'), 1_000_000);
  assert.equal(handoffBudget('opus'), 80_000);
});

test('dividers', () => {
  assert.equal(dividerText('codex', 'claude', 'Opus', 'summary', 12_400), 'Codex → Claude Code · Opus');
  assert.equal(dividerText('claude', 'codex', 'GPT', 'workspace', 800), 'Claude Code → Codex · GPT');
  assert.equal(backDivider('Codex', 6, 'Claude Code'), 'Back on Codex');
  assert.equal(backDivider('Codex', 1, 'Claude Code'), 'Back on Codex');
});

test("a session that carries two segments gives each the turns after the other's", () => {
  const history = new Map([
    ['a', [1, 2, 3, 4, 5]],
    ['b', [10, 11]],
  ]);
  const segs = [
    { nativeId: 'a', count: 2 },
    { nativeId: 'b', count: 1 },
    { nativeId: 'a', count: null },
  ];
  assert.deepEqual(sliceSegments(segs, history), [[1, 2], [10], [3, 4, 5]]);
  assert.deepEqual(sliceSegments([{ nativeId: 'x', count: null }], history), [[]]);
});

test('condensed prompts, replies, and command previews keep complete Unicode characters', () => {
  const result = renderConversation(
    [
      turn(1, 'x'.repeat(159) + '😀', 'y'.repeat(219) + '😀'),
      turn(2, 'new prompt', 'new reply', [{ type: 'commandExecution', command: 'z'.repeat(199) + '😀' }]),
    ],
    10,
  );
  assert.equal(result.condensed, 1);
  assert.ok(!/[\uD800-\uDFFF]/u.test(result.text), 'handoff snippets must not contain lone surrogate code units');
  assert.ok(result.text.includes('x'.repeat(159) + '"'));
  assert.ok(result.text.includes('z'.repeat(199) + '`'));
});

test('empty snippets and declined commands still have accurate summary states', () => {
  const result = renderConversation([turn(1, '', ''), turn(2, '', '', [{ type: 'commandExecution', status: 'declined' }])], 1);
  assert.match(result.text, /Turn 1: continued on its own/);
  assert.match(result.text, /Ran `` \(declined by user\)/);
});

test('failed Git status is not described as a clean working tree in a handoff', () => {
  for (const status of [null, undefined]) {
    const text = workspaceText('/repo', { branch: 'main' }, status);
    assert.ok(!text.includes('No uncommitted changes.'));
    assert.match(text, /Could not read uncommitted changes/);
  }
  assert.match(workspaceText('/repo', { branch: 'main' }, { files: [] }), /No uncommitted changes/);
});

test('handoff diff statistics count header-like source lines inside hunks', () => {
  const patch = [
    'diff --git a/a.ts b/a.ts',
    '--- a/a.ts',
    '+++ b/a.ts',
    '@@ -1,3 +1,3 @@',
    ' context',
    '---counter;',
    '---- old',
    '+++counter;',
    '++++ new',
    '--- a/b.txt',
    '+++ b/b.txt',
    '@@ -1 +1 @@',
    '-before',
    '+after',
  ].join('\n');
  const text = renderConversation(
    [turn(1, 'edit', 'done', [{ type: 'fileChange', id: 'f', changes: [{ path: 'a.ts', kind: 'update', diff: patch }] }])],
    100_000,
  ).text;
  assert.match(text, /Edited a\.ts \(\+3 −3\)/);
});

test('raw additions and deletions have correct labels and content line counts', () => {
  for (const kind of ['add', 'delete']) {
    for (const value of [kind, { type: kind }]) {
      for (const [diff, count] of [
        ['', 0],
        ['\n', 1],
        ['a\nb\n', 2],
        ['title\n---\nbody\n', 3],
        ['+literal\n-literal', 2],
      ] as const) {
        const text = renderConversation(
          [turn(1, 'edit', 'done', [{ type: 'fileChange', changes: [{ path: 'file.txt', kind: value, diff }] }])],
          100_000,
        ).text;
        assert.ok(
          text.includes(
            `${kind === 'add' ? 'Created' : 'Deleted'} file.txt (+${kind === 'add' ? count : 0} −${kind === 'delete' ? count : 0})`,
          ),
          'raw file content must be counted as content rather than patch records',
        );
      }
    }
  }
  const text = renderConversation(
    [turn(1, 'edit', 'done', [{ type: 'fileChange', status: 'declined', changes: [{ path: 'file.txt', kind: 'add' }] }])],
    100_000,
  ).text;
  assert.match(text, /Declined edit to file\.txt \(\+0 −0\)/);
});

test('added and deleted bare hunks remain patch statistics in handoffs', () => {
  for (const [kind, diff, expected] of [
    ['add', '@@ -0,0 +1 @@\n+hello\n', '+1 −0'],
    ['delete', '@@ -1 +0,0 @@\n-hello\n', '+0 −1'],
  ]) {
    const text = renderConversation(
      [turn(1, 'edit', 'done', [{ type: 'fileChange', changes: [{ path: 'file.txt', kind, diff }] }])],
      100_000,
    ).text;
    assert.ok(text.includes(`file.txt (${expected})`));
  }
});

test('incomplete file change records keep a safe summary', () => {
  const text = renderConversation(
    [turn(1, 'edit', 'done', [{ type: 'fileChange' }, { type: 'fileChange', changes: [{ path: 'unknown.txt' }] }])],
    100_000,
  ).text;
  assert.match(text, /Edited unknown\.txt \(\+0 −0\)/);
});

test('failed file edits are reported as failures rather than successful filesystem changes', () => {
  for (const kind of ['add', 'delete', 'update']) {
    const text = renderConversation(
      [
        turn(1, 'edit', 'done', [
          { type: 'fileChange', status: 'failed', changes: [{ path: 'file.txt', kind: { type: kind }, diff: '@@ -1 +1 @@\n-old\n+new' }] },
        ]),
      ],
      100_000,
    ).text;
    assert.match(text, /Failed edit to file\.txt \(\+1 −1\)/);
    assert.ok(!/(?:Created|Deleted|Edited) file\.txt/.test(text));
  }
});

// A turn that only compacted the context reads as one line, never as an empty exchange (#1500).
const compacting = (n: number, extra: any = {}): any => ({
  id: `k${n}`,
  status: 'completed',
  items: [{ type: 'contextCompaction', id: `c${n}` }],
  ...extra,
});
const EMPTY_EXCHANGE = /continued on its own|\(no reply\)/;

test('a Codex compaction turn is one line in the handoff, in full and condensed, and keeps its number', () => {
  const turns = [turn(1, 'first', 'one'), compacting(2), turn(3, 'second', 'two'), compacting(4, { status: 'failed' })];
  const full = renderConversation(turns, 1_000_000).text;
  assert.match(full, /### Turn 2\n\(context compacted\)\n\n### Turn 3\nUser: second/);
  assert.match(full, /### Turn 4\n\(context compaction did not finish\)$/);
  for (const [status, line] of [
    ['interrupted', 'did not finish'],
    ['inProgress', 'still running'],
  ])
    assert.match(renderConversation([compacting(1, { status })], 1_000_000).text, new RegExp(`\\(context compaction ${line}\\)`));
  assert.doesNotMatch(full, EMPTY_EXCHANGE);
  const condensed = renderConversation([...turns, turn(5, 'last', 'reply '.repeat(400))], 10).text;
  assert.match(condensed, /- Turn 2: \(context compacted\)\n\n- Turn 3: user asked "second" → two/);
  assert.match(condensed, /- Turn 4: \(context compaction did not finish\)/);
  assert.doesNotMatch(condensed, EMPTY_EXCHANGE);
  // a delta handoff numbers them from the turns the target already saw
  const record = composeHandoff({
    from: 'codex',
    fromModel: null,
    mode: 'delta',
    turns: [compacting(1)],
    since: 6,
    targetModel: 'opus',
    workspace: 'W',
  });
  assert.match(record, /### Turn 7\n\(context compacted\)\n\nW/);
});

test('a Claude Code /compact turn, as its transcript reads back, is one line in the handoff', () => {
  // getSessionMessages starts at the summary after the last boundary and drops system and meta lines
  const messages = [
    { type: 'user', uuid: 'sum', message: { role: 'user', content: 'This session is being continued from a previous conversation.' } },
    { type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'Picked up.' }] } },
    {
      type: 'user',
      uuid: 'cmd',
      message: {
        role: 'user',
        content: '<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>',
      },
    },
    { type: 'user', uuid: 'out', message: { role: 'user', content: '<local-command-stdout>Compacted </local-command-stdout>' } },
    {
      type: 'user',
      uuid: 'cmd2',
      message: { role: 'user', content: '<command-name>/compact</command-name>\n<command-args>keep the API notes</command-args>' },
    },
    { type: 'user', uuid: 'next', message: { role: 'user', content: 'carry on' } },
    { type: 'assistant', uuid: 'a2', message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'On it.' }] } },
  ];
  const text = renderConversation(buildTurns(messages as any, 'chat', '/w'), 1_000_000).text;
  assert.match(
    text,
    /### Turn 2\n\(user ran \/compact to compact the context\)\n\n### Turn 3\n\(user ran \/compact keep the API notes to compact the context\)\n\n### Turn 4\nUser: carry on/,
  );
  assert.doesNotMatch(text, EMPTY_EXCHANGE);
  // long instructions are cut like any prompt, and a message sent while it ran keeps the turn an exchange
  const long = {
    ...turn(1, `/compact ${'k'.repeat(400)}`, ''),
    items: [{ type: 'userMessage', id: 'u', content: [{ type: 'text', text: `/compact ${'k'.repeat(400)}` }] }],
  };
  assert.match(renderConversation([long], 1_000_000).text, /^### Turn 1\n\(user ran \/compact k{151} to compact the context\)$/);
  const steered = {
    ...compacting(1),
    items: [
      { type: 'userMessage', id: 'u', content: [{ type: 'text', text: '/compact' }] },
      { type: 'contextCompaction', id: 'c' },
      { type: 'userMessage', id: 'u2', content: [{ type: 'text', text: 'also check the tests' }] },
    ],
  };
  assert.match(
    renderConversation([steered], 1_000_000).text,
    /User: \/compact\n\nalso check the tests\nSteps:\n- \(context compacted\)\nAssistant: \(no reply\)/,
  );
  // the live stream puts the compaction in the command's own turn
  const live = {
    ...compacting(1),
    items: [
      { type: 'userMessage', id: 'u', content: [{ type: 'text', text: '/compact' }] },
      { type: 'contextCompaction', id: 'c' },
    ],
  };
  assert.match(renderConversation([live], 1_000_000).text, /^### Turn 1\n\(user ran \/compact; context compacted\)$/);
});

test("an ACP harness's /compact turn is one line, and one it answered keeps its answer", () => {
  const user = (id: string, text: string) => ({
    t: 'user',
    turnId: id,
    user: { id: `u-${id}`, clientId: null, content: [{ type: 'text', text }] },
  });
  const turns = buildAcpTurns([user('t1', '/compact'), { t: 'end', turnId: 't1', stopReason: 'end_turn' }] as any, 'chat', '/w');
  assert.equal(renderConversation(turns, 1_000_000).text, '### Turn 1\n(user ran /compact to compact the context)');
  const answered = { ...turn(1, '/compact', 'Compacted the conversation.') };
  assert.match(renderConversation([answered], 1_000_000).text, /User: \/compact\nAssistant: Compacted the conversation\./);
});

test('a compaction in a turn with other work is one of its steps; other commands and empty turns read as before', () => {
  const mid = turn(1, 'fix it', 'fixed', [
    { type: 'contextCompaction', id: 'c' },
    { type: 'commandExecution', id: 'x', command: 'npm test', exitCode: 0 },
  ]);
  assert.match(
    renderConversation([mid], 1_000_000).text,
    /User: fix it\nSteps:\n- \(context compacted\)\n- Ran `npm test` → exit 0\nAssistant: fixed/,
  );
  const steps = {
    ...compacting(1),
    items: [
      { type: 'contextCompaction', id: 'c' },
      { type: 'webSearch', id: 'w', query: 'q' },
    ],
  };
  assert.match(
    renderConversation([steps], 1_000_000).text,
    /User: \(no message; the agent continued on its own\)\nSteps:\n- \(context compacted\)\n- Web: q/,
  );
  for (const text of ['/compactify', 'please /compact']) {
    const t = { ...turn(1, text, ''), items: [{ type: 'userMessage', id: 'u', content: [{ type: 'text', text }] }] };
    assert.match(renderConversation([t], 1_000_000).text, /Assistant: \(no reply\)/);
  }
  assert.match(renderConversation([{ id: 'e', status: 'completed', items: [] } as any], 1_000_000).text, /continued on its own/);
});

/** The one-line form of a turn: a two-turn render on no budget condenses the first. */
const condensedLine = (t: any, n: number) => renderConversation([t, turn(0, '', '')], 0, n).text.split('\n\n')[1];
/** The budget loop spelled out over whole renders: keep the newest turns verbatim, shrinking by 0.7 until the text fits. */
function expectedConversation(turns: any[], budget: number, first: number) {
  for (let keep = turns.length; ; keep = Math.max(1, Math.floor(keep * 0.7))) {
    const older = turns.slice(0, turns.length - keep).map((t, i) => condensedLine(t, first + i));
    const start = turns.length - keep;
    const recent = turns.slice(start).map((t, i) => renderConversation([t], Number.MAX_SAFE_INTEGER, first + start + i).text);
    const text = [...(older.length ? ['Earlier turns (condensed):', ...older, ''] : []), ...recent].join('\n\n');
    if (estimateTokens(text) <= budget || keep <= 1) return { text, condensed: turns.length - keep };
  }
}

test('every budget gets the same text as whole renders of the budget loop', () => {
  const turns = Array.from({ length: 23 }, (_, i) =>
    turn(i, `ask ${i} ${'word '.repeat(i * 7)}`, `reply ${'x'.repeat(i * 31)}`, [
      { type: 'commandExecution', command: 'ls', exitCode: 0, aggregatedOutput: Array.from({ length: i }, (_, l) => `l${l}`).join('\n') },
    ]),
  );
  for (const budget of [-1, 0, 1, 50, 200, 500, 1000, 2000, 4000, 8000, 1_000_000])
    for (const list of [turns, turns.slice(0, 1), []])
      assert.deepEqual(renderConversation(list, budget, 3), expectedConversation(list, budget, 3));
});

test("a long chat's cost does not grow with its verbatim size: each turn is read once each way, the oldest never verbatim", () => {
  const reads = new Map<number, number>();
  const turns = Array.from({ length: 2000 }, (_, i) => {
    const t = turn(i, `ask ${i}`, 'reply '.repeat(200), [
      { type: 'commandExecution', command: 'ls', exitCode: 0, aggregatedOutput: 'line\n'.repeat(500) },
    ]);
    return new Proxy(t, {
      get(target, key, receiver) {
        if (key === 'items') reads.set(i, (reads.get(i) ?? 0) + 1);
        return Reflect.get(target, key, receiver);
      },
    });
  });
  const { condensed } = renderConversation(turns, 1000);
  assert.ok(condensed > 1900);
  // reading a turn's facts takes the same few reads of its items in every turn, and a verbatim render one more
  const oldest = reads.get(0)!;
  assert.ok(oldest <= 4, `the oldest turn was read ${oldest} times`);
  assert.ok(Math.max(...reads.values()) <= oldest + 1, 'a turn was rendered more than once in a form');
});

test('command output keeps its last twelve lines, whatever its line ends', () => {
  const output = (text: string) =>
    renderConversation([turn(1, 'a', 'b', [{ type: 'commandExecution', command: 'ls', exitCode: 0, aggregatedOutput: text }])], 1_000_000)
      .text;
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `l${i}`).join('\n');
  assert.doesNotMatch(output(lines(12)), /…/);
  assert.match(output(lines(13)), /…\n {4}l1\n/);
  assert.doesNotMatch(output(`${lines(12)}\n`), /…/);
  assert.match(output(`${lines(13)}\n`), /…\n {4}l1\n[\s\S]* {4}l12\nAssistant/);
  // blank lines count, and a run of them at the start is not walked past its first
  assert.doesNotMatch(output(`\n\n\nx`), /…/);
  assert.match(output(`${'\n'.repeat(13)}x`), /…/);
});

test("a marker in a message's code stays text, and one beside code still counts: the markdown parse is skipped only without one", () => {
  // no marker at all: nothing changes
  assert.equal(parseUserText('plain `code` text').text, 'plain `code` text');
  // reply marker: in code it is left alone, on its own line it counts, and text after it on that line makes it no marker
  assert.equal(parseUserText('`<!-- reply 1 -->`\n> quote').annotations.length, 0);
  assert.deepEqual(parseUserText('<!-- reply 1 -->\n> quote\nmine').annotations, [{ text: 'quote', annotation: undefined }]);
  assert.deepEqual(parseUserText('<!-- reply 1 --> `x`\n> quote').annotations, []);
  // question reply: replaced outside code only
  const reply = '<send_user_message_question_reply>[{"question":"q","answer":"a"}]</send_user_message_question_reply>';
  assert.equal(parseUserText(reply).text, 'a');
  assert.equal(parseUserText(`\`${reply}\``).text, `\`${reply}\``);
  // the request header: from a preamble, and not from a code span
  assert.equal(parseUserText('# Selected text:\n## Selection 1\nabc\n\n## My request:\nreq').text, 'req');
  assert.equal(parseUserText('`## My request:`').text, '`## My request:`');
});
