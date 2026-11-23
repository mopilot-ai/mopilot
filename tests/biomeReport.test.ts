// Biome report consumers fail closed with bounded process/fixture evidence while preserving valid lint findings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeBiomeReport, type BiomeResult } from '../scripts/biome-report.mjs';

const context = { file: 'src/.lint-fixture-case/view.tsx', input: 'export const f = () => 1;\n' };
const result = (values: Partial<BiomeResult> = {}): BiomeResult => ({
  status: 0,
  signal: null,
  stdout: '{"diagnostics":[]}',
  stderr: '',
  ...values,
});

function failure(values: Partial<BiomeResult>, input: { file: string; input?: string } = context) {
  let caught: unknown;
  try {
    decodeBiomeReport(result(values), input);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error, 'invalid output must throw instead of becoming no warnings');
  return caught;
}

test('valid reports preserve findings, optional locations and extra fields for zero and nonzero lint exits', () => {
  const report = {
    command: 'lint',
    summary: { warnings: 4 },
    diagnostics: [
      { message: '[guard] warning', severity: 'warning', category: 'plugin', location: { path: 'view.tsx', start: { line: 2 } } },
      { message: 'global', severity: 'information' },
      { message: 'null location', severity: 'warning', location: null },
      { message: 'path only', severity: 'warning', location: { path: 'view.tsx' } },
      { message: 'no path', severity: 'warning', location: { start: null } },
      { message: 'extra fields', severity: 'warning', location: { start: { column: 4 } }, advices: [] },
    ],
  };
  for (const status of [0, 1])
    assert.deepEqual(
      decodeBiomeReport(result({ status, stdout: ` \n${JSON.stringify(report, null, 2)}\n`, stderr: 'lint findings' }), context),
      report,
    );
  assert.deepEqual(decodeBiomeReport(result(), { file: 'all configured files' }), { diagnostics: [] });
});

test('empty, malformed and truncated output retains SyntaxError and all process/fixture context', () => {
  for (const stdout of ['', ' ', '{"diagnostics":', '{"diagnostics":[]} trailing']) {
    const error = failure({ status: 1, stdout, stderr: 'configuration failed\nline 2' });
    assert.ok(error.cause instanceof SyntaxError);
    assert.match(error.message, /status=1; signal=none/);
    assert.ok(error.message.includes(JSON.stringify(context.file)));
    assert.ok(error.message.includes(JSON.stringify(context.input)));
    assert.ok(error.message.includes(`stdout=${JSON.stringify(stdout)}`));
    assert.ok(error.message.includes('stderr="configuration failed\\nline 2"'));
  }
  assert.ok(failure({ stdout: null }).cause instanceof SyntaxError);
  assert.ok(failure({ stdout: undefined }).cause instanceof SyntaxError);
  assert.match(
    failure({ stdout: '', stderr: undefined }, { file: 'all configured files', input: undefined }).message,
    /input=<unavailable>/,
  );
});

test('wrong report or diagnostic field shapes never become empty or usable reports', () => {
  for (const report of [null, [], 1, false, 'text', {}, { diagnostics: null }, { diagnostics: {} }, { diagnostics: 'empty' }])
    assert.ok(failure({ stdout: JSON.stringify(report) }).cause instanceof TypeError, JSON.stringify(report));
  for (const diagnostic of [
    null,
    [],
    1,
    {},
    { message: null },
    { message: 'missing severity' },
    { message: 'null severity', severity: null },
    { message: 1 },
    { message: 'x', severity: 1 },
    { message: 'x', severity: 'warning', category: null },
    { message: 'x', severity: 'warning', location: [] },
    { message: 'x', severity: 'warning', location: 'file' },
    { message: 'x', severity: 'warning', location: { path: 1 } },
    { message: 'x', severity: 'warning', location: { start: [] } },
    { message: 'x', severity: 'warning', location: { start: 'line' } },
    { message: 'x', severity: 'warning', location: { start: { line: '2' } } },
  ])
    assert.ok(failure({ stdout: JSON.stringify({ diagnostics: [diagnostic] }) }).cause instanceof TypeError, JSON.stringify(diagnostic));
});

test('spawn failures preserve the original error even if stdout contains a complete report', () => {
  const cause = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
  const error = failure({ error: cause, status: null, stdout: null, stderr: null });
  assert.equal(error.cause, cause);
  assert.match(error.message, /cause="spawn ENOENT"/);
  assert.match(error.message, /status=null; signal=none/);
  assert.match(error.message, /stderr=<unavailable>\nstdout=<unavailable>/);
  assert.equal(failure({ error: cause }).cause, cause);
  const unusual = failure({ error: 'non-Error rejection' as unknown as Error });
  assert.equal(unusual.cause, 'non-Error rejection');
  assert.match(unusual.message, /cause="non-Error rejection"/);
});

test('signaled or incomplete processes fail even after emitting valid JSON; wrapper exit-zero empty output also fails', () => {
  for (const values of [
    { status: null, signal: 'SIGTERM' },
    { status: 0, signal: 'SIGTERM' },
    { status: null, signal: null },
    { status: 2, signal: null },
  ] as const) {
    const error = failure(values);
    assert.ok(error.cause instanceof Error);
    assert.equal(error.cause.message, 'Biome did not complete normally');
    assert.ok(error.message.includes(`status=${values.status}; signal=${values.signal ?? 'none'}`));
  }
  assert.ok(failure({ status: 0, stdout: '', stderr: '' }).cause instanceof SyntaxError);
});

test('failure messages bound stdout, stderr and fixture context and distinguish exact-limit text from truncation', () => {
  const long = `${'x'.repeat(2048)}hidden-tail`;
  const error = failure({ stdout: long, stderr: long, error: new Error(long) }, { file: long, input: long });
  assert.ok(error.message.length < 11000);
  assert.equal(error.message.includes('hidden-tail'), false);
  assert.equal(error.message.match(/11 more characters/g)?.length, 5);
  const exact = failure({ stdout: 'x'.repeat(2048), stderr: '' });
  assert.equal(exact.message.includes('more characters'), false);
  assert.match(exact.message, /stderr=""/);
});
