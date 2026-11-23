// The open-a-chat benchmark's histories (scripts/perf-bench/history.mjs): the shapes each harness reads, checked against the app's own reader where one runs in node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acpRecords, codexThreads, replyText, turnSpecs, writeClaudeSession } from '../scripts/perf-bench/history.mjs';
import { buildAcpTurns } from '../electron/harness/items/acpTranslator.cjs';

test('a reply is as long as asked and ends in its marker', () => {
  const text = replyText(8192, 'END-x');
  assert.equal(text.length, 8192 + ' END-x'.length);
  assert.ok(text.endsWith(' END-x'));
});

test('turn specs vary their reply size between 8 and 20 kB, give every third turn tools, and mark the last reply', () => {
  const specs = turnSpecs('t', 6);
  assert.equal(specs.length, 6);
  for (const s of specs) assert.ok(s.reply.length >= 8192 && s.reply.length <= 8192 + 12288 + 20);
  assert.deepEqual(
    specs.map((s) => s.tools),
    [3, 0, 0, 3, 0, 0],
  );
  assert.ok(specs[5].reply.endsWith('END-t'));
  assert.ok(specs[4].reply.endsWith('R-t-4'));
  assert.match(specs[0].text, /^Q-t-0: /);
});

test("Codex threads carry each turn's items: the user message, its commands, then the reply", () => {
  const [thread, second] = codexThreads(['a', 'b'], [4, 2]);
  assert.equal(thread.id, 'perf-codex-a');
  assert.equal(thread.turns.length, 4);
  assert.equal(second.turns.length, 2);
  assert.deepEqual(
    thread.turns[0].items.map((i: { type: string }) => i.type),
    ['userMessage', 'commandExecution', 'commandExecution', 'commandExecution', 'agentMessage'],
  );
  assert.deepEqual(
    thread.turns[1].items.map((i: { type: string }) => i.type),
    ['userMessage', 'agentMessage'],
  );
  assert.equal(thread.turns[0].text, (thread.turns[0].items[0] as { content: { text: string }[] }).content[0].text);
});

test('a Claude transcript has a user line, tool_use/tool_result pairs and a reply for each turn, chained by parentUuid', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-claude-'));
  try {
    writeClaudeSession(path.join(dir, '.claude'), dir, { id: 'sess-1', tag: 'c', turns: 3 });
    const project = path.join(dir, '.claude', 'projects', path.join(dir, 'perf-claude').replace(/[^a-zA-Z0-9]/g, '-'));
    const lines = fs
      .readFileSync(path.join(project, 'sess-1.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const records = lines.filter((l) => l.type === 'user' || l.type === 'assistant');
    // 3 user lines + (3 tools x (use + result)) for turn 0 + 3 replies
    assert.equal(records.length, 3 + 6 + 3);
    assert.equal(records[0].parentUuid, null);
    records.slice(1).forEach((r, i) => assert.equal(r.parentUuid, records[i].uuid));
    assert.ok(records.at(-1).message.content[0].text.endsWith('END-c'));
    assert.equal(lines.find((l) => l.type === 'custom-title').customTitle, 'perf claude c');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("basic-harness records read back, through the app's own translator, as the turns they were made from", () => {
  const records = acpRecords('a', 4, 1000);
  const turns = buildAcpTurns(records as never, 'acp:kimi:perf', '/');
  assert.equal(turns.length, 4);
  const last = turns.at(-1)!.items.at(-1) as { type: string; text: string };
  assert.equal(last.type, 'agentMessage');
  assert.ok(last.text.endsWith('END-a'));
  // the first turn ran three commands before replying
  assert.equal(turns[0].items.filter((i) => i.type === 'commandExecution').length, 3);
  // a reply is written in chunks
  assert.ok(records.filter((r: { t: string }) => r.t === 'update').length > 4 * 8);
});
