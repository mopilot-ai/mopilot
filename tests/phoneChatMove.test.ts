// "Move to another computer": machine, folder and carry steps, the Mac's own words for a refusal, answers that come after the person went back, and when the ⋯ offers it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, click, createElement, createRoot, flush } from './support/phone/component-kit';

const movePath = '../mobile/src/remote/machineMove';
const sheetPath = '../mobile/src/components/MoveSheet';
const headerPath = '../mobile/src/components/ChatHeader';
const linkPath = '../mobile/src/macLink';
const { parseFolders, readFolders, moveChat, readMoveProjects } = await import(movePath);
const { MoveSheet, BACK_TO_MAC } = await import(sheetPath);
const { ChatHeader } = await import(headerPath);
const { MacLinkProvider } = await import(linkPath);

const machine = (id: string, name: string, line = 'Online') => ({
  id,
  name,
  status: 'online',
  line,
  tone: 'ok',
  keepRunning: null,
  agents: [],
});
const MACHINES = [machine('local', 'This Mac'), machine('h1', 'Studio', 'Online · Claude Code'), machine('h2', 'Build box', 'Offline')];
const LISTING = {
  path: '/srv',
  roots: ['/srv'],
  entries: [
    { name: 'shop', path: '/srv/shop', git: true },
    { name: 'notes', path: '/srv/notes', git: false },
    { name: '', path: '/srv/bad', git: false },
  ],
  more: false,
};

async function mount(node: any) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  await flush();
  return {
    host,
    root,
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}
function rig(answers: Record<string, unknown> = {}) {
  const calls: [string, any][] = [];
  const request = async (method: string, params: any = {}) => {
    calls.push([method, params]);
    const given = answers[method];
    if (typeof given === 'function') return given(params);
    if (given instanceof Error) throw given;
    return given ?? {};
  };
  return { request, calls };
}
const sheet = (request: any, extra: Record<string, unknown> = {}) =>
  createElement(MoveSheet, { open: true, onClose: () => {}, request, chatId: 'c', machines: MACHINES, moved: () => {}, ...extra });

test('the folder listing is read defensively: rows without a name or path drop, no path is no listing', () => {
  assert.deepEqual(
    parseFolders(LISTING).entries.map((e: any) => e.name),
    ['shop', 'notes'],
  );
  assert.deepEqual(parseFolders({ path: '/a', roots: ['/a', 3], entries: 'x', more: true }), {
    path: '/a',
    roots: ['/a'],
    entries: [],
    more: true,
  });
  assert.deepEqual(parseFolders({ path: '/a' }).roots, [], 'a machine that names no roots has none');
  assert.throws(() => parseFolders({ entries: [] }), /Couldn’t read that machine’s folders|Couldn't read that machine's folders/);
  assert.throws(() => parseFolders(null));
});

test('machines.folders and chat.move carry what was picked', async () => {
  const { request, calls } = rig({ 'machines.folders': LISTING });
  await readFolders(request, 'h1');
  await readFolders(request, 'h1', '/srv/shop');
  await moveChat(request, { chatId: 'c', hostId: 'h1', folder: '/srv/shop', carry: 'code' });
  assert.deepEqual(calls, [
    ['machines.folders', { id: 'h1' }],
    ['machines.folders', { id: 'h1', path: '/srv/shop' }],
    ['chat.move', { chatId: 'c', hostId: 'h1', folder: '/srv/shop', carry: 'code' }],
  ]);
});

test('machine, folder, carry: a chat moves to the picked folder, carrying its changes, and the screen is told', async () => {
  const { request, calls } = rig({ 'machines.folders': LISTING });
  const done: string[] = [];
  const v = await mount(sheet(request, { moved: () => done.push('moved'), onClose: () => done.push('closed') }));
  assert.match(v.host.textContent!, /This Mac.*This chat runs here\./s, 'a chat on this Mac shows it as where it is');
  assert.equal(BACK_TO_MAC, 'Move it back on your Mac.');
  await click('Studio');
  assert.match(v.host.textContent!, /\/srv/);
  assert.doesNotMatch(v.host.textContent!, /bad/);
  await click('notes');
  await click('Use this folder');
  await click('Take the changes along');
  assert.deepEqual(calls.at(-1), ['chat.move', { chatId: 'c', hostId: 'h1', folder: '/srv', carry: 'code' }]);
  assert.deepEqual(done, ['closed', 'moved']);
  await v.done();
});

