// Phone attachment references from each harness's production history builder, through saved rows and the paired image RPC.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { userInput } from '../shared/userInput.mjs';
import { turnFromServer } from '../shared/codexTurns.mjs';
import { rig } from './support/remote-kit.ts';
const require = createRequire(import.meta.url);
const { openHistory, allTurns, releaseHistory } = require('../electron/platform/claudeHistory.cjs');
const { buildAcpTurns } = require('../electron/harness/items/acpTranslator.cjs');
const { rowsOf } = require('../electron/capabilities/browser/chromePanelLive.cjs');
const { readUserImage } = require('../electron/session/userImage.cjs');
const { readCallImage } = require('../electron/session/callImage.cjs');
const { row } = await import('../mobile/src/presentation/thread');

const data = 'iVBORw0KGgo=';
const url = `data:image/png;base64,${data}`;

test('Claude, Codex and ACP real history producers preserve the same fetchable picture positions and row scope', async () => {
  const read = await openHistory(
    [
      {
        type: 'user',
        uuid: 'u',
        timestamp: '2026-01-01T00:00:00Z',
        message: {
          content: [
            { type: 'text', text: 'look' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
          ],
        },
      },
    ],
    'chat',
    '/work',
    { key: 'native' },
  );
  let claude;
  try {
    claude = await allTurns(read);
  } finally {
    releaseHistory(read);
  }
  const input: any[] = userInput('look', [{ kind: 'image', path: '/attached.png' }]);
  const acp = buildAcpTurns([{ t: 'user', turnId: 't', user: { id: 'u', content: input } }], 'native', '/work');
  const codex = [
    turnFromServer({
      id: 't',
      status: 'completed',
      error: null,
      startedAt: null,
      completedAt: null,
      durationMs: null,
      items: [{ type: 'userMessage', id: 'u', clientId: null, content: input }],
    }),
  ];
  for (const [kind, turns, expected] of [
    ['claude', claude, { url }],
    ['acp:test', acp, { path: '/attached.png' }],
    ['codex', codex, { path: '/attached.png' }],
  ] as const) {
    const source = kind === 'codex' ? 'native' : `${kind}:native`;
    const projected = rowsOf(turns.map((turn: any) => ({ ...turn, sourceSession: source }))).rows;
    const message = projected.find((r: any) => r.role === 'user');
    assert.equal(message.images, 1, kind);
    const shown = row(message, 'rows');
    assert.equal(shown.images, 1);
    assert.deepEqual(
      await readUserImage({ segments: [{ kind, nativeId: 'native' }] }, async () => ({ turns }), shown.messageId!, 0),
      expected,
      kind,
    );
  }
});

test('screenshot siblings respect the same source, turn and slice boundaries', async () => {
  const shot = {
    id: 'same',
    type: 'mcpToolCall',
    tool: 'desktop_screenshot',
    result: { content: [{ type: 'image', data, mimeType: 'image/png' }] },
  };
  const turns = [
    { id: 't', items: [shot] },
    { id: 'hidden', items: [{ ...shot, id: 'secret' }] },
  ];
  const record = { segments: [{ kind: 'codex', nativeId: 'native', count: 1 }] };
  const reader = async () => ({ turns });
  assert.equal(await readCallImage(record, reader, '["native","t","same"]'), url);
  assert.equal(await readCallImage(record, reader, '["wrong","t","same"]'), null);
  assert.equal(await readCallImage(record, reader, '["native","wrong","same"]'), null);
  assert.equal(await readCallImage(record, reader, 'secret'), null);
});

test('follow snapshot references fetch image bytes only through the paired message method', async () => {
  const saved = rowsOf([
    { id: 't', sourceSession: 'native', items: [{ type: 'userMessage', id: 'u', content: [{ type: 'image', url }] }] },
  ]).rows;
  const asked: unknown[] = [];
  const r = rig({
    ops: {
      items: async () => ({ itemsShape: 'rows', items: saved }),
      userImage: async (...args: unknown[]) => {
        asked.push(args);
        return { data, width: 8, height: 4 };
      },
    },
  });
  const p = r.phone('p1');
  const snapshot = (await p.ask('chat.follow', { chatId: 'c1' })).result;
  const message = row(snapshot.items[0], 'rows');
  assert.equal(JSON.stringify(snapshot).includes(data), false);
  const answer = await p.ask('messages.image', { chatId: 'c1', itemId: message.messageId, index: 0, maxSide: 360 });
  assert.equal(answer.result.data, data);
  assert.deepEqual(
    asked.map((args: any) => args.slice(0, 4)),
    [['c1', '["native","t","u"]', 0, 360]],
  );
  assert.equal(typeof (asked[0] as any[])[4], 'function');
});
