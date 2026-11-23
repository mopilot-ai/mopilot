// Edge cases of the browser site permissions, the extension token store, the Chrome setup readers
// and the built-in browser's tools.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { OriginGrants } = require('../electron/capabilities/browser/origins.cjs');
const { ChromeTokens } = require('../electron/capabilities/browser/chromeToken.cjs');
const mig = require('../electron/capabilities/browser/chromeMigration.cjs');
const { panelBrowserTools } = require('../electron/capabilities/browser/tools.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cap-browser-'));
const ctx = { chatId: 'c', segmentId: 's' };

/* -- origins ---------------------------------------------------------- */
test('origins: a file without an origins map loads nothing; a failing save is refused and rolled back', () => {
  const dir = tmp();
  const file = path.join(dir, 'origins.json');
  fs.writeFileSync(file, '{}');
  const g = new OriginGrants({ file, ask: async () => null });
  assert.deepEqual(g.list(), []);
  // the target path is a directory: the rename fails, the caller is told, and the grant is not kept
  fs.rmSync(file);
  fs.mkdirSync(file);
  assert.throws(
    () => g.set('https://a.com', 'read'),
    (e: any) => e.code === 'save_failed',
  );
  assert.equal(g.get('https://a.com'), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('origins: an answer without a level grants what the call needs', async () => {
  const g = new OriginGrants({ ask: async () => ({ decision: 'allow', scope: 'chat' }) });
  await g.require('https://a.com/x', 'write', ctx);
  assert.equal(g.chatGrants.get('c').get('https://a.com'), 'write');
});

test('origins: allowed read only for a call that writes is refused as read only', async () => {
  const g = new OriginGrants({ ask: async () => ({ decision: 'allow', scope: 'once', level: 'read' }) });
  await assert.rejects(
    g.require('https://a.com/x', 'write', ctx),
    (e: any) => e.code === 'read_only' && /gave https:\/\/a.com read-only access/.test(e.message),
  );
});

/* -- chrome tokens ---------------------------------------------------- */
test('chrome tokens: a file without a tokens object is empty; an undecryptable token is none', () => {
  const dir = tmp();
  const file = path.join(dir, 'sub', 'tokens.json');
  const safe = {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => {
      const s = b.toString();
      if (!s.startsWith('enc:')) throw new Error('bad');
      return s.slice(4);
    },
  };
  const t = new ChromeTokens({ file, safeStorage: safe });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ tokens: 'nope' }));
  assert.equal(t.has(), false);
  // a file it can't read is never saved over: the other profiles' tokens would go
  assert.throws(() => t.set('Profile 1', 'tok'), /Couldn't read the saved connection tokens \(no tokens in it\)/);
  assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify({ tokens: 'nope' }));
  fs.writeFileSync(file, '{"tokens": {');
  assert.throws(() => t.set('Profile 1', 'tok'), /so they weren't changed/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"tokens": {');
  fs.rmSync(`${file}.unreadable`);
  fs.writeFileSync(file, JSON.stringify({ tokens: { '': Buffer.from('garbage').toString('base64') } }));
  assert.equal(t.get(''), null);
  fs.chmodSync(file, 0o644);
  assert.equal(t.set(undefined, 'tok'), true);
  assert.equal(t.get(), 'tok');
  // the file is replaced whole: a token file left readable by others becomes private, and no temporary file stays
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), [path.basename(file)]);
  fs.rmSync(dir, { recursive: true, force: true });
});

/* -- chrome migration ------------------------------------------------- */
test('chromeUserData: Windows without LOCALAPPDATA falls back to the home folder', () => {
  assert.equal(
    mig.chromeUserData({ home: '/h', platform: 'win32', env: {} }),
    path.join('/h', 'AppData', 'Local', 'Google', 'Chrome', 'User Data'),
  );
});

test('compareVersions: missing parts count as zero', () => {
  assert.equal(mig.compareVersions('1.0', '1.0.0'), 0);
  assert.equal(mig.compareVersions('1.0.1', '1.0'), 1);
  assert.equal(mig.compareVersions('1', '1.0.1'), -1);
});

