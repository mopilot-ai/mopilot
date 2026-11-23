// Codex Browser Use settings (BU-06, electron/capabilities/browser/codexBrowserUse.cjs): $CODEX_HOME/browser/
// config.toml read and written the way the ChatGPT app and Codex's Browser plugin keep it, and Codex's
// managed policy (configRequirements/read, config.toml's browser_use) shown read only and enforced on write.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parse } = require('smol-toml');
const m = require('../electron/capabilities/browser/codexBrowserUse.cjs');
const {
  CodexBrowserUse,
  browserUseView,
  locksOf,
  policiesOf,
  sitesOf,
  withPreference,
  withRule,
  withoutSite,
  normalizeOrigin,
  listOf,
  CONFIG_FILE,
} = m;

const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sage-browser-use-'));
const file = (h: string) => path.join(h, CONFIG_FILE);
const write = (h: string, text: string) => {
  fs.mkdirSync(path.dirname(file(h)), { recursive: true });
  fs.writeFileSync(file(h), text);
};
const read = (h: string) => JSON.parse(JSON.stringify(parse(fs.readFileSync(file(h), 'utf8'))));
const OPEN = { all: null, approvalMode: null, historyMode: null, downloadMode: null, uploadMode: null, fullCdp: null, neverAsk: true };

test('origins are saved the way the ChatGPT app saves them', () => {
  assert.equal(normalizeOrigin('example.com'), 'https://example.com');
  assert.equal(normalizeOrigin('  http://a.test:8080/path?q '), 'http://a.test:8080');
  assert.equal(normalizeOrigin('ftp://x.test'), null);
  assert.equal(normalizeOrigin('https://'), null);
  assert.equal(normalizeOrigin(''), null);
  assert.equal(normalizeOrigin(undefined), null);
  assert.deepEqual(listOf({ allowed: [' a ', 'a', 3, '', 'b'] }, 'allowed'), ['a', 'b']);
  assert.deepEqual(listOf({ allowed: 'a' }, 'allowed'), []);
  assert.deepEqual(listOf(null, 'allowed'), []);
});

test('managed policy fixes what it covers, and nothing else', () => {
  assert.deepEqual(locksOf(null, null), OPEN);
  assert.deepEqual(locksOf(undefined, { browser_use: 'x' }), OPEN);
  const all = locksOf({ allowBrowserAndComputerUse: false }, null);
  assert.equal(all.all, 'Your organization turned off browser use for Codex.');
  const ask = locksOf({ browserUse: { allowGlobalPersistentApproval: false } }, null);
  assert.equal(ask.neverAsk, false);
  for (const k of ['approvalMode', 'downloadMode', 'uploadMode'])
    assert.deepEqual(ask[k], { value: 'always_ask', reason: 'Your organization requires Codex to ask each time.' });
  assert.deepEqual(locksOf({ browserUse: { allowHistoryAccess: false } }, { browser_use: { allow_history_access: false } }).historyMode, {
    value: 'disabled',
    reason: 'Your organization turned off browsing history access.',
  });
  assert.deepEqual(locksOf(null, { browser_use: { allow_history_access: false } }).historyMode, {
    value: 'disabled',
    reason: 'Turned off in config.toml (browser_use.allow_history_access).',
  });
  assert.deepEqual(locksOf({ featureRequirements: { browser_use_full_cdp_access: false } }, null).fullCdp, {
    value: false,
    reason: 'Your organization turned off full CDP access.',
  });
});

test('origin policies from requirements and config.toml are listed with where they come from', () => {
  const requirements = {
    browserUse: {
      defaultOriginPolicy: { access: 'deny', downloads: null, uploads: null, fullCdpAccess: null },
      origins: {
        'https://*.corp.test': { access: 'allow', downloads: 'deny', uploads: 'maybe', fullCdpAccess: 'deny', autoReview: 'deny' },
        'https://empty.test': { access: null },
        'https://bad.test': 'x',
      },
    },
  };
  const config = {
    browser_use: { default_origin_policy: null, origins: { 'https://own.test': { access: 'deny', full_cdp_access: 'allow' } } },
  };
  assert.deepEqual(policiesOf(requirements, config), [
    { pattern: '*', source: 'managed', browse: 'deny', downloads: null, uploads: null, debug: null },
    { pattern: 'https://*.corp.test', source: 'managed', browse: 'allow', downloads: 'deny', uploads: null, debug: 'deny' },
    { pattern: 'https://own.test', source: 'config', browse: 'deny', downloads: null, uploads: null, debug: 'allow' },
  ]);
  assert.deepEqual(policiesOf(null, null), []);
  assert.deepEqual(policiesOf({ browserUse: { origins: [] } }, { browser_use: { origins: 'x' } }), []);
});

