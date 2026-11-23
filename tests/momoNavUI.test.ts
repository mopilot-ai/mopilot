// MoMo's navigation in the sidebar column (src/components/momo/MomoNav.tsx), as Muse lists its views beside the chat:
// Chat and Memory with the route's one marked, each opening its view, the earlier main chats a brain change
// replaced (read again whenever a chat becomes one), and Settings › MoMo; setup shows no views yet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement as h, act } from 'react';
import { render, click, fakeStore, flush } from './support/shell-chrome-kit.ts';
import { deferred } from './support/async-scenarios.ts';
import { mockSource, stubStore } from './support/stubs.ts';
import { installNativeStub } from './support/ports/native.ts';

const routes: unknown[] = [];
let done = true;
const store = fakeStore<any>({ momoChats: {} });
let previous: () => Promise<any[]> = async () => [];
let reads = 0;
stubStore({ navigate: (r: unknown) => routes.push(r), useStore: store.useStore });
installNativeStub({ momoChat: { previousChats: () => (reads++, previous()) } });
mockSource('src/session/momoPrefs.ts', { useMomoPrefs: () => ({ onboarding: { done }, persona: { name: 'Pip', color: 'green' } }) });
const { MomoNav } = await import('../src/components/momo/MomoNav.tsx');

const rows = (host: HTMLElement) => [...host.querySelectorAll('.side-row')] as HTMLElement[];
const settle = async () => {
  for (let i = 0; i < 4; i++) await flush();
};

test('Chat, Tasks and Memory, the route’s view marked, each opening its view; Settings opens Settings › MoMo', async () => {
  done = true;
  const r = await render(h(MomoNav, { tab: 'memory' }));
  assert.equal(r.host.querySelector('aside')!.getAttribute('aria-label'), 'MoMo');
  assert.equal(r.host.querySelector('.sidebar-title')!.textContent, 'Pip', 'the name the user gave');
  assert.equal(
    r.host.querySelector<HTMLElement>('.sidebar-title .momo-dot')!.style.borderColor,
    'var(--green)',
    'with its dot in their color',
  );
  assert.deepEqual(
    rows(r.host).map((b) => [b.textContent, b.getAttribute('aria-current')]),
    [
      ['Chat', null],
      ['Tasks', null],
      ['Memory', 'page'],
      ['Settings', null],
    ],
  );
  routes.length = 0;
  for (const b of rows(r.host)) await click(b);
  assert.deepEqual(routes, [
    { name: 'momo', tab: 'chat' },
    { name: 'momo', tab: 'tasks' },
    { name: 'momo', tab: 'memory' },
    { name: 'settings', section: 'momo' },
  ]);
  await r.unmount();
  const chat = await render(h(MomoNav));
  assert.equal(rows(chat.host)[0].getAttribute('aria-current'), 'page', 'Chat by default');
  await chat.unmount();
});

test('during setup: no views to go to yet, only Settings', async () => {
  done = false;
  const r = await render(h(MomoNav, { tab: 'chat' }));
  assert.deepEqual(
    rows(r.host).map((b) => b.textContent),
    ['Settings'],
  );
  assert.equal(r.host.querySelector('.sidebar-title .momo-dot'), null, 'no dot until setup has chosen its color');
  await r.unmount();
  done = true;
});

test('Earlier: MoMo’s earlier main chats by harness and age, each opening read-only in Chat, marked instead of Chat', async () => {
  done = true;
  const now = Date.now();
  previous = async () => [
    { chatId: 'old2', harness: 'opencode', at: now - 2 * 3600_000 },
    { chatId: 'old1', harness: 'Codex', at: now - 3 * 86400_000 },
  ];
  store.reset({ momoChats: { old2: 'previous', old1: 'previous', m1: 'main' } });
  const r = await render(h(MomoNav, { tab: 'chat', chatId: 'old1' }));
  await settle();
  assert.equal(r.host.querySelector('.side-label')!.textContent, 'Earlier');
  assert.deepEqual(
    rows(r.host).map((b) => [b.textContent, b.getAttribute('aria-current')]),
    [
      ['Chat', null],
      ['Tasks', null],
      ['Memory', null],
      ['opencode2h', null],
      ['Codex3d', 'page'],
      ['Settings', null],
    ],
  );
  routes.length = 0;
  await click(rows(r.host)[3]);
  assert.deepEqual(routes, [{ name: 'momo', tab: 'chat', chatId: 'old2' }]);
  // another chat becomes an earlier one (a brain change): the list is read again; the same set is not
  const before = reads;
  await act(async () => store.setState({ momoChats: { old2: 'previous', old1: 'previous', m1: 'main', x: 'work' } }));
  assert.equal(reads, before);
  previous = async () => [{ chatId: 'm1', harness: 'Kimi Code', at: now }];
  await act(async () => store.setState({ momoChats: { old2: 'previous', old1: 'previous', m1: 'previous' } }));
  await settle();
  assert.equal(reads, before + 1);
  assert.deepEqual(
    rows(r.host).map((b) => b.textContent),
    ['Chat', 'Tasks', 'Memory', 'Kimi Codenow', 'Settings'],
  );
  await r.unmount();
});

test('Earlier: none, or not readable (MoMo off), lists nothing; a read that settles after the nav closed changes nothing', async () => {
  done = true;
  store.reset({ momoChats: {} });
  previous = async () => [];
  let r = await render(h(MomoNav, {}));
  await settle();
  assert.equal(r.host.querySelector('.side-label'), null);
  await r.unmount();
  previous = async () => {
    throw new Error('MoMo is not available for this account.');
  };
  r = await render(h(MomoNav, {}));
  await settle();
  assert.equal(r.host.querySelector('.side-label'), null);
  await r.unmount();
  const late = deferred<any[]>();
  previous = () => late.promise;
  r = await render(h(MomoNav, {}));
  await r.unmount();
  await act(async () => late.resolve([{ chatId: 'a', harness: 'Codex', at: Date.now() }]));
});
