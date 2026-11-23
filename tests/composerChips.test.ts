// The chips above the composer: selected-text attachments (SelectionChip), the "next message" slot
// (NextMessageChip) and where a new chat goes (RoutingChip).
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { $, click, fakeStore, flush, mockTsx, mount, mouse } from './support/composer-kit.ts';
import { stubStore } from './support/stubs.ts';

const store = fakeStore<any>({});
const sets: any[] = [];
let session: any = {};
let cloudCap = 'native';
let accounts: any = { active: null };
let hostView: any = null;
let statuses: Record<string, any> = {};
const navs: any[] = [];
stubStore({
  useStore: store.useStore,
  getState: store.get,
  setState: (p: any) => (sets.push(p), store.set(p)),
  newChatHarness: (s: any) => s.harness,
  newChatBasic: (s: any) => s.basic,
  newChatKind: (s: any) => (s.basic && !s.newChatTemporary ? `acp:${s.basic}` : s.harness),
  navigate: (r: any) => navs.push(r),
  // what stands in for a default that can't run, and what the chip says about it (harness/defaultHarness.ts)
  defaultHarness: (s: any) => ({ kind: s.standIn ?? s.harness }),
  defaultHarnessFallbackNote: (s: any) => s.fallbackNote ?? null,
});
mock.module('../src/store/session/useSession.ts', {
  namedExports: {
    flushSessionPatches: () => {},
    useSession: () => session,
    useSessionField: (id: any, pick: any) => pick(((() => session) as (id: any) => any)(id)),
  },
});
mock.module('../src/store/session/useCaps.ts', {
  namedExports: { useCap: (_id: any, sem: string, hint: any) => ({ state: sem === 'cloud' && hint.kind === 'codex' ? cloudCap : 'none' }) },
});
mock.module('../src/harness/accounts.ts', { namedExports: { accountName: (a: any) => a.email } });
mock.module('../src/session/harness/select.ts', {
  namedExports: { useHarnessAccounts: () => accounts, useHarnessStatus: (h: string) => statuses[h] ?? {} },
});
mock.module('../src/session/useHostAgentChoice.ts', { namedExports: { useHostAgentChoice: () => hostView } });
mock.module('../src/components/composer/HostAgentNote.tsx', {
  namedExports: { HostAgentNote: ({ view }: any) => createElement('i', { 'data-host-note': true }, view.choice.note) },
});
mock.module('../src/session/harness/acp.ts', { namedExports: { basicLabel: (id: string) => id.toUpperCase() } });
// a comment's microphone (Dictation, through session/voice) is not under test here
mockTsx(new URL('../src/components/ui/Dictation.tsx', import.meta.url), { Dictation: () => null });
mockTsx(new URL('../src/components/harnessPicker/HarnessPicker.tsx', import.meta.url), {
  HarnessIcon: ({ h }: any) => `[${h}]`,
  BasicHarnessIcon: ({ id }: any) => `{${id}}`,
  SwitchChip: ({ threadId }: any) => `switch:${threadId}`,
});

const { createElement } = await import('react');
const { act } = await import('react');
const { SelectionChip } = await import('../src/components/composer/SelectionChip.tsx');
const { NextMessageChip } = await import('../src/components/composer/NextMessageChip.tsx');
const { RoutingChip } = await import('../src/components/composer/RoutingChip.tsx');

beforeEach(() => {
  sets.length = 0;
  session = {};
  cloudCap = 'native';
  accounts = { active: null };
  statuses = {};
  store.reset({
    harness: 'codex',
    basic: null,
    newChatCloudEnv: null,
    newChatTemporary: false,
    handoffCarry: {},
    claudeAccounts: { active: 'default', accounts: [] },
  });
});

test('selection chip: nothing without selections, a count, and remove', async () => {
  const removed: number[] = [];
  const m = await mount(createElement(SelectionChip, { selections: [] }));
  assert.equal(m.host.innerHTML, '');
  await m.render(createElement(SelectionChip, { selections: ['one'] }));
  assert.equal($('.selection-chip-label', m.host).textContent, '1 selection');
  assert.ok(!$('.selection-chip-remove', m.host));
  await m.render(createElement(SelectionChip, { selections: ['one', 'two'], onRemove: () => removed.push(1) }));
  assert.equal($('.selection-chip-label', m.host).textContent, '2 selections');
  await click($('.selection-chip-remove', m.host));
  assert.deepEqual(removed, [1]);
  await m.unmount();
});

