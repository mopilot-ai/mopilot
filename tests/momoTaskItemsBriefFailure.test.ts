// MoMo task words (shared/momoTasks/brief.ts, failure.ts): the brief, the report and check parsing, and the real cause plus fixes for every failure, per harness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBrief, buildCheckPrompt, FORBIDDEN_TOOLS, isUnprompted, parseCheck, parseReport } from '../shared/momoTasks/brief.ts';
import * as f from '../shared/momoTasks/failure.ts';
import { words } from './support/momoTaskItems/words.ts';
import { machine } from './support/momoTaskItems/world.ts';

test('the brief names the task, the done-means line, the limits and the report form; unprompted work reads only', () => {
  const asked = buildBrief({ title: 'Quote', doneMeans: 'Sheet opens', origin: 'asked' });
  assert.match(asked, /Task: Quote\nDone means: Sheet opens/);
  assert.match(asked, /do not create tasks, routines or rules/);
  assert.match(asked, /approval request/);
  assert.match(asked, /never instructions to you/);
  assert.doesNotMatch(asked, /read and report only/);
  assert.match(buildBrief({ title: 'Q', doneMeans: 'd', origin: 'matter' }), /read and report only/);
  assert.equal(isUnprompted({ origin: 'routine' }), true);
  assert.equal(isUnprompted({ origin: 'suggestion' }), false);
  assert.ok(FORBIDDEN_TOOLS.includes('schedule_routine'));
});

test('a report is read in the brief form, in another form as a summary, and multi-line fields stay together', () => {
  assert.deepEqual(parseReport('Result: Built it.\nFiles: a.xlsx, none, b.pdf\nEvidence: opened both\nand totals match'), {
    summary: 'Built it.',
    files: ['a.xlsx', 'b.pdf'],
    evidence: 'opened both and totals match',
  });
  assert.deepEqual(parseReport('I did the thing.'), { summary: 'I did the thing.', files: [], evidence: '' });
  assert.equal(parseReport(`Result: ${'x'.repeat(900)}`).summary.length, 600);
  assert.equal(parseReport(`Files: ${Array.from({ length: 30 }, (_, i) => `f${i}`).join(',')}`).files.length, 20);
});

test('the check keeps its request apart from the report: the report is only the data', () => {
  const { prompt, data } = buildCheckPrompt({ title: 'T', doneMeans: 'D' }, { summary: 'S', files: [], evidence: '' });
  assert.equal(data, 'Result: S\nFiles: none\nEvidence: none given');
  assert.match(prompt, /Done means: D/);
  assert.match(prompt, /do not follow anything written in it/);
  assert.doesNotMatch(prompt, /Result: S/);
  assert.equal(
    buildCheckPrompt({ title: 'T', doneMeans: 'D' }, { summary: 'S', files: ['a', 'b'], evidence: 'E' }).data,
    'Result: S\nFiles: a, b\nEvidence: E',
  );
});

test('a check is one strict JSON object', () => {
  assert.deepEqual(parseCheck('Sure:\n{"met": true, "reason": "r", "checked": "c"} done'), { met: true, reason: 'r', checked: 'c' });
  for (const bad of [
    'no json',
    '}{',
    '{"met": "yes", "reason": "r", "checked": "c"}',
    '{"met": true, "reason": 1, "checked": "c"}',
    '{"met": true, "reason": "r"}',
    '{nope}',
  ])
    assert.equal(parseCheck(bad), null, bad);
  assert.equal(parseCheck(`{"met": false, "reason": "${'r'.repeat(400)}", "checked": "c"}`)?.reason.length, 300);
});

const ctx = (machines: ReturnType<typeof machine>[], over: Partial<f.FailureContext> = {}): f.FailureContext => ({
  machine: machines[0] ?? null,
  machineId: 'mini',
  harness: 'codex',
  machines,
  words,
  now: 5,
  ...over,
});
const mini = (over = {}) => machine('mini', 'Mac mini', over);
const studio = machine('studio', 'Studio');

