// Contract fixtures that execute extracted specs or shell commands remain reachable by focused unit selection.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changedFiles, invariantTestsFor, isInvariantTest, relatedTests, reverseGraph } from '../scripts/related-tests.mjs';

const users = reverseGraph();

test('the real welcome spec reaches the contract that executes its signed-out callback', () => {
  assert.ok(relatedTests(['tests/e2e/welcome.spec.ts'], users).includes('tests/acpLoginContract.test.ts'));
  assert.ok(relatedTests(['tests/e2e/fixtures/app.ts'], users).includes('tests/acpLoginContract.test.ts'));
});

test('a shell-only change selects the unit test that invokes that actual script', () => {
  const git = (args: string[]) => (args[0] === 'merge-base' ? 'base\n' : args[0] === 'ls-files' ? '' : 'scripts/vm-exec.sh\n');
  const changed = changedFiles('HEAD', git);
  assert.deepEqual(changed, ['scripts/vm-exec.sh']);
  assert.ok(relatedTests(changed, users).includes('tests/vmExec.test.ts'));
});

test('the dynamic fixture graph guard stays mandatory for every change', () => {
  const guard = 'tests/relatedTestsFixtures.test.ts';
  assert.equal(isInvariantTest(guard), true);
  for (const files of [['docs/guide.md'], ['scripts/vm-exec.sh'], ['tests/acpLoginContract.test.ts'], ['src/new.ts']]) {
    assert.ok(invariantTestsFor(files).includes(guard));
  }
});
