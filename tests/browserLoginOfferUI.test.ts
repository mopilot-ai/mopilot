// The "Save password?" bar (src/components/panels/BrowserLoginOffer.tsx): shown for main's offer on this page only, its
// answers go back to main (which holds the password), and the in-page dropdown's failed fills become toasts.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import * as React from 'react';
import { stubStore } from './support/stubs.ts';
import { installNativeStub } from './support/ports/native.ts';

const { act, createElement } = React;
const f: any = { calls: [] as any[][], answer: async (): Promise<any> => 'saved', listeners: new Set<(e: any) => void>() };
installNativeStub({
  browser: {
    onLoginAssist: (cb: (e: any) => void) => (f.listeners.add(cb), () => f.listeners.delete(cb)),
    answerLoginOffer: (...a: any[]) => (f.calls.push(['answer', ...a]), f.answer(...a)),
  },
});
stubStore({ toast: (...a: unknown[]) => f.calls.push(['toast', ...a]) });
const { createRoot } = await import('react-dom/client');
const { BrowserLoginOffer } = await import('../src/components/panels/BrowserLoginOffer.tsx');
const { LOGINS_CHANGED } = await import('../src/components/panels/BrowserLoginKey.tsx');

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLElement;
let page: number | null = 7;
async function render() {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(createElement(BrowserLoginOffer, { pageId: () => page })));
}
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  container?.remove();
  f.calls = [];
  f.answer = async () => 'saved';
  page = 7;
});
const emit = (e: any) => act(async () => f.listeners.forEach((cb: (e: any) => void) => cb(e)));
const bar = () => container.querySelector('.browser-login-offer');
const buttons = () => [...container.querySelectorAll('button')];
// the band's pills, without its close (Not now)
const pills = () => [...container.querySelectorAll('.browser-notice-actions button')];
const press = (label: string) =>
  act(
    async () =>
      void buttons()
        .find((b) => b.textContent === label || b.getAttribute('aria-label') === label)!
        .dispatchEvent(new window.MouseEvent('click', { bubbles: true }) as any),
  );
const offer = (extra: any = {}) => ({ pageId: 7, kind: 'offer', offerId: 'o1', host: 'a.test', username: 'ann', update: false, ...extra });
const toasts = () => f.calls.filter((c: any[]) => c[0] === 'toast').map((c: any[]) => c.slice(1));

test('an offer for this page shows the site and user; Save saves through main and refreshes the key button', async () => {
  await render();
  assert.equal(bar(), null);
  // another tab's offer waits for the pane to show that tab
  await emit(offer({ pageId: 8, host: 'b.test' }));
  assert.equal(bar(), null);
  page = 8;
  await act(async () => root!.render(createElement(BrowserLoginOffer, { pageId: () => page })));
  assert.match(bar()!.textContent!, /b\.test/);
  page = null;
  await act(async () => root!.render(createElement(BrowserLoginOffer, { pageId: () => page })));
  assert.equal(bar(), null, 'a pane with no page shows none');
  page = 7;
  await act(async () => root!.render(createElement(BrowserLoginOffer, { pageId: () => page })));
  assert.equal(bar(), null);
  await emit(offer());
  assert.equal(bar()!.getAttribute('role'), 'group', 'a band, not an overlay role that would hide the page');
  assert.equal(bar()!.textContent!.replace(/\s+/g, ' ').startsWith('Save password for a.test as ann?'), true);
  assert.deepEqual(
    pills().map((b) => b.textContent),
    ['Save', 'Never for this site'],
  );
  assert.equal(bar()!.querySelector('.browser-notice-close')!.getAttribute('aria-label'), 'Not now');
  let changed = 0;
  const onChanged = () => changed++;
  window.addEventListener(LOGINS_CHANGED, onChanged);
  await press('Save');
  window.removeEventListener(LOGINS_CHANGED, onChanged);
  assert.equal(bar(), null);
  assert.deepEqual(f.calls[0], ['answer', 7, 'save', 'o1']);
  assert.deepEqual(toasts(), [['Password saved']]);
  assert.equal(changed, 1);
});

