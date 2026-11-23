// Passwords: reading a Chromium profile's saved passwords, MoPilot's login store taking an import, the importer's passwords
// category, and the key button's fill (main types into the page; the password never reaches the pane or the model).
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { readPasswords, loginOrigin } = require('../electron/capabilities/browser/import/chromium.cjs');
const { CredentialStore } = require('../electron/capabilities/browser/credentialStore.cjs');
const { groupCookies, siteOfOrigin } = require('../electron/capabilities/browser/import/sites.cjs');
const { fillLogin, fieldScript, touchIdConfirm, FILL_WORLD, STATUSES } = require('../electron/capabilities/browser/userFill.cjs');
const { register } = require('../electron/app/ipc/browserLogins.cjs');
const { deriveKey, encryptValue } = require('../shared/chromiumCrypto.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'browser-passwords-test-'));
const KEY = deriveKey('pw');
const fakeSafe = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(`enc:${s}`),
  decryptString: (b: Buffer) => b.toString().slice(4),
};
const chromeUs = (ms: number) => String((ms + 11644473600000) * 1000);

/** A Login Data database; `full` adds the newer columns. */
function loginDb(file: string, rows: any[], full = true) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(
    full
      ? 'CREATE TABLE logins (origin_url TEXT, signon_realm TEXT, username_value TEXT, password_value BLOB, blacklisted_by_user INTEGER, federation_url TEXT, date_last_used INTEGER, date_created INTEGER)'
      : 'CREATE TABLE logins (origin_url TEXT, signon_realm TEXT, username_value TEXT, password_value BLOB)',
  );
  const cols = full ? 8 : 4;
  const ins = db.prepare(`INSERT INTO logins VALUES (${Array(cols).fill('?').join(', ')})`);
  for (const r of rows) {
    const base = [r.page ?? '', r.realm ?? '', 'user' in r ? r.user : '', 'pass' in r ? r.pass : Buffer.alloc(0)];
    ins.run(...(full ? [...base, r.blocked ? 1 : 0, r.fed ?? '', r.used ?? '0', r.created ?? '0'] : base));
  }
  db.close();
}
const enc = (v: string) => encryptValue(v, KEY, '', 0);
/** What the store holds, without passwords: [origin, user name, source]. */
const held = (store: any) =>
  JSON.parse(fs.readFileSync(store.file, 'utf8'))
    .map((e: any) => [e.origin, e.username, e.source ?? 'local'])
    .sort((a: any, b: any) => a[0].localeCompare(b[0]));

test('loginOrigin: the signon realm first, then the page; web origins only', () => {
  assert.equal(loginOrigin('https://accounts.example.com/', 'https://x.test/login'), 'https://accounts.example.com');
  assert.equal(loginOrigin('', 'http://plain.test/a'), 'http://plain.test');
  assert.equal(loginOrigin('android://hash@com.app/', 'not a url'), null);
  assert.equal(loginOrigin(undefined, undefined), null);
});

test('readPasswords: decrypts saved logins, keeps the newest per site and user, and counts what it leaves out', async () => {
  const profile = tmp();
  loginDb(path.join(profile, 'Login Data'), [
    { realm: 'https://a.test/', user: 'me', pass: enc('old'), used: chromeUs(1000) },
    { realm: 'https://a.test/', user: 'me', pass: enc('new'), used: chromeUs(5000) },
    { realm: 'https://a.test/', user: 'me', pass: enc('older'), created: chromeUs(2000) },
    { realm: 'https://b.test/', page: 'https://b.test/login', user: '', pass: enc('nouser') },
    { realm: 'https://never.test/', user: 'x', pass: enc('x'), blocked: true },
    { realm: 'https://fed.test/', user: 'x', fed: 'https://accounts.google.com' },
    { realm: 'android://h@app/', user: 'x', pass: enc('x') },
    { realm: 'https://empty.test/', user: 'x' },
    { realm: 'https://null.test/', user: 'x', pass: null },
    { realm: 'https://nouser.test/', user: null, pass: enc('pw') },
    { realm: 'https://v11.test/', user: 'x', pass: Buffer.concat([Buffer.from('v11'), Buffer.alloc(16)]) },
    { realm: 'https://wrong.test/', user: 'x', pass: encryptValue('x', deriveKey('other'), '', 0) },
  ]);
  // the account's own database, with the older schema
  loginDb(path.join(profile, 'Login Data For Account'), [{ realm: 'https://acct.test/', user: 'a', pass: enc('acct') }], false);
  const { logins, stats } = await readPasswords(profile, KEY);
  assert.deepEqual(
    logins.map((l: any) => [l.origin, l.username, l.password]),
    [
      ['https://a.test', 'me', 'new'],
      ['https://b.test', '', 'nouser'],
      ['https://nouser.test', '', 'pw'],
      ['https://acct.test', 'a', 'acct'],
    ],
  );
  assert.deepEqual(stats, { total: 13, imported: 4, blocked: 1, federated: 1, invalid: 3, unsupported: 1, undecryptable: 1 });
  // no key: every encrypted password is left out
  const none = await readPasswords(profile, null);
  assert.equal(none.logins.length, 0);
  assert.equal(none.stats.undecryptable, 7);
});

