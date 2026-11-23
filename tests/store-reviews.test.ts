// src/store/reviews.ts: asking a chat to fix review findings, running the review again, and the findings in the Changes pane.
import { test, mock, beforeEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, callsOf, impl, resetAll, flush, bootImpls } from './support/store-harness.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const { store, resetState } = await loadStore();
const S = store;
const reviews = await import('../src/store/reviews.ts');
const st = () => S.useStore.getState();
const set = S.useStore.setState;
const { noteOwner } = await import('../src/harness/ownership.ts');
noteOwner('cl', 'claude');

const findings = [
  { file: 'a.ts', line: 1, summary: 'one' },
  { file: 'b.ts', line: 2, summary: 'two', failureScenario: 'boom' },
];
const marks = (chat = 'cl') => st().reviewMarks[chat]?.r1;

before(async () => {
  bootImpls();
  await S.boot();
  await flush();
});
beforeEach(() => {
  resetState();
  resetAll();
  impl['session.snapshot'] = async () => null;
});

test("Apply fixes marks the findings fixing from the chat's next turn and sends the request with the ReportFindings ask", async () => {
  impl['proxy.send'] = async () => ({ action: 'started', id: 'apply-fixes' });
  set({
    runtime: {
      cl: {
        turns: [
          { id: 't1', items: [] },
          { id: 't2', items: [{}, {}] },
        ],
      } as any,
    },
  });
  S.askFixes('cl', 'r1', findings, [0, 1]);
  // asked after the chat's last item: the fix turn is the one its message starts
  assert.deepEqual(marks(), { fixAfter: { turnId: 't2', items: 2 }, status: { 0: 'fixing', 1: 'fixing' } });
  await flush();
  const [[chat, text]] = callsOf('proxy.send');
  assert.equal(chat, 'cl');
  assert.match(text, /^Apply these 2 code-review findings with the minimal edits\./);
  assert.match(text, /2\. `b\.ts:2`\nSummary:\n> two\nFailure scenario:\n> boom/);
  assert.match(text, /call the ReportFindings tool once/);
  assert.deepEqual(marks()?.status, { 0: 'fixing', 1: 'fixing' });
  // nothing to fix sends nothing
  S.askFixes('cl', 'r2', findings, []);
  assert.equal(callsOf('proxy.send').length, 1);
});

test('a harness without ReportFindings is asked without it, and a request main did not take reopens its findings', async () => {
  impl['proxy.send'] = () => Promise.reject(new Error('refused'));
  S.askFixes('cx', 'r1', findings, [1]);
  assert.deepEqual(marks('cx'), { fixAfter: { turnId: null, items: 0 }, status: { 1: 'fixing' } });
  await flush();
  assert.doesNotMatch(callsOf('proxy.send')[0][1], /ReportFindings/);
  // main refused: the request waits in the composer and the finding is open again
  assert.deepEqual(marks('cx')?.status, {});
  assert.match(st().drafts.cx.text, /^Apply this code-review finding/);
  // reopening touches only what is fixing
  impl['proxy.send'] = async () => ({ action: 'started', id: 'reopen-finding' });
  set({ reviewMarks: {} });
  S.askFixes('cl', 'r1', findings, [0]);
  S.dismissFinding('cl', 'r1', 1);
  reviews.reopenFindings('cl', 'r1', [0, 1]);
  assert.deepEqual(marks()?.status, { 1: 'dismissed' });
});

test('Re-run review: /code-review at its level where findings are reported, else the harness review on the last target', async () => {
  impl['proxy.send'] = async () => ({ action: 'started', id: 'rerun-review' });
  S.rerunReview('cl', 'high');
  S.rerunReview('cl', null);
  await flush();
  assert.deepEqual(
    callsOf('proxy.send').map((c) => c[1]),
    ['/code-review high', '/code-review'],
  );
  impl['codex.leased'] = async () => ({ result: {} });
  // a review MoPilot started records its target, branch and all
  await S.startReview('cx', { type: 'baseBranch', branch: 'main' });
  assert.deepEqual(st().reviewTargets.cx, { type: 'baseBranch', branch: 'main' });
  S.rerunReview('cx', null);
  set({ reviewTargets: {} });
  S.rerunReview('cx', null);
  await flush();
  assert.deepEqual(
    callsOf('codex.leased').map((c) => c[2].target),
    [{ type: 'baseBranch', branch: 'main' }, { type: 'baseBranch', branch: 'main' }, { type: 'uncommittedChanges' }],
  );
});

