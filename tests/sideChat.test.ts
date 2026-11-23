import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSideChat, replaceBlankPaneTab } from '../src/store/sideChat.ts';
import { chatPaneForView, chatTabsFor, parkChatPane, type ChatPaneState } from '../src/store/chatPanes.ts';
import type { PaneTab } from '../src/store/state';
import { focusPrimary } from '../src/store/split.ts';
import type { Route } from '../src/store/types.ts';
import { deferred } from './support/async-scenarios.ts';

/** A navigation of the primary pane, which focuses it. */
const forRoute = (s: ChatPaneState, route: Route, chatOf?: (id: string) => string) =>
  chatPaneForView(s, { route, split: focusPrimary(s.split) }, chatOf);

function harness(
  options: {
    nativeId?: string;
    currentNativeId?: () => string;
    ownerGate?: NonNullable<Parameters<typeof createSideChat>[0]['openHostSideChat']>;
    failure?: unknown;
    claudeFailure?: unknown;
    gate?: Promise<void>;
    tabs?: PaneTab[];
    handled?: boolean | 'refused';
    scoped?: boolean;
    inherit?: (chatId: string, threadId: string) => Promise<void>;
  } = {},
) {
  const events: { kind: string; value?: any }[] = [];
  const nativeId = options.nativeId ?? 'native-source';
  const source = { id: 'main-chat', turns: [{ id: 'existing-turn' }] };
  const thread = { id: 'side-chat', ephemeral: true, cwd: '/repo', turns: [{ id: 'inherited-turn' }] } as any;
  const state = { tabs: options.tabs ?? ([] as PaneTab[]), drafts: {} as Record<string, any>, active: '' };
  let pane: ChatPaneState = {
    route: { name: 'thread', id: 'main-chat' },
    paneTabs: state.tabs,
    paneActive: '',
    chatPanes: {},
    diffPanel: { open: false },
    paneFull: false,
    summaryOpen: true,
  };
  function applyPane(patch: Partial<ChatPaneState>) {
    pane = { ...pane, ...patch };
    state.tabs = pane.paneTabs;
    state.active = pane.paneActive;
  }
  let forks = 0;
  const open = createSideChat({
    nativeOf: options.currentNativeId ?? (() => nativeId),
    familyOf: (id) => (id.startsWith('acp:') ? 'acp' : id.startsWith('claude:') ? 'claude' : 'codex'),
    openHostSideChat: options.ownerGate,
    openClaudeSideChat: async (...args) => {
      events.push({ kind: 'claude', value: args });
      if (options.claudeFailure !== undefined) throw options.claudeFailure;
      return 'claude:side';
    },
    fork: async (params, hold) => {
      events.push({ kind: 'fork', value: { params, hold } });
      // Model the real app-server's constraint, so the previous request fails this UT.
      if (params.ephemeral && params.deferGoalContinuation) throw new Error('`deferGoalContinuation` cannot be combined with `ephemeral`');
      if (options.failure !== undefined) throw options.failure;
      await options.gate;
      return { thread: { ...thread, id: ++forks === 1 ? 'side-chat' : `side-chat-${forks}` } };
    },
    inheritAccount: async (chatId, threadId) => options.inherit?.(chatId, threadId),
    addThread: (value) => events.push({ kind: 'thread', value }),
    setDraft: (id, draft) => {
      state.drafts[id] = draft;
      events.push({ kind: 'draft', value: { id, draft } });
    },
    selectionAttachment: (text) => ({ kind: 'selection', text }) as any,
    hold: (id) => events.push({ kind: 'hold', value: id }),
    markLoaded: (id) => events.push({ kind: 'loaded', value: id }),
    getPaneTabs: (chatId) => (options.scoped ? chatTabsFor(pane, chatId) : state.tabs),
    getPaneActive: () => state.active,
    getDraft: (id) => state.drafts[id],
    addSelection: (id, text) => {
      events.push({ kind: 'selection', value: { id, text } });
      return options.handled ?? false;
    },
    focusPane: (tabId, id, sourceChatId) => {
      if (options.scoped) {
        const tab = chatTabsFor(pane, sourceChatId).find((t) => t.id === tabId)!;
        applyPane(parkChatPane(pane, tab) ?? { paneActive: tabId, diffPanel: { open: true } });
      } else state.active = tabId;
      events.push({ kind: 'focus', value: { tabId, id } });
    },
    openPane: (id, chatId, replaceTabId) => {
      const extra = { threadId: id, sourceChatId: chatId };
      if (options.scoped && !replaceTabId) {
        const tab: PaneTab = { id: `tab-${id}`, kind: 'chat', ...extra };
        applyPane(parkChatPane(pane, tab) ?? { paneTabs: [...pane.paneTabs, tab], paneActive: tab.id, diffPanel: { open: true } });
      } else if (replaceTabId) {
        const converted = replaceBlankPaneTab(state.tabs, 'chat', extra, replaceTabId);
        if (!converted) return;
        state.tabs = converted;
        state.active = replaceTabId;
      } else {
        state.tabs = [...state.tabs, { id: `tab-${id}`, kind: 'chat', ...extra }];
        state.active = `tab-${id}`;
      }
      events.push({ kind: 'pane', value: id });
    },
    toast: (text, level) => events.push({ kind: 'toast', value: { text, level } }),
  });
  return {
    open,
    events,
    source,
    state,
    navigate(id: string) {
      const route = { name: 'thread' as const, id };
      applyPane({ ...forRoute(pane, route), route });
    },
    get pane() {
      return pane;
    },
  };
}

