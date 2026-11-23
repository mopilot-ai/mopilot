// Plugins a harness installed itself (electron/plugins/native.cjs): Claude Code's from installed_plugins.json, Codex's
// from its plugin cache (newest version, without its bundled ones or MoPilot's own mirror), each id once.
// Data is made up; folders are temporary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { nativePlugins, NOT_THE_USERS } = require('../electron/plugins/native.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-native-'));
const mkdir = (p: string) => (fs.mkdirSync(p, { recursive: true }), p);

test("Claude Code's and Codex's own plugins, each id once, Claude Code's first", () => {
  const claudeDir = tmp();
  const codexHome = tmp();
  const stripe = mkdir(path.join(claudeDir, 'plugins/cache/official/stripe/0.10.3'));
  fs.writeFileSync(
    path.join(claudeDir, 'plugins/installed_plugins.json'),
    JSON.stringify({
      version: 2,
      plugins: {
        'stripe@official': [
          { scope: 'project', installPath: '/gone' },
          { scope: 'user', installPath: stripe },
        ],
        'gone@official': [{ installPath: '/nowhere' }],
        'odd@official': 'not a list',
        'bad id': [{ installPath: stripe }],
        'junk@official': [null, { installPath: 3 }],
      },
    }),
  );
  const cache = path.join(codexHome, 'plugins/cache');
  mkdir(path.join(cache, 'official/stripe/0.10.3'));
  const older = mkdir(path.join(cache, 'curated/gmail/1'));
  const newer = mkdir(path.join(cache, 'curated/gmail/2'));
  fs.utimesSync(older, new Date(1000), new Date(1000));
  fs.utimesSync(newer, new Date(2000), new Date(2000));
  mkdir(path.join(cache, 'curated/empty'));
  mkdir(path.join(cache, 'curated/.hidden/1'));
  mkdir(path.join(cache, 'mopilot-acme/tidy/1'));
  mkdir(path.join(cache, 'openai-bundled/browser/1'));
  mkdir(path.join(cache, 'openai-primary-runtime/pdf/1'));
  mkdir(path.join(cache, 'bad name/x/1'));
  // a cache folder Codex no longer lists in its config is a leftover of an uninstall
  mkdir(path.join(cache, 'curated/leftover/1'));
  fs.writeFileSync(
    path.join(codexHome, 'config.toml'),
    '[plugins."gmail@curated"]\nenabled = true\n\n[plugins."stripe@official"]\nenabled = true\n\n[plugins."browser@openai-bundled"]\nenabled = true\n',
  );
  assert.deepEqual(nativePlugins({ claudeDir, codexHome }), [
    { id: 'gmail@curated', name: 'gmail', marketplace: 'curated', path: newer, harness: 'codex' },
    { id: 'stripe@official', name: 'stripe', marketplace: 'official', path: stripe, harness: 'claude' },
  ]);
});

test('harnesses with nothing installed have nothing to offer', () => {
  assert.deepEqual(nativePlugins({ claudeDir: tmp(), codexHome: tmp() }), []);
  const claudeDir = tmp();
  mkdir(path.join(claudeDir, 'plugins'));
  fs.writeFileSync(path.join(claudeDir, 'plugins/installed_plugins.json'), '{"plugins": []}');
  assert.deepEqual(nativePlugins({ claudeDir, codexHome: tmp() }), []);
});

test("Codex's config: none means nothing installed, one without plugins too, one that doesn't parse is an error", () => {
  const codexHome = tmp();
  mkdir(path.join(codexHome, 'plugins/cache/curated/gmail/1'));
  assert.deepEqual(nativePlugins({ claudeDir: tmp(), codexHome }), []);
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "x"\n');
  assert.deepEqual(nativePlugins({ claudeDir: tmp(), codexHome }), []);
  fs.writeFileSync(path.join(codexHome, 'config.toml'), '[plugins\n');
  assert.throws(() => nativePlugins({ claudeDir: tmp(), codexHome }));
  fs.rmSync(path.join(codexHome, 'config.toml'));
  fs.mkdirSync(path.join(codexHome, 'config.toml'));
  assert.throws(() => nativePlugins({ claudeDir: tmp(), codexHome }), /EISDIR/);
});

test('a Codex cache that cannot be read is an error, not an empty list', () => {
  const codexHome = tmp();
  fs.mkdirSync(path.join(codexHome, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'plugins/cache'), 'a file');
  assert.throws(() => nativePlugins({ claudeDir: tmp(), codexHome }), /ENOTDIR/);
});

test('which Codex marketplaces are not the user’s', () => {
  assert.equal(NOT_THE_USERS('mopilot-acme'), true);
  assert.equal(NOT_THE_USERS('openai-bundled'), true);
  assert.equal(NOT_THE_USERS('openai-primary-runtime'), true);
  assert.equal(NOT_THE_USERS('openai-curated'), false);
});
