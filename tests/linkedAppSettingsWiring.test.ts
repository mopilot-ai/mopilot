// Main's actual starter and adapter factories route durable linked settings and persistent forks through their current services.
import { test } from 'node:test';
import { createRequire } from 'node:module';
const { adapterSettings } = createRequire(import.meta.url)('../electron/session/adapterSettings.cjs');
import assert from 'node:assert/strict';
import { loadMain, calls } from './support/electron-wiring/fixture.ts';

test('main starter forks persistently and applies native settings; adapter readers follow current saved metadata', async () => {
  let orchestrator: any;
  const h = await loadMain({
    before: (h) => {
      h.mods['electron/capabilities/tools/sessions.cjs'] = {
        registerSessionTools: (_registry: unknown, options: any) => {
          orchestrator = options.orchestrator;
        },
        registerRemoteControlTool: () => {},
      };
      h.claude.forkLinkedSession = async (id: string, cwd: string) => ({ sessionId: `fork-of-${id}`, cwd });
    },
  });
  await h.ready();
  const deps = h.one('AutomationRunner').opts;
  assert.deepEqual(await deps.claudeFork('source', '/child'), { sessionId: 'fork-of-source', cwd: '/child' });
  const own = { model: 'sonnet', permission: 'read-only', additionalDirectories: ['/notes'] };
  deps.claudeOwn('native-child', own);
  assert.deepEqual(calls(h.one('ClaudeAdapter').setOwn).at(-1), ['native-child', own]);
  const chats = h.one('ChatsStore');
  chats.records = new Map([['chat', { meta: { config: own } }]]);
  assert.equal(h.one('ClaudeAdapter').opts.savedSettings('chat'), own);
  assert.equal(h.one('AcpTurns').opts.savedSettings('chat'), null, 'ordinary ACP keeps native settings');
  assert.ok(orchestrator);
  orchestrator.journal.change((data: any) => {
    data.children.chat = { parentId: 'parent', name: 'Child', title: 'Linked chat', createdAt: 1, driven: [], lastReport: null };
  });
  assert.equal(h.one('AcpTurns').opts.savedSettings('chat'), own);
  chats.records.set('chat', { meta: { config: { permission: 'default' } } });
  assert.equal(h.one('ClaudeAdapter').opts.savedSettings('chat').permission, 'default');
  assert.equal(h.one('AcpTurns').opts.savedSettings('chat').permission, 'default');
  assert.equal(h.one('ClaudeAdapter').opts.savedSettings('missing'), null);
  assert.equal(h.one('AcpTurns').opts.savedSettings('missing'), null);
});

test('main adapter settings read current accounts and persist a move with the existing notes and write receipt', async () => {
  const h = await loadMain();
  await h.ready();
  const chats = h.one('ChatsStore');
  const own = h.one('ClaudeAdapter').opts;
  const basic = h.one('AcpTurns').opts;
  chats.records = new Map();
  assert.equal(own.savedAccount('missing'), null);
  chats.records.set('chat', {});
  assert.equal(own.savedAccount('chat'), null);
  assert.equal(own.savedSettings('chat'), null);
  chats.records.set('chat', { meta: {} });
  assert.equal(own.savedAccount('chat'), null);
  assert.equal(basic.savedSettings('chat'), null);
  chats.records.set('chat', { meta: { account: {} } });
  assert.equal(own.savedAccount('chat'), null);
  chats.records.set('chat', { meta: { account: { id: 'previous', pinned: true }, config: { model: 'sonnet' }, notes: ['earlier'] } });
  chats.record = (id: string) => chats.records.get(id);
  let writable = true;
  chats.patchMeta = (id: string, patch: any) => {
    if (!writable) return false;
    const record = chats.records.get(id);
    chats.records.set(id, { ...record, meta: { ...record.meta, ...patch } });
    return true;
  };
  assert.equal(own.savedAccount('chat'), 'previous');
  assert.equal(own.moved('chat', { account: 'replacement', note: 'Moved after usage limit' }), true);
  assert.equal(own.savedAccount('chat'), 'replacement');
  assert.deepEqual(chats.record('chat').meta, {
    account: { id: 'replacement', pinned: false },
    config: { model: 'sonnet' },
    notes: ['earlier', 'Moved after usage limit'],
  });
  assert.equal(basic.savedSettings('chat'), null, 'first-tier configuration is not an ACP-native choice');
  chats.records.set('empty', { meta: {} });
  assert.equal(own.moved('empty', { account: 'first', note: 'First move' }), true);
  assert.deepEqual(chats.record('empty').meta.notes, ['First move']);
  writable = false;
  assert.equal(own.moved('chat', { account: 'unsaved', note: 'Not written' }), false);
  assert.equal(own.savedAccount('chat'), 'replacement');
});

test('ACP settings follow native destinations while a linked child retains its saved permission across a switch', () => {
  const own = { permission: 'default' };
  const chats = { records: new Map<string, unknown>([['chat', { meta: { config: own } }]]) };
  const orch: any = { journal: { child: () => null } };
  const acp = adapterSettings({ chats, orchestrator: orch });
  assert.equal(acp.acpSettings('chat'), null);
  assert.equal(acp.acpSettings('chat', 'acp:opencode:opaque:key'), null);
  orch.journal.child = () => ({ parentId: 'parent' });
  assert.equal(acp.acpSettings('chat', 'acp:opencode:opaque:key'), own);
  chats.records.set('chat', { meta: { config: { permission: 'read-only' } } });
  assert.equal(acp.acpSettings('chat', 'acp:opencode:opaque:key').permission, 'read-only');
  orch.journal = null;
  assert.equal(acp.acpSettings('chat', 'acp:opencode:opaque:key').permission, 'read-only', 'unknown inheritance keeps its cap');
  assert.equal(adapterSettings({ chats }).acpSettings('chat', 'acp:other:key').permission, 'read-only');
});
