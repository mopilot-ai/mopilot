// Name this Chrome and Site permissions (#1986 PR 5): the pairing's name (chromePairing.cjs), the channel's rename and status (chromeExtension.cjs), main's settings owner (app/chromeBrowserSettings.cjs), the name in Settings' extension row, and the options page's tabs (src/optionsTabs.mjs).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { memoryPairing, fakeChromeApi } from './support/chrome-extension-kit.ts';
import { el } from './support/side-panel-page.ts';

const require = createRequire(import.meta.url);
const { ChromePairing, NAME_MAX } = require('../electron/capabilities/browser/chromePairing.cjs');
const { browserSettings } = require('../electron/app/chromeBrowserSettings.cjs');
const { chromeRelayHealth } = require('../electron/capabilities/capabilityHealth.cjs');
const { extensionStatus } = require('../electron/capabilities/nativeAvailability/status.cjs');
const appRelay = require('../electron/app/chromeRelay.cjs');
const { OptionsTabs, TABS, SHORTCUTS_PAGE, LEVEL_TEXT, settingsOf } = await import('../electron/chrome-extension/src/optionsTabs.mjs');

const tick = () => new Promise((r) => setTimeout(r, 0));
const safeStorage = (on = true) => ({
  isEncryptionAvailable: () => on,
  encryptString: (s: string) => Buffer.from(`enc:${s}`),
  decryptString: (b: Buffer) => b.toString().slice(4),
});

test('the pairing’s name: trimmed, 1 to 80 characters, saved with it, kept when a new port makes a new secret', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-name-')), 'p.json');
  const p = new ChromePairing({ file, safeStorage: safeStorage() });
  assert.throws(() => p.rename('Work'), /Connect this Chrome first/);
  p.forPort(47615);
  for (const bad of ['', '   ', 'x'.repeat(NAME_MAX + 1), 5, null]) assert.throws(() => p.rename(bad), /1 to 80 characters/);
  assert.equal(p.rename('  Work laptop  '), 'Work laptop');
  assert.equal(new ChromePairing({ file, safeStorage: safeStorage() }).get().name, 'Work laptop', 'on disk');
  const moved = p.forPort(50000);
  assert.equal(moved.name, 'Work laptop');
  // a failed save keeps the name as it was
  fs.rmSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(path.dirname(file), 'not a folder');
  assert.throws(() => p.rename('Other'));
  assert.equal(p.get().name, 'Work laptop');
  // no name saved: none read
  const plain = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-name-')), 'p.json');
  const q = new ChromePairing({ file: plain, safeStorage: safeStorage() });
  q.forPort(1);
  assert.equal('name' in new ChromePairing({ file: plain, safeStorage: safeStorage() }).get(), false);
});

test('Allow with a name renames the pairing only while the question is up; Not now never does', () => {
  const pairing = memoryPairing({ secret: 'S'.repeat(43), port: 1, paired: true });
  let asking = false;
  const answerAsk = mock.fn(() => true);
  const setup = { kind: 'extension', relay: { status: () => ({ asking }), answerAsk }, pairing };
  assert.equal(appRelay.answerChromeAsk(setup, true, 'Ignored'), true);
  assert.equal(appRelay.chromeName(pairing), null, 'no question up: the name isn’t touched');
  asking = true;
  appRelay.answerChromeAsk(setup, true, 'Studio');
  assert.equal(appRelay.chromeName(pairing), 'Studio');
  appRelay.answerChromeAsk(setup, false, 'No');
  appRelay.answerChromeAsk(setup, true);
  assert.equal(appRelay.chromeName(pairing), 'Studio');
  assert.deepEqual(
    answerAsk.mock.calls.map((c: any) => c.arguments),
    [[true], [true], [false], [true]],
  );
  // a name that can't be kept never costs the pairing: noted, and Allow still answers
  asking = true;
  const warn = mock.method(console, 'warn', () => undefined);
  try {
    assert.equal(appRelay.answerChromeAsk(setup, true, '  '), true);
  } finally {
    warn.mock.restore();
  }
  assert.equal(appRelay.chromeName(pairing), 'Studio');
  // a pairing that can't be read has no name
  assert.equal(
    appRelay.chromeName({
      get: () => {
        throw new Error('unreadable');
      },
    }),
    null,
  );
  assert.equal(appRelay.chromeName(null), null);
});

