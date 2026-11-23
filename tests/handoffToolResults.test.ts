// shared/handoff.mjs: what a switch tells the next agent about tool results it leaves out (#1381 stab1: after a Claude →
// Codex switch, Codex made up tracking numbers Claude had read, and overruled a refund Claude had found qualified).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeHandoff, renderConversation } from '../shared/handoff.mjs';

const text = (t: string) => ({ type: 'text', text: t });
const render = (items: object[]) => renderConversation([{ items } as any], 1e6).text;

test('a browser read stays one line: no arguments or page text', () => {
  const out = render([
    {
      type: 'mcpToolCall',
      server: 'mopilot_browser',
      tool: 'browser_script',
      arguments: { code: 'await tab.goto("http://shop.localhost/orders/SO-50901")' },
      result: { content: [text('tracking NL-YY39MYKYWZ')] },
    },
  ]);
  assert.match(out, /\n- Tool mopilot_browser · browser_script\nAssistant/);
  assert.doesNotMatch(out, /NL-YY39|shop\.localhost/);
});

test('a record of turns says tool results are left out, so a missing fact is read again; a summary or workspace one does not', () => {
  const rule =
    "The record leaves out what browser, desktop and other app tools returned: read again from its source anything you need that the record doesn't state (an ID, number or date), never guess it, and keep the earlier agent's findings unless the source contradicts them.";
  const base = {
    from: 'claude' as const,
    fromModel: null,
    turns: [],
    since: 0,
    targetModel: 'gpt-6-luna',
    workspace: '## Workspace\nDirectory: /w',
  };
  const full = composeHandoff({ ...base, mode: 'auto' });
  assert.ok(full.includes(`re-read files before editing them. ${rule} Continue by answering`));
  const delta = composeHandoff({ ...base, mode: 'delta' });
  assert.ok(delta.includes(`re-read files before editing them. ${rule}\n\n## Workspace`));
  for (const mode of ['summary', 'workspace'] as const)
    assert.ok(!composeHandoff({ ...base, mode, note: 'n' }).includes('The record leaves out'), mode);
});