test('saved sites merge every permission table; a denial wins over an allowance', () => {
  const data = {
    origins: { allowed: ['https://b.test', 'https://a.test'], denied: ['https://c.test'] },
    downloads: { allowed: ['https://a.test'], denied: ['https://a.test'] },
    uploads: { denied: ['https://b.test'] },
    full_cdp: { allowed: ['https://b.test'] },
    webmcp: { allowed: ['https://w.test'] },
  };
  assert.deepEqual(sitesOf(data), [
    { origin: 'https://a.test', browse: 'allow', downloads: 'deny', uploads: null, debug: null },
    { origin: 'https://b.test', browse: 'allow', downloads: null, uploads: 'deny', debug: 'allow' },
    { origin: 'https://c.test', browse: 'deny', downloads: null, uploads: null, debug: null },
  ]);
});

test('the view: each preference with its value, choices and lock', () => {
  const v = browserUseView({ approval_mode: 'never_ask', history_approval_mode: 'bogus', full_cdp_access_enabled: true });
  assert.equal(v.file, CONFIG_FILE);
  assert.equal(v.disabled, null);
  assert.equal(v.requirementsKnown, true);
  assert.deepEqual(v.prefs.approvalMode, { value: 'never_ask', options: ['always_ask', 'never_ask'], locked: null });
  assert.deepEqual(v.prefs.historyMode, { value: 'always_ask', options: ['always_ask', 'never_ask', 'disabled'], locked: null });
  assert.deepEqual(v.prefs.downloadMode.value, 'always_ask');
  assert.deepEqual(v.prefs.fullCdp, { value: true, options: [true, false], locked: null });
  assert.deepEqual(browserUseView({}).prefs.fullCdp.value, false);
  const managed = browserUseView(
    { approval_mode: 'never_ask', history_approval_mode: 'never_ask' },
    { requirements: { browserUse: { allowGlobalPersistentApproval: false } }, config: null, requirementsKnown: true },
  );
  assert.deepEqual(managed.prefs.approvalMode, {
    value: 'always_ask',
    options: ['always_ask'],
    locked: 'Your organization requires Codex to ask each time.',
  });
  // history keeps its own value, without auto-approve
  assert.deepEqual(managed.prefs.historyMode, { value: 'never_ask', options: ['always_ask', 'disabled'], locked: null });
  const off = browserUseView({}, { requirements: { allowBrowserAndComputerUse: false }, requirementsKnown: false });
  assert.equal(off.disabled, 'Your organization turned off browser use for Codex.');
  assert.equal(off.prefs.uploadMode.locked, off.disabled);
  assert.equal(off.requirementsKnown, false);
});

test('a preference is written only with a known value that policy allows', () => {
  assert.deepEqual(withPreference({ x: 1 }, 'approvalMode', 'never_ask', OPEN), { x: 1, approval_mode: 'never_ask' });
  assert.deepEqual(withPreference({}, 'fullCdp', true, OPEN), { full_cdp_access_enabled: true });
  const err = (fn: () => unknown, code: string, message?: RegExp) =>
    assert.throws(fn, (e: any) => e.code === code && (!message || message.test(e.message)));
  err(() => withPreference({}, 'nope', 'x', OPEN), 'invalid', /Unknown browser setting/);
  err(() => withPreference({}, 'historyMode', 'sometimes', OPEN), 'invalid', /Not a value/);
  err(() => withPreference({}, 'approvalMode', 'always_ask', { ...OPEN, all: 'off' }), 'locked', /^off$/);
  const fixed = locksOf(
    { featureRequirements: { browser_use_full_cdp_access: false }, browserUse: { allowGlobalPersistentApproval: false } },
    null,
  );
  err(() => withPreference({}, 'fullCdp', true, fixed), 'locked', /full CDP/);
  assert.deepEqual(withPreference({}, 'fullCdp', false, fixed), { full_cdp_access_enabled: false });
  err(() => withPreference({}, 'historyMode', 'never_ask', fixed), 'locked', /ask each time/);
  assert.deepEqual(withPreference({}, 'historyMode', 'disabled', fixed), { history_approval_mode: 'disabled' });
});