test('readPasswords: a profile with neither database is missing; an unreadable one fails', async () => {
  await assert.rejects(() => readPasswords(tmp(), KEY), { code: 'missing' });
  const profile = tmp();
  fs.writeFileSync(path.join(profile, 'Login Data'), 'not sqlite');
  await assert.rejects(() => readPasswords(profile, KEY), { code: 'read_failed' });
});

test('CredentialStore: an import replaces a login for the same site and user, is listed by source and can be taken out', () => {
  const store = new CredentialStore({ file: path.join(tmp(), 'sub', 'l.json'), safeStorage: fakeSafe });
  const out = store.saveMany(
    [
      { origin: 'https://a.test', username: 'me', password: 'first' },
      { origin: 'https://a.test', username: 'me', password: 'theirs' },
      { origin: 'https://b.test', password: 'pw' },
      { origin: '', username: 'x', password: 'x' },
      { origin: 'https://c.test', username: 'x', password: '' },
      null,
    ],
    'import:chrome',
  );
  // the same site and user named twice is one login, the later one
  assert.deepEqual(out, { imported: 2, replaced: 0 });
  const [a] = store.list('https://a.test');
  assert.equal(store.get(a.id, 'https://a.test').password, 'theirs');
  assert.deepEqual(held(store), [
    ['https://a.test', 'me', 'import:chrome'],
    ['https://b.test', '', 'import:chrome'],
  ]);
  store.save('https://z.test', 'z', 'own');
  store.saveMany([{ origin: 'https://s.test', username: 's', password: 'p' }], 'import:safari');
  assert.deepEqual(store.importedSources(), [
    { source: 'chrome', count: 2 },
    { source: 'safari', count: 1 },
  ]);
  assert.equal(held(store).find((l: any) => l[0] === 'https://z.test')[2], 'local');
  assert.equal(store.deleteImported('safari'), 1);
  assert.equal(store.deleteImported(), 2);
  assert.equal(store.deleteImported(), 0);
  assert.deepEqual(
    held(store).map((l: any) => l[0]),
    ['https://z.test'],
  );
  // nothing valid: nothing written
  assert.deepEqual(store.saveMany([], 'import:chrome'), { imported: 0, replaced: 0 });
  // no OS encryption key: nothing is saved in the clear
  assert.equal(
    new CredentialStore({ file: path.join(tmp(), 'l.json') }).saveMany(
      [{ origin: 'https://a.test', username: 'u', password: 'p' }],
      'import:chrome',
    ),
    null,
  );
});

test('CredentialStore: an import that updates a login the user saved keeps it theirs, so deleting imports never removes it', () => {
  const store = new CredentialStore({ file: path.join(tmp(), 'l.json'), safeStorage: fakeSafe });
  store.save('https://a.test', 'me', 'mine');
  assert.deepEqual(store.saveMany([{ origin: 'https://a.test', username: 'me', password: 'theirs' }], 'import:chrome'), {
    imported: 1,
    replaced: 1,
  });
  const [a] = store.list('https://a.test');
  assert.equal(store.get(a.id, 'https://a.test').password, 'theirs');
  assert.deepEqual(held(store), [['https://a.test', 'me', 'local']]);
  assert.equal(store.deleteImported(), 0);
  assert.deepEqual(store.importedSources(), []);
});

test('the site checklist counts cookies and saved passwords per site', () => {
  assert.equal(siteOfOrigin('https://accounts.example.co.uk'), 'example.co.uk');
  assert.deepEqual(
    groupCookies([{ host: '.example.com' }], [{ origin: 'https://www.example.com' }, { origin: 'https://chase.com' }]).map((s: any) => [
      s.site,
      s.count,
      s.logins,
      s.sensitive,
    ]),
    [
      ['example.com', 1, 1, false],
      ['chase.com', 0, 1, true],
    ],
  );
});

