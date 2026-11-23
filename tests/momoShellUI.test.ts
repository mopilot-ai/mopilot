// MoMo's page shell (src/components/momo/shell, M0b) around the chat (MomoPage.tsx, MomoChatTab.tsx): with `momo.shell` off the page is today's chat alone, byte for byte; on, it has a left rail (Everything, no channels, where MoMo runs as text) that a toggle hides completely, panel buttons at the top right (Tasks with `momo.tasksPanel`, Files with `momo.outputs`, no Sessions), one panel at a time that Esc or its own button closes, replies drawn whole under a "Thinking it through" pill, and "MoMo can make mistakes." under the composer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { window } from './support/dom.ts';
import { createElement as h, act } from 'react';
import { render, click, flush } from './support/shell-chrome-kit.ts';
import { mockSource, stubStore } from './support/stubs.ts';
import { installNativeStub } from './support/ports/native.ts';
import { reactivePrefs } from './support/reactivePrefs.ts';

const calls: any[] = [];
let shell = true;
let tasksPanel = true;
let outputsFlag = true;
let paused = false;
let rowState: string | null = null;
let momoChats: Record<string, string> = {};
const store = reactivePrefs(() => ({ route: { name: 'momo' }, momoChats }));
const prefs = store.prefs;

mockSource('src/session/useChatRowState.ts', { useChatRowState: () => (rowState ? { state: rowState } : null) });
stubStore({
  useStore: store.useStore,
  setPrefs: store.setPrefs,
  navigate: (r: any) => calls.push(['navigate', r]),
  openThread: async () => {},
  setDraft: () => {},
  toast: () => {},
  sendMessage: async () => true,
});
mockSource('src/lib/mopilot.ts', { useMoPilot: () => ({ signedIn: false, user: null }) });
installNativeStub({
  momoChat: { mainChat: async () => ({ chatId: 'm1', warning: null }), previousChats: async () => [], onBrainChanged: () => () => {} },
});
mockSource('src/session/momoPrefs.ts', {
  useMomoPrefs: () => ({ onboarding: { done: true }, paused, tasksPanel, shell, persona: { name: 'MoMo', color: 'clay' } }),
  saveMomoPref: async () => true,
});
mockSource('src/lib/flags.ts', { useFlag: (key: string) => key === 'momo.outputs' && outputsFlag, harnessEnabled: () => true });
mockSource('src/components/momo/setup/MomoSetup.tsx', { MomoSetup: () => h('div') });
const { useWholeReplies } = await import('../src/components/momo/shell/wholeReplies.ts');
mockSource('src/components/thread/ThreadView.tsx', {
  ThreadView: ({ threadId }: any) => h('div', { 'data-thread': threadId, 'data-whole': String(useWholeReplies()) }),
});
mockSource('src/components/momo/BrainChip.tsx', { BrainChip: () => h('span') });
mockSource('src/components/momo/MomoPanel.tsx', { MomoPanel: () => h('aside', { 'data-stub': 'details' }) });
mockSource('src/components/momo/MemoryTab.tsx', { MemoryTab: () => h('div') });
mockSource('src/components/momo/TasksTab.tsx', { TasksTab: () => h('div') });
mockSource('src/components/momo/tasks/TasksPanel.tsx', { TasksPanel: () => h('div', { 'data-stub': 'tasks-panel' }) });
mockSource('src/components/momo/MomoOutputs.tsx', { MomoOutputs: () => h('div', { 'data-stub': 'outputs' }) });
const { default: MomoPage } = await import('../src/components/momo/MomoPage.tsx');
const { MomoChatTab } = await import('../src/components/momo/MomoChatTab.tsx');
const { MomoShell } = await import('../src/components/momo/shell/MomoShell.tsx');
const { MomoRail } = await import('../src/components/momo/shell/MomoRail.tsx');
const { useRailOpen, usePanel } = await import('../src/components/momo/shell/useShellState.ts');
const { SHELL_COPY } = await import('../src/components/momo/shell/shellCopy.ts');

