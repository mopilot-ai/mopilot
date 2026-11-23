// Mobile source discovery and staged type checks must include the independent Expo workspace.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { reverseGraph, relatedTests, selectsTests, isModuleTypeFile } from '../scripts/related-tests.mjs';
import { cli, mobileTypecheck, plan, typecheckIndex } from '../scripts/precommit.mjs';
import { sourceFiles } from '../scripts/module-map.mjs';

test('mobile, host and Rust core discovery coexist with all staged validation steps', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'phone-core-composition-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sources = ['core/src/lib.rs', 'host/service.mjs', 'mobile/src/runtime.ts'];
  for (const file of sources) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), '// One isolated source.\n');
  }
  assert.deepEqual(sourceFiles(root), sources);
  const steps = plan(sources);
  assert.ok(steps.some(([cmd, args]) => cmd === 'node' && args.includes('scripts/core-check.mjs')));
  assert.ok(steps.some(([cmd, args]) => cmd === 'npm' && args.includes('typecheck')));
  assert.ok(steps.some(([cmd, args]) => cmd === 'node' && args.includes('scripts/module-map.mjs')));
});

test('mobile entry points and source imports select their real dependent tests', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'phone-selector-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files: Record<string, string> = {
    'mobile/src/core.ts': 'export const core = 1;',
    'mobile/App.tsx': "import { core } from './src/core'; export default core;",
    'mobile/index.js': "import App from './App'; export default App;",
    'mobile/metro.config.js': 'module.exports = {};',
    'mobile/package.json': '{"type":"module"}',
    'tests/phone.test.ts': "const modulePath = '../mobile/index.js'; await import(modulePath);",
    'tests/metro.test.ts': "const config = require('../mobile/metro.config.js');",
  };
  for (const [name, text] of Object.entries(files)) {
    const dest = path.join(root, name);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, text);
  }
  const graph = reverseGraph(root);
  for (const file of ['mobile/src/core.ts', 'mobile/App.tsx', 'mobile/index.js'])
    assert.deepEqual(relatedTests([file], graph), ['tests/phone.test.ts']);
  assert.deepEqual(relatedTests(['mobile/metro.config.js'], graph), ['tests/metro.test.ts']);
  assert.equal(selectsTests('mobile/package.json'), true);
  assert.equal(isModuleTypeFile('other/package.json'), false);
  assert.equal(isModuleTypeFile('mobile/src/package.json'), true);
  assert.equal(isModuleTypeFile('mobile/src/core.ts'), false);
  assert.deepEqual(relatedTests(['mobile/package.json'], graph), ['tests/metro.test.ts', 'tests/phone.test.ts']);
});

test('mobile-only staged sources run typed and module header checks', () => {
  assert.ok(plan(['mobile/package.json']).some(([cmd, args]) => cmd === 'npm' && args.includes('typecheck')));
  const steps = plan(['mobile/src/core.ts']);
  assert.ok(steps.some(([cmd, args]) => cmd === 'node' && args.includes('scripts/lint-ratchet.mjs')));
  assert.ok(steps.some(([cmd, args]) => cmd === 'npm' && args.includes('typecheck')));
  assert.ok(steps.some(([cmd, args]) => cmd === 'node' && args.includes('scripts/module-map.mjs')));
  assert.ok(plan(['mobile/App.tsx'], ['mobile/src/core.ts']).some(([cmd, args]) => cmd === 'node' && args.includes('--typecheck-index')));
});

test('staged mobile config uses its staged file and linked phone dependencies', () => {
  let snapshot = '';
  const calls: string[][] = [];
  const run = (cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    if (cmd === 'git') {
      snapshot = args[2].slice('--prefix='.length, -1);
      mkdirSync(path.join(snapshot, 'mobile'), { recursive: true });
      writeFileSync(path.join(snapshot, 'mobile/tsconfig.json'), '{}');
    }
    if (cmd === 'npx' && args.at(-1)?.endsWith('mobile/tsconfig.json'))
      assert.ok(lstatSync(path.join(snapshot, 'mobile/node_modules')).isSymbolicLink());
    return { status: 0 };
  };
  assert.equal(typecheckIndex({ run }), 0);
  assert.ok(calls.some(([cmd, ...args]) => cmd === 'npx' && args.at(-1)?.endsWith('mobile/tsconfig.json')));
  assert.equal(existsSync(snapshot), false);
});

test('mobile typecheck runs only when the checkout contains its config and propagates failures', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'phone-typecheck-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let calls = 0;
  const run = (_cmd: string, _args: string[]) => {
    calls++;
    return { status: 3 };
  };
  assert.equal(mobileTypecheck({ repoRoot: root, run }), 0);
  assert.equal(calls, 0);
  mkdirSync(path.join(root, 'mobile'));
  writeFileSync(path.join(root, 'mobile/tsconfig.json'), '{}');
  assert.equal(mobileTypecheck({ repoRoot: root, run }), 3);
  assert.equal(cli(['--typecheck-mobile'], { repoRoot: root, run }), 3);
  assert.equal(mobileTypecheck({ repoRoot: root, run: () => ({ status: null }) }), 1);
});

test('mobile index typecheck reads staged sources and resolves staged workspace dependencies', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'phone-index-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args: string[]) => assert.equal(spawnSync('git', args, { cwd: dir }).status, 0);
  git('init', '-q');
  writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
  mkdirSync(path.join(dir, 'mobile/node_modules/expo'), { recursive: true });
  mkdirSync(path.join(dir, 'node_modules'));
  writeFileSync(
    path.join(dir, 'mobile/node_modules/expo/tsconfig.base.json'),
    JSON.stringify({ compilerOptions: { strict: true, types: [] } }),
  );
  writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { types: [] }, files: ['root.ts'] }));
  writeFileSync(path.join(dir, 'tsconfig.node.json'), JSON.stringify({ compilerOptions: { types: [] }, files: ['root.ts'] }));
  writeFileSync(path.join(dir, 'root.ts'), 'export const root = 1;');
  writeFileSync(path.join(dir, 'mobile/tsconfig.json'), JSON.stringify({ extends: 'expo/tsconfig.base', files: ['phone.ts'] }));
  writeFileSync(path.join(dir, 'mobile/phone.ts'), 'export const value: number = 1;');
  git('add', '.');
  writeFileSync(path.join(dir, 'mobile/phone.ts'), "export const value: number = 'bad';");
  const run = (cmd: string, args: string[]) => spawnSync(cmd, args, { cwd: cmd === 'git' ? dir : process.cwd(), encoding: 'utf8' });
  assert.equal(typecheckIndex({ run, repoRoot: dir }), 0);
  git('add', 'mobile/phone.ts');
  assert.notEqual(typecheckIndex({ run, repoRoot: dir }), 0);
});
