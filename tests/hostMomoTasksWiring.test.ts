// MoMo's tasks through the real wiring (momoHomeFor): the services load, the tasks service is handed the brain and the chat's sink once, agents come from the Host's harness status, and a result card waits until MoMo's main chat exists and can take a row. (host/src/momoWiring.mjs, host/src/momoServices/tasks.mjs)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { momoHomeFor, createMomoHidden } from '../host/src/momoWiring.mjs';
import { ask, fakeSessions, REPORT, until } from './support/host/momoTasksWorld.ts';

test('through the real wiring, a task finished before MoMo has a chat keeps its card owed, and it is posted once the chat takes rows', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-tasks-wiring-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const records = new Map<string, any>();
  const patchMeta = (id: string, patch: object) => records.set(id, { meta: { ...records.get(id)?.meta, ...patch } });
  const sessions: any = Object.assign(fakeSessions(), { chats: { records, patchMeta }, isolated: () => true, isolate: () => undefined });
  const home: any = momoHomeFor({
    paths: { dataDir: path.join(dir, 'data'), configDir: path.join(dir, 'config') },
    report: () => undefined,
    sessions,
    epochs: { current: () => 1 } as any,
    hidden: createMomoHidden(),
    hostId: 'home-aaaa-1111',
    env: { ANTHROPIC_API_KEY: 'test-key', HOME: '/nonexistent-home', XDG_DATA_HOME: '/nonexistent-data' },
    harnesses: async () => [{ id: 'claude', detected: true, signedIn: true }],
  });
  t.after(() => home.close());
  await home.grant({ account: 'a1', features: ['momo'] });
  await home.start({ name: 'Studio' });
  const tasks = home.service('tasks');
  const brain: string[] = [];
  home.seams.askModel = async (p: string) => (brain.push(p), '{"met": true, "reason": "ok", "checked": "opened it"}');
  const { item } = await tasks.create(ask);
  assert.equal(item.state, 'working');
  assert.equal(sessions.sent.length, 1);
  assert.equal(sessions.sent[0].cwd, path.join(dir, 'data', 'momo-work', 'tasks', item.id));
  const chatId = item.where.sessionId as string;
  sessions.say(chatId, REPORT);
  sessions.end(chatId);
  // the brain the wiring bound read the result: the task is done, and its card is owed (there is no main chat to post to)
  await until(async () => (await tasks.view())[0]?.state === 'done', 'the task to be read');
  assert.equal(brain.length, 1);
  const rows: any[] = [];
  home.seams.writeRow = async (r: any) => void rows.push(r);
  assert.equal(await tasks.deliver(), 0);
  assert.equal(rows.length, 0);
  // MoMo's main chat exists: the owed card is posted, once
  await home.chats.start({ harness: 'claude' });
  assert.equal(await tasks.deliver(), 1);
  assert.equal(await tasks.deliver(), 0);
  assert.deepEqual(
    rows.map((r) => [r.kind, r.body.itemId]),
    [['result', item.id]],
  );
});
