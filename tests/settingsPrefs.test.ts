// Settings → Show reasoning (src/lib/reasoning.ts) and loading prefs saved by older builds (src/store/types.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reasoningText, visibleSteps } from '../src/lib/reasoning.ts';
import {
  DEFAULT_PREFS,
  PREFS_VERSION,
  defaultsPatch,
  inCodexWorktrees,
  loadPrefs,
  projectlessFolderOf,
  worktreeRootOf,
} from '../src/store/types.ts';

const codexReasoning = { type: 'reasoning', id: 'r1', summary: ['**Planning**\n\nLook at the tests first.'], content: [] };
const claudeThinking = { type: 'reasoning', id: 'r2', summary: ['Thinking it over.'], content: [] };
const rawOnly = { type: 'reasoning', id: 'r3', summary: [], content: [{ type: 'reasoning_text', text: 'raw reasoning' }] };
const empty = { type: 'reasoning', id: 'r4', summary: [''], content: [] };
const cmd = { type: 'commandExecution', id: 'c1' };

const steps: { kind: string; item: any }[] = [
  { kind: 'reasoning', item: codexReasoning },
  { kind: 'command', item: cmd },
  { kind: 'reasoning', item: claudeThinking },
  { kind: 'reasoning', item: rawOnly },
  { kind: 'reasoning', item: empty },
  { kind: 'other', item: { type: 'unknown' } },
];

test('reasoning text comes from the summary, else the raw content', () => {
  assert.equal(reasoningText(codexReasoning), '**Planning**\n\nLook at the tests first.');
  assert.equal(reasoningText(rawOnly), 'raw reasoning');
  assert.equal(reasoningText(empty), '');
});

test('with Show reasoning on, reasoning with text gets a row (Codex and Claude alike)', () => {
  assert.deepEqual(
    visibleSteps(steps, true).map((s) => s.item.id),
    ['r1', 'c1', 'r2', 'r3'],
  );
});

test('with Show reasoning off, no reasoning row is shown', () => {
  assert.deepEqual(
    visibleSteps(steps, false).map((s) => s.item.id),
    ['c1'],
  );
});

test('prefs saved by older builds load, without the removed settings', () => {
  const saved = {
    showReasoning: false,
    branchPrefix: 'me/',
    language: 'en',
    prMergeMethod: 'squash',
    forcePush: true,
    draftPRs: false,
    autoMerge: true,
    autoMergeInstructions: 'merge it',
    commitInstructions: 'be brief',
    numberShortcuts: 'tabs',
    pinReview: false,
    conversationDetail: 'compact',
  };
  const p = loadPrefs(saved) as unknown as Record<string, unknown>;
  assert.equal(p.showReasoning, false);
  assert.equal(p.branchPrefix, 'me/');
  for (const k of [
    'language',
    'prMergeMethod',
    'forcePush',
    'draftPRs',
    'autoMerge',
    'autoMergeInstructions',
    'commitInstructions',
    'numberShortcuts',
    'pinReview',
    'conversationDetail',
  ])
    assert.ok(!(k in p), k);
  // the input is left alone
  assert.equal(saved.language, 'en');
});

test('missing or malformed saved prefs fall back to the defaults', () => {
  assert.deepEqual(loadPrefs(undefined), DEFAULT_PREFS);
  assert.deepEqual(loadPrefs(null), DEFAULT_PREFS);
  assert.deepEqual(loadPrefs([1, 2]), DEFAULT_PREFS);
});

test('projects default to stable placement for new and existing profiles without a project sort choice', () => {
  assert.equal(DEFAULT_PREFS.projectSort, 'custom');
  assert.equal(loadPrefs(undefined).projectSort, 'custom');
  assert.equal(loadPrefs({ chatSort: 'manual', sidebarProjectOrder: ['older', 'newer'] }).projectSort, 'custom');
});

test('explicit project sort choices survive loading independently of chat sort', () => {
  for (const projectSort of ['custom', 'updated', 'name'] as const) {
    const prefs = loadPrefs({ projectSort, chatSort: 'manual', sidebarProjectOrder: ['older', 'newer'] });
    assert.equal(prefs.projectSort, projectSort);
    assert.equal(prefs.chatSort, 'manual');
    assert.deepEqual(prefs.sidebarProjectOrder, ['older', 'newer']);
  }
});

