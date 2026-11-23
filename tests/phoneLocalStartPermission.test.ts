// The real panel start applies each family's permission before dispatching a phone's first local message.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createChromePanel, projectsFileOf } = require('../electron/app/chromePanel.cjs');
const { ChatController } = require('../electron/session/controller.cjs');
const { clientIdOf } = require('../electron/session/contract/inputGuard.cjs');
const { SessionStore } = require('../electron/session/state.cjs');

for (const kind of ['claude', 'codex', 'acp:fake']) {
  test(`${kind}: first local send observes the phone's chosen permission`, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-local-mode-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const records = new Map<string, any>();
    const chats = {
      records,
      patchMeta: (id: string, patch: any) => {
        const row = records.get(id) ?? { id, segments: [{ kind, nativeId: id }], meta: {} };
        row.meta = { ...row.meta, ...patch };
        records.set(id, row);
        return true;
      },
      record: (id: string) => records.get(id),
    };
    const state = new SessionStore();
    const controller = new ChatController({ state, chats, codex: {}, claudeTurns: {}, acpTurns: {} });
    const prefs: any = {};
    const seen: string[] = [];
    const identities: string[] = [];
    const nativeMessageId = 'd7f37c3d-7828-59d4-af24-c05881aac92c';
    const catalog = {
      modes: {
        currentModeId: 'ask',
        availableModes: [
          { id: 'ask', name: 'Ask' },
          { id: 'auto', name: 'Auto' },
        ],
      },
    };
    const live: any = {
      chats,
      controller,
      sessions: state,
      patchPrefs: (p: any) => Object.assign(prefs, p),
      acpAdmission: { admitted: () => true, list: () => [{ id: 'fake', state: 'admitted', catalog }] },
      acpTurns: { catalog: () => catalog },
      peerRuntime: { readReference: async () => ({ turns: [], earlierContentOmitted: false }) },
    };
    const panel = createChromePanel({
      live,
      sources: {},
      prefs: () => prefs,
      home: dir,
      projectsFile: projectsFileOf(dir),
      usable: async () => true,
      starter: {
        prefs: () => prefs,
        chats,
        codexThread: async () => ({ id: 'codex-local' }),
        claudeSession: () => {},
        acpSession: (id: string) => {
          records.set(id, { id, segments: [{ kind, nativeId: id }], meta: {} });
        },
        started: () => {},
      },
      send: async (id: string, input: any) => {
        identities.push(clientIdOf(input));
        seen.push(kind.startsWith('acp:') ? prefs.basicDefaults?.fake?.mode : records.get(id)?.meta?.config?.permission);
        return { action: 'started', id: 'input' };
      },
      open: () => {},
    });
    const permission = kind.startsWith('acp:') ? 'auto' : 'auto-review';
    const reply = await panel.service.ops.start({
      harness: kind,
      text: 'hi',
      projectId: null,
      attachments: [],
      skills: [],
      permission,
      nativeMessageId,
    });
    assert.ok(reply);
    assert.deepEqual(seen, [permission]);
    assert.deepEqual(identities, [nativeMessageId]);
  });
}