test('selection chip: diff comments are counted as comments and name their file and lines', async () => {
  const diff = { path: 'src/a.ts', startSide: 'R' as const, startLine: 4, endSide: 'R' as const, endLine: 5, hunk: '+new' };
  const m = await mount(createElement(SelectionChip, { selections: [{ text: '+new', annotation: 'rename', annotationId: 'd', diff }] }));
  assert.equal($('.selection-chip-label', m.host).textContent, '1 comment');
  await click($('.selection-chip-trigger', m.host));
  assert.equal($('.selection-pop-label').textContent, 'src/a.ts · Lines 4-5:');
  assert.equal($('.selection-pop-text.code').textContent, '+new');
  // with any other selection among them, they are annotations, and the other keeps its label
  await m.render(createElement(SelectionChip, { selections: [{ text: '+new', annotation: 'rename', annotationId: 'd', diff }, 'plain'] }));
  assert.equal($('.selection-chip-label', m.host).textContent, '2 annotations');
  await m.unmount();
});

test('selection chip: hover lists the numbered selections in a popover above it, and hides after a pause', async () => {
  const m = await mount(createElement(SelectionChip, { selections: ['alpha', 'beta'], align: 'end' }));
  const pop = () => document.querySelector('.selection-pop');
  const wrap = $('.selection-chip-wrap', m.host);
  await mouse(wrap, 'mouseover');
  assert.equal(String(pop()?.className).includes('selection-pop'), true);
  assert.deepEqual(
    [...document.querySelectorAll('.selection-pop-number')].map((e) => e.textContent),
    ['1.', '2.'],
  );
  assert.deepEqual(
    [...document.querySelectorAll('.selection-pop-item')].map((e) => e.querySelector('.selection-pop-text')?.textContent),
    ['alpha', 'beta'],
  );
  // strings have no comment
  assert.deepEqual(
    [...document.querySelectorAll('.selection-pop-text.empty')].map((e) => e.textContent),
    ['No comment', 'No comment'],
  );
  // leaving and coming back before the pause keeps it open
  await mouse(wrap, 'mouseout');
  await mouse(wrap, 'mouseover');
  await flush(130);
  assert.ok(pop());
  await mouse(wrap, 'mouseout');
  await flush(130);
  assert.ok(!pop());
  await m.unmount();
});

test('selection chip: once the last selection goes, the pinned list closes, so new selections start closed', async () => {
  const m = await mount(createElement(SelectionChip, { selections: ['alpha'] }));
  const pop = () => document.querySelector('.selection-pop');
  await click($('.selection-chip-trigger', m.host));
  assert.ok(pop());
  await m.render(createElement(SelectionChip, { selections: [] }));
  assert.equal(m.host.innerHTML, '');
  await m.render(createElement(SelectionChip, { selections: ['beta'] }));
  assert.ok(!pop());
  assert.equal($('.selection-chip-trigger', m.host).getAttribute('aria-expanded'), 'false');
  // one click pins it open again (it was not left pinned)
  await click($('.selection-chip-trigger', m.host));
  assert.ok(pop());
  await m.unmount();
});

test('next-message chip: a pending switch or carried summary in a chat shows the switch chip', async () => {
  session = { pendingSwitch: { harness: 'claude' } };
  const m = await mount(createElement(NextMessageChip, { threadId: 'c1' }));
  assert.equal(m.host.textContent, 'switch:c1');
  session = {};
  await m.render(createElement(NextMessageChip, { threadId: 'c2' }));
  assert.equal(m.host.textContent, '');
  await act(async () => store.set({ handoffCarry: { c2: { fromTitle: 'Old' } } }));
  assert.equal(m.host.textContent, 'switch:c2');
  await m.unmount();
});

test('next-message chip: a Cloud new chat names the account and can be undone', async () => {
  store.set({ newChatCloudEnv: { id: 'e1', label: 'Env' } });
  accounts = { active: { email: 'me@x.test' } };
  const m = await mount(createElement(NextMessageChip, { threadId: null }));
  assert.equal($('.switch-chip span', m.host).textContent, 'This new chat uses Codex Cloud (ChatGPT · me@x.test)');
  assert.equal($('.switch-chip', m.host).getAttribute('role'), 'status');
  await click($('.switch-chip-x', m.host));
  assert.deepEqual(sets, [{ newChatCloudEnv: null }]);
  assert.equal(m.host.textContent, '');
  // without an active account the account is left out
  accounts = { active: null };
  await act(async () => store.set({ newChatCloudEnv: { id: 'e1', label: 'Env' } }));
  assert.equal($('.switch-chip span', m.host).textContent, 'This new chat uses Codex Cloud (ChatGPT · )');
  // a new chat on a picked basic harness reads that harness's capabilities: it has no Codex Cloud
  await act(async () => store.set({ basic: 'kimi' }));
  assert.equal(m.host.textContent, '');
  await act(async () => store.set({ basic: null }));
  // no Cloud capability: nothing
  cloudCap = 'none';
  await m.render(createElement(NextMessageChip, { threadId: null }));
  assert.equal(m.host.textContent, '');
  await m.unmount();
});

