// Settings → All harnesses: what new chats use, and one row per installed harness (the rows themselves:
// tests/harnessRows.test.ts), with Update all, the route notes and the way to accounts.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { mount, click, fakeStore, settingsStubs } from './support/harness-ui-kit.ts';
import { defaultHarnessExports } from './support/default-harness-fakes.ts';
import { stubStore } from './support/stubs.ts';
import { useFakeNative } from './support/ports/native.ts';

const { createElement: h, act } = await import('react');
const calls: any[][] = [];
let status: Record<string, any> = {};
let views: Record<string, any> = {};
let fresh = 0;
let models: Record<string, any[]> = {};
const store = fakeStore<any>({ basicHarnesses: [], accounts: { accounts: [] }, claudeChats: {} });
stubStore({
  useStore: store.useStore,
  toastFailure: (title: string) => (error: Error) => calls.push(['error', title, error.message]),
  navigate: (r: any) => calls.push(['navigate', r]),
  ...defaultHarnessExports(store.get, (p) => store.set((s: any) => ({ prefs: { ...s.prefs, ...p } }))),
});
mock.module('../src/session/harness/select.ts', {
  namedExports: {
    useHarnessStatus: (h: string) => status[h],
    useHarnessAccounts: (h: string) => views[h],
    useHarnessModels: (h: string) => models[h] ?? [],
    selectionFor: (h: string, s: any = store.get()) => ({ model: s.prefs.selection?.[h] ?? null, effort: s.prefs.efforts?.[h] ?? null }),
    setSelection: (...a: any[]) => calls.push(['setSelection', ...a]),
  },
});
// how new chats start is its own (tests/newChatStart.test.ts): here the rows that save it
const startMode = (s: any) => (s.prefs.newChatStart === 'default' ? 'default' : 'last');
mock.module('../src/session/newChatStart.ts', {
  namedExports: {
    newChatStartMode: (s: any) => startMode(s),
    setNewChatStart: (mode: string) => {
      calls.push(['setNewChatStart', mode]);
      store.set((s: any) => ({ prefs: { ...s.prefs, newChatStart: mode } }));
    },
    setNewChatDefault: (harness: string, model: string | null, effort: string | null) => {
      calls.push(['setNewChatDefault', harness, model, effort]);
      store.set((s: any) => ({ prefs: { ...s.prefs, newChatDefault: { harness, model, effort } } }));
    },
  },
});
mock.module('../src/session/harness/acp.ts', { namedExports: { useFreshBasics: () => (fresh += 1) } });
mock.module('../src/components/harness/HarnessRows.tsx', {
  namedExports: {
    HarnessRow: ({ h: k }: any) => h('button', { 'data-harness-row': k }),
    BasicRow: ({ b }: any) => h('button', { 'data-harness-row': `acp:${b.id}` }),
  },
});
mock.module('../src/components/pages/Settings.tsx', { namedExports: settingsStubs });
// the Update all bar is its own (tests/harnessUpdatesBar.test.ts)
mock.module('../src/components/harness/HarnessUpdatesBar.tsx', {
  namedExports: { HarnessUpdatesBanner: () => h('i', { 'data-banner': true }), HarnessUpdatesFoot: () => h('i', { 'data-foot': true }) },
});
// the route note's own behavior is in tests/harnessRouteUI.test.ts; here only that every row has one under it
mock.module('../src/components/harness/RouteNotice.tsx', {
  namedExports: { RouteNotice: ({ harness, label }: any) => h('aside', { 'data-route-notice': harness, 'data-label': label }) },
});
const { AllHarnesses, NewChatsUse, DefaultHarnessSelect, NewChatsUseRow } = await import('../src/components/harness/AllHarnesses.tsx');

const basic = (p: any) => ({
  id: 'oc',
  label: 'opencode',
  state: 'admitted',
  reason: null,
  bin: null,
  version: '1.18',
  authMethods: [],
  login: null,
  ...p,
});
const text = (el: Element | null | undefined) => el?.textContent ?? '';

beforeEach(() => {
  calls.length = 0;
  status = { codex: { state: 'ready' }, claude: { state: 'ready' } };
  views = { codex: { active: null, accounts: [], multi: true }, claude: { active: null, accounts: [], multi: true } };
  models = {};
});

