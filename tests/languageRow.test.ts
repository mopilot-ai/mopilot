// Settings → General → Language: every language in its own name, Automatic first, and a choice saved as a preference.
import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fakeStore, iconStubs, mockSource, popoverStubs, stubStore } from './support/stubs.ts';

const store = fakeStore<any>({ prefs: { interfaceLanguage: 'system' }, drafts: {} });
const saved: any[] = [];
stubStore({ useStore: store.useStore, setPrefs: (p: any) => saved.push(p) });
mockSource('src/components/ui/Popover.tsx', popoverStubs());
mockSource('src/components/ui/icons.tsx', iconStubs());
const { LanguageRow } = await import('../src/components/pages/settings/LanguageRow.tsx');

let root: Root | null = null;
const host = window.document.createElement('div') as unknown as HTMLElement;
window.document.body.append(host as any);
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  saved.length = 0;
  store.set({ drafts: {} });
});

async function open() {
  root = createRoot(host);
  await act(async () => root!.render(h(LanguageRow)));
  await act(async () => host.querySelector('button')!.click());
  return [...host.querySelectorAll('button')].slice(1);
}

test('it offers Automatic, then each language by its own name, and saves the one picked', async () => {
  const options = await open();
  const names = options.map((o) => o.textContent);
  assert.equal(names[0], 'Automatic');
  for (const name of [
    'English',
    '简体中文',
    '繁體中文',
    '日本語',
    '한국어',
    'Español',
    'Français',
    'Deutsch',
    'Italiano',
    'Português (Brasil)',
    'Русский',
    'Indonesia',
  ])
    assert.ok(names.includes(name), name);
  await act(async () => options.find((o) => o.textContent === '日本語')!.click());
  assert.deepEqual(saved, [{ interfaceLanguage: 'ja' }]);
});

const reloadButton = () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Reload window');

test('nothing reloads on its own: after a pick the person may reload this window, knowing what it stops', async () => {
  const options = await open();
  assert.equal(reloadButton(), undefined, 'offered only after a pick');
  const reload = mock.method(location, 'reload', () => undefined);
  await act(async () => options.find((o) => o.textContent === 'Français')!.click());
  assert.equal(reload.mock.callCount(), 0);
  assert.match(reloadButton()!.getAttribute('title')!, /Stops commands running/);
  await act(async () => reloadButton()!.click());
  assert.equal(reload.mock.callCount(), 1);
  reload.mock.restore();
});

test('a window holding an unsent draft says so instead of reloading', async () => {
  store.set({ drafts: { chat: { text: 'half a thought', attachments: [] } } });
  const options = await open();
  await act(async () => options.find((o) => o.textContent === 'Deutsch')!.click());
  assert.equal(reloadButton()!.disabled, true);
  assert.equal(reloadButton()!.getAttribute('title'), 'Send or clear your draft first');
});
