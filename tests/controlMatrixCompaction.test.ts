// CM-K40: one rule for how a context compaction reads in a chat (shared/compaction.mjs), on every harness family, live
// and read back: a compaction item, never a user or agent message, and the handoff record keeps its summary (#1575, #1501).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AcpTranslator, buildAcpTurns } from '../electron/harness/items/acpTranslator.cjs';
import { ClaudeTranslator, buildTurns } from './support/claude-translate.ts';
import { renderConversation } from '../shared/handoff.mjs';
import { presentItems } from '../src/harness/codexTranslate.ts';

export const GUARDS = ['shared/', 'src/'];

const OPENCODE =
  '## Objective\n- Fix the login\n\n## Important Details\n- (none)\n\n## Work State\n### Completed\n- (none)\n\n## Next Move\n1. Run it\n\n## Relevant Files\n- (none)';
const CLAUDE = 'This session is being continued from a previous conversation that ran out of context.\n\nSummary: fix the login';

/** Turns the way a harness family's chat holds them after it compacted mid-task, with the summary each one writes. */
const families: Record<string, () => { turns: any[]; summary: string | null }> = {
  'Codex (app-server item)': () => ({
    turns: [
      {
        id: 't1',
        status: 'completed',
        items: presentItems([
          { type: 'userMessage', id: 'u', content: [{ type: 'text', text: 'Fix the login' }] },
          { type: 'contextCompaction', id: 'c' },
          { type: 'agentMessage', id: 'a', text: 'Fixed.' },
        ] as any[]),
      },
    ],
    summary: null,
  }),
  'Claude Code live (compact_boundary)': () => {
    const turns: any[] = [];
    const tr = new ClaudeTranslator('claude:x', '/r', (m: string, p: any) => {
      if (m === 'turn/started') turns.push({ ...p.turn, items: [] });
      if (m === 'item/completed') turns.at(-1).items.push(p.item);
    });
    tr.beginTurn('t1', { id: 'u', clientId: null, content: [{ type: 'text', text: 'Fix the login', text_elements: [] }] });
    tr.onMessage({ type: 'system', subtype: 'compact_boundary', uuid: 'b', session_id: 's', compact_metadata: { trigger: 'auto' } });
    tr.onMessage({ type: 'user', uuid: 's1', session_id: 's', message: { role: 'user', content: CLAUDE } });
    return { turns, summary: null };
  },
  'Claude Code read back (isCompactSummary)': () => ({
    turns: buildTurns(
      [
        { type: 'user', uuid: 's1', isCompactSummary: true, message: { role: 'user', content: CLAUDE }, parent_tool_use_id: null },
        { type: 'assistant', uuid: 'a1', message: { id: 'm', content: [{ type: 'text', text: 'Fixed.' }] }, parent_tool_use_id: null },
      ],
      'claude:x',
      '/r',
    ),
    summary: CLAUDE,
  }),
  'ACP live (opencode agent message)': () => {
    const turns: any[] = [];
    const tr = new AcpTranslator('opencode:x', '/r', (m: string, p: any) => {
      if (m === 'turn/started') turns.push({ ...p.turn, items: [] });
      if (m === 'item/completed') turns.at(-1).items.push(p.item);
    });
    tr.beginTurn('t1', { id: 'u', clientId: null, content: [{ type: 'text', text: 'Fix the login' }] });
    for (const t of [OPENCODE.slice(0, 3), OPENCODE.slice(3)])
      tr.onUpdate({ sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: t } });
    tr.onUpdate({ sessionUpdate: 'agent_message_chunk', messageId: 'm2', content: { type: 'text', text: 'Fixed.' } });
    tr.endTurn('end_turn', null);
    return { turns, summary: OPENCODE };
  },
  'ACP read back (transcript records)': () => ({
    turns: buildAcpTurns(
      [
        { t: 'user', turnId: 't1', user: { id: 'u', clientId: null, content: [{ type: 'text', text: 'Fix the login' }] } },
        {
          t: 'update',
          turnId: 't1',
          update: { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: OPENCODE } },
        },
        {
          t: 'update',
          turnId: 't1',
          update: { sessionUpdate: 'agent_message_chunk', messageId: 'm2', content: { type: 'text', text: 'Fixed.' } },
        },
        { t: 'end', turnId: 't1', stopReason: 'end_turn' },
      ] as any[],
      'opencode:x',
      '/r',
    ),
    summary: OPENCODE,
  }),
};

