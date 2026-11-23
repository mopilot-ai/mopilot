// The production entry hands the app a MoMo cache opener whose failure leaves MoMo running without a saved copy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import './support/phone/entry-register.ts';
import { act, createElement } from 'react';
const { createRoot } = await import('react-dom/client');
const g = globalThis as any;
g.__phoneRuntimeCount = 0;
g.__phoneRuntimes = [];
const appPath = '../mobile/App';
const { default: App } = await import(appPath);

test('the app opens the memory cache once per mount and a failed open reads as no cache', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(App)));
  await act(async () => root.render(createElement(App)));
  assert.equal(g.__momoOpens, 1);
  assert.deepEqual(await g.__momoProp.cache, { opened: 1 });
  await act(async () => root.unmount());
  g.__momoOpenFails = true;
  const second = createRoot(host);
  await act(async () => second.render(createElement(App)));
  assert.equal(await g.__momoProp.cache, null);
  await act(async () => second.unmount());
  host.remove();
});