const legacy = { home: '/Users/me', codexHome: '/Users/me/.codex' };

test('legacy branch defaults migrate once, while custom and subsequently chosen prefixes survive', () => {
  for (const prefsVersion of [undefined, 2, 3, '3']) {
    const saved = { prefsVersion, branchPrefix: 'codex/' };
    assert.equal(loadPrefs(saved).branchPrefix, 'mopilot/');
    const patch = defaultsPatch(saved, legacy);
    assert.equal(patch?.branchPrefix, 'mopilot/');
    assert.equal(defaultsPatch({ ...saved, ...patch }, legacy), null);
    assert.equal(saved.branchPrefix, 'codex/', 'reading preferences does not mutate the saved snapshot');
  }
  for (const branchPrefix of ['me/', 'bwang-', 'claude/', 'codex/team/', 'mopilot/', 'codex/']) {
    for (const prefsVersion of [PREFS_VERSION, PREFS_VERSION + 1]) {
      assert.equal(loadPrefs({ branchPrefix, prefsVersion }).branchPrefix, branchPrefix);
      assert.equal(defaultsPatch({ branchPrefix, prefsVersion }, legacy), null);
    }
  }
  for (const branchPrefix of [undefined, null, '', 3, [], {}]) assert.equal(loadPrefs({ branchPrefix }).branchPrefix, 'mopilot/');
});

test('a new profile gets the MoPilot defaults for worktrees and projectless chats', () => {
  for (const saved of [undefined, {}, { shareUsageData: false, theme: 'dark' }]) {
    const patch = defaultsPatch(saved, legacy);
    assert.deepEqual(patch, { prefsVersion: PREFS_VERSION });
    const p = loadPrefs({ ...(saved ?? {}), ...patch });
    assert.equal(p.branchPrefix, 'mopilot/');
    assert.equal(worktreeRootOf(p, legacy.home), '/Users/me/.mopilot/worktrees');
    assert.equal(projectlessFolderOf(p, legacy.home), '/Users/me/Documents/MoPilot');
  }
});

test('a profile saved before the new defaults migrates its legacy prefix and keeps its chat folder', () => {
  // older builds saved every pref, defaults included
  const { prefsVersion: _v, ...older } = DEFAULT_PREFS;
  const saved = { ...older, branchPrefix: 'codex/', worktreeRoot: null, projectlessFolder: null };
  const patch = defaultsPatch(saved, legacy);
  // worktrees don't go to the Codex app's folder, whose cleanup deletes them under running chats
  assert.deepEqual(patch, { prefsVersion: PREFS_VERSION, branchPrefix: 'mopilot/', projectlessFolder: '/Users/me/Documents/Codex' });
  const p = loadPrefs({ ...saved, ...patch });
  assert.equal(p.branchPrefix, 'mopilot/');
  assert.equal(worktreeRootOf(p, legacy.home), '/Users/me/.mopilot/worktrees');
  assert.equal(projectlessFolderOf(p, legacy.home), '/Users/me/Documents/Codex');
  // folders the user chose stay as they are
  assert.deepEqual(defaultsPatch({ branchPrefix: 'me/', worktreeRoot: '/wt', projectlessFolder: '/chats' }, legacy), {
    prefsVersion: PREFS_VERSION,
  });
  // and it runs once
  assert.equal(defaultsPatch({ ...saved, ...patch }, legacy), null);
});

test('the old global "offer paid access" becomes an ask per harness; off, or already per harness, is left alone', () => {
  assert.deepEqual(loadPrefs({ limitFallback: true }).limitAsk, { codex: true, claude: true });
  assert.ok(!('limitFallback' in loadPrefs({ limitFallback: true })));
  assert.deepEqual(loadPrefs({ limitFallback: false }).limitAsk, {});
  assert.deepEqual(loadPrefs({ limitFallback: true, limitAsk: { codex: false } }).limitAsk, { codex: false });
  assert.deepEqual(DEFAULT_PREFS.limitAsk, {});
});

