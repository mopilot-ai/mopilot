// MoMo notice evaluation gate (shared/momoNotice/eval/): the 62 re-labelled OpenDuet mails, the pre-check run that must silence nothing that matters, a scripted model run, the gate, our own end-to-end scenarios, and the verdict file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runScenario, runScenarios, SCENARIOS, scriptedModel, type Scenario } from '../shared/momoNotice/eval/scenarios.ts';
import {
  gate,
  loadTriageSet,
  MODEL_GATE,
  PRECHECK_GATE,
  runPreCheckEval,
  runTriageEval,
  summarize,
  type EvalCase,
} from '../shared/momoNotice/eval/triageEval.ts';
import { main, runNoticeEval } from '../scripts/momo-notice-eval.mjs';
import type { ReaderModel } from '../shared/momoNotice/types.ts';

const cases: EvalCase[] = loadTriageSet(readFileSync(new URL('../shared/momoNotice/eval/triage-62.jsonl', import.meta.url), 'utf8'));

test('the set is the 62 OpenDuet mails re-labelled to three outcomes', () => {
  assert.equal(cases.length, 62);
  const count = (label: string) => cases.filter((c) => c.expected === label).length;
  assert.deepEqual([count('tell_now'), count('track'), count('quiet')], [22, 6, 34]);
  assert.equal(cases.filter((c) => c.openduetLabel === 'needs_you').length, 27);
  assert.equal(new Set(cases.map((c) => c.id)).size, 62);
  assert.equal(new Set(cases.map((c) => c.mail.subject)).size, 62);
  assert.ok(cases.filter((c) => c.hard).length >= 10);
});

test('a line that is not an eval case fails the load', () => {
  assert.throws(() => loadTriageSet('{"id":"x","expected":"maybe","mail":{"body":""}}'), /Line 1/);
  assert.throws(() => loadTriageSet('{"id":"x","expected":"quiet"}'), /Line 1/);
  assert.throws(() => loadTriageSet('not json'));
  const one = '{"id":"x","expected":"quiet","mail":{"body":""}}';
  assert.throws(() => loadTriageSet(`${one}\n${one}`), /repeats an id/);
  assert.throws(() => loadTriageSet(one, 2), /1 cases, not 2/);
  assert.equal(loadTriageSet(one, 1).length, 1);
  assert.deepEqual(loadTriageSet('\n\n'), []);
});

test('the pre-checks silence no labelled mail that matters and settle a real share of the noise', () => {
  const lines = runPreCheckEval(cases);
  const summary = summarize(lines);
  assert.deepEqual(summary.missed, []);
  assert.deepEqual(gate(summary, PRECHECK_GATE), []);
  assert.ok(summary.byRule >= 12, `rules decided ${summary.byRule}`);
  assert.ok(lines.every((l) => l.got === 'quiet' || l.got === 'needs_model'));
  // the hard cases that must reach the model
  for (const id of ['n26', 'n27', 'n06', 'n19', 'n23', 'c26', 'c25']) assert.equal(lines.find((l) => l.id === id)?.got, 'needs_model', id);
  assert.deepEqual(lines.find((l) => l.id === 'n06') && lines.find((l) => l.id === 'n06')?.decidedBy, 'none');
});

/** A model that answers each mail's expected verdict, found by its subject in the prompt; `flip` changes chosen ids. */
function oracle(flip: Record<string, 'tell_now' | 'track' | 'quiet' | 'throw'> = {}): ReaderModel {
  return {
    name: 'oracle',
    complete: async (prompt) => {
      const c = cases.find((candidate) => prompt.includes(`Subject: ${candidate.mail.subject.replace(/\r?\n/g, ' ')}\n`)) as EvalCase;
      const verdict = flip[c.id] ?? c.expected;
      if (verdict === 'throw') throw new Error('model down');
      return JSON.stringify({ verdict, reason: 'Scripted.', matterKey: c.mail.threadId });
    },
  };
}
let counter = 0;
const ids = () => `rid-${(counter += 1)}-padding`;

