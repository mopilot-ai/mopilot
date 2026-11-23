// A tapped "MoMo needs you" push opens MoMo: at the card it named while that card is up, at the end of the chat when the card was answered or is gone (no error), and as before for a push without a card.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush } from './support/phone/component-kit';
import { momoRuntime, mountMomo, snapshotOf } from './support/phone/momo-kit';

const payloadPath = '../mobile/src/push/payload';
const routePath = '../mobile/src/push/route';
const refPath = '../mobile/src/push/chatRef';
const appPath = '../mobile/src/MobileApp';
const { parsePushPayload } = await import(payloadPath);
const { locateTarget } = await import(routePath);
const { chatRef } = await import(refPath);
const { MobileApp } = await import(appPath);

const CARD = (id: string) => ({ id, rev: 1, title: `Card ${id}`, choices: [{ key: 'ok', label: 'OK' }] });
const handlers = (cards = [CARD('k1'), CARD('k2')]) => ({
  'machine.hello': () => ({ v: 1, capabilities: { momo: true, methods: [] } }),
  'momo.brain.get': () => ({ brain: null }),
  'momo.routines.list': () => ({ proposals: [], routines: [] }),
  'momo.sources.status': () => ({ calendar: true, reminders: true }),
  'momo.chat.follow': () => snapshotOf(cards),
  'momo.chat.unfollow': () => ({}),
  'chats.recent': () => ({ chats: [] }),
});
const scrolls = () => ({
  to: ((globalThis as any).__scrolledTo ?? []) as any[],
  end: ((globalThis as any).__scrolledToEnd ?? []) as any[],
});
const resetScrolls = () => {
  delete (globalThis as any).__scrolledTo;
  delete (globalThis as any).__scrolledToEnd;
};
/** Calls onLayout on each card's view as React Native would, the n-th card at 100 + 300·n. */
async function layOutCards(host: HTMLElement) {
  const placed = [...host.querySelectorAll('div')].filter((d) => {
    const key = Object.keys(d).find((k) => k.startsWith('__reactProps'));
    return key && typeof (d as any)[key].onLayout === 'function';
  });
  for (const [i, el] of placed.entries()) {
    const props = (el as any)[Object.keys(el).find((k) => k.startsWith('__reactProps'))!];
    await act(async () => props.onLayout({ nativeEvent: { layout: { x: 0, y: 100 + 300 * i, width: 300, height: 80 } } }));
  }
}

test('the push names its card only on a MoMo needs-you push, bounded like the ref', () => {
  assert.equal(parsePushPayload({ kind: 'momoNeedsYou', ref: 'r', card: 'c1' }).card, 'c1');
  assert.equal(parsePushPayload({ kind: 'needsYou', ref: 'r', card: 'c1' }).card, undefined);
  assert.equal(parsePushPayload({ kind: 'momoNeedsYou', ref: 'r', card: 'x'.repeat(129) }).card, undefined);
  assert.equal('card' in parsePushPayload({ kind: 'momoNeedsYou', ref: 'r' }), false);
});

test('a MoMo push opens MoMo, with its card, on the computer whose chat it names, else on the first paired one', async () => {
  const pairs = ['p1', 'p2'];
  const lists: Record<string, string[]> = { p1: ['a'], p2: ['momo-main'] };
  const loc = { pairs, chatIds: async (p: string) => lists[p], current: () => true };
  const ref = chatRef('p2', 'momo-main');
  assert.deepEqual(await locateTarget({ kind: 'momoNeedsYou', ref, count: 1, card: 'c' }, loc), { pairId: 'p2', momo: { card: 'c' } });
  // MoMo's main chat is not in the chat list: the first paired computer
  assert.deepEqual(await locateTarget({ kind: 'momoNeedsYou', ref: 'nowhere', count: 1 }, loc), { pairId: 'p1', momo: {} });
  assert.equal(await locateTarget({ kind: 'momoNeedsYou', ref: 'nowhere', count: 1 }, { ...loc, pairs: [] }), null);
  // a chat push still opens its chat
  assert.deepEqual(await locateTarget({ kind: 'needsYou', ref: chatRef('p1', 'a'), count: 1 }, loc), { pairId: 'p1', chatId: 'a' });
});

test('the card a push named is scrolled to once it is laid out, also when it was laid out before the chat was read', async () => {
  resetScrolls();
  const m = momoRuntime(handlers());
  const view = await mountMomo(m);
  await flush();
  await layOutCards(view.host);
  // the chat is read and laid out when the tap arrives: the named card (the second) is scrolled to at once
  await view.setProps({ focus: { card: chatRef('p', 'k2'), tap: 1 } });
  assert.deepEqual(scrolls().to.at(-1), { y: 400, animated: true });
  // the same tap is not handled twice
  await view.setProps({ focus: { card: chatRef('p', 'k2'), tap: 1 } });
  assert.equal(scrolls().to.length, 1);
  await view.unmount();

  resetScrolls();
  const later = momoRuntime(handlers());
  const second = await mountMomo(later, undefined, { focus: { card: chatRef('p', 'k2'), tap: 2 } });
  await flush();
  assert.equal(scrolls().to.length, 0, 'not laid out yet: nowhere to go');
  await layOutCards(second.host);
  assert.deepEqual(scrolls().to.at(-1), { y: 400, animated: true });
  assert.equal(scrolls().end.length, 0);
  await second.unmount();
});

