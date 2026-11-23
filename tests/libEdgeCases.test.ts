// Edge cases of the small pure helpers in src/lib: the inputs their main tests don't reach.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPrefsDelta, chatChanges, mapsFromSnapshot, withChatNotes } from '../src/lib/chatMeta.ts';
import { claudeGoalDetail, claudeGoalStatusText } from '../src/lib/claudeGoals.ts';
import { claudeHooksFrom, parseClaudeHooks } from '../src/lib/claudeHooks.ts';
import { formatCredits } from '../src/lib/credits.ts';
import { threadFromHash, threadHash } from '../src/lib/deepLink.ts';
import { isEnter, typingElsewhere } from '../src/lib/focus.ts';
import { reasoningText, visibleSteps } from '../src/lib/reasoning.ts';
import { claudeReviewMessage, claudeReviewPrompt } from '../src/lib/claudeReview.ts';
import { directiveFromHref, parseDirectives, stripDirectives } from '../src/lib/codexDirectives.ts';
import { dirname, isUnder, relPath } from '../src/lib/paths.ts';
import { rehypeWords } from '../src/lib/rehypeWords.ts';
import { splitTab } from '../src/lib/settingsNav.ts';
import { cardKind } from '../src/lib/tasks.ts';
import { goalBudgetLabel, goalErrorMessage, goalStatusLabel } from '../src/lib/codexGoals.ts';
import { TextPacer, revealedPrefix } from '../src/lib/textPacer.ts';

test('chat notes fall back to the turn index for unprefixed or missing turn ids', () => {
  const turns = [
    { id: 'a', items: [] },
    { id: 'b', items: [] },
  ];
  const note = (over: object) => ({ id: 'n', kind: 'account' as const, text: 'switched', turnId: null, turn: 5, at: 0, ...over });
  assert.deepEqual(
    withChatNotes(turns, [note({ turnId: 'a' })])[0].items.map((i: any) => i.id),
    ['n'],
  );
  assert.deepEqual(
    withChatNotes(turns, [note({})])[1].items.map((i: any) => i.id),
    ['n'],
  );
  assert.equal(withChatNotes([], [note({})]).length, 0);
  // a live turn id (ct-) matches the same turn read back from the transcript (h-)
  assert.deepEqual(
    withChatNotes(
      [
        { id: 'h-1', items: [] },
        { id: 'h-2', items: [] },
      ],
      [note({ turnId: 'ct-1' })],
    )[0].items.map((i: any) => i.id),
    ['n'],
  );
});

test('chat maps from no snapshot are empty and unchanged entries produce no patch', () => {
  const empty = mapsFromSnapshot(null);
  assert.deepEqual(empty.pinned, {});
  const shared = { id: 'acct', pinned: false };
  const prev = { ...empty, claudeChats: { a: shared }, worktreeOf: { w: '/x' }, chatNotes: { n: [] as any[] }, pinned: { p: true } };
  const next = { ...empty, claudeChats: { a: shared, b: { id: 'b', pinned: true } }, worktreeOf: {}, chatNotes: {}, pinned: {} };
  assert.deepEqual(chatChanges(prev, next).meta, {
    b: { account: { id: 'b', pinned: true } },
    w: { worktreeOf: null },
    // a chat's notes leaving the window (its deletion) sends nothing: a window only adds notes
    p: { pinned: false },
  });
});

test('a prefs delta without set or unset changes nothing', () => {
  assert.deepEqual(applyPrefsDelta({ a: 1 }, {}), { a: 1 });
});

