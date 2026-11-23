// Review auto-fix in main: each harness's review read from its live events, and the fix request its turn's end sends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { APPLY_REVIEW_REQUEST, applyFixesRequest } from '../shared/reviewFindings.mjs';

const require = createRequire(import.meta.url);
const { ReviewAutoFix, MAX_PENDING, MAX_SENT } = require('../electron/session/reviewAutoFix.cjs');

const finding = { file: 'calc.js', line: 2, summary: 'div multiplies.', failure_scenario: 'div(6, 3) is 18.' };
const typed = { file: 'calc.js', line: 2, summary: 'div multiplies.', failureScenario: 'div(6, 3) is 18.' };
const CODEX_REVIEW = 'One bug.\n\nReview comment:\n\n- [P1] div multiplies — /r/calc.js:2-3\n  div(6, 3) is 18.';
const codexFinding = {
  file: '/r/calc.js',
  line: 2,
  endLine: 3,
  shortSummary: 'div multiplies',
  summary: 'div(6, 3) is 18.',
  category: 'P1',
};

function fixture(over: Record<string, unknown> = {}) {
  const sent: { chatId: string; item: any }[] = [];
  const notes: string[] = [];
  const pending: (() => void)[] = [];
  const o = {
    exists: () => true,
    setting: () => true,
    prAutoFix: () => false,
    reportTool: (chatId: string) => chatId === 'claude-chat',
    chatOf: (key: string) => `${key}-chat`,
    requestThread: (thread: string) => thread,
    queued: () => 0,
    blocked: () => null,
    send: (chatId: string, item: any) => {
      sent.push({ chatId, item });
      return { action: 'started', id: item.id };
    },
    note: (what: string) => notes.push(what),
    later: (fn: () => void) => pending.push(fn),
    ...over,
  };
  const fix = new ReviewAutoFix(o);
  const settle = () => {
    for (const fn of pending.splice(0)) fn();
  };
  return { fix, sent, notes, pending, settle, o };
}

const claudeCall = (id: string, input: unknown, extra = {}) => ({
  kind: 'message',
  key: 'claude',
  msg: { type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'ReportFindings', input }] }, ...extra },
});
const claudeResult = (id: string, isError = false, extra = {}) => ({
  kind: 'message',
  key: 'claude',
  msg: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError }] }, ...extra },
});
const codexReview = (review: string, threadId = 'codex') => ({
  method: 'item/completed',
  params: { threadId, item: { type: 'exitedReviewMode', id: 'r', review } },
});
const turn = (fix: any, chatId: string, text = '/code-review high', id = 'u1') =>
  fix.dispatching({ chatId, kind: 'turn', item: { id, text, opts: { human: true } } });

test("a Claude Code review's findings are sent as Apply fixes sends them once its turn ends well, outcomes asked through ReportFindings", () => {
  const f = fixture();
  turn(f.fix, 'claude-chat');
  f.fix.event('claude', claudeCall('t1', { level: 'high', findings: [finding] }));
  // nothing until the CLI took the call, and nothing until the turn ends
  assert.equal(f.fix.turns.get('claude-chat').review, null);
  f.fix.event('claude', claudeResult('t1'));
  assert.deepEqual(f.fix.turns.get('claude-chat').review.findings, [typed]);
  f.fix.finished({ chatId: 'claude-chat', completed: true, text: 'Found one.' });
  assert.equal(f.sent.length, 0);
  f.settle();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].chatId, 'claude-chat');
  assert.equal(f.sent[0].item.text, applyFixesRequest([typed], { reportTool: true }));
  assert.deepEqual(f.sent[0].item.opts, { human: false });
  assert.deepEqual(f.sent[0].item.attachments, []);
  assert.match(f.sent[0].item.id, /^[0-9a-f-]{36}$/);
  // its own turn is a fix: a review in it (it was told not to run one) applies nothing more
  f.fix.dispatching({ chatId: 'claude-chat', kind: 'turn', item: f.sent[0].item });
  assert.equal(f.fix.sent.size, 0);
  f.fix.event('claude', claudeCall('t2', { findings: [finding] }));
  f.fix.event('claude', claudeResult('t2'));
  f.fix.finished({ chatId: 'claude-chat', completed: true, text: 'done' });
  f.settle();
  assert.equal(f.sent.length, 1);
});