test('a card that was answered or is gone opens the end of the chat with no error; a push without a card does the same', async () => {
  for (const card of [chatRef('p', 'answered'), null]) {
    resetScrolls();
    const m = momoRuntime(handlers());
    const view = await mountMomo(m, undefined, { focus: { card, tap: 3 } });
    await flush();
    assert.equal(scrolls().end.length, 1);
    assert.equal(scrolls().to.length, 0);
    assert.doesNotMatch(view.text(), /error|couldn|not found/i);
    await view.unmount();
  }
});

test('a tapped MoMo push opens MoMo from anywhere in the app, and each tap is handled once', async () => {
  resetScrolls();
  let ui: any = { step: 'granted', busy: false, target: null, prefs: {}, notice: null, token: null };
  const listeners = new Set<() => void>();
  let consumed = 0;
  const push: any = {
    ui: () => ui,
    subscribe: (f: () => void) => (listeners.add(f), () => listeners.delete(f)),
    start: async () => {},
    stop: () => {},
    consumeTarget: () => {
      consumed++;
      ui = { ...ui, target: null };
    },
    setOpenChat: () => {},
    signOut: async () => {},
  };
  const m = momoRuntime(handlers([CARD('k1')]));
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(MobileApp, { runtime: m.runtime, push, momo: { cache: Promise.resolve(null) } })));
  await flush();
  assert.equal(document.querySelector('input[placeholder="Ask MoMo anything"]'), null);
  ui = { ...ui, target: { pairId: 'p', momo: { card: chatRef('p', 'gone') } } };
  await act(async () => listeners.forEach((f) => f()));
  await flush();
  assert.ok(document.querySelector('input[placeholder="Ask MoMo anything"]'), 'MoMo is open');
  assert.equal(consumed, 1);
  assert.equal(scrolls().end.length, 1, 'the card is gone: the end of the chat');
  await act(async () => root.unmount());
  host.remove();
});

test('a tapped chat push opens that chat even while MoMo is open', async () => {
  let ui: any = { step: 'granted', busy: false, target: null, prefs: {}, notice: null, token: null };
  const listeners = new Set<() => void>();
  const push: any = {
    ui: () => ui,
    subscribe: (f: () => void) => (listeners.add(f), () => listeners.delete(f)),
    start: async () => {},
    stop: () => {},
    consumeTarget: () => {
      ui = { ...ui, target: null };
    },
    setOpenChat: () => {},
    signOut: async () => {},
  };
  const m = momoRuntime({ ...handlers([CARD('k1')]), 'chat.follow': () => ({}) });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(MobileApp, { runtime: m.runtime, push, momo: { cache: Promise.resolve(null) } })));
  await flush();
  ui = { ...ui, target: { pairId: 'p', momo: {} } };
  await act(async () => listeners.forEach((f) => f()));
  await flush();
  assert.ok(document.querySelector('input[placeholder="Ask MoMo anything"]'), 'MoMo is open');
  ui = { ...ui, target: { pairId: 'p', chatId: 'c1' } };
  await act(async () => listeners.forEach((f) => f()));
  await flush();
  assert.equal(document.querySelector('input[placeholder="Ask MoMo anything"]'), null, 'MoMo gave way to the chat');
  await act(async () => root.unmount());
  host.remove();
});

test('a MoMo push on an app without MoMo wired opens nothing and is consumed', async () => {
  resetScrolls();
  let ui: any = { step: 'granted', busy: false, target: null, prefs: {}, notice: null, token: null };
  const listeners = new Set<() => void>();
  let consumed = 0;
  const push: any = {
    ui: () => ui,
    subscribe: (f: () => void) => (listeners.add(f), () => listeners.delete(f)),
    start: async () => {},
    stop: () => {},
    consumeTarget: () => {
      consumed++;
      ui = { ...ui, target: null };
    },
    setOpenChat: () => {},
    signOut: async () => {},
  };
  const m = momoRuntime(handlers([CARD('k1')]));
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(MobileApp, { runtime: m.runtime, push })));
  await flush();
  ui = { ...ui, target: { pairId: 'p', momo: { card: chatRef('p', 'k1') } } };
  await act(async () => listeners.forEach((f) => f()));
  await flush();
  assert.equal(document.querySelector('input[placeholder="Ask MoMo anything"]'), null);
  assert.equal(consumed, 1);
  assert.equal(scrolls().end.length + scrolls().to.length, 0);
  await act(async () => root.unmount());
  host.remove();
});

test('a tapped MoMo push without a card opens MoMo at the end of the chat from the app', async () => {
  resetScrolls();
  let ui: any = { step: 'granted', busy: false, target: null, prefs: {}, notice: null, token: null };
  const listeners = new Set<() => void>();
  const push: any = {
    ui: () => ui,
    subscribe: (f: () => void) => (listeners.add(f), () => listeners.delete(f)),
    start: async () => {},
    stop: () => {},
    consumeTarget: () => {
      ui = { ...ui, target: null };
    },
    setOpenChat: () => {},
    signOut: async () => {},
  };
  const m = momoRuntime(handlers([CARD('k1')]));
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(MobileApp, { runtime: m.runtime, push, momo: { cache: Promise.resolve(null) } })));
  await flush();
  // no card named: the target carries an empty `momo`
  ui = { ...ui, target: { pairId: 'p', momo: {} } };
  await act(async () => listeners.forEach((f) => f()));
  await flush();
  assert.ok(document.querySelector('input[placeholder="Ask MoMo anything"]'), 'MoMo is open');
  assert.equal(scrolls().end.length, 1);
  assert.equal(scrolls().to.length, 0);
  await act(async () => root.unmount());
  host.remove();
});
