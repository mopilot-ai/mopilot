// MoPilot's Chrome extension ids (#1632): the dev key's and the Web Store's, accepted in one place by the socket, the pairing page, the profile probe and whether a build ships the extension.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import edition from '../shared/edition.json' with { type: 'json' };
import { rawConnect } from './support/chrome-relay-kit.ts';
import { memoryPairing } from './support/chrome-extension-kit.ts';

const require = createRequire(import.meta.url);
const ids = require('../electron/capabilities/browser/chromeExtensionIds.cjs');
const { ChromeExtensionChannel, SOCKET_PATH, EXTENSION_ID } = require('../electron/capabilities/browser/chromeExtension.cjs');
const nativeHost = require('../electron/capabilities/browser/chromeNativeHost.cjs');
const appRelay = require('../electron/app/chromeRelay.cjs');
const build: any = await import('../scripts/build-chrome-extension.mjs');
const manifest = require('../electron/chrome-extension/manifest.json');

const STORE = 'abcdefghijklmnopabcdefghijklmnop';
const DEV = ids.DEV_EXTENSION_ID;
const PACKAGED = '/Applications/MoPilot.app/Contents/Resources/app.asar/electron/chrome-extension';

test('packaged Store registration follows the edition and the unpacked extension keeps its manifest id', () => {
  const store = edition.desktop.chromeWebStoreId;
  const accepted = store ? [store, DEV] : [DEV];
  assert.equal(build.extensionIdOf(manifest.key), DEV);
  assert.equal(EXTENSION_ID, DEV);
  assert.equal(ids.STORE_EXTENSION_ID, store);
  assert.deepEqual(ids.extensionIds(), accepted);
  assert.equal(ids.storeUrl(), store ? `https://chromewebstore.google.com/detail/${store}` : null);
  assert.equal(ids.allowedOrigin(`chrome-extension://${DEV}`), true);
  assert.equal(appRelay.extensionShipped(PACKAGED), Boolean(store));
  for (const platform of ['darwin', 'win32']) {
    const options = { dir: PACKAGED, platform, env: {} };
    assert.deepEqual(appRelay.nativeHostIds(options), store ? [store] : null);
  }
  assert.deepEqual(
    nativeHost.hostManifest({ launcher: '/l', ids: ids.extensionIds() }).allowed_origins,
    accepted.map((id) => `chrome-extension://${id}/`),
  );
});

test('the ids: the store’s first, then the dev key’s; a store id that isn’t an extension id, or is the dev id, is left out', () => {
  assert.deepEqual(ids.extensionIds({ storeId: STORE }), [STORE, DEV]);
  for (const bad of [null, '', 'short', 'ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP', `${STORE}a`, 'qrstuvwxyzqrstuvwxyzqrstuvwxyzqr', DEV])
    assert.deepEqual(ids.extensionIds({ storeId: bad }), [DEV], String(bad));
  assert.equal(ids.storeUrl({ storeId: STORE }), `https://chromewebstore.google.com/detail/${STORE}`);
});

test('an origin is allowed only exactly as one of the ids’ origins', () => {
  const o = { storeId: STORE };
  assert.equal(ids.allowedOrigin(`chrome-extension://${DEV}`, o), true);
  assert.equal(ids.allowedOrigin(`chrome-extension://${STORE}`, o), true);
  assert.equal(ids.allowedOrigin(`chrome-extension://${STORE}`, { storeId: null }), false);
  for (const bad of [
    undefined,
    null,
    42,
    ['x'],
    '',
    `chrome-extension://${DEV}/`,
    `CHROME-EXTENSION://${DEV}`,
    `https://${DEV}`,
    `chrome-extension://${DEV}.evil`,
  ])
    assert.equal(ids.allowedOrigin(bad, o), false, String(bad));
});

