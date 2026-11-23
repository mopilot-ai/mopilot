// Linked sessions on the phone: the Mac names the chat that started each linked chat in chats.recent, and the phone's Chats tab folds them under that chat as the Mac's sidebar nests them, on every harness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { withLayout } from './support/phone/home-layout';
import { act, createElement, createRoot, flush, click, inputText } from './support/phone/component-kit';
import { chatFamilies } from '../shared/chatFamilies.mjs';
const require = createRequire(import.meta.url);
const { recentRow } = require('../electron/app/chromePanelRecent.cjs');
const readMethods = require('../electron/remote/methods/read.cjs');
const pagesPath = '../mobile/src/chatPages';
const chipsPath = '../mobile/src/presentation/chatChips';
const groupsPath = '../mobile/src/presentation/chatGroups';
const listPath = '../mobile/src/screens/ChatList';
const rowPath = '../mobile/src/components/ChatRow';
const { chatPage } = await import(pagesPath);
const { chatChips, nestedState, chatStateLabel } = await import(chipsPath);
const { groupChats } = await import(groupsPath);
const { ChatList } = await import(listPath);
const { useHomeFolds } = await import('../mobile/src/useHomeFolds');
const StateList = withLayout(ChatList, useHomeFolds, 'state');
const { ChatRow } = await import(rowPath);

// one parent and child per harness family, mixed: a Codex thread, a Claude Code chat and an ACP chat
const CODEX = '019a0000-0000-7000-8000-000000000001';
const CLAUDE = 'claude:11111111-1111-4111-8111-111111111111';
const ACP = 'acp:gemini-cli:22222222-2222-4222-8222-222222222222';

const liveWith = (children: Record<string, any> | null, meta: Record<string, any> = {}) => ({
  chats: { records: new Map(Object.entries(meta).map(([id, m]) => [id, { meta: m }])) },
  capsService: { accountChip: () => null },
  ...(children && { orchestrator: { journal: { child: (id: string) => children[id] ?? null } } }),
});
const listed = (id: string) => ({ id, title: id, harness: 'codex', lastActivity: '2026-11-01T00:00:00Z', project: 'App' });

test('the Mac names the chat that started a linked chat, and how its last turn ended, on every harness', () => {
  const live = liveWith({
    [CLAUDE]: { parentId: CODEX, lastReport: { how: 'failed' } },
    [ACP]: { parentId: CLAUDE, lastReport: null },
    [CODEX]: { parentId: ACP, detached: true },
    orphan: { parentId: '' },
  });
  assert.deepEqual(
    [recentRow(live, listed(CLAUDE)).parentId, recentRow(live, listed(CLAUDE)).ended],
    [CODEX, 'failed'],
    'a Claude Code child of a Codex chat',
  );
  const acp = recentRow(live, listed(ACP));
  assert.equal(acp.parentId, CLAUDE, 'an ACP child of a Claude Code chat');
  assert.equal('ended' in acp, false, 'a child that has not reported says nothing of how it ended');
  for (const id of [CODEX, 'orphan', 'nobody']) {
    const row = recentRow(live, listed(id));
    assert.equal('parentId' in row || 'ended' in row, false, `${id}: detached, damaged or never started by a chat`);
  }
  // before linked sessions are wired (or on a Mac without them) the list is what it was
  const flat = recentRow(liveWith(null, { [CLAUDE]: { pinned: true } }), listed(CLAUDE));
  assert.deepEqual(Object.keys(flat).sort(), ['at', 'harness', 'id', 'pinned', 'project', 'projectId', 'title', 'unread']);
  assert.equal(flat.pinned, true);
});