test('routing chip: Codex Cloud with the account, else a temporary chat on Claude Code; Undo clears each', async () => {
  const m = await mount(createElement(RoutingChip));
  assert.equal(m.host.innerHTML, '');
  statuses = { codex: { email: 'c@x.test' } };
  await act(async () => store.set({ newChatCloudEnv: { id: 'e', label: 'E' } }));
  assert.equal($('.routing-chip span', m.host).textContent, 'This new chat uses Codex Cloud (ChatGPT · c@x.test)');
  statuses = { codex: { plan: 'Pro' } };
  await m.render(createElement(RoutingChip));
  assert.match(m.host.textContent!, /ChatGPT · Pro/);
  statuses = {};
  await m.render(createElement(RoutingChip));
  assert.match(m.host.textContent!, /ChatGPT · signed in/);
  await click($('.btn-pill', m.host));
  assert.deepEqual(sets.at(-1), { newChatCloudEnv: null });
  // a cloud env left over for another harness is not shown
  await act(async () => store.set({ harness: 'claude', newChatCloudEnv: { id: 'e', label: 'E' } }));
  assert.equal(m.host.innerHTML, '');
  // temporary chat on a basic harness
  await act(async () => store.set({ newChatTemporary: true, basic: 'kimi' }));
  assert.equal(
    $('.routing-chip span', m.host).textContent,
    "This temporary chat uses Claude Code (signed in) · KIMI can't keep chats off disk",
  );
  // the pool's active login names it, not whichever the last status read named
  statuses = { claude: { email: 'old@x.test' } };
  await act(async () =>
    store.set({
      claudeAccounts: {
        active: 'work',
        accounts: [
          { id: 'default', email: 'd@x.test' },
          { id: 'work', email: 'w@x.test' },
        ],
      },
    }),
  );
  assert.match(m.host.textContent!, /Claude Code \(w@x\.test\)/);
  await act(async () => store.set({ claudeAccounts: { active: 'gone', accounts: [] } }));
  statuses = { claude: { email: 'cl@x.test' } };
  await m.render(createElement(RoutingChip));
  assert.match(m.host.textContent!, /Claude Code \(cl@x\.test\)/);
  statuses = { claude: { plan: 'Max' } };
  await m.render(createElement(RoutingChip));
  assert.match(m.host.textContent!, /Claude Code \(Max\)/);
  await click($('.btn-pill', m.host));
  assert.deepEqual(sets.at(-1), { newChatTemporary: false });
  assert.equal(m.host.innerHTML, '');
  await m.unmount();
});

test("routing chip: a default that can't run says what new chats start on instead, and opens Harness settings (#1293)", async () => {
  const m = await mount(createElement(RoutingChip));
  assert.equal(m.host.innerHTML, '');
  await act(async () => store.set({ fallbackNote: 'opencode isn’t signed in; new chats start in Codex' }));
  assert.equal($('[data-default-fallback] span', m.host).textContent, 'opencode isn’t signed in; new chats start in Codex');
  assert.match(m.host.textContent!, /^\[codex\]/);
  await click($('.btn-pill', m.host));
  assert.deepEqual(navs.at(-1), { name: 'settings', section: 'harnesses' });
  // a basic harness standing in shows its own icon
  await act(async () => store.set({ standIn: 'acp:dsh', fallbackNote: 'Codex can’t run right now; new chats start in dsh' }));
  assert.match(m.host.textContent!, /^\{dsh\}Codex can’t run right now/);
  // a temporary chat's routing is the more specific note
  await act(async () => store.set({ newChatTemporary: true, basic: 'kimi' }));
  assert.equal(m.host.querySelector('[data-default-fallback]'), null);
  await m.unmount();
});

test("routing chip: a folder on a machine shows only that machine's note, whatever this Mac's default says", async () => {
  const m = await mount(createElement(RoutingChip));
  await act(async () => store.set({ fallbackNote: 'Claude Code isn’t signed in; new chats start in Kimi' }));
  hostView = { machine: null, choice: { note: 'Claude Code: Sign in on mini' } };
  await m.render(createElement(RoutingChip));
  assert.equal($('[data-host-note]', m.host).textContent, 'Claude Code: Sign in on mini');
  assert.equal(m.host.querySelector('[data-default-fallback]'), null);
  // a ready agent (or a machine whose row has no readiness) draws nothing, not the local note
  hostView = { machine: null, choice: { note: null } };
  await m.render(createElement(RoutingChip));
  assert.equal(m.host.innerHTML, '');
  hostView = { machine: null, choice: null };
  await m.render(createElement(RoutingChip));
  assert.equal(m.host.innerHTML, '');
  hostView = null;
  await m.unmount();
});
