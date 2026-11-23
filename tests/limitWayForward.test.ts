// src/store/chats.ts suggestOtherHarness: a chat at its usage limit is noted once and offered a way forward on
// every harness family, retaining the same stable chat when its next message switches harness.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, callsOf, impl, resetAll, flush } from './support/store-harness.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const { store: S, resetState } = await loadStore();
const st = () => S.useStore.getState();
const set = S.useStore.setState;
const { noteOwner } = await import('../src/harness/ownership.ts');
const { ALREADY_ENDED, ALREADY_SWITCHED } = await import('../src/store/liveAction.ts');
noteOwner('cl', 'claude');

beforeEach(() => {
  resetState();
  resetAll();
});

test('default and legacy reset preferences never announce an automatic harness switch', () => {
  assert.equal(st().prefs.autoContinueOnLimit, true);
  assert.equal(st().prefs.autoSwitchHarnessOnLimit, false);
  for (const from of ['codex', 'claude', 'acp'] as const) {
    for (const resume of [false, true]) {
      const chatId = from === 'acp' ? 'acp:kimi:legacy' : from === 'claude' ? 'cl' : 'a';
      set({
        prefs: { ...st().prefs, autoContinueOnLimit: resume, autoSwitchHarnessOnLimit: undefined as any },
        toasts: [],
        runtime: { [chatId]: { turns: [{ id: 'legacy', items: [] }] } as any },
        conn: 'ready',
        models: [{ model: 'gpt-x', displayName: 'GPT X' }] as any,
        claude: { status: { state: 'ready' } as any, models: [{ id: 'son', label: 'Sonnet', isDefault: true }] as any },
      });
      S.suggestOtherHarness(chatId, from);
      assert.equal(st().toasts.length, 1, `${from}: the manual continuation stays available`);
      assert.doesNotMatch(st().runtime[chatId].turns[0].items[0].text, /Continuing on/);
      assert.equal(callsOf('session.patch').length, 0);
    }
  }
});

test('a translator-owned limit note retains the recovery toast without appending a second generic note', () => {
  set({ runtime: { cl: { turns: [{ id: 't', items: [] }] } as any } });
  S.suggestOtherHarness('cl', 'claude', false);
  assert.deepEqual(st().runtime.cl.turns[0].items, []);
  assert.equal(st().toasts.length, 1);
  assert.equal(st().toasts[0].action!.label, 'Set up Codex');
});

test('suggestOtherHarness notes the limit once and offers the other harness when it is ready', async () => {
  set({
    runtime: { a: { turns: [{ id: 't', items: [] }] } as any },
    claude: {
      status: { state: 'ready' } as any,
      models: [
        { id: 'opus', label: 'Opus', isDefault: false },
        { id: 'son', label: 'Sonnet', isDefault: true },
      ] as any,
    },
  });
  S.suggestOtherHarness('a', 'codex');
  S.suggestOtherHarness('a', 'codex');
  assert.equal(st().runtime.a.turns[0].items.filter((i: any) => i.kind === 'limit').length, 1);
  assert.match(st().runtime.a.turns[0].items[0].id, /^limit-[0-9a-f-]{36}$/);
  const t = st().toasts[0];
  assert.equal(t.action!.label, 'Continue on Claude Code');
  t.action!.run();
  await flush();
  assert.deepEqual(callsOf('session.patch')[0][1], {
    pendingSwitch: { harness: 'claude', model: null, modelLabel: 'Sonnet', mode: 'auto' },
  });
  // the selection wins, then the default, then the first model
  set({ prefs: { ...st().prefs, claudeSelection: { model: 'opus', effort: null, fast: false } }, toasts: [] });
  S.suggestOtherHarness('none', 'codex');
  st().toasts[0].action!.run();
  assert.equal(callsOf('session.patch').at(-1)![1].pendingSwitch.model, 'opus');
  // to Codex: needs Codex usable and a model
  set({ toasts: [], conn: 'ready', models: [{ model: 'gpt-6.1-sol', displayName: 'gpt-6.1-sol', isDefault: false }] as any });
  S.suggestOtherHarness('cl', 'claude');
  assert.equal(st().toasts[0].action!.label, 'Continue on Codex');
  st().toasts[0].action!.run();
  await flush();
  // the label the switch divider shows later: the picker's name, not the raw id
  assert.equal(callsOf('session.patch').at(-1)![1].pendingSwitch.modelLabel, 'GPT-6.1 Sol');
  // the other harness can't run: the way on is where it is set up
  set({ toasts: [], conn: 'error' });
  S.suggestOtherHarness('cl', 'claude');
  assert.equal(st().toasts[0].action!.label, 'Set up Codex');
  set({ toasts: [], conn: 'ready', models: [] });
  S.suggestOtherHarness('cl', 'claude');
  assert.equal(st().toasts[0].action!.label, 'Set up Codex');
  st().toasts[0].action!.run();
  await flush();
  await flush();
  assert.deepEqual([st().route.name, (st().route as any).section], ['settings', 'codex']);
  // the note left in the chat offers it too, worked out on its chat's harness when shown
  assert.match(S.limitNoteAction('a').label, /^(Continue on|Set up) /);
});