test('the Mac announces linked chats in its hello', async () => {
  const svc = {
    version: '1',
    machineName: () => 'Mac',
    methodsFor: () => [],
    momoAllowed: () => false,
    homeOffered: () => false,
    momo: () => null,
    pushSettings: null,
    mirror: { available: () => false },
    policy: {},
  };
  const caps = (await readMethods['machine.hello'](svc, {})).capabilities;
  assert.equal(caps.linkedChats, true);
  // a service without Host's facade offers no machines
  assert.equal(caps.machines, false);
  // a service without the app's operations offers no rename or archive
  assert.deepEqual([caps.renameChats, caps.archiveChats], [false, false]);
});

test('the phone keeps a parent that names another chat and a known ending, and drops anything else', () => {
  const page = chatPage({
    chats: [
      { id: 'a', parentId: 'p', ended: 'stopped' },
      { id: 'b', parentId: 'b', ended: 'exploded' },
      { id: 'c', parentId: 7, ended: 3 },
      { id: 'd', parentId: '' },
      { id: 'e' },
    ],
  });
  assert.deepEqual(
    page.chats.map((c: any) => [c.parentId ?? null, c.ended ?? null]),
    [
      ['p', 'stopped'],
      [null, null],
      [null, null],
      [null, null],
      [null, null],
    ],
  );
});

test('a linked session whose last turn failed or was lost reads Failed, below running and waiting', () => {
  const now = 1_800_000_000_000;
  assert.deepEqual(chatChips({ ended: 'failed' }, now), { state: 'failed', stateLabel: 'Failed', harness: null });
  assert.equal(chatChips({ ended: 'lost', unread: true }, now).state, 'failed');
  assert.equal(chatChips({ ended: 'failed', state: 'running', at: now }, now).state, 'running');
  assert.equal(chatChips({ ended: 'failed', state: 'waiting' }, now).state, 'needsYou');
  assert.equal(chatChips({ ended: 'finished', unread: true }, now).state, 'done');
  assert.equal(chatChips({ ended: 'stopped' }, now).state, 'idle');
  assert.equal(chatChips({ ended: 'failed' }, now, true).state, 'offline');
});

test('a folded family shows one state, the most urgent: needs you, failed, running, unread; none offline or idle', () => {
  const now = 1_800_000_000_000;
  const waiting = { state: 'waiting' };
  const failed = { ended: 'failed' };
  const running = { state: 'running', at: now };
  const unread = { unread: true };
  const quiet = { state: 'running', at: now - 60 * 60_000 };
  assert.equal(nestedState([unread, running, failed, waiting], now), 'needsYou');
  assert.equal(nestedState([unread, running, failed], now), 'failed');
  assert.equal(nestedState([unread, running], now), 'running');
  assert.equal(nestedState([unread, quiet], now), 'done');
  assert.equal(nestedState([quiet, {}], now), null);
  assert.equal(nestedState([waiting, failed], now, true), null);
  assert.equal(nestedState([], now), null);
  // a screen reader hears that state in words
  assert.equal(chatStateLabel('needsYou'), 'Needs you');
  assert.equal(chatStateLabel('failed'), 'Failed');
});

test('families: a chat nests only under a listed parent, depth first at one level, and a loop hides nothing', () => {
  const parents: Record<string, string> = { b: 'a', c: 'b', d: 'a', e: 'gone', x: 'y', y: 'x' };
  const f = chatFamilies(['c', 'a', 'b', 'd', 'e', 'x', 'y', 'c'], (id) => parents[id]);
  assert.deepEqual(f.roots, ['a', 'e', 'x', 'y'], 'the root moves to its best member, a missing parent leaves a root');
  assert.deepEqual(f.descendants.get('a'), ['b', 'c', 'd']);
  assert.deepEqual(f.descendants.get('x'), []);
  assert.deepEqual(
    chatFamilies([], () => null),
    { roots: [], descendants: new Map() },
  );
});

const family = [
  { id: CODEX, title: 'mopilot Remote Run', state: 'idle', harness: 'codex', project: 'App' },
  { id: CLAUDE, title: 'Host relay transport', state: 'running', harness: 'claude', project: 'App', parentId: CODEX },
  { id: ACP, title: 'Design v2', state: 'idle', harness: 'acp:gemini-cli', project: 'Web', parentId: CLAUDE, ended: 'failed' },
  { id: 'solo', title: 'Solo', state: 'idle', harness: 'codex', project: 'App' },
];
const ids = (rows: any[]) => rows.map((c) => c.id);

