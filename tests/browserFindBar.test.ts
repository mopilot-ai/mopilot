// The browser pane's find bar (browserPanel/FindBar.tsx): ⌘F opens it on the page, typing finds through the page's
// findInPage, the count follows the current term's results only, ⌘G / ⇧⌘G and Enter / ⇧Enter step, Esc and a new
// document close it, and a page that can't find says so; ViewHandle and main's view carry the same calls.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { act, createElement, useRef } from 'react';
import { render, typeInto } from './support/shell-panels-kit.ts';
import { ViewHandle } from '../src/lib/browserView.ts';
import { installNativeStub } from './support/ports/native.ts';
installNativeStub({ browser: { onShortcut: () => () => {} } });
const toasts: string[] = [];
mock.module('../src/store/core.ts', {
  namedExports: {
    toast: (text: string) => toasts.push(text),
    useStore: (pick: (s: any) => unknown) => pick({ prefs: { keybindings: bindings } }),
  },
});
let bindings: Record<string, string | null> = {};
const { FindBar, usePageFind, findActionFor } = await import('../src/components/panels/browserPanel/FindBar.tsx');

/** A page as the pane holds it: a <webview>'s find calls and events. */
class FakePage {
  finds: [string, { forward: boolean; findNext: boolean }][] = [];
  stops = 0;
  next = 1;
  answer: (id: number) => number | Promise<number> = (id) => id;
  private fns = new Map<string, Set<(e: Event) => void>>();
  addEventListener(type: string, fn: (e: Event) => void) {
    this.fns.set(type, (this.fns.get(type) ?? new Set()).add(fn));
  }
  removeEventListener(type: string, fn: (e: Event) => void) {
    this.fns.get(type)?.delete(fn);
  }
  listeners(type: string) {
    return this.fns.get(type)?.size ?? 0;
  }
  fire(type: string, detail: Record<string, unknown> = {}) {
    for (const fn of [...(this.fns.get(type) ?? [])]) fn(Object.assign(new Event(type), detail));
  }
  findInPage(text: string, options: { forward: boolean; findNext: boolean }) {
    this.finds.push([text, options]);
    return this.answer(this.next++);
  }
  stopFindInPage() {
    this.stops++;
  }
}

let api: ReturnType<typeof usePageFind>;
function Pane({ page, pageKey = 1 }: { page: unknown; pageKey?: unknown }) {
  const ref = useRef<any>(null);
  ref.current = page;
  api = usePageFind(ref, pageKey);
  return createElement(FindBar, { find: api });
}
const field = (host: HTMLElement) => host.querySelector('.browser-find input') as HTMLInputElement | null;
const count = (host: HTMLElement) => host.querySelector('.chat-find-count')?.textContent;
const key = (el: Element, init: KeyboardEventInit) =>
  act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  });
const command = (a: 'open' | 'next' | 'previous') => act(async () => api.command(a));
const found = (page: FakePage, requestId: number, active: number, total: number) =>
  act(async () => page.fire('found-in-page', { result: { requestId, activeMatchOrdinal: active, matches: total, finalUpdate: true } }));

test('⌘F opens the bar focused; typing finds anew, the count is the latest term’s, and stepping goes both ways', async () => {
  const page = new FakePage();
  const r = await render(createElement(Pane, { page }));
  assert.equal(field(r.host), null, 'closed until asked');
  await command('open');
  const input = field(r.host)!;
  assert.equal(document.activeElement, input);
  await act(async () => typeInto(input, 'ca'));
  await act(async () => typeInto(input, 'cat'));
  assert.deepEqual(page.finds, [
    ['ca', { forward: true, findNext: true }],
    ['cat', { forward: true, findNext: true }],
  ]);
  await act(async () => new Promise((res) => setImmediate(res)));
  // the earlier term's late result is stale; the current term's counts
  await found(page, 1, 1, 9);
  assert.equal(count(r.host), '');
  await found(page, 2, 1, 3);
  assert.equal(count(r.host), '1 of 3');
  await key(input, { key: 'Enter' });
  await key(input, { key: 'Enter', shiftKey: true });
  await act(async () => (r.host.querySelector('[aria-label="Next match"]') as HTMLButtonElement).click());
  await act(async () => (r.host.querySelector('[aria-label="Previous match"]') as HTMLButtonElement).click());
  assert.deepEqual(
    page.finds.slice(2).map(([, o]) => o),
    [
      { forward: true, findNext: false },
      { forward: false, findNext: false },
      { forward: true, findNext: false },
      { forward: false, findNext: false },
    ],
  );
  await found(page, 4, 2, 0);
  assert.equal(count(r.host), 'No results');
  // composing text is the input method's
  await key(input, { key: 'Enter', isComposing: true });
  assert.equal(page.finds.length, 6);
  // clearing the term ends the find
  await act(async () => typeInto(input, ''));
  assert.equal(page.stops, 1);
  assert.equal(page.finds.length, 6);
  await found(page, 9, 1, 1);
  assert.equal(count(r.host), '', 'no term, no count');
  await key(input, { key: 'Enter' });
  assert.equal(page.finds.length, 6, 'nothing to step through');
  await r.unmount();
});