test('the limit toast reads its chat at the click: one that switched since says so and does nothing (#1988)', async () => {
  set({
    runtime: { a: { turns: [{ id: 't', items: [] }] } as any },
    claude: { status: { state: 'ready' } as any, models: [{ id: 'son', label: 'Sonnet', isDefault: true }] as any },
  });
  S.suggestOtherHarness('a', 'codex');
  const t = st().toasts[0];
  assert.equal(t.action!.label, 'Continue on Claude Code');
  // the chat moved to Claude Code before the click
  set({
    segments: {
      a: [
        { nativeId: 'a', harness: 'codex', start: 0, count: 1 },
        { nativeId: 'claude:a', harness: 'claude', start: 1 },
      ] as any,
    },
  });
  t.action!.run();
  await flush();
  assert.equal(callsOf('session.patch').length, 0);
  assert.equal(st().toasts.at(-1)!.text, ALREADY_SWITCHED);
  // back on Codex, the model is the one picked by the click, not the one the toast saw
  set({
    segments: {},
    claude: { status: { state: 'ready' } as any, models: [{ id: 'opus', label: 'Opus', isDefault: true }] as any },
  });
  t.action!.run();
  await flush();
  assert.deepEqual(callsOf('session.patch').at(-1)![1].pendingSwitch, {
    harness: 'claude',
    model: null,
    modelLabel: 'Opus',
    mode: 'auto',
  });
  // the way the button named is gone (Claude Code can't run now): the click does nothing else and says so
  const patches = callsOf('session.patch').length;
  set({ claude: { status: { state: 'missing' } as any, models: [] } });
  t.action!.run();
  await flush();
  assert.equal(callsOf('session.patch').length, patches);
  assert.notEqual((st().route as any).section, 'claude');
  assert.equal(st().toasts.at(-1)!.text, ALREADY_ENDED);
});

test("a basic harness's chat at its limit continues in the same chat, on a first-tier harness that can run", async () => {
  impl['acp.acpLabelOf'] = () => 'OpenCode';
  set({
    toasts: [],
    conn: 'error',
    runtime: { 'acp:opencode:1': { turns: [{ id: 't', items: [] }] } as any },
    claude: { status: { state: 'ready' } as any, models: [{ id: 'son', label: 'Sonnet', isDefault: true }] as any },
  });
  S.suggestOtherHarness('acp:opencode:1', 'acp');
  S.suggestOtherHarness('acp:opencode:1', 'acp');
  const items = st().runtime['acp:opencode:1'].turns[0].items as any[];
  assert.deepEqual(
    items.map((i) => [i.kind, i.text]),
    [['limit', 'OpenCode limit reached. Continue on Claude Code in this chat.']],
  );
  const t = st().toasts[0];
  assert.equal(t.action!.label, 'Continue on Claude Code');
  t.action!.run();
  await flush();
  assert.deepEqual(callsOf('session.patch').at(-1)![1].pendingSwitch, {
    harness: 'claude',
    model: null,
    modelLabel: 'Sonnet',
    mode: 'auto',
  });
  assert.deepEqual(callsOf('switch.newChatWithSummary'), []);
  // the harness new chats start on comes first when it can run, else the first that can
  set({
    toasts: [],
    conn: 'ready',
    models: [{ model: 'gpt-x', displayName: 'GPT X' }] as any,
    prefs: { ...st().prefs, defaultHarness: 'claude' },
  });
  S.suggestOtherHarness('acp:opencode:2', 'acp');
  assert.equal(st().toasts[0].action!.label, 'Continue on Claude Code');
  set({ toasts: [], prefs: { ...st().prefs, defaultHarness: 'codex' } });
  S.suggestOtherHarness('acp:opencode:2', 'acp');
  assert.equal(st().toasts[0].action!.label, 'Continue on Codex');
  // nothing first-tier can run: Settings, where another harness is set up
  set({ toasts: [], conn: 'error', claude: { status: { state: 'missing' } as any, models: [] } });
  S.suggestOtherHarness('acp:opencode:2', 'acp');
  assert.equal(st().toasts[0].text, 'OpenCode limit reached. Set up another harness to continue.');
  assert.equal(st().toasts[0].action!.label, 'Harness settings');
  st().toasts[0].action!.run();
  await flush();
  await flush();
  assert.equal((st().route as any).section, 'harnesses');
  delete impl['acp.acpLabelOf'];
});