test('an update offer has no Never; no user name drops the "as"; the pane moving to another page hides it', async () => {
  await render();
  await emit(offer({ username: '', update: true }));
  assert.equal(bar()!.textContent!.replace(/\s+/g, ' ').startsWith('Update the saved password for a.test?'), true);
  assert.deepEqual(
    pills().map((b) => b.textContent),
    ['Update'],
  );
  await press('Update');
  assert.deepEqual(toasts(), [['Password updated']]);
  await emit(offer());
  page = 9;
  await act(async () => root!.render(createElement(BrowserLoginOffer, { pageId: () => page })));
  assert.equal(bar(), null);
  page = 7;
  await act(async () => root!.render(createElement(BrowserLoginOffer, { pageId: () => page })));
  assert.ok(bar(), 'back on its page, the offer is there again');
});

test('Never, Not now, failures and expiry', async () => {
  await render();
  f.answer = async (_id: number, c: string) => (c === 'never' ? 'never' : 'dismissed');
  await emit(offer());
  await press('Never for this site');
  await emit(offer());
  await press('Not now');
  assert.deepEqual(
    f.calls.map((c: any[]) => c[2]),
    ['never', 'dismiss'],
  );
  assert.deepEqual(toasts(), []);
  f.answer = async () => 'failed';
  await emit(offer());
  await press('Save');
  await emit(offer());
  await press('Never for this site');
  f.answer = async () => {
    throw new Error('ipc');
  };
  await emit(offer());
  await press('Save');
  f.answer = async () => 'gone';
  await emit(offer());
  await press('Save');
  await emit(offer());
  await press('Not now');
  assert.deepEqual(toasts(), [
    ["Couldn't save the password", 'error'],
    ["Couldn't remember this choice", 'error'],
    ["Couldn't save the password", 'error'],
    ['That offer expired. Sign in again to save the password.', 'error'],
  ]);
  // main expired it: gone from the bar, but only its own page's
  await emit(offer());
  await emit({ pageId: 8, kind: 'offer_gone', offerId: 'o1' });
  assert.ok(bar());
  // an older offer's expiry leaves the newer one that replaced it (#1988)
  await emit({ pageId: 7, kind: 'offer_gone', offerId: 'older' });
  assert.ok(bar());
  await emit({ pageId: 7, kind: 'offer_gone', offerId: 'o1' });
  assert.equal(bar(), null);
  await emit({ pageId: 7, kind: 'offer_gone', offerId: 'o1' });
});

test('a Save answers the offer its bar showed: a newer one main made meanwhile stays on the bar', async () => {
  await render();
  await emit(offer());
  let release: (v: string) => void = () => {};
  f.answer = () => new Promise((r) => (release = r));
  await press('Save');
  assert.deepEqual(f.calls[0], ['answer', 7, 'save', 'o1']);
  // main's newer offer arrives while the answer is on its way; main says the old one is gone, and nothing tells the
  // user to sign in again: the newer one is on the bar
  await emit(offer({ offerId: 'o2', username: 'bob' }));
  await act(async () => release('gone'));
  assert.match(bar()!.textContent!, /bob/);
  assert.deepEqual(toasts(), []);
});

test("the in-page dropdown's failed fills become toasts", async () => {
  await render();
  await emit({ pageId: 7, kind: 'fill', status: 'origin_changed' });
  await emit({ pageId: 7, kind: 'fill', status: 'weird' });
  await emit({ pageId: 8, kind: 'fill', status: 'failed' });
  assert.deepEqual(toasts(), [
    ['The page changed, so the login fill was stopped. Try again.', 'error'],
    ["Couldn't fill the login on this page", 'error'],
  ]);
});
