// The model-in-the-loop eval runner (scripts/momo-notice-model-eval.mjs): over a fake Messages API it reads all 67 labelled mails, counts silenced-important and over-alert mails against the gate, writes every verdict, and fails closed without a key or on an API error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_MODEL, main, messagesModel, runModelEval } from '../scripts/momo-notice-model-eval.mjs';
import { loadTriageSet } from '../shared/momoNotice/eval/triageEval.ts';

const cases = [
  ...loadTriageSet(readFileSync(new URL('../shared/momoNotice/eval/triage-62.jsonl', import.meta.url), 'utf8'), 62),
  ...loadTriageSet(readFileSync(new URL('../shared/momoNotice/eval/triage-own.jsonl', import.meta.url), 'utf8'), 5),
];

/** The answer the fake model gives for a prompt: the expected verdict of the case whose subject is in it, or the override. */
const verdictFor = (prompt: string, override?: (id: string, expected: string) => string) => {
  const found = cases.find((c) => prompt.includes(c.mail.subject));
  const expected = found?.expected ?? 'quiet';
  return JSON.stringify({ verdict: override ? override(found?.id ?? '', expected) : expected, reason: 'Because.', matterKey: 'gmail:x' });
};
const fakeFetch = (override?: (id: string, expected: string) => string, seen: any[] = []): typeof fetch =>
  (async (url: string, init: any) => {
    const body = JSON.parse(init.body);
    seen.push({ url, headers: init.headers, body });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        content: [{ text: verdictFor(body.messages[0].content, override) }],
        usage: { input_tokens: 100, output_tokens: 10 },
      }),
    };
  }) as unknown as typeof fetch;

const memory = () => {
  const files = new Map<string, string>();
  return {
    files,
    io: {
      read: (file: string) => readFileSync(file, 'utf8'),
      write: (file: string, text: string) => void files.set(file.split('/').pop() as string, text),
      mkdir: () => undefined,
    },
  };
};

test('a model that reads every mail as labelled opens the gate; every verdict and the usage are written', async () => {
  const seen: any[] = [];
  const disk = memory();
  const failures = await runModelEval('out', { fetch: fakeFetch(undefined, seen), env: { MOMO_EVAL_API_KEY: 'k' }, ...disk.io });
  assert.deepEqual(failures, []);
  const summary = JSON.parse(disk.files.get('summary.json') as string);
  assert.deepEqual(
    [summary.model, summary.cases, summary.silencedImportant, summary.overAlerts, summary.unsorted],
    [DEFAULT_MODEL, 67, [], [], []],
  );
  // mails the pre-checks silence never reach the model
  assert.ok(summary.usage.calls < 67 && summary.usage.calls > 40);
  assert.deepEqual([summary.usage.inputTokens, summary.usage.outputTokens], [summary.usage.calls * 100, summary.usage.calls * 10]);
  assert.equal(disk.files.get('verdicts.jsonl')?.trim().split('\n').length, 67);
  // no tools are offered, the key goes in its own header
  assert.ok(seen.every((r) => r.body.tools === undefined && r.headers['x-api-key'] === 'k' && r.url.endsWith('/v1/messages')));
});

test('silenced-important and over-alert mails are counted and block the gate', async () => {
  const disk = memory();
  const failures = await runModelEval('out', {
    fetch: fakeFetch((_id, expected) => (expected === 'tell_now' ? 'quiet' : expected === 'quiet' ? 'tell_now' : expected)),
    env: { MOMO_EVAL_API_KEY: 'k', MOMO_EVAL_MODEL: 'some-model' },
    ...disk.io,
  });
  const summary = JSON.parse(disk.files.get('summary.json') as string);
  assert.equal(summary.model, 'some-model');
  assert.ok(summary.silencedImportant.length > 0 && summary.overAlerts.length > 2);
  assert.ok(failures.some((f) => f.startsWith('Silenced mail that matters')) && failures.some((f) => f.startsWith('Too many pushes')));
});

test('no key asks no model; an API error leaves the mail unsorted, never a default', async () => {
  assert.deepEqual(await runModelEval('out', { env: {} }), ['MOMO_EVAL_API_KEY is not set, so no model was asked.']);
  const disk = memory();
  const broken = (async () => ({ ok: false, status: 529 })) as unknown as typeof fetch;
  const failures = await runModelEval('out', { fetch: broken, env: { MOMO_EVAL_API_KEY: 'k' }, ...disk.io });
  assert.ok(failures.some((f) => f.startsWith('Could not be sorted')));
  assert.equal(JSON.parse(disk.files.get('summary.json') as string).usage.calls, 0);
});

test('the model adapter passes an abort signal on and tolerates a body without usage or content', async () => {
  const usage = { calls: 0, inputTokens: 0, outputTokens: 0 };
  let signalSeen: unknown;
  const fetcher = (async (_url: string, init: any) => {
    signalSeen = init.signal;
    return { ok: true, status: 200, json: async () => ({}) };
  }) as unknown as typeof fetch;
  const model = messagesModel({ fetch: fetcher, apiKey: 'k', model: 'm', usage });
  const controller = new AbortController();
  assert.equal(await model.complete('p', controller.signal), '');
  assert.equal(signalSeen, controller.signal);
  assert.deepEqual(usage, { calls: 1, inputTokens: 0, outputTokens: 0 });
});

test('the command line needs --out and returns the exit code', async () => {
  const logs: string[] = [];
  const errors: string[] = [];
  assert.equal(await main([], { log: (l) => logs.push(l), error: (l) => errors.push(l) }), 2);
  assert.match(errors[0], /usage/);
  assert.equal(await main(['--out', 'x'], { env: {}, log: (l) => logs.push(l), error: (l) => errors.push(l) }), 1);
  assert.match(logs.at(-1) as string, /1 failure/);
  const disk = memory();
  assert.equal(
    await main(['--out', 'x'], { fetch: fakeFetch(), env: { MOMO_EVAL_API_KEY: 'k' }, log: (l) => logs.push(l), ...disk.io }),
    0,
  );
  assert.match(logs.at(-1) as string, /passed/);
});

test('the command line runs as a script and fails closed without a key', () => {
  const script = new URL('../scripts/momo-notice-model-eval.mjs', import.meta.url).pathname;
  const env = { ...process.env };
  delete env.MOMO_EVAL_API_KEY;
  let output = '';
  try {
    execFileSync(process.execPath, [script, '--out', join(tmpdir(), 'momo-notice-model-eval-unused')], {
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.fail('the script should exit 1');
  } catch (error) {
    const failed = error as { status: number; stderr: string; stdout: string };
    output = `${failed.stderr}${failed.stdout}`;
    assert.equal(failed.status, 1);
  }
  assert.match(output, /MOMO_EVAL_API_KEY is not set/);
});
