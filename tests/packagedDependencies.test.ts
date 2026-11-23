// Every package the main process loads at run time is a production dependency: the packager prunes devDependencies
// from app.asar (scripts/package.mjs), so a require of one passes every unit test and then fails the shipped app on
// launch ("Cannot find module 'js-yaml'" from electron/harness/routeReader.cjs). app.asar holds only the top-level
// entries in SHIPPED, so a relative load must stay inside them too. scripts/runtime-deps.mjs is the check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const GUARDS = ['electron/', 'host/src/', 'package-lock.json', 'package.json', 'shared/'];

const deps = await import('../scripts/runtime-deps.mjs');
const repo = path.resolve(import.meta.dirname, '..');

test('the scanner names packages and skips relative paths, builtins, electron and prose', () => {
  const text = `
    const yaml = require('js-yaml');
    const { query } = require("@anthropic-ai/claude-agent-sdk/sdk.mjs");
    import { parse } from 'smol-toml';
    export { x } from './local.cjs';
    log('moved from', error); log('copied from ' + dir);
    // a comment that says: require('left-pad')
    /** @type {import('type-only-pkg').T} */
     * @param {import('another-type').U} u
    const fs = require('node:fs'); const os = require('os'); const { app } = require('electron');
    const pty = await import('node-pty');
    require.resolve('@vscode/ripgrep');
  `;
  assert.deepEqual(deps.packagesIn(text), ['js-yaml', '@anthropic-ai/claude-agent-sdk', 'smol-toml', 'node-pty', '@vscode/ripgrep']);
});

test('the main entry point sits in a folder the check scans', () => {
  const { main } = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
  assert.ok(
    deps.RUNTIME_DIRS.some((dir: string) => main.startsWith(`${dir}/`)),
    `${main} is outside ${deps.RUNTIME_DIRS}`,
  );
});

test('every package electron/ and shared/ load is in dependencies, not only devDependencies', () => {
  const loaded = deps.checkRuntimeDependencies(repo);
  assert.ok(loaded.includes('js-yaml') && loaded.includes('smol-toml'), loaded.join(', '));
});

test('a package loaded only as a devDependency is named with the files that load it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-deps-'));
  try {
    fs.mkdirSync(path.join(root, 'electron', 'harness'), { recursive: true });
    fs.mkdirSync(path.join(root, 'electron', 'node_modules', 'vendored'), { recursive: true });
    fs.mkdirSync(path.join(root, 'shared'));
    fs.mkdirSync(path.join(root, 'host', 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'electron', 'harness', 'route.cjs'), "require('js-yaml'); require('js-yaml/dist');");
    fs.writeFileSync(path.join(root, 'electron', 'node_modules', 'vendored', 'index.js'), "require('left-pad');");
    fs.writeFileSync(path.join(root, 'electron', 'notes.md'), "require('left-pad')");
    fs.writeFileSync(path.join(root, 'shared', 'route.mjs'), "import { parse } from 'smol-toml';");
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ devDependencies: { 'js-yaml': '4' } }));
    assert.throws(
      () => deps.checkRuntimeDependencies(root),
      /prunes devDependencies: js-yaml \(electron\/harness\/route\.cjs\); smol-toml \(shared\/route\.mjs\)$/,
    );
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { 'js-yaml': '4', 'smol-toml': '1' } }));
    assert.deepEqual(deps.checkRuntimeDependencies(root), ['js-yaml', 'smol-toml']);
    assert.deepEqual(
      [...deps.runtimePackages(root)],
      [
        ['js-yaml', ['electron/harness/route.cjs']],
        ['smol-toml', ['shared/route.mjs']],
      ],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('every relative load in electron/, shared/ and host/src stays inside what app.asar holds', () => {
  assert.deepEqual(deps.unshippedLoads(repo), []);
});

test('a relative load outside the shipped folders is named with its file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-deps-'));
  try {
    fs.mkdirSync(path.join(root, 'electron', 'platform'), { recursive: true });
    fs.mkdirSync(path.join(root, 'shared'));
    fs.mkdirSync(path.join(root, 'host', 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'electron', 'platform', 'core.cjs'),
      [
        "require('../../core/target/release/x.node');",
        "require('./sibling.cjs'); require('../../shared/a.mjs'); require('../../host/src/b.mjs');",
        "// require('../../bench/lib/x.mjs')",
        "/** @type {import('../../src/types.ts').T} */",
      ].join('\n'),
    );
    fs.writeFileSync(path.join(root, 'host', 'src', 'b.mjs'), "import '../../shared/a.mjs'; import '../../lint/x.mjs';");
    assert.deepEqual(deps.unshippedLoads(root), [
      'electron/platform/core.cjs -> ../../core/target/release/x.node',
      'host/src/b.mjs -> ../../lint/x.mjs',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the pruned build is checked for each package by its package.json', () => {
  const present = new Set([path.join('/app', 'node_modules', '@scope/pkg', 'package.json')]);
  assert.deepEqual(
    deps.missingFromBuild('/app', ['@scope/pkg', 'js-yaml'], (f: string) => present.has(f)),
    ['js-yaml'],
  );
  assert.deepEqual(deps.missingFromBuild(repo, ['js-yaml']), []);
});
