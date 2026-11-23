// MoMo's chats run apart from the coding side on every harness by one rule, their MoMo tag (electron/app/momo.cjs
// isolateMomoChats): Codex's request gate, a harness switch's new thread, Claude Code's session options and an ACP agent's
// file and terminal requests, the last also for a chat whose ACP session isn't its first segment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { world } from './support/momoAppWorld.ts';

const require = createRequire(import.meta.url);
const { isolateMomoChats } = require('../electron/app/momo.cjs');
const { CodexAdapter } = require('../electron/harness/codex.cjs');
const { guardIsolated } = require('../electron/harness/acp/clientMethods.cjs');
const { setMomoContextProvider } = require('../electron/momo/contract/context.cjs');

test('Codex, a harness switch, Claude Code and ACP all take the rule; ACP by the chat its session belongs to', () => {
  const momo = new Set(['mc']);
  const isMomoChat = (id: string) => momo.has(id);
  const server = { listeners: new Set(), ahead: new Set() };
  const codex = new CodexAdapter({ server, nativeOf: () => null, probe: null, chatOf: (t: string) => (t === 'th-mc' ? 'mc' : t) });
  assert.equal(codex.isolation.applies({ threadId: 'th-mc' }), false, 'no rule yet');
  const live: any = {
    codex,
    switchRunner: { isolated: () => false },
    acpHost: {},
    controller: { chatOf: (k: string) => (k === 'acp:kimi:s1' ? 'mc' : null) },
  };
  let claudeRule: any = null;
  isolateMomoChats(live, { setIsolated: (fn: any) => (claudeRule = fn) }, isMomoChat);
  assert.equal(codex.isolation.applies({ threadId: 'th-mc' }), true);
  assert.equal(codex.isolation.applies({ threadId: 'th-other' }), false);
  assert.equal(live.switchRunner.isolated('mc'), true);
  assert.equal(claudeRule('mc'), true);
  assert.throws(() => guardIsolated(live.acpHost, 'fs/read_text_file', { key: 'acp:kimi:s1' }), /don't read or write files/);
  assert.equal(guardIsolated(live.acpHost, 'fs/read_text_file', { key: 'acp:kimi:s2' }).key, 'acp:kimi:s2');
  // a session the controller doesn't know yet is the chat's own first one
  momo.add('acp:kimi:new');
  assert.throws(() => guardIsolated(live.acpHost, 'terminal/create', { key: 'acp:kimi:new' }));
  // before the sessions open, only Claude Code's rule is set
  isolateMomoChats({}, { setIsolated: () => undefined }, isMomoChat);
});

test('MoMo’s services set the rule at startup', async () => {
  const w = world();
  w.chats.commit({ id: 'mc', segments: [{ kind: 'claude', nativeId: 'x', start: 0, count: null }], meta: { momo: 'main' } });
  assert.equal(w.claudeIsolated('mc'), true);
  assert.equal(w.claudeIsolated('nope'), false);
  await w.m.close();
  setMomoContextProvider(null);
});

test('isolation is set first: a service that can’t be made after it still leaves every harness’s rule set', () => {
  const { openMomo } = require('../electron/app/momo.cjs');
  const set: string[] = [];
  const live: any = {
    chats: { records: new Map([['mc', { meta: { momo: 'main' } }]]) },
    codex: { setIsolated: () => void set.push('codex') },
    switchRunner: {},
    acpHost: {},
    controller: { chatOf: () => null },
  };
  let claudeRule: any = null;
  assert.throws(
    () =>
      openMomo({
        // a relative folder: MoMo's first store refuses it, after isolation
        userData: 'not-absolute',
        ipcMain: { handle: () => undefined },
        live,
        claude: { setIsolated: (fn: any) => (claudeRule = fn) },
        readState: () => ({}),
        broadcastAll: () => undefined,
        appWindows: {},
        chatStart: {},
        usable: async () => false,
        sendRun: async () => undefined,
        electron: { safeStorage: null, dialog: {}, shell: {}, BrowserWindow: {} },
        allowed: () => false,
        onAccess: () => () => undefined,
      }),
    /absolute folder/,
  );
  assert.equal(claudeRule('mc'), true);
  assert.deepEqual(set, ['codex']);
  assert.equal(live.switchRunner.isolated('mc'), true);
  assert.equal(live.acpHost.isolated('mc'), true);
});