// the account row's button: the avatar's initials and the name, both N/A with no account and no OS user
const SIGNED_OUT = 'N/AN/A';
const settle = async () => {
  for (let i = 0; i < 4; i++) await flush();
};
const page = async (p: any = {}) => {
  const r = await render(h(MomoPage, p));
  await settle();
  return r;
};
const key = (k: string, init: any = {}) =>
  act(async () => void window.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })));
const names = (r: any) => [...r.host.querySelectorAll('button')].map((b: any) => b.getAttribute('aria-label') ?? b.textContent);
const reset = () => {
  shell = true;
  tasksPanel = true;
  outputsFlag = true;
  paused = false;
  rowState = null;
  momoChats = {};
  store.reset();
  calls.length = 0;
  window.localStorage.clear();
};

test('flag off: the page is the chat alone, exactly what MomoChatTab draws on its own', async () => {
  reset();
  shell = false;
  const off = await page();
  const offHtml = off.host.innerHTML;
  await off.unmount();
  const bare = await render(h(MomoChatTab, {}));
  await settle();
  assert.equal(offHtml, bare.host.innerHTML, 'nothing of the shell is in the tree, not even a wrapper');
  assert.equal(off.host.querySelector('nav'), null);
  assert.doesNotMatch(offHtml, /data-shell|mistakes|Thinking/);
  await bare.unmount();
  shell = true;
  const on = await page();
  assert.notEqual(on.host.innerHTML, offHtml);
  assert.ok(on.host.querySelector('nav[aria-label=MoMo]'));
  await on.unmount();
});

test('flag on: the rail has Everything and where MoMo runs, and nothing of channels while none can be made', async () => {
  reset();
  const r = await page();
  const rail = r.host.querySelector('nav')!;
  assert.deepEqual(
    [...rail.querySelectorAll('button')].map((b: any) => b.textContent || b.getAttribute('aria-label')),
    ['Hide sidebar', 'Back to chats', 'Everything', 'Memory', 'Settings', SIGNED_OUT],
  );
  assert.equal(rail.querySelector('[aria-current=page]')!.textContent, 'Everything');
  assert.equal(rail.querySelector('p')!.textContent, 'Runs on this Mac');
  assert.doesNotMatch(r.host.textContent!, /New channel|Sessions/);
  await click(rail.querySelector('[aria-current=page]'));
  assert.deepEqual(calls.at(-1), ['navigate', { name: 'momo', tab: 'chat' }]);
  await r.unmount();
  paused = true;
  const p = await page();
  assert.equal(p.host.querySelector('nav p')!.textContent, 'Paused');
  await p.unmount();
});

test('New channel is drawn only when the channels slice gives the rail a way to make one', async () => {
  reset();
  const without = await render(h(MomoRail, { paused: false, hide: () => {} }));
  assert.doesNotMatch(without.host.textContent!, /New channel/);
  await without.unmount();
  let made = 0;
  const withIt = await render(h(MomoRail, { paused: false, hide: () => {}, onNewChannel: () => made++ }));
  await click([...withIt.host.querySelectorAll('button')].find((b: any) => b.textContent === 'New channel'));
  assert.equal(made, 1);
  await withIt.unmount();
  const shown = await render(h(MomoShell, { onNewChannel: () => {}, children: h('div') }));
  assert.match(shown.host.textContent!, /New channel/);
  await shown.unmount();
});

