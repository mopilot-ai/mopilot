// Linked children keep inherited native model, account, permission and notes grants after restart while later user choices still win.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ChatStarter } = require('../electron/platform/chatStart.cjs');
const { ClaudeAdapter } = require('../electron/harness/claude/adapter.cjs');
const { SessionStore } = require('../electron/session/state.cjs');
const { buildSessionOptions } = require('../electron/harness/claude/sessionOptions.cjs');
const { turnParams, chatPrefs } = require('../electron/harness/codexParams.cjs');

test('all starters save inherited configuration before announcement; a failed metadata write cannot announce it', async () => {
  const events: any[] = [];
  const metas = new Map<string, any>();
  const options = {
    model: 'sonnet',
    effort: 'low',
    permission: 'read-only',
    additionalDirectories: ['/notes'],
    account: 'parent-login',
    ignored: ['not config'],
  };
  const starter = new ChatStarter({
    prefs: () => ({ model: 'global' }),
    chats: { patchMeta: (id: string, meta: any) => (metas.set(id, meta), true) },
    claudeSession: () => {},
    claudeFork: async () => ({ sessionId: 'persistent' }),
    claudeOwn: (id: string, own: any) => events.push(['own', id, own]),
    acpSession: () => {},
    codexThread: async (args: any) => (events.push(['codex', args]), { id: 'codex-child' }),
    codexFork: async () => ({ id: 'codex-fork' }),
    started: (event: any) => {
      assert.ok(metas.has(event.chatId));
      events.push(['started', event]);
    },
  });
  const first = starter.startClaude('/work', '/repo', options);
  assert.deepEqual(metas.get(first), {
    worktreeOf: '/repo',
    config: { model: 'sonnet', effort: 'low', permission: 'read-only', additionalDirectories: ['/notes'] },
    account: { id: 'parent-login', pinned: false },
  });
  assert.deepEqual(events[0], ['own', first, options]);
  await starter.forkClaude('parent', '/work', '/repo', options);
  assert.equal(metas.get('claude:persistent').config.permission, 'read-only');
  const acp = starter.startAcp('kimi', '/work', null, { permission: 'read-only' });
  assert.equal(metas.get(acp).config.permission, 'read-only');
  await starter.startCodex('/work', null, options);
  assert.deepEqual(metas.get('codex-child').config, {
    model: 'sonnet',
    effort: 'low',
    permission: 'read-only',
    additionalDirectories: ['/notes'],
    serviceTier: null,
  });
  assert.equal(events.find((e) => e[0] === 'codex')[1].model, 'sonnet');
  await starter.forkCodex('parent', '/work', null, { model: 'gpt-own' });
  assert.equal(metas.get('codex-fork').config.model, 'gpt-own');
  starter.o.chats.patchMeta = () => false;
  const before = events.length;
  assert.throws(() => starter.startClaude('/work', null, options), /save the new chat/);
  assert.equal(events.length, before);
});

