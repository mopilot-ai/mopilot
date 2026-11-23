// Computer History's policy (#1363, electron/computerHistory/policy.cjs and exclusions.cjs): off by default, allow-list edits that refuse excluded apps and sites, settings read back fail closed, and the sample gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  BUILT_IN_BROWSER,
  DEFAULT_SETTINGS,
  MAX_APPS,
  MAX_SITES,
  normalizeSite,
  normalizeSettings,
  allowApp,
  allowSite,
  siteAllowed,
  isBrowser,
  admitSample,
} = require('../electron/computerHistory/policy.cjs');
const { appExclusion, siteExclusion, underDomain } = require('../electron/computerHistory/exclusions.cjs');

const on = (over = {}) => ({
  ...DEFAULT_SETTINGS,
  enabled: true,
  apps: [
    { bundleId: 'com.apple.Notes', name: 'Notes' },
    { bundleId: 'com.google.Chrome', name: 'Chrome' },
    { bundleId: BUILT_IN_BROWSER.bundleId, name: BUILT_IN_BROWSER.name },
  ],
  sites: ['example.com'],
  ...over,
});
const notes = (over = {}) => ({ bundleId: 'com.apple.Notes', name: 'Notes', title: 'Trip plan', secure: false, ...over });
const chrome = (url: string, over = {}) => ({
  bundleId: 'com.google.Chrome',
  name: 'Google Chrome',
  title: 'Docs',
  secure: false,
  url,
  ...over,
});

test('Computer History is off by default with empty allow lists and 30-day retention', () => {
  assert.deepEqual(normalizeSettings(undefined), DEFAULT_SETTINGS);
  assert.equal(DEFAULT_SETTINGS.enabled, false);
  assert.deepEqual(DEFAULT_SETTINGS.apps, []);
  assert.deepEqual(DEFAULT_SETTINGS.sites, []);
  assert.equal(DEFAULT_SETTINGS.retentionDays, 30);
  assert.deepEqual(admitSample(notes(), DEFAULT_SETTINGS), { drop: 'off' });
});

test('settings read from disk fail closed: malformed fields fall back to defaults, never to something more permissive', () => {
  const s = normalizeSettings({
    enabled: 'yes',
    paused: 1,
    retentionDays: 365,
    explainerSeen: 'true',
    apps: [
      null,
      'com.apple.Notes',
      { bundleId: 'not a bundle id' },
      { bundleId: 'com.apple.Notes', name: '  ' },
      { bundleId: 'com.apple.Notes', name: 'Duplicate' },
      { bundleId: 'com.1password.1password', name: '1Password' },
      { bundleId: BUILT_IN_BROWSER.bundleId, name: 'Built-in browser' },
    ],
    sites: ['Example.com', 'example.com', 42, 'chase.com', 'not a site', 'com'],
  });
  assert.equal(s.enabled, false);
  assert.equal(s.paused, false);
  assert.equal(s.retentionDays, 30);
  assert.equal(s.explainerSeen, false);
  assert.deepEqual(s.apps, [
    { bundleId: 'com.apple.Notes', name: 'com.apple.Notes' },
    { bundleId: BUILT_IN_BROWSER.bundleId, name: 'Built-in browser' },
  ]);
  assert.deepEqual(s.sites, ['example.com']);
  assert.deepEqual(normalizeSettings({ enabled: true, paused: true, retentionDays: 7, explainerSeen: true, apps: 'x', sites: {} }), {
    ...DEFAULT_SETTINGS,
    enabled: true,
    paused: true,
    retentionDays: 7,
    explainerSeen: true,
  });
  const many = normalizeSettings({
    apps: Array.from({ length: MAX_APPS + 5 }, (_, i) => ({ bundleId: `com.example.app${i}` })),
    sites: Array.from({ length: MAX_SITES + 5 }, (_, i) => `site${i}.example`),
  });
  assert.equal(many.apps.length, MAX_APPS);
  assert.equal(many.sites.length, MAX_SITES);
});

test('a typed site becomes the host the allow list keeps', () => {
  assert.equal(normalizeSite('https://www.Example.com/path?q=1'), 'example.com');
  assert.equal(normalizeSite(' docs.example.com. '), 'docs.example.com');
  assert.equal(normalizeSite('localhost'), 'localhost');
  assert.equal(normalizeSite('com'), null);
  assert.equal(normalizeSite('mailto:me@example.com'), null, 'a scheme that only looks like a host is no site');
  assert.equal(normalizeSite('example.com:8443/x'), 'example.com');
  assert.equal(normalizeSite(''), null);
  assert.equal(normalizeSite(null), null);
  assert.equal(normalizeSite('two words.com'), null);
  assert.equal(normalizeSite('http://[bad'), null);
});