test('usedClaudeInChrome: the default home is only read through the given fs', () => {
  const seen: string[] = [];
  const f = {
    readFileSync: (p: string) => (seen.push(p), '{"claudeInChromeDefaultEnabled":true}'),
    readdirSync: () => [],
  };
  assert.equal(mig.usedClaudeInChrome({ fs: f }), true);
  assert.equal(seen[0], path.join(os.homedir(), '.claude.json'));
});

test('installedExtensionVersion: an unreadable user data folder or extension folder is not installed', () => {
  const fail = {
    readdirSync: () => {
      throw new Error('ENOENT');
    },
    readFileSync: () => '',
  };
  assert.equal(mig.installedExtensionVersion({ fs: fail }), null);
  assert.equal(mig.installedExtensionVersion({ fs: fail, userData: '/u', profileDir: 'Default' }), null);
});

/* -- built-in browser tools ------------------------------------------- */
function tools(opts: any = {}) {
  const calls: any[] = [];
  const page = { backend: { getURL: () => 'https://a.com/', isDestroyed: () => false } };
  const panel = {
    // the selected tab: one page that stays put while a call checks its permission
    tab: async () => page,
    navigate: async (_c: string, url: string) => (calls.push(['navigate', url]), { url, title: opts.title ?? '', note: opts.note }),
    snapshot: async (_c: string, mode: string) => (calls.push(['snapshot', mode]), 'snap'),
    click: async (_c: string, t: any) => calls.push(['click', t]),
    type: async (_c: string, t: any, text: string, submit: boolean) => calls.push(['type', t, text, submit]),
    screenshot: async () => 'png',
    intent: async () => null,
  };
  const grants = {
    require: async () => {},
    act: async (url: string, _ctx: any, action: any) => {
      calls.push(['act', url, action]);
    },
  };
  const list = panelBrowserTools({ panel, grants, ...(opts.enabled ? { enabled: opts.enabled } : {}) });
  const by = Object.fromEntries(list.map((t: any) => [t.name, t.handler]));
  return { by, calls };
}

test('browser tools: navigate names the page, untitled pages too; snapshot as text', async () => {
  const { by, calls } = tools();
  assert.equal(await by.sage_browser_navigate({ url: 'https://a.com/' }, ctx), 'Opened https://a.com/');
  assert.equal(await by.sage_browser_snapshot({ mode: 'text' }, ctx), 'snap');
  assert.deepEqual(calls.at(-1), ['snapshot', 'text']);
  const titled = tools({ title: 'A' });
  assert.equal(await titled.by.sage_browser_navigate({ url: 'https://a.com/' }, ctx), 'Opened https://a.com/ (A)');
  // a link that downloaded a file instead of opening a page says so
  const file = tools({ note: 'A download started.' });
  assert.equal(await file.by.sage_browser_navigate({ url: 'https://a.com/' }, ctx), 'Opened https://a.com/. A download started.');
});

test('browser tools: click and type reach the panel by ref or selector', async () => {
  const { by, calls } = tools();
  assert.equal(await by.sage_browser_click({ ref: 'e1' }, ctx), 'Clicked e1');
  assert.equal(await by.sage_browser_click({ selector: '#b' }, ctx), 'Clicked #b');
  assert.equal(await by.sage_browser_type({ selector: '#i', text: 'hi', submit: 1 }, ctx), 'Typed into #i');
  assert.equal(await by.sage_browser_type({ ref: 'e2', text: 'x' }, ctx), 'Typed into e2');
  // each action is checked against the site's risk first (grants.act)
  assert.deepEqual(
    calls.filter((c) => c[0] === 'act').map((c) => c[2].tool),
    ['click', 'click', 'type', 'type'],
  );
  assert.deepEqual(calls.filter((c) => c[0] !== 'act').slice(-2), [
    ['type', { ref: undefined, selector: '#i' }, 'hi', true],
    ['type', { ref: 'e2', selector: undefined }, 'x', false],
  ]);
});

test('browser tools: switched off, every call is refused', async () => {
  const { by } = tools({ enabled: () => false });
  await assert.rejects(by.sage_browser_screenshot({}, ctx), (e: any) => e.code === 'disabled');
});
