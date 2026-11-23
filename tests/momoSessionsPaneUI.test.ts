// MoMo's Sessions pane (src/components/momo/sessions, shell/MomoShell.tsx, M6): the third button at the top right exists only with `momo.sessions`; the pane lists the other chats in the design's groups with each one's harness and where it runs (this Mac, a machine, a machine that is away), a click opens the chat, the design's two controls save their settings, and with the list off nothing is read or shown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import './support/dom.ts';
import { window } from './support/dom.ts';
import { createElement as h } from 'react';
import { render, click, flush } from './support/shell-chrome-kit.ts';
import { mockSource, stubStore } from './support/stubs.ts';
import { installNativeStub } from './support/ports/native.ts';
import { reactivePrefs } from './support/reactivePrefs.ts';

(window as any).innerWidth = 1600;
installNativeStub({ momoChat: { previousChats: async () => [] } });

const EMPTY = {
  sessions: {},
  runtime: {},
  pending: [] as any[],
  elsewhere: {},
  unread: {},
  threadOrder: [] as string[],
  threads: {} as any,
};
let world: any = EMPTY;
let hostOwners = new Map<string, string>();
let hostAnswered = true;
let machines: any[] = [];
const reads = { family: 0 };
const opened: any[] = [];
const ensured: string[] = [];
const saved: any[] = [];
let prefsNow: any = {};

const store = reactivePrefs(() => ({ route: { name: 'momo' }, momoChats: { 'momo:main': 'main' }, ...world }));
stubStore({
  useStore: store.useStore,
  setPrefs: store.setPrefs,
  navigate: () => undefined,
  threadTitle: (t: any) => t.name ?? t.id,
  chatHarnessLabel: (id: string) => (id.startsWith('codex') ? 'Codex' : id.startsWith('acp') ? 'Kimi Code' : 'Claude Code'),
});
mockSource('src/lib/mopilot.ts', { useMoPilot: () => ({ signedIn: false, user: null }) });
mockSource('src/session/momoPrefs.ts', {
  useMomoPrefs: () => ({ paused: false, tasksPanel: true, ...prefsNow }),
  saveMomoPref: async (key: string, value: unknown) => (saved.push([key, value]), true),
});
mockSource('src/lib/flags.ts', { useFlag: () => true });
mockSource('src/components/momo/tasks/TasksPanel.tsx', { TasksPanel: () => h('div', { 'data-stub': 'tasks' }) });
mockSource('src/components/momo/MomoOutputs.tsx', { MomoOutputs: () => h('div', { 'data-stub': 'files' }) });
mockSource('src/store/session/useSession.ts', {
  useSessions: (sel: any) => sel({ sessions: world.sessions }),
  ensureSession: (id: string) => ensured.push(id),
});
mockSource('src/session/harness/claude/desktopLineage.ts', { useSidebarLineage: () => ({}) });
mockSource('src/lib/sidebarFamilyIndex.ts', {
  // a root the threads no longer hold (removed between the list and this read) is left out
  familiesOf: (_v: unknown, order: string[]) => (reads.family++, { roots: [...order.filter((id) => id !== 'child'), 'ghost'] }),
});
mockSource('src/lib/hostChats.ts', {
  useHostChats: () => ({ owners: hostOwners, status: 'ready', answered: hostAnswered }),
  machineOfChat: (state: any, id: string) => (state.answered ? (state.owners.get(id) ?? '') : null),
});
mockSource('src/lib/hostMachines.ts', { useHostMachines: () => ({ machines, resolved: true }) });
mockSource('src/session/openChat.ts', { openChatFrom: (e: any, id: string) => opened.push([id, !!e]) });
const { MomoShell } = await import('../src/components/momo/shell/MomoShell.tsx');

const chat = (id: string, name: string) => ({ id, name, cwd: '/repo', status: { type: 'idle' } });
const session = (turn: string) => ({
  rev: 1,
  turn,
  approvals: [],
  questions: [],
  background: [],
  tasks: [],
  runningElsewhere: false,
});
const reset = () => {
  store.reset();
  world = {
    sessions: { 'claude:a': session('awaitingUser'), 'codex-b': session('running'), 'acp:kimi:c': session('idle') },
    runtime: {},
    pending: [],
    elsewhere: {},
    unread: { 'acp:kimi:c': true },
    threadOrder: ['claude:a', 'codex-b', 'acp:kimi:c', 'quiet', 'child', 'momo:main'],
    threads: Object.fromEntries(
      ['claude:a', 'codex-b', 'acp:kimi:c', 'quiet', 'child', 'momo:main'].map((id) => [id, chat(id, `Chat ${id}`)]),
    ),
  };
  hostOwners = new Map([
    ['codex-b', 'studio'],
    ['acp:kimi:c', 'laptop'],
  ]);
  hostAnswered = true;
  machines = [
    { id: 'studio', name: 'Studio', status: 'online' },
    { id: 'laptop', name: 'Laptop', status: 'offline' },
  ];
  prefsNow = { sessions: true, sessionsShow: true, sessionsAct: false };
  reads.family = 0;
  opened.length = 0;
  ensured.length = 0;
  saved.length = 0;
};
const open = async () => {
  const r = await render(h(MomoShell, { children: h('div') }));
  await flush();
  await click(r.host.querySelector('[aria-label="Sessions"][aria-pressed]'));
  return r;
};
const pane = (r: any) => r.host.querySelector('aside')!;