test('allowing an app refuses MoPilot, password managers, auth prompts and the user deny list, in the store', () => {
  for (const bundleId of [
    'ai.mopilot.code',
    'ai.mopilot.code.helper',
    'com.github.Electron',
    'com.1password.1password',
    'com.apple.SecurityAgent',
    'com.apple.keychainaccess',
    'com.apple.ScreenSaver.Engine',
  ]) {
    const r = allowApp(DEFAULT_SETTINGS, { bundleId, name: 'x' });
    assert.equal(r.ok, false, bundleId);
    assert.match(r.reason, /never records this app/);
  }
  const denied = allowApp(DEFAULT_SETTINGS, { bundleId: 'com.example.secret' }, ['com.example.*']);
  assert.equal(denied.ok, false);
  assert.match(denied.reason, /blocked in Settings → Computer use/);
  assert.deepEqual(allowApp(DEFAULT_SETTINGS, null), { ok: false, reason: 'Not an app' });
  assert.deepEqual(allowApp(DEFAULT_SETTINGS, { bundleId: 'bad id' }), { ok: false, reason: 'Not an app' });

  const r = allowApp(DEFAULT_SETTINGS, { bundleId: 'com.apple.Notes', name: ' Notes ' });
  assert.ok(r.ok);
  assert.deepEqual(r.settings.apps, [{ bundleId: 'com.apple.Notes', name: 'Notes' }]);
  assert.equal(allowApp(r.settings, { bundleId: 'com.apple.Notes' }).settings, r.settings, 'already allowed: unchanged');
  assert.deepEqual(allowApp(DEFAULT_SETTINGS, { bundleId: 'com.apple.Notes' }).settings.apps, [
    { bundleId: 'com.apple.Notes', name: 'com.apple.Notes' },
  ]);
  assert.ok(allowApp(DEFAULT_SETTINGS, BUILT_IN_BROWSER).ok, 'the built-in browser is not MoPilot itself');
  const full = { ...DEFAULT_SETTINGS, apps: Array.from({ length: MAX_APPS }, (_, i) => ({ bundleId: `com.example.a${i}`, name: 'a' })) };
  assert.deepEqual(allowApp(full, { bundleId: 'com.apple.Notes' }), { ok: false, reason: `At most ${MAX_APPS} apps` });
});

test('allowing a site refuses banking, payments, health, sign-in and MoPilot sites', () => {
  for (const site of [
    'chase.com',
    'www.paypal.com',
    'mybank.example',
    'mychart.example.org',
    'cvs.com',
    'myhealth.example',
    'accounts.google.com',
    'login.example.com',
    'mopilot.ai',
    'app.mopilot.ai',
    '192.168.1.1',
  ]) {
    const r = allowSite(DEFAULT_SETTINGS, site);
    assert.equal(r.ok, false, site);
    assert.match(r.reason, /never records this site/);
  }
  assert.deepEqual(allowSite(DEFAULT_SETTINGS, 'com'), { ok: false, reason: 'Not a site' });
  const r = allowSite(DEFAULT_SETTINGS, 'https://www.example.com/x');
  assert.ok(r.ok);
  assert.equal(r.site, 'example.com');
  assert.deepEqual(r.settings.sites, ['example.com']);
  assert.equal(allowSite(r.settings, 'example.com').settings, r.settings);
  const full = { ...DEFAULT_SETTINGS, sites: Array.from({ length: MAX_SITES }, (_, i) => `s${i}.example`) };
  assert.deepEqual(allowSite(full, 'example.com'), { ok: false, reason: `At most ${MAX_SITES} sites` });
});

test('site and domain matching is exact or on a dot boundary', () => {
  assert.equal(siteAllowed(['example.com'], 'example.com'), true);
  assert.equal(siteAllowed(['example.com'], 'docs.example.com'), true);
  assert.equal(siteAllowed(['example.com'], 'badexample.com'), false);
  assert.equal(siteAllowed(['example.com'], 'example.com.evil.net'), false);
  assert.equal(underDomain('notchase.com', 'chase.com'), false);
  assert.equal(siteExclusion('https://notcvs.com/'), null);
  assert.equal(siteExclusion('https://shop.cvs.com/'), 'Health site');
});