test('claude goal status and detail cover every state', () => {
  assert.equal(claudeGoalStatusText({ status: 'stopped' } as any), 'Stopped');
  assert.equal(claudeGoalStatusText({ status: 'complete' } as any), 'Complete');
  assert.equal(claudeGoalStatusText({ status: 'active' } as any), 'Active');
  assert.equal(claudeGoalStatusText({ status: 'paused' } as any), 'Paused');
  assert.equal(claudeGoalDetail({ status: 'budgetLimited' } as any), 'Reached the limit (0 rounds). Goal paused · Limit set by MoPilot');
  assert.equal(
    claudeGoalDetail({ status: 'budgetLimited', claude: { iterations: 1, lastReason: null, limit: null } } as any),
    'Reached the limit (1 round). Goal paused · Limit set by MoPilot',
  );
  assert.equal(
    claudeGoalDetail({ status: 'budgetLimited', claude: { iterations: 1, lastReason: null, limit: 4 } } as any),
    'Reached the limit (4 rounds). Goal paused · Limit set by MoPilot',
  );
  assert.equal(claudeGoalDetail({ status: 'active', claude: { iterations: 2, lastReason: null, limit: 5 } } as any), '2 / 5 rounds');
  assert.equal(claudeGoalDetail({ status: 'complete', claude: { iterations: 2, lastReason: null, limit: 5 } } as any), '2 rounds');
});

test('claude hooks default their type and run', () => {
  assert.deepEqual(claudeHooksFrom({ hooks: { Stop: [{ hooks: [{ url: 'https://x' }, { type: 'prompt' }] }] } }), [
    { event: 'Stop', matcher: null, type: 'command', run: 'https://x' },
    { event: 'Stop', matcher: null, type: 'prompt', run: '' },
  ]);
  assert.deepEqual(parseClaudeHooks('   '), []);
  assert.equal(parseClaudeHooks('{'), null);
});

test('credits format as dollars or a dash', () => {
  assert.equal(formatCredits(null), '—');
  assert.equal(formatCredits(1_234_500_000), '$1,234.50');
});

test('thread hashes round-trip and reject undecodable ids', () => {
  assert.equal(threadFromHash('#' + threadHash('acp:kimi:1')), 'acp:kimi:1');
  assert.equal(threadFromHash('#thread=%E0%A4%A'), null);
  assert.equal(threadFromHash('#other=1'), null);
});