test('a perfect scripted model passes the model gate; every case yields one verdict line', async () => {
  const lines = await runTriageEval(cases, { model: oracle(), randomId: ids });
  assert.equal(lines.length, 62);
  const summary = summarize(lines);
  assert.deepEqual(
    [summary.correct, summary.accuracy, summary.missed, summary.overAlerts, summary.unsorted, summary.hardFailed],
    [62, 1, [], [], [], []],
  );
  assert.deepEqual(gate(summary, MODEL_GATE), []);
  assert.ok(lines.some((l) => l.decidedBy === 'model:oracle') && lines.some((l) => l.decidedBy.startsWith('rule:')));
});

test('the gate blocks silenced mail, too many pushes, failures, a lower score and hard-case regressions', async () => {
  const lines = await runTriageEval(cases, {
    model: oracle({ n01: 'quiet', c01: 'tell_now', c06: 'tell_now', c11: 'tell_now', n02: 'throw', n03: 'track' }),
    randomId: ids,
  });
  const summary = summarize(lines);
  assert.deepEqual(summary.missed, ['n01']);
  assert.deepEqual(summary.overAlerts, ['c06', 'c11']);
  assert.deepEqual(summary.unsorted, ['n02']);
  const failures = gate(summary, { ...MODEL_GATE, accuracyMin: 0.99, overAlertsMax: 1 }, ['n06', 'c17']);
  assert.equal(failures.length, 4);
  assert.match(failures.join(' '), /Accuracy .* below 0.99/);
  assert.match(failures.join(' '), /Silenced mail that matters: n01/);
  assert.match(failures.join(' '), /Too many pushes for quiet mail: c06, c11/);
  assert.match(failures.join(' '), /Could not be sorted: n02/);
  const hard = summarize(await runTriageEval(cases, { model: oracle({ c17: 'tell_now' }), randomId: ids }));
  assert.deepEqual(gate(hard, { ...MODEL_GATE, overAlertsMax: 5 }, ['c17', 'n06']), ['Hard cases that passed before now fail: c17.']);
  assert.deepEqual(summarize([]).accuracy, 0);
});

test('the runner writes every verdict to files and reports an open gate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'momo-eval-'));
  try {
    assert.deepEqual(await runNoticeEval(join(dir, 'nested')), []);
    const read = (name: string) =>
      readFileSync(join(dir, 'nested', name), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
    assert.equal(read('prechecks.jsonl').length, 67);
    assert.ok(read('scenarios.jsonl').every((line) => line.ok));
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'nested', 'summary.json'), 'utf8')).failures, []);
    const lines: string[] = [];
    const errors: string[] = [];
    assert.equal(await main(['--out', join(dir, 'cli')], { log: (l: string) => lines.push(l), error: (l: string) => errors.push(l) }), 0);
    assert.deepEqual([lines, errors], [['momo-notice-eval: passed'], []]);
    assert.equal(await main([], { error: (l: string) => errors.push(l) }), 2);
    assert.equal(await main(['--out'], { error: (l: string) => errors.push(l) }), 2);
    assert.match(errors.join('\n'), /usage/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the runner exits 1 and says what failed when the gate blocks', async () => {
  const set = readFileSync(new URL('../shared/momoNotice/eval/triage-62.jsonl', import.meta.url), 'utf8');
  const own = readFileSync(new URL('../shared/momoNotice/eval/triage-own.jsonl', import.meta.url), 'utf8');
  const bad = (file: string) => (file.endsWith('triage-own.jsonl') ? own : set.replaceAll('"expected": "quiet"', '"expected": "tell_now"'));
  const written: Record<string, string> = {};
  const errors: string[] = [];
  const logs: string[] = [];
  const code = await main(['--out', 'out'], {
    read: bad,
    write: (file: string, text: string) => void (written[file] = text),
    mkdir: () => undefined,
    log: (l: string) => logs.push(l),
    error: (l: string) => errors.push(l),
  });
  assert.equal(code, 1);
  assert.match(logs[0], /failure/);
  assert.match(errors[0], /Accuracy|Silenced|Too many/);
  assert.deepEqual(
    Object.keys(written).map((f) => f.split('/').pop()),
    ['prechecks.jsonl', 'scenarios.jsonl', 'summary.json'],
  );
});

test('our own scenarios all pass, and each produces readable lines', async () => {
  const lines = await runScenarios();
  assert.ok(lines.length > 30);
  assert.deepEqual(
    lines.filter((l) => !l.ok),
    [],
  );
  for (const name of [
    'quiet hours',
    'daily cap',
    'one nudge',
    'snooze',
    'slept',
    'instructions',
    'spoofed',
    'mixed-language',
    'brief is claimed',
  ])
    assert.ok(
      SCENARIOS.some((s) => s.name.includes(name)),
      name,
    );
});