test('a rule moves an origin between allowed and denied, as the app does', () => {
  let d: any = {};
  d = withRule(d, 'browse', 'example.com', 'allow');
  assert.deepEqual(d.origins, { allowed: ['https://example.com'], denied: [] });
  d = withRule(d, 'browse', 'https://example.com', 'deny');
  assert.deepEqual(d.origins, { allowed: [], denied: ['https://example.com'] });
  // an origin already saved keeps its spelling (a pattern the plugin saved)
  d = { full_cdp: { allowed: ['https://\\*.x.test'], denied: ['other'] } };
  d = withRule(d, 'debug', 'https://\\*.x.test', 'deny');
  assert.deepEqual(d.full_cdp, { allowed: [], denied: ['other', 'https://\\*.x.test'] });
  d = withRule(d, 'debug', 'other', null);
  assert.deepEqual(d.full_cdp, { allowed: [], denied: ['https://\\*.x.test'] });
  // removing an origin that isn't there changes nothing else
  assert.deepEqual(withRule({ uploads: { allowed: ['a'] } }, 'uploads', 'not saved', null).uploads, { allowed: ['a'], denied: [] });
  const err = (fn: () => unknown, code: string) => assert.throws(fn, (e: any) => e.code === code);
  err(() => withRule({}, 'cookies', 'a.test', 'allow'), 'invalid');
  err(() => withRule({}, 'browse', 'a.test', 'maybe'), 'invalid');
  err(() => withRule({}, 'browse', 'ftp://a.test', 'allow'), 'invalid');
  err(() => withRule({}, 'browse', 'a.test', 'allow', { all: 'off' }), 'locked');
  err(() => withRule({ origins: 'x' }, 'browse', 'a.test', 'allow'), 'unreadable');
  err(() => withRule({ origins: { denied: 'x' } }, 'browse', 'a.test', 'allow'), 'unreadable');
  assert.equal(withRule({}, 'browse', 'a.test', 'allow').origins.allowed[0], 'https://a.test');
});

test('removing a site takes it out of every permission table, and leaves site tools alone', () => {
  const d = {
    origins: { allowed: ['https://a.test', 'https://b.test'] },
    downloads: { denied: ['https://a.test'] },
    webmcp: { allowed: ['https://a.test'] },
  };
  assert.deepEqual(withoutSite(d, 'https://a.test'), {
    origins: { allowed: ['https://b.test'], denied: [] },
    downloads: { allowed: [], denied: [] },
    webmcp: { allowed: ['https://a.test'] },
  });
});

test('the file: missing, written with other keys kept, and read back as a view', async () => {
  const h = home();
  const policy = async () => ({ requirements: null, config: null });
  const s = new CodexBrowserUse({ home: () => h, policy });
  assert.equal(s.file(), file(h));
  const empty = await s.state();
  assert.deepEqual(empty.sites, []);
  assert.equal(empty.prefs.approvalMode.value, 'always_ask');
  write(h, 'webmcp_enabled = true\ndisable_auto_review = false\n\n[webmcp]\nallowed = ["https://w.test"]\n');
  let v = await s.setPreference('approvalMode', 'never_ask');
  assert.equal(v.prefs.approvalMode.value, 'never_ask');
  v = await s.setRule('browse', 'example.com', 'allow');
  assert.deepEqual(v.sites, [{ origin: 'https://example.com', browse: 'allow', downloads: null, uploads: null, debug: null }]);
  v = await s.setRule('downloads', 'https://example.com', undefined);
  v = await s.forget('https://example.com');
  assert.deepEqual(v.sites, []);
  const saved = read(h);
  assert.equal(saved.webmcp_enabled, true);
  assert.equal(saved.disable_auto_review, false);
  assert.deepEqual(saved.webmcp, { allowed: ['https://w.test'] });
  assert.equal(saved.approval_mode, 'never_ask');
  assert.deepEqual(saved.origins, { allowed: [], denied: [] });
  assert.ok(fs.readFileSync(file(h), 'utf8').endsWith('\n'));
});