test('groups: linked sessions fold under the chat that started them, across projects and harnesses, listed once', () => {
  const g = groupChats(family, '');
  assert.deepEqual(
    g.projects.map((p: any) => [p.name, ids(p.chats)]),
    [['App', [CODEX, 'solo']]],
    'a child in another project stays with its family',
  );
  assert.deepEqual(ids(g.nested.get(CODEX)), [CLAUDE, ACP]);
  assert.equal(g.nested.has('solo'), false, 'a chat that started none has no family');
  // empty and flat lists are what they were
  const empty = groupChats([], '');
  assert.deepEqual([empty.projects, empty.nested], [[], new Map()]);
  assert.equal(groupChats([family[3]], '').nested.size, 0);
});

test('groups: a waiting parent keeps its family in its project; a search that leaves the parent out shows the child alone', () => {
  const rows = family.map((c) =>
    c.id === ACP ? { ...c, state: 'waiting' } : c.id === CODEX ? { ...c, state: 'waiting', pinned: true } : c,
  );
  const g = groupChats(rows, '');
  assert.deepEqual(
    g.projects.map((p: any) => ids(p.chats)),
    [[CODEX, 'solo']],
  );
  assert.deepEqual(ids(g.nested.get(CODEX)), [CLAUDE, ACP]);
  const found = groupChats(family, 'design');
  assert.deepEqual(
    found.projects.map((p: any) => ids(p.chats)),
    [[ACP]],
  );
  assert.equal(found.nested.size, 0);
});

const mounted: any[] = [];
async function mount(node: any) {
  for (const old of mounted.splice(0)) await act(async () => old.root.unmount()), old.host.remove();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => root.render(node));
  await flush();
  return host;
}
const list = (chats: any[], props: any = {}) =>
  createElement(StateList, { chats, failed: false, busy: false, scheduled: () => {}, open: () => {}, ...props });
const labels = (host: HTMLElement) =>
  [...host.querySelectorAll('button[aria-label^="Open chat"]')].map((b) => b.getAttribute('aria-label'));

test('the Chats list folds a family behind its count by default, unfolds it under a guide line on a tap, and a child opens like any chat', async () => {
  const opened: string[] = [];
  const host = await mount(list(family, { open: (id: string) => opened.push(id) }));
  // the family is placed by its failed child under Needs input, whole; Solo is in the list after it
  assert.match(host.textContent!, /Needs input.*mopilot Remote Run.*Solo/);
  assert.doesNotMatch(host.textContent!, /Quiet/);
  assert.deepEqual(labels(host), ['Open chat mopilot Remote Run', 'Open chat Solo']);
  const toggle = host.querySelector('button[aria-label^="2 sub-sessions"]') as HTMLElement;
  assert.equal(toggle.getAttribute('aria-label'), '2 sub-sessions, Failed', 'the family’s most urgent state is read out');
  assert.equal(toggle.textContent, '2⌄', 'on screen: the count and a chevron');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  (globalThis as any).__haptics = [];
  await click('2 sub-sessions, Failed');
  assert.deepEqual((globalThis as any).__haptics, ['selection'], 'the fold ticks');
  assert.equal(host.querySelectorAll('[data-entering="FadeIn"]').length, 2, 'each shown sub-session fades in');
  assert.deepEqual(labels(host), [
    'Open chat mopilot Remote Run',
    'Open chat Host relay transport',
    'Open chat Design v2',
    'Open chat Solo',
  ]);
  assert.match(host.textContent!, /Design v2Failed/, 'a failed child says so on its row');
  const guide = [...host.querySelectorAll('[data-style]')]
    .map((n) => JSON.parse(n.getAttribute('data-style')!))
    .find((st) => st.left === 35);
  assert.ok(guide, 'the shown sub-sessions hang off a guide line');
  await click('Open chat Design v2');
  assert.deepEqual(opened, [ACP]);
  await click('2 sub-sessions, Failed');
  assert.deepEqual(labels(host), ['Open chat mopilot Remote Run', 'Open chat Solo']);
});

