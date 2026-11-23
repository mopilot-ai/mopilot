// The key button beside the address bar (src/components/panels/BrowserLoginKey.tsx): shown only when the page's site has saved logins,
// fills the one picked into the page through main, says why a fill failed, and offers the user's own Chrome.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import * as React from 'react';
import { mockSource, popoverStubs, stubStore } from './support/stubs.ts';
import { installNativeStub } from './support/ports/native.ts';

const { act, createElement } = React;
const f: any = { calls: [] as any[][], handlers: {} as Record<string, (...a: any[]) => any>, progress: new Set<() => void>() };
const call =
  (name: string) =>
  (...a: any[]) => (f.calls.push([name, ...a]), f.handlers[name](...a));
installNativeStub({
  browser: {
    logins: call('logins'),
    fillLogin: call('fillLogin'),
    import: { onProgress: (cb: () => void) => (f.progress.add(cb), () => f.progress.delete(cb)) },
  },
});
stubStore({ toast: (...a: unknown[]) => f.calls.push(['toast', ...a]) });
mockSource('src/components/ui/Popover.tsx', popoverStubs({ item: 'div' }));
const { createRoot } = await import('react-dom/client');
const { BrowserLoginKey, LOGINS_CHANGED } = await import('../src/components/panels/BrowserLoginKey.tsx');

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLElement;
async function render(el: React.ReactElement) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(el));
}
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  container?.remove();
  f.calls = [];
  f.progress.clear();
});
const click = (el: Element) => act(async () => void el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }) as any));
const key = () => container.querySelector('button[aria-label="Saved logins"]') as HTMLButtonElement | null;
const items = () => [...container.querySelectorAll('[role=menuitem]')];

test('no saved login for the site: no button; an import or a saved password that changes them updates it', async () => {
  let list: any[] = [];
  f.handlers.logins = async () => list;
  await render(createElement(BrowserLoginKey, { url: 'https://a.test/login', pageId: () => 7 }));
  assert.equal(key(), null);
  assert.deepEqual(f.calls[0], ['logins', 'https://a.test/login']);
  list = [{ id: 'l1', username: 'me' }];
  await act(async () => f.progress.forEach((cb: () => void) => cb()));
  assert.ok(key());
  // a password saved from the page's bar refreshes it too
  list = [];
  await act(async () => void window.dispatchEvent(new window.Event(LOGINS_CHANGED) as any));
  assert.equal(key(), null);
});

test('picking a login fills it into this page; failures say why; a cancel says nothing; Chrome is the last entry', async () => {
  f.handlers.logins = async () => [
    { id: 'l1', username: 'me' },
    { id: 'l2', username: '' },
  ];
  const status: any = { value: 'filled' };
  f.handlers.fillLogin = async () => status.value;
  const chrome: string[] = [];
  let page: number | null = 7;
  await render(createElement(BrowserLoginKey, { url: 'https://a.test/login', pageId: () => page, onChrome: () => chrome.push('chrome') }));
  await click(key()!);
  assert.equal(key()!.getAttribute('aria-expanded'), 'true');
  assert.deepEqual(
    items().map((i) => i.textContent),
    ['me', '(no user name)', 'Continue in Chrome'],
  );
  await click(items()[0]);
  assert.deepEqual(
    f.calls.find((c: any[]) => c[0] === 'fillLogin'),
    ['fillLogin', 7, 'l1'],
  );
  assert.equal(f.calls.filter((c: any[]) => c[0] === 'toast').length, 0);
  for (const [s, text] of [
    ['no_fields', /No sign-in field/],
    ['not_found', /no longer saved/],
    ['origin_changed', /page changed.*Try again/],
    ['failed', /Couldn't fill/],
  ] as const) {
    status.value = s;
    await click(key()!);
    await click(items()[1]);
    assert.match(f.calls.at(-1)[1], text);
    assert.equal(f.calls.at(-1)[2], 'error');
  }
  const toasts = f.calls.filter((c: any[]) => c[0] === 'toast').length;
  status.value = 'cancelled';
  await click(key()!);
  await click(items()[0]);
  assert.equal(f.calls.filter((c: any[]) => c[0] === 'toast').length, toasts, 'a declined Touch ID needs no message');
  // a fill that fails to reach main reads as a failure
  f.handlers.fillLogin = async () => {
    throw new Error('main is busy');
  };
  await click(key()!);
  await click(items()[0]);
  assert.match(f.calls.at(-1)[1], /Couldn't fill/);
  // a page with no id yet
  page = null;
  await click(key()!);
  await click(items()[0]);
  assert.match(f.calls.at(-1)[1], /isn't ready yet/);
  await click(key()!);
  await click(items()[2]);
  assert.deepEqual(chrome, ['chrome']);
});

test('without a chat there is no Chrome entry; a late answer for an old address is ignored; a failed read shows nothing', async () => {
  let late: (v: any[]) => void = () => {};
  f.handlers.logins = (url: string) =>
    url.includes('slow') ? new Promise((r) => (late = r)) : Promise.resolve([{ id: 'l1', username: 'me' }]);
  await render(createElement(BrowserLoginKey, { url: 'https://slow.test/', pageId: () => 1 }));
  await act(async () => root!.render(createElement(BrowserLoginKey, { url: 'https://a.test/', pageId: () => 1 })));
  await act(async () => late([]));
  assert.ok(key(), 'the newer answer stands');
  await click(key()!);
  assert.deepEqual(
    items().map((i) => i.textContent),
    ['me'],
  );
  f.handlers.logins = async () => {
    throw new Error('main is busy');
  };
  await act(async () => root!.render(createElement(BrowserLoginKey, { url: 'https://b.test/', pageId: () => 1 })));
});
