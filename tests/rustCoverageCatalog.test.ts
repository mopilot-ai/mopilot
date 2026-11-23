// Native binding coverage prepares generated catalogs in a clean checkout without depending on npm install or another job.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { runRustCoverage } from '../scripts/rust-coverage.mjs';

for (const parentShard of ['1/3', '2/3', '3/3'])
  for (const existing of [false, true])
    test(`standalone binding checks regenerate a ${existing ? 'stale' : 'missing'} catalog under parent shard ${parentShard} without npm dependencies`, (t) => {
      const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-rust-catalog-'));
      t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
      fs.cpSync(new URL('../shared', import.meta.url), path.join(repoRoot, 'shared'), {
        recursive: true,
        filter: (file) => path.basename(file) !== 'harness-catalog.generated.json',
      });
      fs.mkdirSync(path.join(repoRoot, 'scripts'));
      fs.mkdirSync(path.join(repoRoot, 'tests'));
      // Copy the runner's production preload too: the fixture must execute the same dependency closure as a fresh native lane.
      for (const name of ['harness-catalog.mjs', 'test-slots.mjs', 'exit-with-parent.mjs'])
        fs.copyFileSync(new URL(`../scripts/${name}`, import.meta.url), path.join(repoRoot, 'scripts', name));
      const catalog = path.join(repoRoot, 'shared/harness-catalog.generated.json');
      if (existing) fs.writeFileSync(catalog, '[]');
      const binding = 'tests/coreBindingCatalogFixture.test.ts';
      fs.writeFileSync(
        path.join(repoRoot, binding),
        `import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ACP_PUBLIC_IDS } from '../shared/harnessCatalog.mjs';
import { HARNESS_INSTALL } from '../shared/harnessInstall.mjs';
test('the binding can import the prepared shared package contracts', () => {
  assert.ok(ACP_PUBLIC_IDS.length > 0);
  for (const id of ACP_PUBLIC_IDS) assert.ok(HARNESS_INSTALL['acp:' + id]);
  fs.writeFileSync(new URL('binding-ran', import.meta.url), 'verified imports');
});
`,
      );
      const commands: string[][] = [];
      let failure = '';
      const result = runRustCoverage('coverage/native.lcov', {
        repoRoot,
        tests: [binding],
        read: () => '',
        run: (cmd, args, cwd, env) => {
          commands.push(args);
          if (cmd === 'cargo') return { status: 0 };
          // A nested node:test context can suppress the fixture entirely; preserve the parent's slot lease, not its selection.
          // UNIT_TEST_SHARD too: test-slots turns it into --test-shard, and the fixture's one file is outside every shard but the first.
          const childEnv = Object.fromEntries(
            Object.entries({ ...process.env, UNIT_TEST_SHARD: parentShard, ...env }).filter(
              ([key]) => !key.startsWith('NODE_TEST_') && key !== 'UNIT_TEST_SHARD',
            ),
          );
          const child = spawnSync(cmd, args, { cwd, env: childEnv, encoding: 'utf8' });
          failure += child.stderr;
          return child;
        },
      });
      assert.equal(result, 0, failure);
      assert.equal(fs.readFileSync(path.join(repoRoot, 'tests/binding-ran'), 'utf8'), 'verified imports');
      assert.equal(fs.existsSync(path.join(repoRoot, 'node_modules')), false);
      assert.ok(JSON.parse(fs.readFileSync(catalog, 'utf8')).length > 0);
      const preparation = commands.findIndex((args) => args[0] === 'scripts/harness-catalog.mjs');
      assert.ok(preparation >= 0 && preparation < commands.findIndex((args) => args.includes(binding)));
    });

test('failed catalog preparation stops binding execution and coverage reporting', (t) => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-rust-catalog-failure-'));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const commands: string[][] = [];
  const result = runRustCoverage('coverage/native.lcov', {
    repoRoot,
    tests: ['tests/coreBindingCatalogFixture.test.ts'],
    read: () => '',
    run: (_cmd, args) => {
      commands.push(args);
      return { status: args[0] === 'scripts/harness-catalog.mjs' ? 5 : 0 };
    },
  });
  assert.equal(result, 5);
  assert.equal(
    commands.some((args) => args[0] === 'scripts/test-slots.mjs'),
    false,
  );
  assert.equal(
    commands.some((args) => args.includes('report')),
    false,
  );
});
