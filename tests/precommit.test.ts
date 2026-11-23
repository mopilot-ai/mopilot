import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cli, defaultRun, plan, precommit, typecheckIndex, typesChanged } from '../scripts/precommit.mjs';

/** A lease that holds nothing, so these hook tests never wait on the machine's real slots. */
const noLease = () => ({ workers: '1', env: {}, release() {} });

test('the plan runs Biome for app files, the lint ratchet for linted sources and lint config, typecheck for typed files and configs, and the header check for sources', () => {
  assert.deepEqual(plan([]), []);
  assert.deepEqual(
    plan(['web/app/page.tsx']).map(([c, args]) => [c, args[0]]),
    [['node', 'scripts/file-size.mjs']],
  );
  assert.deepEqual(plan(['web/app/with\nnewline.tsx']), plan(['web/app/page.tsx']));
  assert.deepEqual(plan(['src/with\nnewline.ts']), plan(['src/a.ts']));
  assert.deepEqual(
    plan(['docs/a.md']).map(([c]) => c),
    ['npx'],
  );
  // the Rust core: Biome (it ignores .rs), the size check and the header check for sources, and rustfmt and clippy
  assert.deepEqual(
    plan(['core/crates/proc/src/lib.rs']).map(([, args]) => args[0]),
    ['biome', 'scripts/file-size.mjs', 'scripts/core-check.mjs', 'scripts/module-map.mjs'],
  );
  assert.deepEqual(
    plan(['core/Cargo.lock']).map(([, args]) => args[0]),
    ['biome', 'scripts/core-check.mjs'],
  );
  // sources also go through the lint ratchet and the header check; configs and tests only need the type check
  for (const file of ['src/a.ts', 'src/b.tsx', 'electron/c.cjs', 'shared/d.mjs', 'shared/e.d.mts', 'scripts/f.mjs']) {
    assert.deepEqual(
      plan([file]).map(([c]) => c),
      ['npx', 'node', 'node', 'npm', 'node'],
      file,
    );
  }
  // the lint configuration can change any file's warnings
  for (const file of ['biome.json', 'lint/rules/time-id.grit']) {
    assert.deepEqual(
      plan([file]).map(([c, args]) => [c, args[0]]),
      [['npx', 'biome'], ['node', 'scripts/lint-ratchet.mjs'], ...(file.endsWith('.grit') ? [['node', 'scripts/file-size.mjs']] : [])],
      file,
    );
  }
  for (const file of ['tsconfig.node.json', 'package.json']) {
    assert.deepEqual(
      plan([file]).map(([c]) => c),
      ['npx', 'npm'],
      file,
    );
  }
  assert.deepEqual(
    plan(['tests/a.test.ts']).map(([c]) => c),
    ['npx', 'node', 'npm'],
  );
  // a stylesheet carries the type-scale rule (lint/rules/type-scale.grit), so its warnings are ratcheted too
  assert.deepEqual(
    plan(['src/styles/app/thread-messages.css']).map(([c, args]) => [c, args[0]]),
    [
      ['npx', 'biome'],
      ['node', 'scripts/lint-ratchet.mjs'],
      ['node', 'scripts/file-size.mjs'],
    ],
  );
  for (const file of ['native/A.swift', 'lint/file-size-exceptions.json', 'lint/file-size-exceptions/a.json']) {
    assert.deepEqual(
      plan([file]).map(([c, args]) => [c, args[0]]),
      [
        ['npx', 'biome'],
        ['node', 'scripts/file-size.mjs'],
      ],
    );
  }
  // bench/ is listed in the module map too, so its files need a header, though the ratchet leaves them alone
  assert.deepEqual(
    plan(['bench/run.mjs']).map(([c, args]) => [c, args[0]]),
    [
      ['npx', 'biome'],
      ['node', 'scripts/file-size.mjs'],
      ['npm', 'run'],
      ['node', 'scripts/module-map.mjs'],
    ],
  );
  assert.deepEqual(plan(['src/a.ts'])[0][1].at(-1), '--diagnostic-level=error', "warnings are the ratchet's");
  assert.deepEqual(plan(['src/a.ts'])[1].slice(0, 2), ['node', ['scripts/lint-ratchet.mjs', '--staged']]);
  assert.deepEqual(plan(['src/a.ts'])[2].slice(0, 2), ['node', ['scripts/file-size.mjs', '--staged']]);
  assert.deepEqual(plan(['src/a.ts'])[4].slice(0, 2), ['node', ['scripts/module-map.mjs', '--check']]);
  assert.deepEqual(plan(['src/a.ts'])[3].slice(0, 2), ['npm', ['run', '--silent', 'typecheck']]);
  assert.deepEqual(plan(['src/a.ts'], ['src/b.ts'])[3].slice(0, 2), ['node', ['scripts/precommit.mjs', '--typecheck-index']]);
});