test("a Codex review's text in its format is sent as findings, with no ReportFindings line; one with none, or a sub-agent's, sends nothing", () => {
  const f = fixture();
  f.fix.event('codex', codexReview(CODEX_REVIEW));
  f.fix.finished({ chatId: 'codex-chat', completed: true, text: CODEX_REVIEW });
  f.settle();
  assert.deepEqual(
    f.sent.map((s) => [s.chatId, s.item.text]),
    [['codex-chat', applyFixesRequest([codexFinding], { reportTool: false })]],
  );
  // no findings in Codex's format ("Looks good")
  f.fix.event('codex', codexReview('Looks good to me.'));
  f.fix.finished({ chatId: 'codex-chat', completed: true, text: 'Looks good to me.' });
  // a sub-agent's review, and events that are not a review result
  const sub = fixture({ requestThread: () => 'parent' });
  sub.fix.event('codex', codexReview(CODEX_REVIEW, 'child'));
  sub.fix.event('codex', { method: 'item/completed', params: { threadId: 'codex', item: { type: 'agentMessage' } } });
  sub.fix.event('codex', { method: 'item/started', params: { threadId: 'codex', item: { type: 'exitedReviewMode' } } });
  sub.fix.event('codex', { method: 'item/completed', params: { item: { type: 'exitedReviewMode' } } });
  sub.fix.event('codex', null);
  f.fix.event('codex', { method: 'item/completed', params: { threadId: 'codex', item: { type: 'exitedReviewMode' } } });
  f.settle();
  assert.equal(f.sent.length, 1);
  assert.equal(sub.fix.turns.size, 0);
  // an empty review result reads as no findings
  assert.deepEqual(f.fix.turns.get('codex-chat').review.findings, []);
});

test("a basic harness's /review: its findings in Codex's format as a list, otherwise the review's own prose; another prompt, or no reply, sends nothing", () => {
  const f = fixture();
  turn(f.fix, 'acp-chat', '/review the parser');
  f.fix.finished({ chatId: 'acp-chat', completed: true, text: CODEX_REVIEW });
  turn(f.fix, 'acp-chat', '/review');
  f.fix.finished({ chatId: 'acp-chat', completed: true, text: 'The parser drops the last token when input ends in a comma.' });
  turn(f.fix, 'acp-chat', 'please review this');
  f.fix.finished({ chatId: 'acp-chat', completed: true, text: 'Looks fine.' });
  turn(f.fix, 'acp-chat', '/review');
  f.fix.finished({ chatId: 'acp-chat', completed: true, text: '   ' });
  turn(f.fix, 'acp-chat', '/review');
  f.fix.finished({ chatId: 'acp-chat', completed: true, text: null });
  // a prompt with no text (an image alone)
  f.fix.dispatching({ chatId: 'acp-chat', kind: 'turn', item: { id: 'x', attachments: [] } });
  f.fix.finished({ chatId: 'acp-chat', completed: true, text: 'reply' });
  f.settle();
  assert.deepEqual(
    f.sent.map((s) => s.item.text),
    [applyFixesRequest([codexFinding], { reportTool: false }), APPLY_REVIEW_REQUEST],
  );
  // live events of a basic harness carry no findings of their own
  f.fix.event('acp', { kind: 'update', key: 'acp', update: {} });
  assert.equal(f.fix.turns.size, 0);
});

