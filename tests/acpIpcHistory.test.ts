// electron/harness/acp/ipc.cjs acp:turns: the transcript as main's turns, with what each turn changed in its folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const { register } = createRequire(import.meta.url)('../electron/harness/acp/ipc.cjs');

function ipc() {
  const handlers = new Map<string, (...a: any[]) => any>();
  return { handlers, ipcMain: { handle: (name: string, fn: (...a: any[]) => any) => handlers.set(name, fn) } };
}

const source = { file: '/threads/acp:kimi:1.items.jsonl', extra: [] };
const log = { flush: async () => undefined, file: (key: string) => `/threads/${key}.items.jsonl` };
const host = Object.assign(new EventEmitter(), { items: log, chats: new Map() });

test('acp:turns: a page of the transcript from where the host says, with what its own turns changed', async () => {
  const { handlers, ipcMain } = ipc();
  const asked: any[] = [];
  const saved: any[] = [];
  const page = Buffer.from('{}');
  const items = {
    history: async (key: string, chat: string, cwd: string, read: () => Promise<unknown>, opts: unknown) => {
      asked.push([key, chat, cwd, await read(), opts]);
      return { page, ids: ['at-1'], older: false, activeTurnId: null };
    },
  };
  const diffs = (key: string, ids: string[]) => (saved.push([key, ids]), { 'at-1': 'patch' });
  register(ipcMain, host, { broadcast: () => {}, diffs, items });
  const reply = await handlers.get('acp:turns')!({}, 'acp:kimi:1', 'chat', '/w', { limit: 30 });
  assert.deepEqual(reply, { page, activeTurnId: null, diffs: { 'at-1': 'patch' } });
  assert.deepEqual(saved, [['acp:kimi:1', ['at-1']]]);
  assert.deepEqual(asked, [['acp:kimi:1', 'chat', '/w', source, { limit: 30 }]]);
  await handlers.get('acp:turns')!({}, 'acp:kimi:1', 'chat', undefined);
  assert.equal(asked.at(-1)?.[2], '', 'no cwd given: an empty one');
});

test('with no saved diffs acp:turns gives the page as it is', async () => {
  const { handlers, ipcMain } = ipc();
  const items = { history: async () => ({ page: 'p', ids: [], activeTurnId: 't' }) };
  register(ipcMain, host, { broadcast: () => {}, items });
  assert.deepEqual(await handlers.get('acp:turns')!({}, 'acp:kimi:1', 'chat', '/w'), { page: 'p', activeTurnId: 't', diffs: {} });
});
