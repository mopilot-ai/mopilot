// MoMo's shell, as the design has it (#4926 follow-ups): the Tasks pane is titled "Tasks in #channel" while a channel is shown, with + (a new task: the cursor goes to MoMo's composer, via Main from Everything and the other pages) and × beside it; Files keeps its own title and no +; and the rail's foot has the account row (the MoPilot account's avatar and name, the OS user when signed out) opening Accounts & billing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { window } from './support/dom.ts';
import { createElement as h } from 'react';
import { render, click, flush } from './support/shell-chrome-kit.ts';
import { mockSource, stubStore } from './support/stubs.ts';
import { installNativeStub } from './support/ports/native.ts';
import { reactivePrefs } from './support/reactivePrefs.ts';

(window as any).innerWidth = 1600;
installNativeStub({ momoChat: { previousChats: async () => [] } });
const calls: any[] = [];
let account: any = { signedIn: false, user: null };
let systemUsername: string | null = null;
const store = reactivePrefs(() => ({ route: { name: 'momo' }, momoChats: {}, systemUsername }));
stubStore({ useStore: store.useStore, setPrefs: store.setPrefs, navigate: (r: any) => calls.push(['navigate', r]) });
mockSource('src/lib/mopilot.ts', { useMoPilot: () => account });
mockSource('src/session/momoPrefs.ts', { useMomoPrefs: () => ({ paused: false, tasksPanel: true }) });
mockSource('src/lib/flags.ts', { useFlag: () => true });
mockSource('src/components/momo/tasks/TasksPanel.tsx', { TasksPanel: () => h('div', { 'data-stub': 'tasks' }) });
mockSource('src/components/momo/MomoOutputs.tsx', { MomoOutputs: () => h('div', { 'data-stub': 'files' }) });
mockSource('src/components/momo/sessions/SessionsPane.tsx', { SessionsPane: () => h('div', { 'data-stub': 'sessions' }) });
const { MomoShell } = await import('../src/components/momo/shell/MomoShell.tsx');
const { RailAccount } = await import('../src/components/momo/shell/RailAccount.tsx');
const { askForTask, FOCUS_DELAY_MS } = await import('../src/components/momo/shell/newTask.ts');

const reset = () => {
  store.reset();
  calls.length = 0;
  account = { signedIn: false, user: null };
  systemUsername = null;
  store.reset();
};
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
/** counts the untargeted composer-focus events, the app's own shortcut event */
const focuses = () => {
  const seen = { n: 0 };
  const on = () => void seen.n++;
  window.addEventListener('focus-composer', on);
  return { seen, stop: () => window.removeEventListener('focus-composer', on) };
};
const open = async (props: any, which = 'Tasks') => {
  const r = await render(h(MomoShell, { children: h('div'), ...props }));
  await flush();
  await click(r.host.querySelector(`[aria-label="${which}"][aria-pressed]`));
  return r;
};
const pane = (r: any) => r.host.querySelector('aside')!;
const label = (el: Element, name: string) => el.querySelector(`[aria-label="${name}"]`) as HTMLElement | null;

test('the Tasks pane names the channel it is open beside, and Tasks alone without one', async () => {
  reset();
  const inChannel = await open({ channel: 'Kitchen' });
  assert.equal(pane(inChannel).querySelector('h2')!.textContent, 'Tasks in #Kitchen');
  assert.equal(pane(inChannel).getAttribute('aria-label'), 'Tasks in #Kitchen');
  await inChannel.unmount();
  store.reset();
  const plain = await open({});
  assert.equal(pane(plain).querySelector('h2')!.textContent, 'Tasks');
  await plain.unmount();
});

test('+ and × sit together in the Tasks pane; × closes it', async () => {
  reset();
  const r = await open({ channel: 'Kitchen' });
  const buttons = [...pane(r).querySelectorAll('header button')].map((b: any) => b.getAttribute('aria-label'));
  assert.deepEqual(buttons, ['New task', 'Close']);
  await click(label(pane(r), 'Close'));
  assert.equal(r.host.querySelector('aside'), null);
  await r.unmount();
});