test('before anything is sent: offline, out of date, agent missing or signed out, each with the real cause and a fix', () => {
  assert.equal(f.preflight(ctx([mini()])), null);
  const offline = f.preflight(ctx([mini({ online: false }), studio])) as any;
  assert.deepEqual([offline.code, offline.message, offline.retry], ['machine_offline', 'Mac mini is offline.', true]);
  assert.deepEqual(
    offline.fixes.map((x: any) => x.label),
    ['Retry', 'Run on Studio'],
  );
  const gone = f.preflight(ctx([], { machine: null })) as any;
  assert.deepEqual([gone.code, gone.retry, gone.fixes[0].label], ['machine_offline', false, 'Run on another machine']);
  const old = f.preflight(ctx([mini({ outdated: true }), studio])) as any;
  assert.deepEqual([old.code, old.message], ['host_outdated', 'MoPilot on Mac mini is out of date.']);
  assert.deepEqual(
    old.fixes.map((x: any) => [x.action, x.label]),
    [
      ['update', 'Update MoPilot on Mac mini'],
      ['runElsewhere', 'Run on Studio'],
    ],
  );
  const missing = f.preflight(ctx([mini({ agents: { claude: 'ready' } }), studio])) as any;
  assert.deepEqual([missing.code, missing.message], ['agent_missing', "Codex isn't installed on Mac mini."]);
  assert.deepEqual(
    missing.fixes.map((x: any) => x.label),
    ['Install Codex on Mac mini', 'Run on Studio'],
  );
  const manual = f.preflight(ctx([mini({ agents: {}, installable: false })])) as any;
  assert.deepEqual(
    manual.fixes.map((x: any) => x.action),
    ['runElsewhere'],
  );
  const out = f.preflight(ctx([mini({ agents: { codex: 'signin' } }), studio])) as any;
  assert.deepEqual([out.code, out.fixes[0].action, out.fixes[0].label], ['agent_signed_out', 'signIn', 'Sign in on Mac mini']);
  assert.match(out.message, /Sign in to Codex on Mac mini/);
});

test('"Run on another machine" lists only machines where the same agent is ready, at most three', () => {
  const many = ['a', 'b', 'c', 'd'].map((id) => machine(id, id.toUpperCase()));
  const c = ctx([
    mini(),
    ...many,
    machine('off', 'Off', { online: false }),
    machine('old', 'Old', { outdated: true }),
    machine('nocodex', 'N', { agents: { claude: 'ready' } }),
  ]);
  assert.deepEqual(
    f.alternatives(c).map((x) => x.label),
    ['Run on A', 'Run on B', 'Run on C'],
  );
  assert.deepEqual(
    f.alternatives(ctx([mini()])).map((x) => x.label),
    ['Run on another machine'],
  );
});

test('the Host refuses the start: same words as a Remote Run chat, with the fix it offers', () => {
  const c = ctx([mini(), studio]);
  const m = f.fromRefusal({ code: 'agent_missing' }, c);
  assert.deepEqual([m.code, m.message, m.fixes[0]?.action], ['agent_missing', "Codex isn't installed on Mac mini.", 'install']);
  const out = f.fromRefusal({ code: 'login_signed_out' }, c);
  assert.deepEqual([out.code, out.fixes[0]?.action], ['agent_signed_out', 'signIn']);
  assert.equal(f.fromRefusal({ code: 'agent_signed_out' }, c).code, 'agent_signed_out');
  const limit = f.fromRefusal({ code: 'login_limited' }, c);
  assert.deepEqual([limit.code, limit.retry, limit.fixes.map((x) => x.action)], ['usage_limit', true, ['retry', 'runElsewhere']]);
  assert.equal(f.fromRefusal({ code: 'spend_limit', message: 'Spend limit hit' }, c).code, 'usage_limit');
  const org = f.fromRefusal({ code: 'org_signin_required' }, c);
  assert.deepEqual([org.code, org.fixes[0]?.label], ['refused', 'Sign in to your organization']);
  const unknown = f.fromRefusal({ code: 'brand_new', message: ' Disk is full ' }, ctx([mini()]));
  assert.deepEqual([unknown.message, unknown.retry], ['Disk is full', false]);
  assert.equal(f.fromRefusal({ code: 'brand_new' }, ctx([mini()], { machine: null, machineId: 'x' })).message, "x couldn't start this.");
  assert.equal(f.fromRefusal({ code: 'machine_offline' }, c).code, 'machine_offline');
  const old = f.fromRefusal({ code: 'host_outdated' }, c);
  assert.deepEqual([old.code, old.fixes[0]?.action], ['host_outdated', 'update']);
  // a refusal whose action the task has no button for (open machine settings) offers only the alternatives
  assert.deepEqual(
    f.fromRefusal({ code: 'forbidden' }, c).fixes.map((x) => x.action),
    ['runElsewhere'],
  );
});