test('the pane’s find keys work in the field (⌘G, ⇧⌘G, ⌘F, a rebinding); Esc closes, and ⌘F finds the term again', async () => {
  const page = new FakePage();
  const r = await render(createElement(Pane, { page }));
  await command('open');
  const input = field(r.host)!;
  await act(async () => typeInto(input, 'dog'));
  const g = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'g', code: 'KeyG', metaKey: true });
  await act(async () => void input.dispatchEvent(g));
  assert.equal(g.defaultPrevented, true, 'the app’s own keys never see it');
  await key(input, { key: 'G', code: 'KeyG', metaKey: true, shiftKey: true });
  assert.deepEqual(
    page.finds.map(([t, o]) => [t, o.forward, o.findNext]),
    [
      ['dog', true, true],
      ['dog', true, false],
      ['dog', false, false],
    ],
  );
  input.blur();
  await key(input, { key: 'f', code: 'KeyF', metaKey: true });
  assert.equal(document.activeElement, input, '⌘F in the field selects the term again');
  bindings = { 'browser-find-next': '⌥⌘N' };
  await r.rerender(createElement(Pane, { page }));
  await key(input, { key: 'n', code: 'KeyN', metaKey: true, altKey: true });
  assert.equal(page.finds.length, 4);
  bindings = {};
  await r.rerender(createElement(Pane, { page }));
  const esc = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' });
  await act(async () => void input.dispatchEvent(esc));
  assert.equal(esc.defaultPrevented, true, 'Esc closes the bar, not the side pane');
  assert.equal(field(r.host), null);
  assert.equal(page.stops, 1);
  assert.equal(page.listeners('found-in-page'), 0, 'a closed bar hears no results');
  // the term stays: ⌘F (or ⌘G while closed) opens with it and finds it at once
  await command('next');
  assert.equal(field(r.host)?.value, 'dog');
  assert.deepEqual(page.finds.at(-1), ['dog', { forward: true, findNext: true }]);
  await command('open');
  assert.equal(page.finds.length, 5, 'open while open only focuses');
  await act(async () => (r.host.querySelector('[aria-label="Close find bar"]') as HTMLButtonElement).click());
  assert.equal(field(r.host), null);
  await act(async () => api.close());
  assert.equal(page.stops, 2, 'closing a closed bar ends nothing');
  await r.unmount();
});

