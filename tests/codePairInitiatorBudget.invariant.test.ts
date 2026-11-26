// Whole-repository guard (R2b of #5576): the controlling Mac's run of a typed code is counted against ONE budget per typed code (electron/host/codePairBudgets.cjs, keyed by the hash of the normalised code), so the only caller of createInitiator is the client, and it gives it that budget and nothing made on the spot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '*.mjs', '*.cjs', '*.js', '*.ts', '*.tsx'], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})
  .split('\n')
  .filter((f) => f && !f.startsWith('mobile/') && fs.existsSync(f));

const CLIENT = 'electron/host/codePairClient.cjs';

test('createInitiator is called by the client only, with the budget the typed code’s store gave it', () => {
  const callers = files.filter(
    (f) => f !== 'shared/host/codePair.mjs' && !f.startsWith('tests/') && /\bcreateInitiator\s*\(/.test(fs.readFileSync(f, 'utf8')),
  );
  assert.deepEqual(callers, [CLIENT]);
  const text = fs.readFileSync(CLIENT, 'utf8');
  assert.equal(text.match(/\bcreateInitiator\s*\(/g)?.length, 1, 'one run, one initiator');
  assert.match(text, /const budget = budgets\.forCode\(code\);/, 'the budget is the typed code’s');
  const call = text.slice(text.indexOf('createInitiator({'), text.indexOf('});', text.indexOf('createInitiator({')));
  assert.match(call, /\n\s+budget,\n/, 'it is passed as it was made, never made in the call');
  assert.doesNotMatch(call, /createRunBudget|createTypedCodeBudgets/);
});

test('the typed code’s budget is made in one place, keyed by the hash of the code', () => {
  const makers = files.filter((f) => !f.startsWith('tests/') && /\bcreateTypedCodeBudgets\s*\(/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(makers.sort(), [CLIENT, 'electron/host/codePairBudgets.cjs'].sort());
  const owner = fs.readFileSync('electron/host/codePairBudgets.cjs', 'utf8');
  assert.match(owner, /createHash\('sha256'\)\.update\(`\$\{code\.hint\}\$\{code\.secret\}`\)/);
});
