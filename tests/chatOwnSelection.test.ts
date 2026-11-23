// A chat keeps the model and effort it runs with (electron/session/keepSelection.cjs): a pick in one chat moves the new-chat
// default only, never another chat's next turn, on Claude Code and Codex, including chats made before chats kept them.
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { keepSelection, switchedConfig } = require('../electron/session/keepSelection.cjs');
const { adapterSettings } = require('../electron/session/adapterSettings.cjs');
const { ClaudeAdapter } = require('../electron/harness/claude/adapter.cjs');
const { pendingReads } = require('../electron/harness/claude/turnStart.cjs');
const { CodexTurns } = require('../electron/harness/codexTurns.cjs');
const { SessionStore } = require('../electron/session/state.cjs');
const { createPanelOptions } = require('../electron/app/chromePanelOptions.cjs');

/** The chat store as adapters see it: records by id, patchMeta merging top-level meta keys. */
function chatStore(records: [string, any][]) {
  const map = new Map<string, any>(records);
  const writes: [string, any][] = [];
  return {
    records: map,
    writes,
    patchMeta(id: string, patch: any) {
      writes.push([id, patch]);
      const r = map.get(id);
      if (!r) return false;
      map.set(id, { ...r, meta: { ...r.meta, ...patch } });
      return true;
    },
  };
}

test('keepSelection fills only the settings a chat has none of; a key that is there, even null, stays', () => {
  const chats = chatStore([
    ['a', { meta: { config: { effort: null, permission: 'plan' } } }],
    ['b', { meta: {} }],
    ['c', { meta: { config: 'broken' } }],
  ]);
  assert.equal(keepSelection(chats, 'a', { model: 'sonnet', effort: 'high' }), true);
  assert.deepEqual(chats.records.get('a').meta.config, { effort: null, permission: 'plan', model: 'sonnet' });
  // nothing missing: no write
  assert.equal(keepSelection(chats, 'a', { model: 'opus', effort: 'low' }), false);
  // an undefined value is no pick
  assert.equal(keepSelection(chats, 'b', { model: undefined }), false);
  assert.equal(keepSelection(chats, 'b', { effort: 'low' }), true);
  assert.deepEqual(chats.records.get('b').meta.config, { effort: 'low' });
  assert.equal(keepSelection(chats, 'c', { effort: 'low' }), true);
  assert.deepEqual(chats.records.get('c').meta.config, { effort: 'low' });
  // a chat main doesn't know (an ephemeral helper): nothing written
  assert.equal(keepSelection(chats, 'gone', { effort: 'low' }), false);
  assert.equal(chats.writes.length, 3);
  // adapters reach it through the chat store main owns
  const live = { chats };
  assert.equal(adapterSettings(live).keepSelection('b', { model: 'opus' }), true);
  assert.equal(chats.records.get('b').meta.config.model, 'opus');
});

function claudeWorld(o: { config?: any; sessionSettings?: any; own?: any } = {}) {
  let prefs: any = { claudeSelection: { model: 'opus', effort: 'low', fast: false } };
  const chats = chatStore([
    ['claude:a', { meta: { config: { model: 'opus', effort: 'low' } } }],
    ['claude:b', { meta: o.config === undefined ? {} : { config: o.config } }],
  ]);
  const saved = adapterSettings({ chats });
  const sent: any[] = [];
  const reads: string[] = [];
  const adapter = new ClaudeAdapter({
    api: {
      isLive: () => false,
      accounts: () => ({ active: 'me', accounts: [{ id: 'me', loggedIn: true }] }),
      sessionCwd: async () => '/work',
      ...(o.sessionSettings === undefined ? {} : { sessionSettings: async (id: string) => (reads.push(id), o.sessionSettings()) }),
    },
    state: new SessionStore(),
    prefs: () => prefs,
    savedSettings: saved.savedSettings,
    keepSelection: saved.keepSelection,
    send: async (...a: any[]) => (sent.push(a), {}),
    chatOf: (id: string) => id,
    ref: (chatId: string) => ({ id: chatId.slice(7), key: chatId, kind: 'claude' }),
  });
  if (o.own) adapter.setOwn('claude:b', o.own);
  const turn = async (chatId: string, opts: any = {}, text = 'go') => {
    adapter.registerSession(chatId, { cwd: '/work', resume: true });
    const r = await adapter.startTurn(chatId, { id: chatId.slice(7), key: chatId, kind: 'claude' }, { text, opts });
    assert.equal(r.started, true);
    return sent.at(-1)[2].effort;
  };
  /** The user picks an effort in chat A: its own config and the new-chat default (src/session/harness/select.ts setSelection). */
  const pickInA = (effort: string) => {
    chats.patchMeta('claude:a', { config: { model: 'opus', effort } });
    adapter.setOwn('claude:a', { model: 'opus', effort, account: 'me' });
    prefs = { claudeSelection: { model: 'opus', effort, fast: false } };
  };
  return { adapter, chats, turn, pickInA, reads, sent };
}

