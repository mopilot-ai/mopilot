// How a CLI install is named in Settings: its version and how it was installed, in words instead of its full path.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { installSource, sourceOfBin, installLine, offPathNote } = await import('../src/lib/cliSource.ts');

test('how an install was made, in words: one for every way main tells installs apart', () => {
  assert.equal(installSource('self', 'standalone install'), 'Native installer');
  assert.equal(installSource('brew', 'Homebrew cask'), 'Homebrew');
  assert.equal(installSource('npm', 'npm (~/.npm-global)'), 'npm');
  // a version manager's npm is still npm
  assert.equal(installSource('npm', 'a version manager'), 'npm');
  assert.equal(installSource('bun', 'bun'), 'bun');
  assert.equal(installSource('pnpm', 'pnpm'), 'pnpm');
  assert.equal(installSource('app-bundle', 'ChatGPT.app'), 'Bundled with ChatGPT.app');
  assert.equal(installSource('app-bundle', 'Claude.app'), 'Bundled with Claude.app');
  assert.equal(installSource('app-bundle', ''), 'Bundled with an app');
  assert.equal(installSource('unknown', ''), 'Installed manually');
  // a way a newer main knows and this window doesn't: still no path
  assert.equal(installSource('nix', ''), 'Installed manually');
  // nor a name every object has
  assert.equal(installSource('constructor', ''), 'Installed manually');
  assert.equal(installSource('toString', ''), 'Installed manually');
  // main hasn't said: nothing rather than a guess
  assert.equal(installSource(undefined), null);
  assert.equal(installSource(null, null), null);
});

test("the binary in use: a path the user set that isn't an install found reads Custom location", () => {
  const installs = [
    { path: '/a/claude', version: '2.1.302', via: 'self', from: 'standalone install' },
    { path: '/b/claude', version: '2.1.296', via: 'npm', from: 'npm (/usr/local)' },
    // an older main: no via
    { path: '/c/claude', version: '1.0', extra: true },
  ];
  assert.equal(sourceOfBin('/a/claude', { installs }), 'Native installer');
  assert.equal(sourceOfBin('/b/claude', { installs, manual: '/b/claude' }), 'npm', 'an install picked from the list keeps its words');
  assert.equal(sourceOfBin('/w/wrapper', { installs, manual: '/w/wrapper' }), 'Custom location');
  assert.equal(sourceOfBin('/w/wrapper', { installs: null, manual: '/w/wrapper' }), 'Custom location');
  // a path set that no longer exists: main runs the one it found, which keeps its own words
  assert.equal(sourceOfBin('/a/claude', { installs, manual: '/gone' }), 'Native installer');
  // no via on the install: main's update check of that same binary says
  const checked = { bin: '/c/claude', via: 'brew', from: 'Homebrew' };
  assert.equal(sourceOfBin('/c/claude', { installs, checked }), 'Homebrew');
  // an update check of another binary says nothing about this one
  assert.equal(sourceOfBin('/c/claude', { installs, checked: { ...checked, bin: '/a/claude' } }), null);
  assert.equal(sourceOfBin('/c/claude', { installs, checked: null }), null);
  assert.equal(sourceOfBin(null, { installs }), null);
  assert.equal(sourceOfBin('/x/opencode', { checked: { bin: '/x/opencode', via: 'unknown', from: '' } }), 'Installed manually');
});

test('one line for an install, no "v": its version, then how it was installed', () => {
  assert.equal(installLine('2.1.302', 'Native installer'), '2.1.302 · Native installer');
  assert.equal(installLine('2.1.302', null), '2.1.302');
  assert.equal(installLine(null, 'npm'), 'Version unknown · npm');
  assert.equal(installLine(undefined, null), 'Version unknown');
});

test('the off-PATH line: another CLI in the terminal, or none; nothing when it runs the same one or is unknown', () => {
  assert.deepEqual(offPathNote('Codex', '/a/codex', { offPath: true, terminal: '/b/codex' }), {
    text: 'Your terminal runs a different Codex',
    title: 'MoPilot runs /a/codex\nYour terminal runs /b/codex',
  });
  assert.equal(offPathNote('Kimi', '/a/kimi', { offPath: true, terminal: null })?.text, "Kimi isn't on your terminal's PATH");
  assert.equal(offPathNote('Kimi', '/a/kimi', { offPath: false }), null);
  assert.equal(offPathNote('Kimi', '/a/kimi', null), null);
  assert.equal(offPathNote('Kimi', null, { offPath: true }), null);
});