test('a scenario that expects the wrong thing is reported as failed, not hidden', async () => {
  const wrong: Scenario = {
    name: 'wrong',
    steps: [
      {
        kind: 'pass',
        at: '2026-11-24T10:00:00Z',
        items: [{ mail: { threadId: 'w' }, answer: { verdict: 'tell_now' }, expect: { outcome: 'quiet' } }],
        expectCatchUp: 2,
      },
      { kind: 'snooze', at: '2026-11-24T10:00:00Z', matterKey: 'missing', until: '2026-11-24T12:00:00Z' },
      { kind: 'brief', at: '2026-11-24T12:00:00Z', expect: { sent: false } },
    ],
  };
  const lines = await runScenario(wrong);
  assert.deepEqual(
    lines.map((l) => l.ok),
    [false, false, false, false],
  );
});

test('a brief step without counts only checks that it was sent, and a scripted model with no answer left fails loudly', async () => {
  const sent: Scenario = {
    name: 'sent',
    steps: [
      {
        kind: 'pass',
        at: '2026-11-24T10:00:00Z',
        items: [{ mail: { threadId: 's' }, answer: { verdict: 'tell_now' }, expect: { outcome: 'tell_now' } }],
      },
      { kind: 'brief', at: '2026-11-24T12:00:00Z', expect: { sent: true } },
    ],
  };
  assert.deepEqual(
    (await runScenario(sent)).map((l) => l.ok),
    [true, true],
  );
  const model = scriptedModel([{ verdict: 'quiet' }]);
  assert.match(await model.complete('p'), /"quiet"/);
  await assert.rejects(model.complete('p'), /No scripted answer left/);
});

test('the command line runs as a script and writes its files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'momo-eval-cli-'));
  try {
    const script = new URL('../scripts/momo-notice-eval.mjs', import.meta.url).pathname;
    const out = execFileSync(process.execPath, [script, '--out', dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    assert.match(out, /momo-notice-eval: passed/);
    assert.ok(existsSync(join(dir, 'summary.json')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const ownCases: EvalCase[] = loadTriageSet(readFileSync(new URL('../shared/momoNotice/eval/triage-own.jsonl', import.meta.url), 'utf8'), 5);

test('our own cases: a security alert or failed payment with a link must reach the model, a bare code or reset link stays quiet', () => {
  const lines = runPreCheckEval(ownCases);
  assert.deepEqual(
    lines.map((l) => [l.id, l.got]),
    [
      ['o01', 'needs_model'],
      ['o02', 'needs_model'],
      ['o03', 'needs_model'],
      ['o04', 'quiet'],
      ['o05', 'quiet'],
    ],
  );
  assert.deepEqual(summarize(lines).missed, []);
  assert.deepEqual(gate(summarize(lines), PRECHECK_GATE), []);
  assert.ok(ownCases.every((c) => /https?:\/\//.test(c.mail.body) || c.id === 'o04'));
});

test('a perfect scripted model passes our own cases too, and silencing one fails the gate', async () => {
  const all = [...cases, ...ownCases];
  const model: ReaderModel = {
    name: 'oracle',
    complete: async (prompt) => {
      const c = all.find((candidate) => prompt.includes(`Subject: ${candidate.mail.subject}\n`)) as EvalCase;
      return JSON.stringify({ verdict: c.expected, reason: 'Scripted.', matterKey: `gmail:${c.mail.threadId}` });
    },
  };
  const lines = await runTriageEval(ownCases, { model, randomId: ids });
  assert.deepEqual(gate(summarize(lines), MODEL_GATE), []);
  const silenced = lines.map((l) => (l.id === 'o02' ? { ...l, got: 'quiet' as const, ok: false } : l));
  assert.match(gate(summarize(silenced), MODEL_GATE).join(' '), /Silenced mail that matters: o02/);
});

test('a constant boundary id is refused by the evaluation too', async () => {
  const model: ReaderModel = { name: 'x', complete: async () => '{}' };
  await assert.rejects(runTriageEval(cases, { model, randomId: () => 'constant-id' }), /fresh value/);
});