test("version 2 moved old profiles' worktrees into the Codex app's folder; version 3 moves them back to the default", () => {
  // what version 2 wrote for a profile from before it
  const v2 = {
    prefsVersion: 2,
    branchPrefix: 'codex/',
    worktreeRoot: '/Users/me/.codex/worktrees',
    projectlessFolder: '/Users/me/Documents/Codex',
  };
  const patch = defaultsPatch(v2, legacy);
  assert.deepEqual(patch, { prefsVersion: PREFS_VERSION, branchPrefix: 'mopilot/', worktreeRoot: null });
  assert.equal(worktreeRootOf(loadPrefs({ ...v2, ...patch }), legacy.home), '/Users/me/.mopilot/worktrees');
  // typed by hand with ~, a trailing slash or a folder inside it: the same folder
  for (const worktreeRoot of ['~/.codex/worktrees', '/Users/me/.codex/worktrees/', '/Users/me/.codex/worktrees/mine'])
    assert.deepEqual(defaultsPatch({ prefsVersion: 2, worktreeRoot }, legacy), { prefsVersion: PREFS_VERSION, worktreeRoot: null });
  // a folder of the user's own stays, and a version 2 profile's default chat folder isn't changed to Codex's
  assert.deepEqual(defaultsPatch({ prefsVersion: 2, branchPrefix: 'me/', worktreeRoot: '/wt', projectlessFolder: null }, legacy), {
    prefsVersion: PREFS_VERSION,
  });
  assert.equal(defaultsPatch({ ...v2, ...patch }, legacy), null);
});

test("inCodexWorktrees: the Codex app's worktree folder or one inside it, typed any way; nothing else", () => {
  const yes = ['~/.codex/worktrees', ' /Users/me/.codex/worktrees ', '/Users/me/.codex/worktrees//', '/Users/me/.codex/worktrees/a/b'];
  for (const r of yes) assert.equal(inCodexWorktrees(r, '/Users/me', '/Users/me/.codex'), true, r);
  const no = [
    null,
    undefined,
    3,
    '',
    '  ',
    '~',
    '/Users/me/.codex',
    '/Users/me/.codex/worktrees-2',
    '~other/.codex/worktrees',
    'worktrees',
  ];
  for (const r of no) assert.equal(inCodexWorktrees(r, '/Users/me', '/Users/me/.codex'), false, String(r));
  // another case (macOS and Windows disks ignore it), and ~/.codex's folder when CODEX_HOME is elsewhere
  assert.equal(inCodexWorktrees('/Users/Me/.Codex/Worktrees', '/Users/me', '/Users/me/.codex'), true);
  assert.equal(inCodexWorktrees('~/.codex/worktrees', '/Users/me', '/opt/codex'), true);
  assert.equal(inCodexWorktrees('/opt/codex/worktrees/x', '/Users/me', '/opt/codex'), true);
  // Windows: backslashes and the home folder's own spelling
  assert.equal(inCodexWorktrees('C:\\Users\\me\\.codex\\worktrees\\x', 'C:\\Users\\me', 'C:\\Users\\me\\.codex'), true);
  assert.equal(inCodexWorktrees('~\\.codex\\worktrees', 'C:\\Users\\me', 'C:\\Users\\me\\.codex'), true);
});

test('what new chats start with loads only in the shapes the app writes', () => {
  const p = loadPrefs({
    newChatStart: 'default',
    lastHarness: 'claude',
    newChatDefault: { harness: 'codex', model: 'gpt-6.2-sol', effort: '' },
  });
  assert.equal(p.newChatStart, 'default');
  assert.equal(p.lastHarness, 'claude');
  assert.deepEqual(p.newChatDefault, { harness: 'codex', model: 'gpt-6.2-sol', effort: null });
  assert.deepEqual(loadPrefs({ newChatDefault: { harness: 'acp:opencode', model: 3, effort: 'high' } }).newChatDefault, {
    harness: 'acp:opencode',
    model: null,
    effort: 'high',
  });
  // a hand-edited or older file: the defaults (follow the last used, nothing used yet, no fixed default)
  const bad = loadPrefs({ newChatStart: 'sometimes', lastHarness: 'acp:', newChatDefault: { harness: 'nobody', model: 'x' } });
  assert.deepEqual([bad.newChatStart, bad.lastHarness, bad.newChatDefault], ['last', null, null]);
  assert.equal(loadPrefs({ newChatDefault: 'codex' }).newChatDefault, null);
  assert.equal(loadPrefs({}).newChatDefault, null);
});