test('switching enabled suppresses the extra toast but waits for main to confirm the actual switch', () => {
  set({
    prefs: { ...st().prefs, autoContinueOnLimit: false, autoSwitchHarnessOnLimit: true },
    runtime: { a: { turns: [{ id: 't', items: [] }] } as any },
    claude: { status: { state: 'ready' } as any, models: [{ id: 'son', label: 'Sonnet', isDefault: true }] as any },
  });
  S.suggestOtherHarness('a', 'codex');
  S.suggestOtherHarness('a', 'codex');
  assert.equal(st().toasts.length, 0);
  const notes = st().runtime.a.turns[0].items.filter((i: any) => i.kind === 'limit');
  assert.deepEqual(
    notes.map((i: any) => i.text),
    ['Codex limit reached. You can switch to Claude Code and continue in this chat.'],
  );
  // no renderer state decides it: nothing was sent from here
  assert.equal(callsOf('session.patch').length, 0);
});

test('with it on, a limit main does not continue still has its toast: a pause, or no harness to go on with', () => {
  set({
    prefs: { ...st().prefs, autoContinueOnLimit: false, autoSwitchHarnessOnLimit: true },
    runtime: { a: { turns: [{ id: 't', items: [] }] } as any },
    claude: { status: { state: 'ready' } as any, models: [{ id: 'son', label: 'Sonnet', isDefault: true }] as any },
  });
  S.suggestOtherHarness('a', 'codex', true, true);
  assert.equal(st().toasts.length, 1, 'a rate-limit pause has no end of quota to switch for');
  assert.match(st().runtime.a.turns[0].items[0].text, /switch to Claude Code/);
  set({ toasts: [], claude: { status: { state: 'missing' } as any, models: [] } });
  S.suggestOtherHarness('b', 'codex');
  assert.equal(st().toasts.length, 1);
});

test('a MoMo chat at its limit is offered its brain chip, never a switch: only MoMo’s brain moves it (on every family)', async () => {
  // the main composer takes the command (lib/shortcutFocus.ts dispatchComposerCommand): this store test has no DOM
  const opened: any[] = [];
  const g = globalThis as any;
  const had = g.document;
  g.document = { activeElement: null, querySelector: () => ({ dispatchEvent: (e: Event) => opened.push(e.type) }) };
  try {
    for (const [chatId, family] of [
      ['mc', 'codex'],
      ['cl', 'claude'],
      ['acp:opencode:9', 'acp'],
    ] as const) {
      set({ momoChats: { [chatId]: 'main' }, toasts: [], runtime: { [chatId]: { turns: [{ id: 't', items: [] }] } as any } });
      S.suggestOtherHarness(chatId, family);
      const note = st().runtime[chatId].turns[0].items.find((i: any) => i.kind === 'limit');
      assert.match(note.text, / limit reached\. Change MoMo's brain to continue\.$/, family);
      const t = st().toasts[0];
      assert.equal(t.action!.label, 'Change brain');
      t.action!.run();
      assert.equal(S.limitNoteAction(chatId).label, 'Change brain');
    }
    assert.deepEqual(opened, ['open-model-picker', 'open-model-picker', 'open-model-picker']);
    assert.equal(callsOf('session.patch').length, 0, 'no window switch');
  } finally {
    g.document = had;
  }
});
