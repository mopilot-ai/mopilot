// Native Chrome-panel history composes each harness's transcript, saved account notes, menu ownership and live updates.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { SessionStore } = require('../electron/session/state.cjs');
const { createChromePanel, projectsFileOf } = require('../electron/app/chromePanel.cjs');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-native-history-'));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

test('main’s panel reads a chat back from its harness and follows it live; a follow-up is the user’s own message', async () => {
  const pushed: any[] = [];
  const sent: any[] = [];
  const records = new Map<string, any>([
    [
      'th-1',
      {
        segments: [{ kind: 'codex', nativeId: 'th-1' }],
        meta: {
          config: { model: 'gpt-5.5' },
          // the move to another account is saved on the chat, not in the harness's history: it goes back after its turn
          notes: [
            {
              id: 'account-1',
              kind: 'account',
              text: 'Usage limit reached on a@x.com. Continued on b@x.com',
              turnId: null,
              turn: 0,
              at: 1,
            },
          ],
        },
      },
    ],
    ['acp:goose:1', { segments: [{ kind: 'acp:goose', nativeId: '1', model: 'goose-1' }], meta: {} }],
  ]);
  const states = new SessionStore();
  states.patch('th-1', { turn: 'running' });
  states.patch('claude:new', { turn: 'running' });
  const live: any = {
    chats: { records },
    controller: {
      state: states,
      chatOf: (k: string) => k,
      ref: () => ({ kind: 'claude' }),
    },
    acpAdmission: { list: () => [], admitted: () => false },
    // the account each chat's turns run on now
    capsService: { accountLabel: (id: string) => (id === 'th-1' ? 'b@x.com' : null) },
    peerRuntime: {
      // the whole history: the panel keeps a short form of it itself
      readHistory: async (id: string) => ({
        turns: [
          {
            items: [
              { type: 'userMessage', content: [{ type: 'text', text: `hi ${id}` }] },
              { type: 'agentMessage', text: 'Hello' },
            ],
          },
        ],
        earlierContentOmitted: id === 'acp:goose:1',
      }),
    },
  };
  const panel = createChromePanel({
    live,
    sources: {},
    projectsFile: projectsFileOf(scratch),
    home: scratch,
    prefs: () => ({ claudeSelection: { model: 'sonnet' } }),
    usable: async () => true,
    starter: {
      prefs: () => ({}),
      chats: {
        patchMeta: (id: string, patch: any) => {
          const record = records.get(id) ?? { meta: {} };
          records.set(id, { ...record, meta: { ...record.meta, ...patch } });
          return true;
        },
      },
      started: () => undefined,
    },
    send: async (chatId: string, item: any) => {
      sent.push([chatId, item]);
      return { action: 'started', id: 'panel-input' };
    },
    open: () => undefined,
  });
  const ask = (method: string, params: any) =>
    new Promise<any>((resolve) => void panel.handle({ id: 1, method, params }, (r: any) => (r.event ? pushed.push(r.event) : resolve(r))));
  assert.deepEqual((await ask('read', { chatId: 'th-1' })).result, {
    chatId: 'th-1',
    rows: [
      { role: 'user', text: 'hi th-1' },
      { role: 'assistant', text: 'Hello' },
      { role: 'note', text: 'Usage limit reached on a@x.com. Continued on b@x.com' },
    ],
    omitted: false,
    harness: 'Codex',
    account: 'b@x.com',
    model: 'gpt-5.5',
    menuOwner: JSON.stringify(['codex', null, null, null, null, 'default', ['gpt-5.5', null]]),
    state: 'running',
    approvals: [],
  });
  const acp = (await ask('read', { chatId: 'acp:goose:1' })).result;
  assert.deepEqual([acp.harness, acp.model, acp.omitted, acp.state], ['goose', 'goose-1', true, 'idle']);
  // the basic harness's own name where MoPilot knows it; its id where it doesn't (admission not up yet)
  live.acpAdmission.list = () => [{ id: 'goose', label: 'Goose' }];
  assert.equal((await ask('read', { chatId: 'acp:goose:1' })).result.harness, 'Goose');
  const admission = live.acpAdmission;
  live.acpAdmission = undefined;
  assert.equal((await ask('read', { chatId: 'acp:goose:1' })).result.harness, 'goose');
  live.acpAdmission = admission;
  // started a moment ago: nothing saved yet, so no rows, on the harness main runs it on
  assert.deepEqual((await ask('read', { chatId: 'claude:new' })).result, {
    chatId: 'claude:new',
    rows: [],
    omitted: false,
    harness: 'Claude Code',
    account: null,
    model: 'sonnet',
    menuOwner: JSON.stringify(['claude', null, null, null, null, 'default', ['sonnet', null]]),
    state: 'running',
    approvals: [],
  });
  assert.equal((await ask('read', { chatId: 'gone' })).error, "That chat isn't in MoPilot.");
  // the chats read are followed: their reply streams to the connection that asked
  live.controller.onLiveEvent('codex', { method: 'item/agentMessage/delta', params: { threadId: 'th-1', delta: 'Hel' } });
  live.controller.onLiveEvent('codex', { method: 'item/agentMessage/delta', params: { threadId: 'th-2', delta: 'no' } });
  assert.deepEqual(pushed, [{ kind: 'delta', chatId: 'th-1', text: 'Hel' }]);
  // the panel's own failure never stops the controller's handling of the event
  const chatOf = live.controller.chatOf;
  live.controller.chatOf = () => {
    throw new Error('no such key');
  };
  assert.doesNotThrow(() => live.controller.onLiveEvent('codex', { method: 'item/completed', params: { threadId: 'th-1' } }));
  live.controller.chatOf = chatOf;
  // a follow-up: the user's own message, to a chat MoPilot has
  assert.deepEqual((await ask('send', { chatId: 'th-1', text: 'and Osaka?' })).result, { sent: true });
  assert.deepEqual(sent.at(-1), ['th-1', { text: 'and Osaka?', attachments: [], opts: { human: true }, followUp: 'queue' }]);
  assert.equal((await ask('send', { chatId: 'gone', text: 'hi' })).error, "That chat isn't in MoPilot.");
  // no harness at all (a chat id with no record, its state from a window): neither label nor model
  live.controller.ref = () => undefined;
  states.patch('x:1', { turn: 'idle' });
  // nor an account before the sessions are up (no capabilities service yet)
  live.capsService = undefined;
  const bare = (await ask('read', { chatId: 'x:1' })).result;
  assert.deepEqual([bare.harness, bare.model, bare.account], [null, null, null]);
});