test('which id the profile has: the one turned on, else the one turned off, else none; the page is the store’s by default', () => {
  const states = (m: Record<string, any>) => (id: string) => m[id] ?? 'missing';
  const o = { storeId: STORE };
  assert.deepEqual(ids.extensionInProfileOf(states({ [DEV]: 'on' }), o), { id: DEV, state: 'on' });
  assert.deepEqual(ids.extensionInProfileOf(states({ [DEV]: 'on', [STORE]: 'on' }), o), { id: STORE, state: 'on' });
  assert.deepEqual(ids.extensionInProfileOf(states({ [DEV]: 'on', [STORE]: 'off' }), o), { id: DEV, state: 'on' });
  assert.deepEqual(ids.extensionInProfileOf(states({ [DEV]: 'off' }), o), { id: DEV, state: 'off' });
  assert.deepEqual(ids.extensionInProfileOf(states({}), o), { id: STORE, state: 'missing' });
  assert.deepEqual(
    ids.extensionInProfileOf(() => null, o),
    { id: STORE, state: null },
  );
  // without a store id only the dev key's is read
  const read: string[] = [];
  assert.deepEqual(
    ids.extensionInProfileOf((id: string) => (read.push(id), null), { storeId: null }),
    { id: DEV, state: null },
  );
  assert.deepEqual(read, [DEV]);
});

const stops: (() => void)[] = [];
after(() => stops.forEach((s) => s()));

function channel(o: any = {}) {
  const opened: string[] = [];
  const ch = new ChromeExtensionChannel({
    pairing: memoryPairing(),
    openPage: async (url: string) => opened.push(url),
    connectMs: 200,
    commandMs: 200,
    openMs: 200,
    authMs: 200,
    port: 0,
    ...o,
  });
  stops.push(() => ch.stop());
  return { ch, opened };
}

test('the socket upgrades both ids’ origins once a store id is set, and only the dev key’s without one', async () => {
  const withStore = channel({ storeId: STORE });
  const port = await withStore.ch.start();
  for (const id of [STORE, DEV]) {
    const sock: any = await rawConnect(`ws://127.0.0.1:${port}${SOCKET_PATH}`, { origin: `chrome-extension://${id}` });
    sock.destroy();
  }
  await assert.rejects(
    rawConnect(`ws://127.0.0.1:${port}${SOCKET_PATH}`, { origin: 'chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba' }),
    {
      status: 403,
    },
  );
  const devOnly = channel();
  const devPort = await devOnly.ch.start();
  await assert.rejects(rawConnect(`ws://127.0.0.1:${devPort}${SOCKET_PATH}`, { origin: `chrome-extension://${STORE}` }), { status: 403 });
  const sock: any = await rawConnect(`ws://127.0.0.1:${devPort}${SOCKET_PATH}`, { origin: `chrome-extension://${DEV}` });
  sock.destroy();
});

test('the pairing page opens for the id the profile has (pageId), and the dev key’s without one', async () => {
  const store = channel({ storeId: STORE, pageId: () => STORE });
  await store.ch.start();
  await assert.rejects(store.ch.connect('c'), (e: any) => e?.code === 'not_connected');
  assert.equal(store.opened.length, 1);
  assert.ok(store.opened[0].startsWith(`chrome-extension://${STORE}/options.html#pair=mopilot-claim`));
  const dev = channel();
  await dev.ch.start();
  await assert.rejects(dev.ch.connect('c'), (e: any) => e?.code === 'not_connected');
  assert.ok(dev.opened[0].startsWith(`chrome-extension://${DEV}/options.html#pair=`));
});

test('a build ships the extension where it loads unpacked, or anywhere once a store id is set; the hint says how to install it', () => {
  assert.equal(appRelay.extensionShipped(), true);
  assert.equal(appRelay.extensionShipped(PACKAGED, null), false, 'unchanged without a store id');
  assert.equal(appRelay.extensionShipped(PACKAGED, STORE), true);
  assert.equal(appRelay.extensionShipped(PACKAGED, 'not-an-id'), false);
  assert.equal(appRelay.installHint(PACKAGED, null), "This build of MoPilot doesn't ship its Chrome extension yet.");
  assert.equal(
    appRelay.installHint(PACKAGED, STORE),
    `To install it, open https://chromewebstore.google.com/detail/${STORE} in Chrome and choose Add to Chrome.`,
  );
  // an unpacked build still points at the folder, store id or not
  assert.match(appRelay.installHint(undefined, STORE), /Load unpacked and pick .*chrome-extension\./);
});
