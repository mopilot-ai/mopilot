// MoMo's at-limit rules when the brain's account is already known to be out (#2306), on each harness family: Skip this run
// skips a routine's run (silently) and starts nothing; Next account moves to another account of the same lane; ACP reports
// no limits and runs. A routine that can't start tells MoMo's main chat why; MoMo's main chat is held while Pause applies
// (electron/momo/brainLimit.cjs, routines.cjs, routineRuns.cjs).
import './support/tz-la.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { world, START, sweep, told } from './support/momo-routines.ts';

const require = createRequire(import.meta.url);
const { atLimit, untilText } = require('../electron/momo/brainLimit.cjs');
const { labelOf } = require('../electron/momo/mainChat.cjs');
const { instance, PROVIDERS } = require('../electron/identity/contract/registry.cjs');
const { claudeInstances } = require('../electron/identity/drivers/claude.cjs');
const { startHold } = require('../shared/killSwitch.cjs');

const RESET = START + 30 * 3_600_000;
const plan = (account: string, o: any = {}) =>
  instance({ harness: o.harness ?? 'claude', account, provider: PROVIDERS.anthropic, kind: 'harnessAuth', billing: 'subscription', ...o });
const identity = (lists: Record<string, any[]>) => ({ instances: (f: string) => lists[f] ?? [] });
const rule = (id: any, brain: any, r: string) => atLimit(id, brain, r, START, labelOf);

test('the rule: a known limit on the brain’s account holds it (with when it lifts); Next account moves on; else it goes', () => {
  const out = plan('max', { limited: true, limitedUntil: RESET });
  const claude = { harness: 'claude', account: 'max', model: 'sonnet' };
  assert.deepEqual(rule(identity({ claude: [out] }), claude, 'skip'), { held: `Claude Code is at its limit until ${untilText(RESET)}` });
  assert.match(untilText(RESET), /^[A-Z][a-z]{2} \d+, \d+:\d\d [AP]M$/);
  // Next account with no other account pauses (effectiveAtLimit); with one in the same lane it moves there
  assert.ok('held' in rule(identity({ claude: [out] }), claude, 'nextAccount'));
  const other = plan('pro', { status: 'ok' });
  assert.deepEqual(rule(identity({ claude: [out, other] }), claude, 'nextAccount'), { go: { ...claude, account: 'pro' } });
  // a limit with no known reset says no time; a key never runs out; not limited, or no account known, goes
  assert.deepEqual(rule(identity({ claude: [plan('max', { limited: true })] }), claude, 'pause'), { held: 'Claude Code is at its limit' });
  const key = instance({
    harness: 'claude',
    account: 'max',
    provider: PROVIDERS.anthropic,
    kind: 'sageKey',
    billing: 'apiKey',
    limited: true,
  });
  assert.deepEqual(rule(identity({ claude: [key] }), claude, 'skip'), { go: claude });
  assert.deepEqual(rule(identity({ claude: [plan('max')] }), claude, 'skip'), { go: claude });
  assert.deepEqual(rule(identity({}), claude, 'skip'), { go: claude });
  // no account picked: the one in use; Codex by its own lane
  const codex = { harness: 'codex', account: null, model: 'gpt-5.5' };
  const team = plan('team', { harness: 'codex', provider: PROVIDERS.openai, limited: true, active: true });
  assert.deepEqual(rule(identity({ codex: [team] }), codex, 'skip'), { held: 'Codex is at its limit' });
  // an ACP harness reports none, and one of no family is not judged
  const acp = { harness: 'acp:opencode', account: null, model: null };
  assert.deepEqual(rule(identity({ acp: [plan('opencode', { harness: 'acp', billing: 'harness', active: true })] }), acp, 'skip'), {
    go: acp,
  });
  assert.deepEqual(rule(identity({}), null, 'skip'), { go: null });
});

test('the identity registry says when a limited login’s limit lifts', () => {
  const marks = new Map([['max', { limitedUntil: RESET }]]);
  const [i] = claudeInstances(
    { active: 'max', accounts: [{ id: 'max', email: 'a@b', loggedIn: true }] },
    { mode: 'subscription' },
    false,
    marks,
    START,
  );
  assert.deepEqual([i.limited, i.limitedUntil], [true, RESET]);
  assert.equal('limitedUntil' in plan('x'), false, 'none when not limited');
});

