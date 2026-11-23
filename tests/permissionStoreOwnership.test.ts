// Permission writers preserve unreadable or partially recognized saved choices rather than serializing a filtered subset.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { OriginGrants } = require('../electron/capabilities/browser/origins.cjs');
const { WebPermissions } = require('../electron/capabilities/browser/webPermissions.cjs');
const { GrantStore } = require('../electron/capabilities/grants.cjs');
const a = 'https://a.test';
const b = 'https://b.test';
const app = { bundleId: 'app.known', name: 'Known' };
const grant = { ...app, level: 'view', at: 1 };
function fixture(t: any, raw: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-ownership-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'store.json');
  fs.writeFileSync(file, raw);
  return { file, preserved: () => assert.equal(fs.readFileSync(file, 'utf8'), raw) };
}
for (const data of [
  null,
  [],
  { version: 2 },
  { origins: null },
  { origins: [] },
  { origins: { [a]: 'read', [b]: 'future' } },
  { origins: { 'not an origin': 'read' } },
]) {
  test(`site-grant writes preserve an unowned map: ${JSON.stringify(data)}`, (t) => {
    const raw = JSON.stringify(data);
    const { file, preserved } = fixture(t, raw);
    const store = new OriginGrants({ file, ask: async () => null });
    const before = store.list();
    assert.throws(() => store.set(b, 'write'), { code: 'save_failed' });
    preserved();
    assert.deepEqual(store.list(), before);
    assert.equal(fs.readFileSync(`${file}.unreadable`, 'utf8'), raw);
  });
}
for (const data of [
  null,
  [],
  { version: 2 },
  { origins: null },
  { origins: [] },
  { origins: { 'not an origin': ['camera'] } },
  { origins: { [a]: ['camera'], [b]: ['future'] } },
  { origins: { [a]: 'camera' } },
]) {
  test(`web-permission grant and forget preserve an unowned map: ${JSON.stringify(data)}`, async (t) => {
    const raw = JSON.stringify(data);
    const { file, preserved } = fixture(t, raw);
    const store = new WebPermissions({
      file,
      driver: () => null,
      ask: async () => ({ decision: 'allow', scope: 'always' }),
      note: () => {},
    });
    const before = store.list();
    await assert.rejects(store.request({ getURL: () => `${b}/`, isDestroyed: () => false }, 'notifications', {}), /saved web permissions/);
    assert.deepEqual(store.list(), before);
    if (store.allowed(a, 'camera')) assert.throws(() => store.forget(a), /saved web permissions/);
    preserved();
    assert.equal(fs.readFileSync(`${file}.unreadable`, 'utf8'), raw);
  });
}
for (const data of [
  null,
  [],
  { global: [grant, null] },
  { global: [grant], deny: ['keep', null] },
  { global: [grant], rungs: { app: { actions: { type: 'future' } } } },
]) {
  test(`computer-grant writers preserve unowned choices: ${JSON.stringify(data)}`, (t) => {
    const raw = JSON.stringify(data);
    const { file, preserved } = fixture(t, raw);
    const store = new GrantStore({ file, chats: { get: () => null, patchMeta: () => true } });
    const before = store.global();
    for (const mutate of [
      () => store.grant(null, { bundleId: 'app.new' }, 'full', 'always'),
      () => store.setDeny(['new']),
      () => store.setBriefForeground(false),
    ]) {
      assert.throws(mutate, { code: 'save_failed' });
      preserved();
    }
    if (before.length) {
      assert.throws(() => store.revoke(null, app.bundleId), { code: 'save_failed' });
      assert.throws(() => store.clearGlobal(), { code: 'save_failed' });
    }
    store.rememberRung(app, 'type', 'foreground');
    preserved();
    assert.deepEqual(store.global(), before);
    assert.equal(fs.readFileSync(`${file}.unreadable`, 'utf8'), raw);
  });
}

test('per-chat computer-grant mutations preserve unrecognized entries', (t) => {
  const { file } = fixture(t, '{}');
  const stored = [grant, { bundleId: 'app.future', level: 'future' }];
  let writes = 0;
  const store = new GrantStore({
    file,
    chats: {
      get: () => ({ meta: { computerGrants: stored } }),
      patchMeta: () => {
        writes++;
        return true;
      },
    },
  });
  assert.throws(() => store.grant('chat', { bundleId: 'new.app' }, 'view', 'chat'), { code: 'save_failed' });
  assert.throws(() => store.revoke('chat', app.bundleId), { code: 'save_failed' });
  assert.equal(writes, 0);
});