test('nothing is sent for a review that was already acted on, failed, found nothing, or when the chat is not set to apply it', () => {
  const reviewed = (f: ReturnType<typeof fixture>, chatId = 'claude-chat') => {
    turn(f.fix, chatId);
    f.fix.event('claude', claudeCall('t', { findings: [finding] }));
    f.fix.event('claude', claudeResult('t'));
  };
  // /code-review --fix: its outcomes came in the same turn
  const fixed = fixture();
  reviewed(fixed);
  fixed.fix.event('claude', claudeCall('o', { findings: [{ ...finding, outcome: 'fixed' }] }));
  fixed.fix.event('claude', claudeResult('o'));
  fixed.fix.finished({ chatId: 'claude-chat', completed: true });
  // a message steered in after the review (Apply fixes clicked while the turn ran)
  const steered = fixture();
  reviewed(steered);
  steered.fix.dispatching({ chatId: 'claude-chat', kind: 'steer', item: { id: 's', text: 'fix it' } });
  steered.fix.finished({ chatId: 'claude-chat', completed: true });
  // a message the user queued behind it
  const queued = fixture({ queued: () => 1 });
  reviewed(queued);
  queued.fix.finished({ chatId: 'claude-chat', completed: true });
  // the turn failed or was stopped
  const failed = fixture();
  reviewed(failed);
  failed.fix.finished({ chatId: 'claude-chat', completed: false });
  // a review with no findings, a call the CLI rejected, a sub-agent's call, a result with no call
  const empty = fixture();
  turn(empty.fix, 'claude-chat');
  empty.fix.event('claude', claudeCall('e', { findings: [] }));
  empty.fix.event('claude', claudeResult('e'));
  empty.fix.event('claude', claudeCall('rejected', { findings: [finding] }));
  empty.fix.event('claude', claudeResult('rejected', true));
  empty.fix.event('claude', claudeCall('sub', { findings: [finding] }, { parent_tool_use_id: 'agent' }));
  empty.fix.event('claude', claudeResult('sub'));
  empty.fix.event('claude', claudeResult('unknown'));
  empty.fix.event('claude', { kind: 'message', key: 'claude', msg: { type: 'user', message: { content: [{ type: 'text' }] } } });
  empty.fix.event('claude', { kind: 'message', key: 'claude', msg: { type: 'assistant', message: { content: 'text' } } });
  empty.fix.event('claude', { kind: 'control', key: 'claude' });
  empty.fix.event('claude', claudeCall(7 as any, { findings: [finding] }));
  empty.fix.finished({ chatId: 'claude-chat', completed: true });
  // the setting is off: at the turn's end, or by the time the turn's end settled; the chat is gone
  const off = fixture({ setting: () => false });
  reviewed(off);
  off.fix.finished({ chatId: 'claude-chat', completed: true });
  const gone = fixture({
    exists: () => false,
    reportTool: () => {
      throw new Error('no such chat');
    },
  });
  reviewed(gone);
  gone.fix.finished({ chatId: 'claude-chat', completed: true });
  let on = true;
  const turnedOff = fixture({ setting: () => on });
  reviewed(turnedOff);
  turnedOff.fix.finished({ chatId: 'claude-chat', completed: true });
  on = false;
  // the chat can't take it now (an approval waiting, archived, busy after its queue drained)
  const blocked = fixture({ blocked: () => 'approval required' });
  reviewed(blocked);
  blocked.fix.finished({ chatId: 'claude-chat', completed: true });
  // a turn this service never saw start ends with nothing to send
  const unseen = fixture();
  unseen.fix.finished({ chatId: 'claude-chat', completed: true, text: 'x' });
  for (const f of [fixed, steered, queued, failed, empty, off, gone, turnedOff, blocked, unseen]) {
    f.settle();
    assert.equal(f.sent.length, 0);
  }
  // a steer before any review is not an answer to one
  const early = fixture();
  turn(early.fix, 'claude-chat');
  early.fix.dispatching({ chatId: 'claude-chat', kind: 'steer', item: { id: 's', text: 'also check b' } });
  early.fix.event('claude', claudeCall('t', { findings: [finding] }));
  early.fix.event('claude', claudeResult('t'));
  early.fix.finished({ chatId: 'claude-chat', completed: true });
  early.settle();
  assert.equal(early.sent.length, 1);
});

