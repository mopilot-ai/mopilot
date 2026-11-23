// Unborn HEAD detection distinguishes missing branch refs from detached, broken and inaccessible repositories.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isUnbornHead } from '../shared/gitHead.mjs';

test('only a missing symbolic branch ref confirms an unborn HEAD', async () => {
  for (const scenario of ['unborn', 'existing', 'outside', 'bare', 'detached', 'empty-ref', 'permission', 'spawn-error']) {
    const calls: string[][] = [];
    const answer = await isUnbornHead(async (args) => {
      calls.push(args);
      if (args[0] === 'rev-parse') return { ok: scenario !== 'outside', stdout: scenario === 'bare' ? 'false' : 'true\n' };
      if (args[0] === 'symbolic-ref') return { ok: scenario !== 'detached', stdout: scenario === 'empty-ref' ? '' : 'refs/heads/main\n' };
      return { ok: scenario === 'existing', stdout: '', code: scenario === 'permission' ? 128 : scenario === 'spawn-error' ? 'ENOENT' : 1 };
    });
    assert.equal(answer, scenario === 'unborn', scenario);
    assert.equal(calls.length, ['outside', 'bare'].includes(scenario) ? 1 : ['detached', 'empty-ref'].includes(scenario) ? 2 : 3);
  }
});