test('a parent turns amber with "A sub-session needs you" when a child waits, and says so to a screen reader', async () => {
  const waits = family.map((c) => (c.id === ACP ? { ...c, state: 'waiting', ended: undefined } : c));
  const host = await mount(list(waits));
  const parent = host.querySelector('button[aria-label="Open chat mopilot Remote Run"]')!;
  assert.match(parent.textContent!, /A sub-session needs you/);
  assert.ok(parent.querySelector('[data-symbol="hand.raised"]'), 'the amber hand');
  assert.match(parent.getAttribute('aria-valuetext')!, /^A sub-session needs you/);
  assert.ok(host.querySelector('button[aria-label="2 sub-sessions, Needs you"]'));
});

test('a parent that waits only through a sub-session takes a tap to that sub-session: its quick review, else the sub-session itself', async () => {
  const waits = family.map((c) => (c.id === ACP ? { ...c, state: 'waiting', ended: undefined } : c));
  const opened: string[] = [];
  const reviewed: string[] = [];
  await mount(list(waits, { open: (id: string) => opened.push(id), review: (id: string) => reviewed.push(id) }));
  await click('Open chat mopilot Remote Run');
  assert.deepEqual([opened, reviewed], [[], [ACP]], 'the waiting sub-session’s question, not the parent');
  // where nothing can be answered from the list (no review), the waiting sub-session opens
  await mount(list(waits, { open: (id: string) => opened.push(id) }));
  await click('Open chat mopilot Remote Run');
  assert.deepEqual(opened, [ACP]);
  // a parent that waits itself still opens its own question
  const both = waits.map((c) => (c.id === CODEX ? { ...c, state: 'waiting', ended: undefined } : c));
  reviewed.length = 0;
  await mount(list(both, { open: (id: string) => opened.push(id), review: (id: string) => reviewed.push(id) }));
  await click('Open chat mopilot Remote Run');
  assert.deepEqual(reviewed, [CODEX]);
});

test('a search shows every matching family member, and the fold it overrides cannot be changed unseen', async () => {
  const searchPath = '../mobile/src/components/ChatSearch';
  const search = await import(searchPath);
  const host = await mount(
    createElement(search.ChatSearchProvider, {
      children: (s: any) =>
        createElement('div', null, createElement('button', { 'aria-label': 'Search chats', onClick: s.show }), list(family)),
    }),
  );
  await click('Search chats');
  await inputText('Search chats', 'a');
  assert.ok(labels(host).includes('Open chat Host relay transport'), 'a search unfolds the families it matches');
  const toggle = host.querySelector('button[aria-label*="sub-session"]') as HTMLButtonElement;
  assert.equal(toggle.disabled, true);
});

test('a nested row is inset beside the guide line with a smaller title, and a change of nesting redraws it', async () => {
  const chat = { id: 'n', title: 'Nested' };
  const host = await mount(createElement(ChatRow, { chat, open: () => {}, nested: true }));
  const pad = () => JSON.parse(host.querySelector('button')!.getAttribute('data-style')!).paddingLeft;
  assert.equal(pad(), 60);
  await act(async () => mounted[0].root.render(createElement(ChatRow, { chat, open: () => {} })));
  assert.equal(pad(), 24);
});

test('a family with nothing to say reads only its count', async () => {
  const quiet = [
    { id: 'p', title: 'Parent', state: 'idle', pinned: true, project: null },
    { id: 'k', title: 'Kid', state: 'idle', parentId: 'p' },
  ];
  const host = await mount(list(quiet));
  assert.ok(host.querySelector('button[aria-label="1 sub-session"]'));
});