/** The routines service with the brain's account out (or not), and the rule's decision recorded. */
function limited(o: { held?: boolean; move?: string } = {}) {
  const w = world();
  const asked: any[] = [];
  w.service.o.atLimit = (brain: any) => {
    asked.push(brain);
    if (o.held) return { held: 'Codex is at its limit until Oct 25, 6:00 PM' };
    return { go: o.move ? { ...brain, account: o.move } : brain };
  };
  return { w, asked };
}

/** A routine the user approved, so the service lists it as a task. */
async function approved(w: any) {
  await w.routines.add(sweep, { approved: true });
  const [task] = await w.service.list();
  return task;
}

test('Skip this run: the run is skipped before it starts, silently; nothing starts, nothing is sent, nothing is told', async () => {
  const { w, asked } = limited({ held: true });
  const task = await approved(w);
  await assert.rejects(w.service.run(task), (e: any) => e.reason === 'at-limit');
  assert.deepEqual([w.started, w.sent, w.reports], [[], [], []]);
  assert.deepEqual(asked, [{ harness: 'codex', account: null, model: 'gpt-5.5' }]);
  assert.equal(typeof w.service.skipped, 'undefined', 'a skipped time has no record of its own any more');
});

test('Next account: the run starts on the account the rule moved it to', async () => {
  const { w } = limited({ move: 'team' });
  const task = await approved(w);
  await w.service.run(task);
  assert.equal(w.started[0][0], 'codex');
  assert.equal(w.service.o.atLimit({ harness: 'codex' }).go.account, 'team');
});

test('a run that can’t start tells MoMo’s main chat why; one that ends without finishing says so; no retry is offered', async () => {
  const w = world({ usable: () => false });
  const task = await approved(w);
  const error: any = await w.service.run(task).catch((e: any) => e);
  assert.equal(error.message, 'No harness can run MoMo’s routines now: sign in or install one.');
  await w.service.failed(task, error);
  assert.deepEqual(told(w), [['Inbox sweep', false, 'No harness can run MoMo’s routines now: sign in or install one.']]);
  assert.equal(typeof w.service.retryEdition, 'undefined');
  // and a run that started but didn't finish
  const ok = world();
  const t = await approved(ok);
  const chatId = await ok.service.run(t);
  await ok.service.finished({ chatId, completed: false, text: 'You’ve hit your weekly limit · resets Oct 25 at 6pm' });
  assert.deepEqual(told(ok), [['Inbox sweep', false, 'The run didn’t finish.']]);
  assert.deepEqual(ok.chats.at(-1), ['archive', chatId]);
});

test('the start’s off-switch: a harness switched off wins; else what holds the chat; else it starts', () => {
  const held = (id: string) => (id === 'mc' ? 'MoMo is paused: Claude Code is at its limit.' : null);
  assert.equal(startHold('disabled_by_admin', held, 'mc'), 'disabled_by_admin');
  assert.equal(startHold(null, held, 'mc'), 'MoMo is paused: Claude Code is at its limit.');
  assert.equal(startHold(null, held, 'coding'), null);
  assert.equal(startHold(null, undefined, 'mc'), null, 'before MoMo is open nothing holds a chat');
});

test('the rule with no registry, a family listing nothing, or a limited ACP harness (no other account: held)', () => {
  const claude = { harness: 'claude', account: 'max', model: null };
  assert.deepEqual(rule(null, claude, 'skip'), { go: claude });
  assert.deepEqual(rule({ instances: () => undefined }, claude, 'skip'), { go: claude });
  const acp = { harness: 'acp:opencode', account: null, model: null };
  const out = plan('opencode', { harness: 'acp', billing: 'harness', active: true, limited: true });
  assert.deepEqual(rule(identity({ acp: [out, plan('kimi', { harness: 'acp', billing: 'harness' })] }), acp, 'nextAccount'), {
    held: 'opencode is at its limit',
  });
});