test('a later review in the turn replaces the earlier one and answers what came before it; outcomes before any review are ignored', () => {
  const f = fixture();
  turn(f.fix, 'claude-chat');
  f.fix.event('claude', claudeCall('o', { findings: [{ ...finding, outcome: 'fixed' }] }));
  f.fix.event('claude', claudeResult('o'));
  f.fix.event('claude', claudeCall('r1', { findings: [{ ...finding, summary: 'old' }] }));
  f.fix.event('claude', claudeResult('r1'));
  f.fix.dispatching({ chatId: 'claude-chat', kind: 'steer', item: { id: 's', text: 'look again' } });
  f.fix.event('claude', claudeCall('r2', { findings: [finding] }));
  f.fix.event('claude', claudeResult('r2'));
  f.fix.finished({ chatId: 'claude-chat', completed: true });
  f.settle();
  assert.deepEqual(
    f.sent.map((s) => s.item.text),
    [applyFixesRequest([typed], { reportTool: true })],
  );
});

test('a send that throws or rejects is noted, never thrown; waiting calls and sent ids stay bounded; a deleted chat is forgotten', async () => {
  const thrown = fixture({
    send: () => {
      throw new Error('gone');
    },
  });
  thrown.fix.event('codex', codexReview(CODEX_REVIEW));
  thrown.fix.finished({ chatId: 'codex-chat', completed: true });
  thrown.settle();
  const rejected = fixture({ send: () => Promise.reject(new Error('refused')) });
  rejected.fix.event('codex', codexReview(CODEX_REVIEW));
  rejected.fix.finished({ chatId: 'codex-chat', completed: true });
  rejected.settle();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual([...thrown.notes, ...rejected.notes], ['apply a review’s findings', 'apply a review’s findings']);

  const f = fixture();
  for (let i = 0; i <= MAX_PENDING; i++) f.fix.event('claude', claudeCall(`c${i}`, { findings: [finding] }));
  assert.equal(f.fix.calls.get('claude-chat').size, MAX_PENDING);
  // the oldest waiting call went
  f.fix.event('claude', claudeResult('c0'));
  assert.equal(f.fix.turns.get('claude-chat')?.review ?? null, null);
  for (let i = 0; i <= MAX_SENT; i++) {
    f.fix.event('codex', codexReview(CODEX_REVIEW));
    f.fix.finished({ chatId: 'codex-chat', completed: true });
    f.settle();
  }
  assert.equal(f.fix.sent.size, MAX_SENT);
  f.fix.forget('claude-chat');
  assert.equal(f.fix.calls.has('claude-chat'), false);
  assert.equal(f.fix.turns.has('claude-chat'), false);
});

test('by default the send waits for the turn end to settle, so a queued message drains first', async () => {
  const sent: string[] = [];
  const fix = new ReviewAutoFix({
    exists: () => true,
    setting: () => false,
    prAutoFix: () => true,
    reportTool: () => false,
    chatOf: (key: string) => key,
    requestThread: (t: string) => t,
    queued: () => 0,
    blocked: () => null,
    send: (chatId: string) => void sent.push(chatId),
    note: () => {},
  });
  fix.event('codex', codexReview(CODEX_REVIEW));
  fix.finished({ chatId: 'codex', completed: true });
  assert.deepEqual(sent, []);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent, ['codex']);
});

test("a basic harness's or Claude Code's plain-words review ask counts as a review; a cloud review that only started does not", () => {
  const f = fixture();
  const ask = (prompt: string, text = 'The parser drops the last token.') => {
    turn(f.fix, 'claude-chat', prompt);
    f.fix.finished({ chatId: 'claude-chat', completed: true, text });
  };
  ask(
    'Review the changes on this branch against main: read them with the diff of main...HEAD. Find bugs, regressions and risky changes; list findings by severity with file and line references.',
  );
  ask('Review the current changes. Focus on the parser.');
  ask('/security-review');
  ask('/ultrareview', 'Your review is running in the cloud.');
  ask('/code-review ultra', 'Your review is running in the cloud.');
  ask('/code-review high --comment ultra 12', 'Launched.');
  ask('/code-reviewer');
  f.settle();
  assert.deepEqual(
    f.sent.map((s) => s.item.text),
    [APPLY_REVIEW_REQUEST, APPLY_REVIEW_REQUEST, APPLY_REVIEW_REQUEST],
  );
});