const { BookmarkStore } = require('../electron/capabilities/browser/bookmarkStore.cjs');
const { ChromeTokens } = require('../electron/capabilities/browser/chromeToken.cjs');
const bookmark = { id: 'bookmark', url: `${a}/`, title: 'Known', folderPath: [], source: 'import:chrome', addedAt: 1 };
for (const unknown of [
  null,
  { id: 'future' },
  { id: 'future', url: 'future://a', private: 'keep' },
  { id: 'future', url: `${b}/`, private: 'keep' },
]) {
  test(`bookmark mutations keep all persisted entries: ${JSON.stringify(unknown)}`, (t) => {
    const raw = JSON.stringify({ version: 1, items: [bookmark, unknown] });
    const { file, preserved } = fixture(t, raw);
    const store = new BookmarkStore({ file });
    assert.ok(store.list().some((row: any) => row.id === 'bookmark'));
    for (const mutate of [
      () => store.toggle({ url: 'https://new.test' }),
      () => store.remove('bookmark'),
      () => store.deleteImported('chrome'),
      () => store.importItems([{ url: 'https://new.test' }], 'New', 'new'),
    ]) {
      assert.throws(mutate, /weren't changed/);
      preserved();
    }
    assert.equal(fs.readFileSync(`${file}.unreadable`, 'utf8'), raw);
    store.clear();
    assert.deepEqual(store.list(), [], 'explicit clear still recovers a known damaged format, keeping the backup');
    assert.equal(fs.readFileSync(`${file}.unreadable`, 'utf8'), raw);
  });
}
const safe = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(s),
  decryptString: (b: Buffer) => b.toString(),
};
for (const data of [null, [], { tokens: [] }, { tokens: { old: { future: 'secret' } } }, { version: 2, tokens: { old: 'c2VjcmV0' } }]) {
  test(`Chrome token mutation preserves an unowned map: ${JSON.stringify(data)}`, (t) => {
    const raw = JSON.stringify(data);
    const { file, preserved } = fixture(t, raw);
    const store = new ChromeTokens({ file, safeStorage: safe });
    assert.throws(() => store.set('new', 'new secret'), /weren't changed/);
    preserved();
    assert.equal(fs.readFileSync(`${file}.unreadable`, 'utf8'), raw);
  });
}
test('explicit reserved token keys survive while inherited profile names remain absent', (t) => {
  const raw = JSON.stringify({ tokens: {}, extra: { retain: true } });
  const { file } = fixture(t, raw);
  const store = new ChromeTokens({ file, safeStorage: safe });
  assert.equal(store.has('__proto__'), false);
  assert.equal(store.set('__proto__', 'secret'), true);
  assert.equal(store.get('__proto__'), 'secret');
  assert.equal(store.has('constructor'), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).extra, { retain: true });
  assert.equal(store.set('__proto__', ''), true);
  assert.equal(store.has('__proto__'), false);
});

for (const unknown of [
  { version: 2 },
  { global: 'unowned' },
  { deny: {} },
  { deny: [''] },
  { briefForeground: 'future' },
  { rungs: [] },
  { rungs: { '': { actions: { type: 'foreground' } } } },
  { rungs: { app: null } },
  { rungs: { app: { actions: [] } } },
  { rungs: { app: { actions: {} } } },
  { rungs: { App: { actions: { type: 'foreground' } }, app: { actions: { click: 'background' } } } },
]) {
  test(`computer-permission field ownership: ${JSON.stringify(unknown)}`, (t) => {
    const raw = JSON.stringify({ global: [grant], ...unknown });
    const { file, preserved } = fixture(t, raw);
    const store = new GrantStore({ file, chats: { get: () => null } });
    assert.throws(() => store.setBriefForeground(false), { code: 'save_failed' });
    preserved();
  });
}