test('New chats use picks a model, which sets its harness too; the saved harness shows its own model or default', async () => {
  const opts = (host: HTMLElement) => [...host.querySelectorAll('option')].map((o) => `${o.value}=${o.textContent}`);
  const m = (id: string, p: any = {}) => ({ id, label: id.toUpperCase(), defaultEffort: 'medium', efforts: [], fast: false, ...p });
  models = {
    codex: [m('gpt', { isDefault: true }), m('mini'), m('old', { more: true })],
    claude: [m('opus', { isDefault: true, defaultEffort: 'high' })],
  };
  store.set({ prefs: { defaultHarness: 'codex' }, basicHarnesses: [basic({ id: 'opencode', label: 'opencode' })] });
  const r = await mount(h(DefaultHarnessSelect));
  // pinned versions stay in the picker's More versions; basic harnesses go by name
  assert.deepEqual(opts(r.host), [
    'codex::gpt=Codex · GPT',
    'codex::mini=Codex · MINI',
    'claude::opus=Claude Code · OPUS',
    'acp:opencode=opencode',
  ]);
  assert.equal(r.host.querySelector('select')!.value, 'codex::gpt');
  // the saved harness's own pick
  await act(async () => store.set({ prefs: { defaultHarness: 'codex', selection: { codex: 'mini' } } }));
  assert.equal(r.host.querySelector('select')!.value, 'codex::mini');
  const select = r.host.querySelector('select')!;
  await act(async () => {
    select.value = 'claude::opus';
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
  assert.equal(store.get().prefs.defaultHarness, 'claude');
  // the fixed default remembers it, and while new chats follow the last used it is Claude's next model too
  assert.deepEqual(calls.slice(-2), [
    ['setNewChatDefault', 'claude', 'opus', 'high'],
    ['setSelection', 'claude', { model: 'opus', effort: 'high' }, null],
  ]);
  // a basic harness sets no model
  calls.length = 0;
  await act(async () => {
    select.value = 'acp:opencode';
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
  assert.equal(store.get().prefs.defaultHarness, 'acp:opencode');
  assert.deepEqual(calls, [['setNewChatDefault', 'acp:opencode', null, null]]);
  await r.unmount();
  // a saved model that no longer exists, with no default listed: the harness by name
  models = { codex: [m('mini')], claude: [] };
  store.set({ prefs: { defaultHarness: 'codex', selection: { codex: 'gone' } }, basicHarnesses: [] });
  const gone = await mount(h(DefaultHarnessSelect));
  assert.equal(gone.host.querySelector('select')!.value, 'codex');
  assert.deepEqual(opts(gone.host), ['codex::mini=Codex · MINI', 'claude=Claude Code', 'codex=Codex']);
  await gone.unmount();
  // a harness page whose harness offers models is offered
  const row = await mount(h(NewChatsUseRow, { own: 'codex' }));
  assert.equal(text(row.host.querySelector('.row i')), '');
  await row.unmount();
  store.set({ prefs: {}, basicHarnesses: [] });
});

test('the list: every first-class harness, then every installed basic harness, and the way to accounts; read afresh on open', async () => {
  store.set({
    basicHarnesses: [
      basic({}),
      basic({ id: 'g', label: 'Gemini', state: 'missing' }),
      basic({ id: 'k', label: 'Kimi', state: 'checking' }),
    ],
  });
  fresh = 0;
  const r = await mount(h(AllHarnesses, { ids: ['codex', 'claude'] }));
  assert.ok(fresh > 0);
  assert.deepEqual(
    [...r.host.querySelectorAll('[data-harness-row]')].map((e) => e.getAttribute('data-harness-row')),
    ['codex', 'claude', 'acp:oc', 'acp:k'],
  );
  // one not installed is offered under Install another harness instead, as a basic one is
  status.codex = { state: 'missing' };
  await r.render(h(AllHarnesses, { ids: ['codex', 'claude'] }));
  assert.deepEqual(
    [...r.host.querySelectorAll('[data-harness-row]')].map((e) => e.getAttribute('data-harness-row')),
    ['claude', 'acp:oc', 'acp:k'],
  );
  status.codex = { state: 'ready' };
  await r.render(h(AllHarnesses, { ids: ['codex', 'claude'] }));
  // under each row (siblings: a row is a button) its route note; a version is on the harness's own page, not here;
  // what new chats use above the list, then Update all, when it last checked below
  const rows = [
    ['codex', 'Codex'],
    ['claude', 'Claude Code'],
    ['acp:oc', 'opencode'],
    ['acp:k', 'Kimi'],
  ];
  assert.equal(r.host.querySelector('[data-harness-version], .hver'), null);
  assert.deepEqual(
    [...r.host.querySelectorAll('[data-harness-row] + [data-route-notice]')].map((e) => [
      e.getAttribute('data-route-notice'),
      e.getAttribute('data-label'),
    ]),
    rows,
  );
  assert.equal(text(r.host.querySelector('.group .row b')), 'New chats use');
  assert.ok(r.host.querySelector('.group + section [data-banner] + .hrows'));
  assert.ok(r.host.querySelector('.hrows + [data-foot]'));
  await click([...r.host.querySelectorAll('button')].find((b) => b.textContent === 'Accounts & billing'));
  assert.deepEqual(calls.at(-1), ['navigate', { name: 'settings', section: 'accounts' }]);
  await r.unmount();
});

test('highest CLI version keeps the approved preference, reports a refusal, and offers a retry', async (t) => {
  let patch: (set: Record<string, unknown>, unset: string[]) => Promise<boolean> = async () => false;
  useFakeNative(t, { prefs: { patch: (set: Record<string, unknown>, unset: string[]) => patch(set, unset) } });
  store.set({ prefs: { defaultHarness: 'codex' }, basicHarnesses: [] });
  const r = await mount(h(AllHarnesses, { ids: ['codex', 'claude'] }));
  try {
    const control = () => r.host.querySelector('button[role="switch"]')!;
    assert.match(r.host.textContent ?? '', /Use highest installed CLI version.*Applies after restarting MoPilot/s);
    assert.equal(control().getAttribute('aria-checked'), 'false');
    await click(control());
    assert.equal(control().getAttribute('aria-checked'), 'false');
    assert.deepEqual(calls.splice(0), [['error', "Couldn't save CLI version selection", 'The change was refused.']]);
    patch = async (set, unset) => {
      assert.deepEqual([set, unset], [{ preferHighestCli: true }, []]);
      return true;
    };
    await click(control());
    assert.equal(control().getAttribute('aria-checked'), 'false', 'the renderer awaits main’s published preference');
    await act(async () => store.set({ prefs: { defaultHarness: 'codex', preferHighestCli: true } }));
    assert.equal(control().getAttribute('aria-checked'), 'true');
  } finally {
    await r.unmount();
    store.set({ prefs: {}, basicHarnesses: [] });
  }
});

test('New chats use lists only harnesses that can start a chat, and still names a saved one that cannot', async () => {
  const opts = (host: HTMLElement) =>
    [...host.querySelector('select')!.querySelectorAll('option')].map((o) => `${o.value}=${o.textContent}`);
  const desc = (host: HTMLElement) => text(host.querySelector('.row i'));
  const set = (p: any) => act(async () => store.set(p));
  store.set({
    prefs: { defaultHarness: 'acp:opencode' },
    basicHarnesses: [basic({ id: 'opencode', label: 'opencode' }), basic({ id: 'kimi', label: 'Kimi Code', state: 'signin' })],
  });
  // Codex left for its first chat can start one; Claude Code signed out cannot
  status = { codex: { state: 'detecting', idle: true }, claude: { state: 'signin' } };
  const r = await mount(h(NewChatsUse, { ids: ['codex', 'claude'] }));
  const select = r.host.querySelector('select')!;
  assert.equal(select.value, 'acp:opencode');
  assert.deepEqual(opts(r.host), ['codex=Codex', 'acp:opencode=opencode']);
  assert.equal(desc(r.host), 'Only harnesses that are ready are listed.');
  await act(async () => {
    select.value = 'codex';
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
  assert.equal(store.get().prefs.defaultHarness, 'codex');
  // ready, and an API key, both can start one
  status = { codex: { state: 'ready' }, claude: { state: 'apikey' } };
  await set({ prefs: { defaultHarness: 'claude' } });
  assert.deepEqual(opts(r.host), ['codex=Codex', 'claude=Claude Code', 'acp:opencode=opencode']);
  // saved but signed out: listed by name, and it says what new chats start in instead
  await set({ prefs: { defaultHarness: 'acp:kimi' } });
  assert.equal(r.host.querySelector('select')!.value, 'acp:kimi');
  assert.deepEqual(opts(r.host).at(-1), 'acp:kimi=Kimi Code');
  assert.equal(desc(r.host), 'Kimi Code isn’t signed in; new chats start in Codex');
  await r.unmount();
  // a harness page's select (#1880) offers the same harnesses, every first-class one by default
  const page = await mount(h(DefaultHarnessSelect));
  assert.deepEqual(opts(page.host), ['codex=Codex', 'claude=Claude Code', 'acp:opencode=opencode', 'acp:kimi=Kimi Code']);
  await page.unmount();
  store.set({ prefs: {}, basicHarnesses: [] });
});

test("a harness page's New chats use row says why its own harness isn't offered, and what runs while the default can't", async () => {
  const desc = (host: HTMLElement) => text(host.querySelector('.row i'));
  store.set({ prefs: { defaultHarness: 'claude' }, basicHarnesses: [basic({ id: 'opencode', label: 'opencode' })] });
  status = { codex: { state: 'signin' }, claude: { state: 'ready' } };
  // Codex signed out: its own page's select can't offer it, and says why
  const codex = await mount(h(NewChatsUseRow, { own: 'codex' }));
  assert.equal(desc(codex.host), 'Only harnesses that are ready are listed.');
  await codex.unmount();
  // offered: nothing to add
  const claude = await mount(h(NewChatsUseRow, { own: 'claude' }));
  assert.equal(desc(claude.host), '');
  // the default can't run: what new chats start in instead
  await act(async () => store.set({ prefs: { defaultHarness: 'acp:kimi' } }));
  assert.equal(desc(claude.host), 'Kimi Code isn’t installed; new chats start in Codex');
  await claude.unmount();
  store.set({ prefs: {}, basicHarnesses: [] });
});

test("an open new-chat draft's harness pick never changes the note on the saved default", async () => {
  const desc = (host: HTMLElement) => text(host.querySelector('.row i'));
  const set = (p: any) => act(async () => store.set(p));
  // the saved default runs; the draft picked one that cannot (opencode is not installed)
  store.set({ prefs: { defaultHarness: 'claude' }, basicHarnesses: [], newChatHarnessPick: 'acp:opencode' });
  const all = await mount(h(NewChatsUse, { ids: ['codex', 'claude'] }));
  const own = await mount(h(NewChatsUseRow, { own: 'claude' }));
  assert.equal(desc(all.host), 'Only harnesses that are ready are listed.');
  assert.equal(desc(own.host), '');
  // the saved default itself failing still says what runs instead
  await set({ prefs: { defaultHarness: 'acp:kimi' }, newChatHarnessPick: 'claude' });
  assert.equal(desc(all.host), 'Kimi Code isn’t installed; new chats start in Codex');
  assert.equal(desc(own.host), 'Kimi Code isn’t installed; new chats start in Codex');
  await all.unmount();
  await own.unmount();
  store.set({ prefs: {}, basicHarnesses: [], newChatHarnessPick: null });
});

test('New chats start with: the last used, or always the default above with its own thinking effort', async () => {
  const m = (id: string, p: any = {}) => ({ id, label: id.toUpperCase(), defaultEffort: 'medium', efforts: [], fast: false, ...p });
  models = {
    codex: [
      m('gpt', { isDefault: true, efforts: ['low', 'medium', 'xhigh'] }),
      m('mini', { efforts: ['low', 'high'], defaultEffort: 'high' }),
    ],
    claude: [m('opus', { isDefault: true })],
  };
  store.set({ prefs: { defaultHarness: 'codex', selection: { codex: 'mini' } }, basicHarnesses: [] });
  const r = await mount(h(NewChatsUse, { ids: ['codex', 'claude'] }));
  const rows = () => [...r.host.querySelectorAll('.row')].map((row) => text(row.querySelector('b')));
  const selectOf = (title: string) =>
    [...r.host.querySelectorAll('.row')].find((row) => text(row.querySelector('b')) === title)!.querySelector('select')!;
  const change = (el: HTMLSelectElement, value: string) =>
    act(async () => {
      el.value = value;
      el.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
  // following the last used: no effort of its own, and the default shows the harness's last pick
  assert.deepEqual(rows(), ['New chats use', 'New chats start with', 'Use highest installed CLI version']);
  assert.equal(selectOf('New chats start with').value, 'last');
  assert.equal(selectOf('New chats use').value, 'codex::mini');
  await change(selectOf('New chats start with'), 'default');
  assert.deepEqual(calls.at(-1), ['setNewChatStart', 'default']);
  // a fixed default for another harness: nothing of its own to show yet
  await act(async () =>
    store.set((s: any) => ({ prefs: { ...s.prefs, newChatDefault: { harness: 'claude', model: 'opus', effort: null } } })),
  );
  assert.deepEqual(rows(), ['New chats use', 'New chats start with', 'Use highest installed CLI version']);
  // its own: its model in the select, and its effort beside it
  await act(async () =>
    store.set((s: any) => ({ prefs: { ...s.prefs, newChatDefault: { harness: 'codex', model: 'gpt', effort: 'xhigh' } } })),
  );
  assert.equal(selectOf('New chats use').value, 'codex::gpt');
  assert.equal(selectOf('Thinking effort').value, 'xhigh');
  assert.deepEqual(
    [...selectOf('Thinking effort').querySelectorAll('option')].map((o) => o.textContent),
    ['Low', 'Medium', 'Extra high'],
  );
  calls.length = 0;
  await change(selectOf('Thinking effort'), 'low');
  assert.deepEqual(calls, [['setNewChatDefault', 'codex', 'gpt', 'low']]);
  // an effort the model doesn't offer shows its default; a model gone shows the harness's default model's
  await act(async () =>
    store.set((s: any) => ({ prefs: { ...s.prefs, newChatDefault: { harness: 'codex', model: 'mini', effort: 'xhigh' } } })),
  );
  assert.equal(selectOf('Thinking effort').value, 'high');
  await act(async () =>
    store.set((s: any) => ({ prefs: { ...s.prefs, newChatDefault: { harness: 'codex', model: null, effort: null } } })),
  );
  assert.equal(selectOf('Thinking effort').value, 'medium');
  calls.length = 0;
  await change(selectOf('Thinking effort'), 'xhigh');
  assert.deepEqual(calls, [['setNewChatDefault', 'codex', 'gpt', 'xhigh']]);
  // picking a model sets the fixed default only: the next new chat is set from it, not from a pick here
  calls.length = 0;
  await change(selectOf('New chats use'), 'codex::mini');
  assert.deepEqual(calls, [['setNewChatDefault', 'codex', 'mini', 'high']]);
  // a model with no default effort of its own: its first level
  models.codex = [m('gpt', { isDefault: true, efforts: ['low', 'high'], defaultEffort: null })];
  await act(async () =>
    store.set((s: any) => ({ prefs: { ...s.prefs, newChatDefault: { harness: 'codex', model: 'gpt', effort: null } } })),
  );
  assert.equal(selectOf('Thinking effort').value, 'low');
  // a model with no effort levels: no effort row
  models.codex = [m('gpt', { isDefault: true })];
  await act(async () =>
    store.set((s: any) => ({ prefs: { ...s.prefs, newChatDefault: { harness: 'codex', model: 'gpt', effort: null } } })),
  );
  assert.deepEqual(rows(), ['New chats use', 'New chats start with', 'Use highest installed CLI version']);
  await r.unmount();
  store.set({ prefs: {}, basicHarnesses: [] });
});

test('a harness picked by name while its models load keeps the model and effort it uses now', async () => {
  status = { codex: { state: 'ready' }, claude: { state: 'ready' } };
  models = { codex: [], claude: [] };
  store.set({ prefs: { defaultHarness: 'acp:opencode', selection: { claude: 'sonnet' }, efforts: { claude: 'low' } }, basicHarnesses: [] });
  const r = await mount(h(DefaultHarnessSelect));
  const select = r.host.querySelector('select')!;
  await act(async () => {
    select.value = 'claude';
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
  assert.deepEqual(calls, [['setNewChatDefault', 'claude', 'sonnet', 'low']]);
  await r.unmount();
  store.set({ prefs: {}, basicHarnesses: [] });
});