test('a recreated Claude adapter resumes the durable fork with its saved settings and notes, on the parent login', async () => {
  const chatId = 'claude:fork';
  const state = new SessionStore();
  const sent: any[] = [];
  const saved = { model: 'sonnet', effort: 'low', permission: 'read-only', additionalDirectories: ['/notes'] };
  const adapter = new ClaudeAdapter({
    api: {
      isLive: () => false,
      accounts: () => ({
        active: 'other-login',
        accounts: [
          { id: 'parent-login', loggedIn: true },
          { id: 'other-login', loggedIn: true },
        ],
      }),
      sessionCwd: async () => '/work',
    },
    state,
    prefs: () => ({ claudeSelection: { model: 'opus', effort: 'max', fast: true }, permission: 'full-access' }),
    savedSettings: () => saved,
    savedAccount: () => 'parent-login',
    send: async (...a: any[]) => (sent.push(a), {}),
    chatOf: (id: string) => id,
    ref: () => ({ id: 'fork', key: chatId, kind: 'claude' }),
  });
  adapter.registerSession(chatId, { cwd: '/work', resume: true });
  assert.equal(adapter.isFresh(chatId), false);
  assert.equal(
    (await adapter.startTurn(chatId, { id: 'fork', key: chatId, kind: 'claude' }, { text: 'continue', opts: { human: true } })).started,
    true,
  );
  const opts = sent[0][2];
  assert.deepEqual(
    [
      opts.resume,
      opts.forkFrom,
      opts.ephemeral,
      opts.cwd,
      opts.model,
      opts.effort,
      opts.permission,
      opts.account,
      opts.additionalDirectories,
    ],
    [true, undefined, false, '/work', 'sonnet', 'low', 'read-only', 'parent-login', ['/notes']],
  );
  const sdk = buildSessionOptions(opts);
  assert.deepEqual(sdk.additionalDirectories, ['/notes']);
  assert.equal(sdk.permissionMode, 'dontAsk');
  adapter.setOwn(chatId, { model: 'haiku', effort: 'medium', account: 'parent-login' });
  assert.deepEqual([adapter.settings(chatId, {}).model, adapter.settings(chatId, {}).effort], ['haiku', 'medium']);
  assert.equal(adapter.settings(chatId, { permission: 'default' }).permission, 'default');
  assert.deepEqual(adapter.settings(chatId, { additionalDirectories: ['/new-notes'] }).additionalDirectories, ['/new-notes']);
});

test('Codex applies saved permission and notes without granting writes in a read-only child', () => {
  const saved = { model: 'gpt-own', effort: 'low', permission: 'default', additionalDirectories: ['/notes', '/work'] };
  const prefs = chatPrefs({ permission: 'full-access', model: 'global' }, saved);
  const normal = turnParams('child', 'input', { text: 'go' }, prefs, '/work');
  assert.deepEqual(normal.sandboxPolicy.writableRoots, ['/work', '/notes']);
  assert.equal(normal.model, 'gpt-own');
  assert.equal(normal.effort, 'low');
  const readOnly = turnParams(
    'child',
    'input',
    { text: 'go', opts: { permission: 'read-only', additionalDirectories: ['/extra'] } },
    prefs,
    '/work',
  );
  assert.deepEqual(readOnly.sandboxPolicy, { type: 'readOnly', networkAccess: false });
  const full = turnParams('child', 'input', { text: 'go', opts: { permission: 'full-access' } }, prefs, '/work');
  assert.deepEqual(full.sandboxPolicy, { type: 'dangerFullAccess' });
  const noFolder = turnParams('child', 'input', { text: 'go', opts: { permission: 'plan', additionalDirectories: ['/extra'] } }, {}, null);
  assert.deepEqual(noFolder.sandboxPolicy.writableRoots, ['/extra']);
  assert.equal(noFolder.collaborationMode.mode, 'plan');
});

test('an inherited plan uses its saved base permission until explicitly leaving it', () => {
  const { claudeTurnSettings } = require('../electron/harness/claude/turnSettings.cjs');
  let saved: any = { permission: 'plan', planBasePermission: 'read-only' };
  const adapter: any = {
    prefs: () => ({ permission: 'full-access' }),
    pinnedModel: () => null,
    pinnedEffort: () => null,
    accountOf: () => null,
    savedSettings: () => saved,
    own: new Map(),
    probeInfo: () => null,
  };
  assert.equal(claudeTurnSettings(adapter, 'child', {}).basePermission, 'read-only');
  saved = { permission: 'plan' };
  assert.equal(claudeTurnSettings(adapter, 'child', {}).basePermission, 'default');
  saved = {};
  assert.equal(claudeTurnSettings(adapter, 'child', {}).basePermission, 'full-access');
  const prefs = chatPrefs({ permission: 'full-access' }, { permission: 'plan', planBasePermission: 'read-only' });
  const initial = turnParams('child', 'input', { text: 'go' }, prefs, '/work');
  assert.equal(initial.collaborationMode.mode, 'plan');
  assert.deepEqual(initial.sandboxPolicy, { type: 'readOnly', networkAccess: false });
});
