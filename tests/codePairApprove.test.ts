// The app's side of the person's proof (electron/host/codePairApprove.cjs, #5576): the helper is run with the Host's
// fields, its answers are checked, its refusals keep their code, and nothing is allowed without it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { approveHelperPath, createApprover, PROMPT_MS } = createRequire(import.meta.url)('../electron/host/codePairApprove.cjs');
const KEY = `${'A'.repeat(86)}A=`;
const SIG = 'MEUCIQ'.padEnd(40, 'A');

/** A stand-in for execFile: records what was asked and answers as told. */
function fake(answer: { stdout?: string; error?: any }) {
  const calls: any[] = [];
  const run = (file: string, args: string[], options: any, done: any) => {
    const child = { stdin: { end: (input?: string) => calls.push({ file, args, options, input }) } };
    queueMicrotask(() => done(answer.error ?? null, answer.stdout ?? ''));
    return child;
  };
  return { calls, run };
}

test('the helper is found in the packaged app, or in the checkout', () => {
  assert.equal(
    approveHelperPath({ packaged: true, resourcesPath: '/A.app/Contents/Resources' }),
    '/A.app/Contents/Helpers/code-pair-approve',
  );
  assert.equal(approveHelperPath({ repoRoot: '/repo' }), '/repo/native/code-pair-approve/build/code-pair-approve');
  assert.match(approveHelperPath(), /native\/code-pair-approve\/build\/code-pair-approve$/);
});

test('enrol runs the helper with the Host id and returns its key and proof, checked', async () => {
  const f = fake({ stdout: JSON.stringify({ key: KEY, weak: true, signature: SIG }) });
  const a = createApprover({ helper: '/h', run: f.run, platform: 'darwin' });
  assert.deepEqual(await a.enrol('h_x'), { key: KEY, weak: true, signature: SIG });
  assert.deepEqual(
    [f.calls[0].file, f.calls[0].args, f.calls[0].input, f.calls[0].options.timeout],
    ['/h', ['enrol', 'h_x'], undefined, PROMPT_MS],
  );
  for (const bad of [
    { key: 'x', weak: true, signature: SIG },
    { key: KEY, weak: 'no', signature: SIG },
    { key: KEY, weak: false, signature: '!' },
  ]) {
    const g = fake({ stdout: JSON.stringify(bad) });
    await assert.rejects(createApprover({ helper: '/h', run: g.run, platform: 'darwin' }).enrol('h_x'), { code: 'failed' });
  }
});

test("approve hands the helper the Host's fields on stdin, never a text, and returns its signature", async () => {
  const f = fake({ stdout: JSON.stringify({ sig: SIG }) });
  const fields = { hostId: 'h', offerId: 'r_x', name: 'Mac' };
  assert.deepEqual(await createApprover({ helper: '/h', run: f.run, platform: 'darwin' }).approve(fields), { sig: SIG });
  assert.deepEqual([f.calls[0].args, JSON.parse(f.calls[0].input)], [['approve'], fields]);
  const g = fake({ stdout: JSON.stringify({ sig: 'not a sig!' }) });
  await assert.rejects(createApprover({ helper: '/h', run: g.run, platform: 'darwin' }).approve(fields), { code: 'failed' });
});

test('a refusal keeps its code: the person cancelled, no key, a missing helper, a crash, no answer, not a Mac', async () => {
  const cases: [any, string][] = [
    [
      {
        stdout: JSON.stringify({ error: { code: 'not_approved', message: 'Cancelled' } }),
        error: Object.assign(new Error('exit 1'), { code: 1 }),
      },
      'not_approved',
    ],
    [{ stdout: JSON.stringify({ error: { code: 'no_key' } }) }, 'no_key'],
    [{ error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) }, 'no_helper'],
    [{ error: new Error('killed'), stdout: 'garbage' }, 'failed'],
    [{ stdout: '' }, 'failed'],
    [{ stdout: '7' }, 'failed'],
  ];
  for (const [answer, code] of cases) {
    const f = fake(answer);
    await assert.rejects(createApprover({ helper: '/h', run: f.run, platform: 'darwin' }).approve({}), { code }, code);
  }
  const f = fake({ stdout: '{}' });
  await assert.rejects(createApprover({ helper: '/h', run: f.run, platform: 'linux' }).approve({}), { code: 'unsupported_platform' });
  assert.equal(f.calls.length, 0, 'nothing is run off a Mac');
});

test('commit and abort follow an enrolment: the staged key is kept or dropped', async () => {
  const f = fake({ stdout: JSON.stringify({ committed: true }) });
  assert.deepEqual(await createApprover({ helper: '/h', run: f.run, platform: 'darwin' }).commit(), { committed: true });
  const g = fake({ stdout: JSON.stringify({ aborted: true }) });
  assert.deepEqual(await createApprover({ helper: '/h', run: g.run, platform: 'darwin' }).abort(), { aborted: true });
  assert.deepEqual([f.calls[0].args, g.calls[0].args], [['commit'], ['abort']]);
});

test('reset asks the helper to remove the key', async () => {
  const f = fake({ stdout: JSON.stringify({ reset: true }) });
  assert.deepEqual(await createApprover({ helper: '/h', run: f.run, platform: 'darwin' }).reset(), { reset: true });
  assert.deepEqual(f.calls[0].args, ['reset']);
});
