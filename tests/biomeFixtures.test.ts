// Biome rule fixtures preserve production path overrides and own everything a scanner can traverse until it exits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lintFixtures } from '../scripts/biome-fixtures.mjs';

const clean = () => ({ status: 0, stdout: '{"diagnostics":[]}' });
const fixture = { 'src/view.ts': 'export const value = 1;' };

test('a completed sibling cannot remove the project, config, rules or same-named input of a live scanner', () => {
  const roots: string[] = [];
  const run = (_command: string, args: string[], { cwd }: { cwd: string }) => {
    roots.push(cwd);
    assert.ok(path.relative(process.cwd(), cwd).startsWith('..'), 'the scan owns a project outside the checkout');
    assert.deepEqual(args.slice(1), ['lint', 'src/view.ts', '--reporter=json']);
    for (const name of ['biome.json', '.gitignore', 'lint/rules/enter-selects.grit'])
      assert.equal(fs.readFileSync(path.join(cwd, name), 'utf8'), fs.readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));
    return cwd;
  };
  lintFixtures(fixture, (command, args, options) => {
    const outer = run(command, args, options);
    for (const failure of [false, true]) {
      const nested = () =>
        lintFixtures({ 'src/view.ts': 'export const value = 2;' }, (cmd, argv, opts) => {
          const inner = run(cmd, argv, opts);
          assert.notEqual(inner, outer);
          assert.equal(fs.readFileSync(path.join(inner, 'src/view.ts'), 'utf8'), 'export const value = 2;');
          if (failure) throw new Error('inner spawn failed');
          return clean();
        });
      if (failure) assert.throws(nested, /inner spawn failed/);
      else nested();
      assert.equal(fs.existsSync(roots.at(-1)!), false, 'the settled sibling releases only its own root');
      assert.equal(fs.readFileSync(path.join(outer, 'src/view.ts'), 'utf8'), fixture['src/view.ts']);
      assert.ok(fs.existsSync(path.join(outer, 'biome.json')));
    }
    return clean();
  });
  assert.equal(new Set(roots).size, 3);
  assert.ok(roots.every((root) => !fs.existsSync(root)));
});

test('unchanged production config applies renderer, main, test and exact-path exclusions in one real Biome run', () => {
  const report = lintFixtures({
    'src/components/Row.tsx': 'export const Row = () => <div onMouseEnter={() => setIndex(1)} />;',
    'src/space and "quote".ts': 'export const family = () => chatHarness(id);',
    'tests/family.ts': 'export const family = () => chatHarness(id);',
    'shared/family.ts': 'export const family = () => chatHarness(id);',
    'src/session/open.ts': 'export const open = () => native.shell.openExternal(url);',
    'src/open.ts': 'export const open = () => native.shell.openExternal(url);',
    'src/styles/tokens.css': '.a { font-size: 13px; color: #fff; }',
    'src/styles/view.css': '.a { font-size: 13px; color: #fff; }',
    'electron/log.cjs': "fs.appendFileSync(file, JSON.stringify(e) + '\\n');",
    'scripts/log.cjs': "fs.appendFileSync(file, JSON.stringify(e) + '\\n');",
  });
  const paths = (tag: string) => report.diagnostics.filter((d) => d.message.includes(`[${tag}]`)).map((d) => d.location?.path);
  assert.deepEqual(paths('enter-selects'), ['src/components/Row.tsx']);
  assert.deepEqual(paths('family-collapse'), ['src/space and "quote".ts']);
  assert.deepEqual(paths('silent-open'), ['src/open.ts']);
  assert.deepEqual(paths('type-scale'), ['src/styles/view.css']);
  assert.deepEqual(paths('literal-color'), ['src/styles/view.css']);
  assert.deepEqual(paths('sync-log-append'), ['electron/log.cjs']);
});

test('bad process results remain failures and release their project; a later invocation still works', () => {
  for (const result of [
    { status: 1, stdout: '', stderr: 'a sibling vanished' },
    { status: 2, stdout: '{"diagnostics":[]}', stderr: 'configuration failed' },
    { status: 0, stdout: '{"diagnostics":' },
  ]) {
    let root = '';
    assert.throws(
      () =>
        lintFixtures(fixture, (_command, _args, options) => {
          root = options.cwd;
          return result;
        }),
      /Biome did not produce a usable report[\s\S]*src\/view.ts/,
    );
    assert.equal(fs.existsSync(root), false);
  }
  assert.deepEqual(lintFixtures(fixture, clean), { diagnostics: [] });
});

test('a setup failure releases the new project and never starts Biome', (t) => {
  let root = '';
  t.mock.method(fs, 'cpSync', (_source: unknown, target: string) => {
    root = path.resolve(target, '../..');
    throw new Error('rules are unreadable');
  });
  assert.throws(() => lintFixtures(fixture, () => assert.fail('incomplete configuration must not run')), /rules are unreadable/);
  assert.equal(fs.existsSync(root), false);
});

test('empty inputs, absolute paths, traversal and configuration replacement cannot escape fixture ownership', () => {
  const inputs: Record<string, string>[] = [
    {},
    { '/tmp/view.ts': '' },
    { 'src/../../view.ts': '' },
    { 'src/..\\view.ts': '' },
    { 'biome.json': '{}' },
  ];
  for (const files of inputs) assert.throws(() => lintFixtures(files, () => assert.fail('invalid fixture must not run')), /fixture/);
});

test('a configured temp directory inside the checkout, including a symlink alias, fails before creating a fixture', (t) => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'biome-temp-owner-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const checkout = fs.realpathSync(new URL('../', import.meta.url));
  const alias = path.join(outside, 'checkout-alias');
  fs.symlinkSync(path.join(checkout, 'src'), alias, 'junction');
  const temp = t.mock.method(os, 'tmpdir');
  t.mock.method(fs, 'mkdtempSync', () => assert.fail('a shared-tree temp root must be rejected before writing'));
  for (const parent of [checkout, path.join(checkout, 'src'), alias]) {
    temp.mock.mockImplementation(() => parent);
    assert.throws(() => lintFixtures(fixture, clean), /temporary directory outside the checkout/);
  }
});

test('an outside sibling or ancestor temp parent still permits an owned project', (t) => {
  const checkout = fs.realpathSync(new URL('../', import.meta.url));
  const sibling = fs.mkdtempSync(path.join(path.dirname(checkout), `${path.basename(checkout)}-temp-`));
  t.after(() => fs.rmSync(sibling, { recursive: true, force: true }));
  const temp = t.mock.method(os, 'tmpdir');
  for (const parent of [sibling, path.dirname(checkout)]) {
    temp.mock.mockImplementation(() => parent);
    let root = '';
    lintFixtures(fixture, (_command, _args, options) => {
      root = options.cwd;
      assert.equal(path.dirname(root), parent);
      return clean();
    });
    assert.equal(fs.existsSync(root), false);
  }
});
