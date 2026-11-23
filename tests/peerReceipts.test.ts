import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createPeerReceiptReader } = require('../electron/session/peerReceipts.cjs');

test('native recovery reads the recorded segment and requires the exact peer input identity', async () => {
  const calls: any[] = [];
  const read = createPeerReceiptReader({
    claudeMessages: async (id: string) => {
      calls.push(['claude', id]);
      return [
        { type: 'assistant', uuid: 'peer' },
        { type: 'user', uuid: 'other' },
        { type: 'user', uuid: 'peer' },
      ];
    },
    acpHistory: (key: string) => {
      calls.push(['acp', key]);
      return [
        { t: 'update', turnId: 'wrong', user: { clientId: 'peer' } },
        { t: 'user', turnId: 'at', user: { clientId: 'peer', id: 'u-peer' } },
      ];
    },
    codexTurns: async (id: string, options: any) => {
      calls.push(['codex', id, options]);
      return options.cursor
        ? { data: [{ id: 'ct', items: [{ type: 'userMessage', clientId: 'peer', id: 'item' }] }] }
        : {
            data: [
              {
                id: 'wrong',
                items: [
                  { type: 'agentMessage', id: 'peer' },
                  { type: 'userMessage', clientId: 'other', id: 'other' },
                ],
              },
            ],
            nextCursor: 'older',
          };
    },
  });
  for (const [kind, turnId, itemId] of [
    ['claude', 'h-peer', 'peer'],
    ['acp:kimi', 'at', 'u-peer'],
    ['codex', 'ct', 'item'],
  ]) {
    assert.deepEqual(await read({ id: 'peer', targetKind: kind, targetNativeId: 'old-segment' }), {
      kind,
      nativeId: 'old-segment',
      clientId: 'peer',
      turnId,
      itemId,
    });
  }
  assert.deepEqual(
    calls.map((c) => c[1]),
    ['old-segment', 'acp:kimi:old-segment', 'old-segment', 'old-segment'],
  );
  assert.equal(calls[3][2].cursor, 'older');
});

test('recovery stays unknown for incomplete ids, unknown adapters and repeated page cursors', async () => {
  let calls = 0;
  const read = createPeerReceiptReader({
    claudeMessages: async () => [],
    acpHistory: () => [{ t: 'user', user: { clientId: 'peer' } }],
    codexTurns: async () => {
      calls++;
      return { data: [], nextCursor: 'same' };
    },
  });
  assert.equal(await read({ id: 'peer', targetKind: 'acp:test', targetNativeId: 'old' }), null);
  assert.equal(await read({ id: 'peer', targetKind: 'unknown', targetNativeId: 'old' }), null);
  assert.equal(await read({ id: 'peer', targetKind: 'codex', targetNativeId: null }), null);
  assert.equal(await read({ id: 'peer', targetKind: 'codex', targetNativeId: 'old' }), null);
  assert.equal(calls, 2);
});

test('history errors propagate to reconciliation instead of inventing a successful receipt', async () => {
  const read = createPeerReceiptReader({
    claudeMessages: async () => {
      throw new Error('account offline');
    },
  });
  await assert.rejects(read({ id: 'peer', targetKind: 'claude', targetNativeId: 'old' }), /account offline/);
});

test('recovery returns null when no native user input carries the peer identity, tolerating sparse codex pages', async () => {
  const pages: any[] = [];
  const read = createPeerReceiptReader({
    claudeMessages: async () => [{ type: 'user', uuid: 'other' }],
    acpHistory: () => [{ t: 'user', turnId: 'at', user: { clientId: 'other', id: 'u' } }],
    codexTurns: async (_id: string, options: any) => {
      pages.push(options.cursor);
      return options.cursor ? { nextCursor: null } : { data: [{ id: 'no-items' }], nextCursor: 'older' };
    },
  });
  assert.equal(await read({ id: 'peer', targetKind: 'claude', targetNativeId: 'old' }), null);
  assert.equal(await read({ id: 'peer', targetKind: 'acp:kimi', targetNativeId: 'old' }), null);
  assert.equal(await read({ id: 'peer', targetKind: 'codex', targetNativeId: 'old' }), null);
  assert.deepEqual(pages, [null, 'older']);
});
