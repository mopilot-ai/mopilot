// A paired phone's MoMo over the real operations: createChromePanel's ops, the real main chat service and the real remote service. MoMo's chats are kept from the coding side's chat.* methods, yet the phone's own momo.* methods read and write its main chat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createMemoryLink } from '../shared/remote/transport.mjs';
import { waitFor } from './support/waitFor.ts';
import { world } from './support/momoWorld.ts';

const require = createRequire(import.meta.url);
const { createChromePanel, projectsFileOf } = require('../electron/app/chromePanel.cjs');
const { wireMomoRemote } = require('../electron/remote/momoOps.cjs');

const GONE = /That chat isn't in MoPilot/;
const TURNS = [
  {
    id: 't1',
    items: [
      { id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'What is on today?' }] },
      { id: 'a1', type: 'agentMessage', text: 'Two meetings.' },
    ],
  },
];

/** The Mac as main wires it for a phone, on MoMo's real main chat; `momo: false` is a Mac where MoMo was never made. */
async function mac(o: { momo?: boolean } = {}) {
  const w = world();
  const svc = w.make();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-real-panel-'));
  const calls: any[] = [];
  const live: any = {
    chats: w.chats,
    controller: {
      ...w.controller,
      chatOf: (key: string) => key,
      send: async (chatId: string, item: any) => (calls.push(['send', chatId, item.text]), { action: 'started', id: 'momo-input' }),
      stopChat: async (chatId: string) => calls.push(['stop', chatId]),
    },
    peerRuntime: { readHistory: async () => ({ turns: TURNS, earlierContentOmitted: false }) },
  };
  if (o.momo !== false) live.momo = { mainChat: svc };
  const panel = createChromePanel({
    live,
    sources: {},
    projectsFile: projectsFileOf(scratch),
    home: scratch,
    prefs: () => ({ projectlessFolder: path.join(scratch, 'chats') }),
    usable: async () => true,
    starter: { prefs: () => ({}), chats: w.chats, started: () => undefined },
    send: async () => ({ action: 'started', id: 'panel-input' }),
    open: () => undefined,
    remote: { momoAllowed: () => true },
  });
  live.chromePanel = panel;
  const ipcMain = { handle: () => undefined, removeHandler: () => undefined };
  const wired = wireMomoRemote({ ipcMain, toWindows: () => undefined });
  live.momoRemote = wired.attach({
    live,
    mainChat: svc,
    readState: () => ({ prefs: {} }),
    runAttended: async () => undefined,
    allowed: () => true,
    setPref: () => ({ value: {} }),
  });
  const link = createMemoryLink();
  link.addPair('p1');
  panel.service.attach(link.mac);
  const end = link.phone('p1');
  const inbox: any[] = [];
  end.onMessage((m: any) => inbox.push(m));
  let n = 0;
  const ask = async (method: string, params: any = {}) => {
    const id = `r${++n}`;
    await end.send({ id, t: 1, kind: 'request', method, params });
    await waitFor(() => inbox.some((m) => m.inReplyTo === id), `the reply to ${method}`);
    return inbox.find((m) => m.inReplyTo === id);
  };
  const chatId: string = (await svc.ensureMainChat()).chatId;
  return { w, svc, live, panel, ask, chatId, calls };
}

const texts = (reply: any) => JSON.stringify(reply.result?.items ?? reply.result?.history ?? []);

test('a phone follows MoMo’s main chat and reads its history, on the same chat the Mac uses', async () => {
  const { ask, chatId } = await mac();
  const followed = await ask('momo.chat.follow', { items: 50 });
  assert.equal(followed.error, undefined, JSON.stringify(followed.error));
  assert.equal(followed.result.chatId, chatId);
  assert.match(texts(followed), /What is on today\?/);
  assert.match(texts(followed), /Two meetings\./);
});

test('a snapshot asked for no items reads no history, as one halved down to fit a frame ends', async () => {
  const { live, panel, chatId } = await mac();
  live.peerRuntime.readHistory = async () => assert.fail('no rows were asked for');
  assert.deepEqual((await panel.service.ops.items(chatId, 0)).items, []);
});

test('the rest of a phone’s MoMo chat works on the main chat: send, stop, unfollow', async () => {
  const { ask, chatId, calls } = await mac();
  await ask('momo.chat.follow', { items: 50 });
  assert.deepEqual((await ask('momo.chat.send', { id: 'send-1', text: 'Thanks' })).result, { sent: true });
  assert.deepEqual((await ask('momo.chat.stop')).result, { stopped: true });
  assert.deepEqual(calls, [
    ['send', chatId, 'Thanks'],
    ['stop', chatId],
  ]);
  assert.deepEqual((await ask('momo.chat.unfollow')).result, { unfollowed: true });
});

test('MoMo’s chat stays kept from the coding side: every chat.* a phone or the panel names it with is refused', async () => {
  const { ask, chatId, panel } = await mac();
  for (const [method, params] of [
    ['chat.follow', { chatId, items: 5 }],
    ['chat.read', { chatId }],
    ['chat.read', { chatId, before: 'r1' }],
    ['chat.stop', { chatId }],
    ['chat.send', { chatId, text: 'hi', id: 'send-1' }],
  ] as const) {
    const refused = await ask(method, params);
    assert.match(refused.error?.message ?? '', GONE, method);
  }
  await assert.rejects(panel.service.ops.read(chatId), GONE);
  // The backend keeps this boundary even when a caller already validated the target before reaching it.
  for (const target of [chatId, 'deleted-chat'])
    await assert.rejects(
      panel.service.ops.send(
        { chatId: target, text: 'hi', attachments: ['not-uploaded'], skills: [] },
        () => assert.fail('an unavailable chat must be refused before input preparation'),
        () => assert.fail('an unavailable chat must never admit a send'),
      ),
      { message: "That chat isn't in MoPilot." },
    );
});

test('only the current main chat: a previous one is not read, nor a chat with no MoMo at all', async () => {
  const { w, svc, ask, chatId, panel } = await mac();
  w.chats.patchMeta(chatId, { archived: 1 });
  await assert.rejects(panel.service.ops.items(chatId, 5), GONE);
  const followed = await ask('momo.chat.follow', { items: 5 });
  assert.notEqual(followed.result.chatId, chatId, 'the archived one is replaced');
  assert.equal(followed.result.chatId, svc.mainChatId());

  const none = await mac({ momo: false });
  await assert.rejects(none.panel.service.ops.items(none.chatId, 5), GONE);
});
