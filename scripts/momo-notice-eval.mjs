#!/usr/bin/env node
// Runs MoMo's notice evaluation that needs no model (the pre-checks over the 62 labelled mails, and our own scenarios), writes every verdict to files, and exits 1 when the gate blocks.
//   node scripts/momo-notice-eval.mjs --out <folder>
// A model run (`runTriageEval` with the home's reading model) writes its lines the same way; see shared/momoNotice/README.md.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScenarios } from '../shared/momoNotice/eval/scenarios.ts';
import { gate, loadTriageSet, PRECHECK_GATE, runPreCheckEval, summarize, toJsonl } from '../shared/momoNotice/eval/triageEval.ts';

const SET = fileURLToPath(new URL('../shared/momoNotice/eval/triage-62.jsonl', import.meta.url));
const OWN = fileURLToPath(new URL('../shared/momoNotice/eval/triage-own.jsonl', import.meta.url));

/**
 * @typedef {object} EvalIo Injected so a test can run without the disk.
 * @property {(file: string, encoding: 'utf8') => string | Buffer} [read]
 * @property {(file: string, text: string) => void} [write]
 * @property {(dir: string, options: { recursive: true }) => unknown} [mkdir]
 * @property {(line: string) => void} [log]
 * @property {(line: string) => void} [error]
 */

/**
 * Runs both checks and writes `prechecks.jsonl`, `scenarios.jsonl` and `summary.json` into `out`. Returns the failures (empty: the gate is open).
 * @param {string} out
 * @param {EvalIo} [io]
 * @returns {Promise<string[]>}
 */
export async function runNoticeEval(out, { read = readFileSync, write = writeFileSync, mkdir = mkdirSync } = {}) {
  const lines = runPreCheckEval([...loadTriageSet(String(read(SET, 'utf8')), 62), ...loadTriageSet(String(read(OWN, 'utf8')), 5)]);
  const scenarios = await runScenarios();
  const summary = summarize(lines);
  const failures = [
    ...gate(summary, PRECHECK_GATE),
    ...scenarios
      .filter((line) => !line.ok)
      .map((line) => `Scenario "${line.scenario}" step ${line.step} (${line.item}): expected ${line.expected}, got ${line.got}.`),
  ];
  mkdir(out, { recursive: true });
  write(path.join(out, 'prechecks.jsonl'), toJsonl(lines));
  write(path.join(out, 'scenarios.jsonl'), toJsonl(scenarios));
  write(path.join(out, 'summary.json'), `${JSON.stringify({ summary, failures }, null, 2)}\n`);
  return failures;
}

/**
 * The command line: returns the exit code.
 * @param {string[]} argv
 * @param {EvalIo} [io]
 */
export async function main(argv, { log = console.log, error = console.error, ...io } = {}) {
  const at = argv.indexOf('--out');
  if (at < 0 || !argv[at + 1]) {
    error('usage: node scripts/momo-notice-eval.mjs --out <folder>');
    return 2;
  }
  const failures = await runNoticeEval(argv[at + 1], io);
  for (const failure of failures) error(failure);
  log(failures.length ? `momo-notice-eval: ${failures.length} failure(s)` : 'momo-notice-eval: passed');
  return failures.length ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