test('the rail hides completely and comes back; the choice is kept in the prefs, and Cmd/Ctrl+B does the same', async () => {
  reset();
  const r = await page();
  await click(r.host.querySelector('[aria-label="Hide sidebar"]'));
  assert.equal(r.host.querySelector('nav'), null, 'no icon rail is left');
  assert.equal(prefs.momoRailHidden, true);
  assert.equal(r.host.querySelectorAll('[aria-label="Hide sidebar"]').length, 0);
  await r.unmount();
  const again = await page();
  assert.equal(again.host.querySelector('nav'), null, 'a new page remembers it');
  await click(again.host.querySelector('[aria-label="Show sidebar"]'));
  assert.ok(again.host.querySelector('nav'));
  assert.equal(prefs.momoRailHidden, false);
  // Cmd/Ctrl+B toggles it, unless a modifier, an input method or another handler has the key
  await key('b', { metaKey: true, ctrlKey: true });
  assert.equal(again.host.querySelector('nav'), null);
  await key('b', { metaKey: true, ctrlKey: true });
  assert.ok(again.host.querySelector('nav'));
  await key('b');
  await key('b', { metaKey: true, ctrlKey: true, shiftKey: true });
  await key('B', { metaKey: true, ctrlKey: true, isComposing: true });
  assert.ok(again.host.querySelector('nav'), 'a plain b, Shift, or an input method’s key leaves it');
  await act(async () => {
    const e = new window.KeyboardEvent('keydown', { key: 'b', metaKey: true, ctrlKey: true, bubbles: true, cancelable: true });
    e.preventDefault();
    window.dispatchEvent(e);
  });
  assert.ok(again.host.querySelector('nav'), 'a key something else took stays that one’s');
  await again.unmount();
});

test('Tasks and Files buttons: one panel at a time, 420 pt, the same button or Close or Esc closes it', async () => {
  reset();
  const r = await page();
  const buttons = () =>
    [...r.host.querySelectorAll('button')]
      .map((b: any) => b.getAttribute('aria-label') ?? b.textContent)
      .filter((t: string) => ['Tasks', 'Files', 'Sessions'].includes(t));
  assert.deepEqual(buttons(), ['Tasks', 'Files'], 'no Sessions: that is M6');
  const tasks = () => r.host.querySelector('button[aria-label="Tasks"]')!;
  const files = () => r.host.querySelector('button[aria-label="Files"]')!;
  assert.equal(r.host.querySelector('aside'), null, 'a page opens with no panel until one was left open');
  await click(tasks());
  assert.ok(r.host.querySelector('aside [data-stub=tasks-panel]'));
  assert.equal(r.host.querySelector('aside h2')!.textContent, 'Tasks');
  assert.equal(tasks().getAttribute('aria-pressed'), 'true');
  assert.equal(r.host.querySelectorAll('aside').length, 1);
  await click(files());
  assert.equal(r.host.querySelectorAll('aside').length, 1, 'never two panels');
  assert.ok(r.host.querySelector('aside [data-stub=outputs]'));
  assert.equal(r.host.querySelector('aside h2')!.textContent, 'Files');
  assert.equal(tasks().getAttribute('aria-pressed'), 'false');
  await click(files());
  assert.equal(r.host.querySelector('aside'), null, 'the same button closes it');
  await click(tasks());
  await click(r.host.querySelector('aside [aria-label=Close]'));
  assert.equal(r.host.querySelector('aside'), null);
  await click(files());
  await key('a');
  assert.ok(r.host.querySelector('aside'), 'another key leaves it');
  await key('Escape', { isComposing: true });
  assert.ok(r.host.querySelector('aside'), 'an input method’s Esc is its own');
  await key('Escape', { cancelable: true });
  assert.equal(r.host.querySelector('aside'), null, 'Esc closes it');
  await click(files());
  await act(async () => {
    const e = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    e.preventDefault();
    window.dispatchEvent(e);
  });
  assert.ok(r.host.querySelector('aside'), 'an Esc something else took stays that one’s');
  await r.unmount();
  await key('Escape');
});

test('a panel button shows only where its source is on, and an open panel whose source goes away is closed', async () => {
  reset();
  tasksPanel = false;
  outputsFlag = false;
  let r = await page();
  assert.deepEqual(
    names(r).filter((n: string) => ['Tasks', 'Files'].includes(n)),
    ['Tasks'],
    'only the rail’s Tasks page row while the Tasks panel is off: no panel buttons',
  );
  await r.unmount();
  tasksPanel = true;
  r = await page();
  assert.deepEqual(
    names(r).filter((n: string) => ['Tasks', 'Files'].includes(n)),
    ['Tasks'],
  );
  await click(r.host.querySelector('button[aria-label="Tasks"]'));
  assert.ok(r.host.querySelector('aside'));
  tasksPanel = false;
  await r.unmount();
  r = await page();
  assert.equal(r.host.querySelector('aside'), null);
  await r.unmount();
  store.reset();
  const hook = { open: null as any };
  const Probe = ({ on }: { on: boolean }) => {
    const [open, toggle] = usePanel({ tasks: on, files: false, sessions: false });
    hook.open = [open, toggle];
    return null;
  };
  const probe = await render(h(Probe, { on: true }));
  await act(async () => hook.open[1]('tasks'));
  assert.equal(hook.open[0], 'tasks');
  await probe.rerender(h(Probe, { on: false }));
  assert.equal(hook.open[0], null, 'closed when the source went away');
  await probe.unmount();
  const rail = { value: null as any };
  const RailProbe = () => ((rail.value = useRailOpen()), null);
  const rp = await render(h(RailProbe));
  assert.equal(rail.value[0], true);
  await rp.unmount();
});