test('Claude Code: a pick in one chat never moves another chat that had no effort of its own', async () => {
  const w = claudeWorld();
  assert.equal(await w.turn('claude:b'), 'low');
  // its first turn kept what it ran with
  assert.deepEqual(w.chats.records.get('claude:b').meta.config, { model: 'opus', effort: 'low' });
  w.pickInA('max');
  assert.equal(await w.turn('claude:a'), 'max');
  assert.equal(await w.turn('claude:b'), 'low');
});

test('Claude Code: a chat made before chats kept their effort runs on the one its session last ran with', async () => {
  const w = claudeWorld({ sessionSettings: () => ({ model: 'claude-opus-5-5', effort: 'high' }) });
  w.pickInA('max');
  assert.equal(await w.turn('claude:b'), 'high');
  assert.deepEqual(w.reads, ['b']);
  // read once: from then on the chat's own
  assert.equal(await w.turn('claude:b'), 'high');
  assert.deepEqual(w.reads, ['b']);
  // a session that recorded no effort ran on the model's default: so does the chat, not the new-chat default
  const plain = claudeWorld({ sessionSettings: () => ({ model: 'claude-opus-5-5', effort: null }) });
  plain.pickInA('max');
  assert.equal(await plain.turn('claude:b'), null);
  assert.equal(plain.chats.records.get('claude:b').meta.config.effort, null);
});

test('Claude Code: no transcript, a failed read, or an effort the chat already has: the transcript decides nothing', async () => {
  const none = claudeWorld({ sessionSettings: () => null });
  assert.equal(await none.turn('claude:b'), 'low');
  const failing = claudeWorld({
    sessionSettings: () => {
      throw new Error('EACCES');
    },
  });
  assert.equal(await failing.turn('claude:b'), 'low');
  const own = claudeWorld({ config: { model: 'opus', effort: 'medium' }, sessionSettings: () => ({ effort: 'high' }) });
  assert.equal(await own.turn('claude:b'), 'medium');
  assert.deepEqual(own.reads, []);
  // a window already told main the chat's effort: that is what it runs on
  const pushed = claudeWorld({ own: { model: 'opus', effort: 'medium', account: 'me' }, sessionSettings: () => ({ effort: 'high' }) });
  assert.equal(await pushed.turn('claude:b'), 'medium');
  assert.deepEqual(pushed.reads, []);
  // an api without the reader (an older bridge): the defaults, kept
  const bare = claudeWorld();
  assert.equal(await bare.turn('claude:b'), 'low');
});

test('Codex: a chat with no settings of its own keeps the ones its first turn ran with', async () => {
  let prefs: any = { model: 'gpt-a', effort: 'low', serviceTier: 'default' };
  const chats = chatStore([['old', { meta: {} }]]);
  const requests: any[] = [];
  const adapter: any = {
    ensureResumed: () => Promise.resolve(),
    touch() {},
    nativeLifecycle: { turnEnded: () => Promise.resolve() },
    prefs: () => prefs,
    chatConfig: (id: string) => chats.records.get(id)?.meta?.config,
    keepSelection: adapterSettings({ chats }).keepSelection,
    meta: new Map([['nat', { preview: 'x' }]]),
    emit: () => true,
    defaults: () => Promise.resolve({}),
    state: { patch() {} },
    request: async (method: string, params: any) => (requests.push(params), { turn: { id: 'T1' } }),
  };
  const ref = { kind: 'codex', id: 'nat', key: 'nat' };
  await CodexTurns.prototype.startTurn.call(adapter, 'old', ref, { id: 'm1', text: 'hi' });
  assert.deepEqual(chats.records.get('old').meta.config, { model: 'gpt-a', effort: 'low', serviceTier: 'default' });
  // another chat's pick moves the defaults
  prefs = { model: 'gpt-b', effort: 'xhigh', serviceTier: 'priority' };
  await CodexTurns.prototype.startTurn.call(adapter, 'old', ref, { id: 'm2', text: 'again' });
  const settings = requests.at(-1).collaborationMode.settings;
  assert.deepEqual([settings.model, settings.reasoning_effort], ['gpt-a', 'low']);
});

test("switchedConfig drops the harness it left's model, effort and tier; keeps the switch's model and everything else", () => {
  const config = { model: 'opus', effort: 'max', serviceTier: 'priority', permission: 'plan', additionalDirectories: ['/n'] };
  assert.deepEqual(switchedConfig(config, 'gpt-a'), { permission: 'plan', additionalDirectories: ['/n'], model: 'gpt-a' });
  // a basic harness's switch names no model
  assert.deepEqual(switchedConfig(config, ''), { permission: 'plan', additionalDirectories: ['/n'] });
  assert.deepEqual(switchedConfig(undefined, null), { model: null });
  // an effort the switch picked wins over what the harness's earlier segment kept
  assert.deepEqual(switchedConfig({}, 'm', { effort: 'high' }, 'medium'), { model: 'm', effort: 'medium' });
  assert.deepEqual(switchedConfig({}, 'm', { effort: 'high' }, null), { model: 'm', effort: 'high' });
});