test('the PR check type-checks what the hook would, and what its whole-tree checks also read', () => {
  // what the hook type-checks: sources, tests, configs and manifests outside web/, at any depth
  for (const file of ['src/a.ts', 'electron/b.cjs', 'mobile/src/c.tsx', 'design/x/spike.mjs', 'tsconfig.node.json', 'mobile/package.json'])
    assert.equal(typesChanged([file]), true, file);
  // web/'s own check, a JSON module a typed file can import, and a lockfile, which pins the type declarations
  for (const file of [
    'web/app/page.tsx',
    // (sample paths that name no real private file, so this test ships with the hook in the source edition)
    'web/admin/tsconfig.json',
    'web/admin/package.json',
    'shared/remote/vectors.json',
    'src/harness/matrix.generated.json',
    'package-lock.json',
    'mobile/package-lock.json',
    // a folder a later change adds to a type check's include
    'agent/schema.json',
  ])
    assert.equal(typesChanged([file]), true, file);
  // nothing a type check reads
  for (const file of ['docs/a.md', 'deploy/host/compose.yaml', 'conformance/results/c.json', 'lint/baseline.json', 'core/src/lib.rs'])
    assert.equal(typesChanged([file]), false, file);
  assert.equal(typesChanged([]), false);
  assert.equal(typesChanged(['"docs/quoted\\npath.md"']), true, 'an undecoded Git path keeps the required check');
  assert.equal(typesChanged(['docs/a.md', 'scripts/b.mjs']), true, 'one typed path is enough');
});

test('the checks run inside one slot of the shared budget, freed on success and failure, and none is taken with nothing to check (#2340)', () => {
  const events: string[] = [];
  const envs: any[] = [];
  const start = (env: any) => {
    envs.push(env);
    events.push('lease');
    return { workers: '1', env: {}, release: () => events.push('release') };
  };
  const run =
    (fail: boolean, staged = 'M\0src/a.ts\0') =>
    (cmd: string, args: string[]) => {
      if (cmd === 'git') return { status: 0, stdout: args[1] === '--cached' ? staged : '' };
      events.push(cmd);
      return { status: fail ? 1 : 0 };
    };
  assert.equal(precommit({ run: run(false), log: () => {}, start, env: { HOME: '/h' } }), 0);
  assert.deepEqual(events, ['lease', 'npx', 'node', 'node', 'npm', 'node', 'release']);
  assert.deepEqual(envs, [{ HOME: '/h' }]);
  events.length = 0;
  assert.equal(precommit({ run: run(true), log: () => {}, start }), 1);
  assert.deepEqual(events, ['lease', 'npx', 'release']);
  events.length = 0;
  assert.equal(precommit({ run: run(false, 'M\0web/a.md\0'), log: () => {}, start }), 0);
  assert.deepEqual(events, [], 'a commit with nothing to check waits for no slot');
});