test('leaving the changes sends carry none; a chat already on a machine shows it checked and cannot pick it', async () => {
  const { request, calls } = rig({ 'machines.folders': { ...LISTING, more: true } });
  const v = await mount(sheet(request, { hostId: 'h1' }));
  assert.match(
    v.host.textContent!,
    /This Mac.*Move it back on your Mac\..*Studio.*This chat runs here\./s,
    'the way back is named as the Mac’s own',
  );
  await click('Build box');
  assert.match(v.host.textContent!, /More folders are on the machine than the phone lists\./);
  await click('Use this folder');
  await click('Leave the changes');
  assert.equal(calls.at(-1)![1].carry, 'none');
  await v.done();
});

test('a refusal shows the Mac’s words where it happened, and the person can go back and try another machine', async () => {
  const { request, calls } = rig({
    'machines.folders': (p: any) => {
      if (p.id === 'h2') throw new Error('Build box isn’t reachable. Check it’s online, then try again.');
      return LISTING;
    },
    'chat.move': new Error('The folder on Studio is on another branch. Switch it first, or continue without the changes.'),
  });
  const v = await mount(sheet(request));
  await click('Build box');
  assert.match(v.host.textContent!, /Build box isn’t reachable\. Check it’s online, then try again\./);
  await click('Back');
  assert.doesNotMatch(v.host.textContent!, /isn’t reachable/, 'going back clears it');
  await click('Studio');
  await click('Use this folder');
  await click('Take the changes along');
  assert.match(v.host.textContent!, /on another branch\. Switch it first/);
  assert.equal(calls.filter(([m]) => m === 'chat.move').length, 1);
  // back from the carry step returns to the folders, and a second try can go out
  await click('Back');
  assert.match(v.host.textContent!, /Use this folder/);
  assert.doesNotMatch(v.host.textContent!, /on another branch/);
  await v.done();
});

test('a listing that answers after the person went back is dropped, and a second tap while a move runs sends one', async () => {
  let release!: (v: unknown) => void;
  const slow = new Promise((resolve) => (release = resolve));
  let moves = 0;
  const { request } = rig({
    'machines.folders': () => slow,
    'chat.move': () => {
      moves++;
      return new Promise(() => undefined);
    },
  });
  const v = await mount(sheet(request));
  await click('Studio');
  assert.match(v.host.textContent!, /Loading…/);
  await click('Back');
  release(LISTING);
  await flush();
  assert.doesNotMatch(v.host.textContent!, /shop/);
  const quick = rig({ 'machines.folders': LISTING, 'chat.move': () => (moves++, new Promise(() => undefined)) });
  await act(async () => v.root.render(sheet(quick.request)));
  await flush();
  await click('Studio');
  await click('Use this folder');
  await click('Take the changes along');
  // while the move runs its rows take no tap, so a second one cannot send another
  assert.equal(
    [...v.host.querySelectorAll('button')].some((b) => b.getAttribute('aria-label') === 'Take the changes along'),
    false,
  );
  assert.equal(moves, 1);
  await v.done();
});

test('closing the sheet starts it again from the machines', async () => {
  const { request } = rig({ 'machines.folders': LISTING });
  const closed: string[] = [];
  const v = await mount(sheet(request, { onClose: () => closed.push('x') }));
  await click('Studio');
  await click('Dismiss');
  assert.deepEqual(closed, ['x']);
  assert.match(v.host.textContent!, /Move to another computer/);
  await v.done();
});

const state = (phase = 'online') => ({
  phase,
  generation: 1,
  user: { id: 'u' },
  pairs: [{ pairId: 'p1', macId: 'm1', name: 'MacBook Pro' }],
  selectedPair: phase === 'online' ? 'p1' : null,
  presence: {},
  reconnect: null,
  outbox: [],
  error: null,
});
const runtime = (machines: unknown[]) => ({
  request: async (method: string) =>
    method === 'machine.hello' ? { capabilities: { machines: true } } : method === 'machines.list' ? { machines } : undefined,
  onEvent: () => () => undefined,
});
const header = (reqs: any) =>
  createElement(ChatHeader, {
    request: reqs,
    chatId: 'c',
    title: 'Fix',
    back: () => {},
    reload: () => {},
    changed: () => {},
    hostId: 'h1',
  });