test("Claude Code: a message's own model and effort (a scheduled run's) run that turn but are not kept as the chat's", async () => {
  const w = claudeWorld();
  assert.equal(await w.turn('claude:b', { model: 'sonnet', effort: 'max' }), 'max');
  assert.equal(w.sent.at(-1)[2].model, 'sonnet');
  assert.deepEqual(w.chats.records.get('claude:b').meta.config, { model: 'opus', effort: 'low' });
  w.pickInA('medium');
  assert.equal(await w.turn('claude:b'), 'low');
  // one with only its own effort is not kept either
  const e = claudeWorld();
  await e.turn('claude:b', { effort: 'max' });
  assert.equal(e.chats.records.get('claude:b').meta.config.effort, 'low');
});

test('Claude Code: turns started while an old chat reads its transcript share the one read and keep their order', async () => {
  let release!: (v: any) => void;
  const w = claudeWorld({ sessionSettings: () => new Promise((r) => (release = r)) });
  w.adapter.registerSession('claude:b', { cwd: '/work', resume: true });
  const ref = { id: 'b', key: 'claude:b', kind: 'claude' };
  const first = w.adapter.startTurn('claude:b', ref, { text: 'one', opts: {} });
  const second = w.adapter.startTurn('claude:b', ref, { text: 'two', opts: {} });
  assert.deepEqual(w.reads, ['b']);
  release({ effort: 'high' });
  await Promise.all([first, second]);
  // the messages reach the CLI in the order they were sent, both on the session's effort
  assert.deepEqual(
    w.sent.map((c: any) => [JSON.stringify(c[3]).match(/one|two/)?.[0], c[2].effort]),
    [
      ['one', 'high'],
      ['two', 'high'],
    ],
  );
  assert.equal(pendingReads(w.adapter), 0);
  // an adapter that never read has none
  assert.equal(pendingReads(claudeWorld().adapter), 0);
  // an adapter that never read has none
  assert.equal(pendingReads(claudeWorld().adapter), 0);
});

test("Chrome side panel: a Claude Code chat's pick is saved with the chat, its other settings kept", async () => {
  const chats = chatStore([
    ['claude:1', { meta: { config: { permission: 'plan' } } }],
    ['claude:2', { meta: {} }],
  ]);
  const own: any[] = [];
  let prefs: any = { claudeSelection: { model: 'sonnet', effort: 'low', fast: true } };
  const menus = createPanelOptions({
    live: {
      chats,
      claudeTurns: { setOwn: (...a: any[]) => own.push(a), pickOf: () => 'work' },
      // no switch waits: picks go to the chat itself
      controller: { state: new Map(), ref: (id: string) => ({ key: id }) },
      patchPrefs: (set: any) => ((prefs = { ...prefs, ...set }), true),
    },
    claude: { probeInfo: () => null },
    prefs: () => prefs,
    kindOf: (id: string) => (id.startsWith('claude:') ? 'claude' : null),
    labelOf: () => null,
  });
  await menus.choose({ chatId: 'claude:1', model: 'opus', effort: 'max' });
  assert.deepEqual(chats.records.get('claude:1').meta.config, { permission: 'plan', model: 'opus', effort: 'max' });
  assert.deepEqual(own, [['claude:1', { model: 'opus', effort: 'max', account: 'work' }]]);
  await menus.choose({ chatId: 'claude:2', model: 'opus', effort: null });
  assert.deepEqual(chats.records.get('claude:2').meta.config, { model: 'opus', effort: null });
  // a chat main doesn't keep (gone meanwhile): the default only
  await menus.choose({ chatId: 'claude:gone', model: 'sonnet', effort: 'low' });
  assert.equal(chats.records.has('claude:gone'), false);
  assert.deepEqual(prefs.claudeSelection, { model: 'sonnet', effort: 'low', fast: true });
});

test("Claude Code: a transcript read that never settles holds the chat's turns no longer than its limit", async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const w = claudeWorld({ sessionSettings: () => new Promise(() => {}) });
    w.adapter.registerSession('claude:b', { cwd: '/work', resume: true });
    const turn = w.adapter.startTurn('claude:b', { id: 'b', key: 'claude:b', kind: 'claude' }, { text: 'go', opts: {} });
    await Promise.resolve();
    assert.equal(w.sent.length, 0);
    mock.timers.tick(2000);
    assert.equal((await turn).started, true);
    // nothing read: the defaults it ran on are kept
    assert.equal(w.chats.records.get('claude:b').meta.config.effort, 'low');
  } finally {
    mock.timers.reset();
  }
});