test('web permission failure restores an existing partial permission set', async (t) => {
  const raw = JSON.stringify({ origins: { [a]: ['camera'], [b]: ['future'] } });
  const { file, preserved } = fixture(t, raw);
  const store = new WebPermissions({ file, driver: () => null, ask: async () => ({ decision: 'allow', scope: 'always' }), note: () => {} });
  await assert.rejects(store.request({ getURL: () => `${a}/`, isDestroyed: () => false }, 'notifications', {}), /weren't changed/);
  assert.deepEqual(store.list(), [{ origin: a, permissions: ['camera'] }]);
  preserved();
  fs.writeFileSync(file, JSON.stringify({ origins: { [b]: ['microphone'] }, extra: { retain: true } }));
  assert.equal(await store.request({ getURL: () => `${a}/`, isDestroyed: () => false }, 'notifications', {}), true);
  assert.equal(store.allowed(b, 'microphone'), true, 'recovery includes all entries in the restored file');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).extra, { retain: true });
});

test('computer permission recovery preserves extras and reserved rung identities', (t) => {
  const { file, preserved } = fixture(t, JSON.stringify({ global: [grant, null] }));
  const store = new GrantStore({ file, chats: { get: () => null } });
  assert.equal(store.rememberRung(app, 'type', 'foreground'), true);
  assert.equal(store.rememberRung(app, 'type', 'foreground'), false, 'a failed disk read does not discard the in-memory rung');
  preserved();
  fs.writeFileSync(file, JSON.stringify({ global: [grant], extra: { retain: true } }));
  assert.equal(store.grant(null, { bundleId: 'app.new' }, 'view', 'always'), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).extra, { retain: true });
  assert.equal(store.rung('constructor', 'toString'), 'background');
  assert.equal(store.rung('app.known', 'constructor'), 'background');
  assert.equal(store.rememberRung({ bundleId: '__proto__' }, 'constructor', 'foreground'), true);
  const restored = new GrantStore({ file, chats: { get: () => null } });
  assert.equal(restored.rung('__proto__', 'constructor'), 'foreground');
  assert.equal(restored.rung('__proto__', 'toString'), 'background');
});

for (const fields of [
  { folderPath: { future: ['keep'] } },
  { folderPath: [null] },
  { folderPath: [''] },
  { folderPath: [' leading'] },
  { folderPath: ['x'.repeat(101)] },
  { folderPath: Array.from({ length: 14 }, (_, i) => `F${i}`) },
  { folderPath: Array.from({ length: 13 }, (_, i) => `F${i}`), source: 'local' },
  { title: { toString: 42, future: 'keep' } },
  { title: 'x'.repeat(301) },
  { id: { future: 'keep' } },
  { id: '' },
  { source: { future: 'keep' } },
  { source: '' },
  { addedAt: { future: 'keep' } },
]) {
  test(`foreign bookmark field shapes are preserved: ${JSON.stringify(fields)}`, (t) => {
    const raw = JSON.stringify({ version: 1, items: [bookmark, { ...bookmark, id: 'foreign', ...fields }] });
    const { file, preserved } = fixture(t, raw);
    const store = new BookmarkStore({ file });
    assert.doesNotThrow(() => store.list());
    assert.throws(() => store.toggle({ url: 'https://new.test/' }), /weren't changed/);
    preserved();
  });
}

test('web-permission disk failures reject and roll back both forget and Always allow', async (t) => {
  const raw = JSON.stringify({ origins: { [a]: ['camera'] } });
  const { file, preserved } = fixture(t, raw);
  const store = new WebPermissions({ file, driver: () => null, ask: async () => ({ decision: 'allow', scope: 'always' }), note: () => {} });
  t.mock.method(fs, 'renameSync', () => {
    throw new Error('disk failure');
  });
  assert.throws(() => store.forget(a), /Couldn't save/);
  assert.deepEqual(store.list(), [{ origin: a, permissions: ['camera'] }]);
  await assert.rejects(store.request({ getURL: () => `${a}/`, isDestroyed: () => false }, 'notifications', {}), /Couldn't save/);
  assert.deepEqual(store.list(), [{ origin: a, permissions: ['camera'] }]);
  preserved();
  t.mock.restoreAll();
  assert.deepEqual(store.forget(a), []);
});

test('editing a grant or rung preserves its admitted metadata in global and chat stores', (t) => {
  const entry = { ...grant, future: { keep: true } };
  const rung = { name: 'Known', actions: { click: 'foreground' }, at: 1, future: { keep: true } };
  const { file } = fixture(t, JSON.stringify({ global: [entry], rungs: { [app.bundleId]: rung } }));
  let chat = [entry];
  const store = new GrantStore({
    file,
    chats: {
      get: () => ({ meta: { computerGrants: chat } }),
      patchMeta: (_id: string, patch: any) => {
        chat = patch.computerGrants;
        return true;
      },
    },
  });
  store.grant(null, app, 'full', 'always');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).global[0].future, { keep: true });
  store.grant('chat', app, 'full', 'chat');
  assert.deepEqual(chat[0].future, { keep: true });
  store.rememberRung(app, 'type', 'foreground');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).rungs[app.bundleId].future, { keep: true });
});

