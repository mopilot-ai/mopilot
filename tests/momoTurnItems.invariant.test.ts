// Whole-repository invariant (#2139): MoMo's background readers of a chat's turns (the history index, the memory pass) read
// what the user said from turn items as the shared transcript builders make them on every harness (Codex's rollout
// reader, Claude Code's transcript translator, ACP's record replay), and every MoMo module that reads user messages
// reads their words through electron/momo/turnItems.cjs userMessageText. The memory pass read `item.text`, which those
// items don't carry, so it never saw what the user said; its tests had built items by hand with that made-up field.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { treeFiles } from '../scripts/source-tree.mjs';
import { parseRollout } from './support/rollout.ts';

export const GUARDS = ['electron/momo/', 'core/crates/rollout/', 'electron/harness/items/claudeTranslator.cjs', 'core/crates/translate/'];

const require = createRequire(import.meta.url);
const { buildTurns } = await import('./support/claude-translate.ts');
const { buildAcpTurns } = require('../electron/harness/items/acpTranslator.cjs');
const { turnText } = require('../electron/momo/memoryPass.cjs');
const { chunksOf } = require('../electron/momo/historyIndexer.cjs');
const { momoBlock, withMomoContext } = require('../shared/momoContext.mjs');

const SAID = 'I moved to Lisbon last month';
const REPLY = 'Noted, Lisbon it is.';
/** What Claude Code and ACP are sent: MoMo's block ahead of the user's words (shared/momoContext.mjs). */
const WITH_BLOCK = withMomoContext(SAID, momoBlock({ facts: ['Likes tea'] }));

/** One turn of each harness, as its own transcript builder makes it. */
function turnsByHarness() {
  const ev = (payload: object) => ({ timestamp: 't', type: 'event_msg', payload });
  const codex = parseRollout(
    [
      { type: 'session_meta', payload: { id: 'th', cwd: '/w' } },
      ev({ type: 'task_started', turn_id: 'c1', started_at: 1 }),
      ev({
        type: 'item_completed',
        thread_id: 'th',
        turn_id: 'c1',
        item: { type: 'UserMessage', id: 'u1', client_id: 'k', content: [{ type: 'text', text: SAID, text_elements: [] }] },
      }),
      ev({
        type: 'item_completed',
        thread_id: 'th',
        turn_id: 'c1',
        item: { type: 'AgentMessage', id: 'a1', content: [{ type: 'Text', text: REPLY }], phase: 'final_answer' },
      }),
      ev({ type: 'task_complete', turn_id: 'c1', started_at: 1, completed_at: 2, duration_ms: 1000 }),
    ]
      .map((r) => JSON.stringify(r))
      .join('\n'),
  ).turns;
  const claude = buildTurns(
    [
      { type: 'user', uuid: 'u1', message: { role: 'user', content: WITH_BLOCK } },
      { type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: REPLY }] } },
    ],
    'claude:s',
    '/w',
  );
  const acp = buildAcpTurns(
    [
      { t: 'session', sessionId: 's' },
      { t: 'user', turnId: 't1', user: { id: 'u-1', clientId: 'k', content: [{ type: 'text', text: WITH_BLOCK }] }, at: 1 },
      { t: 'update', turnId: 't1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: REPLY } }, at: 2 },
      { t: 'end', turnId: 't1', stopReason: 'end_turn', at: 3 },
    ] as any,
    'acp:x:1',
    '/w',
  );
  return { codex, claude, acp };
}

test('on every harness, the memory pass and the history index read what the user said, without MoMo’s block', () => {
  for (const [harness, turns] of Object.entries(turnsByHarness())) {
    assert.ok(turns.length >= 1, `${harness} made a turn`);
    const text = turns.map((t: any) => turnText(t)).join('\n');
    assert.match(text, new RegExp(`^User: ${SAID}$`, 'm'), `${harness}: the pass reads the user's words`);
    assert.doesNotMatch(text, /momo-context|Likes tea/, `${harness}: MoMo's block is not the user's words`);
    const [chunk] = chunksOf(turns, { chatId: 'c', harness, kind: 'main', now: 1 });
    assert.equal(chunk.user, SAID, `${harness}: the index keeps the user's words, without MoMo's block`);
  }
});

test('every MoMo module that reads user messages reads their words through turnItems.cjs', () => {
  const readers = treeFiles('electron/momo', /\.cjs$/).filter(
    (f) => /type\s*===\s*'userMessage'/.test(fs.readFileSync(f, 'utf8')) && !f.endsWith(`${path.sep}turnItems.cjs`),
  );
  assert.ok(readers.length >= 2, `the readers were found (${readers.join(', ')})`);
  const bypass = readers.filter((f) => !/require\('\.\/turnItems\.cjs'\)/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(bypass, [], 'read a user message’s words with userMessageText (electron/momo/turnItems.cjs)');
});
