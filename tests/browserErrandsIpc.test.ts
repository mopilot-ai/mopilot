// IPC for the composer's errand line (electron/app/ipc/browserErrands.cjs): a chat's allowed sites from both browsers' tables, Revoke in
// the browser it names, and a push of the chat's list on every change; nothing before the browser tools start.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { register, registeredBy } = require('../electron/app/ipc/browserErrands.cjs');
const { ErrandGrants } = require('../electron/capabilities/browser/errandGrants.cjs');

test('lists both browsers, revokes in the one named, pushes each change; empty before the tables exist', async () => {
  assert.equal(registeredBy, 'browser');
  const handlers = new Map<string, (...a: any[]) => any>();
  const ipcMain = { handle: (ch: string, fn: any) => void handlers.set(ch, fn) };
  const live: any = {};
  const pushed: any[] = [];
  const off = register(ipcMain, { live, broadcastAll: (ch: string, p: any) => pushed.push([ch, p]) });
  assert.deepEqual(await handlers.get('browser:errands')!({}, 'c1'), []);
  assert.equal(await handlers.get('browser:revokeErrand')!({}, 'c1', 'https://store.example', 'chrome'), false);
  live.browserGrants = { errands: new ErrandGrants('iab') };
  live.chromeGrants = { errands: new ErrandGrants('chrome') };
  live.browserGrants.errands.add('c1', 'https://help.store.example', 1);
  live.chromeGrants.errands.add('c1', 'https://store.example', 2);
  assert.deepEqual(await handlers.get('browser:errands')!({}, 'c1'), [
    { site: 'https://store.example', since: 1, browser: 'iab' },
    { site: 'https://store.example', since: 2, browser: 'chrome' },
  ]);
  assert.equal(await handlers.get('browser:revokeErrand')!({}, 'c1', 'https://store.example', 'chrome'), true);
  assert.deepEqual(
    (await handlers.get('browser:errands')!({}, 'c1')).map((e: any) => e.browser),
    ['iab'],
  );
  assert.equal(
    await handlers.get('browser:revokeErrand')!({}, 'c1', 'https://store.example', undefined),
    true,
    'the built-in browser by default',
  );
  assert.deepEqual(pushed.at(-1), ['browser:errandsChanged', { chatId: 'c1', errands: [] }]);
  assert.equal(pushed.length, 4);
  off();
  live.browserGrants.errands.add('c1', 'https://store.example');
  assert.equal(pushed.length, 4, 'unsubscribed');
});