test('exclusions name a reason, and anything that is not an http(s) page is excluded', () => {
  assert.equal(appExclusion(undefined), 'unknown app');
  assert.equal(appExclusion('com.apple.Notes'), null);
  assert.equal(appExclusion('com.apple.Notes', [42 as unknown as string, 'com.apple.Notes']), 'blocked in Settings → Computer use');
  assert.equal(appExclusion('com.github.Electron.helper'), 'MoPilot');
  assert.equal(siteExclusion('not a url'), 'not a web page');
  assert.equal(siteExclusion('file:///etc/passwd'), 'not a web page');
  assert.equal(siteExclusion('https://user:pw@example.com/'), 'sign-in details in the address');
  assert.equal(siteExclusion('https://github.com/settings/tokens'), 'Sign-in page');
  assert.equal(siteExclusion('https://github.com/login'), 'Sign-in page');
  assert.equal(siteExclusion('https://github.com/mopilot-ai/mopilot-internal'), null);
  assert.equal(siteExclusion('https://github.com/settingsx'), null);
  assert.equal(siteExclusion('https://github.com/Settings/tokens'), 'Sign-in page', 'paths compare in lower case');
  assert.equal(siteExclusion('https://github.com/%73ettings/tokens'), 'Sign-in page', 'and decoded');
  assert.equal(siteExclusion('https://sso.example.com/'), 'Sign-in page');
  assert.equal(siteExclusion('https://www.mopilot.ai/'), 'MoPilot');
  assert.equal(siteExclusion('http://169.254.169.254/latest'), 'Cloud metadata endpoint');
  assert.equal(siteExclusion('https://example.com/'), null);
});

test('the gate keeps an allowed app with its redacted title and drops everything it cannot verify', () => {
  assert.deepEqual(admitSample(notes({ title: 'Trip <plan>' }), on()), {
    activity: { bundleId: 'com.apple.Notes', app: 'Notes', title: 'Trip ‹plan›' },
  });
  assert.deepEqual(admitSample(notes({ name: '' }), on()), { activity: { bundleId: 'com.apple.Notes', app: 'Notes', title: 'Trip plan' } });
  assert.deepEqual(
    admitSample(notes({ url: 'https://chase.com/' }), on()).activity,
    { bundleId: 'com.apple.Notes', app: 'Notes', title: 'Trip plan' },
    'a non-browser keeps no URL',
  );
  assert.deepEqual(admitSample(notes(), on({ paused: true })), { drop: 'paused' });
  assert.deepEqual(admitSample(null, on()), { drop: 'invalid' });
  assert.deepEqual(admitSample(notes({ bundleId: 42 }), on()), { drop: 'invalid' });
  assert.deepEqual(admitSample(notes({ secure: undefined }), on()), { drop: 'invalid' }, 'an unknown secure state fails closed');
  assert.deepEqual(admitSample(notes({ secure: true }), on()), { drop: 'secure field' });
  assert.deepEqual(admitSample(notes({ bundleId: 'com.apple.TextEdit' }), on()), { drop: 'app not allowed' });
  assert.deepEqual(admitSample(notes(), on(), { userDeny: ['com.apple.Notes'] }), { drop: 'excluded app' });
  assert.deepEqual(
    admitSample({ ...notes(), bundleId: BUILT_IN_BROWSER.bundleId }, on()),
    { drop: 'invalid' },
    'only main may report the built-in browser',
  );
  assert.deepEqual(admitSample(notes({ source: 'iab' }), on()), { drop: 'invalid' });
});

test('a browser sample is kept only for an allowed, non-excluded site, without query or fragment', () => {
  assert.deepEqual(admitSample(chrome('https://docs.example.com/a/b?token=abc#frag'), on()), {
    activity: { bundleId: 'com.google.Chrome', app: 'Google Chrome', title: 'Docs', site: 'docs.example.com', path: '/a/b' },
  });
  assert.deepEqual(admitSample(chrome('https://other.net/'), on()), { drop: 'site not allowed' });
  assert.deepEqual(admitSample(chrome('https://chase.com/'), on({ sites: ['chase.com'] })), { drop: 'excluded site' });
  assert.deepEqual(admitSample(chrome(undefined as unknown as string), on()), { drop: 'no site' });
  assert.deepEqual(admitSample(chrome('chrome://settings'), on()), { drop: 'excluded site' });
  const iab = {
    bundleId: BUILT_IN_BROWSER.bundleId,
    name: '',
    title: 'Example',
    secure: false,
    url: 'https://example.com/',
    source: 'iab',
  };
  assert.deepEqual(admitSample(iab, on()).activity, {
    bundleId: BUILT_IN_BROWSER.bundleId,
    app: 'Built-in browser',
    title: 'Example',
    site: 'example.com',
    path: '/',
  });
  assert.equal(isBrowser('com.apple.Safari'), true);
  assert.equal(isBrowser('com.apple.Notes'), false);
});
