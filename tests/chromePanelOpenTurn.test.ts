// A chat main is running reads to the side panel as running, even on a harness whose saved history cannot say so: Claude Code's transcript replays a call with no result as finished, so main says the turn is open (electron/app/chromePanel.cjs read, electron/session/peerTranscript.cjs, peerNativeHistory.cjs) (#3046, B3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { setup } from './support/controller/fixture.ts';
import { buildTurns } from './support/claude-translate.ts';
import { acpTurnsOf } from './support/acp-transcript.ts';

const require = createRequire(import.meta.url);
const { createChromePanel, projectsFileOf } = require('../electron/app/chromePanel.cjs');
const { createPeerNativeReader } = require('../electron/session/peerNativeHistory.cjs');
const { readPeerTurns, peerHistoryReader } = require('../electron/session/peerTranscript.cjs');

const messages = [
  { type: 'user', uuid: 'u1', message: { role: 'user', content: 'go' }, timestamp: '2026-11-01T00:00:00Z' },
  {
    type: 'assistant',
    uuid: 'a1',
    message: {
      id: 'm1',
      role: 'assistant',
      content: [{ type: 'tool_use', id: 't1', name: 'mcp__mopilot_chrome__navigate', input: { url: 'http://x.test/' } }],
      stop_reason: 'tool_use',
    },
    timestamp: '2026-11-01T00:00:01Z',
  },
];

test('Claude Code’s native reader leaves the turn main runs, and a call with no result, running; without it the replay says finished', async () => {
  const read = createPeerNativeReader({
    claudeTurns: async (id: string, cwd: string, o: any) => buildTurns(messages, id, cwd, o),
    acpTurns: acpTurnsOf(() => []),
    codexTurns: async () => ({ data: [] }),
  });
  const status = async (options?: object) => {
    const { turns } = await read({ kind: 'claude', nativeId: 'n' }, undefined, options);
    return [turns.at(-1).status, turns.at(-1).items.at(-1).status];
  };
  assert.deepEqual(await status(), ['completed', 'completed']);
  assert.deepEqual(await status({ assistantOnly: false }), ['completed', 'completed']);
  assert.deepEqual(await status({ open: true }), ['inProgress', 'inProgress']);
  // Codex and ACP histories say it themselves: the flag changes nothing there
  const acp = createPeerNativeReader({
    claudeTurns: async () => [],
    acpTurns: acpTurnsOf(() => []),
    codexTurns: async () => ({ data: [] }),
  });
  assert.deepEqual((await acp({ kind: 'acp:test', nativeId: 'n' }, undefined, { open: true })).turns, []);
});

test('only the last segment of a chat that switched harnesses is the turn main runs', async () => {
  const seen: any[] = [];
  const record = {
    segments: [
      { kind: 'claude', nativeId: 'one' },
      { kind: 'codex', nativeId: 'two' },
    ],
  };
  const read = async (seg: any, _signal: any, options: any) => (seen.push([seg.nativeId, options]), { turns: [] });
  await readPeerTurns(record, read, { open: true });
  assert.deepEqual(seen, [
    ['one', { assistantOnly: false }],
    ['two', { assistantOnly: false, open: true }],
  ]);
  seen.length = 0;
  await readPeerTurns(record, read);
  assert.deepEqual(seen, [
    ['one', { assistantOnly: false }],
    ['two', { assistantOnly: false }],
  ]);
  // by chat id, the options go through
  seen.length = 0;
  await peerHistoryReader({ records: new Map([['c', record]]) }, () => read)('c', { open: true });
  assert.deepEqual(seen[1], ['two', { assistantOnly: false, open: true }]);
});

/** A panel over a chat whose history reads are recorded, its turn in `turn`. */
function wired(t: any, turn: string | undefined) {
  const h = setup();
  t.after(() => fs.rmSync(h.chats.dir, { recursive: true, force: true }));
  h.chats.records.set('th-1', { id: 'th-1', segments: [{ kind: 'claude', nativeId: 'th-1' }], meta: {} });
  if (turn) h.c.state.get('th-1').turn = turn;
  const reads: any[][] = [];
  const live: any = {
    chats: h.chats,
    controller: h.c,
    peerRuntime: { readHistory: async (...args: any[]) => (reads.push(args), { turns: [] }) },
  };
  const panel = createChromePanel({
    live,
    sources: {},
    home: h.chats.dir,
    projectsFile: projectsFileOf(h.chats.dir),
    prefs: () => ({}),
    usable: async () => true,
    starter: {},
    send: async () => {},
    open: () => {},
  });
  const read = () => new Promise<any>((resolve) => void panel.handle({ id: 1, method: 'read', params: { chatId: 'th-1' } }, resolve));
  return { read, reads };
}

test('a panel read of a chat main is running asks for its turn open; an idle chat’s read is as before', async (t) => {
  for (const [turn, args] of [
    ['running', [['th-1', { open: true }]]],
    ['awaitingUser', [['th-1', { open: true }]]],
    [undefined, [['th-1', { open: false }]]],
  ] as const) {
    const { read, reads } = wired(t, turn);
    const r = await read();
    assert.equal(r.error, undefined);
    assert.deepEqual(reads, args);
  }
});
