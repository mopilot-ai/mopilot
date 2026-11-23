// src/store/chats.ts: a new chat's harness pick in the model picker is the open draft's, never the saved default.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, callsOf, impl, resetAll, bootImpls, flush } from './support/store-harness.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const { store: S, resetState } = await loadStore();
const st = () => S.useStore.getState();
const set = S.useStore.setState;

beforeEach(() => {
  resetState();
  resetAll();
  set({ conn: 'ready', requiresAuth: false, claude: { status: { state: 'ready' } as any, models: [] }, basicHarnesses: [] });
});

test("a pick other than the saved default is the draft's harness; the saved default and its resolution stay", () => {
  S.setDefaultHarness('codex');
  assert.equal(st().newChatHarnessPick, null);
  S.pickNewChatHarness('claude');
  assert.equal(st().newChatHarnessPick, 'claude');
  assert.equal(st().prefs.defaultHarness, 'codex');
  assert.equal(S.defaultHarness().kind, 'claude');
  assert.equal(S.newChatHarness(), 'claude');
  assert.equal(S.savedDefaultHarness(), 'codex');
  assert.equal(S.savedDefaultResolved().kind, 'codex', 'Settings and scheduled tasks read the saved one');
  assert.equal(callsOf('prefs.patch').length, 0, 'nothing is written');
  // picking the saved default again drops the pick
  S.pickNewChatHarness('codex');
  assert.equal(st().newChatHarnessPick, null);
  assert.equal(S.defaultHarness().kind, 'codex');
});

test('a basic harness pick resolves like any default, and a pick that cannot run stands in with its fallback', () => {
  set({ basicHarnesses: [{ id: 'kimi', state: 'admitted' }] as any });
  S.pickNewChatHarness('acp:kimi');
  assert.equal(S.defaultHarness().kind, 'acp:kimi');
  assert.equal(S.newChatBasic(), 'kimi');
  S.pickNewChatHarness('acp:gone');
  assert.equal(S.defaultHarness().kind, 'codex');
  assert.equal(S.savedDefaultResolved().kind, 'codex');
});

test("setting the default in Settings ends the draft's pick; so does resetting the new-chat defaults", () => {
  S.pickNewChatHarness('claude');
  S.setDefaultHarness('claude');
  assert.equal(st().newChatHarnessPick, null);
  assert.equal(st().prefs.defaultHarness, 'claude');
  S.pickNewChatHarness('codex');
  assert.equal(st().newChatHarnessPick, 'codex');
  S.resetNewChatDefaults();
  assert.equal(st().newChatHarnessPick, null);
  assert.equal(S.defaultHarness().kind, 'claude');
});

test("starting a chat ends the draft's pick unless the next draft picked meanwhile", async () => {
  bootImpls();
  await S.boot();
  await flush();
  impl['claude.startClaudeThread'] = (o: any) => `cl-${o.cwd ?? 'x'}`;
  S.pickNewChatHarness('claude');
  set({ newChatCwd: '/f', newChatProjectId: null });
  const id = await S.createChatThread('x');
  assert.ok(id?.startsWith('cl-'), 'the chat started on the picked harness');
  assert.equal(st().newChatHarnessPick, null);
  assert.equal(S.defaultHarness().kind, st().prefs.defaultHarness ?? 'codex');
  // a pick made on the next draft while this chat was starting stays with that draft
  let started!: (id: string) => void;
  impl['claude.startClaudeThread'] = () => new Promise((r) => (started = r));
  S.pickNewChatHarness('claude');
  const pending = S.createChatThread('x');
  await flush();
  set({ basicHarnesses: [{ id: 'kimi', state: 'admitted' }] as any });
  S.pickNewChatHarness('acp:kimi');
  started('cl-2');
  await pending;
  assert.equal(st().newChatHarnessPick, 'acp:kimi');
});

test('a completed local start cannot retire the same harness chosen again for a replacement draft', async () => {
  bootImpls();
  await S.boot();
  await flush();
  let started!: (id: string) => void;
  impl['claude.startClaudeThread'] = () => new Promise((resolve) => (started = resolve));
  set({ newChatCwd: '/f', newChatProjectId: null });
  S.pickNewChatHarness('claude');
  const pending = S.createChatThread('x');
  await flush();
  S.resetNewChatDefaults();
  S.pickNewChatHarness('claude');
  started('cl-2');
  assert.equal(await pending, 'cl-2');
  assert.equal(st().newChatHarnessPick, 'claude');
});