/** A fake pane page: the isolated-world script's answers per step, and what was typed. */
function page(o: any = {}) {
  const typed: string[] = [];
  const steps: string[] = [];
  let url = o.url ?? 'https://a.test/login';
  const wc: any = Object.assign(new EventEmitter(), {
    typed,
    steps,
    destroyed: false,
    getURL: () => url,
    setURL: (u: string) => (url = u),
    isDestroyed: () => wc.destroyed,
    isLoadingMainFrame: () => false,
    executeJavaScriptInIsolatedWorld: async (world: number, [{ code }]: any) => {
      assert.equal(world, FILL_WORLD);
      const step = JSON.parse(/const step = (".*?");/.exec(code)![1]);
      steps.push(step);
      if (o.throwOn === step) throw new Error('page went away');
      if (step === 'probe') return 'probe' in o ? o.probe : { username: true, password: true };
      return o.focus?.[step] ?? true;
    },
    insertText: async (t: string) => {
      typed.push(t);
      o.afterType?.(wc);
    },
  });
  return wc;
}
function store() {
  const s = new CredentialStore({ file: path.join(tmp(), 'l.json'), safeStorage: fakeSafe });
  s.save('https://a.test', 'me', 'secret');
  return { s, id: s.list('https://a.test')[0].id };
}

test('fillLogin: types the user name and the password into the focused fields after the user approves', async () => {
  const { s, id } = store();
  const wc = page();
  const asked: string[] = [];
  assert.equal(await fillLogin({ wc, store: s, id, confirm: async (host: string) => (asked.push(host), true) }), 'filled');
  assert.deepEqual(wc.typed, ['me', 'secret']);
  assert.deepEqual(wc.steps, ['probe', 'username', 'password']);
  assert.deepEqual(asked, ['a.test']);
  // a page with only the password field (the second step of a sign-in) gets only the password; default approval
  const second = page({ probe: { username: false, password: true } });
  assert.equal(await fillLogin({ wc: second, store: s, id }), 'filled');
  assert.deepEqual(second.typed, ['secret']);
});

test('fillLogin: refuses another site, a page without fields, a declined approval, a page that moved, and a field it cannot focus', async () => {
  const { s, id } = store();
  assert.equal(await fillLogin({ wc: page({ url: 'https://evil.test/' }), store: s, id }), 'not_found');
  assert.equal(await fillLogin({ wc: page({ url: 'about:blank' }), store: s, id }), 'not_found');
  assert.equal(await fillLogin({ wc: page(), store: s, id: 'nope' }), 'not_found');
  assert.equal(await fillLogin({ wc: page({ probe: { username: false, password: false } }), store: s, id }), 'no_fields');
  assert.equal(await fillLogin({ wc: page({ probe: null }), store: s, id }), 'no_fields');
  const declined = page();
  assert.equal(await fillLogin({ wc: declined, store: s, id, confirm: async () => false }), 'cancelled');
  assert.deepEqual(declined.typed, []);
  // the page left the site while the user approved: nothing typed
  const moved = page();
  assert.equal(
    await fillLogin({ wc: moved, store: s, id, confirm: async () => (moved.setURL('https://evil.test/'), true) }),
    'origin_changed',
  );
  assert.deepEqual(moved.typed, []);
  // ...or after the user name: the password is not typed there
  const mid = page({ afterType: (wc: any) => wc.setURL('https://evil.test/') });
  assert.equal(await fillLogin({ wc: mid, store: s, id }), 'origin_changed');
  assert.deepEqual(mid.typed, ['me']);
  const gone = page({ afterType: (wc: any) => (wc.destroyed = true) });
  assert.equal(await fillLogin({ wc: gone, store: s, id }), 'origin_changed');
  assert.equal(await fillLogin({ wc: page({ focus: { username: false } }), store: s, id }), 'failed');
  assert.equal(await fillLogin({ wc: page({ throwOn: 'probe' }), store: s, id }), 'failed');
  // the login was forgotten while the user approved
  const late = store();
  assert.equal(
    await fillLogin({ wc: page(), store: late.s, id: late.id, confirm: async () => (late.s.remove(late.id), true) }),
    'not_found',
  );
  assert.deepEqual(STATUSES, ['filled', 'no_fields', 'not_found', 'origin_changed', 'cancelled', 'failed']);
});

test('fillLogin: a saved login without a user name fills only the password', async () => {
  const s = new CredentialStore({ file: path.join(tmp(), 'l.json'), safeStorage: fakeSafe });
  s.save('https://a.test', '', 'pw');
  const wc = page();
  assert.equal(await fillLogin({ wc, store: s, id: s.list('https://a.test')[0].id }), 'filled');
  assert.deepEqual(wc.typed, ['pw']);
});

