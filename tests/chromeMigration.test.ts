import { extensionWire } from './support/extension-wire.ts';
// Your Chrome: prior Claude in Chrome use (the migration note) and the installed Playwright Extension version,
// both read from files, over a temp home.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  usedClaudeInChrome,
  installedExtensionVersion,
  extensionVersionCheck,
  compareVersions,
  chromeUserData,
  PLAYWRIGHT_EXTENSION_ID,
} = require('../electron/capabilities/browser/chromeMigration.cjs');
const { ChromeChannel, spawnSpec } = require('../electron/capabilities/browser/extension.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-mig-'));
const write = (file: string, text: string) => (fs.mkdirSync(path.dirname(file), { recursive: true }), fs.writeFileSync(file, text));

test('prior Claude in Chrome use: the config flag, or the native messaging host; nothing else', () => {
  const home = tmp();
  assert.equal(usedClaudeInChrome({ home, platform: 'darwin' }), false);
  write(path.join(home, '.claude.json'), JSON.stringify({ claudeInChromeDefaultEnabled: false }));
  assert.equal(usedClaudeInChrome({ home, platform: 'darwin' }), false);
  write(path.join(home, '.claude.json'), JSON.stringify({ claudeInChromeDefaultEnabled: true }));
  assert.equal(usedClaudeInChrome({ home, platform: 'darwin' }), true);

  const other = tmp();
  const hosts = path.join(chromeUserData({ home: other, platform: 'darwin' }), 'NativeMessagingHosts');
  write(path.join(hosts, 'com.example.other.json'), '{}');
  assert.equal(usedClaudeInChrome({ home: other, platform: 'darwin' }), false);
  write(path.join(hosts, 'com.anthropic.claude_browser_extension.json'), '{}');
  assert.equal(usedClaudeInChrome({ home: other, platform: 'darwin' }), true);
  // a broken config file is not use
  write(path.join(tmp(), '.claude.json'), '{nope');
  assert.equal(usedClaudeInChrome({ home: tmp(), platform: 'linux' }), false);
});

test('versions compare numerically, and an installed folder suffix is ignored', () => {
  assert.equal(compareVersions('0.0.9', '0.0.83'), -1);
  assert.equal(compareVersions('0.0.83_0', '0.0.83'), 0);
  assert.equal(compareVersions('1.0', '0.9.9'), 1);
});

test('installed extension version: the newest in the chosen profile, or in any profile', () => {
  const root = tmp();
  const ext = (profile: string, v: string, version = v) =>
    write(path.join(root, profile, 'Extensions', PLAYWRIGHT_EXTENSION_ID, `${v}_0`, 'manifest.json'), JSON.stringify({ version }));
  assert.equal(installedExtensionVersion({ userData: root }), null);
  ext('Default', '0.0.70');
  ext('Profile 1', '0.0.83');
  ext('Profile 1', '0.0.60');
  assert.equal(installedExtensionVersion({ userData: root }), '0.0.83');
  assert.equal(installedExtensionVersion({ userData: root, profileDir: 'Default' }), '0.0.70');
  assert.equal(installedExtensionVersion({ userData: root, profileDir: 'Profile 9' }), null);
  // no profile chosen: the one Chrome opens, not the newest anywhere
  write(path.join(root, 'Local State'), JSON.stringify({ profile: { last_used: 'Default' } }));
  assert.equal(installedExtensionVersion({ userData: root }), '0.0.70');
  write(path.join(root, 'Local State'), JSON.stringify({ profile: { last_used: '' } }));
  assert.equal(installedExtensionVersion({ userData: root }), '0.0.83');
  write(path.join(root, 'Local State'), '{');
  assert.equal(installedExtensionVersion({ userData: root }), '0.0.83');
});

test('version check: older than the pin warns; equal, newer or unknown do not', () => {
  assert.equal(extensionVersionCheck('0.0.70', '0.0.83').status, 'older');
  assert.match(extensionVersionCheck('0.0.70', '0.0.83').message!, /version 0\.0\.70.*tested with 0\.0\.83/);
  assert.equal(extensionVersionCheck('0.0.83', '0.0.83').status, 'ok');
  assert.equal(extensionVersionCheck('0.1.0', '0.0.83').status, 'ok');
  assert.deepEqual(extensionVersionCheck(null, '0.0.83'), { installed: null, pinned: '0.0.83', status: 'unknown', message: null });
});

test('the connection test reports the extension version against the pin', async () => {
  const fork = () => {
    const { EventEmitter } = require('node:events');
    const c: any = new EventEmitter();
    c.stderr = null;
    c.kill = () => c.emit('exit', 0);
    let output: (text: string) => unknown;
    c.postMessage = (m: any) => {
      if (m.type !== 'in') return;
      const msg = JSON.parse(m.data);
      if (msg.id == null) return;
      const result = msg.method === 'initialize' ? { protocolVersion: '2025-06-18' } : { content: [{ type: 'text', text: 'ok' }] };
      setImmediate(() => output(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n'));
    };
    output = extensionWire(c);
    return c;
  };
  const make = (installed: string | null) =>
    new ChromeChannel({
      fork,
      spec: () => spawnSpec({ outputDir: '/o', env: {} }),
      pinnedExtension: '0.0.83',
      extensionVersion: () => installed,
    });
  const old = await make('0.0.70').test();
  assert.equal(old.ok, true, 'a connected Chrome still works with an older extension');
  assert.match(old.message, /Connected to Chrome\. The Playwright Extension is version 0\.0\.70/);
  assert.equal(old.extension.status, 'older');
  assert.deepEqual((await make('0.0.83').test()).message, 'Connected to Chrome.');
  assert.equal((await make(null).test()).extension.status, 'unknown');
});
