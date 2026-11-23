// "Allow Chrome to connect?" (src/components/dialogs/ChromeAllowDialog.tsx): a dialog shown only while main asks; each answer reaches main once, Escape is Not now and Enter in the name is Allow.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const calls: unknown[][] = [];
let status: any = null;
let answer: (allow: boolean) => Promise<boolean> = async () => true;
const names: unknown[] = [];
mock.module('../src/session/nativeAvailability.ts', { namedExports: { useNativeAvailability: () => status } });
installNativeStub({
  availability: {
    chromeAllow: (allow: boolean, name?: string) => (calls.push(['chromeAllow', allow]), names.push(name), answer(allow)),
  },
});
stubStore({ toastFailure: (what: string) => (e: unknown) => calls.push(['toast', what, String(e)]) });
const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { ChromeAllowDialog } = await import('../src/components/dialogs/ChromeAllowDialog.tsx');

async function render() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(() => root.render(createElement(ChromeAllowDialog)));
  return { host, root, buttons: () => [...host.querySelectorAll('button')] as HTMLButtonElement[] };
}

test('hidden until main asks: no status, no extension, or another state', async () => {
  for (const s of [null, { extension: null }, { extension: { reasonCode: 'chrome.pair' } }]) {
    status = s;
    const { host, root } = await render();
    assert.equal(host.innerHTML, '');
    await act(() => root.unmount());
  }
});

test('Allow and Not now each answer main, disabled while the answer is on its way', async () => {
  status = { extension: { reasonCode: 'chrome.allow' } };
  calls.length = 0;
  let finish!: () => void;
  answer = () => new Promise<boolean>((resolve) => (finish = () => resolve(true)));
  const { host, root, buttons } = await render();
  const dialog = host.querySelector('[data-testid="chrome-allow-dialog"]') as HTMLElement;
  assert.equal(dialog.getAttribute('role'), 'dialog');
  assert.equal(dialog.getAttribute('aria-modal'), 'true');
  // over the app, not in the sidebar
  assert.equal(dialog.parentElement?.className, 'sketch-backdrop');
  assert.equal(host.querySelector(`#${dialog.getAttribute('aria-labelledby')}`)?.textContent, 'Allow Chrome to connect?');
  assert.match(
    host.querySelector(`#${dialog.getAttribute('aria-describedby')}`)?.textContent ?? '',
    /^The MoPilot extension in Chrome asked to connect\./,
  );
  // one button family, the answer last: Not now, then the primary Allow
  assert.deepEqual(
    buttons().map((b) => b.className),
    ['btn sm', 'btn primary sm'],
  );
  const [notNow, allow] = buttons();
  assert.deepEqual([notNow.textContent, allow.textContent], ['Not now', 'Allow']);
  await act(() => allow.click());
  assert.equal(allow.disabled, true);
  await act(async () => finish());
  assert.equal(allow.disabled, false);
  await act(() => notNow.click());
  await act(async () => finish());
  assert.deepEqual(calls, [
    ['chromeAllow', true],
    ['chromeAllow', false],
  ]);
  await act(() => root.unmount());
});

test('a failed answer is a toast naming what failed', async () => {
  status = { extension: { reasonCode: 'chrome.allow' } };
  calls.length = 0;
  answer = async () => {
    throw new Error('gone');
  };
  const { root, buttons } = await render();
  const [notNow, allow] = buttons();
  await act(async () => allow.click());
  await act(async () => notNow.click());
  assert.deepEqual(calls, [
    ['chromeAllow', true],
    ['toast', "Couldn't allow Chrome", 'Error: gone'],
    ['chromeAllow', false],
    ['toast', "Couldn't dismiss", 'Error: gone'],
  ]);
  assert.equal(buttons()[1].disabled, false);
  await act(() => root.unmount());
});