test('changes run one after another; a refused one leaves the file and the next change alone', async () => {
  const h = home();
  const s = new CodexBrowserUse({
    home: () => h,
    policy: async () => ({ requirements: { featureRequirements: { browser_use_full_cdp_access: false } }, config: null }),
  });
  const a = s.setRule('browse', 'a.test', 'allow');
  const b = s.setPreference('fullCdp', true);
  const c = s.setRule('browse', 'b.test', 'deny');
  assert.deepEqual(
    (await a).sites.map((x: any) => x.origin),
    ['https://a.test'],
  );
  await assert.rejects(b, (e: any) => e.code === 'locked');
  assert.deepEqual(
    (await c).sites.map((x: any) => [x.origin, x.browse]),
    [
      ['https://a.test', 'allow'],
      ['https://b.test', 'deny'],
    ],
  );
  assert.equal(read(h).full_cdp_access_enabled, undefined);
});

test('policy that cannot be read: the view says so, and nothing is locked by it', async () => {
  const h = home();
  const failing = new CodexBrowserUse({
    home: () => h,
    policy: async () => {
      throw new Error('Codex is down');
    },
  });
  const v = await failing.state();
  assert.equal(v.requirementsKnown, false);
  assert.equal(v.disabled, null);
  const unknown = new CodexBrowserUse({ home: () => h, policy: async () => ({ requirementsKnown: false }) });
  assert.equal((await unknown.state()).requirementsKnown, false);
  const nothing = new CodexBrowserUse({ home: () => h, policy: async () => undefined as any });
  assert.equal((await nothing.state()).requirementsKnown, true);
});

test('a file that is not TOML, or cannot be read or written, is reported and never overwritten', async () => {
  const h = home();
  write(h, 'approval_mode = \n');
  const s = new CodexBrowserUse({ home: () => h, policy: async () => ({}) });
  const v = await s.state();
  assert.equal(v.file, CONFIG_FILE);
  assert.match(v.error, /isn't valid TOML/);
  await assert.rejects(s.setPreference('approvalMode', 'never_ask'), (e: any) => e.code === 'unreadable');
  assert.equal(fs.readFileSync(file(h), 'utf8'), 'approval_mode = \n');
  // a read error other than a missing file
  const denied = new CodexBrowserUse({
    home: () => h,
    fs: {
      ...fs,
      readFileSync: () => {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      },
    } as any,
    policy: async () => ({}),
  });
  assert.match((await denied.state()).error, /Couldn't read .*permission denied/);
  // a write that fails
  const h2 = home();
  const full = new CodexBrowserUse({
    home: () => h2,
    fs: {
      ...fs,
      writeFileSync: () => {
        throw new Error('ENOSPC');
      },
    } as any,
    policy: async () => ({}),
  });
  await assert.rejects(full.setPreference('approvalMode', 'never_ask'), (e: any) => e.code === 'save_failed' && /ENOSPC/.test(e.message));
});

test('failed config renames retain the old file, remove temporary data, and allow retry', async () => {
  const h = home();
  write(h, '# original\n');
  const fileFs: typeof fs = {
    ...fs,
    renameSync: () => {
      throw new Error('rename failed');
    },
  };
  const settings = new CodexBrowserUse({ home: () => h, fs: fileFs, policy: async () => ({}) });
  try {
    await assert.rejects(settings.setPreference('approvalMode', 'never_ask'), /rename failed/);
    assert.equal(fs.readFileSync(file(h), 'utf8'), '# original\n');
    assert.deepEqual(fs.readdirSync(path.dirname(file(h))), ['config.toml']);
    fileFs.renameSync = fs.renameSync;
    const saved = await settings.setPreference('approvalMode', 'never_ask');
    assert.equal(saved.prefs.approvalMode.value, 'never_ask');
  } finally {
    fs.rmSync(h, { recursive: true, force: true });
  }
});

test('main-process site writes reject non-web URI schemes just like the settings page', () => {
  for (const input of ['mailto:user@example.com', 'custom:user@example.com']) {
    assert.equal(normalizeOrigin(input), null);
    assert.throws(
      () => withRule({}, 'browse', input, 'allow'),
      (error: any) => error.code === 'invalid',
    );
  }
  assert.equal(normalizeOrigin('http:example.com/path'), 'http://example.com');
  assert.equal(normalizeOrigin('localhost:3000/path'), 'https://localhost:3000');
});

test('reserved names are rejected as unknown browser settings and permission resources', () => {
  for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    assert.throws(() => withPreference({}, name, 'ask', OPEN), { code: 'invalid', message: `Unknown browser setting: ${name}` });
    assert.throws(() => withRule({}, name, 'https://a.test', 'allow', OPEN), {
      code: 'invalid',
      message: `Unknown site permission: ${name}`,
    });
  }
});
