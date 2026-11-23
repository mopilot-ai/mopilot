// The fake harnesses' shared turn details (tests/e2e/fixtures/fake-turn-details.mjs) against the app's own readers:
// what the CUJ specs expect the app to show from them is what the app's parsers make of them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CONTEXT,
  HOOK_FAILURE,
  THOUGHTS,
  THOUGHT_MS,
  claudeHookResponses,
  claudeUsage,
  codexHookRuns,
  codexReviewText,
  codexTurnEnd,
  extraClaudeModels,
  heldNext,
  released,
  streamClaudeThoughts,
  streamCodexThoughts,
  thoughtsFor,
} from './e2e/fixtures/fake-turn-details.mjs';
import { codexHookItem } from '../shared/hookRuns.mjs';
import { hookNote } from './support/claude-translate.ts';
import { tokenUsage } from '../shared/claudeItems/tokenUsage.mjs';
import { parseCodexReview } from '../shared/reviewFindings.mjs';
import { claudeModels } from '../shared/claudeModels.mjs';

const noSleep = async () => {};

test('thoughts: none, THINK one short summary, THINKTWICE two that only together pass half a second', () => {
  assert.deepEqual(thoughtsFor('hello'), []);
  assert.deepEqual(
    thoughtsFor('please THINK').map((t) => t.ms),
    [15],
  );
  const two = thoughtsFor('THINKTWICE');
  assert.deepEqual(
    two.map((t) => t.summary),
    THOUGHTS,
  );
  assert.ok(two.every((t) => t.ms < 500) && two.reduce((n, t) => n + t.ms, 0) >= 500);
  assert.equal(THOUGHT_MS, 400);
});

test('Codex thoughts: each a reasoning item started, summarized and completed, in order', async () => {
  const sent: [string, any][] = [];
  const turn = { items: [] as any[] };
  await streamCodexThoughts('THINKTWICE', {
    notify: (m: string, p: any) => sent.push([m, p]),
    sleep: noSleep,
    turn,
    threadId: 't',
    turnId: 'u',
  });
  assert.deepEqual(
    sent.map(([m]) => m),
    Array(2).fill(['item/started', 'item/reasoning/summaryPartAdded', 'item/reasoning/summaryTextDelta', 'item/completed']).flat(),
  );
  assert.deepEqual(
    turn.items.map((i) => i.summary),
    THOUGHTS.map((t) => [t]),
  );
  assert.equal(sent[2][1].delta, THOUGHTS[0]);
});

test('ASKASYNC: an async question, then a command the turn keeps running after it', async () => {
  const sent: [string, any][] = [];
  const turn = { items: [] as any[] };
  await streamCodexThoughts('ASKASYNC SLOW', {
    notify: (m: string, p: any) => sent.push([m, p]),
    sleep: noSleep,
    turn,
    threadId: 't',
    turnId: 'u',
    cwd: '/w',
  });
  const [asked, working] = turn.items;
  assert.equal(asked.delivery, 'async');
  assert.deepEqual(asked.questions, [{ title: 'Which color?', options: ['Red', 'Blue'] }]);
  assert.equal(working.type, 'commandExecution');
  assert.equal(working.cwd, '/w');
  assert.deepEqual(
    sent.map(([m, p]) => [m, p.item.id]),
    [
      ['item/started', asked.id],
      ['item/completed', asked.id],
      ['item/started', working.id],
      ['item/completed', working.id],
    ],
  );
});

test('Codex hooks: a passing run shows nothing, a failing Stop one line with its reason', () => {
  assert.deepEqual(codexHookRuns('nothing'), []);
  const [ok, failed] = codexHookRuns('HOOKOK HOOKFAIL', 7);
  assert.equal(ok.startedAt, 7);
  assert.equal(codexHookItem(ok as any), null);
  assert.deepEqual(codexHookItem(failed as any)?.fragments, [{ text: HOOK_FAILURE }]);
});

test('Codex turn end: hook runs, then CTXUSE token usage for the window', () => {
  const sent: [string, any][] = [];
  const notify = (m: string, p: any) => sent.push([m, p]);
  codexTurnEnd('plain', { notify, threadId: 't', turnId: 'u' });
  assert.equal(sent.length, 0);
  codexTurnEnd('HOOKFAIL CTXUSE', { notify, threadId: 't', turnId: 'u' });
  assert.deepEqual(
    sent.map(([m]) => m),
    ['hook/completed', 'thread/tokenUsage/updated'],
  );
  const usage = sent[1][1].tokenUsage;
  assert.equal(usage.last.totalTokens, CONTEXT.codex.used);
  assert.equal(usage.last.inputTokens + usage.last.outputTokens, CONTEXT.codex.used);
  assert.equal(usage.modelContextWindow, CONTEXT.codex.window);
});

