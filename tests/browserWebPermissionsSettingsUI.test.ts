// Settings → Browser → Site permissions (src/components/pages/settings/BrowserWebPermissions.tsx): the sites
// the built-in browser always lets use the camera, microphone, location or notifications, each with Remove.
// The component is real; native, the store and the Settings primitives are stubs.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const React = await import('react');
const { act, createElement } = React;
const { createRoot } = await import('react-dom/client');

const f: any = {
  calls: [],
  sites: [] as any[],
  list: () => Promise.resolve(f.sites),
  forget: async (origin: string) => {
    if (f.forgetFails) throw new Error('disk full');
    f.sites = f.sites.filter((s: any) => s.origin !== origin);
    return f.sites;
  },
};
installNativeStub({
  browser: {
    webPermissions: () => (f.calls.push(['webPermissions']), f.list()),
    forgetWebPermission: (origin: string) => (f.calls.push(['forget', origin]), f.forget(origin)),
  },
});
stubStore({ toast: (text: string, kind: string) => f.calls.push(['toast', text, kind]) });
mock.module('../src/components/pages/Settings.tsx', {
  namedExports: {
    Group: ({ title, desc, children }: any) => createElement('section', { 'data-group': title, 'data-desc': desc }, children),
    Row: ({ title, desc, children }: any) =>
      createElement('div', { className: 'row', 'data-title': title, 'data-desc': desc ?? '' }, children),
  },
});
const { BrowserWebPermissions, permissionsText } = await import('../src/components/pages/settings/BrowserWebPermissions.tsx');

const flush = () =>
  act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });

async function render() {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(BrowserWebPermissions)));
  await flush();
  const rows = () => [...container.querySelectorAll('.row')].map((r: any) => [r.getAttribute('data-title'), r.getAttribute('data-desc')]);
  const items = () => [...container.querySelectorAll('.web-permission-sites li span')].map((n: any) => n.textContent);
  return { container, root, rows, items };
}

test('lists each always-allowed site with what it may use; Remove forgets it and the list shows what is left', async () => {
  f.calls = [];
  f.sites = [
    { origin: 'https://maps.test', permissions: ['geolocation'] },
    { origin: 'https://meet.test', permissions: ['camera', 'microphone', 'notifications'] },
  ];
  const { container, root, rows, items } = await render();
  assert.equal(container.querySelector('section')!.getAttribute('data-group'), 'Site permissions');
  assert.equal(rows().length, 1);
  assert.equal(rows()[0][0], 'Always allowed');
  assert.deepEqual(items(), ['https://maps.test · Location', 'https://meet.test · Camera, Microphone, Notifications']);
  const remove = container.querySelector('button[aria-label="Remove https://maps.test"]') as any;
  assert.equal(remove.textContent, 'Remove');
  await act(async () => remove.click());
  await flush();
  assert.deepEqual(f.calls, [['webPermissions'], ['forget', 'https://maps.test']]);
  assert.deepEqual(items(), ['https://meet.test · Camera, Microphone, Notifications']);
  // a failed removal keeps the row and says so
  f.forgetFails = true;
  await act(async () => (container.querySelector('button') as any).click());
  await flush();
  f.forgetFails = false;
  assert.deepEqual(f.calls.at(-1), ['toast', "Couldn't remove the site permission. Please try again.", 'error']);
  assert.equal(items().length, 1);
  // a removal answered with no list leaves the empty row, not a crash
  f.forget = async () => undefined;
  await act(async () => (container.querySelector('button') as any).click());
  await flush();
  assert.equal(items().length, 0);
  assert.equal(container.querySelector('.row')!.getAttribute('data-title'), 'No sites');
  await act(async () => root.unmount());
});

test('no sites, or a list that could not be read, shows the empty row; an unmounted view ignores a late answer', async () => {
  f.sites = [];
  let view = await render();
  assert.deepEqual(view.rows(), [
    ['No sites', 'Sites you always allow to use your camera, microphone, location or notifications show here.'],
  ]);
  await act(async () => view.root.unmount());
  f.list = () => Promise.reject(new Error('gone'));
  view = await render();
  assert.equal(view.rows()[0][0], 'No sites');
  await act(async () => view.root.unmount());
  // nothing shows until the list arrives; an answer after unmount changes nothing
  let release: any;
  let fail: any;
  f.list = () => new Promise((r, j) => ((release = r), (fail = j)));
  view = await render();
  assert.deepEqual(view.rows(), []);
  await act(async () => view.root.unmount());
  release([{ origin: 'https://late.test', permissions: ['camera'] }]);
  await flush();
  view = await render();
  await act(async () => view.root.unmount());
  fail(new Error('late'));
  await flush();
  assert.equal(permissionsText({ origin: 'https://x.test', permissions: ['camera', 'usb' as any] }), 'Camera, usb');
});
