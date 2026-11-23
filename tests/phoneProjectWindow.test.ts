// By project, each project shows its first 10 chats and the rest behind "Show N more" (the owner's rule), by the Mac's sidebar rule (src/components/sidebar/chatWindow.ts: a hidden chat that would be alone is shown, Show less once all are shown) with the phone's sizes: one project cannot fill the whole list.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { chatWindow as macWindow } from '../src/components/sidebar/chatWindow.ts';
import { useState } from 'react';
import { act, click, createElement, createRoot, flush, inputText } from './support/phone/component-kit';
import { BY_PROJECT, BY_STATE } from './support/phone/home-layout';
import { scripted } from './support/phone/m3';

const windowPath = '../mobile/src/presentation/chatWindow';
const listPath = '../mobile/src/screens/ChatList';
const foldsPath = '../mobile/src/useHomeFolds';
const appPath = '../mobile/src/MobileApp';
const { chatWindow, PROJECT_FIRST, PROJECT_STEP } = await import(windowPath);
const { ChatList } = await import(listPath);
const { useHomeFolds } = await import(foldsPath);
const { MobileApp } = await import(appPath);

afterEach(() => document.body.replaceChildren());

const rows = (n: number) => Array.from({ length: n }, (_, i) => i);
const NOW = Date.now();
/** `n` idle chats of one project, newest first, as the Mac lists them. */
const project = (name: string, n: number, extra: Record<string, unknown> = {}) =>
  Array.from({ length: n }, (_, i) => ({
    id: `${name}${i}`,
    title: `${name} chat ${i}`,
    state: 'idle',
    at: NOW - i * 1000,
    project: name,
    projectId: `p-${name}`,
    ...extra,
  }));

test('the owner’s sizes: ten chats, then ten more at a time', () => {
  assert.equal(PROJECT_FIRST, 10);
  assert.equal(PROJECT_STEP, 10);
});

test('a project with ten chats or fewer has no row, and one chat is never folded away alone', () => {
  for (const n of [0, 1, 9, 10, 11]) {
    const w = chatWindow(rows(n), 10, 10, 0);
    assert.equal(w.visible.length, n, `${n} chats are all shown`);
    assert.equal(w.foot, null);
  }
  const twelve = chatWindow(rows(12), 10, 10, 0);
  assert.equal(twelve.visible.length, 10);
  assert.deepEqual(twelve.foot, { kind: 'more', count: 2 });
});

test('Show more reveals ten at a time, the last page takes what is left, and Show less folds back once all are shown', () => {
  const view = (n: number, revealed: number) => {
    const w = chatWindow(rows(n), 10, 10, revealed);
    return { shown: w.visible.length, foot: w.foot, more: w.more };
  };
  assert.deepEqual(view(35, 0), { shown: 10, foot: { kind: 'more', count: 10 }, more: 10 });
  assert.deepEqual(view(35, 10), { shown: 20, foot: { kind: 'more', count: 10 }, more: 20 });
  assert.deepEqual(view(35, 20), { shown: 30, foot: { kind: 'more', count: 5 }, more: 25 });
  assert.deepEqual(view(35, 25), { shown: 35, foot: { kind: 'less' }, more: 25 });
  // a page that would leave one behind takes it too
  assert.deepEqual(view(21, 0), { shown: 10, foot: { kind: 'more', count: 11 }, more: 11 });
});

test('the rule is the Mac’s: at the Mac’s sizes the two windows agree for every list length and reveal', () => {
  for (let total = 0; total <= 40; total += 1)
    for (let revealed = 0; revealed <= 40; revealed += 1) {
      const mac = macWindow(rows(total), 5, revealed, (r: number) => r < 0);
      const phone = chatWindow(rows(total), 5, 5, revealed);
      assert.deepEqual([phone.visible, phone.foot, phone.more], [mac.visible, mac.foot, mac.more], `${total} chats, ${revealed} revealed`);
    }
});

async function mountList(node: any) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  await flush();
  return { host, text: () => host.textContent ?? '', done: async () => (await act(async () => root.unmount()), host.remove()) };
}
const count = (host: HTMLElement, project: string) => host.querySelectorAll(`button[aria-label^="Open chat ${project} chat"]`).length;
const foot = (host: HTMLElement, label: string) => host.querySelector(`button[aria-label="${label}"]`) as HTMLElement | null;
const ProjectList = (props: Record<string, unknown>) => {
  const folds = useHomeFolds();
  return createElement(ChatList, { failed: false, busy: false, open: () => {}, ...props, folds: { ...folds, layout: 'project' } });
};