test('typing elsewhere and enter respect the document and composition', () => {
  const own = { tagName: 'DIV' };
  assert.equal(typingElsewhere(own), false); // no document in this test process
  (globalThis as any).document = { activeElement: { tagName: 'TEXTAREA' } };
  try {
    assert.equal(typingElsewhere(own), true);
  } finally {
    delete (globalThis as any).document;
  }
  assert.equal(typingElsewhere(own, { tagName: 'INPUT' }), true);
  assert.equal(typingElsewhere(own, { tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(isEnter({ key: 'Enter' }), true);
  assert.equal(isEnter({ key: 'Enter', isComposing: true }), false);
  assert.equal(isEnter({ key: 'Enter', nativeEvent: { isComposing: false }, isComposing: true }), true);
  assert.equal(isEnter({ key: 'Enter', keyCode: 229 }), false);
});

test('reasoning text reads summaries, then string or object content', () => {
  assert.equal(reasoningText(null), '');
  assert.equal(reasoningText({ summary: [' '], content: ['a', { text: 'b' }, {}, null] }), 'a\n\nb');
  assert.deepEqual(
    visibleSteps(
      [
        { kind: 'reasoning', item: { summary: ['x'] } },
        { kind: 'other', item: {} },
        { kind: 'tool', item: {} },
      ],
      false,
    ).map((s) => s.kind),
    ['tool'],
  );
});

test('claude review prompts by target', () => {
  assert.match(claudeReviewPrompt({ type: 'commit', sha: 'abc' }), /^Review the changes in commit abc\. /);
  assert.match(claudeReviewPrompt({ type: 'commit', sha: 'abc', title: 'Fix' }), /commit abc \(Fix\)/);
  assert.equal(claudeReviewPrompt({ type: 'custom' }), 'Review the current changes.');
  assert.equal(claudeReviewMessage({ type: 'custom', instructions: 'focus on auth' }), '/code-review focus on auth');
  assert.equal(claudeReviewMessage(null), '/code-review');
});

test('directive attributes accept every quoting, and odd directives are dropped', () => {
  const { markdown } = parseDirectives(`See :codex-file-citation{path='/a b.md' purpose=source flag}.`);
  const link = /\((<[^>]+>)\)/.exec(markdown)![1].slice(1, -1);
  assert.deepEqual(directiveFromHref(link)?.attrs, { path: '/a b.md', purpose: 'source', flag: '' });
  assert.equal(directiveFromHref(undefined), null);
  assert.deepEqual(directiveFromHref('codex-directive:annotation'), { name: 'annotation', label: '', attrs: {} });
  assert.deepEqual(parseDirectives('plain'), { markdown: 'plain', followups: [] });
  assert.equal(stripDirectives('plain'), 'plain');
  // a followup with neither prompt nor label is not offered
  assert.deepEqual(parseDirectives('Done.\n:codex-followup{}').followups, []);
  assert.deepEqual(
    parseDirectives('Done.\n:codex-followup[Next]{}').followups.map((f) => f.label),
    ['Next'],
  );
  // only a visualization marker, no codex directive
  assert.equal(parseDirectives('A visualize{"path":"/v.html"}').markdown, 'A [](<codex-directive:visualize?path=%2Fv.html>)');
  assert.equal(stripDirectives('A visualize{"mode":"wide"} B'), 'A  B');
});

test('paths handle roots, empty bases and homes outside the path', () => {
  assert.equal(dirname('\\\\server\\share'), '\\\\server\\share');
  assert.equal(dirname('\\\\server'), '\\\\server');
  assert.equal(isUnder('', '/a'), false);
  assert.equal(isUnder('/a', ''), false);
  assert.equal(relPath('/a/b', null), '/a/b');
});

test('word spans skip katex and empty text but walk nested roots', () => {
  const tree: any = {
    type: 'root',
    children: [
      { type: 'text', value: '' },
      { type: 'text', value: ' lead' },
      { type: 'element', tagName: 'span', properties: { className: ['katex'] }, children: [{ type: 'text', value: 'x y' }] },
      { type: 'element', tagName: 'span', properties: { className: [1, 'other'] }, children: [{ type: 'text', value: 'a b' }] },
      { type: 'element', tagName: 'p' },
      { type: 'root', children: [{ type: 'text', value: 'w' }] },
    ],
  };
  rehypeWords()(tree);
  // a word keeps the whitespace around it: the leading space is part of the first word
  assert.equal(tree.children[0].value, '');
  assert.equal(tree.children[1].children[0].value, ' lead');
  assert.equal(tree.children[2].children[0].value, 'x y');
  assert.deepEqual(
    tree.children[3].children.map((c: any) => c.children[0].value),
    ['a ', 'b'],
  );
  assert.equal(tree.children[5].children[0].tagName, 'span');
});

test('settings tabs with an empty sub page', () => {
  assert.deepEqual(splitTab('extensions:'), { tab: 'extensions', sub: undefined });
});

test('task kinds come from harness-neutral types', () => {
  assert.equal(cardKind('monitor'), 'monitor');
  assert.equal(cardKind('monitor_mcp'), 'monitor');
  assert.equal(cardKind('local_bash'), 'shell');
  assert.equal(cardKind('shell'), 'shell');
  assert.equal(cardKind('remote_agent'), 'agent');
  assert.equal(cardKind('in_process_teammate'), 'agent');
  assert.equal(cardKind('local_workflow'), 'workflow');
  assert.equal(cardKind('dream'), 'task');
  assert.equal(cardKind(null), 'task');
});

test('goal labels fall back to the raw status and show budgets', () => {
  assert.equal(goalStatusLabel('usageLimited'), 'Usage limit reached');
  assert.equal(goalStatusLabel('weird' as any), 'weird');
  assert.equal(
    goalBudgetLabel({ tokenBudget: 500, tokensUsed: 12_400 } as any),
    '500 token budget (soft, checked between turns) · 12k used',
  );
});

test('goal errors read a bare string', () => {
  assert.equal(goalErrorMessage('boom'), 'boom');
});

test('a pacer with nothing to show stops at once, and nothing is revealed at zero', () => {
  const p = new TextPacer(0);
  assert.equal(p.step(0), null);
  p.finish();
  assert.equal(p.step(0), null);
  assert.equal(revealedPrefix('abc', 0), '');
});