test('a Codex side chat forks the active native segment with compatible temporary-chat parameters', async () => {
  const { open, events, source } = harness();
  assert.equal(await open(source.id, 'selected passage'), 'side-chat');
  assert.deepEqual(events[0], {
    kind: 'fork',
    value: {
      params: { threadId: 'native-source', ephemeral: true, excludeTurns: true },
      hold: true,
    },
  });
  assert.deepEqual(
    events.map((e) => e.kind),
    ['fork', 'thread', 'draft', 'hold', 'loaded', 'pane'],
  );
  assert.deepEqual(events.find((e) => e.kind === 'draft')?.value, {
    id: 'side-chat',
    draft: { text: '', attachments: [{ kind: 'selection', text: 'selected passage' }] },
  });
  const side = events.find((e) => e.kind === 'thread')!.value;
  assert.equal(side.ephemeral, true);
  assert.equal(side.cwd, '/repo');
  assert.deepEqual(side.turns, [], 'inherited history is hidden in the temporary pane');
  assert.deepEqual(source.turns, [{ id: 'existing-turn' }], 'main chat stays intact');
  assert.deepEqual(events.at(-1), { kind: 'pane', value: 'side-chat' });
});

test('a local parent that changes native session during the owner lookup does not fork the stale thread', async () => {
  const ownership = deferred<null>();
  let nativeId = 'codex-original';
  const h = harness({ ownerGate: () => ownership.promise, currentNativeId: () => nativeId });
  const request = h.open(h.source.id, 'selection');
  nativeId = 'claude:current';
  ownership.resolve(null);
  assert.equal(await request, undefined);
  assert.deepEqual(
    h.events.map((event) => event.kind),
    ['toast'],
  );
  assert.match(h.events[0].value.text, /parent chat changed/);
});

test('a side chat without a selection opens without a draft attachment', async () => {
  const { open, events } = harness();
  await open('main-chat');
  assert.deepEqual(
    events.map((e) => e.kind),
    ['fork', 'thread', 'hold', 'loaded', 'pane'],
  );
});

test('fork rejection shows the server error and never mounts a partial side chat', async () => {
  for (const failure of [new Error('Codex is disconnected'), 'request refused']) {
    const { open, events } = harness({ failure });
    assert.equal(await open('main-chat', 'selection'), undefined);
    assert.deepEqual(
      events.map((e) => e.kind),
      ['fork', 'toast'],
    );
    assert.deepEqual(events.at(-1)?.value, {
      text: `Couldn't open side chat: ${failure instanceof Error ? failure.message : failure}`,
      level: 'error',
    });
  }
});

test('Claude side chats receive the logical chat, active session and selected passage', async () => {
  const { open, events } = harness({ nativeId: 'claude:active-session' });
  assert.equal(await open('main-chat', 'selection'), 'claude:side');
  assert.deepEqual(events, [{ kind: 'claude', value: ['main-chat', 'claude:active-session', 'selection', undefined] }]);
});