test('a project of 25 chats shows 10 with “Show 10 more”, reveals them step by step, and folds back with “Show less”; another project is untouched', async () => {
  const chats = [...project('Big', 25), ...project('Small', 4)];
  const v = await mountList(createElement(ProjectList, { chats }));
  assert.equal(count(v.host, 'Big'), 10, 'a project shows ten chats');
  assert.equal(count(v.host, 'Small'), 4, 'a small project shows all it has and no row');
  assert.equal(v.host.querySelectorAll('button[aria-label^="Show "]').length, 1, 'one project has a row');
  assert.match(foot(v.host, 'Show 10 more in Big')!.textContent!, /^Show 10 more$/, 'the row says how many it reveals');
  await click('Show 10 more in Big');
  assert.equal(count(v.host, 'Big'), 20);
  assert.ok(foot(v.host, 'Show 5 more in Big'), 'the last page is the five left');
  await click('Show 5 more in Big');
  assert.equal(count(v.host, 'Big'), 25, 'all of them');
  assert.equal(foot(v.host, 'Show less in Big')!.textContent, 'Show less');
  await click('Show less in Big');
  assert.equal(count(v.host, 'Big'), 10, 'folded back to ten');
  assert.equal(count(v.host, 'Small'), 4);
  await v.done();
});

test('a chat that needs input is in Needs input on top and never behind “Show more”; the project counts only the rest', async () => {
  const chats = [
    { ...project('Big', 1)[0], id: 'wait', title: 'Big chat waiting', state: 'waiting', at: NOW + 1000 },
    ...project('Big', 12)
      .slice(1)
      .map((c) => ({ ...c, id: `${c.id}x` })),
  ];
  const v = await mountList(createElement(ProjectList, { chats }));
  const labels = [...v.host.querySelectorAll('button[aria-label^="Open chat"]')].map((b) => b.getAttribute('aria-label'));
  assert.equal(labels[0], 'Open chat Big chat waiting', 'the waiting chat is first, under Needs input');
  assert.equal(
    labels.filter((l) => l!.startsWith('Open chat Big chat')).length,
    12,
    'the waiting chat and all eleven others: one chat is not folded away alone',
  );
  assert.ok(foot(v.host, 'Show 1 more in Big') === null, 'one hidden chat is shown, not named in a row');
  await v.done();
  const many = [
    ...chats,
    ...project('Big', 15)
      .slice(12)
      .map((c) => ({ ...c, id: `${c.id}y` })),
  ];
  const w = await mountList(createElement(ProjectList, { chats: many }));
  assert.equal(count(w.host, 'Big'), 11, 'the waiting chat and ten more');
  assert.ok(foot(w.host, 'Show 4 more in Big'), 'fourteen idle chats, ten shown: only the idle ones are counted as hidden');
  await w.done();
});

test('what a project has revealed is kept while the home is held by the app, and a project is revealed on its own', async () => {
  const chats = [...project('Big', 25), ...project('Other', 25)];
  let setShown: (v: boolean) => void = () => {};
  const Held = () => {
    const folds = useHomeFolds();
    const [shown, set] = useState(true);
    setShown = set;
    return shown
      ? createElement(ChatList, { chats, failed: false, busy: false, open: () => {}, folds: { ...folds, layout: 'project' } })
      : createElement('p', null, 'away');
  };
  const v = await mountList(createElement(Held));
  await click('Show 10 more in Big');
  assert.equal(count(v.host, 'Big'), 20);
  assert.equal(count(v.host, 'Other'), 10, 'another project is not revealed with it');
  await act(async () => setShown(false));
  await act(async () => setShown(true));
  assert.equal(count(v.host, 'Big'), 20, 'back from a chat the project is as it was left');
  await v.done();
});

test('a search shows every match, and the by-state view has no windows', async () => {
  const chats = project('Big', 25);
  const found = await mountList(createElement(ProjectList, { chats }));
  assert.equal(count(found.host, 'Big'), 10);
  await found.done();
  const s = scripted((m) => (m === 'chats.recent' ? { chats } : undefined), {
    phase: 'online',
    generation: 1,
    user: { id: 'u', name: 'Dana' },
    pairs: [{ pairId: 'p', macId: 'm', name: 'Studio Mac' }],
    selectedPair: 'p',
    error: null,
  });
  s.runtime.start = async () => {};
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(MobileApp, { runtime: s.runtime, homeLayout: BY_PROJECT })));
  await flush();
  assert.equal(count(host, 'Big'), 10);
  await click('Search chats');
  await inputText('Search chats', 'chat');
  assert.equal(count(host, 'Big'), 25, 'a search lists every match');
  assert.equal(host.querySelectorAll('button[aria-label^="Show "]').length, 0, 'and has no row');
  await act(async () => root.unmount());
  host.remove();
  const state = scripted((m) => (m === 'chats.recent' ? { chats } : undefined), {
    phase: 'online',
    generation: 1,
    user: { id: 'u', name: 'Dana' },
    pairs: [{ pairId: 'p', macId: 'm', name: 'Studio Mac' }],
    selectedPair: 'p',
    error: null,
  });
  state.runtime.start = async () => {};
  const h2 = document.createElement('div');
  document.body.append(h2);
  const r2 = createRoot(h2);
  await act(async () => r2.render(createElement(MobileApp, { runtime: state.runtime, homeLayout: BY_STATE })));
  await flush();
  assert.equal(count(h2, 'Big'), 25, 'by state the list is one flat list');
  await act(async () => r2.unmount());
});
