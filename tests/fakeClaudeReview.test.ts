// Exercises the scripted Claude fixture's /code-review: the forked review's text result, and with REPORT the
// ReportFindings call the app turns into its code-review card, in the shape the app reads (shared/reviewFindings.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeClaudeReview } from './e2e/fixtures/fake-claude-review.mjs';
import { reportedFindings } from '../shared/reviewFindings.mjs';
import { ClaudeTranslator } from './support/claude-translate.ts';

function fixture() {
  const events: any[] = [];
  const logs: any[] = [];
  const records: any[] = [];
  const results: any[] = [];
  const review = createFakeClaudeReview({
    sessionId: 'session',
    resolvedModel: () => 'model',
    send: (event: any) => events.push(event),
    log: (entry: any) => logs.push(entry),
    record: (type: string, entry: any) => records.push({ type, ...entry }),
    result: (...args: any[]) => results.push(args),
    sleep: async () => {},
    stepMs: 0,
  });
  return { ...review, events, logs, records, results };
}
const mainThread = (events: any[]) => events.filter((e) => e.parent_tool_use_id === null);

test('a plain review runs as a forked task and answers with its findings as the result text', async () => {
  const f = fixture();
  await f.runReview({ message: { content: [{ type: 'text', text: '/code-review' }] } }, '', 1);
  assert.deepEqual(f.logs, [{ kind: 'review', args: '', blocks: ['text'] }]);
  assert.deepEqual(
    f.events.filter((e) => e.type === 'system').map((e) => e.subtype),
    ['task_started', 'task_notification'],
  );
  const [reply] = mainThread(f.events);
  assert.equal(reply.message.model, '<synthetic>');
  assert.match(reply.message.content[0].text, /calc\.js:1 .*\(review default\)/);
  assert.equal(f.results.length, 1);
  assert.match(f.results[0][2], /div/);
  assert.equal(
    f.events.some((e) => e.message?.content?.some?.((b: any) => b.name === 'ReportFindings')),
    false,
  );
});

test('with REPORT the review runs inline, as the CLI with CLAUDE_CODE_REPORT_FINDINGS: diff, ReportFindings, a line', async () => {
  const f = fixture();
  await f.runReview({ message: { content: 'x' } }, 'high REPORT', 1);
  assert.deepEqual(f.logs[0].blocks, ['string']);
  assert.deepEqual(
    f.events.filter((e) => e.parent_tool_use_id !== null || e.type === 'system'),
    [],
    'no forked task',
  );
  const blocks = f.events.map((e) => e.message.content[0]);
  assert.deepEqual(
    blocks.map((b) => b.name ?? b.type),
    ['Bash', 'tool_result', 'ReportFindings', 'tool_result', 'text'],
  );
  assert.equal(blocks[3].tool_use_id, blocks[2].id);
  const { level, findings } = reportedFindings(blocks[2].input);
  assert.equal(level, 'high');
  assert.deepEqual(
    findings.map((x: any) => [x.file, x.line, x.category]),
    [
      ['calc.js', 1, 'correctness'],
      ['calc.js', 1, 'test-coverage'],
    ],
  );
  assert.deepEqual(
    f.records.map((r) => r.type),
    ['assistant', 'user', 'assistant', 'user', 'assistant'],
  );
  assert.equal(f.results.length, 1);
  assert.equal(f.results[0][2], blocks[4].text);

  // the app's translator turns the stream into the structured code-review card
  const items: any[] = [];
  const tr = new ClaudeTranslator('claude:r', '/repo', (method: string, p: any) => method === 'item/completed' && items.push(p.item));
  tr.beginTurn('t1', { id: 'u1', clientId: null, content: [{ type: 'text', text: '/code-review high REPORT', text_elements: [] }] });
  for (const e of f.events) tr.onMessage(e);
  const card = items.find((i) => i.type === 'exitedReviewMode');
  assert.equal(card.level, 'high');
  assert.equal(card.findings.length, 2);
  assert.equal(items.filter((i) => i.type === 'exitedReviewMode').length, 1, 'no Markdown review after it');
});

test('REPORT without a level reports at medium', async () => {
  const f = fixture();
  await f.runReview({ message: { content: 'x' } }, 'REPORT', 1);
  assert.equal(f.events.find((e) => e.message.content[0].name === 'ReportFindings').message.content[0].input.level, 'medium');
});
