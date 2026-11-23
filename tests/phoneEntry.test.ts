// Production registration, runtime ownership and Metro workspace resolution are wired to the real entry files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import './support/dom.ts';
import './support/phone/entry-register.ts';
import { act, createElement } from 'react';
const { createRoot } = await import('react-dom/client');
const g = globalThis as any;
g.__phoneRuntimeCount = 0;
g.__phoneRuntimes = [];
g.__phonePushes = [];
g.__phoneActivities = [];
g.__phoneTaskInstalls = 0;
const phoneModulePath1 = '../mobile/App';
const { default: App } = await import(phoneModulePath1);
const phoneModulePath2 = '../mobile/index.js';
await import(phoneModulePath2);
test('Expo registers App and each mounted instance retains its runtime across rerenders', async () => {
  assert.equal(g.__phoneRegistered, App);
  assert.equal(g.__phoneTaskInstalls, 1, 'the Android data-message task is defined once, at module load');
  assert.equal(g.__phoneTaskBeforeRegister, true, 'and before the root component registers');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(App)));
  assert.match(host.textContent!, /Runtime 1/);
  assert.match(
    host.querySelector('[data-gesture-root]')?.textContent ?? '',
    /Runtime 1/,
    'the app sits under the gesture root, so UI-thread gestures work',
  );
  assert.equal(g.__phoneUiAtRender, 'v2', 'the saved Phone UI choice is read before the first screen asks which UI is drawn (#4872)');
  assert.equal(g.__versionProp, '4.5.6', 'the build version reaches Settings › About');
  assert.equal(g.__phoneNameProp, 'iPhone', "the phone's own name reaches the pairing form");
  assert.equal(g.__appearanceProp.reads, 1, 'the saved appearance is applied once, at start, and the control reaches Settings');
  assert.equal(g.__hapticsProp.reads, 1, 'the saved Haptic feedback choice is read once, at start, and the control reaches Settings');
  assert.equal(typeof g.__homeLayoutProp.read, 'function', 'the saved By project / By state choice reaches the home, which reads it');
  assert.deepEqual(
    g.__devEndpointsProp,
    { relayUrl: 'ws://192.168.1.2:8787/v1/ws', accountOrigin: 'http://192.168.1.2:8787' },
    'a dev build shows its endpoints',
  );
  assert.equal(g.__phoneDevPairLinks.length, 1, 'the dev pairing link is watched once per app');
  assert.deepEqual(
    [g.__phoneDevPairLinks[0].name, g.__phoneDevPairLinks[0].dev],
    ['iPhone', true],
    'with the phone name, and only because this build carries a dev host',
  );
  await act(async () => root.render(createElement(App)));
  assert.equal(g.__phoneRuntimeCount, 1);
  assert.equal(g.__phoneDevPairLinks.length, 1, 'and not again on a rerender');
  assert.equal(g.__phoneRuntimes[0].relayUrl, 'ws://192.168.1.2:8787/v1/ws', 'the runtime trusts the relay the build carries');
  assert.equal(g.__phoneRuntimes[0].plainRelay, true, 'and is told it is a development build’s plain relay');
  assert.equal(typeof g.__phoneRuntimes[0].hostChat?.on, 'function', 'and is given the host-chat flag of this phone');
  assert.equal(g.__phonePushes.length, 1, 'one push controller per mounted runtime, kept across rerenders');
  assert.equal(g.__phonePushes[0].runtime, g.__phoneRuntimes[0]);
  await g.__phonePushes[0].hooks.beforeSignOut();
  assert.equal(g.__phoneActivities[0].forgotten, 1, 'signing out ends the activity and drops its relay token');
  assert.equal(g.__phoneActivities.length, 1, 'one Live Activity controller per mounted runtime, kept across rerenders');
  assert.equal(g.__phoneActivities[0].runtime, g.__phoneRuntimes[0]);
  assert.equal(g.__phoneActivities[0].started, 1, 'and started once, for the app’s whole life rather than only while Settings is open');
  await act(async () => root.render(createElement('div', null, createElement(App), createElement(App))));
  assert.equal(g.__phoneRuntimeCount, 3);
  assert.equal(g.__phoneDevPairLinks.length, 3, 'each mounted app watches the link for its own runtime');
  assert.match(host.textContent!, /Runtime 2Runtime 3/);
  await act(async () => root.unmount());
  assert.ok(
    g.__phoneDevPairLinks.every((l: any) => l.stopped),
    'every link watch stops with its app',
  );
  assert.ok(
    g.__phoneActivities.every((a: any) => a.stopped >= 1),
    'every Live Activity controller stops with its app',
  );
  host.remove();
});
test('a store build (no dev host) never listens for a pairing link, so no web page can start a pairing', async () => {
  g.__phoneEndpointsDev = false;
  const before = g.__phoneDevPairLinks.length;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(App)));
  assert.equal(g.__phoneDevPairLinks.length, before + 1);
  assert.equal(g.__phoneDevPairLinks.at(-1).dev, false, 'the gate is the build’s own dev flag, not whether endpoints are shown');
  await act(async () => root.unmount());
  host.remove();
  delete g.__phoneEndpointsDev;
});
test('Metro watches shared repository and resolves native dependencies from the phone workspace', () => {
  const require = createRequire(import.meta.url);
  const config = require('../mobile/metro.config.js');
  const mobile = path.resolve('mobile');
  assert.ok(config.watchFolders.includes(path.resolve('.')));
  assert.deepEqual(config.resolver.nodeModulesPaths, [path.join(mobile, 'node_modules')]);
  assert.ok(require.resolve('../mobile/node_modules/expo/package.json').startsWith(mobile));
});

test('the app version comes from the Expo config and is absent when the build has none', async () => {
  const versionPath = '../mobile/src/appVersion.ts';
  const { appVersion } = await import(versionPath);
  assert.equal(appVersion({ expoConfig: { version: '0.1.0' } }), '0.1.0');
  assert.equal(appVersion({ expoConfig: null }), undefined);
  assert.equal(appVersion({}), undefined);
});

test('a probe build opens the selectable text probe instead of the app, and a build with the in-place flag and a native view turns it on', async () => {
  const flagPath = '../mobile/src/platform/inPlaceSelection';
  const viewPath = '../mobile/src/platform/selectableText';
  const { inPlaceSelection, setInPlaceSelection } = await import(flagPath);
  const { setNativeSelectableText } = await import(viewPath);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  g.__phoneExtra = { selectableProbe: true };
  await act(async () => root.render(createElement(App)));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  assert.match(host.textContent!, /Selectable text probe/);
  assert.doesNotMatch(host.textContent!, /Runtime/, 'not the app');
  await act(async () => root.unmount());
  // a build that asks for in-place selection has it once the native view is there; one that does not, does not
  setNativeSelectableText(() => null);
  g.__phoneExtra = { inPlaceSelection: true };
  const second = createRoot(host);
  await act(async () => second.render(createElement(App)));
  assert.equal(inPlaceSelection(), true);
  await act(async () => second.unmount());
  g.__phoneExtra = undefined;
  const third = createRoot(host);
  await act(async () => third.render(createElement(App)));
  assert.equal(inPlaceSelection(), false);
  await act(async () => third.unmount());
  setNativeSelectableText(null);
  setInPlaceSelection(false);
  host.remove();
});