test('asynchronous Claude fork errors also get a visible failure message', async () => {
  const { open, events } = harness({ nativeId: 'claude:active-session', claudeFailure: new Error('Session unavailable') });
  assert.equal(await open('main-chat'), undefined);
  assert.deepEqual(
    events.map((e) => e.kind),
    ['claude', 'toast'],
  );
  assert.deepEqual(events.at(-1)?.value, { text: "Couldn't open side chat: Session unavailable", level: 'error' });
});

test('unsupported ACP sessions show the reason without making a fork request', async () => {
  const { open, events } = harness({ nativeId: 'acp:kimi:active-session' });
  assert.equal(await open('main-chat'), undefined);
  assert.deepEqual(events, [{ kind: 'toast', value: { text: "Side chats aren't available for this harness", level: 'error' } }]);
});

test('repeated Ask in side chat focuses the same thread and preserves its stored draft', async () => {
  const { open, events, state } = harness();
  await open('main-chat', 'first passage');
  state.drafts['side-chat'].text = 'unfinished question';
  assert.equal(await open('main-chat', 'second passage'), 'side-chat');
  assert.equal(state.tabs.length, 1);
  assert.equal(events.filter((e) => e.kind === 'fork').length, 1);
  assert.deepEqual(state.drafts['side-chat'], {
    text: 'unfinished question',
    attachments: [
      { kind: 'selection', text: 'first passage' },
      { kind: 'selection', text: 'second passage' },
    ],
  });
  assert.equal(state.active, 'tab-side-chat');
  await open('main-chat');
  assert.equal(events.filter((e) => e.kind === 'selection').length, 1);
});

test('a mounted composer receives the selection without overwriting its unsaved draft', async () => {
  const { open, events, state } = harness({ handled: true });
  await open('main-chat');
  await open('main-chat', 'another passage');
  assert.deepEqual(events.at(-2), { kind: 'selection', value: { id: 'side-chat', text: 'another passage' } });
  assert.equal(events.filter((e) => e.kind === 'draft').length, 0);
  assert.deepEqual(state.drafts, {});
});

test('an unmounted composer without a saved draft gets a new selection draft', async () => {
  const { open, state } = harness();
  await open('main-chat');
  await open('main-chat', 'passage');
  assert.deepEqual(state.drafts['side-chat'], { text: '', attachments: [{ kind: 'selection', text: 'passage' }] });
});

test('unrelated chats and read-only agent tabs are not reused', async () => {
  const tabs: PaneTab[] = [
    { id: 'browser', kind: 'browser' },
    { id: 'agent', kind: 'chat', readOnly: true, sourceChatId: 'main-chat', threadId: 'agent-thread' },
    { id: 'other', kind: 'chat', sourceChatId: 'other-chat', threadId: 'other-thread' },
    { id: 'missing-thread', kind: 'chat', sourceChatId: 'main-chat' },
  ];
  const { open, state } = harness({ tabs });
  await open('main-chat');
  assert.equal(state.tabs.length, 5);
  state.tabs = state.tabs.filter((t) => t.id !== 'tab-side-chat');
  assert.equal(await open('main-chat'), 'side-chat-2', 'closing the side chat allows a fresh fork');
});

test('New tab converts in place even when the main chat already has a side chat', async () => {
  const existing: PaneTab = { id: 'existing', kind: 'chat', threadId: 'previous-side', sourceChatId: 'main-chat' };
  const trailing: PaneTab = { id: 'terminal', kind: 'terminal' };
  const { open, state } = harness({ tabs: [existing, { id: 'blank', kind: 'browser', title: 'New tab', cwd: '/old' }, trailing] });
  assert.equal(await open('main-chat', undefined, 'blank'), 'side-chat');
  assert.deepEqual(
    state.tabs.map((t) => t.id),
    ['existing', 'blank', 'terminal'],
  );
  assert.strictEqual(state.tabs[0], existing);
  assert.strictEqual(state.tabs[2], trailing);
  assert.deepEqual(state.tabs[1], { id: 'blank', kind: 'chat', threadId: 'side-chat', sourceChatId: 'main-chat' });
  assert.equal(state.active, 'blank');
  assert.equal(await open('main-chat', 'next selection'), 'side-chat', 'continue in the converted tab');
});

