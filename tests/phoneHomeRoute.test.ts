// The chats home is not drawn for the app's own comings and goings (#4986): opening a chat, and coming back, drew the home 3 and 2 times (about 50 ms each on the phone) because the root made it new props every render. Its props are the same until something it shows changes, its handlers reach it through stable forwarders, and a read that finds the chat list as it was changes nothing.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, click, createElement, createRoot, flush } from './support/phone/component-kit';
import { scripted } from './support/phone/m3';

const appPath = '../mobile/src/MobileApp';
const logPath = '../mobile/src/perfLog';
const cachePath = '../mobile/src/presentation/threadCache';
const routePath = '../mobile/src/screens/HomeRoute';
const listPath = '../mobile/src/useChatList';
const { MobileApp } = await import(appPath);
const { perf } = await import(logPath);
const { forgetRows } = await import(cachePath);
const { homeActions } = await import(routePath);
const { sameChats } = await import(listPath);

afterEach(() => {
  perf.end();
  document.body.replaceChildren();
  (globalThis as any).__phoneKeepStack = false;
});

const online = {
  phase: 'online',
  generation: 1,
  user: { id: 'u' },
  pairs: [{ pairId: 'p', macId: 'm', name: 'Mac' }],
  selectedPair: 'p',
  safetyNumber: null,
  pendingPair: false,
  error: null,
  presence: {},
  reconnect: null,
};

test('A: opening a chat draws the home once at most, and coming back draws it not at all, while the stack keeps it mounted under the chat', async () => {
  forgetRows();
  // natively the home stays mounted under the chat
  (globalThis as any).__phoneKeepStack = true;
  const s = scripted(
    (m) =>
      m === 'chats.recent'
        ? {
            chats: [
              { id: 'c1', title: 'Build' },
              { id: 'c2', title: 'Other' },
            ],
          }
        : m === 'chat.follow'
          ? { rev: 1, feedSeq: 0, session: { turn: 'idle', cards: [] }, itemsShape: 'rows', items: [{ role: 'user', text: 'hi' }] }
          : undefined,
    online,
  );
  s.runtime.start = async () => {};
  s.runtime.subscribe = () => () => {};
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(MobileApp, { runtime: s.runtime })));
  await flush();
  perf.start();
  await click('Open chat Build');
  for (let i = 0; i < 4; i += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
  const open = perf.report().renders;
  // none is fine: the home is not drawn for the navigation at all when nothing it shows changed
  assert.equal((open.Home ?? 0) <= 1, true, `the home drew ${open.Home} times while a chat opened`);
  assert.equal(open.App >= 1, true, 'the root still renders for the navigation');
  perf.reset();
  await click('Back');
  for (let i = 0; i < 4; i += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
  assert.equal(perf.report().renders.Home ?? 0, 0, 'coming back draws the home no time');
  // the list is there and the rows still open chats
  assert.ok(host.textContent!.includes('Build'));
  await act(async () => root.unmount());
});

test('A: the forwarders are the same functions for good, and each calls the handler the app holds now', () => {
  const calls: string[] = [];
  const handlers = (tag: string) =>
    Object.fromEntries(
      [
        'open',
        'review',
        'machine',
        'showChat',
        'momo',
        'scheduled',
        'settings',
        'computers',
        'createChat',
        'away',
        'pair',
        'signOut',
        'run',
        'refresh',
        'loadMore',
      ].map((name) => [
        name,
        (...args: unknown[]) => (calls.push(`${tag}:${name}:${args.join(',')}`), name === 'run' ? Promise.resolve() : undefined),
      ]),
    );
  const latest: { current: any } = { current: handlers('first') };
  const act = homeActions(latest);
  const keep = { ...act };
  latest.current = handlers('second');
  for (const name of Object.keys(act)) assert.equal((act as any)[name], (keep as any)[name]);
  act.open('c1');
  act.createChat('u');
  void act.run(async () => undefined);
  act.refresh();
  assert.deepEqual(calls, ['second:open:c1', 'second:createChat:u', 'second:run:' + String(calls[2]).split(':')[2], 'second:refresh:']);
});

test('I: a chat list read that finds the same chats in the same order is the list that was', () => {
  const a = [
    { id: 'c1', title: 'A' },
    { id: 'c2', title: 'B', state: 'idle' },
  ];
  assert.equal(
    sameChats(
      a,
      a.map((c) => ({ ...c })),
    ),
    true,
  );
  assert.equal(sameChats(a, [a[0]]), false, 'one fewer');
  assert.equal(sameChats(a, [a[0], { id: 'c2', title: 'B', state: 'working' }]), false, 'one changed');
  assert.equal(sameChats(a, [a[1], a[0]]), false, 'another order');
});