test('the walk opens the Changes pane on a finding, moves its focus, and records findings not in the diff', () => {
  S.focusFinding(3);
  assert.equal(st().diffPanel.walk, undefined, 'no walk, nothing to move');
  S.openFindingsWalk('cl', 'r1', 1, 'branch');
  assert.equal(st().paneActive, 'changes');
  assert.deepEqual(st().diffPanel, { open: true, scope: 'branch', walk: { chatId: 'cl', reviewId: 'r1', current: 1 } });
  S.focusFinding(0);
  assert.equal(st().diffPanel.walk?.current, 0);
  S.setUnanchored('cl', 'r1', [1]);
  const before = st().reviewMarks;
  S.setUnanchored('cl', 'r1', [1]);
  assert.equal(st().reviewMarks, before, 'the same findings leave the state as it is');
  S.setUnanchored('cl', 'r1', [0]);
  assert.deepEqual(marks()?.unanchored, [0]);
  S.setUnanchored('cl', 'r1', []);
  assert.deepEqual(marks()?.unanchored, []);
});

test('a walk whose scope lacks a finding moves to Branch once; a walk opened again may move again', () => {
  S.widenFindingsWalk();
  assert.equal(st().diffPanel.walk, undefined, 'no walk, nothing to move');
  S.openFindingsWalk('cl', 'r1', 0, 'uncommitted');
  S.widenFindingsWalk();
  const widened = { chatId: 'cl', reviewId: 'r1', current: 0, settled: true };
  assert.deepEqual(st().diffPanel, { open: true, scope: 'branch', walk: widened });
  // settled: the user's later pick of Uncommitted is not moved again
  set({ diffPanel: { ...st().diffPanel, scope: 'uncommitted' } });
  S.widenFindingsWalk();
  assert.equal(st().diffPanel.scope, 'uncommitted');
  // moving the focus keeps it settled; Walk through in diff clicked again starts a new walk
  S.focusFinding(1);
  assert.equal(st().diffPanel.walk?.settled, true);
  S.openFindingsWalk('cl', 'r1', 0, 'uncommitted');
  S.widenFindingsWalk();
  assert.equal(st().diffPanel.scope, 'branch');
});

test("closing the walk puts the pane's diff back alone, and only for the chat that walks", () => {
  S.closeFindingsWalk('cl');
  assert.equal(st().diffPanel.walk, undefined, 'no walk, nothing to close');
  S.openFindingsWalk('cl', 'r1', 1, 'branch');
  S.closeFindingsWalk('other');
  assert.equal(st().diffPanel.walk?.chatId, 'cl', "another chat's close leaves the walk");
  S.closeFindingsWalk('cl');
  assert.equal(st().diffPanel.walk, undefined);
  assert.equal(st().diffPanel.scope, 'branch', 'the scope stays');
  assert.equal(st().diffPanel.open, true);
});

test('Answer review comments asks the chat, on its harness, to address the PR’s unresolved review comments', async () => {
  impl['proxy.send'] = async () => ({ action: 'started', id: 'answer-review' });
  for (const kind of ['codex', 'claude', 'acp:kimi']) {
    const id = `chat-${kind}`;
    set({ threads: { [id]: { id, kind } } as any });
    S.answerReviewComments(id, { owner: 'o', name: 'r', number: 7 });
    await flush();
    assert.equal(callsOf('proxy.send').at(-1)![0], id, kind);
    assert.match(callsOf('proxy.send').at(-1)![1], /^Read the unresolved review comments on o\/r#7 and address each one/);
  }
});

test('a refused Answer request is kept beside the user’s draft', async () => {
  impl['proxy.send'] = async () => {
    throw new Error('unavailable');
  };
  set({ drafts: { cl: { text: 'my unsent message', attachments: [] } } });
  S.answerReviewComments('cl', { owner: 'o', name: 'r', number: 7 });
  await flush();
  assert.match(st().drafts.cl!.text!, /^my unsent message\nRead the unresolved review comments/);
});