test("Codex review: one line by default; FAKE_CODEX_REVIEW_FINDINGS gives two findings in Codex's format", () => {
  assert.equal(codexReviewText('/repo', {}), '[P1] Fake finding: a+b became a-b');
  // the fake's own environment by default (no test sets the variable here)
  assert.equal(codexReviewText('/repo'), codexReviewText('/repo', {}));
  assert.equal(parseCodexReview(codexReviewText('/repo', {})), null);
  const parsed = parseCodexReview(codexReviewText('/repo', { FAKE_CODEX_REVIEW_FINDINGS: '1' }));
  assert.equal(parsed?.intro, 'Two issues in calc.js.');
  assert.deepEqual(
    parsed?.findings.map((f) => [f.file, f.line, f.category, f.shortSummary]),
    [
      ['/repo/calc.js', 1, 'P1', 'div multiplies instead of dividing'],
      ['/repo/calc.js', 1, 'P2', 'No test covers div'],
    ],
  );
  assert.equal(parsed?.findings[0].summary.split('\n').length, 3);
});

test('Claude thoughts: each a thinking block streamed, then its message; the text takes the next index', async () => {
  const events: any[] = [];
  const sent: any[] = [];
  const message = { id: 'm1', model: 'fake', usage: {} };
  const at = await streamClaudeThoughts('THINKTWICE', {
    event: (e: any) => events.push(e),
    sleep: noSleep,
    send: (m: any) => sent.push(m),
    message,
  });
  assert.equal(at, 2);
  assert.deepEqual(
    events.map((e) => [e.type, e.index]),
    [
      ['content_block_start', 0],
      ['content_block_delta', 0],
      ['content_block_stop', 0],
      ['content_block_start', 1],
      ['content_block_delta', 1],
      ['content_block_stop', 1],
    ],
  );
  assert.equal(events[1].delta.thinking, THOUGHTS[0]);
  assert.deepEqual(
    sent.map((m) => [m.type, m.message.id, m.message.content[0].thinking]),
    THOUGHTS.map((t) => ['assistant', 'm1', t]),
  );
  assert.equal(await streamClaudeThoughts('none', { event: () => {}, sleep: noSleep, send: () => {}, message }), 0);
});

test('Claude hooks: the passing SessionStart (a runtime warning) shows nothing, the failing Stop its line', () => {
  assert.deepEqual(claudeHookResponses('none'), []);
  const [ok, failed, notice] = claudeHookResponses('HOOKOK HOOKFAIL');
  assert.equal(hookNote(ok), null);
  assert.equal(hookNote(failed), null);
  assert.equal(hookNote(notice), HOOK_FAILURE);
});

test('Claude usage: a plain reply uses a few tokens; CTXUSE fills the context to its reading', () => {
  const plain = claudeUsage('hi', 'fake-claude: hi');
  assert.deepEqual(plain, { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  const full = claudeUsage('CTXUSE now', 'fake-claude: CTXUSE now and more words');
  const read = tokenUsage({ usage: full, modelUsage: { fake: { contextWindow: CONTEXT.claude.window } } }, null);
  assert.equal(read.last.totalTokens, CONTEXT.claude.used);
  assert.equal(read.modelContextWindow, CONTEXT.claude.window);
});

test('Claude models: FAKE_CLAUDE_1M adds a 1M variant the menu names with 1M', () => {
  assert.deepEqual(extraClaudeModels({}), []);
  assert.deepEqual(extraClaudeModels(), []);
  const [model] = extraClaudeModels({ FAKE_CLAUDE_1M: '1' });
  assert.equal(claudeModels([model])[0].label, 'Fake Haiku 1M');
  assert.equal(claudeModels([model])[0].more, false);
});

test('Claude models: FAKE_CLAUDE_FAST adds a model with Fast, alongside the 1M variant', () => {
  const [fast] = extraClaudeModels({ FAKE_CLAUDE_FAST: '1' });
  assert.equal(claudeModels([fast])[0].fast, true);
  assert.deepEqual(
    extraClaudeModels({ FAKE_CLAUDE_1M: '1', FAKE_CLAUDE_FAST: '1' }).map((m) => m.value),
    ['haiku[1m]', 'fastopus'],
  );
});

test('a held turn: the hold file is taken once; release resolves when its file appears, and takes it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-turn-details-'));
  const log = path.join(dir, 'fake.jsonl');
  try {
    assert.equal(heldNext(undefined), false);
    assert.equal(heldNext(log), false);
    fs.writeFileSync(`${log}.hold-next`, '');
    assert.equal(heldNext(log), true);
    assert.equal(fs.existsSync(`${log}.hold-next`), false);
    assert.equal(heldNext(log), false);
    let done = false;
    const wait = released(log, 5).then(() => (done = true));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(done, false);
    fs.writeFileSync(`${log}.release`, '');
    await wait;
    assert.equal(fs.existsSync(`${log}.release`), false);
    // at its own pace by default
    fs.writeFileSync(`${log}.release`, '');
    await released(log);
    assert.equal(fs.existsSync(`${log}.release`), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
