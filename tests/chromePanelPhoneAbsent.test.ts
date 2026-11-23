// The app's wiring of "the relay says this phone is away" into the remote service, read late from the running remote.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { setup } from './support/controller/fixture.ts';
const require = createRequire(import.meta.url);
const { createChromePanel, projectsFileOf } = require('../electron/app/chromePanel.cjs');

test('a phone is absent only when the running remote reports it so', async (t) => {
  const h = setup();
  t.after(() => fs.rmSync(h.chats.dir, { recursive: true, force: true }));
  const live: any = { chats: h.chats, controller: h.c, peerRuntime: {} };
  const panel = createChromePanel({
    live,
    sources: { codex: async () => [] },
    home: h.chats.dir,
    projectsFile: projectsFileOf(h.chats.dir),
    cwdOf: async () => '/no/such/folder',
    prefs: () => ({}),
    usable: async () => true,
    starter: {},
    send: async () => {},
    open: () => {},
  });
  const absent = (pairId: string) => panel.service.phoneAbsent(pairId);
  assert.equal(absent('p1'), false, 'no remote yet');
  live.remote = {};
  assert.equal(absent('p1'), false, 'a remote without presence');
  live.remote = { presence: { isAbsent: (id: string) => id === 'p1' } };
  assert.equal(absent('p1'), true);
  assert.equal(absent('p2'), false);
});
