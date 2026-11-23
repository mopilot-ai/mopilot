// The app's wiring of the @ menu lists: the sidebar's chats and the chat's folder reach the phone's mentions.list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { setup } from './support/controller/fixture.ts';
const require = createRequire(import.meta.url);
const { createChromePanel, projectsFileOf } = require('../electron/app/chromePanel.cjs');

test('the panel’s mentions op reads the sidebar’s chats and the chat’s folder, which may hold nothing', async (t) => {
  const h = setup();
  t.after(() => fs.rmSync(h.chats.dir, { recursive: true, force: true }));
  h.chats.records.set('th-1', { id: 'th-1', segments: [{ kind: 'codex', nativeId: 'th-1' }], meta: {} });
  const panel = createChromePanel({
    live: { chats: h.chats, controller: h.c, peerRuntime: {} },
    sources: { codex: async () => [] },
    home: h.chats.dir,
    projectsFile: projectsFileOf(h.chats.dir),
    cwdOf: async () => '/no/such/folder/for/a/mention',
    prefs: () => ({}),
    usable: async () => true,
    starter: {},
    send: async () => {},
    open: () => {},
  });
  const found = await panel.o.mentionsList({ chatId: 'th-1', query: 'x' });
  assert.deepEqual(found.chats, []);
  assert.ok(Array.isArray(found.files));
});

test('the panel’s start-mentions op reads a saved project’s folder (none for an unknown project)', async (t) => {
  const h = setup();
  t.after(() => fs.rmSync(h.chats.dir, { recursive: true, force: true }));
  const panel = createChromePanel({
    live: { chats: h.chats, controller: h.c, peerRuntime: {} },
    sources: { codex: async () => [] },
    home: h.chats.dir,
    projectsFile: projectsFileOf(h.chats.dir),
    cwdOf: async () => null,
    prefs: () => ({}),
    usable: async () => true,
    starter: {},
    send: async () => {},
    open: () => {},
  });
  const found = await panel.o.mentionsStart({ harness: 'claude', projectId: 'nope', query: '' });
  assert.deepEqual(found.files, []);
  assert.ok(Array.isArray(found.chats));
});