test('CM-K40: a compaction is a compaction item, never a message, and its summary is handed over, on every family', () => {
  for (const [family, make] of Object.entries(families)) {
    const { turns, summary } = make();
    const items = turns.flatMap((t) => t.items);
    assert.equal(items.filter((i) => i.type === 'contextCompaction').length, 1, `${family}: one compaction item`);
    const said = items
      .filter((i) => i.type === 'userMessage' || i.type === 'agentMessage')
      .map((i) => i.text ?? i.content?.map((c: any) => c.text).join(''));
    for (const s of said)
      assert.doesNotMatch(s, /This session is being continued|## Objective/, `${family}: no message carries the summary`);
    const record = renderConversation(turns, 1_000_000).text;
    assert.doesNotMatch(record, /(?:User|Assistant): (?:This session is being continued|## Objective)/, family);
    if (summary) assert.ok(record.includes(summary.split('\n')[0]), `${family}: the summary is in the handoff record`);
    else assert.match(record, /\(context compacted\)/, family);
  }
});

// CM-K41: a compaction loop (a compaction after every step) is the same items, so the same loop, on every family (#1575).
const { compactionLoop } = await import('../src/lib/turnStall.ts');
const loops: Record<string, () => any[]> = {
  Codex: () =>
    presentItems(
      [1, 2, 3].flatMap((n) => [
        { type: 'mcpToolCall', id: `t${n}`, status: 'completed' },
        { type: 'contextCompaction', id: `c${n}` },
      ]) as any[],
    ),
  'Claude Code': () => {
    const items: any[] = [];
    const tr = new ClaudeTranslator('claude:x', '/r', (m: string, p: any) => m === 'item/completed' && items.push(p.item));
    tr.beginTurn('t1', { id: 'u', clientId: null, content: [{ type: 'text', text: 'Fix it', text_elements: [] }] });
    for (const n of [1, 2, 3]) {
      tr.onMessage({
        type: 'assistant',
        uuid: `a${n}`,
        session_id: 's',
        message: { id: `m${n}`, content: [{ type: 'tool_use', id: `t${n}`, name: 'Read', input: { file_path: '/r/a' } }] },
      });
      tr.onMessage({
        type: 'user',
        uuid: `r${n}`,
        session_id: 's',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${n}`, content: 'x' }] },
      });
      tr.onMessage({ type: 'system', subtype: 'compact_boundary', uuid: `b${n}`, session_id: 's', compact_metadata: { trigger: 'auto' } });
    }
    return items;
  },
  ACP: () =>
    buildAcpTurns(
      [
        { t: 'user', turnId: 't1', user: { id: 'u', clientId: null, content: [{ type: 'text', text: 'Fix it' }] } },
        ...[1, 2, 3].flatMap((n) => [
          {
            t: 'update',
            turnId: 't1',
            update: { sessionUpdate: 'tool_call', toolCallId: `t${n}`, title: 'read', kind: 'read', status: 'completed' },
          },
          {
            t: 'update',
            turnId: 't1',
            update: { sessionUpdate: 'agent_message_chunk', messageId: `m${n}`, content: { type: 'text', text: OPENCODE } },
          },
        ]),
      ] as any[],
      'opencode:x',
      '/r',
      { live: true },
    )[0].items,
};
test('CM-K41: a compaction after every step is a compaction loop, on every family', () => {
  for (const [family, make] of Object.entries(loops)) assert.equal(compactionLoop(make()), 3, family);
});