test('Ask in side chat prefers the active side chat, then the last opened one for its source', async () => {
  const { open, state, events } = harness({
    tabs: [
      { id: 'first', kind: 'chat', threadId: 'side-a', sourceChatId: 'main-chat' },
      { id: 'last', kind: 'chat', threadId: 'side-b', sourceChatId: 'main-chat' },
    ],
  });
  state.active = 'first';
  assert.equal(await open('main-chat'), 'side-a');
  state.active = 'terminal';
  assert.equal(await open('main-chat'), 'side-b');
  assert.equal(events.filter((e) => e.kind === 'fork').length, 0);
});

test('Claude receives the replacement tab and reuses existing Claude side chats', async () => {
  const { open, events, state } = harness({ nativeId: 'claude:source', tabs: [{ id: 'blank', kind: 'browser' }] });
  assert.equal(await open('main-chat', undefined, 'blank'), 'claude:side');
  assert.deepEqual(events, [{ kind: 'claude', value: ['main-chat', 'claude:source', undefined, 'blank'] }]);
  state.tabs = [{ id: 'claude-tab', kind: 'chat', threadId: 'claude:side', sourceChatId: 'main-chat' }];
  assert.equal(await open('main-chat', 'selection'), 'claude:side');
  assert.equal(events.filter((e) => e.kind === 'claude').length, 1);
});

test('closed, navigated, non-browser and agent browser tabs never become side chats', async () => {
  for (const tab of [
    undefined,
    { id: 'blank', kind: 'terminal' },
    { id: 'blank', kind: 'browser', url: 'https://example.com' },
    { id: 'blank', kind: 'browser', agentChat: 'agent' },
  ] as (PaneTab | undefined)[]) {
    const tabs = tab ? [tab] : [];
    const { open, events } = harness({ tabs });
    assert.equal(await open('main-chat', undefined, 'blank'), undefined);
    assert.deepEqual(events, []);
    assert.equal(replaceBlankPaneTab(tabs, 'chat', { threadId: 'side' }, 'blank'), undefined);
  }
});

test('selections during a pending fork land in one tab without losing either passage', async () => {
  const gate = deferred();
  const { open, events, state } = harness({ gate: gate.promise });
  const first = open('main-chat', 'first');
  const second = open('main-chat', 'second');
  gate.resolve();
  assert.deepEqual(await Promise.all([first, second]), ['side-chat', 'side-chat']);
  assert.equal(events.filter((e) => e.kind === 'fork').length, 1);
  assert.equal(state.tabs.length, 1);
  assert.deepEqual(
    state.drafts['side-chat'].attachments.map((a: any) => a.text),
    ['first', 'second'],
  );
});

test('double clicking Side chat on New tab shares one pending conversion', async () => {
  const gate = deferred();
  const { open, events, state } = harness({ gate: gate.promise, tabs: [{ id: 'blank', kind: 'browser' }] });
  const first = open('main-chat', undefined, 'blank');
  const second = open('main-chat', undefined, 'blank');
  gate.resolve();
  assert.deepEqual(await Promise.all([first, second]), ['side-chat', 'side-chat']);
  assert.equal(events.filter((e) => e.kind === 'fork').length, 1);
  assert.equal(state.tabs.length, 1);
  assert.equal(state.tabs[0].id, 'blank');
});

test('different blank tabs can convert independently for the same source chat', async () => {
  const gate = deferred();
  const { open, state } = harness({
    gate: gate.promise,
    tabs: [
      { id: 'a', kind: 'browser' },
      { id: 'b', kind: 'browser' },
    ],
  });
  const first = open('main-chat', undefined, 'a');
  const second = open('main-chat', undefined, 'b');
  gate.resolve();
  assert.deepEqual(await Promise.all([first, second]), ['side-chat', 'side-chat-2']);
  assert.deepEqual(
    state.tabs.map((t) => [t.id, t.kind]),
    [
      ['a', 'chat'],
      ['b', 'chat'],
    ],
  );
});

