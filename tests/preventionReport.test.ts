// Recurrence reporting counts explicit reviewed PR metadata and keeps incomplete evidence unknown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { classSlugs, preventionReport, main } from '../scripts/prevention-report.mjs';

const classes = new Set(['stale-async-results', 'overlapping-operations']);
const record = (number: number, fields: string, mergedAt = '2026-10-14T10:00:00Z') => ({
  number,
  mergedAt,
  body: `## Prevention record\n${fields}\n## Validation\nTest evidence`,
});
const report = (rows: any[]) => preventionReport(rows, classes);

test('classes follow the canonical index and a missing index fails clearly', () => {
  assert.deepEqual(
    classSlugs('| [Stale](stale-async-results.md) | Details |\n| [Overlap](overlapping-operations.md) | Details |'),
    classes,
  );
  assert.throws(() => classSlugs('no class rows'), /No bug classes/);
});

test('counts declared classes without inferring recurrence from the same class', () => {
  const result = report([
    {
      ...record(10, 'Bug class: stale-async-results\nRecurs after: none known'),
      title: 'Additional gh export field',
      url: 'https://example.test/pr/10',
    },
    record(11, 'Bug class: overlapping-operations\nRecurs after: #1, #2, #1'),
    record(12, 'Bug class: stale-async-results\nRecurs after: unknown', '2026-10-13T10:00:00Z'),
    record(13, 'Bug class: none\nRecurs after: none known'),
    record(14, 'Bug class: unknown'),
  ]);
  assert.deepEqual(result, {
    scope: { mergedPullRequests: 5, firstMergedAt: '2026-10-13T10:00:00.000Z', lastMergedAt: '2026-10-14T10:00:00.000Z' },
    byClass: { 'overlapping-operations': 1, 'stale-async-results': 2 },
    nonBug: [13],
    unclassified: [14],
    unknownRecurrence: [12],
    recurrences: [{ number: 11, bugClass: 'overlapping-operations', recursAfter: [1, 2] }],
  });
});

test('missing, repeated, unsupported and fenced metadata stays unclassified', () => {
  const bodies = [
    '',
    '## Other\nBug class: stale-async-results',
    '## Prevention record\nBug class: stale-async-results\nBug class: none',
    '## Prevention record\nBug class: stale-async-results\n## Prevention record\nBug class: none',
    '## Prevention record\nBug class: invented-class',
    '```md\n## Prevention record\nBug class: stale-async-results\n```',
    '## Prevention record\n~~~\nBug class: stale-async-results\n~~~',
    '<!-- ## Prevention record\nBug class: stale-async-results -->',
  ];
  bodies.forEach((body, i) => assert.deepEqual(report([{ ...record(i + 1, ''), body }]).unclassified, [i + 1]));
  assert.deepEqual(report([record(10, '<!-- Bug class: none -->\nBUG CLASS: STALE-ASYNC-RESULTS\nRecurs after: none known')]).byClass, {
    'stale-async-results': 1,
  });
});

test('metadata in full fenced templates, sibling headings and unfinished comments is never evidence', () => {
  for (const body of [
    '```md\n## Prevention record\nBug class: stale-async-results\nRecurs after: none known\n## Validation\nexample\n```',
    '## Prevention record\nRecurs after: none known\n# Other section\nBug class: stale-async-results',
    '<!--\n## Prevention record\nBug class: stale-async-results\nRecurs after: none known',
    '## Prevention record\nRecurs after: none known\nBug class: stale-async-results\n---',
  ])
    assert.deepEqual(report([{ ...record(10, ''), body }]).unclassified, [10], body);
});

test('Markdown scope preserves actual plain records around code/comments and rejects marked-up fields', () => {
  const actual = '## Prevention record\nBug class: stale-async-results\nRecurs after: none known\n';
  for (const body of [
    '```md\n## Prevention record\nBug class: none\n## Validation\nexample\n```\n\n' + actual,
    '<!--\n## Prevention record\nBug class: none\n-->\n\n' + actual,
    '~~~md\n<!-- a literal unclosed comment in code\n~~~\n\n' + actual,
    actual + '\n```md\nBug class: none\n```',
    actual + '\nA note with **formatting**.',
    'Prevention record\n-----------------\nBug class: stale-async-results\nRecurs after: none known',
  ])
    assert.deepEqual(report([{ ...record(10, ''), body }]).byClass, { 'stale-async-results': 1 }, body);
  for (const body of [
    '## Prevention **record**\nBug class: stale-async-results',
    '## Prevention record\nBug class: **stale-async-results**\nRecurs after: none known',
    '## Prevention record\n### Example\nBug class: stale-async-results',
    '<pre>\n## Prevention record\nBug class: stale-async-results\n</pre>',
  ])
    assert.deepEqual(report([{ ...record(10, ''), body }]).unclassified, [10], body);
});

test('missing and malformed recurrence references remain unknown, never zero recurrences', () => {
  const values = ['', 'unknown', '#0', '#9007199254740992', '#10', '#2 plus guesses', ', ,', '#002'];
  for (const value of values) {
    const result = report([record(10, `Bug class: stale-async-results\nRecurs after: ${value}`)]);
    assert.deepEqual(result.unknownRecurrence, [10], value);
    assert.deepEqual(result.recurrences, []);
  }
  assert.deepEqual(report([record(10, 'Bug class: stale-async-results')]).unknownRecurrence, [10]);
  assert.deepEqual(report([record(10, 'Bug class: stale-async-results\nRecurs after: #1\nRecurs after: #2')]).unknownRecurrence, [10]);
});

test('rejects invalid/open/duplicate records before emitting any report', () => {
  for (const input of [null, {}, 1]) assert.throws(() => preventionReport(input, classes), TypeError);
  const base = record(1, 'Bug class: none');
  for (const row of [
    null,
    [],
    { ...base, number: 0 },
    { ...base, number: 1.5 },
    { ...base, number: Number.MAX_SAFE_INTEGER + 1 },
    { ...base, body: null },
    { ...base, mergedAt: null },
    { ...base, mergedAt: 'bad date' },
  ])
    assert.throws(() => report([row]), TypeError);
  assert.throws(() => report([base, base]), TypeError);
  assert.deepEqual(report([]).scope, { mergedPullRequests: 0, firstMergedAt: null, lastMergedAt: null });
});

test('CLI reads only a supplied export, emits JSON, and fails clearly without valid input', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'prevention-report-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'prs.json');
  const script = fileURLToPath(new URL('../scripts/prevention-report.mjs', import.meta.url));
  writeFileSync(file, JSON.stringify([record(1, 'Bug class: stale-async-results\nRecurs after: none known')]));
  const result = spawnSync(process.execPath, [script, file], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).byClass, { 'stale-async-results': 1 });
  assert.deepEqual(main([file]).unknownRecurrence, []);
  for (const args of [[], [file, file], [path.join(dir, 'missing.json')]]) {
    const failed = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    assert.equal(failed.status, 1);
    assert.equal(failed.stdout, '');
    assert.ok(failed.stderr.length);
  }
  writeFileSync(file, '{');
  assert.throws(() => main([file]), SyntaxError);
  assert.throws(() => main([]), /Usage/);
  const imported = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(new URL('../scripts/prevention-report.mjs', import.meta.url).href)})`],
    { encoding: 'utf8' },
  );
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout, '');
});
