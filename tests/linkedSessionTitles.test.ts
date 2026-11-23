// Linked sessions carry their supplied title through the real starter and durable chat store before any window sees them.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { mapsFromSnapshot } from '../src/lib/chatMeta.ts';
import { tmp } from './support/chat-store-profile.ts';
import { orchestration, SESSION_BACKGROUND } from './support/orchestration-harness.ts';

const require = createRequire(import.meta.url);
const { ChatsStore } = require('../electron/platform/chats.cjs');
const { ChatStarter } = require('../electron/platform/chatStart.cjs');
const { makeChild, startArgs } = require('../electron/session/orchestration/spawn.cjs');

for (const kind of ['codex', 'claude', 'acp:kimi']) {
  for (const context of ['fresh', 'fork']) {
    test(`${kind} ${context}: the supplied title is saved and broadcast before announcement, without a first send`, async (t) => {
      const { threads, ui } = tmp(t);
      const chats = new ChatsStore(threads, { uiState: ui });
      const h = orchestration();
      h.refs.set('top', { kind, id: 'parent-native', key: 'top' });
      const events: string[] = [];
      const title = 'Login session timing';
      h.orch.o.starter = new ChatStarter({
        prefs: () => ({}),
        chats,
        codexThread: async () => ({ id: 'new-codex' }),
        codexFork: async () => ({ id: 'fork-codex' }),
        claudeSession: () => {},
        claudeFork: async () => ({ sessionId: 'fork-claude' }),
        acpSession: () => {},
        changed: (id: string) => {
          assert.equal(chats.get(id).meta.initialTitle, title);
          events.push('metadata');
        },
        started: ({ chatId }: { chatId: string }) => {
          assert.equal(chats.get(chatId)?.meta.initialTitle, title);
          assert.equal(mapsFromSnapshot(chats.snapshot()).chatInitialTitles?.[chatId], title);
          assert.equal(chats.get(chatId).meta.config?.meta, undefined, 'presentation metadata is not native configuration');
          events.push('announced');
        },
      });
      const child = await makeChild(
        h.orch,
        'top',
        startArgs({ title, prompt: 'Fix startup timing', background: SESSION_BACKGROUND, context, use_worktree: false }),
      );
      assert.deepEqual(events, ['metadata', 'announced']);
      const reopened = new ChatsStore(threads, { uiState: ui });
      assert.equal(reopened.get(child.chatId).meta.initialTitle, title, 'a window opened after restart reads the title too');
      assert.equal(
        h.log.some(([event]) => event === 'send'),
        false,
      );
      chats.patchMeta = () => false;
      await assert.rejects(
        makeChild(
          h.orch,
          'top',
          startArgs({ title: 'Another task', prompt: 'Never announced', background: SESSION_BACKGROUND, context, use_worktree: false }),
        ),
        /save the new chat/,
      );
      assert.deepEqual(events, ['metadata', 'announced'], 'a failed save cannot announce an unnamed chat');
    });
  }
}