test('a new document or a new page closes the bar; a page that can’t find says so, a tab with no page does nothing', async () => {
  const page = new FakePage();
  const r = await render(createElement(Pane, { page }));
  await command('open');
  await act(async () => typeInto(field(r.host)!, 'x'));
  await act(async () => page.fire('did-navigate'));
  assert.equal(field(r.host), null, 'Chromium’s find ended with the document');
  await command('open');
  await act(async () => typeInto(field(r.host)!, 'xy'));
  await act(async () => new Promise((res) => setImmediate(res)));
  const fresh = new FakePage();
  await r.rerender(createElement(Pane, { page: fresh, pageKey: 2 }));
  assert.equal(field(r.host), null, 'a recreated page starts closed');
  // its requests are numbered from 1 again: their results still count
  await command('open');
  await act(async () => new Promise((res) => setImmediate(res)));
  await found(fresh, 1, 1, 4);
  assert.equal(count(r.host), '1 of 4');
  await act(async () => api.close());
  await command('previous');
  assert.ok(field(r.host), 'previous while closed opens');
  await r.unmount();

  const none = await render(createElement(Pane, { page: null }));
  await command('open');
  assert.equal(field(none.host), null);
  assert.deepEqual(toasts, []);
  await none.unmount();

  const remote = await render(createElement(Pane, { page: { addEventListener() {}, removeEventListener() {} } }));
  await command('open');
  assert.equal(field(remote.host), null);
  assert.deepEqual(toasts, ["Find isn't available on this page"]);
  await remote.unmount();

  // a find that throws, or that main refuses, is a toast; a refusal for a page that went is not
  for (const answer of [
    () => {
      throw new Error('gone');
    },
    () => Promise.reject(new Error('refused')),
  ]) {
    toasts.length = 0;
    const bad = new FakePage();
    bad.answer = answer as any;
    const b = await render(createElement(Pane, { page: bad }));
    await command('open');
    await act(async () => typeInto(field(b.host)!, 'q'));
    await act(async () => new Promise((res) => setImmediate(res)));
    assert.deepEqual(toasts, ["Couldn't search this page"]);
    await b.unmount();
  }
  toasts.length = 0;
  const later = new FakePage();
  let reject!: (e: Error) => void;
  later.answer = () => new Promise((_, rej) => (reject = rej));
  const l = await render(createElement(Pane, { page: later }));
  await command('open');
  await act(async () => typeInto(field(l.host)!, 'q'));
  await l.rerender(createElement(Pane, { page: new FakePage() }));
  await act(async () => {
    reject(new Error('gone'));
    await new Promise((res) => setImmediate(res));
  });
  assert.deepEqual(toasts, []);
  // the page went while the bar stayed open: typing says the search failed
  await l.rerender(createElement(Pane, { page: null }));
  toasts.length = 0;
  await act(async () => typeInto(field(l.host)!, 'qq'));
  assert.deepEqual(toasts, ["Couldn't search this page"]);
  // a page whose find can't end any more (it went) is no failure
  const gone = new FakePage();
  gone.stopFindInPage = () => {
    throw new Error('destroyed');
  };
  await l.rerender(createElement(Pane, { page: gone }));
  await act(async () => api.close());
  assert.equal(field(l.host), null);
  await l.unmount();
});

test('a result before main answered with its request id counts while a term is live; field keys follow the bindings', async () => {
  const page = new FakePage();
  page.answer = () => new Promise<number>(() => {});
  const r = await render(createElement(Pane, { page }));
  await command('open');
  await act(async () => page.fire('found-in-page', {}));
  await act(async () => typeInto(field(r.host)!, 'a'));
  await act(async () => page.fire('found-in-page', { result: {} }));
  assert.equal(count(r.host), 'No results');
  await r.unmount();
  const ev = (init: Partial<KeyboardEvent>) => ({
    key: '',
    code: '',
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...init,
  });
  assert.equal(findActionFor(ev({ key: 'f', code: 'KeyF', metaKey: true })), 'open');
  assert.equal(findActionFor(ev({ key: 'r', code: 'KeyR', metaKey: true })), null, 'another pane key is not find');
  assert.equal(findActionFor(ev({ key: 'Shift', code: 'ShiftLeft', shiftKey: true })), null);
  assert.equal(findActionFor(ev({ key: 'g', code: 'KeyG', metaKey: true }), { 'browser-find-next': null }), null, 'unbound');
});

test('ViewHandle finds through main and ends the find; main’s view runs it and forwards the results', async () => {
  const sent: unknown[][] = [];
  let fail = false;
  const h = new ViewHandle({
    nav: (...a: unknown[]) => (sent.push(a), fail ? Promise.reject(new Error('gone')) : Promise.resolve(5)),
  } as any);
  h.bound(7, { url: '', title: '', canGoBack: false, canGoForward: false, loading: false, zoom: 1 });
  assert.equal(await h.findInPage('cat', { forward: false, findNext: true }), 5);
  fail = true;
  h.stopFindInPage();
  await new Promise((res) => setImmediate(res));
  assert.deepEqual(sent, [
    [7, 'find', { text: 'cat', forward: false, findNext: true }],
    [7, 'stop-find'],
  ]);
  const results: unknown[] = [];
  h.addEventListener('found-in-page', (e) => results.push((e as any).result));
  h.receive({ id: 7, type: 'found-in-page', state: null, detail: { result: { requestId: 5, matches: 2 } } });
  assert.deepEqual(results, [{ requestId: 5, matches: 2 }]);
});
