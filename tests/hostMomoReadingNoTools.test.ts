// A reading turn (a brief, a notice, a check of a task's result) reads text from outside, so its chat has NO tool: on the Host's real tool registry MoMo's own chat is offered MoMo's tools and a data chat none, and the reading turn refuses to run at all if its chat is offered any.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
// @ts-ignore: plain ESM without declarations
import { momoHomeFor, createMomoHidden } from '../host/src/momoWiring.mjs';
// @ts-ignore
import { createNoticeModel } from '../host/src/momoNoticeModel.mjs';

const require = createRequire(import.meta.url);
const { Registry } = require('../electron/capabilities/contract/registry.cjs');

test('MoMo’s own chat sees MoMo’s tools and a data chat sees none, on the Host’s own registry', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-notools-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const registry = new Registry();
  const records = new Map<string, any>();
  const patchMeta = (id: string, patch: object) => records.set(id, { meta: { ...records.get(id)?.meta, ...patch } });
  const sessions: any = { chats: { records, patchMeta }, isolated: () => true, isolate: () => undefined };
  const home: any = momoHomeFor({
    paths: { dataDir: path.join(dir, 'data'), configDir: path.join(dir, 'config') },
    report: () => undefined,
    sessions,
    epochs: { current: () => 1 } as any,
    hidden: createMomoHidden(),
    hostId: 'home-aaaa-1111',
    tools: { registry },
    env: { ANTHROPIC_API_KEY: 'test-key', HOME: '/nonexistent-home', XDG_DATA_HOME: '/nonexistent-data' },
  });
  t.after(() => home.close());
  await home.grant({ account: 'a1', features: ['momo'] });
  await home.start({ name: 'Studio' });
  const main = await home.chats.start({ harness: 'claude' });
  const reading = home.chats.startBackground('claude', 'brief');
  const names = (chatId: string) => registry.list({ chatId }).map((x: { name: string }) => x.name);
  assert.ok(names(main.chatId).length >= 4, `MoMo’s own chat is offered its tools: ${names(main.chatId)}`);
  assert.deepEqual(names(reading), [], 'a data chat is offered none');
  assert.deepEqual(home.toolsOf(reading), []);
  assert.deepEqual(home.toolsOf(main.chatId), names(main.chatId));
  assert.deepEqual(
    names('claude:a-coding-chat').filter((n: string) => n.startsWith('momo_')),
    [],
    'and a coding chat none of MoMo’s',
  );
});

test('the reading turn is not made when its chat is offered any tool, and is made when it is offered none', async () => {
  const started: unknown[] = [];
  const make = (tools: string[]) =>
    createNoticeModel({
      chats: { main: () => ({ chatId: 'claude:main', harness: 'claude' }), startBackground: () => 'claude:reading', workspace: '/w' },
      protocol: { startScheduled: async (p: unknown) => void started.push(p), asHost: async () => undefined },
      events: new EventEmitter(),
      toolsOf: () => tools,
      cheap: async () => ({}),
      timeoutMs: 20,
    });
  await assert.rejects(make(['momo_memory_save']).complete('read this'), /reading chat has tools \(momo_memory_save\)/);
  assert.deepEqual(started, [], 'nothing was started for a chat that has a tool');
  await assert.rejects(make([]).complete('read this'), /took too long|did not finish/);
  assert.equal(started.length, 1, 'with none, the turn starts');
});
