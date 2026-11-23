// Pure helpers of the real-CLI conformance runner (the probes themselves are not run here).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, judge, redact, writeResults, protectedFailure } from './conformance/lib/common.mjs';
import { sawWord } from './conformance/lib/png.mjs';
import { assertSafeArgs, assertSafeRequest } from './conformance/lib/codex.mjs';

test('parseArgs: harness, --only and cheap defaults', () => {
  const o = parseArgs(['--harness', 'claude', '--only', 'c4, C9']);
  assert.equal(o.harness, 'claude');
  assert.deepEqual(o.only, ['C4', 'C9']);
  assert.equal(o.model, 'haiku');
  assert.equal(o.effort, 'low');
  assert.equal(parseArgs(['--harness', 'codex', '--model', 'm']).model, 'm');
  assert.equal(parseArgs(['--harness', 'codex']).recordProtected, false);
  assert.equal(parseArgs(['--harness', 'codex', '--record-protected']).recordProtected, true);
  assert.throws(() => parseArgs(['--harness', 'gemini']));
  assert.throws(() => parseArgs(['--harness', 'codex', '--bogus']));
});

test('judge: fail lists the facts that changed', () => {
  assert.deepEqual(judge({ a: true, b: true }), { verdict: 'pass', mismatches: [] });
  assert.deepEqual(judge({ a: true, b: false }), { verdict: 'fail', mismatches: ['b'] });
});

test('redact: secrets, emails, home paths and base64 blobs', () => {
  const line = JSON.stringify({
    access_token: 'abcdefghijklmnop',
    email: 'someone@example.com',
    cwd: path.join(os.homedir(), 'x'),
    img: 'A'.repeat(300),
  });
  const out = redact(line);
  assert.ok(!out.includes('abcdefghijklmnop'));
  assert.ok(!out.includes('someone@example.com'));
  assert.ok(!out.includes(os.homedir()));
  assert.ok(out.includes('<base64>'));
  assert.doesNotThrow(() => JSON.parse(out));
});

test('codex: only per-process overrides on the command line', () => {
  assert.doesNotThrow(() => assertSafeArgs(['-c', 'notify=[]', '--disable', 'goals', '--enable', 'x']));
  assert.throws(() => assertSafeArgs(['--config-file', 'x']));
  assert.throws(() => assertSafeArgs(['-c']));
});

test('codex: config writes, logins and real feedback uploads are blocked', () => {
  for (const m of [
    'config/value/write',
    'config/batchWrite',
    'account/login/start',
    'account/logout',
    'experimentalFeature/enablement/set',
    'plugin/install',
  ])
    assert.throws(() => assertSafeRequest(m, {}), m);
  assert.throws(() => assertSafeRequest('feedback/upload', { classification: 'bug' }));
  assert.doesNotThrow(() => assertSafeRequest('feedback/upload', { notAField: true }));
  assert.doesNotThrow(() => assertSafeRequest('thread/start', {}));
});

test('writeResults merges by id and keeps checks not run', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'conf-')), 'x.json');
  writeResults(file, { cli: '1' }, [
    { id: 'C10', verdict: 'pass' },
    { id: 'C2', verdict: 'pass' },
  ]);
  writeResults(file, { cli: '1' }, [{ id: 'C2', verdict: 'fail' }]);
  const out = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(
    out.checks.map((c: { id: string; verdict: string }) => `${c.id}:${c.verdict}`),
    ['C2:fail', 'C10:pass'],
  );
});

test('protectedFailure: a check during which the CLI wrote a protected file fails, naming the file under ~', () => {
  const home = os.homedir();
  const r = protectedFailure({ verdict: 'pass', observed: { mismatches: ['x'] } }, [`${home}/.codex/config.toml`, '/etc/other']);
  assert.equal(r.verdict, 'fail');
  assert.deepEqual(r.observed.mismatches, ['x', 'wrote ~/.codex/config.toml', 'wrote /etc/other']);
  assert.deepEqual(protectedFailure({ verdict: 'error' }, ['/a']).observed, { mismatches: ['wrote /a'] });
});

test('sawWord: the word, or one letter misread in a word of the same length, shows the image reached the model', () => {
  assert.equal(sawWord('The code is JSXTD.', 'JSXTD'), true);
  assert.equal(sawWord('jsxtd', 'JSXTD'), true);
  // the conformance run on Codex 0.162.1 read G as S and D as 0
  assert.equal(sawWord('ATSNB', 'ATGNB'), true);
  assert.equal(sawWord('It says JSXT0', 'JSXTD'), true);
  assert.equal(sawWord('ATSNO', 'ATGNB'), false, 'two letters off is not the same word');
  assert.equal(sawWord('JSXT', 'JSXTD'), false, 'a shorter word is not it');
  assert.equal(sawWord('NOIMAGE', 'CSPVY'), false);
  assert.equal(sawWord(undefined, 'CSPVY'), false);
  assert.equal(sawWord('', 'CSPVY'), false);
});