test('fieldScript: finds visible fields, the user name before the password, and focuses the one asked for', async () => {
  const { Window } = await import('happy-dom');
  const win: any = new Window({ url: 'https://a.test/' });
  const doc = win.document;
  doc.body.innerHTML = `
    <form><input id="search" type="text" name="q"><input id="hidden" type="password" style="display:none">
    <input id="user" type="email" name="email"><input id="pass" type="password"></form>`;
  // happy-dom lays nothing out: give every field a size, except the hidden one
  win.HTMLElement.prototype.getBoundingClientRect = function () {
    return this.style.display === 'none' ? { width: 0, height: 0 } : { width: 100, height: 20 };
  };
  // the page's realm: its objects are compared by value
  const run = (step: string) => JSON.parse(JSON.stringify(win.eval(fieldScript(step))));
  assert.deepEqual(run('probe'), { username: true, password: true });
  assert.equal(run('username'), true);
  assert.equal(doc.activeElement.id, 'user');
  assert.equal(run('password'), true);
  assert.equal(doc.activeElement.id, 'pass');
  // a first step with no password field: the field named like a user name
  doc.body.innerHTML = '<input id="q" type="text" name="q"><input id="login" type="text" autocomplete="username">';
  assert.deepEqual(run('probe'), { username: true, password: false });
  assert.equal(run('password'), false);
  // outside a form, a site's search box before the password field is not a user name field...
  doc.body.innerHTML = '<input id="search" type="search"><input id="q" type="text" name="q"><input id="pass" type="password">';
  assert.deepEqual(run('probe'), { username: false, password: true });
  // ...but one named like a user name is
  doc.body.innerHTML = '<input id="q" type="text" name="q"><input id="em" type="email" name="email"><input id="pass" type="password">';
  assert.deepEqual(run('probe'), { username: true, password: true });
  assert.equal(run('username'), true);
  assert.equal(doc.activeElement.id, 'em');
  doc.body.innerHTML = '<p>nothing</p>';
  assert.deepEqual(run('probe'), { username: false, password: false });
  await win.happyDOM.close();
});

test('touchIdConfirm: asks Touch ID where the Mac has it; a cancel declines; elsewhere the click is the approval', async () => {
  const reasons: string[] = [];
  assert.equal(
    await touchIdConfirm({ canPromptTouchID: () => true, promptTouchID: async (r: string) => void reasons.push(r) })('a.test'),
    true,
  );
  assert.deepEqual(reasons, ['fill your login for a.test']);
  assert.equal(
    await touchIdConfirm({
      canPromptTouchID: () => true,
      promptTouchID: async () => {
        throw new Error('cancelled');
      },
    })('a.test'),
    false,
  );
  assert.equal(await touchIdConfirm({ canPromptTouchID: () => false })('a.test'), true);
  assert.equal(await touchIdConfirm(null)('a.test'), true);
});

test("key button IPC: a page site's user names, and a fill only into a pane tab", async () => {
  const handlers = new Map<string, (...a: any[]) => any>();
  const { s, id } = store();
  const pane = { session: 'pane' };
  const wc = Object.assign(page(), pane);
  const appWindow = Object.assign(page(), { session: 'app' });
  const contents: Record<number, any> = { 1: wc, 2: appWindow, 3: Object.assign(page(), pane, { isDestroyed: () => true }) };
  register({ handle: (c: string, f: any) => handlers.set(c, f) } as any, {
    store: () => s,
    webContents: { fromId: (n: number) => contents[n] ?? null },
    panelSessions: () => ['pane'],
    confirm: async () => true,
  });
  const call = (c: string, ...a: any[]) => handlers.get(c)!({}, ...a);
  assert.deepEqual(await call('browser:logins', 'https://a.test/x'), [{ id, username: 'me' }]);
  assert.deepEqual(await call('browser:logins', 'nonsense'), []);
  assert.deepEqual(await call('browser:logins', 5), []);
  assert.equal(await call('browser:fillLogin', 1, id), 'filled');
  assert.deepEqual(wc.typed, ['me', 'secret']);
  assert.equal(await call('browser:fillLogin', 2, id), 'not_found', 'an app window is never filled');
  assert.equal(await call('browser:fillLogin', 3, id), 'not_found');
  assert.equal(await call('browser:fillLogin', 9, id), 'not_found');
  assert.equal(await call('browser:fillLogin', '1', id), 'not_found');
  assert.equal(await call('browser:fillLogin', 1, undefined), 'not_found');
});
