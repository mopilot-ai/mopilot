// A long press on a Chats-home row opens the chat's own actions, Pin or Unpin, Rename and Archive, only the ones this Mac can do; a swipe does nothing, and a screen reader reaches the same menu as an action on the row (the owner's decision on the home, design/phone-on-orca/chats-home-inventory.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click, inputText } from './support/phone/component-kit';
import { scripted } from './support/phone/m3';
import { BY_STATE } from './support/phone/home-layout';

const appPath = '../mobile/src/MobileApp';
const { MobileApp } = await import(appPath);
const listPath = '../mobile/src/screens/ChatList';
const { ChatList } = await import(listPath);

const online = {
  phase: 'online',
  generation: 1,
  user: { id: 'u', name: 'Dana' },
  pairs: [{ pairId: 'p', macId: 'm', name: 'Studio Mac' }],
  selectedPair: 'p',
  error: null,
};
const ALL = {
  methods: ['chats.pin', 'chats.rename', 'chats.archive'],
  renameChats: true,
  archiveChats: true,
  permissionCeiling: 'auto-review',
};
const chats = [
  { id: 'c1', title: 'Fix login', state: 'idle', harness: 'claude', project: 'App' },
  { id: 'c2', title: 'Write docs', state: 'idle', harness: 'codex', project: 'App', pinned: true },
  { id: 'c3', state: 'idle', harness: 'claude', project: 'App' },
];

async function mount(caps: unknown = ALL, answers: Record<string, unknown> = {}, snap: any = online) {
  const calls: Array<[string, unknown]> = [];
  const s = scripted((method, params) => {
    calls.push([method, params]);
    const given = answers[method];
    if (given instanceof Error) throw given;
    if (method === 'chats.recent') return { chats };
    if (method === 'machine.hello') return { capabilities: caps };
    return given;
  }, snap);
  s.runtime.start = async () => {};
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(MobileApp, { runtime: s.runtime, homeLayout: BY_STATE })));
  await flush();
  return { host, calls, done: async () => (await act(async () => root.unmount()), host.remove()) };
}
const row = (host: HTMLElement, title: string) => host.querySelector(`button[aria-label="Open chat ${title}"]`) as any;
const hold = async (host: HTMLElement, title: string) => {
  await act(async () => row(host, title).__press.onLongPress());
  await flush();
};
const called = (calls: Array<[string, unknown]>, method: string) => calls.filter(([m]) => m === method);

test('a long press on a row opens a sheet named by the chat with Pin, Rename and Archive', async () => {
  const v = await mount();
  assert.equal(document.querySelector('[role="dialog"]'), null, 'no sheet before a long press');
  await hold(v.host, 'Fix login');
  const names = [...document.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? b.textContent);
  for (const name of ['Pin', 'Rename', 'Archive']) assert.ok(names.includes(name), `${name} is offered`);
  assert.ok(!names.includes('Unpin'), 'an unpinned chat offers Pin, not Unpin');
  assert.match(document.body.textContent!, /Fix login/);
  assert.equal(row(v.host, 'Fix login').__press.delayLongPress, 350);
  await v.done();
});

test('Pin and Unpin send the chat id and the new state and read the list again', async () => {
  const v = await mount(ALL, { 'chats.pin': { pinned: true } });
  const before = called(v.calls, 'chats.recent').length;
  await hold(v.host, 'Fix login');
  await click('Pin');
  assert.deepEqual(called(v.calls, 'chats.pin')[0][1], { chatId: 'c1', pinned: true });
  assert.ok(called(v.calls, 'chats.recent').length > before, 'the list is read again');
  await hold(v.host, 'Write docs');
  assert.ok(
    [...document.querySelectorAll('button')].some((b) => (b.getAttribute('aria-label') ?? b.textContent) === 'Unpin'),
    'a pinned chat offers Unpin',
  );
  await v.done();
});

test('Rename asks for a name, trims it and sends it; Archive sends the chat id', async () => {
  const v = await mount(ALL, { 'chats.rename': { title: 'Fix the login' }, 'chats.archive': { archived: true } });
  await hold(v.host, 'Fix login');
  await click('Rename');
  assert.ok(document.querySelector('input[placeholder="Chat name"]'), 'the name field shows');
  await inputText('Chat name', '  Fix the login  ');
  await click('Save name');
  assert.deepEqual(called(v.calls, 'chats.rename')[0][1], { chatId: 'c1', title: 'Fix the login' });
  await hold(v.host, 'Write docs');
  await click('Archive');
  assert.deepEqual(called(v.calls, 'chats.archive')[0][1], { chatId: 'c2', archived: true });
  await v.done();
});

