// src/harness/harnessChecks.ts: the test machine's results as the plain-text section of Copy diagnostics (every
// verdict, finding kind and admission state), over a small matrix and over the committed one.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { contractLines, basicLine, harnessChecksText, CONTRACT_TEXT } = await import('../src/harness/harnessChecks.ts');
const { MATRIX } = await import('../src/harness/compat.ts');

const run = (over: object = {}): any => ({
  kind: 'codex',
  label: 'Codex',
  version: '1.0.0',
  verdict: 'pass',
  date: '2026-10-17',
  regressions: 0,
  known: 0,
  failingRows: [],
  incomplete: [],
  ...over,
});
const basic = (over: object = {}): any => ({
  id: 'x',
  label: 'X',
  vendor: 'V',
  probedVersion: '2.0',
  verified: '2.0',
  admission: 'admitted',
  reason: null,
  imagePrompts: true,
  sageTools: 'hello received',
  ...over,
});

test('a run lists each finding with its issue: new before known, open before fixed', () => {
  const lines = contractLines(
    run({
      verdict: 'fail',
      found: [
        { key: 'a', says: 'Old open.', issue: 1, known: true },
        { key: 'b', says: 'New fixed.', fixedBy: 2 },
        { key: 'c', says: 'New open.', issue: 3 },
        { key: 'd', says: 'Old fixed.', fixedBy: 4, known: true },
      ],
    }),
  );
  assert.deepEqual(lines, [
    '  Codex 1.0.0: problems found',
    '    - New open. (#3)',
    '    - New fixed. (fixed in #2, re-check pending)',
    '    - Old open. (#1; also in earlier versions)',
    '    - Old fixed. (fixed in #4, re-check pending; also in earlier versions)',
  ]);
  // a run that passed with a failure its baseline had too still names it
  assert.deepEqual(contractLines(run({ found: [{ key: 'a', says: 'Old one.', issue: 1, known: true }] })), [
    '  Codex 1.0.0: passed',
    '    - Old one. (#1; also in earlier versions)',
  ]);
  assert.deepEqual(contractLines(run()), ['  Codex 1.0.0: passed']);
});

test('an unfinished run claims nothing: only why it stopped, even when items failed', () => {
  const found = [{ key: 'k', says: 'X.', fixedBy: 9, known: true }];
  assert.deepEqual(contractLines(run({ verdict: 'incomplete', incomplete: ['login: signed out', 'edge: timeout'], found })), [
    '  Codex 1.0.0: not finished (login: signed out; edge: timeout)',
  ]);
  assert.deepEqual(contractLines(run({ verdict: 'incomplete' })), ['  Codex 1.0.0: not finished']);
  assert.deepEqual(Object.keys(CONTRACT_TEXT), ['pass', 'fail', 'incomplete']);
});

test('a basic harness: works and what it lacks, not checked and why, or does not work', () => {
  assert.equal(basicLine(basic()), '  X 2.0: works');
  assert.equal(basicLine(basic({ imagePrompts: false })), '  X 2.0: works; not supported: images');
  assert.equal(basicLine(basic({ imagePrompts: false, sageTools: 'no hello' })), '  X 2.0: works; not supported: images, MoPilot tools');
  // a tool server that was never probed is not called unsupported
  assert.equal(basicLine(basic({ imagePrompts: null, sageTools: 'not probed' })), '  X 2.0: works');
  assert.equal(
    basicLine(basic({ admission: 'signin', reason: 'Sign in to X first', sageTools: 'session/new failed' })),
    '  X 2.0: not checked (no login on the test machine)',
  );
  assert.equal(basicLine(basic({ admission: 'unsupported', reason: 'Too old' })), "  X 2.0: doesn't work (Too old)");
  assert.equal(basicLine(basic({ admission: 'unsupported' })), "  X 2.0: doesn't work");
  assert.equal(
    basicLine(basic({ admission: 'not probed', probedVersion: null })),
    '  X (no version): not checked (not on the test machine)',
  );
});

test('the section: a title that says whose results these are, every run, every basic harness', () => {
  const m: any = { contracts: [run({ verdict: 'fail', found: [{ key: 'a', says: 'Wrote config.', issue: 1346 }] })], basic: [basic()] };
  assert.equal(
    harnessChecksText(m),
    [
      "Harness checks (MoPilot's test machine; these versions, not this Mac)",
      '  Codex 1.0.0: problems found',
      '    - Wrote config. (#1346)',
      'Basic harnesses on the test machine',
      '  X 2.0: works',
    ].join('\n'),
  );
  for (const contracts of [[], undefined])
    assert.match(
      harnessChecksText({ contracts, basic: [] } as any),
      /\n {2}No version has been checked yet\.\nBasic harnesses on the test machine$/,
    );
});

test('the committed matrix reads in plain words: no CM row ids or probe output, and every harness has a line', () => {
  const text = harnessChecksText(MATRIX);
  assert.doesNotMatch(text, /CM-[A-Z]\d|session\/new|conformance:|edge:/);
  for (const r of MATRIX.contracts!) assert.ok(text.includes(`  ${r.label} ${r.version}: `), `${r.label} ${r.version}`);
  for (const b of MATRIX.basic) assert.ok(text.includes(`  ${b.label} `), b.label);
});