test('read-only token queries treat empty and foreign token values as absent', (t) => {
  const { file } = fixture(t, JSON.stringify({ tokens: { empty: '', object: { future: true }, number: 3, nil: null } }));
  const store = new ChromeTokens({ file, safeStorage: safe });
  for (const profile of ['empty', 'object', 'number', 'nil']) {
    assert.equal(store.get(profile), null);
    assert.equal(store.has(profile), false);
  }
});

test('non-string stored permission levels and rungs are not owned', (t) => {
  const siteFile = fixture(t, JSON.stringify({ origins: { [a]: 42 } }));
  assert.throws(() => new OriginGrants({ file: siteFile.file }).set(b, 'read'), { code: 'save_failed' });
  siteFile.preserved();
  const rungFile = fixture(t, JSON.stringify({ rungs: { app: { actions: { type: 42 } } } }));
  assert.throws(() => new GrantStore({ file: rungFile.file, chats: { get: () => null } }).setDeny([]), { code: 'save_failed' });
  rungFile.preserved();
});

test('bookmark metadata and non-finite timestamps stay preserved', (t) => {
  for (const raw of [
    JSON.stringify({ version: 1, items: [bookmark], future: { keep: true } }),
    '{"version":1,"items":[{"id":"a","url":"https://a.test/","addedAt":1e400}]}',
  ]) {
    const { file, preserved } = fixture(t, raw);
    const store = new BookmarkStore({ file });
    assert.doesNotThrow(() => store.list());
    assert.throws(() => store.toggle({ url: 'https://new.test/' }), /weren't changed/);
    preserved();
  }
});

for (const fields of [{ name: { future: 'keep' } }, { at: '12' }, { at: { toString: 42, future: 'keep' } }]) {
  test(`grant and rung field shapes remain readable but unowned: ${JSON.stringify(fields)}`, (t) => {
    const entry = { ...grant, ...fields };
    const raw = JSON.stringify({ global: [entry] });
    const { file, preserved } = fixture(t, raw);
    const store = new GrantStore({
      file,
      chats: { get: () => ({ meta: { computerGrants: [entry] } }), patchMeta: () => assert.fail('unowned chat data must not be changed') },
    });
    assert.doesNotThrow(() => store.global());
    assert.doesNotThrow(() => store.chat('chat'));
    assert.throws(() => store.setDeny([]), { code: 'save_failed' });
    assert.throws(() => store.grant('chat', app, 'full', 'chat'), { code: 'save_failed' });
    assert.throws(() => store.revoke('chat', app.bundleId), { code: 'save_failed' });
    preserved();
    const rungFile = fixture(t, JSON.stringify({ rungs: { [app.bundleId]: { actions: { type: 'foreground' }, ...fields } } }));
    const rungStore = new GrantStore({ file: rungFile.file, chats: { get: () => null } });
    assert.equal(rungStore.rung(app.bundleId, 'type'), 'foreground');
    assert.throws(() => rungStore.setBriefForeground(false), { code: 'save_failed' });
    rungFile.preserved();
  });
}

test('non-finite persisted and chat-local grant timestamps are never rewritten', (t) => {
  for (const raw of [
    '{"global":[{"bundleId":"app","level":"view","at":1e400}]}',
    '{"rungs":{"app":{"actions":{"type":"foreground"},"at":1e400}}}',
  ]) {
    const { file, preserved } = fixture(t, raw);
    const store = new GrantStore({ file, chats: { get: () => ({ meta: { computerGrants: [{ ...grant, at: Infinity }] } }) } });
    assert.throws(() => store.setDeny([]), { code: 'save_failed' });
    assert.throws(() => store.revoke('chat', app.bundleId), { code: 'save_failed' });
    preserved();
  }
});

test('the default token profile reports its saved token', (t) => {
  const { file } = fixture(t, '{"tokens":{}}');
  const store = new ChromeTokens({ file, safeStorage: safe });
  assert.equal(store.set('', 'default'), true);
  assert.equal(store.has(), true);
  assert.equal(store.get(), 'default');
});
