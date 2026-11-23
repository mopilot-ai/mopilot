// Real main-panel sends admit an authenticated existing tab before a new or follow-up message on every harness, using real capability plans and membership transport.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { world } from './support/chrome-membership-kit.mjs';
import { parseUserText } from '../shared/userText.mjs';
const require = createRequire(import.meta.url);
const { SessionStore } = require('../electron/session/state.cjs');
const { ChatController } = require('../electron/session/controller.cjs');
const { ControllerPlans } = require('../electron/session/controllerPlan.cjs');
const { createChromePanel, projectsFileOf } = require('../electron/app/chromePanel.cjs');

for (const kind of ['claude', 'codex', 'acp:gemini'])
  for (const failFirst of [false, true]) {
    test(`${kind} (initial failure ${failFirst}): first send and follow-up see the same existing native tab before dispatch, without a window`, async (t) => {
      const w = world();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-send-admission-'));
      t.after(() => {
        w.tabs.dispose();
        fs.rmSync(dir, { recursive: true, force: true });
      });
      const records = new Map<string, any>();
      const state = new SessionStore();
      const chats = {
        records,
        record: (id: string) => records.get(id),
        patchMeta: (id: string, patch: any) => Object.assign(records.get(id).meta, patch),
      };
      const controller = new ChatController({ state, chats, codex: {}, claudeTurns: {}, acpTurns: {} });
      const register = (id: string) => {
        records.set(id, { id, segments: [{ kind, nativeId: id }], meta: {} });
        state.get(id);
      };
      const live: any = {
        chats,
        controller,
        sessions: state,
        acpAdmission: { list: () => [{ id: 'gemini', label: 'Gemini', state: 'admitted' }], admitted: () => true },
        peerRuntime: { readReference: async () => ({ turns: [], earlierContentOmitted: false }) },
        chromeRelay: { kind: 'extension', relay: w.relay, tabs: w.tabs },
      };
      live.controllerPlans = new ControllerPlans({
        chats,
        sessions: state,
        ref: (id: string) => controller.ref(id),
        chatOf: () => null,
        inputs: () => ({
          channel: kind !== 'codex',
          tools: kind === 'codex' ? [] : ['chrome_tabs_context_mcp'],
          yourChrome: true,
          ownChrome: kind === 'codex',
          vendor: { chrome: null, computer: null },
        }),
      });
      const tab = w.chrome.addTab({ url: 'https://example.org/unsaved', title: 'Existing page' });
      const sends: any[] = [];
      const panel = createChromePanel({
        live,
        claude: {},
        sources: {},
        projectsFile: projectsFileOf(dir),
        home: dir,
        prefs: () => ({ projectlessFolder: path.join(dir, 'chats') }),
        usable: async () => true,
        starter: {
          prefs: () => ({}),
          chats,
          started: () => {},
          claudeSession: register,
          acpSession: register,
          codexThread: async () => {
            register('new-codex');
            return { id: 'new-codex' };
          },
        },
        send: async (id: string, item: any) => {
          assert.deepEqual(w.ids(id), [tab.id], 'the first model/tool dispatch already owns the exact existing tab');
          sends.push([id, item]);
          if (failFirst && sends.length === 1) throw new Error('Native transport unavailable');
          return { action: 'started', id: 'panel-input' };
        },
        open: () => {},
      });
      const ask = (method: string, params: any) => new Promise<any>((resolve) => void panel.handle({ id: 1, method, params }, resolve));
      const first = await ask('start', {
        harness: kind,
        text: 'Read this page',
        retainOnError: true,
        tab: await w.sessions.admissions.offer(tab.id),
      });
      assert.equal(first.error, undefined);
      assert.equal(first.result.warning ?? null, null);
      assert.equal(first.result.error, failFirst ? 'Native transport unavailable' : undefined);
      const chatId = first.result.chatId;
      assert.equal(parseUserText(sends[0][1].text).text, parseUserText('Read this page\n\n[Chrome tab: https://example.org/unsaved]').text);
      assert.equal(w.chrome.tabsById.size, 1);
      const follow = await ask('send', { chatId, text: 'Continue here', tab: await w.sessions.admissions.offer(tab.id) });
      assert.equal(follow.result.warning, undefined);
      assert.equal(sends.length, 2);
      assert.equal(w.tabs.list(chatId).find((v: any) => v.id === w.tabs.chats.get(chatId).selected)?.wc.tabId, tab.id);
      assert.ok(!w.chrome.log.some(([method]: any) => ['tabs.create', 'tabs.update'].includes(method)));
    });
  }
