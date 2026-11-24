// Whole-repository guard (R2b of #5576): a code gets ONE run budget, so only a file that owns it by its marker comment may make one. A second budget for the same offer or the same typed code is a second chance the code does not have.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

export const GUARDS = ['host/', 'electron/', 'shared/', 'src/', 'mobile/', 'tests/'];

const MARKER = '@code-pair-budget-owner';
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '*.mjs', '*.cjs', '*.js', '*.ts', '*.tsx'], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})
  .split('\n')
  .filter((f) => f && !f.startsWith('tests/') && !f.startsWith('mobile/') && fs.existsSync(f));

test('only a file that carries the owner marker calls createRunBudget, and the definition stays in shared/host/codePair.mjs', () => {
  const makers = files.filter((f) => /\bcreateRunBudget\s*\(/.test(fs.readFileSync(f, 'utf8')));
  assert.ok(makers.includes('host/src/codePairBudgets.mjs'), 'the Host owner exists');
  for (const f of makers) {
    if (f === 'shared/host/codePair.mjs') continue;
    assert.ok(
      fs.readFileSync(f, 'utf8').includes(MARKER),
      `${f} makes a run budget without the owner marker (${MARKER}): a code has one budget`,
    );
  }
});

test('createInitiator and createResponder are never given a budget made on the spot', () => {
  for (const f of files) {
    if (f === 'shared/host/codePair.mjs') continue;
    const text = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(
      text,
      /budget:\s*createRunBudget/,
      `${f} makes a budget for one run: it must come from the store that keeps one per offer or typed code`,
    );
  }
});
