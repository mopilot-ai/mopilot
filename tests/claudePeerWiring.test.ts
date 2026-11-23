// The real Claude harness (createClaudeHarness), not a mock, feeds the peer native reader: the sidebar PR badge's
// prose-only read goes through its replies reader, the whole-history reads through messages, and Codex and ACP
// segments never touch it. A wiring slip (a method the harness does not expose) fails here, not only in tsc.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fakes, load } from './support/electron-claude.ts';
import { acpTurnsOf } from './support/acp-transcript.ts';

const require = createRequire(import.meta.url);
process.env.CODEX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-wiring-codex-'));
const { createPeerNativeReader, claudePeerSource } = require('../electron/session/peerNativeHistory.cjs');
const { readPeerReference } = require('../electron/session/peerTranscript.cjs');

const messages = [
  { type: 'user', uuid: 'u', message: { role: 'user', content: 'open a PR' } },
  {
    type: 'assistant',
    uuid: 'a',
    message: { id: 'a', content: [{ type: 'text', text: 'Opened https://github.com/o/r/pull/7' }], stop_reason: 'end_turn' },
  },
];

test('the harness exposes messages and replies, and the peer reference reads a Claude segment through replies', async () => {
  fakes.sdk.getSessionMessages = async () => messages;
  const { claude } = load({ register: false });
  assert.equal(typeof claude.messages, 'function');
  assert.equal(typeof claude.replies, 'function');
  const calls: string[] = [];
  const read = createPeerNativeReader({
    ...claudePeerSource(claude),
    projectOf: async () => '/repo',
    acpTurns: acpTurnsOf((key: string) => (calls.push(`acp:${key}`), [])),
    codexTurns: async (id: string) => (calls.push(`codex:${id}`), { data: [] }),
  });
  // a Claude chat: the prose-only read yields the reply, and the full read the user message as well
  const claudeChat = { segments: [{ kind: 'claude', nativeId: 'n1', count: 1 }] };
  const prose = await readPeerReference(claudeChat, read, true);
  assert.deepEqual(
    prose.turns.flatMap((t: any) => t.items.map((i: any) => i.type)),
    ['agentMessage'],
  );
  assert.match(prose.turns[0].items[0].text, /pull\/7/);
  const full = await readPeerReference(claudeChat, read, false);
  assert.ok(full.turns[0].items.some((i: any) => i.type === 'userMessage'));
  assert.deepEqual(calls, []);
  // a chat switched to Claude from Codex: both segments are read, the Claude one through replies; ACP and Codex ids never reach the harness
  const switched = {
    segments: [
      { kind: 'codex', nativeId: 'c1', count: 1 },
      { kind: 'acp:test', nativeId: 'a1', count: 1 },
      { kind: 'claude', nativeId: 'n2', count: 1 },
    ],
  };
  await readPeerReference(switched, read, true).catch(() => undefined);
  assert.deepEqual(calls, ['codex:c1', 'acp:acp:test:a1']);
});
