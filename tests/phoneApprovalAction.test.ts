// Allow, Deny and Answer from a notification (P5): one answer, device authentication for Allow, the four outcomes, destructive kinds opening the app, and an action racing an answer from the Mac.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import '../tests/support/phone/register.ts';
import { runApprovalAction, ACTION_BUDGET_MS } from '../mobile/src/push/approvalAction';
import { chatRef } from '../mobile/src/push/chatRef';

const ref = chatRef('hp', 'c1');
const opened = { pairId: 'hp', requestId: 'q1', machine: 'build-box', tool: 'execute', question: false };
const card = {
  chatId: 'c1',
  epoch: 3,
  requestId: 'q1',
  options: [
    { optionId: 'allow', kind: 'allow_once' },
    { optionId: 'deny', kind: 'reject_once' },
  ],
};

function rig(
  o: {
    open?: any;
    auth?: boolean;
    cards?: any[];
    answer?: (p: any) => Promise<unknown>;
    connect?: () => Promise<any>;
    budget?: number;
    neverTimer?: boolean;
  } = {},
) {
  const answers: any[] = [];
  const replaced: string[] = [];
  let auths = 0;
  const host = {
    pending: async () => ({ cards: o.cards ?? [card] }),
    answer: async (p: any) => (answers.push(p), o.answer ? o.answer(p) : {}),
  };
  const deps = {
    open: () => (o.open === undefined ? opened : o.open),
    authenticate: async () => (auths++, o.auth ?? true),
    connect: o.connect ?? (async () => host),
    replace: async (t: string) => void replaced.push(t),
    mintKey: () => 'k1',
    budgetMs: o.budget,
  };
  return { deps, answers, replaced, auths: () => auths };
}

test('Allow authenticates, sends exactly one answer with the card epoch and one key, and says so', async () => {
  const r = rig();
  const out = await runApprovalAction('allow', ref, 'blob', r.deps);
  assert.equal(out.kind, 'allowed');
  assert.deepEqual(r.answers, [{ chatId: 'c1', epoch: 3, requestId: 'q1', optionId: 'allow', key: 'k1' }]);
  assert.deepEqual(r.replaced, ['Allowed on build-box']);
  assert.equal(r.auths(), 1);
});

test('Deny needs no authentication and picks the reject option', async () => {
  const r = rig();
  assert.equal((await runApprovalAction('deny', ref, 'blob', r.deps)).kind, 'denied');
  assert.equal(r.answers[0].optionId, 'deny');
  assert.equal(r.auths(), 0);
  assert.deepEqual(r.replaced, ['Denied on build-box']);
});

test('a cancelled Face ID sends nothing and leaves the notification alone', async () => {
  const r = rig({ auth: false });
  assert.equal((await runApprovalAction('allow', ref, 'blob', r.deps)).kind, 'cancelled');
  assert.deepEqual([r.answers, r.replaced], [[], []]);
});

test('delete and fetch, a question, Answer, and a blob that does not open all open the app and send nothing', async () => {
  for (const tool of ['delete', 'fetch']) {
    const r = rig({ open: { ...opened, tool } });
    assert.equal((await runApprovalAction('allow', ref, 'blob', r.deps)).kind, 'open');
    assert.deepEqual(r.replaced, ['Open MoPilot to review this on build-box.']);
    assert.deepEqual([r.answers.length, r.auths()], [0, 0]);
  }
  // Deny on a delete is still a deny: it is safe from the lock screen
  assert.equal((await runApprovalAction('deny', ref, 'blob', rig({ open: { ...opened, tool: 'delete' } }).deps)).kind, 'denied');
  assert.equal((await runApprovalAction('answer', ref, 'blob', rig().deps)).kind, 'open');
  assert.equal((await runApprovalAction('deny', ref, 'blob', rig({ open: { ...opened, question: true } }).deps)).kind, 'open');
  const none = rig({ open: null });
  assert.deepEqual(await runApprovalAction('allow', ref, undefined, none.deps), { kind: 'open', text: '' });
  assert.deepEqual(none.replaced, []);
});

test('an action racing an answer from the Mac: a refused card says who answered, a card already gone says so too', async () => {
  const refused = (code: string, by?: string) =>
    rig({
      answer: async () => {
        throw Object.assign(new Error('x'), { code, ...(by && { details: { by: { name: by } } }) });
      },
    });
  let r = refused('card_answered', 'Work MacBook Pro');
  assert.equal((await runApprovalAction('allow', ref, 'b', r.deps)).kind, 'answered');
  assert.deepEqual(r.replaced, ['Already answered on Work MacBook Pro.']);
  r = refused('card_answered');
  await runApprovalAction('deny', ref, 'b', r.deps);
  assert.deepEqual(r.replaced, ['Already answered on another device.']);
  r = rig({ cards: [] });
  assert.equal((await runApprovalAction('deny', ref, 'b', r.deps)).kind, 'answered');
  assert.equal(r.answers.length, 0);
  // a card for another chat or request is not this one
  r = rig({
    cards: [
      { ...card, requestId: 'other' },
      { ...card, chatId: 'zzz' },
    ],
  });
  assert.equal((await runApprovalAction('deny', ref, 'b', r.deps)).kind, 'answered');
});

test('a moved chat, a Host that cannot be reached and one that never replies say so and keep the card answerable', async () => {
  const moved = rig({
    answer: async () => {
      throw Object.assign(new Error('x'), { code: 'stale_epoch' });
    },
  });
  assert.deepEqual(await runApprovalAction('deny', ref, 'b', moved.deps), { kind: 'moved', text: 'This chat moved to another machine.' });
  const down = rig({
    connect: async () => {
      throw new Error('offline');
    },
  });
  assert.equal((await runApprovalAction('deny', ref, 'b', down.deps)).kind, 'unreachable');
  assert.deepEqual(down.replaced, ["Couldn't reach build-box. Tap to try again."]);
  const odd = rig({
    answer: async () => {
      throw 'plain';
    },
  });
  assert.equal((await runApprovalAction('deny', ref, 'b', odd.deps)).kind, 'unreachable');
  const slow = rig({ connect: () => new Promise(() => {}), budget: 20 });
  assert.equal((await runApprovalAction('deny', ref, 'b', slow.deps)).kind, 'unreachable');
  assert.equal(ACTION_BUDGET_MS, 30_000);
  // an injected timer pair is used
  let fired: any;
  const timed = rig({ connect: () => new Promise(() => {}) });
  const p = runApprovalAction('deny', ref, 'b', {
    ...timed.deps,
    setTimer: (fn: () => void) => ((fired = fn), 7),
    clearTimer: () => undefined,
  });
  await new Promise((r) => setImmediate(r));
  fired();
  assert.equal((await p).kind, 'unreachable');
});

test('an option the card does not offer opens the app, and a failing replace does not change the outcome', async () => {
  const r = rig({ cards: [{ ...card, options: [{ optionId: 'x', kind: 'other' }] }] });
  assert.equal((await runApprovalAction('deny', ref, 'b', r.deps)).kind, 'open');
  const bad = rig();
  bad.deps.replace = async () => {
    throw new Error('no');
  };
  assert.equal((await runApprovalAction('deny', ref, 'b', bad.deps)).kind, 'denied');
});