test('precommit runs each step in order and stops at the first failure with a hint', () => {
  const calls: string[] = [];
  const logs: string[] = [];
  // git diff --cached answers `staged`, the dirty-file queries answer `dirty`; every other step takes the next status
  const run = (statuses: (number | null)[], staged = 'M\0src/a.ts\0', dirty = '') => {
    let i = 0;
    return (cmd: string, args: string[]) => {
      calls.push([cmd, ...args].join(' '));
      if (cmd === 'git' && args[0] === 'diff' && args[1] === '--cached') return { status: statuses[i++], stdout: staged };
      if (cmd === 'git') return { status: 0, stdout: dirty };
      return { status: statuses[i++] };
    };
  };
  assert.equal(precommit({ start: noLease, run: run([0, 0, 0, 0, 0, 0]), log: (s: string) => logs.push(s) }), 0);
  assert.deepEqual(
    calls.map((c) => c.split(' ').slice(0, 3).join(' ')),
    [
      'git diff --cached',
      'git diff --name-only',
      'git ls-files --others',
      'npx biome check',
      'node scripts/lint-ratchet.mjs --staged',
      'node scripts/file-size.mjs --staged',
      'npm run --silent',
      'node scripts/module-map.mjs --check',
    ],
  );
  calls.length = 0;
  assert.equal(precommit({ start: noLease, run: run([0, 2]), log: (s: string) => logs.push(s) }), 2);
  assert.match(logs[0], /biome check --staged.*failed\. Format with `npm run format/);
  assert.equal(precommit({ start: noLease, run: run([0, 0, 1]), log: (s: string) => logs.push(s) }), 1);
  assert.match(logs[1], /lint-ratchet\.mjs --staged` failed\. Fix the warnings this change adds/);
  assert.equal(precommit({ start: noLease, run: run([0, 0, 0, 1]), log: (s: string) => logs.push(s) }), 1);
  assert.match(logs[2], /file-size\.mjs --staged` failed\. Split by responsibility/);
  assert.equal(precommit({ start: noLease, run: run([0, 0, 0, 0, 1]), log: (s: string) => logs.push(s) }), 1);
  assert.match(logs[3], /typecheck` failed\. Fix the type errors above\. Skip once/);
  assert.equal(precommit({ start: noLease, run: run([0, 0, 0, 0, null]), log: () => {} }), 1);
  assert.equal(precommit({ start: noLease, run: run([128]), log: () => {} }), 128);
  assert.equal(precommit({ start: noLease, run: run([null]), log: () => {} }), 1);
  assert.equal(precommit({ start: noLease, run: run([0], ''), log: () => {} }), 0);
  assert.equal(precommit({ start: noLease, run: () => ({ status: 0 }), log: () => {} }), 0);
  // unstaged typed edits (here a dirty test file, ignored docs): the type check runs on a checkout of the index
  calls.length = 0;
  assert.equal(
    precommit({ start: noLease, run: run([0, 0, 0, 0, 0, 0], 'M\0src/a.ts\0', 'tests/x.test.ts\0README.md\0'), log: () => {} }),
    0,
  );
  assert.ok(calls.includes('node scripts/precommit.mjs --typecheck-index'));
  calls.length = 0;
  assert.equal(precommit({ start: noLease, run: run([0, 1], 'M\0web/app/with\nnewline.tsx\0'), log: () => {} }), 1);
  assert.ok(calls.includes('node scripts/file-size.mjs --staged'), 'raw staged paths reach the shared size check');
});

test("a test's lint fixture is refused by index status; deletions and lookalikes remain allowed (#1507)", () => {
  const logs: string[] = [];
  const calls: string[] = [];
  const run = (staged: string) => (cmd: string, args: string[]) => {
    calls.push([cmd, ...args].join(' '));
    return cmd === 'git' ? { status: 0, stdout: args[1] === '--cached' ? staged : '' } : { status: 0 };
  };
  const fixture = 'src/styles/.lint-fixture-AqGrFw/Inline.tsx';
  for (const status of ['A', 'M', 'T', 'R100', 'C100']) {
    calls.length = 0;
    const source = /^[RC]/.test(status) ? 'src/source.ts\0' : '';
    assert.equal(
      precommit({ start: noLease, run: run(`M\0src/a.ts\0${status}\0${source}${fixture}\0`), log: (s: string) => logs.push(s) }),
      1,
    );
    assert.deepEqual(calls, ['git diff --cached --name-status -z --diff-filter=ACMRTD']);
  }
  assert.match(logs[0], /src\/styles\/\.lint-fixture-AqGrFw\/Inline\.tsx is a test's lint fixture, not source\. Unstage it/);
  assert.equal(precommit({ start: noLease, run: run(`D\0${fixture}\0`), log: () => {} }), 0);
  for (const status of ['R100', 'C100']) {
    assert.equal(precommit({ start: noLease, run: run(`${status}\0${fixture}\0src/source.ts\0`), log: () => {} }), 0);
  }
  assert.equal(precommit({ start: noLease, run: run('A\0src/lint-fixture-notes.md\0A\0docs/.lint-fixture.md\0'), log: () => {} }), 0);
});

test("typecheckIndex checks out the index next to this tree's node_modules and runs both configs there", () => {
  const calls: string[][] = [];
  let dir = '';
  const run = (statuses: (number | null)[]) => {
    let i = 0;
    return (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      if (cmd === 'git') {
        dir = args[2].slice('--prefix='.length, -1);
        return { status: statuses[i++] };
      }
      // the snapshot links the dependencies it type-checks against
      assert.ok(lstatSync(path.join(dir, 'node_modules')).isSymbolicLink());
      return { status: statuses[i++] };
    };
  };
  assert.equal(typecheckIndex({ run: run([0, 0, 0]) }), 0);
  assert.deepEqual(
    calls.map((c) => c.slice(0, 3).join(' ')),
    ['git checkout-index --all', 'npx tsc --noEmit', 'npx tsc --noEmit'],
  );
  assert.ok(calls[1][4].endsWith('/tsconfig.json') && calls[2][4].endsWith('/tsconfig.node.json'));
  assert.equal(existsSync(dir), false, 'the snapshot is removed');
  assert.equal(typecheckIndex({ run: run([0, 2]) }), 2);
  assert.equal(typecheckIndex({ run: run([0, null]) }), 1);
  assert.equal(typecheckIndex({ run: run([5]) }), 5);
  assert.equal(typecheckIndex({ run: run([null]) }), 1);
});

test('typecheckIndex judges the index, not unstaged edits', (t) => {
  // a real repository: the committed file is fine, the unstaged edit has a type error the check must not see
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'precommit-repo-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args: string[]) => assert.equal(spawnSync('git', args, { cwd: dir }).status, 0);
  git('init', '-q');
  writeFileSync(
    path.join(dir, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [] }, include: ['a.ts'] }),
  );
  writeFileSync(path.join(dir, 'tsconfig.node.json'), JSON.stringify({ compilerOptions: { noEmit: true, types: [] }, include: ['a.ts'] }));
  writeFileSync(path.join(dir, 'a.ts'), 'export const a: number = 1;\n');
  git('add', '.');
  writeFileSync(path.join(dir, 'a.ts'), "export const a: number = 'unstaged';\n");
  mkdirSync(path.join(dir, 'node_modules'));
  const real = (cmd: string, args: string[]) => spawnSync(cmd, args, { cwd: cmd === 'git' ? dir : process.cwd(), encoding: 'utf8' });
  assert.equal(typecheckIndex({ run: real, repoRoot: dir }), 0);
  git('add', '.');
  assert.notEqual(typecheckIndex({ run: real, repoRoot: dir }), 0);
});