test('a refusal is said in the sheet, which stays open', async () => {
  const v = await mount(ALL, { 'chats.archive': new Error('That chat is running') });
  await hold(v.host, 'Fix login');
  await click('Archive');
  assert.match(document.body.textContent!, /That chat is running|could not|Could not/i);
  assert.ok(
    [...document.querySelectorAll('button')].some((b) => (b.getAttribute('aria-label') ?? b.textContent) === 'Archive'),
    'the sheet is still there',
  );
  await v.done();
});

test('only what this Mac can do is offered, and a Mac that can do none says to update it', async () => {
  const some = await mount({ methods: ['chats.pin'], permissionCeiling: 'auto-review' });
  await hold(some.host, 'Fix login');
  const names = [...document.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? b.textContent);
  assert.ok(names.includes('Pin'));
  assert.ok(!names.includes('Rename') && !names.includes('Archive'), 'rename and archive wait for a Mac that has them');
  await some.done();
  const none = await mount({ methods: ['chat.start'], permissionCeiling: 'auto-review' });
  await hold(none.host, 'Fix login');
  assert.match(document.body.textContent!, /Update MoPilot on your computer to pin, rename or archive/);
  await none.done();
});

test('a screen reader reaches the menu as an action on the row, and away from the Mac a row has none', async () => {
  const v = await mount();
  const press = row(v.host, 'Fix login').__press;
  assert.deepEqual(press.accessibilityActions, [{ name: 'chatActions', label: 'Chat actions' }]);
  await act(async () => press.onAccessibilityAction());
  await flush();
  assert.ok([...document.querySelectorAll('button')].some((b) => (b.getAttribute('aria-label') ?? b.textContent) === 'Rename'));
  await v.done();
  const away = await mount(ALL, {}, { ...online, phase: 'offline' });
  const held = row(away.host, 'Fix login');
  if (held) {
    assert.equal(held.__press.onLongPress, undefined, 'the list is the last one read: nothing to act on');
    assert.equal(held.__press.accessibilityActions, undefined);
  }
  await away.done();
});

const labels = () => [...document.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? b.textContent);

test('a Mac that sends no list of its methods is asked for Pin; one that cannot be asked offers nothing', async () => {
  const unknown = await mount({ permissionCeiling: 'auto-review' });
  await hold(unknown.host, 'Fix login');
  assert.ok(labels().includes('Pin'), 'an older Mac that names no methods is tried');
  assert.ok(!labels().includes('Rename') && !labels().includes('Archive'));
  await unknown.done();
  const silent = await mount(ALL, { 'machine.hello': new Error('no') });
  await hold(silent.host, 'Fix login');
  assert.match(document.body.textContent!, /Update MoPilot on your computer to pin, rename or archive/);
  await silent.done();
});

test('Back leaves the rename field for the actions, and a chat with no title is named so', async () => {
  const v = await mount();
  await hold(v.host, 'Fix login');
  await click('Rename');
  await click('Back');
  assert.ok(labels().includes('Archive'), 'back to the actions');
  await hold(v.host, 'Untitled chat');
  assert.match(document.body.textContent!, /Untitled chat/);
  await v.done();
});

test('the sheet is drawn over the screen, outside the scroll content, so a long press far from the end of a long list shows it', async () => {
  const v = await mount();
  await hold(v.host, 'Fix login');
  const scroll = v.host.querySelector('button[aria-label="Pull to refresh"]')!.parentElement!;
  const dismiss = document.querySelector('button[aria-label="Dismiss"]');
  assert.ok(dismiss, 'the sheet is open');
  assert.equal(scroll.contains(dismiss), false, 'it is not at the end of the list inside the scroll view');
  await v.done();
});

test('a list drawn alone, with no page around it, draws its own sheet in place', async () => {
  const s = scripted((method) => (method === 'machine.hello' ? { capabilities: ALL } : undefined), online);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(ChatList, { chats, failed: false, busy: false, open: () => {}, rowMenu: { runtime: s.runtime, changed: () => {} } }),
    ),
  );
  await flush();
  await hold(host, 'Fix login');
  assert.ok(host.querySelector('button[aria-label="Dismiss"]'), 'the sheet is in the list’s own tree');
  await act(async () => root.unmount());
  host.remove();
});