test("findings a review posts to a PR whose Auto-fix is on are left to the PR's comments; with the setting alone they apply here", () => {
  const posted = (over: Record<string, unknown>) => {
    const f = fixture(over);
    turn(f.fix, 'claude-chat', '/code-review high --comment');
    f.fix.event('claude', claudeCall('t', { findings: [finding] }));
    f.fix.event('claude', claudeResult('t'));
    f.fix.finished({ chatId: 'claude-chat', completed: true });
    f.settle();
    return f.sent.length;
  };
  assert.equal(posted({ setting: () => true, prAutoFix: () => true }), 0);
  assert.equal(posted({ setting: () => true, prAutoFix: () => false }), 1);
  // a monitored chat's review that posts nothing applies here
  const f = fixture({ setting: () => false, prAutoFix: () => true });
  turn(f.fix, 'claude-chat', '/code-review --commentary');
  f.fix.event('claude', claudeCall('t', { findings: [finding] }));
  f.fix.event('claude', claudeResult('t'));
  f.fix.finished({ chatId: 'claude-chat', completed: true });
  f.settle();
  assert.equal(f.sent.length, 1);
});

test("the request is MoPilot's in every window: its findings named, or the prose review's title; the item keeps the id made for it", () => {
  const made: [string, string, any][] = [];
  const f = fixture({
    make: (chatId: string, text: string, show: any) => (
      made.push([chatId, text, show]), { id: 'authored-1', text, opts: { human: false }, authored: { id: 'authored-1' } }
    ),
  });
  f.fix.event('codex', codexReview(CODEX_REVIEW));
  f.fix.finished({ chatId: 'codex-chat', completed: true });
  turn(f.fix, 'acp-chat', '/review');
  f.fix.finished({ chatId: 'acp-chat', completed: true, text: 'The parser drops the last token.' });
  const two = fixture();
  two.fix.event('claude', claudeCall('t', { findings: [finding, { ...finding, line: 9, short_summary: 'avg skips one' }] }));
  two.fix.event('claude', claudeResult('t'));
  two.fix.finished({ chatId: 'claude-chat', completed: true });
  f.settle();
  assert.deepEqual(
    made.map(([chatId, , show]) => [chatId, show]),
    [
      ['codex-chat', { by: 'mopilot', title: 'Applying the code review’s finding', body: '/r/calc.js:2: div multiplies' }],
      ['acp-chat', { by: 'mopilot', title: 'Applying the code review’s findings' }],
    ],
  );
  assert.equal(f.sent[0].item.id, 'authored-1');
  assert.deepEqual(f.sent[0].item.authored, { id: 'authored-1' });
  assert.equal(f.fix.sent.has('authored-1'), true);
  // without a maker (no chat store) the same text goes out unshown, with an id of its own
  two.settle();
  assert.equal(two.sent.length, 1);
  assert.equal(two.sent[0].item.authored, undefined);
  // several findings: counted in the title, one line each
  const shows: any[] = [];
  const many = fixture({ make: (_c: string, text: string, show: any) => (shows.push(show), { id: 'm', text }) });
  many.fix.event('claude', claudeCall('t', { findings: [finding, { ...finding, line: 9, short_summary: 'avg skips one' }] }));
  many.fix.event('claude', claudeResult('t'));
  many.fix.finished({ chatId: 'claude-chat', completed: true });
  many.settle();
  assert.deepEqual(shows, [
    { by: 'mopilot', title: 'Applying the code review’s 2 findings', body: 'calc.js:2: div multiplies\ncalc.js:9: avg skips one' },
  ]);
});