test('typecheckIndex prepares the catalog from the staged snapshot and stops if preparation fails', () => {
  for (const status of [0, 3, null]) {
    const calls: string[][] = [];
    let snapshot = '';
    const result = typecheckIndex({
      run: (cmd: string, args: string[]) => {
        calls.push([cmd, ...args]);
        if (cmd === 'git') {
          snapshot = args[2].slice('--prefix='.length, -1);
          const generator = path.join(snapshot, 'scripts/harness-catalog.mjs');
          mkdirSync(path.dirname(generator), { recursive: true });
          writeFileSync(generator, '// staged generator\n');
          return { status: 0 };
        }
        if (cmd === 'node') {
          assert.equal(args[0], path.join(snapshot, 'scripts/harness-catalog.mjs'));
          assert.equal(args[1], snapshot);
          return { status };
        }
        return { status: 0 };
      },
    });
    assert.equal(result, status ?? 1);
    assert.equal(calls.filter((c) => c[0] === 'npx').length, status === 0 ? 2 : 0);
    assert.equal(existsSync(snapshot), false);
  }
});

test('the CLI checks the real staged set and passes when nothing is staged', (t) => {
  // an index identical to HEAD: nothing staged, whatever the working tree holds
  const dir = mkdtempSync(path.join(os.tmpdir(), 'precommit-index-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, GIT_INDEX_FILE: path.join(dir, 'index') };
  assert.equal(spawnSync('git', ['read-tree', 'HEAD'], { env }).status, 0);
  const r = spawnSync(process.execPath, ['scripts/precommit.mjs'], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
});

test('steps inherit the terminal so their own output reaches the committer', () => {
  assert.equal(defaultRun(process.execPath, ['-e', '0'], true).status, 0);
});

test('the command line runs the hook, or only the index type check', () => {
  const seen: string[] = [];
  const run = (cmd: string, args: string[]) => (seen.push(`${cmd} ${args[0]}`), { status: 0, stdout: '' });
  assert.equal(cli([], { run, log: () => {} }), 0);
  assert.deepEqual(seen, ['git diff', 'git diff', 'git ls-files']);
  seen.length = 0;
  assert.equal(cli(['--typecheck-index'], { run }), 0);
  assert.deepEqual(seen, ['git checkout-index', 'npx tsc', 'npx tsc']);
});