test('⋯ offers Move to another computer only with the Mac there and a machine to move to', async () => {
  const names = (host: HTMLElement) => [...host.querySelectorAll('[role="menuitem"]')].map((n) => n.getAttribute('aria-label'));
  const withHosts = await mount(createElement(MacLinkProvider, { state: state(), runtime: runtime(MACHINES) }, header(rig().request)));
  await flush();
  await flush();
  await click('Chat menu');
  assert.ok(names(withHosts.host).includes('Move to another computer'), names(withHosts.host).join('|'));
  await click('Move to another computer');
  assert.match(withHosts.host.textContent!, /Studio/);
  await withHosts.done();
  const alone = await mount(
    createElement(MacLinkProvider, { state: state(), runtime: runtime([machine('local', 'This Mac')]) }, header(rig().request)),
  );
  await flush();
  await click('Chat menu');
  assert.ok(!names(alone.host).includes('Move to another computer'));
  await alone.done();
  const away = await mount(createElement(MacLinkProvider, { state: state('offline'), runtime: runtime(MACHINES) }, header(rig().request)));
  await click('Chat menu');
  assert.ok(!names(away.host).includes('Move to another computer'));
  await away.done();
});

test('a move that answers after the sheet was closed still tells the screen to read the chat again', async () => {
  let release!: (v: unknown) => void;
  const { request } = rig({ 'machines.folders': LISTING, 'chat.move': () => new Promise((resolve) => (release = resolve)) });
  const done: string[] = [];
  const v = await mount(sheet(request, { moved: () => done.push('moved'), onClose: () => done.push('closed') }));
  await click('Studio');
  await click('Use this folder');
  await click('Take the changes along');
  await click('Dismiss');
  release({});
  await flush();
  assert.deepEqual(done, ['closed', 'moved'], 'the person’s own close, then the screen reads the chat again: the Mac did move it');
  await v.done();
});

test('from the ⋯ the sheet moves the chat, then the screen reads the chat list and its controls again, and Dismiss closes it', async () => {
  const calls: string[] = [];
  const { request } = rig({ 'machines.folders': LISTING });
  const node = createElement(
    MacLinkProvider,
    { state: state(), runtime: runtime(MACHINES) },
    createElement(ChatHeader, {
      request,
      chatId: 'c',
      title: 'Fix',
      back: () => {},
      reload: () => calls.push('reload'),
      changed: () => calls.push('changed'),
      hostId: 'h1',
    }),
  );
  const v = await mount(node);
  await flush();
  await flush();
  await click('Chat menu');
  await click('Move to another computer');
  await click('Dismiss');
  assert.doesNotMatch(v.host.textContent!, /Build box/, 'closed');
  await click('Chat menu');
  await click('Move to another computer');
  await click('Build box');
  await click('Use this folder');
  await click('Leave the changes');
  assert.deepEqual(calls, ['changed', 'reload']);
  await v.done();
});

test('the folder step goes up a level, but not above a root or the top', async () => {
  const at = (path: string, roots = ['/srv']) => ({
    path,
    roots,
    entries: [{ name: 'deep', path: `${path}/deep`, git: false }],
    more: false,
  });
  const { request, calls } = rig({ 'machines.folders': (p: any) => at(p.path ?? '/srv') });
  const v = await mount(sheet(request));
  await click('Studio');
  assert.doesNotMatch(v.host.textContent!, /Up one folder/, 'a root has nothing above it');
  await click('deep');
  assert.match(v.host.textContent!, /Up one folder/);
  await click('..');
  assert.deepEqual(calls.at(-1), ['machines.folders', { id: 'h1', path: '/srv' }]);
  assert.doesNotMatch(v.host.textContent!, /Up one folder/);
  await v.done();
  const top = rig({ 'machines.folders': { path: '/', roots: [], entries: [], more: false } });
  const t = await mount(sheet(top.request));
  await click('Studio');
  assert.doesNotMatch(t.host.textContent!, /Up one folder/, 'nothing above the top');
  await t.done();
  const one = rig({ 'machines.folders': { path: '/work', roots: [], entries: [], more: false } });
  const w = await mount(sheet(one.request));
  await click('Studio');
  await click('..');
  assert.deepEqual(one.calls.at(-1), ['machines.folders', { id: 'h1', path: '/' }], 'the folder above a top-level one is the top');
  await w.done();
});

const CAN = { 'machine.hello': { capabilities: { moveToProject: true } } };
const PROJECTS = {
  projects: [
    { id: 'dev-repo', name: 'Dev repo', branch: 'main' },
    { id: 'notes', label: 'Notes', branch: null },
    { id: 'bare' },
    { name: 'no id' },
  ],
};

