// This Mac's default permission mode is where a chat on a machine STARTS (#5403): a message to a chat that already runs there (one taken in from the machine's list, #5576) carries no mode of its own making, whatever its family; a mode the person picked here, or one the chat has, still rides with it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { remotePicks } = require('../electron/host/remotePicks.cjs');

const ROWS: [string, string | undefined][] = [
  ['acp:host-claude:c', undefined],
  ['acp:host-codex:c', undefined],
  ['claude:native', undefined],
  ['native', 'claude'],
  ['native', 'codex'],
  ['acp:kimi:c', undefined],
];

test('a chat that already runs on its machine carries no mode from this Mac default, for Claude Code, Codex and a basic agent alike', () => {
  for (const [chatId, kind] of ROWS)
    for (const userDefault of ['auto-review', 'full-access', 'read-only'])
      assert.deepEqual(
        remotePicks({ chatId, kind, hostId: 'box', opts: {}, userDefault, starting: false }),
        {},
        `${chatId} ${userDefault}`,
      );
});

test('the same chat as its first message carries the default as before', () => {
  for (const [chatId, kind] of ROWS.slice(0, 5))
    assert.deepEqual(
      remotePicks({ chatId, kind, hostId: 'box', opts: {}, userDefault: 'auto-review', starting: true }),
      { hostMode: 'auto-review' },
      chatId,
    );
  assert.deepEqual(
    remotePicks({ chatId: 'acp:host-claude:c', hostId: 'box', opts: {}, userDefault: 'auto-review' }),
    { hostMode: 'auto-review' },
    'starting is the default',
  );
});

test('a mode the chat has or the person picked here still rides with the message of a chat that already runs', () => {
  assert.deepEqual(
    remotePicks({
      chatId: 'acp:host-claude:c',
      hostId: 'box',
      opts: {},
      chat: { permission: 'read-only' },
      userDefault: 'full-access',
      starting: false,
    }),
    { hostMode: 'read-only' },
  );
  assert.deepEqual(
    remotePicks({
      chatId: 'acp:host-codex:c',
      hostId: 'box',
      opts: {},
      permission: { hostId: 'box', harness: 'codex', value: 'auto-review' },
      userDefault: 'full-access',
      starting: false,
    }),
    { hostMode: 'auto-review' },
  );
});