test('a pending fork does not resurrect a closed tab or overwrite a page navigated in the meantime', async () => {
  for (const navigate of [false, true]) {
    const gate = deferred();
    const { open, state } = harness({ gate: gate.promise, tabs: [{ id: 'blank', kind: 'browser' }] });
    const opening = open('main-chat', undefined, 'blank');
    state.tabs = navigate ? [{ id: 'blank', kind: 'browser', url: 'https://example.com' }] : [];
    const expected = state.tabs;
    gate.resolve();
    await opening;
    assert.strictEqual(state.tabs, expected);
  }
});

test('a shared failed fork leaves New tab intact, reports once and allows a later retry', async () => {
  const options = { failure: new Error('disconnected'), tabs: [{ id: 'blank', kind: 'browser' }] as PaneTab[] };
  const { open, events, state } = harness(options);
  assert.deepEqual(await Promise.all([open('main-chat', undefined, 'blank'), open('main-chat', undefined, 'blank')]), [
    undefined,
    undefined,
  ]);
  assert.equal(events.filter((e) => e.kind === 'toast').length, 1);
  assert.equal(state.tabs[0].kind, 'browser');
  delete (options as any).failure;
  assert.equal(await open('main-chat', undefined, 'blank'), 'side-chat');
  assert.equal(state.tabs[0].kind, 'chat');
});

test('pending selection requests reuse the original parent side chat after navigation without opening it under another session', async () => {
  const gate = deferred();
  const h = harness({ scoped: true, gate: gate.promise });
  const first = h.open('main-chat', 'first');
  const second = h.open('main-chat', 'second');
  h.navigate('other-chat');
  gate.resolve();
  assert.deepEqual(await Promise.all([first, second]), ['side-chat', 'side-chat']);
  assert.equal(h.events.filter((e) => e.kind === 'fork').length, 1);
  assert.deepEqual(h.state.tabs, [] as any[]);
  assert.equal(h.pane.diffPanel.open, false);
  assert.deepEqual(
    h.pane.chatPanes['main-chat'].tabs.map((t) => t.threadId),
    ['side-chat'],
  );
  assert.deepEqual(
    h.state.drafts['side-chat'].attachments.map((a: any) => a.text),
    ['first', 'second'],
  );
  h.navigate('main-chat');
  assert.equal(h.state.tabs[0].threadId, 'side-chat');
  assert.equal(h.state.active, 'tab-side-chat');
  assert.equal(h.pane.diffPanel.open, true);
  await h.open('main-chat', 'third');
  assert.equal(h.events.filter((e) => e.kind === 'fork').length, 1);
  assert.deepEqual(
    h.state.drafts['side-chat'].attachments.map((a: any) => a.text),
    ['first', 'second', 'third'],
  );
});

test("a Codex side chat stays on the parent chat's account before its pane opens; a pin that can't be kept is said", async () => {
  const inherited: string[][] = [];
  const kept = harness({ inherit: async (chatId, threadId) => void inherited.push([chatId, threadId]) });
  assert.equal(await kept.open(kept.source.id), 'side-chat');
  assert.deepEqual(inherited, [['main-chat', 'side-chat']]);
  assert.equal(kept.events.at(-1)?.kind, 'pane', 'the side chat still opens');

  const lost = harness({ inherit: async () => Promise.reject(new Error('relay down')) });
  assert.equal(await lost.open(lost.source.id), 'side-chat');
  const said = lost.events.find((e) => e.kind === 'toast')?.value;
  assert.equal(said?.text, "The side chat couldn't keep this chat's account (relay down); it uses the pool's");
  assert.equal(lost.events.at(-1)?.kind, 'pane');
});

test('a refused side-chat quote is not retained by the unmounted fallback or reported as focused delivery', async () => {
  const existing: PaneTab = { id: 'side', kind: 'chat', threadId: 'remote-side', sourceChatId: 'main-chat' };
  const h = harness({ tabs: [existing], handled: 'refused' });
  assert.equal(await h.open(h.source.id, 'keep this quote in its source'), undefined);
  assert.equal(h.events.filter((e) => e.kind === 'selection').length, 1);
  assert.equal(
    h.events.some((e) => e.kind === 'draft' || e.kind === 'focus' || e.kind === 'fork'),
    false,
  );
});