test('the Sessions button is there only with `momo.sessions`, and is the third at the top right', async () => {
  reset();
  prefsNow = { sessions: false };
  const off = await render(h(MomoShell, { children: h('div') }));
  assert.equal(off.host.querySelector('[aria-label="Sessions"]'), null);
  await off.unmount();
  prefsNow = { sessions: true };
  const on = await render(h(MomoShell, { children: h('div') }));
  const names = [...on.host.querySelectorAll('[aria-pressed]')].map((b: any) => b.getAttribute('aria-label'));
  assert.deepEqual(names, ['Tasks', 'Files', 'Sessions']);
  await on.unmount();
});

test('the pane lists the other chats in the design’s groups with their harness and place, in list order, and leaves out MoMo’s own, children and quiet chats', async () => {
  reset();
  const r = await open();
  assert.equal(pane(r).querySelector('h2')!.textContent, 'Sessions');
  assert.deepEqual(
    [...pane(r).querySelectorAll('h3')].map((x: any) => x.textContent),
    ['Needs input', 'Working', 'Can wait'],
  );
  const rows = [...pane(r).querySelectorAll('[data-session-row]')].map((b: any) => [b.dataset.sessionRow, b.textContent]);
  assert.deepEqual([...new Set(ensured)].sort(), ['acp:kimi:c', 'claude:a', 'codex-b', 'ghost', 'momo:main', 'quiet']);
  assert.deepEqual(rows, [
    ['claude:a', 'Chat claude:aClaude Code · This Mac'],
    ['codex-b', 'Chat codex-bCodex · Studio'],
    ['acp:kimi:c', 'Chat acp:kimi:cKimi Code · Laptop · away'],
  ]);
  await r.unmount();
});

test('a machine whose chats are not known yet or that is no longer listed: this Mac, or its id', async () => {
  reset();
  hostAnswered = false;
  const unknown = await open();
  assert.match(pane(unknown).textContent, /Codex · This Mac/);
  await unknown.unmount();
  store.reset();
  hostAnswered = true;
  machines = [];
  const gone = await open();
  assert.match(pane(gone).textContent, /Codex · studio/);
  assert.match(pane(gone).textContent, /Kimi Code · laptop/);
  await gone.unmount();
});

test('a click opens the chat; a pane with nothing open says so', async () => {
  reset();
  const r = await open();
  await click(pane(r).querySelector('[data-session-row="codex-b"]'));
  assert.deepEqual(opened, [['codex-b', true]]);
  await r.unmount();
  store.reset();
  world = { ...world, sessions: {}, unread: {}, threadOrder: ['quiet'] };
  const none = await open();
  assert.equal(pane(none).querySelector('p')!.textContent, 'No open chats right now.');
  assert.equal(pane(none).querySelector('[data-session-row]'), null);
  await none.unmount();
});

test('the design’s two controls save their settings; with the list off nothing is read or listed', async () => {
  reset();
  const r = await open();
  const [show, act] = [...pane(r).querySelectorAll('[role="switch"]')] as HTMLElement[];
  assert.deepEqual([show.getAttribute('aria-label'), show.getAttribute('aria-checked')], ['Show other chats', 'true']);
  assert.deepEqual([act.getAttribute('aria-label'), act.getAttribute('aria-checked')], ['Let MoMo answer their requests', 'false']);
  await click(act);
  await click(show);
  assert.deepEqual(saved, [
    ['sessionsAct', true],
    ['sessionsShow', false],
  ]);
  await r.unmount();
  store.reset();
  prefsNow = { sessions: true, sessionsShow: false, sessionsAct: true };
  reads.family = 0;
  ensured.length = 0;
  const hidden = await open();
  assert.equal(pane(hidden).querySelector('p')!.textContent, 'Other chats are hidden.');
  assert.equal(pane(hidden).querySelector('[data-session-row]'), null);
  assert.equal(reads.family, 0, 'nothing is read while the list is off');
  assert.deepEqual(ensured, [], 'and no chat’s session is asked for');
  assert.equal(pane(hidden).querySelectorAll('[aria-checked="true"]').length, 1, 'only the second control is on');
  await hidden.unmount();
});

test('the pane’s motion is the shell’s tokens, and stops with Reduce Motion', () => {
  const css = readFileSync(new URL('../src/components/momo/sessions/sessions.module.css', import.meta.url), 'utf8');
  assert.match(css, /transition: background-color var\(--momo-dur-s\) var\(--momo-ease-out\)/);
  assert.doesNotMatch(css, /cubic-bezier|\d+ms/);
  assert.match(css, /prefers-reduced-motion: reduce\)[^}]*\{\s*\.row \{\s*transition: none/);
});