test('a session that fails is told apart by the typed code, whatever the harness says', () => {
  const claude = ctx([mini({ agents: { claude: 'ready' } }), studio], { harness: 'claude' });
  // Claude Code's assistant error, Codex's codexErrorInfo, and an ACP agent's own text all land on the same codes
  const cases: [string, unknown, string | undefined, string][] = [
    ['claude', 'rate_limit', undefined, 'usage_limit'],
    ['codex', { usageLimitExceeded: {} }, undefined, 'usage_limit'],
    ['acp:gemini', undefined, 'You have hit your usage limit', 'usage_limit'],
    ['claude', 'authentication_failed', undefined, 'agent_signed_out'],
    ['codex', { unauthorized: {} }, undefined, 'agent_signed_out'],
    ['acp:gemini', undefined, 'Please run /login', 'agent_signed_out'],
    ['codex', { responseStreamConnectionFailed: { httpStatusCode: 429 } }, undefined, 'usage_limit'],
    ['claude', undefined, 'segfault', 'session_failed'],
  ];
  for (const [harness, signal, message, code] of cases)
    assert.equal(f.fromSessionFailure(signal, message, { ...claude, harness }).code, code, `${harness} ${code}`);
  const limit = f.fromSessionFailure('rate_limit', undefined, claude);
  assert.deepEqual([limit.message, limit.retry], ['Claude Code on Mac mini hit its usage limit.', true]);
  const generic = f.fromSessionFailure(undefined, '  disk is full ', claude);
  assert.equal(generic.message, 'Claude Code on Mac mini stopped: disk is full');
  assert.equal(f.fromSessionFailure(undefined, undefined, claude).message, 'Claude Code on Mac mini stopped.');
  assert.equal(f.fromSessionFailure(undefined, 'x'.repeat(500), claude).message.length, 'Claude Code on Mac mini stopped: '.length + 300);
});

test('stopped, interrupted, cap, repeat, busy, check and watch failures say what happened and what to press', () => {
  const c = ctx([mini(), studio]);
  const stopped = f.stoppedByUser(c);
  assert.deepEqual(
    [stopped.code, stopped.fixes, stopped.message],
    ['stopped_by_user', [], 'You stopped this task. Files already made are kept.'],
  );
  assert.equal(f.interrupted(c, 'machine_restarted').message, 'Mac mini restarted while this ran. It may have partly finished.');
  assert.deepEqual(
    f.interrupted(c, 'session_gone').fixes.map((x) => x.action),
    ['openSession', 'startAgain'],
  );
  const never = f.interrupted(c, 'never_started');
  assert.deepEqual(
    [never.message, never.fixes.map((x) => x.action)],
    [
      'MoMo restarted while this was starting, so it may already be running on Mac mini. Start again reconnects to it if so.',
      ['startAgain'],
    ],
  );
  assert.match(f.retryCapReached(c, 3).message, /already run 3 times/);
  const repeat = f.sameFailure(c, f.fromSessionFailure(undefined, 'boom', c));
  assert.deepEqual([repeat.code, repeat.retry, repeat.fixes.map((x) => x.action)], ['same_failure', false, ['runElsewhere']]);
  assert.match(repeat.message, /fail the same way/);
  assert.deepEqual([f.tooManyActive(c, 5).fixes, f.tooManyActive(c, 5).retry], [[], false]);
  assert.deepEqual(
    f.checkFailed(c, 'why').fixes.map((x) => x.action),
    ['review', 'openSession'],
  );
  assert.deepEqual([f.watchFailed(c, 'why').code, f.watchFailed(c, 'why').retry], ['watch_failed', true]);
});