test('Files keeps its own title, with no + and no channel in it', async () => {
  reset();
  const r = await open({ channel: 'Kitchen' }, 'Files');
  assert.equal(pane(r).querySelector('h2')!.textContent, 'Files');
  assert.equal(label(pane(r), 'New task'), null);
  assert.ok(label(pane(r), 'Close'));
  await r.unmount();
});

test('+ puts the cursor in the composer where there is one, and goes to Main first from Everything and the other pages', async () => {
  reset();
  const f = focuses();
  const inChat = await open({ tab: 'chat', chatId: 'c1', channel: 'Kitchen' });
  await click(label(pane(inChat), 'New task'));
  assert.deepEqual(calls, [], 'the page has a composer: nowhere to go');
  assert.equal(f.seen.n, 0, 'not before the page has had its beat');
  await wait(FOCUS_DELAY_MS + 40);
  assert.equal(f.seen.n, 1);
  await inChat.unmount();

  store.reset();
  const feed = await open({ feed: true, chatId: 'momo:everything' });
  await click(label(pane(feed), 'New task'));
  assert.deepEqual(calls.at(-1), ['navigate', { name: 'momo', tab: 'chat' }]);
  await feed.unmount();

  calls.length = 0;
  store.reset();
  const memory = await open({ tab: 'memory' });
  await click(label(pane(memory), 'New task'));
  assert.deepEqual(calls.at(-1), ['navigate', { name: 'momo', tab: 'chat' }]);
  await wait(FOCUS_DELAY_MS + 40);
  assert.equal(f.seen.n, 3, 'and the cursor follows in each case');
  await memory.unmount();
  f.stop();
});

test('askForTask with no page named is the chat: no navigation', async () => {
  reset();
  const f = focuses();
  askForTask({});
  askForTask({ tab: 'chat', feed: false });
  assert.deepEqual(calls, []);
  await wait(FOCUS_DELAY_MS + 40);
  assert.equal(f.seen.n, 2);
  f.stop();
});

test('the account row: the MoPilot account’s initials and name, and it opens Accounts & billing', async () => {
  reset();
  account = { signedIn: true, user: { name: 'Ada Lovelace', email: 'ada@example.com' } };
  const r = await render(h(RailAccount));
  const btn = r.host.querySelector('button')!;
  assert.equal(btn.textContent, 'ALAda Lovelace');
  assert.equal(btn.getAttribute('title'), 'Accounts & billing');
  const avatar = btn.querySelector('.account-avatar')!;
  assert.ok(avatar.classList.contains('colored'));
  assert.ok((avatar as HTMLElement).style.background, 'a colour from the account');
  assert.equal(avatar.getAttribute('aria-hidden'), 'true');
  await click(btn);
  assert.deepEqual(calls.at(-1), ['navigate', { name: 'settings', section: 'accounts' }]);
  await r.unmount();
});

test('signed out, the account row names the OS user; with none, N/A and no colour', async () => {
  reset();
  systemUsername = 'daxhill';
  const os = await render(h(RailAccount));
  assert.equal(os.host.querySelector('button')!.textContent, 'DAdaxhill');
  await os.unmount();
  systemUsername = null;
  const none = await render(h(RailAccount));
  const avatar = none.host.querySelector('.account-avatar') as HTMLElement;
  assert.equal(none.host.querySelector('button')!.textContent, 'N/AN/A');
  assert.equal(avatar.classList.contains('colored'), false);
  assert.equal(avatar.style.background, '');
  await none.unmount();
});

test('the rail ends with the account row, below where MoMo runs', async () => {
  reset();
  const r = await render(h(MomoShell, { children: h('div') }));
  await flush();
  const rail = r.host.querySelector('nav')!;
  const last = rail.lastElementChild!;
  assert.equal(last.tagName, 'BUTTON');
  assert.equal(last.getAttribute('title'), 'Accounts & billing');
  assert.equal(last.previousElementSibling!.textContent, 'Runs on this Mac');
  await r.unmount();
});