test('saved projects are offered only where the Mac says it takes one, read defensively', async () => {
  const no = rig({ 'machine.hello': { capabilities: {} }, 'projects.list': PROJECTS });
  assert.equal(await readMoveProjects(no.request), null);
  assert.deepEqual(
    no.calls.map(([m]) => m),
    ['machine.hello'],
    'nothing more is asked of a Mac that takes none',
  );
  assert.equal(await readMoveProjects(rig({ 'machine.hello': null }).request), null);
  const yes = rig({ ...CAN, 'projects.list': PROJECTS });
  assert.deepEqual(await readMoveProjects(yes.request), [
    { id: 'dev-repo', label: 'Dev repo', branch: 'main' },
    { id: 'notes', label: 'Notes', branch: null },
    { id: 'bare', label: 'bare', branch: null },
  ]);
  assert.deepEqual(await readMoveProjects(rig({ ...CAN, 'projects.list': { projects: 'x' } }).request), []);
  assert.deepEqual(await moveChat(rig().request, { chatId: 'c', carry: 'none', hostId: 'local', projectId: 'dev-repo' }), undefined);
});

test('a chat on a machine can move back to This Mac into a saved project, the Mac resolving the folder itself', async () => {
  const { request, calls } = rig({ ...CAN, 'projects.list': PROJECTS });
  const done: string[] = [];
  const v = await mount(sheet(request, { hostId: 'h1', moved: () => done.push('moved') }));
  await flush();
  assert.doesNotMatch(v.host.textContent!, /Move it back on your Mac\./, 'a Mac that takes projects offers them');
  await click('This Mac');
  assert.match(v.host.textContent!, /Pick a project/);
  assert.match(v.host.textContent!, /Dev repo.*main/s);
  await click('Dev repo');
  assert.match(v.host.textContent!, /This Mac: Dev repo/);
  // back from the last step returns to the projects, not to a folder listing
  await click('Back');
  assert.match(v.host.textContent!, /Pick a project/);
  await click('Dev repo');
  await click('Take the changes along');
  assert.deepEqual(calls.at(-1), ['chat.move', { chatId: 'c', carry: 'code', hostId: 'local', projectId: 'dev-repo' }]);
  assert.deepEqual(done, ['moved']);
  await v.done();
});

test('the Mac’s refusal for a project shows as given, and a Mac with no saved projects says so', async () => {
  const { request } = rig({ ...CAN, 'projects.list': PROJECTS, 'chat.move': new Error("That project isn't in MoPilot.") });
  const v = await mount(sheet(request, { hostId: 'h1' }));
  await flush();
  await click('This Mac');
  await click('Notes');
  await click('Leave the changes');
  assert.match(v.host.textContent!, /That project isn't in MoPilot\./);
  await v.done();
  const empty = await mount(sheet(rig({ ...CAN, 'projects.list': { projects: [] } }).request, { hostId: 'h1' }));
  await flush();
  await click('This Mac');
  assert.match(empty.host.textContent!, /No saved projects on this Mac\./);
  await empty.done();
});

test('projects are read only for a chat that is elsewhere, and a late or failed read changes nothing', async () => {
  const local = rig({ ...CAN, 'projects.list': PROJECTS });
  const here = await mount(sheet(local.request));
  await flush();
  assert.equal(local.calls.length, 0, 'a chat on this Mac has nowhere to move back to');
  await here.done();
  const failing = rig({ 'machine.hello': new Error('offline') });
  const f = await mount(sheet(failing.request, { hostId: 'h1' }));
  await flush();
  assert.match(f.host.textContent!, /Move it back on your Mac\./, 'a failed read leaves the line');
  await f.done();
  let answer!: (v: unknown) => void;
  const late = rig({ 'machine.hello': () => new Promise((resolve) => (answer = resolve)), 'projects.list': PROJECTS });
  const l = await mount(sheet(late.request, { hostId: 'h1' }));
  await act(async () => l.root.render(sheet(late.request, { hostId: 'h1', open: false })));
  answer({ capabilities: { moveToProject: true } });
  await flush();
  await act(async () => l.root.render(sheet(late.request, { hostId: 'h1', open: true })));
  assert.match(l.host.textContent!, /Move it back on your Mac\./, 'the answer to the closed sheet is not kept');
  await l.done();
  let fail!: (e: unknown) => void;
  const lateFail = rig({ 'machine.hello': () => new Promise((_, reject) => (fail = reject)) });
  const lf = await mount(sheet(lateFail.request, { hostId: 'h1' }));
  await act(async () => lf.root.render(sheet(lateFail.request, { hostId: 'h1', open: false })));
  fail(new Error('late'));
  await flush();
  await lf.done();
});