test('Name this Chrome: on its own row, sent trimmed with Allow (not with Not now); an empty name keeps Allow off', async () => {
  status = { extension: { reasonCode: 'chrome.allow' } };
  calls.length = 0;
  names.length = 0;
  answer = async () => true;
  const { host, root, buttons } = await render();
  const input = host.querySelector('input') as HTMLInputElement;
  assert.equal(input.closest('label')?.textContent, 'Name this Chrome');
  assert.equal(input.className, 'text-input');
  assert.equal(
    host.querySelector(`#${input.getAttribute('aria-describedby')}`)?.textContent,
    'Shown in Settings → Browser and in the extension.',
  );
  assert.equal(input.value, 'My Chrome');
  assert.equal(input.maxLength, 80);
  const type = async (v: string) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      set.call(input, v);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  await type('   ');
  assert.equal(buttons()[1].disabled, true);
  await type('  Work laptop ');
  assert.equal(buttons()[1].disabled, false);
  await act(async () => buttons()[1].click());
  await act(async () => buttons()[0].click());
  assert.deepEqual(names, ['Work laptop', undefined]);
  await act(() => root.unmount());
});

const press = (el: Element, key: string, init: KeyboardEventInit = {}) =>
  act(async () => {
    el.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
  });

test('the name has the keyboard, selected, when the question comes up', async () => {
  status = { extension: { reasonCode: 'chrome.allow' } };
  const { host, root } = await render();
  const input = host.querySelector('input') as HTMLInputElement;
  assert.equal(document.activeElement, input);
  assert.deepEqual([input.selectionStart, input.selectionEnd], [0, 'My Chrome'.length]);
  await act(() => root.unmount());
});

test('Enter in the name is Allow (with the name), but not with an empty name, mid-composition or while answering', async () => {
  status = { extension: { reasonCode: 'chrome.allow' } };
  calls.length = 0;
  names.length = 0;
  let finish!: () => void;
  answer = () => new Promise<boolean>((resolve) => (finish = () => resolve(true)));
  const { host, root } = await render();
  const input = host.querySelector('input') as HTMLInputElement;
  await press(input, 'Enter', { isComposing: true });
  assert.deepEqual(calls, []);
  await press(input, 'Enter');
  // a second Enter while the first answer is on its way sends nothing more
  await press(input, 'Enter');
  await act(async () => finish());
  assert.deepEqual(calls, [['chromeAllow', true]]);
  assert.deepEqual(names, ['My Chrome']);
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    set.call(input, '  ');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await press(input, 'Enter');
  assert.equal(calls.length, 1);
  await act(() => root.unmount());
});

test('Escape is Not now and handles the key; not while answering, mid-composition or with a modifier', async () => {
  status = { extension: { reasonCode: 'chrome.allow' } };
  calls.length = 0;
  let finish!: () => void;
  answer = () => new Promise<boolean>((resolve) => (finish = () => resolve(true)));
  const { host, root } = await render();
  const input = host.querySelector('input') as HTMLInputElement;
  // the app's own Escape (appShortcuts) skips a handled key, so the side pane stays open
  let handled: boolean | null = null;
  const seen = (e: Event) => (handled = e.defaultPrevented);
  window.addEventListener('keydown', seen);
  await press(input, 'Escape', { isComposing: true });
  await press(input, 'Escape', { shiftKey: true });
  assert.deepEqual(calls, []);
  await press(input, 'Escape');
  assert.equal(handled, true);
  await press(input, 'Escape');
  await act(async () => finish());
  window.removeEventListener('keydown', seen);
  assert.deepEqual(calls, [['chromeAllow', false]]);
  await act(() => root.unmount());
});

test('a click on the backdrop answers nothing and keeps the keyboard in the dialog', async () => {
  status = { extension: { reasonCode: 'chrome.allow' } };
  calls.length = 0;
  const { host, root } = await render();
  const backdrop = host.querySelector('.sketch-backdrop') as HTMLElement;
  const down = (el: Element) => {
    const e = new window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
    el.dispatchEvent(e);
    return e.defaultPrevented;
  };
  assert.equal(down(backdrop), true);
  // inside the dialog a press works as usual (selecting text in the name)
  assert.equal(down(host.querySelector('input')!), false);
  assert.deepEqual(calls, []);
  await act(() => root.unmount());
});
