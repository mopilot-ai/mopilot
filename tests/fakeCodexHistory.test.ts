// The real fixture's synchronous native dispatcher emits valid history JSON and delays only the raced snapshot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFakeCodexHistory, HISTORY_DELTA } from './e2e/fixtures/fake-codex-history.mjs';

const { replyNativeRequest } = createRequire(import.meta.url)('./e2e/fixtures/prepared-native-gate.cjs');

test('history replies use the native JSON envelope, with live progress before a delayed old snapshot and a fresh full page afterward', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-history-protocol-'));
  try {
    const log = path.join(dir, 'native.jsonl');
    const rec = { turns: [{ id: 'live', status: 'inProgress', items: [{ type: 'agentMessage', id: 'reply', text: 'Hello' }] }] };
    const messages: any[] = [];
    const send = (message: any) => messages.push(JSON.parse(JSON.stringify(message)));
    const read = createFakeCodexHistory({
      getThread: () => rec,
      otherAppTurn: (r: any) => r,
      elsewhereDone: (r: any) => r,
      notify: (method: string, params: any) => send({ method, params }),
      saveState: () => {},
      log,
      record: () => {},
      send,
    });
    const request = (id: number) =>
      replyNativeRequest(
        { id, method: 'thread/turns/list', params: { threadId: 'chat' } },
        () => read({ threadId: 'chat', limit: 30 }),
        read.reply ?? send,
        { logFile: log, saveState: () => {} },
      );
    request(1);
    assert.equal(messages[0].result.data[0].items[0].text, 'Hello');
    fs.writeFileSync(`${log}.history-race-chat`, 'race');
    request(2);
    assert.equal(messages.at(-1).method, 'item/completed');
    assert.equal(messages.at(-1).params.item.text, 'Hello' + HISTORY_DELTA);
    assert.equal(
      messages.some((m) => m.id === 2),
      false,
    );
    await new Promise((resolve) => setTimeout(resolve, 130));
    assert.equal(messages.find((m) => m.id === 2).result.data[0].items[0].text, 'Hello');
    request(3);
    assert.equal(messages.at(-1).result.data[0].items[0].text, 'Hello' + HISTORY_DELTA);
    assert.equal(messages.filter((m) => m.method === 'item/completed').length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
