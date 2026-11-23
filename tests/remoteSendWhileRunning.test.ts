// A phone's message while a turn runs is handled as the Mac's own composer handles it, on every harness: queued (or steered in when the user chose that and the harness can), listed for the phone, and taken back by id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { rig } from './support/remote-kit.ts';
import { parseParams } from '../shared/remote/schema.mjs';

const require = createRequire(import.meta.url);
const { SessionStore } = require('../electron/session/state.cjs');
const { ChatController } = require('../electron/session/controller.cjs');
const { createChromePanel, projectsFileOf } = require('../electron/app/chromePanel.cjs');
const { viewOf } = require('../electron/remote/sessionView.cjs');

test('chat.queue.cancel names a chat and one queued message', () => {
  assert.deepEqual(parseParams('chat.queue.cancel', { chatId: 'c1', id: 'queued-12' }), { chatId: 'c1', id: 'queued-12' });
  assert.throws(() => parseParams('chat.queue.cancel', { chatId: 'c1' }), /not valid/);
  assert.throws(() => parseParams('chat.queue.cancel', { chatId: 'c1', id: '../x' }), /not valid/);
  assert.throws(() => parseParams('chat.queue.cancel', { id: 'queued-12' }), /isn't in MoPilot/);
});

test('a phone is told which queued messages are the user’s own and how many files each carries', () => {
  const view = viewOf({
    queue: [
      { id: 'a', text: 'mine', attachments: [] },
      {
        id: 'b',
        text: 'with files',
        attachments: [{ path: '/x' }, { path: '/y' }],
      },
      { id: 'c', text: 'from a session', sideSession: { id: 's' } },
      { id: 'd', text: 'from a chat', peer: { messageId: 'm' } },
      { id: 'e', text: 'no human', authored: { id: 'z' } },
      null,
    ],
  });
  assert.deepEqual(
    view.queue.map((q: any) => [q.id, q.mine, q.attached]),
    [
      ['a', true, 0],
      ['b', true, 2],
      ['c', false, 0],
      ['d', false, 0],
      ['e', false, 0],
      ['', false, 0],
    ],
  );
});

test('chat.queue.cancel takes the message out through the Mac and says whether it was still there', async () => {
  const taken: any[] = [];
  const r = rig({
    ops: {
      unqueue: (chatId: string, id: string) => (taken.push([chatId, id]), id === 'queued-1'),
    },
  });
  const p = r.phone('p1');
  const first = await p.ask('chat.queue.cancel', {
    chatId: 'c1',
    id: 'queued-1',
  });
  assert.deepEqual(first.result, { removed: true });
  assert.deepEqual((await p.ask('chat.queue.cancel', { chatId: 'c1', id: 'queued-2' })).result, { removed: false });
  assert.deepEqual(taken, [
    ['c1', 'queued-1'],
    ['c1', 'queued-2'],
  ]);
  const gone = await p.ask('chat.queue.cancel', {
    chatId: 'nope',
    id: 'queued-1',
  });
  assert.equal(gone.ok, false);
  assert.equal(gone.error.code, 'gone');
});

for (const kind of ['claude', 'codex', 'acp:gemini'])
  for (const followUp of ['queue', 'steer'])
    test(`${kind} with follow-ups set to ${followUp}: a phone's messages mid-turn go as the Mac's composer sends them, in order, each takeable by id`, async (t) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-send-running-'));
      t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
      const records = new Map<string, any>();
      const state = new SessionStore();
      const chats = {
        records,
        record: (id: string) => records.get(id),
        patchMeta: (id: string, patch: any) => Object.assign(records.get(id).meta, patch),
      };
      const steered: string[] = [];
      const adapter = {
        steer: async (_id: string, _ref: any, item: any) => (steered.push(item.text), { started: true }),
        startTurn: async () => ({ started: true }),
      };
      const controller = new ChatController({
        state,
        chats,
        codex: adapter,
        claudeTurns: adapter,
        acpTurns: adapter,
      });
      records.set('chat1', {
        id: 'chat1',
        segments: [{ kind, nativeId: 'n1' }],
        meta: {},
      });
      state.patch('chat1', { turn: 'running' });
      const removed: string[] = [];
      const live: any = {
        chats,
        controller,
        sessions: state,
        orchestrator: {
          queuedRemoved: (_id: string, item: any) => (removed.push(item.id), true),
        },
        acpAdmission: { list: () => [], admitted: () => true },
        peerRuntime: {
          readReference: async () => ({
            turns: [],
            earlierContentOmitted: false,
          }),
        },
      };
      const panel = createChromePanel({
        live,
        claude: {},
        sources: {},
        projectsFile: projectsFileOf(dir),
        home: dir,
        prefs: () => ({ followUp, projectlessFolder: path.join(dir, 'chats') }),
        usable: async () => true,
        starter: {
          prefs: () => ({}),
          chats,
          started: () => {},
          claudeSession: () => {},
          acpSession: () => {},
          codexThread: async () => ({ id: 'x' }),
        },
        send: (id: string, item: any) => controller.send(id, item, null, true),
        open: () => {},
      });
      const ask = (method: string, params: any) => new Promise<any>((resolve) => void panel.handle({ id: 1, method, params }, resolve));
      for (const text of ['first', 'second', 'third']) {
        const answer = await ask('send', { chatId: 'chat1', text });
        assert.equal(answer.error, undefined, `${text}: ${JSON.stringify(answer.error)}`);
      }
      const steers = followUp === 'steer' && kind !== 'acp:gemini';
      assert.deepEqual(steered, steers ? ['first', 'second', 'third'] : [], 'steered only where the harness can be steered into');
      const queue = state.get('chat1').queue;
      assert.deepEqual(
        queue.map((q: any) => q.text),
        steers ? [] : ['first', 'second', 'third'],
        'otherwise held, in the order sent',
      );
      assert.deepEqual(
        viewOf({ queue }).queue.map((q: any) => q.mine),
        queue.map(() => true),
      );
      if (steers) return;
      // taking back the middle one leaves the others, in order; one that is gone, or another session's, is not taken
      assert.equal(panel.o.unqueue('chat1', queue[1].id), true);
      assert.equal(panel.o.unqueue('chat1', queue[1].id), false);
      assert.deepEqual(
        state.get('chat1').queue.map((q: any) => q.text),
        ['first', 'third'],
      );
      assert.deepEqual(removed, [queue[1].id], 'the linked-session journal hears of the removal as for the app’s Remove');
      state.patch('chat1', {
        queue: [
          ...state.get('chat1').queue,
          {
            id: 'side-1',
            text: 'from a session',
            attachments: [],
            opts: {},
            sideSession: { id: 'side-1' },
          },
        ],
      });
      assert.equal(panel.o.unqueue('chat1', 'side-1'), false, 'a message another session sent is not the phone’s to take back');
      assert.equal(state.get('chat1').queue.length, 3);
      assert.equal(panel.o.unqueue('unknown-chat', 'x'), false);
    });
