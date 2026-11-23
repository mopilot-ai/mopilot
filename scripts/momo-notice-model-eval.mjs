#!/usr/bin/env node
// Runs MoMo's notice evaluation with a real model in the loop (the 62 labelled mails and our own five), writes every verdict to files, counts silenced-important and over-alert mails against the model gate, and exits 1 when the gate blocks.
//   MOMO_EVAL_API_KEY=... node scripts/momo-notice-model-eval.mjs --out <folder>
// The gate decides whether tell-now pushes may be enabled; it is also the evidence to read after a week in brief-only mode. It reads no mail account and sends only the invented eval mails.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomMarkerId } from '../shared/momoNotice/envelope.ts';
import { gate, loadTriageSet, MODEL_GATE, runTriageEval, summarize, toJsonl } from '../shared/momoNotice/eval/triageEval.ts';

const SET = fileURLToPath(new URL('../shared/momoNotice/eval/triage-62.jsonl', import.meta.url));
const OWN = fileURLToPath(new URL('../shared/momoNotice/eval/triage-own.jsonl', import.meta.url));
/** The cheapest current model: the home's background model is Sonnet-class or cheaper. */
export const DEFAULT_MODEL = 'claude-haiku-5-5';
const ENDPOINT = 'https://api.anthropic.com/v1/messages';

/**
 * @typedef {object} ModelEvalIo Injected so a test can run without the disk or the network.
 * @property {typeof fetch} [fetch]
 * @property {Record<string, string | undefined>} [env]
 * @property {(file: string, encoding: 'utf8') => string | Buffer} [read]
 * @property {(file: string, text: string) => void} [write]
 * @property {(dir: string, options: { recursive: true }) => unknown} [mkdir]
 * @property {(line: string) => void} [log]
 * @property {(line: string) => void} [error]
 */

/**
 * The reading model over the Messages API, with no tools offered: a prompt in, the answer's text out. `usage` counts what a run cost.
 * @param {{ fetch: typeof fetch, apiKey: string, model: string, usage: { calls: number, inputTokens: number, outputTokens: number } }} o
 * @returns {import('../shared/momoNotice/types.d.ts').ReaderModel}
 */
export function messagesModel({ fetch: doFetch, apiKey, model, usage }) {
  return {
    name: model,
    async complete(prompt, signal) {
      const response = await doFetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: 400, messages: [{ role: 'user', content: prompt }] }),
        ...(signal ? { signal } : {}),
      });
      if (!response.ok) throw new Error(`The model answered ${response.status}.`);
      const body = /** @type {any} */ (await response.json());
      usage.calls += 1;
      usage.inputTokens += Number(body.usage?.input_tokens ?? 0);
      usage.outputTokens += Number(body.usage?.output_tokens ?? 0);
      return String(body.content?.[0]?.text ?? '');
    },
  };
}

/**
 * Runs every labelled mail through the reading turn and writes `verdicts.jsonl` and `summary.json` into `out`. Returns the failures (empty: the gate is open).
 * @param {string} out
 * @param {ModelEvalIo} [io]
 * @returns {Promise<string[]>}
 */
export async function runModelEval(
  out,
  { fetch: doFetch = globalThis.fetch, env = process.env, read = readFileSync, write = writeFileSync, mkdir = mkdirSync } = {},
) {
  const apiKey = env.MOMO_EVAL_API_KEY;
  if (!apiKey) return ['MOMO_EVAL_API_KEY is not set, so no model was asked.'];
  const model = env.MOMO_EVAL_MODEL || DEFAULT_MODEL;
  const cases = [...loadTriageSet(String(read(SET, 'utf8')), 62), ...loadTriageSet(String(read(OWN, 'utf8')), 5)];
  const usage = { calls: 0, inputTokens: 0, outputTokens: 0 };
  const lines = await runTriageEval(cases, { model: messagesModel({ fetch: doFetch, apiKey, model, usage }), randomId: randomMarkerId });
  const summary = summarize(lines);
  const failures = gate(summary, MODEL_GATE);
  mkdir(out, { recursive: true });
  write(path.join(out, 'verdicts.jsonl'), toJsonl(lines));
  write(
    path.join(out, 'summary.json'),
    `${JSON.stringify({ model, cases: cases.length, silencedImportant: summary.missed, overAlerts: summary.overAlerts, unsorted: summary.unsorted, accuracy: summary.accuracy, usage, failures }, null, 2)}\n`,
  );
  return failures;
}

/**
 * The command line: returns the exit code.
 * @param {string[]} argv
 * @param {ModelEvalIo} [io]
 */
export async function main(argv, { log = console.log, error = console.error, ...io } = {}) {
  const at = argv.indexOf('--out');
  if (at < 0 || !argv[at + 1]) {
    error('usage: MOMO_EVAL_API_KEY=... node scripts/momo-notice-model-eval.mjs --out <folder>');
    return 2;
  }
  const failures = await runModelEval(argv[at + 1], io);
  for (const failure of failures) error(failure);
  log(failures.length ? `momo-notice-model-eval: ${failures.length} failure(s)` : 'momo-notice-model-eval: passed');
  return failures.length ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