test('browserSettings: only on the extension channel; a name, a saved site revoked, nothing ever allowed', () => {
  const sites = new Map<string, string>([['https://a.example', 'write']]);
  const grants = {
    list: () => [...sites].map(([origin, level]) => ({ origin, level })),
    set: mock.fn((origin: string) => sites.delete(origin)),
  };
  const setup = { kind: 'extension', pairing: memoryPairing({ secret: 'S'.repeat(43), port: 1, paired: true }) };
  assert.throws(() => browserSettings({ setup: { kind: 'relay' }, grants }, {}), /isn't serving this Chrome/);
  assert.throws(() => browserSettings({ setup: { kind: 'extension', pairing: null }, grants }, {}), /isn't serving this Chrome/);
  assert.throws(() => browserSettings({ setup, grants: null }, {}), /isn't serving this Chrome/);
  assert.deepEqual(browserSettings({ setup, grants }, {}), { name: null, sites: [{ origin: 'https://a.example', level: 'write' }] });
  assert.equal(browserSettings({ setup, grants }, { name: 'Work' }).name, 'Work');
  for (const revoke of ['https://b.example', 5]) assert.throws(() => browserSettings({ setup, grants }, { revoke }), /no longer saved/);
  assert.deepEqual(browserSettings({ setup, grants }, { revoke: 'https://a.example' }).sites, []);
  assert.deepEqual(grants.set.mock.calls[0].arguments, ['https://a.example', null]);
});

test('the name reaches Settings’ extension row while connected: facts, health and the row’s label', () => {
  const flags = (k: string) => k === 'shared.browser.chromeExtension';
  const setup = (name?: string) => ({
    kind: 'extension',
    relay: { status: () => ({ paired: true, connected: true }) },
    inProfile: () => null,
    pairing: memoryPairing({ secret: 'S'.repeat(43), port: 1, paired: true, ...(name ? { name } : {}) }),
  });
  const facts = (s: any) => appRelay.chromeRelayFacts({ isFlagEnabled: flags, setup: s, installedVersion: () => null, extensionUrl: 'u' });
  assert.equal(facts(setup('Work')).name, 'Work');
  assert.equal('name' in facts(setup()), false);
  assert.equal('name' in facts(null), false);
  const health = chromeRelayHealth({ enabled: true, running: true, kind: 'extension', connected: true, name: 'Work' });
  assert.equal(health.name, 'Work');
  const unnamed = chromeRelayHealth({ enabled: true, running: true, kind: 'extension', connected: true });
  assert.equal('name' in unnamed, false);
  assert.equal(extensionStatus({ ...health, channel: 'extension' }).label, 'Connected as Work');
  assert.equal(extensionStatus({ ...unnamed, channel: 'extension' }).label, 'Connected');
});

/** The options page's tabs on a fake page and Chrome. */
function tabsPage(reply: (m: any) => any = () => ({ status: 'connected', result: { name: 'Work', sites: [] } })) {
  const els: Record<string, any> = {};
  const document: any = {
    getElementById: (id: string) => (els[id] ??= el()),
    createElement: (tag: string) => el(tag),
    activeElement: null,
  };
  const chrome: any = fakeChromeApi();
  chrome.reply = reply;
  const t = new OptionsTabs({ document, chrome });
  const panels = () => chrome.log.filter((l: any) => l[0] === 'runtime.sendMessage').map((l: any) => l[1]);
  return { t, els, chrome, document, panels };
}

test('options tabs: click and the ARIA keys select one tab at a time; Connection and Site permissions read the settings, Shortcuts the shortcut', async () => {
  const p = tabsPage();
  await p.t.select('connection');
  assert.equal(p.els['connection-tab'].attrs['aria-selected'], 'true');
  assert.equal(p.els['connection-tab'].tabIndex, 0);
  assert.equal(p.els.sites.hidden, true);
  assert.deepEqual(p.panels().at(-1), { type: 'panel', method: 'browserSettings', params: {} });
  assert.equal(p.els['chrome-name'].value, 'Work');
  p.els['sites-tab'].listeners.click();
  await tick();
  assert.equal(p.els.sites.hidden, false);
  assert.equal(p.els.connection.hidden, true);
  assert.equal(p.els['sites-empty'].hidden, false);
  // the keys: Right wraps, Left back, Home and End; others are left alone
  const key = (tab: string, k: string) => {
    const e = { key: k, preventDefault: mock.fn() };
    p.els[`${tab}-tab`].listeners.keydown(e);
    return e.preventDefault.mock.callCount();
  };
  key('sites', 'ArrowRight');
  await tick();
  assert.equal(p.els.shortcuts.hidden, false);
  assert.equal(p.els.shortcut.textContent, '⌘E');
  assert.ok(p.els['shortcuts-tab'].focused > 0);
  key('shortcuts', 'ArrowRight');
  assert.equal(p.els.connection.hidden, false);
  key('connection', 'ArrowLeft');
  assert.equal(p.els.shortcuts.hidden, false);
  key('shortcuts', 'Home');
  assert.equal(p.els.connection.hidden, false);
  key('connection', 'End');
  assert.equal(p.els.shortcuts.hidden, false);
  assert.equal(key('shortcuts', 'a'), 0);
  // a name Chrome couldn't give (another extension took the key), and Change shortcuts
  p.chrome.commands.getAll = async () => [{ name: '_execute_action', shortcut: '' }];
  await p.t.select('shortcuts');
  assert.equal(p.els.shortcut.textContent, 'Not set');
  p.els['shortcuts-open'].listeners.click();
  assert.deepEqual(p.chrome.log.filter((l: any) => l[0] === 'tabs.create').at(-1), ['tabs.create', { url: SHORTCUTS_PAGE }]);
  // failures say so
  p.chrome.commands.getAll = async () => {
    throw new Error('no commands');
  };
  await p.t.select('shortcuts');
  assert.equal(p.els['settings-error'].textContent, 'no commands');
  p.chrome.tabs.create = async () => {
    throw new Error('blocked');
  };
  p.els['shortcuts-open'].listeners.click();
  await tick();
  assert.equal(p.els['settings-error'].textContent, 'blocked');
  // an unknown name is the first tab
  await p.t.select('nope');
  assert.equal(p.els.connection.hidden, false);
  assert.deepEqual(TABS, ['connection', 'sites', 'shortcuts']);
});

test('options tabs: the saved sites list with Revoke; Save name checks the name, keeps a name being typed, and one change at a time', async () => {
  let sites = [
    { origin: 'https://a.example', level: 'read' },
    { origin: 'https://b.example', level: 'write' },
    { origin: 5, level: 'read' },
    { origin: 'https://c.example', level: 'admin' },
  ];
  let name = 'Work';
  let hold: Promise<void> | null = null;
  const p = tabsPage(async (m: any) => {
    if (hold) await hold;
    if (m.params?.name) name = m.params.name;
    if (m.params?.revoke) sites = sites.filter((s) => s.origin !== m.params.revoke);
    return { status: 'connected', result: { name, sites } };
  });
  await p.t.select('sites');
  const rows = p.els['sites-list'].children;
  assert.deepEqual(
    rows.map((r: any) => r.children.map((c: any) => c.textContent)),
    [
      ['https://a.example', LEVEL_TEXT.read, 'Revoke'],
      ['https://b.example', LEVEL_TEXT.write, 'Revoke'],
    ],
    'only well-formed sites',
  );
  assert.equal(rows[0].children[2].attrs['aria-label'], 'Revoke https://a.example');
  rows[0].children[2].listeners.click();
  await tick();
  assert.deepEqual(p.panels().at(-1).params, { revoke: 'https://a.example' });
  assert.equal(p.els['sites-list'].children.length, 1);
  // Save name: checked here first
  const submit = () => {
    const e = { preventDefault: mock.fn() };
    p.els['name-form'].listeners.submit(e);
    return e;
  };
  p.els['chrome-name'].value = '   ';
  assert.equal(submit().preventDefault.mock.callCount(), 1);
  await tick();
  assert.equal(p.els['settings-error'].textContent, 'Use a name of 1 to 80 characters.');
  p.els['chrome-name'].value = ' Studio ';
  let open!: () => void;
  hold = new Promise((r) => (open = r));
  submit();
  await tick();
  assert.equal(p.els['save-name'].disabled, true, 'busy while it saves');
  assert.equal(p.els['sites-list'].children[0].children[2].disabled, true, 'Revoke too');
  // a change can't start while one runs
  await p.t.revoke('https://b.example');
  hold = null;
  open();
  await tick();
  await tick();
  assert.equal(p.els['save-name'].disabled, false);
  assert.equal(name, 'Studio');
  assert.equal(p.els['chrome-name'].value, 'Studio');
  assert.equal(p.panels().filter((m: any) => m.params?.revoke === 'https://b.example').length, 0);
  // a read doesn't overwrite a name being typed
  p.document.activeElement = p.els['chrome-name'];
  p.els['chrome-name'].value = 'Half-typ';
  await p.t.load();
  assert.equal(p.els['chrome-name'].value, 'Half-typ');
});

test('options tabs: not connected says to connect; MoPilot’s own error is shown; an answer not shaped right, or overtaken, is not', async () => {
  let answer: any = { status: 'offline', error: "MoPilot isn't connected." };
  const p = tabsPage(() => answer);
  // Connection: its own line says why; no error, and the name waits for the connection
  await p.t.select('connection');
  assert.equal(p.els['settings-error'].hidden, true);
  assert.equal(p.els['name-form'].hidden, true);
  await p.t.select('sites');
  assert.equal(p.els['settings-error'].textContent, 'Connect to MoPilot to see these settings.');
  assert.equal(p.els['settings-error'].hidden, false);
  answer = { status: 'connected', error: 'Use a name of 1 to 80 characters.' };
  await p.t.load();
  assert.equal(p.els['settings-error'].textContent, 'Use a name of 1 to 80 characters.');
  answer = { status: 'connected', result: { name: 5, sites: [] } };
  await p.t.load();
  assert.equal(p.els['settings-error'].textContent, "Couldn't read these settings. Try again.");
  answer = { status: 'connected', result: { name: null, sites: [] } };
  await p.t.load();
  assert.equal(p.els['settings-error'].hidden, true);
  assert.equal(p.els['name-form'].hidden, false);
  assert.equal(p.els['chrome-name'].value, '');
  // two reads: the first's late answer is dropped, as is its late failure
  let first = true;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  p.chrome.reply = async () => {
    if (first) {
      first = false;
      await gate;
      throw new Error('late failure');
    }
    return { status: 'connected', result: { name: 'Now', sites: [] } };
  };
  const late = p.t.load();
  await p.t.load();
  release();
  await late;
  assert.equal(p.els['chrome-name'].value, 'Now');
  assert.equal(p.els['settings-error'].hidden, true);
  assert.equal(settingsOf(null), null);
  assert.equal(settingsOf({ name: 'x' }), null);
});