test('the chat in the shell: no details panel or its toggle, whole replies, the footer line, the pill while MoMo works', async () => {
  reset();
  const r = await page();
  assert.equal(r.host.querySelector('[data-thread]')!.getAttribute('data-whole'), 'true');
  assert.equal(r.host.querySelector('[aria-label="Hide details"]'), null);
  assert.equal(r.host.querySelector('[data-stub=details]'), null);
  assert.equal(r.host.querySelector('section')!.hasAttribute('data-shell'), true);
  assert.equal(r.host.querySelector('p.footnote')!.textContent, 'MoMo can make mistakes.');
  assert.equal(r.host.querySelector('.thinking'), null, 'nothing while idle');
  assert.equal(r.host.querySelector('header [role=status]')!.textContent, 'Active');
  await r.unmount();
  for (const state of ['working', 'elsewhereRunning']) {
    rowState = state;
    const w = await page();
    assert.equal(w.host.querySelector('.thinking')!.textContent, 'Thinking it through');
    assert.equal(w.host.querySelector('.thinking')!.getAttribute('role'), 'status');
    await w.unmount();
  }
  rowState = 'approval';
  const needs = await page();
  assert.equal(needs.host.querySelector('.thinking'), null, 'a card waiting is not thinking');
  await needs.unmount();
  shell = false;
  rowState = 'working';
  const off = await page();
  assert.equal(off.host.querySelector('.thinking'), null);
  assert.equal(off.host.querySelector('p.footnote'), null);
  assert.equal(off.host.querySelector('[data-thread]')!.getAttribute('data-whole'), 'false');
  await off.unmount();
});

test('an earlier MoMo chat has ONE way back: the rail’s (Main and its header arrow) in the shell, its own arrow without it (#4926)', async () => {
  reset();
  const r = await page({ chatId: 'older' });
  assert.equal(r.host.querySelector('[aria-label="Back to MoMo"]'), null, 'no second arrow in the content');
  assert.equal(r.host.querySelectorAll('[aria-label="Back to chats"]').length, 1);
  await r.unmount();
  shell = false;
  const off = await page({ chatId: 'older' });
  await click(off.host.querySelector('[aria-label="Back to MoMo"]'));
  assert.deepEqual(calls.at(-1), ['navigate', { name: 'momo', tab: 'chat' }]);
  await off.unmount();
});

test('the shell’s words are the design’s short ones', () => {
  assert.deepEqual(
    [SHELL_COPY.everything, SHELL_COPY.thinking, SHELL_COPY.mistakes, SHELL_COPY.home, SHELL_COPY.paused],
    ['Everything', 'Thinking it through', 'MoMo can make mistakes.', 'Runs on this Mac', 'Paused'],
  );
});

test('Memory and Tasks pages sit in the same shell: the rail is the one column on every page of MoMo (#4926)', async () => {
  reset();
  const memory = await page({ tab: 'memory' });
  assert.ok(memory.host.querySelector('nav[aria-label=MoMo]'));
  assert.equal(memory.host.querySelector('nav [aria-current=page]')!.textContent, 'Memory');
  await memory.unmount();
  shell = false;
  const bare = await page({ tab: 'memory' });
  assert.equal(bare.host.querySelector('nav'), null, 'with the shell off the page is today’s, with MoMo’s own nav in the sidebar column');
  await bare.unmount();
});
